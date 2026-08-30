//! POST /v1/text/translations — segment texts in, per-segment translations
//! out. Serves dictation settle-time translation, the viewer's re-translate,
//! retro-translation from History, and subtitle/text-file sources.

use super::{base_url, bounded_server_text, client, detail_from, friendly_err, json_capped, with_auth, MAX_ERROR_TEXT};
use anyhow::bail;
use std::collections::BTreeMap;

/// Client-side ceilings — the server has its own (4 MiB JSON body, 200k chars
/// total); these just keep an accidental monster request from leaving the app.
const MAX_TEXTS: usize = 512;
const MAX_TARGETS: usize = 8;

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
}

/// The IPC-facing result: `results[i]` is the translations map for input i
/// (empty map when the server skipped it), plus bounded provenance.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextTranslationResult {
    pub results: Vec<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
) -> anyhow::Result<TextTranslationResult> {
    if texts.is_empty() {
        bail!("nothing to translate");
    }
    if texts.len() > MAX_TEXTS {
        bail!("too many segments in one request (max {MAX_TEXTS})");
    }
    // Screen target codes like batch.rs does before they join the wire.
    let targets: Vec<String> = targets
        .iter()
        .filter(|t| {
            (2..=16).contains(&t.len())
                && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .cloned()
        .collect();
    if targets.is_empty() || targets.len() > MAX_TARGETS {
        bail!("between 1 and {MAX_TARGETS} valid target languages");
    }
    let targets = &targets[..];
    let body = RequestBody {
        segments: texts.iter().enumerate().map(|(id, t)| SegmentIn { id, text: t }).collect(),
        targets,
        source: source.filter(|s| !s.is_empty()),
        translation_model: model.filter(|s| !s.is_empty()),
        translation_mode: mode.filter(|s| !s.is_empty()),
        translation_glossary: glossary.filter(|s| !s.trim().is_empty()),
        context_segments,
    };
    let base = base_url(server_url);
    let resp = with_auth(client().post(format!("{base}/v1/text/translations")), api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        let body = super::body_capped_to(resp, super::MAX_ERROR_BODY)
            .await
            .unwrap_or_default();
        bail!("HTTP {}: {}", status.as_u16(), detail_from(&body));
    }
    let parsed: ResponseBody = json_capped::<ResponseBody>(resp)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    // Re-order by id into a dense list aligned with the input; translation
    // VALUES are output (untouched), the language-code keys get bounded.
    let mut results: Vec<BTreeMap<String, String>> = (0..texts.len()).map(|_| BTreeMap::new()).collect();
    for seg in parsed.segments {
        if let Some(slot) = results.get_mut(seg.id) {
            *slot = seg
                .translations
                .into_iter()
                .map(|(k, v)| (bounded_server_text(&k, 16), v))
                .collect();
        }
    }
    Ok(TextTranslationResult {
        results,
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
            .take(20)
            .map(|w| bounded_server_text(w, MAX_ERROR_TEXT))
            .collect(),
    })
}
