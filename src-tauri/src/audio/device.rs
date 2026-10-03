//! Input-device enumeration.

use super::AudioDevice;
use cpal::traits::{DeviceTrait, HostTrait};

/// The device's human-readable name, or None when the backend can't report one.
///
/// Persisted microphone pins in settings.json are stored by this name (cpal 0.18 dropped
/// `DeviceTrait::name`; this is what it returned).
pub fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// List available microphone input devices (identified by name).
pub fn list_input_devices() -> Vec<AudioDevice> {
    let host = super::host::app_host();
    let default_name = host.default_input_device().and_then(|d| device_name(&d));

    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if let Some(name) = device_name(&d) {
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
