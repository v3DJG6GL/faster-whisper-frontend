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
/// Serialised camelCase for the frontend (`{ appId, title, editable }`).
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedApp {
    pub app_id: String,
    pub title: String,
    /// `Some(true)` editable text field · `Some(false)` definitely not · `None` unknown
    /// (no a11y tree, asleep, or no focus event yet) — callers must treat `None` as "type".
    pub editable: Option<bool>,
}

#[derive(Default)]
struct Snapshot {
    /// The most recently focused accessible (may be our own window).
    current: Option<FocusedApp>,
    /// The most recently focused accessible that ISN'T us — so "use current app" (which
    /// focuses our window when clicked) and dictation both report the app the user came
    /// from, not the frontend itself.
    last_other: Option<FocusedApp>,
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

/// Apps that must never be treated as a dictation target, so their focus events don't
/// clobber the real one (`last_other`): our own window, plus the KDE desktop shell /
/// compositor / session bits. plasmashell in particular fires focus events for its panels,
/// taskbar and widgets — e.g. when you click the taskbar to switch windows — which would
/// otherwise overwrite the app you actually came from.
fn is_noise(app_id: &str) -> bool {
    let a = app_id.to_lowercase();
    // our own window
    a.contains("faster-whisper")
        || a.contains("faster_whisper")
        || a.contains("informethic")
        // KDE shell / compositor / session — never a target, but they emit focus events
        || a == "plasmashell"
        || a.contains("plasma-desktop")
        || a.starts_with("kwin")
        || a == "ksmserver"
        || a == "krunner"
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

#[cfg(target_os = "linux")]
mod imp {
    use atspi::connection::{set_session_accessibility, AccessibilityConnection};
    use atspi::events::focus::FocusEvent;
    use atspi::events::object::StateChangedEvent;
    use atspi::events::window::ActivateEvent;
    use atspi::events::{Event, FocusEvents, ObjectEvents, WindowEvents};
    use atspi::object_ref::ObjectRefOwned;
    use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
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
        let pending: Arc<parking_lot::Mutex<Option<(ObjectRefOwned, bool)>>> =
            Arc::new(parking_lot::Mutex::new(None));
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
                    // Coalesce: take only the most recent focus; bursts in between are stale.
                    let Some((item, read_editable)) = pending.lock().take() else { continue };
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(1000),
                        resolve_focus(item, &bus, deep.load(Ordering::Relaxed), read_editable),
                    )
                    .await
                    {
                        Ok(Some((app_id, editable))) => update_snapshot(&snapshot, app_id, editable),
                        Ok(None) => {}
                        Err(_) => {} // resolve timed out (busy app) — skip; the next event re-tries
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
                    let (item, read_editable) = match ev {
                        Event::Object(ObjectEvents::StateChanged(e))
                            if e.state == State::Focused && e.enabled => (e.item, true),
                        Event::Focus(FocusEvents::Focus(e)) => (e.item, true),
                        Event::Window(WindowEvents::Activate(e)) => (e.item, false),
                        _ => continue,
                    };
                    // Hand the newest focus to the resolver (replacing any not-yet-resolved
                    // one) and nudge it. This never blocks on the a11y round-trips themselves.
                    *pending.lock() = Some((item, read_editable));
                    notify.notify_one();
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

    /// Read a focus/window-activate source's app id (+ editability for element focus) off the
    /// a11y bus. Pure I/O — the caller bounds it with a timeout and does the sync snapshot
    /// update. Returns `None` if it can't resolve (proxy error / empty name).
    async fn resolve_focus(
        item: ObjectRefOwned,
        bus: &zbus::Connection,
        deep: bool,
        read_editable: bool,
    ) -> Option<(String, Option<bool>)> {
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
            // Window activation reports the frame, not a field → editability unknown. None →
            // the positive-only guard types anyway (safe default) until an element is focused.
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
        Some((app_id, editable))
    }

    /// Fold a resolved focus into the cached snapshot. `current` always tracks the latest
    /// focused app. `last_other` captures the app focused immediately BEFORE our own window —
    /// so "use current" / dictation triggered from our UI reports the app you came from, not
    /// us. Crucially `last_other` is set only at the transition INTO our window, so it can't
    /// get stuck on a stale app (the previous bug). Sync; holds the lock only briefly.
    fn update_snapshot(
        snapshot: &parking_lot::Mutex<super::Snapshot>,
        app_id: String,
        editable: Option<bool>,
    ) {
        let new_is_noise = super::is_noise(&app_id);
        let fa = super::FocusedApp {
            title: app_id.clone(),
            app_id,
            editable,
        };
        let mut snap = snapshot.lock();
        if new_is_noise {
            // Switching TO our own window (or the shell): remember what was focused just
            // before, so callers can report the real target rather than us.
            if let Some(prev) = snap.current.take() {
                if !super::is_noise(&prev.app_id) {
                    snap.last_other = Some(prev);
                }
            }
        }
        snap.current = Some(fa);
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
