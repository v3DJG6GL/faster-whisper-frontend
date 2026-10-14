//! Streaming dictation WebSocket client.
//!
//! Connects to `ws[s]://HOST/v1/audio/transcriptions/stream`, sends the JSON
//! `config` frame, then forwards 16 kHz mono s16le PCM (resampled from the
//! capture rate) as binary frames while parsing the server's
//! `ready`/`partial`/`final`/`error`/`closing` messages into [`StreamEvent`]s.

use crate::audio::resample::Resampler16k;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;

/// Events surfaced from the stream (the session maps these to Tauri events).
pub enum StreamEvent {
    /// Handshake accepted. `overrides_ignored` lists client decode overrides the
    /// server refused because the field is admin-locked (empty otherwise).
    Ready {
        overrides_ignored: Vec<String>,
    },
    Partial {
        committed: String,
        pending: String,
    },
    Final {
        committed: String,
        tail: String,
        last: bool,
        utterance: Option<u32>,
    },
    /// Long-silence hard break: the server reset its document. The client should
    /// reset its injection baseline and optionally type `separator` between docs.
    Boundary {
        separator: String,
    },
    /// The capture-row id the server minted for the utterance it just
    /// finalized. Rides its own frame because the `final` frame is emitted
    /// BEFORE the capture is written, so the id does not exist yet at that
    /// point. The client hands it back on the translate request, which is how
    /// the server links the two halves into one log receipt. Carries the
    /// utterance ordinal so the client can PAIR it with the `Final` that
    /// produced it: a single "most recent id" slot mis-attributes the id to the
    /// next phrase whenever an utterance produces no capture row (the server
    /// samples and rate-limits them) or the inject queue drains slowly.
    /// `utterance` is None when the server predates the ordinal: the client then
    /// pairs nothing rather than keying every phrase on ordinal 0.
    Captured {
        id: String,
        utterance: Option<u32>,
    },
    /// The session's audio was saved to this path ("Keep audio recordings" on).
    /// Emitted before `Closed` so the client can link its history record to the
    /// file. Epoch-gated like every other event — a cancelled session's save
    /// never reaches the UI. `utterance` is set for a per-utterance clip (see
    /// [`ClipCutter`]), emitted right after that utterance's `Final`; None for
    /// the whole-session file.
    RecordingSaved {
        path: String,
        utterance: Option<u32>,
        duration_ms: u64,
    },
    /// Keepalive while the server cold-loads its model (sent every few seconds
    /// until `ready`/the finals). Proof of life — resets the drain's idle
    /// window and the UI's stuck-finalize watchdog.
    Loading,
    /// Where the utterance the server is holding stands: `Open` (it has enough
    /// speech to be decoded), `Decoding` (the final decode is running) or
    /// `Dropped` (it ended with no `final`). The server is the only party that
    /// knows this — a streaming session never leaves "listening" on the client,
    /// so without it the UI read "ready" through every decode. The server
    /// guarantees one terminal per announced utterance (a `Final` with the same
    /// ordinal, or `Dropped`), which is what lets the UI show a working state
    /// without a way to get stuck in it.
    Utterance {
        state: UtteranceState,
        utterance: Option<u32>,
    },
    /// The session ENDED SHORT but not failed: a non-terminal warning the UI shows without
    /// leaving its normal close path (the `Closed` that follows still inserts what was
    /// committed). Emitted when the drain idle window expires before the server's last final.
    /// Never route this through `Error` — the UI treats that as fatal and skips the insert tail.
    Incomplete(String),
    Error(String),
    Closed,
}

/// The `state` of an `utterance` frame. A closed set on purpose: the value
/// drives UI state, so a string the server may grow later is dropped at the
/// parse boundary rather than forwarded for every consumer to re-validate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UtteranceState {
    Open,
    Decoding,
    Dropped,
}

impl UtteranceState {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "decoding" => Some(Self::Decoding),
            "dropped" => Some(Self::Dropped),
            _ => None,
        }
    }
}

pub struct StreamParams {
    pub ws_url: String,
    pub model: String,
    /// "" → omit the handshake field (inherit the server's DEFAULT_LANGUAGE);
    /// "auto" → send "" (explicit auto-detect, overriding an inherited language);
    /// a code → send it.
    pub language: String,
    pub response_format: String, // "json" | "verbose_json"
    // None = omit the field (inherit DEFAULT_PROMPT); Some("") = explicit clear
    // (send no initial_prompt); Some(v) = use v.
    pub prompt: Option<String>,
    pub decode_overrides: Option<serde_json::Value>, // opaque JSON object → handshake "decode_overrides"
    pub override_profile: Option<String>, // server override-profile name → handshake "override_profile"
    // Declares that this session's utterances WILL be translated on a separate
    // request, so the server holds each per-utterance receipt open and merges
    // the translation into it instead of logging two unlinked halves. Opaque
    // JSON like decode_overrides: the shape is the server's contract, not this
    // transport's business. Omitted → the server logs immediately, exactly as
    // it always has.
    pub translate_expect: Option<serde_json::Value>,
    /// Client-minted session id (32 hex) → handshake `client_job`, so every utterance
    /// row on the server links to ONE dictation session (usage counts sessions, not
    /// phrases) and the post-session outcome report can name it. None → omitted; the
    /// server then keys the job on its own session id.
    pub client_job: Option<String>,
    pub api_key: Option<String>,
    pub in_rate: u32,
    pub save_dir: Option<PathBuf>, // Some → save the streamed 16 kHz audio as .wav
    pub trim_silence: bool,        // when saving: keep only spoken spans (drop silence) in the .wav
    /// When saving: one `.wav` per finished utterance instead of one per session (live
    /// hands-free sessions, which keep one History record per utterance). See [`ClipCutter`].
    pub per_utterance_clips: bool,
    /// Set by a Cancel that arrives after Stop, while this session drains detached: from then on
    /// the drain writes no recording file (no session `.wav`/`.txt`, no further clip) — the same
    /// discard the batch path gives a Cancel during "transcribing…".
    pub detached: Arc<crate::session::DetachedStream>,
}

/// Case-insensitive `strip_prefix` for an ASCII prefix. `s.get(..len)` returns None on a
/// non-char-boundary, so this can't panic.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// Derive the streaming WS URL from a profile's http(s) server URL. The scheme match is
/// case-insensitive to mirror reqwest/url's scheme handling: an "HTTP://…" that Test Connection
/// (via reqwest) accepts must yield a valid "ws://…" here, not a malformed "ws://HTTP://…".
///
/// The result goes through the parser reqwest uses (the WHATWG `url` crate) for the same reason:
/// tungstenite's `http::Uri` takes ASCII only, so an IDN host (`bücher.example`) or a space in the
/// path passed Test connection — reqwest punycodes / percent-encodes them — and then failed every
/// live dictation with "invalid uri character". ws/wss are special schemes, so the url crate
/// applies the same IDNA and percent-encoding the HTTP routes get. Unparseable → the string as
/// built, so the connect error still names it.
pub fn http_to_ws(server_url: &str) -> String {
    let s = server_url.trim().trim_end_matches('/');
    let scheme_swapped = if let Some(rest) = strip_prefix_ci(s, "https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = strip_prefix_ci(s, "http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{s}")
    };
    let ws = format!("{scheme_swapped}/v1/audio/transcriptions/stream");
    reqwest::Url::parse(&ws).map(String::from).unwrap_or(ws)
}

