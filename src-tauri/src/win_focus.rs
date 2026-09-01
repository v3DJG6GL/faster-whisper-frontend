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

use super::{FocusedApp, Snapshot, APP_ID_MAX};
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
/// itself only re-reads the target every 700 ms, so 1 s recovery is invisible. A tick
/// is near-free while the foreground HWND is unchanged (see `LAST_HWND`), so the poll
/// costs nothing while the app idles in the tray.
const POLL_MS: u32 = 1000;

/// The foreground HWND the previous fold saw. Compared BEFORE any process work: the 1 s
/// poll almost always lands on an unchanged foreground, and without this pre-check every
/// tick opened a handle to the foreground process (OpenProcess + QueryFullProcessImageNameW
/// + a UTF-16 decode) just to discover nothing changed. Tracker-thread only (the timer and
/// the WinEvent callback both land there).
static LAST_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

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
/// `last_other` is written only at the transition INTO our own window — so "the app
/// the user came from" can't go stale. (Shell surfaces never reach here: `foreground_app_id`
/// returns None for them, which keeps the previous real app current.)
fn fold_foreground() {
    let Some(snap) = SNAP.get() else { return };
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return; // transient during activation hand-off
    }
    use std::sync::atomic::Ordering::Relaxed;
    if LAST_HWND.load(Relaxed) == hwnd as isize {
        return; // same window as last time — nothing to re-resolve
    }
    let Some(app_id) = (unsafe { foreground_app_id(hwnd) }) else {
        // Shell foreground, or a process not readable YET (a UWP frame whose CoreWindow child
        // is still to come, an OpenProcess that failed mid-start): keep the previous state and
        // — by not recording the HWND — let the 1 s poll re-resolve it, as it did before the
        // short-circuit existed.
        return;
    };
    LAST_HWND.store(hwnd as isize, Relaxed);
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

/// Identity of the foreground window's app, or None to keep the previous snapshot
/// untouched (a shell surface, or an unreadable process).
unsafe fn foreground_app_id(hwnd: HWND) -> Option<String> {
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
    // the real app's process owns the CoreWindow child. On a cold start that child does not
    // exist yet — None, never the frame host's own name, so the next poll tries again.
    let exe = if exe == "applicationframehost" { uwp_app(hwnd, pid)? } else { exe };
    // Judged on the RESOLVED exe, so a shell host behind the frame host is caught too.
    if is_shell_exe(&exe) {
        return None; // Start menu / Search / notification centre — the Linux plasmashell twin
    }
    Some(exe)
}

/// Shell surfaces that foreground a plain `Windows.UI.Core.CoreWindow` — a class every real
/// UWP app shares, so they cannot be filtered by class like the taskbar; filter by process
/// name instead, the way `is_noise` filters plasmashell on Linux. Without this the Start
/// menu became `current`, the chip's "→ app" readout named it, and a per-app rule for the
/// app the user came from silently stopped applying to a chord fired over the open menu.
fn is_shell_exe(base: &str) -> bool {
    matches!(
        base,
        "startmenuexperiencehost" // Start menu (Win10 1903+ / Win11)
            | "searchhost" | "searchapp" | "searchui" // Search (Win11 / Win10 / older)
            | "shellexperiencehost" // notification / action centre, volume flyout
            | "lockapp" // lock screen
            | "textinputhost" // touch keyboard / emoji panel
    )
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
    normalize_exe_basename(&path)
}

/// Full image path → lowercased basename without `.exe`, bounded and defanged; None when
/// nothing displayable is left (a name made only of format/control characters), which keeps
/// the previous snapshot exactly as the AT-SPI twin's empty-after-bound check does.
fn normalize_exe_basename(path: &str) -> Option<String> {
    let base = path.rsplit(['\\', '/']).next()?.to_lowercase();
    let base = base.strip_suffix(".exe").map(str::to_string).unwrap_or(base);
    // Same bound + defang the AT-SPI twin applies to ITS app id, for the same three sinks (the
    // overlay payload, a persisted AppRule that rides the sync push, the once-a-second log line).
    // The earlier refutation — "an NTFS filename cannot contain control characters" — is right for
    // Cc and wrong for Cf: a filename may carry U+202E/U+2066/U+200B, which is why the overlay's
    // target readout had to be defanged at the render.
    //
    // Doing it HERE rather than at each consumer is what keeps the app-rule matcher honest. The
    // rule side is normalized with the same character class, and an exe basename that kept an
    // invisible mark while the rule had it stripped would turn a working "never type here" rule
    // into a silent no-op — the failure the rule-side normalization exists to prevent, inverted.
    let id = crate::transport::bounded_server_text(&base, APP_ID_MAX);
    if id.trim().is_empty() {
        return None;
    }
    Some(id)
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

#[cfg(test)]
mod tests {
    use super::{is_shell_exe, normalize_exe_basename};

    #[test]
    fn an_exe_name_with_nothing_displayable_left_is_not_an_app_id() {
        assert_eq!(normalize_exe_basename("C:\\Apps\\Code.exe").as_deref(), Some("code"));
        assert_eq!(normalize_exe_basename("C:\\x\\\u{202e}.exe"), None);
        assert_eq!(normalize_exe_basename("C:\\x\\\u{1}\u{2}.exe"), None);
    }

    #[test]
    fn shell_hosts_are_filtered_by_name_and_real_apps_are_not() {
        for shell in ["startmenuexperiencehost", "searchhost", "searchapp", "shellexperiencehost", "lockapp"] {
            assert!(is_shell_exe(shell), "{shell}");
        }
        for app in ["explorer", "code", "chrome", "applicationframehost", "wordpad"] {
            assert!(!is_shell_exe(app), "{app}");
        }
    }
}
