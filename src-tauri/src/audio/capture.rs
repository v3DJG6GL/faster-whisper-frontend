//! Capture engine: opens an input device and emits a smoothed RMS level
//! (`audio://level`, f32 in 0..1) at ~30 Hz until stopped. While running it also
//! records the down-mixed mono audio into a shared [`MicClip`] (capped to the last
//! few seconds) so the Settings mic-test can replay what it just heard.
//!
//! The `cpal::Stream` is not `Send`, so it lives entirely on a dedicated capture
//! thread; the [`CaptureHandle`] only carries a stop flag + join handle (both
//! `Send`), so it can sit in Tauri state. Dropping the handle stops capture.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig, StreamError};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::audio::MicClip;

/// Keep at most this many seconds of the most recent capture for replay.
const MAX_CLIP_SECS: usize = 30;

pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Smooths instantaneous RMS and publishes it as f32 bits in an atomic.
struct Meter {
    smoothed: f32,
    out: Arc<AtomicU32>,
}

impl Meter {
    fn new(out: Arc<AtomicU32>) -> Self {
        Meter { smoothed: 0.0, out }
    }
    fn push(&mut self, rms: f32) {
        let level = (rms * 6.0).clamp(0.0, 1.0);
        self.smoothed = self.smoothed * 0.7 + level * 0.3;
        self.out.store(self.smoothed.to_bits(), Ordering::Relaxed);
    }
}

/// Appends captured mono samples to the shared clip, dropping the oldest so it
/// never holds more than `cap` samples (a simple ring of the last few seconds).
struct Recorder {
    clip: Arc<Mutex<MicClip>>,
    cap: usize,
}

impl Recorder {
    fn push(&self, mono: &[f32]) {
        if let Ok(mut c) = self.clip.lock() {
            c.samples.extend(mono.iter().copied());
            // Drop the oldest beyond the cap — O(1) per popped sample on the VecDeque ring, vs the
            // O(len) front-shift a Vec::drain did on every callback once the cap was reached.
            while c.samples.len() > self.cap {
                c.samples.pop_front();
            }
        }
    }
}

fn err_cb(e: StreamError) {
    tracing::warn!("[audio] stream error: {e}");
}

/// One pass over an interleaved block: down-mix each frame to mono (appended to
/// `mono`, which is cleared first) and return the block RMS for the level meter.
fn analyze<T: Copy>(
    data: &[T],
    channels: usize,
    to_f32: impl Fn(T) -> f32,
    mono: &mut Vec<f32>,
) -> f32 {
    mono.clear();
    if data.is_empty() || channels == 0 {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for frame in data.chunks(channels) {
        let mut acc = 0.0;
        for &s in frame {
            acc += to_f32(s);
        }
        let m = acc / frame.len() as f32;
        mono.push(m);
        sum += m * m;
    }
    let frames = mono.len();
    if frames == 0 {
        0.0
    } else {
        (sum / frames as f32).sqrt()
    }
}

/// Start capturing on the given device (or the default), emitting `audio://level`
/// and recording mono audio into `clip` for replay.
pub fn start_level_meter(
    app: AppHandle,
    device_id: Option<String>,
    clip: Arc<Mutex<MicClip>>,
) -> Result<CaptureHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let join = std::thread::Builder::new()
        .name("mic-capture".into())
        .spawn(move || {
            if let Err(e) = run(app, device_id, stop_thread, clip) {
                tracing::warn!("[audio] capture ended: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(CaptureHandle {
        stop,
        join: Some(join),
    })
}

fn pick_device(device_id: Option<String>) -> Result<Device, String> {
    let host = cpal::default_host();
    match device_id {
        Some(id) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == id).unwrap_or(false))
            .ok_or_else(|| format!("input device not found: {id}")),
        None => host
            .default_input_device()
            .ok_or_else(|| "no default input device".to_string()),
    }
}

fn run(
    app: AppHandle,
    device_id: Option<String>,
    stop: Arc<AtomicBool>,
    clip: Arc<Mutex<MicClip>>,
) -> Result<(), String> {
    let device = pick_device(device_id)?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_format = supported.sample_format();
    let channels = supported.channels() as usize;
    let config: StreamConfig = supported.config();
    let sample_rate = config.sample_rate.0;
    let cap = MAX_CLIP_SECS * sample_rate as usize;

    // Fresh capture: reset the shared clip and stamp its rate for playback.
    if let Ok(mut c) = clip.lock() {
        c.samples.clear();
        c.sample_rate = sample_rate;
    }

    let level_bits = Arc::new(AtomicU32::new(0));

    let stream = match sample_format {
        SampleFormat::F32 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder { clip: clip.clone(), cap };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    meter.push(analyze(data, channels, |s| s, &mut mono));
                    rec.push(&mono);
                },
                err_cb,
                None,
            )
        }
        SampleFormat::I16 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder { clip: clip.clone(), cap };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    meter.push(analyze(data, channels, |s| s as f32 / 32768.0, &mut mono));
                    rec.push(&mono);
                },
                err_cb,
                None,
            )
        }
        SampleFormat::U16 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder { clip: clip.clone(), cap };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    meter.push(analyze(data, channels, |s| (s as f32 - 32768.0) / 32768.0, &mut mono));
                    rec.push(&mono);
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
        let level = f32::from_bits(level_bits.load(Ordering::Relaxed));
        let _ = app.emit("audio://level", level);
        std::thread::sleep(Duration::from_millis(33));
    }
    // `stream` is dropped here, on the capture thread, stopping the device.
    Ok(())
}
