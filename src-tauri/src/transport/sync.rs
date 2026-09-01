//! Client API for settings sync: `GET`/`PUT`/`DELETE /v1/client-settings`.
//!
//! Like `pipeline.rs`, these return STRUCTURED results carrying the HTTP
//! status — the sync engine must distinguish an old backend without the
//! endpoint (404), unauthorized (401), unreachable (status 0), an empty
//! store (200 with `version: 0, blob: null`), and a version conflict (409,
//! whose body carries the CURRENT server state so the client can 3-way
//! merge without a second GET). Blobs pass through as opaque JSON — the
//! category shapes are typed on the TS side.

use super::{base_url, body_capped_to, client, detail_from, friendly_err, json_capped_to, with_auth};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Per-request override of the shared client's 120 s default (that default is
/// sized for transcription uploads). Sync payloads are ≤512 KB of JSON, and the
/// engine serializes on one in-flight request — a sync call left hanging on an
/// unreachable server (e.g. a LAN address away from home) blocks pulls/pushes
/// to a NEWLY selected server for the whole 120 s. Keep failures prompt.
const SYNC_TIMEOUT: Duration = Duration::from_secs(15);

/// Ceiling on an inbound sync payload — the aggregate the per-category caps never bounded.
///
/// Every existing bound on this data sits on a CONSUMER: `MAX_SYNCED_ENTRIES` (500) caps the
/// entry COUNT per category, the render caps bound what is shown, and the per-field caps bound
/// individual leaves. Nothing bounded the BLOB, so this route inherited the transcription-sized
/// [`MAX_BODY`] (32 MiB) — while the doc comment above claims payloads are ≤512 KB.
///
/// That gap is reachable and measurable: a blob that passes every existing sanitizer (500 backends
/// each carrying a 60 KB prompt ≈ 29 MiB) costs ~1.5-2 s of hard main-thread block per pull, in a
/// webview, on a route that runs UNATTENDED at startup and on every window focus. It is then
/// persisted verbatim to `sync-state.json` as the 3-way merge base, so it is re-read and re-hashed
/// at every launch for the life of the install.
///
/// 4 MiB, not the 512 KB the comment claims: the worst-case LEGITIMATE blob computed from the caps
/// above is ~1.5 MB (500 backends ≈750 KB + 500 profiles ≈500 KB + appRules ≈100 KB + secrets
/// ≈50 KB), and a typical one is under 50 KB. 512 KB would reject a real max-config user and brick
/// their sync; 4 MiB keeps ~2.5x headroom over worst-case-legit while cutting the surface 8x.
///
/// Applied BEFORE the JSON parse, so an oversized payload fails as a transport error and is never
/// merged, never rendered, and never persisted.
pub const SYNC_MAX_BODY: usize = 4 * 1024 * 1024;

/// The GET (and PUT-200 / PUT-409) wire shape: `{version, blob, updated_at,
/// device}`. `version: 0, blob: null` = nothing stored yet.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SyncRemoteState {
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub blob: serde_json::Value,
    #[serde(default)]
    pub updated_at: Option<f64>,
    #[serde(default)]
    pub device: Option<String>,
}

impl SyncRemoteState {
    /// `device` is a server-supplied label rendered in the conflict dialog, as a Segmented option
    /// LABEL the user clicks, on the always-visible sync status line, and on the restore consent
    /// card — but unlike its `username` / `boot_id` / `server_version` siblings it was never
    /// routed through the bounding helper, so it reached those surfaces with no cap and no
    /// defanging at all. Bound it once, here, rather than at each render.
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
    /// survives restarts. The TS pull path already refuses such a version; the PUSH path (200 and
    /// 409 alike) did not, and the push path is the one that writes it down.
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

/// DELETE outcome (the "Delete server copy" button).
#[derive(Debug, Serialize, Default)]
pub struct SyncDelete {
    pub ok: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// GET /v1/client-settings — the account's stored blob (or the zero-state).
pub async fn pull(server_url: &str, api_key: Option<&str>) -> SyncPull {
    let base = base_url(server_url);
    let url = format!("{base}/v1/client-settings");
    match with_auth(client().get(url), api_key)
        .timeout(SYNC_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                match json_capped_to::<SyncRemoteState>(resp, SYNC_MAX_BODY).await {
                    Ok(state) if state.version_representable() => SyncPull {
                        ok: true,
                        status: code,
                        state: Some(state.bounded()),
                        error: None,
                    },
                    Ok(_) => SyncPull {
                        ok: false,
                        status: code,
                        state: None,
                        error: Some(VERSION_ERR.into()),
                    },
                    Err(e) => SyncPull {
                        ok: false,
                        status: code,
                        state: None,
                        error: Some(format!("Unexpected response: {}", super::bounded_server_text(&e.to_string(), super::MAX_ERROR_TEXT))),
                    },
                }
            } else {
                // SYNC_MAX_BODY, not the transcription-sized MAX_BODY: `push`'s non-2xx arm in
                // this same file already reads at the 4 MiB ceiling, and the whole body is handed
                // to `detail_from`, which full-parses it as JSON just to extract 200 characters.
                // This is the UNATTENDED leg — startup plus every window focus — so a hostile
                // server answering 500 with a 32 MiB document needed no state and no gesture.
                let body = body_capped_to(resp, SYNC_MAX_BODY).await.unwrap_or_default();
                SyncPull {
                    ok: false,
                    status: code,
                    state: None,
                    error: Some(detail_from(&body)),
                }
            }
        }
        Err(e) => SyncPull {
            ok: false,
            status: 0,
            state: None,
            error: Some(friendly_err(&e)),
        },
    }
}

