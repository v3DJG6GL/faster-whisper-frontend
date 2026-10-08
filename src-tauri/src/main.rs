// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK workarounds (DMA-BUF renderer under AppImage, AT-SPI bridge). Must happen
    // before the first webview is created; launched helpers do not inherit them. See the lib.
    faster_whisper_frontend_lib::prepare_process_env();
    faster_whisper_frontend_lib::run()
}
