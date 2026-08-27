//! Batch transcription: `POST /v1/audio/transcriptions` (multipart).

use super::{base_url, body_capped_to, client, detail_from, friendly_err, json_capped, with_auth, MAX_ERROR_BODY};
use anyhow::{bail, Context};
use reqwest::multipart::Part;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// Generous per-request ceiling for the Transcribe screen's file upload: an hour-long
/// recording on a CPU-only / slow backend can legitimately decode for many minutes — far
/// longer than the shared client's 120 s default, which is sized for short dictation clips
/// and the status polls. Without this, a long file failed with a spurious "Timed out" while
/// the server was still working, losing the result. Still bounded so a black-holed server
/// can't hang the screen forever. The dictation batch path keeps the 120 s default (its only
/// stuck-session backstop).
const FILE_TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(3600);

/// Mirrors `session.rs`'s cap on the same list from the dictation path.
const MAX_OVERRIDE_NOTICES: usize = 50;
/// A BCP-47 tag; the longest real ones are ~35 characters.
const LANGUAGE_MAX: usize = 64;
/// Speaker labels are identity-adjacent server strings ("SPEAKER_00" or
/// whatever a third-party server invents) — bound them like `language`.
const SPEAKER_MAX: usize = 64;
/// The server clamps speaker hints to 1..32; a well-behaved response can't
/// exceed that, so anything longer is a hostile/broken server.
const MAX_SPEAKERS_LISTED: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Diarization label, when the server ran the stage. Single word — the
    /// camelCase rename is a no-op, so it round-trips to TS unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

/// Per-run stage options for the Transcribe screen (dictation passes None).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOptions {
    /// "translate" → whisper's translate-to-English task; anything else /
    /// absent → plain transcription (the field is then omitted on the wire).
    pub task: Option<String>,
    pub diarize: Option<bool>,
    pub num_speakers: Option<u32>,
    pub min_speakers: Option<u32>,
    pub max_speakers: Option<u32>,
    /// Strip background music (UVR) server-side before decoding.
    pub separate_bgm: Option<bool>,
    /// Client-generated hex id the server keys live progress under
    /// (GET /v1/audio/transcriptions/progress/<id> while the POST runs).
    pub progress_id: Option<String>,
    /// Route a translate run to POST /v1/audio/translations (the OpenAI
    /// endpoint) instead of the full backend's `task` form field — used when
    /// the backend is a plain OpenAI-compatible server.
    pub use_translations_endpoint: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Seconds of audio that survived the server's VAD (only when the filter
    /// ran) — lets the UI warn when silence-skipping ate most of the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_after_vad: Option<f64>,
    /// Per-segment timestamps from verbose_json. Empty when the server omits them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Segment>,
    /// Flat word-level timestamps (verbose_json `words`). Deliberately
    /// unbounded like `text` — that IS the output.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<Word>,
    /// Distinct diarization labels in order of first appearance.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub speakers: Vec<String>,
    /// Soft-failed optional stages (e.g. diarization unavailable) explain
    /// themselves here instead of failing the whole request.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Client decode overrides the server refused because the field is
    /// admin-locked (verbose_json only). Empty ⇒ omitted to the frontend.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub overrides_ignored: Vec<String>,
}

#[derive(Deserialize)]
struct VerboseJson {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    duration_after_vad: Option<f64>,
    #[serde(default)]
    segments: Vec<Segment>,
    #[serde(default)]
    words: Vec<Word>,
    #[serde(default)]
    speakers: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    overrides_ignored: Vec<String>,
}

/// Progress ids are client-generated lowercase hex (a UUID without dashes) —
/// validated before they reach a form field or, critically, a URL path.
fn is_progress_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Live progress of an in-flight file transcription (see BatchOptions::progress_id).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub duration: Option<f64>,
    /// Seconds of audio decoded so far (transcribe stage).
    #[serde(default)]
    pub position: Option<f64>,
    /// Diarization pipeline's current step name.
    #[serde(default)]
    pub step: Option<String>,
    /// The last decoded segment's text (transcribe stage live tail). The
    /// server speaks snake_case; we re-emit camelCase to the webview.
    #[serde(default, alias = "last_text")]
    pub last_text: Option<String>,
    /// Active stage's model / device / compute type.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub compute: Option<String>,
    /// Fraction of the audio the VAD kept (0..1), once decoding starts; null
    /// when the filter was off. snake_case on the wire like `last_text`.
    #[serde(default, alias = "vad_retained")]
    pub vad_retained: Option<f64>,
    /// Requested pipeline stages the server declined to run (feature disabled
    /// there) — e.g. ["separating"]. Authoritative "skipped" signal for the
    /// client's rail; absent on older backends (the client then infers).
    #[serde(default)]
    pub skipped: Option<Vec<String>>,
}

