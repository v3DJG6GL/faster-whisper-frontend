//! Streaming dictation session: microphone capture → resample → WebSocket,
//! surfacing transcript events to the UI.
//!
//! The `cpal::Stream` lives on a dedicated capture thread (it is `!Send`) and
//! forwards mono f32 chunks over a channel to an async WS task. Levels are
//! emitted as `stream://level`; transcripts as `stream://partial`/`final`;
//! state as `stream://status`. Dropping a [`StreamSession`] stops everything.

use crate::audio::resample::Resampler16k;
use crate::transport::batch;
use crate::transport::stream::{self, StreamEvent, StreamParams};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig, StreamError};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::path::PathBuf;
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

/// Monotonic dictation-session epoch. Each new streaming/record session claims the next value
/// (which thereby becomes the "active" one). A session emits `stream://*` transcript/status
/// events ONLY while it is still the active epoch. This matters because a stopped session keeps
/// running in the BACKGROUND after the foreground returns: `StreamSession::finish` detaches the
/// WS task to drain the last utterance, and the batch path spawns its transcribe POST — both
/// emit `final`/`closed` later. The events are global and carry no session id, so without this
/// gate a session that was CANCELLED (cancelLive, e.g. on suspend/resume or an impatient
/// stop-then-restart) could, once a NEW session starts, inject its leftover transcript into the
/// new target and kill the new session's focus poll. Gating at the emit (not the listener) means
/// the moment a newer session claims the epoch, the older one's late drain goes silent.
/// (Level emits don't need this: the capture thread is always joined before the next session
/// starts, so they can't outlive their session.)
static ACTIVE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Claim the next epoch for a starting session (also makes it the active one).
fn next_session_epoch() -> u64 {
    ACTIVE_EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

/// Emit a `stream://*` event only if `epoch` is still the active session (see [`ACTIVE_EPOCH`]).
fn emit_if_active<S: Serialize + Clone>(app: &AppHandle, epoch: u64, event: &str, payload: S) {
    if ACTIVE_EPOCH.load(Ordering::SeqCst) == epoch {
        let _ = app.emit(event, payload);
    }
}

#[derive(Default)]
pub struct StreamState(pub Mutex<Option<StreamSession>>);

/// Tear down any in-flight dictation on app exit. Dropping the session aborts capture and —
/// critically — runs `SystemMuteGuard::drop`, restoring the user's audio if a `mute_system`
/// session was live. The tray "Quit" calls `AppHandle::exit`, which ends the process WITHOUT
/// running destructors for managed state, so without this an explicit quit mid-dictation would
/// strand the system muted. Takes the session out under the lock, then drops it outside (matches
/// `stop_stream`/`stop_record`, so the capture-thread join doesn't run while the state is locked).
pub fn cleanup_for_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<StreamState>() {
        let sess = state.0.lock().ok().and_then(|mut g| g.take());
        drop(sess);
    }
    if let Some(state) = app.try_state::<RecordState>() {
        let sess = state.0.lock().ok().and_then(|mut g| g.take());
        drop(sess);
    }
}

pub struct StartParams {
    pub server_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub language: String,
    pub response_format: String,
    /// None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    pub prompt: Option<String>,
    /// Per-request decode overrides (opaque JSON object) forwarded to the backend.
    pub decode_overrides: Option<serde_json::Value>,
    /// Server override-profile name forwarded to the backend (None/empty = none).
    pub override_profile: Option<String>,
    pub device_id: Option<String>,
    pub save_dir: Option<PathBuf>,
    pub trim_silence: bool,
    pub mute_system: bool,
}

pub struct StreamSession {
    capture_stop: Arc<AtomicBool>,
    capture_join: Option<JoinHandle<()>>,
    ws_stop: watch::Sender<bool>,
    ws_task: Option<tauri::async_runtime::JoinHandle<()>>,
    // Unmutes system audio on drop (after the Drop body below runs).
    _mute: SystemMuteGuard,
}

impl StreamSession {
    /// User-requested stop: stop capture, then let the WS task drain (flush + stop
    /// + final) in the background so the last utterance is still delivered. Takes
    /// the task out first so the `Drop` below won't abort it.
    pub fn finish(mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        let _ = self.ws_stop.send(true);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        drop(self.ws_task.take()); // detach → drains to completion on its own
        tracing::info!("[stream] session finished (draining)");
    }
}

