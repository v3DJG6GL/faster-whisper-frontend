//! Dictation triggers. A trigger maps to a `(mode, action)` and is emitted to the
//! UI as a `trigger` event; the frontend resolves the mode's profile and starts/
//! stops dictation. Triggers arrive from:
//!   * CLI flags routed to the running instance (single-instance) — the portable
//!     path, esp. for Wayland where a DE shortcut runs `app --toggle`.
//!   * In-app global hotkeys (Windows / X11) — added separately.

use crate::config::{DictationModeId, ModeBinding};
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPayload {
    pub mode: String,   // "hold" | "handsfree"
    pub action: String, // "start" | "stop" | "toggle"
}

/// Map a CLI flag to a trigger. Returns None for unrelated args.
fn flag_to_trigger(arg: &str) -> Option<(&'static str, &'static str)> {
    match arg {
        "--ptt-down" => Some(("hold", "start")),
        "--ptt-up" => Some(("hold", "stop")),
        "--toggle-hold" => Some(("hold", "toggle")),
        "--toggle" | "--toggle-latch" => Some(("handsfree", "toggle")),
        _ => None,
    }
}

/// Handle CLI args delivered to the running instance, emitting trigger events.
pub fn handle_cli_args(app: &AppHandle, argv: &[String]) {
    for arg in argv {
        if let Some((mode, action)) = flag_to_trigger(arg) {
            tracing::info!("[trigger] cli {mode}/{action}");
            let _ = app.emit(
                "trigger",
                TriggerPayload {
                    mode: mode.to_string(),
                    action: action.to_string(),
                },
            );
        }
    }
}

// ── In-app global hotkeys (Windows / Linux-X11) ─────────────────────────────
// Native Wayland is X11-only here (the plugin can't register), and modifier-only
// chords like "Ctrl+Shift" aren't registerable anywhere — those rely on the CLI
// path (a DE shortcut → `app --toggle`). The GlobalShortcuts portal is M7.

#[derive(Clone)]
struct ShortcutTarget {
    mode: &'static str,
    is_hold: bool,
}

#[derive(Default)]
pub struct ShortcutRegistry(Mutex<HashMap<Shortcut, ShortcutTarget>>);

fn mode_id_str(m: DictationModeId) -> &'static str {
    match m {
        DictationModeId::Hold => "hold",
        DictationModeId::Handsfree => "handsfree",
    }
}

/// Plugin handler: map a fired shortcut back to its mode and emit a trigger.
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
    let action = match (t.is_hold, event.state()) {
        (true, ShortcutState::Pressed) => "start",
        (true, ShortcutState::Released) => "stop",
        (false, ShortcutState::Pressed) => "toggle",
        _ => return,
    };
    let _ = app.emit(
        "trigger",
        TriggerPayload {
            mode: t.mode.to_string(),
            action: action.to_string(),
        },
    );
}

/// (Re)register global shortcuts for the enabled modes. Unregisterable hotkeys
/// (modifier-only / Wayland) are skipped with a log — the CLI path covers them.
pub fn register_from_config(app: &AppHandle, modes: &[ModeBinding]) {
    let gs = app.global_shortcut();
    let registry = app.state::<ShortcutRegistry>();
    let Ok(mut map) = registry.0.lock() else {
        return;
    };
    for sc in map.keys() {
        let _ = gs.unregister(sc.clone());
    }
    map.clear();

    for m in modes {
        if !m.enabled {
            continue;
        }
        let shortcut = match Shortcut::from_str(&m.hotkey) {
            Ok(s) => s,
            Err(_) => {
                tracing::warn!(
                    "[hotkey] '{}' is not a registerable global shortcut (modifier-only / invalid); bind a desktop shortcut to `app --toggle` instead",
                    m.hotkey
                );
                continue;
            }
        };
        match gs.register(shortcut.clone()) {
            Ok(()) => {
                tracing::info!("[hotkey] registered '{}' → {}", m.hotkey, mode_id_str(m.mode));
                map.insert(
                    shortcut,
                    ShortcutTarget {
                        mode: mode_id_str(m.mode),
                        is_hold: matches!(m.mode, DictationModeId::Hold),
                    },
                );
            }
            Err(e) => tracing::warn!(
                "[hotkey] could not register '{}' (Windows/X11 only): {e}",
                m.hotkey
            ),
        }
    }
}
