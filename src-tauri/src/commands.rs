//! Tauri commands exposed to the web UI (config load/save + secret-store keys).

use crate::audio::{self, AudioDevice, AudioState, MicPlayback, MicTestClip};
use crate::config::{self, Config};
use crate::session::{self, RecordParams, RecordState, StartParams, StreamState};
use crate::transport;
use crate::wayland_inject::WaylandTyper;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Folder where saved dictation `.wav` files go (when "Keep recordings" is on). A
/// non-empty `custom` (the user's chosen folder, from Settings) wins; otherwise the
/// default lives under the app data dir. None only if neither can be resolved.
pub(crate) fn resolve_recordings_dir(app: &AppHandle, custom: Option<String>) -> Option<PathBuf> {
    if let Some(c) = custom {
        let c = c.trim();
        if !c.is_empty() {
            return Some(PathBuf::from(c));
        }
    }
    app.path().app_data_dir().ok().map(|d| d.join("recordings"))
}

/// Absolute path of the active recordings folder (custom or default), for display in
/// Settings — a leading `$HOME` is collapsed to `~`. None if it can't be resolved.
#[tauri::command]
pub fn recordings_dir_path(app: AppHandle, custom: Option<String>) -> Option<String> {
    let dir = resolve_recordings_dir(&app, custom)?;
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Some(format!("~/{}", rest.display()));
        }
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Open the active recordings folder (custom or default) in the system file manager.
/// Creates it first so the button works before the first recording — or right after the
/// user picks a new, not-yet-used folder.
#[tauri::command]
pub fn open_recordings_dir(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir =
        resolve_recordings_dir(&app, custom).ok_or("could not resolve a recordings folder")?;
    crate::audio::create_dir_private(&dir).map_err(|e| format!("could not create the folder: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Resolve an API key: an explicit (just-typed) key wins; otherwise look it up in
/// the OS keyring by Backend id.
fn resolve_key(explicit: Option<String>, backend_id: Option<String>) -> Option<String> {
    if let Some(k) = explicit {
        if !k.is_empty() {
            return Some(k);
        }
    }
    let key = backend_id.as_deref().and_then(config::keys::get);
    if key.is_none() {
        // A keyless backend is legal, but when the server DOES require a key the
        // failure mode is an opaque 403 on connect — make "we are about to go out
        // without an Authorization header" visible in the log.
        tracing::warn!(
            "[keys] no API key resolved (backend_id={backend_id:?}) — connecting unauthenticated"
        );
    }
    key
}

/// Frontend-facing config load: the config plus whether Rust had to RECOVER it (backed up a
/// present-but-unreadable/corrupt file to .json.bak and returned defaults), so the frontend can warn
/// the user their settings were reset instead of the armed auto-save silently persisting the wipe.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConfig {
    pub config: Config,
    pub recovered: bool,
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> LoadedConfig {
    match config_dir(&app) {
        Ok(dir) => {
            let (config, recovered) = config::load_outcome(&dir);
            LoadedConfig { config, recovered }
        }
        // No config dir at all (can't happen in practice) — clean defaults, nothing was backed up.
        Err(_) => LoadedConfig {
            config: Config::default(),
            recovered: false,
        },
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let dir = config_dir(&app)?;
    config::save(&dir, &config).map_err(|e| e.to_string())?;
    sync_autostart(&app, config.settings.general.open_at_login);
    apply_recordings_retention(&app, &config);
    crate::transcripts::apply_transcripts_retention(&app, &config);
    Ok(())
}

/// Enforce the saved-recording retention window. Called on startup and after every config save,
/// so shortening the window takes effect immediately rather than at the next restart.
///
/// Turning "keep audio recordings" off stops the sweep too. The Settings screen DISABLES the
/// retention control whenever saving is off, so leaving the window live meant an existing archive
/// kept being deleted on every launch and every autosave, driven by a control the user could no
/// longer see the value of or change. The two now agree: no saving, no deleting.
pub fn apply_recordings_retention(app: &AppHandle, config: &Config) {
    let days = config.settings.recording.recordings_retention_days;
    if days == 0 || !config.settings.recording.save_recordings {
        return;
    }
    if let Some(dir) = resolve_recordings_dir(app, config.settings.recording.recordings_dir.clone())
    {
        crate::audio::prune_recordings(&dir, days);
    }
}

/// Keep the OS "launch at login" entry in sync with the saved preference. Called
/// on startup and whenever the config is saved.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}

#[tauri::command]
pub fn set_backend_key(backend_id: String, key: String) -> Result<(), String> {
    config::keys::set(&backend_id, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_backend_key(backend_id: String) -> Result<(), String> {
    config::keys::delete(&backend_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn test_connection(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::ConnectionInfo {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::test_connection(&server_url, key.as_deref()).await
}

#[tauri::command]
pub async fn transcribe_file(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    // None (field omitted) = inherit the server DEFAULT_PROMPT; Some("") = explicit
    // clear (send no prompt); Some(v) = use v. See transport::batch::post.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    file_path: String,
    // Per-run stage options (translate / diarization). None ≡ all absent.
    options: Option<transport::batch::BatchOptions>,
) -> Result<transport::batch::BatchResult, String> {
    let key = resolve_key(api_key, backend_id);
    // Cancellation: cancel_file_transcription bumps the epoch; this select
    // polls it and DROPS the reqwest future on a change, which closes the
    // connection (the server cancels its handler task on the disconnect —
    // the in-flight decode thread finishes server-side, but the request,
    // its semaphore slot and its progress entry all end).
    let epoch = FILE_TRANSCRIBE_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    let fut = transport::batch::transcribe(
        &server_url,
        key.as_deref(),
        &model,
        &language,
        prompt.as_deref(),
        decode_overrides.as_ref(),
        override_profile.as_deref(),
        &file_path,
        options,
    );
    tokio::pin!(fut);
    loop {
        tokio::select! {
            r = &mut fut => return r.map_err(|e| e.to_string()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                if FILE_TRANSCRIBE_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != epoch {
                    return Err("cancelled".into());
                }
            }
        }
    }
}

/// Epoch for aborting in-flight `transcribe_file` calls (see above). Same
/// shape as session.rs's CANCELLED_BATCH_EPOCH for dictation clips.
static FILE_TRANSCRIBE_EPOCH: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Abort every in-flight file transcription (the Transcribe screen's Cancel).
#[tauri::command]
pub fn cancel_file_transcription() {
    FILE_TRANSCRIBE_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Ask the SERVER to abort the in-flight transcription behind `progress_id`.
/// Companion to `cancel_file_transcription` (which only drops our end of the
/// connection — the server's pipeline stages would otherwise run to
/// completion). Best-effort by design.
#[tauri::command]
pub async fn cancel_backend_transcription(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    progress_id: String,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::cancel(&server_url, key.as_deref(), &progress_id)
        .await
        .map_err(|e| e.to_string())
}

/// Poll the live progress of an in-flight file transcription.
#[tauri::command]
pub async fn get_transcribe_progress(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    progress_id: String,
) -> Result<transport::batch::BatchProgress, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::progress(&server_url, key.as_deref(), &progress_id)
        .await
        .map_err(|e| e.to_string())
}

/// List the server's selectable override-profile names (for the per-Backend /
/// per-Profile picker). Best-effort — returns [] on any error.
#[tauri::command]
pub async fn list_override_profiles(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> Vec<String> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::list_override_profiles(&server_url, key.as_deref()).await
}

/// The caller's effective request-override capabilities (`GET /v1/me`). Best-
/// effort — returns null on any error so the UI can treat it as "unknown".
#[tauri::command]
pub async fn get_capabilities(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> Option<transport::Capabilities> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::get_capabilities(&server_url, key.as_deref()).await
}

/// One override-profile's decode values + locked client keys, for previewing
/// inherited defaults when a profile is selected. Best-effort — null on error.
#[tauri::command]
pub async fn get_override_profile(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    name: String,
) -> Option<transport::ResolvedOverrideProfile> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::get_override_profile(&server_url, &name, key.as_deref()).await
}

/// P17: the post-processing (pipeline) rules the caller may view + edit
/// (`GET /v1/pipeline-rules`) — for the Dictionary screen. Structured result so
/// the UI can distinguish standard-server (404) / unauthorized (401) / no-access
/// (403) / parse errors from a real rule list.
#[tauri::command]
pub async fn get_pipeline_rules(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::pipeline::PipelineFetch {
    let key = resolve_key(api_key, backend_id);
    transport::pipeline::get_pipeline_rules(&server_url, key.as_deref()).await
}

/// P17: apply a per-rule patch (`PATCH /v1/pipeline-rules`). `patch` is the
/// `{rules_patch, fingerprints}` object the client builds from its edits.
/// Structured result carries saved / conflicts / requires_restart, plus 422
/// `errors` or a 400/403/500 `detail`.
#[tauri::command]
pub async fn save_pipeline_rules(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    patch: serde_json::Value,
) -> transport::pipeline::PipelineSave {
    let key = resolve_key(api_key, backend_id);
    transport::pipeline::save_pipeline_rules(&server_url, key.as_deref(), patch).await
}

/// P18: recently-transcribed word/phrase suggestions for the Dictionary's
/// spoken-symbol key field (`GET /v1/recent-words`). Best-effort — returns an
/// empty list on any failure (old/standard server, unreachable) so the editor
/// degrades to a plain input.
#[tauri::command]
pub async fn get_recent_words(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::pipeline::RecentWords {
    let key = resolve_key(api_key, backend_id);
    transport::pipeline::get_recent_words(&server_url, key.as_deref()).await
}

/// P28: the caller's own usage (`GET /v1/usage`) — today + lifetime totals +
/// a self-scoped trend series, for the Home stats section and the optional chip
/// readout. Best-effort — null on any error so the UI hides the feature on a
/// standard/old server or when unreachable. `tz_midnight` is the client's local
/// midnight (epoch seconds) for a viewer-local "today".
#[tauri::command]
pub async fn get_usage_stats(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    tz_midnight: Option<f64>,
    days: Option<i64>,
    bucket: Option<String>,
) -> Option<transport::UsageStats> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::get_usage_stats(
        &server_url,
        key.as_deref(),
        tz_midnight,
        days,
        bucket.as_deref(),
    )
    .await
}

// ── P30: settings export/import + server sync ──────────────────────────────

/// Pull the account's synced settings blob (`GET /v1/client-settings`).
/// Structured result so the engine can distinguish old-backend (404) /
/// unauthorized (401) / unreachable (0) / empty store (200, version 0).
#[tauri::command]
pub async fn sync_pull(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::sync::SyncPull {
    let key = resolve_key(api_key, backend_id);
    transport::sync::pull(&server_url, key.as_deref()).await
}

/// Push the composed settings blob (`PUT /v1/client-settings`). A 409 comes
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
    let key = resolve_key(api_key, backend_id);
    transport::sync::push(&server_url, key.as_deref(), blob, base_version, &device).await
}

/// Drop the account's server-side settings blob (`DELETE /v1/client-settings`).
#[tauri::command]
pub async fn sync_delete(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::sync::SyncDelete {
    let key = resolve_key(api_key, backend_id);
    transport::sync::delete(&server_url, key.as_deref()).await
}

/// Local sync bookkeeping (device id, last server version, merge-base
/// snapshot) — opaque to Rust, lives in `<config dir>/sync-state.json`.
#[tauri::command]
pub fn load_sync_state(app: AppHandle) -> Option<serde_json::Value> {
    config_dir(&app).ok().and_then(|d| config::sync_state::load(&d))
}

#[tauri::command]
pub fn save_sync_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let dir = config_dir(&app)?;
    config::sync_state::save(&dir, &state).map_err(|e| e.to_string())
}

/// This machine's sync identity (persistent uuid + hostname + platform).
#[tauri::command]
pub fn sync_device_info(app: AppHandle) -> Result<config::sync_state::DeviceInfo, String> {
    let dir = config_dir(&app)?;
    Ok(config::sync_state::device_info(&dir))
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
#[tauri::command]
pub fn export_settings_file(path: String, envelope: serde_json::Value) -> Result<(), String> {
    let path = PathBuf::from(path);
    let tmp = path.with_extension("json.tmp");
    let text =
        serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
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
}

/// Read a media file the user picked into memory for in-card playback. The
/// asset-protocol path is preferred, but Linux WebKitGTK's media stack is
/// unreliable over custom URI schemes — when the <audio> element errors, the
/// webview falls back to this and plays from a blob URL. Raw IPC response
/// (no base64/JSON round-trip); capped so a mispicked multi-GB video can't
/// balloon the webview.
#[tauri::command]
pub async fn read_media_file(path: String) -> Result<tauri::ipc::Response, String> {
    const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_MEDIA_BYTES {
        return Err("file too large to buffer for playback".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Write a plain text file (transcript exports) to the path the user picked
/// in the save dialog. Same atomic tmp+rename + cleanup-on-both-failures shape
/// as `export_settings_file`, minus the 0600 secrecy (a transcript is what the
/// user is deliberately exporting — plain permissions are correct).
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    use std::io::Write as _;
    let path = PathBuf::from(path);
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
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
pub fn import_settings_file(path: String) -> Result<ImportResult, String> {
    const MAX_IMPORT_BYTES: u64 = 20_000_000; // sanity cap, not a format limit
    // Entry-count ceiling, matching the sync path's own (`MAX_SYNCED_ENTRIES` in lib/sync.ts).
    // The byte cap alone admits ~130k well-formed backends, and every one with a key becomes a
    // SERIAL 10s-timeout keyring write in `reconcileBackendSecrets` — permanent credential
    // entries in the user's wallet, with the webview blocked throughout. This is the designated
    // validator for the untrusted-file path; it should fail here, with a message.
    const MAX_ENTRIES: usize = 500;
    // Ceiling on the codes in ONE chord, matching `MAX_CHORD_CODES` in lib/sync.ts. The count cap
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
    let meta = std::fs::metadata(&path).map_err(|e| format!("Could not read the file: {e}"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("That file is too large to be a settings export.".into());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read the file: {e}"))?;
    let mut doc: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| "That file isn't valid JSON.".to_string())?;

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
    let config_version = doc
        .get("configVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(2) as u32;

    let mut warnings: Vec<String> = Vec::new();
    if config_version > 2 {
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
    if let Some(b) = categories.get_mut("backends").and_then(|b| b.as_object_mut()) {
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
    if let Some(list) = categories.get_mut("backends").and_then(|b| b.get_mut("list")) {
        let parsed: Vec<config::Backend> = serde_json::from_value(list.clone())
            .map_err(|e| format!("The file's server connections are invalid: {e}"))?;
        if parsed.len() > MAX_ENTRIES {
            return Err("That file lists far more server connections than the app supports.".into());
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
    if let Some(list) = categories.get_mut("profiles").and_then(|p| p.get_mut("list")) {
        let parsed: Vec<config::Profile> = serde_json::from_value(list.clone())
            .map_err(|e| format!("The file's dictation profiles are invalid: {e}"))?;
        if parsed.len() > MAX_ENTRIES {
            return Err("That file lists far more dictation profiles than the app supports.".into());
        }
        if parsed.iter().any(|p| p.hotkey.len() > MAX_CHORD_CODES) {
            return Err("That file has a shortcut with far more keys than the app supports.".into());
        }
        if parsed
            .iter()
            .any(|p| p.hotkey.iter().any(|c| c.len() > MAX_CHORD_CODE_LEN))
        {
            return Err("That file has a shortcut key name far longer than the app supports.".into());
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
    for key in ["general", "recording", "chip", "dictionary"] {
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
                || qa
                    .as_array()
                    .is_some_and(|a| {
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

#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDevice> {
    audio::device::list_input_devices()
}

#[tauri::command]
pub fn start_mic_test(
    app: AppHandle,
    state: State<AudioState>,
    clip: State<MicTestClip>,
    playback: State<MicPlayback>,
    device_id: Option<String>,
) -> Result<(), String> {
    // Starting a fresh test silences any lingering replay (the bump makes the
    // playback thread see a newer generation and stop).
    playback.0.fetch_add(1, Ordering::SeqCst);
    let mut guard = state.0.lock().map_err(|_| "audio state poisoned")?;
    // Stop any previous capture FIRST — dropping the handle joins its thread, so its cpal
    // callback can't still be appending the old device's samples while the new capture clears +
    // re-stamps the shared clip (which would interleave two devices' audio under one rate stamp,
    // garbling the replay). Mirrors start_stream/start_record's stop-old-before-start-new order.
    *guard = None;
    let handle = audio::capture::start_level_meter(app, device_id, clip.0.clone())?;
    *guard = Some(handle);
    Ok(())
}

/// Stop the mic test and return the number of seconds captured (so the UI can
/// decide whether there's anything worth replaying). Dropping the handle joins the
/// capture thread, so the recorded clip is final by the time we read its length.
#[tauri::command]
pub fn stop_mic_test(state: State<AudioState>, clip: State<MicTestClip>) -> Result<f32, String> {
    *state.0.lock().map_err(|_| "audio state poisoned")? = None;
    let c = clip.0.lock().map_err(|_| "mic clip poisoned")?;
    let secs = if c.sample_rate > 0 {
        c.samples.len() as f32 / c.sample_rate as f32
    } else {
        0.0
    };
    Ok(secs)
}

/// Replay the most recent mic-test capture on the default output device. Returns
/// immediately; playback runs on a detached thread (like the sound cues). A no-op
/// when nothing has been recorded. Bumps the playback generation so any in-flight
/// replay stops before this one starts (never two at once), and emits
/// `audio://test-play-ended` when playback finishes while still current.
#[tauri::command]
pub fn play_mic_test(
    app: AppHandle,
    clip: State<MicTestClip>,
    playback: State<MicPlayback>,
) -> Result<(), String> {
    let (samples, sample_rate) = {
        let c = clip.0.lock().map_err(|_| "mic clip poisoned")?;
        // Collect the ring into a contiguous Vec for playback (one alloc, off the capture path).
        (c.samples.iter().copied().collect::<Vec<f32>>(), c.sample_rate)
    };
    if samples.is_empty() || sample_rate == 0 {
        return Ok(());
    }
    let counter = playback.0.clone();
    let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        'play: {
            // Keep `sink` (it owns the device stream) alive until playback finishes
            // (dropping it cuts audio).
            let Ok(mut sink) = rodio::DeviceSinkBuilder::open_default_sink() else {
                break 'play; // no output device / audio server down — fall through to signal "ended"
            };
            sink.log_on_drop(false); // every replay would otherwise print "Dropping DeviceSink..." on stderr
            // Guarded by the sample_rate == 0 early-return above; still no unwrap on runtime data.
            let Some(rate) = std::num::NonZero::new(sample_rate) else {
                break 'play;
            };
            let player = rodio::Player::connect_new(sink.mixer());
            player.append(rodio::buffer::SamplesBuffer::new(
                std::num::NonZero::new(1).unwrap(), // mono
                rate,
                samples,
            ));
            // Play until it drains, but bail the instant a newer replay (or a new test)
            // superseded us — that newer playback owns the "ended" signal.
            while !player.empty() {
                if counter.load(Ordering::SeqCst) != generation {
                    player.stop();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
        // Finished draining, OR no output device was available — either way nothing of ours is
        // sounding now, so signal "ended" if we're still current. Without the failure path emitting
        // here, a device-acquire failure left the button stuck on "Stop" with no audio until the
        // frontend's duration fallback fired.
        if counter.load(Ordering::SeqCst) == generation {
            let _ = app.emit("audio://test-play-ended", ());
        }
    });
    Ok(())
}

/// Stop an in-flight mic-test replay (no-op if nothing is playing): bump the playback generation
/// so the playing thread sees it's superseded and stops. Does NOT start a new playback.
#[tauri::command]
pub fn stop_mic_test_playback(playback: State<MicPlayback>) {
    playback.0.fetch_add(1, Ordering::SeqCst);
}

// The six session commands below are ASYNC + spawn_blocking, NOT bare sync fns: their bodies do
// genuinely blocking work — the keyring read (resolve_key → D-Bus), joining the previous/current
// capture thread (StreamSession/RecordSession finish + Drop), and above all cpal's device open
// (open_input), which on a Bluetooth mic stalls ~1-2s while the headset switches its profile
// (A2DP → HFP) before it can capture at all. As sync commands all of that ran on the GTK/UI
// thread — the same freeze family as the kwin/arboard gotchas — janking the whole UI on every
// BT dictation start. State is resolved inside the closure via app.state() (a State<'_> param
// can't cross into spawn_blocking); the state Mutex still serializes concurrent starts/stops.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_stream(
    app: AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    response_format: String,
    // None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    recordings_dir: Option<String>,
    trim_silence: bool,
    mute_system: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = resolve_key(api_key, backend_id);
        let save_dir = if save {
            resolve_recordings_dir(&app, recordings_dir)
        } else {
            None
        };
        let state = app.state::<StreamState>();
        let mut guard = state.0.lock().map_err(|_| "stream state poisoned".to_string())?;
        *guard = None; // stop any previous session first (Drop joins capture, drains WS)
        let sess = session::start(
            app.clone(),
            StartParams {
                server_url,
                api_key: key,
                model,
                language,
                response_format,
                prompt,
                decode_overrides,
                override_profile,
                device_id,
                save_dir,
                trim_silence,
                mute_system,
            },
        )?;
        *guard = Some(sess);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_stream(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StreamState>();
        let sess = state.0.lock().map_err(|_| "stream state poisoned".to_string())?.take();
        if let Some(s) = sess {
            s.finish(); // drain in the background to deliver the last utterance
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hard-ABORT the stream session: take it out and let `Drop` run (stops capture, aborts the WS task
/// WITHOUT draining, releases the system-mute guard). Unlike `stop_stream`, no flush/drain happens —
/// a cancel should discard the in-flight session, not fire wasted server work. Also the idempotent
/// teardown the frontend's `closed` handler calls to release a parked session (capture-thread death /
/// server-initiated close that never went through stop_stream): a no-op when already taken.
#[tauri::command]
pub async fn cancel_stream(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StreamState>();
        let sess = state.0.lock().map_err(|_| "stream state poisoned".to_string())?.take();
        let had_session = sess.is_some();
        drop(sess); // Drop (not finish) runs OUTSIDE the lock — the guard released on the line above
        // …and abandon any transcript still being typed out. The typing paths emit one key at a
        // time, so without this a cancel only stopped FUTURE inserts while the current one kept
        // going into whatever window had focus.
        //
        // ONLY when a session was actually taken. The frontend fire-and-forgets a cancel on every
        // normal close, and that no-op call used to bump the counter too — harmless only because
        // the injection captured its epoch so late that the bump always landed first. Now that the
        // capture is at the top of `inject_text`, an unconditional bump here would abort the
        // legitimate end-of-session insert queued moments later.
        if had_session {
            crate::inject::cancel_injection();
        }
        session::retire_active_epoch(); // discarded session (+ any detached drain) must never emit again
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Async + spawn_blocking for the same reasons as start_stream (keyring read, previous-session
// capture join, and the BT-profile-switch stall inside cpal's open_input).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_record(
    app: AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    // None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    recordings_dir: Option<String>,
    trim_silence: bool,
    mute_system: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = resolve_key(api_key, backend_id);
        let save_dir = if save {
            resolve_recordings_dir(&app, recordings_dir)
        } else {
            None
        };
        let state = app.state::<RecordState>();
        let mut guard = state.0.lock().map_err(|_| "record state poisoned".to_string())?;
        *guard = None;
        let sess = session::start_record(
            app.clone(),
            RecordParams {
                server_url,
                api_key: key,
                model,
                language,
                prompt,
                decode_overrides,
                override_profile,
                device_id,
                save_dir,
                trim_silence,
                mute_system,
            },
        )?;
        *guard = Some(sess);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_record(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RecordState>();
        // Claim the detached epoch UNDER the lock. `finish()` publishes it too, but only after
        // joining the capture thread — see `RecordSession::claim_detached` for why that gap let a
        // concurrent cancel disown the wrong session (or none at all).
        let sess = {
            let mut guard = state.0.lock().map_err(|_| "record state poisoned".to_string())?;
            let sess = guard.take();
            if let Some(s) = sess.as_ref() {
                s.claim_detached();
            }
            sess
        };
        if let Some(s) = sess {
            s.finish();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hard-ABORT the record session: take it out and let `Drop` run (stops capture + joins WITHOUT
/// transcribing, releases the system-mute guard). Unlike `stop_record`, it does NOT spawn the
/// transcribe POST — a cancel should discard the clip, not fire a wasted server transcription. Also
/// the idempotent teardown the `closed` handler calls to release a parked session on capture death.
#[tauri::command]
pub async fn cancel_record(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RecordState>();
        // The take AND the no-live-session decision happen under ONE lock. Reading the state and
        // then disowning outside it is the other half of the race `claim_detached` closes: this
        // command must not observe "no session" while `stop_record` is still between its own take
        // and the epoch it is about to publish.
        //
        // A cancel arriving during the "transcribing…" phase finds None here — `stop_record`
        // already took the session and `finish` detached the POST. Disown that work too, so the
        // audio is not uploaded and neither the .wav nor its verbatim .txt is left on disk after
        // a UI that says cancelled.
        //
        // Only when there was no live session: a cancel that DID find one is aimed at that
        // session, and disowning here would instead kill a legitimate earlier transcription that
        // is still in flight (stop A → start B → cancel B would have discarded A's result).
        let (sess, had_session) = {
            let mut guard = state.0.lock().map_err(|_| "record state poisoned".to_string())?;
            let sess = guard.take();
            let had_session = sess.is_some();
            if !had_session {
                session::cancel_detached_batch();
            }
            (sess, had_session)
        };
        // discard() (not finish, not a bare drop) runs OUTSIDE the lock: it marks the clip discarded
        // BEFORE Drop joins the capture thread, so the device-loss salvage arm inside that join does
        // not upload the audio or write the .wav/.txt. Then Drop stops capture and releases the mute.
        if let Some(s) = sess {
            s.discard();
        }
        // …and abandon any transcript still being typed out. The typing paths emit one key at a
        // time, so without this a cancel only stopped FUTURE inserts while the current one kept
        // going into whatever window had focus. Gated on a real session for the same reason as
        // the streaming twin — see `cancel_stream`.
        if had_session {
            crate::inject::cancel_injection();
        }
        session::retire_active_epoch(); // discarded session (+ any in-flight transcribe POST) must never emit again
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Retire the active session epoch WITHOUT draining or aborting — for the frontend's error / fatal-
/// inject teardown, which keeps the DRAINING stop (so the .wav/.txt sidecar still gets written) but
/// must stop that detached drain's late final/closed from bleeding onto a session the user re-triggers
/// during the error linger. Mirrors the cancel-path retire (see session::retire_active_epoch).
#[tauri::command]
pub fn retire_session_epoch() {
    session::retire_active_epoch();
    // The three callers are all "the session died" paths (a server error frame, a fatal insert,
    // a rejected stop), and each one restores the user's focus and declares the session over.
    // Retiring the ACTIVE epoch only silences future EVENTS, though — a transcript already being
    // typed kept going, one key at a time, into whatever window the teardown had just refocused.
    // Abort it too. Unlike a user cancel this leaves the text on the clipboard: the user never
    // asked for it to go away, and the stop-mode path already offers the same recovery.
    crate::inject::abort_injection_for_error();
}

/// Suspend ALL hotkey backends (while the user captures a new binding) so pressing
/// an existing profile's chord only rebinds — it must not also fire dictation. This
/// silences both the global-shortcut plugin AND the evdev reader (which otherwise
/// keeps firing from /dev/input). Pair with `reregister_shortcuts` (apply_bindings)
/// to restore whichever backend is active when capture ends.
///
/// True while shortcuts are intentionally suspended for an in-progress binding capture
/// (suspend_shortcuts is only ever called by the capture hook). The suspend-watch resume
/// path reads this so an automatic resume re-arm can't override a deliberate capture
/// suspension; reregister_shortcuts (the capture-end pair) clears it.
static CAPTURE_SUSPENDED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) {
    CAPTURE_SUSPENDED.store(true, Ordering::SeqCst);
    crate::triggers::unregister_all(&app);
    let state = app.state::<crate::evdev_hotkeys::EvdevState>();
    crate::evdev_hotkeys::stop(&state);
    // Windows twin of the evdev teardown (no-op elsewhere): the hook backend is the
    // always-on low-level listener there and must fall silent during capture too.
    crate::win_hotkeys::stop(&app.state::<crate::win_hotkeys::WinHookState>());
    // stop() aborts the reader tasks, which skips their post-loop cleanup, so compensate for both:
    // (1) the held-KEY counts — a modifier held now would leave a phantom count and make the next
    // inject_text wait the full gate timeout; restore held_keys' "not running ⇒ empty".
    app.state::<crate::held_keys::HeldKeys>().clear();
    // (2) the held-SESSION "stop" — a PTT chord held while a rebind capture starts would otherwise
    // wedge "listening" until manual cancel (the release reaches no reader). No-op when none held.
    crate::evdev_hotkeys::stop_held_sessions(&app);
    crate::win_hotkeys::stop_held_sessions(&app);
}

/// Whether ALL of the given chord's MODIFIER keys are physically held RIGHT NOW, per
/// the low-level backends' shared HeldKeys signal (evdev on Linux, win_hotkeys on
/// Windows; always false when only the plugin backend runs — it can't see raw key
/// state). `codes` is the binding's `event.code` list; non-modifier members are
/// unobservable and ignored, and a chord with NO modifiers answers false.
/// Consumer: the frontend's queued-start path — a PTT press that landed during
/// "finalizing…" auto-starts once the session settles, but only while ITS chord is
/// still down. Checking the chord's own modifiers (not "any modifier") keeps an
/// unrelated held Shift from starting a hold session whose release will never come.
#[tauri::command]
pub fn shortcut_mods_held(app: AppHandle, codes: Vec<String>) -> bool {
    let mods: Vec<u16> = codes
        .iter()
        .filter_map(|c| crate::held_keys::modifier_code(c))
        .collect();
    app.state::<crate::held_keys::HeldKeys>().all_held(&mods)
}

/// Apply the current bindings to the right backend: when the evdev backend is
/// enabled AND permitted it owns the Profiles' chords and the global-shortcut
/// plugin is silenced (mutual exclusion); otherwise the plugin registers and evdev stops.
pub fn apply_bindings(app: &AppHandle) {
    // Serialize the whole load→branch→apply. This is invoked from the suspend-watch thread, the
    // reregister_shortcuts* command handlers, and setup, which can overlap (a resume runs
    // apply_bindings AND emits system://resumed → the frontend calls reregister). Without this lock,
    // if the on-disk config flips evdev_enabled between two concurrent runs' loads, the two take
    // opposite branches and the evdev-XOR-plugin invariant breaks: both backends end up live (every
    // chord double-fires) or neither is registered (no hotkeys until the next reregister). The body
    // is synchronous, so holding a std Mutex across it is safe.
    static APPLY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let Ok(dir) = config_dir(app) else { return };
    let cfg = config::load(&dir);
    // The quick-add chord stays INERT until a word-mapping list is designated
    // (settings.quickAddList) — the window would have nothing to add to. This
    // keeps the Ctrl+Shift+RightCtrl factory default harmless out of the box;
    // designating a list (onboarding step 3 / the Dictionary screen) arms it.
    let no_quick_add: Vec<String> = Vec::new();
    let quick_add = if cfg.settings.quick_add_list.is_some() {
        &cfg.settings.general.quick_add_hotkey
    } else {
        &no_quick_add
    };
    // Re-registering aborts the evdev reader tasks, which skips their post-loop "stop" for any
    // PTT chord held right now — so a session held across this restart (e.g. editing a profile
    // while holding push-to-talk) would wedge "listening". Emit those stops first. No-op when
    // nothing is held. (The Windows hook worker exits gracefully and normally emits its own
    // stops, but claim-based: whichever side runs first wins — see win_hotkeys::take_hold.)
    crate::evdev_hotkeys::stop_held_sessions(app);
    crate::win_hotkeys::stop_held_sessions(app);
    #[cfg(windows)]
    {
        // Windows: the low-level hook backend owns ALL chords — it registers everything
        // the plugin can, plus the modifier-only / left-right / N-key chords it can't
        // (the default Ctrl+Shift PTT). The plugin stays silent, mirroring the
        // evdev-XOR-plugin invariant below.
        crate::triggers::unregister_all(app);
        let hook = app.state::<crate::win_hotkeys::WinHookState>();
        crate::win_hotkeys::start(app, &hook, &cfg.profiles, quick_add);
        tracing::info!("[bindings] windows hook backend active (plugin silenced)");
    }
    #[cfg(not(windows))]
    {
        let state = app.state::<crate::evdev_hotkeys::EvdevState>();
        if cfg.settings.general.evdev_enabled && crate::evdev_hotkeys::permitted() {
            crate::triggers::unregister_all(app);
            crate::evdev_hotkeys::start(app, &state, &cfg.profiles, quick_add);
            tracing::info!("[bindings] evdev backend active (plugin silenced)");
        } else {
            crate::evdev_hotkeys::stop(&state);
            // Aborting the reader skips its held-key cleanup; drop any stale counts so the
            // inject gate isn't wedged on a phantom modifier while evdev stays off.
            app.state::<crate::held_keys::HeldKeys>().clear();
            crate::triggers::register_from_config(app, &cfg.profiles, quick_add);
        }
    }
}

/// Re-read config and re-apply bindings (call after hotkeys / evdev toggle change).
#[tauri::command]
pub fn reregister_shortcuts(app: AppHandle) -> Result<(), String> {
    // Capture ended (or bindings changed): no longer suspended-for-capture, so a later
    // resume may re-arm normally again.
    CAPTURE_SUSPENDED.store(false, Ordering::SeqCst);
    apply_bindings(&app);
    Ok(())
}

/// Like `reregister_shortcuts`, but a NO-OP while a binding capture is in progress
/// (CAPTURE_SUSPENDED). cancelLive's resume-recovery calls this: cancelling a session on
/// `system://resumed` must NOT clear the capture suspension and re-arm the hotkeys mid-capture
/// (the suspend-watch deliberately left them suspended, and the capture-end `reregister_shortcuts`
/// will re-arm once capture truly ends). Outside a capture it behaves exactly like the unconditional
/// reregister, preserving cancelLive's stuck-hotkey recovery.
#[tauri::command]
pub fn reregister_shortcuts_unless_capturing(app: AppHandle) -> Result<(), String> {
    if CAPTURE_SUSPENDED.load(Ordering::SeqCst) {
        return Ok(());
    }
    reregister_shortcuts(app)
}

/// Detect a system suspend/resume by watching the wall clock for a large gap: a
/// dedicated thread ticks every couple of seconds; if far more time elapsed between
/// ticks than it slept, the machine was asleep in between. Suspend is hostile to both
/// long-lived listeners — it can drop the key-release that ends a hold-to-talk chord
/// (leaving the evdev backend stuck "down"), or re-enumerate the keyboards (killing
/// the reader tasks), and it silently kills the dictation WebSocket. On resume we
/// rebuild the hotkey backend (fresh held-state, freshly enumerated devices) and tell
/// the UI to drop any in-flight session so the chip can't hang at "finalizing…".
pub fn spawn_suspend_watch(app: AppHandle) {
    use std::time::{Duration, SystemTime};
    // Wall clock, NOT Instant: CLOCK_MONOTONIC pauses across suspend on Linux, so it
    // would never show the gap. SystemTime keeps advancing while the machine sleeps.
    const TICK: Duration = Duration::from_secs(2);
    // A gap this far beyond TICK means a real sleep, not scheduler jitter / NTP step.
    const GAP: Duration = Duration::from_secs(8);
    let _ = std::thread::Builder::new()
        .name("suspend-watch".into())
        .spawn(move || {
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(TICK);
                let now = SystemTime::now();
                let elapsed = now.duration_since(last).unwrap_or(Duration::ZERO);
                last = now;
                if elapsed > GAP {
                    tracing::info!(
                        "[suspend] resume detected (~{}s gap); clearing dictation",
                        elapsed.as_secs()
                    );
                    // Don't re-arm while a binding capture is in progress: the frontend suspended
                    // shortcuts on purpose so a press only rebinds, and it restores them via
                    // reregister_shortcuts when capture ends. Re-arming here would let the user's
                    // next chord both rebind AND fire dictation (for a held evdev PTT chord, wedge
                    // "listening" — exactly what the suspend guards). The capture's reregister
                    // rebuilds fresh held-state on completion, so nothing is lost by skipping.
                    if CAPTURE_SUSPENDED.load(Ordering::SeqCst) {
                        tracing::info!("[suspend] binding capture in progress; leaving shortcuts suspended");
                    } else {
                        apply_bindings(&app);
                    }
                    let _ = app.emit("system://resumed", ());
                }
            }
        });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvdevStatus {
    /// evdev is a Linux-only backend.
    available: bool,
    /// We can actually open a keyboard (i.e. the user is in the `input` group).
    permitted: bool,
    /// The user has turned the backend on in config.
    enabled: bool,
}

/// Status for the Permissions UI: is evdev available / permitted / enabled?
#[tauri::command]
pub fn evdev_status(app: AppHandle) -> EvdevStatus {
    let enabled = config_dir(&app)
        .map(|d| config::load(&d).settings.general.evdev_enabled)
        .unwrap_or(false);
    EvdevStatus {
        available: cfg!(target_os = "linux"),
        permitted: crate::evdev_hotkeys::permitted(),
        enabled,
    }
}

/// Add the user to the `input` group via `pkexec` (polkit GUI auth). The user must
/// log out and back in for it to take effect.
#[tauri::command]
pub async fn evdev_setup() -> Result<String, String> {
    crate::evdev_hotkeys::setup().await
}

/// Whether a code-list chord can be registered by the platform's registrar. On
/// Windows that's the always-on hook backend (anything mappable, incl. modifier-only
/// / AltGr / left-right). Elsewhere it's the global-shortcut plugin — modifier-only /
/// AltGr chords return false there; those need the evdev backend. (The capture UI
/// only consults this in plugin mode, but keep the answer truthful per platform.)
#[tauri::command]
pub fn validate_codes(codes: Vec<String>) -> bool {
    #[cfg(windows)]
    {
        !codes.is_empty() && codes.iter().all(|c| crate::win_hotkeys::code_valid(c))
    }
    #[cfg(not(windows))]
    {
        use std::str::FromStr;
        crate::config::codes_to_accelerator(&codes)
            .map(|a| tauri_plugin_global_shortcut::Shortcut::from_str(&a).is_ok())
            .unwrap_or(false)
    }
}

/// Snapshot of the clipboard taken before a live (per-segment) paste dictation, so
/// the user's original clipboard is restored once at the end rather than after
/// every segment (which would race + churn the clipboard manager).
#[derive(Default)]
pub struct ClipboardSnapshot(pub std::sync::Mutex<Option<String>>);

/// Snapshot the current clipboard before a live paste-injection session.
/// Run a blocking clipboard / PRIMARY-selection read OFF the UI thread, bounded to 400ms. arboard's
/// get_text (and the PRIMARY read) are blocking Wayland round-trips that can hang indefinitely on a
/// dead/slow owner — e.g. right after the previous clipboard owner exited — so every such read goes
/// through here: one place owns the off-thread + 400ms-cap contract. Returns None on timeout, join
/// error, or an empty read; callers log / handle None per-site.
async fn read_selection_bounded(
    read: impl FnOnce() -> Option<String> + Send + 'static,
) -> Option<String> {
    let task = tokio::task::spawn_blocking(read);
    match tokio::time::timeout(std::time::Duration::from_millis(400), task).await {
        Ok(Ok(v)) => v,
        _ => None,
    }
}

/// True when the currently-focused app is a remote-desktop client (mstsc & co, see
/// inject::is_remote_desktop_app). Clipboard RESTORES are skipped for those targets: their
/// clipboard sync is asynchronous (RDP delayed rendering fetches the data only when the remote
/// app pastes), so a restored value can be what a still-pending remote paste actually receives.
fn focused_remote_target(guard: &crate::atspi_guard::AtspiGuard) -> bool {
    crate::atspi_guard::focused_app_now(guard)
        .map(|f| crate::inject::is_remote_desktop_app(&f.app_id))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn begin_injection(snap: State<'_, ClipboardSnapshot>) -> Result<(), String> {
    // Read the clipboard OFF the GTK main thread, time-bounded (see read_selection_bounded). This is
    // called PER PHRASE, and a SYNC command runs on the UI thread — on the UI thread the blocking read
    // freezes the whole app. On timeout/empty we KEEP the prior snapshot: that path means we still hold
    // the clipboard ourselves (the user copied nothing new), so the existing snapshot already has it.
    match read_selection_bounded(|| arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok())).await {
        // The clipboard still holds OUR last transcript (a restore was skipped or failed silently)
        // — that is NOT the user's clipboard, and snapshotting it would resurrect stale dictation
        // at the end-of-session restore. Same reasoning as the None arm: the user copied nothing
        // new, so the existing snapshot (if any) already has the real thing.
        Some(text) if crate::inject::is_own_injected(&text) => {
            tracing::info!("[clip] begin_injection: clipboard holds our own transcript — keeping prior snapshot");
        }
        Some(text) => {
            tracing::info!("[clip] begin_injection: snapshot {} chars", text.len());
            if let Ok(mut g) = snap.0.lock() {
                *g = Some(text);
            }
        }
        None => tracing::info!("[clip] begin_injection: clipboard read empty/timeout — keeping prior snapshot"),
    }
    Ok(())
}

/// Restore the clipboard snapshot taken by `begin_injection` (end of a live session).
#[tauri::command]
pub fn end_injection(snap: State<ClipboardSnapshot>, guard: State<crate::atspi_guard::AtspiGuard>) {
    // Taken UNCONDITIONALLY, above the snapshot test. Inside `if let Some(prev)` it would be
    // unreachable on every session that took no snapshot (direct-typing method, restore-clipboard
    // off, or a clipboard read that timed out) — and `streaming.ts` calls this on every teardown,
    // no-op or not. A flag armed by such a session would then survive to suppress a LATER
    // session's legitimate restore. Consuming it here makes it strictly one-shot per teardown.
    let recovered_on_clipboard = crate::inject::take_recovery_on_clipboard();
    let prev = snap.0.lock().ok().and_then(|mut g| g.take());
    if let Some(prev) = prev {
        // Remote-desktop target: skip the restore (same contract as the per-paste path) — the
        // restored value can be what the remote's still-pending paste fetches. The snapshot is
        // already consumed above, so it can't leak into a later session either way.
        if focused_remote_target(guard.inner()) {
            tracing::info!("[clip] end_injection: remote-desktop target — restore skipped");
            return;
        }
        // An error-abort recovery just put the abandoned transcript on the clipboard for the
        // user to paste manually. Restoring `prev` 400ms later would erase it — the same
        // erasure the per-paste restore declines a few hundred lines below, on the one path
        // that guard cannot cover (it needs the job's epoch; this command has none). The
        // snapshot is consumed either way, so it cannot leak into a later session.
        if recovered_on_clipboard {
            tracing::info!(
                "[clip] end_injection: a recovered transcript is on the clipboard — restore skipped"
            );
            return;
        }
        tracing::info!("[clip] end_injection: restore {} chars (delayed)", prev.len());
        // Persist on Wayland: a plain set_text that drops immediately doesn't stick, which
        // is why the clipboard was "never restored". Serve it from a live owner — and after a
        // short delay, so the last phrase's in-flight Ctrl+V consumes the transcript BEFORE we
        // swap the original back (else the final phrase can paste the original instead).
        crate::inject::restore_clipboard_later(Some(prev));
    }
}

/// Restore the `begin_injection` snapshot WITHOUT consuming it, so the user's original
/// clipboard can be put back after EACH pasted phrase in an ongoing latch session (the
/// snapshot stays for the next phrase to restore again). Served from a live owner so it
/// persists on Wayland; no-op when no snapshot was taken (restore off / non-paste session).
#[tauri::command]
pub fn restore_clipboard_snapshot(
    snap: State<ClipboardSnapshot>,
    guard: State<crate::atspi_guard::AtspiGuard>,
) {
    let prev = snap.0.lock().ok().and_then(|g| g.clone());
    if let Some(prev) = prev {
        // Remote-desktop target: skip the per-phrase restore (see end_injection) — the snapshot
        // stays untouched for later phrases / a later non-remote end-of-session restore.
        if focused_remote_target(guard.inner()) {
            tracing::info!("[clip] restore_clipboard_snapshot: remote-desktop target — restore skipped");
            return;
        }
        tracing::info!("[clip] restore_clipboard_snapshot: {} chars (delayed)", prev.len());
        // Serve after the same ~400ms margin as end_injection / the paste path (via
        // restore_clipboard_later), NOT an immediate set_clipboard_persistent: the boundary-
        // separator restore (streaming.ts) runs synchronously right after its OWN separator
        // paste, so an immediate serve races the target's async selection read and could hand
        // back the user's old clipboard instead of the separator. The per-phrase restore fires
        // on the ~1.2s quiet timer, so the extra 400ms delay is immaterial there.
        crate::inject::restore_clipboard_later(Some(prev));
    }
}

/// Clear the `begin_injection` snapshot WITHOUT restoring it. Used when a live paste session
/// ENDS on a clipboard-only phrase: the clipboard then deliberately holds the transcript the
/// user wants to paste, so the end-of-session restore must NOT clobber it — but we still drop
/// the snapshot so it can't leak a stale value into a later session (e.g. a future
/// begin_injection that times out and keeps the prior snapshot).
#[tauri::command]
pub fn discard_injection_snapshot(snap: State<ClipboardSnapshot>) {
    if let Ok(mut g) = snap.0.lock() {
        let _ = g.take();
    }
    // The other way a session ends. Dropping the snapshot means no restore will ever be attempted
    // against it, so a recovery flag has nothing left to protect and must not outlive this session.
    crate::inject::clear_recovery_on_clipboard();
}

/// The focused application's id + title + (when deep detection is on) whether its focused
/// element is editable. Via AT-SPI; `None` when nothing is known yet (no a11y bridge / cold
/// listener). Used to resolve per-app rules, the chip readout, and the field guard. When one
/// of OUR OWN windows holds focus, returns a synthetic `is_self` "this app" target so the chip
/// reads "→ this app" rather than the stale previously-focused app AT-SPI would report.
#[tauri::command]
pub async fn get_focused_app(
    app: AppHandle,
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<crate::atspi_guard::FocusedApp>, String> {
    // Authoritative own-window check (same as inject_text's guard): a Wayland client always
    // knows its own keyboard focus. Dictation won't type into our own UI, so surface that
    // truthfully instead of letting AT-SPI report whatever was focused before us. The
    // click-through "overlay" chip never holds focus; exclude it.
    if app
        .webview_windows()
        .iter()
        .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
    {
        return Ok(Some(crate::atspi_guard::FocusedApp {
            app_id: "self".into(),
            title: "this app".into(),
            editable: Some(false),
            is_self: true,
        }));
    }
    let focused = crate::atspi_guard::focused_app(guard.inner()).await;
    // The window TITLE can carry sensitive data (open document / email subject / private tab names)
    // and this is polled ~every 700ms during a session, so keep it OUT of the default-on `info` line —
    // log only app_id + editable there; the full record (incl. title) goes to `debug` (off by default).
    match &focused {
        Some(f) => tracing::info!("[focused-app] id={} editable={:?}", f.app_id, f.editable),
        None => tracing::info!("[focused-app] none"),
    }
    tracing::debug!("[focused-app] {focused:?}");
    Ok(focused)
}

/// Like `get_focused_app` but WITHOUT the own-window self short-circuit: returns the
/// previously-focused OTHER application (`last_other` when our own window is up front). The
/// App-rules "Use current" button calls this — it's always clicked while our own Settings
/// window holds focus, so the self-aware `get_focused_app` would always report "this app".
#[tauri::command]
pub async fn get_focused_other_app(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<crate::atspi_guard::FocusedApp>, String> {
    let focused = crate::atspi_guard::focused_app(guard.inner()).await;
    // Keep the window title out of the default-on `info` line (see get_focused_app) — it can hold
    // sensitive data; log app_id + editable at info, the full record at `debug` (off by default).
    match &focused {
        Some(f) => tracing::info!("[focused-other-app] id={} editable={:?}", f.app_id, f.editable),
        None => tracing::info!("[focused-other-app] none"),
    }
    tracing::debug!("[focused-other-app] {focused:?}");
    Ok(focused)
}

/// Read the user's current text selection from the SOURCE app to pre-fill Quick-Add's "When you
/// say" field on summon, or `None` to leave it empty (and show the recent-words dropdown).
///
/// Order: ask accessibility (AT-SPI) FIRST — it can authoritatively report "nothing is selected",
/// so we never seed a STALE highlight when the user summoned with no selection. Only when it can't
/// tell (no Text interface — terminals, some Electron) do we fall back to the focus-independent
/// PRIMARY "highlight" buffer (read OFF the UI thread + time-bounded, same hazard as
/// `begin_injection`). The text is sanitised to a single short line either way.
#[tauri::command]
pub async fn get_quickadd_seed(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
    seed_rdv: State<'_, crate::quickadd::SeedRendezvous>,
) -> Result<Option<String>, String> {
    // Windows: no AT-SPI / PRIMARY — the copy chord fired BEFORE the window took focus
    // (quickadd::show → win_seed), but the clipboard may still be settling (Office
    // delayed rendering, RDP clipboard redirection), so AWAIT this summon's grab via
    // the generation-stamped rendezvous rather than reading a cache. The bound covers
    // the grab's LONGEST copy deadline (the 6s remote-desktop one) plus read retries —
    // a settle wakes it immediately, so the local path never pays it; off the async
    // runtime because the wait is a condvar block. Same sanitizer as the Linux paths.
    #[cfg(windows)]
    {
        let _ = &guard;
        let rdv = seed_rdv.inner().clone();
        let raw = tauri::async_runtime::spawn_blocking(move || {
            rdv.wait(std::time::Duration::from_millis(6500))
        })
        .await
        .ok()
        .flatten();
        let seed = raw.as_deref().and_then(sanitize_seed);
        // `None` and `Some("")` used to both print "0 chars", which made "the grab found
        // nothing" indistinguishable from "the reader aborted (window closed) / timed out"
        // in exactly the field reports this line exists for.
        match &raw {
            None => tracing::info!(
                "[quickadd-seed] windows copy grab returned no text (no copy landed, summon superseded, or wait timed out)"
            ),
            Some(t) => tracing::info!(
                "[quickadd-seed] windows copy grab {} bytes -> seed {} bytes",
                t.len(),
                seed.as_deref().map_or(0, str::len)
            ),
        }
        return Ok(seed);
    }
    #[cfg(not(windows))]
    {
        let _ = &seed_rdv;
        use crate::atspi_guard::SelRead;
        match crate::atspi_guard::focused_selection(guard.inner()).await {
            SelRead::Text(s) => {
                let seed = sanitize_seed(&s);
                tracing::info!("[quickadd-seed] atspi selection {} chars -> seed {} chars", s.len(), seed.as_deref().map_or(0, str::len));
                Ok(seed)
            }
            SelRead::Empty => {
                tracing::info!("[quickadd-seed] atspi: nothing selected -> no seed");
                Ok(None)
            }
            // Opaque (rich-text ￼) or no Text interface at all → the real word lives in PRIMARY.
            SelRead::Opaque | SelRead::Unavailable => {
                let raw = match read_primary_now().await {
                    Some(s) => s,
                    None => return Ok(None),
                };
                let seed = sanitize_seed(&raw);
                tracing::info!("[quickadd-seed] primary fallback {} chars -> seed {} chars", raw.len(), seed.as_deref().map_or(0, str::len));
                Ok(seed)
            }
        }
    }
}

/// Read the focused element's CURRENT text selection for the correct-on-close guard, called AFTER
/// Quick-Add hides (focus back on the source app) to confirm the SAME word is still highlighted
/// before replacing it. Accessibility must FIRST confirm a live selection exists in the focused app:
/// `Text` returns it directly; `Opaque` (a real rich-text selection whose chars are ￼) is confirmed
/// to exist, so we read its rendered text from PRIMARY. `Empty`/`Unavailable` return `None` — we
/// can't confirm the word is still selected, so we never paste blindly (and never consult PRIMARY,
/// which would be stale). This keeps the "check first, then replace" guarantee in rich-text editors.
///
/// Windows has no a11y selection read: RE-GRAB via the same copy-chord + clipboard-diff as the
/// summon seed (`quickadd::win_seed`), which lands in the source app since focus is back there.
/// An unchanged clipboard (selection gone / collapsed) reads as `None` — same check-first
/// guarantee, verified against the live app rather than a cache.
#[tauri::command]
pub async fn get_focused_selection(
    app: tauri::AppHandle,
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let _ = &guard;
        let sel = tauri::async_runtime::spawn_blocking(move || crate::quickadd::win_seed::grab(&app, None, None))
            .await
            .ok()
            .flatten()
            .map(bounded_selection);
        tracing::info!(
            "[quickadd-close] windows re-grab -> {} chars",
            sel.as_deref().map_or(0, str::len)
        );
        Ok(sel)
    }
    #[cfg(not(windows))]
    {
        let _ = &app;
        use crate::atspi_guard::SelRead;
        Ok(match crate::atspi_guard::focused_selection(guard.inner()).await {
            // `Text` is already capped at its own read; the PRIMARY fallback is only TIME-bounded.
            SelRead::Text(s) => Some(s),
            SelRead::Opaque => read_primary_now().await.map(bounded_selection),
            SelRead::Empty | SelRead::Unavailable => None,
        })
    }
}

/// Read the Wayland PRIMARY ("highlight") selection off the UI thread, time-bounded — the same
/// hazard guard as `begin_injection` (a hung clipboard owner must not stall the caller).
#[cfg_attr(windows, allow(dead_code))] // PRIMARY is a Linux concept; Windows seeds via win_seed
async fn read_primary_now() -> Option<String> {
    read_selection_bounded(crate::inject::read_primary_selection).await
}

/// Cap a selection read at `SEL_MAX`, the way the AT-SPI Text read already does at its own source.
///
/// That bound was applied "at the READ, so every consumer inherits it" — but only for the one
/// path that had a read to bind it to. Two siblings feed the SAME command and got nothing:
/// `read_primary_now`, which is TIME-bounded (400ms) and not SIZE-bounded, and the Windows
/// clipboard re-grab. Both hand the string straight across the IPC into the QuickAdd webview.
/// Truncation cannot change the outcome downstream: the value is only compared against a mapping
/// key that `sanitize_seed` already limits to a single line of ≤100 characters.
fn bounded_selection(s: String) -> String {
    match s.char_indices().nth(crate::atspi_guard::SEL_MAX) {
        Some((i, _)) => s[..i].to_string(),
        None => s,
    }
}

/// Turn a raw selection into a usable mapping KEY, or reject it. Multi-WORD selections are kept
/// verbatim (one key); a multi-LINE selection, an empty/whitespace-only one, or anything longer
/// than a plausible phrase is rejected — a paragraph isn't a spoken symbol. Edges are trimmed (a
/// trailing newline from a to-end-of-line highlight just falls away); an INTERIOR newline rejects.
fn sanitize_seed(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.contains('\n') || s.contains('\r') {
        return None;
    }
    if s.chars().count() > 100 {
        return None;
    }
    Some(s.to_string())
}

/// Toggle the opt-in AT-SPI "deep field detection" (a11y flag + Chromium/Electron poke),
/// which lets the focused-element editability read correctly for browser/Electron apps.
#[tauri::command]
pub fn set_deep_field_detection(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
    enabled: bool,
) -> Result<(), String> {
    tracing::info!("[atspi] deep field detection = {enabled}");
    crate::atspi_guard::set_deep(guard.inner(), enabled);
    Ok(())
}

/// How long a manufactured-stop latch stays valid — see `held_keys::take_lost_if_fresh`.
///
/// Deliberately generous, and sized against the LONGEST leg it has to span rather than a guessed
/// round-trip: what sits in the middle is the untrusted server returning a final, so anything
/// shorter is a bypass the server itself can trigger by stalling. A stale latch only ever costs one
/// phrase a clipboard divert, which the chip now reports; a short one costs the control entirely.
///
/// That leg is NOT bounded by the frontend's stuck-finalize watchdog, which is what this constant
/// was first tied to: `armStuckWatchdog` returns early unless the endpoint is `stream`
/// (`src/lib/streaming.ts`), and `activation: "hold"` with `endpoint: "batch"` is a legal profile —
/// one that lands in stop-timing mode, where the single insert carries the WHOLE transcript through
/// the typing path. On that leg the only bound is the shared HTTP client's 120s default
/// (`transport::mod`, which `batch` dictation does not override), so a transcription that takes
/// longer than 15s — a long clip, a big model, or a server stalling on purpose — walked straight
/// past this control. 130s covers the 120s timeout plus the stop → POST → final → inject hops.
const HELD_CHORD_LATCH_TTL: std::time::Duration = std::time::Duration::from_secs(130);

/// What `inject_text` did, so the caller can keep its own bookkeeping honest.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectOutcome {
    /// The text LANDED — typed, pasted, or deliberately left on the clipboard. `false` only when
    /// one of our own windows held focus and the whole insert was skipped, at entry or at the sink.
    /// The caller must not advance its typed baseline on `false`; nothing was written anywhere, so
    /// there is nothing to recover, and the phrase has to go out again.
    ///
    /// The default for any future early return must be `true`. `false` means "send it again", and a
    /// wrong `false` re-types a phrase the user already has — visibly duplicated text, which is
    /// worse than the silent drop this field exists to fix.
    pub landed: bool,
    /// We DIVERTED to the clipboard against the caller's wishes — it asked for typing or pasting
    /// and got neither, because the trigger chord was still held or focus had moved to a different
    /// app. The text is safe, but it did not go where the user was looking, and until this field
    /// existed nothing said so: the caller stamped its green "typed" confirmation either way.
    ///
    /// This matters more since the held-chord branch became reachable on the primary hotkey paths,
    /// and more again now that the wiped-map latch can reach it too.
    pub diverted: bool,
}

/// Insert text into the focused field of the active app (paste or direct typing).
/// Direct typing on Wayland routes through the RemoteDesktop portal; everything
/// else uses enigo (clipboard paste, or direct on X11/Windows).
#[tauri::command]
pub async fn inject_text(
    app: AppHandle,
    typer: State<'_, WaylandTyper>,
    vkbd: State<'_, crate::virtual_keyboard::VirtualKeyboard>,
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
    text: String,
    method: String,
    auto_enter: bool,
    restore_clipboard: bool,
    paste_shortcut: Vec<String>,
    // `expect_app_id` is the app the CALLER resolved its per-app rule and insert method against.
    // `None` = no identified target (our own window, or a cold a11y bridge), which skips the
    // re-check below.
    expect_app_id: Option<String>,
) -> Result<InjectOutcome, String> {
    // Strip control characters (except Tab/LF; CR is normalized to LF) from the server-transcribed
    // text before it reaches ANY injection path — clipboard-only, Wayland paste, or X11 paste/direct
    // — so a malicious/garbled server can't smuggle terminal-escape sequences onto the clipboard or
    // into a paste. (The Wayland direct-typing paths already drop controls; this matches them.)
    let text = crate::inject::sanitize_injected(&text);
    // Captured HERE — before any await — not where the job is finally queued. Everything below
    // (the held-modifier wait, two focus IPCs, a bounded clipboard read, the settle, and on the
    // Wayland fallback a failed virtual-keyboard attempt) can take a second or more, and a cancel
    // landing in that window used to bump the counter BEFORE the job read it, so the job adopted
    // the post-cancel generation and never saw itself as cancelled.
    let epoch = crate::inject::injection_epoch();
    tracing::info!("[inject] {} chars via {} (auto_enter={})", text.len(), method, auto_enter);
    // Never inject into our OWN UI: if one of our real windows holds keyboard focus, typed/pasted
    // keys would fire buttons/shortcuts in the app itself (e.g. dictating while looking at Home) —
    // AND a clipboard-only insert would silently clobber the user's clipboard for an insert they
    // can't even see land. So this guard runs for ALL methods, BEFORE the clipboard-only branch
    // (it used to sit after it, so clipboard-only clobbered the clipboard while our own window was
    // focused). A Wayland client is always told its own keyboard focus, so this is reliable on KWin —
    // unlike detecting other apps' focused fields. The click-through "overlay" chip never holds
    // focus; exclude it. The transcript still shows in the chip.
    if app
        .webview_windows()
        .iter()
        .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
    {
        tracing::info!("[inject] skipped: our own window holds focus");
        return Ok(InjectOutcome { landed: false, diverted: false });
    }
    // Clipboard-only: put the text on the clipboard and inject NO keystrokes, so it can't
    // fire actions in the wrong window — the user pastes it themselves. No modifier gate needed
    // since nothing is typed (the own-window guard above already ran).
    if method == "clipboard" {
        if !text.is_empty() {
            // The whole point of the handshake: this arm's `landed: true` used to be a constant,
            // and it is the arm that runs for every phrase when the insert method IS the
            // clipboard. Reporting false is safe here because no keystroke is ever synthesized on
            // this path, so the caller's re-send cannot duplicate anything.
            if let Err(e) = crate::inject::set_clipboard_persistent(&text) {
                tracing::warn!("[inject] clipboard-only insert failed: {e}");
                return Ok(InjectOutcome { landed: false, diverted: false });
            }
        }
        return Ok(InjectOutcome { landed: true, diverted: false });
    }
    // Nothing to type and no Enter to send → bail before the keystroke paths. Without this, the
    // Wayland PASTE branch below would set_clipboard("") — clobbering the user's clipboard with an
    // empty string and firing a no-op Ctrl+V — whenever a phrase sanitizes to empty (the server
    // emitted only control chars). Mirrors the X11 inject::inject guard. (empty + auto_enter still
    // falls through below to send the bare Enter.)
    if text.is_empty() && !auto_enter {
        return Ok(InjectOutcome { landed: true, diverted: false });
    }
    // Pasting into a remote-desktop client (mstsc & co) needs different clipboard handling: the
    // local clipboard reaches the remote host ASYNCHRONOUSLY, so the paste gets a longer settle
    // before Ctrl+V (the new content must cross the network before the forwarded keystroke) and
    // NEVER restores the previous clipboard afterwards (with RDP delayed rendering, the restored
    // value can be what the remote's paste actually fetches — this is how a 7-minute-old
    // transcript once landed instead of the fresh one). Direct typing never touches the
    // clipboard, so it doesn't care.
    // Resolved at the SINK, below, from the same focus read the per-app re-check uses — see there.
    // Wait briefly for the trigger chord's shortcut modifiers (Ctrl/Alt/Meta) to be
    // physically released before typing — otherwise the injected keys fold into the
    // still-held modifier and fire shortcuts in the focused app (worst with a latch
    // stop, which triggers on the second chord press with every key still down). Only
    // the evdev backend can observe physical release on Wayland; when it isn't running
    // the held set is empty so this is a no-op. Capped so we never drop the text.
    let mut modifiers_stuck = false;
    {
        let held = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        if held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
                if std::time::Instant::now() >= deadline {
                    // The gate used to fail OPEN here: it logged and typed anyway, so the
                    // transcript's characters folded into the still-held modifier and became
                    // shortcut chords in the focused app — with the server choosing WHICH ones.
                    //
                    // It cannot simply fail closed either. `SHORTCUT_MOD_CODES` spans both
                    // Shifts, and this is `any_held`, so a user holding Shift to capitalize or
                    // Ctrl to scroll-zoom during a live session would silently have every phrase
                    // diverted — dictation looks broken with nothing to explain it. So divert
                    // only when the modifiers still down are the ones that were down when the
                    // TRIGGER fired, i.e. the dictation chord itself is not being released.
                    modifiers_stuck = crate::triggers::trigger_modifiers_still_held(&held);
                    if modifiers_stuck {
                        tracing::warn!("[inject] trigger chord still held after 500ms — clipboard only");
                    } else {
                        tracing::warn!("[inject] an unrelated modifier is held — injecting anyway");
                    }
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        }
    }
    // …and the case the map CANNOT report, because the record was destroyed: a backend restart
    // (a sync pull that changes a profile, a rebind, a hotkey capture, the evdev-off arm) wipes the
    // held map, and both backends feed it by TRANSITION — so a modifier already physically down
    // never reappears and its key-up early-returns too. The map reads empty for the rest of that
    // hold and the whole gate above is skipped.
    //
    // That teardown is not a bystander: it emits a mid-hold stop for a push-to-talk profile, which
    // MANUFACTURES this injection at the exact moment the chord is provably still down. So the wipe
    // now arms a chord-precise, self-expiring latch, and here we consume it.
    //
    // Deliberately consumed AFTER the loop, not merged into it: this is a "the chord was down when
    // we lost sight of it" fact, not a live reading, so there is nothing to wait for. Straight to
    // the same clipboard divert the timeout arm produces. The TTL only has to cover
    // teardown-stop → frontend finalize → here.

    // The own-window guard at the top of this command has the same decided-at-T/applied-at-T+n
    // problem the per-app re-check below was written to fix, and it was left at the entry: the
    // held-modifier wait, the focus IPC and the bounded clipboard read can take a second, and in a
    // live or latch session the user is expected to be moving between windows. Clicking our own
    // window in that gap landed the keys in the app's own settings/dictionary fields — and on the
    // paste path the clipboard was clobbered first, regardless.
    //
    // The per-app re-check below CANNOT stand in for this. `focused_app_now` (and `win_focus`'s
    // twin) classify our own window as noise and fall back to `last_other`, so they report the
    // PREVIOUS app — which still matches `expect_app_id`, so the mismatch arm never fires. Only
    // the authoritative webview-focus check sees it, so re-run exactly that.
    //
    // `return Ok(())`, deliberately NOT a degrade to "clipboard": the entry guard was moved above
    // the clipboard-only branch precisely so our own window holding focus can never clobber the
    // user's clipboard for an insert they cannot see land. Skipping is safe — `streaming.ts`
    // leaves `injectedText` un-advanced on a skip, so the text goes out with the next insert.
    if app
        .webview_windows()
        .iter()
        .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
    {
        tracing::info!("[inject] skipped at the sink: our own window took focus mid-injection");
        return Ok(InjectOutcome { landed: false, diverted: false });
    }
    // Consumed UNCONDITIONALLY (no `!modifiers_stuck &&` short-circuit): a latch left armed by a
    // true positive would divert the NEXT, legitimate injection too. Guarded on `!text.is_empty()`
    // so the bare auto-Enter insert — which carries no transcript and cannot be typed into a chord
    // harmfully — does not steal the latch from the transcript insert that follows it. And placed
    // BELOW the own-window sink skip, so an injection that is going to write nothing and be re-sent
    // does not destroy the latch the re-send needs.
    //
    // The TTL covers manufactured-stop → the server returning a final → here, and the SERVER owns
    // the middle leg. Sized against the LONGEST such leg — the batch POST's 120s client timeout,
    // NOT the stream-only stuck-finalize watchdog this once cited; see HELD_CHORD_LATCH_TTL. A
    // tighter bound would let a slow — or deliberately stalling — server walk its transcript
    // straight past this control, which is a one-line bypass by the actor the control defends
    // against.
    if !text.is_empty() {
        let chord_lost = crate::held_keys::take_lost_if_fresh(HELD_CHORD_LATCH_TTL);
        if chord_lost && !modifiers_stuck {
            tracing::warn!(
                "[inject] a stop was manufactured for a still-held chord — clipboard only"
            );
        }
        modifiers_stuck = modifiers_stuck || chord_lost;
    }
    // The per-app rule — including "never type into this app" — was resolved against the window
    // focused when this insert was QUEUED, and getting here takes real time: a focus IPC, up to
    // 400ms of clipboard read, and the 500ms modifier wait just above. In a live or latch session
    // the user is expected to be switching windows, so the window that receives the keys may not
    // be the one the decision was made for. Re-check now, at the sink.
    //
    // A mismatch degrades to clipboard-only — the same treatment a blocked or non-editable target
    // already gets, so the text is preserved and nothing is typed into a window whose rule we
    // never evaluated. An UNIDENTIFIED window still falls through unchanged: that is the
    // deliberate fail-open behaviour, and a cold a11y bridge hits it routinely.
    let method = if modifiers_stuck { "clipboard".to_string() } else { method };
    // ONE focus read, used for both decisions below. `remote_target` used to be resolved at the
    // top of this function and acted on here — the same decided-at-T, applied-at-T+n shape the
    // per-app re-check exists to fix, on the control immediately beside it. Focus leaving a
    // remote-desktop client meanwhile left it true and the clipboard was never restored; focus
    // entering one left it false, giving the paste the 60ms local settle instead of 300ms AND
    // scheduling a restore — reproducing the delayed-rendering failure described above, where the
    // remote's deferred fetch pastes the RESTORED value.
    let focused_now = crate::atspi_guard::focused_app_now(guard.inner());
    let method = match (&expect_app_id, &focused_now) {
        (Some(expected), Some(now)) if !now.app_id.eq_ignore_ascii_case(expected) => {
            tracing::warn!(
                "[inject] focus moved {} → {} after the rule was resolved — clipboard only",
                expected,
                now.app_id
            );
            "clipboard".to_string()
        }
        _ => method,
    };
    if method == "clipboard" {
        // Unlike the clipboard-only block at the top of this function, THIS one is reachable only
        // by the two mid-function DIVERSIONS above — `modifiers_stuck` and the focus mismatch —
        // so it sits at the far end of the held-modifier wait, which the `modifiers_stuck` arm has
        // by construction run to its full 500ms. A cancel landing in that window used to write the
        // transcript out anyway, as a live persistent clipboard owner, clobbering whatever the user
        // had copied — the exact thing `cancel_injection`'s contract forbids and the Wayland paste
        // path was fixed for.
        //
        // `cancel_wants_recovery` is NOT redundant here: an error abort (a died session) reaches
        // this branch through the same race, and it DOES want its text recovered. Because this is
        // an early `return`, it never reaches the recovery block at the end of the function, so
        // falling through and letting the write happen is what reproduces that recovery.
        if crate::inject::injection_cancelled(epoch) && !crate::inject::cancel_wants_recovery(epoch)
        {
            tracing::info!("[inject] diverted to clipboard, but cancelled first — skipping");
            return Ok(InjectOutcome { landed: true, diverted: false });
        }
        if !text.is_empty() {
            // The divert the ledger's D1 named as the data-loss path: on `landed: true` the
            // caller advances its baseline and the phrase leaves the re-send stream for good.
            // Nothing has been typed on this arm either, so `false` is both truthful and safe.
            if let Err(e) = crate::inject::set_clipboard_persistent(&text) {
                tracing::warn!("[inject] divert to clipboard failed: {e}");
                return Ok(InjectOutcome { landed: false, diverted: false });
            }
        }
        // The one site that reports a DIVERT: the caller asked to type or paste and we did neither.
        return Ok(InjectOutcome { landed: true, diverted: true });
    }
    // Now that the method is final and focus has been read once, at the sink.
    let remote_target = method != "direct"
        && match &focused_now {
            Some(f) if crate::inject::is_remote_desktop_app(&f.app_id) => {
                tracing::info!(
                    "[inject] remote-desktop target ({}) — longer clipboard settle, restore skipped",
                    f.app_id
                );
                true
            }
            _ => false,
        };

    // Kept for the error-abort recovery below: the X11 branch moves `text` into spawn_blocking.
    let recovery_text = text.clone();
    // The probe the two typing backends re-ask focus with. Built once here so `virtual_keyboard`
    // (served by a bare `std::thread`, no `AppHandle`) and `inject` (served by the blocking pool)
    // take the same predicate the entry guard above uses.
    let probe_app = app.clone();
    let own_window_focused = move || {
        probe_app
            .webview_windows()
            .iter()
            .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
    };
    let res = if crate::inject::is_wayland() {
        // Each Wayland arm now reports its own `Landed`, like the X11 arm below: the two TYPING
        // arms (bare auto-Enter via the portal, and `direct` via the virtual keyboard) were the
        // last sinks in the tree with no own-window re-check, so they could not previously say
        // anything but "landed". Their guards live inside the backends, at the keystroke, because
        // that is the far side of the widest guard-to-sink gap on any path.
        let wayland_res: Result<crate::inject::Landed, String> = if text.is_empty() && auto_enter && method != "direct" {
            // Auto-enter with no text on the PASTE path (the per-phrase / tail Enter): press Enter
            // WITHOUT touching the clipboard — paste would set_clipboard("") and clobber it, so route
            // the bare Enter through the portal type path instead. (Direct falls through to the VK-first
            // branch below: VK type_text("", true) cleanly types Return — and on KWin, where VK is
            // unavailable, it falls back to this same portal path — so the per-phrase Enter takes the
            // SAME silent VK route the phrase's words did instead of forcing a portal consent prompt.)
            crate::wayland_inject::type_text(&app, typer.inner(), "", true, epoch).await
        } else if method == "direct" {
            // Prefer the virtual keyboard (Caps Lock-/layout-correct typing). Fall back
            // to the portal keycode path when the protocol is unavailable (e.g. GNOME)
            // or a job fails.
            let vk_probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
                std::sync::Arc::new(own_window_focused.clone());
            match crate::virtual_keyboard::type_text(vkbd.inner(), &text, auto_enter, epoch, vk_probe).await {
                Ok(landed) => {
                    tracing::info!("[inject] typed via virtual keyboard");
                    Ok(landed)
                }
                // Fall back to the portal ONLY when the VK failed before transmitting any key (protocol
                // unavailable, keymap upload failed). A mid-typing failure already landed a prefix, so
                // re-typing the whole text via the portal would duplicate it — surface the error instead.
                Err(e) if !e.after_typing => {
                    tracing::warn!("[inject] virtual keyboard unavailable ({}); using portal", e.message);
                    crate::wayland_inject::type_text(&app, typer.inner(), &text, auto_enter, epoch).await
                }
                Err(e) => {
                    tracing::error!("[inject] virtual keyboard failed mid-typing ({}); not re-typing via portal (would duplicate the landed prefix)", e.message);
                    Err(e.message)
                }
            }
        } else {
            // Paste on Wayland: set the clipboard here, then synthesize Ctrl+V via
            // the portal. enigo's XTEST Ctrl+V is unreliable on KDE Wayland — a
            // synthesized modifier + remapped keycode makes apps fire the wrong
            // shortcut (e.g. opening editor tabs) instead of pasting.
            let clip = text.clone();
            // Capture the user's prior clipboard TIME-BOUNDED, mirroring begin_injection /
            // read_primary_now: reading the clipboard is a blocking Wayland round-trip that can hang
            // indefinitely on a dead clipboard owner, and it previously sat (inside set_clipboard) in an
            // UN-timed spawn_blocking here — so the end-of-session insert (the restoreClipboard:true
            // caller) could wedge at "injecting" forever (the stuck-finalize watchdog is stream-only).
            // Read prev separately (400ms cap; None on timeout → skip the restore), then set the
            // clipboard so the set_text still lands regardless of the prev-read result.
            // remote_target skips the capture entirely — see its resolution above.
            let prev = if restore_clipboard && !remote_target {
                match read_selection_bounded(|| arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok())).await {
                    None => {
                        tracing::info!("[clip] paste: prev-clipboard read empty/timeout — skipping restore");
                        None
                    }
                    // Never adopt OUR OWN last transcript as "the user's previous clipboard" —
                    // it lingers after a failed/skipped restore, and restoring it would resurrect
                    // stale dictation on every future paste (mirrors the Windows/X11 paste guard).
                    Some(t) if crate::inject::is_own_injected(&t) => {
                        tracing::info!("[clip] paste: prior clipboard is our own transcript — skipping restore");
                        None
                    }
                    some => some,
                }
            } else {
                None
            };
            // `inject::inject`'s own paste path checks the epoch BEFORE it touches the clipboard
            // (see the `RECOVER_AT_EPOCH` note: a user cancel means "I don't want this", and
            // putting it on the clipboard anyway clobbers whatever they had copied). This Wayland
            // twin sits at the end of the same ~0.5-1.2s window — the held-modifier wait, the focus
            // read, the bounded prev-clipboard read — and carried no such check, so a cancel
            // landing anywhere in it still wrote the transcript out.
            //
            // The `cancel_wants_recovery` term is load-bearing, and its absence was a bug in this
            // check as first written: the justification given was "the error-abort recovery block
            // below keys off `res`, which this branch never produces", but that block keys off
            // `injection_cancelled && cancel_wants_recovery && !recovery_text.is_empty()` — never
            // `res` — and this is an early `return`, so it skipped the block entirely and a died
            // session lost its transcript instead of leaving it recoverable.
            if crate::inject::injection_cancelled(epoch) && !crate::inject::cancel_wants_recovery(epoch)
            {
                tracing::info!("[clip] paste: cancelled before the clipboard write — skipping");
                return Ok(InjectOutcome { landed: true, diverted: false });
            }
            // Own-window re-check, at the sink rather than at the top of the function. The guard
            // that decides "our own window took focus" runs ~0.5s earlier: the latch consume, a
            // focus IPC, up to 400ms of bounded prev-clipboard read and the settle all sit between
            // it and this write. Without this, a focus change inside that window clobbers the
            // user's clipboard and then fires Ctrl+V into one of our own windows — the exact
            // outcome the entry guard was moved above the clipboard-only branch to prevent.
            //
            // `landed: false` is the truthful answer: nothing has been written yet (`prev` was only
            // READ), so the caller re-sends and no text is duplicated. This does not strand the
            // held-chord latch — if it had been armed, `method` would already be "clipboard" and
            // this branch is unreachable.
            if app
                .webview_windows()
                .iter()
                .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
            {
                tracing::info!("[inject] skipped at the clipboard write: our own window took focus");
                // An early `return` here would skip the error-abort recovery block at the end of
                // this function — the exact defect P4 recorded for the cancel check above, which
                // cost a died session its transcript. The two states are not exclusive: the cancel
                // arm only returns when `!cancel_wants_recovery`, so an ERROR abort reaches here.
                if crate::inject::injection_cancelled(epoch)
                    && crate::inject::cancel_wants_recovery(epoch)
                    && !recovery_text.is_empty()
                {
                    // Arm the session-restore guard ONLY if the recovery actually landed. Arming
                    // it on a failed write would suppress the restore of the user's own clipboard
                    // to protect a transcript that is not there — losing both.
                    if let Err(e) = crate::inject::set_clipboard_persistent(&recovery_text) {
                        tracing::warn!("[inject] recovery to clipboard failed at the write guard: {e}");
                        return Ok(InjectOutcome { landed: false, diverted: false });
                    }
                    // The SECOND recovery write, and it needs the same session-restore guard as
                    // the one at the end of this function — this early `return` is precisely why
                    // (the block that arms it never evaluates). The two preconditions co-occur
                    // naturally: the error teardown refocuses our own window, which is what makes
                    // this guard fire in the first place.
                    crate::inject::note_recovery_on_clipboard();
                    return Ok(InjectOutcome { landed: true, diverted: true });
                }
                return Ok(InjectOutcome { landed: false, diverted: false });
            }
            let set_res = tokio::task::spawn_blocking(move || crate::inject::set_clipboard(&clip))
                .await
                .map_err(|e| e.to_string())?;
            set_res?; // propagate a set_text failure; prev was captured (time-bounded) above
            // Longer settle for a remote-desktop target (content must cross the network first).
            tokio::time::sleep(std::time::Duration::from_millis(if remote_target { 300 } else { 60 })).await;
            // And again after the settle, before the chord. The check above guards the clipboard
            // WRITE; this one guards the KEYSTROKE, and 60ms (300ms remote) of wall clock separates
            // them — the same gap `inject::paste` re-asks the epoch across on the other platform.
            // `diverted: true`, not `landed: false`: the transcript IS on the clipboard by now, so
            // that is the truthful answer, and the restore below must be skipped so it stays
            // pasteable.
            if app
                .webview_windows()
                .iter()
                .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
            {
                tracing::info!("[inject] skipped at the paste chord: our own window took focus");
                // Re-set through the PERSISTENT owner first. The write above used the plain
                // `set_clipboard`, which does not stick on Wayland once the setter returns — so
                // reporting the divert without this promises a clipboard that no longer holds the
                // text, and the caller has already advanced past that phrase. Same rule the X11
                // twin follows at its own chord guard.
                // With an answer available, the comment above becomes enforceable rather than
                // aspirational: if the persistent re-set fails, the plain `set_clipboard` above is
                // exactly the write that does not stick, so promising a divert would be the false
                // confirmation this arm was added to avoid. No chord was pressed, so the caller's
                // re-send is safe.
                if let Err(e) = crate::inject::set_clipboard_persistent(&text) {
                    tracing::warn!("[inject] divert at the paste chord failed: {e}");
                    return Ok(InjectOutcome { landed: false, diverted: false });
                }
                return Ok(InjectOutcome { landed: true, diverted: true });
            }
            let r = crate::wayland_inject::paste(&app, typer.inner(), paste_shortcut, auto_enter, epoch).await;
            // Restore the user's prior clipboard only if the paste actually landed. If it failed,
            // leave the transcript on the clipboard so it's recoverable (the user can paste it
            // manually) instead of silently clobbering it with the old clipboard.
            //
            // `r.is_ok()` is not the same question as "did it press anything": the portal job also
            // returns `Ok(())` when ITS pre-job check finds the epoch cancelled. On an ERROR abort
            // that matters, because the recovery block at the end of this function is about to put
            // the transcript on the clipboard — and this restore, which serves `prev` 400ms later,
            // would erase it, leaving the text neither typed nor recoverable. A plain user cancel
            // still restores: there the clobbered clipboard IS the thing to put back.
            if r.is_ok()
                && !(crate::inject::injection_cancelled(epoch)
                    && crate::inject::cancel_wants_recovery(epoch))
            {
                crate::inject::restore_clipboard_later(prev);
            }
            r
        };
        wayland_res
    } else {
        // The X11/Windows twin of the two Wayland sink guards above. This arm hands off to the
        // blocking pool, and everything past that point — `Enigo::new`, `Clipboard::new`, an
        // un-timed blocking clipboard read, the settle — happens after the guard that ran before
        // the dispatch, so it needs to re-ask at its own sinks. Passing a probe rather than the
        // handle keeps `inject.rs` Tauri-free; it is safe from the blocking pool because Tauri's
        // `is_focused` posts to the event loop and waits on a channel, so the toolkit call runs on
        // the main thread whichever thread asks. No deadlock: this command runs on the async
        // runtime, so the main thread is never waiting on us.
        let probe_app = app.clone();
        tokio::task::spawn_blocking(move || {
            let own_window_focused = move || {
                probe_app
                    .webview_windows()
                    .iter()
                    .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
            };
            crate::inject::inject(
                &text,
                &method,
                auto_enter,
                restore_clipboard,
                &paste_shortcut,
                remote_target,
                epoch,
                &own_window_focused,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    // If a DIED session (not a user cancel) cut this injection short, the text stopped somewhere
    // mid-sentence and the window it was going into has already been refocused by the teardown.
    // Leave the transcript on the clipboard so it is recoverable — the same courtesy the
    // stop-mode path extends. A user-initiated cancel deliberately does not land here.
    let mut recovered = crate::inject::injection_cancelled(epoch)
        && crate::inject::cancel_wants_recovery(epoch)
        && !recovery_text.is_empty();
    if recovered {
        // `recovered` is what upgrades `NothingWritten` to `landed: true, diverted: true` below,
        // i.e. the claim "the text IS somewhere the user can reach". Now that the write can say
        // otherwise, that claim follows the write instead of assuming it: on failure the outcome
        // falls back to plain `NothingWritten`, which is truthful and safe — this arm is reached
        // only when no key was transmitted.
        match crate::inject::set_clipboard_persistent(&recovery_text) {
            Ok(()) => {
                tracing::info!(
                    "[inject] aborted by a failed session — transcript left on the clipboard"
                );
                // Tell the SESSION-level restore not to serve the user's old clipboard over the
                // top. The per-paste restore above already declines on this condition;
                // `end_injection` runs after this job is gone and cannot ask the same question by
                // epoch. Armed only on success, so a failed recovery does not suppress the
                // restore of the clipboard the user actually still has.
                crate::inject::note_recovery_on_clipboard();
            }
            Err(e) => {
                tracing::warn!("[inject] aborted by a failed session, and the clipboard recovery failed too: {e}");
                recovered = false;
            }
        }
    }
    res.map(|landed| match landed {
        crate::inject::Landed::Yes => InjectOutcome { landed: true, diverted: false },
        // "Nothing written" is only true if the recovery block above did not just write the
        // transcript to the clipboard. When it did, the text IS somewhere the user can reach, and
        // saying otherwise both mis-describes the state and makes the caller re-issue an insert
        // that would land in the same place. This is also what the Wayland arm reports for the
        // same event, so the two platforms now answer the same question the same way.
        crate::inject::Landed::NothingWritten if recovered => {
            InjectOutcome { landed: true, diverted: true }
        }
        crate::inject::Landed::NothingWritten => InjectOutcome { landed: false, diverted: false },
        crate::inject::Landed::OnClipboard => InjectOutcome { landed: true, diverted: true },
    })
}