impl Drop for StreamSession {
    fn drop(&mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        let _ = self.ws_stop.send(true);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        // Abort the WS task immediately (no drain). This path runs when a session
        // is REPLACED by a new one; draining a stale session would keep emitting
        // finals/closed and spam the UI. The explicit-stop path (`finish`) drains.
        if let Some(task) = self.ws_task.take() {
            task.abort();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartialPayload {
    committed: String,
    pending: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalPayload {
    committed: String,
    tail: String,
    last: bool,
}

pub fn start(app: AppHandle, p: StartParams) -> Result<StreamSession, String> {
    let (device, format, channels, config, in_rate) = open_input(p.device_id)?;
    let mute = SystemMuteGuard::new(p.mute_system);
    let epoch = next_session_epoch();

    let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (ws_stop_tx, ws_stop_rx) = watch::channel(false);
    let level = Arc::new(AtomicU32::new(0));
    let capture_stop = Arc::new(AtomicBool::new(false));

    let capture_join = spawn_capture(
        app.clone(),
        device,
        format,
        channels,
        config,
        pcm_tx,
        level,
        capture_stop.clone(),
    )?;

    let params = StreamParams {
        ws_url: stream::http_to_ws(&p.server_url),
        model: p.model,
        language: p.language,
        response_format: p.response_format,
        prompt: p.prompt,
        decode_overrides: p.decode_overrides,
        override_profile: p.override_profile,
        api_key: p.api_key,
        in_rate,
        save_dir: p.save_dir,
        trim_silence: p.trim_silence,
    };

    let appc = app.clone();
    // This closure runs on the WS task, which `finish()` DETACHES to drain in the background —
    // so it can fire after the session is gone. Gate every emit on `epoch` so a superseded/
    // cancelled session's late drain can't bleed into the next one (see ACTIVE_EPOCH).
    let on_event = move |ev: StreamEvent| match ev {
        StreamEvent::Ready { overrides_ignored } => {
            emit_if_active(&appc, epoch, "stream://status", "ready");
            if !overrides_ignored.is_empty() {
                emit_if_active(&appc, epoch, "stream://overrides-ignored", overrides_ignored);
            }
        }
        StreamEvent::Partial { committed, pending } => {
            emit_if_active(&appc, epoch, "stream://partial", PartialPayload { committed, pending });
        }
        StreamEvent::Final { committed, tail, last } => {
            tracing::info!(
                "[stream] final committed={} tail={} last={}",
                committed.len(),
                tail.len(),
                last
            );
            emit_if_active(&appc, epoch, "stream://final", FinalPayload { committed, tail, last });
        }
        StreamEvent::Boundary { separator } => {
            tracing::info!("[stream] boundary (hard break)");
            emit_if_active(&appc, epoch, "stream://boundary", separator);
        }
        StreamEvent::Error(m) => {
            emit_if_active(&appc, epoch, "stream://error", m);
        }
        StreamEvent::Closed => {
            emit_if_active(&appc, epoch, "stream://status", "closed");
        }
    };

    let ws_task = tauri::async_runtime::spawn(async move {
        stream::run(params, pcm_rx, ws_stop_rx, on_event).await;
    });

    Ok(StreamSession {
        capture_stop,
        capture_join: Some(capture_join),
        ws_stop: ws_stop_tx,
        ws_task: Some(ws_task),
        _mute: mute,
    })
}

fn open_input(
    device_id: Option<String>,
) -> Result<(Device, SampleFormat, usize, StreamConfig, u32), String> {
    let host = cpal::default_host();
    let device = match device_id {
        Some(id) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == id).unwrap_or(false))
            .ok_or_else(|| format!("input device not found: {id}"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| "no default input device".to_string())?,
    };
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    Ok((
        device.clone(),
        supported.sample_format(),
        supported.channels() as usize,
        supported.config(),
        supported.sample_rate().0,
    ))
}

/// Build a cpal stream error callback that signals `stop` on a TERMINAL device error. A mid-session
/// device disconnect surfaces as StreamError::DeviceNotAvailable and then no more data callbacks
/// fire — without this the capture thread stays blocked in publish_levels (loops until stop), its
/// pcm sender never drops, and the session wedges at "listening" with a frozen meter until the user
/// cancels. Tripping stop unblocks it so the channel closes and the session drains to Closed (the
/// same teardown a user stop triggers). A transient BackendSpecific glitch is recoverable, so it is
/// logged but does NOT stop the session.
fn err_cb_with_stop(stop: Arc<AtomicBool>) -> impl FnMut(StreamError) + Send + 'static {
    move |e| {
        if matches!(e, StreamError::DeviceNotAvailable) {
            stop.store(true, Ordering::SeqCst);
        }
        tracing::warn!("[stream] device error: {e}");
    }
}

/// Like `err_cb_with_stop`, but also records that the stop was caused by a TERMINAL device loss (vs a
/// user/finish stop). The record/batch path has no channel-close teardown like the streaming path, so
/// it inspects this flag after capture returns to emit a recovery "closed" ONLY on a real disconnect —
/// never on a normal stop (which would settle the chip before the final transcript lands).
fn err_cb_with_lost(
    stop: Arc<AtomicBool>,
    device_lost: Arc<AtomicBool>,
) -> impl FnMut(StreamError) + Send + 'static {
    move |e| {
        if matches!(e, StreamError::DeviceNotAvailable) {
            device_lost.store(true, Ordering::SeqCst);
            stop.store(true, Ordering::SeqCst);
        }
        tracing::warn!("[stream] device error: {e}");
    }
}

fn downmix<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
    let mut out = Vec::new();
    downmix_into(data, channels, to_f32, &mut out);
    out
}

