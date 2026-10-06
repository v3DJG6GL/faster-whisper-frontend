//! Global shortcut registration, the suspend while a shortcut is being captured,
//! the suspend/resume watch and the evdev backend status and setup.

use super::config_dir;
use crate::config;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// True while shortcuts are intentionally suspended for an in-progress binding capture
/// (suspend_shortcuts is only ever called by the capture hook). The suspend-watch resume
/// path reads this so an automatic resume re-arm can't override a deliberate capture
/// suspension; reregister_shortcuts (the capture-end pair) clears it. Read and written only
/// under APPLY_LOCK, so a check and the apply it gates can't straddle a suspend.
static CAPTURE_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// Serializes every registration change: apply_bindings' whole load→branch→apply and
/// suspend_shortcuts' teardown. Its holders may block on the MAIN thread — in plugin mode
/// `gs.register`/`gs.unregister` post to it (the plugin's `run_main_thread!`) and wait for the
/// answer — so no holder may run on the main thread, and no main-thread caller may wait for it:
/// that is why the commands below are `async` and run on the blocking pool (spawn_blocking —
/// they may wait here for seconds, which must not park a tokio worker either). setup's
/// apply_bindings is the one main-thread holder, and is safe only because it runs before
/// spawn_suspend_watch starts the other one.
static APPLY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Suspend ALL hotkey backends (while the user captures a new binding) so pressing
/// an existing profile's chord only rebinds — it must not also fire dictation. This
/// silences both the global-shortcut plugin AND the evdev reader (which otherwise
/// keeps firing from /dev/input). Pair with `reregister_shortcuts` (apply_bindings)
/// to restore whichever backend is active when capture ends.
#[tauri::command]
pub async fn suspend_shortcuts(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || suspend_shortcuts_blocking(&app))
        .await
        .map_err(|e| e.to_string())
}

fn suspend_shortcuts_blocking(app: &AppHandle) {
    // Off the main thread now, so it could race a suspend-watch apply_bindings re-arming the
    // backend this is tearing down; take the same lock to keep the two in order.
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    CAPTURE_SUSPENDED.store(true, Ordering::SeqCst);
    crate::hotkeys::triggers::unregister_all(app);
    let state = app.state::<crate::hotkeys::evdev::EvdevState>();
    crate::hotkeys::evdev::stop(&state);
    // Windows twin of the evdev teardown (no-op elsewhere): the hook backend is the
    // always-on low-level listener there and must fall silent during capture too.
    crate::hotkeys::windows::stop(&app.state::<crate::hotkeys::windows::WinHookState>());
    // stop() aborts the reader tasks, which skips their post-loop cleanup, so compensate for both:
    // (1) the held-KEY counts — a modifier held now would leave a phantom count and make the next
    // inject_text wait the full gate timeout; restore held_keys' "not running ⇒ empty".
    app.state::<crate::hotkeys::held_keys::HeldKeys>().clear();
    // (2) the held-SESSION "stop" — a PTT chord held while a rebind capture starts would otherwise
    // wedge "listening" until manual cancel (the release reaches no reader). No-op when none held.
    crate::hotkeys::evdev::stop_held_sessions(app);
    crate::hotkeys::windows::stop_held_sessions(app);
}

/// Whether ALL of the given chord's MODIFIER keys are physically held RIGHT NOW, per
/// the low-level backends' shared HeldKeys signal (evdev on Linux, hotkeys::windows on
/// Windows; always false when only the plugin backend runs — it can't see raw key
/// state). `codes` is the binding's `event.code` list; non-modifier members are
/// unobservable and ignored, and a chord with NO modifiers answers false.
/// Consumer: the frontend's queued-start path — a PTT press that landed during
/// "finalizing…" auto-starts once the session settles, but only while ITS chord is
/// still down. Checking the chord's own modifiers (not "any modifier") keeps an
/// unrelated held Shift from starting a hold session whose release will never come.
#[tauri::command]
pub fn shortcut_mods_held(app: AppHandle, codes: Vec<String>) -> bool {
    let mods: Vec<u16> = codes
        .iter()
        .filter_map(|c| crate::hotkeys::held_keys::modifier_code(c))
        .collect();
    app.state::<crate::hotkeys::held_keys::HeldKeys>()
        .all_held(&mods)
}

