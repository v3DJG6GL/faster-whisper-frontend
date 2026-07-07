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
//! virtual-HID keyboard — the hook sees those as non-injected and keeps them.
//! Duplicated transitions collapse in the worker's held-set (same dedup that
//! absorbs autorepeat), so double delivery is harmless by construction.
//!
//! The receiver thread only decodes + forwards `(key, down)` transitions over a
//! channel; a worker thread owns the chord-matching state machine — a direct port
//! of `evdev_hotkeys::run_device` — emitting the same `trigger` events. Like
//! evdev, we react only to the configured chords, never swallow keys (both feeds
//! are observation-only by design), and never persist or transmit keys.
//!
//! Injected events (raw: header `hDevice == 0`; hook: `LLKHF_INJECTED` — both
//! include our own enigo `SendInput` typing) are ignored: we track PHYSICAL key
//! state, mirroring evdev. The worker also feeds the shared
//! [`crate::held_keys::HeldKeys`] gate, so `inject_text`'s
//! wait-for-modifier-release works on Windows exactly as it does under evdev.

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
/// NumLock ON (NumLock-off numpad presses report navigation VKs, just as browsers
/// report the navigation `event.code`s during capture — the two stay consistent).
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
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
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

    /// What a matched chord does (mirrors evdev_hotkeys::ChordAction).
    #[derive(Clone)]
    enum ChordAction {
        Dictate { profile_id: String, activation: ActivationType },
        OpenQuickAdd,
    }

    /// One enabled chord, in virtual-key-id space, ready for matching.
    struct ChordDesc {
        action: ChordAction,
        keys: Vec<u16>,
    }

    /// A physical key transition, forwarded from `hook_proc` to the worker.
    struct KeyEv {
        id: u16,
        down: bool,
    }

    /// The receiver→worker channel. `wndproc` is a bare `extern "system"` fn with no
    /// captures, so it reaches the current sender through this global; start()/
    /// shutdown() swap it. Locked per keystroke — uncontended in steady state.
    static TX: Mutex<Option<Sender<KeyEv>>> = Mutex::new(None);

    /// Build chord descriptors for every enabled Profile whose hotkey maps cleanly,
    /// plus the quick-add window chord. Equal chords are de-duped (first by config
    /// order wins) so one keypress can't fire two actions. Unmappable / empty skipped.
    /// (Direct port of evdev_hotkeys::chords_from into VK space.)
    fn chords_from(profiles: &[Profile], quick_add_hotkey: &[String]) -> Vec<ChordDesc> {
        let mut out: Vec<ChordDesc> = Vec::new();
        let mut push = |action: ChordAction, keys: Vec<u16>, what: &str| {
            let set: HashSet<u16> = keys.iter().copied().collect();
            let dup = out
                .iter()
                .any(|c| c.keys.len() == keys.len() && c.keys.iter().all(|k| set.contains(k)));
            if dup {
                tracing::warn!("[winhook] {what} has the same chord as an earlier one; ignoring the duplicate");
            } else {
                out.push(ChordDesc { action, keys });
            }
        };
        for p in profiles.iter().filter(|p| p.enabled) {
            let Some(keys) = p.hotkey.iter().map(|c| code_to_vk(c)).collect::<Option<Vec<_>>>() else {
                continue;
            };
            if keys.is_empty() {
                continue;
            }
            push(
                ChordAction::Dictate { profile_id: p.id.clone(), activation: p.activation },
                keys,
                &format!("profile '{}'", p.id),
            );
        }
        if let Some(keys) = quick_add_hotkey.iter().map(|c| code_to_vk(c)).collect::<Option<Vec<_>>>() {
            if !keys.is_empty() {
                push(ChordAction::OpenQuickAdd, keys, "the quick-add shortcut");
            }
        }
        out
    }

    /// For each chord `i`, the indices of OTHER chords that are a strict superset of
    /// it — chord `i` is suppressed while any such superset is fully held ("most-
    /// specific chord wins"; see evdev_hotkeys::compute_strict_supersets).
    fn compute_strict_supersets(chords: &[ChordDesc]) -> Vec<Vec<usize>> {
        let sets: Vec<HashSet<u16>> = chords.iter().map(|c| c.keys.iter().copied().collect()).collect();
        let mut out = vec![Vec::new(); chords.len()];
        for i in 0..chords.len() {
            for j in 0..chords.len() {
                if i != j && sets[j].len() > sets[i].len() && sets[i].iter().all(|c| sets[j].contains(c)) {
                    out[i].push(j);
                }
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
        // inject-gate can't wait on a phantom modifier.
        app.state::<crate::held_keys::HeldKeys>().clear();
        let chords = chords_from(profiles, quick_add_hotkey);
        if chords.is_empty() {
            tracing::info!("[winhook] no mappable chords; not starting");
            return; // guard drops → lock released; *g stays None (no listener)
        }
        let n_chords = chords.len();
        let supersets = compute_strict_supersets(&chords);

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
            .spawn(move || worker(worker_app, rx, chords, supersets));

        let (ready_tx, ready_rx) = channel::<Option<u32>>();
        let _ = std::thread::Builder::new()
            .name("win-hotkeys-input".into())
            .spawn(move || input_thread(&ready_tx));
        match ready_rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(Some(tid)) => {
                tracing::info!("[winhook] raw-input listener up ({n_chords} chord(s))");
                *g = Some(Running { input_thread_id: tid });
            }
            Ok(None) | Err(_) => {
                tracing::warn!("[winhook] couldn't register for raw keyboard input — hotkeys are OFF");
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
    fn input_thread(ready: &Sender<Option<u32>>) {
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
            let _ = ready.send(Some(GetCurrentThreadId()));
            // WM_INPUT arrives here and is routed to wndproc by DispatchMessageW.
            // Returns 0 on the WM_QUIT posted by shutdown(), -1 on error.
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
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

    /// The observation hook: forward physical transitions to the worker (same
    /// channel as the raw feed; the worker's held-set collapses duplicates) and
    /// ALWAYS pass the key on — this backend never swallows input. Kept trivial:
    /// the OS silently removes hooks that dawdle past its timeout.
    unsafe extern "system" fn ll_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == 0 {
            // HC_ACTION
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            // LLKHF_INJECTED = SendInput (ours or anyone's) — physical keys only,
            // the hook-side twin of the raw feed's hDevice check.
            if kb.flags & LLKHF_INJECTED == 0 {
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
    /// NumLock-translated numpad VKs; only AltGr's fake-LCtrl companion and the
    /// Enter/NumpadEnter split need handling (plus a defensive generic-VK
    /// resolve, mirroring the raw path, in case a driver reports them).
    fn ll_key_id(vk: u32, scan: u32, flags: u32) -> Option<u16> {
        let extended = flags & LLKHF_EXTENDED != 0;
        Some(match vk as u16 {
            // Overrun/prefix marker — also mstsc's synthetic activation marker.
            0xFF => return None,
            // AltGr's message-layer companion: a fake LCtrl with scan 0x21D
            // (0x1D | the KBDEXT-era 0x200 marker — what AHK's KeyHistory shows
            // as sc021D). The raw feed never sees it; drop it here too — whether
            // it arrives as the specific or the generic VK — so both feeds agree
            // that AltGr is a lone RAlt (a German-layout AltGr must never read as
            // "Ctrl held" to a chord or to the HeldKeys inject gate).
            0xA2 | 0x11 if scan == 0x21D => return None,
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
                // the HeldKeys gate. Physical keys only, mirroring evdev. The check
                // is over-broad (precision touchpads / virtual-HID keyboards also
                // report hDevice == 0) — those keys still arrive via the hook feed,
                // which filters on LLKHF_INJECTED instead.
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
            // nav VKey (numpad digits are then unbindable-by-design; the capture UI
            // records the same nav code).
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

    fn emit(app: &AppHandle, profile_id: &str, action: &str) {
        let _ = app.emit(
            "trigger",
            TriggerPayload { profile_id: profile_id.to_string(), action: action.to_string() },
        );
    }

    // PTT (Hold) chords currently emitting "start". A teardown (rebind capture,
    // apply_bindings restart) must emit the "stop" a mid-hold session would
    // otherwise lose — see stop_held_sessions and evdev_hotkeys::ACTIVE_HOLDS.
    static ACTIVE_HOLDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn note_hold(profile_id: &str, active: bool) {
        if let Ok(mut h) = ACTIVE_HOLDS.lock() {
            h.retain(|p| p != profile_id);
            if active {
                h.push(profile_id.to_string());
            }
        }
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
        let had = h.iter().any(|p| p == profile_id);
        h.retain(|p| p != profile_id);
        had
    }

    /// Emit "stop" for every PTT chord still held, then clear the set — so a session
    /// held across a listener teardown isn't wedged "listening". No-op when idle.
    pub fn stop_held_sessions(app: &AppHandle) {
        let stuck = ACTIVE_HOLDS
            .lock()
            .map(|mut h| std::mem::take(&mut *h))
            .unwrap_or_default();
        for profile_id in stuck {
            emit(app, &profile_id, "stop");
        }
    }

    /// The chord-matching state machine — a direct port of
    /// `evdev_hotkeys::run_device` (one instance, fed by the hook instead of
    /// per-device streams). Runs until the sender is dropped (shutdown/restart),
    /// then releases its HeldKeys contributions and stops any live Hold session.
    fn worker(app: AppHandle, rx: Receiver<KeyEv>, chords: Vec<ChordDesc>, supersets: Vec<Vec<usize>>) {
        // Mirror physical modifier state into the shared signal `inject_text` reads,
        // so we never type into a still-held trigger modifier (see crate::held_keys).
        let held_keys = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        let mut held: HashSet<u16> = HashSet::new();
        // Per-chord state — hold: currently emitting; latch: armed (rising-edge
        // debounce, so one press = one toggle).
        let mut active = vec![false; chords.len()];
        // Reused per-event scratch — this worker sees every keystroke in any app;
        // recompute in place rather than heap-allocating per key event.
        let mut fully = vec![false; chords.len()];

        while let Ok(ev) = rx.recv() {
            // Windows auto-repeats WM_KEYDOWN while a key is held; the held-set
            // insert dedups them (mirrors evdev skipping value == 2 autorepeat).
            let changed = if ev.down { held.insert(ev.id) } else { held.remove(&ev.id) };
            if !changed {
                continue;
            }
            if let Some(code) = vk_to_evdev_mod(ev.id) {
                held_keys.set(code, ev.down);
            }

            for (slot, c) in fully.iter_mut().zip(chords.iter()) {
                *slot = c.keys.iter().all(|k| held.contains(k));
            }

            for i in 0..chords.len() {
                // Active iff fully held AND no strict-superset chord is also fully held.
                let on = fully[i] && !supersets[i].iter().any(|&j| fully[j]);
                match &chords[i].action {
                    ChordAction::Dictate { profile_id, activation } => match activation {
                        ActivationType::Hold => {
                            if on && !active[i] {
                                active[i] = true;
                                emit(&app, profile_id, "start");
                                note_hold(profile_id, true);
                            } else if !on && active[i] {
                                active[i] = false;
                                emit(&app, profile_id, "stop");
                                note_hold(profile_id, false);
                            }
                        }
                        ActivationType::Latch => {
                            if on && !active[i] {
                                active[i] = true;
                                emit(&app, profile_id, "toggle");
                            } else if !fully[i] {
                                // Re-arm on a real RELEASE only — not when a superset chord
                                // merely suppresses this one (see evdev_hotkeys).
                                active[i] = false;
                            }
                        }
                    },
                    ChordAction::OpenQuickAdd => {
                        // Rising-edge (like latch): open once per chord press.
                        if on && !active[i] {
                            active[i] = true;
                            crate::quickadd::show(&app);
                        } else if !fully[i] {
                            active[i] = false;
                        }
                    }
                }
            }
        }
        // Channel closed (backend stopped or replaced) — release our HeldKeys
        // contributions so a stale modifier can't wedge the inject gate…
        for &id in &held {
            if let Some(code) = vk_to_evdev_mod(id) {
                held_keys.set(code, false);
            }
        }
        // …and stop any push-to-talk session still active, claim-based (take_hold)
        // so a stop already emitted by stop_held_sessions() isn't doubled onto a
        // session the user re-triggered meanwhile.
        for i in 0..chords.len() {
            if active[i] {
                if let ChordAction::Dictate { profile_id, activation: ActivationType::Hold } = &chords[i].action {
                    if take_hold(profile_id) {
                        emit(&app, profile_id, "stop");
                    }
                }
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
