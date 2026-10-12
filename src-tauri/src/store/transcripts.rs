//! Local transcription history: one JSON file per finished batch run under
//! `<app_data_dir>/transcripts/<id>.json`.
//!
//! The record content is FRONTEND-OWNED opaque JSON (result, user corrections,
//! speaker renames/colors and the settings used) — Rust stores and lists it
//! but never interprets it, the same contract as `sync-state.json` and
//! `quick_launch`. The files themselves are the source of truth: listing reads
//! the directory, there is no index to corrupt. Records are as sensitive as
//! saved recordings (verbatim transcripts of the user's audio), so they get
//! the same owner-only file/dir permissions.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Serialises a record write against the retention sweep's per-entry stat-then-unlink. The
/// sweeps run on a background thread (`save_config`), so without it a save could rename a fresh
/// record into place between the sweep's mtime check and its `remove_file`, and the just-saved
/// record would be deleted. Held per entry, never for a whole sweep, so a save waits at most one
/// stat + unlink. The media-path rewriters (`rewrite_media_paths`, `heal_media_paths`) hold it
/// per record across their read-parse-rewrite too: an audio-base move runs them on a blocking
/// thread while saves and sweeps stay live, so an unlocked rewrite could overwrite a newer save
/// with the stale copy it read, or resurrect a record a sweep or the user's delete just removed.
/// Holders: `save_transcript_record`, the retention sweeps (`prune_transcripts`, `wipe_records`),
/// the two rewriters, and `delete_transcript_record` (across its record read + unlink only —
/// its media-copy and recordings-folder unlinks both run after release, so a slow share there
/// cannot stall a main-thread save).
/// The destructive commands (`delete_transcript_record`, `delete_all_dictations`,
/// `clear_file_transcriptions`, `remove_transcript_media`) run on the blocking pool, so they
/// too may overlap a save or sweep and rely on this per-entry lock, not on IPC ordering.
static RECORD_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn record_io_lock() -> std::sync::MutexGuard<'static, ()> {
    RECORD_IO.lock().unwrap_or_else(|e| e.into_inner())
}

/// Sanity cap per record — a transcript with word timestamps of an hours-long
/// file is single-digit MB; anything past this is not ours.
const MAX_RECORD_BYTES: u64 = 32 * 1024 * 1024;

fn transcripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("transcripts"))
        .map_err(|e| e.to_string())
}

/// Dictation-session records live in a subdirectory so their (stricter)
/// retention window can sweep independently of file transcriptions. The
/// top-level listing skips non-`.json` entries, so the subdir is invisible
/// to the pre-existing sweep.
fn dictations_dir(app: &AppHandle) -> Result<PathBuf, String> {
    transcripts_dir(app).map(|d| d.join("dictation"))
}

/// The pre-single-base media store (`transcripts/media`) — referenced only by
/// the startup migration in `commands::ensure_audio_layout`.
pub(crate) fn legacy_media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    transcripts_dir(app).map(|d| d.join("media"))
}

fn audio_base(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    crate::commands::resolve_audio_base(app, custom)
        .ok_or_else(|| "could not resolve the audio folder".into())
}

/// Audio copies of file-transcription inputs: `<base>/files/<id>.<ext>`.
/// `custom` is the audio-base preference from settings (None = default).
/// Same opaque contract as the records: Rust never reads the audio.
pub(crate) fn files_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    audio_base(app, custom).map(|b| b.join(crate::commands::AUDIO_SUBDIRS[1]))
}

/// Downloaded audio of link transcriptions: `<base>/links/<id>.<ext>` — the
/// only playable source for those records.
pub(crate) fn links_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    audio_base(app, custom).map(|b| b.join(crate::commands::AUDIO_SUBDIRS[2]))
}

/// Downloaded VIDEO of link transcriptions: `<base>/video/<id>.<ext>` — kept
/// for export (no in-app video playback yet).
pub(crate) fn video_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    audio_base(app, custom).map(|b| b.join(crate::commands::AUDIO_SUBDIRS[3]))
}

/// Every record media folder — files/, links/, video/ — from one base resolution. The
/// single list cleanup and the storage readout share, so a new media kind cannot be
/// left out of one of them.
fn all_media_dirs(app: &AppHandle, custom: Option<String>) -> Result<[PathBuf; 3], String> {
    let base = audio_base(app, custom)?;
    Ok([1, 2, 3].map(|i| base.join(crate::commands::AUDIO_SUBDIRS[i])))
}

