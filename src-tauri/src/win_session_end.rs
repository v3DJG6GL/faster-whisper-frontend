//! Windows session end (shutdown / logoff / restart, and an installer's Restart Manager
//! closing the running app): agree at once, clean up, and actually EXIT.
//!
//! Two tao behaviours make this necessary while tauri-runtime-wry holds tao at 0.35:
//!   * `WM_QUERYENDSESSION` — a window that answers 0 VETOES the shutdown and Windows shows
//!     the "this app is preventing shutdown" screen. The tao revs between PR #1231 and
//!     PR #1274 did exactly that from their thread-event-target window (see the pin's
//!     comment in Cargo.toml). The pin is fixed; answering 1 here keeps our own window
//!     from ever depending on a default arm again.
//!   * `WM_ENDSESSION` — tao 0.35 tears its event loop down (`RunEvent::Exit` fires) but
//!     never exits the process. The 50 ms chip hover poller (overlay.rs) then posts a user
//!     event into the destroyed loop, which panics ("cannot move state from Destroyed").
//!     Harmless when the OS is about to kill us anyway, a crash dialog when it was only an
//!     installer asking us to close. tao 0.37 exits in that handler (PR #1157).
//!
//! So the main window is subclassed: query → 1, end → the same cleanup every other exit
//! path runs, then `exit(0)`. Windows gives an app ~5 s here; `cleanup_for_exit` is bounded
//! at ~2 s (the system-audio unmute flush). Drop this module once the app builds against
//! tao >= 0.37.
//!
//! Message-only windows (the raw-input hotkey window) never receive these broadcasts, and
//! `WM_CLOSE` is not sent at session end — so close-to-tray's `prevent_close` plays no part.

use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_QUERYENDSESSION};

/// Arbitrary, process-unique subclass id ("fwf" + "SE").
const SUBCLASS_ID: usize = 0x6677_6653;

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        // Never veto, and answer without doing any work: the query is not the place for
        // cleanup (the user can still cancel the shutdown after it).
        WM_QUERYENDSESSION => 1,
        // wParam != 0: the session really is ending. Idempotent with the RunEvent::Exit
        // path in lib.rs, which may or may not get to run first — either order is safe.
        WM_ENDSESSION if wparam != 0 => {
            tracing::info!("[session-end] WM_ENDSESSION; cleaning up and exiting");
            if let Some(app) = APP.get() {
                crate::session::cleanup_for_exit(app);
            }
            std::process::exit(0);
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

/// Subclass the main window. Call from `setup()` — `SetWindowSubclass` must run on the
/// thread that owns the window, which `setup()` does.
pub fn install(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let hwnd = match win.hwnd() {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!("[session-end] no HWND for the main window: {e}");
            return;
        }
    };
    let _ = APP.set(app.clone());
    // SAFETY: a live HWND owned by this thread, and a 'static callback.
    let ok = unsafe { SetWindowSubclass(hwnd.0 as HWND, Some(subclass_proc), SUBCLASS_ID, 0) };
    if ok == 0 {
        tracing::warn!("[session-end] SetWindowSubclass failed; relying on tao's handling");
    }
}
