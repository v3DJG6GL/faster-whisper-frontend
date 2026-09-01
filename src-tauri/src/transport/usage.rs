//! `POST /v1/usage/outcome` — the end-of-dictation facts only the client knows (how the
//! session was activated, how the text landed, the translation outcome, the app it was
//! typed into). The server already holds words / audio seconds from its own utterance
//! rows, so the body never carries them. Idempotent per `job_id` (a retry is a
//! `duplicate`), which is what lets the TS queue flush with backoff and no dedupe of
//! its own.

use super::{base_url, body_capped_to, client, detail_from, friendly_err, with_auth, MAX_META_BODY};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const OUTCOME_TIMEOUT: Duration = Duration::from_secs(15);
/// The server caps a batch at 100 items; a larger list is refused with a 422 and would
/// wedge the queue behind it, so the transport enforces the same ceiling.
pub const MAX_OUTCOMES: usize = 100;

/// One session's outcome, exactly the wire object (snake_case; `app_id` omitted when None).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageOutcome {
    pub job_id: String,
    pub activation: String,
    pub delivery: String,
    pub translation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
}

/// Per-item verdict: `accepted` | `duplicate`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageOutcomeResult {
    #[serde(default)]
    pub job_id: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OutcomeResponse {
    #[serde(default)]
    results: Vec<UsageOutcomeResult>,
}

/// Structured result (model: `sync::push`): `status` 0 = unreachable/transport error, else
/// the HTTP code; `results` only on 2xx. The TS queue decides retry vs drop from `status`.
#[derive(Debug, Default, Serialize)]
pub struct UsageOutcomePost {
    pub ok: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub results: Vec<UsageOutcomeResult>,
}

fn job_id_ok(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub async fn post_usage_outcomes(
    server_url: &str,
    api_key: Option<&str>,
    outcomes: Vec<UsageOutcome>,
) -> UsageOutcomePost {
    // Client-side shape guard mirroring the server's validation. A malformed item is
    // reported as a 422 WITHOUT a round trip, so the queue drops it instead of retrying
    // a request the server will refuse every time.
    let bad = outcomes.iter().any(|o| {
        !job_id_ok(&o.job_id)
            || o.app_id.as_deref().map_or(false, |a| a.is_empty() || a.chars().count() > 64)
    });
    if bad || outcomes.is_empty() || outcomes.len() > MAX_OUTCOMES {
        return UsageOutcomePost {
            ok: false,
            status: 422,
            error: Some("Invalid usage outcome batch.".into()),
            results: Vec::new(),
        };
    }
    let base = base_url(server_url);
    let url = format!("{base}/v1/usage/outcome");
    let body = serde_json::json!({ "outcomes": outcomes });
    match with_auth(client().post(url), api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .timeout(OUTCOME_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let text = body_capped_to(resp, MAX_META_BODY).await.unwrap_or_default();
            if (200..300).contains(&code) {
                let parsed: OutcomeResponse = serde_json::from_str(&text).unwrap_or_default();
                let mut results = parsed.results;
                results.truncate(MAX_OUTCOMES);
                for r in &mut results {
                    r.job_id = super::bounded_server_text(&r.job_id, 64);
                    r.status = super::bounded_server_text(&r.status, 16);
                }
                UsageOutcomePost { ok: true, status: code, error: None, results }
            } else {
                UsageOutcomePost {
                    ok: false,
                    status: code,
                    error: Some(detail_from(&text)),
                    results: Vec::new(),
                }
            }
        }
        Err(e) => UsageOutcomePost {
            ok: false,
            status: 0,
            error: Some(friendly_err(&e)),
            results: Vec::new(),
        },
    }
}
