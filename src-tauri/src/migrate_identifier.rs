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
//!
//! A move that cannot happen now (an old build still running, a failed move, a settings
//! re-point that could not land) quits the launch with a message BEFORE the builder creates
//! the new folders — see `Verdict` — so the next launch retries it.
//!
//! The move is one-way: an older build started afterwards finds empty folders and shows
//! onboarding (backend keys survive — the keyring is not identifier-scoped).

use std::path::{Path, PathBuf};

/// The identifier every release up to 0.1.114 shipped with.
pub(crate) const LEGACY_ID: &str = "ch.informethic.faster-whisper-frontend";
/// Must equal `identifier` in tauri.conf.json (a test below holds the two together).
pub(crate) const NEW_ID: &str = "org.fasterwhisper.frontend";
/// Dropped into each migrated folder; its presence means "do not look at the old one again".
pub(crate) const MARKER: &str = ".migrated-from-legacy";
/// Left beside a config.json whose re-point failed (see `rewrite_config_paths`): every root then
/// carries MARKER and nothing moves again, so this is what brings a later launch back to it.
const REPOINT_PENDING: &str = ".migrate-repoint-pending";

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
        .filter_map(std::env::var_os)
        .map(|b| Root {
            base: PathBuf::from(b),
            disposable: false,
        })
        .collect()
}

#[cfg(not(windows))]
fn roots() -> Vec<Root> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let xdg = |var: &str, fallback: &[&str]| -> Option<PathBuf> {
        std::env::var_os(var)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| {
                home.as_ref()
                    .map(|h| fallback.iter().fold(h.clone(), |p, s| p.join(s)))
            })
    };
    let mut out = Vec::new();
    if let Some(base) = xdg("XDG_CONFIG_HOME", &[".config"]) {
        out.push(Root {
            base,
            disposable: false,
        });
    }
    if let Some(base) = xdg("XDG_DATA_HOME", &[".local", "share"]) {
        out.push(Root {
            base,
            disposable: false,
        });
    }
    if let Some(base) = xdg("XDG_CACHE_HOME", &[".cache"]) {
        push_cache_root(&mut out, base);
    }
    out
}

/// The cache root, unless it is the same folder as a config/data root (XDG_CACHE_HOME set to
/// XDG_DATA_HOME, or a symlink to it): there the identifier folder holds the user's data, and
/// the cache rule (delete, never move) would wipe what that data root just left in place on a
/// `Conflict` or a `Failed` move.
#[cfg(not(windows))]
fn push_cache_root(out: &mut Vec<Root>, base: PathBuf) {
    let same = |a: &Path| {
        a == base || matches!((a.canonicalize(), base.canonicalize()), (Ok(x), Ok(y)) if x == y)
    };
    if out.iter().any(|r| !r.disposable && same(&r.base)) {
        return;
    }
    out.push(Root {
        base,
        disposable: true,
    });
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
    let name: Vec<u16> = format!("{LEGACY_ID}-sim")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
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

/// Whether this launch may go on into the Tauri builder.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Proceed,
    /// Quit before the builder runs, showing the user this text. Going on would create the
    /// new folders (webview profile, logs, a seeded config.json), and from then on every
    /// launch sees `Conflict` and never moves the old data: the user would start empty with
    /// their settings, history and recordings stranded in the old folder for good.
    Stop(String),
}

/// The launch's verdict from what the migration saw. `failed` = the old folders whose move
/// failed (nothing is lost: a failed move leaves the old folder whole and the new one absent).
/// `unrepointed` = the config.json files whose failed re-point stops this launch (see
/// `repoint_fault_stops`): going on would run a session on the vacated folder they still name,
/// re-created empty, and strand what it records there once the next launch's retry re-points them.
fn verdict(legacy_running: bool, failed: &[PathBuf], unrepointed: &[PathBuf]) -> Verdict {
    if legacy_running {
        return Verdict::Stop(
            "An older version of faster-whisper-frontend is still running.\n\n\
             Close it (also from the system tray), then start this version again so it can \
             move your settings, history and recordings over."
                .into(),
        );
    }
    let lines = |ps: &[PathBuf]| -> String {
        let paths: Vec<String> = ps.iter().map(|p| p.display().to_string()).collect();
        paths.join("\n")
    };
    if failed.is_empty() {
        if unrepointed.is_empty() {
            return Verdict::Proceed;
        }
        return Verdict::Stop(format!(
            "The data of the previous version was moved to this version's folder, but these \
             settings could not be updated and still point at the old folder:\n\n{}\n\n\
             Nothing was lost. Close every window of the app (also from the system tray), and \
             any program that may hold that file open, then start it again.",
            lines(unrepointed)
        ));
    }
    Verdict::Stop(format!(
        "The data of the previous version could not be moved to this version's folder. \
         Nothing was lost — it is still in:\n\n{}\n\n\
         Close every window of the app (also from the system tray), then start it again.",
        lines(failed)
    ))
}

pub fn run() -> Verdict {
    migrate(&roots(), legacy_instance_running())
}