/// The media paths one file/url record names (`sourcePath`, `mediaPath`,
/// `videoPath`) — what `copy_media_to` may read on the record's behalf.
pub(crate) fn record_media_paths(app: &AppHandle, id: &str) -> Vec<PathBuf> {
    if !valid_id(id) {
        return Vec::new();
    }
    let Ok(dir) = transcripts_dir(app) else {
        return Vec::new();
    };
    let path = dir.join(format!("{id}.json"));
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    ["sourcePath", "mediaPath", "videoPath"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(|p| p.as_str()))
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// The `kind` field of one record ("file" | "url" | "dictation"), if the
/// record exists and parses. Used by the layout migration to route media.
pub(crate) fn record_kind(app: &AppHandle, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    let path = transcripts_dir(app).ok()?.join(format!("{id}.json"));
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("kind")?.as_str().map(str::to_owned)
}

/// Rewrite a record in place for a path fix-up (move / heal), keeping its mtime: record
/// and dictation-audio retention both age by mtime, and a same-volume audio move keeps the
/// file's, so a reset record clock would outlive its audio by a whole retention window.
/// User edits (`save_transcript_record`) deliberately DO refresh it.
fn rewrite_record_keep_mtime(path: &Path, out: &str, mtime: Option<std::time::SystemTime>) -> bool {
    if crate::config::write_private_atomic(path, out).is_err() {
        return false;
    }
    if let Some(t) = mtime {
        if let Ok(f) = std::fs::File::options().append(true).open(path) {
            let _ = f.set_modified(t);
        }
    }
    true
}

/// What a media-path fix-up walk (`fix_records_in`) got through.
struct FixTally {
    /// Records re-pointed and written back.
    fixed: usize,
    /// Records that may need a fix but could not be stat'ed, read or written back.
    failed: usize,
    /// Folders or listing entries that could not be read: each may hide any number of records.
    unlisted: usize,
}

impl FixTally {
    /// Every record the walk should have reached was reached.
    fn complete(&self) -> bool {
        self.failed == 0 && self.unlisted == 0
    }
}

/// Walk every `.json` record in `dirs` for a media-path fix-up (`what`: "rewrite" or "heal"),
/// let `fix` change the parsed record, and write back the ones it changed, keeping their mtime.
/// The move rewrite and the heal share it so both count a miss alike: a missing folder, a
/// record a sweep removed first, a non-UTF-8 file and an unparsable one are nothing the History
/// listing could load either and are skipped; anything else unread may hide a moved path and is
/// counted (`FixTally`). `size_cap` skips records the listing skips as oversized.
fn fix_records_in(
    dirs: &[PathBuf],
    what: &str,
    size_cap: Option<u64>,
    mut fix: impl FnMut(&mut serde_json::Value) -> bool,
) -> FixTally {
    let mut tally = FixTally {
        fixed: 0,
        failed: 0,
        unlisted: 0,
    };
    for dir in dirs {
        // No folder = no record to re-point; one that exists but cannot be listed may hide one.
        let entries = match list_dir(dir, "history") {
            Ok(Some(e)) => e,
            Ok(None) => continue,
            Err(e) => {
                tracing::warn!("[transcripts] {e} for the media-path {what}");
                tally.unlisted += 1;
                continue;
            }
        };
        for entry in entries {
            // A mid-listing error may hide a matching record too.
            let Ok(entry) = entry else {
                tally.unlisted += 1;
                continue;
            };
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            // A folder (or a link to one) named `*.json` is no record: reading it fails on every
            // pass (IsADirectory, PermissionDenied on Windows) and would keep the walk incomplete
            // for good. Follows a symlink; one that went away is skipped like a removed record.
            match std::fs::metadata(&path) {
                Ok(m) if !m.is_file() => continue,
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    tally.failed += 1;
                    continue;
                }
            }
            if let Some(cap) = size_cap {
                match entry.metadata() {
                    Ok(m) if m.len() > cap => continue,
                    Ok(_) => {}
                    Err(_) => {
                        tally.failed += 1;
                        continue;
                    }
                }
            }
            // Held to the end of this record (read, parse, stat, rewrite) — see `RECORD_IO`.
            // A record a sweep removed first is unreadable here and skipped, not resurrected;
            // a non-UTF-8 file is no record the listing could load either. Any other read
            // failure (a sync client's or antivirus's lock) may hide a moved path.
            let _io = record_io_lock();
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData
                    ) =>
                {
                    continue
                }
                Err(_) => {
                    tally.failed += 1;
                    continue;
                }
            };
            let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            if !fix(&mut v) {
                continue;
            }
            let Ok(out) = serde_json::to_string(&v) else {
                tally.failed += 1;
                continue;
            };
            // Re-stat under the lock: the DirEntry's metadata may predate a save.
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            if rewrite_record_keep_mtime(&path, &out, mtime) {
                tally.fixed += 1;
            } else {
                tally.failed += 1;
            }
        }
    }
    if tally.unlisted > 0 {
        tracing::warn!(
            "[transcripts] media-path {what} skipped {} unlistable folder(s)/entr(y/ies)",
            tally.unlisted
        );
    }
    tally
}

/// Rewrite `mediaPath` in every record whose stored path appears in `lookup`
/// (old absolute path → new absolute path), after a migration or base move.
/// Best-effort per record; a record that fails to parse is left untouched. Returns false when
/// a record that may point at a moved file could not be read or rewritten (locked, unreadable,
/// disk full) or a history folder could not be listed: the caller must then leave the heal to
/// re-point it by basename, or it stays broken for good.
pub(crate) fn rewrite_media_paths(
    app: &AppHandle,
    lookup: &std::collections::HashMap<&str, &str>,
) -> bool {
    let dirs: Vec<PathBuf> = [transcripts_dir(app), dictations_dir(app)]
        .into_iter()
        .flatten()
        .collect();
    rewrite_media_paths_in(&dirs, lookup)
}

fn rewrite_media_paths_in(
    dirs: &[PathBuf],
    lookup: &std::collections::HashMap<&str, &str>,
) -> bool {
    let tally = fix_records_in(dirs, "rewrite", None, |v| {
        // Dictation records keep their audio under `sourcePath`; file/url
        // records under `mediaPath` — a moved file must be re-pointed in
        // whichever field carries it.
        let mut changed = false;
        for key in ["mediaPath", "videoPath", "sourcePath"] {
            let Some(old) = v.get(key).and_then(|m| m.as_str()) else {
                continue;
            };
            if let Some(new) = lookup.get(old) {
                v[key] = serde_json::Value::String((*new).to_owned());
                changed = true;
            }
        }
        changed
    });
    if tally.fixed > 0 {
        tracing::info!(
            "[transcripts] rewrote media paths in {} record(s) after move",
            tally.fixed
        );
    }
    if tally.failed > 0 {
        tracing::warn!(
            "[transcripts] could not rewrite media paths in {} record(s)",
            tally.failed
        );
    }
    tally.complete()
}

/// The subfolders `heal_media_paths` may find `key`'s file in, most likely first.
///
/// A link keeps its audio in `links/` and its video in `video/` under the SAME `<id>.<ext>`
/// name (and audio/webm and video/webm share `webm`), so a basename search in plain
/// `AUDIO_SUBDIRS` order re-pointed a stale `videoPath` at the audio-only copy. A video lives
/// only in `video/`, and audio never does; among the rest, the subfolder the stale path itself
/// named goes first.
fn heal_candidates<'a>(key: &str, old_path: &Path, subs: &[&'a str]) -> Vec<&'a str> {
    const VIDEO: &str = "video";
    let fits = |s: &str| (key == "videoPath") == (s == VIDEO);
    let own = old_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .and_then(|n| subs.iter().copied().find(|s| *s == n))
        .filter(|s| fits(s));
    own.into_iter()
        .chain(subs.iter().copied().filter(|s| fits(s) && Some(*s) != own))
        .collect()
}

/// Repair records whose stored audio path no longer exists but whose file
/// lives under one of the audio-base subfolders (same basename). Heals
/// records a past move rewrote incompletely — earlier builds only rewrote
/// `mediaPath`, stranding every dictation record's `sourcePath` when the
/// layout migration moved the files into `<base>/dictations`. Idempotent, but
/// NOT cheap — it reads and parses every record — so the caller runs it after a
/// migration that moved something and once per install, not every launch.
/// Returns false when a record could not be read or rewritten or a history folder could
/// not be listed: the caller must then keep the heal armed, or that record stays broken.
pub(crate) fn heal_media_paths(app: &AppHandle, base: &std::path::Path) -> bool {
    let dirs: Vec<PathBuf> = [transcripts_dir(app), dictations_dir(app)]
        .into_iter()
        .flatten()
        .collect();
    heal_media_paths_in(&dirs, base)
}

