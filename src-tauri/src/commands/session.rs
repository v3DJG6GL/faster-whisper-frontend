//! Live dictation sessions: streaming and record-then-transcribe start, stop and
//! cancel.

use super::{resolve_key, resolve_recordings_dir};
use crate::session::{self, RecordParams, RecordState, StartParams, StreamState};
use tauri::{AppHandle, Manager};

// The six session commands below are ASYNC + spawn_blocking so their blocking work stays off the
// GTK/UI thread: the keyring read (resolve_key → D-Bus), joining the previous/current capture
// thread (finish + Drop), and above all cpal's open_input, which on a Bluetooth mic stalls ~1-2s
// while the headset switches profile (A2DP → HFP). State is resolved inside the closure via
// app.state() (a State<'_> param can't cross into spawn_blocking); the state Mutex still
// serializes concurrent starts/stops.
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
/// LIVE session's audio too when "Keep recordings" is on: it `finish`es that session instead, so
/// the drain writes the recording (its events are already silenced by the epoch retire), and never
/// claims it, so the keep is final. With recordings off there is nothing to keep, so it aborts the
/// session like a Cancel: a drain would only make the server decode a phrase nobody sees.
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
        // OUTSIDE the lock — capture join, mute release, etc. A recovery cancel that keeps
        // recordings drains (unclaimed) instead of aborting; see the doc above.
        match sess {
            Some(s) if user_initiated && !discard_recording && s.keeps_recording() => s.finish(),
            sess => drop(sess),
        }

        // …and abandon any transcript still being typed out. The typing paths emit one key at a
        // time, so without this a cancel only stopped FUTURE inserts while the current one kept
        // going into whatever window had focus.
        //
        // Gated on `user_initiated`, not on "a session was taken": the one non-user caller, the
        // `closed` handler releasing a parked session, must not cut off that session's own last
        // phrase, and in stop-timing mode the session is already gone while its transcript is
        // typed, so the chip's ✕ must still abort it.
        if user_initiated {
            crate::inject::cancel_injection();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

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
        // capture thread's device-loss salvage arm in `start_record` publishes the same epoch on
        // its own: usually before any stop, but one firing inside `finish()`'s capture join
        // stores it after this claim and outside the lock; see `cancel_record`): `finish()` must
        // not re-publish it after its capture join (see `RecordSession::finish`), and
        // `RecordSession::claim_detached` explains why a store outside the lock let a concurrent
        // cancel disown the wrong session.
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
        // A recovery cancel that keeps recordings finishes the live session instead, unclaimed
        // (see the doc); finish() bails after the join when a device-loss salvage already took the
        // clip. With recordings off it discards too: a POST whose every event is suppressed would
        // only upload the clip.
        match sess {
            Some(s) if !discard_recording && user_initiated && s.keeps_recording() => s.finish(),
            Some(s) => s.discard(),
            None => {}
        }
        // …and abandon any transcript still being typed out — only on a user-initiated cancel, so
        // the `closed` handler's release never aborts its session's own final insert (see
        // `cancel_stream`).
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
    // The three callers are "the session died" paths (a server error frame, a fatal insert, a
    // rejected stop) that refocus the user's window. Retiring the epoch only silences future
    // EVENTS, so a transcript still being typed would keep going into that window: abort it too.
    // Unlike a user cancel this leaves the text on the clipboard: the user never asked for it to
    // go away, and the stop-mode path already offers the same recovery.
    crate::inject::abort_injection_for_error();
}

/// The quit handshake's reply: the main window has landed its pending writes after
/// `app://before-quit`, so the waiting exit may go ahead (see `quit::request_quit`).
#[tauri::command]
pub fn quit_ready() {
    crate::quit::signal_ready();
}
