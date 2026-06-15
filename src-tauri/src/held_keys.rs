//! A tiny shared "which keys are physically held right now" signal.
//!
//! Populated by the evdev hotkey backend (the only component that can observe real
//! key state on Wayland) and read by `inject_text`, so we never type into a still-
//! held modifier from the trigger chord — otherwise our injected keystrokes fold
//! into that Ctrl/Alt/Meta and fire shortcuts in the focused app (e.g. a latch
//! profile's stop fires on the *second* chord press, with every key still down).
//!
//! Refcounted by keycode so multiple keyboards compose correctly; a leaked count
//! (a device vanishing mid-hold) only ever costs an injection a bounded wait, never
//! a wedge. When the evdev backend isn't running the map stays empty, so the gate
//! is a no-op and injection behaves exactly as before.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// evdev keycodes (input-event-codes.h) for the shortcut-forming modifiers — left/
/// right Ctrl, Alt, Meta, plus AltGr. Shift is intentionally excluded: it can't form
/// an app shortcut, and the virtual-keyboard typing path is immune to it anyway.
pub const SHORTCUT_MOD_CODES: [u16; 6] = [
    29,  // KEY_LEFTCTRL
    97,  // KEY_RIGHTCTRL
    56,  // KEY_LEFTALT
    100, // KEY_RIGHTALT (AltGr / ISO_Level3_Shift)
    125, // KEY_LEFTMETA
    126, // KEY_RIGHTMETA
];

/// Shared, cheaply-clonable handle to the held-key refcount map. Managed by Tauri as
/// app state; the evdev reader tasks and `inject_text` each clone a handle.
#[derive(Clone, Default)]
pub struct HeldKeys(Arc<Mutex<HashMap<u16, u32>>>);

impl HeldKeys {
    /// Record a key press (`down = true`) or release (`down = false`).
    pub fn set(&self, code: u16, down: bool) {
        if let Ok(mut m) = self.0.lock() {
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

    /// Is any of `codes` currently held?
    pub fn any_held(&self, codes: &[u16]) -> bool {
        self.0
            .lock()
            .map(|m| codes.iter().any(|c| m.contains_key(c)))
            .unwrap_or(false)
    }

    /// Forget all held keys — called when the listener (re)starts, so a stale count
    /// from a previous run can't wedge the gate.
    pub fn clear(&self) {
        if let Ok(mut m) = self.0.lock() {
            m.clear();
        }
    }
}
