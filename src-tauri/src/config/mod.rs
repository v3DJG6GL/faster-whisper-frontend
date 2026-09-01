//! Persisted configuration: Backends, dictation Profiles, and settings.
//!
//! Mirrors the TypeScript model in `src/lib/types.ts` (serde `camelCase`). The
//! config itself is stored as JSON in the OS app-config dir; raw API keys are
//! never written here — they live in the OS secret store, keyed by Backend id
//! (see [`keys`]).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub mod sync_state;

const KEYRING_SERVICE: &str = "faster-whisper-frontend";

/// Write a file only the owner can read (Unix `0600`; a no-op refinement on Windows, where the
/// per-user profile ACL already does this). `std::fs::write` would create it `0666 & ~umask` —
/// typically world-readable 0644, which is the wrong default for anything under the config dir:
/// sync-state.json carries the sync snapshot, config.json carries server URLs, and the Wayland
/// restore token is a capability that re-acquires input-injection rights without a consent prompt.
///
/// The open does not follow a symlink at the final component. `export_settings_file` writes to
/// `<user-picked-path>.json.tmp`, which can land in a world-writable directory (a save dialog
/// pointed at /tmp is entirely plausible) — without `O_NOFOLLOW` a pre-planted symlink there
/// would have this truncate and overwrite whatever it pointed at, with the user's privileges.
pub fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    // An existing file keeps its old mode through OpenOptions, so restate it after the open.
    let mut f = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(contents.as_bytes())?;
    f.sync_all()
}

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

/// Quick-add default: Super+Alt (user-set 2026-07-13; canonical order per
/// `code_rank`). Independent of the push-to-talk/hands-free defaults — no chord
/// nesting, so chord_engine.rs's grace-window abort never applies between the
/// defaults (it still works for user-configured superset chords).
fn default_quick_add_hotkey() -> Vec<String> {
    vec!["AltLeft".into(), "MetaLeft".into()]
}

fn default_peek_timeout() -> f64 {
    5.0
}

fn default_dim_after() -> f64 {
    2.5
}

fn default_hover_reveal() -> u32 {
    500
}

fn default_hands_free_auto_stop() -> f64 {
    30.0
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
    /// Follow the OS scheme (resolved in the webviews via prefers-color-scheme).
    Auto,
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
    OverlayStatsMetric::Both
}

/// How a Profile's chord behaves. First-class, decoupled from the Profile's id
/// (the old `DictationModeId = hold|handsfree` fused identity with behavior).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivationType {
    Hold,
    /// Tap once to start, tap again to stop. `alias` keeps configs written while
    /// this was called "latch" loading unchanged — the variant renamed, the stored
    /// value did not have to, and a config that still says `latch` is valid forever.
    #[serde(alias = "latch")]
    HandsFree,
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
    /// Per-Backend T2T translation defaults (targets/model/context/glossary/
    /// mode). Opaque to Rust like decode_overrides; skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_overrides: Option<serde_json::Value>,
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
    /// Override the Backend's endpoint (stream vs batch); None = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<EndpointKind>,
    /// Override the Backend's model; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Override the Backend's language; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Override the Backend's prompt; None/empty = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Phase-B placeholder: per-Profile decode-param overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_overrides: Option<serde_json::Value>,
    /// Per-Profile T2T translation overrides; for dictation, translateTo[0]
    /// is the injection target. Opaque to Rust; skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_overrides: Option<serde_json::Value>,
    /// Insert each phrase as the user speaks, rather than the whole transcript at the
    /// end. Replaced the global three-way `insertTiming`. None = off; skipped when None
    /// so existing configs round-trip byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_as_i_speak: Option<bool>,
    /// Per-Profile insertion overrides (method / paste chord / Enter / clipboard restore).
    /// Frontend-owned opaque JSON like `decode_overrides`: Rust stores and round-trips it
    /// but never interprets it. Skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insertion_overrides: Option<serde_json::Value>,
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
#[cfg_attr(windows, allow(dead_code))] // plugin accelerators are the non-Windows registrar (win_hotkeys owns Windows)
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
#[cfg_attr(windows, allow(dead_code))] // plugin accelerators are the non-Windows registrar (win_hotkeys owns Windows)
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
    /// unset. Factory default = the chord family's Ctrl+Shift+RightCtrl (inert until a
    /// quick-add list is designated — see apply_bindings). `#[serde(default = …)]` so
    /// configs missing the field get the factory value. Registered via the same paths
    /// as Profile hotkeys (evdev / plugin / the `--quick-add` CLI flag).
    /// Deserialized through `de_hotkey`, exactly like `Profile.hotkey`. Without it this chord got
    /// no canonicalization and no dedup, so it was the one binding whose LENGTH nothing bounded:
    /// `chords_from` maps every element (a million copies of one modifier all map), and
    /// `Engine::step` then walks the whole vector on EVERY system-wide key transition. The dedup
    /// makes that structurally impossible for all three consumers at once.
    #[serde(default = "default_quick_add_hotkey", deserialize_with = "de_hotkey")]
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
    /// One base folder for ALL stored audio — `dictations/`, `files/` and
    /// `links/` live inside it. None/empty = the default under the app data
    /// dir; the legacy `recordings_dir` acts as a fallback base so a custom
    /// recordings folder keeps working after the upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_base_dir: Option<String>,
    /// When saving: keep only the spoken spans (drop silence) in the .wav, so a long hands-free
    /// session doesn't store hours of quiet. `#[serde(default)]` (true) so older configs load.
    #[serde(default = "default_true")]
    pub trim_silence: bool,
    /// Delete saved recordings (and their transcript sidecars) older than this many days.
    /// 0 = keep forever. Saved recordings are a plaintext archive of everything dictated —
    /// passwords, private documents — and without this they accumulate for the life of the
    /// install. Defaults to 0 so an upgrade never deletes anything the user already has.
    #[serde(default)]
    pub recordings_retention_days: u32,
    pub mute_system_audio: bool,
    /// Auto-stop a hands-free session after this many minutes of continuous silence
    /// (0 = never). Prevents multi-hour runaway sessions and frees the mic/connection.
    ///
    /// `alias` accepts the pre-rename `latchAutoStopMin` key, so a config written before
    /// hands-free was called hands-free keeps the user's configured timeout instead of
    /// silently resetting to the 30-minute default.
    #[serde(default = "default_hands_free_auto_stop", alias = "latchAutoStopMin")]
    pub hands_free_auto_stop_min: f64,
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
    /// Show a tiny usage readout (today's words/minutes) on the chip. Default on;
    /// `#[serde(default = …)]` so configs missing the field get the factory value.
    #[serde(default = "default_true")]
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
    /// Keep the chip on screen (a standby dot) even when dictation is off. Default on.
    #[serde(default = "default_true")]
    pub persistent_dock: bool,
    /// After sitting idle, slide the chip to the screen edge (hover to restore). Default on.
    #[serde(default = "default_true")]
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

