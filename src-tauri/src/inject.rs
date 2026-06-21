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

/// Strip C0/C1 control characters (except Tab and LF) from text bound for injection, so a
/// malicious / compromised / garbled transcription server can't smuggle terminal-escape or
/// other control sequences onto the clipboard or into a typed paste. Tab and newline are kept
/// (legitimate keystrokes); CR is first normalized to LF. The Wayland direct-typing paths already
/// drop controls; this brings the paste / clipboard / X11-direct paths to the same posture.
pub fn sanitize_injected(text: &str) -> String {
    // Collapse CRLF and a lone CR to LF first: every direct-typing path maps BOTH '\r' and '\n' to
    // an Enter keypress (wayland_inject's KeySpec, X11), so a server's Windows CRLF line endings
    // would otherwise type TWO Enters per line break — a spurious blank line. Normalizing here makes
    // direct + paste + clipboard agree on one Enter per break.
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| !c.is_control() || c == '\t' || c == '\n')
        .collect()
}

pub fn inject(
    text: &str,
    method: &str,
    auto_enter: bool,
    restore_clipboard: bool,
    paste_shortcut: &[String],
) -> Result<(), String> {
    if text.is_empty() && !auto_enter {
        return Ok(());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    if !text.is_empty() {
        match method {
            "direct" => enigo.text(text).map_err(|e| e.to_string())?,
            _ => paste(&mut enigo, text, restore_clipboard, paste_shortcut)?,
        }
    }

    if auto_enter {
        enigo
            .key(Key::Return, Direction::Click)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read the focus-independent PRIMARY selection (the Linux "highlight to select" buffer) as
/// plain text, or `None` if it's empty / unavailable. Seeds Quick-Add from whatever the user
/// has highlighted in the SOURCE app: PRIMARY is separate from the normal copy/paste clipboard
/// and isn't tied to window focus, so it still reads the source app's highlight after OUR
/// window has taken focus. BLOCKING (a Wayland round-trip to the selection's owner) — always
/// call from a time-bounded `spawn_blocking`, never on the UI thread (same freeze hazard as
/// `begin_injection`'s clipboard read).
pub fn read_primary_selection() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        use arboard::{Clipboard, GetExtLinux, LinuxClipboardKind};
        let mut cb = Clipboard::new().ok()?;
        cb.get().clipboard(LinuxClipboardKind::Primary).text().ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
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

/// Hold `text` on the clipboard as a LIVE owner, blocking the calling thread until the
/// selection is replaced. On Wayland a selection only persists while its source app stays
/// alive to serve it (arboard's `set().wait()`), so this is needed BOTH for clipboard-only
/// insertion AND for restoring the user's previous clipboard after a paste — a plain
/// `set_text` that returns and drops doesn't stick on Wayland (the "clipboard never
/// restored" bug). Always run this on a detached thread.
fn serve_clipboard_blocking(text: String) {
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        if let Ok(mut cb) = arboard::Clipboard::new() {
            // Blocks here serving the selection until another app replaces it — that's what
            // keeps the text on the clipboard after a plain set would return + drop it.
            let _ = cb.set().wait().text(text);
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(text);
        }
    }
}

/// Put `text` on the clipboard and KEEP it there for the user to paste later. Used by the
/// clipboard-only insert method, where (unlike paste) nothing consumes the clipboard
/// immediately, so it must persist via a live owner.
pub fn set_clipboard_persistent(text: &str) {
    let text = text.to_string();
    std::thread::spawn(move || serve_clipboard_blocking(text));
}

/// Restore clipboard text captured by [`set_clipboard`], after a short delay so the paste
/// has consumed the clipboard first. No-op when `prev` is None. Restores via a LIVE owner
/// (not a plain set_text) so the restored value actually persists on Wayland.
pub fn restore_clipboard_later(prev: Option<String>) {
    if let Some(prev) = prev {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            serve_clipboard_blocking(prev);
        });
    }
}

