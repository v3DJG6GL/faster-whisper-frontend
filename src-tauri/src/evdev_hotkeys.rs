//! Opt-in hardware hotkey backend (Linux) via `evdev`.
//!
//! The `global-shortcut` plugin can't do reliable hold-to-talk, left/right
//! modifiers, or AltGr on Wayland. Reading `/dev/input` directly can — at the cost
//! of system-wide key-read access (the user must be in the `input` group; see
//! `setup`). Strictly opt-in (`general.evdevEnabled`); we only enumerate keyboards,
//! react to the configured chords, and never persist or transmit scancodes.
//!
//! Each keyboard runs an async event loop tracking a held-key set; when a
//! Profile's chord (mapped from its `event.code` list via [`codes_to_keys`])
//! completes we emit the same `trigger` event the CLI/plugin paths use — so it
//! plugs straight into the existing controller. Hold = start on chord-complete /
//! stop on chord-break; latch = toggle on chord-complete. Any number of Profiles
//! (chords) are matched at once, with "most-specific chord wins" suppression.

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
pub fn start(_app: &tauri::AppHandle, _state: &EvdevState, _profiles: &[crate::config::Profile], _quick_add_hotkey: &[String]) {}
#[cfg(not(target_os = "linux"))]
pub async fn setup() -> Result<String, String> {
    Err("The evdev backend is Linux-only.".into())
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{EvdevState, Running};
    use crate::config::{ActivationType, Profile};
    use crate::triggers::TriggerPayload;
    use evdev::{Device, EventType, Key};
    use std::collections::HashSet;
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, Manager};

    /// What a matched chord does — drive dictation for a Profile, or open the
    /// quick-add window.
    #[derive(Clone)]
    enum ChordAction {
        Dictate { profile_id: String, activation: ActivationType },
        OpenQuickAdd,
    }

    /// One enabled chord, ready for matching.
    #[derive(Clone)]
    struct ChordDesc {
        action: ChordAction,
        keys: Vec<Key>,
    }

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

    /// Build chord descriptors for every enabled Profile whose hotkey maps cleanly,
    /// plus the quick-add window chord. Equal chords are de-duped (first by config
    /// order wins) so one keypress can't fire two actions. Unmappable / empty skipped.
    fn chords_from(profiles: &[Profile], quick_add_hotkey: &[String]) -> Vec<ChordDesc> {
        let mut out: Vec<ChordDesc> = Vec::new();
        for p in profiles.iter().filter(|p| p.enabled) {
            let Some(keys) = codes_to_keys(&p.hotkey) else {
                continue;
            };
            if keys.is_empty() {
                continue;
            }
            let codes: HashSet<u16> = keys.iter().map(|k| k.code()).collect();
            let dup = out.iter().any(|c| {
                c.keys.len() == keys.len() && c.keys.iter().all(|k| codes.contains(&k.code()))
            });
            if dup {
                tracing::warn!(
                    "[evdev] profile '{}' has the same chord as an earlier one; ignoring the duplicate",
                    p.id
                );
                continue;
            }
            out.push(ChordDesc {
                action: ChordAction::Dictate { profile_id: p.id.clone(), activation: p.activation },
                keys,
            });
        }
        // The quick-add window shortcut (not a Profile) — matched alongside the chords.
        if let Some(keys) = codes_to_keys(quick_add_hotkey) {
            if !keys.is_empty() {
                let codes: HashSet<u16> = keys.iter().map(|k| k.code()).collect();
                let dup = out.iter().any(|c| {
                    c.keys.len() == keys.len() && c.keys.iter().all(|k| codes.contains(&k.code()))
                });
                if dup {
                    tracing::warn!("[evdev] the quick-add shortcut duplicates a profile chord; ignoring");
                } else {
                    out.push(ChordDesc { action: ChordAction::OpenQuickAdd, keys });
                }
            }
        }
        out
    }

    /// For each chord `i`, the indices of OTHER chords that are a strict superset of
    /// it (more keys, and contain all of `i`'s keys). Chord `i` is suppressed while
    /// any such superset is fully held — generalizing "most-specific chord wins" to
    /// N chords (e.g. bare-Alt PTT stays silent while Ctrl+Alt latch is held).
    fn compute_strict_supersets(chords: &[ChordDesc]) -> Vec<Vec<usize>> {
        let sets: Vec<HashSet<u16>> = chords
            .iter()
            .map(|c| c.keys.iter().map(|k| k.code()).collect())
            .collect();
        let mut out = vec![Vec::new(); chords.len()];
        for i in 0..chords.len() {
            for j in 0..chords.len() {
                if i != j
                    && sets[j].len() > sets[i].len()
                    && sets[i].iter().all(|c| sets[j].contains(c))
                {
                    out[i].push(j);
                }
            }
        }
        out
    }

    pub fn start(app: &AppHandle, state: &EvdevState, profiles: &[Profile], quick_add_hotkey: &[String]) {
        super::stop(state);
        // Fresh start: drop any held-key counts left over from a previous run so the
        // inject-gate can't wait on a phantom modifier.
        app.state::<crate::held_keys::HeldKeys>().clear();
        let chords = chords_from(profiles, quick_add_hotkey);
        if chords.is_empty() {
            tracing::info!("[evdev] no mappable chords; not starting");
            return;
        }
        // Fixed for the life of the listener → precompute once and share read-only.
        let supersets = Arc::new(compute_strict_supersets(&chords));
        let chords = Arc::new(chords);

        let mut tasks = Vec::new();
        for (path, dev) in evdev::enumerate() {
            if !is_keyboard(&dev) {
                continue;
            }
            let app = app.clone();
            let chords = chords.clone();
            let supersets = supersets.clone();
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
                run_device(app, stream, chords, supersets).await;
            }));
        }
        tracing::info!(
            "[evdev] listening on {} keyboard(s), {} chord(s)",
            tasks.len(),
            chords.len()
        );
        if let Ok(mut g) = state.0.lock() {
            *g = Some(Running { tasks });
        }
    }

    fn emit(app: &AppHandle, profile_id: &str, action: &str) {
        let _ = app.emit(
            "trigger",
            TriggerPayload {
                profile_id: profile_id.to_string(),
                action: action.to_string(),
            },
        );
    }

    async fn run_device(
        app: AppHandle,
        mut stream: evdev::EventStream,
        chords: Arc<Vec<ChordDesc>>,
        supersets: Arc<Vec<Vec<usize>>>,
    ) {
        // Mirror physical key state into the shared signal `inject_text` reads, so we
        // never type into a still-held trigger modifier (see crate::held_keys).
        let held_keys = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        let mut held: HashSet<u16> = HashSet::new();
        // Per-chord state — hold: currently emitting; latch: armed (rising-edge
        // debounce, so one press = one toggle).
        let mut active = vec![false; chords.len()];
        // Pre-extract key codes for fast "fully held" tests.
        let key_codes: Vec<Vec<u16>> = chords
            .iter()
            .map(|c| c.keys.iter().map(|k| k.code()).collect())
            .collect();

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
                    held_keys.set(ev.code(), true);
                }
                0 => {
                    held.remove(&ev.code());
                    held_keys.set(ev.code(), false);
                }
                _ => continue, // 2 = autorepeat
            }

            // Which chords are fully held right now? (Small N → recomputing the whole
            // set per event is O(N·chord-len) and negligible.)
            let fully: Vec<bool> = key_codes
                .iter()
                .map(|codes| codes.iter().all(|c| held.contains(c)))
                .collect();

            for i in 0..chords.len() {
                // Active iff fully held AND no strict-superset chord is also fully held.
                let on = fully[i] && !supersets[i].iter().any(|&j| fully[j]);
                match &chords[i].action {
                    ChordAction::Dictate { profile_id, activation } => match activation {
                        ActivationType::Hold => {
                            if on && !active[i] {
                                active[i] = true;
                                emit(&app, profile_id, "start");
                            } else if !on && active[i] {
                                active[i] = false;
                                emit(&app, profile_id, "stop");
                            }
                        }
                        ActivationType::Latch => {
                            if on && !active[i] {
                                active[i] = true;
                                emit(&app, profile_id, "toggle");
                            } else if !on {
                                active[i] = false;
                            }
                        }
                    },
                    ChordAction::OpenQuickAdd => {
                        // Rising-edge (like latch): open once per chord press.
                        if on && !active[i] {
                            active[i] = true;
                            crate::quickadd::show(&app);
                        } else if !on {
                            active[i] = false;
                        }
                    }
                }
            }
        }
        // The device stream ended (unplugged / read error) while keys were still
        // held — drop our contribution so a stale modifier can't wedge the gate.
        for &code in &held {
            held_keys.set(code, false);
        }
        // Stop any push-to-talk session this keyboard had active: its key-release (which
        // normally emits "stop") can never arrive now the device is gone, so without this a
        // hold-to-talk dictation started here would stay stuck running. Latch/quick-add are
        // rising-edge, so their dangling `active` flag dies with the task — only Hold leaks.
        for i in 0..chords.len() {
            if active[i] {
                if let ChordAction::Dictate { profile_id, activation: ActivationType::Hold } = &chords[i].action {
                    emit(&app, profile_id, "stop");
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

    #[cfg(test)]
    mod tests {
        // Every key a user can bind via the UI (src/lib/keys.ts `codeToToken` + MODIFIER_CODES)
        // MUST map here, or its chord is silently dropped under the evdev backend while still
        // firing under the plugin/CLI. This pins that bindability matrix so future drift fails the
        // test instead of producing a dead hotkey. Keep the list in sync with keys.ts.
        #[test]
        fn every_bindable_code_maps_to_an_evdev_key() {
            let mut codes: Vec<String> = [
                "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
                "AltLeft", "AltRight", "MetaLeft", "MetaRight",
                "Backspace", "Delete", "Enter", "Space", "Tab", "Home", "End", "Insert",
                "PageUp", "PageDown", "PrintScreen",
                "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
                "NumpadDecimal", "NumpadEnter", "NumpadEqual",
            ]
            .into_iter()
            .map(String::from)
            .collect();
            for c in b'A'..=b'Z' {
                codes.push(format!("Key{}", c as char));
            }
            for d in 0..=9 {
                codes.push(format!("Digit{d}"));
                codes.push(format!("Numpad{d}"));
            }
            for f in 1..=24 {
                codes.push(format!("F{f}"));
            }
            for code in &codes {
                assert!(
                    super::code_to_key(code).is_some(),
                    "bindable code {code:?} has no evdev mapping — its hotkey would silently never fire under evdev"
                );
            }
        }
    }
}
