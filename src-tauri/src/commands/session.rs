//! Live dictation sessions: streaming and record-then-transcribe start, stop and
//! cancel.

use super::{resolve_key, resolve_recordings_dir};
use crate::session::{self, RecordParams, RecordState, StartParams, StreamState};
use tauri::{AppHandle, Manager};

// The six session commands below are ASYNC + spawn_blocking, NOT bare sync fns: their bodies do
// genuinely blocking work — the keyring read (resolve_key → D-Bus), joining the previous/current
// capture thread (StreamSession/RecordSession finish + Drop), and above all cpal's device open
// (open_input), which on a Bluetooth mic stalls ~1-2s while the headset switches its profile
// (A2DP → HFP) before it can capture at all. As sync commands all of that ran on the GTK/UI
// thread — the same freeze family as the kwin/arboard gotchas — janking the whole UI on every
// BT dictation start. State is resolved inside the closure via app.state() (a State<'_> param
// can't cross into spawn_blocking); the state Mutex still serializes concurrent starts/stops.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_stream(
    app: AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    response_format: String,
    // None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    // Opaque {targets, include_original}: tells the server this session will
    // translate on a separate request, so it holds each utterance's log
    // receipt open rather than logging two unlinked halves.
    translate_expect: Option<serde_json::Value>,
    // Client-minted session id (32 hex) → handshake `client_job`; None = server-keyed.
    client_job: Option<String>,
    device_id: Option<String>,
    save: bool,
    recordings_dir: Option<String>,
    trim_silence: bool,
    // One .wav per utterance (live hands-free sessions keep one History record per utterance).
    per_utterance_clips: bool,
    mute_system: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = resolve_key(api_key, backend_id);
        let save_dir = if save {
            resolve_recordings_dir(&app, recordings_dir)
        } else {
            None
        };
        let state = app.state::<StreamState>();
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "stream state poisoned".to_string())?;
        // Stop any previous session first (Drop joins capture and aborts the WS task, no drain).
        *guard = None;
        let sess = session::start(
            app.clone(),
            StartParams {
                server_url,
                api_key: key,
                model,
                language,
                response_format,
                prompt,
                decode_overrides,
                translate_expect,
                override_profile,
                client_job,
                device_id,
                save_dir,
                trim_silence,
                per_utterance_clips,
                mute_system,
            },
        )?;
        *guard = Some(sess);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_stream(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StreamState>();
        let sess = {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "stream state poisoned".to_string())?;
            let sess = guard.take();
            // Under the lock, so a Cancel that lands before finish() reaches THIS drain.
            if let Some(s) = &sess {
                s.claim_detached();
            }
            sess
        };
        if let Some(s) = sess {
            s.finish(); // drain in the background to deliver the last utterance
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hard-ABORT the stream session: take it out and let `Drop` run (stops capture, aborts the WS task
/// WITHOUT draining, releases the system-mute guard). Unlike `stop_stream`, no flush/drain happens —
/// a cancel should discard the in-flight session, not fire wasted server work. Also the idempotent
/// teardown the frontend's `closed` handler calls to release a parked session (capture-thread death /
/// server-initiated close that never went through stop_stream): a no-op when already taken.
/// A recovery cancel (`user_initiated` with `discard_recording: false`: wake from sleep) keeps a
/// LIVE session's audio too: it `finish`es that session instead, so the drain writes the recording
/// (its events are already silenced by the epoch retire), and never claims it, so the keep is final.
#[tauri::command]
pub async fn cancel_stream(
    app: AppHandle,
    user_initiated: bool,
    discard_recording: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StreamState>();
        let sess = {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "stream state poisoned".to_string())?;
            let sess = guard.take();
            // No live session: the user's Cancel is aimed at the one still draining after a stop —
            // discard its recording, as cancel_record does for a detached batch. Not for the
            // closed-handler release, nor for a recovery cancel (stuck finalize, wake from sleep)
            // where the saved audio may be the only copy of what was said: that one RELEASES the
            // drain instead, so its keep is final and no later stray Cancel can still reach it.
            // A live session taken on any path is the newest one, so it releases the drain too.
            session::settle_detached_on_cancel(sess.is_some(), user_initiated, discard_recording);
            // Retire while the lock is held: start_stream claims its epoch under the same lock, so
            // this prevents a race where a new session claims epoch N+1, the lock drops, and THEN
            // the stale retire bumps to N+2 — silencing the new session's emissions.
            session::retire_active_epoch();
            sess
        };
        // OUTSIDE the lock — capture join, mute release, etc. Drop (not finish) for a Cancel or the
        // closed-handler release; a recovery cancel drains instead, so the live session's recording
        // is written rather than aborted with the WS task. Unclaimed, so no later Cancel reaches it.
        match sess {
            Some(s) if user_initiated && !discard_recording => s.finish(),
            sess => drop(sess),
        }

        // …and abandon any transcript still being typed out. The typing paths emit one key at a
        // time, so without this a cancel only stopped FUTURE inserts while the current one kept
        // going into whatever window had focus.
        //
        // Only when the user pressed Cancel. The one non-user caller is the frontend's `closed`
        // handler releasing a parked session (capture death / server-initiated close): that
        // session is still in state, so gating on "a session was taken" bumped the epoch exactly
        // while that session's own last phrase was being typed and cut it off. In stop-timing
        // mode the session is already gone while the transcript is typed, so the chip's ✕ must
        // abort on `user_initiated` alone — which it does.
        if user_initiated {
            crate::inject::cancel_injection();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Async + spawn_blocking for the same reasons as start_stream (keyring read, previous-session
// capture join, and the BT-profile-switch stall inside cpal's open_input).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_record(
    app: AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    // None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    recordings_dir: Option<String>,
    trim_silence: bool,
    mute_system: bool,
    standard: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = resolve_key(api_key, backend_id);
        let save_dir = if save {
            resolve_recordings_dir(&app, recordings_dir)
        } else {
            None
        };
        let state = app.state::<RecordState>();
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "record state poisoned".to_string())?;
        *guard = None;
        let sess = session::start_record(
            app.clone(),
            RecordParams {
                server_url,
                api_key: key,
                model,
                language,
                prompt,
                decode_overrides,
                override_profile,
                device_id,
                save_dir,
                trim_silence,
                mute_system,
                standard,
            },
        )?;
        *guard = Some(sess);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_record(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RecordState>();
        // Claim the detached epoch UNDER the lock. This is the stop's only publication (the
        // capture thread's device-loss salvage arm in `start_record` publishes its own epoch
        // before any stop): `finish()` must not re-publish it after its capture join (see
        // `RecordSession::finish`), and `RecordSession::claim_detached` explains why a store
        // outside the lock let a concurrent cancel disown the wrong session.
        let sess = {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "record state poisoned".to_string())?;
            let sess = guard.take();
            if let Some(s) = sess.as_ref() {
                s.claim_detached();
            }
            sess
        };
        if let Some(s) = sess {
            s.finish();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hard-ABORT the record session: take it out and stop capture WITHOUT transcribing (releases the
/// system-mute guard). A user's Cancel and the `closed` handler's idempotent release of a parked
/// session (capture death) do NOT spawn the transcribe POST — a cancel should discard the clip, not
/// fire a wasted server transcription. The one exception is a recovery cancel (below), which
/// finishes a live session whose recording is kept.
/// `discard_recording: false` (a recovery cancel: wake from sleep) leaves a transcription already
/// detached by a stop alone, so its saved `.wav` and `.txt` survive — the stream path's rule. That
/// holds for a LIVE session too when "Keep recordings" is on: it is `finish`ed, not discarded, so
/// its clip is transcribed and saved like `cancel_stream`'s drain (its events are already silenced
/// by the epoch retire), and a device-loss salvage the sleep already spawned (or one that fires
/// inside the capture join) keeps its recording. The keep is final for a salvage published before
/// the cancel; one that fires inside the join publishes its epoch after the forget, so a later
/// Cancel with no live session can still disown it. With recordings off there is nothing to keep,
/// so the live session is discarded: the live clip is not uploaded, a device-loss salvage firing
/// inside the join is stopped, and one the sleep already spawned is stopped if it has not sent its
/// POST yet (if the upload is already under way, only its result is dropped).
#[tauri::command]
pub async fn cancel_record(
    app: AppHandle,
    user_initiated: bool,
    discard_recording: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RecordState>();
        // The take AND the no-live-session decision happen under ONE lock. Reading the state and
        // then disowning outside it is the other half of the race `claim_detached` closes: this
        // command must not observe "no session" while `stop_record` is still between its own take
        // and the epoch it is about to publish.
        //
        // A cancel arriving during the "transcribing…" phase finds None here — `stop_record`
        // already took the session and `finish` detached the POST. Disown that work too: a POST
        // not yet sent is skipped, and one already in flight (the usual case by the time
        // "transcribing…" shows) has its result dropped and its .wav removed with no .txt
        // written, so nothing is left on disk after a UI that says cancelled.
        //
        // Only a user's Cancel with no live session: a live session taken on ANY path (a Cancel,
        // the closed-handler release) supersedes the earlier detached batch, which is released so
        // a later Cancel cannot disown a legitimate earlier transcription still in flight (stop A
        // → start B → cancel B → stray Cancel would have discarded A's result); the release with
        // no live session leaves it alone. A recovery cancel (`discard_recording: false`) releases
        // it too, since the saved audio may be the only copy of what was said: that keep is
        // final — released even when a live session WAS found, since its device-loss salvage may
        // already have published its epoch as the detached batch (a salvage that fires inside the
        // join below publishes after this forget, so that one stays reachable).
        let sess = {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "record state poisoned".to_string())?;
            let sess = guard.take();
            session::settle_detached_batch_on_cancel(
                sess.is_some(),
                user_initiated,
                discard_recording,
            );
            session::retire_active_epoch();
            sess
        };
        // discard() runs OUTSIDE the lock: it marks the clip discarded BEFORE Drop joins the capture
        // thread, so the device-loss salvage arm inside that join does not upload the audio or
        // write the .wav/.txt. Then Drop stops capture and releases the mute. A user's Cancel takes
        // that arm, and so does the closed-handler release (TS `cancelRecord()` defaults
        // `discard_recording` to true) — harmless there: a parked session's salvage emitted its
        // `closed` only after its .wav/.txt were written, so there is nothing left to discard.
        // A recovery cancel keeps a live session's audio when "Keep recordings" is on, so it
        // finishes it instead — the `cancel_stream` rule: the clip is transcribed and its .wav/.txt
        // written, its UI events epoch-suppressed, and it is never claimed, so no later Cancel
        // reaches it. finish() bails after the join when a device-loss salvage already took the
        // clip. A recovery cancel with nothing to keep (recordings off) discards too: a POST whose
        // every event is suppressed would only upload the clip, and that holds for a device-loss
        // salvage as well — the flag stops one firing inside the join, and the epoch mark stops
        // one the sleep already spawned before its POST, or drops its result if the upload is
        // already under way (with no save dir there is no .wav/.txt to delete).
        match sess {
            Some(s) if !discard_recording && user_initiated && s.keeps_recording() => s.finish(),
            Some(s) => s.discard(),
            None => {}
        }
        // …and abandon any transcript still being typed out. The typing paths emit one key at a
        // time, so without this a cancel only stopped FUTURE inserts while the current one kept
        // going into whatever window had focus. Only on a user-initiated cancel: the non-user
        // call is the `closed` handler releasing a parked session, whose own final/tail insert
        // must not be aborted — see `cancel_stream`.
        if user_initiated {
            crate::inject::cancel_injection();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Retire the active session epoch WITHOUT draining or aborting — for the frontend's error / fatal-
/// inject teardown, which keeps the DRAINING stop (so the .wav/.txt sidecar still gets written) but
/// must stop that detached drain's late final/closed from bleeding onto a session the user re-triggers
/// during the error linger. Mirrors the cancel-path retire (see session::retire_active_epoch).
#[tauri::command]
pub fn retire_session_epoch() {
    session::retire_active_epoch();
    // The three callers are all "the session died" paths (a server error frame, a fatal insert,
    // a rejected stop), and each one restores the user's focus and declares the session over.
    // Retiring the ACTIVE epoch only silences future EVENTS, though — a transcript already being
    // typed kept going, one key at a time, into whatever window the teardown had just refocused.
    // Abort it too. Unlike a user cancel this leaves the text on the clipboard: the user never
    // asked for it to go away, and the stop-mode path already offers the same recovery.
    crate::inject::abort_injection_for_error();
}

/// The quit handshake's reply: the main window has landed its pending writes after
/// `app://before-quit`, so the waiting exit may go ahead (see `quit::request_quit`).
#[tauri::command]
pub fn quit_ready() {
    crate::quit::signal_ready();
}
