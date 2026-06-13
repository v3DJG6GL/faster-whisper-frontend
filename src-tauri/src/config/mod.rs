//! Persisted configuration: Backends, dictation Profiles, and settings.
//!
//! Mirrors the TypeScript model in `src/lib/types.ts` (serde `camelCase`). The
//! config itself is stored as JSON in the OS app-config dir; raw API keys are
//! never written here — they live in the OS secret store, keyed by Backend id
//! (see [`keys`]).

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

/// How a Profile's chord behaves. First-class, decoupled from the Profile's id
/// (the old `DictationModeId = hold|handsfree` fused identity with behavior).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivationType {
    Hold,
    Latch,
}

/// A faster-whisper backend connection (server + model + decode defaults). The
/// API key is never stored here — it lives in the OS keyring keyed by [`Backend::id`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub has_api_key: bool,
    pub model: String,
    pub endpoint: EndpointKind,
    pub language: String,
    pub prompt: String,
    pub response_format: ResponseFormat,
    /// Phase-B placeholder: per-Backend decode-param defaults. Skipped when None
    /// so Phase-A configs round-trip byte-stable and the frontend need not send it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_overrides: Option<serde_json::Value>,
}

/// A user-defined dictation setup: an activation type + chord, a target [`Backend`],
/// and optional per-Profile language/prompt overrides (empty/None = inherit Backend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Stable opaque id, carried verbatim in the `trigger` payload.
    pub id: String,
    /// Human label shown in the UI; Rust never interprets it.
    pub name: String,
    pub activation: ActivationType,
    pub enabled: bool,
    /// The chord as an ordered list of `KeyboardEvent.code`s (carries left/right
    /// side + AltGr, for the evdev backend). Accepts a legacy accelerator string
    /// ("Ctrl+B") on load and migrates it in place — so old configs don't reset.
    #[serde(deserialize_with = "de_hotkey")]
    pub hotkey: Vec<String>,
    #[serde(default)]
    pub backend_id: Option<String>,
    /// Override the Backend's language; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Override the Backend's prompt; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Phase-B placeholder: per-Profile decode-param overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_overrides: Option<serde_json::Value>,
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
    /// Opt-in: use the evdev backend (reads /dev/input) for reliable hold-to-talk +
    /// left/right + AltGr on Wayland. `#[serde(default)]` so older configs load.
    #[serde(default)]
    pub evdev_enabled: bool,
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
    /// Which Profile the Home "click to dictate" button targets (None = first
    /// enabled). Pure storage; the frontend resolves it. `#[serde(default)]` so
    /// older configs load.
    #[serde(default)]
    pub home_profile_id: Option<String>,
    pub general: GeneralSettings,
    pub recording: RecordingSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub settings: AppSettings,
    pub backends: Vec<Backend>,
    pub profiles: Vec<Profile>,
    /// Schema version (absent/legacy ⇒ 1; current ⇒ 2). Orders future migrations.
    #[serde(default)]
    pub version: Option<u32>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            settings: AppSettings {
                theme: ThemeName::Dark,
                microphone_id: None,
                home_profile_id: None,
                general: GeneralSettings {
                    open_at_login: false,
                    start_minimized: false,
                    insert_timing: InsertTiming::Live,
                    insert_method: InsertMethod::Paste,
                    auto_enter: false,
                    restore_clipboard: true,
                    sound_effects: true,
                    evdev_enabled: false,
                },
                recording: RecordingSettings {
                    indicator_position: IndicatorPosition::Top,
                    save_recordings: false,
                    mute_system_audio: false,
                    realtime_preview: true,
                },
            },
            backends: vec![Backend {
                id: "default".into(),
                name: "Local server".into(),
                server_url: "http://localhost:8000".into(),
                has_api_key: false,
                model: "whisper-1".into(),
                endpoint: EndpointKind::Stream,
                language: "auto".into(),
                prompt: String::new(),
                response_format: ResponseFormat::VerboseJson,
                decode_overrides: None,
            }],
            profiles: vec![
                Profile {
                    id: "hold".into(),
                    name: "Push-to-talk".into(),
                    activation: ActivationType::Hold,
                    enabled: true,
                    hotkey: vec!["ControlLeft".into(), "ShiftLeft".into()],
                    backend_id: Some("default".into()),
                    language: None,
                    prompt: None,
                    decode_overrides: None,
                },
                Profile {
                    id: "handsfree".into(),
                    name: "Latch".into(),
                    activation: ActivationType::Latch,
                    enabled: true,
                    hotkey: vec!["ControlLeft".into(), "KeyH".into()],
                    backend_id: Some("default".into()),
                    language: None,
                    prompt: None,
                    decode_overrides: None,
                },
            ],
            version: Some(2),
        }
    }
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

