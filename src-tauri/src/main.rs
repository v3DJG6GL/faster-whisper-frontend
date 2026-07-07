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
    faster_whisper_frontend_lib::run()
}
