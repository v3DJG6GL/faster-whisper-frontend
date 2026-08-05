//! Dictation triggers. A trigger maps to a `(profile_id, action)` and is emitted
//! to the UI as a `trigger` event; the frontend resolves the Profile's Backend and
//! starts/stops dictation. Triggers arrive from:
//!   * CLI flags routed to the running instance (single-instance) — the portable
//!     path, esp. for Wayland where a DE shortcut runs
//!     `app --profile <id> --action toggle` (or the zero-arg `app --toggle`,
//!     which targets the first enabled latch Profile).
//!   * In-app global hotkeys — the plugin below (Linux-X11), the evdev backend
//!     (Linux, opt-in), or the win_hotkeys hook backend (Windows, always on).

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
    pub action: String, // "start" | "stop" | "toggle" | "reclassify" | "cancel" (chord family — see chord_engine)
}

/// The shortcut modifiers that were physically down at the moment the last trigger fired — by
/// construction, the dictation chord's own. `inject_text` waits for the modifiers to be released
/// before typing (they would otherwise fold into the injected keys and fire shortcuts in the
/// focused app), and on timeout it needs to tell "the user has not let go of the dictation chord"
/// from "the user is holding Shift for their own reasons". Only the first is a reason to divert
/// the text to the clipboard; diverting on the second would break ordinary dictation.
static TRIGGER_MODS: Mutex<Vec<u16>> = Mutex::new(Vec::new());

/// Are any of the modifiers that were down when the trigger fired STILL down?
pub fn trigger_modifiers_still_held(held: &crate::held_keys::HeldKeys) -> bool {
    TRIGGER_MODS
        .lock()
        .ok()
        .is_some_and(|mods| !mods.is_empty() && held.any_held(&mods))
}

/// Record which of `chord_mods` are still physically down, as the trigger's modifier snapshot.
///
/// `chord_mods` are evdev keycodes — the `held_keys` namespace, which BOTH backends share
/// (`win_hotkeys::commit` translates VKs through `vk_to_evdev_mod` before `held_keys.set`).
///
/// This is the ONLY writer of [`TRIGGER_MODS`]. It used to live inline in `emit_trigger`, which
/// meant the CLI and global-shortcut-plugin registrars were the only ones that ever wrote it —
/// while `HeldKeys` is populated ONLY by the evdev and Windows backends. The two facts composed
/// into a dead control: on exactly the backends where the gate can engage, the snapshot was empty,
/// and `trigger_modifiers_still_held` fails OPEN on an empty set by construction. So L3's
/// "the dictation chord is still held → divert to clipboard" never fired on the primary
/// native-hotkey paths.
///
/// Callers pass the FIRING CHORD's own modifiers, not every modifier currently down. That is
/// strictly more precise than what the CLI path did before, and it is what keeps an unrelated
/// held Ctrl (scroll-zoom) or Shift from diverting an ordinary phrase to the clipboard.
/// An empty slice clears the snapshot — correct for a teardown-emitted "stop", which is not a
/// user chord release.
pub fn snapshot_trigger_mods(app: &AppHandle, chord_mods: &[u16]) {
    if let Ok(mut g) = TRIGGER_MODS.lock() {
        let held = app.state::<crate::held_keys::HeldKeys>();
        *g = chord_mods
            .iter()
            .copied()
            .filter(|&c| held.any_held(&[c]))
            .collect();
    }
}