// ── Legacy (pre-v2) config migration ────────────────────────────────────────
// Pre-v2 configs stored `profiles: ModelProfile[]` (= today's Backend) and
// `modes: ModeBinding[]` with a fused `mode: "hold"|"handsfree"`. The fields are
// the ONLY signal of intent, so we parse them explicitly (a plain serde default
// would silently drop them and reset the user's bindings). The mapping is
// deterministic — seed ids equal the legacy mode strings — so re-migration is a
// no-op.

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum LegacyModeId {
    Hold,
    Handsfree,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyModeBinding {
    mode: LegacyModeId,
    enabled: bool,
    #[serde(deserialize_with = "de_hotkey")]
    hotkey: Vec<String>,
    #[serde(default)]
    profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyConfig {
    settings: AppSettings,
    // Old `ModelProfile` is field-compatible with `Backend` (decode_overrides defaults).
    profiles: Vec<Backend>,
    modes: Vec<LegacyModeBinding>,
}

fn migrate_legacy(text: &str) -> Option<Config> {
    let legacy: LegacyConfig = serde_json::from_str(text).ok()?;
    let profiles = legacy
        .modes
        .into_iter()
        .map(|m| {
            let (id, name, activation) = match m.mode {
                LegacyModeId::Hold => ("hold", "Push-to-talk", ActivationType::Hold),
                LegacyModeId::Handsfree => ("handsfree", "Latch", ActivationType::Latch),
            };
            Profile {
                id: id.into(),
                name: name.into(),
                activation,
                enabled: m.enabled,
                hotkey: m.hotkey,
                backend_id: m.profile_id,
                language: None,
                prompt: None,
                decode_overrides: None,
            }
        })
        .collect();
    Some(Config {
        settings: legacy.settings,
        backends: legacy.profiles,
        profiles,
        version: Some(2),
    })
}

/// Load config from `<dir>/config.json`, falling back to defaults if missing or
/// invalid. A legacy (pre-v2) config is migrated losslessly and re-saved so the
/// next load takes the fast path.
pub fn load(dir: &Path) -> Config {
    let path = config_path(dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Config::default();
    };
    // Fast path: already the current (v2) shape.
    if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
        return cfg;
    }
    // Migration path: a legacy `profiles`/`modes` config (no `backends`).
    match migrate_legacy(&text) {
        Some(cfg) => {
            tracing::info!("[config] migrated legacy backends/profiles → v2");
            let _ = save(dir, &cfg);
            cfg
        }
        None => {
            tracing::warn!("config parse failed; using defaults");
            Config::default()
        }
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

/// Secret-store helpers: API keys are keyed by Backend id, never written to disk
/// in cleartext. (The id values are stable across the v2 migration, so existing
/// keyring entries keep resolving.)
pub mod keys {
    use super::KEYRING_SERVICE;

    fn entry(backend_id: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, backend_id)
    }

    pub fn set(backend_id: &str, secret: &str) -> anyhow::Result<()> {
        entry(backend_id)?.set_password(secret)?;
        Ok(())
    }

    #[allow(dead_code)] // read path is wired in M1 (backend connectivity)
    pub fn get(backend_id: &str) -> Option<String> {
        entry(backend_id).ok()?.get_password().ok()
    }

    pub fn delete(backend_id: &str) -> anyhow::Result<()> {
        match entry(backend_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
