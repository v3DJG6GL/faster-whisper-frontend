//! Shared KDE-Plasma-on-Wayland KConfig/KWin helpers for installing window rules — the dictation
//! chip's keep-above / skip-taskbar / no-focus rule (see `overlay::kwin`), the quick-add window's
//! keep-above rule (see `quickadd::kwin`) and the language picker's (see `langpick::kwin`). The
//! generic KConfig primitives and the shared keep-above rule body live here so the callers can't
//! drift; each caller keeps its own rule group name, title, and install flag (the chip adds its
//! no-focus keys on top of `keep_above_keys`).

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

/// Run `program` to completion with all stdio null. No piped stdout: writing kwinrulesrc can
/// D-Bus-activate kded6/kconf_update, which would inherit a captured stdout pipe and hold it open,
/// deadlocking the wait. Null stdio = no pipe to leak — and these callers never read the output.
fn run_silent(program: &str, args: &[&str]) -> std::io::Result<std::process::ExitStatus> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
}

/// First of the candidate KConfig CLI tools that is runnable.
fn tool(candidates: &[&'static str]) -> Option<&'static str> {
    candidates
        .iter()
        .find(|name| run_silent(name, &["--help"]).is_ok())
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

/// Write one KConfig key (null stdio: see `run_silent`).
pub fn set_key(tool: &str, group: &str, key: &str, value: &str) {
    let _ = run_silent(
        tool,
        &[
            "--file",
            "kwinrulesrc",
            "--group",
            group,
            "--key",
            key,
            value,
        ],
    );
}

/// Read one KConfig key (None when empty / unreadable).
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
    let _ = run_silent(
        "dbus-send",
        &[
            "--type=method_call",
            "--dest=org.kde.KWin",
            "/KWin",
            "org.kde.KWin.reconfigure",
        ],
    );
}

/// Serializes the General/rules read-modify-write below. The chip, quick-add window and language
/// picker install on separate detached threads; an interleave would let two read the same
/// `rules=` list and the second writer would clobber the first's append, dropping a window's rule.
/// Held only across synchronous shell-outs (no .await, no nested lock), so it can't deadlock.
static RULES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Merge `group` into General/rules, preserving any existing user (and sibling) rules.
pub fn merge_general(writer: &str, reader: &str, group: &str) {
    let _guard = RULES_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

/// The keep-above / skip-taskbar rule body (strength 2 = "Force") matched on an exact window
/// title. The quick-add window and language picker install exactly this; the chip extends it.
pub fn keep_above_keys<'a>(description: &'a str, title: &'a str) -> [(&'a str, &'a str); 8] {
    [
        ("Description", description),
        ("title", title),
        ("titlematch", "1"),   // exact title match
        ("wmclassmatch", "0"), // ignore window class
        ("above", "true"),
        ("aboverule", "2"),
        ("skiptaskbar", "true"),
        ("skiptaskbarrule", "2"),
    ]
}

/// Install the `keep_above_keys` rule under `group` once per session (guarded by the caller's
/// `installed` flag), then reload KWin. Missing KConfig tools reset the flag so a later summon
/// retries once they exist.
pub fn install_keep_above_once(
    installed: &std::sync::atomic::AtomicBool,
    group: &str,
    description: &str,
    title: &str,
) {
    use std::sync::atomic::Ordering;
    if installed.swap(true, Ordering::Relaxed) {
        return;
    }
    let Some((writer, reader)) = config_tools() else {
        installed.store(false, Ordering::Relaxed);
        return;
    };
    merge_general(writer, reader, group);
    for (k, v) in keep_above_keys(description, title) {
        set_key(writer, group, k, v);
    }
    reconfigure();
}
