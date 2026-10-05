//! Tauri commands exposed to the web UI, one file per domain. Each file's commands are
//! re-exported here (`pub use x::*`), so the handler list in lib.rs names every command as
//! `commands::x`. The helpers below are the ones several domains share.

mod config;
mod files;
mod inject;
mod jobs;
mod log;
mod mic;
mod server;
mod session;
mod shortcuts;
mod sync;
mod transcribe;

pub use self::config::*;
pub use self::files::*;
pub use self::inject::*;
pub use self::jobs::*;
pub use self::log::*;
pub use self::mic::*;
pub use self::server::*;
pub use self::session::*;
pub use self::shortcuts::*;
pub use self::sync::*;
pub use self::transcribe::*;

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Names of the per-type subfolders inside the audio base folder.
pub(crate) const AUDIO_SUBDIRS: [&str; 4] = ["dictations", "files", "links", "video"];

/// The one base folder for ALL stored audio (dictations/, files/, links/
/// inside it). A non-empty `custom` (audioBaseDir, with the legacy
/// recordingsDir as fallback — the caller passes the effective preference)
/// wins; otherwise the default lives under the app data dir. None only if
/// neither can be resolved.
pub(crate) fn resolve_audio_base(app: &AppHandle, custom: Option<String>) -> Option<PathBuf> {
    if let Some(c) = custom {
        let c = c.trim();
        if !c.is_empty() {
            return Some(PathBuf::from(c));
        }
    }
    app.path().app_data_dir().ok().map(|d| d.join("audio"))
}

/// The effective base-folder preference from settings: the new key, else the
/// legacy custom recordings folder (so an existing setup keeps its location).
pub(crate) fn audio_base_pref(settings: &crate::config::AppSettings) -> Option<String> {
    let pick = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    pick(&settings.recording.audio_base_dir).or_else(|| pick(&settings.recording.recordings_dir))
}

/// Folder where saved dictation `.wav` files go: `<base>/dictations`.
/// `custom` is the BASE-folder preference (see `resolve_audio_base`).
pub(crate) fn resolve_recordings_dir(app: &AppHandle, custom: Option<String>) -> Option<PathBuf> {
    resolve_audio_base(app, custom).map(|b| b.join(AUDIO_SUBDIRS[0]))
}

/// Does one of OUR real windows hold keyboard focus? The click-through "overlay" chip never
/// does, so it is excluded. Every sink guard in inject/text.rs asks this before typing or pasting —
/// keys sent while our own window is focused fire buttons/shortcuts in the app itself.
pub(crate) fn own_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .iter()
        .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
}

/// Resolve an API key: an explicit (just-typed) key wins; otherwise look it up in
/// the OS keyring by Backend id.
fn resolve_key(explicit: Option<String>, backend_id: Option<String>) -> Option<String> {
    if let Some(k) = explicit {
        if !k.is_empty() {
            return Some(k);
        }
    }
    let key = backend_id.as_deref().and_then(crate::config::keys::get);
    if key.is_none() {
        // A keyless backend is the factory-normal case (newBackendDraft seeds
        // hasApiKey:false) and this runs on the 30 s usage poll for every backend,
        // so WARN here floods the capture ring forever. DEBUG keeps the "we went
        // out without an Authorization header" breadcrumb for an opaque-403 chase.
        tracing::debug!(
            "[keys] no API key resolved (backend_id={backend_id:?}) — connecting unauthenticated"
        );
    }
    key
}

/// `resolve_key` on the blocking pool. A keyring read can BLOCK indefinitely (a locked KWallet /
/// Secret Service parks the request behind a password prompt), and a hard failure is not memoized,
/// so a recurring caller — the 30 s usage poll, per backend — otherwise parks a tokio runtime
/// worker per call and can starve the runtime an in-flight transcription's polling shares.
async fn resolve_key_async(explicit: Option<String>, backend_id: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || resolve_key(explicit, backend_id))
        .await
        .ok()
        .flatten()
}

/// Run a blocking clipboard / PRIMARY-selection read OFF the UI thread, bounded to 400ms. arboard's
/// get_text (and the PRIMARY read) are blocking Wayland round-trips that can hang indefinitely on a
/// dead/slow owner — e.g. right after the previous clipboard owner exited — so every such read goes
/// through here: one place owns the off-thread + 400ms-cap contract. Returns None on timeout, join
/// error, or an empty read; callers log / handle None per-site.
///
/// Single-flight (CLIP_READ_BUSY): a read that outlives its 400ms cap keeps its blocking thread,
/// so on a wedged owner every per-phrase call used to strand one more thread. While a read is still
/// running, a new one returns None straight away; the flag clears only when the blocking read
/// itself returns, not when the caller's timeout fires.
///
/// The flag lives in `inject` so the clipboard WRITERS can see it too: on Windows the stuck read
/// still holds the clipboard, and every write path now waits it out (`wait_clip_read_idle`)
/// instead of racing it.
pub(crate) async fn read_selection_bounded(
    read: impl FnOnce() -> Option<String> + Send + 'static,
) -> Option<String> {
    use crate::inject::CLIP_READ_BUSY;
    use std::sync::atomic::Ordering;
    if CLIP_READ_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        tracing::debug!(
            "[clipboard] a previous selection read is still running; skipping this one"
        );
        return None;
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            CLIP_READ_BUSY.store(false, Ordering::Release);
        }
    }
    let release = Release;
    let task = tokio::task::spawn_blocking(move || {
        // Moved in, so it drops (and frees the flag) when the read returns, or if it panics.
        let _release = release;
        read()
    });
    match tokio::time::timeout(std::time::Duration::from_millis(400), task).await {
        Ok(Ok(v)) => v,
        _ => None,
    }
}
