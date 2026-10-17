//! The Linux AT-SPI listener behind [`super`]: subscribes to focus/window events, feeds the
//! shared `Snapshot`, and reads the focused element's selection on demand.

use atspi::events::focus::FocusEvent;
use atspi::events::object::StateChangedEvent;
use atspi::events::window::{ActivateEvent, DeactivateEvent};
use atspi::events::{Event, FocusEvents, ObjectEvents, WindowEvents};
use atspi::object_ref::ObjectRefOwned;
use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
use atspi::proxy::text::TextProxy;
use atspi::zbus;
use atspi::{Role, State};
use atspi_connection::{set_session_accessibility, AccessibilityConnection};
use futures_util::StreamExt;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

type Guarded = Arc<parking_lot::Mutex<super::Snapshot>>;

/// The reconnect counter after one connection ended: reset when it pumped ≥60 s (a healthy
/// long-lived connection means a NEW incident, whichever way it ended), then count this end.
pub(super) fn next_failures(failures: u32, pumped_60s: bool) -> u32 {
    let base = if pumped_60s { 0 } else { failures };
    base.saturating_add(1)
}

/// First + every 30th — the shared dedup gate for both reconnect outcomes, so
/// neither a fast-ending stream nor an Err/Ok alternation can flood the ring
/// at the retry cadence (2 s, backing off to 30 s).
pub(super) fn should_log(failures: u32) -> bool {
    failures == 1 || failures.is_multiple_of(30)
}

/// The pause before the next reconnect: 2 s, doubling per consecutive failure (4, 8, 16),
/// capped at 30 s — a session with no working a11y bus otherwise re-opens connections and
/// re-triggers a failed D-Bus activation every few seconds forever. The cap keeps a
/// late-starting bus picked up within 30 s; `next_failures` resetting to 1 after a
/// long-lived connection keeps the ordinary bus-restart recovery at 2 s.
pub(super) fn retry_delay(failures: u32) -> Duration {
    let exp = failures.saturating_sub(1).min(4);
    Duration::from_secs(2)
        .saturating_mul(1u32 << exp)
        .min(Duration::from_secs(30))
}

pub(super) async fn run(snapshot: Guarded, deep: Arc<AtomicBool>) -> Result<(), String> {
    // Reconnect loop: the a11y connection can die — registry daemon restart, or (the big
    // one for long sessions) suspend/resume drops the bus. If we just returned, the task
    // would exit forever and the snapshot would freeze on the last-seen app (looked like
    // "worked for a while, then everything became konsole"). So we always reconnect.
    // Repeated failures log dedup'd (first + every 30th) — a broken bus otherwise floods
    // the journal at one warn per retry (2 s, backing off to 30 s) for as long as the
    // outage lasts.
    let mut failures: u32 = 0;
    loop {
        // CRITICAL: enable session accessibility so app a11y bridges actually EMIT events.
        // Without this, Qt/GTK/Chromium stay dormant and the event stream is silent (this is
        // what libatspi's init does). Best-effort; left on after exit — benign, and KDE's
        // QT_ACCESSIBILITY=1 already implies it. This makes app detection work WITHOUT deep
        // detection; deep detection then only adds the Chromium/Electron poke.
        // Inside the reconnect loop, not once before it: a restarted at-spi-bus-launcher
        // comes back with IsEnabled=false, so after a bus restart we must re-assert it or
        // freshly started apps never bridge and we reconnect onto a silent bus forever.
        // Time-bounded + retried: on a congested/half-wedged session bus this call can hang
        // or error. run_once below will happily connect to a SILENT stream if it never
        // lands, and a silent stream never "ends", so the reconnect loop alone wouldn't
        // retry it. Bounded so a permanently-failing call (unsupported, or already implied
        // by KDE's QT_ACCESSIBILITY=1 — which succeeds on the first try) still lets us
        // proceed to connect.
        for _ in 0..3 {
            match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                set_session_accessibility(true),
            )
            .await
            {
                Ok(Ok(())) => break,
                _ => tokio::time::sleep(std::time::Duration::from_secs(1)).await,
            }
        }
        let started = std::time::Instant::now();
        let outcome = run_once(snapshot.clone(), deep.clone()).await;
        // A stream that ENDS is a failure shape too (bus restart): count it, and clear
        // the counter only after a connection that actually pumped for a while — a fast
        // end (or an Err/Ok alternation) would otherwise reset past the gate and flood at
        // one warn per retry (2 s, backing off to 30 s). Both outcomes: a long-lived connection that finally dies
        // with an ERROR opens a new incident whose first warn must not be swallowed by a
        // counter an earlier outage left at 45.
        failures = next_failures(
            failures,
            started.elapsed() >= std::time::Duration::from_secs(60),
        );
        if should_log(failures) {
            match &outcome {
                Ok(()) => tracing::warn!(
                    "[atspi] event stream ended — reconnecting (failure #{failures}, logging first + every 30th)"
                ),
                Err(e) => tracing::warn!(
                    "[atspi] listener error: {e} — reconnecting (failure #{failures}, logging first + every 30th)"
                ),
            }
        }
        tokio::time::sleep(retry_delay(failures)).await;
    }
}

