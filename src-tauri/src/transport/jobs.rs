//! The server's durable job resource: `GET/DELETE /v1/jobs/{id}` and
//! `GET /v1/jobs/{id}/result` (full backend only).
//!
//! A batch run posted with a `progress_id` is a row the server keeps for
//! its TTL — status, and once done the response payload verbatim. This is
//! how the app re-attaches to a run it lost the connection to (quit
//! mid-run): `get_job` polls the row (with the live progress embedded while
//! the run is in flight), `get_job_result` fetches the payload through the
//! SAME conversion the POST uses, so the record the client builds is
//! identical to the one the POST would have produced.
//!
//! Outcomes are typed rather than `bail!`ed: a 404 (unknown / expired /
//! foreign — one answer, no oracle), a 409 (result asked for while running)
//! and a 403 (feature off) each drive a different client decision.

use super::batch::{bound_progress, is_progress_id, to_batch_result, BatchProgress, BatchResult, VerboseJson};
use super::{base_url, client, friendly_err, json_capped, json_capped_to, with_auth, MAX_META_BODY};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Same ceiling as the progress poll: the re-attached client polls once a
/// second, so a stalled server must fail each tick well under the shared
/// client's 120 s default.
const JOB_TIMEOUT: Duration = Duration::from_secs(10);

/// What a jobs call came back with. `kind` is the discriminant the TS side
/// switches on; `value` rides only on `ok`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JobOutcome<T> {
    Ok { value: T },
    /// Unknown, expired, or someone else's — the server answers all three
    /// the same way (404).
    NotFound,
    /// The result was asked for while the run is still going (409).
    Running,
    /// The server does not keep jobs (403 — JOBS_ENABLED off).
    Disabled,
    /// Transport failure or an unexpected status; `message` is client-safe.
    Error { message: String },
}

/// One job row (`GET /v1/jobs/{id}`), snake_case on the wire, camelCase to
/// the webview. Every field defaults so a newer server's additive keys and
/// an older one's missing keys both parse.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    #[serde(default, alias = "job_id")]
    pub job_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    /// Unix seconds.
    #[serde(default, alias = "created_at")]
    pub created_at: Option<f64>,
    #[serde(default, alias = "finished_at")]
    pub finished_at: Option<f64>,
    #[serde(default, alias = "expires_at")]
    pub expires_at: Option<f64>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, alias = "source_kind")]
    pub source_kind: Option<String>,
    #[serde(default, alias = "source_name")]
    pub source_name: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default, alias = "result_bytes")]
    pub result_bytes: Option<u64>,
    #[serde(default, alias = "result_available")]
    pub result_available: Option<bool>,
    /// The live progress (the progress route's shape) while the run is in
    /// flight in the server process that hosts it; null once it closed.
    #[serde(default)]
    pub progress: Option<BatchProgress>,
}

/// Bound a parsed job row: every string is rendered as a UI label or pasted
/// into a record, every timestamp becomes a clock. The id is screened like a
/// progress id (it IS one) so a hostile server cannot plant a path-bearing
/// value the client would interpolate into its next request.
pub(crate) fn bound_job_status(parsed: JobStatus) -> JobStatus {
    let text = |s: Option<String>, n: usize| s.map(|v| super::bounded_server_text(&v, n));
    let unix = |v: Option<f64>| v.filter(|x| x.is_finite() && *x >= 0.0);
    JobStatus {
        job_id: parsed.job_id.filter(|s| is_progress_id(s)),
        kind: text(parsed.kind, 16),
        state: text(parsed.state, 16),
        created_at: unix(parsed.created_at),
        finished_at: unix(parsed.finished_at),
        expires_at: unix(parsed.expires_at),
        model: text(parsed.model, 128),
        source_kind: text(parsed.source_kind, 8),
        source_name: text(parsed.source_name, 200),
        task: text(parsed.task, 16),
        error: text(parsed.error, super::MAX_ERROR_TEXT),
        result_bytes: parsed.result_bytes,
        result_available: parsed.result_available,
        progress: parsed.progress.map(bound_progress),
    }
}

/// Map a non-2xx status to the outcome the client acts on.
fn outcome_for<T>(status: reqwest::StatusCode) -> JobOutcome<T> {
    match status.as_u16() {
        404 => JobOutcome::NotFound,
        409 => JobOutcome::Running,
        403 => JobOutcome::Disabled,
        code => JobOutcome::Error { message: format!("HTTP {code}") },
    }
}

async fn send(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    req.timeout(JOB_TIMEOUT)
        .send()
        .await
        .map_err(|e| friendly_err(&e))
}

/// `GET /v1/jobs/{id}` — the row, with the live progress while in flight.
pub async fn get_job(server_url: &str, api_key: Option<&str>, job_id: &str) -> JobOutcome<JobStatus> {
    if !is_progress_id(job_id) {
        return JobOutcome::Error { message: "malformed job id".into() };
    }
    let base = base_url(server_url);
    let resp = match send(with_auth(client().get(format!("{base}/v1/jobs/{job_id}")), api_key)).await {
        Ok(r) => r,
        Err(message) => return JobOutcome::Error { message },
    };
    let status = resp.status();
    if !status.is_success() {
        return outcome_for(status);
    }
    match json_capped_to::<JobStatus>(resp, MAX_META_BODY).await {
        Ok(parsed) => JobOutcome::Ok { value: bound_job_status(parsed) },
        Err(message) => JobOutcome::Error { message },
    }
}

