//! Opt-in hardware hotkey backend (Linux) via `evdev`.
//!
//! The `global-shortcut` plugin can't do reliable hold-to-talk, left/right
//! modifiers, or AltGr on Wayland. Reading `/dev/input` directly can — at the cost
//! of system-wide key-read access (the user must be in the `input` group; see
//! `setup`). Strictly opt-in (`general.evdevEnabled`); we only enumerate keyboards,
//! react to the configured chords, and never persist or transmit scancodes.
//!
//! Each keyboard runs an async event loop tracking a held-key set; chord
//! semantics (hold start/stop edges, hands-free toggle + re-arm, the designed
//! hold ⊂ hands-free family's in-place reclassify, and peer arbitration) live in the shared
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
    use tauri::{AppHandle, Emitter, Manager};

    fn is_keyboard(d: &Device) -> bool {
        d.supported_keys()
            .map_or(false, |k| k.contains(Key::KEY_ENTER))
    }

    /// Can we actually open a keyboard for reading (i.e. are we permitted)?
    pub fn permitted() -> bool {
        evdev::enumerate().any(|(_, d)| is_keyboard(&d))
    }

    /// The login name of the real uid, read from the passwd database.
    fn current_username() -> Option<String> {
        // getpwuid_r, not getpwuid: `setup()` is an async command on a multi-threaded runtime and
        // can run twice at once (a double-clicked Setup button), and the plain variant hands back
        // a process-wide static buffer any other passwd lookup in the process may refill between
        // the read and the copy — and this string becomes the `usermod -aG input <user>` argument.
        let mut passwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = [0 as libc::c_char; 1024];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: every pointer is to caller-owned storage that outlives the call; the result
        // pointer (into `passwd`/`buf`) is read once and never retained.
        unsafe {
            let rc = libc::getpwuid_r(
                libc::getuid(),
                &mut passwd,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            );
            if rc != 0 || result.is_null() {
                return None;
            }
            let name = (*result).pw_name;
            if name.is_null() {
                return None;
            }
            std::ffi::CStr::from_ptr(name).to_str().ok().map(str::to_owned)
        }
    }

    /// `pkexec usermod -aG input <this uid's login>` (polkit GUI auth). The user must re-login.
    ///
    /// The account name comes from the REAL uid, not from `$USER`/`$LOGNAME`. This grants
    /// permanent read of every `/dev/input` device — system-wide keylogging capability — and it is
    /// the polkit dialog, not this process, that supplies the privilege. The environment is
    /// writable by anything that launches us (a .desktop entry, a shell rc, a wrapper script), so
    /// taking the target account from it let that name be pointed at a DIFFERENT existing account
    /// while the polkit prompt showed only "usermod" — an administrator approving it had no way to
    /// see whom they were granting it to. The uid we are actually running as cannot be spoofed.
    pub async fn setup() -> Result<String, String> {
        let user = current_username().ok_or_else(|| "couldn't determine the current user".to_string())?;
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
    /// Nesting is filtered by `chord_engine::registration_conflict` (the twin of the
    /// Settings screen's conflicts.ts): only a hold strictly inside a hands-free chord
    /// registers; every other nesting is dropped with a WARN, first in config order wins.
    fn chords_from(profiles: &[Profile], quick_add_hotkey: &[String]) -> Vec<ChordSpec> {
        const MAX_CHORDS: usize = 256;
        let mut out: Vec<ChordSpec> = Vec::new();
        let mut push = |kind: ChordKind, keys: Vec<u16>, what: &str| {
            // Hard ceiling on the chord set. The dedup below is O(n^2), `Engine::new`'s
            // subset matrix is another, and `Engine::step` then walks every chord on EVERY
            // system-wide key transition — so the profile list, which arrives from the sync
            // blob and is persisted, sizes a hot path. This bound is orders of magnitude above
            // any real binding set, so nothing legitimate is dropped.
            if out.len() >= MAX_CHORDS {
                tracing::warn!("[evdev] chord ceiling {MAX_CHORDS} reached, dropping {what}");
                return;
            }
            // The registration filter: duplicates, and every nesting except the designed
            // hold ⊂ hands-free upgrade, are dropped — first in config order wins. The Settings
            // UI refuses to save these (`conflicts.ts`); this is the same rule for the lists
            // that never pass through it (a sync pull, an import), because the engine cannot
            // make sense of them: two nested holds run two sessions at once, and the inner
            // hold's release then stops the OUTER session at the wrong key.
            let candidate = ChordSpec { keys, kind };
            let clash = out
                .iter()
                .find_map(|c| crate::chord_engine::registration_conflict(c, &candidate));
            match clash {
                Some(why) => tracing::warn!(
                    "[evdev] {what} {why}; ignoring it (the Profiles screen flags this as a conflict)"
                ),
                None => out.push(candidate),
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
                ActivationType::HandsFree => ChordKind::HandsFree { profile_id: p.id.clone() },
            };
            // `what` is interpolated into the duplicate-chord warning below, so the untrusted id
            // is defanged here rather than at the log line — same reason as `emit`'s. This one
            // fires on every `apply_bindings`: startup, resume, and every pull touching profiles.
            push(
                kind,
                keys,
                &format!("profile '{}'", crate::transport::bounded_server_text(&p.id, 120)),
            );
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
        // inject-gate can't wait on a phantom modifier — and retire the old readers' writer
        // (a reader whose stream ends past the abort point still runs its post-loop; see
        // HeldKeys::clear). One writer per start, cloned into every reader.
        let held_keys = app.state::<crate::held_keys::HeldKeys>();
        held_keys.clear();
        let held_keys = held_keys.writer();
        let chords = chords_from(profiles, quick_add_hotkey);
        if chords.is_empty() {
            tracing::info!("[evdev] no mappable chords; not starting");
            return; // guard drops → lock released; *g stays None (no listener)
        }
        // Fixed for the life of the listener; each reader gets its own Engine
        // (chord-family state is per-keyboard, like the held-key set).
        let mut tasks = Vec::new();
        for (path, dev) in evdev::enumerate() {
            if !is_keyboard(&dev) {
                continue;
            }
            let app = app.clone();
            let held_keys = held_keys.clone();
            let engine = Engine::new(chords.clone());
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
                run_device(app, held_keys, stream, engine).await;
            }));
        }
        tracing::info!(
            "[evdev] listening on {} keyboard(s), {} chord(s)",
            tasks.len(),
            chords.len()
        );
        *g = Some(Running { tasks }); // still holding the guard from the top → atomic stop→store
    }

    /// `chord_mods` = the firing chord's OWN modifier keycodes, so `inject_text` can tell "the
    /// user has not let go of the dictation chord" (divert to clipboard) from "an unrelated
    /// modifier is down" (type anyway). This backend feeds `HeldKeys`, so without the snapshot
    /// the gate was dead here — see `triggers::snapshot_trigger_mods`. Empty for a teardown-
    /// emitted stop, which is not a user chord release.
    fn emit(app: &AppHandle, profile_id: &str, action: &str, chord_mods: Option<&[u16]>) {
        // `None` = a teardown-emitted stop, which is not a user chord release: leave the existing
        // snapshot alone rather than clearing it, so a stop that follows a real chord press by
        // milliseconds cannot wipe the very modifiers the gate needs to see.
        if let Some(mods) = chord_mods {
            crate::triggers::snapshot_trigger_mods(app, mods);
        }
        // Log every fired trigger (same shape as the CLI path's emit_trigger): the chord →
        // session causality is otherwise invisible in the log — see win_hotkeys::emit.
        // `profile_id` is blob- and import-authored (`sanitizeProfiles` type-checks `id` as a
        // string and never clamps it), so it is defanged for the log exactly as the CLI twin in
        // `triggers.rs` is: an embedded newline forges records in the Windows support log users
        // are asked to send, and an unbounded id turns every chord press into a large disk write.
        // This is the highest-frequency of the four sites — it fires on every trigger.
        let profile_id_log = crate::transport::bounded_server_text(profile_id, 120);
        tracing::info!("[trigger] {profile_id_log}/{action} (evdev)");
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
    // Each entry carries the evdev codes of the chord that started the hold, so the teardown can
    // ask the kernel whether that chord is STILL physically down before arming the loss latch.
    static ACTIVE_HOLDS: std::sync::Mutex<Vec<(String, Vec<u16>)>> = std::sync::Mutex::new(Vec::new());

    fn note_hold(profile_id: &str, keys: &[u16], active: bool) {
        if let Ok(mut h) = ACTIVE_HOLDS.lock() {
            h.retain(|(p, _)| p != profile_id);
            if active {
                h.push((profile_id.to_string(), keys.to_vec()));
            }
        }
    }

    /// Is any shortcut MODIFIER of the chord still physically down on SOME keyboard, per the
    /// kernel? `EVIOCGKEY` on each keyboard — the authoritative state, independent of our readers
    /// (which may be aborted by the very teardown asking). A chord lives on one device (each
    /// reader has its own engine), so "on one device" is the right scope; "any modifier", not
    /// "all keys", for the reason `chord_engine::any_chord_mod_down` gives. Empty = no. An
    /// unreadable key state deliberately reads as "not held": failing toward arming there would
    /// divert a phrase to the clipboard on every teardown for anyone whose enumeration fails.
    ///
    /// **Blocking I/O**: `evdev::enumerate()` opens and ioctls every `/dev/input/event*` node —
    /// a slow USB/bluetooth HID device or a wedged udev node can stall. Callers must not run
    /// this on the main/GTK thread (the Windows twin, `GetAsyncKeyState`, has no I/O at all).
    /// `stop_held_sessions` runs from `commands::suspend_shortcuts`, which is a sync Tauri
    /// command on the GTK thread — if this proves problematic, move it to `spawn_blocking`.
    fn chord_mod_still_down(codes: &[u16]) -> bool {
        if codes.is_empty() {
            return false;
        }
        evdev::enumerate().any(|(_, dev)| {
            is_keyboard(&dev)
                && dev.get_key_state().is_ok_and(|ks| {
                    crate::chord_engine::any_chord_mod_down(
                        codes,
                        |c| crate::held_keys::SHORTCUT_MOD_CODES.contains(&c),
                        |c| ks.contains(Key::new(c)),
                    )
                })
        })
    }

    /// The manufactured-stop rule, shared by both teardown sites — the twin of
    /// `win_hotkeys::manufactured_stop`, see there. Emit the stop; arm the loss latch ONLY if the
    /// chord is still physically down. A chord the kernel reports released is safe to type into,
    /// and arming on it diverted the next phrase to the clipboard for nothing.
    fn manufactured_stop(app: &AppHandle, profile_id: &str, keys: &[u16]) {
        if chord_mod_still_down(keys) {
            crate::held_keys::arm_chord_lost();
        } else {
            tracing::info!("[evdev] teardown stop for a chord the kernel reports released; not arming the loss latch");
        }
        emit(app, profile_id, "stop", None);
    }

    /// Remove `profile_id` from ACTIVE_HOLDS, reporting whether it was present — the twin of
    /// `win_hotkeys::take_hold`, and here for the same reason its docblock gives: a manufactured
    /// stop must be CLAIMED, so whichever of the two racing producers runs first wins and a late
    /// duplicate cannot kill a session the user re-triggered in between.
    fn take_hold(profile_id: &str) -> bool {
        let Ok(mut h) = ACTIVE_HOLDS.lock() else {
            return false;
        };
        let had = h.iter().any(|(p, _)| p == profile_id);
        h.retain(|(p, _)| p != profile_id);
        had
    }

    /// Emit "stop" for every PTT chord still held, then clear the set. Call from a listener teardown
    /// whose abort()'d readers skip their own post-loop stop cleanup, so a session held across the
    /// restart isn't wedged "listening". No-op when nothing is held (the common case).
    pub fn stop_held_sessions(app: &AppHandle) {
        let stuck = ACTIVE_HOLDS
            .lock()
            .map(|mut h| std::mem::take(&mut *h))
            .unwrap_or_default();
        for (profile_id, keys) in stuck {
            // `None` chord mods = a stop we MANUFACTURED, not a user chord release; the loss
            // latch is armed only when the chord is genuinely still down — see manufactured_stop.
            manufactured_stop(app, &profile_id, &keys);
        }
    }

    /// Commit one debounced key transition: update the held-set + the HeldKeys
    /// mirror, step the engine, dispatch its fires. (The pre-debounce body of the
    /// run_device loop, factored out so deferred releases commit through the same
    /// path — the shared engine owns all chord semantics; this just tracks keys.)
    ///
    /// `teardown`: the post-loop drain of parked releases — a Stop is then emitted only if the
    /// hold is still unclaimed (`take_hold`), since `stop_held_sessions` may already have
    /// manufactured it; see the win_hotkeys twin.
    fn commit(
        app: &AppHandle,
        held_keys: &crate::held_keys::HeldKeysWriter,
        held: &mut HashSet<u16>,
        engine: &mut Engine,
        code: u16,
        down: bool,
        teardown: bool,
    ) {
        let changed = if down { held.insert(code) } else { held.remove(&code) };
        if !changed {
            return;
        }
        held_keys.set(code, down);
        let fires = engine.step(held, std::time::Instant::now());
        // This backend's chord keys ARE evdev keycodes, so the `held_keys` namespace needs no
        // translation — just the projection onto the observable modifier subset.
        let chord_mods = |pid: &str| -> Vec<u16> {
            engine
                .keys_for_profile(pid)
                .into_iter()
                .filter(|k| crate::held_keys::SHORTCUT_MOD_CODES.contains(k))
                .collect()
        };
        for fire in fires {
            match fire {
                Fire::Start(pid) => {
                    // A fresh rising edge: this press IS in the map, so the still-held check
                    // works normally for it and any pending loss latch is now a dud.
                    crate::held_keys::clear_chord_lost();
                    emit(app, &pid, "start", Some(&chord_mods(&pid)));
                    note_hold(&pid, &engine.keys_for_profile(&pid), true);
                }
                Fire::Stop(pid) => {
                    if teardown {
                        if take_hold(&pid) {
                            emit(app, &pid, "stop", None);
                        }
                    } else {
                        emit(app, &pid, "stop", Some(&chord_mods(&pid)));
                        note_hold(&pid, &[], false);
                    }
                }
                // Handoff: the hold's session lives on under the superset —
                // release the teardown bookkeeping, emit no "stop".
                Fire::ReleaseHold(pid) => note_hold(&pid, &[], false),
                Fire::Toggle(pid) => {
                    // A fresh rising edge: this press IS in the map, so the still-held check
                    // works normally for it and any pending loss latch is now a dud.
                    crate::held_keys::clear_chord_lost();
                    emit(app, &pid, "toggle", Some(&chord_mods(&pid)));
                }
                Fire::Reclassify(pid) => {
                    // Same rising edge, same reason as Start/Toggle above: the engine fires
                    // Reclassify only on the hands-free chord's own physical completion (`on &&
                    // !active[i]`), so this press IS in the map and the still-held check works
                    // normally for it — which makes any pending loss latch a dud. It was the one
                    // fire of the three that did not clear it, and it CONTINUES a live session
                    // into hands-free mode, so an injection follows it. Reachable on the ordinary
                    // multi-keyboard setup: keyboard A's stream dies with a hold active and its
                    // post-loop arms the latch, keyboard B's separate engine still has that hold,
                    // and completing the hands-free superset on B otherwise consumed the stale latch
                    // (TTL 130s) and diverted the phrase to the clipboard.
                    crate::held_keys::clear_chord_lost();
                    emit(app, &pid, "reclassify", Some(&chord_mods(&pid)))
                }
                Fire::OpenQuickAdd => crate::quickadd::show(app),
            }
        }
    }

    async fn run_device(
        app: AppHandle,
        held_keys: crate::held_keys::HeldKeysWriter,
        mut stream: evdev::EventStream,
        mut engine: Engine,
    ) {
        // `held_keys` mirrors physical key state into the shared signal `inject_text` reads,
        // so we never type into a still-held trigger modifier (see crate::held_keys). It is
        // this start's writer: retired by the next start's clear(), so a post-loop that runs
        // past the abort point cannot touch its successor's counts.
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
                commit(&app, &held_keys, &mut held, &mut engine, key, false, false);
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
                commit(&app, &held_keys, &mut held, &mut engine, k, d, false);
            }
        }
        // The device stream ended (unplugged / read error). First commit every release still
        // parked in the debouncer — those keys ARE released, and a hold whose release is parked
        // would otherwise still read as active below and get a manufactured stop with the loss
        // latch armed on a chord the user let go of (see the win_hotkeys twin). Teardown mode:
        // the Stop is claimed via take_hold, since stop_held_sessions may have emitted it.
        for key in deb.drain() {
            commit(&app, &held_keys, &mut held, &mut engine, key, false, true);
        }
        // Keys still held — drop our contribution so a stale modifier can't wedge the gate.
        for &code in &held {
            held_keys.set(code, false);
        }
        // Stop any push-to-talk session this keyboard had active: its key-release (which
        // normally emits "stop") can never arrive now the device is gone, so without this a
        // hold-to-talk dictation started here would stay stuck running. Hands-free/quick-add are
        // rising-edge, so their dangling state dies with the task — only Hold leaks.
        for pid in engine.active_holds() {
            // CLAIM the hold before manufacturing its stop. `stop_held_sessions` drains the same
            // registry, arms the latch and emits the same stop — and `apply_bindings` calls it
            // BEFORE `permitted()`'s full /dev/input enumeration and evdev's abort, while
            // `suspend_shortcuts` calls `stop()` and `stop_held_sessions` as separate steps. A
            // reader whose stream errors in that window (unplug, dock event, suspend/resume —
            // itself an `apply_bindings` trigger) runs this post-loop synchronously past the abort
            // point and emitted a SECOND stop for the same profile plus a SECOND `arm_chord_lost`:
            // a stop delivered onto a session the user re-triggered in between, and an extra
            // process-global loss latch that the next typing injection drains, silently diverting
            // that phrase to the clipboard. The Windows arm has had this guard since `take_hold`
            // was added; this is its missing twin.
            if !take_hold(&pid) {
                continue;
            }
            manufactured_stop(&app, &pid, &engine.keys_for_profile(&pid));
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
