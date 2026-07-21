//! Opt-in hardware hotkey backend (Linux) via `evdev`.
//!
//! The `global-shortcut` plugin can't do reliable hold-to-talk, left/right
//! modifiers, or AltGr on Wayland. Reading `/dev/input` directly can — at the cost
//! of system-wide key-read access (the user must be in the `input` group; see
//! `setup`). Strictly opt-in (`general.evdevEnabled`); we only enumerate keyboards,
//! react to the configured chords, and never persist or transmit scancodes.
//!
//! Each keyboard runs an async event loop tracking a held-key set; chord
//! semantics (hold start/stop edges, latch toggle + re-arm, and the designed
//! hold ⊂ latch ⊂ quick-add chord family: in-place reclassify, grace-window
//! quick-add abort, "most-specific chord wins" suppression) live in the shared
//! [`crate::chord_engine`], and each completion emits the same `trigger` event
//! the CLI/plugin paths use — so it plugs straight into the existing controller.

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
pub use imp::{permitted, setup, start, stop_held_sessions};

#[cfg(not(target_os = "linux"))]
pub fn permitted() -> bool {
    false
}
#[cfg(not(target_os = "linux"))]
pub fn stop_held_sessions(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "linux"))]
#[cfg_attr(windows, allow(dead_code))] // Windows never starts evdev (win_hotkeys owns all chords); stub kept for the shared signature
pub fn start(_app: &tauri::AppHandle, _state: &EvdevState, _profiles: &[crate::config::Profile], _quick_add_hotkey: &[String]) {}
#[cfg(not(target_os = "linux"))]
pub async fn setup() -> Result<String, String> {
    Err("The evdev backend is Linux-only.".into())
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{EvdevState, Running};
    use crate::chord_engine::{ChordKind, ChordSpec, Engine, Fire};
    use crate::config::{ActivationType, Profile};
    use crate::triggers::TriggerPayload;
    // evdev 0.13 renamed `Key` to `KeyCode` (same KEY_* constants, same .code()).
    use evdev::{Device, EventType, KeyCode as Key};
    use std::collections::HashSet;
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, Manager};

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

    /// Build chord specs for every enabled Profile whose hotkey maps cleanly,
    /// plus the quick-add window chord. Equal chords are de-duped (first by config
    /// order wins) so one keypress can't fire two actions. Unmappable / empty skipped.
    /// Nesting (a chord strictly containing another) is NOT deduped — the shared
    /// chord engine implements the designed hold ⊂ latch ⊂ quick-add family.
    fn chords_from(profiles: &[Profile], quick_add_hotkey: &[String]) -> Vec<ChordSpec> {
        let mut out: Vec<ChordSpec> = Vec::new();
        let mut push = |kind: ChordKind, keys: Vec<u16>, what: &str| {
            let set: HashSet<u16> = keys.iter().copied().collect();
            let dup = out
                .iter()
                .any(|c| c.keys.len() == keys.len() && c.keys.iter().all(|k| set.contains(k)));
            if dup {
                tracing::warn!("[evdev] {what} has the same chord as an earlier one; ignoring the duplicate");
            } else {
                out.push(ChordSpec { keys, kind });
            }
        };
        for p in profiles.iter().filter(|p| p.enabled) {
            let Some(keys) = codes_to_keys(&p.hotkey) else {
                continue;
            };
            if keys.is_empty() {
                continue;
            }
            let keys: Vec<u16> = keys.iter().map(|k| k.code()).collect();
            let kind = match p.activation {
                ActivationType::Hold => ChordKind::Hold { profile_id: p.id.clone() },
                ActivationType::Latch => ChordKind::Latch { profile_id: p.id.clone() },
            };
            push(kind, keys, &format!("profile '{}'", p.id));
        }
        // The quick-add window shortcut (not a Profile) — matched alongside the chords.
        if let Some(keys) = codes_to_keys(quick_add_hotkey) {
            if !keys.is_empty() {
                let keys: Vec<u16> = keys.iter().map(|k| k.code()).collect();
                push(ChordKind::QuickAdd, keys, "the quick-add shortcut");
            }
        }
        out
    }

    pub fn start(app: &AppHandle, state: &EvdevState, profiles: &[Profile], quick_add_hotkey: &[String]) {
        // Hold the EvdevState lock across the ENTIRE stop→enumerate→spawn→store sequence so two
        // concurrent apply_bindings() calls (the reregister_shortcuts IPC thread + the suspend-watch
        // thread) can't interleave: otherwise both spawn reader-task sets that briefly read the same
        // devices in parallel — double-firing every chord — before one store aborts the other. Inline
        // the stop (set *g = None, dropping the old Running → aborting its readers) instead of calling
        // super::stop(): std::sync::Mutex is non-reentrant, so re-locking here would deadlock. No
        // .await runs under the guard (spawn just schedules; enumerate is a sync scan), so this can't
        // hold the lock across a suspension point.
        let mut g = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        *g = None; // drop + abort any previous readers, under the lock
        // Fresh start: drop any held-key counts left over from a previous run so the
        // inject-gate can't wait on a phantom modifier.
        app.state::<crate::held_keys::HeldKeys>().clear();
        let chords = chords_from(profiles, quick_add_hotkey);
        if chords.is_empty() {
            tracing::info!("[evdev] no mappable chords; not starting");
            return; // guard drops → lock released; *g stays None (no listener)
        }
        // Fixed for the life of the listener; each reader gets its own Engine
        // (chord-family state is per-keyboard, like the held-key set).
        let chords = Arc::new(chords);

        let mut tasks = Vec::new();
        for (path, dev) in evdev::enumerate() {
            if !is_keyboard(&dev) {
                continue;
            }
            let app = app.clone();
            let chords = chords.clone();
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
                run_device(app, stream, Engine::new((*chords).clone())).await;
            }));
        }
        tracing::info!(
            "[evdev] listening on {} keyboard(s), {} chord(s)",
            tasks.len(),
            chords.len()
        );
        *g = Some(Running { tasks }); // still holding the guard from the top → atomic stop→store
    }

    fn emit(app: &AppHandle, profile_id: &str, action: &str) {
        // Log every fired trigger (same shape as the CLI path's emit_trigger): the chord →
        // session causality is otherwise invisible in the log — see win_hotkeys::emit.
        tracing::info!("[trigger] {profile_id}/{action} (evdev)");
        let _ = app.emit(
            "trigger",
            TriggerPayload {
                profile_id: profile_id.to_string(),
                action: action.to_string(),
            },
        );
    }

    // PTT (Hold) chords currently emitting "start", across all reader tasks. A listener teardown
    // (apply_bindings restart, evdev disable, suspend-for-rebind) aborts the readers, which SKIPS
    // their post-loop "stop" cleanup — so a Hold session held across the teardown would wedge
    // "listening" forever: the new (or absent) reader never observed the press, so the eventual
    // key-release matches no chord and emits no "stop". Tracked here so the teardown can emit those
    // stops itself (see stop_held_sessions). Vec so the static is const-initializable; entries are
    // deduped on insert and dictate("stop") is a no-op when idle, so any staleness is harmless.
    static ACTIVE_HOLDS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    fn note_hold(profile_id: &str, active: bool) {
        if let Ok(mut h) = ACTIVE_HOLDS.lock() {
            h.retain(|p| p != profile_id);
            if active {
                h.push(profile_id.to_string());
            }
        }
    }

    /// Emit "stop" for every PTT chord still held, then clear the set. Call from a listener teardown
    /// whose abort()'d readers skip their own post-loop stop cleanup, so a session held across the
    /// restart isn't wedged "listening". No-op when nothing is held (the common case).
    pub fn stop_held_sessions(app: &AppHandle) {
        let stuck = ACTIVE_HOLDS
            .lock()
            .map(|mut h| std::mem::take(&mut *h))
            .unwrap_or_default();
        for profile_id in stuck {
            emit(app, &profile_id, "stop");
        }
    }

    /// Commit one debounced key transition: update the held-set + the HeldKeys
    /// mirror, step the engine, dispatch its fires. (The pre-debounce body of the
    /// run_device loop, factored out so deferred releases commit through the same
    /// path — the shared engine owns all chord semantics; this just tracks keys.)
    fn commit(
        app: &AppHandle,
        held_keys: &crate::held_keys::HeldKeys,
        held: &mut HashSet<u16>,
        engine: &mut Engine,
        code: u16,
        down: bool,
    ) {
        let changed = if down { held.insert(code) } else { held.remove(&code) };
        if !changed {
            return;
        }
        held_keys.set(code, down);
        for fire in engine.step(held, std::time::Instant::now()) {
            match fire {
                Fire::Start(pid) => {
                    emit(app, &pid, "start");
                    note_hold(&pid, true);
                }
                Fire::Stop(pid) => {
                    emit(app, &pid, "stop");
                    note_hold(&pid, false);
                }
                // Handoff: the hold's session lives on under the superset —
                // release the teardown bookkeeping, emit no "stop".
                Fire::ReleaseHold(pid) => note_hold(&pid, false),
                Fire::Toggle(pid) => emit(app, &pid, "toggle"),
                Fire::Reclassify(pid) => emit(app, &pid, "reclassify"),
                Fire::Cancel(pid) => emit(app, &pid, "cancel"),
                Fire::OpenQuickAdd => crate::quickadd::show(app),
            }
        }
    }

    async fn run_device(app: AppHandle, mut stream: evdev::EventStream, mut engine: Engine) {
        // Mirror physical key state into the shared signal `inject_text` reads, so we
        // never type into a still-held trigger modifier (see crate::held_keys).
        let held_keys = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        let mut held: HashSet<u16> = HashSet::new();
        // Chatter filter (per device — bounce is per physical switch): key-ups for
        // held keys are deferred RELEASE_DEBOUNCE and erased if the key comes back
        // down in the window; see key_debounce and the win_hotkeys twin.
        let mut deb = crate::key_debounce::Debouncer::new(crate::key_debounce::RELEASE_DEBOUNCE);

        loop {
            let ev = match deb.next_deadline() {
                None => match stream.next_event().await {
                    Ok(e) => Some(e),
                    Err(_) => break, // device went away
                },
                Some(dl) => {
                    match tokio::time::timeout_at(tokio::time::Instant::from_std(dl), stream.next_event()).await {
                        Ok(Ok(e)) => Some(e),
                        Ok(Err(_)) => break, // device went away
                        Err(_) => None,      // deadline reached — commit deferred releases below
                    }
                }
            };
            let now = std::time::Instant::now();
            // Due deferred releases first, so a real release always commits before
            // whatever event (if any) woke us.
            for key in deb.expire(now) {
                commit(&app, &held_keys, &mut held, &mut engine, key, false);
            }
            let Some(ev) = ev else { continue };
            if ev.event_type() != EventType::KEY {
                continue;
            }
            let down = match ev.value() {
                1 => true,
                0 => false,
                _ => continue, // 2 = autorepeat
            };
            if let Some((k, d)) = deb.on_event(ev.code(), down, held.contains(&ev.code()), now) {
                commit(&app, &held_keys, &mut held, &mut engine, k, d);
            }
        }
        // NOTE: pending deferred releases are deliberately NOT flushed here — they are
        // by construction keys still in `held`, and the cleanup below already releases
        // every held key's HeldKeys contribution and emits the owed stops.
        // The device stream ended (unplugged / read error) while keys were still
        // held — drop our contribution so a stale modifier can't wedge the gate.
        for &code in &held {
            held_keys.set(code, false);
        }
        // Stop any push-to-talk session this keyboard had active: its key-release (which
        // normally emits "stop") can never arrive now the device is gone, so without this a
        // hold-to-talk dictation started here would stay stuck running. Latch/quick-add are
        // rising-edge, so their dangling state dies with the task — only Hold leaks.
        for pid in engine.active_holds() {
            emit(&app, &pid, "stop");
            note_hold(&pid, false);
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
