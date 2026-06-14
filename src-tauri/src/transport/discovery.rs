//! Connection test + model discovery against `/v1/models` and `/auth/whoami`.

use super::{
    base_url, client, with_auth, Capabilities, ConnectionInfo, ResolvedOverrideProfile, ServerModel,
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
                    error: None,
                },
                Err(e) => ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
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
            error: Some(friendly_err(&e)),
        },
    }
}

fn friendly_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Could not connect — is the server running and the URL correct?".into()
    } else if e.is_timeout() {
        "Timed out waiting for the server.".into()
    } else {
        e.to_string()
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
    match with_auth(client().get(format!("{base}/v1/override-profiles")), api_key).send().await {
        Ok(resp) if resp.status().is_success() => resp
            .json::<OverrideProfilesResp>()
            .await
            .map(|r| r.profiles)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The caller's effective request-override capabilities (`GET /v1/me`, full
/// backend only). Best-effort: any error (endpoint absent, unauthorized,
/// unreachable) → None, which the UI treats as "unknown ⇒ assume permitted"
/// (never gate a knob we can't prove is unsupported).
pub async fn get_capabilities(server_url: &str, api_key: Option<&str>) -> Option<Capabilities> {
    let base = base_url(server_url);
    match with_auth(client().get(format!("{base}/v1/me")), api_key).send().await {
        Ok(resp) if resp.status().is_success() => resp.json::<Capabilities>().await.ok(),
        _ => None,
    }
}

/// A single override-profile's decode values + locked client keys
/// (`GET /v1/override-profiles/{name}`), for previewing inherited defaults.
/// Best-effort: any error (incl. 404 when the caller may not request it) → None.
/// `name` is a `[a-z0-9-]` profile name, so it's URL-path safe as-is.
pub async fn get_override_profile(
    server_url: &str,
    name: &str,
    api_key: Option<&str>,
) -> Option<ResolvedOverrideProfile> {
    let base = base_url(server_url);
    let url = format!("{base}/v1/override-profiles/{name}");
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<ResolvedOverrideProfile>().await.ok()
        }
        _ => None,
    }
}
