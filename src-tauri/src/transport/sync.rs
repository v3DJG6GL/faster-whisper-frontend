//! Client API for settings sync: `GET`/`PUT`/`DELETE /v1/client-settings`.
//!
//! Like `pipeline.rs`, these return STRUCTURED results carrying the HTTP
//! status — the sync engine must distinguish an old backend without the
//! endpoint (404), unauthorized (401), unreachable (status 0), an empty
//! store (200 with `version: 0, blob: null`), and a version conflict (409,
//! whose body carries the CURRENT server state so the client can 3-way
//! merge without a second GET). Blobs pass through as opaque JSON — the
//! category shapes are typed on the TS side.

use super::{base_url, body_capped, client, detail_from, friendly_err, json_capped, with_auth};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Per-request override of the shared client's 120 s default (that default is
/// sized for transcription uploads). Sync payloads are ≤512 KB of JSON, and the
/// engine serializes on one in-flight request — a sync call left hanging on an
/// unreachable server (e.g. a LAN address away from home) blocks pulls/pushes
/// to a NEWLY selected server for the whole 120 s. Keep failures prompt.
const SYNC_TIMEOUT: Duration = Duration::from_secs(15);

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
        self.version.abs() <= MAX_SAFE_VERSION
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
                match json_capped::<SyncRemoteState>(resp).await {
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
                let body = body_capped(resp).await.unwrap_or_default();
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
    match with_auth(client().put(url), api_key)
        .json(&body)
        .timeout(SYNC_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let text = body_capped(resp).await.unwrap_or_default();
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
                let body = body_capped(resp).await.unwrap_or_default();
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
