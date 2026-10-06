//! System tray icon + menu. The app lives in the background; the tray is the
//! primary way to reveal the window or quit. A left click on the icon shows the
//! window; the menu lists every screen so the right-click menu is a launcher too.
//!
//! Two implementations behind one menu ([`menu_entries`]) and one action table
//! ([`run_menu_action`]):
//! - Windows / macOS: Tauri's own tray icon.
//! - Linux: a StatusNotifierItem served over D-Bus by `ksni`. Tauri's Linux tray is a
//!   libappindicator item, which reports no clicks and opens the menu on any button, so a
//!   left click could never open the window. The SNI item gets `Activate` (left click) and
//!   `SecondaryActivate` (middle click) from the shell; the menu is the right-click surface.
//!   Where no StatusNotifierWatcher runs (GNOME without the AppIndicator extension) there is
//!   no tray at all: [`tray_missing`] then turns close-to-tray into a real quit, and a window
//!   already hidden comes back minimized so it is never stranded out of reach.

use tauri::{App, AppHandle, Emitter, Manager};

/// The tray's name: its id + title on Linux and the idle tooltip everywhere.
const TRAY_TITLE: &str = "faster-whisper-frontend";

/// Menu item id prefix for a screen entry; the rest is the screen id the router's
/// navigate bridge understands (lib/screenRegistry.ts SCREENS, the same ids the overlay uses).
const SCREEN_PREFIX: &str = "screen:";

/// The screens the menu lists, in sidebar order (lib/screenRegistry.ts). App rules is backed
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

/// One row of the tray menu, shared by both implementations.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MenuEntry {
    Item { id: String, label: &'static str },
    Separator,
}

/// The tray menu: "Show window", every screen, "Quit".
fn menu_entries() -> Vec<MenuEntry> {
    let item = |id: String, label| MenuEntry::Item { id, label };
    let mut entries = vec![item("show".into(), "Show window"), MenuEntry::Separator];
    entries.extend(
        SCREENS
            .iter()
            .map(|(id, label)| item(format!("{SCREEN_PREFIX}{id}"), *label)),
    );
    entries.push(MenuEntry::Separator);
    entries.push(item("quit".into(), "Quit"));
    entries
}

#[derive(Debug, PartialEq, Eq)]
enum MenuAction<'a> {
    Show,
    Screen(&'a str),
    Quit,
}

fn parse_action(id: &str) -> Option<MenuAction<'_>> {
    match id {
        "show" => Some(MenuAction::Show),
        "quit" => Some(MenuAction::Quit),
        _ => id.strip_prefix(SCREEN_PREFIX).map(MenuAction::Screen),
    }
}

/// Run a tray menu item. Both trays call this on the main thread.
fn run_menu_action(app: &AppHandle, id: &str) {
    match parse_action(id) {
        Some(MenuAction::Show) => show_main(app),
        Some(MenuAction::Screen(screen)) => show_main_at_screen(app.clone(), screen.to_string()),
        Some(MenuAction::Quit) => {
            // Drop any live dictation first: app.exit ends the process without running
            // managed-state destructors, so a mute_system session would otherwise leave
            // the user's system audio muted after we're gone.
            crate::session::cleanup_for_exit(app);
            app.exit(0)
        }
        None => {}
    }
}

pub fn create(app: &App) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    sni::spawn(app);
    #[cfg(not(target_os = "linux"))]
    native::create(app)?;
    Ok(())
}

