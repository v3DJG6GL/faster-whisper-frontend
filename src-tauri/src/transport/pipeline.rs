//! Client API for the desktop "Dictionary": view + edit the backend's
//! post-processing (pipeline) rules via `GET`/`PATCH /v1/pipeline-rules`.
//!
//! Unlike the best-effort discovery helpers (which collapse every failure to
//! `None`), these return STRUCTURED results carrying the HTTP status + any
//! error/validation detail — the editor UI must distinguish a standard server
//! (404), unauthorized (401), no-access (403), validation failures (422) and
//! edit conflicts. Rule bodies are heterogeneous (regex-list `entries` /
//! cb:map `map` / `pattern` / `wordlist`), so they pass through as opaque JSON
//! and are typed on the TS side.

use super::{base_url, client, detail_from, friendly_err, with_auth};
use serde::{Deserialize, Serialize};

/// First `n` chars of `s` for a log line. Error bodies can be huge, and a 422's body embeds
/// the submitted rule contents — logs get the status + a short detail, never the payload.
fn trunc(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// The GET /v1/pipeline-rules body, passed through verbatim: the rules the
/// caller may view + edit, their role, and the per-type editable-field allow-list.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PipelineRulesState {
    #[serde(default)]
    pub rules: serde_json::Value,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub editable_fields: serde_json::Value,
    /// Backend's QUICK_CONFIG_MAP_COLLAPSE_AFTER (newest cb:map entries shown
    /// before collapsing). MUST be declared here or serde drops it on the
    /// pass-through and the webview never sees it.
    #[serde(default)]
    pub map_collapse_after: Option<i64>,
}

/// GET outcome. `ok` ⇒ `state` is present; otherwise `status` + `error` say why
/// (status 0 = transport failure / server unreachable).
#[derive(Debug, Serialize, Default)]
pub struct PipelineFetch {
    pub ok: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<PipelineRulesState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// PATCH outcome. `ok` ⇒ HTTP 2xx (then inspect `conflicts` / `requires_restart`).
/// `errors` carries the 422 validation list; `detail` a 400/403/500 message or a
/// transport error (status 0).
#[derive(Debug, Serialize, Default)]
pub struct PipelineSave {
    pub ok: bool,
    pub status: u16,
    #[serde(default)]
    pub saved: Vec<String>,
    #[serde(default)]
    pub conflicts: serde_json::Value,
    #[serde(default)]
    pub requires_restart: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Deserialize, Default)]
struct SaveBody {
    #[serde(default)]
    saved: Vec<String>,
    #[serde(default)]
    conflicts: serde_json::Value,
    #[serde(default)]
    requires_restart: bool,
}

/// GET /v1/pipeline-rules — the rules this caller may view + edit.
pub async fn get_pipeline_rules(server_url: &str, api_key: Option<&str>) -> PipelineFetch {
    let base = base_url(server_url);
    let url = format!("{base}/v1/pipeline-rules");
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                match resp.json::<PipelineRulesState>().await {
                    Ok(state) => PipelineFetch {
                        ok: true,
                        status: code,
                        state: Some(state),
                        error: None,
                    },
                    Err(e) => {
                        tracing::warn!("[pipeline] rules GET: HTTP {code} but unparsable body: {e}");
                        PipelineFetch {
                            ok: false,
                            status: code,
                            state: None,
                            error: Some(format!("Unexpected response: {e}")),
                        }
                    }
                }
            } else {
                let body = resp.text().await.unwrap_or_default();
                let detail = detail_from(&body);
                tracing::warn!("[pipeline] rules GET failed: HTTP {code} {}", trunc(&detail, 200));
                PipelineFetch {
                    ok: false,
                    status: code,
                    state: None,
                    error: Some(detail),
                }
            }
        }
        Err(e) => {
            tracing::warn!("[pipeline] rules GET failed: {}", friendly_err(&e));
            PipelineFetch {
                ok: false,
                status: 0,
                state: None,
                error: Some(friendly_err(&e)),
            }
        }
    }
}

