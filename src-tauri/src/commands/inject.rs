//! Text injection into the focused app (paste or type), the clipboard snapshot
//! around it, and the focused-app / selection queries.

use super::{own_window_focused, read_selection_bounded};
use crate::inject::text::InjectOutcome;
use crate::inject::wayland::WaylandTyper;
use tauri::{AppHandle, State};

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
            tracing::info!("[clip] begin_injection: snapshot {} bytes", text.len());
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
            "[clip] end_injection: restore {} bytes (delayed)",
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
            "[clip] restore_clipboard_snapshot: {} bytes (delayed)",
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
    // (aux_windows::quickadd::show → win_seed), but the clipboard may still be settling (Office
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
                    "[quickadd-seed] atspi selection {} bytes -> seed {} bytes",
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
                    "[quickadd-seed] primary fallback {} bytes -> seed {} bytes",
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
/// summon seed (`aux_windows::quickadd::win_seed`), which lands in the source app since focus is back there.
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
            "[quickadd-close] windows re-grab -> {} bytes",
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
    // re-check in `inject::text`.
    expect_app_id: Option<String>,
    // The per-app rule's "Remote desktop" override: `Some(true)`/`Some(false)` force the
    // remote-desktop clipboard handling on/off for that app, `None` = auto-detect (exe/app id +
    // window class). See the resolution at the sink in `inject::text`.
    remote_desktop: Option<bool>,
) -> Result<InjectOutcome, String> {
    crate::inject::text::inject_text(
        app,
        typer,
        vkbd,
        guard,
        text,
        method,
        auto_enter,
        restore_clipboard,
        paste_shortcut,
        expect_app_id,
        remote_desktop,
    )
    .await
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