/// The `Authorization` values the handshake carries, in the order [`super::with_auth`] gives the
/// HTTP routes: the server URL's `user:pass@` as `Basic` first, then `Bearer {key}`. reqwest makes
/// that Basic header for every HTTP request, while tungstenite only strips the userinfo out of
/// `Host` — so without this a basic-auth proxy that passes Test connection refused every live
/// dictation with a 401. reqwest builds the Basic value here too (its percent-decoding, base64 and
/// sensitive flag), from the http(s) twin of the URL. No userinfo and no key → nothing, so such a
/// handshake is unchanged. The error text never carries the credential: it reaches the log.
fn handshake_auth_headers(
    ws_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<tokio_tungstenite::tungstenite::http::HeaderValue>, String> {
    let mut out = Vec::new();
    let with_login = reqwest::Url::parse(ws_url)
        .ok()
        .filter(|u| !u.username().is_empty() || u.password().is_some());
    if let Some(mut url) = with_login {
        let bad_login = || "Invalid server login in the stream URL".to_string();
        let http = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(http).map_err(|()| bad_login())?;
        let req = super::client().get(url).build().map_err(|_| bad_login())?;
        out.extend(req.headers().get_all(AUTHORIZATION).iter().cloned());
    }
    if let Some(k) = api_key.filter(|k| !k.is_empty()) {
        match format!("Bearer {k}").parse() {
            Ok(v) => out.push(v),
            Err(e) => return Err(format!("Invalid API key: {e}")),
        }
    }
    Ok(out)
}

/// The stream URL as it is safe to PRINT — userinfo stripped and length bounded.
///
/// `friendly_err` gave the reqwest half of the transport exactly this treatment: a `serverUrl` of
/// the form `https://user:secret@host/` is storable (`isStorableServerUrl` accepts it, which is why
/// `authorityOf` exists at all), and `http_to_ws` carries the userinfo through by construction, so
/// the connect-failure message — a routine one — otherwise wrote the user's own reverse-proxy
/// password into the message AND into `tracing::warn!`, which on Windows is a log file on disk that
/// users are asked to attach to support reports. Bounded too: `serverUrl` carries no length cap on
/// the sync/import path, only the 4 MiB whole-blob ceiling.
fn display_url(u: &str) -> String {
    let (scheme, rest) = match u.split_once("://") {
        Some((s, r)) => (s, r),
        None => ("", u),
    };
    // The authority ends at the first `/ ? # \` — all four terminate it for the real parsers.
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (authority, remainder) = rest.split_at(end);
    // Userinfo is everything before the LAST `@` WITHIN the authority; a password may contain one.
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // If an `@` survives past the authority, the split was ambiguous — an un-percent-encoded `/`
    // in a proxy password moves the authority boundary left, so what we just called "host" is
    // really a fragment of the credential. `isStorableServerUrl` is a regex gate that never parses,
    // so such a string IS storable and lands in exactly the arm that reports an unparseable URL.
    // Print nothing rather than a piece of a password.
    if remainder.contains('@') {
        return "the configured server address".to_string();
    }
    // The path is a fixed literal on every one of these URLs, so it carries no information for the
    // reader and only spends the message's budget. Scheme + host is the whole point.
    let joined = if scheme.is_empty() {
        host.to_string()
    } else {
        format!("{scheme}://{host}")
    };
    // Its own, smaller budget: the caller bounds the WHOLE message at MAX_ERROR_TEXT, so a URL
    // allowed to spend all 200 would truncate the error's cause away entirely.
    super::bounded_server_text(&joined, MAX_URL_IN_ERROR)
}

/// How much of a message a printed URL may spend — see `display_url`.
const MAX_URL_IN_ERROR: usize = 80;

fn text_msg(s: String) -> Message {
    Message::Text(s.into())
}

/// RMS of a mono f32 frame (rate-independent). Used by the save-time speech gate to
/// mirror the capture meter (`session.rs`) and the chip's speaking detector.
#[inline]
fn rms_f32(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// A parsed server message handed from the dedicated read task to the main loop,
/// or a signal that the socket closed / reached its terminal frame.
enum FromReader {
    Event(StreamEvent),
    Closed,
}

/// Drive the stream until stopped or the socket closes. `on_event` is called for
/// every server message; a terminal `Closed` (and an `Error` on failure) is
/// ALWAYS emitted on every exit path so the UI can never get stuck. Every socket
/// read/write is bounded (connect + send + drain deadlines) so a dead or half-open
/// connection — e.g. the network dropped or the machine suspended mid-stream —
/// resolves to `Closed` within seconds instead of parking on the kernel's TCP
/// retransmit timeout (minutes), which would wedge the UI at "finalizing…".
pub async fn run<F>(
    params: StreamParams,
    mut pcm_rx: mpsc::UnboundedReceiver<Vec<f32>>,
    mut stop_rx: watch::Receiver<bool>,
    on_event: F,
) where
    F: Fn(StreamEvent) + Send + 'static,
{
    // On any setup failure, surface the error AND a terminal Closed, then bail.
    macro_rules! fail {
        ($msg:expr) => {{
            // Bounded inside the macro so no future arm can regress: these are the only error
            // strings in the transport with no ceiling of their own, and they reach both the UI
            // and the log.
            let m = super::bounded_server_text(&$msg, super::MAX_ERROR_TEXT);
            tracing::warn!("[stream] {m}");
            // A stop during setup already claimed the discard slot: retire it here too, or the
            // next session's Cancel takes it and logs a discard for a session that saved nothing.
            let _ = crate::session::settle_detached_stream(&params.detached);
            on_event(StreamEvent::Error(m));
            on_event(StreamEvent::Closed);
            return;
        }};
    }

    let mut request = match params.ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => fail!(format!(
            "Invalid stream URL {}: {e}",
            display_url(&params.ws_url)
        )),
    };
    match handshake_auth_headers(&params.ws_url, params.api_key.as_deref()) {
        Ok(values) => {
            for v in values {
                request.headers_mut().append(AUTHORIZATION, v);
            }
        }
        Err(m) => fail!(m),
    }

    // Connect with a bounded timeout. A Stop may arrive before we've connected — most
    // commonly a quick push-to-talk *tap* (press + release within a fraction of a
    // second), which fires the stop before the millisecond-fast handshake to a
    // reachable server completes. Treating that as "unreachable" gave a false error on
    // every quick tap. So we DON'T bail on early stop: we remember it and let the
    // in-flight connection finish. If it connects we fall straight through to draining
    // (flush + stop → a clean no-op, no audio, no error); only a genuine connect
    // failure / timeout surfaces the unreachable error. The timeout still bounds an
    // unreachable host (whose handshake would otherwise hang on SYN retries for the OS
    // default of a minute+, sticking the UI at "finalizing…").
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    let mut stop_requested = false;
    // Bound one inbound frame. This socket was the last transport route with no read ceiling: every
    // HTTP route got one (`MAX_BODY` for the transcript parse, `MAX_META_BODY` for the metadata
    // probes, `MAX_ERROR_BODY` for error arms), but `connect_async` takes tungstenite's DEFAULT
    // `max_message_size` of 64 MiB, so a hostile server buffered 64 MiB and had it expanded into a
    // full serde `Value` tree — several times that in RSS — BEFORE `MAX_TRANSCRIPT` and its
    // neighbours trimmed anything, repeatable for the life of the session.
    //
    // Sized so it can never reject a frame whose content the parser would have KEPT IN FULL, which
    // is the only truncation that would be a regression. The largest such frame is a `final`:
    // `committed` + `tail`, each capped at MAX_TRANSCRIPT *chars* (not bytes) — so at the 4-byte
    // worst case that is 2 × 4 Mchars × 4 B = 32 MiB of payload, plus keys, quoting and the
    // 50 × 200 `overrides_ignored` list. 48 MiB clears that with room to spare while removing a
    // quarter of the amplification. (A cap sized to REAL usage — an hour of dictation is ~50 KB —
    // would be far tighter and worth much more, but it could refuse a frame the parser would have
    // accepted whole, which is the D12/E8/N1 truncation trade the owner has settled against.
    // Recorded in the notes as the alternative.)
    const MAX_WS_MESSAGE: usize = 48 * 1024 * 1024;
    // ONLY `max_message_size` is overridden. `max_frame_size` keeps tungstenite's default, which is
    // 16 MiB — NOT 64 MiB — and `read_frame` reserves on the DECLARED length before any payload
    // arrives, so setting it to 48 MiB here would have tripled the free per-frame commit a server
    // can demand with a one-byte body. That is the opposite of this change's purpose: the 32 MiB
    // no-truncation argument above is about the assembled MESSAGE, and a message larger than one
    // frame is simply fragmented, so the 16 MiB frame default costs nothing and is left in force.
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE));
    let connect = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false),
    );
    tokio::pin!(connect);
    let (ws, _resp) = loop {
        tokio::select! {
            biased;
            res = stop_rx.changed(), if !stop_requested => {
                let _ = res;
                stop_requested = true; // disables this branch; keep awaiting the connect
            }
            res = &mut connect => match res {
                Ok(Ok(pair)) => break pair,
                Ok(Err(e)) => fail!(format!("Could not connect to {}: {e}", display_url(&params.ws_url))),
                Err(_) => fail!(format!(
                    "Could not connect to {} — timed out after {}s (server unreachable?)",
                    display_url(&params.ws_url),
                    CONNECT_TIMEOUT.as_secs()
                )),
            },
        }
    };
    let (mut write, mut read) = ws.split();
    tracing::info!("[stream] ws connected");

    let mut config = json!({
        "type": "config",
        "model": params.model,
        "response_format": params.response_format,
        "audio": { "format": "pcm_s16le", "sample_rate": 16000 }
    });
    // language sentinel, the same three states the batch form uses (see
    // `transport::wire_language`): "auto" → "", auto-detect stated explicitly, which
    // OVERRIDES an override profile's DEFAULT_LANGUAGE; a code → send it; "" → omit
    // (reserved: no picker emits it today). This route only ever talks to the full
    // backend, so no standard-server variant is needed here.
    if let Some(wire) = super::wire_language(&params.language) {
        config["language"] = json!(wire);
    }
    // prompt sentinel: omit the field entirely → server inherits DEFAULT_PROMPT;
    // send it (incl. "") → server uses it verbatim, where "" CLEARS the prompt.
    if let Some(p) = &params.prompt {
        config["prompt"] = json!(p);
    }
    // Forward per-request decode overrides as a nested object (only when non-empty).
    if let Some(v) = &params.decode_overrides {
        if v.as_object().is_some_and(|m| !m.is_empty()) {
            config["decode_overrides"] = v.clone();
        }
    }
    // Forward the server override-profile name (only when non-empty).
    if let Some(p) = &params.override_profile {
        if !p.is_empty() {
            config["override_profile"] = json!(p);
        }
    }
    // Forward the translation declaration (only when it names targets).
    if let Some(v) = &params.translate_expect {
        if v.as_object().is_some_and(|m| !m.is_empty()) {
            config["translate_expect"] = v.clone();
        }
    }
    // Forward the client-minted session id (only when set).
    if let Some(j) = &params.client_job {
        if !j.is_empty() {
            config["client_job"] = json!(j);
        }
    }
    if let Err(e) = write.send(text_msg(config.to_string())).await {
        fail!(format!("Failed to send stream config: {e}"));
    }

    let mut resampler = match Resampler16k::new(params.in_rate) {
        Ok(r) => r,
        Err(e) => fail!(format!("Resampler init failed: {e}")),
    };
    // If Stop already arrived during connect (a quick tap), skip straight to draining
    // so we flush + stop the empty session and close cleanly without sending audio.
    let mut draining = stop_requested;
    let saving = params.save_dir.is_some();
    let trim = saving && params.trim_silence;
    let mut saved: Vec<u8> = Vec::new();
    // Latched once `saved` reaches MAX_RECORD_PCM_BYTES (see `save_capped`); `gated` is the reused
    // scratch the speech gate writes into, so its output goes through the same cap.
    let mut saved_capped = false;
    let mut gated: Vec<u8> = Vec::new();
    // Accumulate the session transcript HERE (Rust) so a saved recording gets its `.txt` sidecar
    // written in the drain — independent of the epoch-gated `recording-saved` emit — exactly like the
    // batch path (transcribe_recording). A session superseded by cancel/suspend would otherwise keep
    // the `.wav` with no `.txt` (the frontend never sees the suppressed emit). Mirrors the frontend's
    // per-hard-break join: `current_doc` is the running document; a Boundary banks it into `docs`.
    let mut transcript_docs: Vec<String> = Vec::new();
    let mut transcript_cur = String::new();
    let save_dir = params.save_dir.as_deref();
    let detached = params.detached.clone();
    let (mut clips, mut clip_rx) = match save_dir.filter(|_| params.per_utterance_clips) {
        Some(dir) => {
            let (c, rx) = ClipCutter::new(dir);
            (Some(c), Some(rx))
        }
        None => (None, None),
    };
    // Speech-gate for the SAVED recording (NOT what's streamed to the server): keep only the spans
    // the chip shows as "speaking" + a short lead-in, so a long hands-free session doesn't store hours
    // of silence. The detector itself lives in `crate::audio::SpeechGate` (shared with the batch
    // record save so both paths trim identically); here it's fed chunk-by-chunk as audio arrives.
    let mut gate = crate::audio::SpeechGate::new();
    // Live-phase telemetry, reported once at drain entry: "sent 0 frames" instantly
    // separates a dead mic from a server that got audio and answered nothing.
    let mut frames_sent: u64 = 0;
    let mut bytes_sent: u64 = 0;
    let mut partials_seen: u32 = 0;

    // Bound on a single WS send. The server now decodes off its receive loop (it no
    // longer freezes mid-utterance), so a stalled send means a genuinely dead/half-
    // open link (suspend, network loss) — but keep this generous so a brief server
    // hiccup doesn't kill an otherwise-recoverable session and discard buffered audio.
    // A truly dead link is still caught promptly by the client keepalive PING below.
    const SEND_TIMEOUT: Duration = Duration::from_secs(20);

    // Drive the read half in a DEDICATED task. tokio-tungstenite only answers the
    // server's keepalive PINGs (with a PONG) while the read half is polled; in the
    // old single-`select!` loop a blocked/slow `write.send().await` (a full or
    // half-open socket buffer) starved that poll, so the server stopped hearing
    // PONGs and closed the connection with `1011 keepalive ping timeout`. A separate
    // reader keeps PONGs flowing whenever the link is alive, independent of the write
    // side. It forwards parsed messages over `evt_rx` and signals `Closed` when the
    // socket ends or the terminal frame arrives.
    let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<FromReader>();
    // AbortOnDrop: the reader must die with this task on EVERY exit. A cancelled session aborts the
    // outer task (StreamSession::drop), and a bare JoinHandle dropped by that abort only DETACHES
    // the reader — which then keeps the socket alive answering server PINGs indefinitely.
    let reader = AbortOnDrop(tokio::spawn(async move {
        loop {
            match read.next().await {
                Some(Ok(Message::Text(t))) => {
                    // Forward each parsed event; stop on `closing`. The LAST `final` is not
                    // the end: its `captured` receipt follows it, so give the socket a short
                    // grace to deliver it (and a `closing` that may come right behind) before
                    // stopping — bounded, so a server that never says `closing` does not park
                    // the reader on the drain's idle window.
                    let forward = |e| {
                        let _ = evt_tx.send(FromReader::Event(e));
                    };
                    match emit_message(t.as_str(), &forward) {
                        Frame::Continue => {}
                        Frame::Closing => break,
                        Frame::LastFinal => {
                            const LAST_FINAL_GRACE: Duration = Duration::from_millis(300);
                            let deadline = tokio::time::Instant::now() + LAST_FINAL_GRACE;
                            loop {
                                match tokio::time::timeout_at(deadline, read.next()).await {
                                    Ok(Some(Ok(Message::Text(t)))) => {
                                        if emit_message(t.as_str(), &forward) == Frame::Closing {
                                            break;
                                        }
                                    }
                                    Ok(Some(Ok(_))) => continue,
                                    _ => break, // close / eof / error / grace elapsed
                                }
                            }
                            break;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => {
                    tracing::info!("[stream] ws reader: close/eof");
                    break;
                }
                // Ping/Pong/Binary: ignored here. The PONG to a server PING is queued
                // by tungstenite and flushed by this very read poll — that's the point.
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    tracing::warn!("[stream] ws read error: {e}");
                    let _ = evt_tx.send(FromReader::Event(StreamEvent::Error(
                        super::bounded_server_text(&e.to_string(), super::MAX_ERROR_TEXT),
                    )));
                    break;
                }
            }
        }
        let _ = evt_tx.send(FromReader::Closed);
    }));

    // Client-initiated keepalive: a little outbound traffic on a regular cadence so a
    // half-open link is noticed promptly (the bounded send times out) even during a
    // silent stretch, and intermediaries keep the connection warm. The server's PINGs
    // are answered by the reader task above.
    const KEEPALIVE: Duration = Duration::from_secs(10);
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Set by a live-phase write that FAILED (not timed out): the reader may not have queued its
    // terminal message yet, so the post-loop check below waits briefly for it and surfaces the
    // loss itself when the reader has nothing to say.
    let mut write_failed: Option<String> = None;

    while !draining {
        tokio::select! {
            res = stop_rx.changed() => {
                if res.is_err() || *stop_rx.borrow() { draining = true; break; }
            }
            maybe = pcm_rx.recv() => {
                match maybe {
                    Some(chunk) => {
                        let bytes = resampler.push(&chunk);
                        if !bytes.is_empty() {
                            if trim {
                                // Advance the speech detector from this chunk's RMS (same scaling +
                                // thresholds as the chip); the gate keeps audio only while "speaking"
                                // and prepends the buffered lead-in on each silence→speech edge.
                                let lvl = crate::audio::chip_level(rms_f32(&chunk));
                                gated.clear();
                                gate.push(lvl, &bytes, &mut gated);
                                save_capped(&mut saved, &gated, &mut saved_capped);
                            } else if saving {
                                save_capped(&mut saved, &bytes, &mut saved_capped);
                            }
                            let n = bytes.len() as u64;
                            match tokio::time::timeout(
                                SEND_TIMEOUT,
                                write.send(Message::Binary(bytes.into())),
                            )
                            .await
                            {
                                Ok(Ok(())) => {
                                    frames_sent += 1;
                                    bytes_sent += n;
                                }
                                Ok(Err(e)) => {
                                    // socket closed/errored → finish; the post-loop check
                                    // surfaces it unless the reader already did.
                                    tracing::warn!("[stream] audio send failed: {e}");
                                    write_failed = Some(e.to_string());
                                    break;
                                }
                                Err(_) => {
                                    // Stalled send → the connection is gone. Surface it and
                                    // close so the UI returns to idle instead of hanging.
                                    tracing::warn!("[stream] audio send timed out — connection lost");
                                    on_event(StreamEvent::Error(
                                        "stream connection lost (send timed out)".into(),
                                    ));
                                    break;
                                }
                            }
                        }
                    }
                    None => { draining = true; break; } // capture ended
                }
            }
            from = evt_rx.recv() => {
                match from {
                    Some(FromReader::Event(e)) => {
                        if matches!(e, StreamEvent::Partial { .. }) { partials_seen += 1; }
                        forward_saved(e, save_dir, &detached.discard, &mut saved, &mut clips, &mut transcript_docs, &mut transcript_cur, &on_event);
                    }
                    // Server closed the socket (or the read errored, already surfaced
                    // above) — stop now; not draining, so fall through to Closed.
                    Some(FromReader::Closed) | None => {
                        tracing::warn!("[stream] ws ended mid-session (live phase)");
                        break;
                    }
                }
            }
            Some(clip) = recv_clip(&mut clip_rx) => on_event(clip),
            _ = keepalive.tick() => {
                match tokio::time::timeout(SEND_TIMEOUT, write.send(Message::Ping(Vec::<u8>::new().into()))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        // socket closed/errored → finish; the post-loop check surfaces it
                        // unless the reader already did.
                        tracing::warn!("[stream] keepalive send failed: {e}");
                        write_failed = Some(e.to_string());
                        break;
                    }
                    Err(_) => {
                        // Stalled send → the connection is gone. Surface it and close.
                        tracing::warn!("[stream] keepalive timed out — connection lost");
                        on_event(StreamEvent::Error(
                            "stream connection lost (keepalive timed out)".into(),
                        ));
                        break;
                    }
                }
            }
        }
    }

    // On EVERY exit from the live loop, not only the drain: the counters exist to tell a dead
    // mic from a server that got audio and answered nothing, and the mid-session socket death
    // is exactly the case that question is asked about.
    tracing::info!(
        "[stream] live phase ended (draining={draining}): sent {frames_sent} frames / {bytes_sent} B, saw {partials_seen} partial(s)"
    );
    if draining {
        // Finalize the current utterance and ask the server to close, then read the
        // remaining finals (delivered by the reader task) so the last words aren't
        // lost. The WHOLE block is bounded by one deadline: the flush/stop writes are
        // inside it too, so a half-open socket (suspend / dropped link) can't park
        // them indefinitely — we always fall through to the terminal `Closed` below.
        // The writes get one flat bound (a half-open socket can't park them);
        // the reads below get an ACTIVITY-based window instead.
        const DRAIN_WRITE_DEADLINE: Duration = Duration::from_secs(10);
        // Sub-cap on the PCM drain alone: the capture thread closes the channel within ~one
        // buffer; the cap exists so a cpal Stream drop that stalls (device yanked, wedged audio
        // service) cannot starve the flush/stop sends below out of the whole write budget.
        const PCM_DRAIN_CAP: Duration = Duration::from_secs(2);
        if tokio::time::timeout(DRAIN_WRITE_DEADLINE, async {
            // Drain the PCM the capture thread queued but the main loop hadn't consumed when the stop
            // signal won the (non-biased) select — push it through the resampler and send it, so the
            // final tens of ms aren't silently dropped from the transcript. `recv().await` (not a
            // one-shot try_recv) keeps draining until the channel CLOSES, so we also catch the chunks
            // the capture callback enqueues during its own shutdown: finish()/Drop set capture_stop
            // BEFORE ws_stop, so the capture thread is already exiting and drops its sender within
            // ~one buffer. The drain has its own sub-cap (PCM_DRAIN_CAP, one flat deadline so a
            // trickle of chunks can't extend it) so the flush/stop frames below always run under
            // the remaining DRAIN_WRITE_DEADLINE budget. Saved (when recording) like the flush tail
            // below: the end-of-stream sliver isn't speech-gated.
            let pcm_deadline = tokio::time::Instant::now() + PCM_DRAIN_CAP;
            loop {
                let chunk = match tokio::time::timeout_at(pcm_deadline, pcm_rx.recv()).await {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("[stream] capture thread did not close the PCM channel within {PCM_DRAIN_CAP:?} — sending flush/stop without the remaining tail");
                        break;
                    }
                };
                let bytes = resampler.push(&chunk);
                if !bytes.is_empty() {
                    if saving {
                        save_capped(&mut saved, &bytes, &mut saved_capped);
                    }
                    let _ = write.send(Message::Binary(bytes.into())).await;
                }
            }
            // Flush the resampler's buffered tail (< one input block — ~21 ms at 48 kHz) before asking the
            // server to finalize, so the final sliver of audio isn't dropped from the transcript
            // (or the saved recording). The trailing zeros resample to a soft decay, not a click.
            let tail = resampler.flush();
            if !tail.is_empty() {
                if saving {
                    save_capped(&mut saved, &tail, &mut saved_capped);
                }
                let _ = write.send(Message::Binary(tail.into())).await;
            }
            let _ = write.send(text_msg(json!({"type":"flush"}).to_string())).await;
            let _ = write.send(text_msg(json!({"type":"stop"}).to_string())).await;
        })
        .await
        .is_err()
        {
            tracing::warn!("[stream] drain write deadline ({DRAIN_WRITE_DEADLINE:?}) elapsed — audio tail may be incomplete");
        }
        // Read the remaining finals with an idle window that every server frame
        // RESETS — the `loading` keepalives a cold model load emits every ~3 s
        // count, so an arbitrarily long load can't get the finished transcript
        // discarded (a 10 s flat deadline used to fire seconds before large-v3
        // finished loading). The window must comfortably exceed a slow finalize
        // decode (VPN latency + a busy GPU queue beat the old 6 s repeatedly).
        // First-frame window is 30 s when the WHOLE session was silent: an old
        // backend without keepalives cold-loads without a byte on the wire.
        // A dead socket doesn't ride any of this — the reader task surfaces the
        // close/error as `Closed` and the drain exits immediately. The UI-side
        // stuck-finalize watchdog (STUCK_FINALIZE_MS, streaming.ts) re-arms on
        // the same keepalives, so the two stay ordered: watchdog > idle window.
        let mut saw_frame = partials_seen > 0;
        let timed_out = loop {
            let idle = if saw_frame {
                Duration::from_secs(10)
            } else {
                Duration::from_secs(30)
            };
            // Clips the writer saves meanwhile go straight out, and are no server frame: they
            // don't reset the idle window.
            let next = tokio::time::timeout(idle, async {
                loop {
                    tokio::select! {
                        from = evt_rx.recv() => break from,
                        Some(clip) = recv_clip(&mut clip_rx) => on_event(clip),
                    }
                }
            })
            .await;
            match next {
                Err(_) => break true, // silence — dead or half-open
                Ok(None) | Ok(Some(FromReader::Closed)) => break false,
                Ok(Some(FromReader::Event(e))) => {
                    saw_frame = true;
                    forward_saved(
                        e,
                        save_dir,
                        &detached.discard,
                        &mut saved,
                        &mut clips,
                        &mut transcript_docs,
                        &mut transcript_cur,
                        &on_event,
                    );
                }
            }
        };
        if timed_out {
            // The one silent-transcript-loss path left: the server never sent its
            // finals (or its close) within the deadline. Say so loudly — this line
            // is the difference between a diagnosable report and a mystery.
            tracing::warn!(
                "[stream] drain idle window hit ({}) — no frame from the server; pending transcript discarded",
                if saw_frame { "10s since the last frame" } else { "30s, nothing all session" }
            );
            // Surface it too: a bare `Closed` reads as a clean close in the UI, so the last
            // phrase would vanish silently. A WARNING, not an `Error`: everything committed
            // before the timeout is good, and the UI's error path would skip the normal close
            // tail (no stop-mode insert, no pending phrase-end Enter) for one slow final.
            on_event(StreamEvent::Incomplete(
                "The server did not finish the transcript in time; the last phrase may be missing."
                    .into(),
            ));
        }
    }

    // A live-phase write failed: the reader's read-side error may not be queued yet, and the
    // non-blocking drain below + the reader abort would then end the session with a bare
    // `Closed` — which the UI treats as a normal server close, hiding the lost connection.
    // Give the reader a short bounded wait for its terminal message; emit the error ourselves
    // only when it neither reported one nor closed cleanly (a server Close frame followed by a
    // failed write stays the quiet server-initiated close the live `Closed` arm keeps).
    if let Some(msg) = write_failed {
        const WRITE_FAIL_GRACE: Duration = Duration::from_millis(500);
        let deadline = tokio::time::Instant::now() + WRITE_FAIL_GRACE;
        let mut saw_error = false;
        let mut reader_closed = false;
        while let Ok(from) = tokio::time::timeout_at(deadline, evt_rx.recv()).await {
            match from {
                Some(FromReader::Event(e)) => {
                    saw_error |= matches!(e, StreamEvent::Error(_));
                    forward_saved(
                        e,
                        save_dir,
                        &detached.discard,
                        &mut saved,
                        &mut clips,
                        &mut transcript_docs,
                        &mut transcript_cur,
                        &on_event,
                    );
                }
                Some(FromReader::Closed) | None => {
                    reader_closed = true;
                    break;
                }
            }
        }
        if !saw_error && !reader_closed {
            on_event(StreamEvent::Error(super::bounded_server_text(
                &format!("stream connection lost ({msg})"),
                super::MAX_ERROR_TEXT,
            )));
        }
    }

    // Drain any events the reader task queued while the main loop was exiting
    // (a write error can break the loop while a `Final` is already in the
    // channel). Without this, a mid-session socket death silently drops the
    // last phrase the server finished.
    while let Ok(FromReader::Event(e)) = evt_rx.try_recv() {
        forward_saved(
            e,
            save_dir,
            &detached.discard,
            &mut saved,
            &mut clips,
            &mut transcript_docs,
            &mut transcript_cur,
            &on_event,
        );
    }

    // We own the write half; the reader owns the read half. Once draining is done,
    // drop (= abort) the reader so it can't linger after we return.
    drop(reader);
    // The drain's one decision point: every clip cut is done, so retire this session's slot and
    // read the Cancel under its lock (see `session::settle_detached_stream`).
    let discarded = crate::session::settle_detached_stream(&detached);

    if let Some(c) = clips.as_mut().filter(|c| c.cut_any) {
        // Per-utterance clips: the last one's text is complete now, and what is still
        // buffered belongs to no `final` (see ClipCutter's leftover rule).
        c.flush_txt(&transcript_cur);
        if !saved.is_empty() {
            tracing::info!(
                "[stream] dropped {} ms of audio after the last utterance's clip",
                pcm_duration_ms(saved.len())
            );
        }
        // Let the writer finish (that last `.txt` included) and forward every clip it saved, so
        // the UI's close tail sees them all before `Closed`. Awaited: a slow disk parks no worker.
        drop(clips);
        if let Some(rx) = clip_rx.as_mut() {
            while let Some(clip) = rx.recv().await {
                on_event(clip);
            }
        }
    } else if discarded {
        if save_dir.is_some() && !saved.is_empty() {
            tracing::info!(
                "[stream] cancelled after stop — {} ms recording discarded",
                pcm_duration_ms(saved.len())
            );
        }
    } else if let Some(dir) = save_dir {
        // Skip empties (a quick tap that drained without audio, or a session the silence-trim
        // reduced to nothing). Emit the saved path so the client can label it with the transcript.
        if !saved.is_empty() {
            // On the blocking pool: up to MAX_RECORD_PCM_BYTES plus an fsync and the sidecar, and
            // a recordings folder on a sleeping disk or an offline share must not park a runtime
            // worker (the rule 27d8bdd applied to the batch path's media copy).
            let dir = dir.to_path_buf();
            let wrote = tokio::task::spawn_blocking(move || {
                let path = crate::audio::save_recording(&dir, &saved, 16_000)?;
                // Label the .wav with the session transcript IN RUST (ungated), so a superseded
                // recording still gets its sibling .txt (a Cancel after stop discards it above,
                // matching the batch path).
                // The last document goes through bank_doc, under the Boundary arm's budget.
                bank_doc(&mut transcript_docs, &transcript_cur);
                let transcript = transcript_docs.join("\n");
                if !transcript.is_empty() {
                    crate::audio::save_transcript_sidecar(&path, &transcript);
                }
                Some((path, pcm_duration_ms(saved.len())))
            })
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("[stream] saving the recording failed: {e}");
                None
            });
            if let Some((path, duration_ms)) = wrote {
                on_event(StreamEvent::RecordingSaved {
                    path: path.to_string_lossy().into_owned(),
                    utterance: None,
                    duration_ms,
                });
            }
        }
    }
    on_event(StreamEvent::Closed);
}

