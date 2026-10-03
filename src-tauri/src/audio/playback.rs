//! Play a short mono f32 buffer on the default output device (sound cues, mic-test replay).
//!
//! This used to be rodio. rodio pinned cpal to 0.17, and all we used of it was "play this mono
//! buffer at this rate", so this does the four things rodio did for us, straight on cpal:
//! pick an output config, ask for a ~50 ms buffer (ALSA's default buffer can be seconds long),
//! resample linearly to the device rate, and copy the mono signal to every output channel.

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, FromSample, SampleFormat, SizedSample, SupportedBufferSize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Output buffer to ask for, in seconds of audio.
const BUFFER_SECS: f64 = 0.05;
/// How long the last buffer may still be sounding after the cursor ran past the end.
const TAIL: Duration = Duration::from_millis(120);

/// Play `samples` (mono, `rate` Hz) and block until they finished or `cancelled()` turns true.
pub fn play_mono(samples: Vec<f32>, rate: u32, cancelled: impl Fn() -> bool) -> Result<(), String> {
    if samples.is_empty() || rate == 0 {
        return Ok(());
    }
    let device = super::host::default_output().ok_or_else(|| "no output device".to_string())?;
    // Prefer a float config at the source rate (a sound server converts for us), else whatever
    // the device runs at by default and resample here.
    let supported = device
        .supported_output_configs()
        .ok()
        .and_then(|mut ranges| {
            ranges.find_map(|r| {
                (r.sample_format() == SampleFormat::F32)
                    .then(|| r.try_with_sample_rate(rate))
                    .flatten()
            })
        })
        .map_or_else(|| device.default_output_config(), Ok)
        .map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let mut config = supported.config();
    config.buffer_size = buffer_size(supported.buffer_size(), config.sample_rate);

    let duration = Duration::from_secs_f64(samples.len() as f64 / rate as f64);
    let done = Arc::new(AtomicBool::new(false));
    let pcm: Arc<[f32]> = samples.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, pcm, rate, done.clone()),
        SampleFormat::I16 => build::<i16>(&device, config, pcm, rate, done.clone()),
        SampleFormat::I32 => build::<i32>(&device, config, pcm, rate, done.clone()),
        SampleFormat::U16 => build::<u16>(&device, config, pcm, rate, done.clone()),
        other => return Err(format!("unsupported output sample format: {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;

    // A stalled device must not hold this thread forever: give up a little after the clip's
    // own length.
    let deadline = Instant::now() + duration + Duration::from_secs(2);
    while !done.load(Ordering::Relaxed) {
        if cancelled() || Instant::now() >= deadline {
            return Ok(()); // dropping `stream` stops it
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(TAIL);
    Ok(())
}

fn buffer_size(supported: &SupportedBufferSize, device_rate: u32) -> BufferSize {
    let want = (device_rate as f64 * BUFFER_SECS) as u32;
    match supported {
        SupportedBufferSize::Range { min, max } => BufferSize::Fixed(want.clamp(*min, *max)),
        SupportedBufferSize::Unknown => BufferSize::Default,
    }
}

fn build<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    pcm: Arc<[f32]>,
    src_rate: u32,
    done: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let mut cursor = Cursor::new(src_rate, config.sample_rate);
    let mut gate = super::stream_errors::ErrorGate::new("playback");
    device
        .build_output_stream(
            config,
            move |out: &mut [T], _| {
                if fill(out, channels, &mut cursor, &pcm) {
                    done.store(true, Ordering::Relaxed);
                }
            },
            move |e| {
                let msg = e.to_string();
                let _ = gate.on_error(e.kind(), &msg, Instant::now());
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Write the next frames of `pcm` into the interleaved `out` buffer, the same value on every
/// channel; silence past the end. Returns true once the whole clip has been written.
fn fill<T: SizedSample + FromSample<f32>>(
    out: &mut [T],
    channels: usize,
    cursor: &mut Cursor,
    pcm: &[f32],
) -> bool {
    for frame in out.chunks_mut(channels.max(1)) {
        let v = cursor.next(pcm).unwrap_or(0.0);
        frame.fill(T::from_sample(v));
    }
    cursor.finished(pcm)
}

/// Linear-interpolating read position into a mono clip, stepping at src/device rate.
struct Cursor {
    pos: f64,
    step: f64,
}

impl Cursor {
    fn new(src_rate: u32, device_rate: u32) -> Self {
        Cursor {
            pos: 0.0,
            step: src_rate as f64 / device_rate.max(1) as f64,
        }
    }

    fn next(&mut self, pcm: &[f32]) -> Option<f32> {
        let i = self.pos as usize;
        let a = *pcm.get(i)?;
        let v = match pcm.get(i + 1) {
            Some(b) => a + (b - a) * (self.pos - i as f64) as f32,
            None => a,
        };
        self.pos += self.step;
        Some(v)
    }

    fn finished(&self, pcm: &[f32]) -> bool {
        self.pos as usize >= pcm.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_rate_plays_the_samples_unchanged() {
        let pcm = [0.1f32, 0.2, 0.3];
        let mut c = Cursor::new(48_000, 48_000);
        let got: Vec<f32> = std::iter::from_fn(|| c.next(&pcm)).collect();
        assert_eq!(got, pcm);
        assert!(c.finished(&pcm));
    }

    #[test]
    fn upsampling_interpolates_between_samples() {
        let pcm = [0.0f32, 1.0];
        let mut c = Cursor::new(24_000, 48_000);
        let got: Vec<f32> = std::iter::from_fn(|| c.next(&pcm)).collect();
        assert_eq!(got, vec![0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn downsampling_skips_ahead() {
        let pcm = [0.0f32, 0.25, 0.5, 0.75];
        let mut c = Cursor::new(48_000, 24_000);
        let got: Vec<f32> = std::iter::from_fn(|| c.next(&pcm)).collect();
        assert_eq!(got, vec![0.0, 0.5]);
    }

    #[test]
    fn mono_is_copied_to_every_channel_then_silence() {
        let pcm = [0.5f32, -0.5];
        let mut c = Cursor::new(48_000, 48_000);
        let mut out = [9.0f32; 6]; // 3 stereo frames
        let done = fill(&mut out, 2, &mut c, &pcm);
        assert_eq!(out, [0.5, 0.5, -0.5, -0.5, 0.0, 0.0]);
        assert!(done);
    }

    #[test]
    fn integer_outputs_are_converted() {
        let pcm = [1.0f32];
        let mut c = Cursor::new(48_000, 48_000);
        let mut out = [0i16; 1];
        fill(&mut out, 1, &mut c, &pcm);
        assert_eq!(out[0], i16::MAX);
    }

    #[test]
    fn buffer_request_is_clamped_to_the_device_range() {
        let r = SupportedBufferSize::Range { min: 64, max: 1024 };
        assert!(matches!(buffer_size(&r, 48_000), BufferSize::Fixed(1024)));
        let r = SupportedBufferSize::Range {
            min: 4096,
            max: 8192,
        };
        assert!(matches!(buffer_size(&r, 48_000), BufferSize::Fixed(4096)));
        let r = SupportedBufferSize::Range { min: 64, max: 8192 };
        assert!(matches!(buffer_size(&r, 48_000), BufferSize::Fixed(2400)));
        assert!(matches!(
            buffer_size(&SupportedBufferSize::Unknown, 48_000),
            BufferSize::Default
        ));
    }
}

/// `cargo test --lib live_tone -- --ignored --nocapture` plays a quiet 300 ms tone on the default
/// output and reports how long the call blocked.
#[cfg(test)]
#[test]
#[ignore]
fn live_tone() {
    let pcm: Vec<f32> = (0..14_400)
        .map(|i| 0.05 * (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin())
        .collect();
    let t = Instant::now();
    let r = play_mono(pcm, 48_000, || false);
    println!("result={r:?} blocked={:?}", t.elapsed());
}
