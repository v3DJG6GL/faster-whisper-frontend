//! Opt-in hardware hotkey backend (Linux) via `evdev`.
//!
//! The `global-shortcut` plugin can't do reliable hold-to-talk, left/right
//! modifiers, or AltGr on Wayland. Reading `/dev/input` directly can — at the cost
//! of system-wide key-read access (the user must be in the `input` group; see
//! `setup`). Strictly opt-in (`general.evdevEnabled`); we only enumerate keyboards,
//! react to the configured chord, and never persist or transmit scancodes.
//!
//! Each keyboard runs an async event loop tracking a held-key set; when a mode's
//! chord (mapped from the binding's `event.code` list via [`codes_to_keys`])
//! completes we emit the same `trigger` event the CLI/plugin paths use — so it
//! plugs straight into the existing controller. Hold = start on chord-complete /
//! stop on chord-break; latch = toggle on chord-complete.

use tauri::async_runtime::JoinHandle;

/// Live listener: the per-keyboard reader tasks. Dropping it aborts them.
pub struct Running {
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

#[derive(Default)]
pub struct EvdevState(pub std::sync::Mutex<Option<Running>>);

/// Stop the listener (drops the tasks → aborts them).
pub fn stop(state: &EvdevState) {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
}

#[cfg(target_os = "linux")]
pub use imp::{permitted, setup, start};

#[cfg(not(target_os = "linux"))]
pub fn permitted() -> bool {
    false
}
#[cfg(not(target_os = "linux"))]
pub fn start(_app: &tauri::AppHandle, _state: &EvdevState, _modes: &[crate::config::ModeBinding]) {}
#[cfg(not(target_os = "linux"))]
pub async fn setup() -> Result<String, String> {
    Err("The evdev backend is Linux-only.".into())
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{EvdevState, Running};
    use crate::config::{DictationModeId, ModeBinding};
    use crate::triggers::TriggerPayload;
    use evdev::{Device, EventType, Key};
    use std::collections::HashSet;
    use tauri::{AppHandle, Emitter};

    fn is_keyboard(d: &Device) -> bool {
        d.supported_keys()
            .map_or(false, |k| k.contains(Key::KEY_ENTER))
    }

    /// Can we actually open a keyboard for reading (i.e. are we permitted)?
    pub fn permitted() -> bool {
        evdev::enumerate().any(|(_, d)| is_keyboard(&d))
    }

    /// `pkexec usermod -aG input $USER` (polkit GUI auth). The user must re-login.
    pub async fn setup() -> Result<String, String> {
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .map_err(|_| "couldn't determine the current user".to_string())?;
        let out = tokio::process::Command::new("pkexec")
            .args(["usermod", "-aG", "input", &user])
            .output()
            .await
            .map_err(|e| format!("couldn't launch pkexec: {e}"))?;
        if out.status.success() {
            Ok("Added to the 'input' group. Log out and back in, then enable the evdev backend.".into())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(if err.trim().is_empty() {
                "Setup was cancelled or failed.".into()
            } else {
                err.trim().to_string()
            })
        }
    }

    /// Build (chord keys, is_hold) for one enabled mode, or None if it's disabled,
    /// has no binding, or contains a key this backend can't map.
    fn chord_for(modes: &[ModeBinding], want: DictationModeId) -> Option<(Vec<Key>, bool)> {
        let m = modes.iter().find(|m| m.mode == want && m.enabled)?;
        let keys = codes_to_keys(&m.hotkey)?;
        if keys.is_empty() {
            return None;
        }
        Some((keys, matches!(want, DictationModeId::Hold)))
    }

    pub fn start(app: &AppHandle, state: &EvdevState, modes: &[ModeBinding]) {
        stop(state);
        let hold = chord_for(modes, DictationModeId::Hold);
        let latch = chord_for(modes, DictationModeId::Handsfree);
        if hold.is_none() && latch.is_none() {
            tracing::info!("[evdev] no mappable chords; not starting");
            return;
        }
        let mut tasks = Vec::new();
        for (path, dev) in evdev::enumerate() {
            if !is_keyboard(&dev) {
                continue;
            }
            let app = app.clone();
            let hold = hold.clone();
            let latch = latch.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                // into_event_stream() builds a tokio AsyncFd, so it MUST run inside
                // the async runtime — calling it on the main thread (where the
                // command runs) panics with "no reactor running".
                let stream = match dev.into_event_stream() {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("[evdev] can't read {}: {e}", path.display());
                        return;
                    }
                };
                run_device(app, stream, hold, latch).await;
            }));
        }
        tracing::info!("[evdev] listening on {} keyboard(s)", tasks.len());
        if let Ok(mut g) = state.0.lock() {
            *g = Some(Running { tasks });
        }
    }

    fn stop(state: &EvdevState) {
        if let Ok(mut g) = state.0.lock() {
            *g = None;
        }
    }

    fn emit(app: &AppHandle, mode: &str, action: &str) {
        let _ = app.emit(
            "trigger",
            TriggerPayload {
                mode: mode.to_string(),
                action: action.to_string(),
            },
        );
    }

    async fn run_device(
        app: AppHandle,
        mut stream: evdev::EventStream,
        hold: Option<(Vec<Key>, bool)>,
        latch: Option<(Vec<Key>, bool)>,
    ) {
        let mut held: HashSet<u16> = HashSet::new();
        let mut hold_active = false;
        let mut latch_armed = false;
        loop {
            let ev = match stream.next_event().await {
                Ok(e) => e,
                Err(_) => break, // device went away
            };
            if ev.event_type() != EventType::KEY {
                continue;
            }
            match ev.value() {
                1 => {
                    held.insert(ev.code());
                }
                0 => {
                    held.remove(&ev.code());
                }
                _ => continue, // 2 = autorepeat
            }
            if let Some((keys, _)) = &hold {
                let all = keys.iter().all(|k| held.contains(&k.code()));
                if all && !hold_active {
                    hold_active = true;
                    emit(&app, "hold", "start");
                } else if !all && hold_active {
                    hold_active = false;
                    emit(&app, "hold", "stop");
                }
            }
            if let Some((keys, _)) = &latch {
                let all = keys.iter().all(|k| held.contains(&k.code()));
                if all && !latch_armed {
                    latch_armed = true;
                    emit(&app, "handsfree", "toggle");
                } else if !all {
                    latch_armed = false;
                }
            }
        }
    }

    /// Map a binding's `event.code` list to evdev keys (carrying left/right + AltGr).
    /// None if any code isn't mappable.
    fn codes_to_keys(codes: &[String]) -> Option<Vec<Key>> {
        codes.iter().map(|c| code_to_key(c)).collect()
    }

    fn code_to_key(code: &str) -> Option<Key> {
        let k = match code {
            "ControlLeft" => Key::KEY_LEFTCTRL,
            "ControlRight" => Key::KEY_RIGHTCTRL,
            "ShiftLeft" => Key::KEY_LEFTSHIFT,
            "ShiftRight" => Key::KEY_RIGHTSHIFT,
            "AltLeft" => Key::KEY_LEFTALT,
            "AltRight" => Key::KEY_RIGHTALT,
            "MetaLeft" => Key::KEY_LEFTMETA,
            "MetaRight" => Key::KEY_RIGHTMETA,
            "Space" => Key::KEY_SPACE,
            "Enter" => Key::KEY_ENTER,
            "Tab" => Key::KEY_TAB,
            "Backspace" => Key::KEY_BACKSPACE,
            "Delete" => Key::KEY_DELETE,
            "Insert" => Key::KEY_INSERT,
            "Home" => Key::KEY_HOME,
            "End" => Key::KEY_END,
            "PageUp" => Key::KEY_PAGEUP,
            "PageDown" => Key::KEY_PAGEDOWN,
            "PrintScreen" => Key::KEY_SYSRQ,
            "ArrowUp" => Key::KEY_UP,
            "ArrowDown" => Key::KEY_DOWN,
            "ArrowLeft" => Key::KEY_LEFT,
            "ArrowRight" => Key::KEY_RIGHT,
            "NumpadAdd" => Key::KEY_KPPLUS,
            "NumpadSubtract" => Key::KEY_KPMINUS,
            "NumpadMultiply" => Key::KEY_KPASTERISK,
            "NumpadDivide" => Key::KEY_KPSLASH,
            "NumpadDecimal" => Key::KEY_KPDOT,
            "NumpadEnter" => Key::KEY_KPENTER,
            "NumpadEqual" => Key::KEY_KPEQUAL,
            _ => {
                if let Some(l) = code.strip_prefix("Key") {
                    return letter_key(l);
                }
                if let Some(d) = code.strip_prefix("Digit") {
                    return digit_key(d);
                }
                if let Some(n) = code.strip_prefix("Numpad") {
                    return numpad_digit_key(n);
                }
                if let Some(f) = code.strip_prefix('F') {
                    return fn_key(f);
                }
                return None;
            }
        };
        Some(k)
    }

    fn letter_key(l: &str) -> Option<Key> {
        Some(match l {
            "A" => Key::KEY_A, "B" => Key::KEY_B, "C" => Key::KEY_C, "D" => Key::KEY_D,
            "E" => Key::KEY_E, "F" => Key::KEY_F, "G" => Key::KEY_G, "H" => Key::KEY_H,
            "I" => Key::KEY_I, "J" => Key::KEY_J, "K" => Key::KEY_K, "L" => Key::KEY_L,
            "M" => Key::KEY_M, "N" => Key::KEY_N, "O" => Key::KEY_O, "P" => Key::KEY_P,
            "Q" => Key::KEY_Q, "R" => Key::KEY_R, "S" => Key::KEY_S, "T" => Key::KEY_T,
            "U" => Key::KEY_U, "V" => Key::KEY_V, "W" => Key::KEY_W, "X" => Key::KEY_X,
            "Y" => Key::KEY_Y, "Z" => Key::KEY_Z,
            _ => return None,
        })
    }

    fn digit_key(d: &str) -> Option<Key> {
        Some(match d {
            "0" => Key::KEY_0, "1" => Key::KEY_1, "2" => Key::KEY_2, "3" => Key::KEY_3,
            "4" => Key::KEY_4, "5" => Key::KEY_5, "6" => Key::KEY_6, "7" => Key::KEY_7,
            "8" => Key::KEY_8, "9" => Key::KEY_9,
            _ => return None,
        })
    }

    fn numpad_digit_key(n: &str) -> Option<Key> {
        Some(match n {
            "0" => Key::KEY_KP0, "1" => Key::KEY_KP1, "2" => Key::KEY_KP2, "3" => Key::KEY_KP3,
            "4" => Key::KEY_KP4, "5" => Key::KEY_KP5, "6" => Key::KEY_KP6, "7" => Key::KEY_KP7,
            "8" => Key::KEY_KP8, "9" => Key::KEY_KP9,
            _ => return None,
        })
    }

    fn fn_key(f: &str) -> Option<Key> {
        Some(match f {
            "1" => Key::KEY_F1, "2" => Key::KEY_F2, "3" => Key::KEY_F3, "4" => Key::KEY_F4,
            "5" => Key::KEY_F5, "6" => Key::KEY_F6, "7" => Key::KEY_F7, "8" => Key::KEY_F8,
            "9" => Key::KEY_F9, "10" => Key::KEY_F10, "11" => Key::KEY_F11, "12" => Key::KEY_F12,
            "13" => Key::KEY_F13, "14" => Key::KEY_F14, "15" => Key::KEY_F15, "16" => Key::KEY_F16,
            "17" => Key::KEY_F17, "18" => Key::KEY_F18, "19" => Key::KEY_F19, "20" => Key::KEY_F20,
            "21" => Key::KEY_F21, "22" => Key::KEY_F22, "23" => Key::KEY_F23, "24" => Key::KEY_F24,
            _ => return None,
        })
    }
}
