//! The small always-on-top windows next to the main one — the dictation chip (`overlay`), the
//! quick-add window and the language picker — plus the window helpers they share: placement
//! (`position`), show/hide notices to the webview (`visibility`), the Windows z-order repair
//! (`topmost`) and the KDE/KWin window rules (`kwin`).

#[cfg(target_os = "linux")]
pub mod kwin;
pub mod langpick;
pub mod overlay;
pub mod position;
pub mod quickadd;
#[cfg(windows)]
pub mod topmost;
pub mod visibility;

/// Run `f` on the main thread (window ops must not run off it under GTK) against the webview
/// window `label`, if it exists; a missing window is a silent no-op. Returns the hop's result.
pub(crate) fn on_main_window<F>(
    app: &tauri::AppHandle,
    label: &'static str,
    f: F,
) -> tauri::Result<()>
where
    F: FnOnce(&tauri::WebviewWindow) + Send + 'static,
{
    use tauri::Manager;
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window(label) {
            f(&win);
        }
    })
}
