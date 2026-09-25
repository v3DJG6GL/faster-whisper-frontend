//! Keep an always-on-top window actually on top (Windows).
//!
//! tao asserts `HWND_TOPMOST` exactly once — at window creation, while the window is still
//! hidden (for an autostarted app: in the middle of the login churn). After that:
//!   * `set_always_on_top(true)` is a NO-OP: tao diffs its own cached flag, the flag is
//!     already set from tauri.conf.json, so no `SetWindowPos` is ever issued;
//!   * `show()` on a non-focusable window is `SW_SHOWNOACTIVATE`, which shows the window at
//!     its CURRENT z-position and never raises it.
//!
//! So when Windows misplaces the window in the topmost band (observed after login: the chip
//! sat under ordinary app windows until the main window was opened), nothing repaired it.
//! Upstream: tauri-apps/tao#1234. PowerToys' Always-On-Top re-pins for the same reason.
//!
//! Everything here passes `SWP_NOACTIVATE`: activating the chip would steal focus from the
//! app being dictated into and break text injection.

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetWindow, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible,
    SetWindowPos, GWL_EXSTYLE, GW_HWNDPREV, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
};

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    win.hwnd().ok().map(|h| h.0 as HWND)
}

fn set_band(hwnd: HWND, insert_after: HWND) {
    // SAFETY: plain Win32 call on a window handle; a stale handle just fails.
    unsafe {
        SetWindowPos(
            hwnd,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

fn is_topmost(hwnd: HWND) -> bool {
    // SAFETY: as above.
    (unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32) & WS_EX_TOPMOST != 0
}

/// Put the window on top of the topmost band. Call right after every `show()` — it is what
/// `set_always_on_top(true)` looks like it does. The NOTOPMOST→TOPMOST pair (rather than a
/// lone TOPMOST) also repairs the "has the bit but sits below" state, which a lone re-assert
/// can treat as no change.
pub fn assert_topmost(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    set_band(hwnd, HWND_NOTOPMOST);
    set_band(hwnd, HWND_TOPMOST);
}

fn intersects(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// The first ordinary (non-topmost) visible window that sits ABOVE `hwnd` and overlaps it,
/// if any — i.e. proof that the window is mis-ordered. Walks up the z-order only, so the
/// common case (we are at or near the top) is a handful of calls.
fn covering_window(hwnd: HWND) -> Option<HWND> {
    let mut ours = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: out-pointer to a local.
    if unsafe { GetWindowRect(hwnd, &mut ours) } == 0 {
        return None;
    }
    let mut cur = hwnd;
    // Bounded: a z-order walk is finite, the cap only guards against a pathological loop.
    for _ in 0..512 {
        // SAFETY: plain Win32 calls; null ends the walk.
        cur = unsafe { GetWindow(cur, GW_HWNDPREV) };
        if cur.is_null() {
            return None;
        }
        let ordinary =
            unsafe { IsWindowVisible(cur) != 0 && IsIconic(cur) == 0 } && !is_topmost(cur);
        if !ordinary {
            continue;
        }
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(cur, &mut r) } != 0 && intersects(&ours, &r) {
            return Some(cur);
        }
    }
    None
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: buffer + its length.
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) }.max(0) as usize;
    String::from_utf16_lossy(&buf[..n.min(buf.len())])
}

/// Watchdog step: repair ONLY a verified-wrong state (topmost bit lost, or an ordinary
/// window above us), so it never fights another always-on-top app and never flickers.
/// After a repair the window is at the very top, so the next check finds nothing.
/// The debug line is the diagnostic for the still-unknown login trigger.
pub fn repair_if_covered(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    if !is_topmost(hwnd) {
        tracing::debug!("[topmost] '{}' lost WS_EX_TOPMOST; re-pinning", win.label());
        set_band(hwnd, HWND_TOPMOST);
        return;
    }
    if let Some(above) = covering_window(hwnd) {
        tracing::debug!(
            "[topmost] '{}' is topmost but below an ordinary window (class '{}'); re-pinning",
            win.label(),
            class_name(above),
        );
        set_band(hwnd, HWND_NOTOPMOST);
        set_band(hwnd, HWND_TOPMOST);
    }
}

#[cfg(test)]
mod tests {
    use super::intersects;
    use windows_sys::Win32::Foundation::RECT;

    #[test]
    fn touching_edges_do_not_count_as_overlap() {
        let a = RECT {
            left: 0,
            top: 0,
            right: 10,
            bottom: 10,
        };
        let beside = RECT {
            left: 10,
            top: 0,
            right: 20,
            bottom: 10,
        };
        let over = RECT {
            left: 9,
            top: 9,
            right: 20,
            bottom: 20,
        };
        assert!(!intersects(&a, &beside));
        assert!(intersects(&a, &over));
    }
}
