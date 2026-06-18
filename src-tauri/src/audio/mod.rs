//! Microphone capture: device enumeration + a capture engine that emits live
//! RMS levels (`audio://level`). Resampling to 16 kHz / s16le for streaming
//! lands in M3, where it is actually consumed.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

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

/// The most recent mic-test capture: mono f32 samples at `sample_rate`. Kept after
/// the capture stream stops so the Settings mic-test can replay what it just heard.
/// The capture thread clears + fills it (capped to the last few seconds);
/// `play_mic_test` reads it.
#[derive(Default)]
pub struct MicClip {
    /// Ring of the last `MAX_CLIP_SECS` of mono samples — a VecDeque so trimming the oldest is
    /// O(1) per dropped sample, not an O(len) shift of the whole buffer on every capture callback.
    pub samples: VecDeque<f32>,
    pub sample_rate: u32,
}

/// Managed handle to the last mic-test recording, shared with the capture thread.
#[derive(Default, Clone)]
pub struct MicTestClip(pub Arc<Mutex<MicClip>>);

/// Generation counter for mic-test playback. Each new replay (and each new capture)
/// bumps it; a running playback thread stops the instant it sees a newer generation,
/// so at most one replay is ever audible — no overlapping playbacks. The thread that
/// finishes while still current emits `audio://test-play-ended`.
#[derive(Default)]
pub struct MicPlayback(pub Arc<AtomicU64>);

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

/// Save mono s16le PCM as a timestamped `.wav` under `dir`; returns the saved path on
/// success (so the caller can write a transcript sidecar next to it). Best-effort: logs
/// and returns None on any I/O error rather than failing the dictation.
pub fn save_recording(dir: &Path, pcm: &[u8], sample_rate: u32) -> Option<PathBuf> {
    if pcm.is_empty() {
        return None;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!("[record] could not create recordings dir: {e}");
        return None;
    }
    // Human-readable, sortable local timestamp (e.g. dictation-2026-06-16_22-47-35.wav). A counter
    // suffix guards the rare case of two recordings within the same second (never overwrite).
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let mut path = dir.join(format!("dictation-{stamp}.wav"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("dictation-{stamp}-{n}.wav"));
        n += 1;
    }
    match std::fs::write(&path, wav_from_pcm16(pcm, sample_rate)) {
        Ok(()) => {
            tracing::info!("[record] saved {}", path.display());
            Some(path)
        }
        Err(e) => {
            tracing::warn!("[record] could not save recording: {e}");
            None
        }
    }
}

/// Write the dictation transcript next to its `.wav` as a sibling `.txt` (same stem), so the
/// recordings folder is browsable/searchable. Best-effort: logs and returns on any error.
pub fn save_transcript_sidecar(wav_path: &Path, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    let txt_path = wav_path.with_extension("txt");
    if let Err(e) = std::fs::write(&txt_path, format!("{trimmed}\n")) {
        tracing::warn!("[record] could not write transcript sidecar: {e}");
    } else {
        tracing::info!("[record] transcript saved {}", txt_path.display());
    }
}
