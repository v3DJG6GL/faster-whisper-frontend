//! HTTP transport to a faster-whisper / OpenAI-compatible backend.
//!
//! `discovery` resolves server capabilities (`/v1/models`, `/auth/whoami`);
//! `batch` does the multipart `POST /v1/audio/transcriptions`; `stream` is the
//! streaming WebSocket client; `pipeline` reads/writes the server's text rules.

use serde::{Deserialize, Serialize};
use std::time::Duration;

pub mod batch;
pub mod discovery;
pub mod pipeline;
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

// P11: capability + resolved-profile transport types (see commands/discovery).
/// The caller's effective request-override capabilities, from `GET /v1/me`.
/// snake_case (not camelCase) deliberately — it mirrors the backend contract
/// 1:1, like the `decode_overrides` keys, so it passes straight through both
/// the wire (deserialize) and the IPC boundary (serialize) with no remapping.
#[derive(Debug, Serialize, Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub can_request_override_profile: bool,
    #[serde(default)]
    pub can_request_decode_overrides: bool,
    /// `["*"]` = unrestricted (free choice from the names endpoint); else the
    /// explicit allowed names; `[]` = none.
    #[serde(default)]
    pub allowed_override_profiles: Vec<String>,
}

/// A single override-profile's decode-relevant values + locked client keys,
/// from `GET /v1/override-profiles/{name}` — for previewing inherited defaults.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedOverrideProfile {
    pub name: String,
    /// `{client_decode_key: value}` (e.g. `{"beam_size": 8}`); `temperature`
    /// may arrive as a string (the server stores it as a ladder).
    #[serde(default)]
    pub values: serde_json::Value,
    #[serde(default)]
    pub locked: Vec<String>,
    /// The profile's own DEFAULT_PROMPT, exposed separately (it is NOT a client
    /// decode key, so it never appears in `values`) so the editor can ghost it as
    /// the inherited "Vocabulary / prompt". `null` when the profile sets none.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub prompt_locked: bool,
}

// P28: per-user usage stats (`GET /v1/usage`). snake_case passthrough like
// Capabilities — mirrors the backend JSON 1:1 and reaches the TS side unchanged.
/// One usage bucket's counters (the four metrics the backend rolls up).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageTotals {
    #[serde(default)]
    pub requests: i64,
    #[serde(default)]
    pub errors: i64,
    #[serde(default)]
    pub words: i64,
    /// Seconds of audio (the client renders minutes/hours).
    #[serde(default)]
    pub audio_s: f64,
}

/// One point in the trend series — a server-local day (days-since-epoch) plus
/// that day's (or week's) summed counters.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageSeriesPoint {
    #[serde(default)]
    pub day: i64,
    #[serde(default)]
    pub requests: i64,
    #[serde(default)]
    pub errors: i64,
    #[serde(default)]
    pub words: i64,
    #[serde(default)]
    pub audio_s: f64,
}

/// Echo of the trend window the server applied (`days` 0 = lifetime).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageWindow {
    #[serde(default)]
    pub days: i64,
    #[serde(default)]
    pub bucket: String,
}

/// The caller's own usage: today + lifetime totals + a self-scoped trend series.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageStats {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub today: UsageTotals,
    #[serde(default)]
    pub total: UsageTotals,
    #[serde(default)]
    pub range: UsageWindow,
    #[serde(default)]
    pub series: Vec<UsageSeriesPoint>,
}

/// Trim a trailing slash so we can join `/v1/...` paths cleanly.
pub fn base_url(server_url: &str) -> String {
    server_url.trim().trim_end_matches('/').to_string()
}

pub fn client() -> reqwest::Client {
    // One process-wide client: a reqwest::Client owns the connection pool + TLS session cache,
    // so rebuilding it per request threw away keep-alive reuse and paid a fresh TCP/TLS handshake
    // on every call (incl. the 30s usage poll). The config is constant (no per-request timeout/
    // header), and clone is cheap (Arc inside) so callers still get an owned client sharing the pool.
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .user_agent(concat!("faster-whisper-frontend/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("failed to build reqwest client")
        })
        .clone()
}

/// A short, user-facing message for a request-level reqwest failure.
pub fn friendly_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Could not connect — is the server running and the URL correct?".into()
    } else if e.is_timeout() {
        "Timed out waiting for the server.".into()
    } else {
        e.to_string()
    }
}

/// Pull FastAPI's `detail` string from an error body, falling back to the raw text.
pub fn detail_from(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_else(|| body.to_string())
}

/// Attach a bearer token if one is provided.
pub fn with_auth(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    match api_key {
        Some(k) if !k.is_empty() => req.bearer_auth(k),
        _ => req,
    }
}

/// Best-effort `GET <url>` deserialized as `T`: any failure — transport error, non-2xx, or a body
/// that won't deserialize — collapses to `None`. The discovery probes (`/v1/me`, `/v1/usage`,
/// `/v1/override-profiles/{name}`) all treat an unreachable/absent/unauthorized endpoint this way.
pub async fn get_json<T: serde::de::DeserializeOwned>(url: String, api_key: Option<&str>) -> Option<T> {
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => resp.json::<T>().await.ok(),
        _ => None,
    }
}
