//! The usage-outcome queue: `<app_data_dir>/usage-outcomes.json`.
//!
//! Dictation outcomes (`POST /v1/usage/outcome`) that could not be delivered yet — the
//! server was down when the session ended, or the app quit before the flush — wait here
//! across restarts. Rust treats the document as opaque JSON; the retry/backoff logic and
//! the shape live in TS (`lib/usageOutcome.ts`). Kept out of config.json (which sync ships
//! around) and out of the config dir on purpose: it is per-device bookkeeping, not settings.

use std::path::{Path, PathBuf};

/// Hard cap on the file, both ways. A queue is a few hundred bytes per unposted session;
/// anything past this is not a queue but a runaway, and the reader must not parse it on
/// the main thread.
pub const MAX_QUEUE_BYTES: usize = 64 * 1024;

fn queue_path(dir: &Path) -> PathBuf {
    dir.join("usage-outcomes.json")
}

/// Load the queue, or `None` when absent / oversized / unparseable / not an object. An
/// unreadable file means the unposted outcomes are lost; the server marks those sessions
/// "unreported" after 24 h, so no .bak dance here.
pub fn load(dir: &Path) -> Option<serde_json::Value> {
    let path = queue_path(dir);
    let len = std::fs::metadata(&path).ok()?.len();
    if len > MAX_QUEUE_BYTES as u64 {
        tracing::warn!("[usage] outcome queue file is {len} bytes — ignoring it");
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok().filter(|v| v.is_object())
}

/// Persist atomically (tmp + rename, owner-only), mirroring `config::sync_state::save`.
/// Refuses (Err) a document over the cap rather than truncating it.
pub fn save(dir: &Path, queue: &serde_json::Value) -> anyhow::Result<()> {
    let text = serde_json::to_string(queue)?;
    if text.len() > MAX_QUEUE_BYTES {
        anyhow::bail!("usage outcome queue exceeds {MAX_QUEUE_BYTES} bytes");
    }
    std::fs::create_dir_all(dir)?;
    let path = queue_path(dir);
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = super::write_private(&tmp, &text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}