/// Aborts the wrapped task when dropped — including when the owning future is itself aborted
/// or dropped mid-await, which a bare `JoinHandle` would turn into a silent detach.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Append to the saved recording copy, stopping at `MAX_RECORD_PCM_BYTES` (4 h). Only the copy
/// stops growing: the audio still streams, so the live transcript is unaffected. Warns once.
fn save_capped(saved: &mut Vec<u8>, bytes: &[u8], capped: &mut bool) {
    if !crate::audio::push_pcm_capped(saved, bytes) && !*capped {
        *capped = true;
        tracing::warn!(
            "[stream] saved recording reached the {} MB cap (4 h) — the rest of this session is transcribed but not kept",
            crate::audio::MAX_RECORD_PCM_BYTES / 1_000_000
        );
    }
}

/// Fold one server event into the saved recording (when saving), then forward it. The clip
/// cutter sees the transcript BEFORE the event is folded in.
///
/// The clip's disk work (the `.wav` and the previous clip's `.txt`) is queued to the
/// [`ClipWriter`] only AFTER the event is forwarded, so the client already holds the utterance's
/// record when the clip's path arrives; a recordings folder on a sleeping disk or an offline share
/// held the utterance's own `Final` — the phrase shown and typed — behind the spin-up or the share
/// timeout, and, written inline, every later phrase too.
#[allow(clippy::too_many_arguments)]
fn forward_saved<F: Fn(StreamEvent)>(
    e: StreamEvent,
    save_dir: Option<&std::path::Path>,
    discard: &AtomicBool,
    saved: &mut Vec<u8>,
    clips: &mut Option<ClipCutter>,
    docs: &mut Vec<String>,
    current: &mut String,
    on_event: &F,
) {
    let mut io = ClipIo::default();
    if save_dir.is_some() {
        if let Some(c) = clips.as_mut() {
            // A Cancel after stop (see `StreamParams::detached`) cuts no further clip, but the
            // transcript still folds in, so the clip already kept gets its complete `.txt`.
            io = if discard.load(Ordering::SeqCst) {
                c.observe_discarded(&e, current)
            } else {
                c.observe(&e, saved, current)
            };
        }
        accumulate_transcript(&e, docs, current);
    }
    on_event(e);
    if let Some(c) = clips.as_ref() {
        c.queue(io);
    }
}

