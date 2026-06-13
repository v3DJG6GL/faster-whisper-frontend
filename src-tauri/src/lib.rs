mod audio;
mod commands;
mod config;
mod inject;
mod overlay;
mod session;
mod sound;
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(audio::AudioState::default())
        .manage(session::StreamState::default())
        .manage(session::RecordState::default())
        .manage(triggers::ShortcutRegistry::default())
        .manage(wayland_inject::WaylandTokenState::default())
        .manage(commands::ClipboardSnapshot::default())
        .setup(|app| {
            use tauri::Manager;
            tray::create(app)?;
            let cfg = app
                .path()
                .app_config_dir()
                .map(|dir| config::load(&dir))
                .unwrap_or_default();
            triggers::register_from_config(app.handle(), &cfg.modes);
            // Keep the OS autostart entry in sync with the saved preference.
            commands::sync_autostart(app.handle(), cfg.settings.general.open_at_login);
            // Start hidden to the tray if requested (reachable via the tray menu).
            if cfg.settings.general.start_minimized {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
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
            commands::begin_injection,
            commands::end_injection,
            overlay::show_overlay,
            overlay::hide_overlay,
            sound::play_cue,
            tray::set_tray_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
