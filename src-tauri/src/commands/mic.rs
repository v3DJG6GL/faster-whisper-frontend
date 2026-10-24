//! Microphone listing and the mic test (record, level, playback).

use crate::audio::{self, AudioState, MicPlayback, MicTestClip};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

/// The microphone picker's list. Async + spawn_blocking: it asks the sound server (≤2 s timeout)
/// and, with `include_paths`, walks ALSA's device hints — never on the UI thread.
#[tauri::command]
pub async fn list_audio_devices(
    include_paths: Option<bool>,
) -> Result<audio::device::MicInventory, String> {
    let include_paths = include_paths.unwrap_or(false);
    super::blocking(move || audio::device::list_input_devices(include_paths)).await
}

/// One-time migration of a microphone saved by display name (before pins were device ids):
/// today's `{id, label}`, or None while that mic isn't connected or the sound server doesn't serve
/// it (the name keeps working through the same lookup at dictation start, which may still take the
/// card's ALSA path, and the migration retries next launch).
#[tauri::command]
pub async fn resolve_legacy_mic(name: String) -> Result<Option<LegacyMic>, String> {
    super::blocking(move || {
        Ok(audio::device::resolve_legacy(&name, true).map(|(id, label)| LegacyMic { id, label }))
    })
    .await
}

#[derive(serde::Serialize)]
pub struct LegacyMic {
    id: String,
    label: String,
}

/// Start the mic test. Async + spawn_blocking: it waits for cpal's device open (a Bluetooth mic
/// stalls ~1-2 s switching profile) so a mic that fails to open rejects here and the Settings test
/// ends, and that wait must not sit on the UI thread. State is resolved inside the closure (a
/// State<'_> can't cross into spawn_blocking); the AudioState mutex serializes start/stop.
#[tauri::command]
pub async fn start_mic_test(app: AppHandle, device_id: Option<String>) -> Result<(), String> {
    super::blocking(move || {
        // Starting a fresh test silences any lingering replay (the bump makes the
        // playback thread see a newer generation and stop).
        app.state::<MicPlayback>().0.fetch_add(1, Ordering::SeqCst);
        let state = app.state::<AudioState>();
        let mut guard = state.0.lock().map_err(|_| "audio state poisoned")?;
        // Stop any previous capture FIRST — dropping the handle joins its thread, so its cpal
        // callback can't still be appending the old device's samples while the new capture clears +
        // re-stamps the shared clip (which would interleave two devices' audio under one rate stamp,
        // garbling the replay).
        *guard = None;
        let clip = app.state::<MicTestClip>().0.clone();
        let handle = audio::capture::start_level_meter(app.clone(), device_id, clip)?;
        *guard = Some(handle);
        Ok(())
    })
    .await
}

/// Stop the mic test and return the number of seconds captured (so the UI can
/// decide whether there's anything worth replaying). Dropping the handle joins the
/// capture thread, so the recorded clip is final by the time we read its length.
/// Async + spawn_blocking like start_mic_test: a stop that lands while a start is still waiting
/// on the device open queues on the AudioState mutex off the UI thread.
#[tauri::command]
pub async fn stop_mic_test(app: AppHandle) -> Result<f32, String> {
    super::blocking(move || {
        *app.state::<AudioState>()
            .0
            .lock()
            .map_err(|_| "audio state poisoned")? = None;
        let clip = app.state::<MicTestClip>();
        let c = clip.0.lock().map_err(|_| "mic clip poisoned")?;
        let secs = if c.sample_rate > 0 {
            c.samples.len() as f32 / c.sample_rate as f32
        } else {
            0.0
        };
        Ok(secs)
    })
    .await
}

/// Replay the most recent mic-test capture on the default output device. Returns
/// immediately; playback runs on a detached thread (like the sound cues). Any in-flight
/// replay stops first (never two at once); emits `audio://test-play-ended` when playback
/// finishes while still current. Nothing recorded yet: a no-op, with no event.
#[tauri::command]
pub fn play_mic_test(
    app: AppHandle,
    clip: State<MicTestClip>,
    playback: State<MicPlayback>,
) -> Result<(), String> {
    let (samples, sample_rate) = {
        let c = clip.0.lock().map_err(|_| "mic clip poisoned")?;
        (
            c.samples.iter().copied().collect::<Vec<f32>>(),
            c.sample_rate,
        )
    };
    if samples.is_empty() || sample_rate == 0 {
        return Ok(());
    }
    let counter = playback.0.clone();
    let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        // Play until it drains, but bail the instant a newer replay (or a new test) superseded
        // us — that newer playback owns the "ended" signal.
        let superseded = || counter.load(Ordering::SeqCst) != generation;
        if let Err(e) = audio::playback::play_mono(samples, sample_rate, superseded) {
            tracing::warn!("[audio] mic-test replay failed: {e}");
        }
        // Drained or failed (e.g. no output device): nothing of ours is sounding, so signal "ended" if
        // still current — on a failure too, or the button sits on "Stop" until the frontend's
        // duration fallback fires.
        if counter.load(Ordering::SeqCst) == generation {
            let _ = app.emit("audio://test-play-ended", ());
        }
    });
    Ok(())
}

/// Stop an in-flight mic-test replay (no-op if nothing is playing): bump the playback generation
/// so the playing thread sees it's superseded and stops. Does NOT start a new playback.
#[tauri::command]
pub fn stop_mic_test_playback(playback: State<MicPlayback>) {
    playback.0.fetch_add(1, Ordering::SeqCst);
}