/// Downmix to mono into a caller-owned scratch buffer (cleared first), so a per-buffer capture
/// callback can reuse one `Vec` instead of allocating every ~10-20 ms. Mirrors `capture::analyze`.
fn downmix_into<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32, out: &mut Vec<f32>) {
    out.clear();
    if channels <= 1 {
        out.extend(data.iter().map(|&s| to_f32(s)));
        return;
    }
    out.reserve(data.len() / channels + 1);
    for frame in data.chunks(channels) {
        let mut acc = 0.0;
        for &s in frame {
            acc += to_f32(s);
        }
        out.push(acc / frame.len() as f32);
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// One EMA step of the level meter (chip_level gain + clamp, 0.7/0.3 smoothing) — mirrors the
/// capture meter. Centralized so the coefficients stay in one place across both capture
/// loops' per-sample-format arms (they were copied verbatim 6×).
fn smooth(prev: f32, mono: &[f32]) -> f32 {
    prev * 0.7 + crate::audio::chip_level(rms(mono)) * 0.3
}

#[allow(clippy::too_many_arguments)]
fn spawn_capture(
    app: AppHandle,
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    pcm_tx: mpsc::UnboundedSender<Vec<f32>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    std::thread::Builder::new()
        .name("stream-capture".into())
        .spawn(move || {
            if let Err(e) = run_capture(&app, device, format, channels, config, pcm_tx, level, stop) {
                tracing::warn!("[stream] capture: {e}");
            }
        })
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn run_capture(
    app: &AppHandle,
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    pcm_tx: mpsc::UnboundedSender<Vec<f32>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let stream = match format {
        SampleFormat::F32 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let mono = downmix(data, channels, |s| s);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        SampleFormat::I16 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let mono = downmix(data, channels, |s| s as f32 / 32768.0);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        SampleFormat::U16 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let mono = downmix(data, channels, |s| (s as f32 - 32768.0) / 32768.0);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;

    crate::audio::publish_levels(app, "stream://level", &level, &stop);
    // `stream` (and the cloned sender) drop here, ending capture and the channel.
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Batch-mode dictation: record to a buffer, transcribe the whole clip on stop.
// Emits the same stream:// events the UI already handles (level, then final +
// closed after the POST).
// ─────────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct RecordState(pub Mutex<Option<RecordSession>>);

#[derive(Clone)]
pub struct RecordParams {
    pub server_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub language: String,
    /// None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    pub prompt: Option<String>,
    /// Per-request decode overrides (opaque JSON object) forwarded to the backend.
    pub decode_overrides: Option<serde_json::Value>,
    /// Server override-profile name forwarded to the backend (None/empty = none).
    pub override_profile: Option<String>,
    pub device_id: Option<String>,
    pub save_dir: Option<PathBuf>,
    /// When saving: keep only the spoken spans (drop silence) in the `.wav`, matching the
    /// streaming save path. Affects ONLY the saved file, never what's sent for transcription.
    pub trim_silence: bool,
    pub mute_system: bool,
}

pub struct RecordSession {
    app: AppHandle,
    epoch: u64,
    params: RecordParams,
    buffer: Arc<Mutex<Vec<u8>>>,
    capture_stop: Arc<AtomicBool>,
    capture_join: Option<JoinHandle<()>>,
    _mute: SystemMuteGuard,
}

impl Drop for RecordSession {
    fn drop(&mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
    }
}

impl RecordSession {
    /// Stop recording and transcribe the captured clip in the background.
    pub fn finish(mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        let pcm = self
            .buffer
            .lock()
            .map(|mut b| std::mem::take(&mut *b))
            .unwrap_or_default();
        let app = self.app.clone();
        let epoch = self.epoch;
        let params = self.params.clone();
        tauri::async_runtime::spawn(async move {
            transcribe_recording(app, epoch, params, pcm).await;
        });
    }
}

pub fn start_record(app: AppHandle, p: RecordParams) -> Result<RecordSession, String> {
    let (device, format, channels, config, in_rate) = open_input(p.device_id.clone())?;
    let mute = SystemMuteGuard::new(p.mute_system);
    let epoch = next_session_epoch();
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let level = Arc::new(AtomicU32::new(0));
    let capture_stop = Arc::new(AtomicBool::new(false));
    // Set by the capture err_cb on a TERMINAL device loss (vs a user/finish stop), so the post-capture
    // arm below can emit a recovery "closed" only on a real disconnect.
    let device_lost = Arc::new(AtomicBool::new(false));

    let capture_join = {
        let app = app.clone();
        let buffer = buffer.clone();
        let level = level.clone();
        let stop = capture_stop.clone();
        let device_lost = device_lost.clone();
        std::thread::Builder::new()
            .name("record-capture".into())
            .spawn(move || {
                match run_record_capture(
                    &app, device, format, channels, config, in_rate, buffer, level, stop,
                    device_lost.clone(),
                ) {
                    Err(e) => {
                        tracing::warn!("[record] capture: {e}");
                        // Parity with the streaming path: there, a capture failure drops pcm_tx,
                        // closes the channel, and drives a StreamEvent::Closed → "stream://status:
                        // closed", so the chip settles back to idle. The batch path has no such
                        // channel loop, so without this the chip strands on "listening" over a dead
                        // mic with no error and no recovery but a manual cancel. Emit the same close
                        // (committedDoc is empty pre-transcription, so the frontend just returns to
                        // idle, exactly as the streaming path does).
                        emit_if_active(&app, epoch, "stream://status", "closed");
                    }
                    // A mid-capture device disconnect trips `stop` like a normal stop and returns Ok,
                    // but with `device_lost` set. The streaming path settles via its channel close;
                    // the batch path has none, so emit the same "closed" here to unstick the chip.
                    // finish() (the user stop) never sets `device_lost`, so its final still lands.
                    Ok(()) if device_lost.load(Ordering::SeqCst) => {
                        emit_if_active(&app, epoch, "stream://status", "closed");
                    }
                    Ok(()) => {}
                }
            })
            .map_err(|e| e.to_string())?
    };

    Ok(RecordSession {
        app,
        epoch,
        params: p,
        buffer,
        capture_stop,
        capture_join: Some(capture_join),
        _mute: mute,
    })
}

async fn transcribe_recording(app: AppHandle, epoch: u64, params: RecordParams, pcm: Vec<u8>) {
    // Save the captured clip FIRST, regardless of length — exactly as the streaming save path
    // does (it saves any non-empty buffer, with no minimum-duration gate). Whether a too-short
    // recording is worth keeping is the BACKEND's call (CAPTURE_RECORDINGS_MIN_DURATION_SEC),
    // not ours, so "Save recordings" produces the same files on a streaming and a batch backend.
    // "Trim silence" affects ONLY the saved file — the full clip is still sent for transcription
    // below — and trim_silence_16k can reduce an all-silence clip to nothing, which save_recording
    // skips (empty buffer).
    let saved_path = params.save_dir.as_ref().and_then(|dir| {
        if params.trim_silence {
            crate::audio::save_recording(dir, &crate::audio::trim_silence_16k(&pcm), 16_000)
        } else {
            crate::audio::save_recording(dir, &pcm, 16_000)
        }
    });
    if pcm.is_empty() {
        // Nothing captured at all (an instant tap / misfire) — there's no audio to transcribe, and
        // the streaming path likewise closes an empty session without sending anything. We do NOT
        // gate on a minimum DURATION here: any actual audio, however short, is sent so the BACKEND
        // decides whether it's worth transcribing (its CAPTURE_RECORDINGS_MIN_DURATION_SEC etc.) —
        // keeping batch and streaming identical.
        emit_if_active(&app, epoch, "stream://status", "closed");
        return;
    }
    let wav = crate::audio::wav_from_pcm16(&pcm, 16_000);
    match batch::transcribe_wav_bytes(
        &params.server_url,
        params.api_key.as_deref(),
        &params.model,
        &params.language,
        params.prompt.as_deref(),
        params.decode_overrides.as_ref(),
        params.override_profile.as_deref(),
        wav,
    )
    .await
    {
        Ok(res) => {
            // Label the saved recording with its transcript (sibling .txt), same as streaming.
            if let Some(p) = &saved_path {
                crate::audio::save_transcript_sidecar(p, &res.text);
            }
            // Surface server-locked decode overrides the same way the streaming path's
            // `ready` frame does. The batch POST hands the same list back in its result,
            // but it was being dropped here — so on a batch backend a locked override was
            // silently ignored with no "Server ignored N override(s)" notice on Home/chip.
            if !res.overrides_ignored.is_empty() {
                emit_if_active(&app, epoch, "stream://overrides-ignored", res.overrides_ignored);
            }
            emit_if_active(
                &app,
                epoch,
                "stream://final",
                FinalPayload {
                    committed: res.text,
                    tail: String::new(),
                    last: true,
                },
            );
            emit_if_active(&app, epoch, "stream://status", "closed");
        }
        Err(e) => {
            emit_if_active(&app, epoch, "stream://error", format!("Transcription failed: {e}"));
            emit_if_active(&app, epoch, "stream://status", "closed");
        }
    }
}

// ── System-audio mute guard ─────────────────────────────────────────────────
// Optionally silences OTHER apps' audio for the duration of a dictation, so playback /
// notification sounds don't leak into the mic — while leaving OUR OWN start/stop cues audible.
// Per-app: snapshot the playback streams (PulseAudio / PipeWire sink-inputs) at session start and
// mute every one that isn't ours (matched by PID) and isn't already muted, restoring exactly those
// on drop. There's no mid-session watcher, so audio that STARTS after dictation begins isn't muted.
// Falls back to muting the whole default sink when pactl can't enumerate streams (no PulseAudio /
// pipewire-pulse); a no-op where neither exists (e.g. Windows). A hard crash mid-dictation can
// leave streams muted until the next dictation restores them.

/// What the guard did, so Drop undoes exactly that.
enum MuteMode {
    None,
    /// Per-app: the sink-input ids WE muted (others' playback). Unmute these on drop.
    PerApp(Vec<u32>),
    /// Fallback: the whole default sink was muted; restore its prior mute state on drop.
    WholeSink(bool),
}

enum MuteCmd {
    Mute,
    Unmute,
}

/// Apply the system mute (per-app, falling back to whole-sink) and return the mode to restore later.
fn apply_mute() -> MuteMode {
    // Prefer per-app muting so our own cues stay audible; fall back to the whole-sink mute only
    // when pactl can't enumerate streams.
    if let Some(muted) = mute_other_streams() {
        return MuteMode::PerApp(muted);
    }
    let prior = get_system_mute().unwrap_or(false);
    set_system_mute(true);
    MuteMode::WholeSink(prior)
}

fn restore_mute(mode: &MuteMode) {
    match mode {
        MuteMode::None => {}
        MuteMode::PerApp(ids) => {
            for &id in ids {
                set_sink_input_mute(id, false);
            }
        }
        MuteMode::WholeSink(prior) => set_system_mute(*prior),
    }
}

/// A single worker thread that runs the (blocking) pactl/wpctl mute shell-outs OFF the UI thread.
/// SystemMuteGuard::new / Drop only SEND a Mute / Unmute message — they never block — because they
/// run inside the SYNC Tauri commands start_stream / start_record, which execute on the GTK/UI
/// thread: a wedged PulseAudio/PipeWire socket would otherwise freeze the whole app (overlay.rs
/// makes the same off-thread move for its KWin shell-outs). Processing in FIFO order also means a
/// session's Unmute always runs before the next session's Mute, so the per-app muted set can't race.
fn mute_worker() -> &'static std::sync::mpsc::Sender<MuteCmd> {
    static WORKER: OnceLock<std::sync::mpsc::Sender<MuteCmd>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<MuteCmd>();
        std::thread::spawn(move || {
            let mut mode = MuteMode::None;
            while let Ok(cmd) = rx.recv() {
                // Always restore what we last muted before applying the next command, so the worker
                // is self-correcting and never leaves an unmatched mute behind.
                restore_mute(&mode);
                mode = match cmd {
                    MuteCmd::Mute => apply_mute(),
                    MuteCmd::Unmute => MuteMode::None,
                };
            }
        });
        tx
    })
}

struct SystemMuteGuard {
    active: bool,
}

impl SystemMuteGuard {
    fn new(enabled: bool) -> Self {
        if enabled {
            // Non-blocking: the worker thread does the blocking pactl/wpctl work off the UI thread.
            let _ = mute_worker().send(MuteCmd::Mute);
        }
        Self { active: enabled }
    }
}

impl Drop for SystemMuteGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = mute_worker().send(MuteCmd::Unmute);
        }
    }
}

