//! The microphone list and the saved pin → device resolution.
//!
//! A pin is the cpal `DeviceId` string (`pulseaudio:<source name>`, `alsa:plughw:CARD=USB,DEV=0`,
//! `wasapi:{…}`, `coreaudio:<uid>`), stable across reboots and replugging. Older settings stored
//! the device's display name instead; [`resolve_legacy`] maps such a name to today's id.
//!
//! On Linux the list is one entry per microphone the sound server knows, never the five or six
//! ALSA names a card can be opened under (that list pinned the raw `hw:` path, which grabs the mic
//! exclusively). The raw ALSA paths are only listed on request, grouped under their microphone.

#[cfg(target_os = "linux")]
use super::alsa_paths::{self, PathKind};
use super::host;
use cpal::traits::DeviceTrait;
#[cfg(target_os = "linux")]
use cpal::HostId;
use cpal::{Device, DeviceId};
use serde::Serialize;
use std::str::FromStr;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicInventory {
    /// "PipeWire" / "PulseAudio" when Linux records through a sound server.
    pub server: Option<&'static str>,
    /// What "System default" resolves to right now.
    pub default_label: Option<String>,
    pub mics: Vec<Mic>,
    /// Cards with ALSA capture paths but no microphone in `mics` (only with `include_paths`).
    pub other_paths: Vec<PathGroup>,
    /// The "Show all audio paths" switch exists only where there are paths to show (Linux).
    pub advanced_supported: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mic {
    pub id: String,
    pub label: String,
    pub bluetooth: bool,
    pub is_default: bool,
    /// Every way to open this microphone, the recommended one first (only with `include_paths`).
    pub paths: Vec<MicPath>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathGroup {
    pub label: String,
    pub paths: Vec<MicPath>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicPath {
    pub id: String,
    /// "server" or one of the `PathKind`s ("alsa-shared", "alsa-exclusive", "alsa-raw", "alsa-dsnoop").
    pub kind: &'static str,
}

/// Dictation fell back to the default input because the pinned microphone isn't there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicFallback {
    pub wanted_id: String,
    pub using: String,
}

pub struct Resolved {
    pub device: Device,
    pub fallback: Option<MicFallback>,
    /// The sound-server source to watch while recording (a pinned, present pulse source).
    pub watch_source: Option<String>,
}

/// List the microphones (and, on request, every raw ALSA path grouped under them).
pub fn list_input_devices(include_paths: bool) -> MicInventory {
    #[cfg(target_os = "linux")]
    {
        if let Some(snap) = super::pulse::snapshot() {
            if host::on_sound_server() {
                return linux_server_inventory(&snap, include_paths);
            }
        }
        linux_alsa_inventory(include_paths)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = include_paths;
        native_inventory()
    }
}

#[cfg(target_os = "linux")]
fn linux_server_inventory(snap: &super::pulse::Snapshot, include_paths: bool) -> MicInventory {
    let mut cards = if include_paths {
        alsa_cards()
    } else {
        Vec::new()
    };
    let mut mics = Vec::new();
    let mut default_label = None;
    for s in snap.microphones() {
        let id = DeviceId::new(HostId::PulseAudio, &s.name).to_string();
        let is_default = snap.default_source.as_deref() == Some(s.name.as_str());
        if is_default {
            default_label = Some(s.label.clone());
        }
        let mut paths = Vec::new();
        if include_paths {
            paths.push(MicPath {
                id: id.clone(),
                kind: "server",
            });
            if let Some(card) = &s.alsa_card_id {
                // A card with several sources (analog + digital input) lists its paths once, under
                // the first.
                if let Some(i) = cards.iter().position(|c| &c.card == card) {
                    paths.extend(cards.remove(i).paths);
                }
            }
        }
        mics.push(Mic {
            id,
            label: s.label.clone(),
            bluetooth: s.bluetooth,
            is_default,
            paths,
        });
    }
    MicInventory {
        server: Some(snap.flavour),
        default_label,
        mics,
        other_paths: cards
            .into_iter()
            .map(|c| PathGroup {
                label: c.label,
                paths: c.paths,
            })
            .collect(),
        advanced_supported: true,
    }
}

/// No sound server: one microphone per ALSA card, opened through its shared path.
#[cfg(target_os = "linux")]
fn linux_alsa_inventory(include_paths: bool) -> MicInventory {
    let mics = alsa_cards()
        .into_iter()
        .filter_map(|c| {
            let first = c.paths.first()?.id.clone();
            Some(Mic {
                id: first,
                label: c.label,
                bluetooth: false,
                is_default: false,
                paths: if include_paths { c.paths } else { Vec::new() },
            })
        })
        .collect();
    MicInventory {
        server: None,
        default_label: None,
        mics,
        other_paths: Vec::new(),
        advanced_supported: true,
    }
}

#[cfg(target_os = "linux")]
struct AlsaCard {
    card: String,
    label: String,
    /// Sorted by `PathKind` (shared first).
    paths: Vec<MicPath>,
}

/// The offered ALSA capture paths, grouped by card, in ALSA's card order.
#[cfg(target_os = "linux")]
fn alsa_cards() -> Vec<AlsaCard> {
    let mut found: Vec<(String, String, PathKind, String)> = Vec::new();
    for d in host::native_inputs() {
        let Ok(id) = d.id() else { continue };
        let Some((kind, card)) = alsa_paths::classify(id.id()) else {
            continue;
        };
        let label = host::device_label(&d)
            .map(|l| alsa_paths::card_label(&l).to_string())
            .unwrap_or_else(|| card.clone());
        found.push((card, label, kind, id.to_string()));
    }
    group_cards(found)
}

#[cfg(target_os = "linux")]
fn group_cards(found: Vec<(String, String, PathKind, String)>) -> Vec<AlsaCard> {
    let mut cards: Vec<AlsaCard> = Vec::new();
    let mut kinds: Vec<Vec<(PathKind, String)>> = Vec::new();
    for (card, label, kind, id) in found {
        let i = match cards.iter().position(|c| c.card == card) {
            Some(i) => i,
            None => {
                cards.push(AlsaCard {
                    card,
                    label,
                    paths: Vec::new(),
                });
                kinds.push(Vec::new());
                cards.len() - 1
            }
        };
        kinds[i].push((kind, id));
    }
    for (c, mut k) in cards.iter_mut().zip(kinds) {
        k.sort();
        k.dedup();
        c.paths = k
            .into_iter()
            .map(|(kind, id)| MicPath {
                id,
                kind: kind_name(kind),
            })
            .collect();
    }
    cards
}

#[cfg(target_os = "linux")]
fn kind_name(kind: PathKind) -> &'static str {
    match kind {
        PathKind::Shared => "alsa-shared",
        PathKind::Exclusive => "alsa-exclusive",
        PathKind::Raw => "alsa-raw",
        PathKind::Dsnoop => "alsa-dsnoop",
    }
}

#[cfg(not(target_os = "linux"))]
fn native_inventory() -> MicInventory {
    let default = host::default_input();
    let default_id = default.as_ref().and_then(|d| d.id().ok());
    let mics = host::native_inputs()
        .into_iter()
        .filter_map(|d| {
            let id = d.id().ok()?;
            Some(Mic {
                is_default: Some(&id) == default_id.as_ref(),
                id: id.to_string(),
                label: host::device_label(&d)?,
                bluetooth: false,
                paths: Vec::new(),
            })
        })
        .collect();
    MicInventory {
        server: None,
        default_label: default.as_ref().and_then(host::device_label),
        mics,
        other_paths: Vec::new(),
        advanced_supported: false,
    }
}

/// Does this id record through the Linux sound server (the PulseAudio-protocol host)?
fn on_server(id: &DeviceId) -> bool {
    #[cfg(target_os = "linux")]
    {
        id.host() == HostId::PulseAudio
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = id;
        false
    }
}

/// Is this saved value a cpal device id (vs a pre-ids display-name pin)?
fn parse_pin(pin: &str) -> Option<DeviceId> {
    DeviceId::from_str(pin)
        .ok()
        .filter(|id| !id.id().is_empty())
}

/// Find the device a saved pin names; fall back to the default input (and say so) when it is not
/// connected. `None` / "" / "default" = System default.
pub fn resolve_input(pin: Option<&str>) -> Result<Resolved, String> {
    let pin = pin.filter(|p| !p.is_empty() && *p != "default");
    if let Some(pin) = pin {
        let id = parse_pin(pin).or_else(|| resolve_legacy(pin).and_then(|(id, _)| parse_pin(&id)));
        if let Some(device) = id.as_ref().and_then(host::input_by_id) {
            let watch_source = id
                .as_ref()
                .filter(|id| on_server(id))
                .map(|id| id.id().to_string());
            return Ok(Resolved {
                device,
                fallback: None,
                watch_source,
            });
        }
        tracing::warn!("[audio] microphone '{pin}' is not connected; using the default input");
        let device = host::default_input().ok_or_else(|| "no default input device".to_string())?;
        let using = host::device_label(&device).unwrap_or_else(|| "the default input".into());
        return Ok(Resolved {
            device,
            fallback: Some(MicFallback {
                wanted_id: pin.to_string(),
                using,
            }),
            watch_source: None,
        });
    }
    let device = host::default_input().ok_or_else(|| "no default input device".to_string())?;
    Ok(Resolved {
        device,
        fallback: None,
        watch_source: None,
    })
}

/// The config to capture with: the device's default, unless that sample format is one the capture
/// loops don't convert (they take F32 / I16 / U16) — then F32 at the same rate, if offered.
pub fn input_config(device: &Device) -> Result<cpal::SupportedStreamConfig, String> {
    let def = device.default_input_config().map_err(|e| e.to_string())?;
    if matches!(
        def.sample_format(),
        cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16
    ) {
        return Ok(def);
    }
    let f32_at_rate = device.supported_input_configs().ok().and_then(|mut it| {
        it.find_map(|r| {
            (r.sample_format() == cpal::SampleFormat::F32 && r.channels() == def.channels())
                .then(|| r.try_with_sample_rate(def.sample_rate()))
                .flatten()
        })
    });
    Ok(f32_at_rate.unwrap_or(def))
}

/// The stream config for `supported`. Through the sound server, ask for ~20 ms callbacks: left at
/// its default, the PulseAudio host hands over 16384 frames (~340 ms at 48 kHz) per callback, which
/// would make the level meter and the streaming upload visibly lag. ALSA keeps its own default.
pub fn capture_config(
    device: &Device,
    supported: &cpal::SupportedStreamConfig,
) -> cpal::StreamConfig {
    let mut config = supported.config();
    let on_server = device.id().is_ok_and(|id| on_server(&id));
    if let (true, cpal::SupportedBufferSize::Range { min, max }) =
        (on_server, supported.buffer_size())
    {
        config.buffer_size = cpal::BufferSize::Fixed((config.sample_rate / 50).clamp(*min, *max));
    }
    config
}

/// Map a pre-ids pin (a device's display name) to today's `(id, label)`. On Linux the old names
/// were ALSA descriptions "<card>, <pcm>"; the sound server reports the same two as source
/// properties, so the match is exact. Elsewhere the old name is the device's own name.
pub fn resolve_legacy(name: &str) -> Option<(String, String)> {
    if parse_pin(name).is_some() {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(snap) = super::pulse::snapshot() {
            let mics: Vec<_> = snap.microphones().collect();
            if let Some(s) = legacy_match(name, &mics) {
                return Some((
                    DeviceId::new(HostId::PulseAudio, &s.name).to_string(),
                    s.label.clone(),
                ));
            }
        }
        // No server: the card's shared ALSA path.
        let card = alsa_paths::card_label(name);
        alsa_cards()
            .into_iter()
            .find(|c| c.label == card)
            .and_then(|c| Some((c.paths.first()?.id.clone(), c.label)))
    }
    #[cfg(not(target_os = "linux"))]
    {
        host::native_inputs().into_iter().find_map(|d| {
            let label = host::device_label(&d)?;
            (label == name).then(|| Some((d.id().ok()?.to_string(), label)))?
        })
    }
}

#[cfg(target_os = "linux")]
fn legacy_match<'a>(
    name: &str,
    mics: &[&'a super::pulse::PulseSource],
) -> Option<&'a super::pulse::PulseSource> {
    let exact = mics.iter().find(|s| {
        matches!((&s.card_name, &s.alsa_name), (Some(c), Some(n)) if format!("{c}, {n}") == name)
    });
    let card = alsa_paths::card_label(name);
    exact
        .or_else(|| mics.iter().find(|s| s.card_name.as_deref() == Some(card)))
        .or_else(|| mics.iter().find(|s| s.label == name))
        .copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_are_device_ids_names_are_legacy() {
        let id = parse_pin("pulseaudio:alsa_input.usb-R__DE_R__DE_PodMic_USB-00.mono-fallback");
        #[cfg(target_os = "linux")]
        assert_eq!(id.map(|i| i.host()), Some(HostId::PulseAudio));
        #[cfg(not(target_os = "linux"))]
        let _ = id;
        assert!(parse_pin("RØDE PodMic USB, USB Audio").is_none());
        assert!(parse_pin("Mikrofon (Realtek(R) Audio)").is_none());
        assert!(parse_pin("default").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn device_ids_round_trip_with_non_ascii() {
        let id = DeviceId::new(HostId::PulseAudio, "alsa_input.usb-RØDE.mono");
        let s = id.to_string();
        assert_eq!(s, "pulseaudio:alsa_input.usb-RØDE.mono");
        assert_eq!(parse_pin(&s), Some(id));
        let alsa = parse_pin("alsa:plughw:CARD=USB,DEV=0").unwrap();
        assert_eq!(alsa.host(), HostId::Alsa);
        assert_eq!(alsa.id(), "plughw:CARD=USB,DEV=0");
    }

    #[cfg(target_os = "linux")]
    fn src(
        name: &str,
        label: &str,
        card: Option<&str>,
        pcm: Option<&str>,
    ) -> super::super::pulse::PulseSource {
        super::super::pulse::PulseSource {
            name: name.into(),
            label: label.into(),
            bluetooth: false,
            monitor: false,
            alsa_card_id: None,
            card_name: card.map(Into::into),
            alsa_name: pcm.map(Into::into),
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn legacy_alsa_names_map_to_the_server_source() {
        let rode = src(
            "rode.mono",
            "RØDE PodMic USB Mono",
            Some("RØDE PodMic USB"),
            Some("USB Audio"),
        );
        let cam = src(
            "c920.iec",
            "C920 Digital",
            Some("HD Pro Webcam C920"),
            Some("USB Audio"),
        );
        let mics = [&cam, &rode];
        assert_eq!(
            legacy_match("RØDE PodMic USB, USB Audio", &mics).map(|s| s.name.as_str()),
            Some("rode.mono")
        );
        // The pcm part changed name: the card alone still finds it.
        assert_eq!(
            legacy_match("HD Pro Webcam C920, Other", &mics).map(|s| s.name.as_str()),
            Some("c920.iec")
        );
        assert!(legacy_match("Unknown Card, USB Audio", &mics).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn alsa_paths_group_per_card_shared_first() {
        let f = |c: &str, k, id: &str| (c.to_string(), format!("{c} label"), k, id.to_string());
        let cards = group_cards(vec![
            f("USB", PathKind::Raw, "alsa:hw:CARD=USB,DEV=0"),
            f("C920", PathKind::Shared, "alsa:sysdefault:CARD=C920"),
            f("USB", PathKind::Shared, "alsa:sysdefault:CARD=USB"),
            f("USB", PathKind::Exclusive, "alsa:plughw:CARD=USB,DEV=0"),
        ]);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].card, "USB");
        let kinds: Vec<_> = cards[0].paths.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, ["alsa-shared", "alsa-exclusive", "alsa-raw"]);
        assert_eq!(cards[1].paths[0].id, "alsa:sysdefault:CARD=C920");
    }
}

/// `cargo test --lib live_inventory -- --ignored --nocapture` prints what the picker would show on
/// this machine (and how a legacy name pin resolves). Never opens a stream.
#[cfg(test)]
#[test]
#[ignore]
fn live_inventory() {
    let inv = list_input_devices(true);
    println!("{}", serde_json::to_string_pretty(&inv).unwrap());
    if let Ok(name) = std::env::var("LEGACY_PIN") {
        println!("legacy {name:?} -> {:?}", resolve_legacy(&name));
    }
}

/// `PIN=… cargo test --lib live_capture -- --ignored --nocapture`: open the pin like dictation does,
/// record 2 s, print the format and level. Opens the mic (a Bluetooth headset switches profile).
#[cfg(test)]
#[test]
#[ignore]
fn live_capture() {
    use cpal::traits::StreamTrait;
    use std::sync::{Arc, Mutex};
    let pin = std::env::var("PIN").ok();
    let r = resolve_input(pin.as_deref()).unwrap();
    let cfg = input_config(&r.device).unwrap();
    println!(
        "device={:?} id={:?} fallback={:?} watch={:?} cfg={cfg:?}",
        host::device_label(&r.device),
        r.device.id().map(|i| i.to_string()),
        r.fallback,
        r.watch_source
    );
    let got = Arc::new(Mutex::new((0usize, 0f32)));
    let g = got.clone();
    let stream = r
        .device
        .build_input_stream(
            capture_config(&r.device, &cfg),
            move |d: &[f32], _| {
                if std::env::var_os("SHOW").is_some() {
                    eprint!("{} ", d.len());
                }
                let mut g = g.lock().unwrap();
                g.0 += d.len();
                g.1 = d.iter().fold(g.1, |m, s| m.max(s.abs()));
            },
            super::stream_errors::error_callback("probe", || println!("TERMINAL")),
            None,
        )
        .unwrap();
    stream.play().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));
    drop(stream);
    let (n, peak) = *got.lock().unwrap();
    println!("samples={n} peak={peak}");
}
