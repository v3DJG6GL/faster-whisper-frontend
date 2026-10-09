//! Remote-desktop / VDI client detection, shared by every place that has to treat such a
//! target differently: the paste path (`inject::text` — longer settle, no restore, the
//! delayed-rendering clipboard owner on Windows), the per-app rule editor
//! (`commands::remote_desktop_auto_detected`, which shows what "Auto" would decide), the
//! Quick-Add copy-chord grab (`aux_windows::quickadd::win_seed`, which holds its window for the
//! copy to cross) and the Windows push-to-talk liveness gate (`hotkeys::windows`, which keeps a
//! held chord alive while a client's capture hook swallows the keys).
//!
//! Two independent detectors, because neither is complete on its own:
//!   * **by app id** ([`is_remote_desktop_app`]) — the focused app's exe basename (Windows) or
//!     AT-SPI application name (Linux). Covers every client we know by name, on every platform.
//!   * **by window class** ([`focus_is_remote_desktop_client`], Windows only) — the RDP ActiveX
//!     control keeps its window classes wherever it is hosted, so this also catches RDCMan,
//!     mRemoteNG and other hosts whose exe name says nothing about RDP.
//!
//! [`focus_is_remote_desktop`] composes the two; the paste path keeps them apart only because
//! its log names which one fired.
//!
//! A per-app rule can override both ("Remote desktop: On / Off"); `inject_text` logs which
//! detector fired and whether the rule overrode it, so a support log answers "why was this
//! treated as remote" without a repro. The paste path gets the rule from the webview with each
//! insert; the Quick-Add grab and the push-to-talk liveness gate have no webview round trip, so
//! they read the same rules from [`set_rules`]' process-wide copy (applied at startup and on every
//! config save) through [`focus_is_remote_desktop`].

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

/// Is focus on a remote-desktop / VDI client, by EITHER detector (they are only complete
/// together): the window class (mstsc, and the RDP control hosted by RDCMan & co.) or the
/// focused app id (VirtualBox, VMware, Citrix, AnyDesk… — clients whose window class says
/// nothing). The class check runs first, being a few Win32 calls; `app_id` (the callers pass the
/// live foreground app id: a process-image lookup on Windows, a snapshot read on Linux) is called
/// only when it misses.
///
/// A per-app "Remote desktop: On / Off" rule for the focused app wins over both, as it does on the
/// paste path — the rule exists for the client the detectors do not know, or a false positive.
/// With no such rule saved, the id is still read lazily.
pub fn focus_is_remote_desktop(app_id: impl FnOnce() -> Option<String>) -> bool {
    if !has_rules() {
        return focus_is_remote_desktop_client()
            || app_id().is_some_and(|id| is_remote_desktop_app(&id));
    }
    let id = app_id();
    if let Some(on) = id.as_deref().and_then(rule_override) {
        return on;
    }
    focus_is_remote_desktop_client() || id.is_some_and(|id| is_remote_desktop_app(&id))
}

/// The saved per-app overrides (`AppRule.remoteDesktop`), as (rule key, on) in rule order. `None`
/// is "Auto" (or a synced junk value): such a rule still shadows a later one for the same key.
static RULES: std::sync::RwLock<Vec<(String, Option<bool>)>> = std::sync::RwLock::new(Vec::new());

/// Apply the saved app rules (`Config.app_rules`, frontend-owned JSON), floored as the webview's
/// `wellFormedAppRules` floors them: a rule needs a string `id` and a string `appId` whose key is
/// not empty. Every surviving rule is kept, Auto ones too, because `resolveInjectionTarget` finds
/// the first rule for the key and only THEN reads its `remoteDesktop` — anything but a real
/// boolean falls back to detection. Called at startup and by `save_config`.
pub fn set_rules(app_rules: &[serde_json::Value]) {
    let rules: Vec<(String, Option<bool>)> = app_rules
        .iter()
        .filter_map(|r| {
            r.get("id")?.as_str()?;
            let key = rule_key(r.get("appId")?.as_str()?);
            let on = r.get("remoteDesktop").and_then(serde_json::Value::as_bool);
            (!key.is_empty()).then_some((key, on))
        })
        .collect();
    if let Ok(mut g) = RULES.write() {
        *g = rules;
    }
}

/// Can any saved rule force a verdict? Without one the app id is read lazily.
fn has_rules() -> bool {
    RULES
        .read()
        .is_ok_and(|g| g.iter().any(|(_, on)| on.is_some()))
}

