//! The translation-target picker (Tauri window label `langpick`): a small, focusable,
//! always-on-top webview that asks which languages this ONE dictation should be turned
//! into, then hands the answer back and closes.
//!
//! Modelled on `quickadd` — same static declaration in `tauri.conf.json` (visible:false,
//! so it is prewarmed and a summon is instant), same KDE-Wayland keep-above rule, same
//! close-to-hide guard in `lib.rs`. What differs is the direction of the data: quick-add
//! writes to a server, this one answers a question the main window asked and is otherwise
//! stateless.
//!
//! Rust owns show/hide/placement only. The seed (which targets are preselected, what the
//! spoken language is) and the answer both travel as events between the two webviews —
//! this window has no store of its own, exactly like quick-add.
//!
//! Placement is at the CENTRE rather than the chip's edge: the picker takes focus and the
//! user is about to type digits into it, so it belongs where the eyes already are, not
//! tucked against a screen border.

use tauri::{AppHandle, Emitter, Manager};

/// Logical size declared for the `langpick` window in tauri.conf.json.
const LP_W: f64 = 460.0;
const LP_H: f64 = 460.0;
/// A unique, stable window title the KDE keep-above rule matches on (invisible — the
/// window is undecorated). Set just before the window maps so the rule applies.
#[cfg(target_os = "linux")]
const LP_TITLE: &str = "fwf-translate-to";


/// Show + focus the picker, carrying the seed the main window built.
///
/// `seed` is opaque JSON (source language, preselected targets, recents) — Rust forwards
/// it to the webview and never interprets it, the same contract `app_rules` has in the
/// config. It rides the show call rather than a separate fetch so the window cannot paint
/// an empty list first and fill it a frame later.
#[tauri::command]
pub fn show_lang_pick(app: AppHandle, seed: serde_json::Value) {
    let handle = app.clone();
    // Callable from the trigger path (any thread) — hop to the main thread for GTK.
    let hop = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("langpick") else {
            // No window to ask → answer "unavailable" so the caller's await settles (see the
            // CloseRequested arm in lib.rs for what a pending asker costs). NOT `abort`: the
            // user never saw a picker, so this must not cancel their dictation — the asker
            // falls back to the Profile's configured targets instead.
            let _ = handle.emit("langpick://unavailable", ());
            return;
        };
        crate::winpos::center_on_monitor(&win, LP_W, LP_H);
        let _ = win.set_always_on_top(true);
        // KDE-Wayland ignores client keep-above; install a KWin rule instead, matched on a
        // unique title. The focus-ALLOWED variant (like quick-add's, unlike the chip's) —
        // the user types into this window.
        #[cfg(target_os = "linux")]
        if kwin::is_kde_wayland() {
            let _ = win.set_title(LP_TITLE);
            std::thread::spawn(kwin::install_keep_above);
        }
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // A Tauri emit with no listener is dropped, never queued. What makes this one safe
        // is NOT `win.show()` — the webview registers its listener in a mount effect,
        // independently of visibility — but the window being PREWARMED (visible:false in
        // tauri.conf.json, mounted at launch), so the listener exists long before the first
        // user-triggered summon. A summon in the first few hundred ms of process life could
        // still lose it; quick-add's pull-based `get_quickadd_seed` is the recovery shape if
        // that ever matters here.
        let _ = handle.emit("langpick://shown", seed);
    });
    // "A dismissed or failed picker always answers": if the main-thread hop itself failed
    // (event loop gone / not yet running) the closure never ran, so nothing above could emit
    // — answer here, or the asker's promise pends forever and hands-free latches its picker
    // gate. `unavailable`, not `abort`: no user gesture happened, so the dictation goes on.
    if hop.is_err() {
        let _ = app.emit("langpick://unavailable", ());
    }
}

/// Hide the picker. It stays alive (prewarmed) for the next summon — the close-to-hide
/// guard in `lib.rs` keeps it from being destroyed. Not an IPC command: nothing in the
/// webview calls it, and commit/abort are the only ways a picker should close.
pub fn hide_lang_pick(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("langpick") {
            let _ = win.hide();
        }
    });
}

/// Deliver the user's choice to the main window and hide.
///
/// `targets` is the chosen list (empty = insert the original only). Forwarded verbatim;
/// the main window is what validates it against the server's advertised languages.
#[tauri::command]
pub fn commit_lang_pick(app: AppHandle, targets: Vec<String>) {
    let _ = app.emit("langpick://commit", targets);
    hide_lang_pick(app);
}

/// Abort the whole action — Esc, the "Cancel"/"Don’t insert" button, or a closed window.
/// Hands-free: the session is not started. Push-to-talk: the finished transcript is NOT
/// inserted (it still goes to History). A SEPARATE event from commit, deliberately: "stop
/// this" and "answered with nothing" (an empty commit = insert the original only) are
/// different answers, and conflating them would make Esc mean "translate nothing".
///
/// There is deliberately no "dismiss → use the Profile's preset" command any more: a
/// picker that is on screen always ends in a real answer. The only "no answer" left is
/// `langpick://unavailable`, emitted by `show_lang_pick` itself when it could not show a
/// window — that one is not a user gesture, so the asker treats it as the preset.
#[tauri::command]
pub fn abort_lang_pick(app: AppHandle) {
    let _ = app.emit("langpick://abort", ());
    hide_lang_pick(app);
}

/// KDE-Wayland keep-above for the picker — the focus-ALLOWED cousin of the chip's rule,
/// sharing the generic KConfig/KWin primitives with `overlay::kwin` and `quickadd::kwin`.
/// Its own GROUP + title so it can be toggled independently of the other two.
#[cfg(target_os = "linux")]
mod kwin {
    use std::sync::atomic::{AtomicBool, Ordering};

    pub use crate::kwin::is_kde_wayland;
    use crate::kwin::{config_tools, merge_general, reconfigure, set_key};

    const GROUP: &str = "fwf-translate-to";
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    /// Install the keep-above rule once per session (strength 2 = "Force"), then reload KWin.
    pub fn install_keep_above() {
        if INSTALLED.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some((writer, reader)) = config_tools() else {
            INSTALLED.store(false, Ordering::Relaxed); // let a later summon retry once tools exist
            return;
        };
        merge_general(writer, reader, GROUP);
        let rule: &[(&str, &str)] = &[
            ("Description", "faster-whisper translate-to picker"),
            ("title", super::LP_TITLE),
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