fn paste(enigo: &mut Enigo, text: &str, restore_clipboard: bool, chord: &[String]) -> Result<(), String> {
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
    let res = paste_keystroke(enigo, chord);

    // Restore after the paste has consumed the clipboard — via a live owner (same path as the
    // Wayland branch) so it actually persists; a plain set_text that drops doesn't stick on
    // Wayland and is harmless on X11. No-op when restore is off (`previous` is None). Run it
    // UNCONDITIONALLY (not gated on the paste succeeding): a failed paste_keystroke must not strand
    // the user's clipboard clobbered with our dictated text — mirrors the unconditional modifier
    // release inside paste_keystroke.
    restore_clipboard_later(previous);
    res
}

/// Map a KeyboardEvent.code to an enigo key + whether it's a modifier. "Control" maps to
/// Cmd on macOS so the default paste chord stays correct there.
fn code_to_enigo(code: &str) -> Option<(Key, bool)> {
    let ctrl = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
    Some(match code {
        "ControlLeft" | "ControlRight" => (ctrl, true),
        "ShiftLeft" | "ShiftRight" => (Key::Shift, true),
        "AltLeft" | "AltRight" => (Key::Alt, true),
        "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => (Key::Meta, true),
        "Insert" => (Key::Insert, false),
        c if c.len() == 4 && c.starts_with("Key") => {
            (Key::Unicode(c.as_bytes()[3].to_ascii_lowercase() as char), false)
        }
        _ => return None,
    })
}

fn paste_keystroke(enigo: &mut Enigo, chord: &[String]) -> Result<(), String> {
    let (mut mods, mut main) = (Vec::new(), None);
    for code in chord {
        if let Some((k, is_mod)) = code_to_enigo(code) {
            if is_mod {
                mods.push(k);
            } else {
                main = Some(k);
            }
        }
    }
    // Fall back to Ctrl/Cmd+V if the chord didn't map to a usable main key.
    let main = main.unwrap_or(Key::Unicode('v'));
    if mods.is_empty() {
        mods.push(if cfg!(target_os = "macos") { Key::Meta } else { Key::Control });
    }
    // Settle delays: without them a modifier can arrive after the key, so the target
    // sees a literal character instead of a paste (an XTEST timing race).
    //
    // Track how many modifiers we actually pressed so we can release them even when the
    // main-key click (or a later modifier press) fails: enigo synthesizes REAL key events
    // here (X11/Win/macOS), so a Ctrl/Cmd left logically DOWN wedges the whole desktop.
    let mut pressed = 0usize;
    let mut result = Ok(());
    for m in &mods {
        if let Err(e) = enigo.key(*m, Direction::Press) {
            result = Err(e.to_string());
            break;
        }
        pressed += 1;
        std::thread::sleep(Duration::from_millis(30));
    }
    if result.is_ok() {
        match enigo.key(main, Direction::Click) {
            Ok(()) => std::thread::sleep(Duration::from_millis(30)),
            Err(e) => result = Err(e.to_string()),
        }
    }
    // Release exactly the modifiers we pressed, in reverse, regardless of the outcome
    // above (best-effort: we're already unwinding, so don't mask the original error).
    for m in mods[..pressed].iter().rev() {
        let _ = enigo.key(*m, Direction::Release);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::sanitize_injected;

    #[test]
    fn sanitize_drops_controls_keeps_tab_lf_normalizes_cr() {
        // Printable text + Tab/LF survive; a trailing CR is normalized to LF (not kept), so a
        // CRLF break can't type a second Enter in the direct paths.
        assert_eq!(sanitize_injected("hello\tworld\nline\r"), "hello\tworld\nline\n");
        // CRLF collapses to a single LF (one Enter, not two).
        assert_eq!(sanitize_injected("a\r\nb"), "a\nb");
        // ESC, BEL, NUL, DEL, and a C1 control are stripped; the surrounding text stays.
        assert_eq!(sanitize_injected("a\x1bb\x07c\0d\x7fe\u{0085}f"), "abcdef");
        // Non-ASCII printable (incl. astral) is untouched.
        assert_eq!(sanitize_injected("café 😀"), "café 😀");
    }
}
