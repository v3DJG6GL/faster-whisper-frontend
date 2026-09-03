//! The quick-add word-mapping window (label `quickadd`): a small, focusable,
//! always-on-top webview for adding spoken→symbol mappings to the pinned
//! "Spoken symbols" list with the fewest clicks. Defined statically in
//! `tauri.conf.json` (visible:false) so it's prewarmed — we only own showing,
//! hiding, and centering it, plus emitting `quickadd://shown` so the webview can
//! (re)focus its field and refresh the list on every summon.
//!
//! Unlike the chip overlay, this window DOES take focus (the user types into it).
//! On native Wayland `set_position` / `set_always_on_top` are no-ops (the compositor
//! places + stacks it). To keep it ABOVE other windows we install a small KWin window
//! rule (matched on a unique title) — the focus-allowed cousin of the chip's rule in
//! `overlay.rs mod kwin`: it forces keep-above + off-taskbar but never touches focus.

use tauri::{AppHandle, Emitter, Manager};

/// Logical size declared for the `quickadd` window in tauri.conf.json.
const QA_W: f64 = 600.0;
const QA_H: f64 = 480.0;
/// A unique, stable window title the KDE keep-above rule matches on (invisible — the
/// window is undecorated). Set just before the window maps so the rule applies.
#[cfg(target_os = "linux")]
const QA_TITLE: &str = "fwf-quick-add";


/// Rendezvous between the Windows seed grab (writer: a plain thread) and
/// `get_quickadd_seed` (reader: an async command). Generation-stamped: every summon
/// starts a new generation, and a reader only ever receives the generation that was
/// current when it started waiting — so it can never observe another summon's value.
/// The predecessor (a `take()`-once `Mutex<Option<String>>` stash) served a PREVIOUS
/// summon's leftover whenever a `quickadd://shown` emit was lost or a grab was still
/// in flight, and could not represent "the grab is still running, wait for it" at all.
///
/// Writer and reader are both Windows-only; off Windows the managed state sits unread
/// (`clear` still runs on hide, harmlessly).
#[derive(Clone, Default)]
pub struct SeedRendezvous(std::sync::Arc<SeedInner>);

#[derive(Default)]
struct SeedInner {
    cell: std::sync::Mutex<SeedCell>,
    cv: std::sync::Condvar,
}

#[derive(Default)]
struct SeedCell {
    generation: u64,
    state: SeedState,
}

#[derive(Default)]
enum SeedState {
    /// No summon yet (boot), or the window was hidden — nothing to wait for.
    #[default]
    Idle,
    /// This generation's grab is running; its result will settle under the same generation.
    InFlight,
    /// The grab finished (`None` = nothing selected / grab bailed out).
    Settled(Option<String>),
}

/// What `show` should do for this summon, decided atomically under the cell lock.
#[cfg_attr(not(windows), allow(dead_code))]
enum Summon {
    /// The current generation's grab is still running: show once IT settles (or is
    /// superseded), never before its copy chord went out — carries that generation.
    AlreadyInFlight(u64),
    /// A foreign grab (the correct-on-close re-grab) owns the copy chord; this summon
    /// gets no seed, already settled as such.
    NoSeed,
    /// Start a grab and settle it under this generation.
    Grab(u64),
}

#[cfg_attr(not(windows), allow(dead_code))]
impl SeedRendezvous {
    fn summon(&self) -> Summon {
        use std::sync::atomic::Ordering;
        let Ok(mut cell) = self.0.cell.lock() else {
            return Summon::NoSeed;
        };
        if matches!(cell.state, SeedState::InFlight) {
            return Summon::AlreadyInFlight(cell.generation);
        }
        cell.generation += 1;
        // Checked under the SAME lock as the state transition so a summon landing while
        // the correct-on-close re-grab runs can never be classified as Grab (the grab
        // would instantly lose the single-flight and this generation would settle None
        // only after a pointless spawn).
        if win_seed::SEED_GRAB_ACTIVE.load(Ordering::Acquire) {
            // With grab-side supersede polling this window is one poll tick (~15ms)
            // after a close-then-resummon, plus the close re-grab's real duration.
            tracing::info!("[quickadd-seed] a previous grab still owns the copy chord; this summon gets no seed");
            cell.state = SeedState::Settled(None);
            self.0.cv.notify_all();
            return Summon::NoSeed;
        }
        cell.state = SeedState::InFlight;
        let generation = cell.generation;
        drop(cell);
        self.0.cv.notify_all();
        Summon::Grab(generation)
    }

    /// Deliver `generation`'s result. A stale delivery (the window was hidden, or a
    /// newer summon superseded this one) is dropped — never shown to a later summon.
    fn settle(&self, generation: u64, seed: Option<String>) {
        if let Ok(mut cell) = self.0.cell.lock() {
            if cell.generation == generation {
                cell.state = SeedState::Settled(seed);
                self.0.cv.notify_all();
            }
        }
    }

