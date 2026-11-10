//! The audio base folder (layout, move, open) and the file I/O commands: media reads
//! for playback, text save/read, opening a source link, reveal in the file manager.

use super::{
    audio_base_pref, custom_folder, require_audio_base, resolve_audio_base, AUDIO_SUBDIRS,
    HEAL_STAMP,
};
use crate::config::Config;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Absolute path of the active audio base folder (custom or default), for
/// display in Settings — a leading `$HOME` is collapsed to `~`.
#[tauri::command]
pub fn audio_dir_path(app: AppHandle, custom: Option<String>) -> Option<String> {
    let dir = resolve_audio_base(&app, custom)?;
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Some(format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()));
        }
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Open the active audio base folder in the system file manager. Creates it
/// (with its subfolders) first so the button works before the first run.
/// async + spawn_blocking: a sync command runs on the main thread, and the base can sit on a
/// slow or stalled mount (network share, sleeping disk).
#[tauri::command]
pub async fn open_audio_dir(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    super::blocking(move || -> Result<(), String> {
        let dir = require_audio_base(&app, custom)?;
        crate::audio::create_dir_private(&dir)
            .map_err(|e| format!("could not create the folder: {e}"))?;
        for sub in AUDIO_SUBDIRS {
            let _ = crate::audio::create_dir_private(&dir.join(sub));
        }
        // The base can arrive from a sync peer, and `create_dir_private` passes any existing
        // path: a file there would be opened (or run) instead of shown as a folder.
        if !dir.is_dir() {
            return Err("the configured folder is not a folder".into());
        }
        // Not the bare plugin call: the file manager it may cold-start must not inherit the
        // env vars this process injected for itself (see `crate::open_external`).
        crate::open_external(&app, &dir.to_string_lossy())
    })
    .await
}

/// Move one file across a possible filesystem boundary: rename, else
/// copy + remove (verified by the copy's success).
fn move_file(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        // Owner-only like the copy arm: a file written before recordings were created 0600
        // would otherwise keep its old mode in a target folder others can list. Only when
        // `dest` is still the plain file just moved, so the change never lands through a link.
        if std::fs::symlink_metadata(dest).is_ok_and(|m| m.file_type().is_file()) {
            crate::audio::restrict_file_private(dest);
        }
        return Ok(());
    }
    let moved = copy_keeping_mtime(src, dest).and_then(|()| {
        // Owner-only on both platforms: on Windows the copy otherwise takes the DACL of a
        // destination folder that may have pre-existed the pick (`create_dir_private` skips it).
        crate::audio::restrict_file_private(dest);
        std::fs::remove_file(src)
    });
    // Both callers checked `dest` did not exist, so whatever a failed copy (a full disk) or an
    // unremovable source left there is ours: kept, it would trip their never-clobber check on
    // every retry and strand the file in the old base.
    if moved.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    moved
}

/// `move_file`'s cross-volume copy, carrying the source's mtime over (`std::fs::copy` does not
/// on Linux): dictation audio ages by mtime on the same clock as its record, which a move keeps
/// (`rewrite_record_keep_mtime`), so a fresh copy clock would outlive the record by a window.
///
/// `dest` is created fresh and owner-only: every caller has checked nothing is there, and the
/// target base may be a shared folder where a link planted in between must not be written
/// through (the open fails instead, and `move_file` unlinks the link).
///
/// The source is judged on the opened handle and copied from it: the old base may be writable
/// by another account, which could swap an entry for a FIFO or a link to an endless device
/// after the caller's check. Anything not a regular file fails with `InvalidInput`. A regular
/// file that keeps growing past the size the handle reported at open (that account appending
/// to it for as long as the copy runs) fails the move with an error instead of filling the target
/// volume and never finishing. A large sparse source is still copied out densely.
fn copy_keeping_mtime(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    let (mut inp, meta) = crate::transport::open_regular_file(src)?.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a regular file")
    })?;
    let mtime = meta.modified().ok();
    let mut out = crate::audio::create_new_private(dest)?;
    crate::transport::copy_at_most(&mut inp, &mut out, meta.len())?;
    if let Some(t) = mtime {
        let _ = out.set_modified(t);
    }
    Ok(())
}

/// A Windows sharing violation on the rename, the copy's open or the source's removal: a
/// dictation save holds the file with share mode 0 while it writes it
/// (`audio::write_new_private`), and so may a media player, a virus scanner or a sync client.
/// `move_file` then leaves the source where it was. 32 is EPIPE elsewhere, which never means this.
fn held_open_elsewhere(e: &std::io::Error) -> bool {
    cfg!(windows) && e.raw_os_error() == Some(32)
}

/// How often and how far apart [`move_file_waiting_out_a_save`] retries a held file: about two
/// seconds, well past a dictation save's write + sync.
const HELD_RETRIES: u32 = 20;
const HELD_RETRY_GAP: std::time::Duration = std::time::Duration::from_millis(100);

/// `move_file`, retried for a short while when the source is held unshared, so a dictation save
/// writing it right now does not fail the whole relocation. A file still held after that (a
/// player, a scanner, a sync client keeping it open) fails the move like any other error rather
/// than being skipped: left in the old base, it would sit outside every delete and retention
/// sweep, which only look under the current base. Runs on the move's blocking thread.
fn move_file_waiting_out_a_save(
    src: &std::path::Path,
    dest: &std::path::Path,
) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match move_file(src, dest) {
            // The never-clobber check is redone each round: the rename replaces an existing
            // destination on Windows, and the wait widens the gap since the caller looked.
            Err(e) if held_open_elsewhere(&e) && tries < HELD_RETRIES && !dest.exists() => {
                tries += 1;
                std::thread::sleep(HELD_RETRY_GAP);
            }
            r => return r,
        }
    }
}

