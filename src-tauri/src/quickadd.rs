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

/// Show + focus the quick-add window and signal the webview to (re)focus its
/// field and refresh the list. Safe to call repeatedly (each summon re-centers).
pub fn show(app: &AppHandle) {
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

/// KDE-Wayland keep-above for the quick-add window via a KWin window rule — the focus-ALLOWED
/// cousin of the chip's rule in `overlay.rs mod kwin`. On native Wayland a client can't force
/// "keep above", so we write a reversible rule (matched on our unique title) that KWin applies
/// compositor-side. Unlike the chip's rule it forces only `above` + `skiptaskbar`; it deliberately
/// does NOT touch focus, since the user types into this window. Merged into the user's
/// `kwinrulesrc` without clobbering their other rules.
#[cfg(target_os = "linux")]
mod kwin {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    const GROUP: &str = "fwf-quick-add";
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    pub fn is_kde_wayland() -> bool {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|s| s.eq_ignore_ascii_case("wayland"))
                .unwrap_or(false);
        let kde = std::env::var("XDG_CURRENT_DESKTOP")
            .map(|s| s.to_ascii_uppercase().contains("KDE"))
            .unwrap_or(false)
            || std::env::var_os("KDE_SESSION_VERSION").is_some()
            || std::env::var_os("KDE_FULL_SESSION").is_some();
        wayland && kde
    }

    /// First of the candidate KConfig CLI tools that is runnable.
    fn tool(candidates: &[&'static str]) -> Option<&'static str> {
        candidates
            .iter()
            .find(|name| {
                Command::new(name)
                    .arg("--help")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok()
            })
            .copied()
    }

    // Null stdio throughout: writing kwinrulesrc can D-Bus-activate a KDE helper that would
    // inherit (and hold open) a captured stdout pipe, deadlocking the wait. We never read it.
    fn set_key(tool: &str, group: &str, key: &str, value: &str) {
        let _ = Command::new(tool)
            .args(["--file", "kwinrulesrc", "--group", group, "--key", key, value])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    fn read_key(tool: &str, group: &str, key: &str) -> Option<String> {
        let out = Command::new(tool)
            .args(["--file", "kwinrulesrc", "--group", group, "--key", key])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    fn reconfigure() {
        let _ = Command::new("dbus-send")
            .args([
                "--type=method_call",
                "--dest=org.kde.KWin",
                "/KWin",
                "org.kde.KWin.reconfigure",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    /// Append our group to General/rules, preserving any existing user (and chip) rules.
    fn merge_general(writer: &str, reader: &str) {
        let mut list: Vec<String> = read_key(reader, "General", "rules")
            .map(|s| {
                s.split(',')
                    .map(|g| g.trim().to_string())
                    .filter(|g| !g.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if !list.iter().any(|g| g == GROUP) {
            list.push(GROUP.to_string());
        }
        set_key(writer, "General", "count", &list.len().to_string());
        set_key(writer, "General", "rules", &list.join(","));
    }

    /// Install the keep-above rule once per session (strength 2 = "Force"), then reload KWin.
    pub fn install_keep_above() {
        if INSTALLED.swap(true, Ordering::Relaxed) {
            return;
        }
        let (Some(writer), Some(reader)) = (
            tool(&["kwriteconfig6", "kwriteconfig5"]),
            tool(&["kreadconfig6", "kreadconfig5"]),
        ) else {
            INSTALLED.store(false, Ordering::Relaxed); // let a later summon retry once tools exist
            return;
        };
        merge_general(writer, reader);
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
