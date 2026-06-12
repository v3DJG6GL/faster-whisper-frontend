//! Input-device enumeration.

use super::AudioDevice;
use cpal::traits::{DeviceTrait, HostTrait};

/// List available microphone input devices (identified by name).
pub fn list_input_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if let Ok(name) = d.name() {
                let is_default = Some(&name) == default_name.as_ref();
                out.push(AudioDevice {
                    id: name.clone(),
                    label: name,
                    is_default,
                });
            }
        }
    }
    out
}
