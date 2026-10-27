//! Inserting one transcript into the focused app: the work behind the `inject_text` command.
//! The Tauri command itself stays a thin wrapper in `commands/inject.rs`.

use crate::commands::{blocking, own_window_focused, read_selection_bounded};
use crate::inject::wayland::WaylandTyper;
use crate::inject::{sink_gate, SinkGate};
use tauri::{AppHandle, Manager, State};

/// How long a manufactured-stop latch stays valid — see `hotkeys::held_keys::take_lost_if_fresh`.
///
/// Sized against the LONGEST leg it has to span, not a guessed round-trip: what sits in the middle
/// is the untrusted server returning a final, so anything shorter is a bypass the server itself can
/// trigger by stalling. A stale latch only costs one phrase a clipboard divert; a short one costs
/// the control entirely.
///
/// The frontend's stuck-finalize watchdog does NOT bound that leg: `armStuckWatchdog` returns early
/// unless the endpoint is `stream` (`src/lib/dictation/streaming.ts`), and a legal `activation:
/// "hold"` + `endpoint: "batch"` profile carries the WHOLE transcript in one insert, bounded only by
/// the shared HTTP client's 120s default (`transport::mod`, not overridden for `batch`). 130s covers
/// that timeout plus the stop → POST → final → inject hops.
const HELD_CHORD_LATCH_TTL: std::time::Duration = std::time::Duration::from_secs(130);

/// What `inject_text` did, so the caller can keep its own bookkeeping honest.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectOutcome {
    /// The text LANDED — typed, pasted, or deliberately left on the clipboard. `false` means no
    /// key or chord went out and the transcript was not delivered: the caller must not advance its
    /// typed baseline, there is nothing to recover, and a re-send is safe. That invariant is the
    /// contract; the causes today are one of our own windows holding focus, so the insert was
    /// skipped (at entry or at a sink — at a Wayland paste chord only when a user cancel landed
    /// during the chord-time own-window probe or after the portal job's pre-job probe answered,
    /// otherwise it is a divert), or a clipboard write that was busy or failed before any
    /// keystroke: on the clipboard-only, divert or recovery path, or at the paste sink (on
    /// Windows: a quick-add copy grab still held the clipboard after 8 s, a stuck clipboard read
    /// still held it, or the remote-desktop owner or legacy write failed or timed out — a
    /// timed-out offer may still reach the clipboard later), or an insert the caller marked
    /// `withhold_on_divert` (the hard-break separator, a whitespace-only live phrase) that would
    /// otherwise have been diverted, or recovered after a sink that wrote nothing, before anything
    /// was written: it writes nothing,
    /// and that caller drops it rather than re-sending. Or a bare auto-Enter (empty text) the
    /// mid-function divert withheld: no Return went out. A cancel before the write is not a
    /// `landed: false` cause, withheld or not.
    ///
    /// The default for any future early return must be `true`. `false` means "send it again", and a
    /// wrong `false` re-types a phrase the user already has — visibly duplicated text, which is
    /// worse than the silent drop this field exists to fix.
    pub landed: bool,
    /// We DIVERTED to the clipboard against the caller's wishes — it asked for typing or pasting
    /// and got neither, because the trigger chord was still held, focus had moved to a different
    /// app, one of our own windows took focus just before the paste chord, the active keyboard
    /// layout cannot type the transcript's letters (Wayland portal typing), or a failed session's
    /// transcript was recovered to the clipboard after the sink wrote nothing
    /// (`Landed::NothingWritten`). A recovery after a cancel bail or a partly typed phrase still
    /// reports `landed: true, diverted: false`: `Landed` cannot say whether a key went out (see the
    /// note at the recovery block in `inject_text`). The text is safe, but it did not go where the
    /// user was looking, so the caller must not stamp its green "typed" confirmation.
    pub diverted: bool,
}

impl InjectOutcome {
    /// Typed or pasted: the text reached the target.
    const LANDED: Self = Self {
        landed: true,
        diverted: false,
    };
    /// Nothing went out and nothing was delivered: a re-send is safe (see `landed`).
    const NOT_LANDED: Self = Self {
        landed: false,
        diverted: false,
    };
    /// Delivered by leaving the transcript on the clipboard instead.
    const DIVERTED: Self = Self {
        landed: true,
        diverted: true,
    };
}

/// `set_clipboard_persistent` off the async runtime. It blocks on its serving thread's answer —
/// on Windows for up to `CLIP_IDLE_WAIT` + 250ms while another program holds the clipboard — and
/// `inject_text` is async, so calling it inline parks a runtime worker for that long. Still
/// awaited in place, so every call site keeps its ordering and its Ok/Err handling.
pub(crate) async fn persist_off_runtime(text: String) -> Result<(), String> {
    blocking(move || crate::inject::set_clipboard_persistent(&text)).await
}

