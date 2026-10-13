//! The audio base folder (layout, move, open) and the file I/O commands: media reads
//! for playback, text save/read, opening a source link, reveal in the file manager.

use super::{audio_base_pref, resolve_audio_base, AUDIO_SUBDIRS, HEAL_STAMP};
use crate::config::Config;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Absolute path of the active audio base folder (custom or default), for
/// display in Settings — a leading `$HOME` is collapsed to `~`.
#[tauri::command]
pub fn audio_dir_path(app: AppHandle, custom: Option<String>) -> Option<String> {
    let dir = resolve_audio_base(&app, custom)?;
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Some(format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()));
        }
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Open the active audio base folder in the system file manager. Creates it
/// (with its subfolders) first so the button works before the first run.
/// async + spawn_blocking: a sync command runs on the main thread, and the base can sit on a
/// slow or stalled mount (network share, sleeping disk).
#[tauri::command]
pub async fn open_audio_dir(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = resolve_audio_base(&app, custom).ok_or("could not resolve the audio folder")?;
        crate::audio::create_dir_private(&dir)
            .map_err(|e| format!("could not create the folder: {e}"))?;
        for sub in AUDIO_SUBDIRS {
            let _ = crate::audio::create_dir_private(&dir.join(sub));
        }
        // Not the bare plugin call: the file manager it may cold-start must not inherit the
        // env vars this process injected for itself (see `crate::open_external`).
        crate::open_external(&app, &dir.to_string_lossy())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move one file across a possible filesystem boundary: rename, else
/// copy + remove (verified by the copy's success).
fn move_file(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest)?;
    // Owner-only on both platforms: on Windows the copy otherwise takes the DACL of a
    // destination folder that may have pre-existed the pick (`create_dir_private` skips it).
    crate::audio::restrict_file_private(dest);
    std::fs::remove_file(src)
}

/// Move every regular file from `from` into `to`, recording old→new paths.
/// Stops on the first error; already-moved files stay moved and are in `map`,
/// which the caller rewrites into the records even on failure (they store
/// absolute paths, so nothing else would re-point them).
fn move_dir_contents(
    from: &std::path::Path,
    to: &std::path::Path,
    map: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(from) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("could not read {}: {e}", from.display())),
    };
    crate::audio::create_dir_private(to).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        // An in-progress media copy (`<id>.<ext>.tmp`, see save_transcript_media) finishes in
        // the old base and its record keeps a valid absolute path; moving it under the writer
        // fails the copier's final rename and strands a `.tmp` every sweep skips forever.
        if src.extension().and_then(|e| e.to_str()) == Some("tmp") {
            continue;
        }
        let Some(name) = src.file_name() else {
            continue;
        };
        let dest = to.join(name);
        // Never clobber (the layout migration's rule, applied to the relocation too): a base
        // that already holds a same-named file — a second install pointed at one synced folder,
        // a re-run after a partial move — keeps it, and the record still points at the source.
        if dest.exists() {
            tracing::warn!(
                "[audio] not moving {} — {} already exists",
                src.display(),
                dest.display()
            );
            continue;
        }
        move_file(&src, &dest).map_err(|e| format!("could not move {}: {e}", src.display()))?;
        map.push((
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        ));
    }
    let _ = std::fs::remove_dir(from); // only removes if now empty
    Ok(())
}

/// Fix `mediaPath` inside every history record that pointed at a moved file. False when a
/// record that pointed at one could not be rewritten.
fn rewrite_media_paths(app: &AppHandle, map: &[(String, String)]) -> bool {
    if map.is_empty() {
        return true;
    }
    let lookup: std::collections::HashMap<&str, &str> =
        map.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    crate::store::transcripts::rewrite_media_paths(app, &lookup)
}

/// A one-way latch: closed until `open`, then every `wait` returns at once.
pub(crate) struct Gate {
    open: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

impl Gate {
    pub(crate) const fn new() -> Self {
        Self {
            open: std::sync::Mutex::new(false),
            cv: std::sync::Condvar::new(),
        }
    }

