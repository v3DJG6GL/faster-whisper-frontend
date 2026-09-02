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
    publish_levels_with_live(app, event, level, stop, None);
}

/// Like [`publish_levels`], but also announces the mic going LIVE: when `mic_live` (fed by the
/// capture callback's raw-RMS detector, see `session::LiveDetect`) flips true, emit a one-shot
/// `stream://mic-live`. The frontend clears its "warming up…" gate on it — the smoothed+gained
/// level it also receives passes through an EMA from 0 and a threshold a quiet mic's noise floor
/// only hovers AT, so on such mics the level-based gate held the chip grey until the user actually
/// spoke. Ungated by the session epoch for the same reason level emits are: the capture thread is
/// always joined before the next session starts, so it can't outlive its session.
pub fn publish_levels_with_live(
    app: &AppHandle,
    event: &str,
    level: &AtomicU32,
    stop: &AtomicBool,
    mic_live: Option<&AtomicBool>,
) {
    let mut announced = false;
    while !stop.load(Ordering::SeqCst) {
        if !announced {
            if let Some(flag) = mic_live {
                if flag.load(Ordering::Relaxed) {
                    announced = true;
                    let _ = app.emit("stream://mic-live", ());
                }
            }
        }
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

/// The 44-byte canonical PCM WAV header for `data_len` bytes of 16-bit samples.
pub fn wav_header(data_len: u32, sample_rate: u32, channels: u16) -> [u8; 44] {
    let bits: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let mut h = [0u8; 44];
    let mut at = 0usize;
    let mut put = |b: &[u8]| {
        h[at..at + b.len()].copy_from_slice(b);
        at += b.len();
    };
    put(b"RIFF");
    put(&(36 + data_len).to_le_bytes());
    put(b"WAVE");
    put(b"fmt ");
    put(&16u32.to_le_bytes());
    put(&1u16.to_le_bytes()); // PCM
    put(&channels.to_le_bytes());
    put(&sample_rate.to_le_bytes());
    put(&byte_rate.to_le_bytes());
    put(&block_align.to_le_bytes());
    put(&bits.to_le_bytes());
    put(b"data");
    put(&data_len.to_le_bytes());
    h
}

/// Wrap interleaved 16-bit little-endian PCM in a minimal WAV container.
pub fn wav_from_pcm16(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(&wav_header(pcm.len() as u32, sample_rate, channels));
    wav.extend_from_slice(pcm);
    wav
}

/// The two file names this app writes into the dictations folder — `dictation-*.wav`
/// and its `.txt` sidecar. Everything else in a user-chosen folder is somebody else's
/// data: never moved by the layout migration, never deleted by prune or delete-all.
pub fn is_dictation_file(name: &str) -> bool {
    name.starts_with("dictation-") && (name.ends_with(".wav") || name.ends_with(".txt"))
}

/// Delete saved recordings and their transcript sidecars older than `days` (0 = keep forever).
/// Best-effort and silent on I/O errors: retention is housekeeping, and a failure here must
/// never interrupt a dictation. Only touches the files this app writes — `dictation-*.wav` and
/// the `.txt` sidecar next to each — so pointing the recordings folder at a shared directory
/// can't make it delete anything else.
pub fn prune_recordings(dir: &Path, days: u32) -> usize {
    if days == 0 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    // Clamp before the arithmetic. `days` is a u32 that arrives from config — and the `recording`
    // sync category carries it, so a peer's blob sets it with no numeric validation on the way in.
    // On Windows the subtraction converts the span to 100 ns intervals in an i64, which overflows
    // once the window passes ~10.7 million days, and `SystemTime: Sub<Duration>` panics rather than
    // returning an error — inside `setup()`, on every launch, with the value already persisted.
    // Ten years is far past any real retention window and 0 still means "keep forever".
    const MAX_RETENTION_DAYS: u32 = 3650;
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(days.min(MAX_RETENTION_DAYS) as u64 * 86_400);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_dictation_file(&name) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        let effective = days.min(MAX_RETENTION_DAYS);
        tracing::info!("[record] retention: removed {removed} file(s) older than {effective}d");
    }
    removed
}

/// Create a file that must not already exist and that only the owner can read.
///
/// The saved recordings are the most sensitive thing this app writes: a `.wav` of everything
/// dictated and a `.txt` of its verbatim transcript. `std::fs::write` created them `0666 & ~umask`
/// — typically world-readable 0644 — and the recordings folder is user-chosen, so that mode is
/// what actually decides who can read the archive when it is not under the app's private dir.
///
/// `create_new` also closes the gap the `path.exists()` collision loop left open: `exists()`
/// follows symlinks and is separated from the write by a TOCTOU window, so anyone able to create
/// entries in that folder could pre-plant a link named for a coming second and have the
/// server-supplied transcript written through it. `create_new` fails on an existing name of any
/// kind, symlink included.
fn write_new_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    // The Windows half of "owner-only": a file inherits the DACL of its folder, and a folder
    // that already existed when the user picked it (a synced tree, a restore from backup) kept
    // whatever permissions it had — nothing on the file itself compensated. Best-effort, like
    // the directory call.
    #[cfg(windows)]
    if let Err(e) = windows_owner_only_dacl(path) {
        tracing::warn!("[audio] could not restrict {} to the current user: {e}", path.display());
    }
    if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
        let _ = std::fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

/// Create the recordings directory owner-only — 0700 on Unix, an owner-only inheritable DACL on
/// Windows.
///
/// The files themselves are owner-only since `write_new_private` (0600 on Unix, an owner-only DACL
/// on Windows), but the containing directory was
/// still created with `create_dir_all`'s default (0777 & ~umask, typically 0755) — and the folder
/// is USER-CHOSEN, so it may sit somewhere shared. A listing of it is a per-second timestamped log
/// of every dictation the user made: when they dictate, how often, and how large the archive is.
/// A directory that already exists keeps whatever permissions the user gave it.
///
/// Both halves used to be `#[cfg(unix)]`, so on Windows the promise this function's name makes was
/// simply not kept: the directory took its parent's inherited ACL, and so did every `.wav` and its
/// verbatim `.txt` transcript. A folder outside the user profile — `C:\Users\Public`, a mapped
/// share, a OneDrive or Dropbox folder — therefore left the recordings readable by other local
/// accounts and to whatever sync client owns that tree.
pub fn create_dir_private(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        if dir.exists() {
            return Ok(());
        }
        // The LEAF is owner-only; missing ancestors get the default mode. A recursive 0700
        // builder locked down every intermediate directory it had to create — a parent the
        // app has no claim on (`~/Nextcloud/Voice` for a base of `~/Nextcloud/Voice/whisper`)
        // — where the Windows branch below applies its DACL to `dir` alone.
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // The recursive builder this replaced was idempotent; a concurrent creator (two media
        // copies racing for `files/`, a sync client restoring the tree) must not fail the caller.
        return match std::fs::DirBuilder::new().mode(0o700).create(dir) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            r => r,
        };
    }
    #[cfg(windows)]
    {
        if dir.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(dir)?;
        // Best-effort, deliberately: a failure here must not stop the user recording. It is logged
        // so a broken ACL is diagnosable rather than silent.
        if let Err(e) = windows_owner_only_dacl(dir) {
            tracing::warn!("[audio] could not restrict {} to the current user: {e}", dir.display());
        }
        return Ok(());
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Replace `dir`'s DACL with a single inheritable ACE granting the current user full control, and
/// mark it PROTECTED so the parent's inherited entries do not apply. New files created inside
/// inherit that one ACE, which is what carries the guarantee to the `.wav`/`.txt` pairs.
#[cfg(windows)]
pub(crate) fn windows_owner_only_dacl(dir: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE,
        SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const FILE_ALL_ACCESS: u32 = 0x001F_01FF;

    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);

    unsafe {
        // The current user's SID, read out of this process's own token.
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut needed: u32 = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        // Back the buffer with u64 so the pointer meets TOKEN_USER's alignment
        // requirement (8 on x64). A Vec<u8> only guarantees 1-byte alignment,
        // and casting through a misaligned pointer is UB regardless of what the
        // global allocator happens to return.
        let u64_len = (needed.max(1) as usize + 7) / 8;
        let mut buf = vec![0u64; u64_len];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        windows_sys::Win32::Foundation::CloseHandle(token);
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let sid = (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid;

        let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
        ea.grfAccessPermissions = FILE_ALL_ACCESS;
        ea.grfAccessMode = SET_ACCESS;
        ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
        ea.Trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid.cast(),
        };

        let mut acl: *mut ACL = std::ptr::null_mut();
        let rc = SetEntriesInAclW(1, &ea, std::ptr::null_mut(), &mut acl);
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc as i32));
        }
        let rc = SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null_mut(),
        );
        if !acl.is_null() {
            LocalFree(acl.cast());
        }
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc as i32));
        }
    }
    Ok(())
}

