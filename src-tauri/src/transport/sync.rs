//! Client API for settings sync: `GET`/`PUT`/`DELETE /v1/synced-client-settings`.
//!
//! Like `pipeline.rs`, these return STRUCTURED results carrying the HTTP
//! status — the sync engine must distinguish an old backend without the
//! endpoint (404), unauthorized (401), unreachable (status 0), an empty
//! store (200 with `version: 0, blob: null`), and a version conflict (409,
//! whose body carries the CURRENT server state so the client can 3-way
//! merge without a second GET). Blobs pass through as opaque JSON — the
//! category shapes are typed on the TS side.
//!
//! The path was renamed from `/v1/client-settings`; a server from before the rename is reached
//! through [`super::with_legacy_path`].

use super::{
    base_url, body_capped_to, client, detail_from, friendly_err, with_auth, with_legacy_path,
    Answered,
};

/// The settings-sync resource, and its name before the rename (still served, deprecated).
const SYNC_PATH: &str = "/v1/synced-client-settings";
const LEGACY_SYNC_PATH: &str = "/v1/client-settings";

/// Status 0 = no answer (unreachable), as the sync outcomes already spell it.
fn answered(status: u16) -> Option<u16> {
    (status != 0).then_some(status)
}

impl Answered for SyncPull {
    fn answered(&self) -> Option<u16> {
        answered(self.status)
    }
}

impl Answered for SyncPush {
    fn answered(&self) -> Option<u16> {
        answered(self.status)
    }
}

impl Answered for SyncDelete {
    fn answered(&self) -> Option<u16> {
        answered(self.status)
    }
}
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Per-request override of the shared client's 120 s default (that default is
/// sized for transcription uploads). Sync payloads are bounded at 4 MB, and the
/// engine serializes on one in-flight request — a sync call left hanging on an
/// unreachable server (e.g. a LAN address away from home) blocks pulls/pushes
/// to a NEWLY selected server for the whole 120 s. Keep failures prompt.
const SYNC_TIMEOUT: Duration = Duration::from_secs(15);

/// Ceiling on a sync payload, inbound and (less [`SYNC_RESPONSE_MARGIN`]) outbound.
///
/// The other bounds on this data sit on CONSUMERS (`MAX_SYNCED_ENTRIES` = 500 entries per
/// category, the render caps, the per-field caps), never on the blob, which would otherwise take
/// the transcription-sized [`super::MAX_BODY`] (32 MiB). A sanitizer-passing blob of that size (500
/// backends × 60 KB prompt ≈ 29 MiB) costs ~1.5-2 s of main-thread block per pull, on a route that
/// runs UNATTENDED at startup and on every window focus, and is persisted to `sync-state.json` as
/// the 3-way merge base, re-read and re-hashed at every launch.
///
/// 4 MiB: the worst-case LEGITIMATE blob from those caps is ~1.5 MB (500 backends ≈750 KB + 500
/// profiles ≈500 KB + appRules ≈100 KB + secrets ≈50 KB), a typical one under 50 KB. 512 KB would
/// reject a real max-config user; 4 MiB keeps ~2.5x headroom.
///
/// Applied BEFORE the JSON parse, so an oversized payload fails as a transport error and is never
/// merged, never rendered, and never persisted.
pub const SYNC_MAX_BODY: usize = 4 * 1024 * 1024;

/// The GET (and PUT-200 / PUT-409) wire shape: `{version, blob, updated_ts,
/// device}`. `version: 0, blob: null` = nothing stored yet.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SyncRemoteState {
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub blob: serde_json::Value,
    #[serde(default)]
    pub updated_ts: Option<f64>,
    #[serde(default)]
    pub device: Option<String>,
}

impl SyncRemoteState {
    /// `device` is a server-supplied label rendered in the conflict dialog (as a Segmented option
    /// LABEL the user clicks), on the always-visible sync status line and on the restore consent
    /// card, so it is capped and defanged like its `username` / `boot_id` / `server_version`
    /// siblings — once, here, rather than at each render.
    fn bounded(mut self) -> Self {
        self.device = self
            .device
            .map(|d| super::bounded_server_text(&d, DEVICE_LABEL_MAX));
        self
    }

    /// Is `version` representable in JS? The frontend holds it as a double and PERSISTS it to
    /// sync-state.json, then hands it back as `base_version: i64` on the next push — so a value
    /// past 2^53 round-trips as something else and the `sync_push` invoke fails to deserialize
    /// before any Rust code runs, rejecting into a `void pushNow()` with no catch. The device
    /// then pulls forever and can never push again, and because the bad value is on disk it
    /// survives restarts.
    fn version_representable(&self) -> bool {
        // A range test, not `abs()`: `i64::MIN.abs()` overflows (a panic in debug, a wrap back
        // to i64::MIN in release — which then PASSES `<= MAX_SAFE_VERSION`).
        (-MAX_SAFE_VERSION..=MAX_SAFE_VERSION).contains(&self.version)
    }
}