fn migrate(roots: &[Root], legacy_running: bool) -> Verdict {
    // A running old build only matters while there is still something to move out from under
    // it: once every root moved (or never had data), an old binary started by hand would
    // otherwise block every launch of this one for good.
    if legacy_running {
        if roots.iter().any(pending) {
            tracing::warn!(
                "[migrate] a build with the old identifier is running; not starting until it is closed"
            );
            return verdict(true, &[], &[]);
        }
        tracing::info!(
            "[migrate] a build with the old identifier is running, but there is nothing left to move"
        );
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut failed: Vec<PathBuf> = Vec::new();
    for root in roots {
        let old = root.base.join(LEGACY_ID);
        let new = root.base.join(NEW_ID);
        let outcome = migrate_dir(&old, &new, root.disposable);
        match outcome {
            Outcome::Absent | Outcome::AlreadyDone => {}
            Outcome::Moved => {
                tracing::info!("[migrate] moved {} -> {}", old.display(), new.display());
                after_move(&new);
                moved.push((old, new));
            }
            Outcome::Conflict => tracing::warn!(
                "[migrate] {} already has data; leaving {} where it is",
                new.display(),
                old.display()
            ),
            Outcome::Failed => {
                tracing::warn!("[migrate] could not move {}", old.display());
                failed.push(old);
            }
        }
    }
    // The fix-ups still run when another root failed: the roots that moved now carry the
    // marker and are never looked at again, so it is now or never for them — unless an
    // earlier launch's failed re-point left REPOINT_PENDING, which retries it.
    let repoint_pending = roots
        .iter()
        .any(|r| r.base.join(NEW_ID).join(REPOINT_PENDING).exists());
    let unrepointed = if !moved.is_empty() || repoint_pending {
        rewrite_moved_paths(roots, moved)
    } else {
        Vec::new()
    };
    verdict(false, &failed, &unrepointed)
}

/// Show a `Verdict::Stop` text natively — the webview never opens on that path. Windows: a
/// message box. Elsewhere best effort through whichever desktop tool exists (KDE, GNOME, a
/// notification); the text also goes to stderr.
pub fn tell_user(msg: &str) {
    const TITLE: &str = "faster-whisper-frontend";
    eprintln!("{TITLE}: {msg}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let (text, title) = (wide(msg), wide(TITLE));
        // SAFETY: both strings are NUL-terminated and outlive the (modal, blocking) call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONWARNING,
            );
        }
    }
    #[cfg(not(windows))]
    {
        use std::process::{Command, Stdio};
        let attempts: [(&str, Vec<&str>); 3] = [
            ("kdialog", vec!["--title", TITLE, "--sorry", msg]),
            // --no-markup: a path with `&` or `<` must not break Pango's parse of the text.
            (
                "zenity",
                vec!["--warning", "--no-markup", "--title", TITLE, "--text", msg],
            ),
            ("notify-send", vec!["--urgency=critical", TITLE, msg]),
        ];
        for (tool, args) in attempts {
            let shown = Command::new(tool)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if shown {
                return;
            }
        }
    }
}

/// Re-point config paths into every moved folder. A root that moved on an EARLIER launch
/// (one that then stopped on another root's failed move) counts too: the config.json naming a
/// folder inside it may only arrive now, with the root that failed then. Returns the config.json
/// files whose failed re-point stops this launch (see `repoint_fault_stops`).
fn rewrite_moved_paths(roots: &[Root], mut moved: Vec<(PathBuf, PathBuf)>) -> Vec<PathBuf> {
    for root in roots.iter().filter(|r| !r.disposable) {
        let pair = (root.base.join(LEGACY_ID), root.base.join(NEW_ID));
        if pair.1.join(MARKER).exists() && !moved.contains(&pair) {
            moved.push(pair);
        }
    }
    // config.json lives in ONE root (config dir) while a custom audio/log folder may sit inside
    // ANOTHER (Linux data dir, Windows LocalAppData) — so every config.json is checked against
    // every move, not just its own root's.
    let mut failed = Vec::new();
    for root in roots {
        let config = root.base.join(NEW_ID).join("config.json");
        if !config.is_file() {
            continue;
        }
        // A custom audio base that moved carries its own heal stamp; drop it so the setup heal
        // re-points the records' absolute media paths there too (see `after_move`).
        match rewrite_config_paths(&config, &moved) {
            Ok(bases) => {
                for base in bases {
                    let _ = std::fs::remove_file(base.join(crate::commands::HEAL_STAMP));
                }
            }
            Err(()) => failed.push(config),
        }
    }
    failed
}

fn is_empty_dir(p: &Path) -> bool {
    std::fs::read_dir(p)
        .map(|mut d| d.next().is_none())
        .unwrap_or(false)
}

/// `Some` when a folder pair has nothing (left) to move — `migrate_dir`'s first rule, shared
/// with `pending`.
fn settled(old: &Path, new: &Path) -> Option<Outcome> {
    if !old.is_dir() {
        return Some(Outcome::Absent);
    }
    if new.join(MARKER).exists() {
        return Some(Outcome::AlreadyDone);
    }
    None
}

/// The new folder holds data of its own (not merely an empty shell): never moved over.
fn has_own_data(new: &Path) -> bool {
    new.exists() && !is_empty_dir(new)
}

/// Would `migrate_dir` move anything for this root? Touches nothing. (A cache is only
/// deleted, never moved — nothing of the user's can be stranded there.)
fn pending(root: &Root) -> bool {
    let (old, new) = (root.base.join(LEGACY_ID), root.base.join(NEW_ID));
    !root.disposable && settled(&old, &new).is_none() && !has_own_data(&new)
}