/// Move every regular file from `from` into `to`, recording old→new paths.
/// Stops on the first error; already-moved files stay moved and are in `map`,
/// which the caller rewrites into the records even on failure (they store
/// absolute paths, so nothing else would re-point them).
fn move_dir_contents(
    from: &std::path::Path,
    to: &std::path::Path,
    map: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(from) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("could not read {}: {e}", from.display())),
    };
    crate::audio::create_dir_private(to).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let src = entry.path();
        // The entry's own type, not the path's: a link planted in the old base is left there,
        // never copied from its target. The app writes no links into these folders.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        // An in-progress media copy (`<id>.<ext>.tmp`, see save_transcript_media) finishes in
        // the old base and its record keeps a valid absolute path; moving it under the writer
        // fails the copier's final rename and strands a `.tmp` every sweep skips forever. An
        // older build's finished `<id>.tmp` copy moves like any other.
        if crate::store::transcripts::is_partial_copy(&src) {
            continue;
        }
        let Some(name) = src.file_name() else {
            continue;
        };
        let dest = to.join(name);
        // Never clobber (the layout migration's rule, applied to the relocation too): a base
        // that already holds a same-named file — a second install pointed at one synced folder,
        // a re-run after a partial move — keeps it, and the record still points at the source.
        if dest.exists() {
            tracing::warn!("[audio] not moving {:?} — {:?} already exists", src, dest);
            continue;
        }
        match move_file_waiting_out_a_save(&src, &dest) {
            // Swapped for a non-file after the check above: skipped like one found at the check.
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => continue,
            r => r.map_err(|e| format!("could not move {}: {e}", src.display()))?,
        }
        map.push((
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        ));
    }
    let _ = std::fs::remove_dir(from); // only removes if now empty
    Ok(())
}

/// Fix every media path (`mediaPath`, `videoPath`, `sourcePath`) of every history record that
/// pointed at a moved file. False when a record that pointed at one could not be rewritten.
fn rewrite_media_paths(app: &AppHandle, map: &[(String, String)]) -> bool {
    if map.is_empty() {
        return true;
    }
    let lookup: std::collections::HashMap<&str, &str> =
        map.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    crate::store::transcripts::rewrite_media_paths(app, &lookup)
}

/// A one-way latch: closed until `open`, then every `wait` returns at once.
pub(crate) struct Gate {
    open: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

impl Gate {
    pub(crate) const fn new() -> Self {
        Self {
            open: std::sync::Mutex::new(false),
            cv: std::sync::Condvar::new(),
        }
    }

