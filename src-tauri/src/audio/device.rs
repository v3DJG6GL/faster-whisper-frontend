//! Input-device enumeration.

use super::AudioDevice;
use cpal::traits::{DeviceTrait, HostTrait};

/// The device's human-readable name, or None when the backend can't report one.
///
/// cpal 0.17 deprecated `DeviceTrait::name` in favour of the structured `description()` (and of
/// `id()` as the stable identifier). We keep using the NAME as our device id on purpose: persisted
/// microphone pins in settings.json are stored by name, and every pin would silently fall back to
/// the default input the day we switched to `id()`. This helper is exactly the deprecated method's
/// own body, so behaviour is unchanged.
pub fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// List available microphone input devices (identified by name).
pub fn list_input_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
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