fn migrate_dir(old: &Path, new: &Path, disposable: bool) -> Outcome {
    if let Some(outcome) = settled(old, new) {
        return outcome;
    }
    if disposable {
        let _ = std::fs::remove_dir_all(old);
        return Outcome::Absent;
    }
    if has_own_data(new) {
        return Outcome::Conflict;
    }
    // An empty shell (something only created the folder) must not block the move.
    if new.exists() && std::fs::remove_dir(new).is_err() {
        return Outcome::Conflict;
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
    // Best-effort: a leftover old folder is harmless now that the marker exists, and the heal
    // re-points records still naming a file in it to the copy (`migrated_counterpart`).
    let _ = std::fs::remove_dir_all(old);
    Outcome::Moved
}

/// Recursive copy. Skips what is meaningless or unreadable in a copied tree: the webview's
/// lock files and any half-written `*.tmp`. Not an older build's finished `files/<id>.tmp` media
/// copy: the old folder is removed after this, and that copy would go with it.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let lossy = name.to_string_lossy();
        let (src, dst) = (entry.path(), to.join(&name));
        if lossy == "LOCK"
            || lossy == "lockfile"
            || crate::store::transcripts::is_partial_copy(&src)
        {
            continue;
        }
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Fix what still points INTO the old folder after a move. (Settings that name a folder
/// inside it are re-pointed after the per-root loop, in `rewrite_moved_paths`.)
fn after_move(new: &Path) {
    // Transcript records store absolute media paths. Without the heal stamp, setup's
    // `queue_audio_layout` runs `heal_media_paths`, which re-finds every vanished path by file
    // name under the audio base — the same repair an audio-folder move uses. A custom audio
    // folder elsewhere never moved, so heal leaves its still-valid paths alone.
    let _ = std::fs::remove_file(new.join("audio").join(crate::commands::HEAL_STAMP));
}

/// Where `path`, inside an old app folder that has since been migrated, lives now: the same
/// relative path under the new folder, when that exists. The heal needs it beyond its "re-find
/// what is gone" rule: the copy fallback deletes the old folder best-effort, and the file that
/// made `rename` fail (held by an AV scan, an indexer or a sync client) is the one most likely
/// to survive that delete. A record still naming the surviving file would play a copy outside
/// the audio base that no sweep or delete owns, while its real copy sits unreferenced.
pub(crate) fn migrated_counterpart(path: &Path) -> Option<PathBuf> {
    let old = path
        .ancestors()
        .find(|a| a.file_name().is_some_and(|n| n == LEGACY_ID))?;
    let new = old.with_file_name(NEW_ID);
    if !new.join(MARKER).exists() {
        return None;
    }
    let moved = new.join(path.strip_prefix(old).ok()?);
    moved.exists().then_some(moved)
}

/// A custom audio/log folder the user placed INSIDE an old app folder moved with it; point
/// the setting at where it is now. `moved` holds every (old, new) pair that has moved, on this
/// launch or an earlier one.
/// Edits the raw JSON rather than going through `config::load`, whose recovery path may
/// rewrite a config it cannot parse. Returns the re-pointed audio base folders
/// (`audioBaseDir` / `recordingsDir`, not `logDir`), or `Err` when the file could not be read, or
/// a re-point it found could not land, and `repoint_fault_stops` stops this launch on that fault
/// (REPOINT_PENDING is then left for the next launch).
fn rewrite_config_paths(config: &Path, moved: &[(PathBuf, PathBuf)]) -> Result<Vec<PathBuf>, ()> {
    let mut audio_bases = Vec::new();
    // The loader's own read, so a brief AV or sync-client hold right after the move is ridden
    // out the same way. No file at all has nothing to re-point.
    let bytes = match crate::config::read_config_bytes(config) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(audio_bases),
        Err(e) => {
            // Still unreadable after those retries (a lock that outlasted them, a root-owned
            // file from a sudo run): stop per `repoint_fault_stops`, but only with the retry
            // armed — without the marker no later launch comes back.
            if repoint_fault_stops(config, REPOINT_READ) && pending_fault_is(config, REPOINT_READ) {
                tracing::warn!(
                    "[migrate] could not read {} to re-point its moved folders ({e}); stopping, the next launch tries again",
                    config.display()
                );
                return Err(());
            }
            tracing::warn!(
                "[migrate] could not read {} to re-point its moved folders ({e}); going on, the next launch tries again",
                config.display()
            );
            return Ok(audio_bases);
        }
    };
    // A "UTF-8 with BOM" file is not JSON to serde, so the BOM goes.
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    // Invalid UTF-8 is decoded lossily, as the app's own loader (`config::read_config_text`)
    // does: its first settings save writes the U+FFFD text back anyway, while a skipped re-point
    // is lost for good — the marker means this never runs again, and the setting keeps naming
    // the vacated folder, which the audio/log setup then re-creates empty. The original bytes
    // are kept in a side copy before the rewrite (see below).
    let lossy = std::str::from_utf8(body).is_err();
    let text = String::from_utf8_lossy(body);
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(audio_bases);
    };
    let mut changed = false;
    for (section, key) in [
        ("recording", "audioBaseDir"),
        ("recording", "recordingsDir"),
        ("logging", "logDir"),
    ] {
        let Some(slot) = json
            .get_mut("settings")
            .and_then(|s| s.get_mut(section))
            .and_then(|s| s.get_mut(key))
        else {
            continue;
        };
        let Some(current) = slot.as_str() else {
            continue;
        };
        let current = Path::new(current);
        let Some(target) = moved
            .iter()
            .find_map(|(old, new)| current.strip_prefix(old).ok().map(|rest| new.join(rest)))
        else {
            continue;
        };
        *slot = serde_json::Value::String(target.to_string_lossy().into_owned());
        changed = true;
        if section == "recording" {
            audio_bases.push(target);
        }
    }
    if changed {
        // Not config.json.bak: the reset banner names that file as the copy of a config the
        // loader could not parse.
        let side = config.with_extension("json.invalid-utf8.bak");
        if lossy {
            // A copy already holding exactly these bytes is kept: an earlier launch wrote it and
            // then failed the rewrite below, and refusing now would skip this re-point too. A
            // copy cut short (a crash mid-write) holds a prefix of them: it is written again.
            let kept = match keep_private_copy(&side, &bytes) {
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    match std::fs::read(&side) {
                        Ok(b) if b == bytes => Ok(()),
                        Ok(b) if bytes.starts_with(&b) => std::fs::remove_file(&side)
                            .and_then(|()| keep_private_copy(&side, &bytes)),
                        _ => Err(e),
                    }
                }
                r => r,
            };
            if let Err(e) = kept {
                tracing::warn!(
                    "[migrate] config.json is not valid UTF-8 and its bytes could not be kept in {} ({e}); its moved folders are not re-pointed",
                    side.display()
                );
                if repoint_fault_stops(config, REPOINT_COPY) {
                    return Err(());
                }
                tracing::warn!(
                    "[migrate] the same fault as last launch; going on, the next launch tries again"
                );
                return Ok(Vec::new());
            }
        }
        let written = serde_json::to_string_pretty(&json)
            .map_err(std::io::Error::other)
            .and_then(|out| crate::config::write_private_atomic(config, &out));
        // A failed write (a full disk, an AV or sync client holding config.json) leaves the
        // settings naming the vacated folders: say so and leave the pending marker so the next
        // launch tries again (stopping this one unless the same fault already did). Either way
        // no base is returned, so the caller keeps their heal stamps rather than trusting a
        // re-point that never landed.
        if let Err(e) = written {
            tracing::warn!(
                "[migrate] could not write the re-pointed folders to {} ({e}); its settings still name the old folder",
                config.display()
            );
            if repoint_fault_stops(config, REPOINT_WRITE) {
                return Err(());
            }
            tracing::warn!(
                "[migrate] the same fault as last launch; going on, the next launch tries again"
            );
            return Ok(Vec::new());
        }
        if lossy {
            tracing::warn!(
                "[migrate] config.json is not valid UTF-8; re-pointed its moved folders, original bytes kept in {}",
                side.display()
            );
        }
    }
    // Landed, or nothing (left) to re-point: no later launch needs to look again.
    let _ = std::fs::remove_file(config.with_file_name(REPOINT_PENDING));
    Ok(audio_bases)
}

