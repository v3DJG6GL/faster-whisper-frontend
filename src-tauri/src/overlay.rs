//! The dictation chip overlay window (a separate transparent, always-on-top
//! webview defined in `tauri.conf.json` as label `overlay`).
//!
//! The chip's *content* is driven entirely from the main window, which broadcasts
//! a `dictation://update` event with the assembled `{status, level, partial}`.
//! Here we only own the *window*: showing it at the configured screen edge when
//! dictation starts and hiding it when it ends — never taking focus (focus would
//! break text injection into the previously-focused app).
//!
//! Platform note: on Windows and Linux/X11 the window is positioned top/bottom
//! centre and kept above other windows. On **native Wayland** clients cannot
//! position their own windows or force always-on-top, so KWin/Mutter place the
//! chip itself (usually centred) — the tray + sound cues are the reliable signal
//! there. We still show/hide it so the live preview is available.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `overlay` window in tauri.conf.json.
const CHIP_W: f64 = 460.0;
const CHIP_H: f64 = 132.0;
/// Gap from the screen edge, in logical pixels.
const MARGIN: f64 = 28.0;

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
    let _ = win.show();
}

/// Hide the chip.
#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
}