    pub(crate) fn open(&self) {
        *self.open.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    pub(crate) fn wait(&self) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        while !*open {
            open = self.cv.wait(open).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// Opens once this launch's `ensure_audio_layout` is over (done, panicked, or never started).
static AUDIO_LAYOUT: Gate = Gate::new();

/// Run this launch's `ensure_audio_layout` on its own thread. setup() runs on the main thread
/// before the event loop, and the base can sit on a stalled mount (an offline network share, a
/// sleeping disk) whose mkdir/read_dir blocks without limit: launch must not wait on it (the
/// log folder's open is queued for the same reason). What must not overlap a half-done move
/// waits on [`wait_audio_layout`] instead: the retention sweeps (they look in the new layout)
/// and `move_audio_base` (it moves the same subfolders). Every writer creates its own folder,
/// and the records live in app data, so nothing else depends on the layout being in place; a
/// History listing taken before a migration moved something is told to reload when it is done.
pub(crate) fn queue_audio_layout(app: &AppHandle, config: Config) {
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("audio-layout".into())
        .spawn(move || {
            // A panic must not leave the sweeps and a base move waiting on a gate nobody opens.
            let changed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ensure_audio_layout(&app, &config)
            }))
            .unwrap_or(true);
            AUDIO_LAYOUT.open();
            // A History listing taken while this ran may hold the pre-move paths: have it
            // reload, or it plays (and an edit re-saves) them. Nothing went, so `removed: 0`
            // and `dictationsWiped: false`.
            if changed {
                use tauri::Emitter;
                let _ = app.emit(
                    "transcripts://swept",
                    serde_json::json!({ "removed": 0, "dictationsWiped": false }),
                );
            }
        });
    // Nor may a thread that never started: the migration is idempotent and retried next launch.
    if let Err(e) = started {
        tracing::warn!("[audio] could not start the audio-layout worker: {e}");
        AUDIO_LAYOUT.open();
    }
}

/// Block until this launch's audio-layout job is over (see [`queue_audio_layout`]).
pub(crate) fn wait_audio_layout() {
    AUDIO_LAYOUT.wait();
}

/// One-time (idempotent) migration into the single-base layout: legacy saved
/// recordings move into `<base>/dictations`, the old app-data media store
/// splits into `<base>/files` + `<base>/links` by record kind. Run once per
/// launch, off the main thread (`queue_audio_layout`); the retention sweeps
/// wait for it. True when it rewrote or healed records' media paths.
fn ensure_audio_layout(app: &AppHandle, config: &Config) -> bool {
    let pref = audio_base_pref(&config.settings);
    let Some(base) = resolve_audio_base(app, pref.clone()) else {
        return false;
    };
    let _ = crate::audio::create_dir_private(&base);
    for sub in AUDIO_SUBDIRS {
        let _ = crate::audio::create_dir_private(&base.join(sub));
    }
    let mut map: Vec<(String, String)> = Vec::new();
    // Legacy recordings: the custom folder (which may BE the new base — then
    // its loose .wav/.txt files just move down into dictations/) or the old
    // app-data default.
    let legacy_rec = match &pref {
        Some(p) => PathBuf::from(p),
        None => match app.path().app_data_dir() {
            Ok(d) => d.join("recordings"),
            Err(_) => return false,
        },
    };
    let dict = base.join("dictations");
    if legacy_rec != dict {
        if let Ok(entries) = std::fs::read_dir(&legacy_rec) {
            for entry in entries.flatten() {
                let src = entry.path();
                let Some(name) = src.file_name() else {
                    continue;
                };
                // Only the app's own files: the legacy folder is a free user pick (~/Music,
                // a shared Documents folder…), and relocating every .wav/.txt in it moved
                // foreign files under a folder "Delete all dictations" then wipes.
                if !src.is_file() || !crate::audio::is_dictation_file(&name.to_string_lossy()) {
                    continue;
                }
                let dest = dict.join(name);
                if dest.exists() {
                    continue; // never clobber
                }
                if move_file(&src, &dest).is_ok() {
                    map.push((
                        src.to_string_lossy().into_owned(),
                        dest.to_string_lossy().into_owned(),
                    ));
                }
            }
            if legacy_rec.file_name().and_then(|n| n.to_str()) == Some("recordings") {
                let _ = std::fs::remove_dir(&legacy_rec);
            }
        }
    }
    // Legacy media store: split by record kind (url → links, else files).
    if let Ok(legacy_media) = crate::store::transcripts::legacy_media_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&legacy_media) {
            for entry in entries.flatten() {
                let src = entry.path();
                if !src.is_file() {
                    continue;
                }
                let Some(name) = src.file_name() else {
                    continue;
                };
                let stem = src
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let sub = if crate::store::transcripts::record_kind(app, &stem).as_deref()
                    == Some("url")
                {
                    "links"
                } else {
                    "files"
                };
                let dest = base.join(sub).join(name);
                if dest.exists() {
                    continue;
                }
                if move_file(&src, &dest).is_ok() {
                    map.push((
                        src.to_string_lossy().into_owned(),
                        dest.to_string_lossy().into_owned(),
                    ));
                }
            }
            let _ = std::fs::remove_dir(&legacy_media);
        }
    }
    if !map.is_empty() {
        tracing::info!(
            "[audio] layout migration moved {} file(s) under {}",
            map.len(),
            base.display()
        );
        rewrite_media_paths(app, &map);
    }
    // Repair records a past (incomplete) rewrite left pointing at moved files. One
    // full read+parse of every record, so NOT every launch: after a migration that
    // moved something, and once per install (the stamp); `move_audio_base` heals
    // directly through its own rewrite.
    // A fresh install with no records skips the scan entirely and only stamps; the expensive
    // read+parse is reserved for a base that actually has history to heal.
    // The stamp is written only once the heal reached every record (and dropped when it did
    // not, even if a past heal left one), so a record a sync client or antivirus held, or an
    // unlistable history folder, is retried on the next launch; a permanently unreadable
    // record re-runs the scan each launch while it exists — the same read+parse the History
    // listing does, accepted.
    // A base that is no folder (an unplugged drive, an offline share, a broken link) can heal
    // nothing — every candidate lives under it — and cannot take the stamp either, so the scan
    // would repeat on every offline launch; skip it and leave the heal armed for when it is back.
    // (A migration that moved something moved it INTO the base, so it is a folder then.)
    if !base.is_dir() {
        tracing::info!(
            "[audio] audio folder {} unavailable; media-path repair left for a later launch",
            base.display()
        );
        return !map.is_empty();
    }
    let stamp = base.join(HEAL_STAMP);
    if !stamp.exists() && map.is_empty() && !crate::store::transcripts::has_any_records(app) {
        let _ = std::fs::write(&stamp, b"");
    } else if !map.is_empty() || !stamp.exists() {
        if crate::store::transcripts::heal_media_paths(app, &base) {
            let _ = std::fs::write(&stamp, b"");
        } else {
            let _ = std::fs::remove_file(&stamp);
        }
        return true;
    }
    !map.is_empty()
}

