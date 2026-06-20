//! Batch transcription: `POST /v1/audio/transcriptions` (multipart).

use super::{base_url, client, detail_from, friendly_err, with_auth};
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
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
    overrides_ignored: Vec<String>,
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
    post(server_url, api_key, model, language, prompt, overrides, override_profile, part, Some(FILE_TRANSCRIBE_TIMEOUT)).await
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
    post(server_url, api_key, model, language, prompt, overrides, override_profile, part, None).await
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
) -> anyhow::Result<BatchResult> {
    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", model.to_string())
        .text("response_format", "verbose_json");

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
    let mut req = with_auth(client().post(format!("{base}/v1/audio/transcriptions")), api_key)
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
        let body = resp.text().await.unwrap_or_default();
        bail!("HTTP {}: {}", status.as_u16(), detail_from(&body));
    }

    let parsed: VerboseJson = resp.json().await.context("decoding response")?;
    Ok(BatchResult {
        text: parsed.text,
        language: parsed.language,
        duration: parsed.duration,
        overrides_ignored: parsed.overrides_ignored,
    })
}
