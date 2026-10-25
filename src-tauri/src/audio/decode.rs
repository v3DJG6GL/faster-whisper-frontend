//! Last-resort playback decode. Linux WebKitGTK without the proprietary
//! GStreamer plugin set cannot play AAC/MP4 — the format yt-dlp's `bestaudio`
//! picks — and feeding the same bytes back as a blob doesn't change that.
//! Symphonia decodes the file in-process (pure Rust, no system codecs) and
//! the viewer plays a cached plain PCM WAV file instead. Fallback-path only: the
//! `<audio>` element gets two chances at the original bytes first.

use crate::audio::{wav_header, WAV_HEADER_LEN};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Decoded-PCM ceiling: ~1 h of 44.1 kHz stereo. The whole decode is held in
/// memory before it is written to the cache, so this bounds that buffer; past it
/// the viewer shows its honest "can't be decoded" note instead.
const MAX_PCM_BYTES: usize = 640 * 1024 * 1024;

/// Playback-cache ceiling: decoded WAVs beyond this total are pruned
/// oldest-first (a 22-minute stereo YouTube audio is ~240 MB, so this
/// keeps a handful of recent transcripts instantly replayable).
const MAX_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

/// Decode a media file into a cached WAV on disk and return that path.
/// The viewer plays the cached file through the asset protocol — streaming
/// from disk like every dictation WAV, instead of holding a ~240 MB blob in
/// the web process (which WebKitGTK handles badly enough to freeze).
/// `Err("gone")` = the source file no longer exists (vs. a codec failure).
pub fn decode_to_cached_wav(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    let meta = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "gone".to_string()
        } else {
            e.to_string()
        }
    })?;
    let mut h = std::hash::DefaultHasher::new();
    path.hash(&mut h);
    meta.len().hash(&mut h);
    if let Ok(m) = meta.modified() {
        if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
            d.as_secs().hash(&mut h);
        }
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("playback");
    crate::audio::create_dir_private(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{:016x}.wav", h.finish()));
    cache_single_flight(&dir, &out, || decode_to_wav(path))?;
    Ok(out.to_string_lossy().into_owned())
}

/// Fill `out` from `decode` unless it is already cached — one caller per `out` at a time. The
/// viewer re-requests the decode on every open and never cancels the blocking one, so without
/// this a reopen mid-decode runs a second full decode (another up-to-640 MiB buffer). Waiters
/// share the leader's outcome: a success through the cache-hit branch, a failure through the
/// error stored in the slot (so queued opens don't re-run the same doomed decode). The slot
/// dies with its last holder, so a later fresh open retries.
fn cache_single_flight(
    dir: &std::path::Path,
    out: &std::path::Path,
    decode: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let slot = InflightSlot::acquire(out);
    let mut held = slot.lock();
    if out.exists() {
        // Touch the mtime so eviction (`prune_cache`, by mtime) is least-recently-used rather
        // than least-recently-decoded. Best-effort.
        if let Ok(f) = std::fs::File::options().write(true).open(out) {
            let _ =
                f.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()));
        }
        prune_cache(dir, out);
        return Ok(());
    }
    if let Some(e) = held.as_ref() {
        // Queued behind a failed run of this same flight.
        return Err(e.clone());
    }
    let result = decode().and_then(|wav| write_cached(out, &wav));
    if let Err(e) = &result {
        *held = Some(e.clone());
        return result;
    }
    prune_cache(dir, out);
    Ok(())
}

/// Per path: the flight's failure, if its leader failed (`None` while undecided or on success).
type InflightLock = std::sync::Arc<std::sync::Mutex<Option<String>>>;
type InflightMap = std::collections::HashMap<std::path::PathBuf, InflightLock>;

/// Per-output-path locks for `cache_single_flight`. Per path, not one global lock: a newly
/// opened DIFFERENT transcript must not queue behind a stale decode of another one.
static INFLIGHT: std::sync::LazyLock<std::sync::Mutex<InflightMap>> =
    std::sync::LazyLock::new(Default::default);

/// One caller's hold on an `INFLIGHT` entry; dropping it removes the entry once no other caller
/// holds it, so the map doesn't grow by one key per transcript ever opened.
struct InflightSlot {
    out: std::path::PathBuf,
    /// `Some` for the slot's whole life; `Drop` takes it to release it under the map lock.
    lock: Option<InflightLock>,
}

