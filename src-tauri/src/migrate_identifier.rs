//! One-time move of the app's folders from the old identifier to the new one.
//!
//! Tauri names every per-app folder after `identifier` (tauri.conf.json): config, data,
//! local data (logs + the WebView profile, which holds localStorage) and cache. Renaming the
//! identifier therefore orphans all of it — the app would start empty. This runs at the very
//! top of `run()`, BEFORE the Tauri builder: before the single-instance plugin, before the
//! webview opens (and locks) a profile, before anything resolves a path.
//!
//! Not identifier-scoped, so untouched here: the keyring service, the autostart entry, the
//! KWin rule names and the installers' upgrade identity — all derive from the product name.
//!
//! Rules, per folder pair:
//!   * old absent → nothing to do (fresh install, or already moved);
//!   * new carries the marker → done earlier;
//!   * new exists and is non-empty → the user already started fresh under the new name.
//!     NEVER overwrite: leave both, log it;
//!   * otherwise move. `rename` first — same volume, atomic, instant even with gigabytes of
//!     audio. If that fails (AppData redirected to another volume, a locked file), copy into
//!     a staging sibling, swap it in, and delete the old folder only after the copy succeeded.
//! The move is one-way: an older build started afterwards finds empty folders and shows
//! onboarding (backend keys survive — the keyring is not identifier-scoped).

use std::path::{Path, PathBuf};

/// The identifier every release up to 0.1.114 shipped with.
const LEGACY_ID: &str = "ch.informethic.faster-whisper-frontend";
/// Must equal `identifier` in tauri.conf.json (a test below holds the two together).
const NEW_ID: &str = "org.fasterwhisper.frontend";
/// Dropped into each migrated folder; its presence means "do not look at the old one again".
const MARKER: &str = ".migrated-from-legacy";

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    /// No old folder.
    Absent,
    /// The new folder already carries the marker.
    AlreadyDone,
    /// The new folder has content of its own — left alone.
    Conflict,
    Moved,
    Failed,
}

/// A base directory that may hold an identifier-named folder.
struct Root {
    base: PathBuf,
    /// Cache: regenerable, so the old folder is simply deleted instead of moved.
    disposable: bool,
}

#[cfg(windows)]
fn roots() -> Vec<Root> {
    // Roaming = config + data (config.json, audio/, transcripts/); Local = logs, playback
    // cache and the WebView2 profile.
    ["APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .map(|b| Root { base: PathBuf::from(b), disposable: false })
        .collect()
}

#[cfg(not(windows))]
fn roots() -> Vec<Root> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let xdg = |var: &str, fallback: &[&str]| -> Option<PathBuf> {
        std::env::var_os(var)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| home.as_ref().map(|h| fallback.iter().fold(h.clone(), |p, s| p.join(s))))
    };
    let mut out = Vec::new();
    if let Some(base) = xdg("XDG_CONFIG_HOME", &[".config"]) {
        out.push(Root { base, disposable: false });
    }
    if let Some(base) = xdg("XDG_DATA_HOME", &[".local", "share"]) {
        out.push(Root { base, disposable: false });
    }
    if let Some(base) = xdg("XDG_CACHE_HOME", &[".cache"]) {
        out.push(Root { base, disposable: true });
    }
    out
}

/// Is a build with the OLD identifier running right now? Its single-instance name differs
/// from ours, so the plugin would not stop the two from running side by side — and moving
/// the config and the webview profile out from under a live process is how data gets lost.
/// Installers close the app first; this guards a hand-started old binary. (Windows only:
/// there the old build also holds its webview profile open, so the move would half-fail.)
#[cfg(windows)]
fn legacy_instance_running() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    // tauri-plugin-single-instance names its mutex "<identifier>-sim".
    let name: Vec<u16> = format!("{LEGACY_ID}-sim").encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: NUL-terminated name; the handle is closed at once.
    unsafe {
        let h = OpenMutexW(SYNCHRONIZE, 0, name.as_ptr());
        if h.is_null() {
            return false;
        }
        CloseHandle(h);
    }
    true
}

#[cfg(not(windows))]
fn legacy_instance_running() -> bool {
    false
}