/// `persist_off_runtime` for a write gated on a cancel: `cancelled` is asked again after the
/// serving thread's stuck-read wait. `Ok(false)` = cancelled during it, nothing written — see
/// `set_clipboard_persistent_unless`.
async fn persist_off_runtime_unless(
    text: String,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<bool, String> {
    blocking(move || crate::inject::set_clipboard_persistent_unless(&text, cancelled)).await
}

/// The body of the `inject_text` command (see [`crate::commands::inject_text`] for the
/// parameters): the own-window, held-chord and focus guards, then the clipboard, paste or
/// typing sink.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn inject_text(
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
    // `None` = no identified target (the focus tracker has nothing: a cold a11y bridge, or no
    // tracker on this platform or session), which skips the re-check below. Our own window is
    // sent as the synthetic id "self" (`get_focused_app`, forwarded by streaming.ts
    // `resolveTarget`) on purpose; the sink's `focused_app_now` never reports "self", so a focus
    // move from it to another app before the keys go out is a mismatch and diverts to the
    // clipboard.
    expect_app_id: Option<String>,
    // The per-app rule's "Remote desktop" override: `Some(true)`/`Some(false)` force the
    // remote-desktop clipboard handling on/off for that app, `None` = auto-detect (exe/app id +
    // window class). See the resolution at the sink below.
    remote_desktop: Option<bool>,
    // The CLIPBOARD form of `text`, when it differs from what goes into the field: a translated
    // live session types each block behind a phrase gap ("\n\n\n") the field owes, but the
    // clipboard is replaced, not appended to, so a copy that opened with that gap would paste
    // three blank lines (three empty submits in a chat box); a plain live phrase is likewise
    // trimmed of its seam space. Every arm that leaves the transcript
    // on the clipboard for the user — the clipboard-only write, the diverts and the error-abort
    // recoveries — writes this instead of `text`; what is typed or pasted INTO the field stays
    // `text`. `None` = the same as `text`. See `clipboard_form`.
    clipboard_text: Option<String>,
    // The caller has nothing worth recovering from the clipboard (the hard-break separator, a
    // lone " "; a whitespace-only live phrase, the server's output suffix alone), so it never
    // becomes the clipboard's persistent owner over what the user copied, on any divert or
    // recovery arm. A cancel before any write, user OR error abort, stops it with
    // `landed: true, diverted: false` and nothing written: it is never recovered. Where a divert
    // or recovery would write it before anything has been written (the mid-function divert, the
    // Wayland write guard, the Wayland portal's letters-not-on-the-layout divert, the error-abort
    // recovery after a sink that wrote nothing) it writes nothing and reports `landed: false,
    // diverted: false`. Where the paste write already put it on the clipboard (the chord-time
    // own-window divert, an error abort cancelling the paste) it schedules the restore a pasted
    // one gets, arms neither the delivered nor the recovery guard, and reports `landed: true,
    // diverted: false`: the clipboard WAS written, and the caller reads `landed` as that, to give
    // the user's copy back. A failed paste schedules the same restore and returns the error. That
    // restore only puts back what the sink read under `restore_clipboard`, which the separator
    // never passes (its caller owns the restore), so on the reject the caller gives the user's
    // copy back from its own snapshot.
    withhold_on_divert: bool,
) -> Result<InjectOutcome, String> {
    // Sanitized before ANY injection path, the clipboard-only one included (see `sanitize_injected`).
    let text = crate::inject::sanitize_injected(&text);
    // Same sanitising, same posture: this string reaches the clipboard too.
    let clip_text = clipboard_form(&text, clipboard_text);
    // Captured HERE — before any await — not where the job is finally queued. Everything below
    // (the held-modifier wait, two focus IPCs, a bounded clipboard read, the settle, and on the
    // Wayland fallback a failed virtual-keyboard attempt) can take a second or more; a job reading
    // the counter later would adopt a cancel's post-cancel generation and never see itself cancelled.
    let epoch = crate::inject::injection_epoch();
    tracing::info!(
        "[inject] {} bytes via {} (auto_enter={})",
        text.len(),
        method,
        auto_enter
    );
    // Never inject into our OWN UI: if one of our real windows holds keyboard focus, typed/pasted
    // keys would fire buttons/shortcuts in the app itself (e.g. dictating while looking at Home) —
    // AND a clipboard-only insert would silently clobber the user's clipboard for an insert they
    // can't even see land. So this guard runs for ALL methods, BEFORE the clipboard-only branch.
    // A Wayland client is always told its own keyboard focus, so this is reliable on KWin —
    // unlike detecting other apps' focused fields. The transcript still shows in the chip.
    if own_window_focused(&app) {
        tracing::info!("[inject] skipped: our own window holds focus");
        return Ok(InjectOutcome::NOT_LANDED);
    }
    // Clipboard-only types no keystrokes, so it needs no modifier gate (the own-window guard
    // above already ran).
    if method == "clipboard" {
        // Same check as the mid-function divert below, for the same reason: a cancel landing
        // between the epoch capture and this write (the own-window focus IPC above is an
        // event-loop round trip) must not install the transcript over the user's clipboard.
        // `cancel_discards`, not a bare `injection_cancelled`: an error abort wants its text kept,
        // unless the caller withheld it (nothing in it to recover).
        let discarded = move || crate::inject::cancel_discards(epoch, withhold_on_divert);
        if discarded() {
            tracing::info!("[inject] clipboard-only insert cancelled before the write — skipping");
            return Ok(InjectOutcome::LANDED);
        }
        if !text.is_empty() {
            // `landed: false` on a failed write is safe: no keystroke is ever synthesized on this
            // path, so the caller's re-send cannot duplicate anything. The cancel is asked again
            // after the write's stuck-read wait (Windows, up to 1s): a cancel during it skips the
            // write, as the gate above does.
            match persist_off_runtime_unless(clip_text.clone(), discarded).await {
                Err(e) => {
                    tracing::warn!("[inject] clipboard-only insert failed: {e}");
                    return Ok(InjectOutcome::NOT_LANDED);
                }
                Ok(false) => return Ok(InjectOutcome::LANDED),
                Ok(true) => {}
            }
            // Delivered: the session-end restore must not serve the snapshot over it.
            crate::inject::note_delivered_unless_user_cancelled(epoch);
            // A recovery write too when an error abort fell through the gate above: arm the
            // session-restore guard, as the mid-function divert below does, so the error
            // teardown's `end_injection` does not serve the session snapshot over the transcript.
            if crate::inject::error_aborted(epoch) {
                crate::inject::note_recovery_on_clipboard();
            }
        }
        return Ok(InjectOutcome::LANDED);
    }
    // Nothing to type and no Enter to send → bail before the keystroke paths. Without this, the
    // Wayland PASTE branch below would set_clipboard("") — clobbering the user's clipboard with an
    // empty string and firing a no-op Ctrl+V — whenever a phrase sanitizes to empty (the server
    // emitted only control chars). Mirrors the X11 inject::inject guard. (empty + auto_enter still
    // falls through below to send the bare Enter.)
    if text.is_empty() && !auto_enter {
        return Ok(InjectOutcome::LANDED);
    }
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
                    // Not fail-open: typing anyway folds the transcript's characters into the
                    // still-held modifier as shortcut chords in the focused app — with the server
                    // choosing WHICH ones. Not plain fail-closed either: `SHORTCUT_MOD_CODES` spans
                    // both Shifts and this is `any_held`, so a user holding Shift to capitalize or
                    // Ctrl to scroll-zoom would silently have every phrase diverted. So divert
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
    // MANUFACTURES this injection at the exact moment the chord is provably still down. So that
    // stop (not the wipe — see `held_keys::MODS_LOST_AT`) arms a chord-precise, self-expiring latch
    // for this injection to consume.
    //
    // Deliberately consumed AFTER the loop, not merged into it: this is a "the chord was down when
    // we lost sight of it" fact, not a live reading, so there is nothing to wait for. Straight to
    // the same clipboard divert the timeout arm produces (consumed below the own-window sink skip).

    // The entry's own-window guard, re-run at the sink (decided-at-T, applied-at-T+n): the
    // held-modifier wait can take half a second, and in a live or hands-free session the user is
    // expected to be moving between windows. Clicking our own window in that gap would land the
    // keys in the app's own settings/dictionary fields — and on the paste path clobber the
    // clipboard first.
    //
    // The per-app re-check below CANNOT stand in for this. `focused_app_now` classifies our own
    // window as noise and falls back to `last_other` (written on Windows by `focus::windows`'
    // `fold_foreground`), so it reports the PREVIOUS app — which still matches `expect_app_id`, so
    // the mismatch arm never fires. Only the authoritative webview-focus check sees it, so re-run
    // exactly that.
    //
    // `landed: false`, deliberately NOT a degrade to "clipboard": our own window holding focus must
    // never clobber the user's clipboard for an insert they cannot see land. Skipping is safe —
    // `streaming.ts` leaves `injectedText` un-advanced on a skip, so the text goes out with the
    // next insert.
    if own_window_focused(&app) {
        tracing::info!("[inject] skipped at the sink: our own window took focus mid-injection");
        return Ok(InjectOutcome::NOT_LANDED);
    }
    // Consumed UNCONDITIONALLY (no `!modifiers_stuck &&` short-circuit): a latch left armed by a
    // true positive would divert the NEXT, legitimate injection too. Guarded on `!text.is_empty()`
    // so the bare auto-Enter insert — which carries no transcript and cannot be typed into a chord
    // harmfully — does not steal the latch from the transcript insert that follows it. And placed
    // BELOW the own-window sink skip, so an injection that is going to write nothing and be re-sent
    // does not destroy the latch the re-send needs.
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
    // focused when the caller's queued insert task STARTED (streaming.ts `resolveTarget` runs
    // inside the inject chain, after the queue wait), and getting here takes real time: the task's
    // own awaits after that (a live phrase's server translation round trip and the
    // `begin_injection` clipboard read), the IPC hop, and the up-to-500ms modifier wait just above.
    // In a live or hands-free session the user is expected to be switching windows, so the window
    // that receives the keys may not be the one the decision was made for. Re-check now, at the
    // sink. The later prev-clipboard read and settle are re-checked only for OUR OWN window (the
    // probes at the clipboard write and the chord); a move to another app inside that window is
    // not re-checked against the per-app rule.
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
    // ONE focus read, used for both decisions below, so `remote_target` is decided at the sink too.
    // Decided earlier, focus leaving a remote-desktop client meanwhile would skip the restore; focus
    // entering one would give the paste the short local settle AND schedule a restore — the
    // delayed-rendering failure (see `rdp_client::is_remote_desktop_app`), where the remote's
    // deferred fetch pastes the RESTORED value.
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
        // Reachable only by the two mid-function DIVERSIONS above — `modifiers_stuck` and the
        // focus mismatch — so it sits at the far end of the held-modifier wait (a full 500ms on the
        // `modifiers_stuck` arm). A cancel in that window must not install the transcript as a live
        // persistent clipboard owner over what the user copied: `cancel_injection`'s contract.
        //
        // `cancel_discards`, not a bare `injection_cancelled`: an error abort (a died session) reaches
        // this branch through the same race, and it DOES want its text recovered. Because this is
        // an early `return`, it never reaches the recovery block at the end of the function, so
        // letting the write happen IS that recovery. Unless the caller withheld it: a withheld
        // insert has nothing to recover, so any cancel stops it here with `landed: true`, as the
        // clipboard-only arm and the paste write gate do.
        let discarded = move || crate::inject::cancel_discards(epoch, withhold_on_divert);
        if discarded() {
            tracing::info!("[inject] diverted to clipboard, but cancelled first — skipping");
            return Ok(InjectOutcome::LANDED);
        }
        // A divert the caller opted out of: nothing written, so nothing for the session-end restore
        // to step around, and `landed: false` tells the caller the text never went out. Keyed on
        // the caller's flag, not on the text's content — a word-less dictated phrase ("?") is
        // still a transcript and keeps its divert. The empty bare Enter keeps its own arm.
        if withhold_on_divert && !text.is_empty() {
            tracing::info!("[inject] diverted separator withheld");
            return Ok(InjectOutcome::NOT_LANDED);
        }
        if !text.is_empty() {
            // `landed: false` on a failed write: on `true` the caller advances its baseline and
            // the phrase leaves the re-send stream for good. Nothing has been typed on this arm,
            // so `false` is both truthful and safe. A cancel during the write's stuck-read wait
            // skips it, as the gate above does.
            match persist_off_runtime_unless(clip_text.clone(), discarded).await {
                Err(e) => {
                    tracing::warn!("[inject] divert to clipboard failed: {e}");
                    return Ok(InjectOutcome::NOT_LANDED);
                }
                Ok(false) => return Ok(InjectOutcome::LANDED),
                Ok(true) => {}
            }
            // Delivered: the session-end restore must not serve the snapshot over it.
            crate::inject::note_delivered_unless_user_cancelled(epoch);
            // Another recovery write: an error abort that fell through the gate above has just put
            // the transcript on the clipboard; arm the session-restore guard like the two
            // paste-path writes so end_injection does not serve `prev` over it. Not armed on a
            // plain divert — that session is still live.
            if crate::inject::error_aborted(epoch) {
                crate::inject::note_recovery_on_clipboard();
            }
        }
        return Ok(divert_outcome(&text));
    }
    // Now that the method is final and focus has been read once, at the sink. Two detectors (see
    // `inject::rdp_client`); the per-app rule overrides both when it says On/Off (`None` is "Auto").
    // Both are logged so a support log shows WHICH detector fired and whether the rule overrode it.
    // A bare auto-Enter (empty text) touches no clipboard, so there is nothing remote-specific to
    // resolve or log.
    let remote_target = method != "direct"
        && !text.is_empty()
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
    // Recorded by each paste sink once the transcript reached the clipboard, NOT here: several
    // sinks still bail with nothing written, and a skipped phrase must not overwrite the target
    // of the paste before it.

    // Kept for the error-abort recovery below: the X11 branch moves `clip_text` into
    // spawn_blocking. The clipboard form, like every recovery write (see `clipboard_text`); it is
    // empty exactly when `text` is, which the bare-Enter checks below rely on.
    let recovery_text = clip_text.clone();
    // The probe the two typing backends re-ask focus with. Built once here so `virtual_keyboard`
    // (served by a bare `std::thread`, no `AppHandle`) and `inject` (served by the blocking pool)
    // take the same predicate the entry guard above uses.
    let probe_app = app.clone();
    let own_focused_probe = move || own_window_focused(&probe_app);
    let res = if crate::inject::is_wayland() {
        // Each Wayland arm reports its own `Landed`, like the X11 arm below. The two TYPING arms'
        // own-window guards (bare auto-Enter via the portal, `direct` via the virtual keyboard)
        // live inside the backends, at the keystroke: the far side of the widest guard-to-sink
        // gap on any path.
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
            crate::inject::wayland::type_text(&app, typer.inner(), "", "", true, epoch, false).await
        } else if method == "direct" {
            // Prefer the virtual keyboard (Caps Lock-/layout-correct typing). Fall back
            // to the portal keycode path when the protocol is unavailable (GNOME, KWin)
            // or the job fails before typing any key (see the arm below).
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
                    // By outcome: the backend also answers Ok when it typed nothing (our own
                    // window held focus) or was stopped by a cancel.
                    match landed {
                        crate::inject::Landed::NothingWritten => tracing::info!(
                            "[inject] virtual keyboard: nothing typed (our own window holds focus)"
                        ),
                        _ if crate::inject::injection_cancelled(epoch) => {
                            tracing::info!("[inject] virtual keyboard: stopped by cancel")
                        }
                        _ => tracing::info!(
                            "[inject] virtual keyboard job finished (a preceding [vkbd] 'stopped' line means it was cut short)"
                        ),
                    }
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
                    crate::inject::wayland::type_text(
                        &app,
                        typer.inner(),
                        &text,
                        &clip_text,
                        auto_enter,
                        epoch,
                        withhold_on_divert,
                    )
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
            // Capture the user's prior clipboard TIME-BOUNDED (400ms; None on timeout → skip the
            // restore), as begin_injection / read_primary_now do: the read is a blocking Wayland
            // round-trip that can hang forever on a dead clipboard owner, wedging the end-of-session
            // insert (the restoreClipboard:true caller) at "injecting" — the stuck-finalize watchdog
            // is stream-only. remote_target skips the capture — see its resolution above.
            //
            // A restore the previous paste scheduled and that has not fired yet (see
            // inject::RestoreSlot) is taken FIRST, as the X11/Windows twin does: left in the slot, it
            // could fire during the read, which then reads back our own previous transcript (no
            // `prev`) and this paste overwrites the restored clipboard with nothing scheduled to
            // bring it back. The guard re-schedules it if this paste bails before its write (`?`
            // included); after the write it is adopted or dropped below.
            let mut requeue = crate::inject::RequeueRestore(crate::inject::take_pending_restore());
            let prev = if restore_clipboard && !remote_target {
                match read_selection_bounded(|| {
                    arboard::Clipboard::new()
                        .ok()
                        .and_then(|mut c| crate::inject::read_prior_text(&mut c))
                })
                .await
                {
                    None => {
                        tracing::info!(
                            "[clip] paste: prev-clipboard read empty/timeout — skipping restore"
                        );
                        None
                    }
                    // Never our own last transcript nor an empty read (a stalled RDP delayed
                    // render) — see `worth_restoring`, shared with the X11/Windows paste.
                    Some(t) if !crate::inject::worth_restoring(&t) => None,
                    some => some,
                }
            } else {
                None
            };
            // Sink gate at the clipboard write, as `inject::inject`'s paste path has: nothing on
            // this path has asked about a cancel since the epoch capture (the held-modifier wait,
            // latch consume, focus read and bounded prev read: ~0.5-1.2s), and our own window was
            // last checked before the latch consume.
            // - Cancel: a user cancel means "I don't want this" (see `RECOVER_AT_EPOCH`), and writing
            //   anyway clobbers what they had copied. An error abort that wants recovery is NOT
            //   stopped: an early `return` would skip the recovery block at the end of this function
            //   and lose a died session's transcript. A withheld insert has nothing to recover, so
            //   any cancel stops it, as the X11/Windows paste does.
            // - The epoch is read AFTER the own-window probe (a main-thread round trip): a cancel
            //   from the hotkey or tray during it (focus stays in the target app, so it answers
            //   false) would otherwise still write, and with no `prev` the settle check's restore
            //   cannot undo that.
            // - Own window: a focus change in that gap would clobber the user's clipboard and fire
            //   Ctrl+V into one of our own windows. The settle is covered by the chord-time check.
            //
            // The own-window skip answers `landed: false`: nothing is written yet (`prev` was only
            // READ), so the caller's re-send duplicates nothing. It cannot strand the held-chord
            // latch — had it been armed, `method` would be "clipboard" and this branch unreachable.
            let gate = clipboard_write_gate(
                || own_window_focused(&app),
                || crate::inject::injection_cancelled(epoch),
                || crate::inject::cancel_wants_recovery(epoch),
                withhold_on_divert,
            );
            if gate == SinkGate::Cancelled {
                tracing::info!("[clip] paste: cancelled before the clipboard write — skipping");
                return Ok(InjectOutcome::LANDED);
            }
            if gate == SinkGate::OwnWindow {
                tracing::info!(
                    "[inject] skipped at the clipboard write: our own window took focus"
                );
                // An ERROR abort reaches here too (the cancel arm returns only when
                // `!cancel_wants_recovery`), and a bare skip would bypass the recovery block at the
                // end of this function, losing a died session's transcript — so recover here. A
                // withheld insert has nothing to recover: it falls through to the plain skip.
                if crate::inject::error_aborted(epoch)
                    && !recovery_text.is_empty()
                    && !withhold_on_divert
                {
                    // Arm the session-restore guard ONLY if the recovery actually landed. Arming
                    // it on a failed write would suppress the restore of the user's own clipboard
                    // to protect a transcript that is not there — losing both.
                    //
                    // The pending restore taken above is dropped, not re-queued: served 400ms
                    // later, it would erase the recovered transcript.
                    let _ = requeue.0.take();
                    if let Err(e) = persist_off_runtime(recovery_text.clone()).await {
                        tracing::warn!(
                            "[inject] recovery to clipboard failed at the write guard: {e}"
                        );
                        return Ok(InjectOutcome::NOT_LANDED);
                    }
                    // The session-restore guard is armed here, not by the recovery block at the
                    // end of this function: this early `return` skips it. (The error teardown
                    // refocusing our own window is what makes this arm fire.)
                    crate::inject::note_recovery_on_clipboard();
                    crate::inject::note_delivered_unless_user_cancelled(epoch);
                    return Ok(InjectOutcome::DIVERTED);
                }
                return Ok(InjectOutcome::NOT_LANDED);
            }
            // Both arms write through the live owner (`set_clipboard` is `persist_transcript`): a
            // plain write would be dropped when it returns (no data-control — GNOME through
            // XWayland), before the portal's Ctrl+V or a remote client's after-the-chord fetch
            // reads it. (`set_clipboard_persistent`'s own pending-restore take is a no-op:
            // `requeue` holds it.)
            let set_res = if remote_target {
                persist_off_runtime(clip).await
            } else {
                blocking(move || crate::inject::set_clipboard(&clip)).await
            };
            set_res?;
            // The transcript is on the clipboard now, so this is where the paste went — see
            // LAST_PASTE_REMOTE. Recorded only here, past every bail above, so a phrase that
            // skipped without writing does not overwrite the previous paste's target.
            crate::inject::note_paste_target(remote_target);
            // Written: the pending restore taken above becomes this paste's own `prev` when this
            // paste has none (its read came back empty/timeout or as our own previous transcript —
            // exactly what it reads inside that restore window), else it is superseded.
            let prev = crate::inject::merge_pending_restore(prev, requeue.0.take(), !remote_target);
            // Longer settle for a remote-desktop target (content must cross the network first).
            tokio::time::sleep(std::time::Duration::from_millis(if remote_target {
                300
            } else {
                60
            }))
            .await;
            // And again after the settle, before the chord: the check above guards the clipboard
            // WRITE, this one the KEYSTROKE — the same gap `inject::paste` re-asks the epoch across
            // on the other platform.
            //
            // The epoch is asked FIRST, as the X11 twin does at its chord. A cancel in the settle
            // with our own window focused (the error teardown refocuses it) would otherwise take
            // the divert below: a user cancel would leave the discarded transcript as a persistent
            // owner and never put `prev` back, and an error abort's early `return` would skip the
            // recovery block at the end of this function, so `note_recovery_on_clipboard` is never
            // armed and `end_injection` restores the old snapshot over the transcript. Not pressing
            // the chord and reporting `Landed::Yes` lets the restore below decide exactly as the
            // X11 twin does: a user cancel restores `prev`, an error abort keeps the transcript
            // for the recovery block.
            let cancelled_in_settle = crate::inject::injection_cancelled(epoch);
            // The chord-time own-window probe answers `NothingWritten`, exactly as the portal
            // job's own pre-job probe does one queue hop later, so both take the single divert
            // arm below rather than two copies of it that can drift apart.
            let r = if cancelled_in_settle {
                tracing::info!("[clip] paste: cancelled during the settle — not pasting");
                Ok(crate::inject::Landed::Yes)
            } else if own_window_focused(&app) {
                tracing::info!("[inject] skipped at the paste chord: our own window took focus");
                Ok(crate::inject::Landed::NothingWritten)
            } else {
                crate::inject::wayland::paste(
                    &app,
                    typer.inner(),
                    paste_shortcut,
                    auto_enter,
                    epoch,
                )
                .await
            };
            // `NothingWritten` here means our own window took focus before the chord — at the
            // chord-time probe above or at the portal job's pre-job probe (`wayland.rs`) — but by
            // then THIS arm has already written the transcript and noted the paste target.
            // Falling through would schedule the `prev` restore over a phrase nobody pasted and
            // report it as never written, with nothing keeping the session snapshot: hand the
            // transcript to the persistent owner and report the divert.
            //
            // Unless the job was cancelled: a cancel can still land during the chord-time probe
            // (the epoch was read before it) or after the portal job's probe answered. A cancelled
            // job falls through to the restore/recovery logic below, as `cancelled_in_settle` does:
            // a user cancel restores `prev` and reports nothing written, an error abort skips the
            // restore and the recovery block at the end of this function persists the transcript
            // and arms `note_recovery_on_clipboard`.
            if matches!(r, Ok(crate::inject::Landed::NothingWritten))
                && !crate::inject::injection_cancelled(epoch)
            {
                // A withheld insert is not diverted (see `withhold_on_divert`): no persistent
                // owner, no delivered guard, just the restore a pasted one gets. `landed: true`,
                // because the paste write above already replaced the clipboard.
                if withhold_on_divert {
                    tracing::info!(
                        "[inject] separator not pasted (our own window took focus) — withheld"
                    );
                    crate::inject::restore_clipboard_later(prev);
                    return Ok(InjectOutcome::LANDED);
                }
                tracing::info!(
                    "[inject] our own window took focus before the paste chord — left on the clipboard"
                );
                // The paste write above already put the transcript on a live owner. A clipboard
                // form that differs from the pasted text (a translated block's field gap, a plain
                // phrase's seam space) is written over it: this is now a divert, and the user
                // pastes it. That second write is unavoidable here — the paste write went out
                // before the divert was known. If it fails, the gapped text is still on a live
                // owner, so the divert stands.
                if clip_text != text {
                    if let Err(e) = persist_off_runtime(clip_text.clone()).await {
                        tracing::warn!(
                            "[inject] divert before the paste chord: the clipboard form could not replace the pasted text: {e}"
                        );
                    }
                }
                // Delivered — and after this paste's `note_paste_target` above, which cleared the
                // flag: the session-end restore must not serve the snapshot over it.
                crate::inject::note_delivered_unless_user_cancelled(epoch);
                return Ok(InjectOutcome::DIVERTED);
            }
            // Restore the user's prior clipboard only if the paste landed; a failed one leaves the
            // transcript on the clipboard to paste manually.
            //
            // `r.is_ok()` is not "did it press anything": the portal job also answers
            // `Ok(Landed::Yes)` when ITS pre-job check finds the epoch cancelled. On an ERROR abort
            // the recovery block at the end of this function is about to put the transcript on the
            // clipboard, and this restore (serving `prev` 400ms later) would erase it, leaving the
            // text neither typed nor recoverable. A plain user cancel still restores: the clobbered
            // clipboard IS the thing to put back. So does a withheld insert in every case: the
            // recovery block skips it, and there is nothing in it to paste manually.
            if withhold_on_divert || (r.is_ok() && !crate::inject::error_aborted(epoch)) {
                crate::inject::restore_clipboard_later(prev);
            } else if r.is_err() && clip_text != text {
                // The transcript stays on a live owner to paste manually — in its clipboard form,
                // since it is now there to paste: a form that differs (a translated block without
                // its field gap, or a plain phrase without its seam space) is written over the
                // pasted text, as the chord-time divert above does.
                if let Err(e) = persist_off_runtime(clip_text.clone()).await {
                    tracing::warn!(
                        "[inject] paste failed and the clipboard hand-off failed too: {e}"
                    );
                }
            }
            r
        };
        wayland_res
    } else {
        // The X11/Windows twin of the two Wayland sink guards above. This arm hands off to the
        // blocking pool, and everything past that point — `Enigo::new`, `Clipboard::new`, an
        // un-timed blocking clipboard read, the settle — happens after the guard that ran before
        // the dispatch, so it needs to re-ask at its own sinks. Passing a probe rather than the
        // handle keeps `inject/mod.rs` Tauri-free; it is safe from the blocking pool because Tauri's
        // `is_focused` posts to the event loop and waits on a channel, so the toolkit call runs on
        // the main thread whichever thread asks. No deadlock: this command runs on the async
        // runtime, so the main thread is never waiting on us.
        let own_focused_probe = own_focused_probe.clone();
        let x11_res = tokio::task::spawn_blocking(move || {
            crate::inject::inject(
                &text,
                &clip_text,
                &method,
                auto_enter,
                restore_clipboard,
                &paste_shortcut,
                remote_target,
                epoch,
                &own_focused_probe,
                withhold_on_divert,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        // LAST_PASTE_REMOTE: the X11/Windows sink (`inject::paste`) records its own target at the
        // write, as the Wayland arm does. This covers only an Err, which may or may not have
        // written, so it may only ever record a REMOTE target — the safe side, which skips a
        // restore rather than serving one over a fetch the remote has not made yet.
        // `remote_target` already excludes direct typing; a bare auto-Enter carries no transcript
        // and touches no clipboard, so it does not count either (`!recovery_text.is_empty()`).
        if remote_target && !recovery_text.is_empty() && x11_res.is_err() {
            crate::inject::note_paste_target(true);
        }
        x11_res
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    // If a DIED session (not a user cancel) cut this injection short, the text stopped somewhere
    // mid-sentence and the window it was going into has already been refocused by the teardown.
    // Leave the transcript on the clipboard so it is recoverable — the same courtesy the
    // stop-mode path extends. A user-initiated cancel deliberately does not land here, and neither
    // does a withheld insert: it has nothing to recover, so the error teardown's snapshot restore
    // (and the sink's own restore, scheduled above) is left alone.
    let mut recovered =
        crate::inject::error_aborted(epoch) && !recovery_text.is_empty() && !withhold_on_divert;
    if recovered {
        // `recovered` upgrades `NothingWritten` to `landed: true, diverted: true` below ("the text
        // IS somewhere the user can reach"), so it follows the write: on failure the outcome falls
        // back to plain `NothingWritten`. (Known gap: this arm is also reachable after a partial or
        // complete write — `Landed::Yes` covers both a typed prefix and a job cancelled before any
        // key — so an error abort there overwrites the clipboard with text already typed. Closing
        // that needs a cancelled-before-any-key variant distinct from `Landed::Yes`.)
        match persist_off_runtime(recovery_text).await {
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
    settle_outcome(res, recovered, epoch)
}

/// `inject_text`'s final answer from the sink's `Landed` (and whether the error-abort recovery
/// block put the transcript on the clipboard). Every `diverted: true` it reports tells the
/// frontend the transcript is on the clipboard to paste — a sink's own divert
/// (`Landed::OnClipboard`, e.g. `inject::paste`'s chord-time own-window check or the Wayland
/// portal's unreachable-layout divert) and a recovered abort alike — so it arms
/// `DELIVERED_ON_CLIPBOARD` here, after the sink's last `note_paste_target` (which clears it),
/// or the session-end restore would serve the snapshot over that transcript — unless a user
/// cancel superseded the job started at `epoch`, which owes that restore instead.
pub(crate) fn settle_outcome(
    res: Result<crate::inject::Landed, String>,
    recovered: bool,
    epoch: u64,
) -> Result<InjectOutcome, String> {
    let outcome = res.map(|landed| match landed {
        crate::inject::Landed::Yes => InjectOutcome::LANDED,
        // Recovered by `inject_text`'s error-abort block: the text IS somewhere the user can reach,
        // and "nothing written" would make the caller re-issue an insert landing in the same
        // place. The Wayland own-window arm answers the same.
        crate::inject::Landed::NothingWritten if recovered => InjectOutcome::DIVERTED,
        crate::inject::Landed::NothingWritten => InjectOutcome::NOT_LANDED,
        crate::inject::Landed::OnClipboard => InjectOutcome::DIVERTED,
    });
    if outcome.as_ref().is_ok_and(|o| o.diverted) {
        crate::inject::note_delivered_unless_user_cancelled(epoch);
    }
    outcome
}

/// The Wayland paste arm's gate at the clipboard write: [`sink_gate`] (probe first, cancel after)
/// with that arm's cancel term. A user cancel, or any cancel of a withheld insert, skips the write;
/// an error abort that wants recovery does not, so the write or the own-window arm's recovery keeps
/// the transcript.
fn clipboard_write_gate(
    own_window: impl FnOnce() -> bool,
    cancelled: impl FnOnce() -> bool,
    wants_recovery: impl FnOnce() -> bool,
    withhold_on_divert: bool,
) -> SinkGate {
    sink_gate(own_window, || {
        cancelled() && (!wants_recovery() || withhold_on_divert)
    })
}

/// The clipboard form of a sanitized transcript `text` (see `inject_text`'s `clipboard_text`):
/// the caller's string, sanitized exactly as `text` is, or `text` itself when there is none. Also
/// `text` when either side is empty — an empty form would make a divert write nothing while
/// reporting the transcript on the clipboard, and a bare auto-Enter (empty `text`) has no
/// transcript to put there at all, so its recovery checks must keep reading empty.
fn clipboard_form(text: &str, clipboard_text: Option<String>) -> String {
    match clipboard_text.map(|c| crate::inject::sanitize_injected(&c)) {
        Some(c) if !c.is_empty() && !text.is_empty() => c,
        _ => text.to_string(),
    }
}

/// The mid-function divert's answer (the caller asked to type or paste and we did neither).
/// Reported only when a transcript was written. A diverted bare Enter (empty text) wrote nothing
/// and pressed no Return, so it is `landed: false` like every other sink that skips one: a caller
/// clearing its owed phrase gap on a landed Enter must not see one.
fn divert_outcome(text: &str) -> InjectOutcome {
    InjectOutcome {
        landed: !text.is_empty(),
        diverted: !text.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::{clipboard_form, clipboard_write_gate, divert_outcome};
    use crate::inject::{cancel_lands_during, SinkGate};

    /// A cancel landing during the Wayland paste arm's clipboard-write own-window probe (a
    /// main-thread round trip; focus stays in the target app, so it answers false) still skips the
    /// write instead of clobbering what the user had copied.
    #[test]
    fn a_cancel_during_the_clipboard_write_probe_skips_the_write() {
        use std::cell::Cell;
        for own in [true, false] {
            let cancelled = Cell::new(false);
            let gate = clipboard_write_gate(
                cancel_lands_during(&cancelled, own),
                || cancelled.get(),
                || false, // a user cancel: no recovery wanted
                false,
            );
            assert_eq!(gate, SinkGate::Cancelled, "own={own}");
        }
        // A withheld insert has nothing to recover: any cancel skips its write.
        assert_eq!(
            clipboard_write_gate(|| false, || true, || true, true),
            SinkGate::Cancelled
        );
        // An error abort that wants recovery is not skipped here: the write keeps the transcript,
        // or the own-window arm recovers it.
        assert_eq!(
            clipboard_write_gate(|| false, || true, || true, false),
            SinkGate::Proceed
        );
        assert_eq!(
            clipboard_write_gate(|| true, || true, || true, false),
            SinkGate::OwnWindow
        );
        assert_eq!(
            clipboard_write_gate(|| true, || false, || false, false),
            SinkGate::OwnWindow
        );
    }

    /// A bare auto-Enter that reaches the divert arm (focus moved, modifiers stuck) pressed no
    /// Return: not landed, not diverted. A transcript there is on the clipboard: landed, diverted.
    #[test]
    fn a_diverted_bare_enter_reports_not_landed() {
        let enter = divert_outcome("");
        assert!(!enter.landed && !enter.diverted);
        let phrase = divert_outcome("Hallo Welt");
        assert!(phrase.landed && phrase.diverted);
    }

    /// A live phrase types behind the field's phrase gap or seam space, but every clipboard write
    /// of it (divert, recovery, clipboard-only) gets the clipboard form the caller handed over.
    #[test]
    fn the_clipboard_form_is_what_the_caller_handed_over() {
        let typed = "\n\n\nHallo Welt";
        assert_eq!(
            clipboard_form(typed, Some("Hallo Welt".into())),
            "Hallo Welt"
        );
        // Omitted (every other caller): the clipboard gets exactly what is typed.
        assert_eq!(clipboard_form(typed, None), typed);
    }

    /// Sanitized like `text`: a server-authored string cannot reach the clipboard with controls or
    /// a bidi override just because it went through the second argument.
    #[test]
    fn the_clipboard_form_is_sanitized_like_the_text() {
        assert_eq!(
            clipboard_form("a b", Some("a\u{1b}[2J\u{202e}b\r\n".into())),
            "a[2Jb\n"
        );
    }

    /// An empty form falls back to the text, and a bare auto-Enter (empty text) never gains one —
    /// the recovery and divert arms key "is there a transcript" off emptiness.
    #[test]
    fn an_empty_side_falls_back_to_the_text() {
        assert_eq!(clipboard_form("abc", Some("\u{1}".into())), "abc");
        assert_eq!(clipboard_form("abc", Some(String::new())), "abc");
        assert_eq!(clipboard_form("", Some("abc".into())), "");
    }
}