/// Capture threshold for the in-app log ring and the session log file.
/// Lower levels than the threshold are not recorded at all (not merely hidden).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    #[default]
    Info,
    Debug,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }
}

/// In-app logging preferences (Settings → General → Logging). Unlike
/// `sync`/`transcribe`, Rust interprets every field, so it's typed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingSettings {
    #[serde(default)]
    pub log_level: LogLevel,
    /// Delete session log files older than this many days on startup/save;
    /// 0 = keep forever.
    #[serde(default = "default_log_keep_days")]
    pub keep_days: u32,
    #[serde(default = "default_log_sidebar")]
    pub show_in_sidebar: bool,
    /// Custom log folder; None = `<app_data>/logs`. MACHINE-LOCAL by contract:
    /// the TS sync layer never ships it in a synced blob or export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_dir: Option<String>,
}

fn default_log_keep_days() -> u32 {
    30
}

fn default_log_sidebar() -> bool {
    true
}

impl Default for LoggingSettings {
    fn default() -> Self {
        LoggingSettings {
            log_level: LogLevel::default(),
            keep_days: default_log_keep_days(),
            show_in_sidebar: default_log_sidebar(),
            log_dir: None,
        }
    }
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
    /// Settings-sync metadata (enable flag, sync-backend id, per-device category
    /// toggles, per-backend URL overrides). Frontend-owned opaque JSON like
    /// `quick_launch`/`app_rules` — Rust stores + round-trips but never interprets
    /// it. MACHINE-LOCAL by contract: the TS sync layer excludes it from every
    /// synced blob and export. `#[serde(default, skip…)]` so older configs load
    /// and an unset value round-trips byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<serde_json::Value>,
    /// Transcribe-screen preferences (export format, display toggles, history
    /// retention). Frontend-owned opaque JSON like `sync` — Rust stores +
    /// round-trips it, and reads exactly ONE key (`historyRetentionDays`, via
    /// `transcribe_retention_days`) for the history pruning sweep. Was silently
    /// DROPPED before this field existed (serde ignored the unknown key), so
    /// these preferences never survived a restart. `#[serde(default, skip…)]`
    /// so older configs load and an unset value round-trips byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcribe: Option<serde_json::Value>,
    /// In-app logging preferences. `#[serde(default)]` so older configs load.
    #[serde(default)]
    pub logging: LoggingSettings,
    /// "Skip for now" on the first-run gate: fall back to the Home checklist
    /// instead of re-gating every launch. `#[serde(default)]` so older configs load.
    #[serde(default)]
    pub setup_dismissed: bool,
}