/// Apply the current bindings to the right backend: when the evdev backend is
/// enabled AND permitted it owns the Profiles' chords and the global-shortcut
/// plugin is silenced (mutual exclusion); otherwise the plugin registers and evdev stops.
pub fn apply_bindings(app: &AppHandle) {
    // Serialize the whole load→branch→apply. This is invoked from the suspend-watch thread, the
    // reregister_shortcuts* command handlers, and setup, which can overlap (a resume runs
    // apply_bindings AND emits system://resumed → the frontend calls reregister). Without this lock,
    // if the on-disk config flips evdev_enabled between two concurrent runs' loads, the two take
    // opposite branches and the evdev-XOR-plugin invariant breaks: both backends end up live (every
    // chord double-fires) or neither is registered (no hotkeys until the next reregister). See
    // APPLY_LOCK for the threads that may (and may not) hold it.
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    apply_bindings_locked(app);
}

/// The apply step itself; the caller holds APPLY_LOCK.
fn apply_bindings_locked(app: &AppHandle) {
    let Ok(dir) = config_dir(app) else { return };
    let cfg = config::load(&dir);
    // The quick-add chord stays INERT until a word-mapping list is designated
    // (settings.quickAddList) — the window would have nothing to add to. This
    // keeps the Super+Alt factory default harmless out of the box;
    // designating a list (onboarding step 3 / the Dictionary screen) arms it.
    let no_quick_add: Vec<String> = Vec::new();
    let quick_add = if cfg.settings.quick_add_list.is_some() {
        &cfg.settings.general.quick_add_hotkey
    } else {
        &no_quick_add
    };
    // Re-registering tears the old listener down, which skips its post-loop "stop" for any PTT
    // chord held right now — so a session held across this restart (e.g. editing a profile while
    // holding push-to-talk) would wedge "listening". The Windows hook's stops are emitted here,
    // first (its worker exits gracefully and normally emits its own, but claim-based: whichever
    // side runs first wins — see hotkeys::windows::take_hold). evdev's are emitted AFTER its
    // readers are aborted (inside evdev::start, or after evdev::stop below): draining first left
    // the whole permitted() enumeration as a window in which a reader could start a hold that the
    // abort then orphaned. No-op when nothing is held.
    crate::hotkeys::windows::stop_held_sessions(app);
    #[cfg(windows)]
    {
        // Windows: the low-level hook backend owns ALL chords — it registers everything
        // the plugin can, plus the modifier-only / left-right / N-key chords it can't
        // (the default Ctrl+Shift PTT). The plugin stays silent, mirroring the
        // evdev-XOR-plugin invariant below.
        crate::hotkeys::triggers::unregister_all(app);
        let hook = app.state::<crate::hotkeys::windows::WinHookState>();
        crate::hotkeys::windows::start(app, &hook, &cfg.profiles, quick_add);
        tracing::info!("[bindings] windows hook backend active (plugin silenced)");
    }
    #[cfg(not(windows))]
    {
        let state = app.state::<crate::hotkeys::evdev::EvdevState>();
        if cfg.settings.general.evdev_enabled && crate::hotkeys::evdev::permitted() {
            crate::hotkeys::triggers::unregister_all(app);
            crate::hotkeys::evdev::start(app, &state, &cfg.profiles, quick_add);
            tracing::info!("[bindings] evdev backend active (plugin silenced)");
        } else {
            crate::hotkeys::evdev::stop(&state);
            crate::hotkeys::evdev::stop_held_sessions(app);
            // Aborting the reader skips its held-key cleanup; drop any stale counts so the
            // inject gate isn't wedged on a phantom modifier while evdev stays off.
            app.state::<crate::hotkeys::held_keys::HeldKeys>().clear();
            crate::hotkeys::triggers::register_from_config(app, &cfg.profiles, quick_add);
        }
    }
}

/// Re-apply the bindings unless a binding capture holds them suspended — the check and the
/// apply share one APPLY_LOCK hold, so a suspend_shortcuts can't land between them. Returns
/// whether it applied.
fn apply_bindings_unless_capturing(app: &AppHandle) -> bool {
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if CAPTURE_SUSPENDED.load(Ordering::SeqCst) {
        return false;
    }
    apply_bindings_locked(app);
    true
}

