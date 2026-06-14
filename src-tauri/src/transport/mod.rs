//! HTTP transport to a faster-whisper / OpenAI-compatible backend.
//!
//! `discovery` resolves server capabilities (`/v1/models`, `/auth/whoami`);
//! `batch` does the multipart `POST /v1/audio/transcriptions`. The streaming
//! WebSocket client lands in M3.

use serde::Serialize;
use std::time::Duration;

pub mod batch;
pub mod discovery;
pub mod stream;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerModel {
    pub id: String,
    pub loaded: bool,
}

/// Result of a connection test — mirrors the TS `ConnectionInfo`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub ok: bool,
    pub open_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub models: Vec<ServerModel>,
    /// The server's per-process `boot_id` from `/v1/models` (non-standard). Present
    /// ⇒ the full faster-whisper-backend; absent ⇒ a conventional Whisper server.
    /// The UI uses this to gate server-specific override knobs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Trim a trailing slash so we can join `/v1/...` paths cleanly.
pub fn base_url(server_url: &str) -> String {
    server_url.trim().trim_end_matches('/').to_string()
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("faster-whisper-frontend/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build reqwest client")
}

/// Attach a bearer token if one is provided.
pub fn with_auth(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    match api_key {
        Some(k) if !k.is_empty() => req.bearer_auth(k),
        _ => req,
    }
}