pub fn run() {
    if legacy_instance_running() {
        tracing::warn!("[migrate] a build with the old identifier is running; moving its data on a later launch");
        return;
    }
    for root in roots() {
        let old = root.base.join(LEGACY_ID);
        let new = root.base.join(NEW_ID);
        let outcome = migrate_dir(&old, &new, root.disposable);
        match outcome {
            Outcome::Absent | Outcome::AlreadyDone => {}
            Outcome::Moved => {
                tracing::info!("[migrate] moved {} -> {}", old.display(), new.display());
                after_move(&old, &new);
            }
            Outcome::Conflict => tracing::warn!(
                "[migrate] {} already has data; leaving {} where it is",
                new.display(),
                old.display()
            ),
            Outcome::Failed => tracing::warn!("[migrate] could not move {}", old.display()),
        }
    }
}

fn is_empty_dir(p: &Path) -> bool {
    std::fs::read_dir(p).map(|mut d| d.next().is_none()).unwrap_or(false)
}

fn migrate_dir(old: &Path, new: &Path, disposable: bool) -> Outcome {
    if !old.is_dir() {
        return Outcome::Absent;
    }
    if new.join(MARKER).exists() {
        return Outcome::AlreadyDone;
    }
    if disposable {
        let _ = std::fs::remove_dir_all(old);
        return Outcome::Absent;
    }
    if new.exists() {
        if !is_empty_dir(new) {
            return Outcome::Conflict;
        }
        // An empty shell (something only created the folder) must not block the move.
        if std::fs::remove_dir(new).is_err() {
            return Outcome::Conflict;
        }
    }
    if std::fs::rename(old, new).is_ok() {
        let _ = std::fs::write(new.join(MARKER), b"");
        return Outcome::Moved;
    }
    // Cross-volume or partially locked: stage a full copy, swap it in, then drop the old.
    // A sibling, so the final swap is a same-volume rename. (Not `with_extension`: the
    // identifier's last segment would be taken for the extension.)
    let mut staging_name = new.file_name().unwrap_or_default().to_os_string();
    staging_name.push(".migrating");
    let staging = new.with_file_name(staging_name);
    let _ = std::fs::remove_dir_all(&staging);
    if copy_tree(old, &staging).is_err() || std::fs::rename(&staging, new).is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        return Outcome::Failed;
    }
    let _ = std::fs::write(new.join(MARKER), b"");
    // Best-effort: a leftover old folder is harmless now that the marker exists.
    let _ = std::fs::remove_dir_all(old);
    Outcome::Moved
}

/// Recursive copy. Skips what is meaningless or unreadable in a copied tree: the webview's
/// lock files and any half-written `*.tmp`.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let lossy = name.to_string_lossy();
        if lossy == "LOCK" || lossy == "lockfile" || lossy.ends_with(".tmp") {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(&name));
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Fix what still points INTO the old folder after a move.
fn after_move(old: &Path, new: &Path) {
    // Transcript records store absolute media paths. Removing the heal stamp makes
    // `commands::ensure_audio_layout` (setup) run `transcripts::heal_media_paths`, which
    // re-finds every no-longer-existing path by file name under the audio base — the same
    // repair an audio-folder move uses. A custom audio folder elsewhere never moved, so its
    // paths are still valid and heal leaves them alone.
    let _ = std::fs::remove_file(new.join("audio").join(".heal-v1"));
    rewrite_config_paths(&new.join("config.json"), old, new);
}