/// Playback length of 16 kHz mono s16le PCM (32 bytes per ms).
fn pcm_duration_ms(bytes: usize) -> u64 {
    (bytes / 32) as u64
}

/// Take the first `cut` bytes off `saved` (clamped, and rounded down to a whole sample) and
/// return them; the rest stays buffered.
fn split_at_cut(saved: &mut Vec<u8>, cut: usize) -> Vec<u8> {
    let rest = saved.split_off(cut.min(saved.len()) & !1);
    std::mem::replace(saved, rest)
}

/// File stem of one utterance's clip: `dictation-<session stamp>-u<ordinal>`. Keeps the
/// `dictation-` prefix, so retention and delete-all own it like the session file.
fn clip_stem(stamp: &str, utterance: u32) -> String {
    format!("dictation-{stamp}-u{utterance}")
}

/// Per-utterance recording clips (`StreamParams::per_utterance_clips`). The saved buffer is
/// cut where the server began decoding an utterance (`utterance: decoding`), and that head is
/// written at the utterance's `final` (all of the buffer when no decoding mark came), then
/// drained — memory holds at most the utterance in flight, and a crash loses at most that one.
/// A `dropped` utterance's audio is discarded up to its mark (the server found no words in it),
/// or all buffered audio when it had none (the server's no-speech gate drops without decoding).
///
/// Leftover rule: audio still buffered at close belongs to no `final` — the speech gate's tail
/// after the last decode mark (the server finalizes the utterance in flight on close, so it is
/// silence in practice) — and is dropped with a logged length. A session whose server sent no
/// ordinal `final` at all (a backend that predates the ordinal) cut nothing and falls back to
/// the single session file.
///
/// A clip's `.txt` is written once its text is complete — at the next ordinal `final`, a hard
/// break, or close — because a release `final` (no ordinal) can still append held-back words.
///
/// The cutting is in memory and synchronous; the files are written by the session's
/// [`ClipWriter`] thread, in order, so a recordings folder on a sleeping disk or an offline share
/// never holds the session loop (the next phrase, the audio upload, the keepalive, the Stop).
struct ClipCutter {
    /// Session offset of `saved[0]`: the bytes already written out or dropped.
    taken: usize,
    /// Decode marks: (utterance, session offset where its audio ends).
    marks: Vec<(u32, usize)>,
    /// An ordinal `final` cut a clip this session (decides the close-time fallback).
    cut_any: bool,
    /// The document offset the last clip's text starts at, awaiting its `.txt`.
    pending_txt: Option<usize>,
    /// The writer's queue. Dropping the cutter closes it: the writer finishes what is queued,
    /// then exits and closes the clip channel [`Self::new`] returned.
    jobs: std::sync::mpsc::Sender<ClipIo>,
}