/// Poll the server-side progress entry for `progress_id`. Cheap and frequent —
/// uses the shared client's default timeout.
pub async fn progress(
    server_url: &str,
    api_key: Option<&str>,
    progress_id: &str,
) -> anyhow::Result<BatchProgress> {
    if !is_progress_id(progress_id) {
        bail!("malformed progress id");
    }
    let base = base_url(server_url);
    let resp = with_auth(
        client().get(format!("{base}/v1/audio/transcriptions/progress/{progress_id}")),
        api_key,
    )
    .send()
    .await
    .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("HTTP {}", status.as_u16());
    }
    let parsed: BatchProgress = json_capped::<BatchProgress>(resp)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(BatchProgress {
        // Server strings rendered as UI labels — bound every one of them.
        stage: parsed
            .stage
            .map(|s| super::bounded_server_text(&s, 32)),
        step: parsed.step.map(|s| super::bounded_server_text(&s, 48)),
        last_text: parsed
            .last_text
            .map(|s| super::bounded_server_text(&s, 400)),
        model: parsed.model.map(|s| super::bounded_server_text(&s, 128)),
        device: parsed.device.map(|s| super::bounded_server_text(&s, 32)),
        compute: parsed.compute.map(|s| super::bounded_server_text(&s, 32)),
        // Only two stage names are ever legitimate here — cap accordingly.
        skipped: parsed.skipped.map(|v| {
            v.into_iter()
                .take(4)
                .map(|s| super::bounded_server_text(&s, 32))
                .collect()
        }),
        ..parsed
    })
}

/// Ask the server to abort the in-flight transcription posted with this
/// progress id. Dropping the upload connection alone does NOT stop the
/// server-side work (its pipeline stages run in executor threads), so the
/// Cancel button calls this too. Best-effort: an older/standard server
/// without the endpoint just answers 404.
pub async fn cancel(
    server_url: &str,
    api_key: Option<&str>,
    progress_id: &str,
) -> anyhow::Result<()> {
    if !is_progress_id(progress_id) {
        bail!("malformed progress id");
    }
    let base = base_url(server_url);
    let resp = with_auth(
        client().post(format!("{base}/v1/audio/transcriptions/cancel/{progress_id}")),
        api_key,
    )
    .send()
    .await
    .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("HTTP {}", status.as_u16());
    }
    Ok(())
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("mp4") | Some("aac") => "audio/mp4",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("webm") => "audio/webm",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Transcribe a file from disk (used by the Transcribe screen).
pub async fn transcribe(
    server_url: &str,
    api_key: Option<&str>,
    model: &str,
    language: &str,
    prompt: Option<&str>,
    overrides: Option<&serde_json::Value>,
    override_profile: Option<&str>,
    file_path: &str,
    options: Option<BatchOptions>,
) -> anyhow::Result<BatchResult> {
    let path = Path::new(file_path);
    let filename = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("audio")
        .to_string();
    let mime = mime_for(path);
    // Read off the runtime's worker pool: a large file on slow/network storage shouldn't park a
    // tokio worker thread that's also servicing other IPC (chip focus, audio-level events).
    let read_path = file_path.to_string();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&read_path))
        .await
        .context("file-read task panicked")?
        .with_context(|| format!("reading {file_path}"))?;
    let part = Part::bytes(bytes).file_name(filename).mime_str(mime)?;
    // File upload (Transcribe screen): a long recording can decode for many minutes — allow it.
    post(server_url, api_key, model, language, prompt, overrides, override_profile, part, Some(FILE_TRANSCRIBE_TIMEOUT), options).await
}

/// Transcribe an in-memory WAV (used by batch-mode dictation recording).
pub async fn transcribe_wav_bytes(
    server_url: &str,
    api_key: Option<&str>,
    model: &str,
    language: &str,
    prompt: Option<&str>,
    overrides: Option<&serde_json::Value>,
    override_profile: Option<&str>,
    wav: Vec<u8>,
) -> anyhow::Result<BatchResult> {
    let part = Part::bytes(wav).file_name("recording.wav").mime_str("audio/wav")?;
    // Dictation batch: short clips; keep the 120 s client default (the record path's only
    // stuck-session backstop, since the streaming-style finalize watchdog is stream-only).
    // No stage options: dictation never diarizes/translates.
    post(server_url, api_key, model, language, prompt, overrides, override_profile, part, None, None).await
}