    pub(crate) fn open(&self) {
        *self.open.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    pub(crate) fn wait(&self) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        while !*open {
            open = self.cv.wait(open).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// `wait`, but for at most `d`: true once open, false when `d` ran out first.
    pub(crate) fn wait_timeout(&self, d: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + d;
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        while !*open {
            let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) else {
                return false;
            };
            open = self
                .cv
                .wait_timeout(open, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

/// Opens once this launch's `ensure_audio_layout` is over (done, panicked, or never started).
static AUDIO_LAYOUT: Gate = Gate::new();

/// Run this launch's `ensure_audio_layout` on its own thread. setup() runs on the main thread
/// before the event loop, and the base can sit on a stalled mount (an offline network share, a
/// sleeping disk) whose mkdir/read_dir blocks without limit: launch must not wait on it (the
/// log folder's open is queued for the same reason). What must not overlap a half-done move
/// waits on [`wait_audio_layout`] instead: the retention sweeps' audio-base halves (they look in
/// the new layout), `move_audio_base` (it moves the same subfolders) and the History deletes'
/// audio-folder steps (a file moved in after they looked would stay behind). The single-record
/// delete and the retention sweeps' record halves do not wait: the records live in app data, and
/// a rewrite skips a record already gone. The two wipe-all commands wait before their record wipe,
/// so it lands with the IPC settle that reloads History (they emit no swept event). Every
/// writer creates its own folder, so nothing else depends on the layout being in place; a
/// History listing taken before a migration moved something is told to reload when it is done.
pub(crate) fn queue_audio_layout(app: &AppHandle, config: Config) {
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("audio-layout".into())
        .spawn(move || {
            // A panic must not leave the sweeps and a base move waiting on a gate nobody opens.
            let changed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ensure_audio_layout(&app, &config)
            }))
            .unwrap_or(true);
            AUDIO_LAYOUT.open();
            // A History listing taken while this ran may hold the pre-move paths: have it
            // reload, or it plays them (a re-save from it is re-pointed by
            // save_transcript_record, see `MOVED` in store/transcripts.rs). Nothing went, so
            // `removed: 0` and `dictationsWiped: false`.
            if changed {
                use tauri::Emitter;
                let _ = app.emit(
                    "transcripts://swept",
                    serde_json::json!({ "removed": 0, "dictationsWiped": false }),
                );
            }
        });
    // Nor may a thread that never started: the migration is idempotent and retried next launch.
    if let Err(e) = started {
        tracing::warn!("[audio] could not start the audio-layout worker: {e}");
        AUDIO_LAYOUT.open();
    }
}

/// Block until this launch's audio-layout job is over (see [`queue_audio_layout`]).
pub(crate) fn wait_audio_layout() {
    AUDIO_LAYOUT.wait();
}

/// [`wait_audio_layout`] for at most `d`: true once the job is over, false when `d` ran out.
pub(crate) fn wait_audio_layout_for(d: std::time::Duration) -> bool {
    AUDIO_LAYOUT.wait_timeout(d)
}

/// One-time (idempotent) migration into the single-base layout: legacy saved
/// recordings move into `<base>/dictations`, the old app-data media store
/// splits into `<base>/files` + `<base>/links` by record kind. Run once per
/// launch, off the main thread (`queue_audio_layout`, which lists who waits for
/// it). True when it rewrote or healed records' media paths.
fn ensure_audio_layout(app: &AppHandle, config: &Config) -> bool {
    let pref = audio_base_pref(&config.settings);
    let Some(base) = resolve_audio_base(app, pref.clone()) else {
        return false;
    };
    let _ = crate::audio::create_dir_private(&base);
    for sub in AUDIO_SUBDIRS {
        let _ = crate::audio::create_dir_private(&base.join(sub));
    }
    let mut map: Vec<(String, String)> = Vec::new();
    // Legacy recordings: the custom folder (which may BE the new base — then
    // its loose dictation files just move down into dictations/) or the old
    // app-data default.
    // Only an ABSOLUTE preference names a folder (`custom_folder`, as the base itself resolves):
    // a relative one ("Downloads", from a sync peer) would sweep a folder relative to the
    // process's working directory. Such a preference has no legacy folder to sweep.
    let legacy_rec = match &pref {
        Some(p) => custom_folder(Some(p)),
        None => match app.path().app_data_dir() {
            Ok(d) => Some(d.join("recordings")),
            Err(_) => return false,
        },
    };
    let dict = base.join("dictations");
    if let Some(legacy_rec) = legacy_rec.filter(|l| *l != dict) {
        if let Ok(entries) = std::fs::read_dir(&legacy_rec) {
            for entry in entries.flatten() {
                let src = entry.path();
                let Some(name) = src.file_name() else {
                    continue;
                };
                // Only the app's own files: the legacy folder is a free user pick (~/Music,
                // a shared Documents folder…), and relocating every .wav/.txt in it would move
                // foreign files under a folder "Delete all dictations" then wipes.
                // `file_type` is the entry's own: a planted link is left behind (see
                // `move_dir_contents`).
                if !entry.file_type().is_ok_and(|t| t.is_file())
                    || !crate::audio::is_dictation_file(&name.to_string_lossy())
                {
                    continue;
                }
                let dest = dict.join(name);
                if dest.exists() {
                    continue; // never clobber
                }
                if move_file(&src, &dest).is_ok() {
                    map.push((
                        src.to_string_lossy().into_owned(),
                        dest.to_string_lossy().into_owned(),
                    ));
                }
            }
            if legacy_rec.file_name().and_then(|n| n.to_str()) == Some("recordings") {
                let _ = std::fs::remove_dir(&legacy_rec);
            }
        }
    }
    if let Ok(legacy_media) = crate::store::transcripts::legacy_media_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&legacy_media) {
            for entry in entries.flatten() {
                let src = entry.path();
                if !entry.file_type().is_ok_and(|t| t.is_file()) {
                    continue; // a link is left behind (see `move_dir_contents`)
                }
                let Some(name) = src.file_name() else {
                    continue;
                };
                let stem = src
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let sub = if crate::store::transcripts::record_kind(app, &stem).as_deref()
                    == Some("url")
                {
                    "links"
                } else {
                    "files"
                };
                let dest = base.join(sub).join(name);
                if dest.exists() {
                    continue;
                }
                if move_file(&src, &dest).is_ok() {
                    map.push((
                        src.to_string_lossy().into_owned(),
                        dest.to_string_lossy().into_owned(),
                    ));
                }
            }
            let _ = std::fs::remove_dir(&legacy_media);
        }
    }
    if !map.is_empty() {
        tracing::info!(
            "[audio] layout migration moved {} file(s) under {:?}",
            map.len(),
            base
        );
        rewrite_media_paths(app, &map);
    }
    // Repair records a past incomplete rewrite left pointing at moved files. A full read+parse
    // of every record, so only after a migration that moved something or while the base lacks
    // the stamp (a fresh install with no records just stamps); `move_audio_base` heals through
    // its own rewrite. The stamp is written only once the heal reached every record (dropped
    // otherwise), so a record a sync client or antivirus held, or an unlistable history folder,
    // is retried next launch; a permanently unreadable record re-runs the scan each launch — the
    // same read+parse the History listing does, accepted.
    // A base that is no folder (unplugged drive, offline share, broken link) can heal nothing and
    // cannot take the stamp, so the scan would repeat every offline launch: skip it and leave the
    // heal armed. (A migration that moved something moved it INTO the base, so it is a folder.)
    if !base.is_dir() {
        tracing::info!(
            "[audio] audio folder {:?} unavailable; media-path repair left for a later launch",
            base
        );
        return !map.is_empty();
    }
    let stamp = base.join(HEAL_STAMP);
    if !stamp.exists() && map.is_empty() && !crate::store::transcripts::has_any_records(app) {
        let _ = write_heal_stamp(&stamp);
    } else if !map.is_empty() || !stamp.exists() {
        let (complete, fixed) = crate::store::transcripts::heal_media_paths(app, &base);
        if complete {
            let _ = write_heal_stamp(&stamp);
        } else {
            let _ = std::fs::remove_file(&stamp);
        }
        // A heal that re-pointed nothing changed no path a History listing holds.
        return !map.is_empty() || fixed > 0;
    }
    !map.is_empty()
}

/// Write the empty heal stamp at the root of the audio base — a user-picked, possibly shared
/// folder. Never truncating (the stamp is empty, so there is nothing to cut) and, on Linux, never
/// through a symlink: a link planted as the stamp then fails the write (the heal stays armed)
/// instead of emptying the file it points at. A FIFO planted there is refused without waiting
/// for a reader (non-blocking open, then a regular-file check on the handle): a blocked open
/// would park the folder move or the layout job every media action waits on.
fn write_heal_stamp(stamp: &std::path::Path) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        #[cfg(not(target_os = "linux"))]
        opts.custom_flags(libc::O_NONBLOCK);
    }
    let f = opts.open(stamp)?;
    if !f.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the heal stamp is not a regular file",
        ));
    }
    Ok(())
}

