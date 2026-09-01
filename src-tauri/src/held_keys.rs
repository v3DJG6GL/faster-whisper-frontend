//! A tiny shared "which keys are physically held right now" signal.
//!
//! Populated by the evdev hotkey backend (the only component that can observe real
//! key state on Wayland) and read by `inject_text`, so we never type into a still-
//! held modifier from the trigger chord — otherwise our injected keystrokes fold
//! into that Ctrl/Alt/Meta and fire shortcuts in the focused app (e.g. a hands-free
//! profile's stop fires on the *second* chord press, with every key still down).
//!
//! Refcounted by keycode so multiple keyboards compose correctly. When the backend isn't running
//! the map stays empty, so the gate is a no-op and injection behaves exactly as before.
//!
//! A leaked count used to "only cost an injection a bounded wait, never a wedge" — that stopped
//! being true when the divert-on-still-held branch became reachable on the primary hotkey paths.
//! A stuck count now means every phrase is silently sent to the clipboard for the process lifetime.
//!
//! The map is TRANSITION-fed, and that is the reason for the loss latch below: `commit()` on both
//! backends early-returns on its own `held` set before touching this map, and that set starts empty
//! on every (re)start. So after a `clear()` a modifier that is already physically down never
//! reappears here, and its eventual key-up early-returns too — the map reads empty for the whole
//! remainder of that hold, and the gate that depends on it is blind. `clear()` itself is load-
//! bearing and must stay (it prevents the immortal-count wedge above), so instead of trying to
//! preserve the state we RECORD that we destroyed it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// When we last MANUFACTURED a stop for a push-to-talk session that was still physically held —
/// or `None` for "not armed". A one-shot: `take_lost_if_fresh` consumes it.
///
/// This is the evidence a listener teardown destroys. `apply_bindings` (a sync pull that touches a
/// profile, a rebind, a hotkey capture, a resume) emits a stop for every chord still held — which
/// MANUFACTURES an injection at the moment the chord is provably still down — and then restarts the
/// backend, which empties this map. Because the map is transition-fed, what is emptied here never
/// comes back, so the injection a beat later reads an empty map, skips the wait, skips the
/// still-held check, and types the server's transcript into a live Ctrl/Shift.
///
/// It is ONE process-global slot with no session or profile identity — consumed by whichever
/// non-empty typing injection arrives first. That is why `clear_chord_lost` exists.
///
/// Armed at the STOP, not at the wipe. Two reasons, both learned the hard way:
///   * The map is also emptied by DECREMENT in each backend's post-loop cleanup, which then emits
///     the same manufactured stop — and on Windows that cleanup RACES the wipe (`*g = None` wakes
///     the worker before the wipe runs), so arming off the map's contents was a coin flip on the
///     platform where this is unconditionally exposed.
///   * A manufactured stop means a session WAS held, so it cannot fire when no session was at
///     risk at all — which arming off "the
///     map contained a chord modifier" does: that also fires when the user merely happens to be
///     holding Shift to select text while an unrelated sync pull lands — a silent clipboard divert
///     for a phrase that was never at risk, the failure mode this project has twice refused.
///
/// `Instant`, not the wall clock: an NTP step or a VM restore can move `SystemTime` backwards, and
/// an elapsed-time comparison that underflows reads an arbitrarily old latch as fresh — failing
/// toward a false divert.
static MODS_LOST_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// A teardown just emitted a stop for a still-held chord. Record it: the key state that proves the
/// chord is down is about to be unrecoverable.
pub fn arm_chord_lost() {
    if let Ok(mut g) = MODS_LOST_AT.lock() {
        *g = Some(Instant::now());
        tracing::warn!(
            "[held] manufactured a stop for a still-held chord — the injection gate will treat the \
             chord as held until this is consumed"
        );
    }
}

/// A chord just fired a fresh rising edge, so the latch's premise is void: a press the engine saw
/// as an edge is a press this map is tracking correctly, and the still-held check works normally
/// for it. Without this the latch is a dud that the NEXT, unrelated session drains.
///
/// It exists because a manufactured stop arms the latch whenever the OS still reports the chord
/// down, and a manufactured stop does not guarantee an injection follows: a live-mode hold profile coerces every per-phrase insert to
/// clipboard-only (which returns before the consume), and a stop with no speech yet returns without
/// injecting at all. Either leaves the latch set for the whole TTL, and the user's very next
/// reflex — release, re-press, dictate — would have had its first phrase diverted.
///
/// Cannot produce a false negative: a chord held continuously across the wipe emits no rising edge
/// by definition, which is the entire situation the latch is for. Deliberately NOT cleared on a
/// bare modifier key-down — a user reaching for an extra modifier while the trigger chord is
/// genuinely still down would wipe a true positive.
pub fn clear_chord_lost() {
    if let Ok(mut g) = MODS_LOST_AT.lock() {
        *g = None;
    }
}

