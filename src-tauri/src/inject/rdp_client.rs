//! Remote-desktop / VDI client detection, shared by every place that has to treat such a
//! target differently: the paste path (`inject::text` — longer settle, no restore, the
//! delayed-rendering clipboard owner on Windows), the per-app rule editor
//! (`commands::remote_desktop_auto_detected`, which shows what "Auto" would decide) and the
//! Quick-Add copy-chord grab (`aux_windows::quickadd::win_seed`, which holds its window for the copy to cross).
//!
//! Two independent detectors, because neither is complete on its own:
//!   * **by app id** ([`is_remote_desktop_app`]) — the focused app's exe basename (Windows) or
//!     AT-SPI application name (Linux). Covers every client we know by name, on every platform.
//!   * **by window class** ([`focus_is_remote_desktop_client`], Windows only) — the RDP ActiveX
//!     control keeps its window classes wherever it is hosted, so this also catches RDCMan,
//!     mRemoteNG and other hosts whose exe name says nothing about RDP.
//!
//! A per-app rule can override both ("Remote desktop: On / Off"); `inject_text` logs which
//! detector fired and whether the rule overrode it, so a support log answers "why was this
//! treated as remote" without a repro.

/// Remote-desktop / VDI clients, matched on the focused app id. Their clipboard reaches the
/// remote host ASYNCHRONOUSLY (RDP "delayed rendering" even fetches the data only when the
/// remote app pastes), so (a) the usual 60ms local settle before Ctrl+V is not enough for the
/// new content to cross before the forwarded keystroke, and (b) a post-paste restore can be
/// what the remote's paste actually fetches. Paste into these targets uses a longer settle
/// and skips the clipboard restore entirely.
///
/// Substring match on the lowercased id, so `xfreerdp`/`wlfreerdp`, `org.remmina.Remmina` and
/// `RemoteDesktopManager64` all hit. Every entry is therefore checked against ordinary app ids
/// before it goes in: a bare `connections` would have matched any app with that word in its
/// name, which is why GNOME Connections is listed by its two real ids instead.
pub fn is_remote_desktop_app(app_id: &str) -> bool {
    const CLIENTS: &[&str] = &[
        "mstsc",
        "msrdc",
        "rdcman",    // Microsoft RDP clients (classic / Windows-App-AVD / RDCMan)
        "rdclient",  // Microsoft Remote Desktop (store app / macOS "Microsoft Remote Desktop")
        "vmconnect", // Hyper-V console
        "wfica32",
        "cdviewer",     // Citrix Desktop Viewer (the window a published desktop runs in)
        "citrix",       // Citrix Workspace
        "vmware",       // VMware Horizon / Workstation (Tools clipboard sync is async too)
        "vmrc",         // VMware Remote Console
        "virtualboxvm", // VirtualBox VM window (shared clipboard is async)
        "virt-viewer",
        "remote-viewer", // SPICE
        "remmina",
        "freerdp", // Linux RDP clients
        "krdc",    // KDE Remote Desktop Client
        "gnome-connections",
        "org.gnome.connections", // GNOME Connections (NOT a bare "connections" — see above)
        "vinagre",               // GNOME's older remote desktop viewer
        "mremoteng",
        "royalts",
        "remotedesktopmanager", // Devolutions RDM (hosts the RDP ActiveX)
        "vncviewer",            // RealVNC / TightVNC classic / UltraVNC viewers
        "tvnviewer",            // TightVNC 2.x
        "tigervnc",
        "rustdesk",
        "anydesk",
        "teamviewer",
        "parsec",
        "nxplayer",
    ];
    let a = app_id.to_lowercase();
    CLIENTS.iter().any(|c| a.contains(c))
}

/// Window classes that belong to an RDP client surface, wherever it is hosted. Exact
/// (case-insensitive) match — these are fixed class names, not app ids.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows detector (and the tests) ask
pub fn is_remote_window_class(class: &str) -> bool {
    const REMOTE_CLASSES: &[&str] = &[
        "TscShellContainerClass", // mstsc.exe top-level
        "IHWindowClass",          // mstsc input sink; also the embedded ActiveX (RDCMan, mRemoteNG)
        "OPWindowClass",          // mstsc output surface (focus can land here)
        "RAIL_WINDOW",            // RemoteApp seamless windows
        "RdClientWindow",         // msrdc.exe (Windows App / Azure Virtual Desktop)
        "FreeRDP",                // wfreerdp
    ];
    REMOTE_CLASSES.iter().any(|k| class.eq_ignore_ascii_case(k))
}

/// Is the user's focus in a remote-desktop client window right now? Matched by window class
/// (see [`is_remote_window_class`]): mstsc's shell/input/output windows (the input sink also
/// covers the RDP ActiveX embedded in RDCMan / mRemoteNG), RemoteApp seamless windows, the
/// Windows App (msrdc), and FreeRDP. An unrecognized client just keeps the non-RDP behavior.
///
/// Checked as: the foreground window, plus the foreground thread's focus and active windows
/// (`GetGUIThreadInfo`) — focus usually sits on a CHILD (`IHWindowClass`) whose top-level is
/// the shell container.
#[cfg(windows)]
pub fn focus_is_remote_desktop_client() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GUITHREADINFO,
    };
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
        if have_info {
            info.hwndFocus
        } else {
            std::ptr::null_mut()
        },
        if have_info {
            info.hwndActive
        } else {
            std::ptr::null_mut()
        },
    ];
    candidates
        .into_iter()
        .filter_map(class_of)
        .any(|c| is_remote_window_class(&c))
}

/// Non-Windows twin: window classes are a Win32 concept. The app-id detector above is what
/// catches Remmina, KRDC & co. on Linux.
#[cfg(not(windows))]
pub fn focus_is_remote_desktop_client() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{is_remote_desktop_app, is_remote_window_class};

    #[test]
    fn remote_desktop_app_ids() {
        for id in [
            "mstsc",
            "MSRDC",
            "org.remmina.Remmina",
            "xfreerdp",
            "wfica32",
            "vmconnect",
            "CDViewer",
            "RdClient",
            "mRemoteNG",
            "RoyalTS",
            "RemoteDesktopManager64",
            "VirtualBoxVM",
            "vncviewer",
            "tvnviewer",
            "TigerVNC Viewer",
            "vmrc",
            "krdc",
            "org.kde.krdc",
            "gnome-connections",
            "org.gnome.Connections",
            "Vinagre",
        ] {
            assert!(is_remote_desktop_app(id), "{id} should be remote");
        }
        for id in [
            "firefox",
            "kate",
            "ms-teams",
            "code",
            "connections",
            "Connections",
            "notepad",
            "org.kde.konsole",
        ] {
            assert!(!is_remote_desktop_app(id), "{id} should not be remote");
        }
    }

    #[test]
    fn remote_window_classes() {
        for c in [
            "TscShellContainerClass",
            "tscshellcontainerclass",
            "IHWindowClass",
            "OPWindowClass",
            "RAIL_WINDOW",
            "RdClientWindow",
            "FreeRDP",
        ] {
            assert!(is_remote_window_class(c), "{c} should be a remote class");
        }
        for c in ["Chrome_WidgetWin_1", "Notepad", "IHWindow", "", "FreeRDPx"] {
            assert!(
                !is_remote_window_class(c),
                "{c} should not be a remote class"
            );
        }
    }
}