fn heal_media_paths_in(dirs: &[PathBuf], base: &Path) -> bool {
    let subs = crate::commands::AUDIO_SUBDIRS;
    // Same size guard as `read_records_into`: an oversized record is skipped
    // there too, so parsing it here would be work for a record nobody loads.
    let tally = fix_records_in(dirs, "heal", Some(MAX_RECORD_BYTES), |v| {
        let mut changed = false;
        for key in ["mediaPath", "videoPath", "sourcePath"] {
            let Some(old) = v.get(key).and_then(|m| m.as_str()) else {
                continue;
            };
            let old_path = std::path::Path::new(old);
            // Only local absolute paths that are actually gone (a URL in
            // `sourcePath` or a still-valid path is not ours to touch).
            if !old_path.is_absolute() || old_path.exists() {
                continue;
            }
            let Some(name) = old_path.file_name() else {
                continue;
            };
            if let Some(found) = heal_candidates(key, old_path, &subs)
                .into_iter()
                .map(|s| base.join(s).join(name))
                .find(|c| c.exists())
            {
                v[key] = serde_json::Value::String(found.to_string_lossy().into_owned());
                changed = true;
            }
        }
        changed
    });
    if tally.fixed > 0 {
        tracing::info!(
            "[transcripts] healed stale media paths in {} record(s)",
            tally.fixed
        );
    }
    if tally.failed > 0 {
        tracing::warn!(
            "[transcripts] could not heal media paths in {} record(s); retried on the next launch",
            tally.failed
        );
    }
    tally.complete()
}

/// Copy cap — beyond this the copy is silently skipped (the record keeps
/// playing from the original while it exists).
pub(crate) const MAX_MEDIA_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// Record ids are frontend-generated UUIDs — hex + dashes only, so an id can
/// never traverse out of the transcripts directory.
pub(crate) fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Is `s` shaped like the ids this app actually writes — a `crypto.randomUUID()`, 36 chars
/// in 8-4-4-4-12 hex, or the dash-stripped 32-lowercase-hex job id (`newProgressId`) a
/// re-attached / lost-contact run keeps as its record id? Both forms must be lowercase and
/// carry the UUIDv4 version and variant nibbles: a bare 32-hex stem is the common MD5 file
/// name, and an uppercase or non-v4 dashed GUID is a foreign (e.g. Windows-minted) name — a
/// user's file named either way must not read as ours. `valid_id` is the looser PATH-SAFETY
/// predicate for command inputs; as an OWNERSHIP predicate it accepted any 8+ hex-ish stem,
/// so a user's own `20260901.mp3` or `12345678.wav` in the media folder read as ours and was
/// deleted.
fn is_uuid_id(s: &str) -> bool {
    let b = s.as_bytes();
    let dashless: Vec<u8> = match b.len() {
        32 => b.to_vec(),
        36 if [8, 13, 18, 23].iter().all(|&i| b[i] == b'-') => {
            b.iter().copied().filter(|&c| c != b'-').collect()
        }
        _ => return false,
    };
    dashless.len() == 32
        && dashless
            .iter()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        && dashless[12] == b'4'
        && matches!(dashless[16], b'8' | b'9' | b'a' | b'b')
}

/// Is this a media copy THIS app wrote (`<uuid>.<ext>`)? The audio base is a free user
/// pick, so `files/`/`links/` may already hold foreign data — the sweeps, wipes and the
/// storage readout must never touch or count anything else (the dictation twin is
/// `audio::is_dictation_file`).
fn is_own_media(path: &Path) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(is_uuid_id)
        .unwrap_or(false)
}

/// Is this a recordings-folder file THIS app wrote (`dictation-*.wav` / `.txt`)? The one
/// predicate the readout, the wipe and the per-record delete share, so a non-UTF-8 name is
/// judged the same (lossily) by all three and the readout keeps matching the wipe.
fn is_own_recording(path: &Path) -> bool {
    path.file_name()
        .map(|n| crate::audio::is_dictation_file(&n.to_string_lossy()))
        .unwrap_or(false)
}

/// Bytes and count of the files in `dir` that `own` claims — the same predicate the delete
/// commands use, so the "Frees N MB / Delete N files" readout promises exactly what a wipe
/// does. In-progress `.tmp` copies are skipped like every sweep skips them.
fn owned_dir_bytes(dir: &Path, own: impl Fn(&Path) -> bool) -> (u64, u32) {
    let (bytes, files, _) = owned_dir_tally(dir, own, |_| false);
    (bytes, files)
}

/// `owned_dir_bytes` plus how many of the owned files `mark` holds for, in ONE listing — the
/// folder may sit on a slow share, so a readout must not list it once per sub-count.
fn owned_dir_tally(
    dir: &Path,
    own: impl Fn(&Path) -> bool,
    mark: impl Fn(&Path) -> bool,
) -> (u64, u32, u32) {
    let (mut bytes, mut files, mut marked) = (0u64, 0u32, 0u32);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("tmp") || !own(&path) {
                continue;
            }
            if let Ok(m) = entry.metadata() {
                if m.is_file() {
                    bytes += m.len();
                    files += 1;
                    if mark(&path) {
                        marked += 1;
                    }
                }
            }
        }
    }
    (bytes, files, marked)
}

/// The recordings folder's readout: bytes and count of every file "Delete all dictations" removes
/// (`dictation-*.wav` and the `.txt` sidecar beside each), plus how many of them are audio — the
/// delete confirm names audio files, and counting the sidecars there doubled the number.
fn recordings_usage(dir: &Path) -> (u64, u32, u32) {
    owned_dir_tally(dir, is_own_recording, is_wav)
}

/// Is this a `.wav` — the audio half of a dictation's `.wav` + `.txt` pair.
fn is_wav(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("wav")
}

/// Does the transcript store hold ANY `.json` record? Cheap (a directory listing), so the
/// startup migration can skip the full read+parse heal on a fresh install. Checks both
/// `transcripts/` and `transcripts/dictation/` — the same directories `heal_media_paths`
/// scans — so the predicate and the work it guards agree on what a record is.
pub fn has_any_records(app: &AppHandle) -> bool {
    let dirs: Vec<PathBuf> = [transcripts_dir(app), dictations_dir(app)]
        .into_iter()
        .flatten()
        .collect();
    any_records_in(&dirs)
}

/// `has_any_records` over `dirs`. Only a missing folder or a clean listing without a `.json`
/// counts as empty: one that exists but cannot be listed (or fails mid-listing) may hide
/// records, so it answers true and the heal runs — and, like `fix_records_in`, reports the
/// folder incomplete instead of the fast path stamping it healed.
fn any_records_in(dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|d| match list_dir(d, "history") {
        Ok(Some(entries)) => entries.into_iter().any(|e| {
            e.map_or(true, |x| {
                x.path().extension().and_then(|s| s.to_str()) == Some("json")
            })
        }),
        Ok(None) => false,
        Err(_) => true,
    })
}