/// The rule's verdict for `app_id`: `Some(on)` when a rule forces it, `None` = Auto. The first
/// rule for the key wins and then its `remoteDesktop` decides, as the webview's `appRules.find`
/// does — an Auto rule ahead of an On/Off one for the same app leaves it to detection.
pub fn rule_override(app_id: &str) -> Option<bool> {
    let key = rule_key(app_id);
    if key.is_empty() {
        return None;
    }
    RULES
        .read()
        .ok()?
        .iter()
        .find(|(k, _)| *k == key)
        .and_then(|&(_, on)| on)
}

/// Rust twin of the webview's `appRuleKey` (sanitize.ts): `safeDisplayText` (control and
/// deceptive-format characters dropped, 200 kept), then `normalizeAppId`'s invisible key
/// characters dropped and the ends trimmed, lowercased. Both the stored key and the live id go
/// through it, so a rule matches here exactly when it matches on the paste path.
fn rule_key(s: &str) -> String {
    let shown: String = s
        .chars()
        .filter(|&c| !c.is_control() && !crate::inject::is_deceptive_format_char(c))
        .take(200)
        .collect();
    let kept: String = shown
        .chars()
        .filter(|&c| !is_invisible_key_char(c))
        .collect();
    kept.trim().to_lowercase()
}

/// sanitize.ts `isInvisibleKeyChar`: characters with no visible glyph that the deceptive-format
/// set leaves in.
fn is_invisible_key_char(c: char) -> bool {
    matches!(c,
        '\u{034f}'
        | '\u{17b4}'..='\u{17b5}'
        | '\u{180b}'..='\u{180f}'
        | '\u{2065}'
        | '\u{2800}'
        | '\u{fe00}'..='\u{fe0f}'
        | '\u{fff0}'..='\u{fff8}'
        | '\u{e0000}'..='\u{e0fff}')
}

#[cfg(test)]
mod tests {
    use super::{is_remote_desktop_app, is_remote_window_class};

    /// One test owns the process-wide RULES (tests run in parallel; a second fn would race it),
    /// and its ids are ones no other test here asks about.
    #[cfg(not(windows))]
    #[test]
    fn a_per_app_rule_overrides_both_detectors() {
        use super::{focus_is_remote_desktop, rule_override, set_rules};
        let rules: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"id":"1","appId":"MyVdiClient","remoteDesktop":true},
                {"id":"2","appId":"vmconnect\u200b","remoteDesktop":false},
                {"id":"3","appId":"gedit","remoteDesktop":null},
                {"id":"4","appId":"konsole","remoteDesktop":"yes"},
                {"id":"5","appId":"myvdiclient","remoteDesktop":false},
                {"id":"6","appId":"shadowed","remoteDesktop":null},
                {"id":"7","appId":"Shadowed","remoteDesktop":true},
                {"appId":"noid","remoteDesktop":true},
                {"id":"8","appId":" Kate\ufe0f\u2800 ","remoteDesktop":true}]"#,
        )
        .unwrap();
        set_rules(&rules);
        // On: an unknown client is treated as remote; the first matching rule wins.
        assert!(focus_is_remote_desktop(|| Some("myvdiclient".into())));
        // Off: a known client (keyed with an invisible mark, as a synced rule may be) is not.
        assert!(!focus_is_remote_desktop(|| Some("VMConnect".into())));
        // Auto and junk values fall back to detection.
        assert_eq!(rule_override("gedit"), None);
        assert_eq!(rule_override("konsole"), None);
        assert!(!focus_is_remote_desktop(|| Some("gedit".into())));
        assert!(focus_is_remote_desktop(|| Some("anydesk".into())));
        // An Auto rule ahead of an On rule for the same app shadows it: first match, then value.
        assert_eq!(rule_override("shadowed"), None);
        // A rule without an id is dropped by the webview's floor, so it does not apply here.
        assert_eq!(rule_override("noid"), None);
        // A key saved with invisible key characters (not deceptive-format ones) still matches.
        assert_eq!(rule_override("kate"), Some(true));
        set_rules(&[]);
        assert!(focus_is_remote_desktop(|| Some("VMConnect".into())));
        assert!(!focus_is_remote_desktop(|| Some("myvdiclient".into())));
    }

    #[test]
    fn rule_key_drops_invisible_characters() {
        use super::rule_key;
        assert_eq!(rule_key(" Konsole\u{200b} "), "konsole");
        assert_eq!(rule_key("Konsole\u{fe0f}"), "konsole");
        assert_eq!(rule_key("x\u{034f}\u{2800}"), "x");
    }

    #[cfg(not(windows))]
    #[test]
    fn composed_detector_falls_back_to_the_app_id() {
        use super::focus_is_remote_desktop;
        assert!(focus_is_remote_desktop(|| Some("VirtualBoxVM".into())));
        assert!(!focus_is_remote_desktop(|| Some("firefox".into())));
        assert!(!focus_is_remote_desktop(|| None));
    }

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
