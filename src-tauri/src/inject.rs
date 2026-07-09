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
use std::sync::Mutex;
use std::time::Duration;

/// The last text WE placed on the clipboard for an insertion (transcript paste, clipboard-only
/// insert, Wayland paste). Guards every "capture the user's previous clipboard" site: if a
/// restore fails silently or is skipped, the stale transcript stays on the clipboard, the next
/// capture would adopt it as "the user's clipboard", and the restore chain would then resurrect
/// it after every future paste — seen live over RDP, where the remote's delayed clipboard fetch
/// pasted a 7-minute-old transcript (mstsc, 2026-07).
static LAST_INJECTED: Mutex<Option<String>> = Mutex::new(None);

/// Record `text` as the most recent clipboard content WE set (see `LAST_INJECTED`).
fn note_injected(text: &str) {
    if let Ok(mut g) = LAST_INJECTED.lock() {
        *g = Some(text.to_string());
    }
}

/// True when `text` is the last text we put on the clipboard ourselves — i.e. NOT something
/// the user copied. Compared with CRLF normalized to LF: the Windows clipboard round-trips
/// LF as CRLF, which would otherwise defeat the match for multi-line transcripts.
pub fn is_own_injected(text: &str) -> bool {
    fn norm(s: &str) -> String {
        s.replace("\r\n", "\n")
    }
    LAST_INJECTED
        .lock()
        .ok()
        .and_then(|g| g.as_deref().map(|last| norm(last) == norm(text)))
        .unwrap_or(false)
}