/// Consume the latch if it was armed within `ttl`. Returns whether the caller should treat the
/// chord as still held.
///
/// One-shot and self-expiring, so it can never wedge. The TTL has to cover
/// manufactured-stop → the server returning a final → the injection, and the SERVER controls the
/// middle leg — so it is sized against the LONGEST such leg, not against a guess. That leg is the
/// batch transcription POST's 120s client timeout, NOT the stuck-finalize watchdog this doc once
/// cited: that watchdog is stream-only, so on a batch hold profile it never runs. A tighter bound
/// would let a slow or deliberately stalling server walk the transcript straight past the control.
pub fn take_lost_if_fresh(ttl: Duration) -> bool {
    let at = MODS_LOST_AT.lock().ok().and_then(|mut g| g.take());
    at.is_some_and(|at| at.elapsed() <= ttl)
}

/// evdev keycodes (input-event-codes.h) for the modifiers whose physical release the pre-injection
/// gate waits for — left/right Ctrl, Alt, Meta, AltGr, and Shift. Shift is included because on the
/// primary KWin target direct typing falls back to the portal (no zwp_virtual_keyboard) and paste
/// always uses the portal, both of which resolve injected keycodes under the LIVE seat state: a
/// still-held trigger Shift folds into the keys — turning Ctrl+V into Ctrl+Shift+V, an auto-Enter into
/// Shift+Enter, and mis-casing directly-typed letters. Only the zwp_virtual_keyboard path is Shift-immune.
pub const SHORTCUT_MOD_CODES: [u16; 8] = [
    29,  // KEY_LEFTCTRL
    97,  // KEY_RIGHTCTRL
    56,  // KEY_LEFTALT
    100, // KEY_RIGHTALT (AltGr / ISO_Level3_Shift)
    125, // KEY_LEFTMETA
    126, // KEY_RIGHTMETA
    42,  // KEY_LEFTSHIFT
    54,  // KEY_RIGHTSHIFT
];

/// A binding's `event.code` → the evdev keycode of that SHORTCUT modifier, or None
/// for any non-modifier key. Non-modifiers are dropped for cross-backend parity, not
/// because they are unobservable: `win_hotkeys::commit` mirrors only the eight modifiers
/// (via `vk_to_evdev_mod`), while `evdev_hotkeys::commit` feeds `HeldKeys` every key code
/// it sees. Projects a chord onto its portable subset, so the
/// queued-start held check tests THE CHORD's modifiers rather than any modifier
/// (holding an unrelated Shift must not read as "chord still held").
pub fn modifier_code(code: &str) -> Option<u16> {
    Some(match code {
        "ControlLeft" => 29,
        "ControlRight" => 97,
        "AltLeft" => 56,
        "AltRight" => 100,
        "MetaLeft" => 125,
        "MetaRight" => 126,
        "ShiftLeft" => 42,
        "ShiftRight" => 54,
        _ => return None,
    })
}

/// Shared, cheaply-clonable handle to the held-key refcount map. Managed by Tauri as
/// app state; the hotkey backends write through a [`HeldKeysWriter`], `inject_text` reads.
#[derive(Clone, Default)]
pub struct HeldKeys(Arc<Inner>);

#[derive(Default)]
struct Inner {
    map: Mutex<HashMap<u16, u32>>,
    /// The generation writers must belong to for their writes to land. `clear()` bumps it:
    /// a wipe is also a hand-over, and every writer that existed before it is a listener
    /// being replaced — its remaining writes are rejected (see `HeldKeysWriter`).
    generation: AtomicU64,
}

impl HeldKeys {
    /// A writer bound to the CURRENT generation. Take it once per listener start, after
    /// `clear()`, and clone it into that start's workers.
    pub fn writer(&self) -> HeldKeysWriter {
        HeldKeysWriter { keys: self.clone(), generation: self.0.generation.load(Ordering::Acquire) }
    }

    /// Is any of `codes` currently held?
    pub fn any_held(&self, codes: &[u16]) -> bool {
        self.0
            .map
            .lock()
            .map(|m| codes.iter().any(|c| m.contains_key(c)))
            .unwrap_or(false)
    }

    /// Are ALL of `codes` currently held? False for an empty slice — "nothing to
    /// check" must never read as "held"; the queued-start gate depends on that.
    pub fn all_held(&self, codes: &[u16]) -> bool {
        !codes.is_empty()
            && self
                .0
                .map
                .lock()
                .map(|m| codes.iter().all(|c| m.contains_key(c)))
                .unwrap_or(false)
    }