/// Emit a trigger event for an explicit Profile id.
fn emit_trigger(app: &AppHandle, profile_id: String, action: &str) {
    // Defanged before it reaches the log, the same way `session.rs`'s stream-error line and every
    // transport log line already are, and for the reason that line states: this file is what users
    // are asked to send for support, so an embedded newline forges records. `profile_id` is
    // untrusted from two directions — `handle_cli_args` parses `--profile <value>` straight out of
    // argv (the documented DE-shortcut path, ~32k of it available and no validation anywhere on
    // the way), and the sync blob's profile ids are only type-checked, never length- or
    // character-clamped.
    let profile_id_log = crate::transport::bounded_server_text(&profile_id, 120);
    tracing::info!("[trigger] {profile_id_log}/{action}");
    // This registrar has no chord in hand (a CLI arg or a DE-level shortcut), so it keeps the
    // original behaviour: every shortcut modifier currently down.
    snapshot_trigger_mods(app, &crate::held_keys::SHORTCUT_MOD_CODES);
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
    // Did this relaunch carry a recognized trigger/quick-add flag? If not, it's a bare
    // "open the app again" launch (e.g. double-clicking the icon) and we reveal the window.
    let mut recognized = false;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--profile" if i + 1 < argv.len() => {
                profile = Some(argv[i + 1].clone());
                recognized = true;
                i += 2;
            }
            "--action" if i + 1 < argv.len() => {
                action = Some(argv[i + 1].clone());
                recognized = true;
                i += 2;
            }
            "--ptt-down" => {
                emit_for_activation(app, ActivationType::Hold, "start");
                recognized = true;
                i += 1;
            }
            "--ptt-up" => {
                emit_for_activation(app, ActivationType::Hold, "stop");
                recognized = true;
                i += 1;
            }
            "--toggle-hold" => {
                emit_for_activation(app, ActivationType::Hold, "toggle");
                recognized = true;
                i += 1;
            }
            "--toggle" | "--toggle-latch" => {
                emit_for_activation(app, ActivationType::Latch, "toggle");
                recognized = true;
                i += 1;
            }
            "--quick-add" => {
                crate::quickadd::show(app);
                recognized = true;
                i += 1;
            }
            // A login launch reaching an already-running instance must not pop the
            // window — it's the one launch that may explicitly want to stay hidden.
            "--autostart" => {
                recognized = true;
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
    // A bare second launch (no trigger/quick-add flag) means "open the app again". The main
    // window is routinely hidden (start-minimized, or close-to-tray), so without this the
    // already-running instance would stay invisible and the app would appear not to open.
    if !recognized {
        crate::tray::show_main(app);
    }
}

// ── In-app global hotkeys via the global-shortcut plugin (Linux-X11) ─────────
// Native Wayland can't register here, and modifier-only chords like "Ctrl+Shift"
// aren't registerable as plugin accelerators — those rely on the evdev backend or
// the CLI path (a DE shortcut → `app --toggle`). On Windows the plugin is never
// the registrar: the win_hotkeys hook backend owns all chords (apply_bindings).
// The GlobalShortcuts portal is M7.

#[derive(Clone)]
#[cfg_attr(windows, allow(dead_code))] // see module header: on Windows the plugin is never the registrar
enum ShortcutTarget {
    Dictate { profile_id: String, activation: ActivationType },
    OpenQuickAdd,
}

#[derive(Default)]
pub struct ShortcutRegistry(Mutex<HashMap<Shortcut, ShortcutTarget>>);

// PTT (Hold) profiles currently emitting "start" on the plugin/global-shortcut path. Mirrors evdev's
// ACTIVE_HOLDS: a registration teardown (a profile-edit rebind, or suspend-for-capture) means the
// key-RELEASE that normally emits "stop" reaches no registration, so a Hold session held across the
// teardown would wedge "listening". Tracked here so the teardown emits those stops itself. Entries
// are deduped on insert; dictate("stop") is a no-op when idle, so a later real release-stop (if the
// chord gets re-registered and released) is harmless.
static ACTIVE_HOLDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note_hold(profile_id: &str, active: bool) {
    if let Ok(mut h) = ACTIVE_HOLDS.lock() {
        h.retain(|p| p != profile_id);
        if active {
            h.push(profile_id.to_string());
        }
    }
}

/// Emit "stop" for every plugin Hold chord still held, then clear the set. Called from the
/// registration teardowns (unregister_all / register_from_config) so a session held across a
/// rebind/suspend isn't left wedged "listening". No-op when nothing is held (the common case).
fn stop_held_sessions(app: &AppHandle) {
    let stuck = ACTIVE_HOLDS
        .lock()
        .map(|mut h| std::mem::take(&mut *h))
        .unwrap_or_default();
    for profile_id in stuck {
        emit_trigger(app, profile_id, "stop");
    }
}

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
    match t {
        ShortcutTarget::Dictate { profile_id, activation } => {
            let action = match (activation, event.state()) {
                (ActivationType::Hold, ShortcutState::Pressed) => "start",
                (ActivationType::Hold, ShortcutState::Released) => "stop",
                (ActivationType::Latch, ShortcutState::Pressed) => "toggle",
                _ => return,
            };
            // Track a held PTT chord so a registration teardown can emit its "stop" (stop_held_sessions).
            if matches!(activation, ActivationType::Hold) {
                note_hold(&profile_id, event.state() == ShortcutState::Pressed);
            }
            emit_trigger(app, profile_id, action);
        }
        ShortcutTarget::OpenQuickAdd => {
            if event.state() == ShortcutState::Pressed {
                crate::quickadd::show(app);
            }
        }
    }
}

