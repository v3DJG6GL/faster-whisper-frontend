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

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `quickadd` window in tauri.conf.json.
const QA_W: f64 = 600.0;
const QA_H: f64 = 480.0;
/// A unique, stable window title the KDE keep-above rule matches on (invisible — the
/// window is undecorated). Set just before the window maps so the rule applies.
#[cfg(target_os = "linux")]
const QA_TITLE: &str = "fwf-quick-add";

/// Center the window on the monitor it currently lives on (or the primary).
/// A no-op on native Wayland (the compositor decides placement).
fn center(win: &WebviewWindow) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let w = (QA_W * scale) as i32;
    let h = (QA_H * scale) as i32;
    let x = m_pos.x + (m_size.width as i32 - w) / 2;
    let y = m_pos.y + (m_size.height as i32 - h) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// The selection grabbed from the source app just before the window was shown, served
/// to the webview via `get_quickadd_seed`. Windows-only writer (see `win_seed`): there
/// the seed must be captured BEFORE our window takes focus, while on Linux the AT-SPI /
/// PRIMARY reads are focus-independent and happen after. `take`-semantics at read so a
/// summon can never see a previous summon's leftover.
#[derive(Default)]
pub struct SeedStash(
    // Writer (win_seed) and reader (get_quickadd_seed's Windows branch) are both
    // Windows-only; off Windows the managed state simply sits unread.
    #[cfg_attr(not(windows), allow(dead_code))] pub std::sync::Mutex<Option<String>>,
);

/// Show + focus the quick-add window and signal the webview to (re)focus its
/// field and refresh the list. Safe to call repeatedly (each summon re-centers).
///
/// Windows first grabs the source app's selection (copy-chord + clipboard diff —
/// `win_seed`) BEFORE the window takes focus, off the calling thread and time-bounded
/// so a wedged clipboard can never keep the window from opening.
// One seed grab at a time — the flag itself lives in `win_seed`, its owner, so that the SECOND
// caller (`commands::get_focused_selection`, the correct-on-close re-grab) is covered too and so
// it is held for the grab's real lifetime rather than until a caller's timeout.
//
// The grab saves the clipboard, synthesizes a copy chord, then
// restores what it saved — so two overlapping runs interleave: the second snapshots the
// FIRST one's freshly-copied selection as "the user's clipboard", the first restores the
// real one, and the second then puts the selection back. Net effect is the user's own
// clipboard destroyed and their selection left resident globally, which is exactly the
// residue the restore exists to prevent. The window is not shown until the grab settles
// (up to 1.5s of no feedback), so a second press in that window is likely, not exotic.

