//! Tell a webview when Rust shows or hides its window (`window://visibility`, payload: is it
//! visible now?).
//!
//! Every window is created once and only ever hidden, never closed, so a webview keeps
//! running while nobody can see it. The accent drift (theme.ts) holds itself while hidden:
//! ticking in a hidden webview kept a steady CPU cost and built up memory it never released
//! (quick-add grew ~1.3 MB a minute for hours). The page's own `visibilitychange` covers
//! some of this on WebKitGTK, but not reliably across platforms; these call sites know
//! exactly, so they say so — through [`show`] / [`hide`], which keep the order.
//!
//! An emit with no listener is dropped, never queued — the webview also asks
//! `isVisible()` once its listener is up (windowVisibility.ts), which covers a hide that
//! happened before it loaded (start minimized).
//!
//! `emit_to(label, …)` scopes only listeners registered for that label: a webview listening
//! through the global `listen()` (target Any) hears every window's notify, so it must listen
//! on its own window (`getCurrentWebviewWindow().listen`).

use tauri::{Emitter, Runtime, WebviewWindow};

pub const EVENT: &str = "window://visibility";

/// The bare notice, for a caller holding something other than a `WebviewWindow`
/// (lib.rs's close-to-hide guard). Prefer [`show`] / [`hide`].
pub fn notify<R: Runtime, E: Emitter<R>>(emitter: &E, label: &str, visible: bool) {
    let _ = emitter.emit_to(label, EVENT, visible);
}

/// Show `win`, telling its webview BEFORE `show()`: it restamps while still hidden, so the
/// first visible frame is current.
pub fn show<R: Runtime>(win: &WebviewWindow<R>) {
    notify(win, win.label(), true);
    let _ = win.show();
}

/// Hide `win`, telling its webview AFTER `hide()`.
pub fn hide<R: Runtime>(win: &WebviewWindow<R>) {
    let _ = win.hide();
    notify(win, win.label(), false);
}
