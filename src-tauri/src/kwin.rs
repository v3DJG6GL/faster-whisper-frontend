//! Shared KDE-Plasma-on-Wayland KConfig/KWin helpers for installing window rules — the dictation
//! chip's keep-above / skip-taskbar / no-focus rule (see `overlay::kwin`) and the quick-add
//! window's keep-above rule (see `quickadd::kwin`). The generic KConfig primitives live here so the
//! two callers can't drift; each caller keeps its own rule group name, rule body, and install state.

use std::process::{Command, Stdio};

/// KDE Plasma on Wayland — the only place these window rules are needed and usable.
pub fn is_kde_wayland() -> bool {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|s| s.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    let kde = std::env::var("XDG_CURRENT_DESKTOP")
        .map(|s| s.to_ascii_uppercase().contains("KDE"))
        .unwrap_or(false)
        || std::env::var_os("KDE_SESSION_VERSION").is_some()
        || std::env::var_os("KDE_FULL_SESSION").is_some();
    wayland && kde
}

/// First of the candidate KConfig CLI tools that is runnable.
fn tool(candidates: &[&'static str]) -> Option<&'static str> {
    candidates
        .iter()
        .find(|name| {
            Command::new(name)
                .arg("--help")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok()
        })
        .copied()
}

/// The (writer, reader) KConfig CLI pair (kwriteconfig6/5, kreadconfig6/5). BOTH must be runnable:
/// we must be able to READ the existing `rules=` list before rewriting it, or we'd silently drop
/// the user's other window rules.
pub fn config_tools() -> Option<(&'static str, &'static str)> {
    Some((
        tool(&["kwriteconfig6", "kwriteconfig5"])?,
        tool(&["kreadconfig6", "kreadconfig5"])?,
    ))
}

/// Write one KConfig key. No piped stdout: writing kwinrulesrc can D-Bus-activate kded6/kconf_update,
/// which would inherit a captured stdout pipe and hold it open, deadlocking the wait. Null stdio =
/// no pipe to leak — and we never read the output.
pub fn set_key(tool: &str, group: &str, key: &str, value: &str) {
    let _ = Command::new(tool)
        .args(["--file", "kwinrulesrc", "--group", group, "--key", key, value])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Read one KConfig key (None when empty / unreadable). Internal to this module (merge_general).
fn read_key(tool: &str, group: &str, key: &str) -> Option<String> {
    let out = Command::new(tool)
        .args(["--file", "kwinrulesrc", "--group", group, "--key", key])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Ask KWin to reload its configuration so a just-written rule applies to the live window.
pub fn reconfigure() {
    let _ = Command::new("dbus-send")
        .args([
            "--type=method_call",
            "--dest=org.kde.KWin",
            "/KWin",
            "org.kde.KWin.reconfigure",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Merge `group` into General/rules, preserving any existing user (and sibling) rules.
pub fn merge_general(writer: &str, reader: &str, group: &str) {
    let mut list: Vec<String> = read_key(reader, "General", "rules")
        .map(|s| {
            s.split(',')
                .map(|g| g.trim().to_string())
                .filter(|g| !g.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if !list.iter().any(|g| g == group) {
        list.push(group.to_string());
    }
    set_key(writer, "General", "count", &list.len().to_string());
    set_key(writer, "General", "rules", &list.join(","));
}