/// PATCH /v1/pipeline-rules — apply `patch` (the `{rules_patch, fingerprints}`
/// object built by the client).
pub async fn save_pipeline_rules(
    server_url: &str,
    api_key: Option<&str>,
    patch: serde_json::Value,
) -> PipelineSave {
    let base = base_url(server_url);
    let url = format!("{base}/v1/pipeline-rules");
    match with_auth(client().patch(url), api_key).json(&patch).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                match resp.json::<SaveBody>().await {
                    Ok(b) => PipelineSave {
                        ok: true,
                        status: code,
                        saved: b.saved,
                        conflicts: if b.conflicts.is_null() {
                            serde_json::json!([])
                        } else {
                            b.conflicts
                        },
                        requires_restart: b.requires_restart,
                        errors: None,
                        detail: None,
                    },
                    Err(e) => {
                        tracing::warn!("[pipeline] rules PATCH: HTTP {code} but unparsable body: {e}");
                        PipelineSave {
                            ok: false,
                            status: code,
                            conflicts: serde_json::json!([]),
                            detail: Some(format!("Unexpected response: {e}")),
                            ..Default::default()
                        }
                    }
                }
            } else {
                let body = resp.text().await.unwrap_or_default();
                let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();
                let errors = parsed.as_ref().and_then(|v| v.get("errors").cloned());
                let detail = parsed
                    .as_ref()
                    .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                    .unwrap_or_else(|| if errors.is_some() { String::new() } else { body });
                // Status + short detail only — never the `errors` value: a 422's validation
                // list embeds the submitted rule keys/values (user content).
                tracing::warn!("[pipeline] rules PATCH failed: HTTP {code} {}", trunc(&detail, 200));
                PipelineSave {
                    ok: false,
                    status: code,
                    conflicts: serde_json::json!([]),
                    errors,
                    detail: if detail.is_empty() { None } else { Some(detail) },
                    ..Default::default()
                }
            }
        }
        Err(e) => {
            tracing::warn!("[pipeline] rules PATCH failed: {}", friendly_err(&e));
            PipelineSave {
                ok: false,
                status: 0,
                conflicts: serde_json::json!([]),
                detail: Some(friendly_err(&e)),
                ..Default::default()
            }
        }
    }
}

/// GET /v1/recent-words body — recently-transcribed word/phrase suggestions for
/// the spoken-symbol (callback:map) key field, scoped to the caller's user.
/// `max` echoes the backend cap (QUICK_CONFIG_WORD_SUGGESTIONS_MAX).
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct RecentWords {
    #[serde(default)]
    pub words: Vec<String>,
    #[serde(default)]
    pub max: Option<i64>,
}

/// GET /v1/recent-words — BEST-EFFORT. Suggestions are an enhancement, not a
/// feature the editor depends on, so any failure (unreachable, an old/standard
/// server's 404, a parse error) collapses to an empty list instead of surfacing
/// an error. The bearer (resolved upstream) scopes the words to the user.
pub async fn get_recent_words(server_url: &str, api_key: Option<&str>) -> RecentWords {
    let base = base_url(server_url);
    let url = format!("{base}/v1/recent-words");
    // Hand-rolled instead of get_json so the failure kind is at least VISIBLE: an empty
    // quick-add dropdown is otherwise indistinguishable from "no recent words yet".
    // `debug` (not warn) is deliberate — a standard/old server 404s this endpoint on every
    // summon, and that expected miss must not spam the default-on info/warn log.
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<RecentWords>().await {
            Ok(rw) => rw,
            Err(e) => {
                tracing::debug!("[pipeline] recent-words: unparsable body: {e}");
                RecentWords::default()
            }
        },
        Ok(resp) => {
            tracing::debug!("[pipeline] recent-words: HTTP {}", resp.status().as_u16());
            RecentWords::default()
        }
        Err(e) => {
            tracing::debug!("[pipeline] recent-words: {}", friendly_err(&e));
            RecentWords::default()
        }
    }
}