    /// Is `generation` still the one a reader could receive? False the moment a hide
    /// (`clear`) or a newer summon supersedes it. An in-flight grab polls this to stop
    /// early: its result is undeliverable anyway, and holding `SEED_GRAB_ACTIVE` for
    /// the rest of a long remote-desktop deadline turns the user's natural retry press
    /// into a guaranteed-seedless `Summon::NoSeed`.
    fn is_current(&self, generation: u64) -> bool {
        self.0
            .cell
            .lock()
            .map(|cell| cell.generation == generation)
            .unwrap_or(false)
    }

    /// Window hidden: invalidate the current generation so nothing lingers into the
    /// next summon and any in-flight reader returns `None` now.
    pub fn clear(&self) {
        if let Ok(mut cell) = self.0.cell.lock() {
            cell.generation += 1;
            cell.state = SeedState::Idle;
            self.0.cv.notify_all();
        }
    }

    /// Block until the generation current AT CALL TIME settles, up to `timeout`.
    /// Superseded (new summon / hide), `Idle` (nothing in flight — e.g. the recovery
    /// fetch after a lost emit), or timeout → `None`. Non-destructive: a re-read of a
    /// settled generation returns the same value.
    pub fn wait(&self, timeout: std::time::Duration) -> Option<String> {
        let deadline = std::time::Instant::now() + timeout;
        let mut cell = self.0.cell.lock().ok()?;
        let generation = cell.generation;
        loop {
            match &cell.state {
                _ if cell.generation != generation => return None,
                SeedState::Settled(seed) => return seed.clone(),
                SeedState::Idle => return None,
                SeedState::InFlight => {}
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return None;
            }
            let (next, _) = self.0.cv.wait_timeout(cell, deadline - now).ok()?;
            cell = next;
        }
    }
}

/// Show + focus the quick-add window and signal the webview to (re)focus its
/// field and refresh the list. Safe to call repeatedly (each summon re-centers).
///
/// Windows must fire the copy chord (`win_seed`) BEFORE the window takes focus, but the
/// window is shown as soon as the chord is INJECTED — not once the clipboard settles.
/// The clipboard wait continues in the background and delivers through `SeedRendezvous`,
/// so a slow copy (Office delayed rendering, RDP clipboard redirection round-trips of
/// hundreds of ms to seconds) fills the field late instead of never, and the user gets
/// window feedback at the earliest safe moment. Exception: when focus sits in a
/// remote-desktop client the show is held until the copy LANDS (or a short grace
/// passes) — stealing the client's focus at injection time stops its input forwarding
/// and can kill the chord before the remote app ever copies (see `win_seed::grab`).
// One seed grab at a time — the flag itself lives in `win_seed`, its owner, so that the SECOND
// caller (`commands::get_focused_selection`, the correct-on-close re-grab) is covered too and so
// it is held for the grab's real lifetime rather than until a caller's timeout.
//
// The grab saves the clipboard, synthesizes a copy chord, then
// restores what it saved — so two overlapping runs interleave: the second snapshots the
// FIRST one's freshly-copied selection as "the user's clipboard", the first restores the
// real one, and the second then puts the selection back. Net effect is the user's own
// clipboard destroyed and their selection left resident globally, which is exactly the
// residue the restore exists to prevent.

pub fn show(app: &AppHandle) {
    #[cfg(windows)]
    {
        let rdv = app.state::<SeedRendezvous>().inner().clone();
        match rdv.summon() {
            Summon::NoSeed => {
                show_now(app);
                return;
            }
            // A summon grab is already running (second press while the first still waits on
            // the modifier gate / clipboard). Showing at once put the window up BEFORE that
            // grab's copy chord went out, with a stale or empty seed; wait for it to settle
            // instead — normally milliseconds after the first press's own show, the 5 s only
            // backstops a wedged clipboard. Skipped if the window was hidden meanwhile.
            Summon::AlreadyInFlight(generation) => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let _ = rdv.wait(std::time::Duration::from_millis(5000));
                    if rdv.is_current(generation) {
                        show_now(&handle);
                    }
                });
                return;
            }
            Summon::Grab(generation) => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
                    let grabber = handle.clone();
                    let settle = rdv.clone();
                    std::thread::spawn(move || {
                        // A grab panic must not leave the generation InFlight forever
                        // (every later summon would see AlreadyInFlight and never grab).
                        let seed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            win_seed::grab(
                                &grabber,
                                Some(ready_tx),
                                Some((settle.clone(), generation)),
                            )
                        }))
                        .unwrap_or(None);
                        settle.settle(generation, seed);
                    });
                    // Show once the chord is injected or the grab bailed (`Ready` signals on
                    // both), NOT once the clipboard settles. The cap only backstops a wedged
                    // clipboard prologue (`grab`'s un-timed `get_text`) — the release gate
                    // (≤3s) signals on its own timeout, so a held chord never rides this cap;
                    // a wedged clipboard must not keep the window from opening either. Sized
                    // for the worst LEGIT path: release gate (3s) + prologue + the
                    // remote-desktop forwarding grace (1.2s) — a premature backstop show
                    // would steal the RDP client's focus right after injection, the exact
                    // forwarding kill the grace exists to prevent.
                    let _ = ready_rx.recv_timeout(std::time::Duration::from_millis(5000));
                    if rdv.is_current(generation) {
                        show_now(&handle);
                    }
                });
                return;
            }
        }
    }
    #[cfg(not(windows))]
    show_now(app);
}

