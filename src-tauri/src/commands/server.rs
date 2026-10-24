//! Server queries outside a run: connection test, capabilities, presets, decode
//! defaults, pipeline rules, recent words and usage stats (plus the on-disk
//! usage-outcome queue).

use super::{resolve_key_async, store_io};
use crate::transport;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn test_connection(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::ConnectionInfo {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::discovery::test_connection(&server_url, key.as_deref()).await
}

/// List the server's selectable override-profile names (for the per-Backend /
/// per-Profile picker). Best-effort — returns [] on any error.
#[tauri::command]
pub async fn list_override_profiles(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> Vec<String> {
    let key = resolve_key_async(api_key, backend_id).await;
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
    let key = resolve_key_async(api_key, backend_id).await;
    transport::discovery::get_capabilities(&server_url, key.as_deref()).await
}

/// Ask the server to start warming the models a job will need
/// (`POST /v1/models/preload`). Returns a plain bool rather than a Result: this
/// is fired from timers and effects with no user-visible outcome, and a Result
/// would let an IPC-level failure surface as an unhandled promise rejection.
#[tauri::command]
pub async fn preload_models(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    models: Vec<transport::preload::PreloadModel>,
    override_profile: Option<String>,
) -> bool {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::preload::preload_models(
        &server_url,
        key.as_deref(),
        models,
        override_profile.as_deref(),
    )
    .await
}

/// The decode values the caller inherits from the server for one model and override profile
/// (`GET /v1/request-default-settings`) — the "Inherit · <value>" labels. Best-effort — null on error.
#[tauri::command]
pub async fn get_decode_defaults(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    override_profile: Option<String>,
) -> Option<transport::DecodeDefaults> {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::discovery::get_decode_defaults(
        &server_url,
        &model,
        override_profile.as_deref(),
        key.as_deref(),
    )
    .await
}

/// The post-processing (pipeline) rules the caller may view + edit
/// (`GET /v1/pipeline-rules`) — for the Dictionary screen. Structured result so
/// the UI can distinguish standard-server (404) / unauthorized (401) / no-access
/// (403) / parse errors from a real rule list.
#[tauri::command]
pub async fn get_pipeline_rules(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::pipeline::PipelineFetch {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::pipeline::get_pipeline_rules(&server_url, key.as_deref()).await
}

/// Apply a per-rule patch (`PATCH /v1/pipeline-rules`). `patch` is the
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
    let key = resolve_key_async(api_key, backend_id).await;
    transport::pipeline::save_pipeline_rules(&server_url, key.as_deref(), patch).await
}

/// Recently-transcribed word/phrase suggestions for the Dictionary's
/// spoken-symbol key field (`GET /v1/recent-words`). Best-effort — returns an
/// empty list on any failure (old/standard server, unreachable) so the editor
/// degrades to a plain input.
#[tauri::command]
pub async fn get_recent_words(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::pipeline::RecentWords {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::pipeline::get_recent_words(&server_url, key.as_deref()).await
}

/// The caller's own usage document (`GET /v1/usage`) for the Home strip, the Statistics page
/// and the optional chip readout. Best-effort — null on any error so the UI hides the feature
/// on a standard/old server or when unreachable. `query.tz` is the caller's IANA zone so the
/// server reckons days (and DST) the way the viewer does.
#[tauri::command]
pub async fn get_usage_stats(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    query: transport::discovery::UsageQuery,
) -> Option<transport::UsageStats> {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::discovery::get_usage_stats(&server_url, key.as_deref(), &query).await
}

/// Report end-of-dictation outcomes (`POST /v1/usage/outcome`). Structured result
/// (never throws) so the TS queue can tell retry-later (0 / 5xx / 408 / 429 / 401 / 403)
/// from drop-it (other 4xx) — see lib/usageOutcome.ts.
#[tauri::command]
pub async fn post_usage_outcomes(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    outcomes: Vec<transport::usage::UsageOutcome>,
) -> transport::usage::UsageOutcomePost {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::usage::post_usage_outcomes(&server_url, key.as_deref(), outcomes).await
}

/// The on-disk outcome queue (`<app_data_dir>/usage-outcomes.json`): outcomes that could
/// not be posted yet (server down mid-session) survive a restart here. Opaque JSON to
/// Rust; the queue logic lives in TS.
/// `Err` when the file exists but can't be read — the webview then must not save over it.
/// Off the main thread, one call at a time: see `store_io`.
#[tauri::command]
pub async fn load_usage_outcomes(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Ok(None);
    };
    store_io(&USAGE_QUEUE_TURN, move || {
        crate::store::usage_queue::load(&dir)
            .map_err(|e| format!("usage outcome queue unreadable: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn save_usage_outcomes(app: AppHandle, queue: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    store_io(&USAGE_QUEUE_TURN, move || {
        crate::store::usage_queue::save(&dir, &queue).map_err(|e| e.to_string())
    })
    .await
}

static USAGE_QUEUE_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
