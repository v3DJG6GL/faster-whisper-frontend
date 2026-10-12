//! Config load/save, the secret-store keys and the side effects a save applies
//! (recordings retention, autostart).

use super::{audio_base_pref, config_dir, resolve_recordings_dir};
use crate::config::{self, Config};
use tauri::AppHandle;

/// Frontend-facing config load: the config plus whether Rust had to RECOVER it (backed up a
/// present-but-unreadable/corrupt file to .json.bak and returned defaults), so the frontend can warn
/// the user their settings were reset instead of the armed auto-save silently persisting the wipe.
/// `backup_failed`: the reset happened but no `.json.bak` could be made — saving is refused this
/// session, so the frontend must not promise a backup.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConfig {
    pub config: Config,
    pub recovered: bool,
    pub backup_failed: bool,
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> LoadedConfig {
    match config_dir(&app) {
        Ok(dir) => {
            let (config, recovered) = config::load_outcome(&dir);
            LoadedConfig {
                config,
                recovered,
                backup_failed: config::backup_failed(),
            }
        }
        // No config dir at all (can't happen in practice) — clean defaults, nothing was backed up.
        Err(_) => LoadedConfig {
            config: Config::default(),
            recovered: false,
            backup_failed: false,
        },
    }
}

/// Apply the in-memory process switches that mirror the webview's live settings (clipboard
/// privacy, Remote desktop rules, log level). Called by `save_config` before its write, and
/// directly by the webview when it holds a save back (the shortcut-conflict freeze), so these
/// switches follow the webview on every save, written or not.
#[tauri::command]
pub fn apply_live_switches(
    app_rules: Vec<serde_json::Value>,
    exclude_from_clipboard_history: bool,
    log_level: crate::config::LogLevel,
) {
    set_live_switches(&app_rules, exclude_from_clipboard_history, log_level);
}

/// The live switches themselves — also applied once at startup (lib.rs setup), so a switch added
/// here is never skipped at launch.
pub(crate) fn set_live_switches(
    app_rules: &[serde_json::Value],
    exclude_from_clipboard_history: bool,
    log_level: crate::config::LogLevel,
) {
    // Clipboard privacy is a process-wide switch every transcript write reads (see inject/mod.rs), so
    // it is applied here rather than carried on each insert.
    crate::inject::set_clipboard_privacy(exclude_from_clipboard_history);
    // The per-app "Remote desktop" overrides the Quick-Add grab and the push-to-talk liveness gate
    // read (the paste path gets them with each insert).
    crate::inject::rdp_client::set_rules(app_rules);
    // The capture level is an in-memory filter reload (no folder move or prune — those stay on a
    // written save, in apply_log_settings), so a held or refused save still records at the level
    // Settings shows.
    crate::logging::apply_log_level(log_level);
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let dir = config_dir(&app)?;
    // The in-memory process switches (clipboard privacy, Remote desktop rules, log level) mirror
    // the webview's live settings (the paste path already acts on them unsaved), not the disk,
    // so they apply BEFORE the write — and the webview applies them itself on a save it holds
    // back (shortcut conflict): on every held or refused save (BACKUP_FAILED session,
    // full/read-only disk) push-to-talk, Quick-Add and clipboard writes still follow the paste
    // path, and the log records at the level Settings shows, instead of lagging until restart. The
    // Quick-Add window's own paste reads the rules from disk, so after a held or refused save its
    // grab (here) and its paste can disagree until the next good save — the lesser split: before,
    // the main window's paste and push-to-talk disagreed instead.
    set_live_switches(
        &config.app_rules,
        config.settings.general.exclude_from_clipboard_history,
        config.settings.logging.log_level,
    );
    // A save over a reset (this session, or one nobody has saved over yet) carries the defaults'
    // retention windows, not the backed-up settings' — its sweeps must not delete that history.
    let reset = config::retention_held(&dir);
    config::save(&dir, &config).map_err(|e| e.to_string())?;
    sync_autostart(&app, config.settings.general.open_at_login);
    // The retention sweeps are O(history) filesystem work; a sync command runs on the main
    // thread, so they go to a background thread. The mutex serializes them, so two quick saves
    // never prune or wipe at the same time, and the generation check drops a superseded save's
    // sweep (the mutex is not FIFO, so an older, shorter window could otherwise run last).
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    if reset {
        // The hold is sticky for the session and every debounced autosave lands here, so the line
        // is logged once per session (like the log-prune hold in logging.rs), not once per save.
        static LOGGED_SWEEP_HOLD: AtomicBool = AtomicBool::new(false);
        if !LOGGED_SWEEP_HOLD.swap(true, Ordering::SeqCst) {
            tracing::info!("[config] settings were reset; post-save retention sweeps skipped");
        }
    } else {
        static SWEEP_GEN: AtomicU64 = AtomicU64::new(0);
        let my_gen = SWEEP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        let config = config.clone();
        std::thread::spawn(move || {
            static SWEEP: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _g = SWEEP.lock().unwrap_or_else(|e| e.into_inner());
            if SWEEP_GEN.load(Ordering::SeqCst) != my_gen {
                return;
            }
            // History first: its records are local and its swept event lets the History mirror
            // reload before either sweep walks a (possibly slow) audio base. Order-free otherwise.
            crate::store::transcripts::apply_transcripts_retention(&app, &config);
            apply_recordings_retention(&app, &config);
        });
    }
    // Session-file move / prune (written saves only; the level went with the live switches
    // above) — so Settings changes apply live, not at the next restart. Off the main thread too:
    // a custom log folder can sit on a stalled mount (network share, sleeping disk), and every
    // autosave would otherwise freeze the app on its create_dir/read_dir. One worker at a time
    // drains a single newest-wins slot: saves made while it is stuck on a dead share replace the
    // pending one instead of parking a thread each, and the newest is applied as soon as the
    // stuck call returns (a skipped older one is harmless: the newest compares its folder
    // against the live file again). Its own worker, so a slow audio sweep does not hold up the
    // log move.
    static LOG_NEXT: std::sync::Mutex<(Option<(Config, bool)>, bool)> =
        std::sync::Mutex::new((None, false));
    let spawn = {
        let mut slot = LOG_NEXT.lock().unwrap_or_else(|e| e.into_inner());
        slot.0 = Some((config, reset));
        !std::mem::replace(&mut slot.1, true)
    };
    if spawn {
        std::thread::spawn(move || loop {
            let (config, held) = {
                let mut slot = LOG_NEXT.lock().unwrap_or_else(|e| e.into_inner());
                match slot.0.take() {
                    Some(next) => next,
                    None => {
                        slot.1 = false;
                        return;
                    }
                }
            };
            // A panic must not leave the slot marked as drained by a worker that is gone.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::logging::apply_log_settings(&app, &config, held)
            }));
        });
    }
    Ok(())
}

