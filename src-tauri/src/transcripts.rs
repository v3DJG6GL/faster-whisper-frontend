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

/// Record ids are frontend-generated UUIDs — hex + dashes only, so an id can
/// never traverse out of the transcripts directory.
fn valid_id(id: &str) -> bool {
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
#[tauri::command]
pub fn delete_transcript_record(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("malformed record id".into());
    }
    let name = format!("{id}.json");
    let file_path = transcripts_dir(&app)?.join(&name);
    if file_path.exists() {
        return std::fs::remove_file(file_path).map_err(|e| e.to_string());
    }
    std::fs::remove_file(dictations_dir(&app)?.join(&name)).map_err(|e| e.to_string())
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
}

/// Remove every record in `dir` regardless of age ("Keep dictation history"
/// turned off). Only touches `.json` files, like the prune.
fn wipe_records(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
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
        tracing::info!("[transcripts] dictation history off: removed {removed} record(s)");
    }
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
