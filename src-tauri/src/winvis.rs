//! Tell a webview when Rust shows or hides its window (`window://visibility`, payload: is it
//! visible now?).
//!
//! Every window is created once and only ever hidden, never closed, so a webview keeps
//! running while nobody can see it. The accent drift (theme.ts) holds itself while hidden:
//! ticking in a hidden webview kept a steady CPU cost and built up memory it never released
//! (quick-add grew ~1.3 MB a minute for hours). The page's own `visibilitychange` covers
//! some of this on WebKitGTK, but not reliably across platforms; these call sites know
//! exactly, so they say so. Send it BEFORE `show()` (the webview restamps while still
//! hidden, and the first visible frame is current) and AFTER `hide()`.
//!
//! An emit with no listener is dropped, never queued — the webview also asks
//! `isVisible()` once its listener is up (windowVisibility.ts), which covers a hide that
//! happened before it loaded (start minimized).

use tauri::{Emitter, Runtime};

pub const EVENT: &str = "window://visibility";

pub fn notify<R: Runtime, E: Emitter<R>>(emitter: &E, label: &str, visible: bool) {
    let _ = emitter.emit_to(label, EVENT, visible);
}
