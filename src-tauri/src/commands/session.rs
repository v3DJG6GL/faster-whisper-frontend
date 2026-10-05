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
        *guard = None; // stop any previous session first (Drop joins capture, drains WS)
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
        let sess = state
            .0
            .lock()
            .map_err(|_| "stream state poisoned".to_string())?
            .take();
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
#[tauri::command]
pub async fn cancel_stream(app: AppHandle, user_initiated: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StreamState>();
        let (sess, had_session) = {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "stream state poisoned".to_string())?;
            let sess = guard.take();
            let had = sess.is_some();
            // Retire while the lock is held: start_stream claims its epoch under the same lock, so
            // this prevents a race where a new session claims epoch N+1, the lock drops, and THEN
            // the stale retire bumps to N+2 — silencing the new session's emissions.
            session::retire_active_epoch();
            (sess, had)
        };
        drop(sess); // Drop (not finish) runs OUTSIDE the lock — capture join, mute release, etc.
                    // …and abandon any transcript still being typed out. The typing paths emit one key at a
                    // time, so without this a cancel only stopped FUTURE inserts while the current one kept
                    // going into whatever window had focus.
                    //
                    // When a session was actually taken, OR the user pressed Cancel. The frontend
                    // fire-and-forgets a (non-user) cancel on every normal close, and that no-op call used to
                    // bump the counter too — harmless only because the injection captured its epoch so late
                    // that the bump always landed first. Now that the capture is at the top of `inject_text`,
                    // an unconditional bump here would abort the legitimate end-of-session insert queued
                    // moments later. But in stop-timing mode the session is ALREADY gone while the transcript
                    // is being typed, so `had_session` alone made the chip's ✕ a no-op during "inserting…" —
                    // the one phase where a cancel matters most. `user_initiated` tells the two apart.
        if had_session || user_initiated {
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
        // Claim the detached epoch UNDER the lock. `finish()` publishes it too, but only after
        // joining the capture thread — see `RecordSession::claim_detached` for why that gap let a
        // concurrent cancel disown the wrong session (or none at all).
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

/// Hard-ABORT the record session: take it out and let `Drop` run (stops capture + joins WITHOUT
/// transcribing, releases the system-mute guard). Unlike `stop_record`, it does NOT spawn the
/// transcribe POST — a cancel should discard the clip, not fire a wasted server transcription. Also
/// the idempotent teardown the `closed` handler calls to release a parked session on capture death.
#[tauri::command]
pub async fn cancel_record(app: AppHandle, user_initiated: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RecordState>();
        // The take AND the no-live-session decision happen under ONE lock. Reading the state and
        // then disowning outside it is the other half of the race `claim_detached` closes: this
        // command must not observe "no session" while `stop_record` is still between its own take
        // and the epoch it is about to publish.
        //
        // A cancel arriving during the "transcribing…" phase finds None here — `stop_record`
        // already took the session and `finish` detached the POST. Disown that work too, so the
        // audio is not uploaded and neither the .wav nor its verbatim .txt is left on disk after
        // a UI that says cancelled.
        //
        // Only when there was no live session: a cancel that DID find one is aimed at that
        // session, and disowning here would instead kill a legitimate earlier transcription that
        // is still in flight (stop A → start B → cancel B would have discarded A's result).
        let (sess, had_session) = {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "record state poisoned".to_string())?;
            let sess = guard.take();
            let had_session = sess.is_some();
            if !had_session {
                session::cancel_detached_batch();
            }
            session::retire_active_epoch();
            (sess, had_session)
        };
        // discard() (not finish, not a bare drop) runs OUTSIDE the lock: it marks the clip discarded
        // BEFORE Drop joins the capture thread, so the device-loss salvage arm inside that join does
        // not upload the audio or write the .wav/.txt. Then Drop stops capture and releases the mute.
        if let Some(s) = sess {
            s.discard();
        }
        // …and abandon any transcript still being typed out. The typing paths emit one key at a
        // time, so without this a cancel only stopped FUTURE inserts while the current one kept
        // going into whatever window had focus. Gated on a real session OR a user-initiated
        // cancel, for the reasons the streaming twin gives — see `cancel_stream`.
        if had_session || user_initiated {
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
