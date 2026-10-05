//! The audio base folder (layout, move, open) and the file I/O commands: media reads
//! for playback, text save/read, opening a source link, reveal in the file manager.

use super::{audio_base_pref, resolve_audio_base, AUDIO_SUBDIRS};
use crate::config::Config;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Absolute path of the active audio base folder (custom or default), for
/// display in Settings — a leading `$HOME` is collapsed to `~`.
#[tauri::command]
pub fn audio_dir_path(app: AppHandle, custom: Option<String>) -> Option<String> {
    let dir = resolve_audio_base(&app, custom)?;
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Some(format!("~/{}", rest.display()));
        }
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Open the active audio base folder in the system file manager. Creates it
/// (with its subfolders) first so the button works before the first run.
#[tauri::command]
pub fn open_audio_dir(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = resolve_audio_base(&app, custom).ok_or("could not resolve the audio folder")?;
    crate::audio::create_dir_private(&dir)
        .map_err(|e| format!("could not create the folder: {e}"))?;
    for sub in AUDIO_SUBDIRS {
        let _ = crate::audio::create_dir_private(&dir.join(sub));
    }
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Move one file across a possible filesystem boundary: rename, else
/// copy + remove (verified by the copy's success).
fn move_file(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::remove_file(src)
}

/// Move every regular file from `from` into `to`, recording old→new paths.
/// Stops on the first error; already-moved files stay moved and are in `map`,
/// which the caller rewrites into the records even on failure (they store
/// absolute paths, so nothing else would re-point them).
fn move_dir_contents(
    from: &std::path::Path,
    to: &std::path::Path,
    map: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(from) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("could not read {}: {e}", from.display())),
    };
    crate::audio::create_dir_private(to).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        // An in-progress media copy (`<id>.<ext>.tmp`, see save_transcript_media) finishes in
        // the old base and its record keeps a valid absolute path; moving it under the writer
        // fails the copier's final rename and strands a `.tmp` every sweep skips forever.
        if src.extension().and_then(|e| e.to_str()) == Some("tmp") {
            continue;
        }
        let Some(name) = src.file_name() else {
            continue;
        };
        let dest = to.join(name);
        // Never clobber (the layout migration's rule, applied to the relocation too): a base
        // that already holds a same-named file — a second install pointed at one synced folder,
        // a re-run after a partial move — keeps it, and the record still points at the source.
        if dest.exists() {
            tracing::warn!(
                "[audio] not moving {} — {} already exists",
                src.display(),
                dest.display()
            );
            continue;
        }
        move_file(&src, &dest).map_err(|e| format!("could not move {}: {e}", src.display()))?;
        map.push((
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        ));
    }
    let _ = std::fs::remove_dir(from); // only removes if now empty
    Ok(())
}

/// Fix `mediaPath` inside every history record that pointed at a moved file.
fn rewrite_media_paths(app: &AppHandle, map: &[(String, String)]) {
    if map.is_empty() {
        return;
    }
    let lookup: std::collections::HashMap<&str, &str> =
        map.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    crate::store::transcripts::rewrite_media_paths(app, &lookup);
}