impl AppSettings {
    /// History retention window in days (0 = keep forever) from the opaque
    /// `transcribe` blob — the one transcribe key Rust interprets.
    pub fn transcribe_retention_days(&self) -> u32 {
        self.transcribe_days("historyRetentionDays", 0)
    }

    /// Dictation-history retention window (days; 0 = keep forever). Defaults to
    /// 7 — dictations are typed into their target and done, so their record
    /// expires faster than file transcriptions by design.
    pub fn dictation_retention_days(&self) -> u32 {
        self.transcribe_days("dictationRetentionDays", 7)
    }

    /// Whether dictation sessions are recorded to History at all. Default on —
    /// consistent with "Keep audio recordings", which already stores each
    /// dictation's text sidecar. Off also wipes the existing dictation store.
    pub fn keep_dictation_history(&self) -> bool {
        self.transcribe
            .as_ref()
            .and_then(|v| v.get("keepDictationHistory"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    fn transcribe_days(&self, key: &str, default: u32) -> u32 {
        self.transcribe
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_u64())
            .map(|d| d.min(u64::from(u32::MAX)) as u32)
            .unwrap_or(default)
    }
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
                theme: ThemeName::Auto,
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
                    quick_add_hotkey: default_quick_add_hotkey(),
                },
                recording: RecordingSettings {
                    indicator_position: IndicatorPosition::Top,
                    save_recordings: true,
                    recordings_dir: None,
                    audio_base_dir: None,
                    trim_silence: true,
                    recordings_retention_days: 0,
                    mute_system_audio: true,
                    hands_free_auto_stop_min: 30.0,
                    realtime_preview: true,
                    realtime_preview_on_hover: false,
                    show_profile_on_overlay: true,
                    show_profile_on_hover: false,
                    show_stats_on_overlay: true,
                    overlay_stats_on_hover: false,
                    overlay_stats_metric: OverlayStatsMetric::Both,
                    show_target_on_overlay: true,
                    show_target_on_hover: false,
                    show_target_only_speaking: false,
                    persistent_dock: true,
                    overlay_peek: true,
                    peek_timeout_sec: 5.0,
                    peek_while_active: false,
                    dim_after_sec: 2.5,
                    hover_reveal_ms: 500,
                    quick_launch: Vec::new(),
                },
                sync: None,
                transcribe: None,
                logging: LoggingSettings::default(),
                setup_dismissed: false,
            },
            // Fresh installs start EMPTY — no seeded backend or profiles. The
            // first-run onboarding (gate → restore-or-starters → quick add) or the
            // Home checklist walks the user to a working setup; the pre-v2 legacy
            // migration below still builds real entries, so upgraders never see it.
            backends: Vec::new(),
            profiles: Vec::new(),
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
                LegacyModeId::Handsfree => ("handsfree", "Hands-free", ActivationType::HandsFree),
            };
            Profile {
                id: id.into(),
                name: name.into(),
                activation,
                enabled: m.enabled,
                hotkey: m.hotkey,
                backend_id: m.profile_id,
                tag: None,
                endpoint: None,
                model: None,
                language: None,
                prompt: None,
                decode_overrides: None,
                translation_overrides: None,
                type_as_i_speak: None,
                insertion_overrides: None,
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

/// Load config from `<dir>/config.json`, falling back to defaults if missing or invalid. A legacy
/// (pre-v2) config is migrated losslessly and re-saved so the next load takes the fast path.
///
/// Returns `(config, recovered)`: `recovered` is true ONLY when a PRESENT-but-unreadable/unparseable
/// config was backed up to `.json.bak` and replaced with defaults — so the frontend can warn the user
/// their settings were reset (and where the backup is) instead of silently losing them. It is false
/// for a clean load, a migration, and a genuine first-run (absent file).
pub fn load_outcome(dir: &Path) -> (Config, bool) {
    // Sticky for the process: once a corrupt config is backed up + reset, EVERY later load this
    // session reports `recovered` — even the caller that lost the startup race. Two webviews load
    // config concurrently at launch (the main window's initConfig and the prewarmed hidden quick-add
    // window), both hitting the unsynchronized `load_config` command. Without this, if quick-add wins
    // it renames config.json → .bak, then the main window's read sees NotFound → `(default, false)`,
    // so the reset banner (surfaced ONLY by the main window's initConfig on `recovered`) never shows
    // and its armed auto-save silently persists the seeded defaults over the user's backed-up config.
    static RECOVERED_THIS_SESSION: Mutex<bool> = Mutex::new(false);
    // Held across the whole read+rename so the two concurrent startup loads can't interleave the
    // destructive recovery (contended only at launch, by exactly those two callers).
    let mut recovered = RECOVERED_THIS_SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let path = config_path(dir);
    let text = match read_config_text(&path) {
        Ok(Some(text)) => text,
        // First run / file genuinely absent — UNLESS a prior load this session already recovered
        // (the file was renamed out from under us), in which case keep reporting the reset.
        Ok(None) => return (Config::default(), *recovered),
        Err(e) => {
            // The file EXISTS but stayed unreadable across retries (bad permissions, a non-transient
            // lock). Don't silently fall back to defaults that the frontend's auto-save would then
            // write OVER the real config — back it up first (mirrors the parse-failure path below) so
            // it stays recoverable, and report `recovered` so the frontend surfaces the reset.
            tracing::warn!("config read failed ({e}); backing up + using defaults");
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            *recovered = true;
            return (Config::default(), true);
        }
    };
    // Fast path: already the current (v2) shape.
    if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
        return (cfg, false);
    }
    // Migration path: a legacy `profiles`/`modes` config (no `backends`).
    match migrate_legacy(&text) {
        Some(cfg) => {
            tracing::info!("[config] migrated legacy backends/profiles → v2");
            let _ = save(dir, &cfg);
            (cfg, false)
        }
        None => {
            tracing::warn!("config parse failed; backing up + using defaults");
            // Don't silently discard a config we couldn't parse — the frontend arms auto-save
            // after load, so the next save would overwrite it with defaults and lose the user's
            // backends/profiles/settings for good. Stash the unparseable file so a corrupt,
            // hand-edited, or forward-incompatible config stays recoverable, and report `recovered`.
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            *recovered = true;
            (Config::default(), true)
        }
    }
}

