mod atspi_guard;
mod audio;
mod chord_engine;
mod commands;
mod config;
mod evdev_hotkeys;
mod held_keys;
mod inject;
mod key_debounce;
#[cfg(target_os = "linux")]
mod kwin;
mod logging;
mod media_decode;
mod overlay;
mod langpick;
mod quickadd;
mod session;
mod sound;
mod transcripts;
mod transport;
mod tray;
mod triggers;
mod virtual_keyboard;
mod wayland_inject;
mod win_hotkeys;
mod winpos;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ring + file writer exist BEFORE the subscriber so no startup line is
    // lost; the session file itself opens in .setup() (once paths/config are
    // known) with the ring replayed into it. See logging.rs.
    let log_ring = logging::LogRing::default();
    let log_writer = logging::SwapWriter::default();
    logging::init(log_ring.clone(), log_writer.clone());
    tracing::info!("faster-whisper-frontend v{}", env!("CARGO_PKG_VERSION"));

    // reqwest 0.13's `rustls-no-provider` ships no TLS crypto provider; install
    // ring as the process-wide default (the same provider tokio-tungstenite's
    // rustls already uses) so HTTPS never depends on which crate features happen
    // to be enabled elsewhere in the tree. Err = already installed, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();

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
        // The --autostart flag marks login launches so "start minimized to tray"
        // applies only to them, not to manual starts (sync_autostart rewrites the
        // OS entry on every startup, so existing installs pick the flag up).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
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
        .manage(win_hotkeys::WinHookState::default())
        .manage(held_keys::HeldKeys::default())
        .manage(virtual_keyboard::VirtualKeyboard::default())
        .manage(atspi_guard::AtspiGuard::default())
        .manage(quickadd::SeedRendezvous::default())
        .manage(log_ring)
        .manage(log_writer)
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
                if matches!(window.label(), "main" | "quickadd" | "langpick") {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // An OS/WM close (Alt+F4 / compositor close) of quick-add bypasses the in-app
                // Esc/X path, so its debounced-save flush + correct-on-close word replacement would
                // never run. Nudge the webview to run the same closeNow Esc/X do (its own hide is
                // then a no-op since we already hid above).
                if window.label() == "quickadd" {
                    use tauri::{Emitter, Manager};
                    window
                        .app_handle()
                        .state::<crate::quickadd::SeedRendezvous>()
                        .clear();
                    let _ = window.emit("quickadd://closing", ());
                }
                // Same for the language picker: its asker in the main webview awaits
                // `langpick://commit`, `langpick://abort` or `langpick://unavailable` and nothing
                // else settles it. An Alt+F4 that only hid the window left that promise pending
                // for the rest of the process — hands-free latched its "picker open" gate and
                // refused every later dictation; push-to-talk stalled the inject queue and never
                // inserted the text. A closed window means the same as Esc: abort the action
                // (don't start / don't insert), not "quietly use the Profile's preset".
                if window.label() == "langpick" {
                    use tauri::{Emitter, Manager};
                    let _ = window.app_handle().emit("langpick://abort", ());
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
            // Apply the saved log level, open this session's log file (ring
            // replayed in, so it's complete from launch), prune old ones, and
            // start the batched log stream for the Logs screen.
            logging::apply_log_settings(app.handle(), &cfg);
            logging::spawn_emit_pump(app.handle().clone());
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
            // KDE-Wayland: write the chip's KWin placement rule now, ahead of the first
            // show — a first-ever run otherwise maps the chip centred (unruled) and it
            // jumps to its edge only once the rule lands.
            #[cfg(target_os = "linux")]
            overlay::prewarm_chip_rule(&cfg);
            // Consolidate all stored audio under the single base folder
            // (dictations/, files/, links/) — idempotent, runs before the
            // sweeps so they look in the right place.
            commands::ensure_audio_layout(app.handle(), &cfg);
            // Enforce the saved-recording retention window once per launch, so it also applies
            // to a machine that dictated for months and only just enabled it.
            commands::apply_recordings_retention(app.handle(), &cfg);
            // Same once-per-launch sweep for the transcription history.
            transcripts::apply_transcripts_retention(app.handle(), &cfg);
            // Start hidden to the tray if requested (reachable via the tray menu) —
            // but only on login launches (--autostart), never on a manual start.
            if cfg.settings.general.start_minimized
                && std::env::args_os().any(|a| a == "--autostart")
            {
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
            commands::preload_models,   // POST /v1/models/preload (best-effort warm hint)
            commands::get_override_profile, // P11: GET /v1/override-profiles/{name}
            commands::get_pipeline_rules, // P17: GET /v1/pipeline-rules
            commands::save_pipeline_rules, // P17: PATCH /v1/pipeline-rules
            commands::get_recent_words,   // P18: GET /v1/recent-words (key suggestions)
            commands::get_usage_stats,    // P28: GET /v1/usage (per-user usage document)
            commands::post_usage_outcomes, // POST /v1/usage/outcome (end-of-dictation facets)
            commands::load_usage_outcomes, // on-disk outcome queue (survives restarts)
            commands::save_usage_outcomes,
            commands::sync_pull,          // P30: GET /v1/client-settings
            commands::sync_push,          // P30: PUT /v1/client-settings
            commands::sync_delete,        // P30: DELETE /v1/client-settings
            commands::load_sync_state,    // P30: local sync bookkeeping
            commands::save_sync_state,
            commands::sync_device_info,
            commands::read_backend_keys,  // P30: bulk keyring read (export/sync)
            commands::export_settings_file, // P30: settings export to file
            commands::save_text_file,       // transcript exports (Transcribe screen)
            commands::read_text_file,       // subtitle/text sources for translate-only runs
            transcripts::save_transcript_record, // transcription history (local store)
            transcripts::list_transcript_records,
            transcripts::delete_transcript_record,
            transcripts::save_transcript_media,
            transcripts::transcript_store_stats,
            transcripts::delete_all_dictations,
            transcripts::clear_file_transcriptions,
            transcripts::remove_transcript_media,
            commands::read_media_file,      // playback blob fallback (Transcribe screen)
            commands::decode_media_file,    // playback codec fallback (webview can't do AAC)
            commands::open_source_url,      // "Open link" on a URL transcript

            commands::cancel_file_transcription, // abort in-flight Transcribe runs (client side)
            commands::cancel_backend_transcription, // …and tell the server to stop the work
            commands::get_transcribe_progress,   // live progress poll (Transcribe screen)
            commands::transcribe_url,
            commands::translate_text,       // T2T of segment texts (dictation / re-translate / text sources)
            commands::cancel_text_translation, // tell the server to stop an in-flight T2T run
            commands::url_preview,          // link metadata preview (Transcribe screen)
            commands::fetch_url_media,      // pull downloaded audio for local playback
            commands::import_settings_file, // P30: settings import (parse+validate)
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
            commands::retire_session_epoch,
            commands::audio_dir_path,      // audio base folder (display path)
            commands::open_audio_dir,      // open the audio base folder
            commands::move_audio_base,     // relocate the whole audio store
            commands::reregister_shortcuts,
            commands::reregister_shortcuts_unless_capturing,
            commands::suspend_shortcuts,
            commands::shortcut_mods_held,
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
            overlay::chip_pointer_over,
            langpick::show_lang_pick,
            langpick::commit_lang_pick,
            langpick::abort_lang_pick,
            quickadd::show_quick_add,
            quickadd::hide_quick_add,
            sound::play_cue,
            tray::set_tray_state,
            tray::show_main_at_screen,
            logging::get_log_tail,
            logging::set_log_stream,
            logging::get_log_status,
            logging::log_folder_path,
            logging::open_log_folder,
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
