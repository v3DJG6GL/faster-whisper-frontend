//! Server queries outside a run: connection test, capabilities, presets, decode
//! defaults, pipeline rules, recent words and usage stats (plus the on-disk
//! usage-outcome queue).

use super::{resolve_key, resolve_key_async};
use crate::transport;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn test_connection(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::ConnectionInfo {
    let key = resolve_key(api_key, backend_id);
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
) -> bool {
    let key = resolve_key(api_key, backend_id);
    transport::preload::preload_models(&server_url, key.as_deref(), models).await
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

/// P28: the caller's own usage document (`GET /v1/usage`) — per-kind today/total, the
/// daily series, stages, dictation facets, apps, calendar and streak — for the Home strip,
/// the Statistics page and the optional chip readout. Best-effort — null on any error so
/// the UI hides the feature on a standard/old server or when unreachable. `tz` is the
/// caller's IANA zone so the server reckons days (and DST) the way the viewer does.
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
/// (never throws) so the TS queue can tell retry-later (0 / 5xx / 408 / 429) from
/// drop-it (other 4xx) — see lib/usageOutcome.ts.
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
#[tauri::command]
pub fn load_usage_outcomes(app: AppHandle) -> Option<serde_json::Value> {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| crate::store::usage_queue::load(&d))
}

#[tauri::command]
pub fn save_usage_outcomes(app: AppHandle, queue: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::store::usage_queue::save(&dir, &queue).map_err(|e| e.to_string())
}
