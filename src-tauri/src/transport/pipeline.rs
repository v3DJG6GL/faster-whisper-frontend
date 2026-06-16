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

use super::{base_url, client, with_auth};
use serde::{Deserialize, Serialize};

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

fn friendly_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Could not connect — is the server running and the URL correct?".into()
    } else if e.is_timeout() {
        "Timed out waiting for the server.".into()
    } else {
        e.to_string()
    }
}

/// Pull FastAPI's `detail` string from an error body, falling back to the raw text.
fn detail_from(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_else(|| body.to_string())
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
                    Err(e) => PipelineFetch {
                        ok: false,
                        status: code,
                        state: None,
                        error: Some(format!("Unexpected response: {e}")),
                    },
                }
            } else {
                let body = resp.text().await.unwrap_or_default();
                PipelineFetch {
                    ok: false,
                    status: code,
                    state: None,
                    error: Some(detail_from(&body)),
                }
            }
        }
        Err(e) => PipelineFetch {
            ok: false,
            status: 0,
            state: None,
            error: Some(friendly_err(&e)),
        },
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
                    Err(e) => PipelineSave {
                        ok: false,
                        status: code,
                        conflicts: serde_json::json!([]),
                        detail: Some(format!("Unexpected response: {e}")),
                        ..Default::default()
                    },
                }
            } else {
                let body = resp.text().await.unwrap_or_default();
                let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();
                let errors = parsed.as_ref().and_then(|v| v.get("errors").cloned());
                let detail = parsed
                    .as_ref()
                    .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                    .unwrap_or_else(|| if errors.is_some() { String::new() } else { body });
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
        Err(e) => PipelineSave {
            ok: false,
            status: 0,
            conflicts: serde_json::json!([]),
            detail: Some(friendly_err(&e)),
            ..Default::default()
        },
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
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<RecentWords>().await.unwrap_or_default()
        }
        _ => RecentWords::default(),
    }
}
