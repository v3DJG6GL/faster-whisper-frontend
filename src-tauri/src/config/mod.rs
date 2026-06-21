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

/// How to treat a backend's capabilities. `Auto` (or absent) = infer from the
/// connection test (`/v1/models` boot_id); `Full` / `Standard` are manual
/// overrides. Gates which decode overrides the editor offers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Auto,
    Full,
    Standard,
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
    /// Copy to the clipboard only — inject no keystrokes (the user pastes manually).
    Clipboard,
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

/// Paste chord for the "clipboard paste" method (KeyboardEvent.code list). Ctrl+V by
/// default; terminals (Konsole, kitty, …) need Ctrl+Shift+V.
fn default_paste_shortcut() -> Vec<String> {
    vec!["ControlLeft".into(), "KeyV".into()]
}

fn default_true() -> bool {
    true
}

fn default_peek_timeout() -> f64 {
    30.0
}

fn default_dim_after() -> f64 {
    10.0
}

fn default_hover_reveal() -> u32 {
    1000
}

fn default_latch_auto_stop() -> f64 {
    5.0
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

/// Which usage figure the chip's optional readout shows (today's value).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlayStatsMetric {
    Words,
    Audio,
    Both,
}

fn default_stats_metric() -> OverlayStatsMetric {
    OverlayStatsMetric::Words
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
    /// Manual full-vs-standard classification. None/Auto ⇒ infer from the
    /// connection test; Full/Standard override detection. Skipped when None so
    /// existing configs round-trip byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BackendKind>,
    /// Name of a server-side override-profile this backend references per request
    /// (faster-whisper-backend only). None/empty = none. Skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_profile: Option<String>,
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
    /// Short label for the overlay chip; None/empty = derive from `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// Override the Backend's language; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Override the Backend's prompt; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Phase-B placeholder: per-Profile decode-param overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_overrides: Option<serde_json::Value>,
    /// Override the Backend's server override-profile reference; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_profile: Option<String>,
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
    // Rank orders modifiers first (by type+side); equal-rank codes (e.g. two non-modifier keys in
    // an N-chord, both rank 100) fall back to a lexical tie-break so the order is press-order-
    // independent. Mirrors the TS `canonicalizeCodes` so the two layers agree on equality + round-
    // trip. The tie-break also makes identical codes adjacent, so `dedup` removes them all (not
    // just consecutive duplicates).
    codes.sort_by(|a, b| code_rank(a).cmp(&code_rank(b)).then_with(|| a.cmp(b)));
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
            other => {
                // A second non-modifier means this is a multi-key (N-chord) binding,
                // which a plugin accelerator can't express (modifiers + exactly ONE key).
                // Return None so it routes to the evdev/CLI path instead of silently
                // collapsing to — and globally hijacking — the lexically-last key.
                if key.is_some() {
                    return None;
                }
                key = Some(code_to_token(other));
            }
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
    /// Chord for the "clipboard paste" method (KeyboardEvent.code list). `#[serde(default)]`
    /// so configs predating this field load with the Ctrl+V default.
    #[serde(default = "default_paste_shortcut")]
    pub paste_shortcut: Vec<String>,
    pub auto_enter: bool,
    pub restore_clipboard: bool,
    pub sound_effects: bool,
    /// Opt-in: use the evdev backend (reads /dev/input) for reliable hold-to-talk +
    /// left/right + AltGr on Wayland. `#[serde(default)]` so older configs load.
    #[serde(default)]
    pub evdev_enabled: bool,
    /// Opt-in: AT-SPI "deep field detection" — skip typing when the focused element
    /// isn't a text field (covers browsers/Electron via an a11y flag + active poke).
    /// `#[serde(default)]` (false) so older configs load unchanged.
    #[serde(default)]
    pub deep_field_detection: bool,
    /// Global chord (KeyboardEvent.code list) that opens the quick-add window. Empty =
    /// unset. `#[serde(default)]` so older configs load. Registered via the same paths
    /// as Profile hotkeys (evdev / plugin / the `--quick-add` CLI flag).
    #[serde(default)]
    pub quick_add_hotkey: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSettings {
    pub indicator_position: IndicatorPosition,
    pub save_recordings: bool,
    /// User-chosen folder for saved `.wav` recordings; None/empty = the default under
    /// the app data dir. `#[serde(default, skip…)]` so older configs load and configs
    /// that never set it round-trip byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recordings_dir: Option<String>,
    /// When saving: keep only the spoken spans (drop silence) in the .wav, so a long latch
    /// session doesn't store hours of quiet. `#[serde(default)]` (true) so older configs load.
    #[serde(default = "default_true")]
    pub trim_silence: bool,
    pub mute_system_audio: bool,
    /// Auto-stop a hands-free (latch) session after this many minutes of continuous silence
    /// (0 = never). Prevents multi-hour runaway sessions and frees the mic/connection.
    #[serde(default = "default_latch_auto_stop")]
    pub latch_auto_stop_min: f64,
    pub realtime_preview: bool,
    /// When the live preview is on, reveal the words only while hovering the chip (vs. always).
    /// `#[serde(default)]` so older configs default to always-shown.
    #[serde(default)]
    pub realtime_preview_on_hover: bool,
    /// Show the active Profile's tag on the overlay chip. `#[serde(default = …)]`
    /// so older configs load (and default the feature on).
    #[serde(default = "default_true")]
    pub show_profile_on_overlay: bool,
    /// When the Profile tag is shown, reveal it only while hovering the chip (vs. always).
    /// `#[serde(default)]` so older configs default to always-shown.
    #[serde(default)]
    pub show_profile_on_hover: bool,
    /// Show a tiny usage readout (today's words/minutes) on the chip. Default off
    /// — opt-in; `#[serde(default)]` so older configs load with it disabled.
    #[serde(default)]
    pub show_stats_on_overlay: bool,
    /// When the readout is shown, reveal it only while hovering the chip (vs. always).
    /// `#[serde(default)]` so older configs default to always-shown.
    #[serde(default)]
    pub overlay_stats_on_hover: bool,
    /// Which usage figure the chip shows. `#[serde(default = …)]` (words) so older
    /// configs load with a sensible metric.
    #[serde(default = "default_stats_metric")]
    pub overlay_stats_metric: OverlayStatsMetric,
    /// Show the injection target app (→ AppName) on the chip, plus a warn hint when the focused
    /// element isn't a typable text field. `#[serde(default = …)]` so older configs default on.
    #[serde(default = "default_true")]
    pub show_target_on_overlay: bool,
    /// When the target is shown, reveal it only while hovering the chip (vs. always).
    /// `#[serde(default)]` so older configs default to always-shown.
    #[serde(default)]
    pub show_target_on_hover: bool,
    /// Only show the injection target while actively dictating (the chip is expanded), hiding it
    /// when armed but silent — so it doesn't flicker as focus moves between phrases. Default off.
    #[serde(default)]
    pub show_target_only_speaking: bool,
    /// Keep the chip on screen (a standby dot) even when dictation is off.
    #[serde(default)]
    pub persistent_dock: bool,
    /// After sitting idle, slide the chip to the screen edge (hover to restore).
    #[serde(default)]
    pub overlay_peek: bool,
    /// Idle seconds before the chip peeks to the edge (fractional allowed).
    #[serde(default = "default_peek_timeout")]
    pub peek_timeout_sec: f64,
    /// Stay tucked at the edge as a dot even while dictating (color + pulse only),
    /// instead of popping out into the full pill. Layers on `overlay_peek`.
    #[serde(default)]
    pub peek_while_active: bool,
    /// Idle seconds before the chip fades to a dim opacity (0 = never; fractional allowed).
    /// Applies to an armed-but-silent session AND a docked standby dot.
    #[serde(default = "default_dim_after")]
    pub dim_after_sec: f64,
    /// Hover-intent delay (ms) before the chip reveals detail + quick-launch buttons.
    #[serde(default = "default_hover_reveal")]
    pub hover_reveal_ms: u32,
    /// Chip quick-launch buttons. Frontend-owned opaque JSON (like decode_overrides);
    /// Rust never interprets it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quick_launch: Vec<serde_json::Value>,
}

/// Which "Spoken symbols" (callback:map) list the quick-add window targets: the
/// Backend it lives on + the rule slug. Designated on the Dictionary screen; pure
/// storage (the rules themselves are live server state, fetched per-Backend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddTarget {
    pub backend_id: String,
    pub slug: String,
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
    /// The pinned quick-add word-mapping list (Backend id + callback:map rule slug)
    /// the QuickAdd window targets. None = not chosen yet. `#[serde(default, skip…)]`
    /// so older configs load and an unset value round-trips byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_add_list: Option<QuickAddTarget>,
    pub general: GeneralSettings,
    pub recording: RecordingSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub settings: AppSettings,
    pub backends: Vec<Backend>,
    pub profiles: Vec<Profile>,
    /// Per-application injection rules (block/allow + method / paste-shortcut overrides).
    /// Frontend-owned opaque JSON like `quick_launch` — Rust stores + round-trips but
    /// never interprets it. `#[serde(default, skip…)]` so older configs load.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub app_rules: Vec<serde_json::Value>,
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
                quick_add_list: None,
                general: GeneralSettings {
                    open_at_login: false,
                    start_minimized: false,
                    insert_timing: InsertTiming::Live,
                    insert_method: InsertMethod::Paste,
                    paste_shortcut: default_paste_shortcut(),
                    auto_enter: false,
                    restore_clipboard: true,
                    sound_effects: true,
                    evdev_enabled: false,
                    deep_field_detection: false,
                    quick_add_hotkey: Vec::new(),
                },
                recording: RecordingSettings {
                    indicator_position: IndicatorPosition::Top,
                    save_recordings: false,
                    recordings_dir: None,
                    trim_silence: true,
                    mute_system_audio: false,
                    latch_auto_stop_min: 5.0,
                    realtime_preview: true,
                    realtime_preview_on_hover: false,
                    show_profile_on_overlay: true,
                    show_profile_on_hover: false,
                    show_stats_on_overlay: false,
                    overlay_stats_on_hover: false,
                    overlay_stats_metric: OverlayStatsMetric::Words,
                    show_target_on_overlay: true,
                    show_target_on_hover: false,
                    show_target_only_speaking: false,
                    persistent_dock: false,
                    overlay_peek: false,
                    peek_timeout_sec: 30.0,
                    peek_while_active: false,
                    dim_after_sec: 10.0,
                    hover_reveal_ms: 1000,
                    quick_launch: Vec::new(),
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
                kind: None,
                override_profile: None,
            }],
            profiles: vec![
                Profile {
                    id: "hold".into(),
                    name: "Push-to-talk".into(),
                    activation: ActivationType::Hold,
                    enabled: true,
                    hotkey: vec!["ControlLeft".into(), "ShiftLeft".into()],
                    backend_id: Some("default".into()),
                    tag: None,
                    language: None,
                    prompt: None,
                    decode_overrides: None,
                    override_profile: None,
                },
                Profile {
                    id: "handsfree".into(),
                    name: "Latch".into(),
                    activation: ActivationType::Latch,
                    enabled: true,
                    hotkey: vec!["ControlLeft".into(), "KeyH".into()],
                    backend_id: Some("default".into()),
                    tag: None,
                    language: None,
                    prompt: None,
                    decode_overrides: None,
                    override_profile: None,
                },
            ],
            app_rules: Vec::new(),
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
                tag: None,
                language: None,
                prompt: None,
                decode_overrides: None,
                override_profile: None,
            }
        })
        .collect();
    Some(Config {
        settings: legacy.settings,
        backends: legacy.profiles,
        profiles,
        app_rules: Vec::new(),
        version: Some(2),
    })
}

