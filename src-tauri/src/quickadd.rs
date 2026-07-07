//! The quick-add word-mapping window (label `quickadd`): a small, focusable,
//! always-on-top webview for adding spoken→symbol mappings to the pinned
//! "Spoken symbols" list with the fewest clicks. Defined statically in
//! `tauri.conf.json` (visible:false) so it's prewarmed — we only own showing,
//! hiding, and centering it, plus emitting `quickadd://shown` so the webview can
//! (re)focus its field and refresh the list on every summon.
//!
//! Unlike the chip overlay, this window DOES take focus (the user types into it).
//! On native Wayland `set_position` / `set_always_on_top` are no-ops (the compositor
//! places + stacks it). To keep it ABOVE other windows we install a small KWin window
//! rule (matched on a unique title) — the focus-allowed cousin of the chip's rule in
//! `overlay.rs mod kwin`: it forces keep-above + off-taskbar but never touches focus.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `quickadd` window in tauri.conf.json.
const QA_W: f64 = 600.0;
const QA_H: f64 = 480.0;
/// A unique, stable window title the KDE keep-above rule matches on (invisible — the
/// window is undecorated). Set just before the window maps so the rule applies.
#[cfg(target_os = "linux")]
const QA_TITLE: &str = "fwf-quick-add";

/// Center the window on the monitor it currently lives on (or the primary).
/// A no-op on native Wayland (the compositor decides placement).
fn center(win: &WebviewWindow) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let w = (QA_W * scale) as i32;
    let h = (QA_H * scale) as i32;
    let x = m_pos.x + (m_size.width as i32 - w) / 2;
    let y = m_pos.y + (m_size.height as i32 - h) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// The selection grabbed from the source app just before the window was shown, served
/// to the webview via `get_quickadd_seed`. Windows-only writer (see `win_seed`): there
/// the seed must be captured BEFORE our window takes focus, while on Linux the AT-SPI /
/// PRIMARY reads are focus-independent and happen after. `take`-semantics at read so a
/// summon can never see a previous summon's leftover.
#[derive(Default)]
pub struct SeedStash(
    // Writer (win_seed) and reader (get_quickadd_seed's Windows branch) are both
    // Windows-only; off Windows the managed state simply sits unread.
    #[cfg_attr(not(windows), allow(dead_code))] pub std::sync::Mutex<Option<String>>,
);

/// Show + focus the quick-add window and signal the webview to (re)focus its
/// field and refresh the list. Safe to call repeatedly (each summon re-centers).
///
/// Windows first grabs the source app's selection (copy-chord + clipboard diff —
/// `win_seed`) BEFORE the window takes focus, off the calling thread and time-bounded
/// so a wedged clipboard can never keep the window from opening.
pub fn show(app: &AppHandle) {
    #[cfg(windows)]
    {
        let handle = app.clone();
        std::thread::spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            let grabber = handle.clone();
            std::thread::spawn(move || {
                let _ = tx.send(win_seed::grab(&grabber));
            });
            // Generous vs grab's internal bounds (~1s worst case); on timeout the
            // grabber thread is abandoned and the window opens seedless.
            let seed = rx
                .recv_timeout(std::time::Duration::from_millis(1500))
                .ok()
                .flatten();
            if let Ok(mut s) = handle.state::<SeedStash>().0.lock() {
                *s = seed;
            }
            show_now(&handle);
        });
        return;
    }
    #[cfg(not(windows))]
    show_now(app);
}

fn show_now(app: &AppHandle) {
    // Callable from any context — the chip command (main thread), the global-shortcut
    // handler, the single-instance CLI callback, or an evdev reader task — so hop to the
    // main thread for the GTK window ops.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("quickadd") else {
            return;
        };
        center(&win);
        let _ = win.set_always_on_top(true);
        // KDE-Wayland ignores client keep-above; install a KWin window rule instead (matched on a
        // unique title), the focus-allowed cousin of the chip's rule. The title must be set before
        // the window maps so the rule matches; the config write can block, so it runs off-thread.
        #[cfg(target_os = "linux")]
        if kwin::is_kde_wayland() {
            let _ = win.set_title(QA_TITLE);
            std::thread::spawn(kwin::install_keep_above);
        }
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        let _ = handle.emit("quickadd://shown", ());
    });
}

/// Hide the quick-add window. It stays alive (prewarmed) for the next summon —
/// the close-to-hide guard in `lib.rs` keeps it from being destroyed.
pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("quickadd") {
            let _ = win.hide();
        }
    });
}

/// Open (or re-focus) the quick-add window — invoked by the chip quick-launch
/// action and, later, the global shortcut path.
#[tauri::command]
pub fn show_quick_add(app: AppHandle) {
    show(&app);
}

