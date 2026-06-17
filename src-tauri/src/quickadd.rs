//! The quick-add word-mapping window (label `quickadd`): a small, focusable,
//! always-on-top webview for adding spoken→symbol mappings to the pinned
//! "Spoken symbols" list with the fewest clicks. Defined statically in
//! `tauri.conf.json` (visible:false) so it's prewarmed — we only own showing,
//! hiding, and centering it, plus emitting `quickadd://shown` so the webview can
//! (re)focus its field and refresh the list on every summon.
//!
//! Unlike the chip overlay, this window DOES take focus (the user types into it).
//! On native Wayland `set_position` / `set_always_on_top` are no-ops (the
//! compositor places + stacks it); since the user explicitly summons it, the
//! compositor focuses it anyway. A KWin keep-above rule could be added later (cf.
//! `overlay.rs mod kwin`, focus-allowed variant) if stacking proves unreliable.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `quickadd` window in tauri.conf.json.
const QA_W: f64 = 600.0;
const QA_H: f64 = 480.0;

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
    let Some(win) = app.get_webview_window("quickadd") else {
        return;
    };
    center(&win);
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let _ = app.emit("quickadd://shown", ());
}

/// Hide the quick-add window. It stays alive (prewarmed) for the next summon —
/// the close-to-hide guard in `lib.rs` keeps it from being destroyed.
pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("quickadd") {
        let _ = win.hide();
    }
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