/// `GET /v1/jobs/{id}/result` — the payload, through the POST's own
/// conversion and bounding. Generous timeout: a verbose_json payload with
/// words and translations can be megabytes.
pub async fn get_job_result(server_url: &str, api_key: Option<&str>, job_id: &str) -> JobOutcome<BatchResult> {
    if !is_progress_id(job_id) {
        return JobOutcome::Error { message: "malformed job id".into() };
    }
    let base = base_url(server_url);
    let resp = match with_auth(client().get(format!("{base}/v1/jobs/{job_id}/result")), api_key)
        .send()
        .await
        .map_err(|e| friendly_err(&e))
    {
        Ok(r) => r,
        Err(message) => return JobOutcome::Error { message },
    };
    let status = resp.status();
    if !status.is_success() {
        return outcome_for(status);
    }
    match json_capped::<VerboseJson>(resp).await {
        Ok(parsed) => JobOutcome::Ok { value: to_batch_result(parsed) },
        Err(message) => JobOutcome::Error { message },
    }
}

/// `DELETE /v1/jobs/{id}` — cancel a running job / delete a finished one.
pub async fn delete_job(server_url: &str, api_key: Option<&str>, job_id: &str) -> JobOutcome<()> {
    if !is_progress_id(job_id) {
        return JobOutcome::Error { message: "malformed job id".into() };
    }
    let base = base_url(server_url);
    let resp = match send(with_auth(client().delete(format!("{base}/v1/jobs/{job_id}")), api_key)).await {
        Ok(r) => r,
        Err(message) => return JobOutcome::Error { message },
    };
    let status = resp.status();
    if !status.is_success() {
        return outcome_for(status);
    }
    JobOutcome::Ok { value: () }
}

#[cfg(test)]
mod wire_field_tests {
    use super::{bound_job_status, outcome_for, JobOutcome, JobStatus};

    #[test]
    fn job_status_is_bounded() {
        let raw = serde_json::json!({
            "job_id": "../../etc/passwd",
            "kind": "k".repeat(80),
            "state": "done",
            "created_at": -5.0,
            "finished_at": 1757200042.7,
            "expires_at": f64::NAN,
            "model": "m".repeat(300),
            "source_kind": "file",
            "source_name": "n".repeat(500),
            "error": "e".repeat(900),
            "result_bytes": 42,
            "result_available": true,
            "progress": null
        });
        let s: JobStatus = serde_json::from_value(raw).unwrap();
        let b = bound_job_status(s);
        assert_eq!(b.job_id, None);
        assert_eq!(b.kind.unwrap().chars().count(), 17); // cap + ellipsis
        assert_eq!(b.created_at, None);
        assert_eq!(b.finished_at, Some(1757200042.7));
        assert_eq!(b.expires_at, None);
        assert_eq!(b.model.unwrap().chars().count(), 129);
        assert_eq!(b.source_name.unwrap().chars().count(), 201);
        assert_eq!(b.error.unwrap().chars().count(), super::super::MAX_ERROR_TEXT + 1);
        assert_eq!(b.result_bytes, Some(42));
        assert!(b.progress.is_none());
        // A clean id survives; camelCase on the way out.
        let s: JobStatus = serde_json::from_value(serde_json::json!({"job_id": "cafe".repeat(8)})).unwrap();
        let out = serde_json::to_value(bound_job_status(s)).unwrap();
        assert_eq!(out["jobId"], "cafe".repeat(8));
        assert!(out.get("job_id").is_none());
    }

    #[test]
    fn running_job_carries_bounded_progress() {
        let raw = serde_json::json!({
            "job_id": "cafe".repeat(8),
            "state": "running",
            "progress": {
                "stage": "translating", "progress": 0.5, "last_text": "x".repeat(900),
                "target": "fr", "target_progress": 7.0, "eta_s": 12.5, "overall": 0.8
            }
        });
        let s: JobStatus = serde_json::from_value(raw).unwrap();
        let p = bound_job_status(s).progress.unwrap();
        assert_eq!(p.stage.as_deref(), Some("translating"));
        assert_eq!(p.last_text.as_ref().unwrap().chars().count(), 401);
        assert_eq!(p.target_progress, Some(1.0));
        assert_eq!(p.eta_s, Some(12.5));
        let out = serde_json::to_value(&p).unwrap();
        assert_eq!(out["etaS"], 12.5);
    }

    #[test]
    fn status_codes_map_to_outcomes() {
        use reqwest::StatusCode;
        let k = |o: JobOutcome<()>| serde_json::to_value(o).unwrap()["kind"].as_str().unwrap().to_string();
        assert_eq!(k(outcome_for(StatusCode::NOT_FOUND)), "not_found");
        assert_eq!(k(outcome_for(StatusCode::CONFLICT)), "running");
        assert_eq!(k(outcome_for(StatusCode::FORBIDDEN)), "disabled");
        assert_eq!(k(outcome_for(StatusCode::INTERNAL_SERVER_ERROR)), "error");
        let ok = serde_json::to_value(JobOutcome::Ok { value: 3 }).unwrap();
        assert_eq!(ok, serde_json::json!({"kind": "ok", "value": 3}));
    }
}
