//! Dictation triggers. A trigger maps to a `(mode, action)` and is emitted to the
//! UI as a `trigger` event; the frontend resolves the mode's profile and starts/
//! stops dictation. Triggers arrive from:
//!   * CLI flags routed to the running instance (single-instance) — the portable
//!     path, esp. for Wayland where a DE shortcut runs `app --toggle`.
//!   * In-app global hotkeys (Windows / X11) — added separately.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

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
