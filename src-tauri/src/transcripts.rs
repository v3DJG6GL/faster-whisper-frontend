//! Local transcription history: one JSON file per finished batch run under
//! `<app_data_dir>/transcripts/<id>.json`.
//!
//! The record content is FRONTEND-OWNED opaque JSON (result + user corrections
//! + speaker renames/colors + the settings used) — Rust stores and lists it
//! but never interprets it, the same contract as `sync-state.json` and
//! `quick_launch`. The files themselves are the source of truth: listing reads
//! the directory, there is no index to corrupt. Records are as sensitive as
//! saved recordings (verbatim transcripts of the user's audio), so they get
//! the same owner-only file/dir permissions.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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

/// Audio copies of file-transcription inputs: `<base>/files/<id>.<ext>`.
/// `custom` is the audio-base preference from settings (None = default).
/// Same opaque contract as the records: Rust never reads the audio.
pub(crate) fn files_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    crate::commands::resolve_audio_base(app, custom)
        .map(|b| b.join("files"))
        .ok_or_else(|| "could not resolve the audio folder".into())
}

/// Downloaded audio of link transcriptions: `<base>/links/<id>.<ext>` — the
/// only playable source for those records.
pub(crate) fn links_media_dir(app: &AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    crate::commands::resolve_audio_base(app, custom)
        .map(|b| b.join("links"))
        .ok_or_else(|| "could not resolve the audio folder".into())
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

/// Rewrite `mediaPath` in every record whose stored path appears in `lookup`
/// (old absolute path → new absolute path), after a migration or base move.
/// Best-effort per record; a record that fails to parse is left untouched.
pub(crate) fn rewrite_media_paths(
    app: &AppHandle,
    lookup: &std::collections::HashMap<&str, &str>,
) {
    let dirs = [transcripts_dir(app), dictations_dir(app)];
    let mut rewritten = 0;
    for dir in dirs.into_iter().flatten() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            // Dictation records keep their audio under `sourcePath`; file/url
            // records under `mediaPath` — a moved file must be re-pointed in
            // whichever field carries it.
            let mut changed = false;
            for key in ["mediaPath", "sourcePath"] {
                let Some(old) = v.get(key).and_then(|m| m.as_str()) else {
                    continue;
                };
                if let Some(new) = lookup.get(old) {
                    v[key] = serde_json::Value::String((*new).to_owned());
                    changed = true;
                }
            }
            if !changed {
                continue;
            }
            let Ok(out) = serde_json::to_string(&v) else {
                continue;
            };
            if crate::config::write_private(&path, &out).is_ok() {
                rewritten += 1;
            }
        }
    }
    if rewritten > 0 {
        tracing::info!("[transcripts] rewrote media paths in {rewritten} record(s) after move");
    }
}

/// Repair records whose stored audio path no longer exists but whose file
/// lives under one of the audio-base subfolders (same basename). Heals
/// records a past move rewrote incompletely — earlier builds only rewrote
/// `mediaPath`, stranding every dictation record's `sourcePath` when the
/// layout migration moved the files into `<base>/dictations`. Idempotent
/// and cheap: one stat per stored path, rewrites only on a hit.
pub(crate) fn heal_media_paths(app: &AppHandle, base: &std::path::Path) {
    let subs = ["dictations", "files", "links"];
    let dirs = [transcripts_dir(app), dictations_dir(app)];
    let mut healed = 0;
    for dir in dirs.into_iter().flatten() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            let mut changed = false;
            for key in ["mediaPath", "sourcePath"] {
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
                if let Some(found) = subs
                    .iter()
                    .map(|s| base.join(s).join(name))
                    .find(|c| c.exists())
                {
                    v[key] = serde_json::Value::String(found.to_string_lossy().into_owned());
                    changed = true;
                }
            }
            if !changed {
                continue;
            }
            let Ok(out) = serde_json::to_string(&v) else {
                continue;
            };
            if crate::config::write_private(&path, &out).is_ok() {
                healed += 1;
            }
        }
    }
    if healed > 0 {
        tracing::info!("[transcripts] healed stale media paths in {healed} record(s)");
    }
}

