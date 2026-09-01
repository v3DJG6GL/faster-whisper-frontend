//! Last-resort playback decode. Linux WebKitGTK without the proprietary
//! GStreamer plugin set cannot play AAC/MP4 — the format yt-dlp's `bestaudio`
//! picks — and feeding the same bytes back as a blob doesn't change that.
//! Symphonia decodes the file in-process (pure Rust, no system codecs) and
//! the viewer plays a plain PCM WAV blob instead. Fallback-path only: the
//! `<audio>` element gets two chances at the original bytes first.

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Decoded-PCM ceiling: ~1 h of 44.1 kHz stereo. Blobs beyond that would
/// strain the webview more than help it; the viewer then shows its honest
/// "can't be decoded" note instead.
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
    if out.exists() {
        // Touch the mtime so eviction is really least-RECENTLY-used: `prune_cache` orders by
        // mtime, and a pure read left the transcript replayed daily looking older than one
        // decoded yesterday and never played again. Best-effort.
        if let Ok(f) = std::fs::File::options().write(true).open(&out) {
            let _ = f.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()));
        }
        prune_cache(&dir, &out);
        return Ok(out.to_string_lossy().into_owned());
    }
    let wav = decode_to_wav(path)?;
    write_cached(&out, &wav)?;
    prune_cache(&dir, &out);
    Ok(out.to_string_lossy().into_owned())
}

/// tmp + rename, and no tmp left behind on EITHER failure — a WAV here can be hundreds of
/// MB, so ENOSPC mid-write is the realistic case (`save_text_file` has the same shape).
fn write_cached(out: &std::path::Path, wav: &[u8]) -> Result<(), String> {
    let tmp = out.with_extension("wav.tmp");
    if let Err(e) = std::fs::write(&tmp, wav) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    let _ = crate::audio::windows_owner_only_dacl(&tmp); // per-user cache dir; consistency only
    if let Err(e) = std::fs::rename(&tmp, out) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Keep the playback cache under `MAX_CACHE_BYTES`, deleting oldest-modified
/// first and never the file just written. Best-effort housekeeping.
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
    let (track_id, params) = format
        .tracks()
        .iter()
        .find_map(|t| match &t.codec_params {
            Some(CodecParameters::Audio(p)) => Some((t.id, p.clone())),
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
    // Header space reserved up front and patched in at the end: wrapping a
    // full PCM buffer afterwards doubled the peak (two ~640 MiB buffers live
    // at once) on the very path that exists to keep big decodes off the heap.
    let mut pcm: Vec<u8> = vec![0u8; 44];
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
        for s in &interleaved {
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        if pcm.len() - 44 > MAX_PCM_BYTES {
            return Err("audio too long to decode for playback".into());
        }
    }
    if pcm.len() == 44 {
        return Err("no decodable audio in the file".into());
    }
    let data_len = (pcm.len() - 44) as u32;
    pcm[..44].copy_from_slice(&crate::audio::wav_header(data_len, sample_rate, channels));
    Ok(pcm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_cache_write_leaves_no_tmp_behind() {
        let dir = std::env::temp_dir().join(format!("fwf-decode-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // `out` is an existing NON-EMPTY directory, so the rename into it fails.
        let out = dir.join("abc.wav");
        std::fs::create_dir_all(out.join("occupied")).unwrap();
        assert!(write_cached(&out, b"RIFF").is_err());
        assert!(!dir.join("abc.wav.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eviction_is_by_oldest_mtime_and_spares_the_kept_file() {
        let dir = std::env::temp_dir().join(format!("fwf-decode-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let big = vec![0u8; 1024];
        let stamp = |p: &std::path::Path, secs: u64| {
            let f = std::fs::File::options().write(true).open(p).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
        };
        let (old, mid, keep) = (dir.join("old.wav"), dir.join("mid.wav"), dir.join("keep.wav"));
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
}
