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

/// When to insert the transcription into the focused field.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InsertTiming {
    Off,
    Stop,
    Live,
}

fn default_insert_timing() -> InsertTiming {
    InsertTiming::Live
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
    /// The chord as an ordered list of `KeyboardEvent.code`s (carries left/right
    /// side + AltGr, for the evdev backend). Accepts a legacy accelerator string
    /// ("Ctrl+B") on load and migrates it in place — so old configs don't reset.
    #[serde(deserialize_with = "de_hotkey")]
    pub hotkey: Vec<String>,
    pub profile_id: Option<String>,
}

/// Canonical rank so a stored chord is order-independent: modifiers (by type then
/// side) first, the single non-modifier key last.
fn code_rank(code: &str) -> u8 {
    match code {
        "ControlLeft" => 0,
        "ControlRight" => 1,
        "AltLeft" => 2,
        "AltRight" => 3,
        "ShiftLeft" => 4,
        "ShiftRight" => 5,
        "MetaLeft" => 6,
        "MetaRight" => 7,
        _ => 100,
    }
}

fn canonicalize(mut codes: Vec<String>) -> Vec<String> {
    codes.sort_by_key(|c| code_rank(c));
    codes.dedup();
    codes
}

/// A bare key token → its W3C `event.code` (letters/digits get the Key/Digit
/// prefix; named keys like Numpad0/ArrowUp/F1/Backspace already ARE codes).
fn token_to_code(tok: &str) -> String {
    if tok.chars().count() == 1 {
        let c = tok.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return format!("Key{}", c.to_ascii_uppercase());
        }
        if c.is_ascii_digit() {
            return format!("Digit{c}");
        }
    }
    tok.to_string()
}

/// Migrate a legacy accelerator ("Ctrl+Shift+B") to an event.code list (logical
/// modifiers map to their LEFT code).
fn accel_to_codes(accel: &str) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    for tok in accel.split('+') {
        let t = tok.trim();
        if t.is_empty() {
            continue;
        }
        let code = match t.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "ControlLeft".to_string(),
            "alt" | "option" => "AltLeft".to_string(),
            "altgr" => "AltRight".to_string(),
            "shift" => "ShiftLeft".to_string(),
            "super" | "meta" | "cmd" | "command" | "win" => "MetaLeft".to_string(),
            _ => token_to_code(t),
        };
        codes.push(code);
    }
    canonicalize(codes)
}

/// A non-modifier `event.code` → the plugin's accelerator key token.
fn code_to_token(code: &str) -> String {
    if let Some(l) = code.strip_prefix("Key") {
        return l.to_string();
    }
    if let Some(d) = code.strip_prefix("Digit") {
        return d.to_string();
    }
    code.to_string() // Numpad0 / ArrowUp / F1 / Backspace … (parser uppercases)
}

/// Build the global-shortcut accelerator for the plugin, or None if it can't be
/// registered there — a modifier-only chord, or one containing AltGr. Left/right
/// modifiers collapse to logical ones (the plugin can't distinguish sides; that's
/// the evdev backend's job).
pub fn codes_to_accelerator(codes: &[String]) -> Option<String> {
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for c in codes {
        match c.as_str() {
            "ControlLeft" | "ControlRight" => {
                if !mods.contains(&"Ctrl") {
                    mods.push("Ctrl");
                }
            }
            "AltLeft" => {
                if !mods.contains(&"Alt") {
                    mods.push("Alt");
                }
            }
            "AltRight" => return None, // AltGr — evdev-only
            "ShiftLeft" | "ShiftRight" => {
                if !mods.contains(&"Shift") {
                    mods.push("Shift");
                }
            }
            "MetaLeft" | "MetaRight" => {
                if !mods.contains(&"Super") {
                    mods.push("Super");
                }
            }
            other => key = Some(code_to_token(other)),
        }
    }
    let key = key?; // modifier-only → not registerable via the plugin
    let order = ["Ctrl", "Alt", "Shift", "Super"];
    let mut parts: Vec<String> = order
        .iter()
        .filter(|m| mods.contains(m))
        .map(|m| (*m).to_string())
        .collect();
    parts.push(key);
    Some(parts.join("+"))
}

fn de_hotkey<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, SeqAccess, Visitor};
    struct H;
    impl<'de> Visitor<'de> for H {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an accelerator string or a list of key codes")
        }
        fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
            Ok(accel_to_codes(s))
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut v = Vec::new();
            while let Some(s) = seq.next_element::<String>()? {
                v.push(s);
            }
            Ok(canonicalize(v))
        }
    }
    d.deserialize_any(H)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub open_at_login: bool,
    pub start_minimized: bool,
    /// When to auto-insert the transcription (off / on stop / live). `#[serde(default)]`
    /// so configs predating this field (which had `autoPaste`) load without resetting.
    #[serde(default = "default_insert_timing")]
    pub insert_timing: InsertTiming,
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
                    insert_timing: InsertTiming::Live,
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
                    hotkey: vec!["ControlLeft".into(), "ShiftLeft".into()],
                    profile_id: Some("default".into()),
                },
                ModeBinding {
                    mode: DictationModeId::Handsfree,
                    enabled: true,
                    hotkey: vec!["ControlLeft".into(), "KeyH".into()],
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