/// Copy cap — beyond this the copy is silently skipped (the record keeps
/// playing from the original while it exists).
pub(crate) const MAX_MEDIA_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Record ids are frontend-generated UUIDs — hex + dashes only, so an id can
/// never traverse out of the transcripts directory.
pub(crate) fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
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
    let tmp = dir.join(format!("{id}.json.tmp"));
    if let Err(e) = crate::config::write_private(&tmp, &record) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// All history records, parsed but uninterpreted. Unreadable or unparseable
/// files are skipped — one corrupt record must never hide the rest. Ordering
/// is the frontend's job (records carry their own createdAt).
#[tauri::command]
pub fn list_transcript_records(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::new();
    read_records_into(&transcripts_dir(&app)?, &mut out);
    read_records_into(&dictations_dir(&app)?, &mut out);
    Ok(out)
}

fn read_records_into(dir: &Path, out: &mut Vec<serde_json::Value>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // no folder yet = nothing to add
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_RECORD_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            out.push(v);
        }
    }
}

/// Delete one record's file. The user-facing "Delete" — actually removes data.
/// Tries both stores: ids are UUIDs, so the same id can only exist in one.
/// The record's audio copy (if any) goes with it.
#[tauri::command]
pub fn delete_transcript_record(
    app: AppHandle,
    id: String,
    audio_base: Option<String>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("malformed record id".into());
    }
    for dir in [
        files_media_dir(&app, audio_base.clone()),
        links_media_dir(&app, audio_base),
    ]
    .into_iter()
    .flatten()
    {
        remove_media_for(&dir, &id);
    }
    let name = format!("{id}.json");
    let file_path = transcripts_dir(&app)?.join(&name);
    if file_path.exists() {
        return std::fs::remove_file(file_path).map_err(|e| e.to_string());
    }
    std::fs::remove_file(dictations_dir(&app)?.join(&name)).map_err(|e| e.to_string())
}

/// Copy a run's input audio next to its record (`media/<id>.<ext>`), so the
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
            .filter(|e| !e.is_empty() && e.len() <= 5 && e.bytes().all(|b| b.is_ascii_alphanumeric()))
            .unwrap_or_else(|| "bin".into());
        let dest = dir.join(format!("{id}.{ext}"));
        let tmp = dir.join(format!("{id}.{ext}.tmp"));
        if let Err(e) = std::fs::copy(&src, &tmp) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        // Owner-only like the records themselves (copy inherits source perms).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
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
#[tauri::command]
pub fn transcript_store_stats(
    app: AppHandle,
    audio_base: Option<String>,
) -> Result<serde_json::Value, String> {
    fn count_json(dir: &Path) -> u32 {
        std::fs::read_dir(dir)
            .map(|e| {
                e.flatten()
                    .filter(|x| x.path().extension().and_then(|s| s.to_str()) == Some("json"))
                    .count() as u32
            })
            .unwrap_or(0)
    }
    fn dir_bytes(dir: &Path) -> (u64, u32) {
        let (mut bytes, mut files) = (0u64, 0u32);
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(m) = entry.metadata() {
                    if m.is_file() {
                        bytes += m.len();
                        files += 1;
                    }
                }
            }
        }
        (bytes, files)
    }
    let (file_bytes, file_files) = dir_bytes(&files_media_dir(&app, audio_base.clone())?);
    let (link_bytes, link_files) = dir_bytes(&links_media_dir(&app, audio_base.clone())?);
    let (rec_bytes, rec_files) = crate::commands::resolve_recordings_dir(&app, audio_base)
        .map(|d| dir_bytes(&d))
        .unwrap_or((0, 0));
    Ok(serde_json::json!({
        "dictationCount": count_json(&dictations_dir(&app)?),
        "fileCount": count_json(&transcripts_dir(&app)?),
        "fileMediaBytes": file_bytes,
        "fileMediaFiles": file_files,
        "linkMediaBytes": link_bytes,
        "linkMediaFiles": link_files,
        "recordingsBytes": rec_bytes,
        "recordingsFiles": rec_files,
    }))
}