/// The re-point faults REPOINT_PENDING records, so a later launch can tell a lasting fault
/// from a different one. An empty marker (an older build's) records none.
const REPOINT_READ: &str = "read";
const REPOINT_WRITE: &str = "write";
const REPOINT_COPY: &str = "copy";

/// Does this launch stop on the re-point fault `kind`? The first launch to hit it does, so a
/// passing hold (an AV scan or sync client right after the move) cannot let the loader start on
/// settings still naming the vacated folder. A launch whose marker already records the SAME fault
/// goes on instead: an earlier launch hit it too, so it is lasting, and stopping again would stop
/// every launch for good. A marker left by a DIFFERENT fault proves nothing about this one — a
/// write that failed under a hold says nothing about the read failing under it now, which a
/// moment later may read cleanly — so that launch stops. The marker STAYS either way, now
/// recording `kind`: only it brings a later launch back here.
fn repoint_fault_stops(config: &Path, kind: &str) -> bool {
    if pending_fault_is(config, kind) {
        return false;
    }
    mark_repoint_pending(config, kind);
    true
}

/// Does REPOINT_PENDING beside `config` record the fault `kind`?
fn pending_fault_is(config: &Path, kind: &str) -> bool {
    std::fs::read(config.with_file_name(REPOINT_PENDING)).is_ok_and(|b| b == kind.as_bytes())
}

/// Leave REPOINT_PENDING beside `config`, recording the fault `kind`, so the next launch re-runs
/// the re-point. Best effort: a folder that refuses even this small file is logged, and the
/// re-point waits for a move.
fn mark_repoint_pending(config: &Path, kind: &str) {
    let pending = config.with_file_name(REPOINT_PENDING);
    if let Err(e) = std::fs::write(&pending, kind) {
        tracing::warn!(
            "[migrate] could not leave {} to retry the re-point next launch ({e})",
            pending.display()
        );
    }
}

