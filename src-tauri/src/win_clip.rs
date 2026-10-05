//! The Windows clipboard owner for pastes into a remote-desktop client (mstsc & co).
//!
//! **Why this exists.** Live dictation into a windowed mstsc session sometimes wrote a phrase
//! twice. The logs proved the mechanism: we pasted only the new suffix, and the extra text was
//! exactly what the REMOTE clipboard had cached from the previous paste. RDP's clipboard channel
//! and its input channel are not ordered against each other (MS-RDPECLIP delayed rendering): we
//! write the clipboard, mstsc announces a new format list to the server, and our forwarded Ctrl+V
//! can overtake that announcement — the remote app then pastes its cached copy of the PREVIOUS
//! phrase. A fixed settle only makes this rarer; it cannot order the two channels.
//!
//! **What this does.** Our transcript is offered with Win32 DELAYED RENDERING from a hidden
//! message-only window that stays the clipboard owner: `SetClipboardData(CF_UNICODETEXT, NULL)`
//! announces the format without data, and Windows asks us (`WM_RENDERFORMAT`) the moment anyone
//! actually reads it. That turns every fetch into an observable event — who fetched, how long
//! after the offer, how long after our chord — which is what the `diag` mode logs. `enforce`
//! additionally re-announces the same text once right after the target's post-chord fetch, so the
//! remote never keeps a rendered cache: a premature next Ctrl+V then fetches live from us instead
//! of pasting stale text.
//!
//! **Modes** (env `FWF_RDP_CLIP`, read once): `legacy` = today's arboard write, owner never
//! started; `diag` (the default in this batch) = the owner writes and logs, behaviour otherwise
//! unchanged; `enforce` = diag + the one-shot re-announce + the caller waits (≤1.5 s) for the
//! target's fetch before returning, which orders the NEXT offer after this fetch. `FWF_RDP_SETTLE_MS`
//! (default 300) is the pre-chord settle for remote targets, so the user can measure with 0.
//!
//! **Structure.** The bookkeeping ([`OfferLedger`]) is pure and compiled on every platform so it is
//! unit-tested on Linux; only the Win32 owner thread (`imp`) is Windows-only. The owner thread
//! follows `win_hotkeys::input_thread`: a message-only window, a ready handshake, commands over an
//! mpsc channel woken by `PostMessageW`. Every clipboard call that can RE-ENTER the window
//! procedure (`EmptyClipboard` sends `WM_DESTROYCLIPBOARD` to the current owner — us —
//! synchronously; `DestroyWindow` sends `WM_RENDERALLFORMATS`) is made with no `RefCell` borrow
//! held, and the window procedure never lets a panic cross the FFI boundary.
#![cfg_attr(not(windows), allow(dead_code))] // the ledger is exercised by tests off Windows

use std::sync::OnceLock;

/// How remote pastes reach the clipboard. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Legacy,
    Diag,
    Enforce,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Legacy => "legacy",
            Mode::Diag => "diag",
            Mode::Enforce => "enforce",
        }
    }
}

/// `FWF_RDP_CLIP` → mode. Anything unrecognised (or unset) is `diag`: the owner path with
/// logging, which is this batch's default while the user's RDP protocol runs.
fn parse_mode(v: Option<&str>) -> Mode {
    match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("legacy") => Mode::Legacy,
        Some("enforce") => Mode::Enforce,
        _ => Mode::Diag,
    }
}

/// Default pre-chord settle for a remote target — what the fixed sleep was before this module.
const DEFAULT_SETTLE_MS: u64 = 300;
/// Upper bound on `FWF_RDP_SETTLE_MS`: a typo must not park every remote paste for minutes.
const MAX_SETTLE_MS: u64 = 3000;

/// `FWF_RDP_SETTLE_MS` → settle. Unparseable → the default; clamped to [`MAX_SETTLE_MS`]. `0`
/// is legal and is the point: it lets the user provoke the race on purpose and check that every
/// duplicate lines up with a `NO FETCH` line.
fn parse_settle(v: Option<&str>) -> u64 {
    v.and_then(|s| s.trim().parse::<u64>().ok())
        .map(|ms| ms.min(MAX_SETTLE_MS))
        .unwrap_or(DEFAULT_SETTLE_MS)
}

/// The mode for this process (env read once, so a log line and the behaviour can never disagree).
pub fn mode() -> Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    *MODE.get_or_init(|| parse_mode(std::env::var("FWF_RDP_CLIP").ok().as_deref()))
}

/// The pre-chord settle for a remote-desktop target, in ms (env read once).
pub fn settle_ms() -> u64 {
    static SETTLE: OnceLock<u64> = OnceLock::new();
    *SETTLE.get_or_init(|| parse_settle(std::env::var("FWF_RDP_SETTLE_MS").ok().as_deref()))
}

/// Why an offer did not reach the clipboard. Only `Unavailable` falls back to the legacy write;
/// the other two report "nothing written" so the caller re-sends — no chord was pressed, so a
/// re-send cannot duplicate text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferError {
    /// No owner (thread/window could not start, or already shut down), or delayed rendering was
    /// refused. The legacy synchronous write is the fallback.
    Unavailable,
    /// Another process held the clipboard open through all retries.
    Busy,
    /// The owner did not answer within the caller's bound.
    Timeout,
}

/// What `await_target_fetch` saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchWait {
    /// The target fetched after our chord.
    Fetched {
        after_chord_ms: u64,
        /// A re-announce was scheduled for this fetch (enforce).
        reannounced: bool,
    },
    /// No target fetch within the bound (or the offer was superseded / ownership lost).
    NoFetch,
}

/// Who asked us to render. `SelfApp` is our own process (e.g. `begin_injection`'s snapshot read).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requester {
    SelfApp,
    /// The window our chord went to, or any known remote-desktop client.
    Target,
    Other,
    /// `GetOpenClipboardWindow` was NULL — a reader that opened the clipboard without a window.
    Unknown,
}