/// The disk work one event leaves for after it is forwarded (see [`forward_saved`]).
#[derive(Default)]
struct ClipIo {
    /// The previous clip's finished text, for the `.txt` beside its `.wav`.
    txt: Option<String>,
    /// This utterance's clip: its ordinal and the cut PCM.
    clip: Option<(u32, Vec<u8>)>,
}

/// Writes one session's clips on its own thread, in queue order, and sends each clip's
/// `RecordingSaved` back to the session loop. It owns the clip paths: a `.txt` belongs to the last
/// `.wav` actually written, so a failed `.wav` takes its text with it, as before the move.
struct ClipWriter {
    dir: PathBuf,
    stamp: String,
    /// The last clip written, awaiting its `.txt`.
    pending: Option<PathBuf>,
    saved: mpsc::UnboundedSender<StreamEvent>,
}

impl ClipWriter {
    /// The previous clip's `.txt`, then this utterance's `.wav`.
    fn write(&mut self, io: ClipIo) {
        if let Some(text) = io.txt {
            if let Some(path) = self.pending.take() {
                crate::audio::save_transcript_sidecar(&path, &text);
            }
        }
        let Some((n, pcm)) = io.clip else { return };
        self.pending =
            crate::audio::save_recording_as(&self.dir, &clip_stem(&self.stamp, n), &pcm, 16_000);
        if let Some(path) = &self.pending {
            let _ = self.saved.send(StreamEvent::RecordingSaved {
                path: path.to_string_lossy().into_owned(),
                utterance: Some(n),
                duration_ms: pcm_duration_ms(pcm.len()),
            });
        }
    }
}

impl ClipCutter {
    /// A cutter and its writer thread for clips in `dir`. The receiver yields each clip's
    /// `RecordingSaved`, in order, and closes once the cutter is dropped and every queued write
    /// (the close-time `.txt` included) is done.
    fn new(dir: &std::path::Path) -> (Self, mpsc::UnboundedReceiver<StreamEvent>) {
        let (jobs, queue) = std::sync::mpsc::channel::<ClipIo>();
        let (saved, saved_rx) = mpsc::unbounded_channel();
        let mut writer = ClipWriter {
            dir: dir.to_path_buf(),
            stamp: crate::audio::recording_stamp(),
            pending: None,
            saved,
        };
        // A plain thread, not the blocking pool: it lives as long as the session (hours, hands-free).
        if let Err(e) = std::thread::Builder::new()
            .name("clip-writer".into())
            .spawn(move || queue.iter().for_each(|io| writer.write(io)))
        {
            tracing::warn!("[stream] could not start the clip writer — no clips are kept: {e}");
        }
        let cutter = Self {
            taken: 0,
            marks: Vec::new(),
            cut_any: false,
            pending_txt: None,
            jobs,
        };
        (cutter, saved_rx)
    }

    /// Act on one event; `doc` is the transcript BEFORE the event is folded in. Cuts the buffer
    /// in memory and returns the files to write — [`Self::queue`] hands them to the writer once
    /// the event is forwarded.
    fn observe(&mut self, e: &StreamEvent, saved: &mut Vec<u8>, doc: &str) -> ClipIo {
        let mut io = ClipIo::default();
        match e {
            StreamEvent::Utterance {
                state: UtteranceState::Decoding,
                utterance: Some(n),
            } => self.marks.push((*n, self.taken + saved.len())),
            StreamEvent::Utterance {
                state: UtteranceState::Dropped,
                utterance: Some(n),
            } => {
                // The server's no-speech gate drops without decoding, so no mark came: the
                // burst is everything buffered (else it heads the next utterance's clip).
                let end = self.take_mark(*n).unwrap_or(self.taken + saved.len());
                let gone = split_at_cut(saved, end.saturating_sub(self.taken)).len();
                self.taken += gone;
                if gone > 0 {
                    tracing::info!(
                        "[stream] utterance {n} dropped — discarded {} ms of its audio",
                        pcm_duration_ms(gone)
                    );
                }
            }
            // Not the closing final: the server stamps it with the NEXT ordinal (its utterance
            // counter has already advanced) though no such utterance was announced. Cutting on it
            // flushed the previous clip's `.txt` before that final's released words folded in and
            // wrote the ungated drain tail as an orphan clip; the close-time flush covers it.
            StreamEvent::Final {
                utterance: Some(n),
                last: false,
                ..
            } => {
                // The previous clip's text ends here: this final opens the next utterance's.
                io.txt = self.take_txt(doc);
                self.cut_any = true;
                let cut = self
                    .take_mark(*n)
                    .map_or(saved.len(), |end| end.saturating_sub(self.taken));
                let pcm = split_at_cut(saved, cut);
                self.taken += pcm.len();
                self.pending_txt = Some(doc.len());
                io.clip = Some((*n, pcm));
            }
            StreamEvent::Boundary { .. } => io.txt = self.take_txt(doc),
            _ => {}
        }
        io
    }

    /// Hand what [`Self::observe`] planned to the writer thread.
    fn queue(&self, io: ClipIo) {
        if io.txt.is_some() || io.clip.is_some() {
            let _ = self.jobs.send(io);
        }
    }

    /// [`Self::observe`] for a drain a Cancel after stop discarded: no clip is cut, but the kept
    /// clip's text still ends where `observe` would have ended it — at the next utterance's
    /// ordinal `final` or a hard break — so a later utterance's words never land in its `.txt`.
    fn observe_discarded(&mut self, e: &StreamEvent, doc: &str) -> ClipIo {
        let ends = matches!(
            e,
            StreamEvent::Final {
                utterance: Some(_),
                last: false,
                ..
            } | StreamEvent::Boundary { .. }
        );
        ClipIo {
            txt: if ends { self.take_txt(doc) } else { None },
            clip: None,
        }
    }

    /// The decode mark of utterance `n`, retiring it and any older ones.
    fn take_mark(&mut self, n: u32) -> Option<usize> {
        let end = self.marks.iter().find(|(u, _)| *u == n).map(|&(_, e)| e);
        self.marks.retain(|(u, _)| *u > n);
        end
    }

    /// The pending clip's text, retired: everything the document gained since its `final` began.
    fn take_txt(&mut self, doc: &str) -> Option<String> {
        self.pending_txt
            .take()
            .map(|start| doc.get(start..).unwrap_or("").to_string())
    }