/// Re-read config and re-apply bindings (call after hotkeys / evdev toggle change).
/// `async` + spawn_blocking so the wait on APPLY_LOCK happens off the main thread and off
/// the tokio workers (see there).
#[tauri::command]
pub async fn reregister_shortcuts(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Capture ended (or bindings changed): no longer suspended-for-capture, so a later
        // resume may re-arm normally again.
        CAPTURE_SUSPENDED.store(false, Ordering::SeqCst);
        apply_bindings_locked(&app);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Like `reregister_shortcuts`, but a NO-OP while a binding capture is in progress
/// (CAPTURE_SUSPENDED). cancelLive's resume-recovery calls this: cancelling a session on
/// `system://resumed` must NOT clear the capture suspension and re-arm the hotkeys mid-capture
/// (the suspend-watch deliberately left them suspended, and the capture-end `reregister_shortcuts`
/// will re-arm once capture truly ends). Outside a capture it behaves exactly like the unconditional
/// reregister, preserving cancelLive's stuck-hotkey recovery.
#[tauri::command]
pub async fn reregister_shortcuts_unless_capturing(app: AppHandle) -> Result<(), String> {
    // Outside a capture CAPTURE_SUSPENDED is already false, so applying without clearing it
    // is exactly the unconditional reregister.
    tauri::async_runtime::spawn_blocking(move || {
        apply_bindings_unless_capturing(&app);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Detect a system suspend/resume: a dedicated thread ticks every couple of seconds
/// and asks a `SleepClock` whether the machine slept in between. Suspend is hostile to both
/// long-lived listeners — it can drop the key-release that ends a hold-to-talk chord
/// (leaving the evdev backend stuck "down"), or re-enumerate the keyboards (killing
/// the reader tasks), and it silently kills the dictation WebSocket. On resume we
/// rebuild the hotkey backend (fresh held-state, freshly enumerated devices) and tell
/// the UI to drop any in-flight session so the chip can't hang at "finalizing…".
pub fn spawn_suspend_watch(app: AppHandle) {
    const TICK: std::time::Duration = std::time::Duration::from_secs(2);
    let _ = std::thread::Builder::new()
        .name("suspend-watch".into())
        .spawn(move || {
            let mut clock = SleepClock::new();
            loop {
                std::thread::sleep(TICK);
                let Some(slept) = clock.tick() else {
                    continue;
                };
                tracing::info!(
                    "[suspend] resume detected (~{}s gap); clearing dictation",
                    slept.as_secs()
                );
                // Don't re-arm while a binding capture is in progress: the frontend suspended
                // shortcuts on purpose so a press only rebinds, and it restores them via
                // reregister_shortcuts when capture ends. Re-arming here would let the user's
                // next chord both rebind AND fire dictation (for a held evdev PTT chord, wedge
                // "listening" — exactly what the suspend guards). The capture's reregister
                // rebuilds fresh held-state on completion, so nothing is lost by skipping.
                if !apply_bindings_unless_capturing(&app) {
                    tracing::info!(
                        "[suspend] binding capture in progress; leaving shortcuts suspended"
                    );
                }
                // A resume reshuffles the desktop (display re-attach, lock screen); make
                // sure the chip did not come back underneath something.
                #[cfg(windows)]
                crate::aux_windows::overlay::repair_topmost(&app);
                let _ = app.emit("system://resumed", ());
            }
        });
}

/// Linux: the time spent suspended, measured directly. CLOCK_BOOTTIME counts suspend and
/// CLOCK_MONOTONIC does not, so their difference grows ONLY across a suspend. Neither is stepped
/// by NTP or a manual clock change, and a stalled thread grows both alike — the wall-clock gap
/// this replaces fired the full resume path (cancelling an in-flight dictation) on any forward
/// clock step of a few seconds.
#[cfg(target_os = "linux")]
struct SleepClock {
    last: Option<std::time::Duration>,
}

#[cfg(target_os = "linux")]
impl SleepClock {
    /// Suspended time beyond this counts as a real sleep.
    const GAP: std::time::Duration = std::time::Duration::from_secs(4);

    fn new() -> Self {
        Self {
            last: suspended_total(),
        }
    }

    /// The time slept since the previous tick, when it is a real sleep.
    fn tick(&mut self) -> Option<std::time::Duration> {
        let now = suspended_total()?;
        let prev = self.last.replace(now)?;
        let slept = now.saturating_sub(prev);
        (slept > Self::GAP).then_some(slept)
    }
}

/// Total time suspended since boot (CLOCK_BOOTTIME − CLOCK_MONOTONIC). The two clocks can't be
/// read atomically, so the boot reading is bracketed by two monotonic ones and retried if
/// the thread was descheduled in between — a long stall there would skew one tick's
/// difference by the stall and read as a sleep on the next.
#[cfg(target_os = "linux")]
fn suspended_total() -> Option<std::time::Duration> {
    use std::time::Duration;
    fn read(clock: libc::clockid_t) -> Option<Duration> {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid, writable timespec for the duration of the call.
        if unsafe { libc::clock_gettime(clock, &mut ts) } != 0 {
            return None;
        }
        Some(Duration::new(
            u64::try_from(ts.tv_sec).ok()?,
            u32::try_from(ts.tv_nsec).ok()?,
        ))
    }
    for _ in 0..3 {
        let mono1 = read(libc::CLOCK_MONOTONIC)?;
        let boot = read(libc::CLOCK_BOOTTIME)?;
        let mono2 = read(libc::CLOCK_MONOTONIC)?;
        if mono2.saturating_sub(mono1) < Duration::from_millis(100) {
            return Some(boot.saturating_sub(mono2));
        }
    }
    None
}

/// Elsewhere: the wall clock, NOT Instant (which may pause across suspend), so a sleep shows
/// as a gap far beyond the tick. A large forward wall-clock step (time sync, manual change)
/// or a thread stall of the same size reads as a resume too.
#[cfg(not(target_os = "linux"))]
struct SleepClock {
    last: std::time::SystemTime,
}

#[cfg(not(target_os = "linux"))]
impl SleepClock {
    /// A gap this far beyond the tick means a real sleep, not scheduler jitter.
    const GAP: std::time::Duration = std::time::Duration::from_secs(8);

    fn new() -> Self {
        Self {
            last: std::time::SystemTime::now(),
        }
    }

    /// The wall time since the previous tick, when it is a real sleep.
    fn tick(&mut self) -> Option<std::time::Duration> {
        let now = std::time::SystemTime::now();
        let elapsed = now.duration_since(self.last).unwrap_or_default();
        self.last = now;
        (elapsed > Self::GAP).then_some(elapsed)
    }
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
        permitted: crate::hotkeys::evdev::permitted(),
        enabled,
    }
}

/// Add the user to the `input` group via `pkexec` (polkit GUI auth). The user must
/// log out and back in for it to take effect.
#[tauri::command]
pub async fn evdev_setup() -> Result<String, String> {
    crate::hotkeys::evdev::setup().await
}

/// Whether a code-list chord can be registered by the platform's registrar. On
/// Windows that's the always-on hook backend (anything mappable, incl. modifier-only
/// / AltGr / left-right). Elsewhere it's the global-shortcut plugin — modifier-only /
/// AltGr chords return false there; those need the evdev backend. (The capture UI
/// only consults this in plugin mode, but keep the answer truthful per platform.)
#[tauri::command]
pub fn validate_codes(codes: Vec<String>) -> bool {
    #[cfg(windows)]
    {
        !codes.is_empty() && codes.iter().all(|c| crate::hotkeys::windows::code_valid(c))
    }
    #[cfg(not(windows))]
    {
        use std::str::FromStr;
        crate::config::codes_to_accelerator(&codes)
            .map(|a| tauri_plugin_global_shortcut::Shortcut::from_str(&a).is_ok())
            .unwrap_or(false)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn sleep_clock_reads_and_stays_quiet_without_a_suspend() {
        assert!(suspended_total().is_some());
        let mut clock = SleepClock::new();
        assert_eq!(clock.tick(), None);
        assert_eq!(clock.tick(), None);
    }
}
