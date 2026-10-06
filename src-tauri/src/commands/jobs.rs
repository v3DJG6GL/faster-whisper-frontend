//! The server job resource (`/v1/jobs*`) and the on-disk in-flight jobs ledger that
//! lets a run re-attach after a restart.

use super::resolve_key_async;
use crate::transport;
use tauri::{AppHandle, Manager};

/// `GET /v1/jobs/{id}` — the job row, with the live progress while in flight.
#[tauri::command]
pub async fn get_job(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    job_id: String,
) -> transport::jobs::JobOutcome<transport::jobs::JobStatus> {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::jobs::get_job(&server_url, key.as_deref(), &job_id).await
}

/// `GET /v1/jobs/{id}/result` — the stored payload as a BatchResult, through
/// the POST's own conversion.
#[tauri::command]
pub async fn get_job_result(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    job_id: String,
) -> transport::jobs::JobOutcome<transport::batch::BatchResult> {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::jobs::get_job_result(&server_url, key.as_deref(), &job_id).await
}

/// `DELETE /v1/jobs/{id}` — cancel a running job or delete a finished one.
#[tauri::command]
pub async fn delete_job(
    server_url: String,
    backend_id: Option<String>,
    api_key: Option<String>,
    job_id: String,
) -> transport::jobs::JobOutcome<()> {
    let key = resolve_key_async(api_key, backend_id).await;
    transport::jobs::delete_job(&server_url, key.as_deref(), &job_id).await
}

/// The on-disk in-flight jobs ledger (`<app_data_dir>/jobs-ledger.json`): which server
/// job ids the app posted and has not ingested yet, so a run survives the app being quit
/// mid-flight. Opaque JSON to Rust; the row shape lives in TS (`lib/jobsLedger.ts`).
#[tauri::command]
pub fn load_jobs_ledger(app: AppHandle) -> Option<serde_json::Value> {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| crate::store::jobs_ledger::load(&d))
}

#[tauri::command]
pub fn save_jobs_ledger(app: AppHandle, ledger: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::store::jobs_ledger::save(&dir, &ledger).map_err(|e| e.to_string())
}
