//! Capture engine: opens an input device and emits a smoothed RMS level
//! (`audio://level`, f32 in 0..1) at ~30 Hz until stopped. While running it also
//! records the down-mixed mono audio into a shared [`MicClip`] (capped to the last
//! `MAX_CLIP_SECS`) so the Settings mic-test can replay what it just heard.
//!
//! The `cpal::Stream` is not `Send`, so it lives entirely on a dedicated capture
//! thread; the [`CaptureHandle`] only carries a stop flag + join handle (both
//! `Send`), so it can sit in Tauri state. Dropping the handle stops capture.
//!
//! [`start_level_meter`] waits (bounded) until the device is open and playing, so a busy,
//! denied or failing mic comes back as an error the mic test can end on, not a silent meter.

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::audio::MicClip;

/// Keep at most this many seconds of the most recent capture for replay.
const MAX_CLIP_SECS: usize = 30;
/// How long [`start_level_meter`] waits for the device to open before handing back the handle
/// anyway (a slow open then still meters once it lands; a late failure ends the test through
/// `audio://test-ended`).
const OPEN_WAIT: Duration = Duration::from_secs(5);

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
        let level = super::chip_level(rms);
        self.smoothed = self.smoothed * 0.7 + level * 0.3;
        self.out.store(self.smoothed.to_bits(), Ordering::Relaxed);
    }
}

/// Appends captured mono samples to the shared clip, dropping the oldest so it
/// never holds more than `cap` samples.
struct Recorder {
    clip: Arc<Mutex<MicClip>>,
    cap: usize,
}

