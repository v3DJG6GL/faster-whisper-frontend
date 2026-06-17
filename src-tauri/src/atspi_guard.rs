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
//! Non-Linux builds compile to no-op stubs: the snapshot stays empty, `focused_app`
//! returns `None`, and callers degrade to today's behavior.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
/// selected (so we never seed a stale highlight); `Unavailable` = no Text interface / proxy error
/// (terminals, canvases, asleep trees) → the caller falls back (e.g. to the PRIMARY selection).
pub enum SelRead {
    Text(String),
    Empty,
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
    active_app: Option<String>,
    /// The focused TEXT element behind `current` / `last_other`, retained so a lazy command can
    /// read its current selection via the AT-SPI Text interface WITHOUT walking the tree — the
    /// per-event tree walk is what froze apps. Moved current→last_other in lockstep with the
    /// FocusedApp above. Linux-only (the type comes from the `atspi` crate).
    #[cfg(target_os = "linux")]
    current_el: Option<atspi::object_ref::ObjectRefOwned>,
    #[cfg(target_os = "linux")]
    last_other_el: Option<atspi::object_ref::ObjectRefOwned>,
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
    a.contains("faster-whisper") || a.contains("faster_whisper") || a.contains("informethic")
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
            if let Err(e) = imp::run(snapshot, deep).await {
                tracing::warn!("[atspi] focus listener stopped: {e}");
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
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
pub async fn focused_app(g: &AtspiGuard) -> Option<FocusedApp> {
    start(g);
    let result = {
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
    };
    result
}

/// Read the CURRENT text selection of the focused element of the same non-self app `focused_app`
/// reports. Lazy + time-bounded; this is a one-shot query to a single RETAINED element ref, never
/// a per-event tree walk (which froze apps). Used to seed Quick-Add from the live selection and to
/// confirm, on close, that the same text is still selected before correcting it.
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
            Some(el) => imp::read_selection(el).await,
            None => SelRead::Unavailable,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = g;
        SelRead::Unavailable
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use atspi::connection::{set_session_accessibility, AccessibilityConnection};
    use atspi::events::focus::FocusEvent;
    use atspi::events::object::StateChangedEvent;
    use atspi::events::window::{ActivateEvent, DeactivateEvent};
    use atspi::events::{Event, FocusEvents, ObjectEvents, WindowEvents};
    use atspi::object_ref::ObjectRefOwned;
    use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
    use atspi::proxy::text::TextProxy;
    use atspi::zbus;
    use atspi::{Role, State};
    use futures_util::StreamExt;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    type Guarded = Arc<parking_lot::Mutex<super::Snapshot>>;

    pub(super) async fn run(snapshot: Guarded, deep: Arc<AtomicBool>) -> Result<(), String> {
        // CRITICAL: enable session accessibility so app a11y bridges actually EMIT events.
        // Without this, Qt/GTK/Chromium stay dormant and the event stream is silent (this is
        // what libatspi's init does). Best-effort; left on after exit — benign, and KDE's
        // QT_ACCESSIBILITY=1 already implies it. This makes app detection work WITHOUT deep
        // detection; deep detection then only adds the Chromium/Electron poke.
        let _ = set_session_accessibility(true).await;
        // Reconnect loop: the a11y connection can die — registry daemon restart, or (the big
        // one for long sessions) suspend/resume drops the bus. If we just returned, the task
        // would exit forever and the snapshot would freeze on the last-seen app (looked like
        // "worked for a while, then everything became konsole"). So we always reconnect.
        loop {
            match run_once(snapshot.clone(), deep.clone()).await {
                Ok(()) => tracing::warn!("[atspi] event stream ended — reconnecting"),
                Err(e) => tracing::warn!("[atspi] listener error: {e} — reconnecting"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }

    /// One connection's lifetime: connect, register, pump events until the stream ends or
    /// errors (then `run` reconnects). Returns `Ok(())` on a clean stream end.
    async fn run_once(snapshot: Guarded, deep: Arc<AtomicBool>) -> Result<(), String> {
        let conn = AccessibilityConnection::new()
            .await
            .map_err(|e| format!("a11y bus connect: {e}"))?;
        conn.register_event::<StateChangedEvent>()
            .await
            .map_err(|e| format!("register state-changed: {e}"))?;
        conn.register_event::<FocusEvent>()
            .await
            .map_err(|e| format!("register focus: {e}"))?;
        // Window activation tracks Alt-Tab / window switches (no element-focus change fires).
        conn.register_event::<ActivateEvent>()
            .await
            .map_err(|e| format!("register window-activate: {e}"))?;
        // Deactivation clears the foreground mark — essential so that switching INTO an Electron
        // app (which never emits window:activate) is accepted instead of rejected as a ghost.
        conn.register_event::<DeactivateEvent>()
            .await
            .map_err(|e| format!("register window-deactivate: {e}"))?;
        // Owned clone of the underlying bus for proxy calls — keeps off the event
        // stream's borrow of `conn`.
        let bus = conn.connection().clone();
        let mut stream = std::pin::pin!(conn.event_stream());
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(4));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tracing::info!("[atspi] focus listener started");

        // Resolve focus OFF the event loop, in a single COALESCING task that always works on
        // the LATEST focus. Why: resolving one focus is several sequential D-Bus round-trips
        // serviced on the *target app's* UI thread, so a busy window (a terminal streaming
        // output, the dev server) can take >1s. Doing it inline made the loop await each
        // resolve serially — under load every resolve timed out, `update_snapshot` never ran,
        // and the snapshot FROZE on the last app that did resolve. That looked like "every
        // window is Firefox and it stopped typing": the stale `editable=Some(false)` then
        // coerced injection to clipboard, so nothing was typed. (Confirmed from the debug log:
        // a long unbroken run of resolve-timeouts with ZERO snapshot updates.) Now the loop
        // only records the newest focus and nudges the resolver; a slow app can stall just
        // that one task (bounded), never freezing detection of other apps — the resolver
        // always grabs the CURRENT focus, not a backlog of stale events.
        // Three coalescing slots — latest window:activate, window:deactivate, and element focus.
        // Each is its OWN slot so a burst can't drop the activate/deactivate that drive foreground
        // tracking (the bug a single shared slot caused). Resolved OFF the event loop (a11y
        // round-trips run on the target app's UI thread). Processed per cycle in the order
        // activate → deactivate → focus so the foreground mark is right before focus is gated.
        let pending: Arc<
            parking_lot::Mutex<(
                Option<ObjectRefOwned>,
                Option<ObjectRefOwned>,
                Option<ObjectRefOwned>,
            )>,
        > = Arc::new(parking_lot::Mutex::new((None, None, None)));
        let notify = Arc::new(tokio::sync::Notify::new());
        let resolver = {
            let pending = pending.clone();
            let notify = notify.clone();
            let snapshot = snapshot.clone();
            let bus = bus.clone();
            let deep = deep.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    notify.notified().await;
                    let (act, deact, foc) = {
                        let mut p = pending.lock();
                        (p.0.take(), p.1.take(), p.2.take())
                    };
                    let deep = deep.load(Ordering::Relaxed);
                    // window:activate → mark this app foreground. Only a genuine activation reports
                    // STATE_ACTIVE; a background app's stray activate reports false → ignore it.
                    if let Some(item) = act {
                        if let Ok(Some((app_id, _, active))) = tokio::time::timeout(
                            std::time::Duration::from_millis(1000),
                            resolve_focus(&item, &bus, deep, false, true),
                        )
                        .await
                        {
                            if active != Some(false) {
                                note_activate(&snapshot, app_id);
                            }
                        }
                    }
                    // window:deactivate → if it's the app we had marked foreground, clear the mark.
                    if let Some(item) = deact {
                        if let Ok(Some((app_id, _, _))) = tokio::time::timeout(
                            std::time::Duration::from_millis(1000),
                            resolve_focus(&item, &bus, deep, false, false),
                        )
                        .await
                        {
                            note_deactivate(&snapshot, &app_id);
                        }
                    }
                    // element focus → accept only from the foreground app (or when none is marked).
                    if let Some(item) = foc {
                        if let Ok(Some((app_id, editable, _))) = tokio::time::timeout(
                            std::time::Duration::from_millis(1000),
                            resolve_focus(&item, &bus, deep, true, false),
                        )
                        .await
                        {
                            // Hand the element ref to the snapshot so a later command can read its
                            // selection (Quick-Add seed + correct-on-close) without a tree walk.
                            note_focus(&snapshot, app_id, editable, item);
                        }
                    }
                }
            })
        };

        let result = loop {
            tokio::select! {
                ev = stream.next() => {
                    let Some(ev) = ev else { break Ok(()) }; // stream ended → reconnect
                    let Ok(ev) = ev else { continue };
                    // Pull out the source + whether to read editability. Element focus
                    // (state-changed:focused / focus) carries a real field; window:activate
                    // (Alt-Tab / clicking another window) carries the frame, so we skip
                    // editability there — but it's ESSENTIAL: without it, switching windows
                    // without changing the focused element wouldn't update detection.
                    // Route the event to its slot: element focus (carries a real field),
                    // window:activate (marks foreground), window:deactivate (clears it). Separate
                    // slots so a burst can't coalesce away the activate/deactivate.
                    let routed = {
                        let mut p = pending.lock();
                        match ev {
                            Event::Object(ObjectEvents::StateChanged(e))
                                if e.state == State::Focused && e.enabled =>
                            {
                                p.2 = Some(e.item);
                                true
                            }
                            Event::Focus(FocusEvents::Focus(e)) => {
                                p.2 = Some(e.item);
                                true
                            }
                            Event::Window(WindowEvents::Activate(e)) => {
                                p.0 = Some(e.item);
                                true
                            }
                            Event::Window(WindowEvents::Deactivate(e)) => {
                                p.1 = Some(e.item);
                                true
                            }
                            _ => false,
                        }
                    };
                    // Nudge the resolver only if we actually stored an event. Never blocks on the
                    // a11y round-trips themselves.
                    if routed {
                        notify.notify_one();
                    }
                }
                _ = ticker.tick() => {
                    // Deep detection only adds the poke now (accessibility is enabled at
                    // startup). Spawn it so a slow poke over many apps can't stall this loop.
                    if deep.load(Ordering::Relaxed) {
                        let bus2 = bus.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = poke_all(&bus2).await;
                        });
                    }
                }
            }
        };
        // Don't leak the resolver across reconnects — each `run_once` owns exactly one.
        resolver.abort();
        result
    }

    /// Read a source's app id, editability (element focus), and whether its window is ACTIVE
    /// (window:activate). Pure I/O — the caller bounds it with a timeout. Returns `None` if it
    /// can't resolve (proxy error / empty name). `read_editable` reads the element's role/state
    /// (focus events); `read_active` reads the frame's STATE_ACTIVE (window:activate, to reject a
    /// background app's stray activate). Both off for window:deactivate (app id is enough).
    async fn resolve_focus(
        item: &ObjectRefOwned,
        bus: &zbus::Connection,
        deep: bool,
        read_editable: bool,
        read_active: bool,
    ) -> Option<(String, Option<bool>, Option<bool>)> {
        let acc = item.as_accessible_proxy(bus).await.ok()?;
        let editable = if read_editable {
            if deep {
                // The "Orca signal": wakes on-demand a11y trees (Chromium/Electron) so the
                // EDITABLE state we read next is accurate rather than empty.
                let _ = acc.get_attributes().await;
                let _ = acc.get_relation_set().await;
            }
            match acc.get_role().await.ok() {
                // Terminals expose role=terminal and never EDITABLE; whitelist as typable.
                Some(Role::Terminal) => Some(true),
                _ => acc.get_state().await.ok().map(|s| s.contains(State::Editable)),
            }
        } else {
            None
        };
        let active = if read_active {
            acc.get_state().await.ok().map(|s| s.contains(State::Active))
        } else {
            None
        };
        let app_id = acc
            .get_application()
            .await
            .ok()?
            .as_accessible_proxy(bus)
            .await
            .ok()?
            .name()
            .await
            .ok()?;
        if app_id.is_empty() {
            return None;
        }
        Some((app_id, editable, active))
    }

    /// Read the current text selection of a RETAINED element via its AT-SPI Text interface, on a
    /// fresh short-lived connection (a lazy one-shot from a command, never the event loop). The
    /// whole read is time-bounded so an unresponsive app can't hang the caller. Distinguishes a
    /// genuinely-empty selection (`Empty`) from "no Text interface / proxy error" (`Unavailable`).
    pub(super) async fn read_selection(el: ObjectRefOwned) -> super::SelRead {
        let conn = match AccessibilityConnection::new().await {
            Ok(c) => c,
            Err(_) => return super::SelRead::Unavailable,
        };
        let bus = conn.connection().clone();
        let read = async move {
            // Build a Text proxy for the element from its (bus name, path) — same construction as
            // `as_accessible_proxy`, but for the Text interface.
            let Some(name) = el.name() else {
                return super::SelRead::Unavailable;
            };
            let dest: zbus::names::BusName = name.clone().into();
            let builder = match TextProxy::builder(&bus).destination(dest) {
                Ok(b) => b,
                Err(_) => return super::SelRead::Unavailable,
            };
            let builder = match builder.path(el.path().clone()) {
                Ok(b) => b,
                Err(_) => return super::SelRead::Unavailable,
            };
            let text = match builder
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await
            {
                Ok(t) => t,
                Err(_) => return super::SelRead::Unavailable,
            };
            // No Text interface (terminals, canvases) → GetNSelections errors → can't tell.
            let n = match text.get_n_selections().await {
                Ok(n) => n,
                Err(_) => return super::SelRead::Unavailable,
            };
            if n <= 0 {
                return super::SelRead::Empty;
            }
            let (start, end) = match text.get_selection(0).await {
                Ok(v) => v,
                Err(_) => return super::SelRead::Unavailable,
            };
            if end <= start {
                return super::SelRead::Empty;
            }
            match text.get_text(start, end).await {
                Ok(s) => super::SelRead::Text(s),
                Err(_) => super::SelRead::Unavailable,
            }
        };
        match tokio::time::timeout(std::time::Duration::from_millis(800), read).await {
            Ok(r) => r,
            Err(_) => super::SelRead::Unavailable,
        }
    }

    /// A genuine `window:activate`: mark `app_id` foreground and fold it into the snapshot. The
    /// element is the window FRAME (not a text field), so no selection source is stored here.
    fn note_activate(snapshot: &parking_lot::Mutex<super::Snapshot>, app_id: String) {
        let mut snap = snapshot.lock();
        snap.active_app = Some(app_id.clone());
        set_current(&mut snap, app_id, None, None);
    }

    /// A `window:deactivate`: if it's the app currently marked foreground, clear the mark — so the
    /// next element focus (incl. switching INTO an Electron app, which never emits window:activate)
    /// is accepted rather than rejected as a background ghost.
    fn note_deactivate(snapshot: &parking_lot::Mutex<super::Snapshot>, app_id: &str) {
        let mut snap = snapshot.lock();
        if snap.active_app.as_deref() == Some(app_id) {
            snap.active_app = None;
        }
    }

    /// An element focus. Accept ONLY from the foreground app, or when none is marked foreground
    /// (the moment right after a switch). A background app's stray focus while a DIFFERENT app is
    /// foreground is rejected — that's the "chromium ghost" gate.
    fn note_focus(
        snapshot: &parking_lot::Mutex<super::Snapshot>,
        app_id: String,
        editable: Option<bool>,
        element: ObjectRefOwned,
    ) {
        let mut snap = snapshot.lock();
        if let Some(active) = snap.active_app.as_deref() {
            if active != app_id.as_str() {
                return;
            }
        }
        set_current(&mut snap, app_id, editable, Some(element));
    }

    /// Fold a focused app into the snapshot. `current` tracks the latest; `last_other` captures the
    /// app focused immediately BEFORE our own window (set only at that transition, so it can't get
    /// stuck on a stale app). Sync; the caller holds the lock.
    fn set_current(
        snap: &mut super::Snapshot,
        app_id: String,
        editable: Option<bool>,
        element: Option<ObjectRefOwned>,
    ) {
        let new_is_noise = super::is_noise(&app_id);
        let fa = super::FocusedApp {
            title: app_id.clone(),
            app_id,
            editable,
            is_self: false,
        };
        if new_is_noise {
            if let Some(prev) = snap.current.take() {
                if !super::is_noise(&prev.app_id) {
                    snap.last_other = Some(prev);
                    // Carry the real app's element ref over in lockstep, so the selection source
                    // survives our own window (or the shell) taking focus on summon.
                    snap.last_other_el = snap.current_el.take();
                }
            }
        }
        snap.current = Some(fa);
        snap.current_el = element;
    }

    /// Poke every application's top of tree (bounded depth/breadth) so Chromium/Electron
    /// build their web tree. Harmless for Qt/GTK apps (already built → cheap reads).
    async fn poke_all(bus: &zbus::Connection) -> zbus::Result<()> {
        let root = AccessibleProxy::builder(bus)
            .destination("org.a11y.atspi.Registry")?
            .path("/org/a11y/atspi/accessible/root")?
            .build()
            .await?;
        if let Ok(apps) = root.get_children().await {
            for app in apps {
                if let Ok(p) = app.as_accessible_proxy(bus).await {
                    poke(&p, bus, 2).await;
                }
            }
        }
        Ok(())
    }

    /// Recursively read attributes/relations to signal "AT present" (boxed: async recursion).
    fn poke<'a>(
        acc: &'a AccessibleProxy<'_>,
        bus: &'a zbus::Connection,
        depth: u8,
    ) -> Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let _ = acc.get_attributes().await;
            let _ = acc.get_relation_set().await;
            if depth == 0 {
                return;
            }
            if let Ok(children) = acc.get_children().await {
                for child in children.into_iter().take(4) {
                    if let Ok(p) = child.as_accessible_proxy(bus).await {
                        poke(&p, bus, depth - 1).await;
                    }
                }
            }
        })
    }

}
