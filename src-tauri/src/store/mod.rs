//! Local, per-device data files that are not settings: the transcription history and the
//! bookkeeping documents the TS side owns (jobs ledger, usage-outcome queue, sync state).
//! None of them ride along in config.json, so sync never ships them around.

pub mod jobs_ledger;
pub mod sync_state;
pub mod transcripts;
pub mod usage_queue;