/// True once it is known there is no tray to come back through (Linux: no
/// StatusNotifierWatcher, or it went away). While the tray is still connecting this is false,
/// so close-to-tray hides as usual; a failed connect then reveals a hidden window itself.
#[cfg(target_os = "linux")]
pub(crate) fn tray_missing() -> bool {
    sni::missing()
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn tray_missing() -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
mod native {
    use super::{menu_entries, run_menu_action, toggle_main, MenuEntry, TRAY_TITLE};
    use tauri::{
        menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        App, Wry,
    };

    /// Stable id so the tray can be looked up later to reflect dictation state.
    pub(super) const TRAY_ID: &str = "fwf-tray";

    pub(super) fn create(app: &App) -> tauri::Result<()> {
        let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
        for entry in menu_entries() {
            items.push(match entry {
                MenuEntry::Item { id, label } => {
                    Box::new(MenuItem::with_id(app, id, label, true, None::<&str>)?)
                }
                MenuEntry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            });
        }
        let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
        let menu = Menu::with_items(app, &refs)?;

        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip(TRAY_TITLE)
            .menu(&menu)
            // Left click reveals the window; the menu is the right-click surface.
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if accept_toggle() {
                        toggle_main(tray.app_handle());
                    }
                }
            })
            .on_menu_event(|app, event| run_menu_action(app, event.id.as_ref()));

        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }

        builder.build(app)?;
        Ok(())
    }

    /// Whether a left-click Up may toggle the window. A shell double-click delivers DOWN, UP,
    /// DBLCLK, UP — two `Click { Up }` events (tray-icon maps every WM_LBUTTONUP) — so without
    /// this the window toggles twice and ends where it started. An Up within the system
    /// double-click time of the last accepted one is the second half of a double-click.
    fn accept_toggle() -> bool {
        use std::sync::Mutex;
        use std::time::{Duration, Instant};
        static LAST_TOGGLE: Mutex<Option<Instant>> = Mutex::new(None);
        let window = Duration::from_millis(double_click_ms());
        let now = Instant::now();
        let mut last = LAST_TOGGLE.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| now.duration_since(t) < window) {
            return false;
        }
        *last = Some(now);
        true
    }

    #[cfg(windows)]
    fn double_click_ms() -> u64 {
        // SAFETY: no arguments, no pointers; reads a per-user system setting.
        u64::from(unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() })
    }

    #[cfg(not(windows))]
    fn double_click_ms() -> u64 {
        500
    }
}

#[cfg(target_os = "linux")]
mod sni {
    use super::{menu_entries, run_menu_action, toggle_main, MenuEntry, TRAY_TITLE};
    use ksni::{menu::StandardItem, Handle, Icon, MenuItem, ToolTip, TrayMethods};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{App, AppHandle, Manager};

    /// The running tray, for tooltip updates. Unset while connecting and when there is none.
    static HANDLE: OnceLock<Handle<SniTray>> = OnceLock::new();
    /// The current tooltip; empty = the idle title. Lives outside the tray so a status set
    /// before the tray is up isn't lost, and so concurrent updates can't land out of order
    /// (each nudge re-reads whatever is newest).
    static TOOLTIP: Mutex<String> = Mutex::new(String::new());
    static MISSING: AtomicBool = AtomicBool::new(false);

    pub(super) fn missing() -> bool {
        MISSING.load(Ordering::Relaxed)
    }

    struct SniTray {
        app: AppHandle,
        icon: Vec<Icon>,
    }

