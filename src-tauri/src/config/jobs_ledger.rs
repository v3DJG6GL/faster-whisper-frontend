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
/// context (~2 KB); the TS side keeps at most 20 rows, so 256 KiB is many times a
/// legitimately full ledger. Anything past this is a runaway, not a ledger.
pub const MAX_LEDGER_BYTES: usize = 256 * 1024;

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join("jobs-ledger.json")
}

/// Load the ledger, or `None` when absent / oversized / unparseable / not an object.
/// An unreadable file means the app forgets its in-flight runs; the server still holds
/// them for its TTL, so nothing is destroyed — only the automatic re-attach is lost.
pub fn load(dir: &Path) -> Option<serde_json::Value> {
    let path = ledger_path(dir);
    let len = std::fs::metadata(&path).ok()?.len();
    if len > MAX_LEDGER_BYTES as u64 {
        tracing::warn!("[jobs] ledger file is {len} bytes — ignoring it");
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok().filter(|v| v.is_object())
}

/// Persist atomically (tmp + rename, owner-only), mirroring `config::usage_queue::save`.
/// Refuses (Err) a document over the cap rather than truncating it.
pub fn save(dir: &Path, ledger: &serde_json::Value) -> anyhow::Result<()> {
    let text = serde_json::to_string(ledger)?;
    if text.len() > MAX_LEDGER_BYTES {
        anyhow::bail!("jobs ledger exceeds {MAX_LEDGER_BYTES} bytes");
    }
    std::fs::create_dir_all(dir)?;
    let path = ledger_path(dir);
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

#[cfg(test)]
mod tests {
    use super::{load, save, MAX_LEDGER_BYTES};

    #[test]
    fn round_trips_an_object_and_rejects_the_rest() {
        let dir = std::env::temp_dir().join(format!("fwf-jobs-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).is_none());
        let doc = serde_json::json!({"v": 1, "rows": [{"jobId": "ab"}]});
        save(&dir, &doc).unwrap();
        assert_eq!(load(&dir), Some(doc));
        // Not an object → refused on read.
        std::fs::write(dir.join("jobs-ledger.json"), "[1,2]").unwrap();
        assert!(load(&dir).is_none());
        // Oversized → refused on write.
        let big = serde_json::json!({"x": "y".repeat(MAX_LEDGER_BYTES)});
        assert!(save(&dir, &big).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
