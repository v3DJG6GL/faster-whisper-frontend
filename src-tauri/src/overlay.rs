//! The dictation chip overlay window (a separate transparent, always-on-top
//! webview defined in `tauri.conf.json` as label `overlay`).
//!
//! The chip's *content* is driven entirely from the main window, which broadcasts
//! a `dictation://update` event with the assembled `{status, level, partial}`.
//! Here we only own the *window*: showing it at the configured screen edge when
//! dictation starts and hiding it when it ends — never taking focus (focus would
//! break text injection into the previously-focused app).
//!
//! Placement is platform-specific:
//!   * **Windows / Linux-X11** — `set_position` + `set_always_on_top` work, so the
//!     chip is centred at the top (or bottom) and kept above other windows.
//!   * **KDE Wayland** — clients can't position themselves or force keep-above, so
//!     we install a small, reversible **KWin window rule** (matched on a unique,
//!     invisible chip title) that keeps the chip above, off the taskbar, and unable
//!     to steal focus, and forces its position. The position targets the *active*
//!     output (where the cursor / focused window is — `KWin.activeOutputName`), so
//!     on a multi-monitor desktop the chip follows you. See the `kwin` submodule.
//!   * **Other Wayland (GNOME)** — neither works; the chip is shown wherever the
//!     compositor puts it and the tray + sounds are the reliable status cue.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `overlay` window in tauri.conf.json.
const CHIP_W: f64 = 460.0;
const CHIP_H: f64 = 132.0;
/// Gap from the screen edge, in logical pixels.
const MARGIN: f64 = 28.0;
/// A unique, stable window title the KDE rule matches on. Invisible to the user:
/// the chip has no decorations and is hidden from the taskbar/switcher.
#[cfg(target_os = "linux")]
const CHIP_TITLE: &str = "fwf-dictation-chip";

/// Position the chip horizontally centred at the top (or bottom) of the monitor
/// it currently lives on. A no-op on native Wayland (the compositor decides).
fn position(win: &WebviewWindow, edge: &str) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };

    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let chip_w = (CHIP_W * scale) as i32;
    let chip_h = (CHIP_H * scale) as i32;
    let margin = (MARGIN * scale) as i32;

    let x = m_pos.x + (m_size.width as i32 - chip_w) / 2;
    let y = if edge == "bottom" {
        m_pos.y + m_size.height as i32 - chip_h - margin * 3
    } else {
        m_pos.y + margin
    };
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Show the chip at the requested edge ("top" | "bottom"), without focusing it.
#[tauri::command]
pub fn show_overlay(app: AppHandle, position: String) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    self::position(&win, &position);
    let _ = win.set_always_on_top(true);

    #[cfg(target_os = "linux")]
    if kwin::is_kde_wayland() {
        let _ = win.set_title(CHIP_TITLE);
        let _ = win.show();
        // Pin the chip top/bottom-centre of the *active* output via a KWin rule.
        kwin::place_chip(kwin::chip_position(&position, CHIP_W, CHIP_H, MARGIN));
        return;
    }

    let _ = win.show();
}

/// Hide the chip.
#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
}

/// KDE-specific overlay placement via a KWin window rule. On native Wayland a
/// client can't position its own window or force "keep above"; KWin ignores both.
/// The portable fix on KDE is a *window rule*, which KWin applies compositor-side.
/// We write one (merged into the user's `~/.config/kwinrulesrc` without clobbering
/// their existing rules) and ask KWin to reload. The rule only ever matches our
/// chip, identified by its unique title.
#[cfg(target_os = "linux")]
mod kwin {
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// KConfig group (and `rules=` entry) for our rule. A fixed name keeps the
    /// operation idempotent — re-runs update the same entry instead of piling up.
    const GROUP: &str = "fwf-dictation-chip";
    /// Whether the (position-independent) rule body has been written this session.
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    /// The last logical position we forced, so we only reconfigure KWin when the
    /// active output actually changes (avoids churn on every dictation).
    static LAST_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

    /// KDE Plasma on Wayland — the only place this rule is needed and usable.
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

