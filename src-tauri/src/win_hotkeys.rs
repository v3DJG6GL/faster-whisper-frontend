//! Windows hotkey backend — the Windows twin of `evdev_hotkeys`, built on **two
//! redundant feeds** into one chord matcher: **Raw Input** (`RIDEV_INPUTSINK` on a
//! message-only window) plus an observation-only **`WH_KEYBOARD_LL` hook that is
//! re-installed on every foreground change**.
//!
//! The `global-shortcut` plugin can't register modifier-only chords (the default
//! Ctrl+Shift push-to-talk), left/right-specific modifiers (R-Ctrl), or N-key
//! chords — its accelerators are "modifiers + exactly one key". This backend
//! observes every physical key transition system-wide and can match all of them,
//! with no permissions needed. It is therefore ALWAYS the active backend on
//! Windows (the plugin stays silent — it does everything the plugin can and
//! more), mirroring the evdev-XOR-plugin invariant on Linux.
//!
//! WHY two feeds (the RDP saga): a focused mstsc with keyboard capture ("Apply
//! Windows key combinations" ≠ "On this computer", the fullscreen default)
//! installs a low-level hook that swallows the keys it forwards to the remote —
//! and that silenced BOTH single-feed implementations in turn. LL hooks run
//! newest-first, so a hook installed at app start goes deaf the moment mstsc
//! activates (v0.1.4); and swallowed keys turned out not to reach raw-input
//! sinks either (v0.1.5, user-verified — delivery order vs. the LL chain is
//! undocumented and this is the empirical answer). The fix is the AutoHotkey
//! community's: RE-INSTALL our hook whenever the foreground changes — plus a
//! short per-tick BURST after each change (the foreground event can fire before
//! the activated app installs its own hook) and a slow watchdog re-arm (the OS
//! silently removes hooks it deems slow) — so it always sits ABOVE mstsc's and
//! sees keys before they're swallowed. Raw input stays as the primary feed: it
//! has no watchdog, needs no re-arming, and covers the µs re-arm gaps.
//!
//! The two feeds also patch each other's blind spots: raw input drops
//! `hDevice == 0` events, which besides SendInput can be a precision touchpad or
//! virtual-HID keyboard — the hook sees those as non-injected and keeps them,
//! and it also keeps third-party SendInput chords (see below).
//! Duplicated transitions collapse in the worker's held-set (same dedup that
//! absorbs autorepeat), so double delivery is harmless by construction.
//!
//! The receiver thread only decodes + forwards `(key, down)` transitions over a
//! channel; a worker thread owns the chord-matching state machine — a direct port
//! of `evdev_hotkeys::run_device` — emitting the same `trigger` events. Like
//! evdev, we react only to the configured chords, never swallow keys (both feeds
//! are observation-only by design), and never persist or transmit keys.
//!
//! Injected events: our OWN enigo `SendInput` typing/paste is ignored (raw feed:
//! `hDevice == 0`; hook feed: `LLKHF_INJECTED` + enigo's `EVENT_MARKER` in
//! dwExtraInfo) — tracking it could break a live chord mid-inject or wedge the
//! HeldKeys gate. THIRD-PARTY injected input is honoured via the hook feed:
//! dictation hardware companion apps (Philips SpeechControl for the SpeechMike,
//! foot pedals, AutoHotkey remaps) deliver their configured chord as VK-only
//! SendInput, which is invisible to raw input — without the hook keeping it,
//! such chords could be bound but would never fire. The worker also feeds the
//! shared [`crate::held_keys::HeldKeys`] gate, so `inject_text`'s
//! wait-for-modifier-release works on Windows exactly as it does under evdev.
//!
//! Both feeds report TRANSITIONS, so the worker's held-set is only ever as good as
//! the events it was handed — and a key-up can be missed outright: an RDP client's
//! capture hook sits above ours until the next re-arm (≤3 s in steady state) and
//! swallowed keys reach no raw-input sink either; a desktop switch (Ctrl+Alt+Del,
//! Win+L, a UAC prompt) takes the release to a desktop neither feed is on; and for
//! third-party injected chords the hook is the ONLY feed, so its blind windows have
//! no cover at all. One lost key-up used to strand that key in the held-set for the
//! rest of the listener's life — silently rewiring which chords match (a stranded Alt
//! makes the Alt+Super quick-add chord complete on any Super press) and pinning a
//! phantom modifier in `HeldKeys`, which stalls every injection and can divert every
//! phrase to the clipboard. So the worker RECONCILES: while it believes anything is
//! held it asks the OS directly (`GetAsyncKeyState` — the physical state, above the
//! hook chain and independent of any message queue) and releases what the OS says is
//! up. See `resync_held`.

/// Live listener: the receiver thread's native id (to post it `WM_QUIT`). Dropping
/// it stops forwarding (the worker then drains + cleans up) and tears down the
/// raw-input window.
pub struct Running {
    #[cfg(windows)]
    input_thread_id: u32,
}

impl Drop for Running {
    fn drop(&mut self) {
        #[cfg(windows)]
        imp::shutdown(self.input_thread_id);
    }
}

#[derive(Default)]
pub struct WinHookState(pub std::sync::Mutex<Option<Running>>);

/// Stop the listener (drops Running → stops the worker + the raw-input window).
/// No-op off Windows.
pub fn stop(state: &WinHookState) {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
}

#[cfg(windows)]
pub use imp::{start, stop_held_sessions};

// `start`'s only call site is #[cfg(windows)] (commands::apply_bindings), so unlike
// evdev's stubs it needs no off-platform twin; stop_held_sessions IS called
// unconditionally from the teardown paths, so it keeps one.
#[cfg(not(windows))]
pub fn stop_held_sessions(_app: &tauri::AppHandle) {}

// ── Key mapping ──────────────────────────────────────────────────────────────
// Compiled on every platform (plain data, no Win32 types) so the bindability test
// below runs in the Linux CI leg — the Windows CI leg only does `cargo check`.

/// NumpadEnter shares `VK_RETURN` with the main Enter; the receiver tells them apart
/// by the extended-key flag, which we fold into a synthetic id above the 8-bit VK
/// range so a bound "NumpadEnter" can't fire on plain Enter (and vice versa).
#[cfg_attr(not(windows), allow(dead_code))]
const NUMPAD_ENTER: u16 = 0x0D | 0x0100;