/// Enforce the dictation clock on saved recordings. Called on startup (synchronously) and after
/// every config save, so shortening the window takes effect immediately rather than at the next
/// restart. The post-save sweep runs off the main thread, serialized by a mutex in `save_config`.
///
/// The window is `effective_dictation_days` — the same value Settings' "Delete dictations
/// after" row shows and the record sweep (store/transcripts.rs) uses, so a dictation's text and
/// audio leave together. The sweep runs whenever that row is live (saving recordings OR keeping
/// dictation history); with both off the row is disabled, and nothing is deleted by a control
/// the user can no longer see.
pub fn apply_recordings_retention(app: &AppHandle, config: &Config) {
    let s = &config.settings;
    let days = s.effective_dictation_days();
    if days == 0 || !(s.recording.save_recordings || s.keep_dictation_history()) {
        return;
    }
    if let Some(dir) = resolve_recordings_dir(app, audio_base_pref(s)) {
        crate::audio::prune_recordings(&dir, days);
    }
}

/// Keep the OS "launch at login" entry in sync with the saved preference. Called
/// on startup and whenever the config is saved.
///
/// A refused write (read-only `~/.config/autostart`, a Run-key write blocked by policy) is
/// logged, once per distinct (preference, error) so the debounced autosave cannot flood the
/// ring; the save itself still succeeds, since the config was written.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    static LAST_AUTOSTART_ERR: std::sync::Mutex<Option<(bool, String)>> =
        std::sync::Mutex::new(None);
    let mgr = app.autolaunch();
    let result = if enabled {
        mgr.enable()
    } else {
        // On Windows `disable` fails when there is no Run value to delete — the default "off"
        // state. Not a failure when no entry is left in effect.
        mgr.disable().or_else(|e| {
            if matches!(mgr.is_enabled(), Ok(false)) {
                Ok(())
            } else {
                Err(e)
            }
        })
    };
    let Ok(mut last) = LAST_AUTOSTART_ERR.lock() else {
        return;
    };
    match result {
        Ok(()) => *last = None,
        Err(e) => {
            let key = (enabled, e.to_string());
            if last.as_ref() != Some(&key) {
                tracing::warn!(
                    "[autostart] could not {} launch at login: {}",
                    if enabled { "enable" } else { "disable" },
                    key.1
                );
                *last = Some(key);
            }
        }
    }
}

/// Serializes keyring mutations in the order the commands queue on it. tokio's Mutex is fair
/// (waiters are woken first-come, first-served), and each command takes it in its async body
/// BEFORE handing the write to the blocking pool, holding it until the write returns. So writes
/// run one at a time, in the order their command tasks reached `lock()`: a set parked behind the
/// wallet prompt can no longer land after a delete issued later (sync's clearSnapshotSecrets).
/// That order is the IPC order whenever the earlier call reached the lock first, which the
/// runtime does not strictly promise for two calls arriving in the same instant. Only the queued
/// writes wait; the UI thread never does.
static KEYRING_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// Keyring writes can park behind a locked-wallet prompt; off the main thread so the app does
// not freeze meanwhile (same reason as `read_backend_keys`).
#[tauri::command]
pub async fn set_backend_key(backend_id: String, key: String) -> Result<(), String> {
    let _guard = KEYRING_WRITE_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        config::keys::set(&backend_id, &key).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_backend_key(backend_id: String) -> Result<(), String> {
    let _guard = KEYRING_WRITE_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        config::keys::delete(&backend_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
