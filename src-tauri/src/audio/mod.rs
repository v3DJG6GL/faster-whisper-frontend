//! Microphone capture: device enumeration + a capture engine that emits live
//! RMS levels (`audio://level`). Resampling to 16 kHz / s16le for streaming
//! lands in M3, where it is actually consumed.

use serde::Serialize;
use std::sync::Mutex;

pub mod capture;
pub mod device;
pub mod resample;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// Holds the active capture stream (None when idle). Dropping the handle stops
/// and joins the capture thread.
#[derive(Default)]
pub struct AudioState(pub Mutex<Option<capture::CaptureHandle>>);
