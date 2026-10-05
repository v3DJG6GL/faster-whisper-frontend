//! Media export: upload a local video for packaging (`POST /v1/audio/media`,
//! raw body, streamed), read a retained file's stream facts
//! (`GET /v1/audio/media/{id}/streams`), and package a retained video with
//! subtitle tracks straight to a user-picked path
//! (`POST /v1/audio/media/{id}/package`, streamed to disk with a cap).

use super::{
    base_url, body_capped_to, client, detail_from, ensure_ok, error_detail, friendly_err,
    gate_media_id, json_capped_to, with_auth, MAX_ERROR_BODY, MAX_META_BODY,
};
use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub const MAX_TRACKS: usize = 12;
pub const MAX_SRT_BYTES: usize = 2 * 1024 * 1024;
/// A 10 GB upload or download on a slow link: hours, not the run's ceiling.
pub const MEDIA_EXPORT_TIMEOUT: Duration = Duration::from_secs(4 * 3600);

/// One subtitle track as the webview sends it (already-generated SRT text).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub lang: String,
    #[serde(default)]
    pub label: Option<String>,
    pub srt: String,
    /// Written in the spoken language (Matroska FlagOriginal).
    #[serde(default)]
    pub original: bool,
    /// Its language's default track.
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub hearing_impaired: bool,
}

/// The longest track title the server keeps.
pub const MAX_LABEL_CHARS: usize = 64;

/// A track title as the server takes it: control and bidi/format characters
/// dropped, bounded, blank = none.
pub fn bound_label(label: Option<&str>) -> Option<String> {
    label
        .map(|l| super::clean_text(l, MAX_LABEL_CHARS))
        .filter(|l| !l.trim().is_empty())
}

/// The longest language code the package route takes — its regex is
/// `[a-z]{2,3}(-[A-Za-z0-9]{2,8})?`, tighter than [`super::is_lang_code`]'s 16.
const MAX_PACKAGE_LANG: usize = 12;

/// A subtitle-track / audio language code the package route will accept.
pub fn is_package_lang(l: &str) -> bool {
    l.len() <= MAX_PACKAGE_LANG && super::is_lang_code(l)
}

/// The wire's `subtitles` list: each track with its (bounded) title and
/// flags — a server before the flags ignores them and reads the legacy
/// `default_track` / `original_track` indices instead.
fn subtitles_json(subtitles: &[SubtitleTrack]) -> Vec<serde_json::Value> {
    subtitles
        .iter()
        .map(|t| {
            serde_json::json!({
                "lang": t.lang, "label": bound_label(t.label.as_deref()), "srt": t.srt,
                "original": t.original, "default": t.default, "hearing_impaired": t.hearing_impaired,
            })
        })
        .collect()
}

/// Codec facts the export panel decides MP4 vs MKV on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreams {
    #[serde(default, alias = "video_codec")]
    pub video_codec: Option<String>,
    #[serde(default, alias = "audio_codec")]
    pub audio_codec: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default, alias = "mp4_ok")]
    pub mp4_ok: bool,
    #[serde(default, alias = "mp4_reason")]
    pub mp4_reason: Option<String>,
}

fn bound_streams(s: MediaStreams) -> MediaStreams {
    MediaStreams {
        video_codec: s.video_codec.map(|v| super::bounded_server_text(&v, 32)),
        audio_codec: s.audio_codec.map(|v| super::bounded_server_text(&v, 32)),
        mp4_reason: s
            .mp4_reason
            .map(|v| super::bounded_server_text(&v, super::MAX_ERROR_TEXT)),
        width: s.width.filter(|w| (1..=16384).contains(w)),
        height: s.height.filter(|h| (1..=16384).contains(h)),
        duration: s.duration.filter(|d| d.is_finite() && *d >= 0.0),
        ..s
    }
}

/// What the webview gets back from `package_media`. `kind` is the outcome
/// the panel branches on; `detail` is always a client-safe sentence.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageOutcome {
    pub kind: &'static str,
    pub detail: String,
    pub bytes: u64,
    pub media_id: Option<String>,
    pub expires_at: Option<i64>,
    pub reason: Option<String>,
    pub streams: Option<MediaStreams>,
}

