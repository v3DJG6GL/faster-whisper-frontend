//! Batch transcription and translation of files and links, link media fetches,
//! and media export (both share the cancel epochs below).

use super::{resolve_audio_base, resolve_key, AUDIO_SUBDIRS};
use crate::transport;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_file(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    // None (field omitted) = inherit the server DEFAULT_PROMPT; Some("") = explicit
    // clear (send no prompt); Some(v) = use v. See transport::batch::post.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    file_path: String,
    // Per-run stage options (translate / diarization). None ≡ all absent.
    options: Option<transport::batch::BatchOptions>,
) -> Result<transport::batch::BatchResult, String> {
    // Capture the epoch BEFORE the (potentially slow) keyring resolve so a
    // cancel that lands during the D-Bus round-trip is never missed.
    let epoch = FILE_TRANSCRIBE_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    let key = resolve_key(api_key, backend_id);
    // Cancellation: cancel_file_transcription bumps the epoch; this select
    // polls it and DROPS the reqwest future on a change, which closes the
    // connection (the server cancels its handler task on the disconnect —
    // the in-flight decode thread finishes server-side, but the request,
    // its semaphore slot and its progress entry all end).
    let fut = transport::batch::transcribe(
        &server_url,
        key.as_deref(),
        &model,
        &language,
        prompt.as_deref(),
        decode_overrides.as_ref(),
        override_profile.as_deref(),
        &file_path,
        options,
    );
    until_file_epoch_bumps(epoch, fut).await
}

/// Translate segment texts via POST /v1/text/translations (T2T, no audio).
/// Serves dictation settle-time translation, the viewer's re-translate /
/// retro-translate and subtitle/text-file sources. Calls can run long (a
/// 400-segment chunk on a slow MT backend) — the transport applies the
/// long-job timeout; cancellation goes through `cancel_text_translation`
/// with the same `progress_id` the request carried. The latency-critical
/// dictation path still applies its own short JS-side budget.
///
/// `cancel_with_file_epoch` (opt-in, file-workbench callers only): also poll
/// `FILE_TRANSCRIBE_EPOCH` like `transcribe_file` and DROP the request when
/// `cancel_file_transcription` bumps it — otherwise a cancelled text-source
/// run stays parked on a long chunk until the server answers.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn translate_text(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    texts: Vec<String>,
    targets: Vec<String>,
    source: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    glossary: Option<String>,
    context_segments: Option<u32>,
    progress_id: Option<String>,
    captured_id: Option<String>,
    client_job: Option<String>,
    cancel_with_file_epoch: Option<bool>,
) -> Result<transport::text::TextTranslationResult, String> {
    // Captured BEFORE the keyring resolve, as in `transcribe_file`.
    let epoch = FILE_TRANSCRIBE_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    let key = resolve_key(api_key, backend_id);
    let fut = transport::text::translate_texts(
        &server_url,
        key.as_deref(),
        &texts,
        &targets,
        source.as_deref(),
        model.as_deref(),
        mode.as_deref(),
        glossary.as_deref(),
        context_segments,
        progress_id.as_deref(),
        captured_id.as_deref(),
        client_job.as_deref(),
    );
    if cancel_with_file_epoch == Some(true) {
        until_file_epoch_bumps(epoch, fut).await
    } else {
        fut.await.map_err(|e| e.to_string())
    }
}

/// Ask the SERVER to abort the in-flight text translation behind
/// `progress_id`. The backend's cancel endpoint is shared with batch
/// transcription, so this reuses `transport::batch::cancel` verbatim.
/// Best-effort by design (an older backend just answers 404).
#[tauri::command]
pub async fn cancel_text_translation(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    progress_id: String,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::cancel(&server_url, key.as_deref(), &progress_id)
        .await
        .map_err(|e| e.to_string())
}

