//! Persisted configuration: Backends, dictation Profiles, and settings.
//!
//! Mirrors the TypeScript model in `src/lib/types.ts` (serde `camelCase`). The
//! config itself is stored as JSON in the OS app-config dir; raw API keys are
//! never written here — they live in the OS secret store, keyed by Backend id
//! (see [`keys`]).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "faster-whisper-frontend";

/// Write a file only the owner can read (Unix `0600`). `std::fs::write` would create it
/// `0666 & ~umask` — typically world-readable 0644, which is the wrong default for anything under
/// the config dir: sync-state.json carries the sync snapshot, config.json carries server URLs, and
/// the Wayland restore token is a capability that re-acquires input-injection rights without a
/// consent prompt.
///
/// No Windows ACL here: the config-dir callers write under %APPDATA%, inside the profile, whose
/// inherited ACL already shuts other accounts out. A path outside it (the settings export) goes
/// through [`write_export_atomic`].
///
/// On Linux the open does not follow a symlink at the final component. `export_settings_file`
/// writes to `<user-picked-path>.tmp`, which can land in a world-writable directory (a save
/// dialog pointed at /tmp) — without `O_NOFOLLOW` a pre-planted symlink there would have this
/// truncate and overwrite whatever it pointed at, with the user's privileges.
pub fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    fill_private(open_private(path)?, contents)
}

/// The open half of `write_private`: created or truncated, 0600, final symlink not followed.
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
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
    // Tolerate fchmod failure (e.g. FAT/exFAT, some FUSE mounts).
    let f = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    Ok(f)
}

fn fill_private(mut f: std::fs::File, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    f.write_all(contents.as_bytes())?;
    f.sync_all()
}

/// Replace `path` atomically: write `<path>.tmp` owner-only (`write_private`), then rename it
/// into place, so a reader sees the old file or the new one, never half of it. The tmp is
/// removed when the write OR the rename fails (write_private can fail after creating the file,
/// e.g. on a full volume).
pub fn write_private_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = crate::transport::media::tmp_sibling(path);
    replace_via_tmp(&tmp, path, |t| write_private(t, contents))
}

/// `write_private_atomic` for a path OUTSIDE the config dir — the settings export, at a
/// save-dialog path that may carry a folder's permissive inherited ACL. On Windows the tmp also
/// gets an owner-only DACL before the contents land; the rename keeps it.
///
/// A DACL failure only warns, like the Unix fchmod above: FAT/exFAT sticks hold no ACL and are
/// exactly where an export is carried to another machine, and failing would block the export.
pub fn write_export_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = crate::transport::media::tmp_sibling(path);
    replace_via_tmp(&tmp, path, |t| {
        let f = open_private(t)?;
        #[cfg(windows)]
        if let Err(e) = crate::audio::windows_owner_only_dacl(t) {
            tracing::warn!(
                "[config] could not restrict {} to the current user: {e}",
                t.display()
            );
        }
        fill_private(f, contents)
    })
}

