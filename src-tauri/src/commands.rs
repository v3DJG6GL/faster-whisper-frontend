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
fn resolve_recordings_dir(app: &AppHandle, custom: Option<String>) -> Option<PathBuf> {
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create the folder: {e}"))?;
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
    Ok(())
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
) -> Result<transport::batch::BatchResult, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::transcribe(
        &server_url,
        key.as_deref(),
        &model,
        &language,
        prompt.as_deref(),
        decode_overrides.as_ref(),
        override_profile.as_deref(),
        &file_path,
    )
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
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
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
        for b in &parsed {
            if b.has_api_key && !secrets.contains_key(&b.id) {
                warnings.push(format!(
                    "\u{201c}{}\u{201d} uses an API key, but the file doesn't include it — re-enter the key after importing.",
                    b.name
                ));
            }
        }
        *list = serde_json::to_value(parsed).map_err(|e| e.to_string())?;
    }
    if let Some(list) = categories.get_mut("profiles").and_then(|p| p.get_mut("list")) {
        let parsed: Vec<config::Profile> = serde_json::from_value(list.clone())
            .map_err(|e| format!("The file's dictation profiles are invalid: {e}"))?;
        *list = serde_json::to_value(parsed).map_err(|e| e.to_string())?;
    }
    for bucket in ["linux", "windows"] {
        if let Some(rules) = categories.get("appRules").and_then(|r| r.get(bucket)) {
            if !rules.is_null() && !rules.is_array() {
                return Err("The file's app rules are invalid.".into());
            }
        }
    }
    for key in ["general", "recording"] {
        if let Some(v) = categories.get(key) {
            if !v.is_null() && !v.is_object() {
                return Err(format!("The file's {key} settings are invalid."));
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
        drop(sess); // Drop (not finish) runs OUTSIDE the lock — the guard released on the line above
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
        let sess = state.0.lock().map_err(|_| "record state poisoned".to_string())?.take();
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
        let sess = state.0.lock().map_err(|_| "record state poisoned".to_string())?.take();
        drop(sess); // Drop (not finish) runs OUTSIDE the lock — no transcription POST, releases the mute
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
    let quick_add = &cfg.settings.general.quick_add_hotkey;
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
    let prev = snap.0.lock().ok().and_then(|mut g| g.take());
    if let Some(prev) = prev {
        // Remote-desktop target: skip the restore (same contract as the per-paste path) — the
        // restored value can be what the remote's still-pending paste fetches. The snapshot is
        // already consumed above, so it can't leak into a later session either way.
        if focused_remote_target(guard.inner()) {
            tracing::info!("[clip] end_injection: remote-desktop target — restore skipped");
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
    stash: State<'_, crate::quickadd::SeedStash>,
) -> Result<Option<String>, String> {
    // Windows: no AT-SPI / PRIMARY — the seed was grabbed BEFORE the window took focus
    // (quickadd::show → win_seed copy-chord + clipboard diff) and stashed; serve (and
    // consume) it here. Same sanitizer as the Linux paths.
    #[cfg(windows)]
    {
        let _ = &guard;
        let raw = stash.0.lock().ok().and_then(|mut s| s.take());
        let seed = raw.as_deref().and_then(sanitize_seed);
        tracing::info!(
            "[quickadd-seed] windows copy grab {} chars -> seed {} chars",
            raw.as_deref().map_or(0, str::len),
            seed.as_deref().map_or(0, str::len)
        );
        return Ok(seed);
    }
    #[cfg(not(windows))]
    {
        let _ = &stash;
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
        let sel = tauri::async_runtime::spawn_blocking(move || crate::quickadd::win_seed::grab(&app))
            .await
            .ok()
            .flatten();
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
            SelRead::Text(s) => Some(s),
            SelRead::Opaque => read_primary_now().await,
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
) -> Result<(), String> {
    // Strip control characters (except Tab/LF; CR is normalized to LF) from the server-transcribed
    // text before it reaches ANY injection path — clipboard-only, Wayland paste, or X11 paste/direct
    // — so a malicious/garbled server can't smuggle terminal-escape sequences onto the clipboard or
    // into a paste. (The Wayland direct-typing paths already drop controls; this matches them.)
    let text = crate::inject::sanitize_injected(&text);
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
        return Ok(());
    }
    // Clipboard-only: put the text on the clipboard and inject NO keystrokes, so it can't
    // fire actions in the wrong window — the user pastes it themselves. No modifier gate needed
    // since nothing is typed (the own-window guard above already ran).
    if method == "clipboard" {
        if !text.is_empty() {
            crate::inject::set_clipboard_persistent(&text);
        }
        return Ok(());
    }
    // Nothing to type and no Enter to send → bail before the keystroke paths. Without this, the
    // Wayland PASTE branch below would set_clipboard("") — clobbering the user's clipboard with an
    // empty string and firing a no-op Ctrl+V — whenever a phrase sanitizes to empty (the server
    // emitted only control chars). Mirrors the X11 inject::inject guard. (empty + auto_enter still
    // falls through below to send the bare Enter.)
    if text.is_empty() && !auto_enter {
        return Ok(());
    }
    // Pasting into a remote-desktop client (mstsc & co) needs different clipboard handling: the
    // local clipboard reaches the remote host ASYNCHRONOUSLY, so the paste gets a longer settle
    // before Ctrl+V (the new content must cross the network before the forwarded keystroke) and
    // NEVER restores the previous clipboard afterwards (with RDP delayed rendering, the restored
    // value can be what the remote's paste actually fetches — this is how a 7-minute-old
    // transcript once landed instead of the fresh one). Direct typing never touches the
    // clipboard, so it doesn't care.
    let remote_target = method != "direct"
        && match crate::atspi_guard::focused_app_now(guard.inner()) {
            Some(f) if crate::inject::is_remote_desktop_app(&f.app_id) => {
                tracing::info!(
                    "[inject] remote-desktop target ({}) — longer clipboard settle, restore skipped",
                    f.app_id
                );
                true
            }
            _ => false,
        };
    // Wait briefly for the trigger chord's shortcut modifiers (Ctrl/Alt/Meta) to be
    // physically released before typing — otherwise the injected keys fold into the
    // still-held modifier and fire shortcuts in the focused app (worst with a latch
    // stop, which triggers on the second chord press with every key still down). Only
    // the evdev backend can observe physical release on Wayland; when it isn't running
    // the held set is empty so this is a no-op. Capped so we never drop the text.
    {
        let held = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        if held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
                if std::time::Instant::now() >= deadline {
                    tracing::warn!("[inject] trigger modifiers still held after 500ms — injecting anyway");
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        }
    }
    let res = if crate::inject::is_wayland() {
        if text.is_empty() && auto_enter && method != "direct" {
            // Auto-enter with no text on the PASTE path (the per-phrase / tail Enter): press Enter
            // WITHOUT touching the clipboard — paste would set_clipboard("") and clobber it, so route
            // the bare Enter through the portal type path instead. (Direct falls through to the VK-first
            // branch below: VK type_text("", true) cleanly types Return — and on KWin, where VK is
            // unavailable, it falls back to this same portal path — so the per-phrase Enter takes the
            // SAME silent VK route the phrase's words did instead of forcing a portal consent prompt.)
            crate::wayland_inject::type_text(&app, typer.inner(), "", true).await
        } else if method == "direct" {
            // Prefer the virtual keyboard (Caps Lock-/layout-correct typing). Fall back
            // to the portal keycode path when the protocol is unavailable (e.g. GNOME)
            // or a job fails.
            match crate::virtual_keyboard::type_text(vkbd.inner(), &text, auto_enter).await {
                Ok(()) => {
                    tracing::info!("[inject] typed via virtual keyboard");
                    Ok(())
                }
                // Fall back to the portal ONLY when the VK failed before transmitting any key (protocol
                // unavailable, keymap upload failed). A mid-typing failure already landed a prefix, so
                // re-typing the whole text via the portal would duplicate it — surface the error instead.
                Err(e) if !e.after_typing => {
                    tracing::warn!("[inject] virtual keyboard unavailable ({}); using portal", e.message);
                    crate::wayland_inject::type_text(&app, typer.inner(), &text, auto_enter).await
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
            let set_res = tokio::task::spawn_blocking(move || crate::inject::set_clipboard(&clip))
                .await
                .map_err(|e| e.to_string())?;
            set_res?; // propagate a set_text failure; prev was captured (time-bounded) above
            // Longer settle for a remote-desktop target (content must cross the network first).
            tokio::time::sleep(std::time::Duration::from_millis(if remote_target { 300 } else { 60 })).await;
            let r = crate::wayland_inject::paste(&app, typer.inner(), paste_shortcut, auto_enter).await;
            // Restore the user's prior clipboard only if the paste actually landed. If it failed,
            // leave the transcript on the clipboard so it's recoverable (the user can paste it
            // manually) instead of silently clobbering it with the old clipboard.
            if r.is_ok() {
                crate::inject::restore_clipboard_later(prev);
            }
            r
        }
    } else {
        tokio::task::spawn_blocking(move || {
            crate::inject::inject(&text, &method, auto_enter, restore_clipboard, &paste_shortcut, remote_target)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    res
}
