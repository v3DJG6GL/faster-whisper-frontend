//! Microphone capture: device enumeration + a capture engine that emits live
//! RMS levels (`audio://level`). Resampling to 16 kHz / s16le for streaming
//! lands in M3, where it is actually consumed.

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod capture;
pub mod device;
pub mod resample;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// Holds the active capture stream (None when idle). Dropping the handle stops
/// and joins the capture thread.
#[derive(Default)]
pub struct AudioState(pub Mutex<Option<capture::CaptureHandle>>);

/// Wrap mono 16-bit little-endian PCM in a minimal WAV container.
pub fn wav_from_pcm16(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
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

/// Save mono s16le PCM as a timestamped `.wav` under `dir` (best-effort: logs and
/// returns on any I/O error rather than failing the dictation).
pub fn save_recording(dir: &Path, pcm: &[u8], sample_rate: u32) {
    if pcm.is_empty() {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!("[record] could not create recordings dir: {e}");
        return;
    }
    let path = dir.join(format!("dictation-{ts}.wav"));
    if let Err(e) = std::fs::write(&path, wav_from_pcm16(pcm, sample_rate)) {
        tracing::warn!("[record] could not save recording: {e}");
    } else {
        tracing::info!("[record] saved {}", path.display());
    }
}
