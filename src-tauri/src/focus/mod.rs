//! Focused-app + field-editability detection via AT-SPI (the accessibility bus).
//!
//! Replaces the privileged `org_kde_plasma_window_management` (blacklisted for normal
//! clients on KWin) with one event-driven module that answers BOTH questions a safe
//! insertion needs, from a single cached snapshot:
//!   * **which app has focus** (`app_id`) — for per-app rules + the chip's target readout.
//!   * **whether the focused element is editable** — for the opt-in field guard, so we
//!     don't type into a button / list / the desktop.
//!
//! Model (what screen readers do): a background task subscribes to AT-SPI focus events
//! and caches the last focused `{app, role, editable}`. Qt/GTK/WebKit apps bridge
//! natively (`QT_ACCESSIBILITY=1`, a KDE default). Chromium/Electron/Gecko build their
//! a11y tree on-demand — only the opt-in "deep detection" reaches them, by flipping the
//! `org.a11y.Status` enabled flag and actively poking their tree (`GetAttributes` /
//! `GetRelationSet` — the "Orca signal"). Terminals expose `role=terminal` and are
//! whitelisted as typable. Apps that expose nothing (games, no a11y) → `editable = None`
//! → callers type anyway (the guard is positive-only).
//!
//! On Windows the same snapshot is fed by `windows` (a child module:
//! foreground-window tracking via WinEvent hook + poll, exe-basename identity,
//! `editable` always unknown). Everything else compiles to no-op stubs: the
//! snapshot stays empty, `focused_app` returns `None`, and callers degrade.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Ceiling on an app-supplied AT-SPI application name. Real ones are short ("firefox",
/// "org.gnome.Nautilus"); this is loose enough that no existing app rule stops matching.
const APP_ID_MAX: usize = 200;

/// Ceiling on an AT-SPI selection reply. The focused app picks the offsets, so it picks the
/// length; this is the read-side bound so both consumers inherit it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // selection reads are AT-SPI (Linux)
pub(crate) const SEL_MAX: usize = 64 * 1024;

/// The focused application + (when known) whether its focused element is editable.
/// Serialised camelCase for the frontend (`{ appId, title, editable, isSelf }`).
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedApp {
    pub app_id: String,
    pub title: String,
    /// `Some(true)` editable text field · `Some(false)` definitely not · `None` unknown
    /// (no a11y tree, asleep, or no focus event yet) — callers must treat `None` as "type".
    pub editable: Option<bool>,
    /// True when this represents OUR OWN focused window (set by `get_focused_app` via the
    /// reliable Tauri webview-focus check). The chip shows "→ this app" and dictation never
    /// types here — the injection guard skips our own windows.
    pub is_self: bool,
}

/// Result of reading the focused element's text selection (for the Quick-Add seed + the
/// correct-on-close). `Text` = a real, non-empty selection; `Empty` = authoritatively nothing
/// selected (so we never seed a stale highlight); `Opaque` = a selection genuinely EXISTS but its
/// text is an embedded object (U+FFFC — rich-text links/images/formatting anchors), so accessibility
/// can confirm "something is selected here" but can't give the letters → the caller reads the actual
/// rendered text from PRIMARY; `Unavailable` = no Text interface / proxy error (terminals, canvases,
/// asleep trees) → can't even confirm a selection exists → the seed falls back to PRIMARY, but the
/// correct-on-close guard treats it as "don't touch" (it can't verify the word is still selected).
#[cfg_attr(windows, allow(dead_code))] // selection reads are AT-SPI (Linux); Windows seeds via win_seed
pub enum SelRead {
    Text(String),
    Empty,
    Opaque,
    Unavailable,
}

