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
//! hung caller. The client has no timeout of its own, so that helper stays parked until the server
//! answers or hangs up; until it does, later calls return None at once instead of each parking
//! another helper (the mic watch and the Settings device poll ask every few seconds). That hold is
//! time-bounded: a timeout also drops the wedged client, and after BACKOFF one fresh attempt goes
//! through on a new connection — so a single wedged connection (a lost reply, a half-dead socket
//! after resume) recovers while the server itself is fine. Each parked helper keeps its connection
//! open, so retries stop once MAX_PARKED helpers are parked: a server that stays wedged costs a
//! fixed handful of threads and sockets, not one more per back-off for the life of the process.
//! A parked helper whose connection answers late puts it back into the empty slot for reuse; only
//! one the slot has already replaced is dropped (and its reactor lingers until the server hangs up).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(2);
/// How long a timed-out call holds off further attempts before one fresh one may go through.
const BACKOFF: Duration = Duration::from_secs(30);
/// No post-back-off retry while this many helpers are still parked on the server.
const MAX_PARKED: usize = 3;

/// Helper threads still running (a parked one never returns while the server stays wedged).
static LIVE_HELPERS: AtomicUsize = AtomicUsize::new(0);

/// Counts one helper thread for as long as it lives; moved into the thread's closure, so it is
/// dropped when the helper returns (or at once, when the spawn itself fails).
struct LiveHelper;
impl LiveHelper {
    fn new() -> Self {
        LIVE_HELPERS.fetch_add(1, Ordering::SeqCst);
        LiveHelper
    }
}
impl Drop for LiveHelper {
    fn drop(&mut self) {
        LIVE_HELPERS.fetch_sub(1, Ordering::SeqCst);
    }
}

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

/// A helper thread outlived its timeout and is still parked on the server (`helper` = its id), or
/// [`RETRYING`] while the one post-back-off attempt runs. Set by [`wait`] and [`admit`]; cleared by
/// the owning helper once its call returns, or by the retry when it did not time out again.
#[derive(Clone, Copy)]
struct Stuck {
    since: Instant,
    helper: u64,
}
static STUCK: Mutex<Option<Stuck>> = Mutex::new(None);
static HELPER_SEQ: AtomicU64 = AtomicU64::new(0);
const RETRYING: u64 = u64::MAX;

fn stuck() -> std::sync::MutexGuard<'static, Option<Stuck>> {
    STUCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Clear the hold if `helper` still owns it (a later timeout's hold is not this helper's to lift).
fn clear_stuck(helper: u64) {
    let mut s = stuck();
    if s.is_some_and(|st| st.helper == helper) {
        *s = None;
    }
}

/// Is a timeout's hold (or its one post-back-off retry) in force? Then a None from [`snapshot`]
/// means "the server is not answering", not "no server": callers must not fall back to raw ALSA.
/// A refused connect never raises the hold. Time-bounded like [`admit`]: true only while the
/// back-off runs (or MAX_PARKED helpers are parked), so a caller that never reaches [`snapshot`]
/// (`host::with_host`) tries the server again once it ran out instead of skipping it for good
/// while a single wedged helper stays parked.
pub fn held() -> bool {
    match *stuck() {
        None => false,
        Some(st) if st.since.elapsed() < BACKOFF => true,
        Some(_) => LIVE_HELPERS.load(Ordering::SeqCst) >= MAX_PARKED,
    }
}

/// Put a connection that answered after its caller gave up back into the empty slot: it is
/// healthy, and dropping it would leak its reactor thread and socket (they only go when the
/// server hangs up). A slot already refilled by a fresh client keeps that one.
fn restore(client: Arc<pulseaudio::Client>) {
    if let Ok(mut slot) = CLIENT.lock() {
        if slot.is_none() {
            *slot = Some(client);
        }
    }
}

/// May a call go to the server now? None = a helper is parked and the back-off is still running.
/// Once it ran out, the first caller is let through (Some(true)) and the hold is restamped, so
/// concurrent callers keep waiting while that one attempt runs — unless MAX_PARKED helpers are
/// already parked, then the hold stays until one of them returns.
fn admit() -> Option<bool> {
    let mut s = stuck();
    match *s {
        None => Some(false),
        Some(st) if st.since.elapsed() < BACKOFF => None,
        Some(_) if LIVE_HELPERS.load(Ordering::SeqCst) >= MAX_PARKED => None,
        Some(_) => {
            *s = Some(Stuck {
                since: Instant::now(),
                helper: RETRYING,
            });
            Some(true)
        }
    }
}

/// Why [`query`] produced no snapshot.
enum QueryFail {
    /// The connection is gone (disconnected, a socket error, a dead helper): worth a fresh client.
    Error,
    /// The server answered with an error (or a reply that would not decode): the connection is
    /// alive, so it is kept — dropping it would leak its reactor thread and socket.
    Rejected,
    /// No answer in time; the helper is still parked on this client.
    TimedOut,
}

/// Why [`wait`] returned no answer.
enum Waited {
    /// No answer in time; the helper is still parked and [`STUCK`] is raised.
    TimedOut,
    /// The helper died without answering: nothing is parked.
    Died,
}

/// Wait for helper `id`'s answer. On a timeout, raise [`STUCK`]; the helper clears it right after
/// its send, so an answer that slipped in between the timeout and the flag is picked up here
/// instead of leaving the flag raised until the back-off runs out.
fn wait<T>(rx: &Receiver<T>, id: u64) -> Result<T, Waited> {
    match rx.recv_timeout(TIMEOUT) {
        Ok(v) => Ok(v),
        Err(RecvTimeoutError::Timeout) => {
            *stuck() = Some(Stuck {
                since: Instant::now(),
                helper: id,
            });
            match rx.try_recv() {
                Ok(v) => {
                    clear_stuck(id);
                    Ok(v)
                }
                Err(_) => Err(Waited::TimedOut),
            }
        }
        Err(RecvTimeoutError::Disconnected) => Err(Waited::Died),
    }
}