    /// Queue the pending clip's `.txt` now (at close).
    fn flush_txt(&mut self, doc: &str) {
        let txt = self.take_txt(doc);
        self.queue(ClipIo { txt, clip: None });
    }
}

/// The next clip the writer saved; never resolves for a session that keeps no clips.
async fn recv_clip(rx: &mut Option<mpsc::UnboundedReceiver<StreamEvent>>) -> Option<StreamEvent> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Fold a stream event into the running session transcript (for the saved-recording `.txt` sidecar),
/// mirroring the frontend's per-hard-break archive: a `Final` replaces the current document with
/// `committed + tail`; a `Boundary` banks the (trimmed, non-empty) current document and resets it.
fn accumulate_transcript(e: &StreamEvent, docs: &mut Vec<String>, current: &mut String) {
    match e {
        StreamEvent::Final {
            committed, tail, ..
        } => {
            current.clear();
            current.push_str(committed);
            current.push_str(tail);
        }
        StreamEvent::Boundary { .. } => {
            bank_doc(docs, current);
            current.clear();
        }
        _ => {}
    }
}

/// Bank one finished document (trimmed, non-empty) into the session transcript. The ONE push
/// site for both a hard break and the end of the drain, so the budget cannot drift between them
/// again. Total-size budget across the whole session: each field is capped at MAX_TRANSCRIPT,
/// but the number of banked documents was not, so a server looping final/boundary grew this
/// without limit and `join("\n")` then allocated the whole thing a second time before writing it
/// under the user's recordings directory. Only the `.txt` sidecar clips: the `.wav` and the text
/// actually typed are untouched, and 8 MiB is well over a million words.
fn bank_doc(docs: &mut Vec<String>, doc: &str) {
    let trimmed = doc.trim();
    let banked: usize = docs.iter().map(|d| d.len()).sum();
    if !trimmed.is_empty() && banked + trimmed.len() <= MAX_SIDECAR_BYTES {
        docs.push(trimmed.to_string());
    }
}

/// What one server text frame means for the reader's lifetime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    Continue,
    /// The last `final`. NOT terminal for the reader: the `captured` frame for that
    /// utterance is written AFTER it (see `FromReader`), and a reader that stopped here
    /// never read the last phrase's receipt — the frontend then parked its inject queue
    /// for the full CAPTURE_ID_WAIT_MS on every session.
    LastFinal,
    /// `closing` — the server is done.
    Closing,
}

/// Parse one server text frame, emit the matching event, and classify it.
fn emit_message<F: Fn(StreamEvent)>(text: &str, on_event: &F) -> Frame {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Frame::Continue;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("ready") => {
            on_event(StreamEvent::Ready {
                // Bounded here, at the parse boundary, like its neighbours `separator` and
                // `message`: the BATCH sibling caps this same list at 50 × 200 chars, but the
                // streaming arm forwarded it whole to `stream://overrides-ignored`, where Home
                // renders `join(", ")` in a wrapping span. The only other ceiling was tungstenite's
                // 64 MiB frame limit — one `ready` frame froze the main window.
                overrides_ignored: bounded_str_vec_field(&v, "overrides_ignored"),
            });
            Frame::Continue
        }
        Some("partial") => {
            on_event(StreamEvent::Partial {
                committed: bounded(str_field(&v, "committed"), MAX_TRANSCRIPT),
                pending: bounded(str_field(&v, "pending"), MAX_TRANSCRIPT),
            });
            Frame::Continue
        }
        Some("final") => {
            let last = v.get("last").and_then(|b| b.as_bool()).unwrap_or(false);
            on_event(StreamEvent::Final {
                committed: bounded(str_field(&v, "committed"), MAX_TRANSCRIPT),
                tail: bounded(str_field(&v, "tail"), MAX_TRANSCRIPT),
                last,
                utterance: ordinal_field(&v, "utterance"),
            });
            if last {
                Frame::LastFinal
            } else {
                Frame::Continue
            }
        }
        Some("boundary") => {
            on_event(StreamEvent::Boundary {
                separator: bounded(str_field(&v, "separator"), MAX_SEPARATOR),
            });
            Frame::Continue
        }
        Some("captured") => {
            // Server-authored id; bounded at the parse boundary like every
            // other string here, and it only ever travels back out as an
            // opaque field on the next translate request.
            let id = bounded(str_field(&v, "id"), 64);
            if !id.is_empty() {
                on_event(StreamEvent::Captured {
                    id,
                    utterance: ordinal_field(&v, "utterance"),
                });
            }
            Frame::Continue
        }
        Some("error") => {
            // Defanged, not merely truncated: this string is rendered in the error banner and in
            // the always-on-top overlay, and the log copy's own fold is Cc-only — so the bidi and
            // invisible-format class survived into the sentence the user reads to judge a failed
            // dictation. NOT applied to the `separator` above: separators are legitimately "\n"
            // and are typed as Enter, so folding controls to spaces would silently turn every
            // hard break into a space.
            on_event(StreamEvent::Error(super::bounded_server_text(
                str_field(&v, "message"),
                super::MAX_ERROR_TEXT,
            )));
            Frame::Continue
        }
        Some("loading") => {
            on_event(StreamEvent::Loading);
            Frame::Continue
        }
        Some("utterance") => {
            // A state this build doesn't know is ignored, not guessed at: the
            // protocol's must-ignore rule applies to the value as much as to
            // the frame type, and a fallback here would be a UI state change
            // nobody asked for.
            if let Some(state) = UtteranceState::parse(str_field(&v, "state")) {
                on_event(StreamEvent::Utterance {
                    state,
                    utterance: ordinal_field(&v, "utterance"),
                });
            }
            Frame::Continue
        }
        Some("closing") => Frame::Closing,
        _ => Frame::Continue,
    }
}

/// Ceiling on ONE transcript field. These four were the last fields on this socket with no bound
/// at all — their neighbours (`separator`, `message`, `overrides_ignored`) are all capped here —
/// and tungstenite's 64 MiB limit is PER MESSAGE, so it bounds nothing cumulative. They reach two
/// sinks: a cross-window IPC emit plus an overlay re-render on every frame, and `injectText`,
/// which on direct-typing synthesizes them key by key into whatever window has focus.
///
/// `bounded` and NOT `bounded_server_text`: a transcript legitimately contains newlines, and
/// folding controls to spaces would destroy every hard break. Sized for headroom rather than
/// thrift — an hour of continuous dictation is roughly 50 KB, and `final.committed` is the whole
/// document so far and grows across a hands-free session, so 4 MiB is a whole working week of speech.
pub(crate) const MAX_TRANSCRIPT: usize = 4 * 1024 * 1024;

/// Ceiling on the whole saved-transcript sidecar for one session. Applies ONLY to the `.txt`
/// written beside a kept recording — never to what is typed, and never to file transcription
/// in the Transcribe tab, which takes a different path and writes no sidecar.
const MAX_SIDECAR_BYTES: usize = 8 * 1024 * 1024;

/// A `boundary` separator is a delimiter — " ", "\n", "\n\n", ". " — but the server prefixes the
/// open document's output suffix to it, and that suffix may be 512 chars (the `output_suffix`
/// decode key's and OUTPUT_SUFFIX's limit) ahead of a hard-break separator of up to 8. The
/// frontend types it as keystrokes into the focused window, so it stays bounded — at that sum, so
/// a long suffix is not cut differently at a break than inside `final.committed` at the end.
const MAX_SEPARATOR: usize = 512 + 8;

/// First `n` chars of a server-supplied string. Char-indexed, so it can't split a UTF-8 sequence.
pub(crate) fn bounded(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// A server-supplied non-negative ordinal, or None when absent, negative or
/// oversized. Absence is kept EXPLICIT: 0 is a real ordinal (the first
/// utterance), so mapping "no field" onto it would key every phrase of an older
/// backend onto one slot — the positional mis-pairing the ordinal exists to end.
/// The client pairs nothing for None, which is the best-effort behaviour an
/// older backend already gets.
fn ordinal_field(v: &serde_json::Value, key: &str) -> Option<u32> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .and_then(|n| u32::try_from(n).ok())
}

fn str_field<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// A server-supplied string LIST, held to the same ceiling the batch path applies to this data:
/// [`MAX_NOTICES`] entries of [`crate::transport::MAX_ERROR_TEXT`] chars, control chars folded.
fn bounded_str_vec_field(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_str())
                .take(super::MAX_NOTICES)
                .map(|s| crate::transport::bounded_server_text(s, crate::transport::MAX_ERROR_TEXT))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod display_url_tests {
    use super::display_url;

    #[test]
    fn strips_userinfo_including_a_slash_in_the_password() {
        // A `/` in the password moved the authority split left, so the strip found no `@` and the
        // credentials were printed verbatim into the message AND the log.
        assert_eq!(display_url("wss://user:secret@host/v1/x"), "wss://host");
        assert_eq!(display_url("wss://a@b@host/v1"), "wss://host");
        // Ambiguous: the `/` moved the authority boundary into the password, so refuse entirely
        // rather than print the fragment `user:p` the old form leaked.
        let amb = display_url("wss://user:p/ss@host/v1/x");
        assert!(!amb.contains("user"), "{amb}");
    }

    #[test]
    fn does_not_let_a_query_or_backslash_rename_the_host() {
        // `?`/`#`/`\` end the authority for the real parsers, so they must end it here too — else
        // the message names a host the connection never used.
        assert!(!display_url("wss://real.host?x=@fake.host/v1").contains("fake.host"));
        assert!(!display_url("wss://evil.tld\\@trusted.tld/v1").contains("trusted.tld"));
    }

    #[test]
    fn keeps_ordinary_urls_and_ipv6_intact() {
        assert_eq!(display_url("wss://host:8000/v1/x"), "wss://host:8000");
        assert_eq!(display_url("wss://[::1]:8000/v1/x"), "wss://[::1]:8000");
        assert_eq!(display_url("host:8000"), "host:8000");
    }
}

