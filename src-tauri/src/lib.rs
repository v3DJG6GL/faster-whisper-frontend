mod atspi_guard;
mod audio;
mod commands;
mod config;
mod evdev_hotkeys;
mod held_keys;
mod inject;
#[cfg(target_os = "linux")]
mod kwin;
mod overlay;
mod quickadd;
mod session;
mod sound;
mod transport;
mod tray;
mod triggers;
mod virtual_keyboard;
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
        .manage(audio::MicTestClip::default())
        .manage(audio::MicPlayback::default())
        .manage(session::StreamState::default())
        .manage(session::RecordState::default())
        .manage(triggers::ShortcutRegistry::default())
        .manage(wayland_inject::WaylandTyper::default())
        .manage(commands::ClipboardSnapshot::default())
        .manage(evdev_hotkeys::EvdevState::default())
        .manage(held_keys::HeldKeys::default())
        .manage(virtual_keyboard::VirtualKeyboard::default())
        .manage(atspi_guard::AtspiGuard::default())
        // Close-to-tray for the MAIN window. Its webview hosts the dictation state machine and the
        // trigger/chip action listeners; destroying it mid-session would leave the Rust audio
        // stream running with NOTHING able to stop it (both the global shortcut and the chip route
        // their stop/cancel through this webview), stranding the dictation until a force-quit. So
        // we intercept the close, keep the window (and its listeners) alive, and just hide it —
        // reachable again via the tray "Show window"; truly quit via the tray "Quit". Other windows
        // (the overlay chip) are left to close normally.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // main: keep the dictation state machine + listeners alive (see above).
                // quickadd: keep it prewarmed so the next summon is instant.
                if matches!(window.label(), "main" | "quickadd") {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // An OS/WM close (Alt+F4 / compositor close) of quick-add bypasses the in-app
                // Esc/X path, so its debounced-save flush + correct-on-close word replacement would
                // never run. Nudge the webview to run the same closeNow Esc/X do (its own hide is
                // then a no-op since we already hid above).
                if window.label() == "quickadd" {
                    use tauri::Emitter;
                    let _ = window.emit("quickadd://closing", ());
                }
            }
        })
        .setup(|app| {
            use tauri::Manager;
            tray::create(app)?;
            let cfg = app
                .path()
                .app_config_dir()
                .map(|dir| config::load(&dir))
                .unwrap_or_default();
            commands::apply_bindings(app.handle());
            // Warm the AT-SPI focus listener now so the focused-app cache is populated by
            // the time the user dictates (per-app rules + the chip target readout), and
            // apply the saved "deep field detection" preference.
            {
                let guard = app.state::<atspi_guard::AtspiGuard>();
                atspi_guard::start(&guard);
                atspi_guard::set_deep(&guard, cfg.settings.general.deep_field_detection);
            }
            // Recover hotkeys + any in-flight dictation after the machine wakes from
            // suspend (a dropped key-release / dead WebSocket would otherwise wedge us).
            commands::spawn_suspend_watch(app.handle().clone());
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
            commands::set_backend_key,
            commands::delete_backend_key,
            commands::app_version,
            commands::test_connection,
            commands::transcribe_file,
            commands::list_override_profiles,
            commands::get_capabilities, // P11: GET /v1/me capabilities
            commands::get_override_profile, // P11: GET /v1/override-profiles/{name}
            commands::get_pipeline_rules, // P17: GET /v1/pipeline-rules
            commands::save_pipeline_rules, // P17: PATCH /v1/pipeline-rules
            commands::get_recent_words,   // P18: GET /v1/recent-words (key suggestions)
            commands::get_usage_stats,    // P28: GET /v1/usage (per-user stats + trend)
            commands::list_audio_devices,
            commands::start_mic_test,
            commands::stop_mic_test,
            commands::play_mic_test,
            commands::stop_mic_test_playback,
            commands::start_stream,
            commands::stop_stream,
            commands::cancel_stream,
            commands::start_record,
            commands::stop_record,
            commands::cancel_record,
            commands::recordings_dir_path, // saved-recordings folder (display path)
            commands::open_recordings_dir, // open the saved-recordings folder
            commands::reregister_shortcuts,
            commands::reregister_shortcuts_unless_capturing,
            commands::suspend_shortcuts,
            commands::validate_codes,
            commands::evdev_status,
            commands::evdev_setup,
            commands::inject_text,
            commands::begin_injection,
            commands::end_injection,
            commands::restore_clipboard_snapshot,
            commands::discard_injection_snapshot,
            commands::get_focused_app,
            commands::get_focused_other_app,
            commands::set_deep_field_detection,
            commands::get_quickadd_seed,
            commands::get_focused_selection,
            overlay::show_overlay,
            overlay::hide_overlay,
            overlay::set_chip_hit_region,
            quickadd::show_quick_add,
            quickadd::hide_quick_add,
            sound::play_cue,
            tray::set_tray_state,
            tray::show_main_at_screen,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Restore the system-audio mute guard (and tear down any live dictation) on every
            // in-process exit, not just the tray "Quit". `app.exit()` / window-close exits skip
            // managed-state destructors, which would otherwise strand the system muted. Idempotent
            // with the tray's explicit cleanup (the session is taken once, then a no-op).
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                crate::session::cleanup_for_exit(app);
            }
        });
}