impl PackageOutcome {
    pub fn err_pub(kind: &'static str, detail: impl Into<String>) -> Self {
        Self::err(kind, detail)
    }

    fn err(kind: &'static str, detail: impl Into<String>) -> Self {
        PackageOutcome {
            kind,
            detail: detail.into(),
            bytes: 0,
            media_id: None,
            expires_at: None,
            reason: None,
            streams: None,
        }
    }
}

/// One progress event for the export panel (`media://export-progress`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: String,
    pub phase: &'static str,
    pub done: u64,
    pub total: Option<u64>,
}

pub type Progress = Arc<dyn Fn(&'static str, u64, Option<u64>) + Send + Sync>;

#[derive(Debug, Deserialize)]
struct UploadAnswer {
    #[serde(alias = "media_id")]
    media_id: String,
    #[serde(default, alias = "expires_at")]
    expires_at: Option<i64>,
}

pub enum UploadOutcome {
    Ok {
        media_id: String,
        expires_at: Option<i64>,
    },
    /// A status the panel can name (413 too large, 429 rate, 403 off, 503 no ffmpeg).
    Http { status: u16, detail: String },
}

/// Stream a local file into the server's media store: `POST /v1/audio/media?ext=…`
/// with the raw bytes as the body and the length declared (the server's
/// early 413 fires before a byte moves).
pub async fn upload_media(
    server_url: &str,
    api_key: Option<&str>,
    path: &Path,
    max_bytes: u64,
    progress: Progress,
) -> anyhow::Result<UploadOutcome> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| (1..=5).contains(&e.len()) && e.bytes().all(|b| b.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "bin".into());
    let file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("opening {}", path.display()))?;
    let meta = file.metadata().await.context("reading the file")?;
    if !meta.is_file() {
        bail!("not a file");
    }
    let len = meta.len();
    if len > max_bytes {
        return Ok(UploadOutcome::Http {
            status: 413,
            detail: "the video is larger than the server's limit".into(),
        });
    }
    let p = progress.clone();
    let on_read: Arc<dyn Fn(u64) + Send + Sync> =
        Arc::new(move |sent| p("uploading", sent, Some(len)));
    let body = reqwest::Body::wrap_stream(super::file_stream(file, Some(on_read)));
    let base = base_url(server_url);
    let resp = with_auth(
        client()
            .post(format!("{base}/v1/audio/media?ext={ext}"))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(body),
        api_key,
    )
    .timeout(MEDIA_EXPORT_TIMEOUT)
    .send()
    .await
    .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;
    if !resp.status().is_success() {
        let (status, detail) = error_detail(resp).await;
        return Ok(UploadOutcome::Http { status, detail });
    }
    let parsed: UploadAnswer = json_capped_to::<UploadAnswer>(resp, MAX_META_BODY)
        .await
        .map_err(|e| anyhow::anyhow!(e))
        .context("decoding the upload answer")?;
    gate_media_id(&parsed.media_id).context("the server answered with a malformed media id")?;
    Ok(UploadOutcome::Ok {
        media_id: parsed.media_id,
        expires_at: parsed.expires_at,
    })
}

/// Codec facts for a retained file; `None` when the server no longer has it.
pub async fn get_streams(
    server_url: &str,
    api_key: Option<&str>,
    media_id: &str,
) -> anyhow::Result<Option<MediaStreams>> {
    gate_media_id(media_id)?;
    let base = base_url(server_url);
    let resp = with_auth(
        client().get(format!("{base}/v1/audio/media/{media_id}/streams")),
        api_key,
    )
    .timeout(Duration::from_secs(60))
    .send()
    .await
    .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    let parsed: MediaStreams =
        json_capped_to::<MediaStreams>(ensure_ok(resp).await?, MAX_META_BODY)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Some(bound_streams(parsed)))
}