#[cfg(test)]
mod http_to_ws_tests {
    use super::http_to_ws;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    #[test]
    fn an_idn_host_or_a_spaced_path_yields_a_url_the_handshake_accepts() {
        // reqwest (Test connection, batch, sync) sends to the punycoded / percent-encoded form;
        // the handshake's `http::Uri` takes ASCII only, so the raw string failed every dictation.
        let idn = http_to_ws("https://bücher.example:8000");
        assert_eq!(
            idn,
            "wss://xn--bcher-kva.example:8000/v1/audio/transcriptions/stream"
        );
        assert!(idn.as_str().into_client_request().is_ok(), "{idn}");
        let spaced = http_to_ws("http://host/my path/");
        assert_eq!(spaced, "ws://host/my%20path/v1/audio/transcriptions/stream");
        assert!(spaced.as_str().into_client_request().is_ok(), "{spaced}");
    }

    #[test]
    fn plain_ascii_urls_are_unchanged() {
        assert_eq!(
            http_to_ws("HTTP://host:8000/"),
            "ws://host:8000/v1/audio/transcriptions/stream"
        );
        assert_eq!(
            http_to_ws("https://u:p@10.0.0.2:8443/base"),
            "wss://u:p@10.0.0.2:8443/base/v1/audio/transcriptions/stream"
        );
        assert_eq!(
            http_to_ws("host:8000"),
            "ws://host:8000/v1/audio/transcriptions/stream"
        );
    }
}

#[cfg(test)]
mod handshake_auth_tests {
    use super::handshake_auth_headers;

    fn auth(ws_url: &str, key: Option<&str>) -> Vec<String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        handshake_auth_headers(ws_url, key)
            .unwrap()
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_url_login_goes_first_as_basic_then_the_key() {
        // Same order `with_auth` gives the HTTP routes: a basic-auth proxy reads the first header.
        assert_eq!(auth("wss://u:p@h/x", Some("k")), ["Basic dTpw", "Bearer k"]);
        assert_eq!(auth("ws://u:p@h:8000/x", None), ["Basic dTpw"]);
        assert_eq!(auth("wss://u:p@h/x", Some("")), ["Basic dTpw"]);
        // Percent-encoded user and password are decoded before the base64, as reqwest does.
        assert_eq!(
            auth("wss://us%40er:p%3Ass@h/x", None),
            ["Basic dXNAZXI6cDpzcw=="]
        );
        assert_eq!(auth("wss://:p@h/x", None), ["Basic OnA="]);
    }

    #[test]
    fn without_a_login_the_handshake_headers_are_unchanged() {
        assert_eq!(auth("wss://h/x", Some("k")), ["Bearer k"]);
        assert!(auth("wss://h/x", None).is_empty());
        assert!(auth("wss://h/x", Some("")).is_empty());
    }

    #[test]
    fn a_bad_key_is_refused_without_echoing_any_credential() {
        let e = handshake_auth_headers("wss://u:secret@h/x", Some("k\nx")).unwrap_err();
        assert!(e.starts_with("Invalid API key"), "{e}");
        assert!(!e.contains("secret") && !e.contains("k\nx"), "{e}");
    }
}

#[cfg(test)]
mod emit_message_tests {
    use super::{emit_message, Frame, StreamEvent, UtteranceState};
    use std::cell::RefCell;

    /// The `utterance` events one server text frame produces.
    fn utterances(text: &str) -> (Vec<(UtteranceState, Option<u32>)>, Frame) {
        let seen = RefCell::new(Vec::new());
        let frame = emit_message(text, &|e| {
            if let StreamEvent::Utterance { state, utterance } = e {
                seen.borrow_mut().push((state, utterance));
            }
        });
        (seen.into_inner(), frame)
    }

    #[test]
    fn the_three_known_states_are_forwarded_with_their_ordinal() {
        for (wire, state) in [
            ("open", UtteranceState::Open),
            ("decoding", UtteranceState::Decoding),
            ("dropped", UtteranceState::Dropped),
        ] {
            let (seen, frame) = utterances(&format!(
                r#"{{"type":"utterance","utterance":7,"state":"{wire}","reason":"empty"}}"#
            ));
            assert_eq!(seen, vec![(state, Some(7))], "{wire}");
            assert!(
                frame == Frame::Continue,
                "{wire}: an utterance frame never ends the reader"
            );
        }
    }

    #[test]
    fn a_state_this_build_does_not_know_is_ignored_not_guessed() {
        // Must-ignore applies to the VALUE too: the server may grow states, and any
        // fallback here would be a UI state change nobody asked for.
        for text in [
            r#"{"type":"utterance","utterance":1,"state":"paused"}"#,
            r#"{"type":"utterance","utterance":1}"#,
            r#"{"type":"utterance","utterance":1,"state":7}"#,
        ] {
            let (seen, frame) = utterances(text);
            assert!(seen.is_empty(), "{text}");
            assert!(frame == Frame::Continue, "{text}");
        }
    }