#[derive(Default)]
struct Snapshot {
    /// The most recently focused accessible (may be our own window).
    current: Option<FocusedApp>,
    /// The most recently focused accessible that ISN'T us — so "use current app" (which
    /// focuses our window when clicked) and dictation both report the app the user came
    /// from, not the frontend itself.
    last_other: Option<FocusedApp>,
    /// The app whose window is foregrounded, tracked from `window:activate` / `window:deactivate`.
    /// Element focus is accepted only from this app (or when it's `None` — the moment after a
    /// switch, incl. into an Electron app that never emits `window:activate`). This is what stops
    /// a background Electron app's stray focus from hijacking detection (the "chromium ghost").
    #[cfg_attr(windows, allow(dead_code))] // only the Linux AT-SPI listener filters on it
    active_app: Option<String>,
    /// The focused TEXT element behind `current` / `last_other`, retained so a lazy command can
    /// read its current selection via the AT-SPI Text interface WITHOUT walking the tree — the
    /// per-event tree walk is what froze apps. Moved current→last_other in lockstep with the
    /// FocusedApp above. Linux-only (the type comes from the `atspi` crate).
    #[cfg(target_os = "linux")]
    current_el: Option<::atspi::object_ref::ObjectRefOwned>,
    #[cfg(target_os = "linux")]
    last_other_el: Option<::atspi::object_ref::ObjectRefOwned>,
}

/// Managed state: the lazily-started a11y listener + the deep-detection switch.
pub struct AtspiGuard {
    started: parking_lot::Mutex<bool>,
    snapshot: Arc<parking_lot::Mutex<Snapshot>>,
    /// Opt-in "deep field detection": flip the a11y flag + poke Chromium/Electron trees.
    deep: Arc<AtomicBool>,
}

