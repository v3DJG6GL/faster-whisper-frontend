//! Tauri commands exposed to the web UI (config load/save + secret-store keys).

use crate::audio::{self, AudioDevice, AudioState};
use crate::config::{self, Config};
use crate::session::{self, RecordParams, RecordState, StartParams, StreamState};
use crate::transport;
use crate::wayland_inject::WaylandTyper;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Folder where saved dictation `.wav` files go (when "Keep recordings" is on).
fn recordings_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("recordings"))
}

/// Resolve an API key: an explicit (just-typed) key wins; otherwise look it up in
/// the OS keyring by profile id.
fn resolve_key(explicit: Option<String>, profile_id: Option<String>) -> Option<String> {
    if let Some(k) = explicit {
        if !k.is_empty() {
            return Some(k);
        }
    }
    profile_id.and_then(|pid| config::keys::get(&pid))
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Config {
    match config_dir(&app) {
        Ok(dir) => config::load(&dir),
        Err(_) => Config::default(),
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let dir = config_dir(&app)?;
    config::save(&dir, &config).map_err(|e| e.to_string())?;
    sync_autostart(&app, config.settings.general.open_at_login);
    Ok(())
}

/// Keep the OS "launch at login" entry in sync with the saved preference. Called
/// on startup and whenever the config is saved.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}

#[tauri::command]
pub fn set_profile_key(profile_id: String, key: String) -> Result<(), String> {
    config::keys::set(&profile_id, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile_key(profile_id: String) -> Result<(), String> {
    config::keys::delete(&profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn test_connection(
    server_url: String,
    profile_id: Option<String>,
    api_key: Option<String>,
) -> transport::ConnectionInfo {
    let key = resolve_key(api_key, profile_id);
    transport::discovery::test_connection(&server_url, key.as_deref()).await
}

#[tauri::command]
pub async fn transcribe_file(
    server_url: String,
    profile_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    prompt: String,
    file_path: String,
) -> Result<transport::batch::BatchResult, String> {
    let key = resolve_key(api_key, profile_id);
    transport::batch::transcribe(&server_url, key.as_deref(), &model, &language, &prompt, &file_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDevice> {
    audio::device::list_input_devices()
}

#[tauri::command]
pub fn start_mic_test(
    app: AppHandle,
    state: State<AudioState>,
    device_id: Option<String>,
) -> Result<(), String> {
    let handle = audio::capture::start_level_meter(app, device_id)?;
    // Replacing the Option drops (and stops) any previous capture.
    *state.0.lock().map_err(|_| "audio state poisoned")? = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_mic_test(state: State<AudioState>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "audio state poisoned")? = None;
    Ok(())
}

#[tauri::command]
pub fn start_stream(
    app: AppHandle,
    state: State<StreamState>,
    server_url: String,
    profile_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    response_format: String,
    device_id: Option<String>,
    save: bool,
    mute_system: bool,
) -> Result<(), String> {
    let key = resolve_key(api_key, profile_id);
    let save_dir = if save { recordings_dir(&app) } else { None };
    let mut guard = state.0.lock().map_err(|_| "stream state poisoned")?;
    *guard = None; // stop any previous session first (Drop joins capture, drains WS)
    let sess = session::start(
        app,
        StartParams {
            server_url,
            api_key: key,
            model,
            language,
            response_format,
            device_id,
            save_dir,
            mute_system,
        },
    )?;
    *guard = Some(sess);
    Ok(())
}

#[tauri::command]
pub fn stop_stream(state: State<StreamState>) -> Result<(), String> {
    let sess = state.0.lock().map_err(|_| "stream state poisoned")?.take();
    if let Some(s) = sess {
        s.finish(); // drain in the background to deliver the last utterance
    }
    Ok(())
}

#[tauri::command]
pub fn start_record(
    app: AppHandle,
    state: State<RecordState>,
    server_url: String,
    profile_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    prompt: String,
    device_id: Option<String>,
    save: bool,
    mute_system: bool,
) -> Result<(), String> {
    let key = resolve_key(api_key, profile_id);
    let save_dir = if save { recordings_dir(&app) } else { None };
    let mut guard = state.0.lock().map_err(|_| "record state poisoned")?;
    *guard = None;
    let sess = session::start_record(
        app,
        RecordParams {
            server_url,
            api_key: key,
            model,
            language,
            prompt,
            device_id,
            save_dir,
            mute_system,
        },
    )?;
    *guard = Some(sess);
    Ok(())
}

#[tauri::command]
pub fn stop_record(state: State<RecordState>) -> Result<(), String> {
    let sess = state.0.lock().map_err(|_| "record state poisoned")?.take();
    if let Some(s) = sess {
        s.finish();
    }
    Ok(())
}

/// Suspend all global hotkeys (while the user captures a new binding). Pair with
/// `reregister_shortcuts` to restore them when capture ends.
#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) {
    crate::triggers::unregister_all(&app);
}

/// Re-read config and re-register global hotkeys (call after hotkeys change).
#[tauri::command]
pub fn reregister_shortcuts(app: AppHandle) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let cfg = config::load(&dir);
    crate::triggers::register_from_config(&app, &cfg.modes);
    Ok(())
}

/// Whether an accelerator string can be registered as a global shortcut.
#[tauri::command]
pub fn validate_shortcut(accelerator: String) -> bool {
    use std::str::FromStr;
    tauri_plugin_global_shortcut::Shortcut::from_str(&accelerator).is_ok()
}

/// Snapshot of the clipboard taken before a live (per-segment) paste dictation, so
/// the user's original clipboard is restored once at the end rather than after
/// every segment (which would race + churn the clipboard manager).
#[derive(Default)]
pub struct ClipboardSnapshot(pub std::sync::Mutex<Option<String>>);

/// Snapshot the current clipboard before a live paste-injection session.
#[tauri::command]
pub fn begin_injection(snap: State<ClipboardSnapshot>) {
    let text = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok());
    if let Ok(mut g) = snap.0.lock() {
        *g = Some(text.unwrap_or_default());
    }
}

/// Restore the clipboard snapshot taken by `begin_injection` (end of a live session).
#[tauri::command]
pub fn end_injection(snap: State<ClipboardSnapshot>) {
    let prev = snap.0.lock().ok().and_then(|mut g| g.take());
    if let Some(prev) = prev {
        if let Ok(mut c) = arboard::Clipboard::new() {
            let _ = c.set_text(prev);
        }
    }
}

/// Insert text into the focused field of the active app (paste or direct typing).
/// Direct typing on Wayland routes through the RemoteDesktop portal; everything
/// else uses enigo (clipboard paste, or direct on X11/Windows).
#[tauri::command]
pub async fn inject_text(
    app: AppHandle,
    typer: State<'_, WaylandTyper>,
    text: String,
    method: String,
    auto_enter: bool,
    restore_clipboard: bool,
) -> Result<(), String> {
    tracing::info!("[inject] {} chars via {} (auto_enter={})", text.len(), method, auto_enter);
    let res = if crate::inject::is_wayland() {
        if method == "direct" {
            crate::wayland_inject::type_text(&app, typer.inner(), &text, auto_enter).await
        } else {
            // Paste on Wayland: set the clipboard here, then synthesize Ctrl+V via
            // the portal. enigo's XTEST Ctrl+V is unreliable on KDE Wayland — a
            // synthesized modifier + remapped keycode makes apps fire the wrong
            // shortcut (e.g. opening editor tabs) instead of pasting.
            let clip = text.clone();
            let prev = tokio::task::spawn_blocking(move || {
                crate::inject::set_clipboard(&clip, restore_clipboard)
            })
            .await
            .map_err(|e| e.to_string())??;
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            let r = crate::wayland_inject::paste(&app, typer.inner(), auto_enter).await;
            crate::inject::restore_clipboard_later(prev);
            r
        }
    } else {
        tokio::task::spawn_blocking(move || {
            crate::inject::inject(&text, &method, auto_enter, restore_clipboard)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    res
}