/// A custom audio/log folder the user placed INSIDE the old app folder moved with it; point
/// the setting at where it is now. Edits the raw JSON rather than going through
/// `config::load`, whose recovery path may rewrite a config it cannot parse.
fn rewrite_config_paths(config: &Path, old: &Path, new: &Path) {
    let Ok(text) = std::fs::read_to_string(config) else { return };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let mut changed = false;
    for (section, key) in [("recording", "audioBaseDir"), ("recording", "recordingsDir"), ("logging", "logDir")] {
        let Some(slot) = json.get_mut("settings").and_then(|s| s.get_mut(section)).and_then(|s| s.get_mut(key))
        else {
            continue;
        };
        let Some(current) = slot.as_str() else { continue };
        if let Ok(rest) = Path::new(current).strip_prefix(old) {
            *slot = serde_json::Value::String(new.join(rest).to_string_lossy().into_owned());
            changed = true;
        }
    }
    if changed {
        if let Ok(out) = serde_json::to_string_pretty(&json) {
            let _ = crate::config::write_private(config, &out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fwf-migrate-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_new_id_is_the_configured_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
    }

    #[test]
    fn a_fresh_install_has_nothing_to_move() {
        let base = scratch("fresh");
        assert_eq!(migrate_dir(&base.join(LEGACY_ID), &base.join(NEW_ID), false), Outcome::Absent);
        assert!(!base.join(NEW_ID).exists());
    }

    #[test]
    fn an_existing_install_moves_whole_and_only_once() {
        let base = scratch("move");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(old.join("audio").join("dictations")).unwrap();
        std::fs::write(old.join("config.json"), "{}").unwrap();
        std::fs::write(old.join("audio").join("dictations").join("a.wav"), b"x").unwrap();

        assert_eq!(migrate_dir(&old, &new, false), Outcome::Moved);
        assert!(!old.exists());
        assert!(new.join("audio").join("dictations").join("a.wav").exists());
        assert!(new.join(MARKER).exists());

        // An old build run afterwards recreates its folder; it must never be merged back in.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("config.json"), "{\"stale\":true}").unwrap();
        assert_eq!(migrate_dir(&old, &new, false), Outcome::AlreadyDone);
        assert_eq!(std::fs::read_to_string(new.join("config.json")).unwrap(), "{}");
    }

    #[test]
    fn data_already_under_the_new_name_is_never_overwritten() {
        let base = scratch("conflict");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("config.json"), "old").unwrap();
        std::fs::write(new.join("config.json"), "new").unwrap();
        assert_eq!(migrate_dir(&old, &new, false), Outcome::Conflict);
        assert_eq!(std::fs::read_to_string(new.join("config.json")).unwrap(), "new");
        assert!(old.join("config.json").exists());
    }

    #[test]
    fn an_empty_new_folder_does_not_block_the_move() {
        let base = scratch("empty");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("config.json"), "old").unwrap();
        assert_eq!(migrate_dir(&old, &new, false), Outcome::Moved);
        assert_eq!(std::fs::read_to_string(new.join("config.json")).unwrap(), "old");
    }

    #[test]
    fn a_cache_is_dropped_not_moved() {
        let base = scratch("cache");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(old.join("playback")).unwrap();
        assert_eq!(migrate_dir(&old, &new, true), Outcome::Absent);
        assert!(!old.exists() && !new.exists());
    }

    #[test]
    fn the_staged_copy_skips_locks_and_temp_files() {
        let base = scratch("copy");
        let (from, to) = (base.join("from"), base.join("to"));
        std::fs::create_dir_all(from.join("EBWebView")).unwrap();
        std::fs::write(from.join("EBWebView").join("LOCK"), b"").unwrap();
        std::fs::write(from.join("config.json.tmp"), b"").unwrap();
        std::fs::write(from.join("EBWebView").join("prefs"), b"p").unwrap();
        copy_tree(&from, &to).unwrap();
        assert!(to.join("EBWebView").join("prefs").exists());
        assert!(!to.join("EBWebView").join("LOCK").exists());
        assert!(!to.join("config.json.tmp").exists());
    }

    #[test]
    fn custom_folders_inside_the_old_app_folder_follow_the_move() {
        let base = scratch("cfg");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&new).unwrap();
        let elsewhere = base.join("elsewhere");
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": old.join("my-audio"), "recordingsDir": elsewhere },
            "logging": { "logDir": null },
        }});
        std::fs::write(new.join("config.json"), cfg.to_string()).unwrap();
        rewrite_config_paths(&new.join("config.json"), &old, &new);
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(new.join("config.json")).unwrap()).unwrap();
        assert_eq!(out["settings"]["recording"]["audioBaseDir"], serde_json::json!(new.join("my-audio")));
        assert_eq!(out["settings"]["recording"]["recordingsDir"], serde_json::json!(elsewhere));
    }
}