/// Remote-desktop / VDI clients, matched on the focused app id. Their clipboard reaches the
/// remote host ASYNCHRONOUSLY (RDP "delayed rendering" even fetches the data only when the
/// remote app pastes), so (a) the usual 60ms local settle before Ctrl+V is not enough for the
/// new content to cross before the forwarded keystroke, and (b) a post-paste restore can be
/// what the remote's paste actually fetches. Paste into these targets uses a longer settle
/// and skips the clipboard restore entirely.
pub fn is_remote_desktop_app(app_id: &str) -> bool {
    const CLIENTS: &[&str] = &[
        "mstsc", "msrdc", "rdcman", // Microsoft RDP clients (classic / Windows-App-AVD / RDCMan)
        "vmconnect", // Hyper-V console
        "wfica32", "citrix", // Citrix Workspace
        "vmware", // VMware Horizon / Workstation (Tools clipboard sync is async too)
        "virt-viewer", "remote-viewer", // SPICE
        "remmina", "freerdp", // Linux RDP clients
        "rustdesk", "anydesk", "teamviewer", "parsec", "nxplayer",
    ];
    let a = app_id.to_lowercase();
    CLIENTS.iter().any(|c| a.contains(c))
}

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
    remote_target: bool,
) -> Result<(), String> {
    if text.is_empty() && !auto_enter {
        return Ok(());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    if !text.is_empty() {
        match method {
            "direct" => enigo.text(text).map_err(|e| e.to_string())?,
            _ => paste(&mut enigo, text, restore_clipboard, paste_shortcut, remote_target)?,
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

/// Put `text` on the clipboard. Used by the Wayland paste path, which sets the clipboard
/// here and synthesizes Ctrl+V via the portal. The prior clipboard is captured separately
/// and TIME-BOUNDED by the caller (read_selection_bounded — see commands.rs), so this no
/// longer does the unbounded get_text() that could wedge on a dead clipboard owner.
pub fn set_clipboard(text: &str) -> Result<(), String> {
    use arboard::Clipboard;
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())?;
    note_injected(text);
    Ok(())
}

/// Hold `text` on the clipboard as a LIVE owner, blocking the calling thread until the
/// selection is replaced. On Wayland a selection only persists while its source app stays
/// alive to serve it (arboard's `set().wait()`), so this is needed BOTH for clipboard-only
/// insertion AND for restoring the user's previous clipboard after a paste — a plain
/// `set_text` that returns and drops doesn't stick on Wayland (the "clipboard never
/// restored" bug). Always run this on a detached thread.
/// `what` names the operation for the failure log. Failures MUST be visible: a silently-failed
/// RESTORE leaves our transcript on the clipboard, which every later "capture the previous
/// clipboard" would have adopted as the user's content and re-restored forever (the mstsc
/// stale-paste bug hid behind exactly this `let _ =`). `is_own_injected` now breaks that chain,
/// but the failure itself still needs to show up in the log.
fn serve_clipboard_blocking(text: String, what: &str) {
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        match arboard::Clipboard::new() {
            // Blocks here serving the selection until another app replaces it — that's what
            // keeps the text on the clipboard after a plain set would return + drop it.
            Ok(mut cb) => {
                if let Err(e) = cb.set().wait().text(text) {
                    tracing::warn!("[clip] {what} failed: {e}");
                }
            }
            Err(e) => tracing::warn!("[clip] {what}: clipboard unavailable: {e}"),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        match arboard::Clipboard::new() {
            Ok(mut cb) => {
                if let Err(e) = cb.set_text(text) {
                    tracing::warn!("[clip] {what} failed: {e}");
                }
            }
            Err(e) => tracing::warn!("[clip] {what}: clipboard unavailable: {e}"),
        }
    }
}

/// Put `text` on the clipboard and KEEP it there for the user to paste later. Used by the
/// clipboard-only insert method, where (unlike paste) nothing consumes the clipboard
/// immediately, so it must persist via a live owner.
pub fn set_clipboard_persistent(text: &str) {
    note_injected(text);
    let text = text.to_string();
    std::thread::spawn(move || serve_clipboard_blocking(text, "clipboard-only set"));
}

/// Restore clipboard text captured (time-bounded) by the caller before the paste, after a short delay so the paste
/// has consumed the clipboard first. No-op when `prev` is None. Restores via a LIVE owner
/// (not a plain set_text) so the restored value actually persists on Wayland.
pub fn restore_clipboard_later(prev: Option<String>) {
    if let Some(prev) = prev {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            serve_clipboard_blocking(prev, "clipboard restore");
        });
    }
}

fn paste(
    enigo: &mut Enigo,
    text: &str,
    restore_clipboard: bool,
    chord: &[String],
    remote_target: bool,
) -> Result<(), String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    // Never capture (→ never restore) for a remote-desktop target: its clipboard sync is
    // asynchronous, and with RDP delayed rendering the RESTORED value can be what the remote's
    // paste actually fetches — no fixed delay makes that safe, so skipping the restore is the
    // only airtight option. The transcript stays on the clipboard instead.
    let previous = if restore_clipboard && !remote_target {
        // Refuse to adopt OUR OWN last transcript as "the user's previous clipboard": it lingers
        // there after a failed/skipped restore, and restoring it here would resurrect stale
        // dictation after every future paste (the mstsc wrong-text bug).
        clipboard.get_text().ok().filter(|p| {
            let own = is_own_injected(p);
            if own {
                tracing::info!("[clip] paste: prior clipboard is our own transcript — skipping restore");
            }
            !own
        })
    } else {
        None
    };
    clipboard.set_text(text.to_string()).map_err(|e| e.to_string())?;
    note_injected(text);
    // Let the new clipboard owner settle before pasting. A remote-desktop client additionally
    // needs the new content to cross the network (format-list announcement) before the forwarded
    // Ctrl+V lands, or the remote pastes its previously-synced clipboard — give it a longer window.
    std::thread::sleep(Duration::from_millis(if remote_target { 300 } else { 60 }));
    let res = paste_keystroke(enigo, chord);

    // Restore the user's prior clipboard ONLY when the paste SUCCEEDED — via a live owner (same path
    // as the Wayland branch) so it actually persists; a plain set_text that drops doesn't stick on
    // Wayland and is harmless on X11. On FAILURE, deliberately leave our dictated text on the
    // clipboard so it's recoverable by a manual paste: the dictation is the product, and losing it is
    // worse than losing the prior clipboard. This matches the Wayland paste path AND streaming.ts's
    // end-of-session "it's on the clipboard to paste manually" message, which documents this
    // skip-restore-on-failure contract. No-op when restore is off (`previous` is None).
    if res.is_ok() {
        restore_clipboard_later(previous);
    }
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
    fn own_injected_matches_last_set_modulo_crlf() {
        // Only this test touches the LAST_INJECTED global (keep it that way — tests run in
        // parallel within one process).
        super::note_injected("Befund\nZeile 2");
        assert!(super::is_own_injected("Befund\nZeile 2"));
        // The Windows clipboard round-trips LF as CRLF — still ours.
        assert!(super::is_own_injected("Befund\r\nZeile 2"));
        // The user's own copy is not ours.
        assert!(!super::is_own_injected("etwas anderes"));
        // A newer set replaces the remembered value.
        super::note_injected("neu");
        assert!(!super::is_own_injected("Befund\nZeile 2"));
        assert!(super::is_own_injected("neu"));
    }

    #[test]
    fn remote_desktop_app_ids() {
        for id in ["mstsc", "MSRDC", "org.remmina.Remmina", "xfreerdp", "wfica32", "vmconnect"] {
            assert!(super::is_remote_desktop_app(id), "{id} should be remote");
        }
        for id in ["firefox", "kate", "ms-teams", "code"] {
            assert!(!super::is_remote_desktop_app(id), "{id} should not be remote");
        }
    }

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
