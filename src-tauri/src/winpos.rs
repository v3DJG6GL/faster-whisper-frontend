//! Window placement primitives shared by every window this app positions itself — the
//! chip's edge placement (`overlay::position`), and the centred quick-add and
//! translation-picker windows. Platform-neutral (unlike `kwin`, which is Linux-only).

use tauri::{PhysicalPosition, WebviewWindow};

/// The monitor a window lives on, falling back to the primary. Shared by every window
/// placement in the app (chip edge placement, quick-add and picker centring).
pub fn monitor_of(win: &WebviewWindow) -> Option<tauri::Monitor> {
    match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    }
}

/// Center a window of logical size `w`×`h` on its monitor. A no-op on native Wayland,
/// where the compositor decides placement.
pub fn center_on_monitor(win: &WebviewWindow, w: f64, h: f64) {
    let Some(monitor) = monitor_of(win) else { return };
    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let pw = (w * scale) as i32;
    let ph = (h * scale) as i32;
    let x = m_pos.x + (m_size.width as i32 - pw) / 2;
    let y = m_pos.y + (m_size.height as i32 - ph) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}
