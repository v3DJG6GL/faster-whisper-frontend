mod audio;
mod commands;
mod config;
mod inject;
mod session;
mod transport;
mod tray;
mod triggers;
mod wayland_inject;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "faster_whisper_frontend_lib=info,info".into()),
        )
        .init();

    tauri::Builder::default()
        // single-instance MUST be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            triggers::handle_cli_args(app, &argv);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(triggers::handle_shortcut)
                .build(),
        )
        .manage(audio::AudioState::default())
        .manage(session::StreamState::default())
        .manage(session::RecordState::default())
        .manage(triggers::ShortcutRegistry::default())
        .manage(wayland_inject::WaylandTokenState::default())
        .setup(|app| {
            use tauri::Manager;
            tray::create(app)?;
            if let Ok(dir) = app.path().app_config_dir() {
                let cfg = config::load(&dir);
                triggers::register_from_config(app.handle(), &cfg.modes);
            }
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
            commands::start_record,
            commands::stop_record,
            commands::reregister_shortcuts,
            commands::validate_shortcut,
            commands::inject_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
