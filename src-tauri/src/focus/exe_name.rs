//! Exe-basename identity for the Windows tracker (`focus::windows`): the pure name rules, kept
//! out of the `#[cfg(windows)]` module so their tests run on the Linux `cargo test` leg too —
//! CI runs the test suite on Linux only.

/// Shell surfaces that foreground a plain `Windows.UI.Core.CoreWindow` — a class every real
/// UWP app shares, so they cannot be filtered by class like the taskbar; filter by process
/// name instead, the way `is_noise` filters plasmashell on Linux. Without this the Start
/// menu became `current`, the chip's "→ app" readout named it, and a per-app rule for the
/// app the user came from silently stopped applying to a chord fired over the open menu.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn is_shell_exe(base: &str) -> bool {
    matches!(
        base,
        "startmenuexperiencehost" // Start menu (Win10 1903+ / Win11)
            | "searchhost" | "searchapp" | "searchui" // Search (Win11 / Win10 / older)
            | "shellexperiencehost" // notification / action centre, volume flyout
            | "lockapp" // lock screen
            | "textinputhost" // touch keyboard / emoji panel
    )
}

/// Full image path → lowercased basename without `.exe`, bounded and defanged; None when
/// nothing displayable is left (a name made only of format/control characters), which keeps
/// the previous snapshot exactly as the AT-SPI twin's empty-after-bound check does.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn normalize_exe_basename(path: &str) -> Option<String> {
    let base = path.rsplit(['\\', '/']).next()?.to_lowercase();
    let base = base
        .strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(base);
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
    let id = crate::transport::bounded_server_text(&base, super::APP_ID_MAX);
    if id.trim().is_empty() {
        return None;
    }
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::{is_shell_exe, normalize_exe_basename};

    #[test]
    fn an_exe_name_with_nothing_displayable_left_is_not_an_app_id() {
        assert_eq!(
            normalize_exe_basename("C:\\Apps\\Code.exe").as_deref(),
            Some("code")
        );
        assert_eq!(normalize_exe_basename("C:\\x\\\u{202e}.exe"), None);
        assert_eq!(normalize_exe_basename("C:\\x\\\u{1}\u{2}.exe"), None);
    }

    #[test]
    fn shell_hosts_are_filtered_by_name_and_real_apps_are_not() {
        for shell in [
            "startmenuexperiencehost",
            "searchhost",
            "searchapp",
            "searchui",
            "shellexperiencehost",
            "lockapp",
            "textinputhost",
        ] {
            assert!(is_shell_exe(shell), "{shell}");
        }
        for app in [
            "explorer",
            "code",
            "chrome",
            "applicationframehost",
            "wordpad",
        ] {
            assert!(!is_shell_exe(app), "{app}");
        }
    }
}
