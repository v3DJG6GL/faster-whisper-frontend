//! System tray icon + menu. The app lives in the background; the tray is the
//! primary way to reveal the window or quit.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager,
};

/// Stable id so the tray can be looked up later to reflect dictation state.
const TRAY_ID: &str = "fwf-tray";

pub fn create(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("faster-whisper-frontend")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                // Drop any live dictation first: app.exit ends the process without running
                // managed-state destructors, so a mute_system session would otherwise leave
                // the user's system audio muted after we're gone.
                crate::session::cleanup_for_exit(app);
                app.exit(0)
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

pub(crate) fn show_main(app: &AppHandle) {
    // Hop the GTK window ops onto the main thread: one caller (triggers::handle_cli_args, the
    // single-instance handler) runs off the main thread, and GTK window calls off the main thread
    // can crash/hang. run_on_main_thread queues onto the loop, so the already-on-main callers
    // (tray menu event, the sync show_main_at_screen command) stay correct without deadlocking.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}

/// Show + focus the main window and ask its router to navigate to `screen`. Used by
/// the overlay chip's quick-launch (a separate window that can't drive the main
/// window's router directly). The main window listens for `app://navigate` (App.tsx).
#[tauri::command]
pub fn show_main_at_screen(app: AppHandle, screen: String) {
    show_main(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("app://navigate", screen);
    }
}

/// Reflect the live dictation status in the tray tooltip. This is the reliable
/// status cue where the overlay chip can't be pinned (GNOME / non-KDE Wayland) —
/// which is why it carries the translation ROUTE too: on those desktops there is no
/// other surface that can tell the user their German is about to arrive as French.
///
/// `route` is the pre-rendered "DE → FR IT" the chip shows, or empty for a session
/// that doesn't translate. It is built from peer-authored language codes by
/// `trayRoute` (overlay.ts), which — unlike `chipPayload` — does NOT screen them, so
/// this is the only bound: length-capped AND defanged (bidi/format controls
/// stripped, controls folded), since the value goes straight into a shell-drawn
/// tooltip whose whole point is to disclose the route.
#[tauri::command]
pub fn set_tray_state(app: AppHandle, status: String, route: Option<String>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let base = match status.as_str() {
        "warming" => "faster-whisper — warming up…",
        "listening" => "faster-whisper — recording…",
        "transcribing" => "faster-whisper — transcribing…",
        "translating" => "faster-whisper — translating…",
        "injecting" => "faster-whisper — inserting…",
        "error" => "faster-whisper — error",
        _ => "faster-whisper-frontend",
    };
    // Only while something is actually happening: an idle tray naming a route would be
    // advertising a session that isn't running.
    let tip = tooltip(base, &status, route.as_deref().unwrap_or_default());
    let _ = tray.set_tooltip(Some(tip.as_str()));
}

/// The tooltip text: the status line, plus the bounded route while a session runs.
fn tooltip(base: &str, status: &str, route: &str) -> String {
    if route.is_empty() || status == "idle" {
        base.to_string()
    } else {
        format!("{base}  ·  {}", crate::transport::bounded_server_text(route, 64))
    }
}

#[cfg(test)]
mod tests {
    use super::tooltip;

    #[test]
    fn an_idle_tray_never_advertises_a_route() {
        assert_eq!(tooltip("app", "idle", "DE → FR"), "app");
        assert_eq!(tooltip("app", "listening", ""), "app");
    }

    #[test]
    fn the_route_is_defanged_and_bounded_before_it_reaches_the_shell() {
        let t = tooltip("app", "listening", "D\u{202e}E → FR");
        assert!(!t.contains('\u{202e}'), "{t:?}");
        assert!(t.contains("DE → FR"));
        let long = tooltip("app", "listening", &"X".repeat(200));
        assert!(long.chars().count() < 200 + 10, "{long:?}");
    }
}