/// Relocate the whole audio store: move every media subfolder (`AUDIO_SUBDIRS`:
/// dictations, files, links, video) from the current base to the next one and fix
/// the records' stored paths. The caller (the Settings screen) persists the new
/// setting only after this returns Ok — never save-then-hope. On Err the records
/// that DID move are already rewritten on disk, so the caller must reload history
/// either way, or its mirror writes the pre-move paths back on the next edit.
#[tauri::command]
pub async fn move_audio_base(
    app: AppHandle,
    current: Option<String>,
    next: Option<String>,
) -> Result<(), String> {
    let from = resolve_audio_base(&app, current).ok_or("could not resolve the audio folder")?;
    let to = resolve_audio_base(&app, next).ok_or("could not resolve the new folder")?;
    if from == to {
        return Ok(());
    }
    if to.starts_with(&from) {
        return Err("the new folder can't be inside the current one".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Not under a launch layout migration still moving files into these same subfolders.
        wait_audio_layout();
        crate::audio::create_dir_private(&to)
            .map_err(|e| format!("could not create the folder: {e}"))?;
        let mut map: Vec<(String, String)> = Vec::new();
        let mut res: Result<(), String> = Ok(());
        for sub in AUDIO_SUBDIRS {
            if let Err(e) = move_dir_contents(&from.join(sub), &to.join(sub), &mut map) {
                res = Err(e);
                break;
            }
        }
        // Move the heal stamp so the new base is stamped and the old one is clean.
        // Without this the old base keeps a stray stamp (blocking the remove_dir
        // below) and the new one re-runs the full heal scan on the next launch.
        // A missing old stamp means a heal is still pending (a failed rewrite or
        // identifier migration dropped it): that must travel to the new base too, so
        // a stray stamp already there is cleared instead of masking it.
        // Rename first: it is a no-op when both paths name the same folder (case-only
        // difference, symlink). Across drives it fails (EXDEV); the stamp is an empty
        // marker, so write + remove is the move then.
        let (old_stamp, new_stamp) = (from.join(HEAL_STAMP), to.join(HEAL_STAMP));
        if !old_stamp.exists() {
            let _ = std::fs::remove_file(&new_stamp);
        } else if std::fs::rename(&old_stamp, &new_stamp).is_err() {
            let _ = std::fs::write(&new_stamp, b"");
            let _ = std::fs::remove_file(&old_stamp);
        }
        let _ = std::fs::remove_dir(&from); // only if empty

        // Always re-point what actually moved: records store ABSOLUTE paths, and a
        // partial move leaves the preference on the old base, which the startup heal
        // then searches — so an unrewritten record would stay broken for good.
        if !rewrite_media_paths(&app, &map) {
            // A record that pointed at a moved file could not be rewritten: drop the stamp so
            // the next launch's heal re-points it by basename under the new base (the same
            // remedy as the identifier migration).
            let _ = std::fs::remove_file(&new_stamp);
        }
        match &res {
            Ok(()) => tracing::info!(
                "[audio] base moved: {} file(s) → {}",
                map.len(),
                to.display()
            ),
            Err(e) => tracing::warn!(
                "[audio] base move stopped after {} file(s) moved to {}: {e}",
                map.len(),
                to.display()
            ),
        }
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The exact refusal text the viewer matches on to fall back to the decode path.
pub const MEDIA_TOO_LARGE: &str = "too large to buffer";

/// Read a media file the user picked into memory for in-card playback. The
/// asset-protocol path is preferred, but Linux WebKitGTK's media stack is
/// unreliable over custom URI schemes — when the <audio> element errors, the
/// webview falls back to this and plays from a blob URL. Raw IPC response
/// (no base64/JSON round-trip); capped so a mispicked multi-GB video can't
/// balloon the webview.
#[tauri::command]
pub async fn read_media_file(path: String) -> Result<tauri::ipc::Response, String> {
    // Below the ~240 MB at which handing the bytes over IPC froze the web process (see
    // `decode_media_file`), with headroom for the JS-side Blob copy. The viewer routes an
    // over-cap refusal to the decode path instead of calling the media broken.
    const MAX_MEDIA_BYTES: u64 = 192 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_MEDIA_BYTES {
        return Err(MEDIA_TOO_LARGE.into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open a transcribed link in the system browser. Scheme-checked so a
/// stored record can only ever launch a web URL, never a local program.
#[tauri::command]
pub fn open_source_url(app: AppHandle, url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("not a web link".into());
    }
    // A cold-started browser must not inherit our injected env vars (`crate::open_external`).
    crate::open_external(&app, u)
}

/// The longest path `reveal_in_folder` accepts (bytes) — past every OS's own limit.
const REVEAL_PATH_MAX: usize = 4096;

/// A path `reveal_in_folder` may show: non-empty, bounded, free of control
/// characters, absolute, and present on disk. A just-saved export always is.
fn reveal_target(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > REVEAL_PATH_MAX {
        return Err("not a usable path".into());
    }
    if path.chars().any(char::is_control) {
        return Err("the path has control characters".into());
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("not an absolute path".into());
    }
    if !p.exists() {
        return Err("the file is not there".into());
    }
    Ok(p)
}

/// Show a saved export in the system file manager: its folder opens with the
/// file selected. async + spawn_blocking: the Linux path is a blocking D-Bus
/// call (FileManager1, else the OpenURI portal).
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let target = reveal_target(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decode a media file in-process (symphonia) — the playback fallback for
/// codecs the system webview can't handle (AAC/MP4 on Linux
/// WebKitGTK, i.e. every retained YouTube audio). Returns the path of a
/// cached on-disk WAV the viewer streams through the asset protocol —
/// returning the bytes over IPC froze the web process on ~240 MB blobs.
#[tauri::command]
pub async fn decode_media_file(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::decode::decode_to_cached_wav(&app, &path).map_err(|e| {
            tracing::warn!("[playback] decode failed for {path}: {e}");
            e
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a plain text file (transcript exports) to the path the user picked
/// in the save dialog. Same atomic tmp+rename + cleanup-on-both-failures shape
/// as `export_settings_file`, minus the 0600 secrecy (a transcript is what the
/// user is deliberately exporting — plain permissions are correct).
/// async + spawn_blocking: a sync command runs on the main thread and this fsyncs into a
/// user-picked sink (USB stick, network share).
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write as _;
        let path = PathBuf::from(path);
        let tmp = crate::transport::media::tmp_sibling(&path);
        let write = || -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(contents.as_bytes())?;
            f.sync_all()
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a text/subtitle source file for a translate-only run. Size-capped —
/// subtitle files are KBs; anything past the cap is the wrong file.
/// async + spawn_blocking: a sync command runs on the main thread, and the picked file can sit
/// on a slow or stalled mount (network share, sleeping disk).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    const MAX_TEXT_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_TEXT_SOURCE_BYTES {
            return Err("file is larger than 10 MB — not a subtitle/text source".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(decode_text_source(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Windows-1252 code points for bytes 0x80–0x9F; the five undefined slots are U+FFFD.
#[rustfmt::skip]
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
    '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

/// Decode a subtitle/text source. Subtitle files in the wild are not all UTF-8: Windows
/// "Unicode" saves are UTF-16 with a BOM, and older files are Windows-1252. Decoding those as
/// lossy UTF-8 turned UTF-16's NUL bytes into extra line breaks (every cue split apart) and
/// every umlaut into U+FFFD.
fn decode_text_source(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], from: fn([u8; 2]) -> u16| -> String {
        // An odd trailing byte is dropped by chunks_exact.
        let units = rest.chunks_exact(2).map(|c| from([c[0], c[1]]));
        char::decode_utf16(units)
            .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, u16::from_be_bytes);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => {
            // Valid multi-byte UTF-8 outnumbers the bad runs: a UTF-8 file with a stray invalid
            // byte, which must not block (or mojibake) the whole file. A plain "any valid
            // multi-byte char" test is not enough: Windows-1252 pairs like "ß…" (DF 85) happen
            // to be valid UTF-8, and one of them flipped a whole German file to U+FFFD umlauts.
            let (mut good, mut bad) = (0usize, 0usize);
            for chunk in bytes.utf8_chunks() {
                good += chunk.valid().chars().filter(|c| !c.is_ascii()).count();
                if !chunk.invalid().is_empty() {
                    bad += 1;
                }
            }
            if good > bad {
                return String::from_utf8_lossy(bytes).into_owned();
            }
            // Mostly undecodable high bytes: a single-byte (Windows-1252) file.
            bytes
                .iter()
                .map(|&b| match b {
                    0x80..=0x9F => CP1252_HIGH[usize::from(b - 0x80)],
                    _ => char::from(b),
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::move_dir_contents;

    #[test]
    fn the_layout_gate_holds_waiters_until_it_opens_then_lets_every_one_through() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        static GATE: super::Gate = super::Gate::new();
        static PASSED: AtomicBool = AtomicBool::new(false);
        let waiter = std::thread::spawn(|| {
            GATE.wait();
            PASSED.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !PASSED.load(Ordering::SeqCst),
            "a waiter got through a closed gate"
        );
        GATE.open();
        waiter.join().unwrap();
        assert!(PASSED.load(Ordering::SeqCst));
        GATE.wait(); // open for good: a later wait returns at once
    }

    #[test]
    fn reveal_target_takes_only_an_existing_absolute_clean_path() {
        use super::{reveal_target, REVEAL_PATH_MAX};
        let file = std::env::temp_dir().join(format!("fwf-reveal-{}.srt", std::process::id()));
        std::fs::write(&file, b"1").unwrap();
        let ok = file.to_string_lossy().into_owned();
        assert_eq!(reveal_target(&ok).unwrap(), file);
        // Relative, empty, over-long, control characters, missing: all refused.
        // Each refusal is asserted by its message: the paths below do not exist either,
        // so a bare is_err() would pass on the final missing-file gate alone.
        assert_eq!(
            reveal_target("talk.srt").unwrap_err(),
            "not an absolute path"
        );
        assert_eq!(reveal_target("").unwrap_err(), "not a usable path");
        let long = format!("/{}", "a".repeat(REVEAL_PATH_MAX));
        assert_eq!(reveal_target(&long).unwrap_err(), "not a usable path");
        assert_eq!(
            reveal_target(&format!("{ok}\n")).unwrap_err(),
            "the path has control characters"
        );
        assert_eq!(
            reveal_target(&format!("{ok}\u{7f}")).unwrap_err(),
            "the path has control characters"
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(reveal_target(&ok).unwrap_err(), "the file is not there");
    }

    #[test]
    fn move_dir_contents_leaves_inflight_tmp_behind() {
        let base = std::env::temp_dir().join(format!(
            "fwf-move-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.wav"), b"riff").unwrap();
        std::fs::write(from.join("b.m4a.tmp"), b"partial").unwrap();

        let mut map = Vec::new();
        move_dir_contents(&from, &to, &mut map).unwrap();

        assert!(to.join("a.wav").is_file(), "regular media moves");
        assert!(
            !to.join("b.m4a.tmp").exists(),
            "an in-flight .tmp is never moved"
        );
        assert!(
            from.join("b.m4a.tmp").is_file(),
            "the .tmp stays in the old base for its writer"
        );
        assert_eq!(map.len(), 1);
        assert!(map[0].0.ends_with("a.wav") && map[0].1.ends_with("a.wav"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn text_source_decodes_utf16_cp1252_and_keeps_stray_byte_utf8() {
        use super::decode_text_source;
        let srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nMädchen\r\n";

        let mut le = vec![0xFF, 0xFE];
        le.extend(srt.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_text_source(&le), srt, "UTF-16LE keeps plain CRLF");

        let mut be = vec![0xFE, 0xFF];
        be.extend("Grüße\n".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(decode_text_source(&be), "Grüße\n");

        assert_eq!(decode_text_source(b"M\xe4dchen \x80"), "Mädchen €");

        let mut stray = "äöü ".as_bytes().to_vec();
        stray.push(0xFF);
        assert_eq!(decode_text_source(&stray), "äöü \u{FFFD}");
        // A 1:1 tie goes to Windows-1252: "weiß…" + one umlaut is one valid pair and one bad byte.
        assert_eq!(
            decode_text_source(b"Ich wei\xdf\x85 nicht, M\xe4dchen"),
            "Ich weiß… nicht, Mädchen"
        );

        // "ß…" in Windows-1252 (DF 85) is also a valid UTF-8 pair; it must not outvote the rest.
        assert_eq!(
            decode_text_source(b"Ich wei\xdf\x85 nicht, M\xe4dchen \xfcber \xf6l"),
            "Ich weiß… nicht, Mädchen über öl"
        );

        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("ä".as_bytes());
        assert_eq!(decode_text_source(&bom), "ä", "UTF-8 BOM is stripped");
    }
}
