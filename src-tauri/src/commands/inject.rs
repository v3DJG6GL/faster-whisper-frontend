//! Text injection into the focused app (paste or type), the clipboard snapshot
//! around it, and the focused-app / selection queries.

use super::{own_window_focused, read_selection_bounded};
use crate::inject::wayland::WaylandTyper;
use tauri::{AppHandle, Manager, State};

/// Snapshot of the clipboard taken before a live (per-segment) paste dictation, so
/// the user's original clipboard is restored once at the end rather than after
/// every segment (which would race + churn the clipboard manager).
#[derive(Default)]
pub struct ClipboardSnapshot(pub std::sync::Mutex<Option<String>>);

/// Snapshot the current clipboard before a live paste-injection session.
#[tauri::command]
pub async fn begin_injection(snap: State<'_, ClipboardSnapshot>) -> Result<(), String> {
    // Read the clipboard OFF the GTK main thread, time-bounded (see read_selection_bounded). This is
    // called PER PHRASE, and a SYNC command runs on the UI thread — on the UI thread the blocking read
    // freezes the whole app. On timeout/empty we KEEP the prior snapshot: that path means we still hold
    // the clipboard ourselves (the user copied nothing new), so the existing snapshot already has it.
    match read_selection_bounded(|| {
        arboard::Clipboard::new()
            .ok()
            .and_then(|mut c| c.get_text().ok())
    })
    .await
    {
        // The clipboard still holds OUR last transcript (a restore was skipped or failed silently)
        // — that is NOT the user's clipboard, and snapshotting it would resurrect stale dictation
        // at the end-of-session restore. Same reasoning as the None arm: the user copied nothing
        // new, so the existing snapshot (if any) already has the real thing.
        Some(text) if crate::inject::is_own_injected(&text) => {
            tracing::info!("[clip] begin_injection: clipboard holds our own transcript — keeping prior snapshot");
        }
        Some(text) => {
            tracing::info!("[clip] begin_injection: snapshot {} chars", text.len());
            if let Ok(mut g) = snap.0.lock() {
                *g = Some(text);
            }
        }
        None => tracing::info!(
            "[clip] begin_injection: clipboard read empty/timeout — keeping prior snapshot"
        ),
    }
    Ok(())
}

/// Restore the clipboard snapshot taken by `begin_injection` (end of a live session).
#[tauri::command]
pub fn end_injection(snap: State<ClipboardSnapshot>) {
    // Where the session's LAST paste went, read and forgotten here (the session is over).
    let last_remote = crate::inject::last_paste_was_remote();
    crate::inject::clear_paste_target();
    // Taken UNCONDITIONALLY, above the snapshot test. Inside `if let Some(prev)` it would be
    // unreachable on every session that took no snapshot (direct-typing method, restore-clipboard
    // off, or a clipboard read that timed out) — and `streaming.ts` calls this on every teardown,
    // no-op or not. A flag armed by such a session would then survive to suppress a LATER
    // session's legitimate restore. Consuming it here makes it strictly one-shot per teardown.
    let recovered_on_clipboard = crate::inject::take_recovery_on_clipboard();
    let prev = snap.0.lock().ok().and_then(|mut g| g.take());
    if let Some(prev) = prev {
        // The last paste went to a remote-desktop target: skip the restore (same contract as the
        // per-paste path) — the restored value can be what the remote's still-pending paste
        // fetches. Decided by where that paste WENT (`last_paste_was_remote`), not by what has
        // focus now: this runs at teardown, after the user may have moved into or out of the RDP
        // window. The snapshot is already consumed above, so it can't leak into a later session.
        if last_remote {
            tracing::info!("[clip] end_injection: last paste went to a remote-desktop target — restore skipped");
            return;
        }
        // An error-abort recovery just put the abandoned transcript on the clipboard for the
        // user to paste manually. Restoring `prev` 400ms later would erase it — the same
        // erasure the per-paste restore declines a few hundred lines below, on the one path
        // that guard cannot cover (it needs the job's epoch; this command has none). The
        // snapshot is consumed either way, so it cannot leak into a later session.
        if recovered_on_clipboard {
            tracing::info!(
                "[clip] end_injection: a recovered transcript is on the clipboard — restore skipped"
            );
            return;
        }
        tracing::info!(
            "[clip] end_injection: restore {} chars (delayed)",
            prev.len()
        );
        // Persist on Wayland: a plain set_text that drops immediately doesn't stick, which
        // is why the clipboard was "never restored". Serve it from a live owner — and after a
        // short delay, so the last phrase's in-flight Ctrl+V consumes the transcript BEFORE we
        // swap the original back (else the final phrase can paste the original instead).
        crate::inject::restore_clipboard_later(Some(prev));
    }
}

/// Restore the `begin_injection` snapshot WITHOUT consuming it, so the user's original
/// clipboard can be put back after EACH pasted phrase in an ongoing hands-free session (the
/// snapshot stays for the next phrase to restore again). Served from a live owner so it
/// persists on Wayland; no-op when no snapshot was taken (restore off / non-paste session).
#[tauri::command]
pub fn restore_clipboard_snapshot(snap: State<ClipboardSnapshot>) {
    let prev = snap.0.lock().ok().and_then(|g| g.clone());
    if let Some(prev) = prev {
        // The last paste went to a remote-desktop target: skip the per-phrase restore (see
        // end_injection) — the snapshot stays untouched for later phrases / a later non-remote
        // end-of-session restore.
        if crate::inject::last_paste_was_remote() {
            tracing::info!(
                "[clip] restore_clipboard_snapshot: last paste went to a remote-desktop target — restore skipped"
            );
            return;
        }
        tracing::info!(
            "[clip] restore_clipboard_snapshot: {} chars (delayed)",
            prev.len()
        );
        // Serve after the same ~400ms margin as end_injection / the paste path (via
        // restore_clipboard_later), NOT an immediate set_clipboard_persistent: the boundary-
        // separator restore (streaming.ts) runs synchronously right after its OWN separator
        // paste, so an immediate serve races the target's async selection read and could hand
        // back the user's old clipboard instead of the separator. The per-phrase restore fires
        // on the ~1.2s quiet timer, so the extra 400ms delay is immaterial there.
        crate::inject::restore_clipboard_later(Some(prev));
    }
}

