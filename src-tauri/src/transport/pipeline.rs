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

use super::{
    base_url, body_capped_to, client, friendly_err, json_capped_to, with_auth, MAX_ERROR_BODY,
    MAX_META_BODY,
};
use serde::{Deserialize, Serialize};

/// A role name ("admin", "editor"), never prose.
const ROLE_MAX: usize = 60;
/// Mirrors the count both webviews already slice to.
const MAX_RECENT_WORDS: usize = 500;
/// A single dictated word or short phrase.
const WORD_MAX: usize = 120;
/// Env-pinned setting names echoed back by a save: a handful at most.
const MAX_ENV_PINNED: usize = 16;
/// An env-pinned SETTING name ("PIPELINE_RULES"), never prose and never a rule name: the server
/// reports which of the settings the save wrote are pinned by its environment.
const SETTING_NAME_MAX: usize = 64;
/// Read cap for the GET body, which carries every visible rule in full. The server allows
/// 10,000 entries per cb:map list (keys and values up to 64 chars, a `map_meta` stamp per key)
/// across several lists, so one large but valid dictionary passes 1 MiB in compact JSON. The
/// PATCH reply carries no rule bodies and stays at [`MAX_META_BODY`].
const RULES_MAX_BODY: usize = 16 * 1024 * 1024;
/// Per-request bound on the GET, sized for reading the 2xx [`RULES_MAX_BODY`] the way
/// [`super::META_TIMEOUT`] is sized for [`MAX_META_BODY`]. Only that success body gets the 60 s:
/// connect + headers and a non-2xx error body share ONE `META_TIMEOUT` deadline, so an offline,
/// black-holed or stalling host still shows Retry after 15 s (not 60, nor 15 + 15).
const RULES_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Per-request bound on the PATCH (connect, headers and its [`MAX_META_BODY`] reply). Wider than
/// `META_TIMEOUT` because the server validates every regex entry in a child process (up to 10 s,
/// possibly queued behind another save), and a save that lands must not read as unsaved; the
/// shared client's 120 s ceiling left "Saving…" up for two minutes against a black-holed host.
const RULES_SAVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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

/// PATCH outcome. `ok` ⇒ HTTP 2xx with a readable reply (then inspect `conflicts` /
/// `requires_restart`). A 2xx `status` with `ok: false` means the change LANDED but the
/// reply couldn't be read or parsed, so the caller must reload rather than treat it as
/// unsaved. `errors` carries the 422 validation list; `detail` a 400/403/500 message or a
/// transport error before any status arrived (status 0).
#[derive(Debug, Serialize, Default)]
pub struct PipelineSave {
    pub ok: bool,
    pub status: u16,
    pub saved: Vec<String>,
    pub conflicts: serde_json::Value,
    pub requires_restart: bool,
    /// The env-pinned SETTING names among those the save wrote (the server's
    /// `sorted(n for n in written if n in env_pinned)`), not rule names. A rules PATCH
    /// writes only `PIPELINE_RULES`, so in practice this is `["PIPELINE_RULES"]` or empty:
    /// when present the environment pins the WHOLE rule list and nothing in this save
    /// takes effect. MUST be declared here or serde drops it on the pass-through and the
    /// webview shows a plain "Saved".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub env_pinned_ignored: Vec<String>,
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
    #[serde(default)]
    env_pinned_ignored: Vec<String>,
}

