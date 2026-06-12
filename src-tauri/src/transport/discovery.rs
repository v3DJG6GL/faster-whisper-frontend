//! Connection test + model discovery against `/v1/models` and `/auth/whoami`.

use super::{base_url, client, with_auth, ConnectionInfo, ServerModel};
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
                    error: Some("Unauthorized — an API key is required or the key is invalid.".into()),
                };
            }
            if !status.is_success() {
                return ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
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
                    error: None,
                },
                Err(e) => ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    error: Some(format!("Unexpected /v1/models response: {e}")),
                },
            }
        }
        Err(e) => ConnectionInfo {
            ok: false,
            open_mode,
            username,
            models: vec![],
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
