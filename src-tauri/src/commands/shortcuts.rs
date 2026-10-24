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
/// silences the global-shortcut plugin AND the low-level listener (the evdev reader /
/// the Windows hook), which otherwise keeps firing. Pair with `reregister_shortcuts`
/// to restore whichever backend is active when capture ends.
#[tauri::command]
pub async fn suspend_shortcuts(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || suspend_shortcuts_blocking(&app))
        .await
        .map_err(|e| e.to_string())
}

fn suspend_shortcuts_blocking(app: &AppHandle) {
    // Same lock as the suspend-watch's re-arm, so it can't race the teardown below.
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
/// ignored (projected onto the modifier subset for cross-backend parity; see
/// held_keys::modifier_code), and a chord with NO modifiers answers false.
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
/// On Windows the low-level hook backend always owns them.
pub fn apply_bindings(app: &AppHandle) {
    // Serialize the whole load→branch→apply, as every other applier does: if the on-disk config
    // flips evdev_enabled between two overlapping runs' loads, they take opposite branches and the
    // evdev-XOR-plugin invariant breaks: both backends end up live (every chord double-fires) or
    // neither is registered (no hotkeys until the next reregister). See APPLY_LOCK for the threads
    // that may (and may not) hold it.
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    apply_bindings_locked(app);
}

/// The config of the last good read by [`bindings_config`]: what an unreadable file falls back to.
/// A capture's re-register runs after suspend_shortcuts unregistered everything, so "keep what is
/// live" alone would leave every hotkey off until the next resume or re-register.
static LAST_GOOD: std::sync::Mutex<Option<config::Config>> = std::sync::Mutex::new(None);

/// The config for the mid-session hotkey readers (the bindings apply, the evdev re-scan, a legacy
/// CLI/DE-shortcut flag); never the recovering `load`: a read error here must not move the user's
/// config aside, and must not use the defaults either (they have no profiles: every hotkey would
/// go). An unreadable file falls back to the last config read this session, so every reader
/// decides from the same config the live bindings were armed from. None only when no read has
/// succeeded yet this session.
pub fn bindings_config(app: &AppHandle) -> Option<config::Config> {
    read_or_last_good(&LAST_GOOD, || {
        config_dir(app).ok().and_then(|dir| config::try_load(&dir))
    })
}

/// `bindings_config`'s fallback: a good read replaces `last_good`; a failed one returns it. The
/// read runs under the slot's lock, so the stores land in read order: the readers don't all hold
/// APPLY_LOCK (the evdev re-scan and a legacy flag read without it), and a slower reader holding
/// an older read must not overwrite the newer one the live bindings were just armed from. The
/// read takes no other lock, and no thread waits on APPLY_LOCK while holding this one.
fn read_or_last_good(
    last_good: &std::sync::Mutex<Option<config::Config>>,
    read: impl FnOnce() -> Option<config::Config>,
) -> Option<config::Config> {
    let mut last = last_good.lock().unwrap_or_else(|e| e.into_inner());
    match read() {
        Some(cfg) => {
            *last = Some(cfg.clone());
            Some(cfg)
        }
        None => {
            if last.is_some() {
                tracing::warn!("[bindings] config unreadable; using the last one read");
            }
            last.clone()
        }
    }
}

/// The apply step itself; the caller holds APPLY_LOCK.
fn apply_bindings_locked(app: &AppHandle) {
    let Some(cfg) = bindings_config(app) else {
        tracing::warn!("[bindings] config unreadable; nothing applied");
        return;
    };
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
    // readers are retired (inside evdev::start, or after evdev::stop below): a reader still
    // running past the abort registers a hold only under the live generation, so the drain sees
    // every hold that emitted a start (evdev::register_hold). No-op when nothing is held.
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
/// the tokio workers (see APPLY_LOCK).
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
///
/// `seed` is the input-node listing taken before setup's apply_bindings (see
/// `suspend_watch_seed`).
pub fn spawn_suspend_watch(app: AppHandle, seed: SuspendWatchSeed) {
    const TICK: std::time::Duration = std::time::Duration::from_secs(2);
    #[cfg(not(target_os = "linux"))]
    let _ = seed;
    let _ = std::thread::Builder::new()
        .name("suspend-watch".into())
        .spawn(move || {
            let mut clock = SleepClock::new();
            #[cfg(target_os = "linux")]
            let mut nodes = InputNodeWatch::seeded(seed.0);
            loop {
                std::thread::sleep(TICK);
                let Some(slept) = clock.tick() else {
                    // evdev enumerates only on an apply, so a keyboard plugged in (or re-attached)
                    // later has dead chords until something re-applies; a new keyboard node, or a
                    // running reader losing its keyboard, is that something.
                    #[cfg(target_os = "linux")]
                    rescan_input_devices(&app, &mut nodes);
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
                // The node listing is taken BEFORE the apply enumerates (see below).
                #[cfg(target_os = "linux")]
                let listing = input_event_nodes();
                if !apply_bindings_unless_capturing(&app) {
                    tracing::info!(
                        "[suspend] binding capture in progress; leaving shortcuts suspended"
                    );
                }
                // A resume reshuffles the desktop (display re-attach, lock screen); make
                // sure the chip did not come back underneath something.
                #[cfg(windows)]
                crate::aux_windows::overlay::repair_topmost(&app);
                // Re-baseline on the listing taken before the apply (see
                // `InputNodeWatch::after_apply`): a keyboard re-enumerated across the suspend stays
                // pending for one settled-tick probe. A failed listing keeps the old baseline.
                #[cfg(target_os = "linux")]
                match listing {
                    Some(now) => nodes.after_apply(now),
                    None => nodes.forget_pending(),
                }
                let _ = app.emit("system://resumed", ());
            }
        });
}

/// The suspend watch's starting input-node baseline. setup takes it BEFORE its apply_bindings
/// enumerates keyboards, as the resume path does around its own apply: baselined on the watch's
/// first tick instead (2 s later), a keyboard that appeared in between — a Bluetooth or dock
/// keyboard connecting right after login — would never be probed, and its chords would stay dead
/// until something else re-applied.
pub struct SuspendWatchSeed(#[cfg(target_os = "linux")] Option<std::collections::BTreeSet<String>>);

pub fn suspend_watch_seed() -> SuspendWatchSeed {
    SuspendWatchSeed(
        #[cfg(target_os = "linux")]
        input_event_nodes(),
    )
}

/// The `/dev/input/event*` node names (no device is opened). None when the directory can't be
/// read: the caller skips that tick and keeps its last good set, since an empty set as the
/// baseline would make every existing node read as new on the next good listing.
#[cfg(target_os = "linux")]
fn input_event_nodes() -> Option<std::collections::BTreeSet<String>> {
    std::fs::read_dir("/dev/input").ok().map(|rd| {
        rd.filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("event"))
            .collect()
    })
}

/// What a re-scan's apply did.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum RescanApply {
    Applied,
    /// A binding capture holds the bindings suspended; the capture's re-register enumerates.
    Capturing,
    /// A push-to-talk hold started since the decision; a restart now would end it.
    Held,
    /// The loss that asked for it was already re-armed by a concurrent apply.
    Covered,
}

/// The re-scan's apply, with the capture, hold and loss gates re-checked under the same APPLY_LOCK
/// hold as the apply: the decision was made before the keyboard probes and the lock wait (seconds,
/// when a plugin-mode re-register holds it), so a hold or a re-apply may have landed since.
#[cfg(target_os = "linux")]
fn apply_bindings_for_rescan(app: &AppHandle, loss: bool) -> RescanApply {
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if CAPTURE_SUSPENDED.load(Ordering::SeqCst) {
        return RescanApply::Capturing;
    }
    if crate::hotkeys::evdev::any_hold_active() || crate::hotkeys::triggers::any_hold_active() {
        return RescanApply::Held;
    }
    if loss && !crate::hotkeys::evdev::reader_lost() {
        return RescanApply::Covered;
    }
    // The caller only gets here with a config in hand, so LAST_GOOD is set and the apply's own
    // read cannot come back empty.
    apply_bindings_locked(app);
    RescanApply::Applied
}

/// One suspend-watch tick of evdev's device re-scan. A re-apply is a full evdev restart — it aborts
/// every reader and manufactures a stop for any push-to-talk hold — so it runs only when it can
/// gain a keyboard: a settled new node that IS a keyboard, or a running reader that lost its own
/// (which also covers a keyboard re-enumerated under the same node name). Gated on the configured
/// intent, not on evdev running: a resume apply that found no keyboard yet fell back to the plugin,
/// and the keyboard arriving later is what switches the backend back to evdev.
#[cfg(target_os = "linux")]
fn rescan_input_devices(app: &AppHandle, nodes: &mut InputNodeWatch) {
    let Some(now) = input_event_nodes() else {
        return;
    };
    let Some(reader_lost) = nodes.observe(now, crate::hotkeys::evdev::reader_lost()) else {
        return;
    };
    // An unreadable config decides from the last config read (the one the live bindings were
    // armed from); only with no good read yet this session does it skip the tick (pending kept)
    // rather than read as "evdev off".
    let Some(cfg) = bindings_config(app) else {
        return;
    };
    let wanted = cfg.settings.general.evdev_enabled;
    let step = rescan_step(
        wanted,
        crate::hotkeys::evdev::any_hold_active() || crate::hotkeys::triggers::any_hold_active(),
        reader_lost,
        || {
            nodes
                .pending
                .iter()
                .any(|n| crate::hotkeys::evdev::is_keyboard_node(n))
        },
    );
    match step {
        // Kept pending: the next settled tick asks again, once the hold has ended.
        RescanStep::Defer => {}
        RescanStep::Skip => nodes.pending.clear(),
        RescanStep::Apply => match apply_bindings_for_rescan(app, reader_lost) {
            RescanApply::Applied => {
                nodes.pending.clear();
                if reader_lost {
                    nodes.note_loss_apply();
                }
                tracing::info!(
                    "[evdev] {}; re-scanning keyboards",
                    if reader_lost {
                        "a keyboard stream ended"
                    } else {
                        "keyboard added"
                    }
                );
            }
            RescanApply::Capturing => {
                nodes.pending.clear();
                tracing::info!(
                    "[evdev] binding capture in progress; the capture's re-register will enumerate keyboards"
                );
            }
            // As Defer: kept pending, the next settled tick asks again.
            RescanApply::Held => {}
            RescanApply::Covered => nodes.pending.clear(),
        },
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum RescanStep {
    /// Nothing to gain (evdev not wanted, or no new node is a keyboard): drop what was pending.
    Skip,
    /// A push-to-talk hold (evdev or plugin) is active and a restart would end it: keep it pending.
    Defer,
    /// Re-apply the bindings.
    Apply,
}

/// The re-scan decision for a due tick. `new_keyboard` probes the pending nodes (opens devices),
/// so it runs only when nothing else already decided.
#[cfg(target_os = "linux")]
fn rescan_step(
    evdev_wanted: bool,
    hold_active: bool,
    reader_lost: bool,
    new_keyboard: impl FnOnce() -> bool,
) -> RescanStep {
    if !evdev_wanted {
        RescanStep::Skip
    } else if hold_active {
        RescanStep::Defer
    } else if reader_lost || new_keyboard() {
        RescanStep::Apply
    } else {
        RescanStep::Skip
    }
}

/// Debounces "an input device appeared / a keyboard was lost" for evdev's re-scan. Neither is acted
/// on the tick it is first seen (udev may not have set the new node's ACL yet, so opening it would
/// fail and the keyboard stay missed); a re-scan is due on a tick whose node set equals the previous
/// one. `pending` = nodes that appeared since the last decision and still exist. A loss that
/// survives its own re-apply (a keyboard whose reads fail right after every open) backs off
/// exponentially instead of restarting evdev every other tick.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct InputNodeWatch {
    prev: Option<std::collections::BTreeSet<String>>,
    pending: std::collections::BTreeSet<String>,
    lost_seen: bool,
    /// Ticks the next loss-triggered re-apply waits; doubles per consecutive one, reset only once
    /// the readers stayed up for `LOSS_STABLE_TICKS` ticks in a row — a keyboard that fails a few
    /// seconds after every open shows a clean tick or two between losses, and resetting on those
    /// would restart evdev every few ticks without bound.
    loss_backoff: u32,
    loss_wait: u32,
    /// Consecutive ticks without a lost reader.
    clean_run: u32,
}

/// Cap on `InputNodeWatch::loss_backoff`, in ticks (~2 min at the 2 s tick).
#[cfg(target_os = "linux")]
const LOSS_BACKOFF_MAX: u32 = 64;

/// Clean ticks in a row (~1 min at the 2 s tick) after which a loss counts as new again and the
/// backoff resets.
#[cfg(target_os = "linux")]
const LOSS_STABLE_TICKS: u32 = 30;

#[cfg(target_os = "linux")]
impl InputNodeWatch {
    /// A watch baselined on `listing`, taken before an apply enumerated (see `after_apply`); a
    /// failed listing leaves the first tick to baseline.
    fn seeded(listing: Option<std::collections::BTreeSet<String>>) -> Self {
        let mut w = Self::default();
        if let Some(now) = listing {
            w.after_apply(now);
        }
        w
    }

    /// Feed this tick's node set and evdev's reader-lost flag. `Some(reader_lost)` when a re-scan
    /// decision is due; the caller clears `pending` unless it defers.
    fn observe(&mut self, now: std::collections::BTreeSet<String>, lost: bool) -> Option<bool> {
        // The first look is the baseline, not an arrival.
        let settled = match &self.prev {
            Some(prev) => {
                self.pending.extend(now.difference(prev).cloned());
                now == *prev
            }
            None => false,
        };
        self.pending.retain(|n| now.contains(n));
        self.prev = Some(now);
        // A loss already seen on an earlier tick: its keyboard may have come straight back under
        // the same name, so it gets the same one-tick grace as a new node.
        if lost {
            self.clean_run = 0;
        } else {
            self.clean_run = self.clean_run.saturating_add(1);
            if self.clean_run >= LOSS_STABLE_TICKS {
                self.loss_backoff = 0;
                self.loss_wait = 0;
            }
        }
        let lost_due = lost && self.lost_seen && self.loss_wait == 0;
        if lost && self.loss_wait > 0 {
            self.loss_wait -= 1;
        }
        self.lost_seen = lost;
        if !settled {
            None
        } else if lost_due {
            Some(true)
        } else if !self.pending.is_empty() {
            Some(false)
        } else {
            None
        }
    }

    /// A loss-triggered re-apply ran: if the loss is still there afterwards, wait longer each time.
    fn note_loss_apply(&mut self) {
        self.loss_backoff = (self.loss_backoff * 2).clamp(1, LOSS_BACKOFF_MAX);
        self.loss_wait = self.loss_backoff;
    }

    /// An apply just enumerated: clears `pending` and the loss latch, then re-baselines on `now`
    /// via observe — so nodes new relative to the last tick's listing stay pending and get one
    /// settled-tick keyboard probe. Taking `now` before the apply enumerates means a node that
    /// appears during or after that enumerate is missing from the new baseline and reads as new on
    /// the next tick.
    fn after_apply(&mut self, now: std::collections::BTreeSet<String>) {
        self.forget_pending();
        let _ = self.observe(now, false);
    }

    /// An apply just enumerated but this tick's listing failed: drop what was pending and the loss
    /// latch, and keep the last good baseline.
    fn forget_pending(&mut self) {
        self.pending.clear();
        self.lost_seen = false;
    }
}

/// Linux: the time spent suspended, measured directly. CLOCK_BOOTTIME counts suspend and
/// CLOCK_MONOTONIC does not, so their difference grows ONLY across a suspend. Neither is stepped
/// by NTP or a manual clock change, and a stalled thread grows both alike — a wall-clock gap
/// would fire the full resume path (cancelling an in-flight dictation) on any forward clock step
/// of a few seconds.
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
    /// Wall time since the previous tick (the 2 s tick sleep included) beyond which it counts
    /// as a real sleep, not scheduler jitter.
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
}

/// Status for the Permissions UI: is evdev available / permitted? (Whether it is turned on is the
/// store's settings.general.evdevEnabled.)
/// `async` + spawn_blocking: `permitted()` opens and probes every /dev/input node, which does not
/// belong on the main thread (a slow device would freeze the window).
#[tauri::command]
pub async fn evdev_status() -> Result<EvdevStatus, String> {
    tauri::async_runtime::spawn_blocking(|| EvdevStatus {
        available: cfg!(target_os = "linux"),
        permitted: crate::hotkeys::evdev::permitted(),
    })
    .await
    .map_err(|e| e.to_string())
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

    fn set(names: &[&str]) -> std::collections::BTreeSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn input_node_watch_is_due_once_a_new_node_settles() {
        let mut w = InputNodeWatch::default();
        assert_eq!(
            w.observe(set(&["event0", "event1"]), false),
            None,
            "baseline"
        );
        assert_eq!(
            w.observe(set(&["event0", "event1"]), false),
            None,
            "nothing new"
        );
        assert_eq!(
            w.observe(set(&["event0", "event1", "event5"]), false),
            None,
            "appeared: wait a tick"
        );
        assert_eq!(
            w.observe(set(&["event0", "event1", "event5", "event6"]), false),
            None,
            "still settling"
        );
        assert_eq!(
            w.observe(set(&["event0", "event1", "event5", "event6"]), false),
            Some(false),
            "settled: decide"
        );
        assert_eq!(w.pending, set(&["event5", "event6"]));
        w.pending.clear();
        assert_eq!(
            w.observe(set(&["event0", "event1", "event5", "event6"]), false),
            None,
            "only once"
        );
    }

    #[test]
    fn a_seeded_watch_reads_a_node_that_appeared_before_its_first_tick_as_new() {
        // Seeded from setup's pre-apply listing: event5 arrived after that listing but before the
        // first tick, so it is an arrival to probe, not part of the baseline.
        let mut w = InputNodeWatch::seeded(Some(set(&["event0"])));
        assert_eq!(w.observe(set(&["event0", "event5"]), false), None);
        assert_eq!(w.pending, set(&["event5"]));
        assert_eq!(w.observe(set(&["event0", "event5"]), false), Some(false));
        // A failed seed listing: the first tick is the baseline.
        let mut w = InputNodeWatch::seeded(None);
        assert_eq!(w.observe(set(&["event0", "event5"]), false), None);
        assert!(w.pending.is_empty());
    }

    #[test]
    fn input_node_watch_keeps_a_deferred_node_due() {
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0"]), false);
        w.observe(set(&["event0", "event5"]), false);
        assert_eq!(w.observe(set(&["event0", "event5"]), false), Some(false));
        // Deferred (a hold is active): pending is left alone, so the next tick asks again.
        assert_eq!(w.observe(set(&["event0", "event5"]), false), Some(false));
    }

    #[test]
    fn input_node_watch_ignores_removals() {
        let mut w = InputNodeWatch::default();
        assert_eq!(w.observe(set(&["event0", "event1"]), false), None);
        assert_eq!(w.observe(set(&["event0"]), false), None);
        assert_eq!(w.observe(set(&["event0"]), false), None);
        assert_eq!(w.observe(set(&[]), false), None, "every node removed");
        assert_eq!(w.observe(set(&[]), false), None);
    }

    #[test]
    fn input_node_watch_drops_a_node_that_left_before_settling() {
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0"]), false);
        w.observe(set(&["event0", "event5"]), false);
        assert_eq!(w.observe(set(&["event0"]), false), None);
        assert_eq!(
            w.observe(set(&["event0"]), false),
            None,
            "nothing left to probe"
        );
    }

    #[test]
    fn input_node_watch_reports_a_lost_reader_with_the_same_node_set() {
        // The keyboard came back as the same eventN within one tick: the set never changes, the
        // reader-lost flag is the only signal. Acted on the tick after it is first seen.
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0", "event5"]), false);
        assert_eq!(
            w.observe(set(&["event0", "event5"]), true),
            None,
            "grace tick"
        );
        assert_eq!(w.observe(set(&["event0", "event5"]), true), Some(true));
        // The apply bumps evdev's generation, so the flag reads false afterwards.
        assert_eq!(w.observe(set(&["event0", "event5"]), false), None);
    }

    #[test]
    fn input_node_watch_backs_off_a_loss_that_survives_its_reapply() {
        // A keyboard whose reads fail right after every open: the flag stays up across applies.
        let mut w = InputNodeWatch::default();
        let s = || set(&["event0", "event5"]);
        w.observe(s(), false);
        assert_eq!(w.observe(s(), true), None, "grace tick");
        let mut applied_at = Vec::new();
        for tick in 0..40 {
            if w.observe(s(), true) == Some(true) {
                applied_at.push(tick);
                w.note_loss_apply();
            }
        }
        // Waits of 1, 2, 4, 8, 16 ticks between re-applies, not one every tick.
        assert_eq!(applied_at, vec![0, 2, 5, 10, 19, 36]);
        // Once the readers stay up for a sustained run the backoff resets: the next loss is acted
        // on after its grace.
        for _ in 0..LOSS_STABLE_TICKS {
            assert_eq!(w.observe(s(), false), None);
        }
        assert_eq!(w.observe(s(), true), None, "grace tick");
        assert_eq!(w.observe(s(), true), Some(true));
    }

    #[test]
    fn input_node_watch_keeps_backing_off_across_short_clean_gaps() {
        // A keyboard whose stream ends a few seconds after every open: each re-apply buys one
        // clean tick, then the loss is back. The clean tick must not reset the backoff.
        let mut w = InputNodeWatch::default();
        let s = || set(&["event0", "event5"]);
        w.observe(s(), false);
        let mut applied_at = Vec::new();
        let mut since_apply = None::<u32>;
        for tick in 0..80 {
            let lost = since_apply != Some(0);
            if w.observe(s(), lost) == Some(true) {
                applied_at.push(tick);
                w.note_loss_apply();
                since_apply = Some(0);
            } else {
                since_apply = since_apply.map(|n| n + 1);
            }
        }
        // Gaps grow (3, 4, 6, 10, 18, 34 ticks), not a re-apply every third tick.
        assert_eq!(applied_at, vec![1, 4, 8, 14, 24, 42, 76]);
    }

    #[test]
    fn input_node_watch_waits_for_a_lost_keyboard_to_settle() {
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0", "event5"]), false);
        assert_eq!(w.observe(set(&["event0"]), true), None, "removed");
        assert_eq!(w.observe(set(&["event0", "event5"]), true), None, "back");
        assert_eq!(w.observe(set(&["event0", "event5"]), true), Some(true));
    }

    #[test]
    fn input_node_watch_after_apply_drops_what_was_pending() {
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0"]), false);
        w.observe(set(&["event0", "event5"]), false);
        w.after_apply(set(&["event0", "event5"]));
        assert_eq!(w.observe(set(&["event0", "event5"]), false), None);
    }

    #[test]
    fn input_node_watch_after_apply_keeps_nodes_new_since_the_last_tick() {
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0"]), false);
        w.after_apply(set(&["event0", "event7"]));
        assert_eq!(w.observe(set(&["event0", "event7"]), false), Some(false));
    }

    #[test]
    fn input_node_watch_forget_pending_keeps_the_baseline() {
        let mut w = InputNodeWatch::default();
        w.observe(set(&["event0"]), false);
        w.observe(set(&["event0", "event5"]), false);
        w.forget_pending();
        assert_eq!(w.observe(set(&["event0", "event5"]), false), None);
    }

    #[test]
    fn rescan_step_never_restarts_during_a_hold() {
        let probe_panics = || -> bool { panic!("must not probe") };
        assert_eq!(
            rescan_step(true, true, true, probe_panics),
            RescanStep::Defer
        );
        assert_eq!(
            rescan_step(true, true, false, probe_panics),
            RescanStep::Defer
        );
    }

    #[test]
    fn rescan_step_gates_on_intent_and_keyboards() {
        let probe_panics = || -> bool { panic!("must not probe") };
        assert_eq!(
            rescan_step(false, false, true, probe_panics),
            RescanStep::Skip
        );
        assert_eq!(
            rescan_step(true, false, true, probe_panics),
            RescanStep::Apply
        );
        // A mouse / headset node is not a keyboard: no restart.
        assert_eq!(rescan_step(true, false, false, || false), RescanStep::Skip);
        // evdev wanted (running or fallen back to the plugin) and a keyboard arrived.
        assert_eq!(rescan_step(true, false, false, || true), RescanStep::Apply);
    }

    #[test]
    fn bindings_config_falls_back_to_the_last_good_read() {
        let slot = std::sync::Mutex::new(None);
        // No good read yet: an unreadable file is "nothing" (the re-scan keeps pending).
        assert!(read_or_last_good(&slot, || None).is_none());
        let mut good = config::Config::default();
        good.settings.general.evdev_enabled = !good.settings.general.evdev_enabled;
        let wanted = good.settings.general.evdev_enabled;
        let read = read_or_last_good(&slot, move || Some(good)).expect("a good read is returned");
        assert_eq!(read.settings.general.evdev_enabled, wanted);
        // Unreadable mid-session: every reader decides from the last config read, not "nothing".
        let fallback = read_or_last_good(&slot, || None).expect("the last good read");
        assert_eq!(fallback.settings.general.evdev_enabled, wanted);
        // A later good read replaces it.
        let fresh = config::Config::default();
        let fresh_flag = fresh.settings.general.evdev_enabled;
        read_or_last_good(&slot, move || Some(fresh));
        let fallback = read_or_last_good(&slot, || None).expect("the newer good read");
        assert_eq!(fallback.settings.general.evdev_enabled, fresh_flag);
    }

    #[test]
    fn bindings_config_reads_under_the_last_good_lock() {
        // The re-scan and a legacy flag read without APPLY_LOCK: a read taken before the slot's
        // lock could store an older config over the newer one an apply just armed from.
        let slot = std::sync::Mutex::new(None);
        let read = read_or_last_good(&slot, || {
            assert!(
                slot.try_lock().is_err(),
                "the read must run under the slot lock"
            );
            Some(config::Config::default())
        });
        assert!(read.is_some());
    }
}