/// GET /v1/pipeline-rules — the rules this caller may view + edit.
pub async fn get_pipeline_rules(server_url: &str, api_key: Option<&str>) -> PipelineFetch {
    let base = base_url(server_url);
    let url = format!("{base}/v1/pipeline-rules");
    let meta_deadline = tokio::time::Instant::now() + super::META_TIMEOUT;
    let send = with_auth(client().get(url), api_key)
        .timeout(RULES_TIMEOUT)
        .send();
    let sent = match tokio::time::timeout_at(meta_deadline, send).await {
        Ok(r) => r.map_err(|e| friendly_err(&e)),
        Err(_) => Err(super::TIMED_OUT.to_string()),
    };
    match sent {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                // Read the body apart from parsing it, as `discovery::test_connection` does: a
                // timeout or oversized body is a transport failure, not "Unexpected response",
                // so it reports as status 0 like a send failure (the card offers Retry instead
                // of titling it "Server error (HTTP 200)").
                let text = match body_capped_to(resp, RULES_MAX_BODY).await {
                    Ok(t) => t,
                    Err(reason) => {
                        tracing::warn!(
                            "[pipeline] rules GET: HTTP {code} body read failed: {reason}"
                        );
                        return PipelineFetch {
                            ok: false,
                            status: 0,
                            state: None,
                            error: Some(reason),
                        };
                    }
                };
                match serde_json::from_str::<PipelineRulesState>(&text)
                    .map_err(|e| super::bounded_server_text(&e.to_string(), super::MAX_ERROR_TEXT))
                {
                    Ok(mut state) => {
                        // `role` renders inline ("Editing as <role>") in a wrapping row with
                        // no truncation.
                        state.role = super::bounded_server_text(&state.role, ROLE_MAX);
                        PipelineFetch {
                            ok: true,
                            status: code,
                            state: Some(state),
                            error: None,
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[pipeline] rules GET: HTTP {code} but unparsable body: {e}"
                        );
                        PipelineFetch {
                            ok: false,
                            status: code,
                            state: None,
                            error: Some(format!("Unexpected response: {e}")),
                        }
                    }
                }
            } else {
                // The small error body shares the headers' deadline (see RULES_TIMEOUT).
                let read = super::error_detail(resp);
                let detail = match tokio::time::timeout_at(meta_deadline, read).await {
                    Ok((_, d)) => d,
                    Err(_) => super::TIMED_OUT.to_string(),
                };
                tracing::warn!("[pipeline] rules GET failed: HTTP {code} {detail}");
                PipelineFetch {
                    ok: false,
                    status: code,
                    state: None,
                    error: Some(detail),
                }
            }
        }
        Err(msg) => {
            tracing::warn!("[pipeline] rules GET failed: {msg}");
            PipelineFetch {
                ok: false,
                status: 0,
                state: None,
                error: Some(msg),
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
    match with_auth(client().patch(url), api_key)
        .json(&patch)
        .timeout(RULES_SAVE_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                // Same split as the GET above, but the 2xx `status` is kept on both failure arms:
                // it is the only signal that the save landed, so the client reloads. The detail
                // stops at the read failure: only the webview knows whether that reload worked,
                // so the reload clause is the Dictionary banner's to add.
                let text = match body_capped_to(resp, MAX_META_BODY).await {
                    Ok(t) => t,
                    Err(reason) => {
                        tracing::warn!(
                            "[pipeline] rules PATCH: HTTP {code} body read failed: {reason}"
                        );
                        return PipelineSave {
                            ok: false,
                            status: code,
                            conflicts: serde_json::json!([]),
                            detail: Some(format!(
                                "The server accepted the save, but its reply couldn't be read ({reason})."
                            )),
                            ..Default::default()
                        };
                    }
                };
                match serde_json::from_str::<SaveBody>(&text)
                    .map_err(|e| super::bounded_server_text(&e.to_string(), super::MAX_ERROR_TEXT))
                {
                    Ok(mut b) => PipelineSave {
                        ok: true,
                        status: code,
                        // Capped like `words`: it crosses the IPC and is JSON-parsed on the
                        // webview main thread, and the only consumer reads `.length`, so the cap
                        // loses nothing.
                        saved: {
                            b.saved.truncate(MAX_RECENT_WORDS);
                            b.saved
                                .iter()
                                .map(|s| super::bounded_server_text(s, WORD_MAX))
                                .collect()
                        },
                        conflicts: if b.conflicts.is_null() {
                            serde_json::json!([])
                        } else {
                            b.conflicts
                        },
                        requires_restart: b.requires_restart,
                        env_pinned_ignored: {
                            b.env_pinned_ignored.truncate(MAX_ENV_PINNED);
                            b.env_pinned_ignored
                                .iter()
                                .map(|s| super::bounded_server_text(s, SETTING_NAME_MAX))
                                .collect()
                        },
                        errors: None,
                        detail: None,
                    },
                    Err(e) => {
                        tracing::warn!(
                            "[pipeline] rules PATCH: HTTP {code} but unparsable body: {e}"
                        );
                        PipelineSave {
                            ok: false,
                            status: code,
                            conflicts: serde_json::json!([]),
                            detail: Some(format!(
                                "The server accepted the save, but its reply was unexpected ({e})."
                            )),
                            ..Default::default()
                        }
                    }
                }
            } else {
                let body = match body_capped_to(resp, MAX_ERROR_BODY).await {
                    Ok(b) => b,
                    Err(r) => r,
                };
                let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();
                let errors = parsed.as_ref().and_then(|v| v.get("errors").cloned());
                // Bounded and control-folded like every other server-supplied string: the fallback
                // arm is the whole response body (up to MAX_ERROR_BODY, 256 KiB), and this one is
                // both rendered in a wrapping paragraph and written to the log.
                let detail = crate::transport::bounded_server_text(
                    &parsed
                        .as_ref()
                        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                        .unwrap_or_else(|| {
                            if errors.is_some() {
                                String::new()
                            } else {
                                body
                            }
                        }),
                    crate::transport::MAX_ERROR_TEXT,
                );
                // Status + short detail only — never the `errors` value: a 422's validation
                // list embeds the submitted rule keys/values (user content).
                tracing::warn!("[pipeline] rules PATCH failed: HTTP {code} {detail}");
                PipelineSave {
                    ok: false,
                    status: code,
                    conflicts: serde_json::json!([]),
                    errors,
                    detail: if detail.is_empty() {
                        None
                    } else {
                        Some(detail)
                    },
                    ..Default::default()
                }
            }
        }
        Err(e) => {
            let msg = friendly_err(&e);
            tracing::warn!("[pipeline] rules PATCH failed: {msg}");
            PipelineSave {
                ok: false,
                status: 0,
                conflicts: serde_json::json!([]),
                detail: Some(msg),
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
    match with_auth(client().get(url), api_key)
        .timeout(super::META_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match json_capped_to::<RecentWords>(resp, MAX_META_BODY).await {
                // The COUNT is capped in both webviews; the per-word LENGTH never was, and
                // `Combobox.rank` lowercases every candidate on every keystroke.
                Ok(mut rw) => {
                    rw.words.truncate(MAX_RECENT_WORDS);
                    rw.words = rw
                        .words
                        .iter()
                        .map(|w| super::bounded_server_text(w, WORD_MAX))
                        .collect();
                    rw
                }
                Err(e) => {
                    tracing::debug!("[pipeline] recent-words: unparsable body: {e}");
                    RecentWords::default()
                }
            }
        }
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

#[cfg(test)]
mod tests {
    use super::{get_pipeline_rules, save_pipeline_rules};
    use std::io::{Read, Write};

    /// A one-shot local server: answers the first request with `head` + `body`, then closes.
    fn serve_once(head: &'static str, body: &'static str) -> String {
        // The app installs the TLS provider at startup (lib.rs); the shared client needs it, and
        // a filtered run of just these tests has no sibling that installed it first.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(body.as_bytes());
        });
        format!("http://{addr}")
    }

    /// A 2xx whose body can't be read is a transport failure (status 0, so the card offers
    /// Retry), never "Server error (HTTP 200)".
    #[tokio::test]
    async fn rules_get_reports_an_unreadable_2xx_body_as_status_0() {
        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n",
            "",
        );
        let out = get_pipeline_rules(&url, None).await;
        assert!(!out.ok);
        assert_eq!(out.status, 0);
    }

    /// A valid dictionary past the 1 MiB metadata cap still loads: the GET reads up to
    /// `RULES_MAX_BODY`, not `MAX_META_BODY`.
    #[tokio::test]
    async fn rules_get_accepts_a_valid_body_over_the_meta_cap() {
        let body = format!(
            r#"{{"rules":{{"x":"{}"}},"role":"admin","editable_fields":{{}}}}"#,
            "a".repeat(2 * 1024 * 1024)
        );
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let url = serve_once(
            Box::leak(head.into_boxed_str()),
            Box::leak(body.into_boxed_str()),
        );
        let out = get_pipeline_rules(&url, None).await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.status, 200);
        assert_eq!(out.state.unwrap().role, "admin");
    }

    /// A 2xx PATCH landed even when its reply can't be read or parsed: the status stays 2xx
    /// (the client reloads on it) and the detail says the save was accepted — but never that it
    /// reloaded: the follow-up GET can fail, and the banner then sits above its error card.
    #[tokio::test]
    async fn rules_patch_keeps_the_2xx_when_its_reply_is_unreadable_or_unparsable() {
        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n",
            "",
        );
        let out = save_pipeline_rules(&url, None, serde_json::json!({})).await;
        assert!(!out.ok);
        assert_eq!(out.status, 200);
        let detail = out.detail.unwrap();
        assert!(detail.starts_with("The server accepted the save"));
        assert!(!detail.contains("Reload"), "{detail}");

        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            "not json",
        );
        let out = save_pipeline_rules(&url, None, serde_json::json!({})).await;
        assert!(!out.ok);
        assert_eq!(out.status, 200);
        let detail = out.detail.unwrap();
        assert!(detail.starts_with("The server accepted the save"));
        assert!(!detail.contains("Reload"), "{detail}");
    }
}
