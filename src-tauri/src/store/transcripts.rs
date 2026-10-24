//! Local transcription history: one JSON file per finished run under
//! `<app_data_dir>/transcripts/<id>.json` (dictation sessions under `transcripts/dictation/`).
//!
//! The record content is FRONTEND-OWNED opaque JSON (result, user corrections,
//! speaker renames/colors and the settings used) — Rust stores and lists it
//! but never interprets it, the same contract as `sync-state.json` and
//! `quick_launch`. The files themselves are the source of truth: listing reads
//! the directory, there is no index to corrupt. Records are as sensitive as
//! saved recordings (verbatim transcripts of the user's audio), so they get
//! the same owner-only file/dir permissions.

use crate::commands::require_audio_base;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Serialises a record write against the retention sweep's per-entry stat-then-unlink. The sweeps
/// run on a background thread (`queue_retention_sweeps`), so without it a save could rename a fresh
/// record into place between the sweep's mtime check and its `remove_file`, and the just-saved
/// record would be deleted. Held per entry, never for a whole sweep, so a save waits at most one
/// stat + unlink. The media-path rewriters (`rewrite_media_paths`, `heal_media_paths`) hold it per
/// record across their re-read and rewrite too: they run on a background thread (the launch
/// audio-layout job, an audio-base move) while saves and sweeps stay live, so an unlocked rewrite
/// could overwrite a newer save with the stale copy it read, or resurrect a record a sweep or the
/// user's delete just removed.
/// Holders: `save_transcript_record`, the retention sweeps (`prune_transcripts`, `wipe_records`),
/// the two rewriters, and `delete_transcript_record` (across its record read + unlink only).
/// Slow-share I/O (the heal's path stats, the delete's media-copy and recordings-folder unlinks)
/// runs outside the hold, so a stalled share cannot stall a main-thread save.
/// The destructive commands (`delete_transcript_record`, `delete_all_dictations`,
/// `clear_file_transcriptions`, `remove_transcript_media`) run on the blocking pool, so they
/// too may overlap a save or sweep and rely on this per-entry lock, not on IPC ordering.
static RECORD_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn record_io_lock() -> std::sync::MutexGuard<'static, ()> {
    RECORD_IO.lock().unwrap_or_else(|e| e.into_inner())
}

/// Every media path a rewrite or heal re-pointed this session (old absolute path → new
/// absolute path). The History mirror may still hold a record listed before the move, and
/// `save_transcript_record` writes the webview's record whole: a re-save from that listing (an
/// edit, a coalesced translate chunk) would put the dead path back after the heal passed it —
/// for good, since the heal stamp is then written. The save re-points through this map instead.
/// Noted under the record's `RECORD_IO` hold (see `fix_records_in`), so a save that waited on
/// it sees the move; locked after `RECORD_IO`, never before.
static MOVED: std::sync::Mutex<Option<Moved>> = std::sync::Mutex::new(None);

/// The session's moved paths: `fwd` (old → new, what a save re-points through) and its reverse
/// index `rev` (new → every old mapped onto it), so chaining a note touches only the entries
/// that pointed at the moved path: a move or heal notes once per re-pointed field, so scanning
/// the whole map per note would make a large history's move quadratic.
#[derive(Default)]
struct Moved {
    fwd: std::collections::HashMap<String, String>,
    rev: std::collections::HashMap<String, Vec<String>>,
}

fn note_moved(old: String, new: String) {
    let mut moved = MOVED.lock().unwrap_or_else(|e| e.into_inner());
    note_moved_in(moved.get_or_insert_with(Default::default), old, new);
}

/// Add `old → new` to `moved`, chaining: an entry that pointed at `old` now points at `new`, so
/// a path moved twice (layout migration, then a base move) still maps to where it is now. An
/// entry moved back onto itself is dropped.
fn note_moved_in(moved: &mut Moved, old: String, new: String) {
    if old == new {
        return;
    }
    // `old` is re-noted: its earlier target no longer has it as a source.
    if let Some(prev) = moved.fwd.get(&old) {
        if let Some(sources) = moved.rev.get_mut(prev) {
            sources.retain(|s| *s != old);
            if sources.is_empty() {
                moved.rev.remove(prev);
            }
        }
    }
    for source in moved.rev.remove(&old).unwrap_or_default() {
        if source == new {
            moved.fwd.remove(&source);
        } else {
            moved.fwd.insert(source.clone(), new.clone());
            moved.rev.entry(new.clone()).or_default().push(source);
        }
    }
    moved.rev.entry(new.clone()).or_default().push(old.clone());
    moved.fwd.insert(old, new);
}

/// The three [`MEDIA_KEYS`] fields of a record, and nothing else: serde skips every other field
/// without building it, so a multi-MB record with word timestamps costs one linear pass.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaFields {
    media_path: Option<String>,
    video_path: Option<String>,
    source_path: Option<String>,
}

/// A save's record re-pointed by [`repoint_moved`]: the JSON to write, and each media field it
/// re-pointed with its new path. The webview's History mirror still names the old paths, so the
/// save hands `fields` back: every later chunk merge or edit reads that mirror copy.
#[derive(Debug, PartialEq)]
struct Repointed {
    record: String,
    fields: std::collections::HashMap<&'static str, String>,
}