    /// Forget all held keys — called when the listener (re)starts, so a stale count
    /// from a previous run can't wedge the gate — and retire every existing writer.
    ///
    /// The retirement is what makes the wipe safe. The Windows worker exits gracefully and
    /// runs a post-loop that decrements everything it held, and it may still be draining a
    /// backlog — but the wipe runs the moment `start()` drops the old listener, BEFORE that
    /// worker wakes. So the old worker's late writes used to land on the NEW worker's counts:
    /// a decrement zeroed a modifier the new worker had just recorded as down, the injection
    /// gate then read "nothing held", skipped its wait, and typed the transcript into a live
    /// Ctrl; a late increment from its backlog left a count nobody would ever decrement. With
    /// the generation bumped here, every write from the retired worker is dropped, and the
    /// counts belong to one listener at a time.
    ///
    /// Deliberately unconditional and evidence-free: see [`MODS_LOST_AT`] for why the loss is
    /// recorded at the manufactured stop instead of here.
    pub fn clear(&self) {
        // Bump FIRST: a writer that races the wipe must already be retired when it lands.
        self.0.generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut m) = self.0.map.lock() {
            m.clear();
        }
    }
}

/// A listener's handle for recording presses and releases. Bound to the generation current
/// when it was taken; once `HeldKeys::clear()` has run since, every write is a no-op — the
/// listener that holds it has been replaced and must not touch its successor's counts.
#[derive(Clone)]
pub struct HeldKeysWriter {
    keys: HeldKeys,
    generation: u64,
}

impl HeldKeysWriter {
    /// Record a key press (`down = true`) or release (`down = false`). Dropped when retired.
    pub fn set(&self, code: u16, down: bool) {
        let inner = &self.keys.0;
        // Checked under the map lock so a `clear()` cannot slip between the check and the write.
        if let Ok(mut m) = inner.map.lock() {
            if inner.generation.load(Ordering::Acquire) != self.generation {
                return;
            }
            if down {
                *m.entry(code).or_insert(0) += 1;
            } else if let Some(c) = m.get_mut(&code) {
                *c = c.saturating_sub(1);
                if *c == 0 {
                    m.remove(&code);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These share one process-global latch, so they live in ONE test rather than racing each
    // other under the default parallel harness.
    #[test]
    fn loss_latch_semantics() {
        // Not armed ⇒ nothing to take.
        assert!(!take_lost_if_fresh(Duration::from_secs(60)));

        // Armed ⇒ taken once, and ONLY once. This is what stops a true positive from leaving the
        // latch set and diverting the next, legitimate injection too.
        arm_chord_lost();
        assert!(take_lost_if_fresh(Duration::from_secs(60)));
        assert!(!take_lost_if_fresh(Duration::from_secs(60)));

        // Stale ⇒ consumed but not honoured, so a latch nobody picks up can never wedge.
        arm_chord_lost();
        assert!(!take_lost_if_fresh(Duration::ZERO));
        assert!(!take_lost_if_fresh(Duration::from_secs(60)));

        // A fresh rising edge voids it: the press the engine saw as an edge IS in the map, so the
        // next session must not inherit a dud latch from a teardown that produced no injection.
        arm_chord_lost();
        clear_chord_lost();
        assert!(!take_lost_if_fresh(Duration::from_secs(60)));

        // A WIPE does not arm. The loss is recorded at the manufactured stop, never at the wipe —
        // otherwise an unrelated sync pull landing while the user merely holds Shift to select text
        // would divert a phrase that was never at risk.
        let held = HeldKeys::default();
        held.writer().set(SHORTCUT_MOD_CODES[0], true);
        assert!(held.any_held(&SHORTCUT_MOD_CODES));
        held.clear();
        assert!(!held.any_held(&SHORTCUT_MOD_CODES));
        assert!(!take_lost_if_fresh(Duration::from_secs(60)));
    }

    #[test]
    fn a_retired_writer_cannot_touch_its_successors_counts() {
        const CTRL: u16 = SHORTCUT_MOD_CODES[0];
        let held = HeldKeys::default();
        let old = held.writer();
        old.set(CTRL, true);
        // The listener restarts: wipe + hand-over.
        held.clear();
        let new = held.writer();
        new.set(CTRL, true);
        assert!(held.all_held(&[CTRL]));
        // The old worker's late post-loop decrement — the race that read "nothing held" and
        // typed into a live Ctrl — is dropped, and so is a late increment from its backlog.
        old.set(CTRL, false);
        assert!(held.all_held(&[CTRL]));
        old.set(CTRL, true);
        new.set(CTRL, false);
        assert!(!held.any_held(&[CTRL]));
    }

    #[test]
    fn all_held_is_false_for_an_empty_chord() {
        // The queued-start gate depends on "nothing to check" never reading as "held".
        let held = HeldKeys::default();
        assert!(!held.all_held(&[]));
    }
}