/// Map a binding's `event.code` to a Windows virtual-key id (carrying left/right +
/// AltGr, which arrives as `VK_RMENU`). None if the code isn't mappable. Must cover
/// the same bindable set as `evdev_hotkeys::code_to_key` / keys.ts `codeToToken` —
/// pinned by the test below. One known corner: numpad digits match only with
/// NumLock ON. The capture UI records the PHYSICAL `event.code` ("Numpad4") in either
/// NumLock state, so such a chord binds and validates but stays inert on Windows while
/// NumLock is off (the raw feed then reports the nav VK) — a known Windows-only gap
/// versus evdev, which fires KEY_KP4 regardless.
#[cfg_attr(not(windows), allow(dead_code))]
fn code_to_vk(code: &str) -> Option<u16> {
    let vk = match code {
        "ControlLeft" => 0xA2,    // VK_LCONTROL
        "ControlRight" => 0xA3,   // VK_RCONTROL
        "ShiftLeft" => 0xA0,      // VK_LSHIFT
        "ShiftRight" => 0xA1,     // VK_RSHIFT
        "AltLeft" => 0xA4,        // VK_LMENU
        "AltRight" => 0xA5,       // VK_RMENU (AltGr)
        "MetaLeft" => 0x5B,       // VK_LWIN
        "MetaRight" => 0x5C,      // VK_RWIN
        "Space" => 0x20,          // VK_SPACE
        "Enter" => 0x0D,          // VK_RETURN (non-extended; see NUMPAD_ENTER)
        "Tab" => 0x09,            // VK_TAB
        "Backspace" => 0x08,      // VK_BACK
        "Delete" => 0x2E,         // VK_DELETE
        "Insert" => 0x2D,         // VK_INSERT
        "Home" => 0x24,           // VK_HOME
        "End" => 0x23,            // VK_END
        "PageUp" => 0x21,         // VK_PRIOR
        "PageDown" => 0x22,       // VK_NEXT
        "PrintScreen" => 0x2C,    // VK_SNAPSHOT
        "ArrowUp" => 0x26,        // VK_UP
        "ArrowDown" => 0x28,      // VK_DOWN
        "ArrowLeft" => 0x25,      // VK_LEFT
        "ArrowRight" => 0x27,     // VK_RIGHT
        "NumpadAdd" => 0x6B,      // VK_ADD
        "NumpadSubtract" => 0x6D, // VK_SUBTRACT
        "NumpadMultiply" => 0x6A, // VK_MULTIPLY
        "NumpadDivide" => 0x6F,   // VK_DIVIDE
        "NumpadDecimal" => 0x6E,  // VK_DECIMAL
        "NumpadEnter" => NUMPAD_ENTER,
        "NumpadEqual" => 0x92, // VK_OEM_NEC_EQUAL
        _ => {
            if let Some(l) = code.strip_prefix("Key") {
                return offset_vk(l, b'A', b'Z', 0x41); // VK_A..VK_Z
            }
            if let Some(d) = code.strip_prefix("Digit") {
                return offset_vk(d, b'0', b'9', 0x30); // VK_0..VK_9
            }
            if let Some(n) = code.strip_prefix("Numpad") {
                return offset_vk(n, b'0', b'9', 0x60); // VK_NUMPAD0..9
            }
            if let Some(f) = code.strip_prefix('F') {
                return fn_vk(f);
            }
            return None;
        }
    };
    Some(vk)
}

/// Whether the hook backend can register a chord containing this code
/// (commands::validate_codes' Windows answer).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn code_valid(code: &str) -> bool {
    code_to_vk(code).is_some()
}

