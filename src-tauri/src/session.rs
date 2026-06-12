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
    pub device_id: Option<String>,
}

pub struct StreamSession {
    capture_stop: Arc<AtomicBool>,
    capture_join: Option<JoinHandle<()>>,
    ws_stop: watch::Sender<bool>,
    ws_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for StreamSession {
    fn drop(&mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        let _ = self.ws_stop.send(true);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        // Detach the WS task so it can flush + drain the final utterance in the
        // background; it ends on its own once it sees the stop signal.
        drop(self.ws_task.take());
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
        api_key: p.api_key,
        in_rate,
    };

    let appc = app.clone();
    let on_event = move |ev: StreamEvent| match ev {
        StreamEvent::Ready => {
            let _ = appc.emit("stream://status", "ready");
        }
        StreamEvent::Partial { committed, pending } => {
            let _ = appc.emit("stream://partial", PartialPayload { committed, pending });
        }
        StreamEvent::Final { committed, tail, last } => {
            let _ = appc.emit("stream://final", FinalPayload { committed, tail, last });
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
    pub prompt: String,
    pub device_id: Option<String>,
}

pub struct RecordSession {
    app: AppHandle,
    params: RecordParams,
    buffer: Arc<Mutex<Vec<u8>>>,
    capture_stop: Arc<AtomicBool>,
    capture_join: Option<JoinHandle<()>>,
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
    })
}

async fn transcribe_recording(app: AppHandle, params: RecordParams, pcm: Vec<u8>) {
    if pcm.len() < 32_000 {
        // < ~1 s of 16 kHz mono audio — nothing meaningful captured.
        let _ = app.emit("stream://status", "closed");
        return;
    }
    let wav = wav_from_pcm16(&pcm, 16_000);
    match batch::transcribe_wav_bytes(
        &params.server_url,
        params.api_key.as_deref(),
        &params.model,
        &params.language,
        &params.prompt,
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

/// Wrap mono 16-bit little-endian PCM in a minimal WAV container.
fn wav_from_pcm16(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let channels: u16 = 1;
    let bits: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
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
