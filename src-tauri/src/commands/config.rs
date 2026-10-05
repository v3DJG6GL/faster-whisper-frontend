//! Config load/save, the secret-store keys and the side effects a save applies
//! (recordings retention, autostart).

use super::{audio_base_pref, config_dir, resolve_recordings_dir};
use crate::config::{self, Config};
use tauri::AppHandle;

/// Frontend-facing config load: the config plus whether Rust had to RECOVER it (backed up a
/// present-but-unreadable/corrupt file to .json.bak and returned defaults), so the frontend can warn
/// the user their settings were reset instead of the armed auto-save silently persisting the wipe.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConfig {
    pub config: Config,
    pub recovered: bool,
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> LoadedConfig {
    match config_dir(&app) {
        Ok(dir) => {
            let (config, recovered) = config::load_outcome(&dir);
            LoadedConfig { config, recovered }
        }
        // No config dir at all (can't happen in practice) — clean defaults, nothing was backed up.
        Err(_) => LoadedConfig {
            config: Config::default(),
            recovered: false,
        },
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let dir = config_dir(&app)?;
    config::save(&dir, &config).map_err(|e| e.to_string())?;
    sync_autostart(&app, config.settings.general.open_at_login);
    apply_recordings_retention(&app, &config);
    crate::store::transcripts::apply_transcripts_retention(&app, &config);
    // Log level reload / session-file move / prune — so Settings changes
    // apply live, not at the next restart.
    crate::logging::apply_log_settings(&app, &config);
    // Clipboard privacy is a process-wide switch every transcript write reads (see inject.rs), so
    // it is applied here rather than carried on each insert.
    crate::inject::set_clipboard_privacy(config.settings.general.exclude_from_clipboard_history);
    Ok(())
}

/// Enforce the saved-recording retention window. Called on startup and after every config save,
/// so shortening the window takes effect immediately rather than at the next restart.
///
/// Turning "keep audio recordings" off stops the sweep too. The Settings screen DISABLES the
/// retention control whenever saving is off, so leaving the window live meant an existing archive
/// kept being deleted on every launch and every autosave, driven by a control the user could no
/// longer see the value of or change. The two now agree: no saving, no deleting.
pub fn apply_recordings_retention(app: &AppHandle, config: &Config) {
    let days = config.settings.recording.recordings_retention_days;
    if days == 0 || !config.settings.recording.save_recordings {
        return;
    }
    if let Some(dir) = resolve_recordings_dir(app, audio_base_pref(&config.settings)) {
        crate::audio::prune_recordings(&dir, days);
    }
}

/// Keep the OS "launch at login" entry in sync with the saved preference. Called
/// on startup and whenever the config is saved.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}

#[tauri::command]
pub fn set_backend_key(backend_id: String, key: String) -> Result<(), String> {
    config::keys::set(&backend_id, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_backend_key(backend_id: String) -> Result<(), String> {
    config::keys::delete(&backend_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
