mod audio;
mod commands;
mod config;
mod session;
mod transport;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "faster_whisper_frontend_lib=info,info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(audio::AudioState::default())
        .manage(session::StreamState::default())
        .setup(|app| {
            tray::create(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_config,
            commands::save_config,
            commands::set_profile_key,
            commands::delete_profile_key,
            commands::app_version,
            commands::test_connection,
            commands::transcribe_file,
            commands::list_audio_devices,
            commands::start_mic_test,
            commands::stop_mic_test,
            commands::start_stream,
            commands::stop_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