/// Save mono s16le PCM as a timestamped `.wav` under `dir`; returns the saved path on
/// success (so the caller can write a transcript sidecar next to it). Best-effort: logs
/// and returns None on any I/O error rather than failing the dictation.
///
/// See [`create_dir_private`] for why the directory itself is owner-only.
pub fn save_recording(dir: &Path, pcm: &[u8], sample_rate: u32) -> Option<PathBuf> {
    if pcm.is_empty() {
        return None;
    }
    if let Err(e) = create_dir_private(dir) {
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
    match write_new_private(&path, &wav_from_pcm16(pcm, sample_rate, 1)) {
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
/// chip shows as "speaking" plus a short lead-in, so a long hands-free session doesn't store
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
    if let Err(e) = write_new_private(&txt_path, format!("{trimmed}\n").as_bytes()) {
        tracing::warn!("[record] could not write transcript sidecar: {e}");
    } else {
        tracing::info!("[record] transcript saved {}", txt_path.display());
    }
}

#[cfg(test)]
mod retention_tests {
    #[cfg(unix)]
    #[test]
    fn private_dir_locks_down_the_leaf_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("fwf-private-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let leaf = root.join("a").join("b").join("leaf");
        super::create_dir_private(&leaf).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&leaf), 0o700);
        assert_ne!(mode(&root.join("a")), 0o700);
        assert_ne!(mode(&root.join("a").join("b")), 0o700);
        // Idempotent, like the recursive builder it replaced: a second (or racing) creator is Ok.
        super::create_dir_private(&leaf).unwrap();
        assert_eq!(mode(&leaf), 0o700);
        let _ = std::fs::remove_dir_all(&root);
    }

    use super::*;

    #[test]
    fn wav_header_matches_the_full_wrapper() {
        let n = 1000usize;
        let full = wav_from_pcm16(&vec![0u8; n], 44_100, 2);
        assert_eq!(full.len(), 44 + n);
        assert_eq!(&full[..44], &wav_header(n as u32, 44_100, 2)[..]);
        assert_eq!(&full[..4], b"RIFF");
        assert_eq!(&full[36..40], b"data");
    }

    /// Write `name` into `dir` with an mtime `age_days` in the past.
    fn seed(dir: &Path, name: &str, age_days: u64) {
        let p = dir.join(name);
        std::fs::write(&p, b"x").unwrap();
        let when = std::time::SystemTime::now() - Duration::from_secs(age_days * 86_400);
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(when).unwrap();
    }

    /// A retention window a peer's sync blob can set must not reach the `SystemTime` subtraction
    /// unclamped: on Windows the span is converted to 100ns intervals in an i64, which overflows
    /// past ~10.7 million days and PANICS inside `setup()` on every launch once persisted.
    #[test]
    fn an_absurd_retention_window_is_clamped_not_fatal() {
        let dir = std::env::temp_dir().join(format!("fwf-retention-clamp-{}", std::process::id()).as_str());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed(&dir, "dictation-old.wav", 400);
        // u32::MAX days is ~11.7 million years; clamped, this is simply "keep everything".
        assert_eq!(prune_recordings(&dir, u32::MAX), 0);
        assert!(dir.join("dictation-old.wav").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `create_new` must refuse an existing name, so a pre-planted entry in a shared recordings
    /// folder cannot have the server-supplied transcript written through it.
    #[test]
    fn a_transcript_never_overwrites_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("fwf-sidecar-nofollow-{}", std::process::id()).as_str());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("dictation-x.txt");
        std::fs::write(&victim, b"original").unwrap();
        save_transcript_sidecar(&dir.join("dictation-x.wav"), "replacement text");
        assert_eq!(std::fs::read(&victim).unwrap(), b"original");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_everything_when_retention_is_off() {
        let dir = std::env::temp_dir().join(format!("fwf-retention-off-{}", std::process::id()).as_str());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed(&dir, "dictation-old.wav", 400);
        assert_eq!(prune_recordings(&dir, 0), 0);
        assert!(dir.join("dictation-old.wav").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removes_only_our_files_past_the_window() {
        let dir = std::env::temp_dir().join(format!("fwf-retention-window-{}", std::process::id()).as_str());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed(&dir, "dictation-old.wav", 40);
        seed(&dir, "dictation-old.txt", 40);
        seed(&dir, "dictation-fresh.wav", 2);
        // Someone else's file in a shared folder, old enough to qualify on age alone.
        seed(&dir, "important-tax-return.wav", 400);
        seed(&dir, "notes.txt", 400);

        assert_eq!(prune_recordings(&dir, 30), 2);
        assert!(!dir.join("dictation-old.wav").exists());
        assert!(!dir.join("dictation-old.txt").exists());
        assert!(dir.join("dictation-fresh.wav").exists());
        assert!(dir.join("important-tax-return.wav").exists());
        assert!(dir.join("notes.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_is_not_an_error() {
        assert_eq!(prune_recordings(Path::new("/nonexistent/fwf/x"), 30), 0);
    }
}
