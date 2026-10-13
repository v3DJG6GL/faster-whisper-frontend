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

/// Mid-session config read for the windows other than the main window's launch load (the
/// Quick-Add window, on every summon). Never recovers (see `config::try_load`): a settings file
/// that cannot be read for a moment (an antivirus or sync-client lock, a hand-edit typo) rejects
/// instead of being moved aside as broken and resetting the session.
#[tauri::command]
pub fn read_config(app: AppHandle) -> Result<Config, String> {
    let dir = config_dir(&app)?;
    config::try_load(&dir).ok_or_else(|| "the settings file could not be read".to_string())
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
    sync_autostart_if_changed(&app, config.settings.general.open_at_login);
    // The retention sweeps are O(history) filesystem work; a sync command runs on the main
    // thread, so they go to a background worker (`queue_retention_sweeps`).
    if reset {
        // The hold is sticky for the session and every debounced autosave lands here, so the line
        // is logged once per session (like the log-prune hold in logging.rs), not once per save.
        use std::sync::atomic::{AtomicBool, Ordering};
        static LOGGED_SWEEP_HOLD: AtomicBool = AtomicBool::new(false);
        if !LOGGED_SWEEP_HOLD.swap(true, Ordering::SeqCst) {
            tracing::info!("[config] settings were reset; post-save retention sweeps skipped");
        }
    } else {
        queue_retention_sweeps(&app, config.clone());
    }
    // Session-file move / prune (written saves only; the level went with the live switches
    // above) — so Settings changes apply live, not at the next restart. Queued off the main
    // thread like the launch open; see `queue_log_settings`.
    crate::logging::queue_log_settings(&app, config, reset);
    Ok(())
}

/// The launch and post-save retention sweeps, both `config`'s windows, on one newest-wins
/// worker (`drain_newest`): sweeps run one at a time, so the launch sweep and two quick saves
/// never prune or wipe at the same time, a superseded config's sweep is dropped (an older,
/// shorter window never runs last), and calls made while a sweep is stuck on a dead audio share
/// replace the pending one instead of parking a thread each.
/// Each run's record half (app data) runs at once and never waits for this launch's audio-layout
/// migration. Its audio-base half (orphaned media, recordings) must look in the moved folders, so
/// it waits for the migration, in slices: a newer config queued meanwhile supersedes it — that
/// half is dropped and the newer run (whose own record half then runs at once) does it, so a
/// stale config never sweeps after the user changed the settings during a long migration.
pub(crate) fn queue_retention_sweeps(app: &AppHandle, config: Config) {
    static SWEEP_NEXT: crate::NewestSlot<(AppHandle, Config)> =
        std::sync::Mutex::new((None, false));
    crate::drain_newest(&SWEEP_NEXT, (app.clone(), config), |(app, config)| {
        let superseded = || {
            SWEEP_NEXT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .0
                .is_some()
        };
        // History records first: they are local, and the swept event lets the History mirror
        // reload before the audio-base sweeps walk a (possibly slow) share.
        crate::store::transcripts::apply_transcripts_retention(&app, &config);
        while !super::wait_audio_layout_for(std::time::Duration::from_millis(250)) {
            if superseded() {
                return;
            }
        }
        if superseded() {
            return;
        }
        crate::store::transcripts::apply_transcripts_media_retention(&app, &config);
        if superseded() {
            return;
        }
        apply_recordings_retention(&app, &config);
    });
}

/// Enforce the dictation clock on saved recordings. Queued at startup and after every config
/// save (`queue_retention_sweeps`), so shortening the window takes effect immediately rather
/// than at the next restart.
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

/// Keep the OS "launch at login" entry in sync with the saved preference. Called on startup
/// (always, so the entry's args are refreshed once per launch) and on a save that changes the
/// preference (`sync_autostart_if_changed`).
///
/// A refused write (read-only `~/.config/autostart`, a Run-key write blocked by policy) is
/// logged, once per distinct (preference, error) so the debounced autosave cannot flood the
/// ring; the save itself still succeeds, since the config was written.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    static LAST_AUTOSTART_ERR: std::sync::Mutex<Option<(bool, String)>> =
        std::sync::Mutex::new(None);
    // Cleared first, so a sync that bails out below is never remembered as done.
    *LAST_SYNCED.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
        Ok(()) => {
            *last = None;
            *LAST_SYNCED.lock().unwrap_or_else(|e| e.into_inner()) = Some(enabled);
        }
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

/// The preference the OS entry was last written for, `None` after a refused write — so a save
/// that leaves it unchanged skips the OS work (a non-atomic `.desktop` rewrite on Linux, registry
/// calls on Windows), while a refused one retries on the next save.
static LAST_SYNCED: std::sync::Mutex<Option<bool>> = std::sync::Mutex::new(None);

/// `sync_autostart`, unless the entry was already written for `enabled` this session.
fn sync_autostart_if_changed(app: &AppHandle, enabled: bool) {
    if *LAST_SYNCED.lock().unwrap_or_else(|e| e.into_inner()) == Some(enabled) {
        return;
    }
    sync_autostart(app, enabled);
}

/// Serializes keyring mutations in the order the commands queue on it. tokio's Mutex is fair
/// (waiters are woken first-come, first-served), and each command takes it in its async body
/// BEFORE handing the write to the blocking pool, holding it until the write returns. So writes
/// run one at a time, in the order their command tasks reached `lock()`: a set parked behind the
/// wallet prompt can no longer land after a delete issued later (sync's clearSnapshotSecrets).
/// That order is the IPC order whenever the earlier call reached the lock first, which the
/// runtime does not promise (each invoke's args are deserialised in its own task first), so
/// api.ts sends these one at a time (its keyring turn). Only the queued writes wait; the UI
/// thread never does.
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