/// PUT /v1/client-settings — optimistic write; `base_version` is the version
/// this device last saw (0 creates). Never log `blob` — it can carry API keys.
pub async fn push(
    server_url: &str,
    api_key: Option<&str>,
    blob: serde_json::Value,
    base_version: i64,
    device: &str,
) -> SyncPush {
    let base = base_url(server_url);
    let url = format!("{base}/v1/client-settings");
    let body = serde_json::json!({
        "blob": blob,
        "base_version": base_version,
        "device": device,
    });
    // SYNC_MAX_BODY bounds BOTH directions. Only the inbound side was capped, so a blob past
    // 4 MiB pushed fine and then failed every pull, on this and every other device, forever
    // (the version never advanced; the only recovery was "Delete server copy").
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    if over_wire_limit(bytes.len()) {
        return SyncPush {
            ok: false,
            status: 0,
            error: Some("Your settings are too large to sync.".into()),
            ..Default::default()
        };
    }
    match with_auth(client().put(url), api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes)
        .timeout(SYNC_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let text = body_capped_to(resp, SYNC_MAX_BODY).await.unwrap_or_default();
            if (200..300).contains(&(code as i32)) {
                match serde_json::from_str::<SyncRemoteState>(&text) {
                    Ok(state) if state.version_representable() => SyncPush {
                        ok: true,
                        status: code,
                        state: Some(state.bounded()),
                        conflict: None,
                        error: None,
                    },
                    Ok(_) => SyncPush {
                        ok: false,
                        status: code,
                        error: Some(VERSION_ERR.into()),
                        ..Default::default()
                    },
                    Err(e) => SyncPush {
                        ok: false,
                        status: code,
                        error: Some(format!("Unexpected response: {}", super::bounded_server_text(&e.to_string(), super::MAX_ERROR_TEXT))),
                        ..Default::default()
                    },
                }
            } else if code == 409 {
                // The conflict body IS the current server state (+ a detail
                // string serde ignores) — hand it to the merge loop.
                match serde_json::from_str::<SyncRemoteState>(&text) {
                    Ok(current) if current.version_representable() => SyncPush {
                        ok: false,
                        status: code,
                        conflict: Some(current.bounded()),
                        ..Default::default()
                    },
                    Ok(_) => SyncPush {
                        ok: false,
                        status: code,
                        error: Some(VERSION_ERR.into()),
                        ..Default::default()
                    },
                    Err(e) => SyncPush {
                        ok: false,
                        status: code,
                        error: Some(format!("Unexpected conflict response: {}", super::bounded_server_text(&e.to_string(), super::MAX_ERROR_TEXT))),
                        ..Default::default()
                    },
                }
            } else {
                SyncPush {
                    ok: false,
                    status: code,
                    error: Some(detail_from(&text)),
                    ..Default::default()
                }
            }
        }
        Err(e) => SyncPush {
            ok: false,
            status: 0,
            error: Some(friendly_err(&e)),
            ..Default::default()
        },
    }
}

/// DELETE /v1/client-settings — drop the account's stored blob.
pub async fn delete(server_url: &str, api_key: Option<&str>) -> SyncDelete {
    let base = base_url(server_url);
    let url = format!("{base}/v1/client-settings");
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
                // Same ceiling as the pull arm above and as `push`. User-initiated, so narrower.
                let body = body_capped_to(resp, SYNC_MAX_BODY).await.unwrap_or_default();
                SyncDelete {
                    ok: false,
                    status: code,
                    error: Some(detail_from(&body)),
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
/// different, larger envelope (`version` + `updated_at`) and is read at the same ceiling, so a
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
        let state = |version: i64| SyncRemoteState { version, ..Default::default() };
        assert!(!state(i64::MIN).version_representable());
        assert!(!state(i64::MAX).version_representable());
        assert!(state(MAX_SAFE_VERSION).version_representable());
        assert!(state(-MAX_SAFE_VERSION).version_representable());
        assert!(state(0).version_representable());
    }

    #[test]
    fn the_push_body_is_bounded_like_the_pull_body() {
        // Less the envelope margin: the echoed blob is read at SYNC_MAX_BODY in a larger wrapper.
        assert!(!over_wire_limit(SYNC_MAX_BODY - SYNC_RESPONSE_MARGIN));
        assert!(over_wire_limit(SYNC_MAX_BODY - SYNC_RESPONSE_MARGIN + 1));
        assert!(over_wire_limit(SYNC_MAX_BODY));
    }
}