    /// ksni calls the tray from its D-Bus task on the async runtime. Every action hops to the
    /// main thread — the same thread Tauri's own tray menu events arrive on — so the window
    /// ops stay GTK-safe and a slow action (Quit's bounded unmute wait) never stalls the
    /// D-Bus loop.
    fn dispatch(app: &AppHandle, id: String) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || run_menu_action(&handle, &id));
    }

    impl ksni::Tray for SniTray {
        fn id(&self) -> String {
            TRAY_TITLE.into()
        }

        fn title(&self) -> String {
            TRAY_TITLE.into()
        }

        fn icon_pixmap(&self) -> Vec<Icon> {
            self.icon.clone()
        }

        fn tool_tip(&self) -> ToolTip {
            let tip = TOOLTIP.lock().map(|t| t.clone()).unwrap_or_default();
            ToolTip {
                title: if tip.is_empty() {
                    TRAY_TITLE.into()
                } else {
                    tip
                },
                icon_pixmap: self.icon.clone(),
                ..Default::default()
            }
        }

        /// Left click: toggles the window.
        fn activate(&mut self, _x: i32, _y: i32) {
            toggle_main(&self.app);
        }

        /// Middle click: toggles the window too.
        fn secondary_activate(&mut self, _x: i32, _y: i32) {
            toggle_main(&self.app);
        }

        fn menu(&self) -> Vec<MenuItem<Self>> {
            menu_entries()
                .into_iter()
                .map(|entry| match entry {
                    MenuEntry::Item { id, label } => StandardItem {
                        label: label.into(),
                        activate: Box::new(move |t: &mut Self| dispatch(&t.app, id.clone())),
                        ..Default::default()
                    }
                    .into(),
                    MenuEntry::Separator => MenuItem::Separator,
                })
                .collect()
        }

        /// The shell's tray went away (plasmashell restarted, the GNOME extension disabled):
        /// until it is back, close must not hide the window, and a hidden one comes back.
        fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
            tracing::warn!("[tray] StatusNotifierWatcher went offline: {reason:?}");
            mark_missing(&self.app);
            true
        }

        fn watcher_online(&self) {
            tracing::info!("[tray] StatusNotifierWatcher back online");
            MISSING.store(false, Ordering::Relaxed);
        }
    }

    pub(super) fn spawn(app: &App) {
        let tray = SniTray {
            app: app.handle().clone(),
            icon: app
                .default_window_icon()
                .map(|img| {
                    vec![Icon {
                        width: img.width() as i32,
                        height: img.height() as i32,
                        data: rgba_to_argb(img.rgba()),
                    }]
                })
                .unwrap_or_default(),
        };
        let app = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            match tray.spawn().await {
                Ok(handle) => {
                    let _ = HANDLE.set(handle);
                    // A status that arrived while connecting.
                    nudge();
                }
                Err(e) => {
                    tracing::warn!("[tray] no system tray, running without one: {e}");
                    mark_missing(&app);
                }
            }
        });
    }

    /// No tray: a main window hidden to it (start minimized, or closed while the tray was
    /// still connecting) comes back minimized, so the taskbar can reach it.
    fn mark_missing(app: &AppHandle) {
        MISSING.store(true, Ordering::Relaxed);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window("main") {
                if !window.is_visible().unwrap_or(true) {
                    crate::aux_windows::visibility::notify(&window, "main", true);
                    let _ = window.show();
                    let _ = window.minimize();
                }
            }
        });
    }

    pub(super) fn set_tooltip(tip: String) {
        if let Ok(mut t) = TOOLTIP.lock() {
            *t = tip;
        }
        nudge();
    }

    /// Ask ksni to re-read the tray's properties (it signals only what changed).
    fn nudge() {
        if let Some(handle) = HANDLE.get() {
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                handle.update(|_| {}).await;
            });
        }
    }

    /// Tauri images are RGBA; the SNI pixmap is ARGB32 in network byte order (A, R, G, B).
    pub(super) fn rgba_to_argb(rgba: &[u8]) -> Vec<u8> {
        let (pixels, _partial) = rgba.as_chunks::<4>();
        pixels
            .iter()
            .flat_map(|&[r, g, b, a]| [a, r, g, b])
            .collect()
    }
}

pub(crate) fn show_main(app: &AppHandle) {
    // Hop the GTK window ops onto the main thread: callers run off the main thread
    // (hotkeys::triggers::handle_cli_args, the single-instance handler; the Linux tray's D-Bus task), and
    // GTK window calls off the main thread can crash/hang. run_on_main_thread queues onto the
    // loop, so the already-on-main callers (tray menu events, the sync show_main_at_screen
    // command) stay correct without deadlocking.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            crate::aux_windows::visibility::notify(&window, "main", true);
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}