/// One-time (idempotent) migration into the single-base layout: legacy saved
/// recordings move into `<base>/dictations`, the old app-data media store
/// splits into `<base>/files` + `<base>/links` by record kind. Called once
/// per launch, before the retention sweeps.
pub fn ensure_audio_layout(app: &AppHandle, config: &Config) {
    let pref = audio_base_pref(&config.settings);
    let Some(base) = resolve_audio_base(app, pref.clone()) else {
        return;
    };
    let _ = crate::audio::create_dir_private(&base);
    for sub in AUDIO_SUBDIRS {
        let _ = crate::audio::create_dir_private(&base.join(sub));
    }
    let mut map: Vec<(String, String)> = Vec::new();
    // Legacy recordings: the custom folder (which may BE the new base — then
    // its loose .wav/.txt files just move down into dictations/) or the old
    // app-data default.
    let legacy_rec = match &pref {
        Some(p) => PathBuf::from(p),
        None => match app.path().app_data_dir() {
            Ok(d) => d.join("recordings"),
            Err(_) => return,
        },
    };
    let dict = base.join("dictations");
    if legacy_rec != dict {
        if let Ok(entries) = std::fs::read_dir(&legacy_rec) {
            for entry in entries.flatten() {
                let src = entry.path();
                let Some(name) = src.file_name() else {
                    continue;
                };
                // Only the app's own files: the legacy folder is a free user pick (~/Music,
                // a shared Documents folder…), and relocating every .wav/.txt in it moved
                // foreign files under a folder "Delete all dictations" then wipes.
                if !src.is_file() || !crate::audio::is_dictation_file(&name.to_string_lossy()) {
                    continue;
                }
                let dest = dict.join(name);
                if dest.exists() {
                    continue; // never clobber
                }
                if move_file(&src, &dest).is_ok() {
                    map.push((
                        src.to_string_lossy().into_owned(),
                        dest.to_string_lossy().into_owned(),
                    ));
                }
            }
            if legacy_rec.file_name().and_then(|n| n.to_str()) == Some("recordings") {
                let _ = std::fs::remove_dir(&legacy_rec);
            }
        }
    }
    // Legacy media store: split by record kind (url → links, else files).
    if let Ok(legacy_media) = crate::store::transcripts::legacy_media_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&legacy_media) {
            for entry in entries.flatten() {
                let src = entry.path();
                if !src.is_file() {
                    continue;
                }
                let Some(name) = src.file_name() else {
                    continue;
                };
                let stem = src
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let sub = if crate::store::transcripts::record_kind(app, &stem).as_deref()
                    == Some("url")
                {
                    "links"
                } else {
                    "files"
                };
                let dest = base.join(sub).join(name);
                if dest.exists() {
                    continue;
                }
                if move_file(&src, &dest).is_ok() {
                    map.push((
                        src.to_string_lossy().into_owned(),
                        dest.to_string_lossy().into_owned(),
                    ));
                }
            }
            let _ = std::fs::remove_dir(&legacy_media);
        }
    }
    if !map.is_empty() {
        tracing::info!(
            "[audio] layout migration moved {} file(s) under {}",
            map.len(),
            base.display()
        );
        rewrite_media_paths(app, &map);
    }
    // Repair records a past (incomplete) rewrite left pointing at moved files. One
    // full read+parse of every record, so NOT every launch: after a migration that
    // moved something, and once per install (the stamp); `move_audio_base` heals
    // directly through its own rewrite.
    // This runs synchronously inside setup(), before the event loop, so a fresh install with
    // no records skips the scan entirely and only stamps; the expensive read+parse is reserved
    // for a base that actually has history to heal.
    let stamp = base.join(".heal-v1");
    if !stamp.exists() && map.is_empty() && !crate::store::transcripts::has_any_records(app) {
        let _ = std::fs::write(&stamp, b"");
    } else if !map.is_empty() || !stamp.exists() {
        crate::store::transcripts::heal_media_paths(app, &base);
        let _ = std::fs::write(&stamp, b"");
    }
}

