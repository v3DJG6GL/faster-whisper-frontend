//! The microphones as the sound server sees them (pipewire-pulse or PulseAudio), read over the
//! PulseAudio protocol with the same pure-Rust client cpal's PulseAudio host uses.
//!
//! cpal's own device description for a pulse source carries only its display name. The picker
//! also needs the source's properties: whether it is a monitor of an output (hidden — not a
//! microphone), whether it is a Bluetooth headset (the chip), and which ALSA card backs it (to
//! group the card's raw ALSA paths under it, and to migrate pins saved by card name).
//!
//! The client's reactor thread only exits when the server hangs up, never when the client is
//! dropped, so ONE client is kept for the life of the process and rebuilt only after it failed.
//! Every call runs on a helper thread with a timeout: a wedged server costs a 2 s wait, never a
//! hung caller.

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PulseSource {
    /// The source name (= PipeWire `node.name`); stable across reboots and replugging.
    pub name: String,
    pub label: String,
    pub bluetooth: bool,
    pub monitor: bool,
    /// ALSA card id (`alsa.id`, the `CARD=` value in ALSA PCM names), when ALSA backs it.
    pub alsa_card_id: Option<String>,
    pub card_name: Option<String>,
    pub alsa_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    /// "PipeWire" or "PulseAudio" — what the picker calls the server path.
    pub flavour: &'static str,
    pub default_source: Option<String>,
    /// In server order, monitors included (callers filter).
    pub sources: Vec<PulseSource>,
}

impl Snapshot {
    pub fn microphones(&self) -> impl Iterator<Item = &PulseSource> {
        self.sources.iter().filter(|s| !s.monitor)
    }
}

static CLIENT: Mutex<Option<Arc<pulseaudio::Client>>> = Mutex::new(None);

/// Is a PulseAudio-protocol server socket there at all? Cheap; no connection.
pub fn server_present() -> bool {
    pulseaudio::socket_path_from_env().is_some_and(|p| p.exists())
}

/// The server's current view, or None when no server answers.
pub fn snapshot() -> Option<Snapshot> {
    if !server_present() {
        return None;
    }
    for _ in 0..2 {
        let client = client()?;
        if let Some(s) = query(client) {
            return Some(s);
        }
        // Failed or timed out: rebuild the client once (a restarted server leaves the old one
        // disconnected; its reactor thread has already exited).
        if let Ok(mut c) = CLIENT.lock() {
            *c = None;
        }
    }
    None
}

fn client() -> Option<Arc<pulseaudio::Client>> {
    let mut slot = CLIENT.lock().ok()?;
    if let Some(c) = slot.as_ref() {
        return Some(c.clone());
    }
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("pulse-connect".into())
        .spawn(move || {
            let _ = tx.send(pulseaudio::Client::from_env(c"faster-whisper-frontend"));
        })
        .ok()?;
    match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(c)) => {
            let c = Arc::new(c);
            *slot = Some(c.clone());
            Some(c)
        }
        Ok(Err(e)) => {
            tracing::debug!("[audio] sound server connect failed: {e}");
            None
        }
        Err(_) => {
            tracing::warn!("[audio] sound server did not answer within {TIMEOUT:?}");
            None
        }
    }
}

fn query(client: Arc<pulseaudio::Client>) -> Option<Snapshot> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("pulse-query".into())
        .spawn(move || {
            let res = futures_executor::block_on(async {
                let info = client.server_info().await?;
                let sources = client.list_sources().await?;
                Ok::<_, pulseaudio::ClientError>((info, sources))
            });
            let _ = tx.send(res);
        })
        .ok()?;
    let (info, sources) = match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::debug!("[audio] sound server query failed: {e}");
            return None;
        }
        Err(_) => {
            tracing::warn!("[audio] sound server query timed out after {TIMEOUT:?}");
            return None;
        }
    };
    let server_name = info
        .server_name
        .as_ref()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(Snapshot {
        flavour: flavour(&server_name),
        default_source: info
            .default_source_name
            .as_ref()
            .map(|s| s.to_string_lossy().into_owned()),
        sources: sources
            .iter()
            .map(|s| {
                let props: HashMap<String, String> = s
                    .props
                    .iter()
                    .map(|(k, v)| (k.to_string_lossy().into_owned(), prop_text(v)))
                    .collect();
                source_from(
                    &s.name.to_string_lossy(),
                    s.description
                        .as_ref()
                        .map(|d| d.to_string_lossy())
                        .as_deref(),
                    s.monitor_of_sink_index.is_some(),
                    &props,
                )
            })
            .collect(),
    })
}

