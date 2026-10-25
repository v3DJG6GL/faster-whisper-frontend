//! Settings sync with the server, its local bookkeeping, and the settings file
//! export/import.

use super::{blocking, config_dir, resolve_key_async, store_io};
use crate::config;
use crate::transport;
use std::path::PathBuf;
use tauri::AppHandle;

/// Pull the account's synced settings blob (`GET /v1/synced-client-settings`).
/// Structured result so the engine can distinguish old-backend (404) /
/// unauthorized (401) / unreachable (0) / empty store (200, version 0).
#[tauri::command]
pub async fn sync_pull(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::sync::SyncPull {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::sync::pull(&server_url, key.as_deref()).await
}

/// Push the composed settings blob (`PUT /v1/synced-client-settings`). A 409 comes
/// back in `conflict` carrying the current server state for the merge loop.
#[tauri::command]
pub async fn sync_push(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    blob: serde_json::Value,
    base_version: i64,
    device: String,
) -> transport::sync::SyncPush {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::sync::push(&server_url, key.as_deref(), blob, base_version, &device).await
}

/// Drop the account's server-side settings blob (`DELETE /v1/synced-client-settings`).
#[tauri::command]
pub async fn sync_delete(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::sync::SyncDelete {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::sync::delete(&server_url, key.as_deref()).await
}

/// Local sync bookkeeping (device id, last server version, merge-base
/// snapshot) — opaque to Rust, lives in `<config dir>/sync-state.json`.
/// `Err` when the file exists but can't be read — the webview then must not save over it.
/// Off the main thread, one call at a time: see `store_io`.
#[tauri::command]
pub async fn load_sync_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let Ok(dir) = config_dir(&app) else {
        return Ok(None);
    };
    store_io(&SYNC_STATE_TURN, move || {
        crate::store::sync_state::load(&dir).map_err(|e| format!("sync state unreadable: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn save_sync_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let dir = config_dir(&app)?;
    store_io(&SYNC_STATE_TURN, move || {
        crate::store::sync_state::save(&dir, &state).map_err(|e| e.to_string())
    })
    .await
}

static SYNC_STATE_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// This machine's sync identity (persistent uuid + hostname + platform). Same turn as the
/// state commands: a first call writes the new id into sync-state.json.
#[tauri::command]
pub async fn sync_device_info(
    app: AppHandle,
) -> Result<crate::store::sync_state::DeviceInfo, String> {
    let dir = config_dir(&app)?;
    store_io(&SYNC_STATE_TURN, move || {
        Ok(crate::store::sync_state::device_info(&dir))
    })
    .await
}

/// Bulk keyring read for export/sync composition: the API keys of the given
/// Backends in `keys`, and in `unreadable` the ids whose read FAILED (locked wallet,
/// dismissed prompt, platform error) — an id in neither has no stored key. The two must
/// stay apart: a sync pull keeps a backend's "has a key" flag across a failed read but
/// clears it when the store says nothing is there. The result stays in memory on its way
/// into an export the user asked for (or the sync blob) — never log it.
///
/// async + spawn_blocking: a sync command runs on the MAIN thread, and a keyring read can block
/// indefinitely (a locked KWallet parks it behind a password prompt), wedging every later
/// invoke. On a worker it hangs harmlessly; the TS caller wraps this in a 10s timeout and
/// degrades to "no secrets".
#[tauri::command]
pub async fn read_backend_keys(backend_ids: Vec<String>) -> BackendKeys {
    let ids = backend_ids.clone();
    tauri::async_runtime::spawn_blocking(move || collect_keys(backend_ids, config::keys::read))
        .await
        // A panicked worker read nothing: every id unreadable, never absent.
        .unwrap_or_else(|_| BackendKeys {
            keys: Default::default(),
            unreadable: ids,
        })
}

#[derive(serde::Serialize, Default, Debug, PartialEq)]
pub struct BackendKeys {
    keys: std::collections::HashMap<String, String>,
    unreadable: Vec<String>,
}

fn collect_keys(
    backend_ids: Vec<String>,
    mut read: impl FnMut(&str) -> config::keys::KeyRead,
) -> BackendKeys {
    use config::keys::KeyRead;
    let mut out = BackendKeys::default();
    for id in backend_ids {
        match read(&id) {
            KeyRead::Found(k) => {
                out.keys.insert(id, k);
            }
            KeyRead::Absent => {}
            KeyRead::Unreadable => out.unreadable.push(id),
        }
    }
    out
}

/// Write a settings-export envelope (built by the TS side) to the path the
/// user picked in the save dialog. Atomic tmp+rename like `config::save`.
/// async + spawn_blocking: a sync command runs on the main thread and this fsyncs into a
/// user-picked sink (USB stick, network share).
#[tauri::command]
pub async fn export_settings_file(path: String, envelope: serde_json::Value) -> Result<(), String> {
    blocking(move || -> Result<(), String> {
        let path = PathBuf::from(path);
        let text = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
        // Owner-only, and never leave the tmp behind: with "include API keys" ticked this envelope
        // holds the raw keyring secrets. A write failing on a nearly-full USB stick or share would
        // otherwise leave a partial plaintext-credential file where the user pointed the dialog, and
        // the 0600 does not protect it there (FAT/exFAT and most SMB mounts carry no Unix mode).
        // `write_private_atomic` removes `<path>.tmp` on both the write and the rename failure.
        config::write_private_atomic(&path, &text).map_err(|e| e.to_string())
    })
    .await
}

/// A parsed + validated settings export, ready for the import-preview UI.
/// `categories` is the normalized SyncBlob (secrets stripped out into
/// `secrets`), `warnings` are human-readable notes for the preview.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub format_version: u32,
    pub config_version: u32,
    pub app_version: String,
    pub hostname: String,
    pub platform: String,
    pub created_at: String,
    pub categories: serde_json::Value,
    pub secrets: serde_json::Value,
    pub has_secrets: bool,
    pub warnings: Vec<String>,
}

/// Read + validate a settings-export file. Refuses a NEWER formatVersion
/// outright (forward compat is the exporter's job, not the importer's);
/// normalizes `backends.list` / `profiles.list` through the typed serde
/// structs so garbage fails here — with a clear message — instead of
/// hydrating a broken store later.
#[tauri::command]
pub async fn import_settings_file(path: String) -> Result<ImportResult, String> {
    blocking(move || import_settings_file_inner(&path)).await
}

fn import_settings_file_inner(path: &str) -> Result<ImportResult, String> {
    // Sanity cap, not a format limit.
    const MAX_IMPORT_BYTES: u64 = 20_000_000;
    // Entry-count ceiling, matching the sync path's own (`MAX_SYNCED_ENTRIES` in lib/sync/sync.ts).
    // The byte cap alone admits ~130k backends, and each one with a key becomes a serial
    // 10s-timeout keyring write in `reconcileBackendSecrets` — permanent wallet entries with the
    // webview blocked throughout. This is the untrusted-file validator: fail here, with a message.
    const MAX_ENTRIES: usize = 500;
    // Ceiling on the codes in ONE chord, matching `MAX_CHORD_CODES` in lib/sync/sync.ts. The count
    // cap above does not bound chord length (`de_hotkey` / `canonicalize` only sort + dedup), and
    // the import preview runs `conflicts()` (hotkeyConflicts.ts) in its render body before consent,
    // where `isStrictSubset` is O(k·m) in chord length — two long nested chords freeze the window.
    // Rejected HERE, not in `de_hotkey`: that also loads the user's own config.json every launch,
    // where truncating would silently rewrite a valid chord and rejecting would refuse a working
    // config.
    const MAX_CHORD_CODES: usize = 16;
    // ...and the length of ONE code, which the count cap does not bound: 16 codes of ~1.2 MB pass it
    // and `isCodeList` under the 20 MB ceiling, and reach the same preview scan, a ~20 MB
    // `config.json` re-serialized on every autosave, and `codeToLabel` rendering the raw string as a
    // key cap. Every real code is a `KeyboardEvent.code`-style token well under 32 bytes, so this
    // rejects only forgeries.
    const MAX_CHORD_CODE_LEN: usize = 64;
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read the file: {e}"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("That file is too large to be a settings export.".into());
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("Could not read the file: {e}"))?;
    // An export re-saved by an editor as "UTF-8 with BOM" is still valid JSON to the user.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut doc: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "That file isn't valid JSON.".to_string())?;

    let format_version = doc
        .get("formatVersion")
        .and_then(|v| v.as_u64())
        .ok_or("That file doesn't look like a settings export (no formatVersion).")?;
    if format_version > 1 {
        return Err(
            "This file was created by a newer version of the app — update the app to import it."
                .into(),
        );
    }
    // Keep in sync with the frontend's `CONFIG_VERSION` (src/lib/store.ts): the envelope carries
    // that value, so a lower constant here would flag our own exports as a newer schema.
    const CURRENT_CONFIG_VERSION: u32 = 3;
    let config_version = doc
        .get("configVersion")
        .and_then(|v| v.as_u64())
        .map(|v| u32::try_from(v).unwrap_or(u32::MAX))
        .unwrap_or(2);

    let mut warnings: Vec<String> = Vec::new();
    if config_version > CURRENT_CONFIG_VERSION {
        warnings.push(
            "The file uses a newer settings schema — unknown settings will be skipped.".into(),
        );
    }

    let mut categories = doc
        .get_mut("categories")
        .map(serde_json::Value::take)
        .ok_or("That file doesn't look like a settings export (no categories).")?;
    if !categories.is_object() {
        return Err("That file doesn't look like a settings export (bad categories).".into());
    }

    // Split out the secrets ({backendId: apiKey}); a non-string or empty value is dropped, not refused.
    let mut secrets = serde_json::Map::new();
    if let Some(b) = categories
        .get_mut("backends")
        .and_then(|b| b.as_object_mut())
    {
        if let Some(raw) = b.remove("secrets") {
            if let Some(map) = raw.as_object() {
                for (id, key) in map {
                    if let Some(k) = key.as_str() {
                        if !k.is_empty() {
                            secrets.insert(id.clone(), serde_json::json!(k));
                        }
                    }
                }
            }
        }
    }

    // The serde round-trip also drops unknown fields and canonicalizes hotkey chords (Profile
    // deserializer).
    if let Some(list) = categories
        .get_mut("backends")
        .and_then(|b| b.get_mut("list"))
    {
        let parsed: Vec<config::Backend> = serde_json::from_value(list.take())
            .map_err(|e| format!("The file's server connections are invalid: {e}"))?;
        if parsed.len() > MAX_ENTRIES {
            return Err(
                "That file lists far more server connections than the app supports.".into(),
            );
        }
        // No per-backend "missing API key" warning here: the import preview's
        // selection-aware notice is the single source, so it neither repeats per
        // backend nor lingers once Backends is deselected.
        *list = serde_json::to_value(parsed).map_err(|e| e.to_string())?;
    }
    if let Some(list) = categories
        .get_mut("profiles")
        .and_then(|p| p.get_mut("list"))
    {
        let parsed: Vec<config::Profile> = serde_json::from_value(list.take())
            .map_err(|e| format!("The file's dictation profiles are invalid: {e}"))?;
        if parsed.len() > MAX_ENTRIES {
            return Err(
                "That file lists far more dictation profiles than the app supports.".into(),
            );
        }
        if parsed.iter().any(|p| p.hotkey.len() > MAX_CHORD_CODES) {
            return Err(
                "That file has a shortcut with far more keys than the app supports.".into(),
            );
        }
        if parsed
            .iter()
            .any(|p| p.hotkey.iter().any(|c| c.len() > MAX_CHORD_CODE_LEN))
        {
            return Err(
                "That file has a shortcut key name far longer than the app supports.".into(),
            );
        }
        *list = serde_json::to_value(parsed).map_err(|e| e.to_string())?;
    }
    for bucket in ["linux", "windows"] {
        if let Some(rules) = categories.get("appRules").and_then(|r| r.get(bucket)) {
            if !rules.is_null() && !rules.is_array() {
                return Err("The file's app rules are invalid.".into());
            }
            if rules.as_array().is_some_and(|a| a.len() > MAX_ENTRIES) {
                return Err("That file lists far more app rules than the app supports.".into());
            }
        }
    }
    // Every scalar wire category — keep in step with `SCALAR_CATS` in src/lib/sync/syncGates.ts. A
    // category missing here skips this shape check, and a malformed one then vanishes silently at
    // apply time.
    for key in [
        "general",
        "recording",
        "chip",
        "transcription",
        "fileTranscriptions",
        "dictionary",
        "logging",
    ] {
        if let Some(v) = categories.get(key) {
            if !v.is_null() && !v.is_object() {
                return Err(format!("The file's {key} settings are invalid."));
            }
        }
    }
    // The categories are checked as OBJECTS only above, so the chord-shaped leaf never met the
    // element and length checks the profile list gets. It reaches the same preview scan. The
    // chord lives under `dictionary` since the category split; `general` is where files written
    // before it carried it — validate whichever this file has.
    for cat in ["dictionary", "general"] {
        if let Some(qa) = categories.get(cat).and_then(|g| g.get("quickAddHotkey")) {
            let ok = qa.is_null()
                || qa.as_array().is_some_and(|a| {
                    a.len() <= MAX_CHORD_CODES
                        && a.iter()
                            .all(|c| c.as_str().is_some_and(|s| s.len() <= MAX_CHORD_CODE_LEN))
                });
            if !ok {
                return Err("The file's quick-add shortcut is invalid.".into());
            }
        }
    }

    let has_secrets = !secrets.is_empty();
    let s = |k: &str| {
        doc.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(ImportResult {
        format_version: format_version as u32,
        config_version,
        app_version: s("appVersion"),
        hostname: s("hostname"),
        platform: s("platform"),
        created_at: s("createdAt"),
        categories,
        secrets: serde_json::Value::Object(secrets),
        has_secrets,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_failed_key_read_is_reported_apart_from_a_missing_key() {
        use crate::config::keys::KeyRead;
        let ids = ["found", "absent", "locked"].map(String::from).to_vec();
        let got = super::collect_keys(ids, |id| match id {
            "found" => KeyRead::Found("sk-1".into()),
            "absent" => KeyRead::Absent,
            _ => KeyRead::Unreadable,
        });
        assert_eq!(got.keys, [("found".to_string(), "sk-1".to_string())].into());
        assert_eq!(got.unreadable, vec!["locked".to_string()]);
    }

    #[test]
    fn an_export_saved_with_a_byte_order_mark_is_read_as_json() {
        let dir = crate::config::fresh_test_dir("import-bom");
        let path = dir.join("settings.json");
        std::fs::write(&path, "\u{feff}{}").unwrap();
        let err = super::import_settings_file_inner(path.to_str().unwrap())
            .err()
            .unwrap();
        // Past the JSON parse: it fails on the missing formatVersion, not as invalid JSON.
        assert!(err.contains("formatVersion"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