impl InflightSlot {
    fn acquire(out: &std::path::Path) -> Self {
        let mut map = INFLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        let lock = map.entry(out.to_path_buf()).or_default().clone();
        Self {
            out: out.to_path_buf(),
            lock: Some(lock),
        }
    }

    /// Poison-tolerant: a panicked decode stored no error, so the next waiter just retries.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        let lock = self.lock.as_ref().expect("held until drop");
        lock.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for InflightSlot {
    fn drop(&mut self) {
        let mut map = INFLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        // Every clone is taken AND released under the map lock, so 2 (the map's + ours) means
        // nobody else holds this path. Releasing ours after the map guard instead would let two
        // concurrent drops both count 3 and strand the entry, failed flight's error included.
        let lock = self.lock.take();
        if lock
            .as_ref()
            .is_some_and(|l| std::sync::Arc::strong_count(l) == 2)
        {
            map.remove(&self.out);
        }
        drop(lock);
    }
}

/// Through `replace_via_tmp` so a failed write leaves no tmp behind: a WAV here can be hundreds
/// of MB, so ENOSPC mid-write is the realistic case.
fn write_cached(out: &std::path::Path, wav: &[u8]) -> Result<(), String> {
    crate::config::replace_via_tmp(&cache_tmp_path(out), out, |t| {
        std::fs::write(t, wav)?;
        crate::audio::restrict_file_private(t); // per-user cache dir; consistency only
        Ok(())
    })
    .map_err(|e| e.to_string())
}

/// Tmp-file sequence: the pid alone is shared by every call in this process.
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A per-CALL unique tmp name. `cache_single_flight` already serialises the writers of one `out`
/// in this process; the `<pid>-<seq>` tag keeps every tmp name unique anyway (defence in depth:
/// a shared name would let one rename take another write's tmp, failing the second rename with
/// ENOENT) and lets `prune_cache_to` tell this process's in-flight tmp (skipped) from another
/// process's orphan (swept, see `cache_tmp_pid`).
fn cache_tmp_path(out: &std::path::Path) -> std::path::PathBuf {
    out.with_extension(format!(
        "wav.{:x}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

/// The writing pid of a `cache_tmp_path` name (`<hash>.wav.<hex pid>-<seq>.tmp`); `None` for
/// any other `.tmp` (e.g. an older build's pid-less `<hash>.wav.tmp`).
fn cache_tmp_pid(name: &str) -> Option<u32> {
    let (_, tag) = name.strip_suffix(".tmp")?.rsplit_once(".wav.")?;
    let (pid, seq) = tag.split_once('-')?;
    seq.parse::<u64>().ok()?;
    u32::from_str_radix(pid, 16).ok()
}

/// Keep the playback cache under `MAX_CACHE_BYTES`, deleting oldest-modified
/// first and never `keep` (the file about to be played). Best-effort housekeeping.
fn prune_cache(dir: &std::path::Path, keep: &std::path::Path) {
    prune_cache_to(dir, keep, MAX_CACHE_BYTES)
}

fn prune_cache_to(dir: &std::path::Path, keep: &std::path::Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() || p == keep {
                return None;
            }
            // Skip in-progress tmp files: a concurrent decode is writing to
            // `<hash>.wav.<pid>-<seq>.tmp` and will rename it on completion. Unlinking it
            // makes that rename fail with ENOENT and the viewer declares
            // playback broken for a file that decoded fine. Another pid's tmp is an orphan
            // (single-instance app; quit/crash doesn't wait for the blocking decode) that
            // nothing else would ever remove — sweep it. Tmps never count toward the total.
            if p.extension().is_some_and(|ext| ext == "tmp") {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                if cache_tmp_pid(name) != Some(std::process::id()) {
                    let _ = std::fs::remove_file(&p);
                }
                return None;
            }
            let m = e.metadata().ok()?;
            Some((p, m.modified().ok()?, m.len()))
        })
        .collect();
    let keep_len = std::fs::metadata(keep).map(|m| m.len()).unwrap_or(0);
    let mut total: u64 = keep_len + files.iter().map(|f| f.2).sum::<u64>();
    files.sort_by_key(|f| f.1);
    for (p, _, len) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// Decode any symphonia-supported audio file to 16-bit interleaved WAV
/// bytes at the source rate and channel count.
pub fn decode_to_wav(path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
    {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("unrecognized container: {e}"))?;
    let (track_id, params, num_frames) = format
        .tracks()
        .iter()
        .find_map(|t| match &t.codec_params {
            Some(CodecParameters::Audio(p)) => Some((t.id, p.clone(), t.num_frames)),
            _ => None,
        })
        .ok_or("no audio track")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut sample_rate: u32 = params.sample_rate.unwrap_or(44_100);
    let mut channels: u16 = params
        .channels
        .as_ref()
        .map(|c| c.count() as u16)
        .unwrap_or(2);
    // Header space reserved up front and patched in at the end: wrapping the
    // finished PCM afterwards would hold two ~640 MiB buffers at once.
    let mut pcm: Vec<u8> = vec![0u8; WAV_HEADER_LEN];
    // Size the buffer from the header's frame count so the extend loop below
    // doesn't leave Vec's doubling slack (up to ~2x) behind a big decode. A
    // hint only — mid-stream channel changes and missing num_frames still
    // grow normally; +1 MiB absorbs padding/priming frames so the last
    // extend doesn't trigger a full doubling. `try_reserve_exact` (never
    // `reserve_exact`): the count is untrusted, so a bogus header must not
    // abort the process — it just falls back to normal growth.
    if let Some(n) = num_frames {
        let hint = n
            .saturating_mul(channels as u64)
            .saturating_mul(2)
            .saturating_add(1 << 20)
            .min(MAX_PCM_BYTES as u64) as usize;
        let _ = pcm.try_reserve_exact(hint);
    }
    let mut interleaved: Vec<i16> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            // End of stream; ResetRequired only occurs mid-chained-stream —
            // treat both as "done" for a finite local file.
            Ok(None) | Err(SymErr::ResetRequired) => break,
            Err(e) => return Err(format!("read failed: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A corrupt frame mid-file is survivable — skip it.
            Err(SymErr::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode failed: {e}")),
        };
        let spec = decoded.spec();
        sample_rate = spec.rate();
        channels = spec.channels().count() as u16;
        decoded.copy_to_vec_interleaved::<i16>(&mut interleaved);
        // Bulk-copy the whole packet: a per-sample push would cost hundreds of
        // millions of capacity checks and tiny memcpys at these sizes (~640 MB).
        let byte_slice = unsafe {
            std::slice::from_raw_parts(
                interleaved.as_ptr() as *const u8,
                interleaved.len() * std::mem::size_of::<i16>(),
            )
        };
        if pcm.len() - WAV_HEADER_LEN + byte_slice.len() > MAX_PCM_BYTES {
            return Err("audio too long to decode for playback".into());
        }
        pcm.extend_from_slice(byte_slice);
    }
    if pcm.len() == WAV_HEADER_LEN {
        return Err("no decodable audio in the file".into());
    }
    let data_len = (pcm.len() - WAV_HEADER_LEN) as u32;
    pcm[..WAV_HEADER_LEN].copy_from_slice(&wav_header(data_len, sample_rate, channels));
    Ok(pcm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_cache_write_leaves_no_tmp_behind() {
        let dir = crate::audio::scratch_dir("decode-cache");
        // `out` is an existing NON-EMPTY directory, so the rename into it fails.
        let out = dir.join("abc.wav");
        std::fs::create_dir_all(out.join("occupied")).unwrap();
        assert!(write_cached(&out, b"RIFF").is_err());
        let tmps = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .count();
        assert_eq!(tmps, 0, "no tmp file is left in the cache dir");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_cache_writes_of_one_file_get_distinct_tmp_names() {
        let out = std::path::Path::new("/cache/abc.wav");
        let (a, b) = (cache_tmp_path(out), cache_tmp_path(out));
        assert_ne!(a, b, "a shared tmp lets one rename steal the other's");
        assert!(a.extension().is_some_and(|x| x == "tmp"));
    }

    #[test]
    fn eviction_is_by_oldest_mtime_and_spares_the_kept_file() {
        let dir = crate::audio::scratch_dir("decode-prune");
        let big = vec![0u8; 1024];
        let stamp = |p: &std::path::Path, secs: u64| {
            let f = std::fs::File::options().write(true).open(p).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            f.set_times(std::fs::FileTimes::new().set_modified(t))
                .unwrap();
        };
        let (old, mid, keep) = (
            dir.join("old.wav"),
            dir.join("mid.wav"),
            dir.join("keep.wav"),
        );
        for p in [&old, &mid, &keep] {
            std::fs::write(p, &big).unwrap();
        }
        stamp(&old, 1_000_000);
        stamp(&mid, 2_000_000);
        stamp(&keep, 500_000); // oldest of all, but it is the one just written

        // Force eviction of exactly one file by pretending the ceiling is tiny.
        prune_cache_to(&dir, &keep, 2 * 1024 + 512);
        assert!(!old.exists(), "the oldest-modified file is evicted first");
        assert!(mid.exists());
        assert!(keep.exists(), "the file just written is never evicted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_sweeps_other_processes_tmps_but_not_its_own() {
        let dir = crate::audio::scratch_dir("decode-tmps");
        let own = std::process::id();
        let foreign = if own == 1 { 2 } else { own - 1 };
        let keep = dir.join("keep.wav");
        let foreign_tmp = dir.join(format!("abc.wav.{foreign:x}-0.tmp"));
        let own_tmp = dir.join(format!("abc.wav.{own:x}-0.tmp"));
        let plain_tmp = dir.join("abc.wav.tmp");
        for p in [&keep, &foreign_tmp, &own_tmp, &plain_tmp] {
            std::fs::write(p, b"RIFF").unwrap();
        }
        assert_eq!(cache_tmp_pid(&format!("abc.wav.{own:x}-7.tmp")), Some(own));
        prune_cache_to(&dir, &keep, u64::MAX);
        assert!(!foreign_tmp.exists(), "a dead process's tmp is an orphan");
        assert!(
            !plain_tmp.exists(),
            "a pid-less tmp from an older build is an orphan"
        );
        assert!(
            own_tmp.exists(),
            "this process's in-flight write is left alone"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_requests_for_one_output_decode_once() {
        let dir = crate::audio::scratch_dir("decode-flight");
        let out = dir.join("abc.wav");
        let decodes = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..2 {
                s.spawn(|| {
                    cache_single_flight(&dir, &out, || {
                        decodes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        Ok(b"RIFF".to_vec())
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(
            decodes.into_inner(),
            1,
            "the second request waits for the first's file"
        );
        assert!(out.exists());
        assert!(
            !INFLIGHT.lock().unwrap().contains_key(&out),
            "the in-flight entry is released afterwards"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn waiters_share_a_failed_decode_and_a_later_open_retries() {
        let dir = crate::audio::scratch_dir("decode-fail");
        let out = dir.join("abc.wav");
        let decodes = std::sync::atomic::AtomicUsize::new(0);
        let failing = || {
            decodes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(200));
            Err::<Vec<u8>, _>("x".to_string())
        };
        std::thread::scope(|s| {
            let calls: Vec<_> = (0..2)
                .map(|_| s.spawn(|| cache_single_flight(&dir, &out, failing)))
                .collect();
            for c in calls {
                assert_eq!(c.join().unwrap(), Err("x".to_string()));
            }
        });
        assert_eq!(
            decodes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the waiter takes the leader's error instead of re-running the decode"
        );
        assert!(!INFLIGHT.lock().unwrap().contains_key(&out));
        assert_eq!(
            cache_single_flight(&dir, &out, failing),
            Err("x".to_string())
        );
        assert_eq!(
            decodes.into_inner(),
            2,
            "a fresh open after the flight retries"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn holders_dropping_together_never_strand_the_entry() {
        // Two holders of one slot dropping at the same moment: each must see the other's
        // release, or both count 3, the entry outlives them, and a later fresh open is handed
        // the dead flight's error without decoding.
        let out =
            std::path::PathBuf::from(format!("/fwf-decode-drop-{}/abc.wav", std::process::id()));
        for _ in 0..20_000 {
            let (a, b) = (InflightSlot::acquire(&out), InflightSlot::acquire(&out));
            let go = std::sync::Barrier::new(2);
            std::thread::scope(|s| {
                s.spawn(|| {
                    go.wait();
                    drop(a);
                });
                go.wait();
                drop(b);
            });
            assert!(
                !INFLIGHT.lock().unwrap().contains_key(&out),
                "the last of two concurrent releases removes the entry"
            );
        }
    }
}