/// Property values arrive as C strings with their terminating NUL.
fn prop_text(v: &[u8]) -> String {
    let v = v.strip_suffix(&[0]).unwrap_or(v);
    String::from_utf8_lossy(v).into_owned()
}

fn flavour(server_name: &str) -> &'static str {
    if server_name.contains("PipeWire") {
        "PipeWire"
    } else {
        "PulseAudio"
    }
}

fn source_from(
    name: &str,
    description: Option<&str>,
    is_monitor_of_sink: bool,
    props: &HashMap<String, String>,
) -> PulseSource {
    let prop = |k: &str| props.get(k).filter(|v| !v.is_empty()).cloned();
    let bluetooth = prop("device.bus").as_deref() == Some("bluetooth")
        || prop("device.api").as_deref() == Some("bluez5")
        || name.starts_with("bluez_");
    let monitor = is_monitor_of_sink || prop("device.class").as_deref() == Some("monitor");
    PulseSource {
        name: name.to_string(),
        label: description
            .filter(|d| !d.trim().is_empty())
            .unwrap_or(name)
            .to_string(),
        bluetooth,
        monitor,
        alsa_card_id: prop("alsa.id"),
        card_name: prop("alsa.card_name").or_else(|| prop("api.alsa.card.name")),
        alsa_name: prop("alsa.name"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(kv: &[(&str, &str)]) -> HashMap<String, String> {
        kv.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn usb_mic_keeps_its_card_for_grouping_and_migration() {
        let s = source_from(
            "alsa_input.usb-R__DE_R__DE_PodMic_USB_6F0EDA88-00.mono-fallback",
            Some("RØDE PodMic USB Mono"),
            false,
            &props(&[
                ("device.bus", "usb"),
                ("device.api", "alsa"),
                ("device.class", "sound"),
                ("alsa.id", "USB"),
                ("alsa.card_name", "RØDE PodMic USB"),
                ("alsa.name", "USB Audio"),
            ]),
        );
        assert_eq!(s.label, "RØDE PodMic USB Mono");
        assert!(!s.bluetooth && !s.monitor);
        assert_eq!(s.alsa_card_id.as_deref(), Some("USB"));
        assert_eq!(s.card_name.as_deref(), Some("RØDE PodMic USB"));
        assert_eq!(s.alsa_name.as_deref(), Some("USB Audio"));
    }

    #[test]
    fn bluetooth_is_recognised_by_bus_api_or_name() {
        let by_bus = source_from("x", None, false, &props(&[("device.bus", "bluetooth")]));
        let by_api = source_from("x", None, false, &props(&[("device.api", "bluez5")]));
        let by_name = source_from("bluez_input.BC:87:FA:9A:DF:30", None, false, &props(&[]));
        assert!(by_bus.bluetooth && by_api.bluetooth && by_name.bluetooth);
        assert_eq!(by_name.label, "bluez_input.BC:87:FA:9A:DF:30");
    }

    #[test]
    fn monitors_are_flagged_either_way() {
        assert!(source_from("a.monitor", None, true, &props(&[])).monitor);
        assert!(source_from("b", None, false, &props(&[("device.class", "monitor")])).monitor);
        assert!(!source_from("c", None, false, &props(&[])).monitor);
    }

    #[test]
    fn prop_values_lose_their_nul_and_survive_non_ascii() {
        assert_eq!(prop_text("RØDE\0".as_bytes()), "RØDE");
        assert_eq!(prop_text(b"usb"), "usb");
    }

    #[test]
    fn flavour_names_the_server() {
        assert_eq!(flavour("PulseAudio (on PipeWire 1.4.7)"), "PipeWire");
        assert_eq!(flavour("pulseaudio"), "PulseAudio");
    }
}