    #[test]
    fn a_missing_or_bogus_ordinal_stays_explicitly_absent() {
        let (seen, _) = utterances(r#"{"type":"utterance","state":"open"}"#);
        assert_eq!(seen, vec![(UtteranceState::Open, None)]);
        let (seen, _) = utterances(r#"{"type":"utterance","state":"open","utterance":-3}"#);
        assert_eq!(seen, vec![(UtteranceState::Open, None)]);
    }

    #[test]
    fn a_boundary_separator_carrying_a_long_output_suffix_is_forwarded_whole() {
        // The server sends `suffix + separator`; a 46-char suffix plus "\n\n" must not lose its
        // tail or the newlines, or the next document is typed glued onto a cut suffix.
        let separator = " -- dictated on my laptop, please excuse typos\n\n";
        let text = serde_json::json!({ "type": "boundary", "separator": separator }).to_string();
        let seen = RefCell::new(Vec::new());
        let frame = emit_message(&text, &|e| {
            if let StreamEvent::Boundary { separator } = e {
                seen.borrow_mut().push(separator);
            }
        });
        assert_eq!(seen.into_inner(), vec![separator.to_string()]);
        assert!(frame == Frame::Continue);
    }
}

#[cfg(test)]
mod clip_tests {
    use super::{clip_stem, forward_saved, split_at_cut, ClipCutter, StreamEvent, UtteranceState};
    use std::cell::RefCell;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::mpsc::UnboundedReceiver;

    #[test]
    fn a_cut_is_clamped_and_sample_aligned() {
        let mut saved = vec![1, 2, 3, 4, 5, 6];
        assert_eq!(split_at_cut(&mut saved, 3), [1, 2]);
        assert_eq!(saved, [3, 4, 5, 6]);
        assert_eq!(split_at_cut(&mut saved, 99), [3, 4, 5, 6]);
        assert!(saved.is_empty());
    }

    #[test]
    fn clip_names_stay_inside_retention() {
        let stem = clip_stem("2026-10-05_09-15-00", 7);
        assert_eq!(stem, "dictation-2026-10-05_09-15-00-u7");
        assert!(crate::audio::is_dictation_file(&format!("{stem}.wav")));
        assert!(crate::audio::is_dictation_file(&format!("{stem}-2.txt")));
    }

    fn fin(doc: &str, utterance: Option<u32>) -> StreamEvent {
        StreamEvent::Final {
            committed: doc.into(),
            tail: String::new(),
            last: false,
            utterance,
        }
    }

    fn state(state: UtteranceState, n: u32) -> StreamEvent {
        StreamEvent::Utterance {
            state,
            utterance: Some(n),
        }
    }

    /// Close the cutter and collect every clip its writer saved, in order — what the end of `run`
    /// forwards before `Closed`. Returns once the writer is done, the close-time `.txt` included.
    fn finish(
        clips: Option<ClipCutter>,
        mut rx: UnboundedReceiver<StreamEvent>,
    ) -> Vec<(String, Option<u32>, u64)> {
        drop(clips);
        let mut out = Vec::new();
        while let Some(e) = rx.blocking_recv() {
            if let StreamEvent::RecordingSaved {
                path,
                utterance,
                duration_ms,
            } = e
            {
                out.push((path, utterance, duration_ms));
            }
        }
        out
    }

    /// One clip per ordinal final, cut at the decode mark; a release final's words reach the
    /// previous clip's `.txt`; a dropped utterance's audio goes nowhere.
    #[test]
    fn each_utterance_gets_its_own_clip_and_text() {
        let dir = std::env::temp_dir().join(format!("fwf-clips-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut saved = vec![0u8; 64_000]; // 2 s
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let keep = AtomicBool::new(false);
        let mut feed = |e: StreamEvent, saved: &mut Vec<u8>, clips: &mut Option<ClipCutter>| {
            forward_saved(
                e,
                Some(&dir),
                &keep,
                saved,
                clips,
                &mut docs,
                &mut cur,
                &|_| {},
            );
        };
        feed(state(UtteranceState::Decoding, 1), &mut saved, &mut clips);
        saved.extend(vec![0u8; 32_000]); // 1 s after the mark: the next utterance's
        feed(fin(" Hallo Welt", Some(1)), &mut saved, &mut clips);
        assert_eq!(saved.len(), 32_000);
        // A release final: no clip of its own, its words belong to utterance 1.
        feed(fin(" Hallo Welt Komma", None), &mut saved, &mut clips);
        // No decode mark: the clip takes everything buffered.
        feed(
            fin(" Hallo Welt Komma und weiter", Some(2)),
            &mut saved,
            &mut clips,
        );
        assert!(saved.is_empty());
        saved.extend(vec![0u8; 3_200]);
        feed(state(UtteranceState::Decoding, 3), &mut saved, &mut clips);
        feed(state(UtteranceState::Dropped, 3), &mut saved, &mut clips);
        assert!(saved.is_empty());
        clips.as_mut().unwrap().flush_txt(&cur);

        let seen = finish(clips, rx);
        assert_eq!(seen.len(), 2);
        assert_eq!((seen[0].1, seen[0].2), (Some(1), 2_000));
        assert_eq!((seen[1].1, seen[1].2), (Some(2), 1_000));
        let txt = |i: usize| {
            let wav = std::path::Path::new(&seen[i].0);
            let name = wav.file_name().unwrap().to_string_lossy().into_owned();
            assert!(name.ends_with(&format!("-u{}.wav", i + 1)), "{name}");
            std::fs::read_to_string(wav.with_extension("txt")).unwrap()
        };
        assert_eq!(txt(0), "Hallo Welt Komma\n");
        assert_eq!(txt(1), "und weiter\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The phrase is forwarded BEFORE its clip touches the disk: a sleeping recordings disk or an
    /// offline share held the utterance's `Final` (shown and typed) behind the `.wav` write, and a
    /// hard break behind the previous clip's `.txt`. Both files still land, in order, right after.
    #[test]
    fn the_phrase_is_forwarded_before_its_clip_is_written() {
        let dir = std::env::temp_dir().join(format!("fwf-clips-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let files_with = |ext: &str| {
            std::fs::read_dir(&dir).map_or(0, |d| {
                d.filter(|f| {
                    f.as_ref()
                        .is_ok_and(|f| f.path().extension().is_some_and(|x| x == ext))
                })
                .count()
            })
        };
        let seen = RefCell::new(Vec::new());
        let on_event = |e: StreamEvent| {
            let tag = match e {
                StreamEvent::Final { .. } => format!("final wav={}", files_with("wav")),
                StreamEvent::Boundary { .. } => format!("boundary txt={}", files_with("txt")),
                _ => return,
            };
            seen.borrow_mut().push(tag);
        };
        let mut saved = vec![0u8; 32_000];
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let keep = AtomicBool::new(false);
        for e in [
            fin(" Hallo Welt", Some(1)),
            StreamEvent::Boundary {
                separator: "\n".into(),
            },
        ] {
            forward_saved(
                e,
                Some(&dir),
                &keep,
                &mut saved,
                &mut clips,
                &mut docs,
                &mut cur,
                &on_event,
            );
        }
        assert_eq!(seen.into_inner(), ["final wav=0", "boundary txt=0"]);
        assert_eq!(finish(clips, rx).len(), 1);
        assert_eq!(files_with("wav"), 1);
        assert_eq!(
            files_with("txt"),
            1,
            "the hard break still ends the clip's text"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The clip writes leave the session loop: `forward_saved` hands them to the writer thread and
    /// forwards no clip itself (a recordings folder on a sleeping disk or an offline share held
    /// every later phrase, the audio upload and the keepalive behind each write). The writer saves
    /// the clips in order, ends each `.txt` where the next utterance begins, and writes the
    /// close-time `.txt` before its channel closes — so `run` forwards them all before `Closed`.
    #[test]
    fn clip_writes_leave_the_session_loop_and_arrive_in_order() {
        let dir = std::env::temp_dir().join(format!("fwf-clips-writer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let forwarded = RefCell::new(Vec::new());
        let on_event = |e: StreamEvent| {
            forwarded.borrow_mut().push(match e {
                StreamEvent::Final { utterance, .. } => format!("final {utterance:?}"),
                StreamEvent::RecordingSaved { .. } => "saved".into(),
                _ => return,
            });
        };
        let mut saved = Vec::new();
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let keep = AtomicBool::new(false);
        let words = [" eins", " eins zwei", " eins zwei drei"];
        for (i, doc) in words.iter().enumerate() {
            saved.extend(vec![0u8; 3_200 * (i + 1)]);
            forward_saved(
                fin(doc, Some(i as u32 + 1)),
                Some(&dir),
                &keep,
                &mut saved,
                &mut clips,
                &mut docs,
                &mut cur,
                &on_event,
            );
        }
        assert_eq!(
            forwarded.into_inner(),
            ["final Some(1)", "final Some(2)", "final Some(3)"],
            "no clip is written or forwarded inline"
        );
        clips.as_mut().unwrap().flush_txt(&cur);

        let seen = finish(clips, rx);
        let order: Vec<_> = seen.iter().map(|s| (s.1, s.2)).collect();
        assert_eq!(order, [(Some(1), 100), (Some(2), 200), (Some(3), 300)]);
        let texts: Vec<_> = seen
            .iter()
            .map(|s| {
                std::fs::read_to_string(std::path::Path::new(&s.0).with_extension("txt")).unwrap()
            })
            .collect();
        assert_eq!(texts, ["eins\n", "zwei\n", "drei\n"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A Cancel after stop: the draining session cuts no further clip (the batch path's discard),
    /// but the clip already kept still gets its complete `.txt` — the release final's words, and
    /// none of a later utterance's.
    #[test]
    fn a_discarded_drain_cuts_no_clip() {
        let dir = std::env::temp_dir().join(format!("fwf-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut saved = vec![0u8; 64_000];
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let discard = AtomicBool::new(false);
        let mut feed = |e: StreamEvent, saved: &mut Vec<u8>, clips: &mut Option<ClipCutter>| {
            forward_saved(
                e,
                Some(&dir),
                &discard,
                saved,
                clips,
                &mut docs,
                &mut cur,
                &|_| {},
            );
        };
        // Utterance 1 is cut and kept before the Cancel.
        feed(fin(" Hallo Welt", Some(1)), &mut saved, &mut clips);
        assert!(clips.as_ref().unwrap().cut_any);
        discard.store(true, std::sync::atomic::Ordering::SeqCst);
        saved.extend(vec![0u8; 32_000]);
        // The drain's release final still belongs to utterance 1…
        feed(fin(" Hallo Welt Komma", None), &mut saved, &mut clips);
        // …and utterance 2's final ends that text but cuts no clip of its own.
        feed(
            fin(" Hallo Welt Komma und weiter", Some(2)),
            &mut saved,
            &mut clips,
        );
        clips.as_mut().unwrap().flush_txt(&cur);
        assert_eq!(
            cur, " Hallo Welt Komma und weiter",
            "the transcript still folds in"
        );
        let seen = finish(clips, rx);
        assert_eq!(seen.len(), 1, "no clip after the Cancel");
        let wav = std::path::Path::new(&seen[0].0);
        assert_eq!(
            std::fs::read_to_string(wav.with_extension("txt")).unwrap(),
            "Hallo Welt Komma\n"
        );
        let wavs = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|f| {
                f.as_ref()
                    .is_ok_and(|f| f.path().extension().is_some_and(|x| x == "wav"))
            })
            .count();
        assert_eq!(wavs, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A Cancel after stop that lands before any clip was cut: nothing is written at all, and
    /// `cut_any` stays false so the end of `run` takes its discard arm for the session audio.
    #[test]
    fn a_drain_discarded_before_any_clip_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("fwf-discard-early-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut saved = vec![0u8; 64_000];
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let discard = AtomicBool::new(true);
        for e in [
            fin(" Hallo Welt", Some(1)),
            fin(" Hallo Welt und weiter", Some(2)),
        ] {
            forward_saved(
                e,
                Some(&dir),
                &discard,
                &mut saved,
                &mut clips,
                &mut docs,
                &mut cur,
                &|_| {},
            );
        }
        assert!(!clips.as_ref().unwrap().cut_any, "nothing was cut");
        assert_eq!(saved.len(), 64_000, "no audio was split off");
        assert!(finish(clips, rx).is_empty(), "no clip is saved");
        assert!(!dir.exists(), "no file was written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A gate-dropped utterance (no decode mark) takes its buffered burst with it instead of
    /// leaving it at the head of the next utterance's clip.
    #[test]
    fn a_markless_drop_discards_its_burst() {
        let dir = std::env::temp_dir().join(format!("fwf-clips-drop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut saved = vec![0u8; 32_000]; // 1 s of noise the gate ignores
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let keep = AtomicBool::new(false);
        let mut feed = |e: StreamEvent, saved: &mut Vec<u8>, clips: &mut Option<ClipCutter>| {
            forward_saved(
                e,
                Some(&dir),
                &keep,
                saved,
                clips,
                &mut docs,
                &mut cur,
                &|_| {},
            );
        };
        feed(state(UtteranceState::Dropped, 1), &mut saved, &mut clips);
        assert!(saved.is_empty());
        saved.extend(vec![0u8; 16_000]); // 0.5 s
        feed(state(UtteranceState::Decoding, 2), &mut saved, &mut clips);
        feed(fin(" Hallo", Some(2)), &mut saved, &mut clips);
        let seen: Vec<_> = finish(clips, rx).into_iter().map(|s| (s.1, s.2)).collect();
        assert_eq!(seen, vec![(Some(2), 500)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The closing final carries the NEXT (never announced) ordinal: it must not cut an orphan
    /// clip from the drain tail, and its released words still reach the last clip's `.txt`.
    #[test]
    fn the_closing_final_cuts_no_clip() {
        let dir = std::env::temp_dir().join(format!("fwf-clips-last-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut saved = vec![0u8; 32_000];
        let (cutter, rx) = ClipCutter::new(&dir);
        let mut clips = Some(cutter);
        let (mut docs, mut cur) = (Vec::new(), String::new());
        let keep = AtomicBool::new(false);
        let mut feed = |e: StreamEvent, saved: &mut Vec<u8>, clips: &mut Option<ClipCutter>| {
            forward_saved(
                e,
                Some(&dir),
                &keep,
                saved,
                clips,
                &mut docs,
                &mut cur,
                &|_| {},
            );
        };
        feed(state(UtteranceState::Decoding, 1), &mut saved, &mut clips);
        saved.extend(vec![0u8; 3_200]);
        feed(fin(" Hallo Welt", Some(1)), &mut saved, &mut clips);
        saved.extend(vec![0u8; 640]); // the ungated drain/resampler tail
        feed(
            StreamEvent::Final {
                committed: " Hallo Welt Komma".into(),
                tail: String::new(),
                last: true,
                utterance: Some(2),
            },
            &mut saved,
            &mut clips,
        );
        assert!(clips.as_ref().unwrap().cut_any);
        clips.as_mut().unwrap().flush_txt(&cur);

        let seen: Vec<_> = finish(clips, rx).into_iter().map(|s| s.1).collect();
        assert_eq!(seen, vec![Some(1)]);
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!names.iter().any(|n| n.contains("-u2")), "{names:?}");
        let u1 = names.iter().find(|n| n.ends_with("-u1.txt")).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(u1)).unwrap(),
            "Hallo Welt Komma\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