impl Requester {
    fn as_str(self) -> &'static str {
        match self {
            Requester::SelfApp => "self",
            Requester::Target => "target",
            Requester::Other => "other",
            Requester::Unknown => "unknown",
        }
    }
}

/// What the owner should do (or log) after rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderVerdict {
    /// Nothing special.
    Plain,
    /// Someone other than the target rendered: the data now sits on the clipboard, so every LATER
    /// fetch (including the target's) is invisible to us for this offer.
    Blind,
    /// Enforce: re-announce this offer once, so the remote's cache is dropped again.
    Reannounce,
    /// The target fetched AGAIN after our re-announce (log only).
    EagerRefetch,
}

/// One render, as the ledger saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderReport {
    pub id: u64,
    pub since_offer_ms: u64,
    pub since_chord_ms: Option<u64>,
    pub verdict: RenderVerdict,
}

/// The previous offer, replaced by a new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Superseded {
    pub prev_id: u64,
    pub age_ms: u64,
    pub target_fetches: u32,
    /// Our chord went out for it but the target never fetched it (and nobody blinded us): the
    /// remote pasted its cached clipboard — the duplicate-text signature. Warned.
    pub unfetched_chord: bool,
}

/// The answer to the post-chord NO-FETCH timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoFetchVerdict {
    /// The timer belongs to an offer that is no longer current, or had no chord.
    Stale,
    /// The target fetched it. All good.
    Fetched,
    /// Someone else rendered first, so a target fetch would have been invisible — no verdict.
    Blind,
    /// Chord pressed, no target fetch, not blind: the remote pasted its cached clipboard (or the
    /// target took no text). Warned.
    NoFetch,
}

#[derive(Debug, Clone)]
struct OfferRec {
    id: u64,
    at: u64,
    /// (when, target pid)
    chord: Option<(u64, u32)>,
    target_fetches: u32,
    last_target_fetch: Option<u64>,
    reannounced: bool,
    blind: bool,
}

/// Pure per-offer bookkeeping for the owner. Times are caller-supplied monotonic milliseconds so
/// the state machine is deterministic under test.
#[derive(Debug)]
pub struct OfferLedger {
    mode: Mode,
    cur: Option<OfferRec>,
}

impl OfferLedger {
    pub fn new(mode: Mode) -> Self {
        Self { mode, cur: None }
    }

    /// The offer we still own, if any.
    pub fn current_id(&self) -> Option<u64> {
        self.cur.as_ref().map(|c| c.id)
    }

    /// The pid our chord for the current offer went to.
    pub fn chord_pid(&self) -> Option<u32> {
        self.cur.as_ref().and_then(|c| c.chord.map(|(_, pid)| pid))
    }

    /// A new offer replaced whatever we had.
    pub fn on_offer(&mut self, id: u64, now: u64) -> Option<Superseded> {
        let prev = self.cur.replace(OfferRec {
            id,
            at: now,
            chord: None,
            target_fetches: 0,
            last_target_fetch: None,
            reannounced: false,
            blind: false,
        });
        prev.map(|p| Superseded {
            prev_id: p.id,
            age_ms: now.saturating_sub(p.at),
            target_fetches: p.target_fetches,
            unfetched_chord: p.chord.is_some() && p.target_fetches == 0 && !p.blind,
        })
    }

    /// Our chord went out for offer `id` to `pid`. Returns ms since the offer, or None when `id`
    /// is no longer current (then nothing is armed).
    pub fn on_chord(&mut self, id: u64, pid: u32, now: u64) -> Option<u64> {
        let c = self.cur.as_mut().filter(|c| c.id == id)?;
        c.chord = Some((now, pid));
        Some(now.saturating_sub(c.at))
    }

    /// Someone asked us to render the current offer. `None` when we hold no offer.
    pub fn on_render(&mut self, who: Requester, now: u64) -> Option<RenderReport> {
        let mode = self.mode;
        let c = self.cur.as_mut()?;
        let since_chord_ms = c.chord.map(|(t, _)| now.saturating_sub(t));
        let verdict = match who {
            Requester::Target => {
                c.target_fetches += 1;
                c.last_target_fetch = Some(now);
                if c.reannounced {
                    RenderVerdict::EagerRefetch
                } else if mode == Mode::Enforce && c.chord.is_some() {
                    // Once per offer — the loop guard. Set when SCHEDULED, so a second fetch that
                    // races the 30ms timer cannot schedule another one.
                    c.reannounced = true;
                    RenderVerdict::Reannounce
                } else {
                    // Diag never re-announces; a pre-chord fetch is not the paste we pressed.
                    RenderVerdict::Plain
                }
            }
            Requester::SelfApp | Requester::Other | Requester::Unknown => {
                c.blind = true;
                RenderVerdict::Blind
            }
        };
        Some(RenderReport {
            id: c.id,
            since_offer_ms: now.saturating_sub(c.at),
            since_chord_ms,
            verdict,
        })
    }

    /// The re-announce for `id` went out. Returns ms since the target fetch that triggered it.
    pub fn on_reannounced(&mut self, id: u64, now: u64) -> Option<u64> {
        let c = self.cur.as_ref().filter(|c| c.id == id)?;
        Some(now.saturating_sub(c.last_target_fetch.unwrap_or(c.at)))
    }

    /// Another process took the clipboard. Returns (id, ms since the offer) for the log.
    pub fn on_lost(&mut self, now: u64) -> Option<(u64, u64)> {
        self.cur.take().map(|c| (c.id, now.saturating_sub(c.at)))
    }