fn show_now(app: &AppHandle) {
    // Callable from any context — the chip command (main thread), the global-shortcut
    // handler, the single-instance CLI callback, or an evdev reader task — so hop to the
    // main thread for the GTK window ops.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("quickadd") else {
            return;
        };
        crate::winpos::center_on_monitor(&win, QA_W, QA_H);
        let _ = win.set_always_on_top(true);
        // KDE-Wayland ignores client keep-above; install a KWin window rule instead (matched on a
        // unique title), the focus-allowed cousin of the chip's rule. The title must be set before
        // the window maps so the rule matches; the config write can block, so it runs off-thread.
        #[cfg(target_os = "linux")]
        if kwin::is_kde_wayland() {
            let _ = win.set_title(QA_TITLE);
            std::thread::spawn(kwin::install_keep_above);
        }
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        let _ = handle.emit("quickadd://shown", ());
    });
}

/// Hide the quick-add window. It stays alive (prewarmed) for the next summon —
/// the close-to-hide guard in `lib.rs` keeps it from being destroyed.
pub fn hide(app: &AppHandle) {
    // Invalidate the summon's seed generation: a grab still settling after the user
    // already closed the window must not be readable by any later summon. (No-op off
    // Windows, where the state is never written.)
    app.state::<SeedRendezvous>().clear();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("quickadd") {
            let _ = win.hide();
        }
    });
}

/// Open (or re-focus) the quick-add window — invoked by the chip quick-launch
/// action and, later, the global shortcut path.
#[tauri::command]
pub fn show_quick_add(app: AppHandle) {
    show(&app);
}

/// Hide the quick-add window — invoked by the webview on Esc / "done".
#[tauri::command]
pub fn hide_quick_add(app: AppHandle) {
    hide(&app);
}