/// Clear the `begin_injection` snapshot WITHOUT restoring it. Used when a live paste session
/// ENDS on a clipboard-only phrase: the clipboard then deliberately holds the transcript the
/// user wants to paste, so the end-of-session restore must NOT clobber it — but we still drop
/// the snapshot so it can't leak a stale value into a later session (e.g. a future
/// begin_injection that times out and keeps the prior snapshot).
#[tauri::command]
pub fn discard_injection_snapshot(snap: State<ClipboardSnapshot>) {
    if let Ok(mut g) = snap.0.lock() {
        let _ = g.take();
    }
    // The other way a session ends. Dropping the snapshot means no restore will ever be attempted
    // against it, so a recovery flag has nothing left to protect and must not outlive this session.
    crate::inject::clear_recovery_on_clipboard();
    // Same for the last paste target: it only ever gates a restore of THIS session's snapshot.
    crate::inject::clear_paste_target();
}

/// The focused application's id + title + (when deep detection is on) whether its focused
/// element is editable. Via AT-SPI; `None` when nothing is known yet (no a11y bridge / cold
/// listener). Used to resolve per-app rules, the chip readout, and the field guard. When one
/// of OUR OWN windows holds focus, returns a synthetic `is_self` "this app" target so the chip
/// reads "→ this app" rather than the stale previously-focused app AT-SPI would report.
#[tauri::command]
pub async fn get_focused_app(
    app: AppHandle,
    guard: State<'_, crate::focus::AtspiGuard>,
) -> Result<Option<crate::focus::FocusedApp>, String> {
    // Authoritative own-window check (same as inject_text's guard): a Wayland client always
    // knows its own keyboard focus. Dictation won't type into our own UI, so surface that
    // truthfully instead of letting AT-SPI report whatever was focused before us. The
    // click-through "overlay" chip never holds focus; exclude it.
    if own_window_focused(&app) {
        return Ok(Some(crate::focus::FocusedApp {
            app_id: "self".into(),
            title: "this app".into(),
            editable: Some(false),
            is_self: true,
        }));
    }
    let focused = crate::focus::focused_app(guard.inner()).await;
    // The window TITLE can carry sensitive data (open document / email subject / private tab names)
    // and this is polled ~every 700ms during a session, so keep it OUT of the default-on `info` line —
    // log only app_id + editable there; the full record (incl. title) goes to `debug` (off by default).
    match &focused {
        Some(f) => tracing::info!("[focused-app] id={} editable={:?}", f.app_id, f.editable),
        None => tracing::info!("[focused-app] none"),
    }
    tracing::debug!("[focused-app] {focused:?}");
    Ok(focused)
}

/// Like `get_focused_app` but WITHOUT the own-window self short-circuit: returns the
/// previously-focused OTHER application (`last_other` when our own window is up front). The
/// App-rules "Use current" button calls this — it's always clicked while our own Settings
/// window holds focus, so the self-aware `get_focused_app` would always report "this app".
#[tauri::command]
pub async fn get_focused_other_app(
    guard: State<'_, crate::focus::AtspiGuard>,
) -> Result<Option<crate::focus::FocusedApp>, String> {
    let focused = crate::focus::focused_app(guard.inner()).await;
    // Keep the window title out of the default-on `info` line (see get_focused_app) — it can hold
    // sensitive data; log app_id + editable at info, the full record at `debug` (off by default).
    match &focused {
        Some(f) => tracing::info!(
            "[focused-other-app] id={} editable={:?}",
            f.app_id,
            f.editable
        ),
        None => tracing::info!("[focused-other-app] none"),
    }
    tracing::debug!("[focused-other-app] {focused:?}");
    Ok(focused)
}

/// Read the user's current text selection from the SOURCE app to pre-fill Quick-Add's "When you
/// say" field on summon, or `None` to leave it empty (and show the recent-words dropdown).
///
/// Order: ask accessibility (AT-SPI) FIRST — it can authoritatively report "nothing is selected",
/// so we never seed a STALE highlight when the user summoned with no selection. Only when it can't
/// tell (no Text interface — terminals, some Electron) do we fall back to the focus-independent
/// PRIMARY "highlight" buffer (read OFF the UI thread + time-bounded, same hazard as
/// `begin_injection`). The text is sanitised to a single short line either way.
#[tauri::command]
pub async fn get_quickadd_seed(
    guard: State<'_, crate::focus::AtspiGuard>,
    seed_rdv: State<'_, crate::aux_windows::quickadd::SeedRendezvous>,
) -> Result<Option<String>, String> {
    // Windows: no AT-SPI / PRIMARY — the copy chord fired BEFORE the window took focus
    // (quickadd::show → win_seed), but the clipboard may still be settling (Office
    // delayed rendering, RDP clipboard redirection), so AWAIT this summon's grab via
    // the generation-stamped rendezvous rather than reading a cache. The bound covers
    // the grab's LONGEST copy deadline (the 6s remote-desktop one) plus read retries —
    // a settle wakes it immediately, so the local path never pays it; off the async
    // runtime because the wait is a condvar block. Same sanitizer as the Linux paths.
    #[cfg(windows)]
    {
        let _ = &guard;
        let rdv = seed_rdv.inner().clone();
        let raw = tauri::async_runtime::spawn_blocking(move || {
            rdv.wait(std::time::Duration::from_millis(6500))
        })
        .await
        .ok()
        .flatten();
        let seed = raw.as_deref().and_then(sanitize_seed);
        // `None` and `Some("")` used to both print "0 chars", which made "the grab found
        // nothing" indistinguishable from "the reader aborted (window closed) / timed out"
        // in exactly the field reports this line exists for.
        match &raw {
            None => tracing::info!(
                "[quickadd-seed] windows copy grab returned no text (no copy landed, summon superseded, or wait timed out)"
            ),
            Some(t) => tracing::info!(
                "[quickadd-seed] windows copy grab {} bytes -> seed {} bytes",
                t.len(),
                seed.as_deref().map_or(0, str::len)
            ),
        }
        Ok(seed)
    }
    #[cfg(not(windows))]
    {
        let _ = &seed_rdv;
        use crate::focus::SelRead;
        match crate::focus::focused_selection(guard.inner()).await {
            SelRead::Text(s) => {
                let seed = sanitize_seed(&s);
                tracing::info!(
                    "[quickadd-seed] atspi selection {} chars -> seed {} chars",
                    s.len(),
                    seed.as_deref().map_or(0, str::len)
                );
                Ok(seed)
            }
            SelRead::Empty => {
                tracing::info!("[quickadd-seed] atspi: nothing selected -> no seed");
                Ok(None)
            }
            // Opaque (rich-text ￼) or no Text interface at all → the real word lives in PRIMARY.
            SelRead::Opaque | SelRead::Unavailable => {
                let raw = match read_primary_now().await {
                    Some(s) => s,
                    None => return Ok(None),
                };
                let seed = sanitize_seed(&raw);
                tracing::info!(
                    "[quickadd-seed] primary fallback {} chars -> seed {} chars",
                    raw.len(),
                    seed.as_deref().map_or(0, str::len)
                );
                Ok(seed)
            }
        }
    }
}