/// Is a PulseAudio-protocol server socket there at all? Cheap; no connection.
pub fn server_present() -> bool {
    pulseaudio::socket_path_from_env().is_some_and(|p| p.exists())
}

/// The server's current view, or None when no server answers.
pub fn snapshot() -> Option<Snapshot> {
    if !server_present() {
        return None;
    }
    // A helper is still parked on a wedged server: don't park another one beside it until the
    // back-off has run out.
    let retrying = admit()?;
    let out = attempt();
    // The retry did not time out again (that would have replaced the hold): lift it.
    if retrying {
        clear_stuck(RETRYING);
    }
    out
}

fn attempt() -> Option<Snapshot> {
    for _ in 0..2 {
        let client = client()?;
        match query(client) {
            Ok(s) => return Some(s),
            // Wedged: no second try now. Drop the client so the post-back-off retry builds a
            // fresh connection (a wedged connection is not always a wedged server).
            Err(QueryFail::TimedOut) => {
                if let Ok(mut c) = CLIENT.lock() {
                    *c = None;
                }
                return None;
            }
            // Answered with an error: the connection is fine, a fresh one would get the same.
            Err(QueryFail::Rejected) => return None,
            // Failed: rebuild the client once (a restarted server leaves the old one
            // disconnected; its reactor thread has already exited).
            Err(QueryFail::Error) => {
                if let Ok(mut c) = CLIENT.lock() {
                    *c = None;
                }
            }
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
    let id = HELPER_SEQ.fetch_add(1, Ordering::Relaxed);
    let live = LiveHelper::new();
    std::thread::Builder::new()
        .name("pulse-connect".into())
        .spawn(move || {
            let _live = live;
            // Connected after the caller gave up: keep the connection rather than leak it.
            if let Err(mpsc::SendError(Ok(c))) =
                tx.send(pulseaudio::Client::from_env(c"faster-whisper-frontend"))
            {
                restore(Arc::new(c));
            }
            clear_stuck(id);
        })
        .ok()?;
    match wait(&rx, id) {
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

fn query(client: Arc<pulseaudio::Client>) -> Result<Snapshot, QueryFail> {
    let (tx, rx) = mpsc::channel();
    let id = HELPER_SEQ.fetch_add(1, Ordering::Relaxed);
    let live = LiveHelper::new();
    std::thread::Builder::new()
        .name("pulse-query".into())
        .spawn(move || {
            let _live = live;
            let res = futures_executor::block_on(async {
                let info = client.server_info().await?;
                let sources = client.list_sources().await?;
                Ok::<_, pulseaudio::ClientError>((info, sources))
            });
            // Answered after the caller timed out (and dropped the client from the slot): the
            // connection is alive, so put it back rather than leak it.
            let alive = res.as_ref().map_or_else(connection_alive, |_| true);
            if tx.send(res).is_err() && alive {
                restore(client);
            }
            clear_stuck(id);
        })
        .map_err(|_| QueryFail::Error)?;
    let (info, sources) = match wait(&rx, id) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::debug!("[audio] sound server query failed: {e}");
            return Err(if connection_alive(&e) {
                QueryFail::Rejected
            } else {
                QueryFail::Error
            });
        }
        Err(Waited::TimedOut) => {
            tracing::warn!("[audio] sound server query timed out after {TIMEOUT:?}");
            return Err(QueryFail::TimedOut);
        }
        // The helper died without answering.
        Err(Waited::Died) => return Err(QueryFail::Error),
    };
    let server_name = info
        .server_name
        .as_ref()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Snapshot {
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

/// Does the connection survive this error? Only a socket error or a hang-up ends its reactor; a
/// server-side error or an undecodable reply leaves it running.
fn connection_alive(e: &pulseaudio::ClientError) -> bool {
    !matches!(
        e,
        pulseaudio::ClientError::Disconnected | pulseaudio::ClientError::Io(_)
    )
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
    fn only_a_dead_socket_drops_the_connection() {
        use pulseaudio::ClientError;
        assert!(!connection_alive(&ClientError::Disconnected));
        let broken_pipe = ClientError::Io(std::io::ErrorKind::BrokenPipe.into());
        assert!(!connection_alive(&broken_pipe));
        assert!(connection_alive(&ClientError::UnexpectedSequenceNumber));
        assert!(connection_alive(&ClientError::ServerUnavailable));
    }

    #[test]
    fn a_timeout_hold_reads_as_held_until_lifted_or_its_back_off_runs_out() {
        *stuck() = Some(Stuck {
            since: Instant::now(),
            helper: 7,
        });
        assert!(held());
        clear_stuck(8);
        assert!(held(), "another helper's return must not lift the hold");
        clear_stuck(7);
        assert!(!held());
        // Past its back-off (and below the parked cap) a hold no longer reads as held, so
        // with_host tries the server again even while the wedged helper stays parked.
        if let Some(since) = Instant::now().checked_sub(BACKOFF + Duration::from_secs(1)) {
            *stuck() = Some(Stuck { since, helper: 7 });
            assert!(!held());
            clear_stuck(7);
        }
    }

    #[test]
    fn flavour_names_the_server() {
        assert_eq!(flavour("PulseAudio (on PipeWire 1.4.7)"), "PipeWire");
        assert_eq!(flavour("pulseaudio"), "PulseAudio");
    }
}