/// Windows selection grab: neither AT-SPI nor a PRIMARY selection exists there,
/// so the pragmatic path is "make the source app copy its selection, diff the
/// clipboard, put the clipboard back". Must run while the SOURCE app has focus —
/// before `show_now` for the summon seed, or after the window hid for the
/// correct-on-close re-read (`commands::get_focused_selection`).
///
/// Uses cross-platform APIs (arboard / HeldKeys; enigo on the never-called non-Windows
/// twin) plus cfg-gated Win32 calls (`GetClipboardSequenceNumber`, `SendInput`), so it
/// still compiles on every platform and the Linux dev loop type-checks it — only the
/// call sites are `#[cfg(windows)]`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod win_seed {
    /// See the note above `show`: one seed grab at a time, process-wide. Owned here rather
    /// than in `show` so it covers `commands::get_focused_selection` too, and so it is held
    /// for the grab's real lifetime rather than until a caller's timeout.
    pub(super) static SEED_GRAB_ACTIVE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    #[cfg(not(windows))]
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    /// How long the source app gets for its copy to land. Word delay-renders its
    /// clipboard text and can't even take clipboard OWNERSHIP until its UI thread
    /// drains (add-ins, AutoSave, big documents — hundreds of ms is routine), which
    /// is why the old 400 ms deadline read real selections as "nothing selected".
    /// The headroom is cheap now that the window shows at injection time rather
    /// than after this wait: only the LATE "no selection → open the recent-words
    /// dropdown" fallback pays the full deadline.
    const COPY_DEADLINE_MS: u64 = 2500;

    /// The copy deadline when the selection lives in a remote-desktop session. Every
    /// leg crosses the network: the chord is forwarded to the remote, the remote app
    /// copies into the REMOTE clipboard, and rdpclip announces it back over the
    /// redirection channel asynchronously — routinely several hundred ms to seconds
    /// on a loaded link, which is what kept blowing the shared deadline and reading
    /// real RDP selections as "nothing selected". Costs nothing off RDP; over RDP the
    /// no-selection dropdown fallback arrives this late, but the field itself is
    /// usable the moment the window shows.
    const COPY_DEADLINE_RDP_MS: u64 = 6000;

    /// How long `grab` keeps our window UNSHOWN after injecting the chord into a
    /// remote-desktop client (unless the copy lands sooner — the clipboard bump ends
    /// the hold early). Deactivating the client is what must not happen in this
    /// window: on focus loss RDP clients stop forwarding input and flush a
    /// "release all keys" sync to the remote, so a show right after injection can
    /// kill the chord before the remote app ever executes the copy. Forwarding
    /// itself is quick (a local channel write + one network hop), so a short grace
    /// suffices; the clipboard SYNC legs (rdpclip announcement, delayed-render
    /// fetch) are served fine by a background client and need no focus.
    const RDP_FORWARD_GRACE_MS: u64 = 1200;

    /// The Win32 clipboard sequence number: a cheap user32 counter bumped on every
    /// clipboard write, readable WITHOUT opening the clipboard.
    #[cfg(windows)]
    fn clipboard_seq() -> u32 {
        unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
    }

    /// Inject Ctrl+Insert as ONE `SendInput` batch of four events shaped exactly like a
    /// physical keyboard's: the real make codes in `wScan` (left-Ctrl 0x1D; Insert 0x52
    /// with `KEYEVENTF_EXTENDEDKEY` standing in for the E0 prefix) alongside the
    /// virtual keys. Locally focused apps act on the VK — but a focused RDP client
    /// forwards ONLY the scan code + extended bit ([MS-RDPBCGR]: keyboard input is
    /// restricted to scancodes; no VK crosses the wire), which is where the enigo path
    /// this replaces was malformed: it mapped VK→scan with `MAPVK_VK_TO_VSC_EX` under
    /// the foreground window's layout and stored the result unmasked, so Insert went
    /// out with wScan=0xE052 (the E0 prefix INSIDE the 8-bit-scan field low-level
    /// consumers read) — or wScan=0 when the map failed, the classic works-locally/
    /// dies-remotely event. And a forwarded 0x52 WITHOUT the extended bit is
    /// numpad-0/Ins on the remote: NumLock on turns the "copy" into Ctrl+0 (reset zoom
    /// in browsers) — why RDP selections never seeded while local ones always did.
    /// Hardcoded scans are layout-proof; one batch keeps a concurrent user keystroke
    /// from interleaving mid-chord (enigo issued three separate `SendInput`s). The
    /// events carry enigo's `dwExtraInfo` marker so our own LL hook / raw-input feed
    /// keeps ignoring our injections exactly as before.
    #[cfg(windows)]
    const SCAN_LCTRL: u16 = 0x1D;
    #[cfg(windows)]
    const SCAN_INSERT: u16 = 0x52; // + KEYEVENTF_EXTENDEDKEY = the dedicated (E0) Insert

    /// One synthetic keyboard event shaped like a physical keyboard's (see
    /// `send_copy_chord` for why the scan code is load-bearing). Carries enigo's
    /// `dwExtraInfo` marker so our own LL hook / raw-input feed ignores it.
    #[cfg(windows)]
    fn key_event(
        vk: u16,
        scan: u16,
        flags: u32,
    ) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        };
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: enigo::EVENT_MARKER as usize,
                },
            },
        }
    }

    /// Send `events` as ONE `SendInput` batch — inserted serially into the input
    /// stream, so no concurrent user keystroke can interleave inside it. True iff
    /// every event was accepted.
    #[cfg(windows)]
    fn send_events(events: &[windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT]) -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
        let sent = unsafe {
            SendInput(
                events.len() as u32,
                events.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        sent == events.len() as u32
    }

    #[cfg(windows)]
    fn send_copy_chord() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VK_CONTROL, VK_INSERT,
        };
        send_events(&[
            key_event(VK_CONTROL, SCAN_LCTRL, 0),
            key_event(VK_INSERT, SCAN_INSERT, KEYEVENTF_EXTENDEDKEY),
            key_event(VK_INSERT, SCAN_INSERT, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
            key_event(VK_CONTROL, SCAN_LCTRL, KEYEVENTF_KEYUP),
        ])
    }

    /// Neutralize the summoning chord's bare-modifier release BEFORE it happens —
    /// AutoHotkey's "#MenuMaskKey" technique. Windows and apps activate menus on a bare
    /// Alt/Win press-and-release with NO intervening key event: Firefox-family reveals +
    /// focuses its menu bar (a toggle — quick-add seeded only every 2nd try there),
    /// classic Win32 apps like Notepad++ enter the menu loop (re-entered on EVERY try,
    /// since deactivation cancels it), Chrome moves focus to its toolbar menu when a
    /// PAGE field has focus (but not when the omnibox does — why the URL bar always
    /// seeded). The chord's keys reach the focused app (our hook only observes), and a
    /// focused RDP client forwards them to the remote one — where the follow-up copy
    /// chord then landed in a MENU instead of the text field. A Ctrl tap injected while
    /// the chord is still held turns its release into a combo; Ctrl taps have no menu
    /// semantics anywhere, which is why AutoHotkey masks with Ctrl. Real scan code so
    /// the mask forwards over RDP like everything else.
    #[cfg(windows)]
    fn send_menu_mask() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, VK_CONTROL};
        send_events(&[
            key_event(VK_CONTROL, SCAN_LCTRL, 0),
            key_event(VK_CONTROL, SCAN_LCTRL, KEYEVENTF_KEYUP),
        ])
    }

    /// Are the keys with menu-release semantics (Alt / Win, either side) physically
    /// down right now? ONLY their bare release activates anything — Ctrl and Shift
    /// taps have no menu meaning — so a chord without Alt/Win needs no mask, and
    /// skipping it there avoids the mask's own side-effect surface (a transient
    /// Ctrl+Shift can read as the legacy input-language switch hotkey).
    #[cfg(windows)]
    fn alt_or_win_physically_down() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_LWIN, VK_MENU, VK_RWIN,
        };
        [VK_MENU, VK_LWIN, VK_RWIN]
            .iter()
            .any(|&vk| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0)
    }

    /// Is Ctrl (either side) logically down right now? When it is, the chord release
    /// needs no mask — the menu-activation rule requires a BARE Alt/Win tap, and a
    /// Ctrl-modified release never activates one (AutoHotkey skips its mask on the
    /// same condition). More importantly, masking then would inject a Ctrl-up beside
    /// the user's physically HELD Ctrl — the one genuinely hazardous variant (an
    /// isolated Ctrl-up next to a held Win can itself pop the Start menu). AltGr
    /// chords are covered for free: AltGr is RAlt plus a system-generated LCtrl, so
    /// they arrive pre-masked and this skip applies.
    #[cfg(windows)]
    fn ctrl_logically_down() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
        (unsafe { GetAsyncKeyState(VK_CONTROL as i32) } as u16) & 0x8000 != 0
    }

    /// Is any shortcut modifier physically down RIGHT NOW, straight from the OS?
    /// `GetAsyncKeyState`'s high bit is the current physical state, independent of our
    /// hook and of any message queue — so unlike `HeldKeys` it cannot be reset to an
    /// empty map by a worker restart. VK_SHIFT/CONTROL/MENU cover both sides.
    #[cfg(windows)]
    fn modifier_physically_down() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        };
        [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
            .iter()
            .any(|&vk| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0)
    }

    /// Non-Windows twin (never called — `grab`'s only call sites are `#[cfg(windows)]` —
    /// but kept so the Linux dev loop type-checks the module, like `clipboard_seq`'s.
    #[cfg(not(windows))]
    fn modifier_physically_down() -> bool {
        false
    }

    /// Is the user's focus in a remote-desktop client window right now? Read BEFORE
    /// injecting, while focus is still on the source. Matched by window class:
    /// mstsc's shell/input/output windows (the input sink also covers the RDP
    /// ActiveX embedded in RDCMan / mRemoteNG), RemoteApp seamless windows, the
    /// Windows App (msrdc), and FreeRDP. An unrecognized client just keeps the
    /// non-RDP behavior — same as before this detection existed.
    ///
    /// Checked as: the foreground window, plus the foreground thread's focus and
    /// active windows (`GetGUIThreadInfo`) — focus usually sits on a CHILD
    /// (`IHWindowClass`) whose top-level is the shell container.
    #[cfg(windows)]
    fn focus_is_remote_desktop_client() -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GUITHREADINFO,
        };
        const REMOTE_CLASSES: &[&str] = &[
            "TscShellContainerClass", // mstsc.exe top-level
            "IHWindowClass",          // mstsc input sink; also the embedded ActiveX (RDCMan, mRemoteNG)
            "OPWindowClass",          // mstsc output surface (focus can land here)
            "RAIL_WINDOW",            // RemoteApp seamless windows
            "RdClientWindow",         // msrdc.exe (Windows App / Azure Virtual Desktop)
            "FreeRDP",                // wfreerdp
        ];
        let class_of = |hwnd: windows_sys::Win32::Foundation::HWND| -> Option<String> {
            if hwnd.is_null() {
                return None;
            }
            let mut buf = [0u16; 64];
            let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
            (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
        };
        let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let have_info = unsafe { GetGUIThreadInfo(0, &mut info) } != 0;
        let candidates = [
            unsafe { GetForegroundWindow() },
            if have_info { info.hwndFocus } else { std::ptr::null_mut() },
            if have_info { info.hwndActive } else { std::ptr::null_mut() },
        ];
        candidates
            .into_iter()
            .filter_map(class_of)
            .any(|c| REMOTE_CLASSES.iter().any(|k| c.eq_ignore_ascii_case(k)))
    }

    /// Non-Windows twin, like `modifier_physically_down`'s: keeps the module
    /// type-checking in the Linux dev loop.
    #[cfg(not(windows))]
    fn focus_is_remote_desktop_client() -> bool {
        false
    }

    /// Signals `quickadd::show`'s "safe to show the window now" rendezvous exactly once —
    /// explicitly, right after the copy chord is injected (the last point where focus must
    /// still be on the source app), or implicitly on drop, so every early-return / panic
    /// path releases the window instead of riding out the caller's backstop cap.
    pub struct Ready(Option<std::sync::mpsc::Sender<()>>);
    impl Ready {
        fn signal(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }
    impl Drop for Ready {
        fn drop(&mut self) {
            self.signal();
        }
    }

    /// Best-effort: any failure or no copy landing (= nothing selected; apps
    /// no-op the copy) → None. The user's clipboard TEXT is restored afterwards;
    /// non-text content (an image) can't be snapshotted via arboard's text API and
    /// is lost only when the copy actually replaced it (logged).
    ///
    /// `ready`, when given, is signalled the moment it is safe for our window to take
    /// focus (chord injected, or grab abandoned) — see `Ready`. The correct-on-close
    /// re-grab passes `None`: its window is already hidden.
    ///
    /// `cancel`, when given, is the rendezvous + generation this grab settles under: the
    /// clipboard polls bail as soon as the generation is superseded (window closed / new
    /// summon), because the result is undeliverable and holding `SEED_GRAB_ACTIVE` for
    /// the rest of a 6s remote-desktop deadline makes the user's retry press seedless.
    /// The close re-grab passes `None` — its caller awaits the result directly.
    pub fn grab(
        app: &AppHandle,
        ready: Option<std::sync::mpsc::Sender<()>>,
        cancel: Option<(super::SeedRendezvous, u64)>,
    ) -> Option<String> {
        use std::sync::atomic::Ordering;
        let mut ready = Ready(ready);
        let superseded =
            || cancel.as_ref().is_some_and(|(rdv, generation)| !rdv.is_current(*generation));
        // The single-flight lives HERE, not in `show`, because `show` is only one of two callers:
        // `commands::get_focused_selection` (the correct-on-close re-grab, which runs ~400ms after
        // the window hides and can last SECONDS: the ≤3 s modifier release gate, an un-timed
        // clipboard prologue, then COPY_DEADLINE_MS / COPY_DEADLINE_RDP_MS of polling — and,
        // passing `cancel: None`, it is never superseded) calls straight through. A summon landing in that
        // window used to start a second concurrent grab and produce exactly the interleave
        // described on SEED_GRAB_ACTIVE. Owning it here also means it is held for as long as the
        // grab actually runs, rather than until some caller's timeout fires.
        if SEED_GRAB_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            tracing::info!("[quickadd-seed] another grab is in flight; skipping this one");
            return None;
        }
        struct Release;
        impl Drop for Release {
            fn drop(&mut self) {
                SEED_GRAB_ACTIVE.store(false, Ordering::Release);
            }
        }
        let _release = Release;
        // The summoning chord is usually still physically held right now — that is
        // exactly what the release gate below waits out. Mask its release FIRST, while
        // the modifiers are down: without this, the bare Alt/Win tap that follows puts
        // the focused (possibly remote) app into menu mode and the copy chord lands in
        // a menu instead of the field — see `send_menu_mask`. Fire-time masking is
        // also the only timing that works through an RDP client (a mask injected at
        // release time would be forwarded AFTER the release). Skipped when nothing is
        // held (already released / the close re-grab — nothing to mask), when the hold
        // has no Alt/Win (nothing HAS menu semantics — see `alt_or_win_physically_down`),
        // and when Ctrl is part of the hold (no mask needed, and injecting one would be
        // the risky case — see `ctrl_logically_down`). Known residual: a Win-containing
        // chord held past the autorepeat delay can re-arm the Start menu after this
        // mask (Win repeats count as fresh bare presses; Alt does not repeat-re-arm).
        #[cfg(windows)]
        if alt_or_win_physically_down() && !ctrl_logically_down() {
            let _ = send_menu_mask();
        }
        // The summoning chord's modifiers must be UP before injecting: a still-held
        // Shift would mutate the copy chord (Ctrl+Shift+Insert is PASTE in many
        // terminals). Mirrors inject_text's release gate, except on timeout we SKIP
        // entirely — a seed is optional, firing a mutated chord into the source app
        // is not worth the risk. The win_hotkeys worker feeds this held-set.
        //
        // The wait is GENEROUS (3s, was 500ms): the default chord is Alt+Win — pure
        // modifiers, physically down at the instant the chord fires — and with no
        // window on screen yet, holding the chord while waiting for one is the natural
        // first-press behaviour. The old 500ms gate read exactly that as "skip the
        // grab", which is why the first press seeded nothing and the retry (a quick
        // tap by then) worked. Waiting longer is free — the copy fires the moment the
        // keys lift, and the window follows immediately after — only INJECTING with
        // modifiers down is dangerous.
        let held = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        let deadline = Instant::now() + Duration::from_millis(3000);
        while held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
            if Instant::now() >= deadline {
                tracing::info!("[quickadd-seed] chord modifiers held past the release gate; skipping the copy grab");
                return None;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        // Second, AUTHORITATIVE read before injecting. `HeldKeys` is fed only by the
        // win-hotkeys worker, and `apply_bindings` clears it and restarts that worker
        // unconditionally — reachable mid-wait from a sync pull that changes bindings.
        // The fresh hook only sees TRANSITIONS, so a modifier already down is never
        // re-added and the gate above reads "nothing held" for the rest of that hold.
        // Ask the OS directly rather than trusting the cleared map.
        if modifier_physically_down() {
            tracing::info!("[quickadd-seed] modifier still physically down; skipping the copy grab");
            return None;
        }
        let mut cb = arboard::Clipboard::new().ok()?;
        let prev = cb.get_text().ok(); // None = empty or non-text (image/files)
        #[cfg(windows)]
        let seq0 = clipboard_seq();
        // Third read, at the SINK. The authoritative check above runs before `Clipboard::new()`
        // and an explicitly UN-timed blocking `get_text()` (over RDP that read can stall for
        // seconds: the local clipboard may be delay-rendered by the client, so reading it pulls
        // the bytes across the channel) — so the gate that decides "no modifier is down" is
        // separated from the chord it guards by an unbounded wait, and a second chord press in
        // that gap is likely, not exotic. With Shift physically down, the Ctrl+Insert below
        // becomes Ctrl+Shift+Insert, which is PASTE in most terminals and many editors: it would
        // dump the user's clipboard into the focused source app, the exact mutation the gate's
        // own comment names. Same rule as the injection sinks — re-ask at the sink, not only
        // before the prologue.
        if modifier_physically_down() {
            tracing::info!("[quickadd-seed] modifier went down during the prologue; skipping the copy grab");
            return None;
        }
        // Read while focus is still on the source (the last pre-injection moment): a
        // remote-desktop client gets the longer network deadline AND keeps our window
        // unshown until the copy lands / the forwarding grace passes — see the consts.
        let remote = focus_is_remote_desktop_client();
        if remote {
            tracing::info!("[quickadd-seed] remote-desktop client focused; holding the window for the copy");
        }
        // Ctrl+Insert, the CUA copy chord — Win32 edit controls, browsers, Office, Qt,
        // and terminals all honor it, and unlike Ctrl+C it is never a terminal
        // interrupt. Injected events are skipped by our own keyboard hook
        // (LLKHF_INJECTED + marker), so this can't disturb chord matching.
        #[cfg(windows)]
        if !send_copy_chord() {
            tracing::warn!("[quickadd-seed] SendInput rejected the copy chord (UIPI / desktop switch?)");
            return None;
        }
        // Non-Windows twin of the injection (never called — kept so the Linux dev loop
        // type-checks the module). Windows injects via `send_copy_chord`: see there.
        #[cfg(not(windows))]
        {
            let mut enigo = Enigo::new(&Settings::default()).ok()?;
            enigo.key(Key::Control, Direction::Press).ok()?;
            let copied = enigo.key(Key::Insert, Direction::Click);
            let _ = enigo.key(Key::Control, Direction::Release); // release even if the click failed
            copied.ok()?;
        }
        // The chord is in the source app's input queue — focus may move now. The window
        // shows while the (potentially slow: Office delayed render) copy below is still
        // landing; the seed follows through the rendezvous. NOT over remote desktop:
        // there the chord still has to be forwarded across the network, and stealing
        // the client's focus stops that forwarding — the show waits for the clipboard
        // bump (or the grace) inside the poll below.
        let injected_at = Instant::now();
        if !remote {
            ready.signal();
        }
        // The copy lands asynchronously in the source app.
        let deadline = injected_at
            + Duration::from_millis(if remote { COPY_DEADLINE_RDP_MS } else { COPY_DEADLINE_MS });
        #[cfg(windows)]
        {
            // Phase 1: wait for the copy to LAND by watching the sequence number — NOT by
            // re-reading the text. Every arboard read OPENS the clipboard, and a poll that
            // holds it open at the moment the source app writes makes the COPY ITSELF fail
            // (Office's classic "cannot empty the clipboard"), which this grab then
            // misreported as "nothing selected". No bump by the deadline ⇒ no selection.
            let grace = injected_at + Duration::from_millis(RDP_FORWARD_GRACE_MS);
            loop {
                std::thread::sleep(Duration::from_millis(15));
                if clipboard_seq() != seq0 {
                    break;
                }
                // Remote-desktop hold expired without a bump yet: the chord is long since
                // forwarded, so the window may take focus now — the announcement/render
                // legs don't need the client focused. (No-op when already signalled.)
                if Instant::now() >= grace {
                    ready.signal();
                }
                // Reader gone (window closed / superseded): stop wasting the
                // single-flight slot on an undeliverable result. Clipboard untouched.
                if superseded() {
                    tracing::info!(
                        "[quickadd-seed] summon superseded {}ms after injection; abandoning the grab",
                        injected_at.elapsed().as_millis()
                    );
                    return None;
                }
                if Instant::now() >= deadline {
                    // The one line that distinguishes "the copy never landed" (this)
                    // from "the reader gave up" (commands.rs's fetch log) in the field.
                    tracing::info!(
                        "[quickadd-seed] no clipboard bump within {}ms (remote={}); treating as no selection",
                        injected_at.elapsed().as_millis(),
                        remote
                    );
                    return None; // clipboard untouched — nothing to restore
                }
            }
            // Copy landed — over remote desktop this is what ends the hold (usually well
            // before the grace). The elapsed time is the diagnostic for "deadline too
            // short" reports.
            if remote {
                tracing::info!(
                    "[quickadd-seed] copy landed {}ms after injection (remote client)",
                    injected_at.elapsed().as_millis()
                );
            }
            ready.signal();
            // Phase 2: the copy landed — read the text exactly once (this pull is what
            // triggers Office's delayed rendering). Retry a transient read failure within
            // the same deadline; a persistent one means non-text content (an image copy) —
            // put the user's text back and give up.
            loop {
                match cb.get_text() {
                    // The sequence bump is the format ANNOUNCEMENT, not the data. Over RDP
                    // the CF_UNICODETEXT bytes cross the channel only when a read pulls
                    // them, and a stalled fetch can come back as an EMPTY string rather
                    // than an error (FreeRDP documents exactly that fallback on its own
                    // timeout). An empty "copy" of a real selection doesn't exist — keep
                    // polling for the bytes; at the deadline restore and report nothing.
                    Ok(text) if text.is_empty() => {
                        if Instant::now() >= deadline || superseded() {
                            match prev {
                                Some(p) => {
                                    let _ = cb.set_text(p);
                                }
                                None => {
                                    let _ = cb.clear();
                                }
                            }
                            return None;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    Ok(text) => {
                        match &prev {
                            // A sequence bump proves a copy HAPPENED, so text equal to the
                            // prior clipboard is a real selection too (the old text-diff
                            // detector had to read that as "no selection") — and the
                            // clipboard already holds it, so there's nothing to restore.
                            Some(p) if *p == text => {}
                            Some(p) => {
                                let _ = cb.set_text(p.clone()); // put the user's clipboard back
                            }
                            // Nothing text-shaped to put back — but the grab still LEFT the
                            // user's selection sitting in the global clipboard, readable by every
                            // process and captured by clipboard history / cloud sync, after the
                            // user did nothing but press a hotkey to open a word-mapping window.
                            // Clearing is the closest we can get to "as it was".
                            None => {
                                let _ = cb.clear();
                                tracing::info!("[quickadd-seed] non-text clipboard was replaced by the copy grab; cleared it");
                            }
                        }
                        return Some(text);
                    }
                    Err(_) => {
                        // Superseded mid-retry: the copy DID land (we're past the bump), so
                        // restore the user's clipboard exactly like the deadline path.
                        if Instant::now() >= deadline || superseded() {
                            match prev {
                                Some(p) => {
                                    let _ = cb.set_text(p); // copied content is non-text — restore
                                }
                                // Same residue as above, on the read-failure path.
                                None => {
                                    let _ = cb.clear();
                                }
                            }
                            return None;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
            }
        }
        // Non-Windows twin (never called — the call sites are #[cfg(windows)] — but kept
        // compiling so the Linux dev loop type-checks the module): the old text-diff poll,
        // which cannot distinguish "same text re-copied" from "no copy".
        #[cfg(not(windows))]
        loop {
            std::thread::sleep(Duration::from_millis(25));
            if superseded() {
                return None;
            }
            let now = cb.get_text().ok();
            if now != prev {
                match prev {
                    Some(prev) => {
                        let _ = cb.set_text(prev); // put the user's clipboard back
                    }
                    None => tracing::info!("[quickadd-seed] non-text clipboard was replaced by the copy grab"),
                }
                return now;
            }
            if Instant::now() >= deadline {
                return None; // clipboard untouched — nothing to restore
            }
        }
    }
}

/// KDE-Wayland keep-above for the quick-add window via a KWin window rule — the focus-ALLOWED
/// cousin of the chip's rule in `overlay.rs mod kwin`. On native Wayland a client can't force
/// "keep above", so we write a reversible rule (matched on our unique title) that KWin applies
/// compositor-side. Unlike the chip's rule it forces only `above` + `skiptaskbar`; it deliberately
/// does NOT touch focus, since the user types into this window. Merged into the user's
/// `kwinrulesrc` without clobbering their other rules.
#[cfg(target_os = "linux")]
mod kwin {
    use std::sync::atomic::{AtomicBool, Ordering};

    // Generic KConfig/KWin primitives are shared with overlay::kwin via crate::kwin.
    use crate::kwin::{config_tools, merge_general, reconfigure, set_key};
    pub use crate::kwin::is_kde_wayland;

    const GROUP: &str = "fwf-quick-add";
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    /// Install the keep-above rule once per session (strength 2 = "Force"), then reload KWin.
    pub fn install_keep_above() {
        if INSTALLED.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some((writer, reader)) = config_tools() else {
            INSTALLED.store(false, Ordering::Relaxed); // let a later summon retry once tools exist
            return;
        };
        merge_general(writer, reader, GROUP);
        let rule: &[(&str, &str)] = &[
            ("Description", "faster-whisper quick-add"),
            ("title", super::QA_TITLE),
            ("titlematch", "1"),   // exact title match
            ("wmclassmatch", "0"), // ignore window class
            ("above", "true"),
            ("aboverule", "2"),
            ("skiptaskbar", "true"),
            ("skiptaskbarrule", "2"),
        ];
        for (k, v) in rule {
            set_key(writer, GROUP, k, v);
        }
        reconfigure();
    }
}
