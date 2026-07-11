// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // AppImage only: the bundled WebKitGTK's DMA-BUF renderer fails to bring up EGL
    // against the host graphics stack ("Could not create default EGL display:
    // EGL_BAD_PARAMETER" from the GPU process → the webview never paints, white
    // window). The deb/host build is unaffected, so flip the fallback only when the
    // AppImage runtime is detected ($APPIMAGE), and never override a user's setting.
    // Must happen before the first webview is created.
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Don't bridge OUR OWN UI onto the AT-SPI accessibility bus. WebKitGTK's
    // startup burst of accessible-object registration segfaults inside
    // libatk-bridge (spi_register_object_to_path) on current stacks
    // (webkit2gtk 2.52.3 × at-spi2-core 2.60.0/2.60.4, Ubuntu resolute,
    // 2026-07-11: three identical startup crashes, deterministic). This app is
    // itself an AT-SPI *client* — its own listeners are precisely what force
    // every app (including this one) to bridge — so opting our own tree out
    // both dodges the crash and removes noise from the desktop a11y tree.
    // atspi_guard (app detection / field guard) reads OTHER apps as a client
    // and is unaffected; the own-window inject guard uses Tauri is_focused(),
    // not AT-SPI. Cost: our UI is invisible to screen readers — export
    // NO_AT_BRIDGE=0 to re-enable the bridge explicitly. Must happen before
    // the first webview is created.
    #[cfg(target_os = "linux")]
    if std::env::var_os("NO_AT_BRIDGE").is_none() {
        std::env::set_var("NO_AT_BRIDGE", "1");
    }
    faster_whisper_frontend_lib::run()
}