/// `Number.MAX_SAFE_INTEGER`. A version counter starts at 1 and increments, so no real server
/// approaches this; anything beyond it is a server saying something the client cannot hold.
const MAX_SAFE_VERSION: i64 = 9_007_199_254_740_991;

/// Shown for an unrepresentable version on all three arms. Deliberately a transport FAILURE
/// rather than a clamp: adopting a different number than the server has would desync the base
/// version and make every later push a 409.
const VERSION_ERR: &str = "The server sent a settings version this app cannot represent.";

/// Parse and accept one server state body: version-checked, then bounded; a parse error is
/// prefixed with `what`. The ONE gate for all three response arms (pull, push 2xx, push 409), so
/// the version guard cannot go missing from one of them (see `version_representable`).
fn accept(text: &str, what: &str) -> Result<SyncRemoteState, String> {
    match serde_json::from_str::<SyncRemoteState>(text).map_err(|e| e.to_string()) {
        Ok(state) if state.version_representable() => Ok(state.bounded()),
        Ok(_) => Err(VERSION_ERR.into()),
        Err(e) => Err(format!(
            "{what}: {}",
            super::bounded_server_text(&e, super::MAX_ERROR_TEXT)
        )),
    }
}

/// A device label is a short human name ("mar's laptop"), never prose.
const DEVICE_LABEL_MAX: usize = 80;

/// GET outcome. `ok` ⇒ `state` is present; otherwise `status` + `error` say
/// why (0 = unreachable, 404 = backend build predates sync, 401 = key).
#[derive(Debug, Serialize, Default)]
pub struct SyncPull {
    pub ok: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<SyncRemoteState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// PUT outcome. `ok` ⇒ stored, `state` carries the new version. A 409 sets
/// `conflict` to the CURRENT server state (merge base for the retry loop).
#[derive(Debug, Serialize, Default)]
pub struct SyncPush {
    pub ok: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<SyncRemoteState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<SyncRemoteState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SyncPull {
    /// A failed pull: `status` 0 = no answer, else the HTTP status.
    fn failed(status: u16, error: String) -> Self {
        Self {
            status,
            error: Some(error),
            ..Default::default()
        }
    }
}

impl SyncPush {
    /// A failed push: no stored state, no conflict.
    fn failed(status: u16, error: String) -> Self {
        Self {
            status,
            error: Some(error),
            ..Default::default()
        }
    }
}

/// DELETE outcome (the "Delete server copy" button).
#[derive(Debug, Serialize, Default)]
pub struct SyncDelete {
    pub ok: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// GET /v1/synced-client-settings — the account's stored blob (or the zero-state).
pub async fn pull(server_url: &str, api_key: Option<&str>) -> SyncPull {
    let base = base_url(server_url);
    with_legacy_path(&base, SYNC_PATH, LEGACY_SYNC_PATH, |path| {
        pull_at(format!("{base}{path}"), api_key)
    })
    .await
}

async fn pull_at(url: String, api_key: Option<&str>) -> SyncPull {
    match with_auth(client().get(url), api_key)
        .timeout(SYNC_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                // Read the body apart from parsing it, as `push_at` does: a timeout or
                // oversized body is a transport failure, not a malformed reply, and must
                // not surface as "Unexpected response: Timed out…".
                let text = match body_capped_to(resp, SYNC_MAX_BODY).await {
                    Ok(b) => b,
                    Err(reason) => return SyncPull::failed(code, reason),
                };
                match accept(&text, "Unexpected response") {
                    Ok(state) => SyncPull {
                        ok: true,
                        status: code,
                        state: Some(state),
                        error: None,
                    },
                    Err(e) => SyncPull::failed(code, e),
                }
            } else {
                // Pure error arm: the body goes straight into `detail_from` and nothing
                // else, so the error-body ceiling is enough — buffering 4 MiB to extract
                // 200 characters is wasted on the unattended startup/focus-change leg.
                let (_, detail) = super::error_detail(resp).await;
                SyncPull::failed(code, detail)
            }
        }
        Err(e) => SyncPull::failed(0, friendly_err(&e)),
    }
}

/// PUT /v1/synced-client-settings — optimistic write; `base_version` is the version
/// this device last saw (0 creates). Never log `blob` — it can carry API keys.
pub async fn push(
    server_url: &str,
    api_key: Option<&str>,
    blob: serde_json::Value,
    base_version: i64,
    device: &str,
) -> SyncPush {
    let base = base_url(server_url);
    let body = serde_json::json!({
        "blob": blob,
        "base_version": base_version,
        "device": device,
    });
    // SYNC_MAX_BODY bounds BOTH directions: a blob past it would push fine and then fail every
    // pull, on this and every other device, until "Delete server copy".
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    if over_wire_limit(bytes.len()) {
        return SyncPush::failed(0, "Your settings are too large to sync.".into());
    }
    // The body is built once; a retry on the old path re-sends the same bytes.
    let bytes = &bytes;
    with_legacy_path(&base, SYNC_PATH, LEGACY_SYNC_PATH, |path| {
        push_at(format!("{base}{path}"), api_key, bytes.clone())
    })
    .await
}

async fn push_at(url: String, api_key: Option<&str>, bytes: Vec<u8>) -> SyncPush {
    match with_auth(client().put(url), api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes)
        .timeout(SYNC_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            // Keep the body read outcome separate, so a size/timeout error surfaces as itself
            // rather than as "Unexpected response: expected value at line 1".
            let text = match body_capped_to(resp, SYNC_MAX_BODY).await {
                Ok(b) => b,
                Err(reason) => return SyncPush::failed(code, reason),
            };
            if (200..300).contains(&(code as i32)) {
                match accept(&text, "Unexpected response") {
                    Ok(state) => SyncPush {
                        ok: true,
                        status: code,
                        state: Some(state),
                        conflict: None,
                        error: None,
                    },
                    Err(e) => SyncPush::failed(code, e),
                }
            } else if code == 409 {
                // The conflict body IS the current server state (+ a detail
                // string serde ignores) — hand it to the merge loop.
                match accept(&text, "Unexpected conflict response") {
                    Ok(current) => SyncPush {
                        ok: false,
                        status: code,
                        conflict: Some(current),
                        ..Default::default()
                    },
                    Err(e) => SyncPush::failed(code, e),
                }
            } else {
                SyncPush::failed(code, detail_from(&text))
            }
        }
        Err(e) => SyncPush::failed(0, friendly_err(&e)),
    }
}

