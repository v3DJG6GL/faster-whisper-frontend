//! Microphone capture: device enumeration + a capture engine that emits live
//! RMS levels (`audio://level`). Resampling to 16 kHz / s16le for streaming
//! lands in M3, where it is actually consumed.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub mod capture;
pub mod device;
pub mod resample;

/// Publish the live RMS meter to `event` at ~30 Hz until `stop` is set, decoding the level from the
/// atomic f32-bits cell the capture callbacks write. The one cadence + bit-decode shared by all three
/// capture loops (mic-test "audio://level", plus streaming and batch "stream://level"), so the refresh
/// rate / decode protocol lives in one place. Runs on the caller's capture thread until stop flips.
pub fn publish_levels(app: &AppHandle, event: &str, level: &AtomicU32, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        let l = f32::from_bits(level.load(Ordering::Relaxed));
        let _ = app.emit(event, l);
        std::thread::sleep(Duration::from_millis(33));
    }
}

/// Scale a raw RMS into the chip's 0..1 meter level: the tuned gain 6.0, clamped. This single
/// constant COUPLES the live chip meter to the batch + streaming speech-gate thresholds, so it
/// lives in ONE place — retuning it at one call site would silently desync the meter from the gate.
pub fn chip_level(rms: f32) -> f32 {
    (rms * 6.0).clamp(0.0, 1.0)
}

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

/// Speech gate for the SAVED recording, shared by the streaming save path
/// (`transport/stream.rs`, fed chunk-by-chunk as audio arrives) and the batch record
/// save (`trim_silence_16k` below, fed the finished buffer). Keeps only the spans the
/// chip shows as "speaking" plus a short lead-in, so a long latch session doesn't store
/// hours of silence and the file matches the indicator. Ported from the frontend
/// detector (`lib/speaking.ts`): a two-stage smoothed RMS with hysteresis (enter
/// >`SPEAK_HIGH`, leave <`SPEAK_LOW` after ~900 ms quiet) feeding a 250 ms pre-roll ring
/// that's flushed on each silence→speech edge (so word onsets aren't clipped; the 900 ms
/// leave-hold gives the trailing tail for free). The hold/pre-roll are sample-counted, so
/// only the EMA smoothing is sensitive to the caller's chunk cadence.
pub struct SpeechGate {
    sp_stream: f32, // ~ session.rs `stream://level` (0.7/0.3 EMA of rms*6)
    sp_smooth: f32, // ~ speaking.ts memo.smooth (0.8/0.2 EMA)
    speaking: bool,
    low_run: usize, // consecutive 16 kHz samples below SPEAK_LOW
    preroll: VecDeque<u8>,
}

impl SpeechGate {
    const SPEAK_HIGH: f32 = 0.08;
    const SPEAK_LOW: f32 = 0.04;
    const HOLD_SAMPLES: usize = 14_400; // 900 ms @ 16 kHz
    const PREROLL_BYTES: usize = 8_000; // 250 ms @ 16 kHz s16le

    pub fn new() -> Self {
        Self {
            sp_stream: 0.0,
            sp_smooth: 0.0,
            speaking: false,
            low_run: 0,
            preroll: VecDeque::new(),
        }
    }

    /// Feed one chunk. `level` is the chip-scaled RMS (`rms * 6`, clamped 0..1) for this
    /// chunk; `bytes` is the matching 16 kHz s16le audio. Spoken audio (plus the buffered
    /// lead-in on each silence→speech edge) is appended to `out`.
    pub fn push(&mut self, level: f32, bytes: &[u8], out: &mut Vec<u8>) {
        self.sp_stream = self.sp_stream * 0.7 + level * 0.3;
        self.sp_smooth = self.sp_smooth * 0.8 + self.sp_stream * 0.2;
        if self.sp_smooth > Self::SPEAK_HIGH {
            self.speaking = true;
            self.low_run = 0;
        } else if self.sp_smooth < Self::SPEAK_LOW {
            self.low_run += bytes.len() / 2;
            if self.speaking && self.low_run >= Self::HOLD_SAMPLES {
                self.speaking = false;
            }
        } else {
            self.low_run = 0; // hysteresis band → hold current state
        }
        if self.speaking {
            if !self.preroll.is_empty() {
                out.extend(self.preroll.drain(..));
            }
            out.extend_from_slice(bytes);
        } else {
            self.preroll.extend(bytes.iter().copied());
            while self.preroll.len() > Self::PREROLL_BYTES {
                self.preroll.pop_front();
            }
        }
    }
}

impl Default for SpeechGate {
    fn default() -> Self {
        Self::new()
    }
}

/// RMS of a 16 kHz s16le mono frame, scaled and clamped to the chip's 0..1 level (chip_level) so
/// the batch gate keys off the same thresholds as the live indicator.
fn frame_level_s16le(bytes: &[u8]) -> f32 {
    let n = bytes.len() / 2;
    if n == 0 {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for s in bytes.chunks_exact(2) {
        let v = i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0;
        sum += v * v;
    }
    chip_level((sum / n as f32).sqrt())
}

/// Trim leading / internal / trailing silence from a COMPLETE 16 kHz s16le mono buffer
/// using the shared [`SpeechGate`], so the "Trim silence" setting produces the same kind
/// of saved file on a batch (record-then-POST) backend as it already does on the
/// streaming path. Processes the buffer in fixed ~64 ms frames (the gate's hold/pre-roll
/// are sample-counted, so only the EMA smoothing is frame-cadence sensitive — a frame
/// near the streaming chunk size keeps the trimming close). Returns the spoken-only bytes
/// (empty if the whole clip was below the speech threshold).
pub fn trim_silence_16k(pcm: &[u8]) -> Vec<u8> {
    const FRAME_BYTES: usize = 2_048; // 1024 samples ≈ 64 ms @ 16 kHz s16le
    let mut gate = SpeechGate::new();
    let mut out = Vec::with_capacity(pcm.len());
    for frame in pcm.chunks(FRAME_BYTES) {
        gate.push(frame_level_s16le(frame), frame, &mut out);
    }
    out
}

/// Write the dictation transcript next to its `.wav` as a sibling `.txt` (same stem), so the
/// recordings folder is browsable/searchable. Best-effort: logs and returns on any error.
pub fn save_transcript_sidecar(wav_path: &Path, text: &str) {
    // Sanitize like the injection + Copy paths so the saved .txt matches what was actually typed
    // (drops control chars, keeps tab/LF) — the server text arrives here raw. A no-op for normal
    // natural-language transcripts; only strips stray control chars if the server ever emits them.
    let cleaned = crate::inject::sanitize_injected(text);
    let trimmed = cleaned.trim();
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