/// Transcribe a pasted media link: the SERVER downloads the audio (yt-dlp)
/// and runs the normal pipeline. Same cancellation contract as
/// `transcribe_file` — the epoch poll drops the request (closing the
/// connection), and the Transcribe screen pairs that with the server-side
/// cancel by progress id, which also terminates the download subprocess.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_url(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    source_url: String,
    options: Option<transport::batch::BatchOptions>,
) -> Result<transport::batch::BatchResult, String> {
    let epoch = FILE_TRANSCRIBE_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    let key = resolve_key(api_key, backend_id);
    let fut = transport::batch::transcribe_url(
        &server_url,
        key.as_deref(),
        &model,
        &language,
        prompt.as_deref(),
        decode_overrides.as_ref(),
        override_profile.as_deref(),
        &source_url,
        options,
    );
    until_file_epoch_bumps(epoch, fut).await
}

/// Metadata preview of a pasted media link (title / duration / thumbnail) —
/// debounced from the Transcribe screen's URL field. Advisory only.
#[tauri::command]
pub async fn url_preview(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    url: String,
) -> Result<transport::batch::UrlPreview, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::url_preview(&server_url, key.as_deref(), &url)
        .await
        .map_err(|e| e.to_string())
}

/// Pull the server-retained audio of a finished URL run into the local media
/// store (`<base>/links/<record_id>.<ext>`), so playback works like any file run.
/// `Ok(None)` = the server no longer has it (expired/restarted) — the
/// transcript stays usable without playback.
#[tauri::command]
pub async fn fetch_url_media(
    app: tauri::AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    media_id: String,
    record_id: String,
    audio_base: Option<String>,
) -> Result<Option<String>, String> {
    fetch_link_media(
        &app, server_url, backend_id, api_key, media_id, record_id, audio_base, false,
    )
    .await
}

/// Pull the server-retained VIDEO of a link run into `<base>/video/<record_id>.<ext>`.
/// Same contract as `fetch_url_media`; a video pull gets hours, not the run's ceiling.
#[tauri::command]
pub async fn fetch_url_video(
    app: tauri::AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    media_id: String,
    record_id: String,
    audio_base: Option<String>,
) -> Result<Option<String>, String> {
    fetch_link_media(
        &app, server_url, backend_id, api_key, media_id, record_id, audio_base, true,
    )
    .await
}