/// Hide the quick-add window — invoked by the webview on Esc / "done".
#[tauri::command]
pub fn hide_quick_add(app: AppHandle) {
    hide(&app);
}

/// Windows selection grab for the quick-add seed: neither AT-SPI nor a PRIMARY
/// selection exists there, so the pragmatic path is "make the source app copy its
/// selection, diff the clipboard, put the clipboard back". Must run while the SOURCE
/// app still has focus (i.e. before `show_now`).
#[cfg(windows)]
mod win_seed {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    /// Best-effort: any failure or an unchanged clipboard (= nothing selected; apps
    /// no-op the copy) → None. The user's clipboard TEXT is restored afterwards;
    /// non-text content (an image) can't be snapshotted via arboard's text API and
    /// is lost only when the copy actually replaced it (logged).
    pub fn grab(app: &AppHandle) -> Option<String> {
        // The summoning chord's modifiers must be UP before injecting: a still-held
        // Shift would mutate the copy chord (Ctrl+Shift+Insert is PASTE in many
        // terminals). Mirrors inject_text's release gate, except on timeout we SKIP
        // entirely — a seed is optional, firing a mutated chord into the source app
        // is not worth the risk. The win_hotkeys worker feeds this held-set.
        let held = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        let deadline = Instant::now() + Duration::from_millis(500);
        while held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
            if Instant::now() >= deadline {
                tracing::info!("[quickadd-seed] chord modifiers still held; skipping the copy grab");
                return None;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        let mut cb = arboard::Clipboard::new().ok()?;
        let prev = cb.get_text().ok(); // None = empty or non-text (image/files)
        // Ctrl+Insert, the CUA copy chord — Win32 edit controls, browsers, Office, Qt,
        // and terminals all honor it, and unlike Ctrl+C it is never a terminal
        // interrupt. Injected events are skipped by our own keyboard hook
        // (LLKHF_INJECTED), so this can't disturb chord matching.
        let mut enigo = Enigo::new(&Settings::default()).ok()?;
        enigo.key(Key::Control, Direction::Press).ok()?;
        let copied = enigo.key(Key::Insert, Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release); // release even if the click failed
        copied.ok()?;
        // The copy lands asynchronously in the source app — poll briefly for the
        // clipboard to change. Still unchanged at the deadline ⇒ no selection. (A
        // selection that exactly equals the prior clipboard text also reads as
        // "unchanged" and seeds nothing — accepted corner.)
        let deadline = Instant::now() + Duration::from_millis(400);
        loop {
            std::thread::sleep(Duration::from_millis(25));
            let now = cb.get_text().ok();
            if now != prev {
                match prev {
                    Some(prev) => {
                        let _ = cb.set_text(prev); // put the user's clipboard back
                    }
                    None => tracing::info!("[quickadd-seed] non-text clipboard was replaced by the copy grab"),
                }
                return now;
            }
            if Instant::now() >= deadline {
                return None; // clipboard untouched — nothing to restore
            }
        }
    }
}

/// KDE-Wayland keep-above for the quick-add window via a KWin window rule — the focus-ALLOWED
/// cousin of the chip's rule in `overlay.rs mod kwin`. On native Wayland a client can't force
/// "keep above", so we write a reversible rule (matched on our unique title) that KWin applies
/// compositor-side. Unlike the chip's rule it forces only `above` + `skiptaskbar`; it deliberately
/// does NOT touch focus, since the user types into this window. Merged into the user's
/// `kwinrulesrc` without clobbering their other rules.
#[cfg(target_os = "linux")]
mod kwin {
    use std::sync::atomic::{AtomicBool, Ordering};

    // Generic KConfig/KWin primitives are shared with overlay::kwin via crate::kwin.
    use crate::kwin::{config_tools, merge_general, reconfigure, set_key};
    pub use crate::kwin::is_kde_wayland;

    const GROUP: &str = "fwf-quick-add";
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    /// Install the keep-above rule once per session (strength 2 = "Force"), then reload KWin.
    pub fn install_keep_above() {
        if INSTALLED.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some((writer, reader)) = config_tools() else {
            INSTALLED.store(false, Ordering::Relaxed); // let a later summon retry once tools exist
            return;
        };
        merge_general(writer, reader, GROUP);
        let rule: &[(&str, &str)] = &[
            ("Description", "faster-whisper quick-add"),
            ("title", super::QA_TITLE),
            ("titlematch", "1"),   // exact title match
            ("wmclassmatch", "0"), // ignore window class
            ("above", "true"),
            ("aboverule", "2"),
            ("skiptaskbar", "true"),
            ("skiptaskbarrule", "2"),
        ];
        for (k, v) in rule {
            set_key(writer, GROUP, k, v);
        }
        reconfigure();
    }
}