/// The 422 body of the package route: `{"detail": {"code", "message"}}` or a plain string.
/// A 429 names the refusing limit in `error.param` (`{"error": {"param", …}, "detail": "…"}`),
/// returned as the code.
fn error_code(body: &str) -> (Option<String>, String) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(d) = v.get("detail") {
            if let Some(obj) = d.as_object() {
                let code = obj
                    .get("code")
                    .and_then(|c| c.as_str())
                    .map(|c| c.to_string());
                let msg = obj
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(|m| super::bounded_server_text(m, super::MAX_ERROR_TEXT))
                    .unwrap_or_else(|| "packaging failed".into());
                return (code, msg);
            }
        }
        let param = v
            .pointer("/error/param")
            .and_then(|p| p.as_str())
            .map(|p| p.to_string());
        if param.is_some() {
            return (param, detail_from(body));
        }
    }
    (None, detail_from(body))
}

/// The limit a second concurrent export trips (another device of the same user): the app
/// waits and retries instead of failing.
const INFLIGHT_PARAM: &str = "MEDIA_PACKAGE_MAX_INFLIGHT_PER_USER";

/// The outcome kind of a non-2xx, non-404 package answer.
fn package_error_kind(status: u16, code: Option<&str>) -> &'static str {
    match (status, code) {
        (422, Some("mp4_incompatible")) => "mp4_incompatible",
        (422, Some("no_video")) => "no_video",
        (429, Some(INFLIGHT_PARAM)) => "busy",
        (429, _) => "rate_limited",
        (403, _) | (503, _) => "disabled",
        (413, _) => "too_large",
        _ => "error",
    }
}