/// Parse `pactl list sink-inputs` output → the ids of streams to MUTE: every block that is neither
/// ours (`application.process.id` == our PID, so our cues stay audible) nor already muted (so we
/// never restore something the user muted). Pure (no IO) for testability.
fn streams_to_mute(text: &str, our_pid: u32) -> Vec<u32> {
    // Each block: (sink-input id, already-muted, owner pid).
    let mut blocks: Vec<(u32, bool, Option<u32>)> = Vec::new();
    let mut cur: Option<(u32, bool, Option<u32>)> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Sink Input #") {
            blocks.extend(cur.take());
            cur = rest.trim().parse::<u32>().ok().map(|id| (id, false, None));
        } else if let Some(b) = cur.as_mut() {
            if let Some(rest) = t.strip_prefix("Mute:") {
                b.1 = rest.trim().eq_ignore_ascii_case("yes");
            } else if let Some(rest) = t.strip_prefix("application.process.id = ") {
                b.2 = rest.trim().trim_matches('"').parse::<u32>().ok();
            }
        }
    }
    blocks.extend(cur);
    blocks
        .into_iter()
        .filter(|&(_, already_muted, pid)| !already_muted && pid != Some(our_pid))
        .map(|(id, _, _)| id)
        .collect()
}

/// Mute every other app's playback stream (see streams_to_mute); returns the ids muted (to restore
/// on drop), or None when pactl is unavailable so the caller falls back to a whole-sink mute.
fn mute_other_streams() -> Option<Vec<u32>> {
    // LC_ALL=C: pactl localizes the labels we parse ("Sink Input #", "Mute:", "yes"/"no"), so on a
    // non-English desktop the parse would find nothing → Some(vec![]) → no whole-sink fallback →
    // muting silently does nothing. Force the C locale so the parse is language-independent.
    let out = std::process::Command::new("pactl")
        .args(["list", "sink-inputs"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let ids = streams_to_mute(&String::from_utf8_lossy(&out.stdout), std::process::id());
    for &id in &ids {
        set_sink_input_mute(id, true);
    }
    Some(ids)
}

fn set_sink_input_mute(id: u32, mute: bool) {
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-input-mute", &id.to_string(), if mute { "1" } else { "0" }])
        .status();
}

/// Current mute state of the default sink: PipeWire (`wpctl get-volume` → "[MUTED]") first, then
/// PulseAudio (`pactl get-sink-mute` → "Mute: yes"). The fallback MUST mirror set_system_mute's
/// wpctl→pactl fallback: on a PulseAudio-only host wpctl is absent, so a wpctl-only read returns
/// None → the guard records "unmuted" and then wrongly UN-mutes a user who began muted on drop.
fn get_system_mute() -> Option<bool> {
    if let Ok(out) = std::process::Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SINK@"])
        .env("LC_ALL", "C")
        .output()
    {
        if out.status.success() {
            return Some(String::from_utf8_lossy(&out.stdout).contains("[MUTED]"));
        }
    }
    let out = std::process::Command::new("pactl")
        .args(["get-sink-mute", "@DEFAULT_SINK@"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_lowercase().contains("yes"))
}

fn set_system_mute(mute: bool) {
    let v = if mute { "1" } else { "0" };
    let ok = std::process::Command::new("wpctl")
        .args(["set-mute", "@DEFAULT_AUDIO_SINK@", v])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        let _ = std::process::Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", v])
            .status();
    }
}

#[allow(clippy::too_many_arguments)]
fn run_record_capture(
    app: &AppHandle,
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    in_rate: u32,
    buffer: Arc<Mutex<Vec<u8>>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    device_lost: Arc<AtomicBool>,
) -> Result<(), String> {
    // One resampler, shared with the `move` capture closure via Arc<Mutex>, so we can flush its
    // buffered tail after capture stops (the closure owns nothing else we could reach).
    let resampler = Arc::new(Mutex::new(Resampler16k::new(in_rate).map_err(|e| e.to_string())?));
    let stream = match format {
        SampleFormat::F32 => {
            let buf = buffer.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    downmix_into(data, channels, |s| s, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let bytes = resampler.lock().map(|mut r| r.push(&mono)).unwrap_or_default();
                    if !bytes.is_empty() {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&bytes);
                        }
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        SampleFormat::I16 => {
            let buf = buffer.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    downmix_into(data, channels, |s| s as f32 / 32768.0, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let bytes = resampler.lock().map(|mut r| r.push(&mono)).unwrap_or_default();
                    if !bytes.is_empty() {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&bytes);
                        }
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        SampleFormat::U16 => {
            let buf = buffer.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    downmix_into(data, channels, |s| (s as f32 - 32768.0) / 32768.0, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let bytes = resampler.lock().map(|mut r| r.push(&mono)).unwrap_or_default();
                    if !bytes.is_empty() {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&bytes);
                        }
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    crate::audio::publish_levels(app, "stream://level", &level, &stop);
    // Stop capture (drop the stream → no more callbacks), then flush the resampler's buffered tail
    // (< one input block — ~21 ms at 48 kHz) into the recording so the final sliver isn't dropped.
    drop(stream);
    if let Ok(mut r) = resampler.lock() {
        let tail = r.flush();
        if !tail.is_empty() {
            if let Ok(mut b) = buffer.lock() {
                b.extend_from_slice(&tail);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::streams_to_mute;

    // A trimmed `pactl list sink-inputs` with three streams: a normal other-app stream, one the
    // user already muted, and our own (matched by PID).
    const SAMPLE: &str = "Sink Input #10\n\
\tCorked: no\n\
\tMute: no\n\
\tProperties:\n\
\t\tapplication.name = \"Firefox\"\n\
\t\tapplication.process.id = \"100\"\n\
Sink Input #11\n\
\tMute: yes\n\
\t\tapplication.process.id = \"200\"\n\
Sink Input #12\n\
\tMute: no\n\
\t\tapplication.process.id = \"999\"\n";

    #[test]
    fn mutes_others_but_skips_ours_and_already_muted() {
        // our pid = 999 → skip #12 (ours) + #11 (already muted) → only #10 gets muted.
        assert_eq!(streams_to_mute(SAMPLE, 999), vec![10]);
    }

    #[test]
    fn empty_or_garbage_input_mutes_nothing() {
        assert!(streams_to_mute("", 1).is_empty());
        assert!(streams_to_mute("no sink inputs here\nSink Input #notanumber\n", 1).is_empty());
    }
}