/// One connection's lifetime: connect, register, pump events until the stream ends or
/// errors (then `run` reconnects). Returns `Ok(())` on a clean stream end.
async fn run_once(snapshot: Guarded, deep: Arc<AtomicBool>) -> Result<(), String> {
    // Connect + register, time-bounded: on a congested or half-wedged session/a11y bus these
    // D-Bus round-trips can hang indefinitely, leaving the listener neither connected NOR
    // erroring — so `run`'s reconnect loop never fires and detection is dead until an app
    // restart (the "this app works, others show nothing" symptom). A timeout turns a hang into
    // a normal error the loop retries after its backoff, so the listener self-heals.
    let conn = tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
        Ok::<_, String>(conn)
    })
    .await
    .map_err(|_| "connect/register timed out".to_string())??;
    // Owned clone of the underlying bus for proxy calls — keeps off the event
    // stream's borrow of `conn`.
    let bus = conn.connection().clone();
    let mut stream = std::pin::pin!(conn.event_stream());
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(4));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Single-flight guard for the periodic deep-detection poke (see the ticker arm below).
    let poke_busy = Arc::new(AtomicBool::new(false));
    // window:activate/deactivate events were lost while disconnected (`run` reuses this
    // snapshot across reconnects), so a kept foreground mark may name an app the user has
    // since left — and note_focus would reject every focus from the app actually in front.
    // Fail open until the next window:activate, like "the moment after a switch".
    clear_mark(&mut snapshot.lock());
    tracing::info!("[atspi] focus listener started");

    // Resolve focus OFF the event loop, in a single COALESCING task that always works on
    // the LATEST focus. Why: resolving one focus is several sequential D-Bus round-trips
    // serviced on the *target app's* UI thread, so a busy window (a terminal streaming
    // output, the dev server) can take >1s. Doing it inline made the loop await each
    // resolve serially — under load every resolve timed out, `set_current` never ran,
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
    // activate → deactivate → focus so the foreground mark is right before focus is gated —
    // except when the deactivate ARRIVED first (a same-app window switch: deactivate A, then
    // activate A): replaying it after the activate would clear A's mark although A is in front.
    // The window slots carry an arrival sequence number for that check.
    type Slots = (
        Option<(u64, ObjectRefOwned)>,
        Option<(u64, ObjectRefOwned)>,
        Option<ObjectRefOwned>,
    );
    let pending: Arc<parking_lot::Mutex<Slots>> =
        Arc::new(parking_lot::Mutex::new((None, None, None)));
    let notify = Arc::new(tokio::sync::Notify::new());
    let resolver = {
        let pending = pending.clone();
        let notify = notify.clone();
        let snapshot = snapshot.clone();
        let bus = bus.clone();
        let deep = deep.clone();
        tauri::async_runtime::spawn(async move {
            // The last element focus note_focus rejected for another app's foreground mark (see
            // replay_parked). Resolver-local: only this task reads or writes it.
            let mut parked: Option<Parked> = None;
            loop {
                notify.notified().await;
                let (act, deact, foc) = {
                    let mut p = pending.lock();
                    (p.0.take(), p.1.take(), p.2.take())
                };
                let deep = deep.load(Ordering::Relaxed);
                let mark_before = snapshot.lock().active_app.clone();
                let deact_bus = deact
                    .as_ref()
                    .and_then(|(_, item)| item.name_as_str().map(str::to_owned));
                // Deactivate first only when it arrived before the activate (see Slots).
                let deact_first = matches!((&act, &deact), (Some((a, _)), Some((d, _))) if d < a);
                // window:activate → mark this app foreground. Only a genuine activation reports
                // STATE_ACTIVE; a background app's stray activate reports false → ignore it.
                let activate = async {
                    if let Some((_, item)) = act {
                        if let Ok(Some((app_id, _, active))) = tokio::time::timeout(
                            std::time::Duration::from_millis(1000),
                            resolve_focus(&item, &bus, deep, false, true),
                        )
                        .await
                        {
                            if active != Some(false) {
                                let sender = item.name_as_str().map(str::to_owned);
                                note_activate(&snapshot, app_id, sender);
                            }
                        }
                    }
                };
                // window:deactivate → if it's the app we had marked foreground, clear the mark.
                // Matched by the sender's bus name first (no I/O): the departing app is the one
                // most likely too busy — or already gone — to answer the resolve in time.
                let deactivate = async {
                    if let Some((_, item)) = deact {
                        if note_deactivate_bus(&snapshot, item.name_as_str()) {
                            if let Ok(Some((app_id, _, _))) = tokio::time::timeout(
                                std::time::Duration::from_millis(1000),
                                resolve_focus(&item, &bus, deep, false, false),
                            )
                            .await
                            {
                                note_deactivate(&snapshot, &app_id);
                            }
                        }
                    }
                };
                if deact_first {
                    deactivate.await;
                    activate.await;
                } else {
                    activate.await;
                    deactivate.await;
                }
                // element focus → accept only from the foreground app (or when none is marked).
                if let Some(item) = foc {
                    // A newer focus supersedes the parked one, whether or not it resolves.
                    parked = None;
                    if let Ok(Some((app_id, editable, _))) = tokio::time::timeout(
                        std::time::Duration::from_millis(1000),
                        resolve_focus(&item, &bus, deep, true, false),
                    )
                    .await
                    {
                        // Hand the element ref to the snapshot so a later command can read its
                        // selection (Quick-Add seed + correct-on-close) without a tree walk.
                        parked = note_focus(&snapshot, app_id, editable, item);
                    }
                } else {
                    replay_parked(
                        &snapshot,
                        &mut parked,
                        mark_before.as_deref(),
                        deact_bus.as_deref(),
                        std::time::Instant::now(),
                    );
                }
            }
        })
    };

    // Arrival order of window events (see Slots); a u64 never overflows in practice.
    let mut seq: u64 = 0;
    let result = loop {
        tokio::select! {
            ev = stream.next() => {
                let Some(ev) = ev else { break Ok(()) }; // stream ended → reconnect
                let Ok(ev) = ev else { continue };
                // Route the event to its slot: element focus (carries a real field),
                // window:activate (marks foreground), window:deactivate (clears it). Separate
                // slots so a burst can't coalesce away the activate/deactivate. window:activate
                // is ESSENTIAL: without it, switching windows without changing the focused
                // element wouldn't update detection.
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
                            seq += 1;
                            p.0 = Some((seq, e.item));
                            true
                        }
                        Event::Window(WindowEvents::Deactivate(e)) => {
                            seq += 1;
                            p.1 = Some((seq, e.item));
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
                // Single-flight + time-bounded: poke_all walks every app on the bus with
                // unbounded D-Bus reads, so on a congested/wedged bus one poke can stall for
                // a long time. Without a guard a fresh task would spawn every tick and pile
                // up (untracked, and they outlive this connection — resolver.abort() below
                // doesn't touch them). The flag skips a new poke while the previous is still
                // running; the timeout caps any single poke so ≤1 short-lived task is in flight.
                if deep.load(Ordering::Relaxed) && !poke_busy.swap(true, Ordering::AcqRel) {
                    let bus2 = bus.clone();
                    let busy = poke_busy.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            poke_all(&bus2),
                        )
                        .await;
                        busy.store(false, Ordering::Release);
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
            _ => acc
                .get_state()
                .await
                .ok()
                .map(|s| s.contains(State::Editable)),
        }
    } else {
        None
    };
    let active = if read_active {
        acc.get_state()
            .await
            .ok()
            .map(|s| s.contains(State::Active))
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
    // This is the focused application's OWN name, over the session a11y bus — any app can
    // choose it freely, so it is untrusted input on a par with a server string. It reaches
    // three sinks unbounded: the overlay payload rebuilt on every level tick and rendered as
    // a React child, a persisted AppRule that then rides the sync push to other devices, and
    // a default-on log line polled roughly once a second (a newline there forges records).
    // Bound and defang it once, here, where all three inherit it. Generous enough that no
    // real application name — or an existing rule keyed on one — is affected.
    let app_id = crate::transport::bounded_server_text(&app_id, crate::focus::APP_ID_MAX);
    // Emptiness is judged on the BOUNDED value: a name made only of format controls (bidi
    // overrides, ZWSP) is non-empty raw and empty after the bound, and an empty id must
    // read as "no focus" — `is_noise("")` is false, so it would otherwise be installed as
    // the current app, render a blank chip target and be capturable as an AppRule key.
    if app_id.trim().is_empty() {
        return None;
    }
    Some((app_id, editable, active))
}

/// Read the current text selection of a RETAINED element via its AT-SPI Text interface, on a
/// fresh short-lived connection (a lazy one-shot from a command, never the event loop). The
/// whole read is time-bounded so an unresponsive app can't hang the caller. Distinguishes a
/// genuinely-empty selection (`Empty`) from "no Text interface / proxy error" (`Unavailable`).
pub(super) async fn read_selection(el: ObjectRefOwned) -> super::SelRead {
    // Bound the connect too — not just the read below. A wedged a11y bus can make
    // AccessibilityConnection::new() hang indefinitely (same reason run_once bounds it),
    // and read_selection is awaited inline by get_quickadd_seed / get_focused_selection,
    // so an unbounded connect would hang the command — the exact failure this fn's
    // "whole read is time-bounded" contract promises to avoid.
    let conn = match tokio::time::timeout(
        std::time::Duration::from_millis(800),
        AccessibilityConnection::new(),
    )
    .await
    {
        Ok(Ok(c)) => c,
        _ => return super::SelRead::Unavailable, // timed out or connect error → degrade
    };
    let bus = conn.connection().clone();
    let read = async move {
        // Password/secret field → never pull its selection into the Quick-Add seed or the
        // correct-on-close guard. Native toolkits expose only masked bullets over AT-SPI, but skip
        // it outright (defence in depth). Best-effort: a proxy error / asleep tree just falls
        // through to the normal read.
        if let Ok(acc) = el.as_accessible_proxy(&bus).await {
            if matches!(acc.get_role().await, Ok(atspi::Role::PasswordText)) {
                return super::SelRead::Empty;
            }
        }
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
        // Clamp the REQUEST too, not just the reply: the range is the focused app's choice, so a
        // select-all in a huge document would otherwise ship it all over D-Bus inside the 800 ms
        // budget below. Consumers only compare for equality or take a short seed, so the clamp
        // changes nothing they see; `bounded_selection` stays the backstop (some toolkits count
        // offsets in UTF-16 units, not chars).
        let end = end.min(start.saturating_add(super::SEL_MAX as i32));
        match text.get_text(start, end).await {
            // Rich text (Thunderbird/Joplin links, images, formatting anchors) comes back with
            // U+FFFC object-replacement chars in place of the words. That's not usable plain
            // text, BUT a real selection demonstrably exists here → report Opaque so the caller
            // reads the actual rendered selection from PRIMARY (and the close-guard can still
            // trust "a selection exists in the focused app").
            Ok(s) if s.contains('\u{fffc}') => super::SelRead::Opaque,
            // Bound at the READ, so every consumer inherits it (H13's shape, applied to
            // `resolve_focus` in this file and missed here). `start`/`end` are chosen by the
            // focused app itself, so the reply length is that app's choice: `get_quickadd_seed`
            // bounds it via `sanitize_seed`, but `get_focused_selection` hands it straight
            // across the IPC into the QuickAdd webview, where it is only ever compared for
            // equality. SEL_MAX is far above any real selection, so the cap costs nothing.
            Ok(s) => super::SelRead::Text(super::bounded_selection(s)),
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
/// `sender` is the activating window's D-Bus unique name, kept beside the mark so the matching
/// `window:deactivate` can clear it without a resolve (see `note_deactivate_bus`).
pub(super) fn note_activate(
    snapshot: &parking_lot::Mutex<super::Snapshot>,
    app_id: String,
    sender: Option<String>,
) {
    let mut snap = snapshot.lock();
    // A desktop-shell app (plasmashell/kwin/…) taking window focus must NOT become the
    // foreground gate: shell noise is filtered everywhere else (focused_app output,
    // last_other), so letting it set `active_app` would make note_focus reject the REAL
    // app's next element focus until the panel deactivates. Our OWN window is still marked —
    // the summon/last_other flow relies on that gate. Either way fold it into the snapshot:
    // set_current already demotes a real current into last_other.
    if super::is_self(&app_id) || !super::is_noise(&app_id) {
        snap.active_app = Some(app_id.clone());
        snap.active_bus = sender;
    }
    set_current(&mut snap, app_id, None, None);
}

/// A `window:deactivate`, matched by its sender's bus name — no D-Bus round-trip, so a busy or
/// quitting app can't leave its foreground mark behind. The mark's own bus clears it; a
/// different bus is a different app, so the mark stays. Returns `true` only when a mark exists
/// and the bus can't decide (no bus recorded for the mark, or none on the event) — the caller
/// then falls back to resolving the app id for `note_deactivate`. No mark → nothing to clear,
/// so no resolve either.
pub(super) fn note_deactivate_bus(
    snapshot: &parking_lot::Mutex<super::Snapshot>,
    sender: Option<&str>,
) -> bool {
    let mut snap = snapshot.lock();
    if snap.active_app.is_none() {
        return false;
    }
    match (snap.active_bus.as_deref(), sender) {
        (Some(marked), Some(sender)) => {
            if marked == sender {
                clear_mark(&mut snap);
            }
            false
        }
        _ => true,
    }
}

/// A `window:deactivate`: if it's the app currently marked foreground, clear the mark — so the
/// next element focus (incl. switching INTO an Electron app, which never emits window:activate)
/// is accepted rather than rejected as a background ghost.
pub(super) fn note_deactivate(snapshot: &parking_lot::Mutex<super::Snapshot>, app_id: &str) {
    let mut snap = snapshot.lock();
    if snap.active_app.as_deref() == Some(app_id) {
        clear_mark(&mut snap);
    }
}

/// Drop the foreground mark — `active_app` and `active_bus` always clear together (lockstep).
fn clear_mark(snap: &mut super::Snapshot) {
    snap.active_app = None;
    snap.active_bus = None;
}

/// An element focus note_focus rejected, kept so the resolver can replay it (replay_parked).
pub(super) struct Parked {
    app_id: String,
    editable: Option<bool>,
    item: ObjectRefOwned,
    /// When note_focus rejected it (see [`PARK_MAX_AGE`]).
    at: std::time::Instant,
}

/// How long a parked focus stays replayable. The race it exists for (the new app's focus landing
/// before the departing app's deactivate) is bounded by when the departing app SENDS that
/// deactivate, not by the resolver: it comes from the app's own UI thread, and a busy terminal
/// streaming output takes well over the 1 s resolve budget to get to it. A focus parked longer
/// than that slack is a background app's stray one (the "chromium ghost" the gate rejects), and
/// replaying it on the next mark change — the user summoning Quick-Add minutes later — would make
/// an app the user never focused `current`, then `last_other` with its per-app rule and selection.
const PARK_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(5);

/// An element focus. Accept ONLY from the foreground app, or when none is marked foreground
/// (the moment right after a switch). A background app's stray focus while a DIFFERENT app is
/// foreground is rejected — that's the "chromium ghost" gate — and handed back for parking.
pub(super) fn note_focus(
    snapshot: &parking_lot::Mutex<super::Snapshot>,
    app_id: String,
    editable: Option<bool>,
    element: ObjectRefOwned,
) -> Option<Parked> {
    let mut snap = snapshot.lock();
    if let Some(active) = snap.active_app.as_deref() {
        if active != app_id.as_str() {
            return Some(Parked {
                app_id,
                editable,
                item: element,
                at: std::time::Instant::now(),
            });
        }
    }
    set_current(&mut snap, app_id, editable, Some(element));
    None
}

/// The focus step of a resolver cycle that carried no element focus. The departing app's
/// window:deactivate can land a cycle AFTER the new app's focus (two processes, arbitrary
/// order), so that focus was rejected against the still-standing mark — and an Electron app
/// never emits window:activate, so nothing else would bring it into the snapshot until the
/// user moves focus inside it. Once this cycle's window events changed the mark
/// (`mark_before` → now), replay the parked focus through note_focus, once. An unchanged mark
/// keeps it waiting; the parked app's own deactivate (by bus name) drops it as stale, and so does
/// age (`now` past [`PARK_MAX_AGE`]).
pub(super) fn replay_parked(
    snapshot: &parking_lot::Mutex<super::Snapshot>,
    parked: &mut Option<Parked>,
    mark_before: Option<&str>,
    deactivated_bus: Option<&str>,
    now: std::time::Instant,
) {
    let Some(p) = parked.take() else {
        return;
    };
    if now.saturating_duration_since(p.at) > PARK_MAX_AGE {
        return;
    }
    if deactivated_bus.is_some() && p.item.name_as_str() == deactivated_bus {
        return;
    }
    if snapshot.lock().active_app.as_deref() == mark_before {
        *parked = Some(p);
        return;
    }
    let _ = note_focus(snapshot, p.app_id, p.editable, p.item);
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
    // A `window:activate` carries no element (it's the window frame). When it re-activates the
    // app that is ALREADY current (e.g. Alt-Tab back to it), keep the field ref we already hold
    // — otherwise we'd wipe the selection source to None and degrade to the PRIMARY fallback
    // even though the same field is still focused. A switch to a DIFFERENT app must still clear
    // it (no stale cross-app ref); the element focus that follows the switch replaces it.
    let reactivating_same =
        element.is_none() && snap.current.as_ref().is_some_and(|c| c.app_id == app_id);
    let fa = super::FocusedApp {
        title: app_id.clone(),
        app_id,
        // A `window:activate` carries no field info (editable=None). On a same-app re-activation
        // (Alt-Tab back) carry the editable flag we already hold — in lockstep with the
        // current_el preservation below — so we don't wipe a known Some(false)/Some(true) to
        // unknown and degrade the field guard. (fa is built before snap.current.take() runs, so
        // snap.current still holds the prior FocusedApp here.)
        editable: if reactivating_same {
            editable.or_else(|| snap.current.as_ref().and_then(|c| c.editable))
        } else {
            editable
        },
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
    if !reactivating_same {
        snap.current_el = element;
    }
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
