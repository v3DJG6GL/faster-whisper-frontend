//! POST /v1/text/translations — segment texts in, per-segment translations
//! out. Serves dictation settle-time translation, the viewer's re-translate,
//! retro-translation from History, and subtitle/text-file sources.

use super::{base_url, bounded_server_text, client, detail_from, friendly_err, json_capped, with_auth, MAX_ERROR_TEXT};
use anyhow::bail;
use std::collections::BTreeMap;
use std::time::Duration;

/// Client-side ceilings — the server has its own (4 MiB JSON body, 200k chars
/// total); these just keep an accidental monster request from leaving the app.
const MAX_TEXTS: usize = 512;
use super::MAX_TARGETS;

/// Generous per-request ceiling for translation runs — same failure mode as
/// batch.rs's `FILE_TRANSCRIBE_TIMEOUT`: a 400-segment chunk against a slow /
/// CPU-only MT backend (or one that first has to download the model) can
/// legitimately work for many minutes — far longer than the shared client's
/// 120 s default, which is sized for dictation clips and status polls. Without
/// this, a long retro-translate failed with a spurious "Timed out" while the
/// server was still translating, losing the chunk. Still bounded so a
/// black-holed server can't hang the run forever. (The latency-critical
/// dictation path races the call against its own much shorter budget in JS,
/// so it is unaffected by this ceiling.)
const TEXT_TRANSLATE_TIMEOUT: Duration = Duration::from_secs(3600);

#[derive(serde::Serialize)]
struct RequestBody<'a> {
    segments: Vec<SegmentIn<'a>>,
    targets: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation_model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation_mode: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation_glossary: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_segments: Option<u32>,
    /// Keys the server-side progress entry (GET progress / POST cancel — the
    /// same endpoints batch transcription uses). Optional: older backends
    /// ignore unknown fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    progress_id: Option<&'a str>,
    /// The capture row whose per-utterance log receipt the server is holding
    /// open, waiting for this translation to complete it. Omitted for every
    /// non-dictation caller (a subtitle file, the viewer's retro-translate),
    /// which the server treats as "nothing held" rather than an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    captured_id: Option<&'a str>,
}

#[derive(serde::Serialize)]
struct SegmentIn<'a> {
    id: usize,
    text: &'a str,
}

#[derive(serde::Deserialize)]
struct ResponseBody {
    #[serde(default)]
    segments: Vec<SegmentOut>,
    #[serde(default)]
    translation: Option<super::batch::TranslationInfo>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(serde::Deserialize)]
struct SegmentOut {
    id: usize,
    #[serde(default)]
    translations: BTreeMap<String, String>,
    /// Target codes whose `translations` entry kept the SOURCE text (the
    /// server's quality guard rejected the MT output) — the frontend must
    /// not present those as translations.
    #[serde(default)]
    kept_original: Vec<String>,
}

/// The IPC-facing result: `results[i]` is the translations map for input i
/// (empty map when the server skipped it), plus bounded provenance.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextTranslationResult {
    pub results: Vec<BTreeMap<String, String>>,
    /// `kept[i]` = target codes for which `results[i]` carries the source
    /// text unchanged (quality guard) — dense, aligned with `results`.
    pub kept: Vec<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Assemble the request body, applying each field's own present-vs-absent rule.
///
/// `source` and `translation_glossary` ride through on PRESENCE alone: `None` omits
/// the key, `Some(s)` sends it verbatim — `""` included. For the GLOSSARY the server
/// really distinguishes the two, resolving an empty one through the same knob ladder the
/// batch form uses ("no glossary", overriding whatever would otherwise be inherited).
/// `source` rides through the same way for wire fidelity only: the server collapses `""`
/// and absent to the same auto-detect (`source_lang=(source or None)`), so do NOT build
/// another explicit-empty override on it. Emptiness filters here collapsed both onto "absent", so a
/// glossary the user had explicitly cleared came back from the server's own config on
/// every dictation settle, retro-translate and subtitle run — the one path the batch
/// form's fix did not cover.
///
/// `translation_model` / `translation_mode` keep their truthiness prune: their controls
/// offer a real "Inherit" row, so `""` there is the absence of a choice, not a choice.
/// The two ids are screened, not tri-state — an empty id names nothing.
#[allow(clippy::too_many_arguments)]
fn build_request_body<'a>(
    texts: &'a [String],
    targets: &'a [String],
    source: Option<&'a str>,
    model: Option<&'a str>,
    mode: Option<&'a str>,
    glossary: Option<&'a str>,
    context_segments: Option<u32>,
    progress_id: Option<&'a str>,
    captured_id: Option<&'a str>,
) -> RequestBody<'a> {
    RequestBody {
        segments: texts.iter().enumerate().map(|(id, t)| SegmentIn { id, text: t }).collect(),
        targets,
        source,
        translation_model: model.filter(|s| !s.is_empty()),
        translation_mode: mode.filter(|s| !s.is_empty()),
        translation_glossary: glossary,
        context_segments,
        progress_id: progress_id.filter(|s| !s.is_empty()),
        captured_id: captured_id.filter(|s| !s.is_empty()),
    }
}

#[cfg(test)]
mod request_body_tests {
    use super::build_request_body;

    fn body(source: Option<&str>, glossary: Option<&str>) -> serde_json::Value {
        let texts = vec!["hallo".to_string()];
        let targets = vec!["en".to_string()];
        serde_json::to_value(build_request_body(
            &texts, &targets, source, None, None, glossary, None, None, None,
        ))
        .unwrap()
    }

