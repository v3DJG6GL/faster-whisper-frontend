//! Connection test + model discovery against `/v1/models` and `/auth/whoami`.

use super::{
    base_url, client, friendly_err, get_json, with_auth, Capabilities, ConnectionInfo,
    ResolvedOverrideProfile, ServerModel, UsageStats,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct WhoAmI {
    #[serde(default)]
    open_mode: bool,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResp {
    #[serde(default)]
    data: Vec<ModelObj>,
    /// Non-standard per-process marker emitted by faster-whisper-backend. Its mere
    /// presence is our signal that this is the full backend (vs a conventional
    /// OpenAI-compatible Whisper server, which never sends it).
    #[serde(default)]
    boot_id: Option<String>,
    /// Non-standard build version (faster-whisper-backend ≥ v0.1.0), e.g.
    /// "v0.1.0-3-g1a2b3c4". Older builds send boot_id but not this.
    #[serde(default)]
    server_version: Option<String>,
}

#[derive(Deserialize)]
struct ModelObj {
    id: String,
    #[serde(default)]
    loaded: bool,
}

/// Probe a server: list its models and resolve auth state. Never errors — failures
/// are reported in `ConnectionInfo { ok: false, error }` so the UI can show them.
pub async fn test_connection(server_url: &str, api_key: Option<&str>) -> ConnectionInfo {
    let base = base_url(server_url);
    let http = client();

    // /auth/whoami is best-effort (open-mode banner / username); ignore its failures.
    let (mut open_mode, mut username) = (false, None);
    if let Ok(resp) = with_auth(http.get(format!("{base}/auth/whoami")), api_key).send().await {
        if let Ok(who) = resp.json::<WhoAmI>().await {
            open_mode = who.open_mode;
            username = who.username;
        }
    }

    // /v1/models is the actual connectivity gate.
    match with_auth(http.get(format!("{base}/v1/models")), api_key).send().await {
        Ok(resp) => {
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
                    server_version: None,
                    error: Some("Unauthorized — an API key is required or the key is invalid.".into()),
                };
            }
            if !status.is_success() {
                return ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
                    server_version: None,
                    error: Some(format!("Server returned HTTP {}.", status.as_u16())),
                };
            }
            match resp.json::<ModelsResp>().await {
                Ok(parsed) => ConnectionInfo {
                    ok: true,
                    open_mode,
                    username,
                    models: parsed
                        .data
                        .into_iter()
                        .map(|m| ServerModel { id: m.id, loaded: m.loaded })
                        .collect(),
                    boot_id: parsed.boot_id,
                    server_version: parsed.server_version,
                    error: None,
                },
                Err(e) => ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
                    server_version: None,
                    error: Some(format!("Unexpected /v1/models response: {e}")),
                },
            }
        }
        Err(e) => ConnectionInfo {
            ok: false,
            open_mode,
            username,
            models: vec![],
            boot_id: None,
            server_version: None,
            error: Some(friendly_err(&e)),
        },
    }
}

#[derive(Deserialize)]
struct OverrideProfilesResp {
    #[serde(default)]
    profiles: Vec<String>,
}

/// Names of the server-side override-profiles a client may reference (the full
/// faster-whisper-backend's `GET /v1/override-profiles`). Best-effort: any error
/// (endpoint absent, unauthorized, unreachable, feature gated off) → empty list,
/// so the picker falls back to free-text entry.
pub async fn list_override_profiles(server_url: &str, api_key: Option<&str>) -> Vec<String> {
    let base = base_url(server_url);
    let url = format!("{base}/v1/override-profiles");
    // Best-effort: get_json → None on any failure, so the picker falls back to free-text.
    get_json::<OverrideProfilesResp>(url, api_key).await.map(|r| r.profiles).unwrap_or_default()
}

/// The caller's effective request-override capabilities (`GET /v1/me`, full
/// backend only). Best-effort: any error (endpoint absent, unauthorized,
/// unreachable) → None, which the UI treats as "unknown ⇒ assume permitted"
/// (never gate a knob we can't prove is unsupported).
pub async fn get_capabilities(server_url: &str, api_key: Option<&str>) -> Option<Capabilities> {
    let base = base_url(server_url);
    get_json(format!("{base}/v1/me"), api_key).await
}

/// The caller's own usage (`GET /v1/usage`, full backend only): today + total
/// + a self-scoped daily/weekly trend series. Best-effort: any error (endpoint
/// absent on a standard/old server, unauthorized, unreachable) → None, so the
/// UI simply hides the stats surfaces (Home section + chip line). Query params
/// are omitted when None so the server applies its own defaults.
pub async fn get_usage_stats(
    server_url: &str,
    api_key: Option<&str>,
    tz_midnight: Option<f64>,
    days: Option<i64>,
    bucket: Option<&str>,
) -> Option<UsageStats> {
    let base = base_url(server_url);
    let mut q: Vec<String> = Vec::new();
    if let Some(tz) = tz_midnight {
        q.push(format!("tz_midnight={tz}"));
    }
    if let Some(d) = days {
        q.push(format!("days={d}"));
    }
    if let Some(b) = bucket {
        if !b.is_empty() {
            q.push(format!("bucket={b}"));
        }
    }
    let url = if q.is_empty() {
        format!("{base}/v1/usage")
    } else {
        format!("{base}/v1/usage?{}", q.join("&"))
    };
    get_json(url, api_key).await
}

/// A single override-profile's decode values + locked client keys
/// (`GET /v1/override-profiles/{name}`), for previewing inherited defaults.
/// Best-effort: any error (incl. 404 when the caller may not request it) → None.
pub async fn get_override_profile(
    server_url: &str,
    name: &str,
    api_key: Option<&str>,
) -> Option<ResolvedOverrideProfile> {
    // Enforce the slug invariant before interpolating `name` into the path: server profile
    // names are `[a-z0-9-_]`. A free-typed "custom name" that isn't one can't match a real
    // profile, and pasting it raw could escape the path (e.g. "../") or break URL parsing —
    // so a non-slug name is treated as "no such profile" (None), consistent with best-effort.
    if name.is_empty()
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let base = base_url(server_url);
    let url = format!("{base}/v1/override-profiles/{name}");
    get_json(url, api_key).await
}
