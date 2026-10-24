//! The in-flight jobs ledger: `<app_data_dir>/jobs-ledger.json`.
//!
//! One row per batch run the app has posted to a server that keeps a job resource
//! (`GET /v1/jobs*`), written BEFORE the request leaves and removed once the result was
//! ingested — so a run survives the app being quit mid-flight: on the next launch the
//! ledger says which job ids to ask the server about. Rust treats the document as opaque
//! JSON; the row shape, caps and the reconcile logic live in TS (`lib/jobsLedger.ts`,
//! `lib/jobsReconcile.ts`). Per-device bookkeeping like the usage-outcome queue, so it
//! stays out of config.json (which sync ships around).

use std::path::{Path, PathBuf};

/// Hard cap on the file, both ways. A row carries the run's resolved options and
/// context — usually ~2 KB, but the options carry user text verbatim (e.g. the
/// translation glossary), so a row can be much larger. The TS side keeps at most 20
/// rows AND trims the oldest rows to this byte budget (`MAX_LEDGER_BYTES` in
/// `lib/jobsLedger.ts` mirrors it), because a save over the cap is refused whole.
pub const MAX_LEDGER_BYTES: usize = 256 * 1024;

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join("jobs-ledger.json")
}

/// Load the ledger: `Ok(None)` when absent / oversized / unparseable / not an object. A
/// corrupt file means the app forgets its in-flight runs; the server still holds them for
/// its TTL, so nothing is destroyed — only the automatic re-attach is lost.
///
/// A file that exists but can't be READ (a Windows AV/indexer lock outlasting the retries of
/// `config::read_config_text`, an EIO) is an `Err`, never `None`: the same file reads fine a
/// moment later, but the webview would take "no ledger" as an empty one and its next save
/// would replace an earlier launch's rows for good.
pub fn load(dir: &Path) -> std::io::Result<Option<serde_json::Value>> {
    let path = ledger_path(dir);
    if let Ok(meta) = std::fs::metadata(&path) {
        let len = meta.len();
        if len > MAX_LEDGER_BYTES as u64 {
            tracing::warn!("[jobs] ledger file is {len} bytes — ignoring it");
            return Ok(None);
        }
    }
    Ok(crate::config::read_config_text(&path)?
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|v| v.is_object()))
}

/// Atomic, owner-only write. Refuses (Err) a document over the cap rather than truncating it.
pub fn save(dir: &Path, ledger: &serde_json::Value) -> anyhow::Result<()> {
    let text = serde_json::to_string(ledger)?;
    if text.len() > MAX_LEDGER_BYTES {
        anyhow::bail!("jobs ledger exceeds {MAX_LEDGER_BYTES} bytes");
    }
    std::fs::create_dir_all(dir)?;
    let path = ledger_path(dir);
    crate::config::write_private_atomic(&path, &text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{load, save, MAX_LEDGER_BYTES};

    #[test]
    fn round_trips_an_object_and_rejects_the_rest() {
        let dir = std::env::temp_dir().join(format!("fwf-jobs-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).unwrap().is_none());
        let doc = serde_json::json!({"v": 1, "rows": [{"jobId": "ab"}]});
        save(&dir, &doc).unwrap();
        assert_eq!(load(&dir).unwrap(), Some(doc));
        // Not an object → refused on read.
        std::fs::write(dir.join("jobs-ledger.json"), "[1,2]").unwrap();
        assert!(load(&dir).unwrap().is_none());
        let big = serde_json::json!({"x": "y".repeat(MAX_LEDGER_BYTES)});
        assert!(save(&dir, &big).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_ledger_is_an_error_not_an_empty_ledger() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("fwf-jobs-ledger-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("jobs-ledger.json");
        let original = r#"{"v":1,"rows":[{"jobId":"ab"}]}"#;
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