/// Package `media_id` with `subtitles` and stream the result to `dest`
/// (tmp + rename, capped at `max_bytes`). Never fully resident.
#[allow(clippy::too_many_arguments)]
pub async fn package_to_path(
    server_url: &str,
    api_key: Option<&str>,
    media_id: &str,
    container: &str,
    subtitles: &[SubtitleTrack],
    default_track: Option<u32>,
    original_track: Option<u32>,
    audio_lang: Option<&str>,
    audio_label: Option<&str>,
    filename: &str,
    dest: &Path,
    max_bytes: u64,
    progress: Progress,
) -> anyhow::Result<PackageOutcome> {
    gate_media_id(media_id)?;
    let base = base_url(server_url);
    let body = serde_json::json!({
        "container": container,
        "subtitles": subtitles_json(subtitles),
        "default_track": default_track,
        "original_track": original_track,
        "audio_lang": audio_lang,
        "audio_label": audio_label,
        "filename": filename,
    });
    progress("packaging", 0, None);
    let mut resp = with_auth(
        client()
            .post(format!("{base}/v1/audio/media/{media_id}/package"))
            .json(&body),
        api_key,
    )
    .timeout(MEDIA_EXPORT_TIMEOUT)
    .send()
    .await
    .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(PackageOutcome::err(
            "expired",
            "the server no longer has this media",
        ));
    }
    if !resp.status().is_success() {
        let text = body_capped_to(resp, MAX_ERROR_BODY)
            .await
            .unwrap_or_else(|r| r);
        let (code, msg) = error_code(&text);
        let kind = package_error_kind(status, code.as_deref());
        let mut out = PackageOutcome::err(kind, msg.clone());
        if kind == "mp4_incompatible" {
            out.reason = Some(msg);
        }
        return Ok(out);
    }
    let total = resp.content_length();
    let ext = container.to_string();
    let tmp = {
        let mut t = dest.as_os_str().to_owned();
        t.push(".tmp");
        std::path::PathBuf::from(t)
    };
    let mut written: u64 = 0;
    let write_result: anyhow::Result<()> = async {
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::File::create(&tmp)
            .await
            .context("creating the export file")?;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| anyhow::anyhow!(friendly_err(&e)))?
        {
            written += chunk.len() as u64;
            if written > max_bytes {
                bail!("the packaged video is larger than this app's copy limit");
            }
            f.write_all(&chunk)
                .await
                .context("writing the export file")?;
            progress("downloading", written, total);
        }
        if written == 0 {
            bail!("the server sent no media");
        }
        f.flush().await.context("writing the export file")?;
        f.sync_all().await.context("writing the export file")?;
        Ok(())
    }
    .await;
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        anyhow::anyhow!("saving the export file: {e}")
    })?;
    let _ = ext;
    Ok(PackageOutcome {
        kind: "ok",
        detail: String::new(),
        bytes: written,
        media_id: Some(media_id.to_string()),
        expires_at: None,
        reason: None,
        streams: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_reads_structured_and_plain_details() {
        let (code, msg) =
            error_code(r#"{"detail":{"code":"mp4_incompatible","message":"MP4 can't carry VP9"}}"#);
        assert_eq!(code.as_deref(), Some("mp4_incompatible"));
        assert!(msg.contains("VP9"));
        let (code, msg) = error_code(r#"{"detail":"container must be mkv or mp4"}"#);
        assert!(code.is_none());
        assert!(msg.contains("container"));
    }

    #[test]
    fn a_second_inflight_export_is_busy_other_429s_stay_rate_limited() {
        let body = r#"{"error":{"message":"you already have 1 video export running","type":"rate_limit_exceeded","param":"MEDIA_PACKAGE_MAX_INFLIGHT_PER_USER","retry_after":5},"detail":"you already have 1 video export running"}"#;
        let (code, msg) = error_code(body);
        assert_eq!(code.as_deref(), Some(INFLIGHT_PARAM));
        assert!(msg.contains("already have"));
        assert_eq!(package_error_kind(429, code.as_deref()), "busy");
        let (code, _) = error_code(
            r#"{"error":{"type":"rate_limit_exceeded","param":"MEDIA_PACKAGE_RATE_PER_MIN"},"detail":"slow down"}"#,
        );
        assert_eq!(package_error_kind(429, code.as_deref()), "rate_limited");
        assert_eq!(package_error_kind(429, None), "rate_limited");
        // The param only means "busy" on a 429.
        assert_eq!(package_error_kind(400, Some(INFLIGHT_PARAM)), "error");
    }

    #[test]
    fn subtitle_tracks_carry_their_flags_and_a_bounded_title() {
        let subs: Vec<SubtitleTrack> = serde_json::from_value(serde_json::json!([
            {"lang": "de", "label": format!("German\u{7}\u{202E}{}", "x".repeat(80)), "srt": "1",
             "original": true, "default": true, "hearingImpaired": true},
            {"lang": "en", "label": " ", "srt": "2"},
        ]))
        .unwrap();
        let body = subtitles_json(&subs);
        assert_eq!(body[0]["original"], true);
        assert_eq!(body[0]["default"], true);
        assert_eq!(body[0]["hearing_impaired"], true);
        let label = body[0]["label"].as_str().unwrap();
        // The bell and the right-to-left override are both dropped, not counted.
        assert!(label.starts_with("Germanx"));
        assert_eq!(label.chars().count(), MAX_LABEL_CHARS);
        assert!(is_package_lang("pt-BR") && !is_package_lang("zh-Hant-TW-x1"));
        assert_eq!(body[1]["label"], serde_json::Value::Null);
        assert_eq!(body[1]["original"], false);
        assert_eq!(body[1]["default"], false);
        assert_eq!(body[1]["hearing_impaired"], false);
    }

    #[test]
    fn streams_are_bounded() {
        let s = bound_streams(MediaStreams {
            video_codec: Some("x".repeat(80)),
            audio_codec: None,
            width: Some(99_999),
            height: Some(1080),
            duration: Some(f64::INFINITY),
            mp4_ok: false,
            mp4_reason: Some("why".into()),
        });
        assert_eq!(
            s.video_codec.as_deref().map(|v| v.chars().count()),
            Some(33)
        );
        assert_eq!(s.width, None);
        assert_eq!(s.height, Some(1080));
        assert_eq!(s.duration, None);
    }
}