impl Default for AtspiGuard {
    fn default() -> Self {
        Self {
            started: parking_lot::Mutex::new(false),
            snapshot: Arc::new(parking_lot::Mutex::new(Snapshot::default())),
            deep: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Our own windows, by the WebKitGTK a11y app name. Used to keep `last_other` pointing at the
/// app the user came from (for the AppRules "use current" capture). The AUTHORITATIVE "our
/// window is focused right now" signal is the Tauri webview-focus check in `get_focused_app`;
/// this string match is only a best-effort fallback for the snapshot bookkeeping.
fn is_self(app_id: &str) -> bool {
    let a = app_id.to_lowercase();
    // "fasterwhisper": the identifier (org.fasterwhisper.frontend), which is what GTK derives
    // the application id — and with it the a11y app name — from on some desktops.
    a.contains("faster-whisper") || a.contains("faster_whisper") || a.contains("fasterwhisper")
}

/// Apps that must never be treated as a dictation target, so their focus events don't clobber
/// the real one (`last_other`): our own window, the compositor / session-manager (kwin,
/// ksmserver), AND plasmashell / plasma-desktop. plasmashell is the desktop SHELL — its panels,
/// taskbar, system tray and widgets emit focus events CONSTANTLY (hovering/clicking a panel,
/// notifications, etc.), which would otherwise show as "→ plasmashell" while you actually have a
/// real window focused. We lose its Kickoff launcher search as a target by this, but the
/// spurious-detection noise far outweighs that — and KRunner covers launcher dictation.
/// NOTE: `krunner` is deliberately NOT noise — it's a separate, on-demand search popup, focused
/// only when you actively open it, so it's a legitimate (and quiet) dictation target.
fn is_noise(app_id: &str) -> bool {
    if is_self(app_id) {
        return true;
    }
    let a = app_id.to_lowercase();
    a.starts_with("kwin") || a == "ksmserver" || a == "plasmashell" || a.contains("plasma-desktop")
}

/// Start the focus listener once (idempotent). Spawns on Tauri's async runtime so it can
/// be called from `setup` (eager warm-up) as well as from the async commands.
pub fn start(g: &AtspiGuard) {
    #[cfg(target_os = "linux")]
    {
        let mut started = g.started.lock();
        if *started {
            return;
        }
        *started = true;
        let snapshot = g.snapshot.clone();
        let deep = g.deep.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = atspi::run(snapshot, deep).await {
                tracing::warn!("[atspi] focus listener stopped: {e}");
            }
        });
    }
    // Windows: the foreground tracker owns a Win32 message pump, so it gets a
    // plain thread (not the async runtime). It feeds the same snapshot.
    #[cfg(windows)]
    {
        let mut started = g.started.lock();
        if *started {
            return;
        }
        let snapshot = g.snapshot.clone();
        match std::thread::Builder::new()
            .name("win-focus".into())
            .spawn(move || windows::run(snapshot))
        {
            Ok(_) => *started = true,
            Err(e) => tracing::warn!("[atspi] win-focus thread spawn failed: {e}"),
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = g;
    }
}

/// Toggle opt-in deep field detection (a11y flag + Chromium/Electron poke). The running
/// listener applies it on its next tick; also ensures the listener exists.
pub fn set_deep(g: &AtspiGuard, enabled: bool) {
    g.deep.store(enabled, Ordering::SeqCst);
    start(g);
}

/// The focused app (its id + title + editability), or `None` when nothing is known yet
/// (cold listener / no a11y). Reports the most recent NON-self focused app.
/// Synchronous — it's a cached-snapshot read, no a11y round-trip — so SYNC commands
/// (the clipboard-restore gating) can use it too; `focused_app` is the async wrapper.
pub fn focused_app_now(g: &AtspiGuard) -> Option<FocusedApp> {
    start(g);
    let snap = g.snapshot.lock();
    // Prefer the app focused RIGHT NOW. Only when our own window (or the shell) holds
    // focus — e.g. clicking "use current", or triggering dictation from our UI — fall
    // back to the app focused just before us. This (with update_snapshot setting
    // last_other only at the transition into our window) is what stops detection from
    // sticking on a stale app.
    match &snap.current {
        Some(c) if !is_noise(&c.app_id) => Some(c.clone()),
        _ => snap.last_other.clone(),
    }
}

pub async fn focused_app(g: &AtspiGuard) -> Option<FocusedApp> {
    focused_app_now(g)
}

/// Read the CURRENT text selection of the focused element of the same non-self app `focused_app`
/// reports. Lazy + time-bounded; this is a one-shot query to a single RETAINED element ref, never
/// a per-event tree walk (which froze apps). Used to seed Quick-Add from the live selection and to
/// confirm, on close, that the same text is still selected before correcting it.
#[cfg_attr(windows, allow(dead_code))] // AT-SPI (Linux) path; Windows seeds via win_seed's copy grab
pub async fn focused_selection(g: &AtspiGuard) -> SelRead {
    start(g);
    #[cfg(target_os = "linux")]
    {
        // Pick the element ref for the SAME app focused_app() would report (current if not noise,
        // else last_other), so the seed/correction targets the app the user came from — not us.
        let el = {
            let snap = g.snapshot.lock();
            match &snap.current {
                Some(c) if !is_noise(&c.app_id) => snap.current_el.clone(),
                _ => snap.last_other_el.clone(),
            }
        };
        match el {
            Some(el) => atspi::read_selection(el).await,
            None => SelRead::Unavailable,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = g;
        SelRead::Unavailable
    }
}

// The Windows tracker lives in its own file but stays a CHILD of this module so
// it can fold into the private `Snapshot` with the exact `set_current` semantics.
#[cfg(windows)]
mod windows;
/// Pid → exe basename, the identity `windows` gives apps (see there). Re-exported for
/// `win_clip`, which names the process behind each clipboard fetch.
#[cfg(windows)]
pub(crate) use windows::exe_basename;

#[cfg(target_os = "linux")]
mod atspi;

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::atspi::{next_failures, should_log};

    #[test]
    fn our_own_app_is_recognised_under_every_name_a_desktop_may_report() {
        assert!(super::is_self("faster-whisper-frontend"));
        assert!(super::is_self("Faster_Whisper_Frontend"));
        assert!(super::is_self("org.fasterwhisper.frontend"));
        assert!(!super::is_self("org.kde.kate"));
    }

    #[test]
    fn a_long_lived_connection_resets_the_counter_for_either_outcome() {
        assert_eq!(next_failures(45, true), 1);
        assert_eq!(next_failures(45, false), 46);
        assert_eq!(next_failures(0, false), 1);
    }

    #[test]
    fn reconnect_log_gate_is_first_plus_every_30th() {
        assert!(should_log(1));
        assert!(!should_log(2));
        assert!(!should_log(29));
        assert!(should_log(30));
        assert!(!should_log(31));
        assert!(should_log(60));
    }
}
