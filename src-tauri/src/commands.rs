//! Tauri commands exposed to the web UI (config load/save + secret-store keys).

use crate::config::{self, Config};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
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
    config::save(&dir, &config).map_err(|e| e.to_string())
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