impl Recorder {
    fn push(&self, mono: &[f32]) {
        if let Ok(mut c) = self.clip.lock() {
            c.samples.extend(mono.iter().copied());
            // VecDeque ring: O(1) per popped sample, not an O(len) front-shift on every callback.
            while c.samples.len() > self.cap {
                c.samples.pop_front();
            }
        }
    }
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
/// and recording mono audio into `clip` for replay. Blocks until the stream is playing (or
/// [`OPEN_WAIT`] passed) and returns the open failure, if any, as the error.
pub fn start_level_meter(
    app: AppHandle,
    device_id: Option<String>,
    clip: Arc<Mutex<MicClip>>,
) -> Result<CaptureHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    // run() reports Ok once the stream plays; every Err it returns comes before that, so the
    // channel carries exactly one message and the one-slot buffer never blocks the sender.
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
    // Raised by the starter once OPEN_WAIT ran out, before its last look at the channel.
    let gave_up = Arc::new(AtomicBool::new(false));
    let (app_ev, stop_ev, gave_up_t) = (app.clone(), stop.clone(), gave_up.clone());
    let join = std::thread::Builder::new()
        .name("mic-capture".into())
        .spawn(move || {
            if let Err(e) = run(app, device_id, stop_thread, clip, &ready_tx) {
                tracing::warn!("[audio] capture ended: {e}");
                // The send fails, or lands with `gave_up` raised, only when the starter stopped
                // waiting after OPEN_WAIT, so it may already have resolved Ok and nothing else would
                // tell the Settings test it is over (a doubled signal is harmless). Skip it on a user
                // stop/replacement and on the lost-at-open path (both raise `stop`; the latter
                // already emitted).
                if (ready_tx.send(Err(e)).is_err() || gave_up_t.load(Ordering::SeqCst))
                    && !stop_ev.load(Ordering::SeqCst)
                {
                    let _ = app_ev.emit("audio://test-ended", "open-failed");
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let mut handle = CaptureHandle {
        stop,
        join: Some(join),
    };
    let failed = match ready_rx.recv_timeout(OPEN_WAIT) {
        Ok(Err(e)) => Some(e),
        // Raise `gave_up` first: a failure sent after this look is then emitted by the thread.
        Err(mpsc::RecvTimeoutError::Timeout) => {
            gave_up.store(true, Ordering::SeqCst);
            match ready_rx.try_recv() {
                Ok(Err(e)) => Some(e),
                _ => None,
            }
        }
        _ => None,
    };
    if let Some(e) = failed {
        // The open failed and the thread is on its way out; join it before reporting.
        if let Some(j) = handle.join.take() {
            let _ = j.join();
        }
        return Err(e);
    }
    // Playing, still opening after OPEN_WAIT, or gone (Drop joins it): hand the handle back.
    Ok(handle)
}

fn run(
    app: AppHandle,
    device_id: Option<String>,
    stop: Arc<AtomicBool>,
    clip: Arc<Mutex<MicClip>>,
    ready: &SyncSender<Result<(), String>>,
) -> Result<(), String> {
    // Reset the clip BEFORE the fallible open: a busy/unplugged/denied mic would otherwise leave
    // the previous test's audio for stop_mic_test to auto-replay. Rate 0 makes it report 0 s (no
    // replay). No torn write: start_mic_test joins the prior capture before spawning this thread.
    if let Ok(mut c) = clip.lock() {
        c.samples.clear();
        c.sample_rate = 0;
    }

    // A pinned mic that isn't connected falls back to the default input, as dictation does (the
    // Settings row already says it isn't connected).
    let device = super::device::resolve_input(device_id.as_deref())?.device;
    let supported = super::device::input_config(&device)?;
    let sample_format = supported.sample_format();
    let channels = supported.channels() as usize;
    let config: StreamConfig = super::device::capture_config(&device, &supported);
    let sample_rate = config.sample_rate;
    let cap = MAX_CLIP_SECS * sample_rate as usize;

    // Stamp the device's rate for playback (samples were cleared above).
    if let Ok(mut c) = clip.lock() {
        c.sample_rate = sample_rate;
    }

    let level_bits = Arc::new(AtomicU32::new(0));
    // Set by on_terminal only (a user stop raises `stop` alone), so the exit below can tell the
    // frontend the test ended on its own.
    let lost = Arc::new(AtomicBool::new(false));
    // A lost device (or an error storm) ends the test: zero the meter and stop publishing, which
    // drops the stream. The clip recorded so far stays replayable.
    let on_terminal = || {
        let (s, l, d) = (stop.clone(), level_bits.clone(), lost.clone());
        move || {
            l.store(0f32.to_bits(), Ordering::Relaxed);
            d.store(true, Ordering::SeqCst);
            s.store(true, Ordering::SeqCst);
        }
    };

    let stream = match sample_format {
        SampleFormat::F32 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder {
                clip: clip.clone(),
                cap,
            };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                config,
                move |data: &[f32], _| {
                    meter.push(analyze(data, channels, |s| s, &mut mono));
                    rec.push(&mono);
                },
                super::stream_errors::error_callback("audio", on_terminal()),
                None,
            )
        }
        SampleFormat::I16 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder {
                clip: clip.clone(),
                cap,
            };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                config,
                move |data: &[i16], _| {
                    meter.push(analyze(data, channels, |s| s as f32 / 32768.0, &mut mono));
                    rec.push(&mono);
                },
                super::stream_errors::error_callback("audio", on_terminal()),
                None,
            )
        }
        SampleFormat::U16 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder {
                clip: clip.clone(),
                cap,
            };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                config,
                move |data: &[u16], _| {
                    meter.push(analyze(
                        data,
                        channels,
                        |s| (s as f32 - 32768.0) / 32768.0,
                        &mut mono,
                    ));
                    rec.push(&mono);
                },
                super::stream_errors::error_callback("audio", on_terminal()),
                None,
            )
        }
        SampleFormat::I32 => {
            let mut meter = Meter::new(level_bits.clone());
            let rec = Recorder {
                clip: clip.clone(),
                cap,
            };
            let mut mono: Vec<f32> = Vec::new();
            device.build_input_stream(
                config,
                move |data: &[i32], _| {
                    meter.push(analyze(
                        data,
                        channels,
                        |s| s as f32 / 2_147_483_648.0,
                        &mut mono,
                    ));
                    rec.push(&mono);
                },
                super::stream_errors::error_callback("audio", on_terminal()),
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    // Lost while opening or in play()'s first moments: fail the start instead of reporting a test
    // that is already over (the frontend only hears test-ended once its start resolved). The event
    // still goes out for a start that stopped waiting after OPEN_WAIT and so resolved Ok already.
    if lost.load(Ordering::SeqCst) {
        let _ = app.emit("audio://test-ended", "device-lost");
        return Err("the microphone stopped delivering audio".into());
    }
    let _ = ready.send(Ok(()));

    super::publish_levels_with_live(&app, "audio://level", &level_bits, &stop, None);
    // Leave the meter at rest: after a device loss its last live-looking level would otherwise
    // stay on screen (after a user stop the listener is already gone, so this is a no-op).
    let _ = app.emit("audio://level", 0f32);
    // A device loss ended the test: tell the Settings test so it leaves "testing" (its start
    // call resolved long ago, so nothing else would reach it).
    if lost.load(Ordering::SeqCst) {
        let _ = app.emit("audio://test-ended", "device-lost");
    }
    // `stream` is dropped here, on the capture thread, stopping the device.
    Ok(())
}