/// Relocate the whole audio store: move the three subfolders from the current
/// base to the next one and fix the records' stored paths. The caller (the
/// Settings screen) persists the new setting only after this returns Ok —
/// never save-then-hope.
#[tauri::command]
pub async fn move_audio_base(
    app: AppHandle,
    current: Option<String>,
    next: Option<String>,
) -> Result<(), String> {
    let from = resolve_audio_base(&app, current).ok_or("could not resolve the audio folder")?;
    let to = resolve_audio_base(&app, next).ok_or("could not resolve the new folder")?;
    if from == to {
        return Ok(());
    }
    if to.starts_with(&from) {
        return Err("the new folder can't be inside the current one".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::create_dir_private(&to)
            .map_err(|e| format!("could not create the folder: {e}"))?;
        let mut map: Vec<(String, String)> = Vec::new();
        let mut res: Result<(), String> = Ok(());
        for sub in AUDIO_SUBDIRS {
            if let Err(e) = move_dir_contents(&from.join(sub), &to.join(sub), &mut map) {
                res = Err(e);
                break;
            }
        }
        // Move the heal stamp so the new base is stamped and the old one is clean.
        // Without this the old base keeps a stray `.heal-v1` and the new one
        // re-runs the full heal scan on the next launch.
        let stamp_name = ".heal-v1";
        let old_stamp = from.join(stamp_name);
        let new_stamp = to.join(stamp_name);
        if old_stamp.exists() {
            let _ = std::fs::rename(&old_stamp, &new_stamp);
        } else {
            let _ = std::fs::write(&new_stamp, b"");
        }
        let _ = std::fs::remove_dir(&from); // only if empty
                                            // Always re-point what actually moved: records store ABSOLUTE paths, and a
                                            // partial move leaves the preference on the old base, which the startup heal
                                            // then searches — so an unrewritten record would stay broken for good.
        rewrite_media_paths(&app, &map);
        tracing::info!(
            "[audio] base moved: {} file(s) → {}",
            map.len(),
            to.display()
        );
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The exact refusal text the viewer matches on to fall back to the decode path.
pub const MEDIA_TOO_LARGE: &str = "too large to buffer";

/// Read a media file the user picked into memory for in-card playback. The
/// asset-protocol path is preferred, but Linux WebKitGTK's media stack is
/// unreliable over custom URI schemes — when the <audio> element errors, the
/// webview falls back to this and plays from a blob URL. Raw IPC response
/// (no base64/JSON round-trip); capped so a mispicked multi-GB video can't
/// balloon the webview.
#[tauri::command]
pub async fn read_media_file(path: String) -> Result<tauri::ipc::Response, String> {
    // Below the ~240 MB at which handing the bytes over IPC froze the web process (see
    // `decode_media_file`), with headroom for the JS-side Blob copy. The viewer routes an
    // over-cap refusal to the decode path instead of calling the media broken.
    const MAX_MEDIA_BYTES: u64 = 192 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_MEDIA_BYTES {
        return Err(MEDIA_TOO_LARGE.into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open a transcribed link in the system browser. Scheme-checked so a
/// stored record can only ever launch a web URL, never a local program.
#[tauri::command]
pub fn open_source_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("not a web link".into());
    }
    app.opener()
        .open_url(u, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The longest path `reveal_in_folder` accepts (bytes) — past every OS's own limit.
const REVEAL_PATH_MAX: usize = 4096;

/// A path `reveal_in_folder` may show: non-empty, bounded, free of control
/// characters, absolute, and present on disk. A just-saved export always is.
fn reveal_target(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > REVEAL_PATH_MAX {
        return Err("not a usable path".into());
    }
    if path.chars().any(char::is_control) {
        return Err("the path has control characters".into());
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("not an absolute path".into());
    }
    if !p.exists() {
        return Err("the file is not there".into());
    }
    Ok(p)
}

/// Show a saved export in the system file manager: its folder opens with the
/// file selected. async + spawn_blocking: the Linux path is a blocking D-Bus
/// call (FileManager1, else the OpenURI portal).
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let target = reveal_target(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decode a media file in-process (symphonia) — the playback fallback for
/// codecs the system webview can't handle (AAC/MP4 on Linux
/// WebKitGTK, i.e. every retained YouTube audio). Returns the path of a
/// cached on-disk WAV the viewer streams through the asset protocol —
/// returning the bytes over IPC froze the web process on ~240 MB blobs.
#[tauri::command]
pub async fn decode_media_file(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::decode::decode_to_cached_wav(&app, &path).map_err(|e| {
            tracing::warn!("[playback] decode failed for {path}: {e}");
            e
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a plain text file (transcript exports) to the path the user picked
/// in the save dialog. Same atomic tmp+rename + cleanup-on-both-failures shape
/// as `export_settings_file`, minus the 0600 secrecy (a transcript is what the
/// user is deliberately exporting — plain permissions are correct).
/// async + spawn_blocking: a sync command runs on the main thread and this fsyncs into a
/// user-picked sink (USB stick, network share).
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write as _;
        let path = PathBuf::from(path);
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let write = || -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(contents.as_bytes())?;
            f.sync_all()
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a text/subtitle source file for a translate-only run. Size-capped —
/// subtitle files are KBs; anything past the cap is the wrong file.
/// async + spawn_blocking: a sync command runs on the main thread, and the picked file can sit
/// on a slow or stalled mount (network share, sleeping disk).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    const MAX_TEXT_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_TEXT_SOURCE_BYTES {
            return Err("file is larger than 10 MB — not a subtitle/text source".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        // Lossy: a stray invalid byte must not block a whole subtitle file.
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::move_dir_contents;

    #[test]
    fn reveal_target_takes_only_an_existing_absolute_clean_path() {
        use super::{reveal_target, REVEAL_PATH_MAX};
        let file = std::env::temp_dir().join(format!("fwf-reveal-{}.srt", std::process::id()));
        std::fs::write(&file, b"1").unwrap();
        let ok = file.to_string_lossy().into_owned();
        assert_eq!(reveal_target(&ok).unwrap(), file);
        // Relative, empty, over-long, control characters, missing: all refused.
        assert!(reveal_target("talk.srt").is_err());
        assert!(reveal_target("").is_err());
        let long = format!("/{}", "a".repeat(REVEAL_PATH_MAX));
        assert!(reveal_target(&long).is_err());
        assert!(reveal_target(&format!("{ok}\n")).is_err());
        assert!(reveal_target(&format!("{ok}\u{7f}")).is_err());
        std::fs::remove_file(&file).unwrap();
        assert!(reveal_target(&ok).is_err());
    }

    #[test]
    fn move_dir_contents_leaves_inflight_tmp_behind() {
        let base = std::env::temp_dir().join(format!(
            "fwf-move-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.wav"), b"riff").unwrap();
        std::fs::write(from.join("b.m4a.tmp"), b"partial").unwrap();

        let mut map = Vec::new();
        move_dir_contents(&from, &to, &mut map).unwrap();

        assert!(to.join("a.wav").is_file(), "regular media moves");
        assert!(
            !to.join("b.m4a.tmp").exists(),
            "an in-flight .tmp is never moved"
        );
        assert!(
            from.join("b.m4a.tmp").is_file(),
            "the .tmp stays in the old base for its writer"
        );
        assert_eq!(map.len(), 1);
        assert!(map[0].0.ends_with("a.wav") && map[0].1.ends_with("a.wav"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
