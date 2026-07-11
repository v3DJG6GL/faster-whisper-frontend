//! Local sync bookkeeping: `<app_config_dir>/sync-state.json`.
//!
//! Holds what the TS sync engine needs to remember BETWEEN runs but must never
//! sync or export: this device's identity (`deviceId`/`deviceLabel`), the last
//! server `version`/`hash` we hold, and the last-synced blob `snapshot` (the
//! 3-way merge base). Rust treats the whole document as opaque JSON — all merge
//! logic lives in TS — except for the `deviceId` key, which [`device_info`]
//! seeds on first use so every later save preserves it.
//!
//! Kept OUT of config.json on purpose: the snapshot duplicates the whole config
//! (would double every 400ms auto-save write) and the config itself is what
//! sync ships around — its own bookkeeping can't ride inside it.

use std::path::{Path, PathBuf};

fn sync_state_path(dir: &Path) -> PathBuf {
    dir.join("sync-state.json")
}

/// Load the sync state, or `None` when absent/unparseable. An unparseable file
/// is treated as "no state": the engine then re-pulls and rebuilds the snapshot
/// — safe (worst case one spurious conflict prompt), so no .bak dance here.
pub fn load(dir: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(sync_state_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Persist atomically (tmp + rename), mirroring `config::save`.
pub fn save(dir: &Path, state: &serde_json::Value) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = sync_state_path(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(state)?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// This machine's sync identity, shown in "last synced from …" lines.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device_id: String,
    pub hostname: String,
    pub platform: String,
}

/// Best-effort hostname: env vars first (COMPUTERNAME is always set on
/// Windows; HOSTNAME only in some shells), then /etc/hostname (Linux).
/// Falls back to a generic label — it's display metadata, not identity.
fn hostname() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string("/etc/hostname") {
        let text = text.trim().to_string();
        if !text.is_empty() {
            return text;
        }
    }
    "this device".into()
}

/// Return (creating + persisting on first call) this machine's device id, plus
/// hostname + platform. The id lives in sync-state.json so it survives restarts
/// but is wiped with the rest of the local state if the user resets the app dir.
pub fn device_info(dir: &Path) -> DeviceInfo {
    let mut state = load(dir).unwrap_or_else(|| serde_json::json!({}));
    let existing = state
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let device_id = match existing {
        Some(id) if !id.is_empty() => id,
        _ => {
            let id = uuid::Uuid::new_v4().to_string();
            if let Some(obj) = state.as_object_mut() {
                obj.insert("deviceId".into(), serde_json::json!(id));
                let _ = save(dir, &state);
            }
            id
        }
    };
    DeviceInfo {
        device_id,
        hostname: hostname(),
        platform: if cfg!(target_os = "windows") {
            "windows".into()
        } else if cfg!(target_os = "macos") {
            "macos".into()
        } else {
            "linux".into()
        },
    }
}