/// The body `fetch_url_media` and `fetch_url_video` share; `video` picks the
/// folder and the ceiling.
#[allow(clippy::too_many_arguments)]
async fn fetch_link_media(
    app: &tauri::AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    media_id: String,
    record_id: String,
    audio_base: Option<String>,
    video: bool,
) -> Result<Option<String>, String> {
    if !crate::store::transcripts::valid_id(&record_id) {
        return Err("malformed record id".into());
    }
    let key = resolve_key(api_key, backend_id);
    let (dir, timeout) = if video {
        (
            crate::store::transcripts::video_media_dir(app, audio_base)?,
            transport::batch::FILE_TRANSCRIBE_TIMEOUT * 4,
        )
    } else {
        (
            crate::store::transcripts::links_media_dir(app, audio_base)?,
            transport::batch::FILE_TRANSCRIBE_TIMEOUT,
        )
    };
    transport::batch::download_result_media(
        &server_url,
        key.as_deref(),
        &media_id,
        &dir,
        &record_id,
        crate::store::transcripts::MAX_MEDIA_BYTES,
        timeout,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Ask the server to fetch a link's VIDEO on demand (POST /v1/audio/url-media/video).
#[tauri::command]
pub async fn url_video_download(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    url: String,
    max_height: Option<u32>,
    format_id: Option<String>,
    progress_id: Option<String>,
) -> Result<transport::batch::UrlMediaDownload, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::url_video_download(
        &server_url,
        key.as_deref(),
        &url,
        max_height,
        format_id.as_deref(),
        progress_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Ask the server to fetch a link's AUDIO on demand (POST /v1/audio/url-media/audio) —
/// a run whose transcript comes from the site's subtitles still keeps the audio.
#[tauri::command]
pub async fn url_audio_download(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    url: String,
    progress_id: Option<String>,
) -> Result<transport::batch::UrlMediaDownload, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::url_audio_download(&server_url, key.as_deref(), &url, progress_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Download a link's picked subtitle tracks (POST /v1/audio/url-subtitles).
#[tauri::command]
pub async fn url_subtitles(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    url: String,
    tracks: Vec<String>,
) -> Result<transport::batch::UrlSubtitles, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::url_subtitles(&server_url, key.as_deref(), &url, &tracks)
        .await
        .map_err(|e| e.to_string())
}

/// Which language a link speaks (POST /v1/audio/url-language). Cancel with
/// `cancel_text_translation` on the same progress id (the shared cancel route).
#[tauri::command]
pub async fn url_language_check(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    url: String,
    model: Option<String>,
    progress_id: Option<String>,
) -> Result<transport::batch::UrlLanguageCheck, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::url_language_check(
        &server_url,
        key.as_deref(),
        &url,
        model.as_deref(),
        progress_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Epoch for aborting in-flight `transcribe_file` calls (see above). Same
/// shape as session.rs's CANCELLED_BATCH_EPOCH for dictation clips.
static FILE_TRANSCRIBE_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Drive `fut` to completion unless `cancel_file_transcription` bumps the epoch captured as
/// `epoch` first — then DROP the future, which closes the connection (the server cancels its
/// handler task on the disconnect; the in-flight decode thread finishes server-side, but the
/// request, its semaphore slot and its progress entry all end). Polled at 250 ms. Shared by
/// `transcribe_file`, `transcribe_url` and the opt-in `translate_text` path.
async fn until_file_epoch_bumps<T, E: std::fmt::Display>(
    epoch: u64,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    until_epoch_bumps(&FILE_TRANSCRIBE_EPOCH, epoch, fut).await
}

/// The generic half of `until_file_epoch_bumps`: any epoch counter.
async fn until_epoch_bumps<T, E: std::fmt::Display>(
    counter: &'static std::sync::atomic::AtomicU64,
    epoch: u64,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            r = &mut fut => return r.map_err(|e| e.to_string()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                if counter.load(std::sync::atomic::Ordering::SeqCst) != epoch {
                    return Err("cancelled".into());
                }
            }
        }
    }
}

/// Epoch for aborting an in-flight media export (`package_media`): bumping it
/// drops the future, which closes the upload/download connection.
static MEDIA_EXPORT_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Abort the in-flight media export (the export panel's Cancel).
#[tauri::command]
pub fn cancel_media_export() {
    MEDIA_EXPORT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

fn under(dir: &std::path::Path, path: &std::path::Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(d), Ok(p)) => p.starts_with(&d),
        _ => false,
    }
}

/// Whether `path` sits inside any folder this app manages (the audio base or
/// the app data dir) — an export must never land there, and a copy source
/// must come from there or from the record's own files.
fn inside_app_storage(
    app: &tauri::AppHandle,
    audio_base: Option<String>,
    path: &std::path::Path,
) -> bool {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(b) = resolve_audio_base(app, audio_base) {
        dirs.push(b);
    }
    if let Ok(d) = app.path().app_data_dir() {
        dirs.push(d);
    }
    dirs.iter().any(|d| under(d, path))
}

/// Package a retained (or local) video with subtitle tracks to `dest_path`.
/// Exactly one of `source_media_id` (the server already holds it) or
/// `source_path` (a local file, uploaded first) names the video. Progress
/// lands on `media://export-progress` tagged with `job_id`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn package_media(
    app: tauri::AppHandle,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    job_id: String,
    source_media_id: Option<String>,
    source_path: Option<String>,
    container: String,
    subtitles: Vec<transport::media::SubtitleTrack>,
    default_track: Option<u32>,
    original_track: Option<u32>,
    audio_lang: Option<String>,
    audio_label: Option<String>,
    dest_path: String,
    filename: String,
    max_upload_bytes: Option<u64>,
    audio_base: Option<String>,
) -> Result<transport::media::PackageOutcome, String> {
    use transport::media::{self as media, PackageOutcome, UploadOutcome};
    // Capture the epoch BEFORE the (potentially slow) keyring resolve so a
    // cancel that lands during the D-Bus round-trip is never missed.
    let epoch = MEDIA_EXPORT_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    if !job_id.is_empty() && !transport::is_progress_id(&job_id) {
        return Err("malformed job id".into());
    }
    if !matches!(container.as_str(), "mkv" | "mp4") {
        return Err("container must be mkv or mp4".into());
    }
    if subtitles.len() > media::MAX_TRACKS {
        return Err(format!("at most {} subtitle tracks", media::MAX_TRACKS));
    }
    for t in &subtitles {
        if t.srt.len() > media::MAX_SRT_BYTES {
            return Err("a subtitle track is too large".into());
        }
        if !media::is_package_lang(&t.lang) {
            return Err("a subtitle track has a malformed language code".into());
        }
    }
    for (name, idx) in [
        ("default_track", default_track),
        ("original_track", original_track),
    ] {
        if idx.is_some_and(|i| i as usize >= subtitles.len()) {
            return Err(format!("{name} is out of range"));
        }
    }
    // An unusable audio language is dropped, not fatal: the mux still works,
    // only the audio stream keeps whatever tag the source carried.
    let audio_lang = audio_lang.filter(|l| media::is_package_lang(l));
    let audio_label = media::bound_label(audio_label.as_deref());
    let dest = PathBuf::from(&dest_path);
    let Some(parent) = dest.parent().filter(|p| p.is_dir()) else {
        return Err("the export folder does not exist".into());
    };
    if inside_app_storage(&app, audio_base, parent) {
        return Err("choose a folder outside the app's own storage".into());
    }
    let max_upload = max_upload_bytes.unwrap_or(crate::store::transcripts::MAX_MEDIA_BYTES);
    let (media_id, path) = match (source_media_id, source_path) {
        (Some(id), None) => {
            transport::gate_media_id(&id).map_err(|e| e.to_string())?;
            (Some(id), None)
        }
        (None, Some(p)) => {
            let p = PathBuf::from(p);
            let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
            if !meta.is_file() {
                return Err("the video is not a file".into());
            }
            if meta.len() > max_upload {
                return Ok(PackageOutcome::err("too_large", media::TOO_LARGE_DETAIL));
            }
            (None, Some(p))
        }
        _ => return Err("name exactly one of a media id or a local file".into()),
    };
    let key = resolve_key(api_key, backend_id);
    let emit_app = app.clone();
    let job = job_id.clone();
    // Throttled to ~10 events/s: the transfer loops report every KB-sized chunk, and each
    // event re-renders the whole viewer. A phase's first event and the final one (done ==
    // total) always go through, so the bar never skips a phase or stalls short of 100%.
    let last_emit: std::sync::Mutex<(Option<std::time::Instant>, &'static str)> =
        std::sync::Mutex::new((None, ""));
    let progress: media::Progress = std::sync::Arc::new(move |phase, done, total| {
        {
            let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
            let now = std::time::Instant::now();
            let due = last.1 != phase
                || total == Some(done)
                || last
                    .0
                    .is_none_or(|t| now.duration_since(t) >= std::time::Duration::from_millis(100));
            if !due {
                return;
            }
            *last = (Some(now), phase);
        }
        let _ = emit_app.emit(
            "media://export-progress",
            media::ExportProgress {
                job_id: job.clone(),
                phase,
                done,
                total,
            },
        );
    });
    let dest_for_cleanup = dest.clone();
    let fut = async {
        let mut uploaded_expiry: Option<i64> = None;
        let mid = match (media_id, path) {
            (Some(id), _) => id,
            (None, Some(p)) => {
                match media::upload_media(
                    &server_url,
                    key.as_deref(),
                    &p,
                    max_upload,
                    progress.clone(),
                )
                .await?
                {
                    UploadOutcome::Ok {
                        media_id,
                        expires_at,
                    } => {
                        uploaded_expiry = expires_at;
                        media_id
                    }
                    UploadOutcome::Http { status, detail } => {
                        let kind = match status {
                            413 => "too_large",
                            429 => "rate_limited",
                            403 | 503 => "disabled",
                            _ => "error",
                        };
                        return Ok::<_, anyhow::Error>(PackageOutcome::err(kind, detail));
                    }
                }
            }
            _ => unreachable!(),
        };
        let mut out = media::package_to_path(
            &server_url,
            key.as_deref(),
            &mid,
            &container,
            &subtitles,
            default_track,
            original_track,
            audio_lang.as_deref(),
            audio_label.as_deref(),
            &filename,
            &dest,
            crate::store::transcripts::MAX_MEDIA_BYTES,
            progress.clone(),
        )
        .await?;
        if out.kind == "ok" && out.expires_at.is_none() {
            out.expires_at = uploaded_expiry;
        }
        // Busy (the user's export slot is taken elsewhere): name the server copy so the
        // webview's retry packages it without uploading the file again.
        if out.kind == "busy" {
            out.media_id = Some(mid);
            out.expires_at = uploaded_expiry;
        }
        Ok(out)
    };
    let r = until_epoch_bumps(&MEDIA_EXPORT_EPOCH, epoch, fut).await;
    if r.is_err() {
        // A cancelled or failed export leaves no half-written file behind.
        let _ = std::fs::remove_file(media::tmp_sibling(&dest_for_cleanup));
    }
    match r {
        Ok(out) => Ok(out),
        Err(e) if e == "cancelled" => Ok(PackageOutcome::err("cancelled", "export cancelled")),
        Err(e) => Err(e),
    }
}

/// Codec facts for a retained file (`None` when the server no longer has it).
#[tauri::command]
pub async fn get_media_streams(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    media_id: String,
) -> Result<Option<transport::media::MediaStreams>, String> {
    let key = resolve_key(api_key, backend_id);
    transport::media::get_streams(&server_url, key.as_deref(), &media_id)
        .await
        .map_err(|e| e.to_string())
}

/// Copy one of a record's media files (its source, its audio copy or its
/// video copy — or any file inside the app's media folders) to a user-picked
/// path. Plain copy via tmp + rename; returns the bytes copied. The
/// destination must lie OUTSIDE the app's own storage.
#[tauri::command]
pub async fn copy_media_to(
    app: tauri::AppHandle,
    src: String,
    dest: String,
    record_id: String,
    audio_base: Option<String>,
) -> Result<u64, String> {
    if !crate::store::transcripts::valid_id(&record_id) {
        return Err("malformed record id".into());
    }
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);
    let src_real = src_path
        .canonicalize()
        .map_err(|e| format!("reading the media file: {e}"))?;
    if !src_real.is_file() {
        return Err("the media file is missing".into());
    }
    let owned = crate::store::transcripts::record_media_paths(&app, &record_id)
        .iter()
        .any(|p| p.canonicalize().map(|c| c == src_real).unwrap_or(false));
    let in_store = resolve_audio_base(&app, audio_base.clone())
        .map(|b| AUDIO_SUBDIRS.iter().any(|s| under(&b.join(s), &src_real)))
        .unwrap_or(false);
    if !owned && !in_store {
        return Err("that file does not belong to this transcription".into());
    }
    let Some(parent) = dest_path.parent().filter(|p| p.is_dir()) else {
        return Err("the export folder does not exist".into());
    };
    if inside_app_storage(&app, audio_base, parent) {
        return Err("choose a folder outside the app's own storage".into());
    }
    if dest_path
        .canonicalize()
        .map(|c| c == src_real)
        .unwrap_or(false)
    {
        return Err("that is the file itself".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let tmp = transport::media::tmp_sibling(&dest_path);
        let n = match std::fs::copy(&src_real, &tmp) {
            Ok(n) => n,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        };
        if let Err(e) = std::fs::rename(&tmp, &dest_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abort every in-flight file transcription (the Transcribe screen's Cancel).
#[tauri::command]
pub fn cancel_file_transcription() {
    FILE_TRANSCRIBE_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Ask the SERVER to abort the in-flight transcription behind `progress_id`.
/// Companion to `cancel_file_transcription` (which only drops our end of the
/// connection — the server's pipeline stages would otherwise run to
/// completion). Best-effort by design.
#[tauri::command]
pub async fn cancel_backend_transcription(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    progress_id: String,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::cancel(&server_url, key.as_deref(), &progress_id)
        .await
        .map_err(|e| e.to_string())
}

/// Poll the live progress of an in-flight file transcription.
#[tauri::command]
pub async fn get_transcribe_progress(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    progress_id: String,
) -> Result<transport::batch::BatchProgress, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::progress(&server_url, key.as_deref(), &progress_id)
        .await
        .map_err(|e| e.to_string())
}

// ── Server jobs: re-attach to a run the app lost the connection to ─────────
// Deliberately NOT wrapped in `until_file_epoch_bumps`: that epoch is one global
// counter any cancel bumps, and a late result ingest must survive an unrelated
// cancel. The typed outcome (not an Err) is what the reconcile step switches on.
