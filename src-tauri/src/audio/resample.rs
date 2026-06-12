//! Streaming resampler: arbitrary-rate mono f32 → 16 kHz mono PCM s16le bytes.
//!
//! The backend's streaming endpoint expects 16 kHz mono `pcm_s16le`. Device
//! capture is usually 44.1/48 kHz, so we band-limit + resample with `rubato`.
//! Input arrives in arbitrary-sized chunks, so we buffer to the resampler's
//! fixed input size and emit whatever 16 kHz output is ready.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub struct Resampler16k {
    inner: Option<SincFixedIn<f32>>,
    acc: Vec<f32>,
    needed: usize,
}

impl Resampler16k {
    pub fn new(in_rate: u32) -> anyhow::Result<Self> {
        if in_rate == 16_000 {
            // No resampling needed — pass through (just pack to s16le).
            return Ok(Self {
                inner: None,
                acc: Vec::new(),
                needed: 0,
            });
        }
        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        let inner = SincFixedIn::<f32>::new(16_000.0 / in_rate as f64, 2.0, params, 1024, 1)?;
        let needed = inner.input_frames_next();
        Ok(Self {
            inner: Some(inner),
            acc: Vec::new(),
            needed,
        })
    }

    /// Feed mono f32 samples; returns any ready 16 kHz s16le bytes.
    pub fn push(&mut self, samples: &[f32]) -> Vec<u8> {
        let mut out = Vec::new();
        let Some(resampler) = self.inner.as_mut() else {
            // Pass-through: already 16 kHz.
            out.reserve(samples.len() * 2);
            for &s in samples {
                push_i16le(&mut out, s);
            }
            return out;
        };

        self.acc.extend_from_slice(samples);
        while self.acc.len() >= self.needed && self.needed > 0 {
            let chunk: Vec<f32> = self.acc.drain(..self.needed).collect();
            if let Ok(frames) = resampler.process(&[chunk], None) {
                if let Some(ch0) = frames.into_iter().next() {
                    out.reserve(ch0.len() * 2);
                    for s in ch0 {
                        push_i16le(&mut out, s);
                    }
                }
            }
            self.needed = resampler.input_frames_next();
        }
        out
    }
}

#[inline]
fn push_i16le(out: &mut Vec<u8>, sample: f32) {
    let v = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
    out.extend_from_slice(&v.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsamples_48k_to_16k() {
        let mut r = Resampler16k::new(48_000).unwrap();
        // 1 second of silence at 48 kHz → ~1 second at 16 kHz (minus < 1 chunk of buffering).
        let bytes = r.push(&vec![0.0f32; 48_000]);
        let samples = bytes.len() / 2;
        assert!(samples > 16_000 - 2048 && samples <= 16_000, "got {samples} samples");
    }

    #[test]
    fn passthrough_16k() {
        let mut r = Resampler16k::new(16_000).unwrap();
        let bytes = r.push(&[0.0, 0.5, -0.5, 1.0]);
        assert_eq!(bytes.len(), 8); // 4 samples × 2 bytes
    }
}
