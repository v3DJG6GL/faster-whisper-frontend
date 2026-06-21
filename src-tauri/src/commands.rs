//! Tauri commands exposed to the web UI (config load/save + secret-store keys).

use crate::audio::{self, AudioDevice, AudioState, MicPlayback, MicTestClip};
use crate::config::{self, Config};
use crate::session::{self, RecordParams, RecordState, StartParams, StreamState};
use crate::transport;
use crate::wayland_inject::WaylandTyper;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Folder where saved dictation `.wav` files go (when "Keep recordings" is on). A
/// non-empty `custom` (the user's chosen folder, from Settings) wins; otherwise the
/// default lives under the app data dir. None only if neither can be resolved.
fn resolve_recordings_dir(app: &AppHandle, custom: Option<String>) -> Option<PathBuf> {
    if let Some(c) = custom {
        let c = c.trim();
        if !c.is_empty() {
            return Some(PathBuf::from(c));
        }
    }
    app.path().app_data_dir().ok().map(|d| d.join("recordings"))
}

/// Absolute path of the active recordings folder (custom or default), for display in
/// Settings — a leading `$HOME` is collapsed to `~`. None if it can't be resolved.
#[tauri::command]
pub fn recordings_dir_path(app: AppHandle, custom: Option<String>) -> Option<String> {
    let dir = resolve_recordings_dir(&app, custom)?;
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Some(format!("~/{}", rest.display()));
        }
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Open the active recordings folder (custom or default) in the system file manager.
/// Creates it first so the button works before the first recording — or right after the
/// user picks a new, not-yet-used folder.
#[tauri::command]
pub fn open_recordings_dir(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir =
        resolve_recordings_dir(&app, custom).ok_or("could not resolve a recordings folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create the folder: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Write a dictation transcript next to its saved `.wav` as a sibling `.txt`. Called by the
/// frontend at session end (it owns the assembled transcript). Best-effort, never errors.
#[tauri::command]
pub fn write_recording_transcript(wav_path: String, text: String) {
    crate::audio::save_transcript_sidecar(std::path::Path::new(&wav_path), &text);
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
    // None (field omitted) = inherit the server DEFAULT_PROMPT; Some("") = explicit
    // clear (send no prompt); Some(v) = use v. See transport::batch::post.
    prompt: Option<String>,
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
        prompt.as_deref(),
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

/// The caller's effective request-override capabilities (`GET /v1/me`). Best-
/// effort — returns null on any error so the UI can treat it as "unknown".
#[tauri::command]
pub async fn get_capabilities(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> Option<transport::Capabilities> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::get_capabilities(&server_url, key.as_deref()).await
}

/// One override-profile's decode values + locked client keys, for previewing
/// inherited defaults when a profile is selected. Best-effort — null on error.
#[tauri::command]
pub async fn get_override_profile(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    name: String,
) -> Option<transport::ResolvedOverrideProfile> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::get_override_profile(&server_url, &name, key.as_deref()).await
}

/// P17: the post-processing (pipeline) rules the caller may view + edit
/// (`GET /v1/pipeline-rules`) — for the Dictionary screen. Structured result so
/// the UI can distinguish standard-server (404) / unauthorized (401) / no-access
/// (403) / parse errors from a real rule list.
#[tauri::command]
pub async fn get_pipeline_rules(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::pipeline::PipelineFetch {
    let key = resolve_key(api_key, backend_id);
    transport::pipeline::get_pipeline_rules(&server_url, key.as_deref()).await
}

/// P17: apply a per-rule patch (`PATCH /v1/pipeline-rules`). `patch` is the
/// `{rules_patch, fingerprints}` object the client builds from its edits.
/// Structured result carries saved / conflicts / requires_restart, plus 422
/// `errors` or a 400/403/500 `detail`.
#[tauri::command]
pub async fn save_pipeline_rules(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    patch: serde_json::Value,
) -> transport::pipeline::PipelineSave {
    let key = resolve_key(api_key, backend_id);
    transport::pipeline::save_pipeline_rules(&server_url, key.as_deref(), patch).await
}

/// P18: recently-transcribed word/phrase suggestions for the Dictionary's
/// spoken-symbol key field (`GET /v1/recent-words`). Best-effort — returns an
/// empty list on any failure (old/standard server, unreachable) so the editor
/// degrades to a plain input.
#[tauri::command]
pub async fn get_recent_words(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
) -> transport::pipeline::RecentWords {
    let key = resolve_key(api_key, backend_id);
    transport::pipeline::get_recent_words(&server_url, key.as_deref()).await
}

/// P28: the caller's own usage (`GET /v1/usage`) — today + lifetime totals +
/// a self-scoped trend series, for the Home stats section and the optional chip
/// readout. Best-effort — null on any error so the UI hides the feature on a
/// standard/old server or when unreachable. `tz_midnight` is the client's local
/// midnight (epoch seconds) for a viewer-local "today".
#[tauri::command]
pub async fn get_usage_stats(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    tz_midnight: Option<f64>,
    days: Option<i64>,
    bucket: Option<String>,
) -> Option<transport::UsageStats> {
    let key = resolve_key(api_key, backend_id);
    transport::discovery::get_usage_stats(
        &server_url,
        key.as_deref(),
        tz_midnight,
        days,
        bucket.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDevice> {
    audio::device::list_input_devices()
}

#[tauri::command]
pub fn start_mic_test(
    app: AppHandle,
    state: State<AudioState>,
    clip: State<MicTestClip>,
    playback: State<MicPlayback>,
    device_id: Option<String>,
) -> Result<(), String> {
    // Starting a fresh test silences any lingering replay (the bump makes the
    // playback thread see a newer generation and stop).
    playback.0.fetch_add(1, Ordering::SeqCst);
    let mut guard = state.0.lock().map_err(|_| "audio state poisoned")?;
    // Stop any previous capture FIRST — dropping the handle joins its thread, so its cpal
    // callback can't still be appending the old device's samples while the new capture clears +
    // re-stamps the shared clip (which would interleave two devices' audio under one rate stamp,
    // garbling the replay). Mirrors start_stream/start_record's stop-old-before-start-new order.
    *guard = None;
    let handle = audio::capture::start_level_meter(app, device_id, clip.0.clone())?;
    *guard = Some(handle);
    Ok(())
}

/// Stop the mic test and return the number of seconds captured (so the UI can
/// decide whether there's anything worth replaying). Dropping the handle joins the
/// capture thread, so the recorded clip is final by the time we read its length.
#[tauri::command]
pub fn stop_mic_test(state: State<AudioState>, clip: State<MicTestClip>) -> Result<f32, String> {
    *state.0.lock().map_err(|_| "audio state poisoned")? = None;
    let c = clip.0.lock().map_err(|_| "mic clip poisoned")?;
    let secs = if c.sample_rate > 0 {
        c.samples.len() as f32 / c.sample_rate as f32
    } else {
        0.0
    };
    Ok(secs)
}

/// Replay the most recent mic-test capture on the default output device. Returns
/// immediately; playback runs on a detached thread (like the sound cues). A no-op
/// when nothing has been recorded. Bumps the playback generation so any in-flight
/// replay stops before this one starts (never two at once), and emits
/// `audio://test-play-ended` when playback finishes while still current.
#[tauri::command]
pub fn play_mic_test(
    app: AppHandle,
    clip: State<MicTestClip>,
    playback: State<MicPlayback>,
) -> Result<(), String> {
    let (samples, sample_rate) = {
        let c = clip.0.lock().map_err(|_| "mic clip poisoned")?;
        // Collect the ring into a contiguous Vec for playback (one alloc, off the capture path).
        (c.samples.iter().copied().collect::<Vec<f32>>(), c.sample_rate)
    };
    if samples.is_empty() || sample_rate == 0 {
        return Ok(());
    }
    let counter = playback.0.clone();
    let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        'play: {
            // Keep `_stream` alive until playback finishes (dropping it cuts audio).
            let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
                break 'play; // no output device / audio server down — fall through to signal "ended"
            };
            let Ok(sink) = rodio::Sink::try_new(&handle) else {
                break 'play;
            };
            sink.append(rodio::buffer::SamplesBuffer::new(1, sample_rate, samples));
            // Play until it drains, but bail the instant a newer replay (or a new test)
            // superseded us — that newer playback owns the "ended" signal.
            while !sink.empty() {
                if counter.load(Ordering::SeqCst) != generation {
                    sink.stop();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
        // Finished draining, OR no output device was available — either way nothing of ours is
        // sounding now, so signal "ended" if we're still current. Without the failure path emitting
        // here, a device-acquire failure left the button stuck on "Stop" with no audio until the
        // frontend's duration fallback fired.
        if counter.load(Ordering::SeqCst) == generation {
            let _ = app.emit("audio://test-play-ended", ());
        }
    });
    Ok(())
}

/// Stop an in-flight mic-test replay (no-op if nothing is playing): bump the playback generation
/// so the playing thread sees it's superseded and stops. Does NOT start a new playback.
#[tauri::command]
pub fn stop_mic_test_playback(playback: State<MicPlayback>) {
    playback.0.fetch_add(1, Ordering::SeqCst);
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
    // None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    recordings_dir: Option<String>,
    trim_silence: bool,
    mute_system: bool,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    let save_dir = if save {
        resolve_recordings_dir(&app, recordings_dir)
    } else {
        None
    };
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
            trim_silence,
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
    // None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    prompt: Option<String>,
    decode_overrides: Option<serde_json::Value>,
    override_profile: Option<String>,
    device_id: Option<String>,
    save: bool,
    recordings_dir: Option<String>,
    trim_silence: bool,
    mute_system: bool,
) -> Result<(), String> {
    let key = resolve_key(api_key, backend_id);
    let save_dir = if save {
        resolve_recordings_dir(&app, recordings_dir)
    } else {
        None
    };
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
            trim_silence,
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
///
/// True while shortcuts are intentionally suspended for an in-progress binding capture
/// (suspend_shortcuts is only ever called by the capture hook). The suspend-watch resume
/// path reads this so an automatic resume re-arm can't override a deliberate capture
/// suspension; reregister_shortcuts (the capture-end pair) clears it.
static CAPTURE_SUSPENDED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) {
    CAPTURE_SUSPENDED.store(true, Ordering::SeqCst);
    crate::triggers::unregister_all(&app);
    let state = app.state::<crate::evdev_hotkeys::EvdevState>();
    crate::evdev_hotkeys::stop(&state);
    // stop() aborts the reader tasks, which skips their post-loop cleanup, so compensate for both:
    // (1) the held-KEY counts — a modifier held now would leave a phantom count and make the next
    // inject_text wait the full gate timeout; restore held_keys' "not running ⇒ empty".
    app.state::<crate::held_keys::HeldKeys>().clear();
    // (2) the held-SESSION "stop" — a PTT chord held while a rebind capture starts would otherwise
    // wedge "listening" until manual cancel (the release reaches no reader). No-op when none held.
    crate::evdev_hotkeys::stop_held_sessions(&app);
}

/// Apply the current bindings to the right backend: when the evdev backend is
/// enabled AND permitted it owns the Profiles' chords and the global-shortcut
/// plugin is silenced (mutual exclusion); otherwise the plugin registers and evdev stops.
pub fn apply_bindings(app: &AppHandle) {
    let Ok(dir) = config_dir(app) else { return };
    let cfg = config::load(&dir);
    let state = app.state::<crate::evdev_hotkeys::EvdevState>();
    let quick_add = &cfg.settings.general.quick_add_hotkey;
    // Re-registering aborts the evdev reader tasks, which skips their post-loop "stop" for any
    // PTT chord held right now — so a session held across this restart (e.g. editing a profile
    // while holding push-to-talk) would wedge "listening". Emit those stops first. No-op when
    // nothing is held.
    crate::evdev_hotkeys::stop_held_sessions(app);
    if cfg.settings.general.evdev_enabled && crate::evdev_hotkeys::permitted() {
        crate::triggers::unregister_all(app);
        crate::evdev_hotkeys::start(app, &state, &cfg.profiles, quick_add);
        tracing::info!("[bindings] evdev backend active (plugin silenced)");
    } else {
        crate::evdev_hotkeys::stop(&state);
        // Aborting the reader skips its held-key cleanup; drop any stale counts so the
        // inject gate isn't wedged on a phantom modifier while evdev stays off.
        app.state::<crate::held_keys::HeldKeys>().clear();
        crate::triggers::register_from_config(app, &cfg.profiles, quick_add);
    }
}

/// Re-read config and re-apply bindings (call after hotkeys / evdev toggle change).
#[tauri::command]
pub fn reregister_shortcuts(app: AppHandle) -> Result<(), String> {
    // Capture ended (or bindings changed): no longer suspended-for-capture, so a later
    // resume may re-arm normally again.
    CAPTURE_SUSPENDED.store(false, Ordering::SeqCst);
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
                        "[suspend] resume detected (~{}s gap); clearing dictation",
                        elapsed.as_secs()
                    );
                    // Don't re-arm while a binding capture is in progress: the frontend suspended
                    // shortcuts on purpose so a press only rebinds, and it restores them via
                    // reregister_shortcuts when capture ends. Re-arming here would let the user's
                    // next chord both rebind AND fire dictation (for a held evdev PTT chord, wedge
                    // "listening" — exactly what the suspend guards). The capture's reregister
                    // rebuilds fresh held-state on completion, so nothing is lost by skipping.
                    if CAPTURE_SUSPENDED.load(Ordering::SeqCst) {
                        tracing::info!("[suspend] binding capture in progress; leaving shortcuts suspended");
                    } else {
                        apply_bindings(&app);
                    }
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
pub async fn begin_injection(snap: State<'_, ClipboardSnapshot>) -> Result<(), String> {
    // Read the clipboard OFF the GTK main thread, time-bounded. This is now called PER PHRASE, and a
    // SYNC command runs on the UI thread — arboard's get_text is a blocking Wayland round-trip, so on
    // the UI thread it freezes the whole app (and reading a dead/slow clipboard owner — e.g. right
    // after the previous owner process exited — can hang indefinitely). On timeout/empty we KEEP the
    // prior snapshot: that path means we still hold the clipboard ourselves (the user copied nothing
    // new), so the existing snapshot already has their value.
    let read = tokio::task::spawn_blocking(|| {
        arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok())
    });
    match tokio::time::timeout(std::time::Duration::from_millis(400), read).await {
        Ok(Ok(Some(text))) => {
            tracing::info!("[clip] begin_injection: snapshot {} chars", text.len());
            if let Ok(mut g) = snap.0.lock() {
                *g = Some(text);
            }
        }
        _ => tracing::info!("[clip] begin_injection: clipboard read empty/timeout — keeping prior snapshot"),
    }
    Ok(())
}

/// Restore the clipboard snapshot taken by `begin_injection` (end of a live session).
#[tauri::command]
pub fn end_injection(snap: State<ClipboardSnapshot>) {
    let prev = snap.0.lock().ok().and_then(|mut g| g.take());
    if let Some(prev) = prev {
        tracing::info!("[clip] end_injection: restore {} chars (delayed)", prev.len());
        // Persist on Wayland: a plain set_text that drops immediately doesn't stick, which
        // is why the clipboard was "never restored". Serve it from a live owner — and after a
        // short delay, so the last phrase's in-flight Ctrl+V consumes the transcript BEFORE we
        // swap the original back (else the final phrase can paste the original instead).
        crate::inject::restore_clipboard_later(Some(prev));
    }
}

/// Restore the `begin_injection` snapshot WITHOUT consuming it, so the user's original
/// clipboard can be put back after EACH pasted phrase in an ongoing latch session (the
/// snapshot stays for the next phrase to restore again). Served from a live owner so it
/// persists on Wayland; no-op when no snapshot was taken (restore off / non-paste session).
#[tauri::command]
pub fn restore_clipboard_snapshot(snap: State<ClipboardSnapshot>) {
    let prev = snap.0.lock().ok().and_then(|g| g.clone());
    if let Some(prev) = prev {
        tracing::info!("[clip] restore_clipboard_snapshot: {} chars", prev.len());
        crate::inject::set_clipboard_persistent(&prev);
    }
}

/// Clear the `begin_injection` snapshot WITHOUT restoring it. Used when a live paste session
/// ENDS on a clipboard-only phrase: the clipboard then deliberately holds the transcript the
/// user wants to paste, so the end-of-session restore must NOT clobber it — but we still drop
/// the snapshot so it can't leak a stale value into a later session (e.g. a future
/// begin_injection that times out and keeps the prior snapshot).
#[tauri::command]
pub fn discard_injection_snapshot(snap: State<ClipboardSnapshot>) {
    if let Ok(mut g) = snap.0.lock() {
        let _ = g.take();
    }
}

/// The focused application's id + title + (when deep detection is on) whether its focused
/// element is editable. Via AT-SPI; `None` when nothing is known yet (no a11y bridge / cold
/// listener). Used to resolve per-app rules, the chip readout, and the field guard. When one
/// of OUR OWN windows holds focus, returns a synthetic `is_self` "this app" target so the chip
/// reads "→ this app" rather than the stale previously-focused app AT-SPI would report.
#[tauri::command]
pub async fn get_focused_app(
    app: AppHandle,
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<crate::atspi_guard::FocusedApp>, String> {
    // Authoritative own-window check (same as inject_text's guard): a Wayland client always
    // knows its own keyboard focus. Dictation won't type into our own UI, so surface that
    // truthfully instead of letting AT-SPI report whatever was focused before us. The
    // click-through "overlay" chip never holds focus; exclude it.
    if app
        .webview_windows()
        .iter()
        .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
    {
        return Ok(Some(crate::atspi_guard::FocusedApp {
            app_id: "self".into(),
            title: "this app".into(),
            editable: Some(false),
            is_self: true,
        }));
    }
    let focused = crate::atspi_guard::focused_app(guard.inner()).await;
    tracing::info!("[focused-app] {focused:?}");
    Ok(focused)
}

/// Like `get_focused_app` but WITHOUT the own-window self short-circuit: returns the
/// previously-focused OTHER application (`last_other` when our own window is up front). The
/// App-rules "Use current" button calls this — it's always clicked while our own Settings
/// window holds focus, so the self-aware `get_focused_app` would always report "this app".
#[tauri::command]
pub async fn get_focused_other_app(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<crate::atspi_guard::FocusedApp>, String> {
    let focused = crate::atspi_guard::focused_app(guard.inner()).await;
    tracing::info!("[focused-other-app] {focused:?}");
    Ok(focused)
}

/// Read the user's current text selection from the SOURCE app to pre-fill Quick-Add's "When you
/// say" field on summon, or `None` to leave it empty (and show the recent-words dropdown).
///
/// Order: ask accessibility (AT-SPI) FIRST — it can authoritatively report "nothing is selected",
/// so we never seed a STALE highlight when the user summoned with no selection. Only when it can't
/// tell (no Text interface — terminals, some Electron) do we fall back to the focus-independent
/// PRIMARY "highlight" buffer (read OFF the UI thread + time-bounded, same hazard as
/// `begin_injection`). The text is sanitised to a single short line either way.
#[tauri::command]
pub async fn get_quickadd_seed(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<String>, String> {
    use crate::atspi_guard::SelRead;
    match crate::atspi_guard::focused_selection(guard.inner()).await {
        SelRead::Text(s) => {
            let seed = sanitize_seed(&s);
            tracing::info!("[quickadd-seed] atspi selection {} chars -> seed {} chars", s.len(), seed.as_deref().map_or(0, str::len));
            Ok(seed)
        }
        SelRead::Empty => {
            tracing::info!("[quickadd-seed] atspi: nothing selected -> no seed");
            Ok(None)
        }
        // Opaque (rich-text ￼) or no Text interface at all → the real word lives in PRIMARY.
        SelRead::Opaque | SelRead::Unavailable => {
            let raw = match read_primary_now().await {
                Some(s) => s,
                None => return Ok(None),
            };
            let seed = sanitize_seed(&raw);
            tracing::info!("[quickadd-seed] primary fallback {} chars -> seed {} chars", raw.len(), seed.as_deref().map_or(0, str::len));
            Ok(seed)
        }
    }
}

/// Read the focused element's CURRENT text selection for the correct-on-close guard, called AFTER
/// Quick-Add hides (focus back on the source app) to confirm the SAME word is still highlighted
/// before replacing it. Accessibility must FIRST confirm a live selection exists in the focused app:
/// `Text` returns it directly; `Opaque` (a real rich-text selection whose chars are ￼) is confirmed
/// to exist, so we read its rendered text from PRIMARY. `Empty`/`Unavailable` return `None` — we
/// can't confirm the word is still selected, so we never paste blindly (and never consult PRIMARY,
/// which would be stale). This keeps the "check first, then replace" guarantee in rich-text editors.
#[tauri::command]
pub async fn get_focused_selection(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
) -> Result<Option<String>, String> {
    use crate::atspi_guard::SelRead;
    Ok(match crate::atspi_guard::focused_selection(guard.inner()).await {
        SelRead::Text(s) => Some(s),
        SelRead::Opaque => read_primary_now().await,
        SelRead::Empty | SelRead::Unavailable => None,
    })
}

/// Read the Wayland PRIMARY ("highlight") selection off the UI thread, time-bounded — the same
/// hazard guard as `begin_injection` (a hung clipboard owner must not stall the caller).
async fn read_primary_now() -> Option<String> {
    let read = tokio::task::spawn_blocking(crate::inject::read_primary_selection);
    match tokio::time::timeout(std::time::Duration::from_millis(400), read).await {
        Ok(Ok(Some(s))) => Some(s),
        _ => None,
    }
}

/// Turn a raw selection into a usable mapping KEY, or reject it. Multi-WORD selections are kept
/// verbatim (one key); a multi-LINE selection, an empty/whitespace-only one, or anything longer
/// than a plausible phrase is rejected — a paragraph isn't a spoken symbol. Edges are trimmed (a
/// trailing newline from a to-end-of-line highlight just falls away); an INTERIOR newline rejects.
fn sanitize_seed(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.contains('\n') || s.contains('\r') {
        return None;
    }
    if s.chars().count() > 100 {
        return None;
    }
    Some(s.to_string())
}

/// Toggle the opt-in AT-SPI "deep field detection" (a11y flag + Chromium/Electron poke),
/// which lets the focused-element editability read correctly for browser/Electron apps.
#[tauri::command]
pub fn set_deep_field_detection(
    guard: State<'_, crate::atspi_guard::AtspiGuard>,
    enabled: bool,
) -> Result<(), String> {
    tracing::info!("[atspi] deep field detection = {enabled}");
    crate::atspi_guard::set_deep(guard.inner(), enabled);
    Ok(())
}

/// Insert text into the focused field of the active app (paste or direct typing).
/// Direct typing on Wayland routes through the RemoteDesktop portal; everything
/// else uses enigo (clipboard paste, or direct on X11/Windows).
#[tauri::command]
pub async fn inject_text(
    app: AppHandle,
    typer: State<'_, WaylandTyper>,
    vkbd: State<'_, crate::virtual_keyboard::VirtualKeyboard>,
    text: String,
    method: String,
    auto_enter: bool,
    restore_clipboard: bool,
    paste_shortcut: Vec<String>,
) -> Result<(), String> {
    // Strip control characters (except Tab/LF; CR is normalized to LF) from the server-transcribed
    // text before it reaches ANY injection path — clipboard-only, Wayland paste, or X11 paste/direct
    // — so a malicious/garbled server can't smuggle terminal-escape sequences onto the clipboard or
    // into a paste. (The Wayland direct-typing paths already drop controls; this matches them.)
    let text = crate::inject::sanitize_injected(&text);
    tracing::info!("[inject] {} chars via {} (auto_enter={})", text.len(), method, auto_enter);
    // Clipboard-only: put the text on the clipboard and inject NO keystrokes, so it can't
    // fire actions in the wrong window — the user pastes it themselves. No own-window guard
    // / modifier gate needed since nothing is typed.
    if method == "clipboard" {
        if !text.is_empty() {
            crate::inject::set_clipboard_persistent(&text);
        }
        return Ok(());
    }
    // Never type into our OWN UI: if one of our real windows holds keyboard focus, the
    // injected keys would fire buttons/shortcuts in the app itself (e.g. dictating while
    // looking at Home). A Wayland client is always told its own keyboard focus, so this is
    // reliable on KWin — unlike detecting other apps' focused fields. The click-through
    // "overlay" chip never holds focus; exclude it. The transcript still shows in the chip.
    if app
        .webview_windows()
        .iter()
        .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
    {
        tracing::info!("[inject] skipped: our own window holds focus");
        return Ok(());
    }
    // Wait briefly for the trigger chord's shortcut modifiers (Ctrl/Alt/Meta) to be
    // physically released before typing — otherwise the injected keys fold into the
    // still-held modifier and fire shortcuts in the focused app (worst with a latch
    // stop, which triggers on the second chord press with every key still down). Only
    // the evdev backend can observe physical release on Wayland; when it isn't running
    // the held set is empty so this is a no-op. Capped so we never drop the text.
    {
        let held = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        if held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
                if std::time::Instant::now() >= deadline {
                    tracing::warn!("[inject] trigger modifiers still held after 500ms — injecting anyway");
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        }
    }
    let res = if crate::inject::is_wayland() {
        if text.is_empty() && auto_enter {
            // Auto-enter with no text (the per-phrase / tail Enter): press Enter WITHOUT
            // touching the clipboard. The paste path would set_clipboard("") and clobber it;
            // route the bare Enter through the portal type path instead.
            crate::wayland_inject::type_text(&app, typer.inner(), "", true).await
        } else if method == "direct" {
            // Prefer the virtual keyboard (Caps Lock-/layout-correct typing). Fall back
            // to the portal keycode path when the protocol is unavailable (e.g. GNOME)
            // or a job fails.
            match crate::virtual_keyboard::type_text(vkbd.inner(), &text, auto_enter).await {
                Ok(()) => {
                    tracing::info!("[inject] typed via virtual keyboard");
                    Ok(())
                }
                Err(e) => {
                    tracing::warn!("[inject] virtual keyboard unavailable ({e}); using portal");
                    crate::wayland_inject::type_text(&app, typer.inner(), &text, auto_enter).await
                }
            }
        } else {
            // Paste on Wayland: set the clipboard here, then synthesize Ctrl+V via
            // the portal. enigo's XTEST Ctrl+V is unreliable on KDE Wayland — a
            // synthesized modifier + remapped keycode makes apps fire the wrong
            // shortcut (e.g. opening editor tabs) instead of pasting.
            let clip = text.clone();
            let set_res = tokio::task::spawn_blocking(move || {
                crate::inject::set_clipboard(&clip, restore_clipboard)
            })
            .await
            .map_err(|e| e.to_string())?;
            let prev = set_res?;
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            let r = crate::wayland_inject::paste(&app, typer.inner(), paste_shortcut, auto_enter).await;
            // Restore the user's prior clipboard only if the paste actually landed. If it failed,
            // leave the transcript on the clipboard so it's recoverable (the user can paste it
            // manually) instead of silently clobbering it with the old clipboard.
            if r.is_ok() {
                crate::inject::restore_clipboard_later(prev);
            }
            r
        }
    } else {
        tokio::task::spawn_blocking(move || {
            crate::inject::inject(&text, &method, auto_enter, restore_clipboard, &paste_shortcut)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(ref e) = res {
        tracing::warn!("[inject] FAILED: {e}");
    }
    res
}