    /// The post-chord NO-FETCH timer for `id` fired.
    pub fn on_nofetch_timer(&self, id: u64) -> NoFetchVerdict {
        match self.cur.as_ref() {
            Some(c) if c.id == id && c.chord.is_some() => {
                if c.target_fetches > 0 {
                    NoFetchVerdict::Fetched
                } else if c.blind {
                    NoFetchVerdict::Blind
                } else {
                    NoFetchVerdict::NoFetch
                }
            }
            _ => NoFetchVerdict::Stale,
        }
    }
}

#[cfg(windows)]
pub use imp::{await_target_fetch, foreground_pid, note_chord, offer, shutdown};

#[cfg(windows)]
mod imp {
    use super::{
        mode, settle_ms, FetchWait, NoFetchVerdict, OfferError, OfferLedger, RenderVerdict,
        Requester,
    };
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        GlobalFree, SetLastError, HANDLE, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardOwner, GetOpenClipboardWindow,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
        GetMessageW, GetWindowThreadProcessId, KillTimer, PeekMessageW, PostMessageW,
        PostQuitMessage, RegisterClassW, SetTimer, HWND_MESSAGE, MSG, PM_NOREMOVE,
        PM_QS_SENDMESSAGE, WM_APP, WM_DESTROYCLIPBOARD, WM_RENDERALLFORMATS, WM_RENDERFORMAT,
        WM_TIMER, WNDCLASSW,
    };

    /// Standard clipboard format for UTF-16 text (winuser.h). A plain const rather than pulling
    /// in the `Win32_System_Ole` feature for one number.
    const CF_UNICODETEXT: u32 = 13;

    /// "Drain the command channel."
    const WM_CMD: u32 = WM_APP + 1;
    /// "Our chord for offer `wparam` went to pid `lparam`."
    const WM_CHORD: u32 = WM_APP + 2;
    /// "Render what you still owe, destroy the window, quit."
    const WM_SHUTDOWN: u32 = WM_APP + 3;

    const T_REANNOUNCE: usize = 1;
    const T_NOFETCH: usize = 2;
    /// Delay before the re-announce: `WM_RENDERFORMAT` runs while the REQUESTER holds the
    /// clipboard open, so the re-offer can only happen after it closes it.
    const REANNOUNCE_DELAY_MS: u32 = 30;
    /// A re-announce that keeps finding the clipboard open is retried this often, then dropped.
    const REANNOUNCE_TRIES: u32 = 10;
    /// How long after our chord the target has to fetch before we call it a stale paste.
    const NOFETCH_MS: u32 = 1500;
    /// The caller's bound on one offer round trip (open retries are ≤ ~100ms of it).
    const OFFER_TIMEOUT: Duration = Duration::from_millis(750);

    enum Cmd {
        Offer {
            text_lf: String,
            exclude: bool,
            deadline: Instant,
            reply: SyncSender<Result<u64, OfferError>>,
        },
    }

    struct Owner {
        /// HWND as an integer: raw pointers are neither Send nor Sync, and this handle is only
        /// ever used for PostMessageW (thread-safe).
        hwnd: usize,
        tx: Sender<Cmd>,
        done: Mutex<Receiver<()>>,
    }

    static OWNER: OnceLock<Option<Owner>> = OnceLock::new();
    /// Set by the shutdown handler: no new offers after this, the legacy path takes over.
    static DOWN: AtomicBool = AtomicBool::new(false);

    /// Where `await_target_fetch` waits. Written by the owner thread on the first post-chord
    /// target fetch (or on loss of ownership / a newer offer).
    struct FetchSlot {
        id: u64,
        fetched: Option<(u64, bool)>,
        closed: bool,
    }
    static FETCH: Mutex<FetchSlot> = Mutex::new(FetchSlot {
        id: 0,
        fetched: None,
        closed: false,
    });
    static FETCH_CV: Condvar = Condvar::new();

    fn publish_fetch(f: impl FnOnce(&mut FetchSlot)) {
        if let Ok(mut g) = FETCH.lock() {
            f(&mut g);
        }
        FETCH_CV.notify_all();
    }

    /// Owner-thread state. Only ever touched on the owner thread, and never borrowed across a
    /// call that can re-enter the window procedure (see the module docs).
    struct State {
        ledger: OfferLedger,
        t0: Instant,
        next_id: u64,
        /// The current offer's text, already CRLF — what a render hands out.
        text: Option<String>,
        exclude: bool,
        fmt_history: u32,
        fmt_cloud: u32,
        self_pid: u32,
        reannounce_for: Option<u64>,
        reannounce_tries: u32,
        nofetch_for: Option<u64>,
    }

    impl State {
        fn now(&self) -> u64 {
            self.t0.elapsed().as_millis() as u64
        }
    }

    thread_local! {
        static ST: RefCell<Option<State>> = const { RefCell::new(None) };
        static RX: RefCell<Option<Receiver<Cmd>>> = const { RefCell::new(None) };
        /// True while WE are emptying the clipboard: the `WM_DESTROYCLIPBOARD` that sends to us
        /// is our own doing, not a loss of ownership.
        static SELF_EMPTYING: Cell<bool> = const { Cell::new(false) };
    }

    /// Run `f` on the owner state if it is free. A failed borrow means a re-entry we did not
    /// expect; skipping is always safe here (the worst case is one missing log line).
    fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
        ST.with(|s| match s.try_borrow_mut() {
            Ok(mut g) => g.as_mut().map(f),
            Err(_) => {
                tracing::warn!("[winclip] state busy (re-entrant message) — skipped");
                None
            }
        })
    }

    fn owner() -> Option<&'static Owner> {
        OWNER.get_or_init(start).as_ref()
    }

    fn start() -> Option<Owner> {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Option<usize>>(1);
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let spawned = std::thread::Builder::new()
            .name("fwf-clip-owner".into())
            .spawn(move || {
                owner_thread(rx, &ready_tx);
                let _ = done_tx.send(());
            });
        if let Err(e) = spawned {
            tracing::warn!("[winclip] owner thread did not start: {e} — using the legacy write");
            return None;
        }
        match ready_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(hwnd)) => Some(Owner {
                hwnd,
                tx,
                done: Mutex::new(done_rx),
            }),
            _ => {
                tracing::warn!("[winclip] owner window did not come up — using the legacy write");
                None
            }
        }
    }

    fn owner_thread(rx: Receiver<Cmd>, ready: &SyncSender<Option<usize>>) {
        unsafe {
            let class_name: Vec<u16> = "fwf-clip-owner\0".encode_utf16().collect();
            let hinstance = GetModuleHandleW(std::ptr::null());
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
            // Registered once per process; a failure here just means it already exists.
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
                HWND_MESSAGE, // message-only: never visible, but a valid clipboard owner
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                let _ = ready.send(None);
                return;
            }
            let history: Vec<u16> = "CanIncludeInClipboardHistory\0".encode_utf16().collect();
            let cloud: Vec<u16> = "CanUploadToCloudClipboard\0".encode_utf16().collect();
            let state = State {
                ledger: OfferLedger::new(mode()),
                t0: Instant::now(),
                next_id: 1,
                text: None,
                exclude: false,
                fmt_history: RegisterClipboardFormatW(history.as_ptr()),
                fmt_cloud: RegisterClipboardFormatW(cloud.as_ptr()),
                self_pid: GetCurrentProcessId(),
                reannounce_for: None,
                reannounce_tries: 0,
                nofetch_for: None,
            };
            ST.with(|s| *s.borrow_mut() = Some(state));
            RX.with(|r| *r.borrow_mut() = Some(rx));
            tracing::info!(
                "[winclip] owner up (mode={}, settle={}ms)",
                mode().as_str(),
                settle_ms()
            );
            let _ = ready.send(Some(hwnd as usize));
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        }
    }

    /// Never lets a panic cross into user32: a panic in an `extern "system"` fn aborts the
    /// process, and this runs inside OTHER processes' `GetClipboardData` calls.
    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle(hwnd, msg, wparam, lparam)
        }));
        match handled {
            Ok(Some(r)) => r,
            Ok(None) => DefWindowProcW(hwnd, msg, wparam, lparam),
            Err(_) => {
                tracing::error!("[winclip] panic in the clipboard owner (msg {msg:#x}) — ignored");
                0
            }
        }
    }

    fn handle(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_CMD => {
                drain_commands(hwnd);
                Some(0)
            }
            WM_CHORD => {
                on_chord(hwnd, wparam as u64, lparam as u32);
                Some(0)
            }
            WM_RENDERFORMAT => {
                if wparam as u32 == CF_UNICODETEXT {
                    on_render_format(hwnd);
                }
                Some(0)
            }
            WM_RENDERALLFORMATS => {
                on_render_all(hwnd);
                Some(0)
            }
            WM_DESTROYCLIPBOARD => {
                if !SELF_EMPTYING.with(|c| c.get()) {
                    on_lost(hwnd);
                }
                Some(0)
            }
            WM_TIMER if wparam == T_REANNOUNCE => {
                on_reannounce_timer(hwnd);
                Some(0)
            }
            WM_TIMER if wparam == T_NOFETCH => {
                on_nofetch_timer(hwnd);
                Some(0)
            }
            WM_SHUTDOWN => {
                DOWN.store(true, Ordering::SeqCst);
                publish_fetch(|s| s.closed = true);
                // Sends WM_RENDERALLFORMATS while we still own unrendered data, so the text the
                // user may still paste survives our exit. No borrow is held here.
                unsafe {
                    DestroyWindow(hwnd);
                    PostQuitMessage(0);
                }
                Some(0)
            }
            _ => None,
        }
    }

    /// Pid → exe basename (the per-app rule identity), "unknown" when unreadable.
    fn exe_of(pid: u32) -> String {
        if pid == 0 {
            return "unknown".into();
        }
        unsafe { crate::focus::exe_basename(pid) }.unwrap_or_else(|| "unknown".into())
    }

    /// The process that currently has the clipboard open (the one asking us to render, or the
    /// one that just emptied it), as (pid, exe). (0, "unknown") when it opened it windowless.
    fn clipboard_opener() -> (u32, String) {
        let w = unsafe { GetOpenClipboardWindow() };
        if w.is_null() {
            return (0, "unknown".into());
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(w, &mut pid) };
        (pid, exe_of(pid))
    }

    /// Let other threads' SENT messages through while we wait: a reader holding the clipboard
    /// open may be blocked inside `GetClipboardData` waiting for US to render the previous
    /// offer, and sleeping without pumping would deadlock the two of us until the retries ran out.
    fn pump_sent_messages() {
        let mut msg: MSG = unsafe { std::mem::zeroed() };
        unsafe {
            PeekMessageW(
                &mut msg,
                std::ptr::null_mut(),
                0,
                0,
                PM_NOREMOVE | PM_QS_SENDMESSAGE,
            );
        }
    }

    /// Open the clipboard as `hwnd` (so `EmptyClipboard` makes us the owner), retrying 10×10ms.
    fn open_with_retry(hwnd: HWND) -> bool {
        for attempt in 0..10 {
            if unsafe { OpenClipboard(hwnd) } != 0 {
                return true;
            }
            if attempt < 9 {
                pump_sent_messages();
                std::thread::sleep(Duration::from_millis(10));
                pump_sent_messages();
            }
        }
        false
    }

    /// With the clipboard OPEN: empty it (becoming the owner), announce CF_UNICODETEXT without
    /// data, and — when asked — mark the item as not-for-history / not-for-cloud. Returns
    /// Ok(excluded) or Err(Unavailable) when the delayed announcement did not take.
    ///
    /// Never sets `ExcludeClipboardContentFromMonitorProcessing`: that hides the item from
    /// clipboard LISTENERS, and mstsc is one — it could stop syncing our text to the remote.
    fn announce(exclude: bool, fmt_history: u32, fmt_cloud: u32) -> Result<bool, OfferError> {
        SELF_EMPTYING.with(|c| c.set(true));
        let emptied = unsafe { EmptyClipboard() } != 0;
        SELF_EMPTYING.with(|c| c.set(false));
        if !emptied {
            return Err(OfferError::Busy);
        }
        unsafe {
            SetLastError(0);
            // NULL = delayed rendering; returns NULL on success too, so verify the format instead.
            SetClipboardData(CF_UNICODETEXT, std::ptr::null_mut());
            if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
                return Err(OfferError::Unavailable);
            }
        }
        if !exclude {
            return Ok(false);
        }
        let mut all = true;
        for fmt in [fmt_history, fmt_cloud] {
            all &= fmt != 0 && set_dword_zero(fmt);
        }
        Ok(all)
    }

    /// Put a DWORD 0 under `fmt` (the documented "do not include" value for the two registered
    /// history/cloud formats). Frees the allocation on every failure path.
    fn set_dword_zero(fmt: u32) -> bool {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, 4);
            if h.is_null() {
                return false;
            }
            let p = GlobalLock(h) as *mut u32;
            if p.is_null() {
                GlobalFree(h);
                return false;
            }
            p.write_unaligned(0);
            GlobalUnlock(h);
            if SetClipboardData(fmt, h as HANDLE).is_null() {
                GlobalFree(h);
                return false;
            }
            true
        }
    }

    /// Hand `text` (already CRLF) to the clipboard as real CF_UNICODETEXT data. Only valid inside
    /// WM_RENDERFORMAT (no OpenClipboard — the requester has it open) or with the clipboard open
    /// (WM_RENDERALLFORMATS).
    fn render_text(text: &str) -> bool {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let bytes = wide.len() * 2;
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if h.is_null() {
                return false;
            }
            let p = GlobalLock(h) as *mut u16;
            if p.is_null() {
                GlobalFree(h);
                return false;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
            GlobalUnlock(h);
            if SetClipboardData(CF_UNICODETEXT, h as HANDLE).is_null() {
                GlobalFree(h);
                return false;
            }
            true
        }
    }

    fn drain_commands(hwnd: HWND) {
        loop {
            let cmd = RX.with(|r| {
                r.try_borrow()
                    .ok()
                    .and_then(|g| g.as_ref()?.try_recv().ok())
            });
            let Some(cmd) = cmd else { break };
            match cmd {
                Cmd::Offer {
                    text_lf,
                    exclude,
                    deadline,
                    reply,
                } => {
                    if Instant::now() > deadline {
                        // The caller already reported "nothing written" and will re-send; acting
                        // now would put text on the clipboard behind its back.
                        tracing::info!("[winclip] dropped a stale offer (caller timed out)");
                        continue;
                    }
                    let r = do_offer(hwnd, &text_lf, exclude);
                    let _ = reply.send(r);
                }
            }
        }
    }

    fn do_offer(hwnd: HWND, text_lf: &str, exclude: bool) -> Result<u64, OfferError> {
        let started = Instant::now();
        let Some((id, fmt_history, fmt_cloud)) = with_state(|s| {
            let id = s.next_id;
            s.next_id += 1;
            (id, s.fmt_history, s.fmt_cloud)
        }) else {
            return Err(OfferError::Unavailable);
        };
        if !open_with_retry(hwnd) {
            tracing::warn!("[winclip] offer #{id} FAILED: busy — nothing written, caller re-sends");
            return Err(OfferError::Busy);
        }
        let announced = announce(exclude, fmt_history, fmt_cloud);
        unsafe { CloseClipboard() };
        let excluded = match announced {
            Ok(x) => x,
            Err(e) => {
                let why = match e {
                    OfferError::Busy => "busy — nothing written, caller re-sends",
                    _ => "delayed rendering refused — falling back to the legacy write",
                };
                tracing::warn!("[winclip] offer #{id} FAILED: {why}");
                return Err(e);
            }
        };
        let crlf = crate::inject::clipboard_newlines(text_lf, true).into_owned();
        let chars = crlf.chars().count();
        let superseded = with_state(|s| {
            let now = s.now();
            s.text = Some(crlf);
            s.exclude = exclude;
            s.reannounce_for = None;
            s.reannounce_tries = 0;
            s.nofetch_for = None;
            s.ledger.on_offer(id, now)
        })
        .flatten();
        unsafe {
            KillTimer(hwnd, T_REANNOUNCE);
            KillTimer(hwnd, T_NOFETCH);
        }
        publish_fetch(|f| {
            f.id = id;
            f.fetched = None;
            f.closed = false;
        });
        if let Some(sup) = superseded {
            if sup.unfetched_chord {
                tracing::warn!(
                    "[winclip] #{} superseded by #{id} after {}ms (target fetches=0) — our chord went out but the target never fetched it: the remote pasted its cached clipboard",
                    sup.prev_id,
                    sup.age_ms
                );
            } else {
                tracing::info!(
                    "[winclip] #{} superseded by #{id} after {}ms (target fetches={})",
                    sup.prev_id,
                    sup.age_ms,
                    sup.target_fetches
                );
            }
        }
        tracing::info!(
            "[winclip] offer #{id}: {chars} chars CRLF, delayed, history/cloud excluded={} ({:.1}ms)",
            exclude && excluded,
            started.elapsed().as_secs_f64() * 1000.0
        );
        if exclude && !excluded {
            tracing::warn!(
                "[winclip] offer #{id}: the history/cloud exclusion formats did not take"
            );
        }
        Ok(id)
    }

    fn on_chord(hwnd: HWND, id: u64, pid: u32) {
        let armed = with_state(|s| {
            let now = s.now();
            let r = s.ledger.on_chord(id, pid, now);
            if r.is_some() {
                s.nofetch_for = Some(id);
            }
            r
        })
        .flatten();
        match armed {
            Some(after_offer) => {
                tracing::info!(
                    "[winclip] chord #{id} → {} (pid {pid}) +{after_offer}ms after offer",
                    exe_of(pid)
                );
                unsafe { SetTimer(hwnd, T_NOFETCH, NOFETCH_MS, None) };
            }
            None => tracing::info!("[winclip] chord #{id}: offer no longer current — not tracked"),
        }
    }

    fn classify(pid: u32, exe: &str, self_pid: u32, chord_pid: Option<u32>) -> Requester {
        if pid == 0 {
            Requester::Unknown
        } else if pid == self_pid {
            Requester::SelfApp
        } else if chord_pid == Some(pid) || crate::remote_desktop::is_remote_desktop_app(exe) {
            Requester::Target
        } else {
            Requester::Other
        }
    }

    fn on_render_format(hwnd: HWND) {
        let (pid, exe) = clipboard_opener();
        // Copy what we need OUT of the state; `SetClipboardData` below runs with no borrow held.
        let Some((text, self_pid, chord_pid)) =
            with_state(|s| (s.text.clone(), s.self_pid, s.ledger.chord_pid()))
        else {
            return;
        };
        let Some(text) = text else {
            tracing::warn!("[winclip] render requested by {exe} (pid {pid}) but no offer is held");
            return;
        };
        if !render_text(&text) {
            tracing::warn!(
                "[winclip] render for {exe} (pid {pid}) FAILED: allocation/SetClipboardData"
            );
        }
        let who = classify(pid, &exe, self_pid, chord_pid);
        let Some(rep) = with_state(|s| {
            let now = s.now();
            let rep = s.ledger.on_render(who, now);
            if let Some(r) = rep {
                if r.verdict == RenderVerdict::Reannounce {
                    s.reannounce_for = Some(r.id);
                    s.reannounce_tries = 0;
                }
            }
            rep
        })
        .flatten() else {
            return;
        };
        let chord_part = rep
            .since_chord_ms
            .map(|ms| format!(", +{ms}ms after chord"))
            .unwrap_or_else(|| ", before our chord".into());
        let id = rep.id;
        match rep.verdict {
            RenderVerdict::Blind => tracing::info!(
                "[winclip] render #{id} for {exe} (pid {pid}, {}) +{}ms after offer{chord_part} — later fetches invisible (blind)",
                who.as_str(),
                rep.since_offer_ms
            ),
            RenderVerdict::EagerRefetch => tracing::info!(
                "[winclip] #{id} target re-fetched after the re-announce ({exe}, pid {pid}, +{}ms after offer)",
                rep.since_offer_ms
            ),
            RenderVerdict::Plain | RenderVerdict::Reannounce => tracing::info!(
                "[winclip] render #{id} for {exe} (pid {pid}, {}) +{}ms after offer{chord_part}",
                who.as_str(),
                rep.since_offer_ms
            ),
        }
        if who == Requester::Target {
            if let Some(after_chord) = rep.since_chord_ms {
                let reannounce = rep.verdict == RenderVerdict::Reannounce;
                publish_fetch(|f| {
                    if f.id == id && f.fetched.is_none() {
                        f.fetched = Some((after_chord, reannounce));
                    }
                });
            }
        }
        if rep.verdict == RenderVerdict::Reannounce {
            unsafe { SetTimer(hwnd, T_REANNOUNCE, REANNOUNCE_DELAY_MS, None) };
        }
    }

    fn on_render_all(hwnd: HWND) {
        let Some((text, id)) = with_state(|s| (s.text.clone(), s.ledger.current_id())) else {
            return;
        };
        if unsafe { OpenClipboard(hwnd) } == 0 {
            tracing::warn!("[winclip] shutdown: could not open the clipboard to render for exit");
            return;
        }
        // Only if we are STILL the owner — otherwise the clipboard is someone else's by now.
        if unsafe { GetClipboardOwner() } == hwnd {
            if let (Some(text), Some(id)) = (text, id) {
                if render_text(&text) {
                    tracing::info!("[winclip] shutdown: rendered #{id} for exit");
                } else {
                    tracing::warn!("[winclip] shutdown: rendering #{id} for exit FAILED");
                }
            }
        }
        unsafe { CloseClipboard() };
    }

    fn on_lost(hwnd: HWND) {
        let (_, exe) = clipboard_opener();
        let lost = with_state(|s| {
            let now = s.now();
            s.text = None;
            s.reannounce_for = None;
            s.nofetch_for = None;
            s.ledger.on_lost(now)
        })
        .flatten();
        unsafe {
            KillTimer(hwnd, T_REANNOUNCE);
            KillTimer(hwnd, T_NOFETCH);
        }
        publish_fetch(|f| f.closed = true);
        if let Some((id, age)) = lost {
            tracing::info!("[winclip] #{id} ownership lost to {exe} after {age}ms");
        }
    }

    fn on_reannounce_timer(hwnd: HWND) {
        unsafe { KillTimer(hwnd, T_REANNOUNCE) };
        let Some((want, current, exclude, fh, fc)) = with_state(|s| {
            (
                s.reannounce_for,
                s.ledger.current_id(),
                s.exclude,
                s.fmt_history,
                s.fmt_cloud,
            )
        }) else {
            return;
        };
        let Some(id) = want else { return };
        // Same text, and only while it is still ours: a newer offer or another app's copy wins.
        if current != Some(id) || unsafe { GetClipboardOwner() } != hwnd {
            with_state(|s| s.reannounce_for = None);
            return;
        }
        if unsafe { OpenClipboard(hwnd) } == 0 {
            let tries = with_state(|s| {
                s.reannounce_tries += 1;
                s.reannounce_tries
            })
            .unwrap_or(REANNOUNCE_TRIES);
            if tries < REANNOUNCE_TRIES {
                unsafe { SetTimer(hwnd, T_REANNOUNCE, REANNOUNCE_DELAY_MS, None) };
            } else {
                tracing::warn!(
                    "[winclip] #{id} re-announce given up: the clipboard stayed open for {tries} tries"
                );
                with_state(|s| s.reannounce_for = None);
            }
            return;
        }
        let announced = announce(exclude, fh, fc);
        unsafe { CloseClipboard() };
        let after = with_state(|s| {
            s.reannounce_for = None;
            let now = s.now();
            s.ledger.on_reannounced(id, now)
        })
        .flatten();
        match (announced, after) {
            (Ok(_), Some(ms)) => {
                tracing::info!("[winclip] #{id} re-announced {ms}ms after the target fetch")
            }
            (Ok(_), None) => {}
            (Err(e), _) => tracing::warn!("[winclip] #{id} re-announce FAILED: {e:?}"),
        }
    }

    fn on_nofetch_timer(hwnd: HWND) {
        unsafe { KillTimer(hwnd, T_NOFETCH) };
        let Some((id, verdict, pid)) = with_state(|s| {
            let id = s.nofetch_for.take()?;
            Some((id, s.ledger.on_nofetch_timer(id), s.ledger.chord_pid()))
        })
        .flatten() else {
            return;
        };
        match verdict {
            NoFetchVerdict::NoFetch => {
                let pid = pid.unwrap_or(0);
                tracing::warn!(
                    "[winclip] #{id}: NO FETCH by {} within {NOFETCH_MS}ms of the chord — remote pasted its cached clipboard (stale/duplicate) or target took no text",
                    exe_of(pid)
                );
            }
            NoFetchVerdict::Blind => tracing::info!(
                "[winclip] #{id}: no visible target fetch within {NOFETCH_MS}ms — blind (someone else rendered first)"
            ),
            NoFetchVerdict::Fetched | NoFetchVerdict::Stale => {}
        }
    }

    // ---- caller side ----

    /// Offer `text_lf` (LF line endings; the owner renders CRLF) as the clipboard's text via
    /// delayed rendering. Blocks ≤750ms. See [`OfferError`] for what each failure means.
    pub fn offer(text_lf: &str, exclude: bool) -> Result<u64, OfferError> {
        if DOWN.load(Ordering::SeqCst) {
            return Err(OfferError::Unavailable);
        }
        let Some(o) = owner() else {
            return Err(OfferError::Unavailable);
        };
        let (reply, rx) = mpsc::sync_channel(1);
        let deadline = Instant::now() + OFFER_TIMEOUT;
        let cmd = Cmd::Offer {
            text_lf: text_lf.to_string(),
            exclude,
            deadline,
            reply,
        };
        if o.tx.send(cmd).is_err() {
            return Err(OfferError::Unavailable);
        }
        if unsafe { PostMessageW(o.hwnd as HWND, WM_CMD, 0, 0) } == 0 {
            // The command stays queued and is dropped as stale if the owner ever drains it.
            return Err(OfferError::Unavailable);
        }
        match rx.recv_timeout(OFFER_TIMEOUT) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                tracing::warn!(
                    "[winclip] offer timed out after {}ms",
                    OFFER_TIMEOUT.as_millis()
                );
                Err(OfferError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(OfferError::Unavailable),
        }
    }

    /// Tell the owner our paste chord for offer `id` is going to `target_pid` (0 = unknown). Arms
    /// the NO-FETCH timer and, in enforce mode, makes the target's fetch trigger a re-announce.
    pub fn note_chord(id: u64, target_pid: u32) {
        if let Some(Some(o)) = OWNER.get() {
            unsafe {
                PostMessageW(o.hwnd as HWND, WM_CHORD, id as WPARAM, target_pid as LPARAM);
            }
        }
    }

    /// Wait (≤ `max`) for the target's first post-chord fetch of offer `id`. Returns early on a
    /// newer offer, loss of ownership or shutdown.
    pub fn await_target_fetch(id: u64, max: Duration) -> FetchWait {
        let Ok(g) = FETCH.lock() else {
            return FetchWait::NoFetch;
        };
        let res =
            FETCH_CV.wait_timeout_while(g, max, |s| s.id == id && s.fetched.is_none() && !s.closed);
        match res {
            Ok((g, _)) => match (g.id == id, g.fetched) {
                (true, Some((after_chord_ms, reannounced))) => FetchWait::Fetched {
                    after_chord_ms,
                    reannounced,
                },
                _ => FetchWait::NoFetch,
            },
            Err(_) => FetchWait::NoFetch,
        }
    }

    /// Pid of the foreground window's process (0 when none) — the target of the chord we are
    /// about to press.
    pub fn foreground_pid() -> u32 {
        let mut pid = 0u32;
        unsafe {
            let w = GetForegroundWindow();
            if !w.is_null() {
                GetWindowThreadProcessId(w, &mut pid);
            }
        }
        pid
    }

    /// Exit path (`session::cleanup_for_exit`): render what we still owe so the last transcript
    /// stays pasteable after we are gone, then stop the thread. Bounded by `max`; a no-op when the
    /// owner was never started (it is never started just to be shut down).
    pub fn shutdown(max: Duration) {
        let Some(Some(o)) = OWNER.get() else {
            return;
        };
        if DOWN.swap(true, Ordering::SeqCst) {
            return; // already shut down (the exit path runs more than once)
        }
        if unsafe { PostMessageW(o.hwnd as HWND, WM_SHUTDOWN, 0, 0) } == 0 {
            return;
        }
        if let Ok(done) = o.done.lock() {
            if done.recv_timeout(max).is_err() {
                tracing::warn!(
                    "[winclip] shutdown: owner did not finish within {}ms",
                    max.as_millis()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_and_settle_parse() {
        assert_eq!(parse_mode(None), Mode::Diag);
        assert_eq!(parse_mode(Some("legacy")), Mode::Legacy);
        assert_eq!(parse_mode(Some(" ENFORCE ")), Mode::Enforce);
        assert_eq!(parse_mode(Some("diag")), Mode::Diag);
        assert_eq!(parse_mode(Some("bogus")), Mode::Diag);
        assert_eq!(parse_settle(None), 300);
        assert_eq!(parse_settle(Some("0")), 0);
        assert_eq!(parse_settle(Some("450")), 450);
        assert_eq!(parse_settle(Some("junk")), 300);
        assert_eq!(parse_settle(Some("999999")), MAX_SETTLE_MS);
    }

    #[test]
    fn enforce_reannounces_once_then_reports_eager_refetch() {
        let mut l = OfferLedger::new(Mode::Enforce);
        assert!(l.on_offer(1, 0).is_none());
        assert_eq!(l.on_chord(1, 4312, 300), Some(300));
        assert_eq!(l.chord_pid(), Some(4312));
        let r = l.on_render(Requester::Target, 348).unwrap();
        assert_eq!(r.verdict, RenderVerdict::Reannounce);
        assert_eq!(r.since_offer_ms, 348);
        assert_eq!(r.since_chord_ms, Some(48));
        assert_eq!(l.on_reannounced(1, 379), Some(31));
        // The loop guard: a second target fetch never schedules another re-announce.
        let r = l.on_render(Requester::Target, 400).unwrap();
        assert_eq!(r.verdict, RenderVerdict::EagerRefetch);
        let r = l.on_render(Requester::Target, 500).unwrap();
        assert_eq!(r.verdict, RenderVerdict::EagerRefetch);
    }

    #[test]
    fn diag_never_reannounces() {
        let mut l = OfferLedger::new(Mode::Diag);
        l.on_offer(1, 0);
        l.on_chord(1, 7, 300);
        for t in [350, 400, 450] {
            assert_eq!(
                l.on_render(Requester::Target, t).unwrap().verdict,
                RenderVerdict::Plain
            );
        }
    }

    #[test]
    fn a_pre_chord_render_never_reannounces() {
        let mut l = OfferLedger::new(Mode::Enforce);
        l.on_offer(1, 0);
        let r = l.on_render(Requester::Target, 10).unwrap();
        assert_eq!(r.verdict, RenderVerdict::Plain);
        assert_eq!(r.since_chord_ms, None);
    }

    #[test]
    fn another_process_rendering_first_blinds_the_offer() {
        let mut l = OfferLedger::new(Mode::Enforce);
        l.on_offer(1, 0);
        for who in [Requester::Other, Requester::SelfApp, Requester::Unknown] {
            let r = l.on_render(who, 5).unwrap();
            assert_eq!(r.verdict, RenderVerdict::Blind);
        }
        l.on_chord(1, 7, 300);
        // No target fetch was visible, but we were blind: no stale-paste warning.
        assert_eq!(l.on_nofetch_timer(1), NoFetchVerdict::Blind);
    }

    #[test]
    fn nofetch_warns_only_with_a_chord_and_no_target_render() {
        let mut l = OfferLedger::new(Mode::Diag);
        l.on_offer(1, 0);
        // No chord yet → the timer is meaningless.
        assert_eq!(l.on_nofetch_timer(1), NoFetchVerdict::Stale);
        l.on_chord(1, 7, 300);
        assert_eq!(l.on_nofetch_timer(1), NoFetchVerdict::NoFetch);
        l.on_render(Requester::Target, 400);
        assert_eq!(l.on_nofetch_timer(1), NoFetchVerdict::Fetched);
        // A timer for an offer that is no longer current is stale.
        l.on_offer(2, 500);
        assert_eq!(l.on_nofetch_timer(1), NoFetchVerdict::Stale);
        // A chord for an old id arms nothing.
        assert_eq!(l.on_chord(1, 7, 600), None);
    }

    #[test]
    fn superseded_reports_an_unfetched_chord() {
        let mut l = OfferLedger::new(Mode::Diag);
        l.on_offer(12, 0);
        l.on_chord(12, 7, 300);
        let s = l.on_offer(13, 2100).unwrap();
        assert_eq!(s.prev_id, 12);
        assert_eq!(s.age_ms, 2100);
        assert_eq!(s.target_fetches, 0);
        assert!(
            s.unfetched_chord,
            "chord without a fetch is the stale-paste signature"
        );

        l.on_chord(13, 7, 2400);
        l.on_render(Requester::Target, 2450);
        let s = l.on_offer(14, 3000).unwrap();
        assert_eq!(s.target_fetches, 1);
        assert!(!s.unfetched_chord);

        // No chord → nothing to warn about either.
        let s = l.on_offer(15, 3100).unwrap();
        assert!(!s.unfetched_chord);
    }

    #[test]
    fn losing_ownership_ends_the_offer() {
        let mut l = OfferLedger::new(Mode::Enforce);
        l.on_offer(1, 0);
        assert_eq!(l.on_lost(5400), Some((1, 5400)));
        assert_eq!(l.current_id(), None);
        assert!(l.on_render(Requester::Target, 5500).is_none());
        assert!(
            l.on_offer(2, 6000).is_none(),
            "a lost offer is not 'superseded'"
        );
    }
}