    /// Connector name of the output the user is on (cursor / focused window), via
    /// KWin's D-Bus. e.g. "DP-1". None if KWin isn't reachable.
    fn active_output_name() -> Option<String> {
        for q in ["qdbus6", "qdbus-qt6", "qdbus"] {
            if let Ok(out) = Command::new(q)
                .args(["org.kde.KWin", "/KWin", "org.kde.KWin.activeOutputName"])
                .output()
            {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
        None
    }

    /// Logical geometry (x, y, width, height) of the active output, read straight
    /// from KDE so it matches KWin's own coordinate space. `pos` is logical; `size`
    /// is physical, so logical size = size / scale.
    fn active_output_geometry() -> Option<(i32, i32, i32, i32)> {
        let name = active_output_name()?;
        let out = Command::new("kscreen-doctor").arg("--json").output().ok()?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        for o in v.get("outputs")?.as_array()? {
            if o.get("name").and_then(|n| n.as_str()) != Some(name.as_str()) {
                continue;
            }
            let pos = o.get("pos")?;
            let size = o.get("size")?;
            let scale = o.get("scale").and_then(|s| s.as_f64()).unwrap_or(1.0).max(0.1);
            let x = pos.get("x")?.as_i64()? as i32;
            let y = pos.get("y")?.as_i64()? as i32;
            let w = (size.get("width")?.as_f64()? / scale).round() as i32;
            let h = (size.get("height")?.as_f64()? / scale).round() as i32;
            return Some((x, y, w, h));
        }
        None
    }

    /// Top-left logical position to pin the chip at, on the active output.
    pub fn chip_position(edge: &str, w: f64, h: f64, margin: f64) -> Option<(i32, i32)> {
        let (ox, oy, ow, oh) = active_output_geometry()?;
        let cw = w as i32;
        let ch = h as i32;
        let m = margin as i32;
        let x = ox + ((ow - cw) / 2).max(0);
        let y = if edge == "bottom" {
            oy + (oh - ch - m * 3).max(0)
        } else {
            oy + m
        };
        Some((x, y))
    }

    /// First of the candidate KConfig CLI tools that is runnable.
    fn tool(candidates: &[&'static str]) -> Option<&'static str> {
        candidates
            .iter()
            .find(|name| Command::new(name).arg("--help").output().is_ok())
            .copied()
    }

    fn set_key(tool: &str, group: &str, key: &str, value: &str) {
        let _ = Command::new(tool)
            .args(["--file", "kwinrulesrc", "--group", group, "--key", key, value])
            .output();
    }

    fn read_key(tool: &str, group: &str, key: &str) -> Option<String> {
        let out = Command::new(tool)
            .args(["--file", "kwinrulesrc", "--group", group, "--key", key])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    /// Ask KWin to reload its configuration so the rule applies to the live window.
    fn reconfigure() {
        let _ = Command::new("dbus-send")
            .args([
                "--type=method_call",
                "--dest=org.kde.KWin",
                "/KWin",
                "org.kde.KWin.reconfigure",
            ])
            .output();
    }

    /// Merge our group into General/rules, preserving any existing user rules.
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

    /// Write the position-independent rule body (strength 2 = "Force").
    fn write_rule_body(writer: &str) {
        let rule: &[(&str, &str)] = &[
            ("Description", "faster-whisper dictation chip"),
            ("title", super::CHIP_TITLE),
            ("titlematch", "1"),   // exact title match
            ("wmclassmatch", "0"), // ignore window class
            ("above", "true"),
            ("aboverule", "2"),
            ("skiptaskbar", "true"),
            ("skiptaskbarrule", "2"),
            ("skipswitcher", "true"),
            ("skipswitcherrule", "2"),
            ("skippager", "true"),
            ("skippagerrule", "2"),
            ("acceptfocus", "false"),
            ("acceptfocusrule", "2"),
        ];
        for (k, v) in rule {
            set_key(writer, GROUP, k, v);
        }
    }

    /// Install the chip rule (once) and force its position to `pos` (when known),
    /// reloading KWin only when something actually changed.
    pub fn place_chip(pos: Option<(i32, i32)>) {
        // Need both tools; if we can't read existing rules we must not rewrite the
        // `rules=` list, or we'd silently drop the user's other window rules.
        let (Some(writer), Some(reader)) = (
            tool(&["kwriteconfig6", "kwriteconfig5"]),
            tool(&["kreadconfig6", "kreadconfig5"]),
        ) else {
            return;
        };

        let mut need_reconfigure = false;

        if !INSTALLED.swap(true, Ordering::Relaxed) {
            merge_general(writer, reader);
            write_rule_body(writer);
            need_reconfigure = true;
        }

        if let Some((x, y)) = pos {
            if let Ok(mut last) = LAST_POS.lock() {
                if *last != Some((x, y)) {
                    set_key(writer, GROUP, "position", &format!("{x},{y}"));
                    set_key(writer, GROUP, "positionrule", "2");
                    *last = Some((x, y));
                    need_reconfigure = true;
                }
            }
        }

        if need_reconfigure {
            reconfigure();
        }
    }
}
