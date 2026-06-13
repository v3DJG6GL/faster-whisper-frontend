//! Insert transcribed text into the focused field of the active application.
//!
//! Two strategies (mirroring the settings):
//!   * **paste** — put the text on the clipboard and synthesize Ctrl/Cmd+V
//!     (robust, layout-agnostic; optional clipboard restore afterwards).
//!   * **direct** — type the characters directly via the OS (never touches the
//!     clipboard, but can struggle with some layouts / non-Latin input).
//!
//! Backed by `enigo` (Windows SendInput / X11 XTEST; Wayland via XWayland today —
//! a native libei path is M7) and `arboard` for the clipboard.

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::time::Duration;

/// True on a native Wayland session (where enigo's X11 text path can't type
/// Unicode into native windows — direct typing routes through the portal instead).
pub fn is_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub fn inject(
    text: &str,
    method: &str,
    auto_enter: bool,
    restore_clipboard: bool,
) -> Result<(), String> {
    if text.is_empty() && !auto_enter {
        return Ok(());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    if !text.is_empty() {
        match method {
            "direct" => enigo.text(text).map_err(|e| e.to_string())?,
            _ => paste(&mut enigo, text, restore_clipboard)?,
        }
    }

    if auto_enter {
        enigo
            .key(Key::Return, Direction::Click)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Put `text` on the clipboard; returns the previous contents when `capture_prev`
/// (so the caller can restore it after the paste). Used by the Wayland paste path,
/// which sets the clipboard here and synthesizes Ctrl+V via the portal.
pub fn set_clipboard(text: &str, capture_prev: bool) -> Result<Option<String>, String> {
    use arboard::Clipboard;
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    let prev = if capture_prev { cb.get_text().ok() } else { None };
    cb.set_text(text.to_string()).map_err(|e| e.to_string())?;
    Ok(prev)
}

/// Restore clipboard text captured by [`set_clipboard`], after a short delay so the
/// paste has consumed the clipboard first. No-op when `prev` is None.
pub fn restore_clipboard_later(prev: Option<String>) {
    if let Some(prev) = prev {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set_text(prev);
            }
        });
    }
}

fn paste(enigo: &mut Enigo, text: &str, restore_clipboard: bool) -> Result<(), String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let previous = if restore_clipboard {
        clipboard.get_text().ok()
    } else {
        None
    };
    clipboard.set_text(text.to_string()).map_err(|e| e.to_string())?;
    // Let the new clipboard owner settle before pasting.
    std::thread::sleep(Duration::from_millis(60));
    paste_keystroke(enigo)?;

    if let Some(previous) = previous {
        // Restore after the paste has consumed the clipboard.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            if let Ok(mut cb) = Clipboard::new() {
                let _ = cb.set_text(previous);
            }
        });
    }
    Ok(())
}

fn paste_keystroke(enigo: &mut Enigo) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    // Settle delays: without them the modifier can arrive after the 'v', so the
    // target sees a literal "v" instead of a paste (an XTEST timing race).
    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(30));
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(30));
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
    Ok(())
}