/// Relocate the whole audio store: move every media subfolder (`AUDIO_SUBDIRS`:
/// dictations, files, links, video) from the current base to the next one and fix
/// the records' stored paths. The caller (the Settings screen) persists the new
/// setting only after this returns Ok — never save-then-hope. On Err the records
/// that DID move are already rewritten on disk, so the caller must reload history
/// either way, or its mirror keeps playing the pre-move paths.
#[tauri::command]
pub async fn move_audio_base(
    app: AppHandle,
    current: Option<String>,
    next: Option<String>,
) -> Result<(), String> {
    let from = require_audio_base(&app, current)?;
    let to = resolve_audio_base(&app, next).ok_or("could not resolve the new folder")?;
    if from == to {
        return Ok(());
    }
    if to.starts_with(&from) {
        return Err("the new folder can't be inside the current one".into());
    }
    super::blocking(move || {
        // Not under a launch layout migration still moving files into these same subfolders.
        wait_audio_layout();
        crate::audio::create_dir_private(&to)
            .map_err(|e| format!("could not create the folder: {e}"))?;
        let mut map: Vec<(String, String)> = Vec::new();
        let mut res: Result<(), String> = Ok(());
        for sub in AUDIO_SUBDIRS {
            if let Err(e) = move_dir_contents(&from.join(sub), &to.join(sub), &mut map) {
                res = Err(e);
                break;
            }
        }
        // Move the heal stamp: left behind, it blocks the remove_dir below and the new base
        // re-runs the full heal scan next launch. A missing old stamp is a pending heal (a failed
        // rewrite or identifier migration dropped it) that must travel too, so a stray stamp
        // already at the new base is cleared instead of masking it. Rename first: a no-op when
        // both paths name one folder (case-only difference, symlink); across drives (EXDEV) the
        // empty marker is written + removed instead.
        let (old_stamp, new_stamp) = (from.join(HEAL_STAMP), to.join(HEAL_STAMP));
        if !old_stamp.exists() {
            let _ = std::fs::remove_file(&new_stamp);
        } else if std::fs::rename(&old_stamp, &new_stamp).is_err() {
            let _ = write_heal_stamp(&new_stamp);
            let _ = std::fs::remove_file(&old_stamp);
        }
        let _ = std::fs::remove_dir(&from); // only if empty

        // Always re-point what actually moved: records store ABSOLUTE paths, and a
        // partial move leaves the preference on the old base, which the startup heal
        // then searches — so an unrewritten record would stay broken for good.
        if !rewrite_media_paths(&app, &map) {
            // A record that pointed at a moved file could not be rewritten: drop the stamp so
            // the next launch's heal re-points it by basename under the new base (the same
            // remedy as the identifier migration).
            let _ = std::fs::remove_file(&new_stamp);
        }
        match &res {
            Ok(()) => tracing::info!("[audio] base moved: {} file(s) → {:?}", map.len(), to),
            Err(e) => tracing::warn!(
                "[audio] base move stopped after {} file(s) moved to {:?}: {e}",
                map.len(),
                to
            ),
        }
        res
    })
    .await
}

enum CappedRead {
    TooLarge,
    NotAFile,
    Io(std::io::Error),
}

