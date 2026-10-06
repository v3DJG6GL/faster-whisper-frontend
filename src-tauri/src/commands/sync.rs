//! Settings sync with the server, its local bookkeeping, and the settings file
//! export/import.

use super::{config_dir, resolve_key_async};
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
#[tauri::command]
pub fn load_sync_state(app: AppHandle) -> Option<serde_json::Value> {
    config_dir(&app)
        .ok()
        .and_then(|d| crate::store::sync_state::load(&d))
}

#[tauri::command]
pub fn save_sync_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let dir = config_dir(&app)?;
    crate::store::sync_state::save(&dir, &state).map_err(|e| e.to_string())
}

/// This machine's sync identity (persistent uuid + hostname + platform).
#[tauri::command]
pub fn sync_device_info(app: AppHandle) -> Result<crate::store::sync_state::DeviceInfo, String> {
    let dir = config_dir(&app)?;
    Ok(crate::store::sync_state::device_info(&dir))
}

/// Bulk keyring read for export/sync composition: the API keys of the given
/// Backends, omitting ids with no stored key. The result stays in memory on
/// its way into an export the user asked for (or the sync blob) — never log it.
///
/// async + spawn_blocking: a sync command runs on the MAIN thread, and a
/// keyring read can BLOCK indefinitely (locked KWallet parks the request
/// behind a password prompt) — that froze the whole event loop, wedging every
/// later invoke. On a worker it can hang harmlessly; the TS caller wraps this
/// in a 10s timeout and degrades to "no secrets".
#[tauri::command]
pub async fn read_backend_keys(
    backend_ids: Vec<String>,
) -> std::collections::HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        backend_ids
            .into_iter()
            .filter_map(|id| config::keys::get(&id).map(|k| (id, k)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Write a settings-export envelope (built by the TS side) to the path the
/// user picked in the save dialog. Atomic tmp+rename like `config::save`.
/// async + spawn_blocking: a sync command runs on the main thread and this fsyncs into a
/// user-picked sink (USB stick, network share).
#[tauri::command]
pub async fn export_settings_file(path: String, envelope: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = PathBuf::from(path);
        let tmp = crate::transport::media::tmp_sibling(&path);
        let text = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
        // Owner-only, and never leave the tmp behind: with "include API keys" ticked this envelope
        // holds the raw keyring secrets, and it lands wherever the user pointed the save dialog.
        // A4 cleaned up the tmp on a rename failure but not on a write failure — and `write_private`
        // fails AFTER creating and truncating the file (write_all / sync_all hitting ENOSPC, EIO or
        // EDQUOT), which is the realistic case for this sink: the user points the save dialog at a
        // nearly-full USB stick or a network share. What survives is a PARTIAL plaintext-credential
        // file in a directory the user chose, and they see only an error toast. The 0600 does not
        // cover it there either — FAT/exFAT removable media and most SMB mounts carry no Unix mode.
        if let Err(e) = config::write_private(&tmp, &text) {
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
    tauri::async_runtime::spawn_blocking(move || import_settings_file_inner(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn import_settings_file_inner(path: &str) -> Result<ImportResult, String> {
    const MAX_IMPORT_BYTES: u64 = 20_000_000; // sanity cap, not a format limit
                                              // Entry-count ceiling, matching the sync path's own (`MAX_SYNCED_ENTRIES` in lib/sync/sync.ts).
                                              // The byte cap alone admits ~130k well-formed backends, and every one with a key becomes a
                                              // SERIAL 10s-timeout keyring write in `reconcileBackendSecrets` — permanent credential
                                              // entries in the user's wallet, with the webview blocked throughout. This is the designated
                                              // validator for the untrusted-file path; it should fail here, with a message.
    const MAX_ENTRIES: usize = 500;
    // Ceiling on the codes in ONE chord, matching `MAX_CHORD_CODES` in lib/sync/sync.ts. The count cap
    // above bounds how MANY chords arrive, never how long one is: `de_hotkey`'s `visit_seq` pushes
    // an unbounded sequence and `canonicalize` only sorts + dedups, which does not bound DISTINCT
    // strings. `chordConflicts` runs in the import preview's render body — before the user has
    // consented to anything — and `isStrictSubset` is O(k·m) in chord LENGTH, so one 20 MB file
    // holding two profiles whose chords nest freezes the window. Rejected, not truncated, and
    // rejected HERE rather than in `de_hotkey`: that runs on the user's own config.json every
    // launch, where truncating would silently rewrite a valid stored chord with the autosave
    // armed, and rejecting would refuse to load a working config.
    const MAX_CHORD_CODES: usize = 16;
    // ...and the other dimension of the same field, which the cap above does not bound: how long
    // ONE code is. 16 codes of ~1.2 MB each pass both the count check and `isCodeList`, under the
    // 20 MB ceiling. Same three sinks as the count: `chordConflicts` in the preview's render body
    // before consent (where `canonicalizeCodes`' `localeCompare` tie-break and `isStrictSubset`
    // now compare megabyte strings), a permanently ~20 MB `config.json` re-serialized on every
    // 400ms-debounced autosave and re-parsed at every launch, and `codeToLabel`'s fall-through
    // rendering the raw string as a key cap. Every real code is a `KeyboardEvent.code`-style
    // token — the longest in the tree is well under 32 — so this rejects only forgeries.
    const MAX_CHORD_CODE_LEN: usize = 64;
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read the file: {e}"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("That file is too large to be a settings export.".into());
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("Could not read the file: {e}"))?;
    let mut doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "That file isn't valid JSON.".to_string())?;

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
    // Keep in sync with the frontend's `CONFIG_VERSION` (src/lib/store.ts) — the
    // envelope now carries that value, and warning on `> 2` would flag our own
    // exports as foreign.
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

    // Split out + validate secrets ({backendId: apiKey} strings only).
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

    // Normalize the typed categories through serde (drops unknown fields,
    // canonicalizes hotkey chords via the Profile deserializer, and fails
    // loudly on structurally-broken lists).
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
        for b in &parsed {
            if b.has_api_key && !secrets.contains_key(&b.id) {
                // Bounded and defanged. `b.name` is wholly file-controlled and length-unbounded,
                // and it sits at the FRONT of the only sentence telling the user a key is
                // missing — while the sole render of this string is `safeDisplayText(w, 300)`,
                // which truncates with no marker. At 300+ code points the whole explanatory
                // clause is cut away, leaving a warn-styled box in the import-consent dialog that
                // renders only the file author's own sentence. 60 leaves the clause intact and
                // `bounded_server_text` marks the cut with an ellipsis, so a padded or
                // control-char name cannot pass itself off as the app's copy.
                warnings.push(format!(
                    "\u{201c}{}\u{201d} uses an API key, but the file doesn't include it — re-enter the key after importing.",
                    crate::transport::bounded_server_text(&b.name, 60)
                ));
            }
        }
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
    // category missing here passed validation and then vanished silently at apply time.
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