/// `record` with every media field ([`MEDIA_KEYS`]) that names a moved path re-pointed, or
/// `None` when nothing in it moved (or it does not parse) — then it is written as sent. No stat:
/// the save is a main-thread command and the base may be stalled. Every save after a move or
/// heal comes through here for the rest of the session, and `moved` may then hold thousands of
/// paths: so one typed parse of the three media fields and three lookups decide, and the full
/// parse + re-serialize runs only for a record that really names a moved path.
fn repoint_moved(
    record: &str,
    moved: &std::collections::HashMap<String, String>,
) -> Option<Repointed> {
    if moved.is_empty() {
        return None;
    }
    let media = serde_json::from_str::<MediaFields>(record).ok()?;
    let hits: Vec<(&'static str, &String)> = MEDIA_KEYS
        .into_iter()
        .zip([media.media_path, media.video_path, media.source_path])
        .filter_map(|(key, path)| moved.get(path?.as_str()).map(|new| (key, new)))
        .collect();
    if hits.is_empty() {
        return None;
    }
    let mut v = serde_json::from_str::<serde_json::Value>(record).ok()?;
    // A derived struct also reads a JSON array positionally: only an object is re-pointed.
    let obj = v.as_object_mut()?;
    for &(key, new) in &hits {
        obj.insert(key.to_owned(), serde_json::Value::String(new.clone()));
    }
    Some(Repointed {
        record: serde_json::to_string(&v).ok()?,
        fields: hits
            .into_iter()
            .map(|(key, new)| (key, new.clone()))
            .collect(),
    })
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
/// to the file-transcription sweep.
fn dictations_dir(app: &AppHandle) -> Result<PathBuf, String> {
    transcripts_dir(app).map(|d| d.join("dictation"))
}

/// Both record folders (file/url + dictation): the set every media-path walk and its launch
/// predicate (`has_any_records`) share, so the fast path never stamps a folder the heal skips.
fn record_dirs(app: &AppHandle) -> Vec<PathBuf> {
    [transcripts_dir(app), dictations_dir(app)]
        .into_iter()
        .flatten()
        .collect()
}

/// Every record field that may hold a media path. Dictation records keep their audio under
/// `sourcePath`, file/url records under `mediaPath` (+ `videoPath`): the move rewrite, the heal
/// and `record_media_paths` all read this one list, so a moved file is re-pointed and healed in
/// whichever field carries it.
const MEDIA_KEYS: [&str; 3] = ["mediaPath", "videoPath", "sourcePath"];

/// The pre-single-base media store (`transcripts/media`) — referenced only by
/// the startup migration in `commands::ensure_audio_layout`.
pub(crate) fn legacy_media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    transcripts_dir(app).map(|d| d.join("media"))
}

/// Audio copies of file-transcription inputs: `<base>/files/<id>.<ext>`.
/// `custom` is the audio-base preference from settings (None = default).
/// Same opaque contract as the records: Rust never reads the audio.
pub(crate) fn files_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    require_audio_base(app, custom).map(|b| b.join(crate::commands::AUDIO_SUBDIRS[1]))
}

/// Downloaded audio of link transcriptions: `<base>/links/<id>.<ext>` — the
/// only playable source for those records.
pub(crate) fn links_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    require_audio_base(app, custom).map(|b| b.join(crate::commands::AUDIO_SUBDIRS[2]))
}

/// Downloaded VIDEO of link transcriptions: `<base>/video/<id>.<ext>` — kept
/// for export (no in-app video playback yet).
pub(crate) fn video_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    require_audio_base(app, custom).map(|b| b.join(crate::commands::AUDIO_SUBDIRS[3]))
}

