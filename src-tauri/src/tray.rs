//! System tray icon + menu. The app lives in the background; the tray is the
//! primary way to reveal the window or quit. A left click on the icon shows the
//! window where the platform reports clicks (Windows, macOS); the menu lists every
//! screen so the right-click menu is a launcher too. On Linux the tray is a
//! libappindicator item: it reports no click events and shows the menu on any
//! click, so there the menu is the whole surface.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager,
};

/// Stable id so the tray can be looked up later to reflect dictation state.
const TRAY_ID: &str = "fwf-tray";

/// Menu item id prefix for a screen entry; the rest is the screen id the router's
/// navigate bridge understands (lib/screens.tsx SCREENS, the same ids the overlay uses).
const SCREEN_PREFIX: &str = "screen:";

/// The screens the menu lists, in sidebar order (lib/screens.tsx). App rules is backed
/// by the focused-app detector and only exists on Linux / Windows.
const SCREENS: &[(&str, &str)] = &[
    ("dashboard", "Dashboard"),
    ("statistics", "Statistics"),
    ("transcribe", "Transcribe"),
    ("history", "History"),
    ("profiles", "Profiles"),
    ("backends", "Backends"),
    ("dictionary", "Dictionary"),
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    ("app-rules", "App rules"),
    ("logs", "Logs"),
    ("settings", "Settings"),
];

pub fn create(app: &App) -> tauri::Result<()> {
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::with_capacity(SCREENS.len());
    for (id, label) in SCREENS {
        items.push(MenuItem::with_id(app, format!("{SCREEN_PREFIX}{id}"), *label, true, None::<&str>)?);
    }
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let mut refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    refs.push(&sep);
    refs.push(&quit);
    let menu = Menu::with_items(app, &refs)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("faster-whisper-frontend")
        .menu(&menu)
        // Left click reveals the window; the menu is the right-click surface. Ignored on
        // Linux (libappindicator shows the menu on any button and reports no clicks).
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if let Some(screen) = id.strip_prefix(SCREEN_PREFIX) {
                show_main_at_screen(app.clone(), screen.to_string());
            } else if id == "quit" {
                // Drop any live dictation first: app.exit ends the process without running
                // managed-state destructors, so a mute_system session would otherwise leave
                // the user's system audio muted after we're gone.
                crate::session::cleanup_for_exit(app);
                app.exit(0)
            }
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
/// window's router directly) and by the tray menu's screen entries. The main window
/// listens for `app://navigate` (App.tsx).
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
        // base + the 5-char separator + 64 route chars + the bound's own ellipsis — nowhere near 200.
        assert_eq!(long.chars().count(), "app".len() + 5 + 64 + 1, "{long:?}");
        assert!(!long.contains(&"X".repeat(65)), "{long:?}");
    }
}