/// Read a whole regular file of at most `cap` bytes. The path comes from the webview, so the
/// checks run on the one opened handle, not a separate stat: a swap between stat and read could
/// otherwise hand over a device or a file that grows, and the read itself stops at `cap + 1`.
fn read_capped(path: &str, cap: u64) -> Result<Vec<u8>, CappedRead> {
    use std::io::Read as _;
    // A FIFO is refused without waiting for a writer (see open_regular_file).
    let (f, meta) = crate::transport::open_regular_file(std::path::Path::new(path))
        .map_err(CappedRead::Io)?
        .ok_or(CappedRead::NotAFile)?;
    if meta.len() > cap {
        return Err(CappedRead::TooLarge);
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    f.take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(CappedRead::Io)?;
    if buf.len() as u64 > cap {
        return Err(CappedRead::TooLarge);
    }
    Ok(buf)
}

/// The exact refusal text the webview matches on: the viewer falls back to the decode path,
/// History says the file is too large instead of gone.
pub const MEDIA_TOO_LARGE: &str = "too large to buffer";

/// Read a media file into memory for in-card playback from a blob URL: Linux WebKitGTK's
/// media stack is unreliable over custom URI schemes (the asset protocol). Raw IPC response
/// (no base64/JSON round-trip); capped so a mispicked multi-GB video can't balloon the webview.
#[tauri::command]
pub async fn read_media_file(path: String) -> Result<tauri::ipc::Response, String> {
    // Below the ~240 MB at which handing the bytes over IPC froze the web process (see
    // `decode_media_file`), with headroom for the JS-side Blob copy. The viewer routes an
    // over-cap refusal to the decode path instead of calling the media broken.
    const MAX_MEDIA_BYTES: u64 = 192 * 1024 * 1024;
    // The size check too runs on the blocking pool: a stat of media on a stalled mount (a
    // sleeping disk, an offline share) must not park a runtime worker any more than the read.
    let bytes = super::blocking(move || -> Result<Vec<u8>, String> {
        read_capped(&path, MAX_MEDIA_BYTES).map_err(|e| match e {
            CappedRead::TooLarge => MEDIA_TOO_LARGE.into(),
            CappedRead::NotAFile => "not a file".into(),
            CappedRead::Io(e) => e.to_string(),
        })
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open a transcribed link in the system browser. Scheme-checked so a
/// stored record can only ever launch a web URL, never a local program.
#[tauri::command]
pub fn open_source_url(app: AppHandle, url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("not a web link".into());
    }
    // A cold-started browser must not inherit our injected env vars (`crate::open_external`).
    crate::open_external(&app, u)
}

/// The longest path `reveal_in_folder` accepts (bytes): Linux's PATH_MAX, past any real export path.
const REVEAL_PATH_MAX: usize = 4096;

/// A path `reveal_in_folder` may show: non-empty, bounded, free of control
/// characters, absolute, and present on disk. A just-saved export always is.
fn reveal_target(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > REVEAL_PATH_MAX {
        return Err("not a usable path".into());
    }
    if path.chars().any(char::is_control) {
        return Err("the path has control characters".into());
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("not an absolute path".into());
    }
    if !p.exists() {
        return Err("the file is not there".into());
    }
    Ok(p)
}

/// Show a saved export in the system file manager: its folder opens with the
/// file selected. async + spawn_blocking: the Linux path is a blocking D-Bus
/// call (FileManager1, else the OpenURI portal), and the existence check runs on the
/// blocking pool too — a stat of an export on a stalled mount (a sleeping disk, an offline
/// share) must not park a runtime worker.
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    super::blocking(move || {
        let target = reveal_target(&path)?;
        tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
    })
    .await
}

/// Decode a media file in-process (symphonia) — the playback fallback for
/// codecs the system webview can't handle (AAC/MP4 on Linux
/// WebKitGTK, i.e. every retained YouTube audio). Returns the path of a
/// cached on-disk WAV the viewer streams through the asset protocol —
/// returning the bytes over IPC froze the web process on ~240 MB blobs.
#[tauri::command]
pub async fn decode_media_file(app: AppHandle, path: String) -> Result<String, String> {
    super::blocking(move || {
        crate::audio::decode::decode_to_cached_wav(&app, &path).map_err(|e| {
            tracing::warn!("[playback] decode failed for {path:?}: {e}");
            e
        })
    })
    .await
}

/// Write a plain text file (transcript exports) atomically (`write_text_atomic`) to the path
/// the user picked in the save dialog. Plain permissions, not `export_settings_file`'s 0600: a
/// transcript is what the user is deliberately exporting.
/// async + spawn_blocking: a sync command runs on the main thread and this fsyncs into a
/// user-picked sink (USB stick, network share).
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    super::blocking(move || write_text_atomic(&PathBuf::from(path), &contents)).await
}

/// The body of `save_text_file`. The predictable `<path>.tmp` goes through `open_export_tmp`,
/// which removes whatever is planted there (a link itself, never its target) and writes a file
/// it just created.
fn write_text_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write as _;
    let tmp = crate::transport::media::tmp_sibling(path);
    let write = |t: &std::path::Path| -> std::io::Result<()> {
        let mut f = crate::transport::media::open_export_tmp(t)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()
    };
    crate::config::replace_via_tmp(&tmp, path, write).map_err(|e| e.to_string())
}

/// Read a text/subtitle source file for a translate-only run. Size-capped —
/// subtitle files are KBs; anything past the cap is the wrong file.
/// async + spawn_blocking: a sync command runs on the main thread, and the picked file can sit
/// on a slow or stalled mount (network share, sleeping disk).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    const MAX_TEXT_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
    super::blocking(move || -> Result<String, String> {
        let bytes = read_capped(&path, MAX_TEXT_SOURCE_BYTES).map_err(|e| match e {
            CappedRead::TooLarge => "file is larger than 10 MB — not a subtitle/text source".into(),
            CappedRead::NotAFile => "not a file".into(),
            CappedRead::Io(e) => e.to_string(),
        })?;
        Ok(decode_text_source(&bytes))
    })
    .await
}

/// Windows-1252 code points for bytes 0x80–0x9F; the five undefined slots are U+FFFD.
#[rustfmt::skip]
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
    '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