/// Read the focused element's CURRENT text selection for the correct-on-close guard, called AFTER
/// Quick-Add hides (focus back on the source app) to confirm the SAME word is still highlighted
/// before replacing it. Accessibility must FIRST confirm a live selection exists in the focused app:
/// `Text` returns it directly; `Opaque` (a real rich-text selection whose chars are ￼) is confirmed
/// to exist, so we read its rendered text from PRIMARY. `Empty`/`Unavailable` return `None` — we
/// can't confirm the word is still selected, so we never paste blindly (and never consult PRIMARY,
/// which would be stale). This keeps the "check first, then replace" guarantee in rich-text editors.
///
/// Windows has no a11y selection read: RE-GRAB via the same copy-chord + clipboard-diff as the
/// summon seed (`quickadd::win_seed`), which lands in the source app since focus is back there.
/// An unchanged clipboard (selection gone / collapsed) reads as `None` — same check-first
/// guarantee, verified against the live app rather than a cache.
#[tauri::command]
pub async fn get_focused_selection(
    app: tauri::AppHandle,
    guard: State<'_, crate::focus::AtspiGuard>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let _ = &guard;
        let sel = tauri::async_runtime::spawn_blocking(move || {
            crate::aux_windows::quickadd::win_seed::grab(&app, None, None)
        })
        .await
        .ok()
        .flatten()
        .map(bounded_selection);
        tracing::info!(
            "[quickadd-close] windows re-grab -> {} chars",
            sel.as_deref().map_or(0, str::len)
        );
        Ok(sel)
    }
    #[cfg(not(windows))]
    {
        let _ = &app;
        use crate::focus::SelRead;
        Ok(match crate::focus::focused_selection(guard.inner()).await {
            // `Text` is already capped at its own read; the PRIMARY fallback is only TIME-bounded.
            SelRead::Text(s) => Some(s),
            SelRead::Opaque => read_primary_now().await.map(bounded_selection),
            SelRead::Empty | SelRead::Unavailable => None,
        })
    }
}

/// Read the Wayland PRIMARY ("highlight") selection off the UI thread, time-bounded — the same
/// hazard guard as `begin_injection` (a hung clipboard owner must not stall the caller).
#[cfg_attr(windows, allow(dead_code))] // PRIMARY is a Linux concept; Windows seeds via win_seed
async fn read_primary_now() -> Option<String> {
    read_selection_bounded(crate::inject::read_primary_selection).await
}

/// Cap a selection read at `SEL_MAX`, the way the AT-SPI Text read already does at its own source.
///
/// That bound was applied "at the READ, so every consumer inherits it" — but only for the one
/// path that had a read to bind it to. Two siblings feed the SAME command and got nothing:
/// `read_primary_now`, which is TIME-bounded (400ms) and not SIZE-bounded, and the Windows
/// clipboard re-grab. Both hand the string straight across the IPC into the QuickAdd webview.
/// Truncation cannot change the outcome downstream: the value is only compared against a mapping
/// key that `sanitize_seed` already limits to a single line of ≤100 characters.
fn bounded_selection(s: String) -> String {
    match s.char_indices().nth(crate::focus::SEL_MAX) {
        Some((i, _)) => s[..i].to_string(),
        None => s,
    }
}

/// Turn a raw selection into a usable mapping KEY, or reject it. Multi-WORD selections are kept
/// verbatim (one key); a multi-LINE selection, an empty/whitespace-only one, or anything longer
/// than a plausible phrase is rejected — a paragraph isn't a spoken symbol. Edges are trimmed (a
/// trailing newline from a to-end-of-line highlight just falls away); an INTERIOR newline rejects.
fn sanitize_seed(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.contains('\n') || s.contains('\r') {
        return None;
    }
    if s.chars().count() > 100 {
        return None;
    }
    Some(s.to_string())
}

/// Toggle the opt-in AT-SPI "deep field detection" (a11y flag + Chromium/Electron poke),
/// which lets the focused-element editability read correctly for browser/Electron apps.
#[tauri::command]
pub fn set_deep_field_detection(
    guard: State<'_, crate::focus::AtspiGuard>,
    enabled: bool,
) -> Result<(), String> {
    tracing::info!("[atspi] deep field detection = {enabled}");
    crate::focus::set_deep(guard.inner(), enabled);
    Ok(())
}

/// How long a manufactured-stop latch stays valid — see `held_keys::take_lost_if_fresh`.
///
/// Deliberately generous, and sized against the LONGEST leg it has to span rather than a guessed
/// round-trip: what sits in the middle is the untrusted server returning a final, so anything
/// shorter is a bypass the server itself can trigger by stalling. A stale latch only ever costs one
/// phrase a clipboard divert, which the chip now reports; a short one costs the control entirely.
///
/// That leg is NOT bounded by the frontend's stuck-finalize watchdog, which is what this constant
/// was first tied to: `armStuckWatchdog` returns early unless the endpoint is `stream`
/// (`src/lib/streaming.ts`), and `activation: "hold"` with `endpoint: "batch"` is a legal profile —
/// one that lands in stop-timing mode, where the single insert carries the WHOLE transcript through
/// the typing path. On that leg the only bound is the shared HTTP client's 120s default
/// (`transport::mod`, which `batch` dictation does not override), so a transcription that takes
/// longer than 15s — a long clip, a big model, or a server stalling on purpose — walked straight
/// past this control. 130s covers the 120s timeout plus the stop → POST → final → inject hops.
const HELD_CHORD_LATCH_TTL: std::time::Duration = std::time::Duration::from_secs(130);

/// What `inject_text` did, so the caller can keep its own bookkeeping honest.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectOutcome {
    /// The text LANDED — typed, pasted, or deliberately left on the clipboard. `false` only when
    /// one of our own windows held focus and the whole insert was skipped, at entry or at the sink.
    /// The caller must not advance its typed baseline on `false`; nothing was written anywhere, so
    /// there is nothing to recover, and the phrase has to go out again.
    ///
    /// The default for any future early return must be `true`. `false` means "send it again", and a
    /// wrong `false` re-types a phrase the user already has — visibly duplicated text, which is
    /// worse than the silent drop this field exists to fix.
    pub landed: bool,
    /// We DIVERTED to the clipboard against the caller's wishes — it asked for typing or pasting
    /// and got neither, because the trigger chord was still held or focus had moved to a different
    /// app. The text is safe, but it did not go where the user was looking, and until this field
    /// existed nothing said so: the caller stamped its green "typed" confirmation either way.
    ///
    /// This matters more since the held-chord branch became reachable on the primary hotkey paths,
    /// and more again now that the wiped-map latch can reach it too.
    pub diverted: bool,
}