pub fn show(app: &AppHandle) {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering;
        // Only OBSERVE the flag here — `win_seed::grab` owns it (see there). Setting it in this
        // thread would make the grabber we are about to spawn refuse its own grab, and releasing
        // it on our `recv_timeout` would clear it while an abandoned grabber is still mutating
        // the clipboard.
        if win_seed::SEED_GRAB_ACTIVE.load(Ordering::Acquire) {
            // A grab is already running; it will show the window when it settles. Still
            // re-focus, so the second press never feels dead.
            show_now(app);
            return;
        }
        let handle = app.clone();
        std::thread::spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            let grabber = handle.clone();
            std::thread::spawn(move || {
                let _ = tx.send(win_seed::grab(&grabber));
            });
            // Generous vs grab's internal bounds (~1.35s worst case: ≤500ms modifier
            // gate — which SKIPS the copy when it trips, so it never stacks fully —
            // + the 800ms copy deadline); on timeout the grabber thread is abandoned
            // and the window opens seedless.
            let seed = rx
                .recv_timeout(std::time::Duration::from_millis(1500))
                .ok()
                .flatten();
            if let Ok(mut s) = handle.state::<SeedStash>().0.lock() {
                *s = seed;
            }
            show_now(&handle);
        });
        return;
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
        center(&win);
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
/// Uses cross-platform APIs (enigo / arboard / HeldKeys) plus one cfg-gated Win32
/// call (`GetClipboardSequenceNumber`), so it still compiles on every platform and
/// the Linux dev loop type-checks it — only the call sites are `#[cfg(windows)]`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod win_seed {
    /// See the note above `show`: one seed grab at a time, process-wide. Owned here rather
    /// than in `show` so it covers `commands::get_focused_selection` too, and so it is held
    /// for the grab's real lifetime rather than until a caller's timeout.
    pub(super) static SEED_GRAB_ACTIVE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    /// How long the source app gets for its copy to land. Word delay-renders its
    /// clipboard text and can't even take clipboard OWNERSHIP until its UI thread
    /// drains (add-ins, AutoSave, big documents — hundreds of ms is routine), which
    /// is why the old 400 ms deadline read real selections as "nothing selected".
    /// The cost of the headroom: a no-selection summon waits the full deadline
    /// before the window opens seedless.
    const COPY_DEADLINE_MS: u64 = 800;

    /// The Win32 clipboard sequence number: a cheap user32 counter bumped on every
    /// clipboard write, readable WITHOUT opening the clipboard.
    #[cfg(windows)]
    fn clipboard_seq() -> u32 {
        unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
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

    /// Best-effort: any failure or no copy landing (= nothing selected; apps
    /// no-op the copy) → None. The user's clipboard TEXT is restored afterwards;
    /// non-text content (an image) can't be snapshotted via arboard's text API and
    /// is lost only when the copy actually replaced it (logged).
    pub fn grab(app: &AppHandle) -> Option<String> {
        use std::sync::atomic::Ordering;
        // The single-flight lives HERE, not in `show`, because `show` is only one of two callers:
        // `commands::get_focused_selection` (the correct-on-close re-grab, which runs ~400ms after
        // the window hides and can last ~1.3s) calls straight through. A summon landing in that
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
        // The summoning chord's modifiers must be UP before injecting: a still-held
        // Shift would mutate the copy chord (Ctrl+Shift+Insert is PASTE in many
        // terminals). Mirrors inject_text's release gate, except on timeout we SKIP
        // entirely — a seed is optional, firing a mutated chord into the source app
        // is not worth the risk. The win_hotkeys worker feeds this held-set.
        let held = app.state::<crate::held_keys::HeldKeys>().inner().clone();
        let deadline = Instant::now() + Duration::from_millis(500);
        while held.any_held(&crate::held_keys::SHORTCUT_MOD_CODES) {
            if Instant::now() >= deadline {
                tracing::info!("[quickadd-seed] chord modifiers still held; skipping the copy grab");
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
        // Ctrl+Insert, the CUA copy chord — Win32 edit controls, browsers, Office, Qt,
        // and terminals all honor it, and unlike Ctrl+C it is never a terminal
        // interrupt. Injected events are skipped by our own keyboard hook
        // (LLKHF_INJECTED), so this can't disturb chord matching.
        let mut enigo = Enigo::new(&Settings::default()).ok()?;
        // Third read, at the SINK. The authoritative check above runs before `Clipboard::new()`,
        // an explicitly UN-timed blocking `get_text()`, `clipboard_seq()` and `Enigo::new()` — so
        // the gate that decides "no modifier is down" is separated from the chord it guards by an
        // unbounded wait. `quickadd::show` gives the user up to 1.5s of no feedback before the
        // window appears, and this file already records a second chord press in that window as
        // "likely, not exotic" — landing squarely in the unguarded leg. With Shift physically
        // down, the Ctrl+Insert below becomes Ctrl+Shift+Insert, which is PASTE in most terminals
        // and many editors: it would dump the user's clipboard into the focused source app, the
        // exact mutation the gate's own comment names. Same rule as the injection sinks — re-ask
        // at the sink, not only before the prologue.
        if modifier_physically_down() {
            tracing::info!("[quickadd-seed] modifier went down during the prologue; skipping the copy grab");
            return None;
        }
        enigo.key(Key::Control, Direction::Press).ok()?;
        let copied = enigo.key(Key::Insert, Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release); // release even if the click failed
        copied.ok()?;
        // The copy lands asynchronously in the source app.
        let deadline = Instant::now() + Duration::from_millis(COPY_DEADLINE_MS);
        #[cfg(windows)]
        {
            // Phase 1: wait for the copy to LAND by watching the sequence number — NOT by
            // re-reading the text. Every arboard read OPENS the clipboard, and a poll that
            // holds it open at the moment the source app writes makes the COPY ITSELF fail
            // (Office's classic "cannot empty the clipboard"), which this grab then
            // misreported as "nothing selected". No bump by the deadline ⇒ no selection.
            loop {
                std::thread::sleep(Duration::from_millis(15));
                if clipboard_seq() != seq0 {
                    break;
                }
                if Instant::now() >= deadline {
                    return None; // clipboard untouched — nothing to restore
                }
            }
            // Phase 2: the copy landed — read the text exactly once (this pull is what
            // triggers Office's delayed rendering). Retry a transient read failure within
            // the same deadline; a persistent one means non-text content (an image copy) —
            // put the user's text back and give up.
            loop {
                match cb.get_text() {
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
                        if Instant::now() >= deadline {
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
