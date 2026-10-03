//! Which cpal host the app records and plays through.
//!
//! One place decides it, so capture, the mic test and the sound cues never disagree about the
//! backend. Windows / macOS: cpal's default (WASAPI / CoreAudio). Linux: the PulseAudio-protocol
//! host whenever a sound server answers (pipewire-pulse on current desktops), so the app records
//! as an ordinary client of the server — shared with every other app, following the user's sound
//! settings. Raw ALSA only when no server runs, or for a raw ALSA path the user picked on purpose.

use cpal::traits::{DeviceTrait, HostTrait};
#[cfg(target_os = "linux")]
use cpal::HostId;
use cpal::{Device, DeviceId};

/// Default input device of the app's host.
pub fn default_input() -> Option<Device> {
    with_host(|h| h.default_input_device())
}

/// Default output device of the app's host.
pub fn default_output() -> Option<Device> {
    with_host(|h| h.default_output_device())
}

/// The input device with this id, if it exists right now.
pub fn input_by_id(id: &DeviceId) -> Option<Device> {
    #[cfg(target_os = "linux")]
    if id.host() == HostId::Alsa {
        return alsa_host()?.device_by_id(id);
    }
    with_host(|h| {
        if h.id() != id.host() {
            return None;
        }
        h.device_by_id(id).filter(|d| d.supports_input())
    })
}

/// Every input device of the host the inventory lists directly: WASAPI / CoreAudio, or on Linux
/// raw ALSA (the server's sources come from `pulse::snapshot` instead).
pub fn native_inputs() -> Vec<Device> {
    #[cfg(target_os = "linux")]
    let host = alsa_host();
    #[cfg(not(target_os = "linux"))]
    let host = Some(cpal::default_host());
    host.and_then(|h| h.input_devices().ok())
        .map(|it| it.collect())
        .unwrap_or_default()
}

/// The device's human-readable name, or None when the backend can't report one.
pub fn device_label(device: &Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// Is the app recording through the sound server (Linux PulseAudio-protocol host)?
#[cfg(target_os = "linux")]
pub fn on_sound_server() -> bool {
    with_pulse(|_| Some(())).is_some()
}

fn with_host<R>(f: impl Fn(&cpal::Host) -> Option<R>) -> Option<R> {
    #[cfg(target_os = "linux")]
    {
        if super::pulse::server_present() {
            if let Some(r) = with_pulse(&f) {
                return Some(r);
            }
        }
        f(&alsa_host()?)
    }
    #[cfg(not(target_os = "linux"))]
    {
        f(&cpal::default_host())
    }
}

#[cfg(target_os = "linux")]
fn alsa_host() -> Option<cpal::Host> {
    cpal::host_from_id(HostId::Alsa).ok()
}

/// Run `f` on the process-wide PulseAudio host. Like `pulse::CLIENT`, ONE host lives for the
/// process: its client's reactor thread never exits on drop, only when the server hangs up. A
/// None from `f` on a host whose connection died (a restarted server) rebuilds it once.
#[cfg(target_os = "linux")]
fn with_pulse<R>(f: impl Fn(&cpal::Host) -> Option<R>) -> Option<R> {
    use std::sync::Mutex;
    static HOST: Mutex<Option<cpal::Host>> = Mutex::new(None);

    let mut slot = HOST.lock().ok()?;
    for _ in 0..2 {
        if slot.is_none() {
            if !cpal::available_hosts().contains(&HostId::PulseAudio) {
                return None;
            }
            match cpal::host_from_id(HostId::PulseAudio) {
                Ok(h) => *slot = Some(h),
                Err(e) => {
                    tracing::debug!("[audio] PulseAudio host unavailable: {e}");
                    return None;
                }
            }
        }
        let host = slot.as_ref()?;
        if let Some(r) = f(host) {
            return Some(r);
        }
        // A plain "no such device" keeps the host; a dead connection fails every query.
        if host.devices().is_ok() {
            return None;
        }
        tracing::info!("[audio] sound server connection lost; reconnecting");
        *slot = None;
    }
    None
}