/// Keep `bytes` in a NEW owner-only file at `path` (`config::write_private` takes text only).
/// `create_new` never follows a planted symlink and never overwrites an earlier copy.
pub(crate) fn keep_private_copy(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    let written = f.write_all(bytes).and_then(|()| f.sync_all());
    if written.is_err() {
        // A partial copy would refuse every retry (`create_new`): remove it, best effort.
        drop(f);
        let _ = std::fs::remove_file(path);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fwf-migrate-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A config.json naming `audio_base`, with a stray Latin-1 byte (0xE9, "é") in a string value.
    fn latin1_config(audio_base: &Path) -> Vec<u8> {
        let mut bytes = br#"{"settings":{"recording":{"audioBaseDir":"#.to_vec();
        bytes.extend(serde_json::to_vec(audio_base).unwrap());
        bytes.extend(br#"},"general":{"note":"caf"#);
        bytes.push(0xE9);
        bytes.extend(br#""}}}"#);
        bytes
    }

    #[test]
    fn the_new_id_is_the_configured_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
    }

    #[test]
    fn a_launch_that_cannot_move_the_old_data_stops_instead_of_starting_empty() {
        assert!(matches!(verdict(true, &[], &[]), Verdict::Stop(m) if m.contains("still running")));
        let old = PathBuf::from("/home/u/.local/share").join(LEGACY_ID);
        match verdict(false, std::slice::from_ref(&old), &[]) {
            Verdict::Stop(m) => assert!(m.contains(&old.display().to_string()), "{m}"),
            Verdict::Proceed => panic!("a failed move must stop the launch"),
        }
        // Absent / AlreadyDone / Moved / Conflict leave nothing in `failed`.
        assert_eq!(verdict(false, &[], &[]), Verdict::Proceed);
    }

    fn root(base: &Path) -> Root {
        Root {
            base: base.to_path_buf(),
            disposable: false,
        }
    }

    #[test]
    fn a_running_old_build_does_not_block_a_launch_once_nothing_is_left_to_move() {
        // Moved on an earlier launch (the old build since recreated its folder), and a root
        // the old build never used.
        let (done, absent) = (scratch("legacy-done"), scratch("legacy-absent"));
        std::fs::create_dir_all(done.join(NEW_ID)).unwrap();
        std::fs::write(done.join(NEW_ID).join(MARKER), b"").unwrap();
        std::fs::create_dir_all(done.join(LEGACY_ID)).unwrap();
        std::fs::write(done.join(LEGACY_ID).join("config.json"), "{}").unwrap();
        // The user started fresh under the new name: never moved either.
        let fresh = scratch("legacy-conflict");
        std::fs::create_dir_all(fresh.join(LEGACY_ID)).unwrap();
        std::fs::write(fresh.join(LEGACY_ID).join("config.json"), "old").unwrap();
        std::fs::create_dir_all(fresh.join(NEW_ID)).unwrap();
        std::fs::write(fresh.join(NEW_ID).join("config.json"), "new").unwrap();

        let roots = [root(&done), root(&absent), root(&fresh)];
        assert_eq!(migrate(&roots, true), Verdict::Proceed);
        assert!(done.join(LEGACY_ID).join("config.json").exists());
        assert!(!absent.join(NEW_ID).exists());
    }

    #[test]
    fn a_running_old_build_stops_the_launch_while_its_data_is_still_to_move() {
        let (done, todo) = (scratch("legacy-done2"), scratch("legacy-todo"));
        std::fs::create_dir_all(done.join(NEW_ID)).unwrap();
        std::fs::write(done.join(NEW_ID).join(MARKER), b"").unwrap();
        std::fs::create_dir_all(todo.join(LEGACY_ID)).unwrap();
        std::fs::write(todo.join(LEGACY_ID).join("config.json"), "old").unwrap();

        let roots = [root(&done), root(&todo)];
        assert!(matches!(migrate(&roots, true), Verdict::Stop(m) if m.contains("still running")));
        // Nothing touched: the next launch, with the old build closed, moves it.
        assert!(todo.join(LEGACY_ID).join("config.json").exists());
        assert!(!todo.join(NEW_ID).exists());
        assert_eq!(migrate(&roots, false), Verdict::Proceed);
        assert!(todo.join(NEW_ID).join(MARKER).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_move_leaves_the_old_folder_whole_and_creates_no_new_one() {
        use std::os::unix::fs::PermissionsExt;
        let base = scratch("failed");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("config.json"), "old").unwrap();
        // A read-only parent: neither the rename nor the staging copy can create anything.
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::write(base.join("probe"), b"").is_ok(); // root ignores modes
        let outcome = migrate_dir(&old, &new, false);
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        if writable {
            return;
        }
        assert_eq!(outcome, Outcome::Failed);
        assert!(!new.exists());
        assert_eq!(
            std::fs::read_to_string(old.join("config.json")).unwrap(),
            "old"
        );
    }

    #[test]
    fn a_root_moved_on_an_earlier_launch_is_re_pointed_when_the_config_arrives() {
        // Launch 1 moved the data root and stopped on the config root; launch 2 moves the config.
        let (cfg_root, data_root) = (scratch("retry-cfg"), scratch("retry-data"));
        let (cfg_old, cfg_new) = (cfg_root.join(LEGACY_ID), cfg_root.join(NEW_ID));
        let (data_old, data_new) = (data_root.join(LEGACY_ID), data_root.join(NEW_ID));
        std::fs::create_dir_all(&data_new).unwrap();
        std::fs::write(data_new.join(MARKER), b"").unwrap();
        std::fs::create_dir_all(&cfg_new).unwrap();
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": data_old.join("audio-x") },
        }});
        std::fs::write(cfg_new.join("config.json"), cfg.to_string()).unwrap();
        let roots = [root(&cfg_root), root(&data_root)];
        rewrite_moved_paths(&roots, vec![(cfg_old, cfg_new.clone())]);
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cfg_new.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            out["settings"]["recording"]["audioBaseDir"],
            serde_json::json!(data_new.join("audio-x"))
        );
    }

    #[test]
    fn a_fresh_install_has_nothing_to_move() {
        let base = scratch("fresh");
        assert_eq!(
            migrate_dir(&base.join(LEGACY_ID), &base.join(NEW_ID), false),
            Outcome::Absent
        );
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
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            "{}"
        );
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
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            "new"
        );
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
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            "old"
        );
    }

    #[test]
    fn a_cache_is_dropped_not_moved() {
        let base = scratch("cache");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(old.join("playback")).unwrap();
        assert_eq!(migrate_dir(&old, &new, true), Outcome::Absent);
        assert!(!old.exists() && !new.exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn a_cache_root_that_is_the_data_root_never_deletes_the_users_data() {
        // XDG_CACHE_HOME == XDG_DATA_HOME, and the user already started fresh under the new
        // name: the data root leaves the old folder in place, the cache root must not drop it.
        let base = scratch("cache-is-data");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(old.join("audio")).unwrap();
        std::fs::write(old.join("audio").join("a.wav"), b"x").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("config.json"), "new").unwrap();
        let mut roots = vec![root(&scratch("cache-is-data-cfg")), root(&base)];
        push_cache_root(&mut roots, base.clone());
        assert!(roots.iter().all(|r| !r.disposable));
        assert_eq!(migrate(&roots, false), Verdict::Proceed);
        assert!(old.join("audio").join("a.wav").exists());

        // The same folder reached through a symlink is the same folder.
        let link = scratch("cache-link").join("cache");
        std::os::unix::fs::symlink(&base, &link).unwrap();
        let mut roots = vec![root(&base)];
        push_cache_root(&mut roots, link);
        assert!(roots.iter().all(|r| !r.disposable));

        // A cache of its own is still a cache.
        let mut roots = vec![root(&base)];
        push_cache_root(&mut roots, scratch("own-cache"));
        assert!(roots[1].disposable);
    }

    #[test]
    fn the_staged_copy_skips_locks_and_temp_files() {
        let base = scratch("copy");
        let (from, to) = (base.join("from"), base.join("to"));
        std::fs::create_dir_all(from.join("EBWebView")).unwrap();
        std::fs::write(from.join("EBWebView").join("LOCK"), b"").unwrap();
        std::fs::write(from.join("config.json.tmp"), b"").unwrap();
        std::fs::write(from.join("EBWebView").join("prefs"), b"p").unwrap();
        // An older build's finished media copy of a `.tmp` source, and an in-progress one.
        let id = "9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b";
        std::fs::create_dir_all(from.join("audio").join("files")).unwrap();
        std::fs::write(from.join("audio/files").join(format!("{id}.tmp")), b"a").unwrap();
        std::fs::write(from.join("audio/files").join(format!("{id}.mp3.tmp")), b"").unwrap();
        copy_tree(&from, &to).unwrap();
        assert!(to.join("EBWebView").join("prefs").exists());
        assert!(!to.join("EBWebView").join("LOCK").exists());
        assert!(!to.join("config.json.tmp").exists());
        assert!(to.join("audio/files").join(format!("{id}.tmp")).exists());
        assert!(!to
            .join("audio/files")
            .join(format!("{id}.mp3.tmp"))
            .exists());
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
        let rebased =
            rewrite_config_paths(&new.join("config.json"), &[(old, new.clone())]).unwrap();
        assert_eq!(rebased, vec![new.join("my-audio")]);
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(new.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            out["settings"]["recording"]["audioBaseDir"],
            serde_json::json!(new.join("my-audio"))
        );
        assert_eq!(
            out["settings"]["recording"]["recordingsDir"],
            serde_json::json!(elsewhere)
        );
    }

    #[test]
    fn a_config_saved_with_a_bom_still_follows_the_move() {
        let base = scratch("bom");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&new).unwrap();
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": old.join("my-audio") },
        }});
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice(cfg.to_string().as_bytes());
        std::fs::write(new.join("config.json"), bytes).unwrap();
        let rebased =
            rewrite_config_paths(&new.join("config.json"), &[(old, new.clone())]).unwrap();
        assert_eq!(rebased, vec![new.join("my-audio")]);
        let text = crate::config::read_config_text(&new.join("config.json"))
            .unwrap()
            .unwrap();
        let out: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            out["settings"]["recording"]["audioBaseDir"],
            serde_json::json!(new.join("my-audio"))
        );
    }

    #[test]
    fn a_config_that_is_not_valid_utf8_follows_the_move_and_keeps_its_bytes_aside() {
        let base = scratch("not-utf8");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&new).unwrap();
        let bytes = latin1_config(&old.join("my-audio"));
        let config = new.join("config.json");
        std::fs::write(&config, &bytes).unwrap();
        let rebased = rewrite_config_paths(&config, &[(old, new.clone())]).unwrap();
        // Re-pointed: the loader reads the file lossily anyway, and the move never retries.
        assert_eq!(rebased, vec![new.join("my-audio")]);
        let text = crate::config::read_config_text(&config).unwrap().unwrap();
        let out: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            out["settings"]["recording"]["audioBaseDir"],
            serde_json::json!(new.join("my-audio"))
        );
        // The original bytes survive in a side copy — not config.json.bak, the reset banner's.
        assert_eq!(
            std::fs::read(new.join("config.json.invalid-utf8.bak")).unwrap(),
            bytes
        );
        assert!(!new.join("config.json.bak").exists());
    }

    /// A side copy cut short (a write that failed half-way, a crash) must not refuse every later
    /// re-point; one holding other bytes is still never overwritten.
    #[test]
    fn a_side_copy_cut_short_is_written_again_so_the_re_point_retry_lands() {
        let base = scratch("side-partial");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&new).unwrap();
        let bytes = latin1_config(&old.join("my-audio"));
        let config = new.join("config.json");
        std::fs::write(&config, &bytes).unwrap();
        let side = new.join("config.json.invalid-utf8.bak");
        let moved = [(old, new.clone())];
        std::fs::write(&side, b"other").unwrap();
        assert!(rewrite_config_paths(&config, &moved).is_err());
        assert_eq!(std::fs::read(&side).unwrap(), b"other");
        std::fs::write(&side, &bytes[..10]).unwrap();
        assert_eq!(
            rewrite_config_paths(&config, &moved),
            Ok(vec![new.join("my-audio")])
        );
        assert_eq!(std::fs::read(&side).unwrap(), bytes);
        assert!(!new.join(REPOINT_PENDING).exists());
    }

    #[test]
    fn a_failed_config_write_reports_nothing_re_pointed_and_a_later_launch_still_re_points() {
        let base = scratch("write-fails");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&new).unwrap();
        let bytes = latin1_config(&old.join("my-audio"));
        let config = new.join("config.json");
        std::fs::write(&config, &bytes).unwrap();
        // A directory where the atomic write's temp file goes: the write fails, as a held
        // config.json does on Windows.
        let blocker = crate::transport::media::tmp_sibling(&config);
        std::fs::create_dir_all(blocker.join("held")).unwrap();
        let moved = [(old, new.clone())];
        assert!(rewrite_config_paths(&config, &moved).is_err());
        assert_eq!(std::fs::read(&config).unwrap(), bytes);
        assert!(new.join(REPOINT_PENDING).exists());
        // The next launch, brought back by the pending marker, finds the side copy from the
        // first try holding these exact bytes, and still re-points.
        std::fs::remove_dir_all(&blocker).unwrap();
        assert_eq!(
            rewrite_config_paths(&config, &moved),
            Ok(vec![new.join("my-audio")])
        );
        assert_eq!(
            std::fs::read(new.join("config.json.invalid-utf8.bak")).unwrap(),
            bytes
        );
        assert!(!new.join(REPOINT_PENDING).exists());
    }

    /// A config.json unreadable for the first time stops the launch: a hold that ends right
    /// after this read lets the loader start on the settings that still name the vacated folder,
    /// and the session would record into it. The pending marker is left, so the next launch
    /// retries.
    #[test]
    fn a_config_that_cannot_be_read_stops_the_first_launch_with_the_retry_armed() {
        let base = scratch("read-fails-once");
        let new = base.join(NEW_ID);
        let config = new.join("config.json");
        // A directory here; a held or root-owned file in the field.
        std::fs::create_dir_all(&config).unwrap();
        let moved = [(base.join(LEGACY_ID), new.clone())];
        assert_eq!(rewrite_config_paths(&config, &moved), Err(()));
        assert!(new.join(REPOINT_PENDING).exists());
    }

    /// A config.json that is still unreadable when the pending marker is already there must not
    /// stop the launch: an earlier launch saw the same fault, and stopping again would stop
    /// every launch for good. It must not drop the retry either: only the marker brings a later
    /// launch back to re-point the settings. One rule for every read error, PermissionDenied
    /// included: a lasting fault costs one stopped launch, then each launch one bounded re-read
    /// until the file reads again.
    #[test]
    fn a_config_that_cannot_be_read_stops_once_then_goes_on_and_retries_next_launch() {
        let base = scratch("read-fails");
        let new = base.join(NEW_ID);
        std::fs::create_dir_all(&new).unwrap();
        let moved = [(base.join(LEGACY_ID), new.clone())];
        // Missing: nothing to re-point, no marker.
        assert_eq!(
            rewrite_config_paths(&new.join("config.json"), &moved),
            Ok(vec![])
        );
        assert!(!new.join(REPOINT_PENDING).exists());
        // Present but unreadable (a directory here; a held or root-owned file in the field):
        // the first launch stops and leaves the marker; the next, still unable to read it, goes
        // on and keeps the marker for the launch after.
        let config = new.join("config.json");
        std::fs::create_dir_all(&config).unwrap();
        assert_eq!(rewrite_config_paths(&config, &moved), Err(()));
        assert!(new.join(REPOINT_PENDING).exists());
        assert_eq!(rewrite_config_paths(&config, &moved), Ok(vec![]));
        assert!(new.join(REPOINT_PENDING).exists());
        // The next launch reads it and re-points the setting, and the marker goes.
        std::fs::remove_dir(&config).unwrap();
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": base.join(LEGACY_ID).join("my-audio") },
        }});
        std::fs::write(&config, cfg.to_string()).unwrap();
        assert_eq!(
            rewrite_config_paths(&config, &moved),
            Ok(vec![new.join("my-audio")])
        );
        assert!(!new.join(REPOINT_PENDING).exists());
    }

    /// The pending marker proves a lasting fault only for the fault it records. A write that
    /// failed under a hold, then a read failing under the same hold on the next launch, is no
    /// lasting fault: the hold may end a moment later and let the loader start on the settings
    /// still naming the vacated folder. A write failing again is one, and must not stop every
    /// launch for good.
    #[test]
    fn a_re_point_fault_goes_on_only_when_an_earlier_launch_hit_the_same_one() {
        let base = scratch("fault-kinds");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(&new).unwrap();
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": old.join("my-audio") },
        }})
        .to_string();
        let config = new.join("config.json");
        std::fs::write(&config, &cfg).unwrap();
        // Blocks the atomic write's temp file, as a held config.json does on Windows.
        let blocker = crate::transport::media::tmp_sibling(&config);
        std::fs::create_dir_all(blocker.join("held")).unwrap();
        let moved = [(old, new.clone())];
        assert_eq!(rewrite_config_paths(&config, &moved), Err(()));
        // The next launch cannot read it (a directory here; the same hold in the field): stops.
        std::fs::remove_file(&config).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert_eq!(rewrite_config_paths(&config, &moved), Err(()));
        // Readable again but the write still fails: a different fault than last launch, stops.
        std::fs::remove_dir(&config).unwrap();
        std::fs::write(&config, &cfg).unwrap();
        assert_eq!(rewrite_config_paths(&config, &moved), Err(()));
        // The same write fault again: lasting, so the launch goes on with nothing re-pointed and
        // the retry kept.
        assert_eq!(rewrite_config_paths(&config, &moved), Ok(vec![]));
        assert!(new.join(REPOINT_PENDING).exists());
        std::fs::remove_dir_all(&blocker).unwrap();
        assert_eq!(
            rewrite_config_paths(&config, &moved),
            Ok(vec![new.join("my-audio")])
        );
        assert!(!new.join(REPOINT_PENDING).exists());
    }

    #[test]
    fn a_failed_config_write_stops_the_launch_and_a_launch_with_nothing_left_to_move_re_points() {
        let base = scratch("write-retry");
        let (old, new) = (base.join(LEGACY_ID), base.join(NEW_ID));
        std::fs::create_dir_all(old.join("my-audio")).unwrap();
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": old.join("my-audio") },
        }});
        std::fs::write(old.join("config.json"), cfg.to_string()).unwrap();
        // Moves with the folder and blocks the atomic write's temp file, as a held config.json
        // does on Windows.
        let blocker = crate::transport::media::tmp_sibling(&old.join("config.json"));
        std::fs::create_dir_all(blocker.join("held")).unwrap();
        let roots = [root(&base)];
        let config = new.join("config.json");
        // No session may run on the vacated folder the setting still names: the launch stops,
        // as on a failed move, and says which settings file is stuck.
        match migrate(&roots, false) {
            Verdict::Stop(m) => assert!(m.contains(&config.display().to_string()), "{m}"),
            Verdict::Proceed => panic!("a failed re-point must stop the launch"),
        }
        let audio_base = |cfg: &Path| -> serde_json::Value {
            let out: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(cfg).unwrap()).unwrap();
            out["settings"]["recording"]["audioBaseDir"].clone()
        };
        assert_eq!(audio_base(&config), serde_json::json!(old.join("my-audio")));
        assert!(new.join(REPOINT_PENDING).exists());
        // The next launch: every root already moved, yet the setting is re-pointed.
        std::fs::remove_dir_all(crate::transport::media::tmp_sibling(&config)).unwrap();
        assert_eq!(migrate(&roots, false), Verdict::Proceed);
        assert_eq!(audio_base(&config), serde_json::json!(new.join("my-audio")));
        assert!(!new.join(REPOINT_PENDING).exists());
    }

    #[test]
    fn a_custom_folder_in_another_root_follows_its_move() {
        // Linux: config.json under ~/.config, the audio folder under ~/.local/share.
        let (cfg_root, data_root) = (scratch("cfg-root"), scratch("data-root"));
        let cfg_new = cfg_root.join(NEW_ID);
        let (data_old, data_new) = (data_root.join(LEGACY_ID), data_root.join(NEW_ID));
        std::fs::create_dir_all(&cfg_new).unwrap();
        let cfg = serde_json::json!({ "settings": {
            "recording": { "audioBaseDir": data_old.join("audio-x") },
            "logging": { "logDir": data_old.join("logs") },
        }});
        std::fs::write(cfg_new.join("config.json"), cfg.to_string()).unwrap();
        let moved = [
            (cfg_root.join(LEGACY_ID), cfg_new.clone()),
            (data_old, data_new.clone()),
        ];
        let rebased = rewrite_config_paths(&cfg_new.join("config.json"), &moved).unwrap();
        assert_eq!(rebased, vec![data_new.join("audio-x")]);
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cfg_new.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            out["settings"]["recording"]["audioBaseDir"],
            serde_json::json!(data_new.join("audio-x"))
        );
        assert_eq!(
            out["settings"]["logging"]["logDir"],
            serde_json::json!(data_new.join("logs"))
        );
    }
}
