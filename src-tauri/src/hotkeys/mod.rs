//! Global dictation hotkeys: the trigger registry and plugin accelerators (`triggers`), the two
//! low-level chord backends (`evdev` on Linux, `windows` on Windows), the platform-neutral chord
//! state machine they share (`chord_engine`), their key-release debounce (`debounce`) and the
//! shared held-key signal text injection waits on (`held_keys`).

pub mod chord_engine;
pub mod debounce;
pub mod evdev;
pub mod held_keys;
pub mod triggers;
pub mod windows;
