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

/// Center a window of logical size `w`×`h` on its monitor. A window larger than the
/// monitor keeps its top-left on screen (offsets clamp at 0, like the chip placement), so
/// an undecorated window's header stays reachable. A no-op on native Wayland, where the
/// compositor decides placement.
pub fn center_on_monitor(win: &WebviewWindow, w: f64, h: f64) {
    let Some(monitor) = monitor_of(win) else {
        return;
    };
    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let pw = (w * scale) as i32;
    let ph = (h * scale) as i32;
    let x = m_pos.x + ((m_size.width as i32 - pw) / 2).max(0);
    let y = m_pos.y + ((m_size.height as i32 - ph) / 2).max(0);
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Whether two screen rectangles `(left, top, right, bottom)` overlap. Edges that merely
/// touch do not count. Lives here (not in the Windows-only `topmost`) so its test runs on
/// the Linux CI leg.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn rects_overlap(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.0 < b.2 && b.0 < a.2 && a.1 < b.3 && b.1 < a.3
}

#[cfg(test)]
mod tests {
    use super::rects_overlap;

    #[test]
    fn touching_edges_do_not_count_as_overlap() {
        assert!(!rects_overlap((0, 0, 10, 10), (10, 0, 20, 10)));
        assert!(!rects_overlap((0, 0, 10, 10), (0, 10, 10, 20)));
        assert!(rects_overlap((0, 0, 10, 10), (9, 9, 20, 20)));
    }
}