/// Unregister all currently-registered global shortcuts. Used while the user is
/// capturing a new binding, so pressing a key only rebinds and doesn't also fire
/// dictation (which previously could start a stuck push-to-talk session).
pub fn unregister_all(app: &AppHandle) {
    // A PTT chord held across this teardown would never receive its "stop" (the registration is
    // gone before the release) — emit it now so the session isn't left wedged "listening".
    stop_held_sessions(app);
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
#[cfg_attr(windows, allow(dead_code))] // see module header: on Windows the plugin is never the registrar
pub fn register_from_config(app: &AppHandle, profiles: &[Profile], quick_add_hotkey: &[String]) {
    // Flush any held PTT chord's "stop" before tearing down the old registrations (a rebind mid-hold
    // would otherwise lose the release-stop and wedge "listening"). Mirrors evdev's stop_held_sessions.
    stop_held_sessions(app);
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
                // Same defang, same file, same reason — `p.id` here is the sync blob's.
                let id_log = crate::transport::bounded_server_text(&p.id, 120);
                tracing::info!(
                    "[hotkey] {} {:?} isn't a global-shortcut chord (modifier-only / AltGr) — use a desktop shortcut → `app --profile {} --action toggle`, or the evdev backend",
                    id_log, p.hotkey, id_log
                );
                continue;
            }
        };
        // `accel` is as untrusted as the `p.id` beside it, and was left raw on every line that
        // prints it — including the one whose id this run defanged. `de_hotkey` only sorts and
        // dedups, `codes_to_accelerator` passes an unrecognized code straight through
        // `code_to_token`'s `code.to_string()` fallthrough, so a synced profile's hotkey carries
        // arbitrary text and length into the accelerator. Same log file, same forged-record harm.
        let accel_log = crate::transport::bounded_server_text(&accel, 120);
        let shortcut = match Shortcut::from_str(&accel) {
            Ok(s) => s,
            Err(_) => {
                tracing::warn!("[hotkey] '{accel_log}' is not a registerable global shortcut");
                continue;
            }
        };
        match gs.register(shortcut.clone()) {
            Ok(()) => {
                tracing::info!(
                    "[hotkey] registered '{accel_log}' → {} ({:?})",
                    crate::transport::bounded_server_text(&p.id, 120),
                    p.activation
                );
                if map
                    .insert(
                        shortcut,
                        ShortcutTarget::Dictate {
                            profile_id: p.id.clone(),
                            activation: p.activation,
                        },
                    )
                    .is_some()
                {
                    tracing::warn!("[hotkey] '{accel_log}' is bound by more than one profile; last wins");
                }
            }
            Err(e) => tracing::warn!("[hotkey] could not register '{accel_log}' (X11 only): {e}"),
        }
    }

    // The quick-add window shortcut (not a Profile) — same plugin registration path.
    if !quick_add_hotkey.is_empty() {
        match crate::config::codes_to_accelerator(quick_add_hotkey) {
            // Same defang: `quickAddHotkey` is a synced code list with the same passthrough.
            Some(accel) => match Shortcut::from_str(&accel) {
                Ok(shortcut) => match gs.register(shortcut.clone()) {
                    Ok(()) => {
                        tracing::info!("[hotkey] registered '{}' → quick-add", crate::transport::bounded_server_text(&accel, 120));
                        map.insert(shortcut, ShortcutTarget::OpenQuickAdd);
                    }
                    Err(e) => tracing::warn!("[hotkey] could not register quick-add '{}' (X11 only): {e}", crate::transport::bounded_server_text(&accel, 120)),
                },
                Err(_) => tracing::warn!("[hotkey] quick-add '{}' is not a registerable global shortcut", crate::transport::bounded_server_text(&accel, 120)),
            },
            None => tracing::info!(
                "[hotkey] quick-add chord {:?} isn't a global-shortcut chord (modifier-only / AltGr) — use the evdev backend or a desktop shortcut → `app --quick-add`",
                quick_add_hotkey
            ),
        }
    }
}