/// Insert text into the focused field of the active app (paste or direct typing).
/// Direct typing on Wayland routes through the RemoteDesktop portal; everything
/// else uses enigo (clipboard paste, or direct on X11/Windows).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn inject_text(
    app: AppHandle,
    typer: State<'_, WaylandTyper>,
    vkbd: State<'_, crate::inject::virtual_keyboard::VirtualKeyboard>,
    guard: State<'_, crate::focus::AtspiGuard>,
    text: String,
    method: String,
    auto_enter: bool,
    restore_clipboard: bool,
    paste_shortcut: Vec<String>,
    // `expect_app_id` is the app the CALLER resolved its per-app rule and insert method against.
    // `None` = no identified target (our own window, or a cold a11y bridge), which skips the
    // re-check below.
    expect_app_id: Option<String>,
    // The per-app rule's "Remote desktop" override: `Some(true)`/`Some(false)` force the
    // remote-desktop clipboard handling on/off for that app, `None` = auto-detect (exe/app id +
    // window class). See the resolution at the sink below.
    remote_desktop: Option<bool>,
) -> Result<InjectOutcome, String> {
    // Strip control characters (except Tab/LF; CR is normalized to LF) from the server-transcribed
    // text before it reaches ANY injection path — clipboard-only, Wayland paste, or X11 paste/direct
    // — so a malicious/garbled server can't smuggle terminal-escape sequences onto the clipboard or
    // into a paste. (The Wayland direct-typing paths already drop controls; this matches them.)
    let text = crate::inject::sanitize_injected(&text);
    // Captured HERE — before any await — not where the job is finally queued. Everything below
    // (the held-modifier wait, two focus IPCs, a bounded clipboard read, the settle, and on the
    // Wayland fallback a failed virtual-keyboard attempt) can take a second or more, and a cancel
    // landing in that window used to bump the counter BEFORE the job read it, so the job adopted
    // the post-cancel generation and never saw itself as cancelled.
    let epoch = crate::inject::injection_epoch();
    tracing::info!(
        "[inject] {} chars via {} (auto_enter={})",
        text.len(),
        method,
        auto_enter
    );
    // Never inject into our OWN UI: if one of our real windows holds keyboard focus, typed/pasted
    // keys would fire buttons/shortcuts in the app itself (e.g. dictating while looking at Home) —
    // AND a clipboard-only insert would silently clobber the user's clipboard for an insert they
    // can't even see land. So this guard runs for ALL methods, BEFORE the clipboard-only branch
    // (it used to sit after it, so clipboard-only clobbered the clipboard while our own window was
    // focused). A Wayland client is always told its own keyboard focus, so this is reliable on KWin —
    // unlike detecting other apps' focused fields. The click-through "overlay" chip never holds
    // focus; exclude it. The transcript still shows in the chip.
    if own_window_focused(&app) {
        tracing::info!("[inject] skipped: our own window holds focus");
        return Ok(InjectOutcome {
            landed: false,
            diverted: false,
        });
    }
    // Clipboard-only: put the text on the clipboard and inject NO keystrokes, so it can't
    // fire actions in the wrong window — the user pastes it themselves. No modifier gate needed
    // since nothing is typed (the own-window guard above already ran).
    if method == "clipboard" {
        // Same check as the mid-function divert below, for the same reason: a cancel landing
        // between the epoch capture and this write (the own-window focus IPC above is an
        // event-loop round trip) must not install the transcript over the user's clipboard.
        // `cancel_wants_recovery` stays in the condition — an error abort wants its text kept.
        if crate::inject::injection_cancelled(epoch) && !crate::inject::cancel_wants_recovery(epoch)
        {
            tracing::info!("[inject] clipboard-only insert cancelled before the write — skipping");
            return Ok(InjectOutcome {
                landed: true,
                diverted: false,
            });
        }
        if !text.is_empty() {
            // The whole point of the handshake: this arm's `landed: true` used to be a constant,
            // and it is the arm that runs for every phrase when the insert method IS the
            // clipboard. Reporting false is safe here because no keystroke is ever synthesized on
            // this path, so the caller's re-send cannot duplicate anything.
            if let Err(e) = crate::inject::set_clipboard_persistent(&text) {
                tracing::warn!("[inject] clipboard-only insert failed: {e}");
                return Ok(InjectOutcome {
                    landed: false,
                    diverted: false,
                });
            }
        }
        return Ok(InjectOutcome {
            landed: true,
            diverted: false,
        });
    }
    // Nothing to type and no Enter to send → bail before the keystroke paths. Without this, the
    // Wayland PASTE branch below would set_clipboard("") — clobbering the user's clipboard with an
    // empty string and firing a no-op Ctrl+V — whenever a phrase sanitizes to empty (the server
    // emitted only control chars). Mirrors the X11 inject::inject guard. (empty + auto_enter still
    // falls through below to send the bare Enter.)
    if text.is_empty() && !auto_enter {
        return Ok(InjectOutcome {
            landed: true,
            diverted: false,
        });
    }
    // Pasting into a remote-desktop client (mstsc & co) needs different clipboard handling: the
    // local clipboard reaches the remote host ASYNCHRONOUSLY, so the paste gets a longer settle
    // before Ctrl+V (the new content must cross the network before the forwarded keystroke) and
    // NEVER restores the previous clipboard afterwards (with RDP delayed rendering, the restored
    // value can be what the remote's paste actually fetches — this is how a 7-minute-old
    // transcript once landed instead of the fresh one). Direct typing never touches the
    // clipboard, so it doesn't care.
    // Resolved at the SINK, below, from the same focus read the per-app re-check uses — see there.
    // Wait briefly for the trigger chord's shortcut modifiers (Ctrl/Alt/Meta) to be
    // physically released before typing — otherwise the injected keys fold into the
    // still-held modifier and fire shortcuts in the focused app (worst with a hands-free
    // stop, which triggers on the second chord press with every key still down). Only
    // the evdev backend can observe physical release on Wayland; when it isn't running
    // the held set is empty so this is a no-op. Capped so we never drop the text.
    let mut modifiers_stuck = false;
    {
        let held = app
            .state::<crate::hotkeys::held_keys::HeldKeys>()
            .inner()
            .clone();
        if held.any_held(&crate::hotkeys::held_keys::SHORTCUT_MOD_CODES) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while held.any_held(&crate::hotkeys::held_keys::SHORTCUT_MOD_CODES) {
                if std::time::Instant::now() >= deadline {
                    // The gate used to fail OPEN here: it logged and typed anyway, so the
                    // transcript's characters folded into the still-held modifier and became
                    // shortcut chords in the focused app — with the server choosing WHICH ones.
                    //
                    // It cannot simply fail closed either. `SHORTCUT_MOD_CODES` spans both
                    // Shifts, and this is `any_held`, so a user holding Shift to capitalize or
                    // Ctrl to scroll-zoom during a live session would silently have every phrase
                    // diverted — dictation looks broken with nothing to explain it. So divert
                    // only when the modifiers still down are the ones that were down when the
                    // TRIGGER fired, i.e. the dictation chord itself is not being released.
                    modifiers_stuck = crate::hotkeys::triggers::trigger_modifiers_still_held(&held);
                    if modifiers_stuck {
                        tracing::warn!(
                            "[inject] trigger chord still held after 500ms — clipboard only"
                        );
                    } else {
                        tracing::warn!("[inject] an unrelated modifier is held — injecting anyway");
                    }
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        }
    }
    // …and the case the map CANNOT report, because the record was destroyed: a backend restart
    // (a sync pull that changes a profile, a rebind, a hotkey capture, the evdev-off arm) wipes the
    // held map, and both backends feed it by TRANSITION — so a modifier already physically down
    // never reappears and its key-up early-returns too. The map reads empty for the rest of that
    // hold and the whole gate above is skipped.
    //
    // That teardown is not a bystander: it emits a mid-hold stop for a push-to-talk profile, which
    // MANUFACTURES this injection at the exact moment the chord is provably still down. So the wipe
    // now arms a chord-precise, self-expiring latch, and here we consume it.
    //
    // Deliberately consumed AFTER the loop, not merged into it: this is a "the chord was down when
    // we lost sight of it" fact, not a live reading, so there is nothing to wait for. Straight to
    // the same clipboard divert the timeout arm produces. The TTL only has to cover
    // teardown-stop → frontend finalize → here.

    // The own-window guard at the top of this command has the same decided-at-T/applied-at-T+n
    // problem the per-app re-check below was written to fix, and it was left at the entry: the
    // held-modifier wait, the focus IPC and the bounded clipboard read can take a second, and in a
    // live or hands-free session the user is expected to be moving between windows. Clicking our own
    // window in that gap landed the keys in the app's own settings/dictionary fields — and on the
    // paste path the clipboard was clobbered first, regardless.
    //
    // The per-app re-check below CANNOT stand in for this. `focused_app_now` (and `focus::windows`'s
    // twin) classify our own window as noise and fall back to `last_other`, so they report the
    // PREVIOUS app — which still matches `expect_app_id`, so the mismatch arm never fires. Only
    // the authoritative webview-focus check sees it, so re-run exactly that.
    //
    // `return Ok(())`, deliberately NOT a degrade to "clipboard": the entry guard was moved above
    // the clipboard-only branch precisely so our own window holding focus can never clobber the
    // user's clipboard for an insert they cannot see land. Skipping is safe — `streaming.ts`
    // leaves `injectedText` un-advanced on a skip, so the text goes out with the next insert.
    if own_window_focused(&app) {
        tracing::info!("[inject] skipped at the sink: our own window took focus mid-injection");
        return Ok(InjectOutcome {
            landed: false,
            diverted: false,
        });
    }
    // Consumed UNCONDITIONALLY (no `!modifiers_stuck &&` short-circuit): a latch left armed by a
    // true positive would divert the NEXT, legitimate injection too. Guarded on `!text.is_empty()`
    // so the bare auto-Enter insert — which carries no transcript and cannot be typed into a chord
    // harmfully — does not steal the latch from the transcript insert that follows it. And placed
    // BELOW the own-window sink skip, so an injection that is going to write nothing and be re-sent
    // does not destroy the latch the re-send needs.
    //
    // The TTL covers manufactured-stop → the server returning a final → here, and the SERVER owns
    // the middle leg. Sized against the LONGEST such leg — the batch POST's 120s client timeout,
    // NOT the stream-only stuck-finalize watchdog this once cited; see HELD_CHORD_LATCH_TTL. A
    // tighter bound would let a slow — or deliberately stalling — server walk its transcript
    // straight past this control, which is a one-line bypass by the actor the control defends
    // against.
    if !text.is_empty() {
        let chord_lost = crate::hotkeys::held_keys::take_lost_if_fresh(HELD_CHORD_LATCH_TTL);
        if chord_lost && !modifiers_stuck {
            tracing::warn!(
                "[inject] a stop was manufactured for a still-held chord — clipboard only"
            );
        }
        modifiers_stuck = modifiers_stuck || chord_lost;
    }
    // The per-app rule — including "never type into this app" — was resolved against the window
    // focused when this insert was QUEUED, and getting here takes real time: a focus IPC, up to
    // 400ms of clipboard read, and the 500ms modifier wait just above. In a live or hands-free session
    // the user is expected to be switching windows, so the window that receives the keys may not
    // be the one the decision was made for. Re-check now, at the sink.
    //
    // A mismatch degrades to clipboard-only — the same treatment a blocked or non-editable target
    // already gets, so the text is preserved and nothing is typed into a window whose rule we
    // never evaluated. An UNIDENTIFIED window still falls through unchanged: that is the
    // deliberate fail-open behaviour, and a cold a11y bridge hits it routinely.
    let method = if modifiers_stuck {
        "clipboard".to_string()
    } else {
        method
    };
    // ONE focus read, used for both decisions below. `remote_target` used to be resolved at the
    // top of this function and acted on here — the same decided-at-T, applied-at-T+n shape the
    // per-app re-check exists to fix, on the control immediately beside it. Focus leaving a
    // remote-desktop client meanwhile left it true and the clipboard was never restored; focus
    // entering one left it false, giving the paste the 60ms local settle instead of 300ms AND
    // scheduling a restore — reproducing the delayed-rendering failure described above, where the
    // remote's deferred fetch pastes the RESTORED value.
    let focused_now = crate::focus::focused_app_now(guard.inner());
    let method = match (&expect_app_id, &focused_now) {
        (Some(expected), Some(now)) if !now.app_id.eq_ignore_ascii_case(expected) => {
            tracing::warn!(
                "[inject] focus moved {} → {} after the rule was resolved — clipboard only",
                expected,
                now.app_id
            );
            "clipboard".to_string()
        }
        _ => method,
    };
    if method == "clipboard" {
        // Unlike the clipboard-only block at the top of this function, THIS one is reachable only
        // by the two mid-function DIVERSIONS above — `modifiers_stuck` and the focus mismatch —
        // so it sits at the far end of the held-modifier wait, which the `modifiers_stuck` arm has
        // by construction run to its full 500ms. A cancel landing in that window used to write the
        // transcript out anyway, as a live persistent clipboard owner, clobbering whatever the user
        // had copied — the exact thing `cancel_injection`'s contract forbids and the Wayland paste
        // path was fixed for.
        //
        // `cancel_wants_recovery` is NOT redundant here: an error abort (a died session) reaches
        // this branch through the same race, and it DOES want its text recovered. Because this is
        // an early `return`, it never reaches the recovery block at the end of the function, so
        // falling through and letting the write happen is what reproduces that recovery.
        if crate::inject::injection_cancelled(epoch) && !crate::inject::cancel_wants_recovery(epoch)
        {
            tracing::info!("[inject] diverted to clipboard, but cancelled first — skipping");
            return Ok(InjectOutcome {
                landed: true,
                diverted: false,
            });
        }
        if !text.is_empty() {
            // The divert the ledger's D1 named as the data-loss path: on `landed: true` the
            // caller advances its baseline and the phrase leaves the re-send stream for good.
            // Nothing has been typed on this arm either, so `false` is both truthful and safe.
            if let Err(e) = crate::inject::set_clipboard_persistent(&text) {
                tracing::warn!("[inject] divert to clipboard failed: {e}");
                return Ok(InjectOutcome {
                    landed: false,
                    diverted: false,
                });
            }
            // Third recovery write: an error abort that fell through the gate above has just put the
            // transcript on the clipboard; arm the session-restore guard like the two paste-path
            // writes so end_injection does not serve `prev` over it. Not armed on a plain divert —
            // that session is still live.
            if crate::inject::injection_cancelled(epoch)
                && crate::inject::cancel_wants_recovery(epoch)
            {
                crate::inject::note_recovery_on_clipboard();
            }
        }
        // The one site that reports a DIVERT: the caller asked to type or paste and we did neither.
        return Ok(InjectOutcome {
            landed: true,
            diverted: true,
        });
    }
    // Now that the method is final and focus has been read once, at the sink. Two detectors (see
    // `inject::rdp_client`): the focused app id against the known clients, and — Windows — the focused
    // window's class, which also catches the RDP control hosted by RDCMan/mRemoteNG & co. The
    // per-app rule overrides both when it says On/Off; `None` is "Auto". Both are logged so a
    // support log shows WHICH detector fired and whether the rule overrode it.
    let remote_target = method != "direct"
        && {
            let by_exe = focused_now
                .as_ref()
                .is_some_and(|f| crate::inject::rdp_client::is_remote_desktop_app(&f.app_id));
            let by_class = crate::inject::rdp_client::focus_is_remote_desktop_client();
            let detected = by_exe || by_class;
            let remote = remote_desktop.unwrap_or(detected);
            if remote || remote_desktop.is_some_and(|r| r != detected) {
                let app = focused_now
                    .as_ref()
                    .map_or("unknown", |f| f.app_id.as_str());
                let (what, then) = if remote {
                    (
                        "remote-desktop target",
                        " — longer clipboard settle, restore skipped",
                    )
                } else {
                    ("not treated as a remote-desktop target", "")
                };
                tracing::info!(
                    "[inject] {what} ({app}) — exe={by_exe} class={by_class} rule={remote_desktop:?}{then}"
                );
            }
            remote
        };
    // Where this paste goes decides the SESSION-level restores later (end_injection /
    // restore_clipboard_snapshot), which run after focus may have moved — see LAST_PASTE_REMOTE.
    // A bare auto-Enter carries no transcript and touches no clipboard, so it does not count.
    if method != "direct" && !text.is_empty() {
        crate::inject::note_paste_target(remote_target);
    }

    // Kept for the error-abort recovery below: the X11 branch moves `text` into spawn_blocking.
    let recovery_text = text.clone();
    // The probe the two typing backends re-ask focus with. Built once here so `virtual_keyboard`
    // (served by a bare `std::thread`, no `AppHandle`) and `inject` (served by the blocking pool)
    // take the same predicate the entry guard above uses.
    let probe_app = app.clone();
    let own_focused_probe = move || own_window_focused(&probe_app);
    let res = if crate::inject::is_wayland() {
        // Each Wayland arm now reports its own `Landed`, like the X11 arm below: the two TYPING
        // arms (bare auto-Enter via the portal, and `direct` via the virtual keyboard) were the
        // last sinks in the tree with no own-window re-check, so they could not previously say
        // anything but "landed". Their guards live inside the backends, at the keystroke, because
        // that is the far side of the widest guard-to-sink gap on any path.
        let wayland_res: Result<crate::inject::Landed, String> = if text.is_empty()
            && auto_enter
            && method != "direct"
        {
            // Auto-enter with no text on the PASTE path (the per-phrase / tail Enter): press Enter
            // WITHOUT touching the clipboard — paste would set_clipboard("") and clobber it, so route
            // the bare Enter through the portal type path instead. (Direct falls through to the VK-first
            // branch below: VK type_text("", true) cleanly types Return — and on KWin, where VK is
            // unavailable, it falls back to this same portal path — so the per-phrase Enter takes the
            // SAME silent VK route the phrase's words did instead of forcing a portal consent prompt.)
            crate::inject::wayland::type_text(&app, typer.inner(), "", true, epoch).await
        } else if method == "direct" {
            // Prefer the virtual keyboard (Caps Lock-/layout-correct typing). Fall back
            // to the portal keycode path when the protocol is unavailable (e.g. GNOME)
            // or a job fails.
            let vk_probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
                std::sync::Arc::new(own_focused_probe.clone());
            match crate::inject::virtual_keyboard::type_text(
                vkbd.inner(),
                &text,
                auto_enter,
                epoch,
                vk_probe,
            )
            .await
            {
                Ok(landed) => {
                    tracing::info!("[inject] typed via virtual keyboard");
                    Ok(landed)
                }
                // Fall back to the portal ONLY when the VK failed before transmitting any key (protocol
                // unavailable, keymap upload failed). A mid-typing failure already landed a prefix, so
                // re-typing the whole text via the portal would duplicate it — surface the error instead.
                Err(e) if !e.after_typing => {
                    tracing::warn!(
                        "[inject] virtual keyboard unavailable ({}); using portal",
                        e.message
                    );
                    crate::inject::wayland::type_text(&app, typer.inner(), &text, auto_enter, epoch)
                        .await
                }
                Err(e) => {
                    tracing::error!("[inject] virtual keyboard failed mid-typing ({}); not re-typing via portal (would duplicate the landed prefix)", e.message);
                    Err(e.message)
                }
            }
        } else {
            // Paste on Wayland: set the clipboard here, then synthesize Ctrl+V via
            // the portal. enigo's XTEST Ctrl+V is unreliable on KDE Wayland — a
            // synthesized modifier + remapped keycode makes apps fire the wrong
            // shortcut (e.g. opening editor tabs) instead of pasting.
            let clip = text.clone();
            // Capture the user's prior clipboard TIME-BOUNDED, mirroring begin_injection /
            // read_primary_now: reading the clipboard is a blocking Wayland round-trip that can hang
            // indefinitely on a dead clipboard owner, and it previously sat (inside set_clipboard) in an
            // UN-timed spawn_blocking here — so the end-of-session insert (the restoreClipboard:true
            // caller) could wedge at "injecting" forever (the stuck-finalize watchdog is stream-only).
            // Read prev separately (400ms cap; None on timeout → skip the restore), then set the
            // clipboard so the set_text still lands regardless of the prev-read result.
            // remote_target skips the capture entirely — see its resolution above.
            let prev = if restore_clipboard && !remote_target {
                match read_selection_bounded(|| {
                    arboard::Clipboard::new()
                        .ok()
                        .and_then(|mut c| c.get_text().ok())
                })
                .await
                {
                    None => {
                        tracing::info!(
                            "[clip] paste: prev-clipboard read empty/timeout — skipping restore"
                        );
                        None
                    }
                    // Never adopt OUR OWN last transcript as "the user's previous clipboard" —
                    // it lingers after a failed/skipped restore, and restoring it would resurrect
                    // stale dictation on every future paste (mirrors the Windows/X11 paste guard).
                    Some(t) if crate::inject::is_own_injected(&t) => {
                        tracing::info!("[clip] paste: prior clipboard is our own transcript — skipping restore");
                        None
                    }
                    some => some,
                }
            } else {
                None
            };
            // `inject::inject`'s own paste path checks the epoch BEFORE it touches the clipboard
            // (see the `RECOVER_AT_EPOCH` note: a user cancel means "I don't want this", and
            // putting it on the clipboard anyway clobbers whatever they had copied). This Wayland
            // twin sits at the end of the same ~0.5-1.2s window — the held-modifier wait, the focus
            // read, the bounded prev-clipboard read — and carried no such check, so a cancel
            // landing anywhere in it still wrote the transcript out.
            //
            // The `cancel_wants_recovery` term is load-bearing, and its absence was a bug in this
            // check as first written: the justification given was "the error-abort recovery block
            // below keys off `res`, which this branch never produces", but that block keys off
            // `injection_cancelled && cancel_wants_recovery && !recovery_text.is_empty()` — never
            // `res` — and this is an early `return`, so it skipped the block entirely and a died
            // session lost its transcript instead of leaving it recoverable.
            if crate::inject::injection_cancelled(epoch)
                && !crate::inject::cancel_wants_recovery(epoch)
            {
                tracing::info!("[clip] paste: cancelled before the clipboard write — skipping");
                return Ok(InjectOutcome {
                    landed: true,
                    diverted: false,
                });
            }
            // Own-window re-check, at the sink rather than at the top of the function. The guard
            // that decides "our own window took focus" runs ~0.5s earlier: the latch consume, a
            // focus IPC, up to 400ms of bounded prev-clipboard read and the settle all sit between
            // it and this write. Without this, a focus change inside that window clobbers the
            // user's clipboard and then fires Ctrl+V into one of our own windows — the exact
            // outcome the entry guard was moved above the clipboard-only branch to prevent.
            //
            // `landed: false` is the truthful answer: nothing has been written yet (`prev` was only
            // READ), so the caller re-sends and no text is duplicated. This does not strand the
            // held-chord latch — if it had been armed, `method` would already be "clipboard" and
            // this branch is unreachable.
            if own_window_focused(&app) {
                tracing::info!(
                    "[inject] skipped at the clipboard write: our own window took focus"
                );
                // An early `return` here would skip the error-abort recovery block at the end of
                // this function — the exact defect P4 recorded for the cancel check above, which
                // cost a died session its transcript. The two states are not exclusive: the cancel
                // arm only returns when `!cancel_wants_recovery`, so an ERROR abort reaches here.
                if crate::inject::injection_cancelled(epoch)
                    && crate::inject::cancel_wants_recovery(epoch)
                    && !recovery_text.is_empty()
                {
                    // Arm the session-restore guard ONLY if the recovery actually landed. Arming
                    // it on a failed write would suppress the restore of the user's own clipboard
                    // to protect a transcript that is not there — losing both.
                    if let Err(e) = crate::inject::set_clipboard_persistent(&recovery_text) {
                        tracing::warn!(
                            "[inject] recovery to clipboard failed at the write guard: {e}"
                        );
                        return Ok(InjectOutcome {
                            landed: false,
                            diverted: false,
                        });
                    }
                    // The SECOND recovery write, and it needs the same session-restore guard as
                    // the one at the end of this function — this early `return` is precisely why
                    // (the block that arms it never evaluates). The two preconditions co-occur
                    // naturally: the error teardown refocuses our own window, which is what makes
                    // this guard fire in the first place.
                    crate::inject::note_recovery_on_clipboard();
                    return Ok(InjectOutcome {
                        landed: true,
                        diverted: true,
                    });
                }
                return Ok(InjectOutcome {
                    landed: false,
                    diverted: false,
                });
            }
            // A restore the previous paste scheduled and that has not fired yet would land on top
            // of this write (see inject::RestoreSlot): take it now. It becomes this paste's own
            // `prev` when this paste has none (its read came back empty/timeout or as our own
            // previous transcript — exactly what it reads inside that restore window), else it is
            // superseded. If the write fails, the original restore is put back.
            let pending = crate::inject::take_pending_restore();
            let prev = crate::inject::merge_pending_restore(prev, pending.clone(), !remote_target);
            let set_res = tokio::task::spawn_blocking(move || crate::inject::set_clipboard(&clip))
                .await
                .map_err(|e| e.to_string())?;
            if set_res.is_err() {
                crate::inject::restore_clipboard_later(pending);
            }
            set_res?; // propagate a set_text failure; prev was captured (time-bounded) above
                      // Longer settle for a remote-desktop target (content must cross the network first).
            tokio::time::sleep(std::time::Duration::from_millis(if remote_target {
                300
            } else {
                60
            }))
            .await;
            // And again after the settle, before the chord. The check above guards the clipboard
            // WRITE; this one guards the KEYSTROKE, and 60ms (300ms remote) of wall clock separates
            // them — the same gap `inject::paste` re-asks the epoch across on the other platform.
            // `diverted: true`, not `landed: false`: the transcript IS on the clipboard by now, so
            // that is the truthful answer, and the restore below must be skipped so it stays
            // pasteable.
            if own_window_focused(&app) {
                tracing::info!("[inject] skipped at the paste chord: our own window took focus");
                // Re-set through the PERSISTENT owner first. The write above used the plain
                // `set_clipboard`, which does not stick on Wayland once the setter returns — so
                // reporting the divert without this promises a clipboard that no longer holds the
                // text, and the caller has already advanced past that phrase. Same rule the X11
                // twin follows at its own chord guard.
                // With an answer available, the comment above becomes enforceable rather than
                // aspirational: if the persistent re-set fails, the plain `set_clipboard` above is
                // exactly the write that does not stick, so promising a divert would be the false
                // confirmation this arm was added to avoid. No chord was pressed, so the caller's
                // re-send is safe.
                if let Err(e) = crate::inject::set_clipboard_persistent(&text) {
                    tracing::warn!("[inject] divert at the paste chord failed: {e}");
                    return Ok(InjectOutcome {
                        landed: false,
                        diverted: false,
                    });
                }
                return Ok(InjectOutcome {
                    landed: true,
                    diverted: true,
                });
            }
            let r = crate::inject::wayland::paste(
                &app,
                typer.inner(),
                paste_shortcut,
                auto_enter,
                epoch,
            )
            .await;
            // Restore the user's prior clipboard only if the paste actually landed. If it failed,
            // leave the transcript on the clipboard so it's recoverable (the user can paste it
            // manually) instead of silently clobbering it with the old clipboard.
            //
            // `r.is_ok()` is not the same question as "did it press anything": the portal job also
            // returns `Ok(())` when ITS pre-job check finds the epoch cancelled. On an ERROR abort
            // that matters, because the recovery block at the end of this function is about to put
            // the transcript on the clipboard — and this restore, which serves `prev` 400ms later,
            // would erase it, leaving the text neither typed nor recoverable. A plain user cancel
            // still restores: there the clobbered clipboard IS the thing to put back.
            if r.is_ok()
                && !(crate::inject::injection_cancelled(epoch)
                    && crate::inject::cancel_wants_recovery(epoch))
            {
                crate::inject::restore_clipboard_later(prev);
            }
            r
        };
        wayland_res
    } else {
        // The X11/Windows twin of the two Wayland sink guards above. This arm hands off to the
        // blocking pool, and everything past that point — `Enigo::new`, `Clipboard::new`, an
        // un-timed blocking clipboard read, the settle — happens after the guard that ran before
        // the dispatch, so it needs to re-ask at its own sinks. Passing a probe rather than the
        // handle keeps `inject.rs` Tauri-free; it is safe from the blocking pool because Tauri's
        // `is_focused` posts to the event loop and waits on a channel, so the toolkit call runs on
        // the main thread whichever thread asks. No deadlock: this command runs on the async
        // runtime, so the main thread is never waiting on us.
        let own_focused_probe = own_focused_probe.clone();
        tokio::task::spawn_blocking(move || {
            crate::inject::inject(
                &text,
                &method,
                auto_enter,
                restore_clipboard,
                &paste_shortcut,
                remote_target,
                epoch,
                &own_focused_probe,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    // If a DIED session (not a user cancel) cut this injection short, the text stopped somewhere
    // mid-sentence and the window it was going into has already been refocused by the teardown.
    // Leave the transcript on the clipboard so it is recoverable — the same courtesy the
    // stop-mode path extends. A user-initiated cancel deliberately does not land here.
    let mut recovered = crate::inject::injection_cancelled(epoch)
        && crate::inject::cancel_wants_recovery(epoch)
        && !recovery_text.is_empty();
    if recovered {
        // `recovered` is what upgrades `NothingWritten` to `landed: true, diverted: true` below,
        // i.e. the claim "the text IS somewhere the user can reach". Now that the write can say
        // otherwise, that claim follows the write instead of assuming it: on failure the outcome
        // falls back to plain `NothingWritten`, which is truthful and safe. (This arm is also
        // reachable after a partial or even complete write — the typing backends report
        // `Landed::Yes` for a prefix — because `Landed` does not say whether any key went out;
        // an error abort landing in that window then overwrites the clipboard with text that
        // was already typed. Closing that needs a "nothing written" variant on `Landed`.)
        match crate::inject::set_clipboard_persistent(&recovery_text) {
            Ok(()) => {
                tracing::info!(
                    "[inject] aborted by a failed session — transcript left on the clipboard"
                );
                // Tell the SESSION-level restore not to serve the user's old clipboard over the
                // top. The per-paste restore above already declines on this condition;
                // `end_injection` runs after this job is gone and cannot ask the same question by
                // epoch. Armed only on success, so a failed recovery does not suppress the
                // restore of the clipboard the user actually still has.
                crate::inject::note_recovery_on_clipboard();
            }
            Err(e) => {
                tracing::warn!("[inject] aborted by a failed session, and the clipboard recovery failed too: {e}");
                recovered = false;
            }
        }
    }
    res.map(|landed| match landed {
        crate::inject::Landed::Yes => InjectOutcome {
            landed: true,
            diverted: false,
        },
        // "Nothing written" is only true if the recovery block above did not just write the
        // transcript to the clipboard. When it did, the text IS somewhere the user can reach, and
        // saying otherwise both mis-describes the state and makes the caller re-issue an insert
        // that would land in the same place. This is also what the Wayland arm reports for the
        // same event, so the two platforms now answer the same question the same way.
        crate::inject::Landed::NothingWritten if recovered => InjectOutcome {
            landed: true,
            diverted: true,
        },
        crate::inject::Landed::NothingWritten => InjectOutcome {
            landed: false,
            diverted: false,
        },
        crate::inject::Landed::OnClipboard => InjectOutcome {
            landed: true,
            diverted: true,
        },
    })
}

/// Would "Auto" treat `app_id` as a remote-desktop client? For the per-app rule editor, which
/// shows "detected as a remote-desktop client" / "not a known remote-desktop client" next to the
/// Auto choice. The app-id list only: the window-class detector needs the window focused, which
/// the editor's target is not.
#[tauri::command]
pub fn remote_desktop_auto_detected(app_id: String) -> bool {
    // An app id is short; bound the input so a junk IPC argument costs nothing.
    let id: String = app_id.chars().take(256).collect();
    crate::inject::rdp_client::is_remote_desktop_app(&id)
}