/// Decode a subtitle/text source. Subtitle files in the wild are not all UTF-8: Windows
/// "Unicode" saves are UTF-16 with a BOM, and older files are Windows-1252. Decoded as lossy
/// UTF-8, UTF-16's NUL bytes become extra line breaks (every cue split apart) and every umlaut
/// becomes U+FFFD.
fn decode_text_source(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], from: fn([u8; 2]) -> u16| -> String {
        // An odd trailing byte is dropped by as_chunks.
        let units = rest.as_chunks::<2>().0.iter().map(|&c| from(c));
        char::decode_utf16(units)
            .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, u16::from_be_bytes);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => {
            // Valid multi-byte UTF-8 outnumbers the bad runs: a UTF-8 file with a stray invalid
            // byte, which must not block (or mojibake) the whole file. A plain "any valid
            // multi-byte char" test is not enough: Windows-1252 pairs like "ß…" (DF 85) happen
            // to be valid UTF-8, so one of them would flip a whole German file to U+FFFD umlauts.
            let (mut good, mut bad) = (0usize, 0usize);
            for chunk in bytes.utf8_chunks() {
                good += chunk.valid().chars().filter(|c| !c.is_ascii()).count();
                if !chunk.invalid().is_empty() {
                    bad += 1;
                }
            }
            if good > bad {
                return String::from_utf8_lossy(bytes).into_owned();
            }
            // Mostly undecodable high bytes: a single-byte (Windows-1252) file.
            bytes
                .iter()
                .map(|&b| match b {
                    0x80..=0x9F => CP1252_HIGH[usize::from(b - 0x80)],
                    _ => char::from(b),
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::move_dir_contents;

    #[cfg(unix)]
    #[test]
    fn a_move_that_cannot_remove_its_source_leaves_no_destination_behind() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::config::fresh_test_dir("move-partial");
        let (from, to) = (root.join("from"), root.join("to"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        let src = from.join("clip.wav");
        std::fs::write(&src, b"RIFF").unwrap();
        // A read-only source folder: the rename and the source's removal both fail, the copy
        // succeeds — the "copied but could not remove the original" path.
        std::fs::set_permissions(&from, std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::write(from.join("probe"), b"").is_ok(); // root ignores modes
        let dest = to.join("clip.wav");
        let res = super::move_file(&src, &dest);
        std::fs::set_permissions(&from, std::fs::Permissions::from_mode(0o755)).unwrap();
        if !writable {
            assert!(res.is_err());
            assert!(src.exists(), "the original stays");
            assert!(!dest.exists(), "no partial destination blocks the retry");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_export_never_writes_through_a_planted_tmp_symlink() {
        let dir = crate::config::fresh_test_dir("export-tmp");
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, "keep").unwrap();
        let dest = dir.join("transcript.srt");
        let tmp = crate::transport::media::tmp_sibling(&dest);
        std::os::unix::fs::symlink(&victim, &tmp).unwrap();
        // The planted link is removed, not written through, and the export goes through.
        super::write_text_atomic(&dest, "exported").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "exported");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_layout_gate_holds_waiters_until_it_opens_then_lets_every_one_through() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        static GATE: super::Gate = super::Gate::new();
        static PASSED: AtomicBool = AtomicBool::new(false);
        let waiter = std::thread::spawn(|| {
            GATE.wait();
            PASSED.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !PASSED.load(Ordering::SeqCst),
            "a waiter got through a closed gate"
        );
        GATE.open();
        waiter.join().unwrap();
        assert!(PASSED.load(Ordering::SeqCst));
        GATE.wait(); // open for good: a later wait returns at once
    }

    #[test]
    fn a_timed_layout_wait_gives_up_while_closed_and_passes_once_open() {
        use std::time::Duration;
        static GATE: super::Gate = super::Gate::new();
        assert!(!GATE.wait_timeout(Duration::from_millis(20)));
        let opener = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(30));
            GATE.open();
        });
        assert!(GATE.wait_timeout(Duration::from_secs(10)));
        opener.join().unwrap();
        assert!(GATE.wait_timeout(Duration::ZERO), "open for good");
    }

    #[test]
    fn a_cross_volume_move_copy_keeps_the_source_mtime() {
        let dir = crate::config::fresh_test_dir("copymtime");
        let (src, dest) = (dir.join("dictation-a.wav"), dir.join("moved.wav"));
        std::fs::write(&src, b"RIFF").unwrap();
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        crate::config::set_test_mtime(&src, old);
        super::copy_keeping_mtime(&src, &dest).unwrap();
        let mtime = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert_eq!(mtime, old);
        assert_eq!(std::fs::read(&dest).unwrap(), b"RIFF");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cross_volume_move_copy_stops_on_a_source_that_grew() {
        let mut out = Vec::new();
        let err = crate::transport::copy_at_most(&mut &b"RIFFgrown"[..], &mut out, 4).unwrap_err();
        assert_ne!(
            err.kind(),
            std::io::ErrorKind::InvalidInput,
            "must not be skipped"
        );
        let mut out = Vec::new();
        crate::transport::copy_at_most(&mut &b"RIFF"[..], &mut out, 4).unwrap();
        assert_eq!(out, b"RIFF");
    }

    #[cfg(unix)]
    #[test]
    fn a_cross_volume_move_never_writes_through_a_planted_link() {
        let dir = crate::config::fresh_test_dir("move-link");
        let (src, dest, victim) = (dir.join("a.wav"), dir.join("b.wav"), dir.join("victim"));
        std::fs::write(&src, b"RIFF").unwrap();
        // Dangling: `dest.exists()` says no, so only the open stands between it and the write.
        std::os::unix::fs::symlink(&victim, &dest).unwrap();
        assert!(super::copy_keeping_mtime(&src, &dest).is_err());
        assert!(!victim.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_media_file_refuses_an_over_cap_file_and_reports_a_missing_one() {
        let dir = crate::config::fresh_test_dir("readmedia");
        let big = dir.join("big.webm");
        // Sparse: the size check reads the length, never the bytes.
        std::fs::File::create(&big)
            .unwrap()
            .set_len(192 * 1024 * 1024 + 1)
            .unwrap();
        let small = dir.join("small.webm");
        std::fs::write(&small, b"abc").unwrap();
        let read = |p: &std::path::Path| {
            tauri::async_runtime::block_on(super::read_media_file(p.to_string_lossy().into_owned()))
        };
        assert_eq!(read(&big).err().as_deref(), Some(super::MEDIA_TOO_LARGE));
        assert!(read(&small).is_ok());
        assert!(read(&dir.join("gone.webm")).is_err());
        assert!(read(&dir).is_err());
        assert_eq!(
            super::read_capped(&small.to_string_lossy(), 2)
                .err()
                .map(|e| matches!(e, super::CappedRead::TooLarge)),
            Some(true)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A named pipe is refused at once instead of parking the reader until a writer appears.
    #[cfg(unix)]
    #[test]
    fn read_capped_refuses_a_fifo_without_waiting_for_a_writer() {
        let dir = crate::config::fresh_test_dir("readfifo");
        let fifo = dir.join("subs.srt");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let path = fifo.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let r = super::read_capped(&path, 1024);
            let _ = tx.send(matches!(r, Err(super::CappedRead::NotAFile)));
        });
        let refused = rx.recv_timeout(std::time::Duration::from_secs(5));
        if refused.is_err() {
            // Unblock the parked open so the thread ends, then fail.
            let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
        }
        assert_eq!(refused, Ok(true));
        // A regular file still reads whole.
        let file = dir.join("ok.srt");
        std::fs::write(&file, b"1\n").unwrap();
        assert_eq!(
            super::read_capped(&file.to_string_lossy(), 1024)
                .ok()
                .as_deref(),
            Some(&b"1\n"[..])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A link planted as the heal stamp fails the write instead of emptying its target.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_heal_stamp_never_truncates_through_a_planted_link() {
        let dir = crate::config::fresh_test_dir("healstamp");
        let target = dir.join("precious.txt");
        std::fs::write(&target, b"keep me").unwrap();
        let stamp = dir.join(super::HEAL_STAMP);
        std::os::unix::fs::symlink(&target, &stamp).unwrap();
        assert!(super::write_heal_stamp(&stamp).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
        // A real stamp is created, and rewriting an existing one is fine.
        let fresh = dir.join("fresh").join(super::HEAL_STAMP);
        std::fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        assert!(super::write_heal_stamp(&fresh).is_ok());
        assert!(super::write_heal_stamp(&fresh).is_ok());
        assert!(fresh.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A FIFO planted as the heal stamp fails the write at once instead of parking the caller.
    #[cfg(unix)]
    #[test]
    fn the_heal_stamp_never_waits_on_a_planted_fifo() {
        let dir = crate::config::fresh_test_dir("healstampfifo");
        let stamp = dir.join(super::HEAL_STAMP);
        let c = std::ffi::CString::new(stamp.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let p = stamp.clone();
        std::thread::spawn(move || {
            let _ = tx.send(super::write_heal_stamp(&p).is_err());
        });
        let refused = rx.recv_timeout(std::time::Duration::from_secs(5));
        if refused.is_err() {
            // Unblock the parked open so the thread ends, then fail.
            let _ = std::fs::OpenOptions::new().read(true).open(&stamp);
        }
        assert_eq!(refused, Ok(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reveal_target_takes_only_an_existing_absolute_clean_path() {
        use super::{reveal_target, REVEAL_PATH_MAX};
        let file = std::env::temp_dir().join(format!("fwf-reveal-{}.srt", std::process::id()));
        std::fs::write(&file, b"1").unwrap();
        let ok = file.to_string_lossy().into_owned();
        assert_eq!(reveal_target(&ok).unwrap(), file);
        // Each refusal is asserted by its message: the paths below do not exist either,
        // so a bare is_err() would pass on the final missing-file gate alone.
        assert_eq!(
            reveal_target("talk.srt").unwrap_err(),
            "not an absolute path"
        );
        assert_eq!(reveal_target("").unwrap_err(), "not a usable path");
        let long = format!("/{}", "a".repeat(REVEAL_PATH_MAX));
        assert_eq!(reveal_target(&long).unwrap_err(), "not a usable path");
        assert_eq!(
            reveal_target(&format!("{ok}\n")).unwrap_err(),
            "the path has control characters"
        );
        assert_eq!(
            reveal_target(&format!("{ok}\u{7f}")).unwrap_err(),
            "the path has control characters"
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(reveal_target(&ok).unwrap_err(), "the file is not there");
    }

    #[test]
    fn move_dir_contents_leaves_inflight_tmp_behind() {
        let base = crate::config::fresh_test_dir("move-dir");
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.wav"), b"riff").unwrap();
        std::fs::write(from.join("b.m4a.tmp"), b"partial").unwrap();
        let id = "9f8a7b6c-1d2e-4f30-9a8b-7c6d5e4f3a2b";
        std::fs::write(from.join(format!("{id}.mp3.tmp")), b"partial").unwrap();
        std::fs::write(from.join(format!("{id}.tmp")), b"final").unwrap();

        let mut map = Vec::new();
        move_dir_contents(&from, &to, &mut map).unwrap();

        assert!(to.join("a.wav").is_file(), "regular media moves");
        assert!(
            to.join(format!("{id}.tmp")).is_file(),
            "an older build's finished <id>.tmp copy moves"
        );
        assert!(from.join(format!("{id}.mp3.tmp")).is_file());
        assert!(!to.join(format!("{id}.mp3.tmp")).exists());
        assert!(
            !to.join("b.m4a.tmp").exists(),
            "an in-flight .tmp is never moved"
        );
        assert!(
            from.join("b.m4a.tmp").is_file(),
            "the .tmp stays in the old base for its writer"
        );
        assert_eq!(map.len(), 2);
        assert!(map
            .iter()
            .any(|(old, new)| old.ends_with("a.wav") && new.ends_with("a.wav")));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_a_windows_sharing_violation_counts_as_held_open() {
        let e = std::io::Error::from_raw_os_error(32);
        assert_eq!(super::held_open_elsewhere(&e), cfg!(windows));
        assert!(!super::held_open_elsewhere(&std::io::Error::other("x")));
    }

    // A file a dictation save holds unshared for a moment is moved once the save lets go.
    #[cfg(windows)]
    #[test]
    fn move_dir_contents_waits_out_a_file_held_briefly() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let base = crate::config::fresh_test_dir("move-dir-held-brief");
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.wav"), b"riff").unwrap();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(from.join("b.wav"))
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            drop(held);
        });

        let mut map = Vec::new();
        move_dir_contents(&from, &to, &mut map).unwrap();
        release.join().unwrap();

        assert!(to.join("a.wav").is_file());
        assert!(to.join("b.wav").is_file());
        assert!(!from.join("b.wav").exists());
        assert_eq!(map.len(), 2);
        let _ = std::fs::remove_dir_all(&base);
    }

    // A file held unshared for longer than the retry (a player, a scanner) fails the move loudly
    // instead of being left behind in a base no sweep or delete looks at.
    #[cfg(windows)]
    #[test]
    fn move_dir_contents_fails_on_a_file_held_past_the_retry() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let base = crate::config::fresh_test_dir("move-dir-held-long");
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).unwrap();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(from.join("b.wav"))
            .unwrap();

        let mut map = Vec::new();
        let res = move_dir_contents(&from, &to, &mut map);
        drop(held);

        assert!(res.is_err_and(|e| e.contains("could not move")));
        assert!(from.join("b.wav").is_file());
        assert!(!to.join("b.wav").exists());
        assert!(map.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    // A link planted in the old base stays there (never copied from its target), and a file the
    // same-volume rename moves ends up owner-only, as a cross-volume copy would.
    #[cfg(unix)]
    #[test]
    fn move_dir_contents_leaves_links_behind_and_moves_files_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let base = crate::config::fresh_test_dir("move-dir-links");
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).unwrap();
        let old = from.join("a.wav");
        std::fs::write(&old, b"riff").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
        let secret = base.join("secret");
        std::fs::write(&secret, b"elsewhere").unwrap();
        std::os::unix::fs::symlink(&secret, from.join("b.wav")).unwrap();

        let mut map = Vec::new();
        move_dir_contents(&from, &to, &mut map).unwrap();

        let moved = std::fs::metadata(to.join("a.wav")).unwrap();
        assert_eq!(moved.permissions().mode() & 0o777, 0o600);
        assert!(!to.join("b.wav").exists(), "a link is never moved");
        assert!(std::fs::symlink_metadata(from.join("b.wav")).is_ok());
        assert_eq!(map.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn text_source_decodes_utf16_cp1252_and_keeps_stray_byte_utf8() {
        use super::decode_text_source;
        let srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nMädchen\r\n";

        let mut le = vec![0xFF, 0xFE];
        le.extend(srt.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_text_source(&le), srt, "UTF-16LE keeps plain CRLF");

        let mut be = vec![0xFE, 0xFF];
        be.extend("Grüße\n".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(decode_text_source(&be), "Grüße\n");

        assert_eq!(decode_text_source(b"M\xe4dchen \x80"), "Mädchen €");

        let mut stray = "äöü ".as_bytes().to_vec();
        stray.push(0xFF);
        assert_eq!(decode_text_source(&stray), "äöü \u{FFFD}");
        // A 1:1 tie goes to Windows-1252: "weiß…" + one umlaut is one valid pair and one bad byte.
        assert_eq!(
            decode_text_source(b"Ich wei\xdf\x85 nicht, M\xe4dchen"),
            "Ich weiß… nicht, Mädchen"
        );

        // "ß…" in Windows-1252 (DF 85) is also a valid UTF-8 pair; it must not outvote the rest.
        assert_eq!(
            decode_text_source(b"Ich wei\xdf\x85 nicht, M\xe4dchen \xfcber \xf6l"),
            "Ich weiß… nicht, Mädchen über öl"
        );

        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("ä".as_bytes());
        assert_eq!(decode_text_source(&bom), "ä", "UTF-8 BOM is stripped");
    }
}