/// "Delete all dictations now": every stored session record AND every file in
/// the recordings folder (.wav + .txt sidecars — the folder is app-managed).
/// The retention clocks stay as set.
#[tauri::command]
pub fn delete_all_dictations(app: AppHandle, audio_base: Option<String>) -> Result<u32, String> {
    let mut removed = wipe_records(&dictations_dir(&app)?) as u32;
    if let Some(dir) = crate::commands::resolve_recordings_dir(&app, audio_base) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let ext = path.extension().and_then(|e| e.to_str());
                if matches!(ext, Some("wav") | Some("txt"))
                    && std::fs::remove_file(&path).is_ok()
                {
                    removed += 1;
                }
            }
        }
    }
    tracing::info!("[transcripts] delete-all dictations: removed {removed} file(s)");
    Ok(removed)
}

/// "Delete all transcriptions": every file/link record with its corrections;
/// the orphan sweep then drops their audio.
#[tauri::command]
pub fn clear_file_transcriptions(app: AppHandle, audio_base: Option<String>) -> Result<u32, String> {
    let removed = wipe_records(&transcripts_dir(&app)?) as u32;
    sweep_orphan_media(&app, audio_base);
    Ok(removed)
}

/// "Delete audio from file/link transcriptions": empties one media subfolder
/// (`kind` "file" → files/, "url" → links/; None → both). Transcripts stay.
#[tauri::command]
pub fn remove_transcript_media(
    app: AppHandle,
    kind: Option<String>,
    audio_base: Option<String>,
) -> Result<u32, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    match kind.as_deref() {
        Some("file") => dirs.push(files_media_dir(&app, audio_base)?),
        Some("url") => dirs.push(links_media_dir(&app, audio_base)?),
        _ => {
            dirs.push(files_media_dir(&app, audio_base.clone())?);
            dirs.push(links_media_dir(&app, audio_base)?);
        }
    }
    let mut removed = 0u32;
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if std::fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    tracing::info!("[transcripts] media store cleared: removed {removed} file(s)");
    Ok(removed)
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
/// and half-finished copies (`.tmp` stems never match a record id). One clock:
/// a copy lives exactly as long as its transcript.
fn sweep_orphan_media(app: &AppHandle, audio_base: Option<String>) {
    let Ok(records) = transcripts_dir(app) else {
        return;
    };
    let mut removed = 0;
    for dir in [
        files_media_dir(app, audio_base.clone()),
        links_media_dir(app, audio_base),
    ]
    .into_iter()
    .flatten()
    {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !records.join(format!("{stem}.json")).exists()
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

/// Delete records older than `days` (0 = keep forever). Same shape and
/// rationale as `audio::prune_recordings`, including the overflow clamp.
pub fn prune_transcripts(dir: &Path, days: u32) -> usize {
    if days == 0 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    const MAX_RETENTION_DAYS: u32 = 3650;
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(days.min(MAX_RETENTION_DAYS) as u64 * 86_400);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
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
        tracing::info!("[transcripts] retention: removed {removed} record(s) older than {days}d");
    }
    removed
}

/// Enforce both history retention windows. Called on startup and after every
/// config save, mirroring `apply_recordings_retention`.
/// - File transcriptions: `historyRetentionDays` (0/absent = keep forever).
/// - Dictations: their own, stricter `dictationRetentionDays` (default 7) —
///   and when `keepDictationHistory` is off, the whole dictation store is
///   wiped (the setting's copy promises exactly that).
pub fn apply_transcripts_retention(app: &AppHandle, config: &crate::config::Config) {
    let days = config.settings.transcribe_retention_days();
    if days > 0 {
        if let Ok(dir) = transcripts_dir(app) {
            prune_transcripts(&dir, days);
        }
    }
    if let Ok(dir) = dictations_dir(app) {
        if !config.settings.keep_dictation_history() {
            wipe_records(&dir);
        } else {
            let ddays = config.settings.dictation_retention_days();
            if ddays > 0 {
                prune_transcripts(&dir, ddays);
            }
        }
    }
    sweep_orphan_media(app, crate::commands::audio_base_pref(&config.settings));
}

/// Remove every record in `dir` regardless of age ("Keep dictation history"
/// turned off). Only touches `.json` files, like the prune.
fn wipe_records(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json")
            && std::fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!("[transcripts] record wipe: removed {removed} record(s)");
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn prune_only_touches_old_json() {
        let dir = std::env::temp_dir().join("fwf-transcripts-prune");
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
}
