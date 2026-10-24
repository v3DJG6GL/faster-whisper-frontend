// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK env workarounds; must run before `run()` creates the first webview.
    faster_whisper_frontend_lib::prepare_process_env();
    faster_whisper_frontend_lib::run()
}
