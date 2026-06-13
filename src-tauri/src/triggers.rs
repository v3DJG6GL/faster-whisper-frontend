//! Dictation triggers. A trigger maps to a `(profile_id, action)` and is emitted
//! to the UI as a `trigger` event; the frontend resolves the Profile's Backend and
//! starts/stops dictation. Triggers arrive from:
//!   * CLI flags routed to the running instance (single-instance) — the portable
//!     path, esp. for Wayland where a DE shortcut runs
//!     `app --profile <id> --action toggle` (or the zero-arg `app --toggle`,
//!     which targets the first enabled latch Profile).
//!   * In-app global hotkeys (Windows / X11) — added separately.

use crate::config::{ActivationType, Profile};
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPayload {
    /// The fired Profile's stable id (resolved to a Backend on the frontend).
    pub profile_id: String,
    pub action: String, // "start" | "stop" | "toggle"
}

/// Emit a trigger event for an explicit Profile id.
fn emit_trigger(app: &AppHandle, profile_id: String, action: &str) {
    tracing::info!("[trigger] {profile_id}/{action}");
    let _ = app.emit(
        "trigger",
        TriggerPayload {
            profile_id,
            action: action.to_string(),
        },
    );
}

/// Load the persisted config (for resolving CLI flags → a Profile id).
fn load_config(app: &AppHandle) -> Option<crate::config::Config> {
    let dir = app.path().app_config_dir().ok()?;
    Some(crate::config::load(&dir))
}

/// Resolve a legacy / zero-arg flag to the first enabled Profile with `want`
/// activation (config order), then emit. Keeps existing desktop shortcuts working.
fn emit_for_activation(app: &AppHandle, want: ActivationType, action: &str) {
    let Some(cfg) = load_config(app) else { return };
    match cfg.profiles.iter().find(|p| p.enabled && p.activation == want) {
        Some(p) => emit_trigger(app, p.id.clone(), action),
        None => tracing::info!("[trigger] legacy flag: no enabled {want:?} profile"),
    }
}

/// Handle CLI args delivered to the running instance, emitting trigger events.
/// Generic form: `--profile <id> --action <start|stop|toggle>`. Legacy flags
/// (`--toggle`, `--ptt-down/up`, `--toggle-hold/latch`) resolve to the first
/// enabled Profile of the matching activation.
pub fn handle_cli_args(app: &AppHandle, argv: &[String]) {
    let mut profile: Option<String> = None;
    let mut action: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--profile" if i + 1 < argv.len() => {
                profile = Some(argv[i + 1].clone());
                i += 2;
            }
            "--action" if i + 1 < argv.len() => {
                action = Some(argv[i + 1].clone());
                i += 2;
            }
            "--ptt-down" => {
                emit_for_activation(app, ActivationType::Hold, "start");
                i += 1;
            }
            "--ptt-up" => {
                emit_for_activation(app, ActivationType::Hold, "stop");
                i += 1;
            }
            "--toggle-hold" => {
                emit_for_activation(app, ActivationType::Hold, "toggle");
                i += 1;
            }
            "--toggle" | "--toggle-latch" => {
                emit_for_activation(app, ActivationType::Latch, "toggle");
                i += 1;
            }
            _ => i += 1,
        }
    }
    if let (Some(p), Some(a)) = (profile, action) {
        if matches!(a.as_str(), "start" | "stop" | "toggle") {
            emit_trigger(app, p, &a);
        } else {
            tracing::warn!("[trigger] cli ignored unknown action '{a}'");
        }
    }
}

// ── In-app global hotkeys (Windows / Linux-X11) ─────────────────────────────
// Native Wayland is X11-only here (the plugin can't register), and modifier-only
// chords like "Ctrl+Shift" aren't registerable anywhere — those rely on the CLI
// path (a DE shortcut → `app --toggle`). The GlobalShortcuts portal is M7.

#[derive(Clone)]
struct ShortcutTarget {
    profile_id: String,
    activation: ActivationType,
}

#[derive(Default)]
pub struct ShortcutRegistry(Mutex<HashMap<Shortcut, ShortcutTarget>>);

/// Plugin handler: map a fired shortcut back to its Profile and emit a trigger.
/// Hold → start on press / stop on release; latch → toggle on press.
pub fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let target = app
        .state::<ShortcutRegistry>()
        .0
        .lock()
        .ok()
        .and_then(|m| m.get(shortcut).cloned());
    let Some(t) = target else {
        return;
    };
    let action = match (t.activation, event.state()) {
        (ActivationType::Hold, ShortcutState::Pressed) => "start",
        (ActivationType::Hold, ShortcutState::Released) => "stop",
        (ActivationType::Latch, ShortcutState::Pressed) => "toggle",
        _ => return,
    };
    emit_trigger(app, t.profile_id.clone(), action);
}

/// Unregister all currently-registered global shortcuts. Used while the user is
/// capturing a new binding, so pressing a key only rebinds and doesn't also fire
/// dictation (which previously could start a stuck push-to-talk session).
pub fn unregister_all(app: &AppHandle) {
    let gs = app.global_shortcut();
    let registry = app.state::<ShortcutRegistry>();
    let Ok(mut map) = registry.0.lock() else {
        return;
    };
    for sc in map.keys() {
        let _ = gs.unregister(sc.clone());
    }
    map.clear();
}

/// (Re)register global shortcuts for the enabled Profiles. Unregisterable hotkeys
/// (modifier-only / Wayland) are skipped with a log — the CLI path covers them.
pub fn register_from_config(app: &AppHandle, profiles: &[Profile]) {
    let gs = app.global_shortcut();
    let registry = app.state::<ShortcutRegistry>();
    let Ok(mut map) = registry.0.lock() else {
        return;
    };
    for sc in map.keys() {
        let _ = gs.unregister(sc.clone());
    }
    map.clear();

    for p in profiles {
        if !p.enabled {
            continue;
        }
        // Code list → plugin accelerator (None = modifier-only / AltGr → evdev/CLI only).
        let accel = match crate::config::codes_to_accelerator(&p.hotkey) {
            Some(a) => a,
            None => {
                tracing::info!(
                    "[hotkey] {} {:?} isn't a global-shortcut chord (modifier-only / AltGr) — use a desktop shortcut → `app --profile {} --action toggle`, or the evdev backend",
                    p.id, p.hotkey, p.id
                );
                continue;
            }
        };
        let shortcut = match Shortcut::from_str(&accel) {
            Ok(s) => s,
            Err(_) => {
                tracing::warn!("[hotkey] '{accel}' is not a registerable global shortcut");
                continue;
            }
        };
        match gs.register(shortcut.clone()) {
            Ok(()) => {
                tracing::info!("[hotkey] registered '{accel}' → {} ({:?})", p.id, p.activation);
                if map
                    .insert(
                        shortcut,
                        ShortcutTarget {
                            profile_id: p.id.clone(),
                            activation: p.activation,
                        },
                    )
                    .is_some()
                {
                    tracing::warn!("[hotkey] '{accel}' is bound by more than one profile; last wins");
                }
            }
            Err(e) => tracing::warn!("[hotkey] could not register '{accel}' (Windows/X11 only): {e}"),
        }
    }
}