/// Delete a dictation record's audio (`dictation-*.wav` + its `.txt` sidecar) — only
/// when the name is one we write and the path is absolute, so a user-chosen folder can
/// never lose foreign files.
fn remove_dictation_audio(source_path: &str) {
    let p = Path::new(source_path);
    if is_own_recording(p) && p.is_absolute() {
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_file(p.with_extension("txt"));
    }
}

/// Write (create or replace) one history record. Atomic tmp+rename with
/// owner-only permissions, cleanup on both failure paths.
#[tauri::command]
pub fn save_transcript_record(
    app: AppHandle,
    id: String,
    record: String,
    dictation: Option<bool>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("malformed record id".into());
    }
    if record.len() as u64 > MAX_RECORD_BYTES {
        return Err("transcript record too large".into());
    }
    let dir = if dictation.unwrap_or(false) {
        dictations_dir(&app)?
    } else {
        transcripts_dir(&app)?
    };
    crate::audio::create_dir_private(&dir)
        .map_err(|e| format!("could not create the transcripts folder: {e}"))?;
    let path = dir.join(format!("{id}.json"));
    // Never in place: `read_records_into` silently skips a file that fails to parse, so a crash
    // between truncate and write would make the record vanish from History.
    let _io = record_io_lock();
    crate::config::write_private_atomic(&path, &record).map_err(|e| e.to_string())
}

