//! The usage-outcome queue: `<app_data_dir>/usage-outcomes.json`.
//!
//! Dictation outcomes (`POST /v1/usage/outcome`) that could not be delivered yet — the
//! server was down when the session ended, or the app quit before the flush — wait here
//! across restarts. Rust treats the document as opaque JSON; the retry/backoff logic and
//! the shape live in TS (`lib/usageOutcome.ts`). Kept out of config.json (which sync ships
//! around) and out of the config dir on purpose: it is per-device bookkeeping, not settings.

use std::path::{Path, PathBuf};

/// Hard cap on the file, both ways. Sized to hold a full TS-side queue
/// (MAX_ITEMS = 200 entries at ~400 bytes each with a typical server URL ≈ 80 KB)
/// plus margin, so a legitimately full queue never trips the cap and loses
/// unposted outcomes. Anything past this is not a queue but a runaway, and the
/// reader does not parse it.
pub const MAX_QUEUE_BYTES: usize = 256 * 1024;

fn queue_path(dir: &Path) -> PathBuf {
    dir.join("usage-outcomes.json")
}

/// Load the queue: `Ok(None)` when absent / oversized / unparseable / not an object. A
/// corrupt file means the unposted outcomes are lost; the server marks those sessions
/// "unreported" after 24 h, so no .bak dance here.
///
/// A file that exists but can't be READ (a Windows AV/indexer lock outlasting the retries of
/// `config::read_config_text`, an EIO) is an `Err`, never `None`: the same file reads fine a
/// moment later, but the webview would take "no queue" as an empty one and its next save
/// would replace the backlog of unposted outcomes for good.
pub fn load(dir: &Path) -> std::io::Result<Option<serde_json::Value>> {
    let path = queue_path(dir);
    if let Ok(meta) = std::fs::metadata(&path) {
        let len = meta.len();
        if len > MAX_QUEUE_BYTES as u64 {
            tracing::warn!("[usage] outcome queue file is {len} bytes — ignoring it");
            return Ok(None);
        }
    }
    Ok(crate::config::read_config_text(&path)?
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|v| v.is_object()))
}

/// Persist atomically (tmp + rename, owner-only) via `config::write_private_atomic`.
/// Refuses (Err) a document over the cap rather than truncating it.
pub fn save(dir: &Path, queue: &serde_json::Value) -> anyhow::Result<()> {
    let text = serde_json::to_string(queue)?;
    if text.len() > MAX_QUEUE_BYTES {
        anyhow::bail!("usage outcome queue exceeds {MAX_QUEUE_BYTES} bytes");
    }
    std::fs::create_dir_all(dir)?;
    let path = queue_path(dir);
    crate::config::write_private_atomic(&path, &text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses_bad_shapes() {
        let dir = crate::config::fresh_test_dir("usage-queue");
        assert!(load(&dir).unwrap().is_none());
        let doc = serde_json::json!({"version": 1, "items": []});
        save(&dir, &doc).unwrap();
        assert_eq!(load(&dir).unwrap(), Some(doc));
        // Not an object → refused on read.
        std::fs::write(dir.join("usage-outcomes.json"), "[1,2]").unwrap();
        assert!(load(&dir).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_queue_is_an_error_not_an_empty_queue() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::config::fresh_test_dir("usage-queue-unreadable");
        let path = dir.join("usage-outcomes.json");
        let original = r#"{"version":1,"items":[{"backendId":"b"}]}"#;
        std::fs::write(&path, original).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads a 0o000 file anyway: nothing unreadable to test there.
        if std::fs::read_to_string(&path).is_err() {
            assert!(load(&dir).is_err());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
