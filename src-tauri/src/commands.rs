//! Tauri commands exposed to the web UI (config load/save + secret-store keys).

use crate::audio::{self, AudioDevice, AudioState};
use crate::config::{self, Config};
use crate::session::{self, RecordParams, RecordState, StartParams, StreamState};
use crate::transport;
use crate::wayland_inject::WaylandTyper;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Folder where saved dictation `.wav` files go (when "Keep recordings" is on).
fn recordings_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("recordings"))
}

/// Resolve an API key: an explicit (just-typed) key wins; otherwise look it up in
/// the OS keyring by Backend id.
fn resolve_key(explicit: Option<String>, backend_id: Option<String>) -> Option<String> {
    if let Some(k) = explicit {
        if !k.is_empty() {
            return Some(k);
        }
    }
    backend_id.and_then(|id| config::keys::get(&id))
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Config {
    match config_dir(&app) {
        Ok(dir) => config::load(&dir),
        Err(_) => Config::default(),
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let dir = config_dir(&app)?;
    config::save(&dir, &config).map_err(|e| e.to_string())?;
    sync_autostart(&app, config.settings.general.open_at_login);
    Ok(())
}

/// Keep the OS "launch at login" entry in sync with the saved preference. Called
/// on startup and whenever the config is saved.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}

#[tauri::command]
pub fn set_backend_key(backend_id: String, key: String) -> Result<(), String> {
    config::keys::set(&backend_id, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_backend_key(backend_id: String) -> Result<(), String> {
    config::keys::delete(&backend_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn test_connection(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::ConnectionInfo {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::test_connection(&server_url, key.as_deref()).await
}

#[tauri::command]
pub async fn transcribe_file(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    prompt: String,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    file_path: String,
) -> Result<transport::batch::BatchResult, String> {
    let key = resolve_key(api_key, backend_id);
    transport::batch::transcribe(
        &server_url,
        key.as_deref(),
        &model,
        &language,
        &prompt,
        decode_overrides.as_ref(),
        override_profile.as_deref(),
        &file_path,
    )
    .await
    .map_err(|e| e.to_string())
}

/// List the server's selectable override-profile names (for the per-Backend /
/// per-Profile picker). Best-effort — returns [] on any error.
#[tauri::command]
pub async fn list_override_profiles(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> Vec<String> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::list_override_profiles(&server_url, key.as_deref()).await
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDevice> {
    audio::device::list_input_devices()
}

#[tauri::command]
pub fn start_mic_test(
    app: AppHandle,
    state: State<AudioState>,
    device_id: Option<String>,
) -> Result<(), String> {
    let handle = audio::capture::start_level_meter(app, device_id)?;
    // Replacing the Option drops (and stops) any previous capture.
    *state.0.lock().map_err(|_| "audio state poisoned")? = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_mic_test(state: State<AudioState>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "audio state poisoned")? = None;
    Ok(())
}

#[tauri::command]
pub fn start_stream(
    app: AppHandle,
    state: State<StreamState>,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    response_format: String,
    prompt: String,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    mute_system: bool,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    let save_dir = if save { recordings_dir(&app) } else { None };
    let mut guard = state.0.lock().map_err(|_| "stream state poisoned")?;
    *guard = None; // stop any previous session first (Drop joins capture, drains WS)
    let sess = session::start(
        app,
        StartParams {
            server_url,
            api_key: key,
            model,
            language,
            response_format,
            prompt,
            decode_overrides,
            override_profile,
            device_id,
            save_dir,
            mute_system,
        },
    )?;
    *guard = Some(sess);
    Ok(())
}

#[tauri::command]
pub fn stop_stream(state: State<StreamState>) -> Result<(), String> {
    let sess = state.0.lock().map_err(|_| "stream state poisoned")?.take();
    if let Some(s) = sess {
        s.finish(); // drain in the background to deliver the last utterance
    }
    Ok(())
}

#[tauri::command]
pub fn start_record(
    app: AppHandle,
    state: State<RecordState>,
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    model: String,
    language: String,
    prompt: String,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    mute_system: bool,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    let save_dir = if save { recordings_dir(&app) } else { None };
    let mut guard = state.0.lock().map_err(|_| "record state poisoned")?;
    *guard = None;
    let sess = session::start_record(
        app,
        RecordParams {
            server_url,
            api_key: key,
            model,
            language,
            prompt,
            decode_overrides,
            override_profile,
            device_id,
            save_dir,
            mute_system,
        },
    )?;
    *guard = Some(sess);
    Ok(())
}

#[tauri::command]
pub fn stop_record(state: State<RecordState>) -> Result<(), String> {
    let sess = state.0.lock().map_err(|_| "record state poisoned")?.take();
    if let Some(s) = sess {
        s.finish();
    }
    Ok(())
}

/// Suspend ALL hotkey backends (while the user captures a new binding) so pressing
/// an existing profile's chord only rebinds — it must not also fire dictation. This
/// silences both the global-shortcut plugin AND the evdev reader (which otherwise
/// keeps firing from /dev/input). Pair with `reregister_shortcuts` (apply_bindings)
/// to restore whichever backend is active when capture ends.
#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) {
    crate::triggers::unregister_all(&app);
    let state = app.state::<crate::evdev_hotkeys::EvdevState>();
    crate::evdev_hotkeys::stop(&state);
}

/// Apply the current bindings to the right backend: when the evdev backend is
/// enabled AND permitted it owns the Profiles' chords and the global-shortcut
/// plugin is silenced (mutual exclusion); otherwise the plugin registers and evdev stops.
pub fn apply_bindings(app: &AppHandle) {
    let Ok(dir) = config_dir(app) else { return };
    let cfg = config::load(&dir);
    let state = app.state::<crate::evdev_hotkeys::EvdevState>();
    if cfg.settings.general.evdev_enabled && crate::evdev_hotkeys::permitted() {
        crate::triggers::unregister_all(app);
        crate::evdev_hotkeys::start(app, &state, &cfg.profiles);
        tracing::info!("[bindings] evdev backend active (plugin silenced)");
    } else {
        crate::evdev_hotkeys::stop(&state);
        crate::triggers::register_from_config(app, &cfg.profiles);
    }
}

/// Re-read config and re-apply bindings (call after hotkeys / evdev toggle change).
#[tauri::command]
pub fn reregister_shortcuts(app: AppHandle) -> Result<(), String> {
    apply_bindings(&app);
    Ok(())
}

/// Detect a system suspend/resume by watching the wall clock for a large gap: a
/// dedicated thread ticks every couple of seconds; if far more time elapsed between
/// ticks than it slept, the machine was asleep in between. Suspend is hostile to both
/// long-lived listeners — it can drop the key-release that ends a hold-to-talk chord
/// (leaving the evdev backend stuck "down"), or re-enumerate the keyboards (killing
/// the reader tasks), and it silently kills the dictation WebSocket. On resume we
/// rebuild the hotkey backend (fresh held-state, freshly enumerated devices) and tell
/// the UI to drop any in-flight session so the chip can't hang at "finalizing…".
pub fn spawn_suspend_watch(app: AppHandle) {
    use std::time::{Duration, SystemTime};
    // Wall clock, NOT Instant: CLOCK_MONOTONIC pauses across suspend on Linux, so it
    // would never show the gap. SystemTime keeps advancing while the machine sleeps.
    const TICK: Duration = Duration::from_secs(2);
    // A gap this far beyond TICK means a real sleep, not scheduler jitter / NTP step.
    const GAP: Duration = Duration::from_secs(8);
    let _ = std::thread::Builder::new()
        .name("suspend-watch".into())
        .spawn(move || {
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(TICK);
                let now = SystemTime::now();
                let elapsed = now.duration_since(last).unwrap_or(Duration::ZERO);
                last = now;
                if elapsed > GAP {
                    tracing::info!(
                        "[suspend] resume detected (~{}s gap); rebuilding hotkeys + clearing dictation",
                        elapsed.as_secs()
                    );
                    apply_bindings(&app);
                    let _ = app.emit("system://resumed", ());
                }
            }
        });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvdevStatus {
    /// evdev is a Linux-only backend.
    available: bool,
    /// We can actually open a keyboard (i.e. the user is in the `input` group).
    permitted: bool,
    /// The user has turned the backend on in config.
    enabled: bool,
}

/// Status for the Permissions UI: is evdev available / permitted / enabled?
#[tauri::command]
pub fn evdev_status(app: AppHandle) -> EvdevStatus {
    let enabled = config_dir(&app)
        .map(|d| config::load(&d).settings.general.evdev_enabled)
        .unwrap_or(false);
    EvdevStatus {
        available: cfg!(target_os = "linux"),
        permitted: crate::evdev_hotkeys::permitted(),
        enabled,
    }
}

/// Add the user to the `input` group via `pkexec` (polkit GUI auth). The user must
/// log out and back in for it to take effect.
#[tauri::command]
pub async fn evdev_setup() -> Result<String, String> {
    crate::evdev_hotkeys::setup().await
}

/// Whether an accelerator string can be registered as a global shortcut.
#[tauri::command]
pub fn validate_shortcut(accelerator: String) -> bool {
    use std::str::FromStr;
    tauri_plugin_global_shortcut::Shortcut::from_str(&accelerator).is_ok()
}

/// Whether a code-list chord can be registered via the global-shortcut plugin.
/// Modifier-only / AltGr chords return false — those need the evdev backend.
#[tauri::command]
pub fn validate_codes(codes: Vec<String>) -> bool {
    use std::str::FromStr;
    crate::config::codes_to_accelerator(&codes)
        .map(|a| tauri_plugin_global_shortcut::Shortcut::from_str(&a).is_ok())
        .unwrap_or(false)
}

/// Snapshot of the clipboard taken before a live (per-segment) paste dictation, so
/// the user's original clipboard is restored once at the end rather than after
/// every segment (which would race + churn the clipboard manager).
#[derive(Default)]
pub struct ClipboardSnapshot(pub std::sync::Mutex<Option<String>>);

/// Snapshot the current clipboard before a live paste-injection session.
#[tauri::command]
pub fn begin_injection(snap: State<ClipboardSnapshot>) {
    let text = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok());
    if let Ok(mut g) = snap.0.lock() {
        *g = Some(text.unwrap_or_default());
    }
}

/// Restore the clipboard snapshot taken by `begin_injection` (end of a live session).
#[tauri::command]
pub fn end_injection(snap: State<ClipboardSnapshot>) {
    let prev = snap.0.lock().ok().and_then(|mut g| g.take());
    if let Some(prev) = prev {
        if let Ok(mut c) = arboard::Clipboard::new() {
            let _ = c.set_text(prev);
        }
    }
}

/// Insert text into the focused field of the active app (paste or direct typing).
/// Direct typing on Wayland routes through the RemoteDesktop portal; everything
/// else uses enigo (clipboard paste, or direct on X11/Windows).
#[tauri::command]
pub async fn inject_text(
    app: AppHandle,
    typer: State<'_, WaylandTyper>,
    text: String,
    method: String,
    auto_enter: bool,
    restore_clipboard: bool,
) -> Result<(), String> {
    tracing::info!("[inject] {} chars via {} (auto_enter={})", text.len(), method, auto_enter);
    let res = if crate::inject::is_wayland() {
        if method == "direct" {
            crate::wayland_inject::type_text(&app, typer.inner(), &text, auto_enter).await
        } else {
            // Paste on Wayland: set the clipboard here, then synthesize Ctrl+V via
            // the portal. enigo's XTEST Ctrl+V is unreliable on KDE Wayland — a
            // synthesized modifier + remapped keycode makes apps fire the wrong
            // shortcut (e.g. opening editor tabs) instead of pasting.
            let clip = text.clone();
            let prev = tokio::task::spawn_blocking(move || {
                crate::inject::set_clipboard(&clip, restore_clipboard)
            })
            .await
            .map_err(|e| e.to_string())??;
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            let r = crate::wayland_inject::paste(&app, typer.inner(), auto_enter).await;
            crate::inject::restore_clipboard_later(prev);
            r
        }
    } else {
        tokio::task::spawn_blocking(move || {
            crate::inject::inject(&text, &method, auto_enter, restore_clipboard)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    res
}