/// Convenience wrapper for callers that don't need the `recovered` flag.
pub fn load(dir: &Path) -> Config {
    load_outcome(dir).0
}

/// Persist config atomically to `<dir>/config.json`.
pub fn save(dir: &Path, config: &Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = config_path(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config)?;
    write_private(&tmp, &text)?;
    // Don't leave the tmp behind when the rename fails (a Windows AV/indexer lock — the exact
    // condition the config reader already retries for — a read-only or full volume, a cross-device
    // app-data dir). The settings-export sibling already cleans up on this path.
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Secret-store helpers: API keys are keyed by Backend id, never written to disk
/// in cleartext. (The id values are stable across the v2 migration, so existing
/// keyring entries keep resolving.)
pub mod keys {
    use super::KEYRING_SERVICE;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    /// Write-through cache over the OS store. Every command resolves the key
    /// fresh, so without this each poll/translate-chunk/WS-connect is a D-Bus
    /// round trip — tens of ms each, and on flaky Secret Service daemons every
    /// read is another chance to fail. The store is only ever written through
    /// `set`/`delete` below, so the cache cannot go stale within the process.
    fn cache() -> &'static Mutex<HashMap<String, String>> {
        static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn entry(backend_id: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, backend_id)
    }

    pub fn set(backend_id: &str, secret: &str) -> anyhow::Result<()> {
        entry(backend_id)?.set_password(secret)?;
        cache()
            .lock()
            .unwrap()
            .insert(backend_id.to_string(), secret.to_string());
        Ok(())
    }

    pub fn get(backend_id: &str) -> Option<String> {
        if let Some(k) = cache().lock().unwrap().get(backend_id) {
            return Some(k.clone());
        }
        // One extra attempt on a transient platform error: each try opens a
        // fresh D-Bus connection (and, with an encrypted session, a fresh DH
        // keypair), so per-session daemon flakiness rarely strikes twice.
        for attempt in 0..2u8 {
            match entry(backend_id).and_then(|e| e.get_password()) {
                Ok(k) => {
                    if attempt > 0 {
                        tracing::debug!("[keys] keyring read recovered on retry");
                    }
                    cache()
                        .lock()
                        .unwrap()
                        .insert(backend_id.to_string(), k.clone());
                    return Some(k);
                }
                // Simply not stored — the caller treats the backend as keyless.
                Err(keyring::Error::NoEntry) => return None,
                // Anything else (Ambiguous duplicate items, a store/platform failure) means a
                // key may EXIST but cannot be read — the visible symptom is an opaque 403 on
                // connect, so say what actually happened.
                Err(e) => {
                    if attempt == 0 {
                        continue;
                    }
                    // Debug-format the id, like `resolve_key`'s sibling log: it is a sync/import-supplied
                    // string with no length bound and no control-character fold, so a Display copy would
                    // let a peer forge whole records in the log the user is asked to send for support.
                    tracing::warn!("[keys] keyring read failed for backend {backend_id:?}: {e}");
                }
            }
        }
        None
    }

    pub fn delete(backend_id: &str) -> anyhow::Result<()> {
        cache().lock().unwrap().remove(backend_id);
        match entry(backend_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