    #[test]
    fn an_explicitly_cleared_glossary_is_sent_and_an_absent_one_is_omitted() {
        // The distinction the whole change exists for: "" = no glossary (overrides the
        // server's own), absent = inherit it.
        assert_eq!(body(None, Some(""))["translation_glossary"], "");
        assert!(body(None, None).get("translation_glossary").is_none());
        assert_eq!(body(None, Some("a = b"))["translation_glossary"], "a = b");
    }

    #[test]
    fn a_whitespace_only_glossary_is_still_a_present_value() {
        // It used to be trimmed away into "absent", which re-inherited. The server owns
        // the decision about what an all-blank glossary means; the client just says it.
        assert_eq!(body(None, Some("   "))["translation_glossary"], "   ");
    }

    #[test]
    fn an_empty_source_is_sent_verbatim_not_pruned() {
        assert_eq!(body(Some(""), None)["source"], "");
        assert!(body(None, None).get("source").is_none());
        assert_eq!(body(Some("de"), None)["source"], "de");
    }

    #[test]
    fn model_and_mode_keep_their_truthiness_prune() {
        // Not tri-state: their pickers have an "Inherit" row, so "" is no choice at all.
        let texts = vec!["hallo".to_string()];
        let targets = vec!["en".to_string()];
        let v = serde_json::to_value(build_request_body(
            &texts,
            &targets,
            None,
            Some(""),
            Some(""),
            None,
            None,
            Some(""),
            Some(""),
        ))
        .unwrap();
        for key in ["translation_model", "translation_mode", "progress_id", "captured_id"] {
            assert!(v.get(key).is_none(), "{key} should be omitted");
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn translate_texts(
    server_url: &str,
    api_key: Option<&str>,
    texts: &[String],
    targets: &[String],
    source: Option<&str>,
    model: Option<&str>,
    mode: Option<&str>,
    glossary: Option<&str>,
    context_segments: Option<u32>,
    progress_id: Option<&str>,
    // The capture row whose log receipt the server is holding open for this
    // translation. Opaque here; the server links the two halves with it.
    captured_id: Option<&str>,
) -> anyhow::Result<TextTranslationResult> {
    if texts.is_empty() {
        bail!("nothing to translate");
    }
    if texts.len() > MAX_TEXTS {
        bail!("too many segments in one request (max {MAX_TEXTS})");
    }
    // The same screen the batch form applies; the CAP differs on purpose (refuse, don't
    // truncate — see `transport::MAX_TARGETS`).
    let targets: Vec<String> = targets.iter().filter(|t| super::is_lang_code(t)).cloned().collect();
    if targets.is_empty() || targets.len() > MAX_TARGETS {
        bail!("between 1 and {MAX_TARGETS} valid target languages");
    }
    let targets = &targets[..];
    let body = build_request_body(
        texts,
        targets,
        source,
        model,
        mode,
        glossary,
        context_segments,
        progress_id,
        captured_id,
    );
    let base = base_url(server_url);
    // Per-request override of the shared client's 120 s default (reqwest's
    // RequestBuilder::timeout replaces the client-level timeout for this
    // request only) — see TEXT_TRANSLATE_TIMEOUT for why.
    let resp = with_auth(client().post(format!("{base}/v1/text/translations")), api_key)
        .json(&body)
        .timeout(TEXT_TRANSLATE_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            // The viewer historically swallowed this error into a generic
            // toast — make sure the log carries the classified cause.
            let msg = friendly_err(&e);
            tracing::warn!("[text] translate request failed: {msg}");
            anyhow::anyhow!(msg)
        })?;
    let status = resp.status();
    if !status.is_success() {
        let body = super::body_capped_to(resp, super::MAX_ERROR_BODY)
            .await
            .unwrap_or_else(|reason| reason);
        let detail = detail_from(&body);
        tracing::warn!("[text] translate failed: HTTP {} {detail}", status.as_u16());
        bail!("HTTP {}: {}", status.as_u16(), detail);
    }
    let parsed: ResponseBody = json_capped::<ResponseBody>(resp)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    // Re-order by id into a dense list aligned with the input; translation
    // VALUES are output (untouched), the language-code keys get bounded.
    let mut results: Vec<BTreeMap<String, String>> = (0..texts.len()).map(|_| BTreeMap::new()).collect();
    let mut kept: Vec<Vec<String>> = (0..texts.len()).map(|_| Vec::new()).collect();
    for seg in parsed.segments {
        if let Some(slot) = results.get_mut(seg.id) {
            *slot = seg
                .translations
                .into_iter()
                .map(|(k, v)| (bounded_server_text(&k, 16), v))
                .collect();
            // Kept-original markers are language codes — bound like the
            // translation keys, capped at the target ceiling.
            kept[seg.id] = seg
                .kept_original
                .iter()
                .take(MAX_TARGETS)
                .map(|k| bounded_server_text(k, 16))
                .collect();
        }
    }
    Ok(TextTranslationResult {
        results,
        kept,
        model: parsed
            .translation
            .as_ref()
            .and_then(|t| t.model.as_deref())
            .map(|m| bounded_server_text(m, 128)),
        source: parsed
            .translation
            .as_ref()
            .and_then(|t| t.source.as_deref())
            .map(|s| bounded_server_text(s, 16)),
        warnings: parsed
            .warnings
            .iter()
            .take(super::MAX_NOTICES)
            .map(|w| bounded_server_text(w, MAX_ERROR_TEXT))
            .collect(),
    })
}
