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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};

#[derive(Default)]
pub struct StreamState(pub Mutex<Option<StreamSession>>);

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
    let on_event = move |ev: StreamEvent| match ev {
        StreamEvent::Ready { overrides_ignored } => {
            let _ = appc.emit("stream://status", "ready");
            if !overrides_ignored.is_empty() {
                let _ = appc.emit("stream://overrides-ignored", overrides_ignored);
            }
        }
        StreamEvent::Partial { committed, pending } => {
            let _ = appc.emit("stream://partial", PartialPayload { committed, pending });
        }
        StreamEvent::Final { committed, tail, last } => {
            tracing::info!(
                "[stream] final committed={} tail={} last={}",
                committed.len(),
                tail.len(),
                last
            );
            let _ = appc.emit("stream://final", FinalPayload { committed, tail, last });
        }
        StreamEvent::Boundary { separator } => {
            tracing::info!("[stream] boundary (hard break)");
            let _ = appc.emit("stream://boundary", separator);
        }
        StreamEvent::Error(m) => {
            let _ = appc.emit("stream://error", m);
        }
        StreamEvent::Closed => {
            let _ = appc.emit("stream://status", "closed");
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

fn err_cb(e: StreamError) {
    tracing::warn!("[stream] device error: {e}");
}

fn downmix<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
    if channels <= 1 {
        return data.iter().map(|&s| to_f32(s)).collect();
    }
    let mut out = Vec::with_capacity(data.len() / channels + 1);
    for frame in data.chunks(channels) {
        let mut acc = 0.0;
        for &s in frame {
            acc += to_f32(s);
        }
        out.push(acc / frame.len() as f32);
    }
    out
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
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
            if let Err(e) = run_capture(&app, device, format, channels, config, pcm_tx, level, &stop) {
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
    stop: &AtomicBool,
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
                    sm = sm * 0.7 + (rms(&mono) * 6.0).clamp(0.0, 1.0) * 0.3;
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let _ = tx.send(mono);
                },
                err_cb,
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
                    sm = sm * 0.7 + (rms(&mono) * 6.0).clamp(0.0, 1.0) * 0.3;
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let _ = tx.send(mono);
                },
                err_cb,
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
                    sm = sm * 0.7 + (rms(&mono) * 6.0).clamp(0.0, 1.0) * 0.3;
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let _ = tx.send(mono);
                },
                err_cb,
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;

    while !stop.load(Ordering::SeqCst) {
        let l = f32::from_bits(level.load(Ordering::Relaxed));
        let _ = app.emit("stream://level", l);
        std::thread::sleep(Duration::from_millis(33));
    }
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
    pub mute_system: bool,
}

pub struct RecordSession {
    app: AppHandle,
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
        let params = self.params.clone();
        tauri::async_runtime::spawn(async move {
            transcribe_recording(app, params, pcm).await;
        });
    }
}

pub fn start_record(app: AppHandle, p: RecordParams) -> Result<RecordSession, String> {
    let (device, format, channels, config, in_rate) = open_input(p.device_id.clone())?;
    let mute = SystemMuteGuard::new(p.mute_system);
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let level = Arc::new(AtomicU32::new(0));
    let capture_stop = Arc::new(AtomicBool::new(false));

    let capture_join = {
        let app = app.clone();
        let buffer = buffer.clone();
        let level = level.clone();
        let stop = capture_stop.clone();
        std::thread::Builder::new()
            .name("record-capture".into())
            .spawn(move || {
                if let Err(e) =
                    run_record_capture(&app, device, format, channels, config, in_rate, buffer, level, &stop)
                {
                    tracing::warn!("[record] capture: {e}");
                }
            })
            .map_err(|e| e.to_string())?
    };

    Ok(RecordSession {
        app,
        params: p,
        buffer,
        capture_stop,
        capture_join: Some(capture_join),
        _mute: mute,
    })
}

async fn transcribe_recording(app: AppHandle, params: RecordParams, pcm: Vec<u8>) {
    if pcm.len() < 32_000 {
        // < ~1 s of 16 kHz mono audio — nothing meaningful captured.
        let _ = app.emit("stream://status", "closed");
        return;
    }
    if let Some(dir) = &params.save_dir {
        crate::audio::save_recording(dir, &pcm, 16_000);
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
            let _ = app.emit(
                "stream://final",
                FinalPayload {
                    committed: res.text,
                    tail: String::new(),
                    last: true,
                },
            );
            let _ = app.emit("stream://status", "closed");
        }
        Err(e) => {
            let _ = app.emit("stream://error", format!("Transcription failed: {e}"));
            let _ = app.emit("stream://status", "closed");
        }
    }
}

// ── System-audio mute guard ─────────────────────────────────────────────────
// Optionally mutes the default audio output for the duration of a dictation, so
// playback / notification sounds don't leak into the mic, restoring the prior
// state on drop. Best-effort: PipeWire (`wpctl`) first, then PulseAudio (`pactl`);
// a no-op where neither exists (e.g. Windows). A hard crash mid-dictation can
// leave it muted until the next dictation restores it.

struct SystemMuteGuard {
    prior: Option<bool>,
}

impl SystemMuteGuard {
    fn new(enabled: bool) -> Self {
        if !enabled {
            return Self { prior: None };
        }
        let prior = get_system_mute().unwrap_or(false);
        set_system_mute(true);
        Self { prior: Some(prior) }
    }
}

impl Drop for SystemMuteGuard {
    fn drop(&mut self) {
        if let Some(prior) = self.prior {
            set_system_mute(prior);
        }
    }
}

/// Current mute state of the default sink, via `wpctl get-volume` ("[MUTED]").
fn get_system_mute() -> Option<bool> {
    let out = std::process::Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SINK@"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).contains("[MUTED]"))
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
    stop: &AtomicBool,
) -> Result<(), String> {
    let stream = match format {
        SampleFormat::F32 => {
            let buf = buffer.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut resampler = Resampler16k::new(in_rate).map_err(|e| e.to_string())?;
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let mono = downmix(data, channels, |s| s);
                    sm = sm * 0.7 + (rms(&mono) * 6.0).clamp(0.0, 1.0) * 0.3;
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let bytes = resampler.push(&mono);
                    if !bytes.is_empty() {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&bytes);
                        }
                    }
                },
                err_cb,
                None,
            )
        }
        SampleFormat::I16 => {
            let buf = buffer.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut resampler = Resampler16k::new(in_rate).map_err(|e| e.to_string())?;
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let mono = downmix(data, channels, |s| s as f32 / 32768.0);
                    sm = sm * 0.7 + (rms(&mono) * 6.0).clamp(0.0, 1.0) * 0.3;
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let bytes = resampler.push(&mono);
                    if !bytes.is_empty() {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&bytes);
                        }
                    }
                },
                err_cb,
                None,
            )
        }
        SampleFormat::U16 => {
            let buf = buffer.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut resampler = Resampler16k::new(in_rate).map_err(|e| e.to_string())?;
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let mono = downmix(data, channels, |s| (s as f32 - 32768.0) / 32768.0);
                    sm = sm * 0.7 + (rms(&mono) * 6.0).clamp(0.0, 1.0) * 0.3;
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    let bytes = resampler.push(&mono);
                    if !bytes.is_empty() {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&bytes);
                        }
                    }
                },
                err_cb,
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    while !stop.load(Ordering::SeqCst) {
        let l = f32::from_bits(level.load(Ordering::Relaxed));
        let _ = app.emit("stream://level", l);
        std::thread::sleep(Duration::from_millis(33));
    }
    Ok(())
}
