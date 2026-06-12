//! Persisted configuration: Model Profiles, per-mode bindings, and settings.
//!
//! Mirrors the TypeScript model in `src/lib/types.ts` (serde `camelCase`). The
//! config itself is stored as JSON in the OS app-config dir; raw API keys are
//! never written here — they live in the OS secret store (see [`keys`]).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEYRING_SERVICE: &str = "faster-whisper-frontend";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EndpointKind {
    Stream,
    Batch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormat {
    Json,
    VerboseJson,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InsertMethod {
    Paste,
    Direct,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndicatorPosition {
    Top,
    Bottom,
    Off,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeName {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DictationModeId {
    Hold,
    Handsfree,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub has_api_key: bool,
    pub model: String,
    pub endpoint: EndpointKind,
    pub language: String,
    pub prompt: String,
    pub response_format: ResponseFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeBinding {
    pub mode: DictationModeId,
    pub enabled: bool,
    pub hotkey: String,
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub open_at_login: bool,
    pub start_minimized: bool,
    pub auto_paste: bool,
    pub insert_method: InsertMethod,
    pub auto_enter: bool,
    pub restore_clipboard: bool,
    pub sound_effects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSettings {
    pub indicator_position: IndicatorPosition,
    pub save_recordings: bool,
    pub mute_system_audio: bool,
    pub realtime_preview: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: ThemeName,
    pub microphone_id: Option<String>,
    pub general: GeneralSettings,
    pub recording: RecordingSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub settings: AppSettings,
    pub profiles: Vec<ModelProfile>,
    pub modes: Vec<ModeBinding>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            settings: AppSettings {
                theme: ThemeName::Dark,
                microphone_id: None,
                general: GeneralSettings {
                    open_at_login: false,
                    start_minimized: false,
                    auto_paste: true,
                    insert_method: InsertMethod::Paste,
                    auto_enter: false,
                    restore_clipboard: true,
                    sound_effects: true,
                },
                recording: RecordingSettings {
                    indicator_position: IndicatorPosition::Top,
                    save_recordings: false,
                    mute_system_audio: false,
                    realtime_preview: true,
                },
            },
            profiles: vec![ModelProfile {
                id: "default".into(),
                name: "Local server".into(),
                server_url: "http://localhost:8000".into(),
                has_api_key: false,
                model: "whisper-1".into(),
                endpoint: EndpointKind::Stream,
                language: "auto".into(),
                prompt: String::new(),
                response_format: ResponseFormat::VerboseJson,
            }],
            modes: vec![
                ModeBinding {
                    mode: DictationModeId::Hold,
                    enabled: true,
                    hotkey: "Ctrl+Shift".into(),
                    profile_id: Some("default".into()),
                },
                ModeBinding {
                    mode: DictationModeId::Handsfree,
                    enabled: true,
                    hotkey: "Ctrl+H".into(),
                    profile_id: Some("default".into()),
                },
            ],
        }
    }
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

/// Load config from `<dir>/config.json`, falling back to defaults if missing or invalid.
pub fn load(dir: &Path) -> Config {
    let path = config_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!("config parse failed ({e}); using defaults");
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

/// Persist config atomically to `<dir>/config.json`.
pub fn save(dir: &Path, config: &Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = config_path(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config)?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Secret-store helpers: API keys are keyed by profile id, never written to disk in cleartext.
pub mod keys {
    use super::KEYRING_SERVICE;

    fn entry(profile_id: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, profile_id)
    }

    pub fn set(profile_id: &str, secret: &str) -> anyhow::Result<()> {
        entry(profile_id)?.set_password(secret)?;
        Ok(())
    }

    #[allow(dead_code)] // read path is wired in M1 (backend connectivity)
    pub fn get(profile_id: &str) -> Option<String> {
        entry(profile_id).ok()?.get_password().ok()
    }

    pub fn delete(profile_id: &str) -> anyhow::Result<()> {
        match entry(profile_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