/// Read `config.json`, retrying briefly on a transient read error (a Windows AV/indexer lock usually
/// clears within tens of ms) so a momentary glitch isn't mistaken for a corrupt config. Returns
/// `Ok(None)` when the file genuinely doesn't exist yet (first run).
fn read_config_text(path: &Path) -> std::io::Result<Option<String>> {
    let mut attempt = 0;
    loop {
        match std::fs::read_to_string(path) {
            Ok(text) => return Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                attempt += 1;
                if attempt >= 3 {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Load config from `<dir>/config.json`, falling back to defaults if missing or
/// invalid. A legacy (pre-v2) config is migrated losslessly and re-saved so the
/// next load takes the fast path.
pub fn load(dir: &Path) -> Config {
    let path = config_path(dir);
    let text = match read_config_text(&path) {
        Ok(Some(text)) => text,
        Ok(None) => return Config::default(), // first run / file genuinely absent
        Err(e) => {
            // The file EXISTS but stayed unreadable across retries (bad permissions, a non-transient
            // lock). Don't silently fall back to defaults that the frontend's auto-save would then
            // write OVER the real config — back it up first (mirrors the parse-failure path below) so
            // it stays recoverable.
            tracing::warn!("config read failed ({e}); backing up + using defaults");
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            return Config::default();
        }
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
            // Don't silently discard a config we couldn't parse — the frontend arms auto-save
            // after load, so the next save would overwrite it with defaults and lose the user's
            // backends/profiles/settings for good. Stash the unparseable file so a corrupt,
            // hand-edited, or forward-incompatible config stays recoverable.
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
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