/// The tray icon's left click: hide the main window when it is up (visible, not minimized),
/// otherwise bring it up like `show_main`. Hiding goes through the same visibility notice as the
/// close-to-tray path, so the webview knows it went to the tray.
pub(crate) fn toggle_main(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let up = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        if up && !tray_missing() {
            let _ = window.hide();
            crate::aux_windows::visibility::notify(&window, "main", false);
        } else {
            crate::aux_windows::visibility::notify(&window, "main", true);
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
/// `trayRoute` (dictation/chipController.ts), which — unlike `chipPayload` — does NOT screen them, so
/// this is the only bound: length-capped AND defanged (bidi/format controls
/// stripped, controls folded), since the value goes straight into a shell-drawn
/// tooltip whose whole point is to disclose the route.
#[tauri::command]
pub fn set_tray_state(app: AppHandle, status: String, route: Option<String>) {
    let base = match status.as_str() {
        "warming" => "faster-whisper — warming up…",
        // The server is cold-loading its model: nothing said now is transcribed yet.
        "loading" => "faster-whisper — loading model…",
        "listening" => "faster-whisper — recording…",
        "transcribing" => "faster-whisper — transcribing…",
        "translating" => "faster-whisper — translating…",
        "injecting" => "faster-whisper — inserting…",
        "error" => "faster-whisper — error",
        _ => TRAY_TITLE,
    };
    // Only while something is actually happening: an idle tray naming a route would be
    // advertising a session that isn't running.
    let tip = tooltip(base, &status, route.as_deref().unwrap_or_default());
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        sni::set_tooltip(tip);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(tray) = app.tray_by_id(native::TRAY_ID) {
        let _ = tray.set_tooltip(Some(tip.as_str()));
    }
}

/// The tooltip text: the status line, plus the bounded route while a session runs.
fn tooltip(base: &str, status: &str, route: &str) -> String {
    if route.is_empty() || status == "idle" {
        base.to_string()
    } else {
        format!(
            "{base}  ·  {}",
            crate::transport::bounded_server_text(route, 64)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{menu_entries, parse_action, tooltip, MenuAction, MenuEntry, SCREENS};

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

    #[test]
    fn the_menu_is_show_then_every_screen_then_quit() {
        let entries = menu_entries();
        assert_eq!(entries.len(), SCREENS.len() + 4);
        assert_eq!(
            entries[0],
            MenuEntry::Item {
                id: "show".into(),
                label: "Show window"
            }
        );
        assert_eq!(entries[1], MenuEntry::Separator);
        for ((id, label), entry) in SCREENS.iter().zip(&entries[2..]) {
            assert_eq!(
                *entry,
                MenuEntry::Item {
                    id: format!("screen:{id}"),
                    label
                }
            );
        }
        assert_eq!(entries[entries.len() - 2], MenuEntry::Separator);
        assert_eq!(
            entries[entries.len() - 1],
            MenuEntry::Item {
                id: "quit".into(),
                label: "Quit"
            }
        );
    }

    #[test]
    fn every_menu_id_maps_to_its_action() {
        for entry in menu_entries() {
            if let MenuEntry::Item { id, .. } = entry {
                assert!(parse_action(&id).is_some(), "{id}");
            }
        }
        assert_eq!(parse_action("show"), Some(MenuAction::Show));
        assert_eq!(parse_action("quit"), Some(MenuAction::Quit));
        assert_eq!(
            parse_action("screen:settings"),
            Some(MenuAction::Screen("settings"))
        );
        assert_eq!(parse_action("nope"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rgba_pixels_become_network_order_argb() {
        let rgba = [0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd];
        assert_eq!(
            super::sni::rgba_to_argb(&rgba),
            [0x44, 0x11, 0x22, 0x33, 0xdd, 0xaa, 0xbb, 0xcc]
        );
        // A trailing partial pixel is dropped, never misaligned.
        assert_eq!(
            super::sni::rgba_to_argb(&rgba[..6]),
            [0x44, 0x11, 0x22, 0x33]
        );
    }
}