/// Every record media folder — files/, links/, video/ — from one base resolution. The
/// single list cleanup and the storage readout share, so a new media kind cannot be
/// left out of one of them.
fn all_media_dirs(app: &AppHandle, custom: Option<String>) -> Result<[PathBuf; 3], String> {
    let base = require_audio_base(app, custom)?;
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
    let Some(v) = read_json_value(&path) else {
        return Vec::new();
    };
    MEDIA_KEYS
        .iter()
        .filter_map(|k| v.get(*k).and_then(|p| p.as_str()))
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// The `kind` field of one record ("file" | "url" | "text" | "dictation"), if the
/// record exists and parses. Used by the layout migration to route media.
pub(crate) fn record_kind(app: &AppHandle, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    let path = transcripts_dir(app).ok()?.join(format!("{id}.json"));
    let v = read_json_value(&path)?;
    v.get("kind")?.as_str().map(str::to_owned)
}

/// Rewrite a record for a path fix-up (move / heal), restoring `mtime` for the retention reason
/// in `write_record_keeping_mtime`: an audio move keeps the file's mtime (a cross-volume one too,
/// see `copy_keeping_mtime`), so the record's clock must not reset either.
fn rewrite_record_keep_mtime(path: &Path, out: &str, mtime: Option<std::time::SystemTime>) -> bool {
    if crate::config::write_private_atomic(path, out).is_err() {
        return false;
    }
    if let Some(t) = mtime {
        restore_mtime(path, t);
    }
    true
}

/// Best effort: a record whose clock could not be set back is still saved.
fn restore_mtime(path: &Path, t: std::time::SystemTime) {
    if let Ok(f) = std::fs::File::options().append(true).open(path) {
        let _ = f.set_modified(t);
    }
}

/// Write a record, keeping the mtime of the file it replaces; a first write dates it now.
/// Retention ages a record and its dictation audio by their own mtimes, so a re-save (a text
/// edit, an export-track toggle) that reset the record's clock would let it outlive its audio
/// by up to a whole window — Settings promises text and audio leave together.
fn write_record_keeping_mtime(path: &Path, out: &str) -> std::io::Result<()> {
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    crate::config::write_private_atomic(path, out)?;
    if let Some(t) = mtime {
        restore_mtime(path, t);
    }
    Ok(())
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
/// let `fix` map each media field (`MEDIA_KEYS`; key, stored path → new path), and write back the
/// ones it changed, keeping their mtime.
/// The move rewrite and the heal share it so both count a miss alike: a missing folder, a
/// record a sweep removed first, a non-UTF-8 file and an unparsable one are nothing the History
/// listing could load either and are skipped; anything else unread may hide a moved path and is
/// counted (`FixTally`). `size_cap` skips records the listing skips as oversized.
fn fix_records_in(
    dirs: &[PathBuf],
    what: &str,
    size_cap: Option<u64>,
    mut fix: impl FnMut(&str, &str) -> Option<String>,
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
            if !is_record_file(&path) {
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
            // Two passes so `fix` (the heal stats arbitrary user paths, possibly on an offline
            // share) never runs under `RECORD_IO`: first read, parse and map without the lock;
            // then, under it, re-read and apply each change only where the field still holds the
            // value it was computed from. A record a sweep removed first is skipped, not
            // resurrected; other read failures (a sync client's or antivirus's lock) may hide a
            // moved path.
            let read = |path: &Path, tally: &mut FixTally| match std::fs::read_to_string(path) {
                Ok(t) => serde_json::from_str::<serde_json::Value>(&t).ok(),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData
                    ) =>
                {
                    None
                }
                Err(_) => {
                    tally.failed += 1;
                    None
                }
            };
            let Some(v) = read(&path, &mut tally) else {
                continue;
            };
            let changes: Vec<(&str, String, String)> = MEDIA_KEYS
                .iter()
                .filter_map(|&key| {
                    let old = v.get(key)?.as_str()?;
                    fix(key, old).map(|new| (key, old.to_owned(), new))
                })
                .collect();
            if changes.is_empty() {
                continue;
            }
            // Held across the re-read and rewrite only — see `RECORD_IO`.
            let _io = record_io_lock();
            let Some(mut v) = read(&path, &mut tally) else {
                continue;
            };
            // A save or delete that got there first changed the field: not ours to touch, and
            // not a failure.
            let applied: Vec<&(&str, String, String)> = changes
                .iter()
                .filter(|(key, old, _)| v.get(*key).and_then(|m| m.as_str()) == Some(old.as_str()))
                .collect();
            if applied.is_empty() {
                continue;
            }
            for (key, _, new) in &applied {
                v[*key] = serde_json::Value::String(new.clone());
            }
            let Ok(out) = serde_json::to_string(&v) else {
                tally.failed += 1;
                continue;
            };
            // Re-stat under the lock: the DirEntry's metadata may predate a save.
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            if rewrite_record_keep_mtime(&path, &out, mtime) {
                tally.fixed += 1;
                // Still under the record's hold, so a save that waited on it sees the move.
                for (_, old, new) in applied {
                    note_moved(old.clone(), new.clone());
                }
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

/// Re-point every media field ([`MEDIA_KEYS`]) of every record whose stored path appears in
/// `lookup` (old absolute path → new absolute path), after a migration or base move.
/// Best-effort per record; a record that fails to parse is left untouched. Returns false when
/// a record that may point at a moved file could not be read or rewritten (locked, unreadable,
/// disk full) or a history folder could not be listed: the caller must then leave the heal to
/// re-point it by basename, or it stays broken for good.
pub(crate) fn rewrite_media_paths(
    app: &AppHandle,
    lookup: &std::collections::HashMap<&str, &str>,
) -> bool {
    rewrite_media_paths_in(&record_dirs(app), lookup)
}

fn rewrite_media_paths_in(
    dirs: &[PathBuf],
    lookup: &std::collections::HashMap<&str, &str>,
) -> bool {
    let tally = fix_records_in(dirs, "rewrite", None, |_, old| {
        lookup.get(old).map(|n| (*n).to_owned())
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
/// `AUDIO_SUBDIRS` order would re-point a stale `videoPath` at the audio-only copy. A video lives
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
/// lives under one of the audio-base subfolders (same basename), or that still name
/// a leftover in a migrated old app folder (`migrated_counterpart`). Heals
/// records a past move rewrote incompletely — earlier builds only rewrote
/// `mediaPath`, stranding every dictation record's `sourcePath` when the
/// layout migration moved the files into `<base>/dictations`. Idempotent, but
/// NOT cheap — it reads and parses every record — so the caller runs it after a
/// migration that moved something and once per install, not every launch.
/// Returns `(complete, fixed)`. `complete` is false when a record could not be read or
/// rewritten or a history folder could not be listed: the caller must then keep the heal armed,
/// or that record stays broken. `fixed` counts the records re-pointed: none means a History
/// listing has nothing to reload for.
pub(crate) fn heal_media_paths(app: &AppHandle, base: &std::path::Path) -> (bool, usize) {
    heal_media_paths_in(&record_dirs(app), base)
}

fn heal_media_paths_in(dirs: &[PathBuf], base: &Path) -> (bool, usize) {
    let subs = crate::commands::AUDIO_SUBDIRS;
    // Same size guard as `read_records_into`: an oversized record is skipped
    // there too, so parsing it here would be work for a record nobody loads.
    let tally = fix_records_in(dirs, "heal", Some(MAX_RECORD_BYTES), |key, old| {
        let old_path = std::path::Path::new(old);
        if !old_path.is_absolute() {
            return None;
        }
        // A leftover of the old app folder still exists, but its file moved with the folder.
        if let Some(moved) = crate::migrate_identifier::migrated_counterpart(old_path) {
            return Some(moved.to_string_lossy().into_owned());
        }
        // Otherwise only local absolute paths that are actually gone (a URL in
        // `sourcePath` or a still-valid path is not ours to touch).
        if old_path.exists() {
            return None;
        }
        let name = old_path.file_name()?;
        heal_candidates(key, old_path, &subs)
            .into_iter()
            .map(|s| base.join(s).join(name))
            .find(|c| c.exists())
            .map(|found| found.to_string_lossy().into_owned())
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
    (tally.complete(), tally.fixed)
}

/// Size cap for a media copy, a link-media download and an export's upload. An over-cap copy
/// is skipped (the record keeps playing from the original while it exists).
pub(crate) const MAX_MEDIA_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// Is `path` named like a stored record (`<id>.json`)?
fn is_record_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

/// A record file parsed as JSON; `None` when it cannot be read or does not parse.
fn read_json_value(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

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
/// user's file named either way must not read as ours. `valid_id` is only the looser PATH-SAFETY
/// predicate for command inputs: it accepts any 8+ hex-ish stem, so a user's own `20260901.mp3`
/// or `12345678.wav` would read as ours and be deleted.
pub(crate) fn is_uuid_id(s: &str) -> bool {
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

/// Is this an in-progress `.tmp` copy (`<id>.<ext>.tmp`, or a download's
/// `<id>.<ext>.<pid>-<seq>.tmp`) rather than a finished one? A bare `<uuid>.tmp` is the finished
/// copy an older build kept of a transcribed `.tmp` source (see `media_copy_ext`): no in-progress
/// name has a bare record id for its stem, so that one is swept, counted and moved like any copy.
pub(crate) fn is_partial_copy(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("tmp") && !is_own_media(path)
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
            if is_partial_copy(&path) || !own(&path) {
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
/// delete confirm names audio files, and counting the sidecars there would double the number.
fn recordings_usage(dir: &Path) -> (u64, u32, u32) {
    owned_dir_tally(dir, is_own_recording, is_wav)
}

/// Is this a `.wav` — the audio half of a dictation's `.wav` + `.txt` pair.
fn is_wav(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("wav")
}

/// Does the transcript store hold ANY `.json` record? Cheap (a directory listing), so the
/// startup migration can skip the full read+parse heal on a fresh install. Walks the heal's own
/// `record_dirs`, so the predicate and the work it guards agree on what a record is.
pub fn has_any_records(app: &AppHandle) -> bool {
    any_records_in(&record_dirs(app))
}

/// `has_any_records` over `dirs`. Only a missing folder or a clean listing without a `.json`
/// counts as empty: one that exists but cannot be listed (or fails mid-listing) may hide
/// records, so it answers true and the heal runs — and, like `fix_records_in`, reports the
/// folder incomplete instead of the fast path stamping it healed.
fn any_records_in(dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|d| match list_dir(d, "history") {
        Ok(Some(entries)) => entries
            .into_iter()
            .any(|e| e.map_or(true, |x| is_record_file(&x.path()))),
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

/// Write (create or replace) one history record, keeping a replaced record's date (see
/// `write_record_keeping_mtime`). Atomic tmp+rename with owner-only permissions, cleanup on
/// both failure paths. Resolves to the media fields the save re-pointed (key → new path; empty
/// when none did), so the webview's mirror stops naming the paths a move took away.
#[tauri::command]
pub fn save_transcript_record(
    app: AppHandle,
    id: String,
    record: String,
    dictation: Option<bool>,
) -> Result<std::collections::HashMap<&'static str, String>, String> {
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
    // A record from a listing taken before this session's move or heal may name a dead path.
    let repointed = MOVED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|moved| repoint_moved(&record, &moved.fwd));
    write_record_keeping_mtime(
        &path,
        repointed
            .as_ref()
            .map_or(record.as_str(), |r| r.record.as_str()),
    )
    .map_err(|e| e.to_string())?;
    Ok(repointed.map(|r| r.fields).unwrap_or_default())
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
    crate::commands::blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let mut out = Vec::new();
        read_records_into(&transcripts, &mut out)?;
        read_records_into(&dictations, &mut out)?;
        Ok(out)
    })
    .await
}

fn read_records_into(dir: &Path, out: &mut Vec<serde_json::Value>) -> Result<(), String> {
    let Some(entries) = list_dir(dir, "history")? else {
        return Ok(());
    };
    for entry in entries {
        // A folder-level readdir failure would otherwise truncate the listing silently.
        let entry = entry.map_err(|e| format!("could not list the history folder: {e}"))?;
        let path = entry.path();
        if !is_record_file(&path) {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > MAX_RECORD_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        if let Some(v) = read_json_value(&path) {
            out.push(v);
        }
    }
    Ok(())
}

/// Delete one record's file. Tries both stores: ids are UUIDs, so the same id can only exist in
/// one. The record's audio copy (if any) goes with it, only once the record is gone.
/// The command settles as soon as the record unlink ran: the media unlinks wait out this launch's
/// audio-layout migration, which may sit on a stalled base (a sleeping disk, an offline share),
/// so they run on a detached thread ([`spawn_delete_media`]). The webview tracks this IPC in its
/// pending-writes set, and a `transcripts://swept` reload or a Settings cleanup waits on that
/// set: a hung delete would keep History listing records a sweep already removed.
#[tauri::command]
pub async fn delete_transcript_record(
    app: AppHandle,
    id: String,
    audio_base: Option<String>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("malformed record id".into());
    }
    crate::commands::blocking(move || -> Result<(), String> {
        // Media only after a successful unlink: a failed one (Windows briefly locking the file)
        // keeps the History entry, which must keep its playable media too. The record unlink
        // never waits for the migration, or a quit during the wait would bring the record back.
        let name = format!("{id}.json");
        let file_path = transcripts_dir(&app)?.join(&name);
        let source_of = |p: &Path| -> Option<String> {
            read_json_value(p).and_then(|v| v.get("sourcePath")?.as_str().map(str::to_owned))
        };
        // Held across both branches' record read + unlink — see `RECORD_IO`: a media-path
        // rewrite that read this record before the unlink would otherwise rename its copy back
        // into place afterwards.
        let io = record_io_lock();
        if file_path.exists() {
            let res = std::fs::remove_file(file_path).map_err(|e| e.to_string());
            drop(io);
            if res.is_ok() {
                spawn_delete_media(app, id, audio_base, None);
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
        let src: Option<String> = source_of(&rec_path);
        let res = std::fs::remove_file(rec_path).map_err(|e| e.to_string());
        // The audio unlink touches no record file and the record is gone, so no rewriter can
        // re-point it: release the lock first, or a slow recordings share would hold every
        // (main-thread) save hostage.
        drop(io);
        if !existed {
            spawn_delete_media(app, id, audio_base, None);
            return Ok(());
        }
        // The recording too goes only after a successful unlink. A dictation without audio stores
        // `sourcePath: ""` and has nothing to drop.
        if let (Ok(()), Some(src)) = (&res, src.filter(|s| !s.trim().is_empty())) {
            spawn_delete_media(app, id, audio_base, Some(src));
        }
        res
    })
    .await
}

/// Run [`delete_record_media`] on a detached thread, so `delete_transcript_record` settles
/// without waiting for the audio-layout migration; inline when the thread cannot start (the
/// delete then waits rather than leave the audio behind).
fn spawn_delete_media(
    app: AppHandle,
    id: String,
    audio_base: Option<String>,
    dictation_src: Option<String>,
) {
    // A spawn error consumes the closure, so the inline fallback keeps its own copy.
    let fallback = (
        app.clone(),
        id.clone(),
        audio_base.clone(),
        dictation_src.clone(),
    );
    let spawned = std::thread::Builder::new()
        .name("history-delete-audio".into())
        .spawn(move || delete_record_media(&app, &id, audio_base, dictation_src));
    if let Err(e) = spawned {
        tracing::warn!("[transcripts] could not start the delete-audio worker: {e}");
        let (app, id, audio_base, dictation_src) = fallback;
        delete_record_media(&app, &id, audio_base, dictation_src);
    }
}

/// The media half of `delete_transcript_record`, run once the record is gone and never under
/// `RECORD_IO` (the migration's rewrite takes it per record, so waiting under it would
/// deadlock). `dictation_src` None: the record's `files/`/`links/`/video copies, unlinked once
/// this launch's audio-layout migration is over, since it can move a file in after the delete
/// looked (see delete_all_dictations). Some: a dictation's stored recording, unlinked once
/// before that wait too, so a quit mid-wait leaves at most the one file the migration is moving
/// at that moment. The record is already gone, so no rewrite re-points that recording: after the
/// wait the stored path is tried again and, if it is gone (normally: the first unlink took it;
/// or the migration moved it), the file is looked for under its migrated name in the recordings
/// folder too.
fn delete_record_media(
    app: &AppHandle,
    id: &str,
    audio_base: Option<String>,
    dictation_src: Option<String>,
) {
    match dictation_src {
        None => {
            crate::commands::wait_audio_layout();
            if let Ok(dirs) = all_media_dirs(app, audio_base) {
                for dir in dirs {
                    remove_media_for(&dir, id);
                }
            }
        }
        Some(src) => {
            remove_dictation_audio(&src);
            crate::commands::wait_audio_layout();
            let stored = Path::new(&src);
            let moved = !stored.exists();
            remove_dictation_audio(&src);
            if moved {
                if let (Some(dir), Some(file)) = (
                    crate::commands::resolve_recordings_dir(app, audio_base),
                    stored.file_name(),
                ) {
                    let twin = dir.join(file);
                    if twin != stored {
                        remove_dictation_audio(&twin.to_string_lossy());
                    }
                }
            }
        }
    }
}

/// The extension a media copy of `src` keeps: the source's own, lowercased, when it is short and
/// plain, else `bin`. Never `tmp`: a `.tmp` name reads as an in-progress copy, and the sweeps and
/// folder moves take a final `<id>.tmp` only as older builds' leftover (`is_partial_copy`).
fn media_copy_ext(src: &Path) -> String {
    src.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| {
            !e.is_empty()
                && e.len() <= 5
                && e.bytes().all(|b| b.is_ascii_alphanumeric())
                && e != "tmp"
        })
        .unwrap_or_else(|| "bin".into())
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
    crate::commands::blocking(move || {
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
        let ext = media_copy_ext(&src);
        let dest = dir.join(format!("{id}.{ext}"));
        let tmp = dir.join(format!("{id}.{ext}.tmp"));
        crate::config::replace_via_tmp(&tmp, &dest, |t| {
            std::fs::copy(&src, t)?;
            // Owner-only like the records themselves (copy inherits source perms). On Windows the
            // file inherits the DACL of a `files/` folder that may have pre-existed the pick (a
            // restored or synced tree), so it gets the same per-file DACL the recordings get.
            crate::audio::restrict_file_private(t);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
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
    crate::commands::blocking(move || -> Result<serde_json::Value, String> {
        fn count_json(dir: &Path) -> u32 {
            std::fs::read_dir(dir)
                .map(|e| e.flatten().filter(|x| is_record_file(&x.path())).count() as u32)
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
}

/// "Delete all dictations": every stored session record AND every app-owned
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
    crate::commands::blocking(move || -> Result<u32, String> {
        // Waits out this launch's audio-layout migration FIRST: a file it moves in after the
        // wipe listed the recordings folder would be left behind. The record wipe waits with it,
        // not ahead of it: this command emits no `transcripts://swept`, so the webview reloads
        // its History mirror only when the IPC settles. Wiped early, the records would stay
        // listed (and editable, so a save could write one back) for as long as the wait lasts.
        crate::commands::wait_audio_layout();
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
    crate::commands::blocking(move || -> Result<u32, String> {
        // As delete_all_dictations: the wait comes first, since the orphan sweep must see the
        // migrated layout, and the record wipe waits with it so it lands together with the IPC
        // settle that reloads the History mirror (no `transcripts://swept` here).
        crate::commands::wait_audio_layout();
        let removed = wipe_records(&transcripts_dir(&app)?)? as u32;
        sweep_orphan_media(&app, audio_base);
        Ok(removed)
    })
    .await
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
    crate::commands::blocking(move || -> Result<u32, String> {
        // As delete_all_dictations: a file the layout migration moves in after the listing stays.
        crate::commands::wait_audio_layout();
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

/// Drop media files whose record is gone (retention pruning, wipes), so a copy lives exactly
/// as long as its transcript; never an in-progress `.tmp` copy (see `sweep_orphans_in`).
fn sweep_orphan_media(app: &AppHandle, audio_base: Option<String>) {
    let Ok(records) = transcripts_dir(app) else {
        return;
    };
    let Ok(dirs) = all_media_dirs(app, audio_base) else {
        return;
    };
    let removed: usize = dirs.iter().map(|d| sweep_orphans_in(d, &records)).sum();
    if removed > 0 {
        tracing::info!("[transcripts] media sweep: removed {removed} orphaned audio cop(y/ies)");
    }
}

/// `sweep_orphan_media` over one media folder; returns the removed count.
fn sweep_orphans_in(dir: &Path, records: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // An in-progress copy (`<id>.<ext>.tmp`, written on a blocking thread for up
        // to MAX_MEDIA_BYTES = 10 GiB) is not an orphan: this sweep runs on every
        // config save, and unlinking the tmp under the writer would fail its final
        // rename, silently losing the record's only playable audio.
        if is_partial_copy(&path) {
            // A media download tmp of another (so dead: single-instance) process has no
            // writer left, and nothing else would ever reclaim it once its record is gone.
            let stale = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(crate::transport::batch::stale_download_tmp);
            if stale && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
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
    removed
}

/// Delete records older than `days` (0 = keep forever), with the same clamped mtime window as
/// `audio::prune_older_than`. Its own loop rather than that helper: each entry is re-stat'd and
/// unlinked under [`RECORD_IO`], so a record `save_transcript_record` just wrote for the first
/// time (fresh mtime) is never deleted on the strength of an older file's age.
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
        if !is_record_file(&path) {
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
/// - Dictations: `effective_dictation_days`, the same window the recordings sweep uses — and
///   when `keepDictationHistory` is off, the whole dictation store is wiped (the setting's copy
///   promises exactly that).
///
/// When any record went, `transcripts://swept` (payload: `{ removed, dictationsWiped }` — the
/// record count, and whether this sweep actually emptied the dictation store; read by
/// `listenRetentionSweeps` in src/lib/transcript/transcriptHistory.ts) tells the History
/// mirror to reload — otherwise it keeps listing, and an edit re-saves, a deleted entry.
/// Records only (app data): the orphan-media half walks the (possibly slow, network-share)
/// audio base and is `apply_transcripts_media_retention`, which the caller runs after this
/// launch's audio-layout migration — this half never waits for it.
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
}

/// The audio-base half of the history retention: drop the media copies whose record
/// `apply_transcripts_retention` (or anything else) removed. Changes no record; must see the
/// migrated layout, so the caller runs it after `wait_audio_layout`.
pub(crate) fn apply_transcripts_media_retention(app: &AppHandle, config: &crate::config::Config) {
    sweep_orphan_media(app, crate::commands::audio_base_pref(&config.settings));
}

/// List `dir`: a missing folder is nothing to read (`None`), but one that exists and cannot be
/// listed is an error — never a silent "removed 0" (an empty History, a heal marked done) while
/// every file stays on disk.
fn list_dir(dir: &Path, what: &str) -> Result<Option<std::fs::ReadDir>, String> {
    match std::fs::read_dir(dir) {
        Ok(entries) => Ok(Some(entries)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not list the {what} folder: {e}")),
    }
}

/// Remove every record in `dir` regardless of age ("Save dictations to History"
/// turned off, or a "Delete all"). Only touches `.json` files, like the prune.
fn wipe_records(dir: &Path) -> Result<usize, String> {
    let Some(entries) = list_dir(dir, "history")? else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_record_file(&path) {
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

    /// A `.tmp` source would leave a final copy every sweep takes for an in-progress one, never
    /// reclaimed once its record goes.
    #[test]
    fn a_media_copy_never_keeps_a_tmp_extension() {
        assert_eq!(media_copy_ext(Path::new("/home/u/capture.tmp")), "bin");
        assert_eq!(media_copy_ext(Path::new("/home/u/capture.TMP")), "bin");
        assert_eq!(media_copy_ext(Path::new("/home/u/talk.M4A")), "m4a");
        assert_eq!(media_copy_ext(Path::new("/home/u/talk")), "bin");
        assert_eq!(media_copy_ext(Path::new("/home/u/talk.toolong")), "bin");
    }

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
        let dir = crate::config::fresh_test_dir("atomic");
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
        let dir = crate::config::fresh_test_dir("dict-rm");
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
        let dir = crate::config::fresh_test_dir("store-stats");
        let own = "9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b";
        std::fs::write(dir.join(format!("{own}.m4a")), b"12345").unwrap();
        std::fs::write(dir.join(format!("{own}.m4a.tmp")), b"1234567").unwrap();
        std::fs::write(dir.join("holiday video.mp4"), b"123456789").unwrap();
        assert_eq!(owned_dir_bytes(&dir, is_own_media), (5, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An older build kept a transcribed `.tmp` source's copy as `<uuid>.tmp`: once its record
    /// goes, the orphan sweep reclaims it and the readout counts it, while an in-progress copy
    /// keeps its own handling.
    #[test]
    fn an_older_builds_bare_tmp_copy_is_swept_and_counted_like_any_copy() {
        let base = crate::config::fresh_test_dir("tmp-copy");
        let (dir, records) = (base.join("files"), base.join("transcripts"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&records).unwrap();
        let orphan = "9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b";
        let kept = "0f8b5c2e-6d1a-4c3b-9e7f-1a2b3c4d5e6f";
        std::fs::write(records.join(format!("{kept}.json")), b"{}").unwrap();
        std::fs::write(dir.join(format!("{orphan}.tmp")), b"123").unwrap();
        std::fs::write(dir.join(format!("{kept}.tmp")), b"12345").unwrap();
        let me = std::process::id();
        let other = me.wrapping_add(1);
        for partial in [
            format!("{orphan}.mp3.tmp"),
            format!("{orphan}.mp3.{me}-1.tmp"),
            format!("{orphan}.mp3.{other}-1.tmp"),
        ] {
            std::fs::write(dir.join(partial), b"1234567").unwrap();
        }
        assert_eq!(owned_dir_bytes(&dir, is_own_media), (8, 2));
        assert_eq!(sweep_orphans_in(&dir, &records), 2);
        assert!(!dir.join(format!("{orphan}.tmp")).exists());
        assert!(!dir.join(format!("{orphan}.mp3.{other}-1.tmp")).exists());
        assert!(dir.join(format!("{kept}.tmp")).exists());
        assert!(dir.join(format!("{orphan}.mp3.tmp")).exists());
        assert!(dir.join(format!("{orphan}.mp3.{me}-1.tmp")).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_recordings_readout_counts_sidecars_as_files_but_not_as_audio() {
        let dir = crate::config::fresh_test_dir("rec-stats");
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
        let dir = crate::config::fresh_test_dir("rec-lossy");
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
        let dir = crate::config::fresh_test_dir("rec-wipe");
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
        let dir = crate::config::fresh_test_dir("list");
        // A missing folder (first launch) is an empty history, not a failure.
        let mut out = Vec::new();
        assert!(read_records_into(&dir.join("missing"), &mut out).is_ok());
        assert!(out.is_empty());
        // One corrupt record never hides the rest.
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
        let dir = crate::config::fresh_test_dir("wipe-list");
        // A missing folder is nothing to delete, not a failure.
        assert_eq!(wipe_records(&dir.join("missing")), Ok(0));
        assert_eq!(remove_own_recordings(&dir.join("missing")), Ok(0));
        // A path that exists but cannot be listed (here: a regular file) rejects, so
        // "Delete all" never reports "Removed 0" while every file stays on disk.
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
        let dir = crate::config::fresh_test_dir("rewrite-mtime");
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
    fn a_re_saved_record_keeps_its_date_and_a_new_one_is_dated_now() {
        let dir = crate::config::fresh_test_dir("resave-mtime");
        let rec = dir.join("aaaa1111.json");
        std::fs::write(&rec, b"{}").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(5 * 86_400);
        let f = std::fs::File::options().append(true).open(&rec).unwrap();
        f.set_modified(old).unwrap();
        drop(f);
        write_record_keeping_mtime(&rec, "{\"edited\":true}").unwrap();
        assert_eq!(std::fs::read_to_string(&rec).unwrap(), "{\"edited\":true}");
        assert_eq!(std::fs::metadata(&rec).unwrap().modified().unwrap(), old);

        let fresh = dir.join("bbbb2222.json");
        write_record_keeping_mtime(&fresh, "{}").unwrap();
        let age = std::time::SystemTime::now()
            .duration_since(std::fs::metadata(&fresh).unwrap().modified().unwrap())
            .unwrap_or_default();
        assert!(age < std::time::Duration::from_secs(60), "{age:?}");
        // The edited record still leaves with a 1-day retention; the new one stays.
        assert_eq!(prune_transcripts(&dir, 1), 1);
        assert!(!rec.exists() && fresh.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_only_touches_old_json() {
        let dir = crate::config::fresh_test_dir("transcripts-prune");
        let old = dir.join("aaaa1111.json");
        std::fs::write(&old, b"{}").unwrap();
        let keep = dir.join("notes.txt");
        std::fs::write(&keep, b"x").unwrap();
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
        let dir = crate::config::fresh_test_dir("rewrite");
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

    fn moved_target(old: &str) -> Option<String> {
        MOVED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|m| m.fwd.get(old).cloned())
    }

    #[test]
    fn a_media_fix_maps_paths_without_holding_the_record_lock() {
        let dir = crate::config::fresh_test_dir("fixlock");
        let old = format!("/fwf-fixlock-{}/old/a.wav", std::process::id());
        let new = format!("/fwf-fixlock-{}/new/a.wav", std::process::id());
        std::fs::write(dir.join("r.json"), format!(r#"{{"mediaPath":"{old}"}}"#)).unwrap();
        let tally = fix_records_in(std::slice::from_ref(&dir), "heal", None, |_, p| {
            // A save (main thread) must be able to take the lock while `fix` stats: retried,
            // since other tests may hold it — across an fsync, which after a build's burst of
            // writes took over 2 s. Only `fix` running under the lock itself waits this out.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while RECORD_IO.try_lock().is_err() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "`fix` ran under RECORD_IO"
                );
                std::thread::yield_now();
            }
            (p == old).then(|| new.clone())
        });
        assert_eq!((tally.fixed, tally.failed), (1, 0));
        let text = std::fs::read_to_string(dir.join("r.json")).unwrap();
        assert!(text.contains(&new));
        assert_eq!(moved_target(&old).as_deref(), Some(new.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_media_fix_leaves_a_field_a_save_changed_meanwhile_and_notes_no_move() {
        let dir = crate::config::fresh_test_dir("fixrace");
        let rec = dir.join("r.json");
        let old = format!("/fwf-fixrace-{}/old/a.wav", std::process::id());
        let saved = format!("/fwf-fixrace-{}/saved/a.wav", std::process::id());
        std::fs::write(&rec, format!(r#"{{"mediaPath":"{old}"}}"#)).unwrap();
        let tally = fix_records_in(std::slice::from_ref(&dir), "heal", None, |_, p| {
            // A save lands between the unlocked map and the locked rewrite.
            std::fs::write(&rec, format!(r#"{{"mediaPath":"{saved}"}}"#)).unwrap();
            (p == old).then(|| "/elsewhere/a.wav".to_owned())
        });
        assert_eq!((tally.fixed, tally.failed), (0, 0));
        assert!(std::fs::read_to_string(&rec).unwrap().contains(&saved));
        assert_eq!(moved_target(&old), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_from_a_pre_move_listing_is_re_pointed() {
        let mut moved = Moved::default();
        note_moved_in(
            &mut moved,
            "/old/files/a.m4a".into(),
            "/new/files/a.m4a".into(),
        );
        note_moved_in(
            &mut moved,
            "/old/dictations/d.wav".into(),
            "/new/dictations/d.wav".into(),
        );
        let out = repoint_moved(
            r#"{"id":"x","mediaPath":"/old/files/a.m4a","sourcePath":"/old/dictations/d.wav","text":"/old/files/a.m4a"}"#,
            &moved.fwd,
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.record).unwrap();
        assert_eq!(v["mediaPath"], "/new/files/a.m4a");
        assert_eq!(v["sourcePath"], "/new/dictations/d.wav");
        // The save hands the re-pointed fields back: the webview's mirror still names the old
        // paths.
        assert_eq!(
            out.fields,
            std::collections::HashMap::from([
                ("mediaPath", "/new/files/a.m4a".to_owned()),
                ("sourcePath", "/new/dictations/d.wav".to_owned()),
            ])
        );
        // Only media fields: the same text elsewhere in the record is the user's.
        assert_eq!(v["text"], "/old/files/a.m4a");
        // A record naming no moved path is written as sent.
        assert_eq!(
            repoint_moved(r#"{"mediaPath":"/elsewhere/b.m4a"}"#, &moved.fwd),
            None
        );
        // A moved path that is not a media field's value changes nothing either.
        assert_eq!(
            repoint_moved(r#"{"title":"/old/files/a.m4a"}"#, &moved.fwd),
            None
        );
        assert_eq!(repoint_moved("not json /old/files/a.m4a", &moved.fwd), None);
    }

    #[test]
    fn a_save_whose_media_paths_did_not_move_is_written_as_sent() {
        let mut moved = Moved::default();
        for i in 0..2000 {
            note_moved_in(
                &mut moved,
                format!("/old/files/{i}.m4a"),
                format!("/new/files/{i}.m4a"),
            );
        }
        // Moved paths elsewhere in the record (the user's text, a nested copy) are not media
        // fields; the media fields themselves name unmoved paths, or are null.
        let record = r#"{"id":"x","mediaPath":"/kept/files/7.m4a","videoPath":null,"sourcePath":"","text":"/old/files/7.m4a","result":{"mediaPath":"/old/files/8.m4a"}}"#;
        assert_eq!(repoint_moved(record, &moved.fwd), None);
        // An array never parses as a record, even though the media struct reads one by position.
        assert_eq!(
            repoint_moved(r#"["/old/files/1.m4a",null,null]"#, &moved.fwd),
            None
        );
        // Nothing moved this session (or everything moved back): no parse at all.
        assert_eq!(
            repoint_moved(
                r#"{"mediaPath":"/old/files/1.m4a"}"#,
                &std::collections::HashMap::new()
            ),
            None
        );
    }

    #[test]
    fn a_path_moved_twice_maps_to_where_it_is_now() {
        let mut moved = Moved::default();
        note_moved_in(&mut moved, "/a/x.wav".into(), "/b/x.wav".into());
        note_moved_in(&mut moved, "/b/x.wav".into(), "/c/x.wav".into());
        assert_eq!(
            moved.fwd.get("/a/x.wav").map(String::as_str),
            Some("/c/x.wav")
        );
        assert_eq!(
            moved.fwd.get("/b/x.wav").map(String::as_str),
            Some("/c/x.wav")
        );
        let out = repoint_moved(r#"{"videoPath":"/a/x.wav"}"#, &moved.fwd).unwrap();
        assert!(out.record.contains("/c/x.wav"));
        // Moved back: no entry maps a path onto itself.
        note_moved_in(&mut moved, "/c/x.wav".into(), "/a/x.wav".into());
        assert_eq!(moved.fwd.get("/a/x.wav"), None);
        assert_eq!(
            moved.fwd.get("/b/x.wav").map(String::as_str),
            Some("/a/x.wav")
        );
        assert_eq!(
            moved.fwd.get("/c/x.wav").map(String::as_str),
            Some("/a/x.wav")
        );
    }

    /// The whole-map scan `note_moved_in` used before its reverse index: the reference answers.
    fn note_moved_by_scan(
        moved: &mut std::collections::HashMap<String, String>,
        old: &str,
        new: &str,
    ) {
        for target in moved.values_mut() {
            if target == old {
                *target = new.to_owned();
            }
        }
        moved.retain(|from, to| from != to);
        if old != new {
            moved.insert(old.to_owned(), new.to_owned());
        }
    }

    /// `rev` is exactly `fwd` inverted: every source once, under its one target, no empty list.
    fn assert_rev_inverts_fwd(moved: &Moved) {
        let mut inverted: std::collections::HashMap<&str, Vec<&str>> = Default::default();
        for (from, to) in &moved.fwd {
            inverted.entry(to).or_default().push(from);
        }
        let mut rev: std::collections::HashMap<&str, Vec<&str>> = Default::default();
        for (to, froms) in &moved.rev {
            assert!(!froms.is_empty(), "empty reverse entry for {to}");
            rev.insert(to, froms.iter().map(String::as_str).collect());
        }
        for v in inverted.values_mut().chain(rev.values_mut()) {
            v.sort_unstable();
        }
        assert_eq!(rev, inverted);
    }

    #[test]
    fn a_moved_chain_collapses_like_the_whole_map_scan() {
        // A→B, B→C, C→A: A moved back onto itself is dropped, B and C both lead to A.
        let mut moved = Moved::default();
        let mut scan = std::collections::HashMap::new();
        for (old, new) in [("A", "B"), ("B", "C"), ("C", "A")] {
            note_moved_in(&mut moved, old.into(), new.into());
            note_moved_by_scan(&mut scan, old, new);
            assert_eq!(moved.fwd, scan);
            assert_rev_inverts_fwd(&moved);
        }
        assert_eq!(moved.fwd.get("A"), None);
        assert_eq!(moved.fwd.get("B").map(String::as_str), Some("A"));
        assert_eq!(moved.fwd.get("C").map(String::as_str), Some("A"));
        // Every sequence over a few paths (self-moves, re-notes, cycles) answers like the scan.
        let paths = ["p", "q", "r", "s"];
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..200 {
            let mut moved = Moved::default();
            let mut scan = std::collections::HashMap::new();
            for _ in 0..12 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let old = paths[(seed % 4) as usize];
                let new = paths[((seed >> 8) % 4) as usize];
                note_moved_in(&mut moved, old.into(), new.into());
                note_moved_by_scan(&mut scan, old, new);
                assert_eq!(moved.fwd, scan, "after {old} → {new}");
                assert_rev_inverts_fwd(&moved);
            }
        }
    }

    #[test]
    fn a_re_noted_path_leaves_its_old_target_chain() {
        // old → X, then old → Y: a later move of X must not drag old along with it.
        let mut moved = Moved::default();
        note_moved_in(&mut moved, "/old/a.wav".into(), "/x/a.wav".into());
        note_moved_in(&mut moved, "/old/a.wav".into(), "/y/a.wav".into());
        assert_eq!(moved.rev.get("/x/a.wav"), None);
        note_moved_in(&mut moved, "/x/a.wav".into(), "/z/a.wav".into());
        assert_eq!(
            moved.fwd.get("/old/a.wav").map(String::as_str),
            Some("/y/a.wav")
        );
        assert_eq!(
            moved.fwd.get("/x/a.wav").map(String::as_str),
            Some("/z/a.wav")
        );
        assert_rev_inverts_fwd(&moved);
    }

    #[cfg(unix)]
    #[test]
    fn heal_reports_an_unreadable_record() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::config::fresh_test_dir("heal");
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
        assert_eq!(heal_media_paths_in(&dirs, &base), (true, 1));
        let ok = std::fs::read_to_string(dir.join("ok.json")).unwrap();
        assert!(ok.contains(&*base.join("files").join("a.wav").to_string_lossy()));
        // A locked record may still point at the gone path: the caller must not stamp the heal.
        let locked = dir.join("locked.json");
        std::fs::write(&locked, format!(r#"{{"mediaPath":"{gone}"}}"#)).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads through 0o000, so there is nothing to assert there.
        if std::fs::read_to_string(&locked).is_err() {
            assert!(!heal_media_paths_in(&dirs, &base).0);
        }
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn heal_reports_an_unlistable_folder() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::config::fresh_test_dir("heal-unlisted");
        let (dir, base) = (root.join("history"), root.join("base"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root lists through 0o000, so there is nothing to assert there.
        if std::fs::read_dir(&dir).is_err() {
            // A folder that exists but cannot be listed may hide any number of records.
            assert!(!heal_media_paths_in(std::slice::from_ref(&dir), &base).0);
            let lookup = std::collections::HashMap::new();
            assert!(!rewrite_media_paths_in(std::slice::from_ref(&dir), &lookup));
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The identifier migration's copy fallback can leave a held file behind in the old app
    /// folder: the record must follow the moved copy, not keep playing the leftover.
    #[test]
    fn heal_re_points_a_leftover_of_the_migrated_app_folder_to_its_copy() {
        use crate::migrate_identifier::{LEGACY_ID, MARKER, NEW_ID};
        let root = std::env::temp_dir().join(format!("fwf-heal-legacy-{}", uuid::Uuid::new_v4()));
        let (dir, old, new) = (
            root.join("history"),
            root.join(LEGACY_ID),
            root.join(NEW_ID),
        );
        let rel = Path::new("audio").join("dictations").join("a.wav");
        std::fs::create_dir_all(&dir).unwrap();
        for app in [&old, &new] {
            std::fs::create_dir_all(app.join(&rel).parent().unwrap()).unwrap();
            std::fs::write(app.join(&rel), b"").unwrap();
        }
        let leftover = old.join(&rel);
        let record = serde_json::json!({ "sourcePath": leftover }).to_string();
        std::fs::write(dir.join("r.json"), &record).unwrap();
        let dirs = std::slice::from_ref(&dir);
        let base = new.join("audio");
        // Not migrated (no marker): a folder that merely carries the old name is left alone.
        assert_eq!(heal_media_paths_in(dirs, &base), (true, 0));
        std::fs::write(new.join(MARKER), b"").unwrap();
        assert_eq!(heal_media_paths_in(dirs, &base), (true, 1));
        let healed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("r.json")).unwrap()).unwrap();
        assert_eq!(healed["sourcePath"], serde_json::json!(new.join(&rel)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_named_like_a_record_is_no_failed_record() {
        let root = crate::config::fresh_test_dir("heal-dirjson");
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
        assert_eq!(heal_media_paths_in(dirs, &base), (true, 1));
        // Nothing left to re-point: complete, and nothing for a History listing to reload.
        assert_eq!(heal_media_paths_in(dirs, &base), (true, 0));
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
        let root = crate::config::fresh_test_dir("any-rec");
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
        let root = crate::config::fresh_test_dir("any-unlisted");
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
