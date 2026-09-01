//! Model pre-warm hint (`POST /v1/models/preload`, full backend only).
//!
//! Best-effort in exactly the sense `discovery`'s probes are: the endpoint is a
//! HINT, never a precondition. An older backend answers 404 and a disallowed
//! model / disabled stage answers 202 with `state: "deferred"` — both must be
//! indistinguishable from success to the user, so nothing here is surfaced.

use super::{base_url, client, json_capped_to, with_auth};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The backend accepts 1..6 entries and rejects anything else with a 422, so
/// clamp here rather than letting a caller's plan turn into a hard error.
const MAX_ENTRIES: usize = 6;
/// Same ceiling `discovery` puts on every server-supplied identifier; applied on
/// the way OUT too so a model id that came from a hostile server's inventory
/// can't be echoed back as an unbounded request body.
const MAX_ID: usize = 120;

/// One `{family, id}` pair. Unknown keys are REJECTED by the backend (422), so
/// this struct must stay exactly these two fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloadModel {
    pub family: String,
    pub id: String,
}

#[derive(Serialize)]
struct PreloadReq {
    models: Vec<PreloadModel>,
    stage_ahead: bool,
}

// Nothing in the response is surfaced. The per-model `state`/`reason` fields are
// deliberately NOT read: `deferred` is the backend's answer for a disallowed model,
// a disabled stage and a disabled feature alike, and none of those is something the
// user asked for or can act on here. The plan id is not read back either — the
// client re-POSTs the whole plan on each renew tick (preload.ts), and a `plan_id`
// that nothing could ever supply was dead plumbing across four layers.

/// Ask the server to start warming the models a job is about to need.
///
/// Returns whether the hint was accepted (a 2xx). `false` covers every failure
/// mode alike — unreachable, unauthorized, 404 on an older backend — because no
/// caller may branch on it beyond deciding not to retry.
pub async fn preload_models(
    server_url: &str,
    api_key: Option<&str>,
    models: Vec<PreloadModel>,
) -> bool {
    if models.is_empty() {
        return false;
    }
    let body = PreloadReq {
        models: models
            .into_iter()
            .take(MAX_ENTRIES)
            .map(|m| PreloadModel {
                family: super::bounded_server_text(&m.family, MAX_ID),
                id: super::bounded_server_text(&m.id, MAX_ID),
            })
            .collect(),
        // Server-driven stage-ahead: the backend walks the plan forward on its
        // own as stages complete, so the client never has to re-POST mid-run.
        stage_ahead: true,
    };
    let url = format!("{}/v1/models/preload", base_url(server_url));
    // Per-request 10s ceiling instead of the shared 120s client timeout
    // (transport/mod.rs): a preload is a hint fired on a 2-minute renew timer,
    // so a black-holed server would otherwise hold a task open across several
    // renews, stacking one live request per tick for as long as it stays dark.
    let resp = with_auth(client().post(url), api_key)
        .timeout(Duration::from_secs(10))
        .json(&body)
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            // Drained (capped) rather than dropped so the connection returns to
            // the pool. A body we can't parse still means the hint landed.
            let _ = json_capped_to::<serde::de::IgnoredAny>(r, super::MAX_META_BODY).await;
            true
        }
        _ => false,
    }
}
