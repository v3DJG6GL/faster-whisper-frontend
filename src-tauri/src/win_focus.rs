//! Windows foreground-app tracker — the Windows twin of the AT-SPI focus
//! listener, compiled as a child module of `atspi_guard` (via `#[path]`) so it
//! feeds the SAME private `Snapshot` the portable `focused_app()` reads.
//! Everything downstream — per-app rules, the chip's target readout, the
//! AppRules "Use current" capture — works unchanged once this populates it.
//!
//! Model: a dedicated thread owns a `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`
//! (out-of-context WinEvent hooks are delivered on the registering thread, which
//! must pump messages) plus a 1 s `WM_TIMER` poll of `GetForegroundWindow` as
//! belt-and-braces for the transitions the event is documented to miss
//! (fullscreen hand-offs, UAC, transient NULL foregrounds).
//!
//! App identity: the foreground process' exe basename, lowercased, `.exe`
//! stripped — `firefox`, `code`, `chrome` — which lines up with the Linux
//! AT-SPI application names for the cross-platform apps people write rules for,
//! and with the frontend's exact case-insensitive rule matcher. UWP apps hosted
//! by ApplicationFrameHost are resolved to the real app via their CoreWindow
//! child. Shell surfaces (taskbar, desktop, Alt-Tab flicker) are skipped by
//! WINDOW CLASS — the Windows counterpart of the plasmashell name-filter, which
//! can't work here because explorer-the-taskbar and explorer-the-file-manager
//! share one process name.
//!
//! `editable` stays `None` (unknown): the field guard is positive-only, so
//! unknown degrades to "type" — Linux parity for apps without an a11y tree.
//! Selection reads stay `Unavailable` (quick-add seeds via the copy-chord grab
//! in `quickadd::win_seed` instead).

use super::{FocusedApp, Snapshot};
use std::sync::{Arc, OnceLock};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumChildWindows, GetClassNameW, GetForegroundWindow, GetMessageW,
    GetWindowThreadProcessId, SetTimer, EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT,
    WM_TIMER,
};

/// Poll cadence backing up the foreground event (see module docs). The frontend
/// itself only re-reads the target every 700 ms, so 1 s recovery is invisible.
const POLL_MS: u32 = 1000;

/// The shared snapshot, reachable from the bare `extern "system"` WinEvent
/// callback (which can't capture). Set once by `run`; the `started` flag in
/// `atspi_guard::start` guarantees a single tracker per process.
static SNAP: OnceLock<Arc<parking_lot::Mutex<Snapshot>>> = OnceLock::new();

/// Thread entry — runs for the process lifetime, like the Linux listener
/// (nothing posts WM_QUIT here; teardown is process exit).
pub(super) fn run(snapshot: Arc<parking_lot::Mutex<Snapshot>>) {
    let _ = SNAP.set(snapshot);
    fold_foreground(); // seed before the first event/tick
    unsafe {
        let hook: HWINEVENTHOOK = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(),
            Some(fg_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_null() {
            tracing::warn!("[winfocus] SetWinEventHook failed; tracking by poll only");
        }
        let _ = SetTimer(std::ptr::null_mut(), 0, POLL_MS, None);
        tracing::info!("[winfocus] foreground-app tracker up");
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            // The poll timer targets no window (thread message) — handle it here;
            // DispatchMessageW would drop it. WinEvent callbacks are delivered
            // inside GetMessageW itself.
            if msg.message == WM_TIMER && msg.hwnd.is_null() {
                fold_foreground();
                continue;
            }
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn fg_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _id_event_thread: u32,
    _time: u32,
) {
    fold_foreground();
}

/// Read the current foreground app and fold it into the snapshot with the same
/// semantics as the Linux `set_current`: `current` tracks the latest real app,
/// `last_other` is written only at the transition INTO our own window / the
/// shell — so "the app the user came from" can't go stale.
fn fold_foreground() {
    let Some(snap) = SNAP.get() else { return };
    let Some(app_id) = foreground_app_id() else {
        return; // no/transient/shell foreground, or unreadable process — keep the previous state
    };
    let mut s = snap.lock();
    if s.current.as_ref().map_or(false, |c| c.app_id == app_id) {
        return; // unchanged (where the 1 s poll usually lands)
    }
    tracing::debug!("[winfocus] foreground: {app_id}");
    if super::is_noise(&app_id) {
        if let Some(prev) = s.current.take() {
            if !super::is_noise(&prev.app_id) {
                s.last_other = Some(prev);
            }
        }
    }
    s.current = Some(FocusedApp {
        title: app_id.clone(),
        app_id,
        editable: None,
        is_self: false,
    });
}

/// Identity of the current foreground window's app, or None to keep the
/// previous snapshot untouched.
fn foreground_app_id() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None; // transient during activation hand-off
        }
        if is_shell_window(hwnd) {
            return None; // taskbar / desktop / Alt-Tab flicker
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let exe = exe_basename(pid)?;
        // UWP: the foreground window belongs to the ApplicationFrameHost shim;
        // the real app's process owns the CoreWindow child.
        if exe == "applicationframehost" {
            if let Some(real) = uwp_app(hwnd, pid) {
                return Some(real);
            }
        }
        Some(exe)
    }
}

/// Shell surfaces whose momentary focus must not clobber the target readout.
unsafe fn is_shell_window(hwnd: HWND) -> bool {
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buf[..n as usize]);
    matches!(
        class.as_str(),
        "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"          // taskbar(s)
            | "Progman" | "WorkerW"                          // the desktop
            | "MultitaskingViewFrame" | "ForegroundStaging"  // Alt-Tab / Task View (Win10)
            | "XamlExplorerHostIslandWindow"                 // Alt-Tab / Task View (Win11)
    )
}

/// Process id → lowercased exe basename without `.exe`. None when the process
/// can't be opened (protected / cross-session) — callers keep the prior state.
unsafe fn exe_basename(pid: u32) -> Option<String> {
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if h.is_null() {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
    CloseHandle(h);
    if ok == 0 || len == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let base = path.rsplit(['\\', '/']).next()?.to_lowercase();
    Some(base.strip_suffix(".exe").map(str::to_string).unwrap_or(base))
}

/// Resolve a UWP app hosted by ApplicationFrameHost: find the child window of
/// class `Windows.UI.Core.CoreWindow` owned by a DIFFERENT process — that
/// process is the actual app.
unsafe fn uwp_app(host: HWND, host_pid: u32) -> Option<String> {
    struct Ctx {
        host_pid: u32,
        found: Option<u32>,
    }
    unsafe extern "system" fn enum_cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let ctx = &mut *(lp as *mut Ctx);
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "Windows.UI.Core.CoreWindow" {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != 0 && pid != ctx.host_pid {
                ctx.found = Some(pid);
                return 0; // stop enumerating
            }
        }
        1 // continue
    }
    let mut ctx = Ctx { host_pid, found: None };
    EnumChildWindows(host, Some(enum_cb), &mut ctx as *mut Ctx as LPARAM);
    exe_basename(ctx.found?)
}
