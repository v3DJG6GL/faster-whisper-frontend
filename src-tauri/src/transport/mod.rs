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
pub mod sync;

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
    /// The server's build version from `/v1/models` (`server_version`, non-standard;
    /// emitted by faster-whisper-backend ≥ v0.1.0). Shown in the Detected chip;
    /// absent on standard servers and older backend builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
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
                // Never follow a redirect to a DIFFERENT host. reqwest strips `Authorization` on a
                // cross-host hop, but it does NOT strip the request BODY, and 307/308 replay method
                // + body verbatim to the `Location` host — and the sync push's body is the settings
                // blob, which carries `backends.secrets`, i.e. every backend's plaintext API key.
                // A hostile (or MITM'd — cleartext http is permitted) server answering the PUT with
                // a 308 would have that key set POSTed to a host of its choosing.
                //
                // Same-host hops still follow, so a server that redirects http→https or normalizes
                // a trailing slash keeps working; only the cross-host case is refused.
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let same_host = attempt.previous().last().and_then(|u| u.host_str())
                        == attempt.url().host_str();
                    if !same_host {
                        attempt.stop()
                    } else if attempt.previous().len() > 5 {
                        attempt.error("too many redirects")
                    } else {
                        attempt.follow()
                    }
                }))
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
///
/// Bounded HERE rather than at each call site: every caller surfaces the result to the UI or the
/// log, the fallback arm returns the WHOLE response body (32 MiB, see [`MAX_BODY`]), and only the
/// two `session.rs` sites had picked up [`bounded_server_text`]. The sync pull runs unattended at
/// startup and on every window focus, so a hostile server needed no user action to plant a
/// multi-megabyte, newline-bearing string in a `<Notice>` and in the log file.
pub fn detail_from(body: &str) -> String {
    let raw = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_else(|| body.to_string());
    bounded_server_text(&raw, MAX_ERROR_TEXT)
}

/// Attach a bearer token if one is provided.
pub fn with_auth(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    match api_key {
        Some(k) if !k.is_empty() => req.bearer_auth(k),
        _ => req,
    }
}

/// Hard ceiling on any response body we buffer in memory. reqwest has no built-in body limit, and
/// the only other bound is the request timeout — 3600s on the file-transcribe path, long enough for
/// a hostile server to stream tens of gigabytes into one allocation. 32 MiB is orders of magnitude
/// above any legitimate transcription or settings payload.
pub const MAX_BODY: usize = 32 * 1024 * 1024;

/// A server-supplied error string is surfaced in the UI and written to the log file users are
/// asked to attach to support reports. Same ceiling the streaming parse path uses.
pub const MAX_ERROR_TEXT: usize = 200;

/// Bound and defang a server-supplied string on its way to the UI or the log.
///
/// The streaming parse path caps its `error` frames at [`MAX_ERROR_TEXT`], but the BATCH sibling
/// formatted the transport error straight into the emitted message — and that error carries
/// `detail_from(&body)`, which falls back to the whole response body (bounded only by
/// [`MAX_BODY`]). Newlines are folded too, so a server cannot forge log records.
pub fn bounded_server_text(s: &str, n: usize) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    match cleaned.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &cleaned[..i]),
        None => cleaned,
    }
}

/// Buffer a response body, giving up once it passes [`MAX_BODY`] instead of growing without bound.
pub async fn body_capped(resp: reqwest::Response) -> Result<String, String> {
    if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err(TOO_LARGE.into());
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > MAX_BODY {
                    return Err(TOO_LARGE.into());
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(friendly_err(&e)),
        }
    }
    String::from_utf8(buf).map_err(|_| "The server sent a response that wasn't valid text.".into())
}

/// [`body_capped`] plus a JSON parse.
pub async fn json_capped<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, String> {
    let text = body_capped(resp).await?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

const TOO_LARGE: &str = "The server sent an unreasonably large response — ignoring it.";

/// Best-effort `GET <url>` deserialized as `T`: any failure — transport error, non-2xx, an
/// over-large body, or one that won't deserialize — collapses to `None`. The discovery probes
/// (`/v1/me`, `/v1/usage`, `/v1/override-profiles/{name}`) all treat an unreachable/absent/
/// unauthorized endpoint this way.
pub async fn get_json<T: serde::de::DeserializeOwned>(url: String, api_key: Option<&str>) -> Option<T> {
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => json_capped::<T>(resp).await.ok(),
        _ => None,
    }
}