/// A single-character suffix in `[lo, hi]` → `base + offset` (letters, digits, and
/// numpad digits are all contiguous VK ranges in ASCII order).
#[cfg_attr(not(windows), allow(dead_code))]
fn offset_vk(s: &str, lo: u8, hi: u8, base: u16) -> Option<u16> {
    match s.as_bytes() {
        [c] if (lo..=hi).contains(c) => Some(base + u16::from(c - lo)),
        _ => None,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn fn_vk(f: &str) -> Option<u16> {
    match f.parse::<u16>() {
        Ok(n @ 1..=24) => Some(0x70 + (n - 1)), // VK_F1..VK_F24
        _ => None,
    }
}

/// Hook-event key id → the evdev keycode the shared inject gate speaks
/// (`held_keys::SHORTCUT_MOD_CODES`). Only the eight shortcut modifiers are
/// mirrored into HeldKeys — they're all the gate ever reads.
#[cfg_attr(not(windows), allow(dead_code))]
fn vk_to_evdev_mod(vk: u16) -> Option<u16> {
    Some(match vk {
        0xA2 => 29,  // VK_LCONTROL → KEY_LEFTCTRL
        0xA3 => 97,  // VK_RCONTROL → KEY_RIGHTCTRL
        0xA0 => 42,  // VK_LSHIFT   → KEY_LEFTSHIFT
        0xA1 => 54,  // VK_RSHIFT   → KEY_RIGHTSHIFT
        0xA4 => 56,  // VK_LMENU    → KEY_LEFTALT
        0xA5 => 100, // VK_RMENU    → KEY_RIGHTALT (AltGr)
        0x5B => 125, // VK_LWIN     → KEY_LEFTMETA
        0x5C => 126, // VK_RWIN     → KEY_RIGHTMETA
        _ => return None,
    })
}

#[cfg(windows)]
mod imp {
    use super::{code_to_vk, vk_to_evdev_mod, Running, WinHookState, NUMPAD_ENTER};
    use crate::chord_engine::{ChordKind, ChordSpec, Engine, Fire};
    use crate::config::{ActivationType, Profile};
    use crate::triggers::TriggerPayload;
    use std::cell::Cell;
    use std::collections::HashSet;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyState};
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
        RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        GetMessageW, KillTimer, PostThreadMessageW, RegisterClassW, SetTimer,
        SetWindowsHookExW, UnhookWindowsHookEx, EVENT_SYSTEM_FOREGROUND, HHOOK, HWND_MESSAGE,
        KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_INJECTED, MSG, RI_KEY_BREAK, RI_KEY_E0,
        RI_KEY_E1, WH_KEYBOARD_LL, WINEVENT_OUTOFCONTEXT, WM_INPUT, WM_KEYDOWN, WM_QUIT,
        WM_SYSKEYDOWN, WM_TIMER, WNDCLASSW,
    };

    /// A physical key transition, forwarded from `hook_proc` to the worker.
    struct KeyEv {
        id: u16,
        down: bool,
    }

    /// The receiver→worker channel. `wndproc` is a bare `extern "system"` fn with no
    /// captures, so it reaches the current sender through this global; start()/
    /// shutdown() swap it. Locked per keystroke — uncontended in steady state.
    static TX: Mutex<Option<Sender<KeyEv>>> = Mutex::new(None);

    /// Build chord specs for every enabled Profile whose hotkey maps cleanly,
    /// plus the quick-add window chord. Equal chords are de-duped (first by config
    /// order wins) so one keypress can't fire two actions. Unmappable / empty skipped.
    /// (Direct port of evdev_hotkeys::chords_from into VK space; the nesting/family
    /// semantics live in the shared crate::chord_engine.)
    fn chords_from(profiles: &[Profile], quick_add_hotkey: &[String]) -> Vec<ChordSpec> {
        const MAX_CHORDS: usize = 256;
        let mut out: Vec<ChordSpec> = Vec::new();
        let mut push = |kind: ChordKind, keys: Vec<u16>, what: &str| {
            // Hard ceiling on the chord set. The dedup below is O(n^2), `Engine::new`'s
            // subset matrix is another, and `Engine::step` then walks every chord on EVERY
            // system-wide key transition — so the profile list, which arrives from the sync
            // blob and is persisted, sizes a hot path. This bound is orders of magnitude above
            // any real binding set, so nothing legitimate is dropped.
            if out.len() >= MAX_CHORDS {
                return;
            }
            // The registration filter: duplicates, and every nesting except the designed
            // hold ⊂ hands-free upgrade, are dropped — first in config order wins. The Settings
            // UI refuses to save these (`conflicts.ts`); this is the same rule for the lists
            // that never pass through it (a sync pull, an import), because the engine cannot
            // make sense of them: two nested holds run two sessions at once, and the inner
            // hold's release then stops the OUTER session at the wrong key.
            let candidate = ChordSpec { keys, kind };
            let clash = out
                .iter()
                .find_map(|c| crate::chord_engine::registration_conflict(c, &candidate));
            match clash {
                Some(why) => tracing::warn!(
                    "[winhook] {what} {why}; ignoring it (the Profiles screen flags this as a conflict)"
                ),
                None => out.push(candidate),
            }
        };
        for p in profiles.iter().filter(|p| p.enabled) {
            let Some(keys) = p.hotkey.iter().map(|c| code_to_vk(c)).collect::<Option<Vec<_>>>() else {
                continue;
            };
            if keys.is_empty() {
                continue;
            }
            let kind = match p.activation {
                ActivationType::Hold => ChordKind::Hold { profile_id: p.id.clone() },
                ActivationType::HandsFree => ChordKind::HandsFree { profile_id: p.id.clone() },
            };
            // `what` is interpolated into the duplicate-chord warning below, so the untrusted id
            // is defanged here rather than at the log line — same reason as `emit`'s.
            push(
                kind,
                keys,
                &format!("profile '{}'", crate::transport::bounded_server_text(&p.id, 120)),
            );
        }
        if let Some(keys) = quick_add_hotkey.iter().map(|c| code_to_vk(c)).collect::<Option<Vec<_>>>() {
            if !keys.is_empty() {
                push(ChordKind::QuickAdd, keys, "the quick-add shortcut");
            }
        }
        out
    }

    pub fn start(app: &AppHandle, state: &WinHookState, profiles: &[Profile], quick_add_hotkey: &[String]) {
        // Hold the state lock across the whole stop→spawn→store sequence so two
        // concurrent apply_bindings() calls can't interleave and leave two live
        // hooks (mirrors evdev_hotkeys::start — see the comment there).
        let mut g = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        *g = None; // drop any previous Running → old worker drains + old hook unhooks
        // Fresh start: drop any held-key counts left over from a previous run so the
        // inject-gate can't wait on a phantom modifier — and retire the old worker's writer,
        // so its late post-loop decrements (it wakes AFTER this) can't zero counts the new
        // worker is about to record (see HeldKeys::clear).
        let held_keys = app.state::<crate::held_keys::HeldKeys>();
        held_keys.clear();
        let held_keys = held_keys.writer();
        let chords = chords_from(profiles, quick_add_hotkey);
        if chords.is_empty() {
            tracing::info!("[winhook] no mappable chords; not starting");
            return; // guard drops → lock released; *g stays None (no listener)
        }
        let n_chords = chords.len();

        let (tx, rx) = channel::<KeyEv>();
        // Install the sender BEFORE the hook goes live so no transition is dropped.
        // A just-stopped previous hook may forward its last few events here for a
        // moment — benign: transitions are idempotent on the worker's held-set.
        if let Ok(mut t) = TX.lock() {
            *t = Some(tx);
        }
        let worker_app = app.clone();
        let _ = std::thread::Builder::new()
            .name("win-hotkeys-match".into())
            .spawn(move || worker(worker_app, held_keys, rx, Engine::new(chords)));

        let (ready_tx, ready_rx) = channel::<Option<u32>>();
        let abandoned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let abandoned_thread = abandoned.clone();
        let _ = std::thread::Builder::new()
            .name("win-hotkeys-input".into())
            .spawn(move || input_thread(&ready_tx, &abandoned_thread));
        match ready_rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(Some(tid)) => {
                tracing::info!("[winhook] raw-input listener up ({n_chords} chord(s))");
                *g = Some(Running { input_thread_id: tid });
            }
            ready => {
                // Two different investigations share one teardown: a refused raw-input
                // registration (driver / permission) vs. a setup that HUNG (CreateWindowExW /
                // SetWinEventHook wedged). Name them apart in the support log.
                match ready {
                    Ok(None) => tracing::warn!(
                        "[winhook] raw keyboard input setup failed (message window or RegisterRawInputDevices) — hotkeys are OFF"
                    ),
                    _ => tracing::warn!(
                        "[winhook] raw-input listener didn't report ready within 2 s — abandoning it; hotkeys are OFF"
                    ),
                }
                // On the timeout arm no Running was stored, so Running::drop can never
                // reach the thread — a slow setup would otherwise leave it pumping (and
                // re-arming a global LL hook) for the process lifetime, one zombie per
                // apply_bindings. Tell it to tear itself down: the 250 ms re-arm timer wakes
                // it within one tick, or — if SetTimer failed (warned in input_thread) — the
                // next raw-input message does, so on a fully idle machine the teardown can be
                // deferred until someone presses a key.
                abandoned.store(true, std::sync::atomic::Ordering::Relaxed);
                if let Ok(mut t) = TX.lock() {
                    *t = None; // ends the worker
                }
            }
        }
    }

    /// Stop this backend: stop forwarding (the worker drains its backlog, releases
    /// its HeldKeys contributions, and stops any still-held PTT session), then wake
    /// the receiver's GetMessageW so it destroys its window and exits. Called from
    /// Running::drop. Not joined: the residual double-forwarding window is µs-scale
    /// and idempotent (see start()).
    pub(super) fn shutdown(input_thread_id: u32) {
        if let Ok(mut t) = TX.lock() {
            *t = None;
        }
        unsafe {
            PostThreadMessageW(input_thread_id, WM_QUIT, 0, 0);
        }
    }

    /// The raw-input receiver: a message-only window registered for keyboard raw
    /// input with `RIDEV_INPUTSINK` (delivery regardless of foreground — this is
    /// what keeps chords alive while an RDP client is focused; see module docs),
    /// pumping messages until shutdown posts WM_QUIT.
    fn input_thread(ready: &Sender<Option<u32>>, abandoned: &std::sync::atomic::AtomicBool) {
        unsafe {
            let class_name: Vec<u16> = "fwf-raw-input\0".encode_utf16().collect();
            let hinstance = GetModuleHandleW(std::ptr::null());
            // Idempotent across backend restarts in one process: re-registering the
            // same class fails harmlessly (CreateWindowExW then uses the existing one).
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            let _ = RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE, // message-only: never visible, no taskbar, just a raw-input sink
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                let _ = ready.send(None);
                return;
            }
            let rid = RAWINPUTDEVICE {
                usUsagePage: 0x01, // Generic Desktop
                usUsage: 0x06,     // Keyboard
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            };
            if RegisterRawInputDevices(&rid, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32) == 0 {
                DestroyWindow(hwnd);
                let _ = ready.send(None);
                return;
            }
            // Second feed: the observation LL hook, re-armed on every foreground
            // change so it stays above mstsc's capture hook (see module docs).
            // Both the WinEvent callback and WM_TIMER fire on THIS thread (its
            // message pump), so the hook handle can live in a thread-local.
            arm_ll_hook();
            let fg_hook: HWINEVENTHOOK = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(fg_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            let timer = SetTimer(std::ptr::null_mut(), 0, TICK_MS, None);
            if timer == 0 {
                // Without the tick there is no burst and no watchdog: the hook is armed once,
                // here, and never re-installed — so the first RDP/VM client to install a
                // capture hook silences this feed permanently. Nothing recovers it short of a
                // rebind, so it has to be visible in the support log.
                tracing::warn!("[winhook] no re-arm timer; the keyboard hook will never be re-installed above a capture hook");
            }
            let _ = ready.send(Some(GetCurrentThreadId()));
            // WM_INPUT arrives here and is routed to wndproc by DispatchMessageW.
            // Returns 0 on the WM_QUIT posted by shutdown(), -1 on error.
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if abandoned.load(std::sync::atomic::Ordering::Relaxed) {
                    break; // start() gave up on us; fall through to the cleanup below
                }
                // The re-arm timer targets no window (thread message) — handle it
                // here; DispatchMessageW would drop it.
                if msg.message == WM_TIMER && msg.hwnd.is_null() {
                    on_rearm_tick();
                    continue;
                }
                DispatchMessageW(&msg);
            }
            if timer != 0 {
                KillTimer(std::ptr::null_mut(), timer);
            }
            if !fg_hook.is_null() {
                UnhookWinEvent(fg_hook);
            }
            disarm_ll_hook();
            // Destroying the target window ends raw-input delivery; the class is
            // left registered for the next start (see above).
            DestroyWindow(hwnd);
        }
    }

    /// Re-arm scheduling. The timer ticks every TICK_MS; normally we only re-arm
    /// every WATCHDOG_TICKS ticks (silent-removal insurance — each re-arm has a
    /// µs blind gap, so steady-state re-arms are kept rare). A foreground change
    /// arms immediately AND starts a BURST of per-tick re-arms: the
    /// EVENT_SYSTEM_FOREGROUND callback can run BEFORE the newly-activated app
    /// (mstsc) finishes installing its own capture hook, so the immediate re-arm
    /// alone can lose the newest-hook race — the burst covers the late install.
    const TICK_MS: u32 = 250;
    const BURST_TICKS: u32 = 6; // per-tick re-arms for 1.5 s after a fg change
    const WATCHDOG_TICKS: u32 = 12; // steady-state re-arm every 3 s

    thread_local! {
        /// The LL hook installed by THIS thread (0 = none). Thread-local, not a
        /// global: across an apply_bindings restart the old input thread's late
        /// cleanup must not tear down the hook the new thread just armed. A hook
        /// only fires while its owning thread pumps, so each thread manages its own.
        static LL_HOOK: Cell<isize> = const { Cell::new(0) };
        /// Remaining burst re-arms (set by fg_changed, consumed per tick).
        static BURST: Cell<u32> = const { Cell::new(0) };
        /// Ticks since the last steady-state re-arm.
        static TICKS: Cell<u32> = const { Cell::new(0) };
        /// Whether the last install attempt failed — the WARN is logged once per transition
        /// into that state, not once per 250 ms tick (a persistent failure otherwise wrote
        /// ~1200 lines an hour into the support log).
        static HOOK_FAILED: Cell<bool> = const { Cell::new(false) };
    }

    /// One timer tick: burst re-arm after a recent foreground change, else the
    /// slow watchdog re-arm.
    fn on_rearm_tick() {
        let bursting = BURST.with(|b| {
            let v = b.get();
            if v > 0 {
                b.set(v - 1);
            }
            v > 0
        });
        if bursting {
            arm_ll_hook();
            return;
        }
        let due = TICKS.with(|t| {
            let v = t.get() + 1;
            if v >= WATCHDOG_TICKS {
                t.set(0);
                true
            } else {
                t.set(v);
                false
            }
        });
        if due {
            arm_ll_hook();
        }
    }

    /// (Re-)install the observation hook so it is the NEWEST — LL hooks run
    /// newest-first, and mstsc's capture hook (installed when its window
    /// activates) swallows keys from every hook below it. Gapless: the new hook
    /// goes in BEFORE the old one comes out — during RDP capture the raw feed is
    /// silenced, so an unhook→rehook gap would drop keys with no cover; the brief
    /// double-hook overlap only duplicates events, which the worker's held-set
    /// collapses anyway.
    fn arm_ll_hook() {
        LL_HOOK.with(|h| unsafe {
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(ll_hook_proc),
                GetModuleHandleW(std::ptr::null()),
                0,
            );
            // A FAILED install (desktop switch in flight, hook-table pressure) must not cost
            // us the hook we already have. The old code stored the null and unhooked the
            // working one regardless, which took the feed down for a whole watchdog period on
            // top of whatever caused the failure — the exact blind window this function
            // exists to close. Keep the incumbent; the next tick tries again.
            if hook.is_null() {
                if !HOOK_FAILED.replace(true) {
                    tracing::warn!("[winhook] could not re-arm the keyboard hook; keeping the current one (retrying every tick, logged once)");
                }
                return;
            }
            if HOOK_FAILED.replace(false) {
                tracing::info!("[winhook] keyboard hook re-armed after a failed attempt");
            }
            let prev = h.replace(hook as isize);
            if prev != 0 {
                UnhookWindowsHookEx(prev as HHOOK);
            }
        });
    }

    fn disarm_ll_hook() {
        LL_HOOK.with(|h| unsafe {
            let prev = h.replace(0);
            if prev != 0 {
                UnhookWindowsHookEx(prev as HHOOK);
            }
        });
    }

    /// EVENT_SYSTEM_FOREGROUND → re-arm now so whatever hook the newly-activated
    /// app installs (mstsc's capture hook) ends up BELOW ours — and start the
    /// burst, because this callback can beat the app's own hook install (see
    /// the scheduling constants).
    unsafe extern "system" fn fg_changed(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _id_event_thread: u32,
        _time: u32,
    ) {
        arm_ll_hook();
        BURST.with(|b| b.set(BURST_TICKS));
        TICKS.with(|t| t.set(0));
    }

    /// The observation hook: forward key transitions (physical + third-party
    /// injected, minus our own enigo events) to the worker (same channel as the
    /// raw feed; the worker's held-set collapses duplicates) and ALWAYS pass the
    /// key on — this backend never swallows input. Kept trivial: the OS silently
    /// removes hooks that dawdle past its timeout.
    unsafe extern "system" fn ll_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == 0 {
            // HC_ACTION
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            // LLKHF_INJECTED = SendInput. Drop only OUR OWN synthetic input —
            // enigo tags its events with EVENT_MARKER in dwExtraInfo (inject.rs
            // typing/paste, quickadd's win_seed grab); tracking those could break
            // a live chord mid-inject, wedge the HeldKeys gate, or self-trigger a
            // chord matching the paste shortcut. THIRD-PARTY injected input is
            // kept: dictation hardware (SpeechMike-style companion apps, AutoHotkey
            // remaps) sends its configured chord via VK-only SendInput, and the raw
            // feed can never see it (hDevice == 0) — this hook is its only path.
            let own_inject = kb.flags & LLKHF_INJECTED != 0
                && kb.dwExtraInfo == enigo::EVENT_MARKER as usize;
            if !own_inject {
                if let Some(id) = ll_key_id(kb.vkCode, kb.scanCode, kb.flags) {
                    let down = wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize;
                    if let Ok(g) = TX.lock() {
                        if let Some(tx) = g.as_ref() {
                            let _ = tx.send(KeyEv { id, down });
                        }
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// KBDLLHOOKSTRUCT → the same chord id space as `key_id` (the raw decoder).
    /// The hook layer already reports left/right-resolved modifier VKs and
    /// NumLock-translated numpad VKs; only the kbd-layer phantoms and the
    /// Enter/NumpadEnter split need handling (plus a defensive generic-VK
    /// resolve, mirroring the raw path, in case a driver reports them).
    fn ll_key_id(vk: u32, scan: u32, flags: u32) -> Option<u16> {
        // Keyboard-layer PHANTOMS carry the kbd.h SCANCODE_SIMULATED bit (0x200):
        // AltGr's fake LCtrl (0x21D, German/Swiss layouts — must never read as
        // "Ctrl held" to a chord or the HeldKeys gate) and the fake Shift break/
        // make pair wrapped around NumLock-overridden numpad keys (0x22A/0x236 —
        // forwarding those would release a held Ctrl+Shift PTT mid-dictation the
        // moment a numpad key is typed). Never physical; the raw feed reports
        // these with VKey 0xFF, which it already drops.
        if scan & 0x200 != 0 {
            return None;
        }
        let extended = flags & LLKHF_EXTENDED != 0;
        Some(match vk as u16 {
            // Overrun/prefix marker — also mstsc's synthetic activation marker.
            0xFF => return None,
            0x10 => {
                if scan == 0x36 {
                    0xA1 // VK_RSHIFT
                } else {
                    0xA0 // VK_LSHIFT
                }
            }
            0x11 => {
                if extended {
                    0xA3 // VK_RCONTROL
                } else {
                    0xA2 // VK_LCONTROL
                }
            }
            0x12 => {
                if extended {
                    0xA5 // VK_RMENU (AltGr)
                } else {
                    0xA4 // VK_LMENU
                }
            }
            // Enter vs NumpadEnter share VK_RETURN; the numpad one is extended.
            0x0D => {
                if extended {
                    NUMPAD_ENTER
                } else {
                    0x0D
                }
            }
            other => other,
        })
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_INPUT {
            let mut raw: RAWINPUT = std::mem::zeroed();
            let mut size = std::mem::size_of::<RAWINPUT>() as u32;
            let got = GetRawInputData(
                lparam as HRAWINPUT,
                RID_INPUT,
                &mut raw as *mut RAWINPUT as *mut core::ffi::c_void,
                &mut size,
                std::mem::size_of::<RAWINPUTHEADER>() as u32,
            );
            if got != u32::MAX && raw.header.dwType == RIM_TYPEKEYBOARD {
                // hDevice == 0 marks INJECTED input (SendInput — incl. our own enigo
                // typing): tracking it could break a live chord mid-inject or wedge
                // the HeldKeys gate. The check is over-broad (precision touchpads /
                // virtual-HID keyboards, and third-party injectors like dictation-
                // hardware companion apps, all report hDevice == 0) — those keys
                // still arrive via the hook feed, which drops only events carrying
                // our own enigo dwExtraInfo marker.
                if !raw.header.hDevice.is_null() {
                    let kb = raw.data.keyboard;
                    if let Some(id) = key_id(kb.VKey, kb.MakeCode, kb.Flags as u32) {
                        let down = kb.Flags as u32 & RI_KEY_BREAK == 0;
                        if let Ok(g) = TX.lock() {
                            if let Some(tx) = g.as_ref() {
                                let _ = tx.send(KeyEv { id, down });
                            }
                        }
                    }
                }
            }
            // Fall through to DefWindowProc for cleanup (raw input is observation-
            // only: nothing we do here can swallow the key from the focused app).
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// RAWKEYBOARD → the chord id space of `code_to_vk` (left/right-specific VKs,
    /// NUMPAD_ENTER synthetic). None = not a key transition we track.
    fn key_id(vkey: u16, make_code: u16, flags: u32) -> Option<u16> {
        let e0 = flags & RI_KEY_E0 as u32 != 0;
        Some(match vkey {
            // Overrun / prefix marker — never a real key.
            0xFF => return None,
            // Raw input reports the GENERIC modifier VKs; resolve the side from the
            // scan code (Shift) or the E0 flag (Ctrl/Alt), per RAWKEYBOARD docs.
            0x10 => {
                if make_code == 0x36 {
                    0xA1 // VK_RSHIFT
                } else {
                    0xA0 // VK_LSHIFT
                }
            }
            0x11 => {
                // Defensive: if a message-layer fake AltGr companion ever shows up in
                // raw input it carries the 0x21D scan / E1 marking — drop it (AltGr
                // must be a lone RAlt, evdev parity; normally it never reaches here).
                if make_code == 0x21D || flags & RI_KEY_E1 as u32 != 0 {
                    return None;
                }
                if e0 {
                    0xA3 // VK_RCONTROL
                } else {
                    0xA2 // VK_LCONTROL
                }
            }
            0x12 => {
                if e0 {
                    0xA5 // VK_RMENU (AltGr)
                } else {
                    0xA4 // VK_LMENU
                }
            }
            // Enter vs NumpadEnter share VK_RETURN; the numpad one is E0.
            0x0D => {
                if e0 {
                    NUMPAD_ENTER
                } else {
                    0x0D
                }
            }
            // Numpad digits: some driver stacks report the NAV VKey for numpad keys
            // even with NumLock ON (raw input is pre-translation). E0 CLEAR = the key
            // is physically on the numpad — map it to VK_NUMPADx / VK_DECIMAL when
            // NumLock is on, so a "Numpad4" binding fires like it does under a browser
            // capture. E0 set = the dedicated nav key — keep it. NumLock off keeps the
            // nav VKey: a saved Numpad-digit chord (the capture UI records the physical
            // "Numpad4" regardless of NumLock) is then inert until NumLock comes back on.
            0x0C | 0x21..=0x28 | 0x2D | 0x2E if !e0 && numlock_on() => numpad_from_scan(make_code)?,
            other => other,
        })
    }

    /// NumLock toggle state (low bit of GetKeyState is the toggle).
    fn numlock_on() -> bool {
        unsafe { GetKeyState(0x90) & 1 != 0 } // VK_NUMLOCK
    }

    /// Numpad scan codes (E0 clear) → VK_NUMPAD0..9 / VK_DECIMAL.
    fn numpad_from_scan(make_code: u16) -> Option<u16> {
        Some(match make_code {
            0x52 => 0x60, // KP0
            0x4F => 0x61, // KP1
            0x50 => 0x62, // KP2
            0x51 => 0x63, // KP3
            0x4B => 0x64, // KP4
            0x4C => 0x65, // KP5
            0x4D => 0x66, // KP6
            0x47 => 0x67, // KP7
            0x48 => 0x68, // KP8
            0x49 => 0x69, // KP9
            0x53 => 0x6E, // KP. (VK_DECIMAL)
            _ => return None,
        })
    }

    /// `chord_mods` = the firing chord's OWN modifier keycodes, already translated into the
    /// `held_keys` (evdev) namespace by the caller. This backend feeds `HeldKeys` and is always
    /// the registrar on Windows, so without the snapshot `inject_text`'s held-modifier gate was
    /// dead here — see `triggers::snapshot_trigger_mods`. Empty for a teardown-emitted stop.
    fn emit(app: &AppHandle, profile_id: &str, action: &str, chord_mods: Option<&[u16]>) {
        // `None` = a teardown-emitted stop, which is not a user chord release: leave the existing
        // snapshot alone rather than clearing it, so a stop that follows a real chord press by
        // milliseconds cannot wipe the very modifiers the gate needs to see.
        if let Some(mods) = chord_mods {
            crate::triggers::snapshot_trigger_mods(app, mods);
        }
        // Log every fired trigger (same shape as the CLI path's emit_trigger): the chord →
        // session causality is otherwise invisible in the log, which made the key-chatter
        // instant-stop bug diagnosable only by timing forensics.
        // Defanged for the same reason as the evdev twin, and this is the platform where it
        // matters most: the Windows support log is the artifact users are asked to send.
        let profile_id_log = crate::transport::bounded_server_text(profile_id, 120);
        tracing::info!("[trigger] {profile_id_log}/{action} (winhook)");
        let _ = app.emit(
            "trigger",
            TriggerPayload { profile_id: profile_id.to_string(), action: action.to_string() },
        );
    }

    // PTT (Hold) chords currently emitting "start", each with the VKs of the chord that
    // started it. A teardown (rebind capture, apply_bindings restart) must emit the "stop"
    // a mid-hold session would otherwise lose — see stop_held_sessions and
    // evdev_hotkeys::ACTIVE_HOLDS. The keys are what lets the teardown ask the OS whether
    // that chord is STILL physically down before it arms the loss latch on it.
    static ACTIVE_HOLDS: Mutex<Vec<(String, Vec<u16>)>> = Mutex::new(Vec::new());

    fn note_hold(profile_id: &str, keys: &[u16], active: bool) {
        if let Ok(mut h) = ACTIVE_HOLDS.lock() {
            h.retain(|(p, _)| p != profile_id);
            if active {
                h.push((profile_id.to_string(), keys.to_vec()));
            }
        }
    }

    /// Is any shortcut MODIFIER of the chord still physically down, per the OS? Empty = no.
    /// See `chord_engine::any_chord_mod_down` for why it is "any modifier", not "all keys".
    fn chord_mod_still_down(keys: &[u16]) -> bool {
        crate::chord_engine::any_chord_mod_down(keys, |k| vk_to_evdev_mod(k).is_some(), physically_down)
    }

    /// The manufactured-stop rule, shared by both teardown sites: emit the stop, and arm the
    /// loss latch ONLY if a modifier of the chord is still physically down. The latch exists for
    /// exactly one situation — the teardown is about to wipe the map that proves the chord is
    /// held, and the injection that follows must not type into it. A chord the OS reports fully
    /// UP is not that situation: the user released it (its key-up was parked in the debouncer,
    /// or lost outright), so the injection is safe to type — and arming anyway diverted the next
    /// phrase to the clipboard, silently, on a control that is designed never to produce a false
    /// positive. A chord with ONE modifier still down IS that situation (a staggered release),
    /// so the predicate fails toward arming.
    fn manufactured_stop(app: &AppHandle, profile_id: &str, keys: &[u16]) {
        if chord_mod_still_down(keys) {
            crate::held_keys::arm_chord_lost();
        } else {
            tracing::info!("[winhook] teardown stop for a chord the OS reports released; not arming the loss latch");
        }
        emit(app, profile_id, "stop", None);
    }

    /// Remove `profile_id` from ACTIVE_HOLDS, reporting whether it was present.
    /// Unlike evdev's abort()'d readers, this worker DOES run its post-loop cleanup
    /// on teardown — so its "stop" must be claim-based to fire at most once even
    /// when a teardown's stop_held_sessions() already emitted it (a late duplicate
    /// could otherwise kill a session the user re-triggered in between).
    fn take_hold(profile_id: &str) -> bool {
        let Ok(mut h) = ACTIVE_HOLDS.lock() else {
            return false;
        };
        let had = h.iter().any(|(p, _)| p == profile_id);
        h.retain(|(p, _)| p != profile_id);
        had
    }

    /// Emit "stop" for every PTT chord still held, then clear the set — so a session
    /// held across a listener teardown isn't wedged "listening". No-op when idle.
    pub fn stop_held_sessions(app: &AppHandle) {
        let stuck = ACTIVE_HOLDS
            .lock()
            .map(|mut h| std::mem::take(&mut *h))
            .unwrap_or_default();
        for (profile_id, keys) in stuck {
            // `None` chord mods = a stop we MANUFACTURED, not a user chord release; the loss
            // latch is armed only when the chord is genuinely still down — see manufactured_stop.
            manufactured_stop(app, &profile_id, &keys);
        }
    }

    /// Commit one debounced key transition: update the held-set + the HeldKeys
    /// mirror, step the engine, dispatch its fires. (The pre-debounce body of the
    /// worker loop, factored out so deferred releases commit through the same path.)
    ///
    /// `teardown`: the post-loop drain of parked releases. `stop_held_sessions` may already have
    /// manufactured (and CLAIMED, via `take_hold`) the stop for a hold this release ends —
    /// `apply_bindings` calls it before the old listener is dropped — so a teardown Stop is
    /// emitted only if the hold is still unclaimed, and with no chord mods: HeldKeys was wiped by
    /// the successor's start, so a snapshot taken here would clear a fresh session's trigger mods.
    fn commit(
        app: &AppHandle,
        held_keys: &crate::held_keys::HeldKeysWriter,
        held: &mut HashSet<u16>,
        engine: &mut Engine,
        id: u16,
        down: bool,
        teardown: bool,
    ) {
        // Windows auto-repeats WM_KEYDOWN while a key is held; the held-set
        // insert dedups them (mirrors evdev skipping value == 2 autorepeat).
        let changed = if down { held.insert(id) } else { held.remove(&id) };
        if !changed {
            return;
        }
        if let Some(code) = vk_to_evdev_mod(id) {
            held_keys.set(code, down);
        }

        let fires = engine.step(held, std::time::Instant::now());
        // This backend's chord keys are VKs; `held_keys` is the shared evdev namespace, so the
        // projection goes through the same translation `commit` uses above.
        let chord_mods = |pid: &str| -> Vec<u16> {
            engine
                .keys_for_profile(pid)
                .into_iter()
                .filter_map(vk_to_evdev_mod)
                .collect()
        };
        for fire in fires {
            match fire {
                Fire::Start(pid) => {
                    // A fresh rising edge: this press IS in the map, so the still-held check
                    // works normally for it and any pending loss latch is now a dud.
                    crate::held_keys::clear_chord_lost();
                    emit(app, &pid, "start", Some(&chord_mods(&pid)));
                    note_hold(&pid, &engine.keys_for_profile(&pid), true);
                }
                Fire::Stop(pid) => {
                    if teardown {
                        if take_hold(&pid) {
                            emit(app, &pid, "stop", None);
                        }
                    } else {
                        emit(app, &pid, "stop", Some(&chord_mods(&pid)));
                        note_hold(&pid, &[], false);
                    }
                }
                // Handoff: the hold's session lives on under the superset —
                // release the teardown bookkeeping, emit no "stop".
                Fire::ReleaseHold(pid) => note_hold(&pid, &[], false),
                Fire::Toggle(pid) => {
                    // A fresh rising edge: this press IS in the map, so the still-held check
                    // works normally for it and any pending loss latch is now a dud.
                    crate::held_keys::clear_chord_lost();
                    emit(app, &pid, "toggle", Some(&chord_mods(&pid)));
                }
                Fire::Reclassify(pid) => {
                    // Same rising edge, same reason as Start/Toggle above: the engine fires
                    // Reclassify only on the hands-free chord's own physical completion (`on &&
                    // !active[i]`), so this press IS in the map and the still-held check works
                    // normally for it — which makes any pending loss latch a dud. It was the one
                    // fire of the three that did not clear it, and it CONTINUES a live session
                    // into hands-free mode, so an injection follows it. Reachable on the ordinary
                    // multi-keyboard setup: keyboard A's stream dies with a hold active and its
                    // post-loop arms the latch, keyboard B's separate engine still has that hold,
                    // and completing the hands-free superset on B otherwise consumed the stale latch
                    // (TTL 130s) and diverted the phrase to the clipboard.
                    crate::held_keys::clear_chord_lost();
                    emit(app, &pid, "reclassify", Some(&chord_mods(&pid)))
                }
                Fire::OpenQuickAdd => crate::quickadd::show(app),
            }
        }
    }

    /// Is `id` physically down right now, straight from the OS?
    ///
    /// `GetAsyncKeyState`'s high bit is the real, current keyboard state: it is maintained
    /// above the hook chain and independently of any message queue, so it can arbitrate a
    /// held-set the hook chain may have lied to. `quickadd::win_seed` already leans on the
    /// same authority for the same reason before it injects.
    ///
    /// `id & 0xFF` strips the synthetic extended bit we fold into NumpadEnter: the OS knows
    /// only `VK_RETURN`, which covers both Enters — and "VK_RETURN is up" is true of each of
    /// them, which is all `resync_held` asks. The other caller, `chord_mod_still_down`, asks
    /// the opposite question but only about MODIFIERS, which carry no synthetic bit, so the
    /// aliasing (an Enter-bound chord reading "down" because the OTHER Enter is held) never
    /// reaches an arm/don't-arm decision.
    fn physically_down(id: u16) -> bool {
        unsafe { GetAsyncKeyState((id & 0x00FF) as i32) as u16 & 0x8000 != 0 }
    }

    /// How often the worker re-asks the OS about the keys it believes are held. Only
    /// *scheduled* while the held-set is non-empty — an idle worker blocks in `rx.recv()` with
    /// no deadline and polls nothing; a wake-up past the deadline still calls it once with an
    /// empty held-set to clear stale first strikes.
    const RESYNC_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

    /// Release every key the held-set still carries that the OS says is UP — the repair for a
    /// key-up neither feed ever saw (see the module header for how that happens).
    ///
    /// Deliberately covers the WHOLE held-set, not just chord keys: a stranded non-chord
    /// modifier changes no match, but it pins a phantom count in `HeldKeys`, which stalls every
    /// injection on the release gate and — when it belongs to a bound chord — diverts every
    /// phrase to the clipboard for the process lifetime.
    ///
    /// A key must read UP on TWO consecutive polls before it is released. A genuine release
    /// commits through the event path within RELEASE_DEBOUNCE, so nothing legitimate ever
    /// reaches the second poll; the confirmation only costs a repair ≤250 ms, and it buys one
    /// poll of slack against a transient bad read. Known gap: while the process is off the
    /// input desktop (secure desktop, lock screen, a UAC prompt) `GetAsyncKeyState` may read
    /// every key UP for the whole switch, which outlasts two polls — a chord held across such a
    /// switch is released, ending its push-to-talk session. `up_once` carries the first strike
    /// between calls.
    fn resync_held(
        app: &AppHandle,
        held_keys: &crate::held_keys::HeldKeysWriter,
        held: &mut HashSet<u16>,
        engine: &mut Engine,
        up_once: &mut HashSet<u16>,
    ) {
        let up_now: HashSet<u16> = held.iter().copied().filter(|&id| !physically_down(id)).collect();
        // Retain-then-swap: only keys up on BOTH polls are acted on.
        let confirmed: Vec<u16> = up_once.intersection(&up_now).copied().collect();
        *up_once = up_now;
        for id in confirmed {
            up_once.remove(&id);
            tracing::warn!(
                "[winhook] key {id:#06x} is up per the OS but no key-up ever arrived — releasing it \
                 (a capture hook or a desktop switch ate the release)"
            );
            commit(app, held_keys, held, engine, id, false, false);
        }
    }

    /// The chord-matching worker — the twin of `evdev_hotkeys::run_device` (one
    /// instance, fed by the hook instead of per-device streams). All chord
    /// semantics (hold edges, hands-free re-arm, family handoff, peer arbitration) live in the
    /// shared crate::chord_engine. Runs until the sender is dropped (shutdown/
    /// restart), then releases its HeldKeys contributions and stops any live
    /// Hold session.
    fn worker(
        app: AppHandle,
        held_keys: crate::held_keys::HeldKeysWriter,
        rx: Receiver<KeyEv>,
        mut engine: Engine,
    ) {
        // `held_keys` mirrors physical modifier state into the shared signal `inject_text`
        // reads, so we never type into a still-held trigger modifier (see crate::held_keys).
        // It is this start's writer: once a later start has cleared the map, our writes —
        // including the post-loop's decrements below — are dropped rather than landing on
        // our successor's counts.
        let mut held: HashSet<u16> = HashSet::new();
        // Chatter filter: key-ups for held keys are deferred RELEASE_DEBOUNCE and
        // erased if the key comes back down in the window (a worn-switch bounce fed
        // straight through here fired Stop+Start and killed the session instantly —
        // see key_debounce). Downs commit immediately; deferred ups commit via the
        // recv_timeout deadline below.
        let mut deb = crate::key_debounce::Debouncer::new(crate::key_debounce::RELEASE_DEBOUNCE);
        // First strikes for the held-set reconciler (see resync_held).
        let mut up_once: HashSet<u16> = HashSet::new();
        let mut next_resync = std::time::Instant::now() + RESYNC_INTERVAL;

        loop {
            // Wake for whichever comes first: a due deferred release, or the next
            // reconciliation. The reconciler is scheduled ONLY while we believe something is
            // held — with an empty held-set there is nothing to repair and the worker goes
            // back to blocking indefinitely on the channel, exactly as before.
            let deadline = match (deb.next_deadline(), (!held.is_empty()).then_some(next_resync)) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let ev = match deadline {
                None => match rx.recv() {
                    Ok(e) => Some(e),
                    Err(_) => break, // sender dropped (shutdown/restart)
                },
                Some(dl) => {
                    let wait = dl.saturating_duration_since(std::time::Instant::now());
                    match rx.recv_timeout(wait) {
                        Ok(e) => Some(e),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            };
            let now = std::time::Instant::now();
            // Due deferred releases first, so a real release always commits before
            // whatever event (if any) woke us.
            for key in deb.expire(now) {
                commit(&app, &held_keys, &mut held, &mut engine, key, false, false);
            }
            if now >= next_resync {
                next_resync = now + RESYNC_INTERVAL;
                // Called even when nothing is held (an event can wake us before the deadline
                // we skipped scheduling): it then simply clears any stale first strike, so a
                // key pressed later always gets its own two polls.
                resync_held(&app, &held_keys, &mut held, &mut engine, &mut up_once);
            }
            if let Some(ev) = ev {
                if let Some((k, d)) = deb.on_event(ev.id, ev.down, held.contains(&ev.id), now) {
                    commit(&app, &held_keys, &mut held, &mut engine, k, d, false);
                }
            }
        }
        // Channel closed (backend stopped or replaced). First commit every release still parked
        // in the debouncer: those keys ARE released, and a hold whose release is parked here
        // would otherwise still read as active below and get a manufactured stop — with the loss
        // latch armed on a chord the user let go of, which diverted the next phrase to the
        // clipboard. Through `commit` in teardown mode: the HeldKeys decrement and the engine
        // step happen exactly as if the window had elapsed a moment earlier, and the Stop is
        // CLAIMED via take_hold — stop_held_sessions runs before this listener is dropped on the
        // rebind/sync-pull path and may already have emitted it.
        for key in deb.drain() {
            commit(&app, &held_keys, &mut held, &mut engine, key, false, true);
        }
        // Release our remaining HeldKeys contributions so a stale modifier can't wedge the
        // inject gate…
        for &id in &held {
            if let Some(code) = vk_to_evdev_mod(id) {
                held_keys.set(code, false);
            }
        }
        // …and stop any push-to-talk session still active, claim-based (take_hold)
        // so a stop already emitted by stop_held_sessions() isn't doubled onto a
        // session the user re-triggered meanwhile.
        for pid in engine.active_holds() {
            if take_hold(&pid) {
                manufactured_stop(&app, &pid, &engine.keys_for_profile(&pid));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // Every key a user can bind via the UI (src/lib/keys.ts `codeToToken` +
    // MODIFIER_CODES) MUST map here, or its chord is silently dropped on Windows
    // while still binding fine in the capture UI. Pins the same bindability matrix
    // as evdev_hotkeys' twin test — keep all three lists in sync.
    #[test]
    fn every_bindable_code_maps_to_a_windows_vk() {
        let mut codes: Vec<String> = [
            "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
            "AltLeft", "AltRight", "MetaLeft", "MetaRight",
            "Backspace", "Delete", "Enter", "Space", "Tab", "Home", "End", "Insert",
            "PageUp", "PageDown", "PrintScreen",
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
            "NumpadDecimal", "NumpadEnter", "NumpadEqual",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        for c in b'A'..=b'Z' {
            codes.push(format!("Key{}", c as char));
        }
        for d in 0..=9 {
            codes.push(format!("Digit{d}"));
            codes.push(format!("Numpad{d}"));
        }
        for f in 1..=24 {
            codes.push(format!("F{f}"));
        }
        for code in &codes {
            assert!(
                super::code_to_vk(code).is_some(),
                "bindable code {code:?} has no Windows VK mapping — its hotkey would silently never fire on Windows"
            );
        }
    }

    // The ids must stay distinct per code (e.g. Enter vs NumpadEnter via the
    // synthetic extended id) — a collision would make two different bindings
    // fire each other.
    #[test]
    fn vk_ids_are_distinct_per_code() {
        use std::collections::HashMap;
        let mut seen: HashMap<u16, String> = HashMap::new();
        let mut check = |code: String| {
            if let Some(vk) = super::code_to_vk(&code) {
                if let Some(prev) = seen.insert(vk, code.clone()) {
                    panic!("codes {prev:?} and {code:?} map to the same VK id {vk:#x}");
                }
            }
        };
        for c in [
            "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
            "AltLeft", "AltRight", "MetaLeft", "MetaRight",
            "Backspace", "Delete", "Enter", "Space", "Tab", "Home", "End", "Insert",
            "PageUp", "PageDown", "PrintScreen",
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
            "NumpadDecimal", "NumpadEnter", "NumpadEqual",
        ] {
            check(c.to_string());
        }
        for c in b'A'..=b'Z' {
            check(format!("Key{}", c as char));
        }
        for d in 0..=9 {
            check(format!("Digit{d}"));
            check(format!("Numpad{d}"));
        }
        for f in 1..=24 {
            check(format!("F{f}"));
        }
    }
}
