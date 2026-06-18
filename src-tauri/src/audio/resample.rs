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
    /// Reused output scratch (one channel, sized to the resampler's max output) so each chunk
    /// converts without a per-call heap allocation on the audio thread.
    out: Vec<Vec<f32>>,
}

impl Resampler16k {
    pub fn new(in_rate: u32) -> anyhow::Result<Self> {
        if in_rate == 16_000 {
            // No resampling needed — pass through (just pack to s16le).
            return Ok(Self {
                inner: None,
                acc: Vec::new(),
                needed: 0,
                out: Vec::new(),
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
        let out = inner.output_buffer_allocate(true);
        Ok(Self {
            inner: Some(inner),
            acc: Vec::new(),
            needed,
            out,
        })
    }

    /// Feed mono f32 samples; returns any ready 16 kHz s16le bytes.
    pub fn push(&mut self, samples: &[f32]) -> Vec<u8> {
        let mut out = Vec::new();
        if self.inner.is_none() {
            // Pass-through: already 16 kHz.
            out.reserve(samples.len() * 2);
            for &s in samples {
                push_i16le(&mut out, s);
            }
            return out;
        }

        self.acc.extend_from_slice(samples);
        while self.acc.len() >= self.needed && self.needed > 0 {
            let needed = self.needed;
            // Convert the front block in place into the reused output buffer — `process_into_buffer`
            // avoids the per-chunk input/output heap allocations `process()` does on the audio thread.
            let res = self
                .inner
                .as_mut()
                .unwrap()
                .process_into_buffer(&[&self.acc[..needed]], &mut self.out, None);
            if let Ok((_, written)) = res {
                out.reserve(written * 2);
                for &s in &self.out[0][..written] {
                    push_i16le(&mut out, s);
                }
            }
            self.acc.drain(..needed);
            self.needed = self.inner.as_ref().unwrap().input_frames_next();
        }
        out
    }

    /// Flush the buffered tail (< one input block) at end of stream: zero-pad to a full input block
    /// and resample, so the final (< ~64 ms) of audio isn't dropped. The trailing zeros resample to
    /// a soft decay into silence (no click). Pass-through mode buffers nothing, so it's a no-op.
    pub fn flush(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.inner.is_none() || self.acc.is_empty() || self.needed == 0 {
            self.acc.clear();
            return out;
        }
        self.acc.resize(self.needed, 0.0); // pad the partial block with silence
        let needed = self.needed;
        let res = self
            .inner
            .as_mut()
            .unwrap()
            .process_into_buffer(&[&self.acc[..needed]], &mut self.out, None);
        if let Ok((_, written)) = res {
            out.reserve(written * 2);
            for &s in &self.out[0][..written] {
                push_i16le(&mut out, s);
            }
        }
        self.acc.clear();
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

    #[test]
    fn flush_emits_buffered_tail() {
        let mut r = Resampler16k::new(48_000).unwrap();
        // Fewer than one input block → buffered, nothing emitted yet.
        assert!(r.push(&vec![0.3f32; 100]).is_empty());
        // Flush pads + resamples that tail, so it's no longer dropped.
        assert!(!r.flush().is_empty());
    }
}