/// All history records, parsed but uninterpreted. Unreadable or unparseable
/// files are skipped — one corrupt record must never hide the rest — but an existing
/// folder that cannot be listed rejects, so History shows its failed-listing notice
/// instead of an empty list; a missing folder is an empty history. Ordering
/// is the frontend's job (records carry their own createdAt).
/// async + spawn_blocking: reading and parsing every record is the heaviest read the app does,
/// and a sync command would stall the main thread (every window) for its duration. Safe to run
/// beside writes: `config::write_private_atomic` renames into place, so a read sees old or new,
/// never half.
#[tauri::command]
pub async fn list_transcript_records(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let transcripts = transcripts_dir(&app)?;
    let dictations = dictations_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let mut out = Vec::new();
        read_records_into(&transcripts, &mut out)?;
        read_records_into(&dictations, &mut out)?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_records_into(dir: &Path, out: &mut Vec<serde_json::Value>) -> Result<(), String> {
    // No folder yet = nothing to add.
    let Some(entries) = list_dir(dir, "history")? else {
        return Ok(());
    };
    for entry in entries {
        // A folder-level readdir failure would otherwise truncate the listing silently.
        let entry = entry.map_err(|e| format!("could not list the history folder: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > MAX_RECORD_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            out.push(v);
        }
    }
    Ok(())
}

/// Delete one record's file. The user-facing "Delete" — actually removes data.
/// Tries both stores: ids are UUIDs, so the same id can only exist in one.
/// The record's audio copy (if any) goes with it, only once the record is gone.
/// async + spawn_blocking like the other destructive store commands: it walks the media folders
/// under a user-picked base (possibly a slow or offline share), which must not freeze every window.
#[tauri::command]
pub async fn delete_transcript_record(
    app: AppHandle,
    id: String,
    audio_base: Option<String>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("malformed record id".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // The `files/`/`links/`/video copies go only once the record is gone: a failed unlink
        // (Windows briefly locking the file) keeps the History entry, and it must keep its
        // playable media too. Runs after the lock is released, like the recordings unlink.
        let drop_media = || {
            if let Ok(dirs) = all_media_dirs(&app, audio_base.clone()) {
                for dir in dirs {
                    remove_media_for(&dir, &id);
                }
            }
        };
        let name = format!("{id}.json");
        let file_path = transcripts_dir(&app)?.join(&name);
        // Held across both branches' record read + unlink — see `RECORD_IO`: a media-path
        // rewrite that read this record before the unlink would otherwise rename its copy back
        // into place afterwards.
        let io = record_io_lock();
        if file_path.exists() {
            let res = std::fs::remove_file(file_path).map_err(|e| e.to_string());
            drop(io);
            if res.is_ok() {
                drop_media();
            }
            return res;
        }
        let rec_path = dictations_dir(&app)?.join(&name);
        // Absent from both stores: nothing to delete (not a failure), but stray files/links/video
        // copies of a record whose first write never landed still go. A dictation never owns
        // such a copy, so a present one skips the sweep (three listings under a possibly slow or
        // offline audio base).
        let existed = rec_path.exists();
        // A dictation's audio lives in the recordings folder, not `files/`/`links/`:
        // take the .wav and its .txt sidecar with the record, or "delete from disk"
        // leaves a verbatim recording of the user's speech (and the deleted text)
        // behind with nothing referencing it.
        let src: Option<String> = std::fs::read_to_string(&rec_path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("sourcePath")?.as_str().map(str::to_owned));
        let res = std::fs::remove_file(rec_path).map_err(|e| e.to_string());
        // The audio unlink touches no record file and the record is gone, so no rewriter can
        // re-point it: release the lock first, or a slow recordings share would hold every
        // (main-thread) save hostage.
        drop(io);
        // The audio goes only once the record is gone: a failed unlink (locked file) keeps the
        // History entry, and it must keep its recording too.
        if res.is_ok() {
            if let Some(src) = src {
                remove_dictation_audio(&src);
            }
        }
        if !existed {
            drop_media();
            return Ok(());
        }
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a run's input audio into `<base>/files/<id>.<ext>`, so the
/// workbench can still play it after the original moves. Verbatim copy, no
/// transcode; over-cap sources return Ok(None) ("no copy" — not an error).
/// Runs on a blocking thread: a multi-GB copy must not park the runtime.
#[tauri::command]
pub async fn save_transcript_media(
    app: AppHandle,
    id: String,
    source_path: String,
    audio_base: Option<String>,
) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err("malformed record id".into());
    }
    let dir = files_media_dir(&app, audio_base)?;
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&source_path);
        let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_MEDIA_BYTES {
            tracing::info!("[transcripts] media copy skipped (over cap): {source_path}");
            return Ok(None);
        }
        crate::audio::create_dir_private(&dir)
            .map_err(|e| format!("could not create the media folder: {e}"))?;
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| {
                !e.is_empty() && e.len() <= 5 && e.bytes().all(|b| b.is_ascii_alphanumeric())
            })
            .unwrap_or_else(|| "bin".into());
        let dest = dir.join(format!("{id}.{ext}"));
        let tmp = dir.join(format!("{id}.{ext}.tmp"));
        if let Err(e) = std::fs::copy(&src, &tmp) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        // Owner-only like the records themselves (copy inherits source perms). On Windows the
        // file inherits the DACL of a `files/` folder that may have pre-existed the pick (a
        // restored or synced tree), so it gets the same per-file DACL the recordings get.
        crate::audio::restrict_file_private(&tmp);
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Storage readout for the Recording & history tab: per-type counts and
/// sizes. `audio_base` is the settings' base-folder preference (None =
/// default), same contract as `audio_dir_path`.
/// async + spawn_blocking: it stats every entry of the media and recordings folders under a
/// user-picked base (possibly a slow or offline network share), and a sync command would freeze
/// every window for the scan. Read-only and lock-free, so it is safe beside saves and sweeps.
#[tauri::command]
pub async fn transcript_store_stats(
    app: AppHandle,
    audio_base: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        fn count_json(dir: &Path) -> u32 {
            std::fs::read_dir(dir)
                .map(|e| {
                    e.flatten()
                        .filter(|x| x.path().extension().and_then(|s| s.to_str()) == Some("json"))
                        .count() as u32
                })
                .unwrap_or(0)
        }
        let [files, links, video] = all_media_dirs(&app, audio_base.clone())?;
        let (file_bytes, file_files) = owned_dir_bytes(&files, is_own_media);
        let (link_bytes, link_files) = owned_dir_bytes(&links, is_own_media);
        let (video_bytes, video_files) = owned_dir_bytes(&video, is_own_media);
        let (rec_bytes, rec_files, rec_audio_files) =
            crate::commands::resolve_recordings_dir(&app, audio_base)
                .map(|d| recordings_usage(&d))
                .unwrap_or((0, 0, 0));
        Ok(serde_json::json!({
            "dictationCount": count_json(&dictations_dir(&app)?),
            "fileCount": count_json(&transcripts_dir(&app)?),
            "fileMediaBytes": file_bytes,
            "fileMediaFiles": file_files,
            "linkMediaBytes": link_bytes,
            "linkMediaFiles": link_files,
            "videoMediaBytes": video_bytes,
            "videoMediaFiles": video_files,
            "recordingsBytes": rec_bytes,
            "recordingsFiles": rec_files,
            "recordingsAudioFiles": rec_audio_files,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Delete all dictations now": every stored session record AND every app-owned
/// file in the recordings folder (.wav + .txt sidecars matching the `dictation-*`
/// naming convention — a user-chosen folder may hold foreign files).
/// The retention clocks stay as set. Returns records + AUDIO files removed — the sidecars go
/// too but are not counted, so the result matches the confirm's "N dictations + M audio files"
/// (`recordingsAudioFiles`).
#[tauri::command]
pub async fn delete_all_dictations(
    app: AppHandle,
    audio_base: Option<String>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        // Both steps always run, so a readable folder is still wiped when the other is not.
        let records = wipe_records(&dictations_dir(&app)?);
        let recordings = match crate::commands::resolve_recordings_dir(&app, audio_base) {
            Some(dir) => remove_own_recordings(&dir),
            None => Ok(0),
        };
        let removed =
            records.as_ref().map_or(0, |&n| n as u32) + recordings.as_ref().map_or(0, |&n| n);
        tracing::info!(
            "[transcripts] delete-all dictations: removed {removed} record(s)/recording(s)"
        );
        records?;
        recordings?;
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete every app-owned file in the recordings folder; returns how many of them were audio.
fn remove_own_recordings(dir: &Path) -> Result<u32, String> {
    let mut removed = 0u32;
    if let Some(entries) = list_dir(dir, "recordings")? {
        for entry in entries.flatten() {
            let path = entry.path();
            // Only the app's own files (same invariant as prune): a user-chosen
            // folder may hold other people's .wav/.txt.
            if is_own_recording(&path) && std::fs::remove_file(&path).is_ok() && is_wav(&path) {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// "Delete all transcriptions": every file/link/text record with its corrections;
/// the orphan sweep then drops their audio.
#[tauri::command]
pub async fn clear_file_transcriptions(
    app: AppHandle,
    audio_base: Option<String>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let removed = wipe_records(&transcripts_dir(&app)?)? as u32;
        sweep_orphan_media(&app, audio_base);
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Delete audio from file/link transcriptions": empties one media subfolder
/// (`kind` "file" → files/, "url" → links/, "video" → video/; None → all three).
/// Transcripts stay.
#[tauri::command]
pub async fn remove_transcript_media(
    app: AppHandle,
    kind: Option<String>,
    audio_base: Option<String>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        match kind.as_deref() {
            Some("file") => dirs.push(files_media_dir(&app, audio_base)?),
            Some("url") => dirs.push(links_media_dir(&app, audio_base)?),
            Some("video") => dirs.push(video_media_dir(&app, audio_base)?),
            _ => dirs.extend(all_media_dirs(&app, audio_base)?),
        }
        let mut removed = 0u32;
        let mut failed = None;
        for dir in dirs {
            // An unlistable folder fails the call, but only after the others were emptied.
            let entries = match list_dir(&dir, "media") {
                Ok(Some(entries)) => entries,
                Ok(None) => continue,
                Err(e) => {
                    failed.get_or_insert(e);
                    continue;
                }
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if is_own_media(&path) && std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        tracing::info!("[transcripts] media store cleared: removed {removed} file(s)");
        match failed {
            Some(e) => Err(e),
            None => Ok(removed),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove every media file named after `id` (any extension).
fn remove_media_for(dir: &Path, id: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_stem().and_then(|s| s.to_str()) == Some(id) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Drop media files whose record is gone — covers retention pruning, wipes,
/// but never an in-progress `.tmp` copy (see the loop). One clock:
/// a copy lives exactly as long as its transcript.
fn sweep_orphan_media(app: &AppHandle, audio_base: Option<String>) {
    let Ok(records) = transcripts_dir(app) else {
        return;
    };
    let Ok(dirs) = all_media_dirs(app, audio_base) else {
        return;
    };
    let mut removed = 0;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // An in-progress copy (`<id>.<ext>.tmp`, written on a blocking thread for up
            // to MAX_MEDIA_BYTES = 10 GiB) is not an orphan: this sweep runs on every
            // config save, and unlinking the tmp under the writer made its final rename
            // fail — the record then silently lost its only playable audio.
            if path.extension().and_then(|e| e.to_str()) == Some("tmp") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_own_media(&path) {
                continue;
            }
            // A stat error is not proof the record is gone: only a definite "absent" sweeps.
            if matches!(records.join(format!("{stem}.json")).try_exists(), Ok(false))
                && std::fs::remove_file(&path).is_ok()
            {
                removed += 1;
            }
        }
    }
    if removed > 0 {
        tracing::info!("[transcripts] media sweep: removed {removed} orphaned audio cop(y/ies)");
    }
}

/// Delete records older than `days` (0 = keep forever), with the same clamped mtime window as
/// `audio::prune_older_than`. Its own loop rather than that helper: each entry is re-stat'd and
/// unlinked under [`RECORD_IO`], so a record `save_transcript_record` just renamed into place
/// (fresh mtime) is never deleted on the strength of the old file's age.
pub fn prune_transcripts(dir: &Path, days: u32) -> usize {
    if days == 0 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let effective = days.min(crate::audio::MAX_RETENTION_DAYS);
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(u64::from(effective) * 86_400);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let _io = record_io_lock();
        let old = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!(
            "[transcripts] retention: removed {removed} record(s) older than {effective}d"
        );
    }
    removed
}

/// Enforce both history retention windows. Called on startup and after every
/// config save, mirroring `apply_recordings_retention`.
/// - File transcriptions: `historyRetentionDays` (0/absent = keep forever).
/// - Dictations: the one dictation clock, `effective_dictation_days` (the
///   stricter non-zero of `recordingsRetentionDays` and `dictationRetentionDays`,
///   default 7), the same window the recordings sweep uses — and when
///   `keepDictationHistory` is off, the whole dictation store is wiped (the
///   setting's copy promises exactly that).
///
/// When any record went, `transcripts://swept` (payload: `{ removed, dictationsWiped }` — the
/// record count, and whether this sweep actually emptied the dictation store; read by
/// `listenRetentionSweeps` in src/lib/transcript/transcriptHistory.ts) tells the History
/// mirror to reload — otherwise it keeps listing, and an edit re-saves, a deleted entry. It goes
/// out as soon as the records are gone, before the media sweep, which walks the (possibly slow,
/// network-share) audio base and changes no record.
pub fn apply_transcripts_retention(app: &AppHandle, config: &crate::config::Config) {
    let mut removed = 0;
    let mut dictations_wiped = false;
    let wipe_dictations = !config.settings.keep_dictation_history();
    let days = config.settings.transcribe_retention_days();
    if days > 0 {
        if let Ok(dir) = transcripts_dir(app) {
            removed += prune_transcripts(&dir, days);
        }
    }
    if let Ok(dir) = dictations_dir(app) {
        if wipe_dictations {
            // Best-effort like the prunes: an unlistable folder is retried on the next sweep.
            match wipe_records(&dir) {
                Ok(n) => {
                    removed += n;
                    dictations_wiped = true;
                }
                Err(e) => tracing::warn!(
                    "[transcripts] dictation wipe skipped, retried on the next sweep: {e}"
                ),
            }
        } else {
            let ddays = config.settings.effective_dictation_days();
            if ddays > 0 {
                removed += prune_transcripts(&dir, ddays);
            }
        }
    }
    if removed > 0 {
        // `dictationsWiped`: THIS sweep ran with "Save dictations to History" off AND listed
        // (so emptied) the dictation folder — an absent folder counts (Ok(0)); a failed listing
        // deleted nothing and says false. The webview's in-memory switch can be ahead of (or
        // behind) the config a queued sweep acted on, so it must not infer that itself.
        let _ = app.emit(
            "transcripts://swept",
            serde_json::json!({ "removed": removed, "dictationsWiped": dictations_wiped }),
        );
    }
    sweep_orphan_media(app, crate::commands::audio_base_pref(&config.settings));
}

/// List `dir` for a wipe, the History listing or a media-path rewrite/heal (`fix_records_in`):
/// a missing folder is nothing to read (`None`), but one that exists and cannot be listed is an
/// error — never a silent "removed 0" (an empty History, a heal marked done) while every file
/// stays on disk.
fn list_dir(dir: &Path, what: &str) -> Result<Option<std::fs::ReadDir>, String> {
    match std::fs::read_dir(dir) {
        Ok(entries) => Ok(Some(entries)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not list the {what} folder: {e}")),
    }
}

/// Remove every record in `dir` regardless of age ("Keep dictation history"
/// turned off, or a "Delete all"). Only touches `.json` files, like the prune.
fn wipe_records(dir: &Path) -> Result<usize, String> {
    let Some(entries) = list_dir(dir, "history")? else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let _io = record_io_lock();
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!("[transcripts] record wipe: removed {removed} record(s)");
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heal_keeps_video_and_audio_apart() {
        let subs = crate::commands::AUDIO_SUBDIRS;
        // A link's video and audio share `<id>.webm`; the video must never heal to `links/`.
        assert_eq!(
            heal_candidates("videoPath", Path::new("/gone/video/r1.webm"), &subs),
            vec!["video"]
        );
        let media = heal_candidates("mediaPath", Path::new("/gone/links/r1.webm"), &subs);
        assert_eq!(media.first(), Some(&"links"));
        assert!(!media.contains(&"video"));
        let source = heal_candidates("sourcePath", Path::new("/gone/video/r1.webm"), &subs);
        assert_eq!(source, vec!["dictations", "files", "links"]);
        // A path outside any known subfolder falls back to the plain order.
        assert_eq!(
            heal_candidates("mediaPath", Path::new("/old/r1.wav"), &subs),
            vec!["dictations", "files", "links"]
        );
    }

    #[test]
    fn record_rewrite_is_atomic_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("fwf-atomic-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("r.json");
        std::fs::write(&path, "{\"a\":1}").unwrap();
        crate::config::write_private_atomic(&path, "{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        assert!(!dir.join("r.json.tmp").exists());
        // A missing parent fails before anything is written.
        let bad = dir.join("missing").join("r.json");
        assert!(crate::config::write_private_atomic(&bad, "{}").is_err());
        assert!(!dir.join("missing").exists());
        // A rename that fails AFTER the full tmp write (target is a non-empty directory)
        // must clean the tmp up.
        std::fs::create_dir_all(dir.join("occ.json").join("x")).unwrap();
        assert!(crate::config::write_private_atomic(&dir.join("occ.json"), "{}").is_err());
        assert!(!dir.join("occ.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn media_ownership_guard_only_matches_our_ids() {
        assert!(is_own_media(Path::new(
            "/x/files/9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b.m4a"
        )));
        assert!(!is_own_media(Path::new("/x/files/my-album.mp3")));
        assert!(!is_own_media(Path::new("/x/links/notes.txt")));
        assert!(!is_own_media(Path::new("/x/files/holiday video.mp4")));
    }

    #[test]
    fn dictation_audio_removal_spares_foreign_files() {
        let dir = std::env::temp_dir().join(format!("fwf-dict-rm-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        for n in [
            "dictation-1.wav",
            "dictation-1.txt",
            "interview.wav",
            "interview.txt",
        ] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        remove_dictation_audio(dir.join("dictation-1.wav").to_str().unwrap());
        assert!(!dir.join("dictation-1.wav").exists());
        assert!(!dir.join("dictation-1.txt").exists());
        remove_dictation_audio(dir.join("interview.wav").to_str().unwrap());
        assert!(dir.join("interview.wav").exists());
        assert!(dir.join("interview.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ownership_is_uuid_shaped_not_merely_hex() {
        assert!(is_own_media(Path::new(
            "/x/files/9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b.m4a"
        )));
        assert!(!is_own_media(Path::new("/x/files/20260901.mp3")));
        assert!(!is_own_media(Path::new("/x/files/12345678.wav")));
        assert!(!is_own_media(Path::new("/x/files/cafe1234.wav")));
        // The dash-stripped job id a re-attached / lost-contact run records under.
        assert!(is_own_media(Path::new(
            "/x/links/9f8a7b6c1d2e4f309a8b7c6d5e4f3a2b.webm"
        )));
        assert!(!is_own_media(Path::new(
            "/x/files/9f8a7b6c1d2e4f309a8b7c6d5e4f3a2.mp3"
        )));
        assert!(!is_own_media(Path::new(
            "/x/files/9f8a7b6c1d2e4f309a8b7c6d5e4f3a2b0.mp3"
        )));
        assert!(!is_own_media(Path::new(
            "/x/files/9F8A7B6C1D2E4F309A8B7C6D5E4F3A2B.mp3"
        )));
        // An MD5-named file (no UUIDv4 version/variant nibbles) is the user's.
        assert!(!is_own_media(Path::new(
            "/x/files/5d41402abc4b2a76b9719d911017c592.mp3"
        )));
        // A dashed GUID that is uppercase or not v4 is a foreign name, not ours.
        assert!(!is_own_media(Path::new(
            "/x/files/6F9619FF-8B86-D011-B42D-00C04FC964FF.mp3"
        )));
        assert!(!is_own_media(Path::new(
            "/x/files/6f9619ff-8b86-1011-b42d-00c04fc964ff.mp3"
        )));
        assert!(!is_own_media(Path::new(
            "/x/files/9F8A7B6C-1D2E-4F30-9A8B-7C6D5E4F3A2B.m4a"
        )));
        // Dashes anywhere but the 8-4-4-4-12 positions are not a UUID.
        assert!(!is_own_media(Path::new(
            "/x/files/9f8a7b6c1-d2e-4f30-9a8b-7c6d5e4f3a2b.m4a"
        )));
    }

    #[test]
    fn the_storage_readout_counts_only_what_a_wipe_would_delete() {
        let dir = std::env::temp_dir().join(format!("fwf-store-stats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let own = "9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b";
        std::fs::write(dir.join(format!("{own}.m4a")), b"12345").unwrap();
        std::fs::write(dir.join(format!("{own}.m4a.tmp")), b"1234567").unwrap();
        std::fs::write(dir.join("holiday video.mp4"), b"123456789").unwrap();
        assert_eq!(owned_dir_bytes(&dir, is_own_media), (5, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_recordings_readout_counts_sidecars_as_files_but_not_as_audio() {
        let dir = std::env::temp_dir().join(format!("fwf-rec-stats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for stem in ["dictation-1", "dictation-2"] {
            std::fs::write(dir.join(format!("{stem}.wav")), b"1234").unwrap();
            std::fs::write(dir.join(format!("{stem}.txt")), b"12").unwrap();
        }
        std::fs::write(dir.join("dictation-3.wav.tmp"), b"1234567").unwrap();
        std::fs::write(dir.join("song.wav"), b"123456789").unwrap();
        assert_eq!(recordings_usage(&dir), (12, 4, 2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_recording_name_is_counted_and_wiped_alike() {
        use std::os::unix::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!("fwf-rec-lossy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let odd = dir.join(std::ffi::OsStr::from_bytes(b"dictation-\xff.wav"));
        std::fs::write(&odd, b"1234").unwrap();
        // The readout promises exactly what the wipe then removes.
        assert_eq!(recordings_usage(&dir), (4, 1, 1));
        assert_eq!(remove_own_recordings(&dir), Ok(1));
        assert!(!odd.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_all_recordings_counts_audio_not_sidecars() {
        let dir = std::env::temp_dir().join(format!("fwf-rec-wipe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for stem in ["dictation-1", "dictation-2", "dictation-3"] {
            std::fs::write(dir.join(format!("{stem}.wav")), b"1234").unwrap();
            std::fs::write(dir.join(format!("{stem}.txt")), b"12").unwrap();
        }
        std::fs::write(dir.join("song.wav"), b"123456789").unwrap();
        // The readout's audio count and the wipe's result agree; the sidecars still go.
        assert_eq!(recordings_usage(&dir).2, 3);
        assert_eq!(remove_own_recordings(&dir), Ok(3));
        assert!(!dir.join("dictation-1.txt").exists());
        assert!(dir.join("song.wav").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_listing_skips_bad_files_but_rejects_an_unlistable_folder() {
        let dir = std::env::temp_dir().join(format!("fwf-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A missing folder (first launch) is an empty history, not a failure.
        let mut out = Vec::new();
        assert!(read_records_into(&dir.join("missing"), &mut out).is_ok());
        assert!(out.is_empty());
        // One corrupt record never hides the rest.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.json"), "{\"id\":\"a\"}").unwrap();
        std::fs::write(dir.join("b.json"), "not json").unwrap();
        assert!(read_records_into(&dir, &mut out).is_ok());
        assert_eq!(out.len(), 1);
        // A path that exists but cannot be listed (here: a regular file) rejects.
        let mut out = Vec::new();
        assert!(read_records_into(&dir.join("a.json"), &mut out).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wipe_rejects_an_unlistable_folder_instead_of_removing_nothing() {
        let dir = std::env::temp_dir().join(format!("fwf-wipe-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A missing folder is nothing to delete, not a failure.
        assert_eq!(wipe_records(&dir.join("missing")), Ok(0));
        assert_eq!(remove_own_recordings(&dir.join("missing")), Ok(0));
        // A path that exists but cannot be listed (here: a regular file) rejects, so
        // "Delete all" never reports "Removed 0" while every file stays on disk.
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("dictation-1.wav");
        std::fs::write(&file, b"1234").unwrap();
        assert!(wipe_records(&file).is_err());
        assert!(remove_own_recordings(&file).is_err());
        assert!(file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_validation() {
        assert!(valid_id("9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b"));
        assert!(valid_id("cafe1234"));
        assert!(!valid_id("short"));
        assert!(!valid_id("../../../etc/passwd"));
        assert!(!valid_id("abcXYZ123"));
        assert!(!valid_id(""));
    }

    #[test]
    fn path_rewrite_keeps_the_record_mtime() {
        let dir = std::env::temp_dir().join(format!("fwf-rewrite-mtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rec = dir.join("aaaa1111.json");
        std::fs::write(&rec, b"{}").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(5 * 86_400);
        let f = std::fs::File::options().append(true).open(&rec).unwrap();
        f.set_modified(old).unwrap();
        drop(f);
        let mtime = std::fs::metadata(&rec).and_then(|m| m.modified()).ok();
        assert!(rewrite_record_keep_mtime(&rec, "{\"a\":1}", mtime));
        assert_eq!(std::fs::read_to_string(&rec).unwrap(), "{\"a\":1}");
        // Still old enough for a 1-day retention to prune it.
        assert_eq!(prune_transcripts(&dir, 1), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_only_touches_old_json() {
        let dir =
            std::env::temp_dir().join(format!("fwf-transcripts-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("aaaa1111.json");
        std::fs::write(&old, b"{}").unwrap();
        let keep = dir.join("notes.txt");
        std::fs::write(&keep, b"x").unwrap();
        // Backdate the record two days.
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86_400);
        let f = std::fs::File::options().append(true).open(&old).unwrap();
        f.set_modified(mtime).unwrap();
        drop(f);
        assert_eq!(prune_transcripts(&dir, 0), 0); // keep forever
        assert_eq!(prune_transcripts(&dir, 1), 1);
        assert!(!old.exists());
        assert!(keep.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn media_rewrite_reports_an_unreadable_record() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fwf-rewrite-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let lookup: std::collections::HashMap<&str, &str> =
            [("/old/files/a.wav", "/new/files/a.wav")]
                .into_iter()
                .collect();
        std::fs::write(dir.join("ok.json"), r#"{"mediaPath":"/old/files/a.wav"}"#).unwrap();
        // Not UTF-8 = no record the listing could load either: skipped, not a failure.
        std::fs::write(dir.join("bin.json"), [0xff, 0xfe, 0x00]).unwrap();
        // A missing folder has no record to re-point.
        let dirs = [dir.clone(), dir.join("missing")];
        assert!(rewrite_media_paths_in(&dirs, &lookup));
        let ok = std::fs::read_to_string(dir.join("ok.json")).unwrap();
        assert!(ok.contains("/new/files/a.wav"));
        // A locked record may hide a moved path: the caller must keep the heal armed.
        let locked = dir.join("locked.json");
        std::fs::write(&locked, r#"{"mediaPath":"/old/files/a.wav"}"#).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads through 0o000, so there is nothing to assert there.
        if std::fs::read_to_string(&locked).is_err() {
            assert!(!rewrite_media_paths_in(&dirs, &lookup));
        }
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn heal_reports_an_unreadable_record() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("fwf-heal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (dir, base) = (root.join("history"), root.join("base"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(base.join("files")).unwrap();
        std::fs::write(base.join("files").join("a.wav"), b"").unwrap();
        let gone = "/fwf-heal-gone/files/a.wav";
        std::fs::write(dir.join("ok.json"), format!(r#"{{"mediaPath":"{gone}"}}"#)).unwrap();
        // Not UTF-8 = no record the listing could load either: skipped, not a failure.
        std::fs::write(dir.join("bin.json"), [0xff, 0xfe, 0x00]).unwrap();
        // A missing folder has no record to heal.
        let dirs = [dir.clone(), dir.join("missing")];
        assert!(heal_media_paths_in(&dirs, &base));
        let ok = std::fs::read_to_string(dir.join("ok.json")).unwrap();
        assert!(ok.contains(&*base.join("files").join("a.wav").to_string_lossy()));
        // A locked record may still point at the gone path: the caller must not stamp the heal.
        let locked = dir.join("locked.json");
        std::fs::write(&locked, format!(r#"{{"mediaPath":"{gone}"}}"#)).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads through 0o000, so there is nothing to assert there.
        if std::fs::read_to_string(&locked).is_err() {
            assert!(!heal_media_paths_in(&dirs, &base));
        }
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn heal_reports_an_unlistable_folder() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("fwf-heal-unlisted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (dir, base) = (root.join("history"), root.join("base"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root lists through 0o000, so there is nothing to assert there.
        if std::fs::read_dir(&dir).is_err() {
            // A folder that exists but cannot be listed may hide any number of records.
            assert!(!heal_media_paths_in(std::slice::from_ref(&dir), &base));
            let lookup = std::collections::HashMap::new();
            assert!(!rewrite_media_paths_in(std::slice::from_ref(&dir), &lookup));
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_named_like_a_record_is_no_failed_record() {
        let root = std::env::temp_dir().join(format!("fwf-heal-dirjson-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (dir, base) = (root.join("history"), root.join("base"));
        std::fs::create_dir_all(dir.join("x.json")).unwrap();
        std::fs::create_dir_all(base.join("files")).unwrap();
        std::fs::write(base.join("files").join("a.wav"), b"").unwrap();
        let gone = "/fwf-heal-gone/files/a.wav";
        std::fs::write(dir.join("ok.json"), format!(r#"{{"mediaPath":"{gone}"}}"#)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("x.json"), dir.join("link.json")).unwrap();
        // Reading a folder fails on every pass: counting it would re-run the heal forever.
        let dirs = std::slice::from_ref(&dir);
        assert!(heal_media_paths_in(dirs, &base));
        let ok = std::fs::read_to_string(dir.join("ok.json")).unwrap();
        assert!(ok.contains(&*base.join("files").join("a.wav").to_string_lossy()));
        let lookup: std::collections::HashMap<&str, &str> =
            [(gone, "/new/files/a.wav")].into_iter().collect();
        std::fs::write(dir.join("ok.json"), format!(r#"{{"mediaPath":"{gone}"}}"#)).unwrap();
        assert!(rewrite_media_paths_in(dirs, &lookup));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_fresh_install_check_finds_records_and_skips_only_missing_folders() {
        let root = std::env::temp_dir().join(format!("fwf-any-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("notes.txt"), b"x").unwrap();
        // Missing folders and a folder without a `.json` hold no record.
        assert!(!any_records_in(&[a.clone(), root.join("missing")]));
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("r.json"), b"{}").unwrap();
        assert!(any_records_in(&[a.clone(), b.clone()]));
        // A path that exists but cannot be listed (here: a regular file) may hide records.
        assert!(any_records_in(&[a.join("notes.txt")]));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn the_fresh_install_check_counts_an_unlistable_folder_as_maybe_holding_records() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("fwf-any-unlisted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("history");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root lists through 0o000, so there is nothing to assert there.
        if std::fs::read_dir(&dir).is_err() {
            // Read as empty, the startup fast path would stamp the heal done without running it.
            assert!(any_records_in(std::slice::from_ref(&dir)));
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_dir_all(&root);
    }
}
