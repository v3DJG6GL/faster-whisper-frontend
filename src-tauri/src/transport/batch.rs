//! Batch transcription: `POST /v1/audio/transcriptions` (multipart).

use super::{base_url, client, with_auth};
use anyhow::{bail, Context};
use reqwest::multipart::Part;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

#[derive(Deserialize)]
struct VerboseJson {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
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
    prompt: &str,
    file_path: &str,
) -> anyhow::Result<BatchResult> {
    let path = Path::new(file_path);
    let bytes = std::fs::read(path).with_context(|| format!("reading {file_path}"))?;
    let filename = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("audio")
        .to_string();
    let part = Part::bytes(bytes).file_name(filename).mime_str(mime_for(path))?;
    post(server_url, api_key, model, language, prompt, part).await
}

/// Transcribe an in-memory WAV (used by batch-mode dictation recording).
pub async fn transcribe_wav_bytes(
    server_url: &str,
    api_key: Option<&str>,
    model: &str,
    language: &str,
    prompt: &str,
    wav: Vec<u8>,
) -> anyhow::Result<BatchResult> {
    let part = Part::bytes(wav).file_name("recording.wav").mime_str("audio/wav")?;
    post(server_url, api_key, model, language, prompt, part).await
}

async fn post(
    server_url: &str,
    api_key: Option<&str>,
    model: &str,
    language: &str,
    prompt: &str,
    file_part: Part,
) -> anyhow::Result<BatchResult> {
    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", model.to_string())
        .text("response_format", "verbose_json");

    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }

    let base = base_url(server_url);
    let resp = with_auth(client().post(format!("{base}/v1/audio/transcriptions")), api_key)
        .multipart(form)
        .send()
        .await
        .context("request failed")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
            .unwrap_or(body);
        bail!("HTTP {}: {}", status.as_u16(), detail);
    }

    let parsed: VerboseJson = resp.json().await.context("decoding response")?;
    Ok(BatchResult {
        text: parsed.text,
        language: parsed.language,
        duration: parsed.duration,
    })
}