/// Fill `tmp` with `fill`, then rename it over `dest`. `tmp` is removed when the fill OR the
/// rename fails (a fill can fail after creating it).
pub(crate) fn replace_via_tmp(
    tmp: &Path,
    dest: &Path,
    fill: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let done = fill(tmp).and_then(|()| std::fs::rename(tmp, dest));
    if done.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    done
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

/// Ctrl+V; terminals (Konsole, kitty, …) need Ctrl+Shift+V, hence a configurable chord.
fn default_paste_shortcut() -> Vec<String> {
    vec!["ControlLeft".into(), "KeyV".into()]
}

fn default_true() -> bool {
    true
}

/// Quick-add default: Super+Alt (canonical order per `code_rank`). An independent chord
/// beside the push-to-talk/hands-free defaults; nesting it over a hold is a shadow
/// conflict, not a feature (see hotkeys/chord_engine.rs).
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

fn default_scale() -> f64 {
    1.0
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

/// How a Profile's chord behaves, independent of the Profile's id.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivationType {
    Hold,
    /// Tap once to start, tap again to stop. `alias`: configs that still store the
    /// pre-rename value `latch` stay valid.
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
    /// Default vocabulary / initial_prompt. Stays a REQUIRED string so a config
    /// written by this build still parses in one that predates the tri-state below
    /// (a missing field fails the typed parse, and `load_outcome`'s answer to that is
    /// to rename config.json → .bak and load defaults — a downgrade would wipe the
    /// user's backends, profiles and hotkeys).
    pub prompt: String,
    /// The explicit-clear half of the prompt's tri-state: `prompt` empty + this set
    /// means "send an empty prompt" (suppress the server's DEFAULT_PROMPT), while
    /// `prompt` empty on its own keeps meaning "inherit". Additive and skipped when
    /// None, so existing configs round-trip byte-stable and an older build — which
    /// ignores the unknown key — reads the "" as the inherit it always meant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cleared: Option<bool>,
    pub response_format: ResponseFormat,
    /// Per-Backend decode-param defaults, opaque to Rust. Skipped when None so
    /// existing configs round-trip byte-stable and the frontend need not send it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_overrides: Option<serde_json::Value>,
    /// Per-Backend T2T translation defaults (targets/model/context/glossary/
    /// mode). Opaque to Rust like decode_overrides; skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_overrides: Option<serde_json::Value>,
    /// None behaves as `Auto`. Skipped when None so existing configs round-trip
    /// byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BackendKind>,
    /// Name of a server-side override-profile this backend references per request
    /// (faster-whisper-backend only). None/empty = none. Skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_profile: Option<String>,
}

/// A user-defined dictation setup: an activation type + chord, a target [`Backend`],
/// and optional per-Profile overrides of that Backend's settings (None = inherit).
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
    /// Override the Backend's prompt: None = inherit, "" = explicit clear (send no
    /// initial_prompt), a value = override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Per-Profile decode-param overrides, opaque to Rust.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_overrides: Option<serde_json::Value>,
    /// Per-Profile T2T translation overrides; for dictation, every translateTo
    /// target is injected (blank-line separated). Opaque to Rust; skipped when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_overrides: Option<serde_json::Value>,
    /// Insert each phrase as the user speaks, rather than the whole transcript at the
    /// end. None = inherit `general.typeAsISpeak`; skipped when None so existing configs
    /// round-trip byte-stable.
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
    /// Ask which target languages to translate into at activation time instead of
    /// using the Profile's fixed `translationOverrides.translateTo`. Frontend-owned;
    /// Rust only round-trips it, but it must be typed here: a key missing from this
    /// mirror is dropped on every save. Skipped when None so configs round-trip byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_translation_targets: Option<bool>,
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
    // Equal-rank codes (e.g. two non-modifier keys in an N-chord, both rank 100) fall back to a
    // lexical tie-break so the order is press-order-independent. Mirrors the TS `canonicalizeCodes`
    // so the two layers agree on equality + round-trip. The tie-break also makes identical codes
    // adjacent, so `dedup` removes them all (not just consecutive duplicates).
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
#[cfg_attr(windows, allow(dead_code))] // plugin accelerators are the non-Windows registrar (hotkeys::windows owns Windows)
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
#[cfg_attr(windows, allow(dead_code))] // plugin accelerators are the non-Windows registrar (hotkeys::windows owns Windows)
pub fn codes_to_accelerator(codes: &[String]) -> Option<String> {
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for c in codes {
        let m = match c.as_str() {
            "ControlLeft" | "ControlRight" => "Ctrl",
            "AltLeft" => "Alt",
            "AltRight" => return None, // AltGr — evdev-only
            "ShiftLeft" | "ShiftRight" => "Shift",
            "MetaLeft" | "MetaRight" => "Super",
            other => {
                // A second non-modifier means this is a multi-key (N-chord) binding,
                // which a plugin accelerator can't express (modifiers + exactly ONE key).
                // Return None so it routes to the evdev/CLI path instead of silently
                // collapsing to — and globally hijacking — the lexically-last key.
                if key.is_some() {
                    return None;
                }
                key = Some(code_to_token(other));
                continue;
            }
        };
        if !mods.contains(&m) {
            mods.push(m);
        }
    }
    let key = key?;
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
    /// Retired three-way timing (off / on stop / live), superseded by `type_as_i_speak`.
    /// Kept so a rollback to an older build reads a conservative value instead of
    /// defaulting back to "live"; `#[serde(default)]` so configs predating it load.
    #[serde(default = "default_insert_timing")]
    pub insert_timing: InsertTiming,
    pub insert_method: InsertMethod,
    /// Chord for the "clipboard paste" method (KeyboardEvent.code list). `#[serde(default)]`
    /// so configs predating this field load with the Ctrl+V default.
    #[serde(default = "default_paste_shortcut")]
    pub paste_shortcut: Vec<String>,
    pub auto_enter: bool,
    pub restore_clipboard: bool,
    /// Keep dictated text out of the clipboard history (Win+V, Klipper & co) and off the
    /// Windows cloud clipboard: every transcript write carries the platform's "don't record
    /// this" hint (`inject::set_clipboard_privacy`). Restores of the user's own clipboard are
    /// ALWAYS excluded regardless — a restored snapshot has lost its source's flags, and it may
    /// be a password a manager had marked. Typed here, not left to the frontend, because this
    /// struct is a typed mirror: a key missing from it is silently dropped on every save.
    /// `default_true` so configs written before it existed get the private behaviour.
    #[serde(default = "default_true")]
    pub exclude_from_clipboard_history: bool,
    /// Default for the per-Profile "type as I speak"; carries forward what the retired
    /// three-way `insert_timing` meant by "live". `#[serde(default)]` so configs written
    /// before it existed load unchanged (and get it from the frontend migration).
    #[serde(default = "default_true")]
    pub type_as_i_speak: bool,
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
    /// unset. Factory default = Super+Alt, inert until a quick-add list is designated (see
    /// apply_bindings). Registered via the same paths as Profile hotkeys (Windows hook / evdev /
    /// plugin / the `--quick-add` CLI flag). Deserialized through `de_hotkey` like `Profile.hotkey`:
    /// its dedup bounds the chord's length, which `Engine::step` walks on every system-wide
    /// key transition.
    #[serde(default = "default_quick_add_hotkey", deserialize_with = "de_hotkey")]
    pub quick_add_hotkey: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSettings {
    pub indicator_position: IndicatorPosition,
    pub save_recordings: bool,
    /// User-chosen folder for saved `.wav` recordings; None/empty = the default under
    /// the app data dir.
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
    /// The audio half of the one dictation clock (see `AppSettings::effective_dictation_days`):
    /// the recordings sweep deletes saved recordings (and their transcript sidecars) older than
    /// the stricter non-zero of this key and `transcribe.dictationRetentionDays` (default 7), so
    /// 0 here means keep forever only when the record window is 0 too. Settings' "Delete
    /// dictations after" row writes both keys. Saved recordings are a plaintext archive of
    /// everything dictated — passwords, private documents — and without a window they
    /// accumulate for the life of the install.
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
    /// Show the translation route ("→ FR IT") on the chip, independent of the Profile
    /// tag. `#[serde(default = …)]` so older configs keep the route they had.
    #[serde(default = "default_true")]
    pub show_route_on_overlay: bool,
    /// When the route is shown, reveal it only while hovering the chip (vs. always).
    #[serde(default)]
    pub show_route_on_hover: bool,
    /// Show a tiny usage readout (today's words/minutes) on the chip.
    #[serde(default = "default_true")]
    pub show_stats_on_overlay: bool,
    /// When the readout is shown, reveal it only while hovering the chip (vs. always).
    /// `#[serde(default)]` so older configs default to always-shown.
    #[serde(default)]
    pub overlay_stats_on_hover: bool,
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
    /// "Chip size": one factor for the whole chip (0.75–2.0). Rust never reads the stored
    /// value: the webview passes it to `show_overlay`, which clamps it.
    #[serde(default = "default_scale")]
    pub chip_scale: f64,
    /// "Dot size": extra factor (1.0–3.0) for the status dot while the chip is minimized
    /// (standby dot / tucked at the edge). Frontend-only — pure CSS in the chip webview.
    #[serde(default = "default_scale")]
    pub dot_scale: f64,
    /// Send the dictated-into app id with each session's usage outcome. Older configs
    /// default on, matching the TS default.
    #[serde(default = "default_true")]
    pub report_target_app: bool,
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

/// In-app logging preferences (Settings → General → Logging). Typed rather
/// than an opaque blob like `sync`/`transcribe`: Rust interprets `log_level`,
/// `keep_days` and `log_dir`; `show_in_sidebar` is frontend-only nav state.
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
    /// Custom log folder; None = `<app_local_data>/logs` (never the roaming
    /// dir). Machine-specific: never included in an export, and synced only
    /// when this device's `logFolder` gate is on (TS `extractLogging` on
    /// compose and the `gates.logFolder` check on apply, src/lib/sync/sync.ts).
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
    /// The Signal colour (hue in degrees) and its motion — frontend-owned like `sync`
    /// and `transcribe`: Rust stores + round-trips both and never interprets them.
    /// The Quick-Add window reads the config THROUGH this struct (`read_config`), so a
    /// key missing here is silently dropped by serde. An unset value round-trips
    /// byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_hue: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_motion: Option<serde_json::Value>,
    #[serde(default)]
    pub microphone_id: Option<String>,
    /// The pinned microphone's name when it was picked (shown while it is unplugged). Storage only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_label: Option<String>,
    /// Which Profile the Home "click to dictate" button targets (None = first
    /// enabled). Pure storage; the frontend resolves it.
    #[serde(default)]
    pub home_profile_id: Option<String>,
    /// The pinned quick-add list (see `QuickAddTarget`). None = not chosen yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_add_list: Option<QuickAddTarget>,
    pub general: GeneralSettings,
    pub recording: RecordingSettings,
    /// Settings-sync metadata (enable flag, sync-backend id, per-device category
    /// toggles, per-backend URL overrides). Frontend-owned opaque JSON like
    /// `quick_launch` — Rust stores + round-trips but never interprets
    /// it. MACHINE-LOCAL by contract: the TS sync layer excludes it from every
    /// synced blob and export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<serde_json::Value>,
    /// Transcribe-screen preferences (export format, display toggles, history
    /// retention). Frontend-owned opaque JSON like `sync` — Rust stores +
    /// round-trips it, and reads exactly THREE keys — `historyRetentionDays`
    /// (`transcribe_retention_days`), `dictationRetentionDays`
    /// (`dictation_retention_days`) and `keepDictationHistory`
    /// (`keep_dictation_history`) — for the retention sweeps in store/transcripts.rs.
    /// Renaming any of them on the TS side silently changes retention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcribe: Option<serde_json::Value>,
    #[serde(default)]
    pub logging: LoggingSettings,
    /// "Skip for now" on the first-run gate: fall back to the Home checklist
    /// instead of re-gating every launch.
    #[serde(default)]
    pub setup_dismissed: bool,
    /// Most-recently picked dictation translation targets, newest first — seeds the
    /// picker's "Recent" group. Frontend-owned and machine-local (the sync layer
    /// excludes it); Rust only stores + round-trips it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent_translation_targets: Option<Vec<String>>,
    /// Most-recently picked spoken languages, newest first — the spoken-language picker's
    /// "Recent" group. Frontend-owned and machine-local like `recent_translation_targets`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent_spoken_languages: Option<Vec<String>>,
}

impl AppSettings {
    /// History retention window in days (0 = keep forever) from the opaque
    /// `transcribe` blob — one of the three transcribe keys Rust interprets.
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

    /// The ONE dictation clock Settings shows ("Delete dictations after"): the stricter
    /// non-zero of the audio window (`recording.recordingsRetentionDays`) and the record
    /// window (`dictationRetentionDays`), mirroring Settings.tsx's `dictDays`. A never-touched
    /// install has audio 0 + record 7 and the row reads 7 days, so both sweeps use this value
    /// and text and audio leave together as the row promises. 0 = keep forever.
    pub fn effective_dictation_days(&self) -> u32 {
        match (
            self.recording.recordings_retention_days,
            self.dictation_retention_days(),
        ) {
            (0, d) | (d, 0) => d,
            (audio, record) => audio.min(record),
        }
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
    /// Frontend-owned opaque JSON like `quick_launch` — Rust stores + round-trips it and reads
    /// three keys: `id` and `appId` (the webview's `wellFormedAppRules` floor: both strings,
    /// non-empty key; a rule failing it is ignored, as the webview ignores it) and
    /// `remoteDesktop` (`inject::rdp_client::set_rules`, for the Quick-Add grab and the
    /// push-to-talk liveness gate).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub app_rules: Vec<serde_json::Value>,
    /// Schema version (absent = pre-versioning; current ⇒ 3, see `CONFIG_VERSION` in store.ts). Gates the TS loader's one-shot migrations.
    #[serde(default)]
    pub version: Option<u32>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            settings: AppSettings {
                theme: ThemeName::Auto,
                accent_hue: None,
                accent_motion: None,
                microphone_id: None,
                microphone_label: None,
                home_profile_id: None,
                quick_add_list: None,
                general: GeneralSettings {
                    open_at_login: false,
                    start_minimized: false,
                    insert_timing: default_insert_timing(),
                    insert_method: InsertMethod::Paste,
                    paste_shortcut: default_paste_shortcut(),
                    auto_enter: false,
                    type_as_i_speak: true,
                    restore_clipboard: true,
                    exclude_from_clipboard_history: true,
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
                    hands_free_auto_stop_min: default_hands_free_auto_stop(),
                    realtime_preview: true,
                    realtime_preview_on_hover: false,
                    show_profile_on_overlay: true,
                    show_profile_on_hover: false,
                    show_route_on_overlay: true,
                    show_route_on_hover: false,
                    show_stats_on_overlay: true,
                    overlay_stats_on_hover: false,
                    overlay_stats_metric: default_stats_metric(),
                    show_target_on_overlay: true,
                    show_target_on_hover: false,
                    show_target_only_speaking: false,
                    persistent_dock: true,
                    overlay_peek: true,
                    peek_timeout_sec: default_peek_timeout(),
                    peek_while_active: false,
                    dim_after_sec: default_dim_after(),
                    hover_reveal_ms: default_hover_reveal(),
                    chip_scale: default_scale(),
                    dot_scale: default_scale(),
                    report_target_app: true,
                    quick_launch: Vec::new(),
                },
                sync: None,
                transcribe: None,
                logging: LoggingSettings::default(),
                setup_dismissed: false,
                recent_translation_targets: None,
                recent_spoken_languages: None,
            },
            // Fresh installs start EMPTY — no seeded backend or profiles. The
            // first-run onboarding (gate → restore-or-starters → quick add) or the
            // Home checklist walks the user to a working setup; the pre-v2 legacy
            // migration below still builds real entries, so upgraders never see it.
            backends: Vec::new(),
            profiles: Vec::new(),
            app_rules: Vec::new(),
            version: Some(3),
        }
    }
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

/// Extension of the reset backup (`config.json.bak`): what `bak_target` writes and
/// `reset_unconfirmed` looks for.
const BAK_EXT: &str = "json.bak";

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
                ask_translation_targets: None,
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
/// `Ok(None)` when the file genuinely doesn't exist yet (first run). Also reads sync-state.json,
/// jobs-ledger.json and usage-outcomes.json.
///
/// Decoded lossily: invalid UTF-8 is a permanent CONTENT fault, so it reaches the callers' parse
/// (unparseable → rebuilt) instead of their unreadable path, which never saves over the file —
/// one stray byte would pause sync on every launch.
pub(crate) fn read_config_text(path: &Path) -> std::io::Result<Option<String>> {
    Ok(read_config_bytes(path)?.map(|bytes| {
        // A leading byte-order mark (an editor's "UTF-8 with BOM") is not JSON to serde,
        // and would reset a valid file to defaults.
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        String::from_utf8_lossy(bytes).into_owned()
    }))
}

/// `read_config_text`'s retrying read, with the raw bytes (the launch load and the identifier
/// migration keep them aside when they are not valid UTF-8).
pub(crate) fn read_config_bytes(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let mut attempt = 0;
    loop {
        match std::fs::read(path) {
            Ok(bytes) => return Ok(Some(bytes)),
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

/// Set when `load_outcome` reset an unreadable/unparseable config to defaults but could NOT
/// stash the original as `.json.bak` (e.g. a Windows lock without delete/read share). `save`
/// then refuses for the rest of the session: the frontend's armed auto-save would otherwise
/// replace the only copy of the user's backends/profiles/hotkeys with the defaults.
static BACKUP_FAILED: AtomicBool = AtomicBool::new(false);

/// Whether this session's load reset an unusable config WITHOUT managing a backup — `save`
/// refuses from then on, so the frontend says so instead of promising a `.json.bak`.
pub fn backup_failed() -> bool {
    BACKUP_FAILED.load(Ordering::SeqCst)
}

/// Sticky per-process "a load reset the config this session" (see `load_outcome`).
static RECOVERED_THIS_SESSION: Mutex<bool> = Mutex::new(false);

/// Whether a load this session reset an unusable config (backup made or not).
pub fn reset_this_session() -> bool {
    *RECOVERED_THIS_SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A reset nobody has saved over yet: `config.json` is gone but its `.bak` is there (the reset
/// renamed it, and no settings change has been written since). A later launch then loads the
/// defaults with `recovered = false`, so the startup retention sweeps check this too — the
/// defaults' window must not delete history the backed-up settings said to keep.
pub fn reset_unconfirmed(dir: &Path) -> bool {
    let path = config_path(dir);
    !path.exists() && path.with_extension(BAK_EXT).exists()
}

/// Retention sweeps and log pruning must not run on a reset nobody has saved over (this
/// session's, or an earlier launch's still-unconfirmed one).
pub fn retention_held(dir: &Path) -> bool {
    reset_this_session() || reset_unconfirmed(dir)
}

/// Where to stash a config backup: `config.json.bak`, after moving an existing `.bak` aside to
/// a timestamped `config.json.bak.<secs>` sibling — a second reset in a later session must not
/// replace the backup of the user's original settings with the post-reset file. When the old
/// `.bak` can't be moved, the new backup takes the timestamped name instead. An existing `.bak`
/// byte-identical to the file being backed up is reused as is: a locked corrupt config that
/// `backup_unreadable` could only copy stays in place, and every later load this session (and
/// every launch) would otherwise move yet another identical copy aside.
fn bak_target(path: &Path) -> PathBuf {
    let bak = path.with_extension(BAK_EXT);
    if !bak.exists() {
        return bak;
    }
    if let (Ok(old), Ok(new)) = (std::fs::read(&bak), std::fs::read(path)) {
        if old == new {
            return bak;
        }
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut aside = path.with_extension(format!("{BAK_EXT}.{secs}"));
    let mut n = 1;
    while aside.exists() {
        aside = path.with_extension(format!("{BAK_EXT}.{secs}-{n}"));
        n += 1;
    }
    match std::fs::rename(&bak, &aside) {
        Ok(()) => bak,
        Err(_) => aside,
    }
}

/// Stash an unusable `config.json` as `config.json.bak` (see `bak_target`) — rename first, a
/// copy when the rename is refused (the original then stays in place, but a backup exists).
/// False only when neither worked.
fn backup_unreadable(path: &Path) -> bool {
    let bak = bak_target(path);
    let Err(rename_err) = std::fs::rename(path, &bak) else {
        return true;
    };
    match std::fs::copy(path, &bak) {
        Ok(_) => true,
        Err(copy_err) => {
            tracing::error!(
                "config backup failed (rename: {rename_err}; copy: {copy_err}); \
                 refusing to overwrite config.json this session"
            );
            false
        }
    }
}

/// `read_config_text`'s decode, for the launch load. Invalid UTF-8 still loads lossily (no reset,
/// no paused sync), but a whole file re-encoded by a hand edit (ANSI/CP1252 Notepad) turns EVERY
/// non-ASCII character into U+FFFD, and the next auto-save writes that over the only copy. So the
/// raw bytes are kept first in `config.json.invalid-utf8.bak` — the identifier migration's name;
/// not `.json.bak`, which the reset banner reads as "a config the loader reset". A copy already
/// holding these bytes is reused; a different one (an earlier incident) is kept and the next
/// numbered name is used.
fn decode_keeping_invalid_utf8(path: &Path, bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if std::str::from_utf8(body).is_err() {
        let kept = (0..10).find_map(|n| {
            let side = match n {
                0 => path.with_extension("json.invalid-utf8.bak"),
                n => path.with_extension(format!("json.invalid-utf8.{n}.bak")),
            };
            match crate::migrate_identifier::keep_private_copy(&side, bytes) {
                Ok(()) => Some(Ok(side)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => std::fs::read(&side)
                    .is_ok_and(|b| b == bytes)
                    .then_some(Ok(side)),
                Err(e) => Some(Err(e)),
            }
        });
        match kept {
            Some(Ok(side)) => tracing::warn!(
                "[config] config.json is not valid UTF-8; loaded lossily, original bytes kept in {}",
                side.display()
            ),
            Some(Err(e)) => tracing::warn!(
                "[config] config.json is not valid UTF-8; loaded lossily, its original bytes could not be kept ({e})"
            ),
            None => tracing::warn!(
                "[config] config.json is not valid UTF-8; loaded lossily, no free side-copy name left"
            ),
        }
    }
    String::from_utf8_lossy(body).into_owned()
}

/// Load config from `<dir>/config.json`, falling back to defaults if missing or invalid. A legacy
/// (pre-v2) config is migrated losslessly and re-saved so the next load takes the fast path.
///
/// Returns `(config, recovered)`: `recovered` is true when a PRESENT-but-unreadable/unparseable
/// config was replaced with defaults — by this load or an earlier one this session (sticky, see
/// below) — and backed up to `.json.bak` unless `backup_failed()`, so the frontend can warn the user
/// their settings were reset instead of silently losing them. Before any reset it is false for a
/// clean load, a migration, and a genuine first-run (absent file).
pub fn load_outcome(dir: &Path) -> (Config, bool) {
    // Sticky for the process: setup() loads before any webview exists, then the main window's
    // `load_config` loads again. Setup's recovery renamed config.json → .bak, so that second load
    // would see NotFound → `(default, false)`: the reset banner (shown ONLY on its `recovered`)
    // never appears and its armed auto-save persists the defaults over the backed-up config.
    // (Quick-Add reads through `try_load`, which never recovers.) Held across the whole
    // read+rename so two loads can't interleave the destructive recovery.
    let mut recovered = RECOVERED_THIS_SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let path = config_path(dir);
    let text = match read_config_bytes(&path) {
        Ok(Some(bytes)) => decode_keeping_invalid_utf8(&path, &bytes),
        // First run / file genuinely absent — UNLESS a prior load this session already recovered
        // (the file was renamed out from under us), in which case keep reporting the reset.
        Ok(None) => return (Config::default(), *recovered),
        Err(e) => {
            // The file EXISTS but stayed unreadable across retries (bad permissions, a non-transient
            // lock). Don't silently fall back to defaults that the frontend's auto-save would then
            // write OVER the real config — back it up first (mirrors the parse-failure path below) so
            // it stays recoverable, and report `recovered` so the frontend surfaces the reset.
            tracing::warn!("config read failed ({e}); backing up + using defaults");
            if !backup_unreadable(&path) {
                BACKUP_FAILED.store(true, Ordering::SeqCst);
            }
            *recovered = true;
            return (Config::default(), true);
        }
    };
    // Fast path: already the current (v3) shape.
    if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
        // BACKUP_FAILED stays set even when a later load reads the file fine: an earlier load
        // may already have handed defaults to a webview, whose auto-save would then overwrite
        // the real config (and run the defaults' retention sweeps).
        return (cfg, *recovered);
    }
    // Migration path: a legacy `profiles`/`modes` config (no `backends`).
    match migrate_legacy(&text) {
        Some(cfg) => {
            tracing::info!("[config] migrated legacy backends/profiles → v2");
            let _ = save(dir, &cfg);
            (cfg, *recovered)
        }
        None => {
            tracing::warn!("config parse failed; backing up + using defaults");
            // The frontend arms auto-save after load, so the next save would overwrite this file
            // with defaults: stash it so a corrupt, hand-edited or forward-incompatible config
            // stays recoverable.
            if !backup_unreadable(&path) {
                BACKUP_FAILED.store(true, Ordering::SeqCst);
            }
            *recovered = true;
            (Config::default(), true)
        }
    }
}

/// Convenience wrapper for callers that don't need the `recovered` flag. Recovers like
/// `load_outcome` — for the launch load only; a mid-session reader uses `try_load`.
pub fn load(dir: &Path) -> Config {
    load_outcome(dir).0
}

/// Side-effect-free read for mid-session callers (`commands::bindings_config` and the Quick-Add
/// window's `read_config`). By then a webview holds the live settings, so an unreadable or
/// unparseable file must never be renamed to `.bak`, flip the session's reset flags or be
/// re-saved: `None` on a read or parse error (the caller keeps what it has / skips), the
/// defaults when the file is absent (first run, or this session's reset already moved it —
/// the defaults are then what is live), and a legacy config migrated in memory only.
pub fn try_load(dir: &Path) -> Option<Config> {
    let text = match read_config_text(&config_path(dir)) {
        Ok(Some(text)) => text,
        Ok(None) => return Some(Config::default()),
        Err(e) => {
            tracing::warn!("[config] read failed ({e}); leaving the file as is");
            return None;
        }
    };
    if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
        return Some(cfg);
    }
    let cfg = migrate_legacy(&text);
    if cfg.is_none() {
        tracing::warn!("[config] parse failed; leaving the file as is");
    }
    cfg
}

/// Persist config atomically to `<dir>/config.json`.
pub fn save(dir: &Path, config: &Config) -> anyhow::Result<()> {
    if BACKUP_FAILED.load(Ordering::SeqCst) {
        anyhow::bail!(
            "your settings file could not be backed up; not overwriting it this session — restart the app"
        );
    }
    std::fs::create_dir_all(dir)?;
    let path = config_path(dir);
    let text = serde_json::to_string_pretty(config)?;
    write_private_atomic(&path, &text)?;
    Ok(())
}

/// Secret-store helpers: API keys are keyed by Backend id, never written to disk
/// in cleartext. (The id values are stable across the v2 migration, so existing
/// keyring entries keep resolving.)
pub mod keys {
    use super::KEYRING_SERVICE;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};

    /// Write-through cache over the OS store. Every command resolves the key
    /// fresh, so without this each poll/translate-chunk/WS-connect is a D-Bus
    /// round trip — tens of ms each, and on flaky Secret Service daemons every
    /// read is another chance to fail. The store is only ever written through
    /// `set`/`delete` below, so the cache cannot go stale within the process.
    /// Values are `Option`: a `None` memoizes "no entry stored" — a keyless backend
    /// is a normal configuration and must not cost a D-Bus round trip per call.
    fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
        static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Bumped by `set`/`delete` under the cache lock, at the moment they update the cache. A
    /// `get` notes it before its keyring read and caches the result only if it is unchanged:
    /// a read that finished before a concurrent write but reached the cache after it would
    /// otherwise pin the old secret (or a stale "no entry") for the life of the process.
    static GEN: AtomicU64 = AtomicU64::new(0);

    /// Cache what a `get` read, unless a `set`/`delete` ran since it noted `seen` (the
    /// read may predate that write). Checked under the cache lock, where writers bump it.
    pub(crate) fn remember(backend_id: &str, seen: u64, value: Option<String>) -> bool {
        let mut cache = cache().lock().unwrap();
        if GEN.load(Ordering::SeqCst) != seen {
            return false;
        }
        cache.insert(backend_id.to_string(), value);
        true
    }

    #[cfg(test)]
    pub(crate) fn generation() -> u64 {
        GEN.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn cached(backend_id: &str) -> Option<Option<String>> {
        cache().lock().unwrap().get(backend_id).cloned()
    }

    /// Whether a failed keyring read is worth exactly one more attempt. Only a
    /// platform/D-Bus flake is: `Ambiguous`, `Invalid`, `TooLong` and `BadEncoding`
    /// are deterministic, and `NoStorageAccess` (a locked KWallet / Secret Service)
    /// parks behind a password prompt — retrying it prompts the user a second time.
    pub(crate) fn retryable(e: &keyring::Error) -> bool {
        matches!(e, keyring::Error::PlatformFailure(_))
    }

    pub(crate) fn should_retry(attempt: u8, e: &keyring::Error) -> bool {
        attempt == 0 && retryable(e)
    }

    fn entry(backend_id: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, backend_id)
    }

    pub fn set(backend_id: &str, secret: &str) -> anyhow::Result<()> {
        entry(backend_id)?.set_password(secret)?;
        let mut cache = cache().lock().unwrap();
        GEN.fetch_add(1, Ordering::SeqCst);
        cache.insert(backend_id.to_string(), Some(secret.to_string()));
        Ok(())
    }

    /// What one keyring read found. `Absent` and `Unreadable` both leave the caller without a
    /// key, but only `Absent` is the store saying so: an `Unreadable` key (wallet prompt
    /// dismissed, platform error) may still exist, so nothing may conclude "no key" from it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum KeyRead {
        Found(String),
        Absent,
        Unreadable,
    }

    /// A read that failed for good: only `NoEntry` means nothing is stored.
    pub(crate) fn failed_read(e: &keyring::Error) -> KeyRead {
        if matches!(e, keyring::Error::NoEntry) {
            KeyRead::Absent
        } else {
            KeyRead::Unreadable
        }
    }

    pub fn get(backend_id: &str) -> Option<String> {
        match read(backend_id) {
            KeyRead::Found(k) => Some(k),
            KeyRead::Absent | KeyRead::Unreadable => None,
        }
    }

    pub fn read(backend_id: &str) -> KeyRead {
        if let Some(k) = cache().lock().unwrap().get(backend_id) {
            return k.clone().map_or(KeyRead::Absent, KeyRead::Found);
        }
        let seen = GEN.load(Ordering::SeqCst);
        // One extra attempt on a transient platform error: each try opens a
        // fresh D-Bus connection (and, with an encrypted session, a fresh DH
        // keypair), so per-session daemon flakiness rarely strikes twice.
        for attempt in 0..2u8 {
            match entry(backend_id).and_then(|e| e.get_password()) {
                Ok(k) => {
                    if attempt > 0 {
                        tracing::debug!("[keys] keyring read recovered on retry");
                    }
                    // Returned either way; cached only if no write raced this read.
                    remember(backend_id, seen, Some(k.clone()));
                    return KeyRead::Found(k);
                }
                Err(e) => {
                    if should_retry(attempt, &e) {
                        continue;
                    }
                    let read = failed_read(&e);
                    match read {
                        // Simply not stored — the caller treats the backend as keyless. Memoized
                        // like a hit (see `cache`).
                        KeyRead::Absent => {
                            remember(backend_id, seen, None);
                        }
                        // Anything else (Ambiguous duplicate items, a store/platform failure) means a
                        // key may EXIST but cannot be read — the visible symptom is an opaque 403 on
                        // connect, so say what actually happened.
                        // Debug-format the id, like `resolve_key`'s sibling log: it is a sync/import-supplied
                        // string with no length bound and no control-character fold, so a Display copy would
                        // let a peer forge whole records in the log the user is asked to send for support.
                        _ => tracing::warn!(
                            "[keys] keyring read failed for backend {backend_id:?}: {e}"
                        ),
                    }
                    // Return, never fall through: the loop would read (and prompt for) every
                    // non-retryable error a second time.
                    return read;
                }
            }
        }
        KeyRead::Unreadable
    }

    pub fn delete(backend_id: &str) -> anyhow::Result<()> {
        let result = match entry(backend_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        };
        // Evict AFTER the deletion, and bump `GEN` with it: a concurrent `get` whose keyring
        // read finished before the deletion returns the old secret once but never caches it,
        // so the next `get` re-reads the store.
        let mut cache = cache().lock().unwrap();
        GEN.fetch_add(1, Ordering::SeqCst);
        cache.remove(backend_id);
        result
    }
}

/// A per-process scratch folder `fwf-{tag}-{pid}` under the temp dir, wiped and recreated.
#[cfg(test)]
pub(crate) fn fresh_test_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fwf-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Sets an existing test file's mtime.
#[cfg(test)]
pub(crate) fn set_test_mtime(path: &Path, when: std::time::SystemTime) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn an_export_replaces_a_permissive_file_owner_only_and_leaves_no_tmp() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_test_dir("cfg-export");
        let path = dir.join("settings.json");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_export_atomic(&path, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_config_saved_with_a_byte_order_mark_parses() {
        let dir = fresh_test_dir("cfg-bom");
        let path = dir.join("config.json");
        std::fs::write(&path, b"\xEF\xBB\xBF{\"version\": 2}").unwrap();
        let text = read_config_text(&path).unwrap().unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&text).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unusable_config_is_stashed_or_reported_unbacked() {
        let dir = fresh_test_dir("cfg-bak");
        let path = dir.join("config.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(backup_unreadable(&path));
        assert_eq!(
            std::fs::read(dir.join("config.json.bak")).unwrap(),
            b"{not json"
        );
        // Nothing to rename and nothing to copy: the caller must learn no backup exists.
        assert!(!backup_unreadable(&dir.join("gone.json")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A config re-encoded as CP1252 by a hand edit still loads (lossily, no reset), but its
    /// raw bytes are kept aside before an auto-save can write the U+FFFD text over them.
    #[test]
    fn a_non_utf8_config_loads_and_keeps_its_raw_bytes() {
        let dir = fresh_test_dir("cfg-utf8");
        let mut json = serde_json::to_value(Config::default()).unwrap();
        json["profiles"] = serde_json::json!([{
            "id": "p1", "name": "MARKER", "activation": "hold", "enabled": true, "hotkey": []
        }]);
        let text = serde_json::to_string(&json).unwrap();
        let (a, b) = text.split_once("MARKER").unwrap();
        let raw = [a.as_bytes(), b"f\xFCr M\xFCller", b.as_bytes()].concat();
        std::fs::write(dir.join("config.json"), &raw).unwrap();
        let side = dir.join("config.json.invalid-utf8.bak");

        let (cfg, _) = load_outcome(&dir);
        assert_eq!(cfg.profiles[0].name, "f\u{FFFD}r M\u{FFFD}ller");
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), raw);
        assert_eq!(std::fs::read(&side).unwrap(), raw);
        // The next launch reuses the copy; a later, different incident gets its own.
        let _ = load_outcome(&dir);
        let other = [raw.as_slice(), b" "].concat();
        std::fs::write(dir.join("config.json"), &other).unwrap();
        let _ = load_outcome(&dir);
        assert_eq!(std::fs::read(&side).unwrap(), raw);
        assert_eq!(
            std::fs::read(dir.join("config.json.invalid-utf8.1.bak")).unwrap(),
            other
        );
        // Clean UTF-8 makes no side copy.
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), text).unwrap();
        let _ = load_outcome(&dir);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reset_stays_unconfirmed_until_a_config_is_saved() {
        let dir = fresh_test_dir("cfg-unconf");
        // Fresh install: no config, no backup.
        assert!(!reset_unconfirmed(&dir));
        std::fs::write(dir.join("config.json"), b"{not json").unwrap();
        let _ = load_outcome(&dir);
        assert!(reset_unconfirmed(&dir));
        save(&dir, &Config::default()).unwrap();
        assert!(!reset_unconfirmed(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mid_session_read_never_recovers() {
        let dir = fresh_test_dir("cfg-try");
        // Absent: the defaults (first run, or this session's reset already moved the file).
        assert!(try_load(&dir).is_some_and(|c| c.profiles.is_empty()));
        // Held so a parallel test's `load_outcome` can't flip the sticky flag under us; a
        // `try_load` that took it (i.e. recovered) times out instead of passing.
        let recovered = RECOVERED_THIS_SESSION
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let was_recovered = *recovered;
        let was_backup_failed = backup_failed();
        let path = dir.join("config.json");
        let try_in_thread = |dir: PathBuf| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(try_load(&dir).is_none());
            });
            rx.recv_timeout(std::time::Duration::from_secs(5))
        };
        // Unparseable, then unreadable (a directory where the file should be).
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(try_in_thread(dir.clone()), Ok(true));
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(try_in_thread(dir.clone()), Ok(true));
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no .bak made");
        assert_eq!(*recovered, was_recovered);
        assert_eq!(backup_failed(), was_backup_failed);
        drop(recovered);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_reset_keeps_the_first_backup() {
        let dir = fresh_test_dir("cfg-bak2");
        let path = dir.join("config.json");
        std::fs::write(dir.join("config.json.bak"), b"first").unwrap();
        std::fs::write(&path, b"second").unwrap();
        assert!(backup_unreadable(&path));
        assert_eq!(
            std::fs::read(dir.join("config.json.bak")).unwrap(),
            b"second"
        );
        let aside: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("config.json.bak.")
            })
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(aside[0].path()).unwrap(), b"first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_config_left_in_place_is_not_backed_up_again_and_again() {
        let dir = fresh_test_dir("cfg-bak3");
        let path = dir.join("config.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(backup_unreadable(&path));
        // The copy fallback leaves the corrupt original in place: put it back and back it up again.
        std::fs::write(&path, b"{not json").unwrap();
        assert!(backup_unreadable(&path));
        assert_eq!(
            std::fs::read(dir.join("config.json.bak")).unwrap(),
            b"{not json"
        );
        let aside = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("config.json.bak.")
            })
            .count();
        assert_eq!(aside, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_dictation_clock_is_the_stricter_non_zero_window() {
        let clock = |audio: u32, record: Option<u32>| {
            let mut s = Config::default().settings;
            s.recording.recordings_retention_days = audio;
            s.transcribe = record.map(|r| serde_json::json!({ "dictationRetentionDays": r }));
            s.effective_dictation_days()
        };
        assert_eq!(clock(0, None), 7); // never touched: the row reads 7, audio follows
        assert_eq!(clock(0, Some(30)), 30);
        assert_eq!(clock(14, Some(0)), 14);
        assert_eq!(clock(3, Some(7)), 3);
        assert_eq!(clock(30, Some(7)), 7);
        assert_eq!(clock(0, Some(0)), 0); // forever
    }

    #[test]
    fn only_platform_failures_are_retried() {
        use super::keys::{retryable, should_retry};
        assert!(retryable(&keyring::Error::PlatformFailure("dbus".into())));
        assert!(!retryable(&keyring::Error::NoStorageAccess(
            "locked".into()
        )));
        assert!(!retryable(&keyring::Error::Ambiguous(vec![])));
        assert!(!retryable(&keyring::Error::Invalid(
            "attr".into(),
            "why".into()
        )));
        // The loop's gate, not just the predicate: a locked wallet is never read twice.
        assert!(should_retry(
            0,
            &keyring::Error::PlatformFailure("dbus".into())
        ));
        assert!(!should_retry(
            1,
            &keyring::Error::PlatformFailure("dbus".into())
        ));
        assert!(!should_retry(
            0,
            &keyring::Error::NoStorageAccess("locked".into())
        ));
    }

    #[test]
    fn a_keyring_read_that_raced_a_write_is_not_cached() {
        use super::keys::{cached, generation, remember};
        let id = format!("race-{}", uuid::Uuid::new_v4());
        // A `set`/`delete` landed between the read noting the generation and caching: the
        // (possibly old) value must not be pinned in the cache.
        let stale = generation().wrapping_sub(1);
        assert!(!remember(&id, stale, Some("old".into())));
        assert_eq!(cached(&id), None);
        // No write in between: the read is cached.
        assert!(remember(&id, generation(), Some("k".into())));
        assert_eq!(cached(&id), Some(Some("k".into())));
    }

    #[test]
    fn only_a_missing_entry_reads_as_absent() {
        use super::keys::{failed_read, generation, read, remember, KeyRead};
        // The store saying "nothing here" is the one failure a caller may treat as "no key".
        assert_eq!(failed_read(&keyring::Error::NoEntry), KeyRead::Absent);
        for e in [
            keyring::Error::NoStorageAccess("locked".into()),
            keyring::Error::PlatformFailure("dbus".into()),
            keyring::Error::Ambiguous(vec![]),
        ] {
            assert_eq!(failed_read(&e), KeyRead::Unreadable, "{e}");
        }
        // A memoized "no entry" is still an absence, and a memoized key is found.
        let id = format!("absent-{}", uuid::Uuid::new_v4());
        assert!(remember(&id, generation(), None));
        assert_eq!(read(&id), KeyRead::Absent);
        assert!(remember(&id, generation(), Some("k".into())));
        assert_eq!(read(&id), KeyRead::Found("k".into()));
    }

    #[test]
    fn a_failed_config_save_leaves_no_tmp_behind() {
        let dir = fresh_test_dir("cfg-tmp");
        // Pre-plant the FINAL path as a non-empty directory: the tmp file is written in full
        // and the rename then fails — the cleanup this pins is the one after a successful
        // write (a planted tmp path would fail at the open and never create anything).
        std::fs::create_dir_all(dir.join("config.json").join("occupied")).unwrap();
        assert!(save(&dir, &Config::default()).is_err());
        assert!(
            !dir.join("config.json.tmp").exists(),
            "tmp left behind after a failed rename"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Frontend-owned keys must survive the typed `Config` round-trip that `save_config`
    /// performs — a field missing from these structs is silently dropped on every save.
    #[test]
    fn frontend_owned_fields_round_trip_through_config() {
        // Start from a real default config so every required field is present, then add
        // exactly the frontend-written keys the way the UI's `save_config` payload would.
        let mut json = serde_json::to_value(Config::default()).expect("default serializes");
        json["settings"]["recentTranslationTargets"] = serde_json::json!(["fr", "de"]);
        json["settings"]["recentSpokenLanguages"] = serde_json::json!(["de", "yue"]);
        json["settings"]["accentHue"] = serde_json::json!(330);
        json["settings"]["accentMotion"] = serde_json::json!({"period": 3600, "range": "wheel"});
        json["settings"]["transcribe"] = serde_json::json!({"revealAfterSave": false});
        json["profiles"] = serde_json::json!([{
            "id": "p1", "name": "P", "activation": "hold", "enabled": true, "hotkey": [],
            "askTranslationTargets": true
        }]);

        let cfg: Config = serde_json::from_value(json).expect("config parses");
        let out = serde_json::to_value(&cfg).expect("config serializes");
        assert_eq!(
            out["profiles"][0]["askTranslationTargets"],
            serde_json::json!(true)
        );
        assert_eq!(
            out["settings"]["recentTranslationTargets"],
            serde_json::json!(["fr", "de"])
        );
        assert_eq!(
            out["settings"]["recentSpokenLanguages"],
            serde_json::json!(["de", "yue"])
        );
        // The quick-add and picker windows read the Signal colour through this struct.
        assert_eq!(out["settings"]["accentHue"], serde_json::json!(330.0));
        // The export panel's "Open folder after saving" (an opaque transcribe key).
        assert_eq!(
            out["settings"]["transcribe"]["revealAfterSave"],
            serde_json::json!(false)
        );
        assert_eq!(
            out["settings"]["accentMotion"]["period"],
            serde_json::json!(3600)
        );
    }

    /// A config written before the clipboard-privacy setting existed must load with the
    /// PRIVATE default (true), and the key must survive the typed round-trip once present.
    #[test]
    fn clipboard_privacy_defaults_on_and_round_trips() {
        let mut json = serde_json::to_value(Config::default()).expect("default serializes");
        let general = json["settings"]["general"]
            .as_object_mut()
            .expect("general is an object");
        assert!(general.remove("excludeFromClipboardHistory").is_some());
        let cfg: Config = serde_json::from_value(json.clone()).expect("config parses");
        assert!(cfg.settings.general.exclude_from_clipboard_history);

        json["settings"]["general"]["excludeFromClipboardHistory"] = serde_json::json!(false);
        let cfg: Config = serde_json::from_value(json).expect("config parses");
        assert!(!cfg.settings.general.exclude_from_clipboard_history);
        let out = serde_json::to_value(&cfg).expect("config serializes");
        assert_eq!(
            out["settings"]["general"]["excludeFromClipboardHistory"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn microphone_pin_and_label_round_trip_and_may_be_absent() {
        let mut json = serde_json::to_value(Config::default()).expect("default serializes");
        let settings = json["settings"]
            .as_object_mut()
            .expect("settings is an object");
        settings.remove("microphoneId");
        settings.remove("microphoneLabel");
        let cfg: Config = serde_json::from_value(json.clone()).expect("config parses");
        assert_eq!(cfg.settings.microphone_id, None);
        assert_eq!(cfg.settings.microphone_label, None);

        json["settings"]["microphoneId"] = serde_json::json!("pulseaudio:alsa_input.usb-RØDE.mono");
        json["settings"]["microphoneLabel"] = serde_json::json!("RØDE PodMic USB Mono");
        let cfg: Config = serde_json::from_value(json).expect("config parses");
        let out = serde_json::to_value(&cfg).expect("config serializes");
        assert_eq!(
            out["settings"]["microphoneId"],
            serde_json::json!("pulseaudio:alsa_input.usb-RØDE.mono")
        );
        assert_eq!(
            out["settings"]["microphoneLabel"],
            serde_json::json!("RØDE PodMic USB Mono")
        );
    }
}
