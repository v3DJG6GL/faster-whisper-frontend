//! Model pre-warm hint (`POST /v1/models/preload`, full backend only).
//!
//! Best-effort in exactly the sense `discovery`'s probes are: the endpoint is a
//! HINT, never a precondition. An older backend answers 404 and a disallowed
//! model / disabled stage answers 202 with `state: "deferred"` — both must be
//! indistinguishable from success to the user, so nothing here is surfaced.

use super::{base_url, client, with_auth};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The backend accepts 1..6 entries and rejects anything else with a 422, so
/// clamp here rather than letting a caller's plan turn into a hard error.
const MAX_ENTRIES: usize = 6;
/// Bound on the `family` echoed back: it is one of four short literals (`whisper`,
/// `diarization`, `separation`, `translation`), so this only keeps a bogus value small.
const FAMILY_MAX: usize = 120;
/// The server's own bound on a preload id (`PreloadModel.id`, `Field(min_length=1,
/// max_length=128)` in the backend's runtime/preload_routes.py). Lower than
/// [`super::MODEL_ID_MAX`], so an id the pickers keep may still be too long to hint: such an
/// entry is DROPPED, never cut — a cut id names no model, and one over the bound would 422
/// the whole plan.
const PRELOAD_ID_MAX: usize = 128;

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

/// The request body for a plan, or None when no entry is left to send. Entries with an id past
/// [`PRELOAD_ID_MAX`], or one that is blank once folded (an id of invisible characters only folds
/// to "", which the server's `min_length=1` would answer with a 422 for the whole plan), are
/// dropped BEFORE the [`MAX_ENTRIES`] clamp, so a dropped one doesn't push a sendable one out.
fn plan_body(models: Vec<PreloadModel>) -> Option<PreloadReq> {
    let models: Vec<PreloadModel> = models
        .into_iter()
        .filter_map(|m| {
            Some(PreloadModel {
                // The model-id rule at the server's own bound: within it nothing is cut.
                id: super::model_id_within(&m.id, PRELOAD_ID_MAX)?,
                family: super::bounded_server_text(&m.family, FAMILY_MAX),
            })
        })
        .take(MAX_ENTRIES)
        .collect();
    (!models.is_empty()).then_some(PreloadReq {
        models,
        // Server-driven stage-ahead: the backend walks the plan forward on its
        // own as stages complete, so the client never has to re-POST mid-run.
        stage_ahead: true,
    })
}

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
    let Some(body) = plan_body(models) else {
        return false;
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
            // the pool. The hint landed whatever the body says, so it isn't parsed.
            let _ = super::body_capped_to(r, super::MAX_META_BODY).await;
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{plan_body, PreloadModel, MAX_ENTRIES};

    fn entry(family: &str, id: &str) -> PreloadModel {
        PreloadModel {
            family: family.into(),
            id: id.into(),
        }
    }

    fn ids(models: Vec<PreloadModel>) -> Option<Vec<String>> {
        plan_body(models).map(|b| b.models.into_iter().map(|m| m.id).collect())
    }

    #[test]
    fn an_id_within_the_server_bound_is_sent_whole() {
        let id = format!("org/{}", "m".repeat(121));
        assert_eq!(id.chars().count(), 125);
        assert_eq!(ids(vec![entry("whisper", &id)]), Some(vec![id]));
    }

    #[test]
    fn a_too_long_id_is_dropped_and_the_rest_still_go() {
        // 129..=200 characters: kept by the pickers but over the server's bound; and past 200.
        for long in ["m".repeat(150), "m".repeat(250)] {
            let plan = vec![entry("whisper", &long), entry("diarization", "pyannote/x")];
            assert_eq!(ids(plan), Some(vec!["pyannote/x".to_string()]));
        }
    }

    #[test]
    fn dropped_entries_do_not_count_against_the_entry_clamp() {
        let mut plan = vec![entry("whisper", "  "), entry("whisper", &"m".repeat(129))];
        plan.extend((0..MAX_ENTRIES).map(|i| entry("whisper", &format!("m{i}"))));
        assert_eq!(ids(plan).map(|v| v.len()), Some(MAX_ENTRIES));
    }

    #[test]
    fn an_id_that_folds_to_nothing_is_dropped_not_sent_blank() {
        // `trim()` keeps a zero-width space; the fold deletes it, and a blank id 422s the plan.
        for blank in ["\u{200B}", "\u{2060}\u{200F}", " \u{200B} "] {
            assert_eq!(
                ids(vec![entry("whisper", blank), entry("whisper", "m1")]),
                Some(vec!["m1".to_string()])
            );
        }
    }

    #[test]
    fn a_plan_with_nothing_left_is_not_sent() {
        assert!(plan_body(vec![]).is_none());
        assert!(plan_body(vec![
            entry("whisper", &"m".repeat(150)),
            entry("whisper", " ")
        ])
        .is_none());
    }
}