/// DELETE /v1/synced-client-settings — drop the account's stored blob.
pub async fn delete(server_url: &str, api_key: Option<&str>) -> SyncDelete {
    let base = base_url(server_url);
    with_legacy_path(&base, SYNC_PATH, LEGACY_SYNC_PATH, |path| {
        delete_at(format!("{base}{path}"), api_key)
    })
    .await
}

async fn delete_at(url: String, api_key: Option<&str>) -> SyncDelete {
    match with_auth(client().delete(url), api_key)
        .timeout(SYNC_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                SyncDelete {
                    ok: true,
                    status: code,
                    error: None,
                }
            } else {
                // Pure error arm: `detail_from` extracts at most 200 characters, so the
                // error-body ceiling is enough.
                let (_, detail) = super::error_detail(resp).await;
                SyncDelete {
                    ok: false,
                    status: code,
                    error: Some(detail),
                }
            }
        }
        Err(e) => SyncDelete {
            ok: false,
            status: 0,
            error: Some(friendly_err(&e)),
        },
    }
}

/// Room the push body leaves under the ceiling: the RESPONSE echoing the same blob carries a
/// different, larger envelope (`version` + `updated_ts`) and is read at the same ceiling, so a
/// body that just fits must not produce a stored blob whose echo — and every later pull — no
/// longer does.
const SYNC_RESPONSE_MARGIN: usize = 4096;

/// Is a composed push body past the wire ceiling this same module enforces on pulls (less the
/// response envelope's margin)?
fn over_wire_limit(body_len: usize) -> bool {
    body_len > SYNC_MAX_BODY - SYNC_RESPONSE_MARGIN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_guard_rejects_the_unrepresentable_extremes_without_overflowing() {
        let state = |version: i64| SyncRemoteState {
            version,
            ..Default::default()
        };
        assert!(!state(i64::MIN).version_representable());
        assert!(!state(i64::MAX).version_representable());
        assert!(state(MAX_SAFE_VERSION).version_representable());
        assert!(state(-MAX_SAFE_VERSION).version_representable());
        assert!(state(0).version_representable());
    }

    #[tokio::test]
    async fn an_oversized_pull_body_is_a_transport_error_not_an_unexpected_response() {
        // A 2xx whose declared length is past the ceiling: the body read fails before any
        // parse, so the reason must come through bare, without the malformed-reply prefix.
        // The app installs the TLS provider at startup (lib.rs); the shared client needs it.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut sock, _) = listener.accept().unwrap();
            let mut req = [0u8; 4096];
            let _ = sock.read(&mut req);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                SYNC_MAX_BODY + 1
            );
            let _ = sock.write_all(head.as_bytes());
        });
        let out = pull_at(format!("http://{addr}{SYNC_PATH}"), None).await;
        assert!(!out.ok);
        assert_eq!(out.status, 200);
        assert!(out.state.is_none());
        let error = out.error.expect("an error reason");
        assert!(
            !error.starts_with("Unexpected response"),
            "transport failure mislabelled: {error}"
        );
        assert_eq!(error, super::super::TOO_LARGE);
    }

    #[test]
    fn the_push_body_is_bounded_like_the_pull_body() {
        // Less the envelope margin: the echoed blob is read at SYNC_MAX_BODY in a larger wrapper.
        assert!(!over_wire_limit(SYNC_MAX_BODY - SYNC_RESPONSE_MARGIN));
        assert!(over_wire_limit(SYNC_MAX_BODY - SYNC_RESPONSE_MARGIN + 1));
        assert!(over_wire_limit(SYNC_MAX_BODY));
    }
}