async fn post(
    server_url: &str,
    api_key: Option<&str>,
    model: &str,
    language: &str,
    prompt: Option<&str>,
    overrides: Option<&serde_json::Value>,
    override_profile: Option<&str>,
    file_part: Part,
    timeout: Option<Duration>,
    options: Option<BatchOptions>,
) -> anyhow::Result<BatchResult> {
    let opts = options.unwrap_or_default();
    let translate = opts.task.as_deref() == Some("translate");
    // Standard OpenAI servers have no `task` field — translation is its own
    // endpoint there. The full backend accepts both spellings.
    let use_translations_route = translate && opts.use_translations_endpoint.unwrap_or(false);

    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", model.to_string())
        .text("response_format", "verbose_json")
        // Explicit word granularity: the full backend defaults words ON for
        // verbose_json anyway (same wire result), and standard servers need
        // the explicit ask — so word timestamps work against both kinds.
        .text("timestamp_granularities[]", "word");

    if translate && !use_translations_route {
        form = form.text("task", "translate");
    }
    if let Some(d) = opts.diarize {
        form = form.text("diarize", if d { "true" } else { "false" });
    }
    if let Some(n) = opts.num_speakers {
        form = form.text("num_speakers", n.to_string());
    }
    if let Some(n) = opts.min_speakers {
        form = form.text("min_speakers", n.to_string());
    }
    if let Some(n) = opts.max_speakers {
        form = form.text("max_speakers", n.to_string());
    }
    if let Some(s) = opts.separate_bgm {
        form = form.text("separate_bgm", if s { "true" } else { "false" });
    }
    if let Some(pid) = opts.progress_id.as_deref() {
        if is_progress_id(pid) {
            form = form.text("progress_id", pid.to_string());
        }
    }

    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    // prompt sentinel: None → omit the field (server inherits DEFAULT_PROMPT);
    // Some (incl. "") → send it, where "" CLEARS the prompt (reqwest transmits an
    // empty text part; the server reads the raw form to keep "" distinct from absent).
    if let Some(p) = prompt {
        form = form.text("prompt", p.to_string());
    }
    // Per-request decode overrides as a JSON Form field (only when non-empty).
    if let Some(v) = overrides {
        if v.as_object().map_or(false, |m| !m.is_empty()) {
            if let Ok(s) = serde_json::to_string(v) {
                form = form.text("decode_overrides", s);
            }
        }
    }
    // Per-request server override-profile name (only when non-empty).
    if let Some(p) = override_profile {
        if !p.is_empty() {
            form = form.text("override_profile", p.to_string());
        }
    }

    let base = base_url(server_url);
    let endpoint = if use_translations_route {
        "/v1/audio/translations"
    } else {
        "/v1/audio/transcriptions"
    };
    let mut req = with_auth(client().post(format!("{base}{endpoint}")), api_key)
        .multipart(form);
    // Per-request override of the shared client's 120 s default (reqwest's RequestBuilder::timeout
    // replaces the client-level timeout for this request only). Only the file-upload path sets it;
    // dictation passes None and keeps the 120 s default.
    if let Some(t) = timeout {
        req = req.timeout(t);
    }
    // Classify connect/timeout failures the same way discovery/pipeline/streaming do, so the
    // Transcribe screen and batch dictation show "Could not connect…" / "Timed out…" instead of
    // a raw reqwest error chain.
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;

    let status = resp.status();
    if !status.is_success() {
        let body = body_capped_to(resp, MAX_ERROR_BODY).await.unwrap_or_default();
        bail!("HTTP {}: {}", status.as_u16(), detail_from(&body));
    }

    let parsed: VerboseJson = json_capped::<VerboseJson>(resp)
        .await
        .map_err(|e| anyhow::anyhow!(e))
        .context("decoding response")?;
    // The dictation sibling caps this same pair on the way out (session.rs); the file-upload arm
    // returned them straight off the wire, so the Transcribe screen rendered a server string
    // bounded only by the 32 MiB body cap. `text` is deliberately untouched — that IS the output.
    Ok(BatchResult {
        text: parsed.text,
        language: parsed
            .language
            .map(|s| super::bounded_server_text(&s, LANGUAGE_MAX)),
        duration: parsed.duration,
        duration_after_vad: parsed.duration_after_vad,
        // Segment text stays untouched (it IS the output); the speaker label
        // is an identity-adjacent server string rendered as a chip and pasted
        // into exports — bound it like `language`.
        segments: parsed
            .segments
            .into_iter()
            .map(|mut s| {
                s.speaker = s
                    .speaker
                    .map(|sp| super::bounded_server_text(&sp, SPEAKER_MAX));
                s
            })
            .collect(),
        words: parsed.words,
        speakers: parsed
            .speakers
            .iter()
            .take(MAX_SPEAKERS_LISTED)
            .map(|s| super::bounded_server_text(s, SPEAKER_MAX))
            .collect(),
        warnings: parsed
            .warnings
            .iter()
            .take(MAX_OVERRIDE_NOTICES)
            .map(|s| super::bounded_server_text(s, super::MAX_ERROR_TEXT))
            .collect(),
        overrides_ignored: parsed
            .overrides_ignored
            .iter()
            .take(MAX_OVERRIDE_NOTICES)
            .map(|s| super::bounded_server_text(s, super::MAX_ERROR_TEXT))
            .collect(),
    })
}
