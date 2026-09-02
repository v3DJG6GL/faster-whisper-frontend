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
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;

/// Events surfaced from the stream (the session maps these to Tauri events).
pub enum StreamEvent {
    /// Handshake accepted. `overrides_ignored` lists client decode overrides the
    /// server refused because the field is admin-locked (empty otherwise).
    Ready { overrides_ignored: Vec<String> },
    Partial { committed: String, pending: String },
    Final { committed: String, tail: String, last: bool, utterance: Option<u32> },
    /// Long-silence hard break: the server reset its document. The client should
    /// reset its injection baseline and optionally type `separator` between docs.
    Boundary { separator: String },
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
    Captured { id: String, utterance: Option<u32> },
    /// The session's audio was saved to this path ("Keep audio recordings" on).
    /// Emitted before `Closed` so the client can link its history record to the
    /// file. Epoch-gated like every other event — a cancelled session's save
    /// never reaches the UI.
    RecordingSaved(String),
    /// Keepalive while the server cold-loads its model (sent every few seconds
    /// until `ready`/the finals). Proof of life — resets the drain's idle
    /// window and the UI's stuck-finalize watchdog.
    Loading,
    Error(String),
    Closed,
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
    pub trim_silence: bool, // when saving: keep only spoken spans (drop silence) in the .wav
}

/// Case-insensitive `strip_prefix` for an ASCII prefix. `s.get(..len)` returns None on a
/// non-char-boundary, so this can't panic.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

/// Derive the streaming WS URL from a profile's http(s) server URL. The scheme match is
/// case-insensitive to mirror reqwest/url's scheme handling: an "HTTP://…" that Test Connection
/// (via reqwest) accepts must yield a valid "ws://…" here, not a malformed "ws://HTTP://…".
pub fn http_to_ws(server_url: &str) -> String {
    let s = server_url.trim().trim_end_matches('/');
    let scheme_swapped = if let Some(rest) = strip_prefix_ci(s, "https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = strip_prefix_ci(s, "http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{s}")
    };
    format!("{scheme_swapped}/v1/audio/transcriptions/stream")
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
    let joined = if scheme.is_empty() { host.to_string() } else { format!("{scheme}://{host}") };
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
            on_event(StreamEvent::Error(m));
            on_event(StreamEvent::Closed);
            return;
        }};
    }

    let mut request = match params.ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => fail!(format!("Invalid stream URL {}: {e}", display_url(&params.ws_url))),
    };
    if let Some(k) = &params.api_key {
        if !k.is_empty() {
            match format!("Bearer {k}").parse() {
                Ok(v) => {
                    request.headers_mut().insert(AUTHORIZATION, v);
                }
                Err(e) => fail!(format!("Invalid API key: {e}")),
            }
        }
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
        if v.as_object().map_or(false, |m| !m.is_empty()) {
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
        if v.as_object().map_or(false, |m| !m.is_empty()) {
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
    // Accumulate the session transcript HERE (Rust) so a saved recording gets its `.txt` sidecar
    // written in the drain — independent of the epoch-gated `recording-saved` emit — exactly like the
    // batch path (transcribe_recording). A session superseded by cancel/suspend would otherwise keep
    // the `.wav` with no `.txt` (the frontend never sees the suppressed emit). Mirrors the frontend's
    // per-hard-break join: `current_doc` is the running document; a Boundary banks it into `docs`.
    let mut transcript_docs: Vec<String> = Vec::new();
    let mut transcript_cur = String::new();
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
    let reader = tokio::spawn(async move {
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
    });

    // Client-initiated keepalive: a little outbound traffic on a regular cadence so a
    // half-open link is noticed promptly (the bounded send times out) even during a
    // silent stretch, and intermediaries keep the connection warm. The server's PINGs
    // are answered by the reader task above.
    const KEEPALIVE: Duration = Duration::from_secs(10);
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                                gate.push(lvl, &bytes, &mut saved);
                            } else if saving {
                                saved.extend_from_slice(&bytes);
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
                                    // socket closed/errored → finish + Closed
                                    tracing::warn!("[stream] audio send failed: {e}");
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
                        if saving { accumulate_transcript(&e, &mut transcript_docs, &mut transcript_cur); }
                        on_event(e);
                    }
                    // Server closed the socket (or the read errored, already surfaced
                    // above) — stop now; not draining, so fall through to Closed.
                    Some(FromReader::Closed) | None => {
                        tracing::warn!("[stream] ws ended mid-session (live phase)");
                        break;
                    }
                }
            }
            _ = keepalive.tick() => {
                match tokio::time::timeout(SEND_TIMEOUT, write.send(Message::Ping(Vec::<u8>::new().into()))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        // socket closed/errored → finish + Closed (reader surfaces it)
                        tracing::warn!("[stream] keepalive send failed: {e}");
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
        if tokio::time::timeout(DRAIN_WRITE_DEADLINE, async {
            // Drain the PCM the capture thread queued but the main loop hadn't consumed when the stop
            // signal won the (non-biased) select — push it through the resampler and send it, so the
            // final tens of ms aren't silently dropped from the transcript. `recv().await` (not a
            // one-shot try_recv) keeps draining until the channel CLOSES, so we also catch the chunks
            // the capture callback enqueues during its own shutdown: finish()/Drop set capture_stop
            // BEFORE ws_stop, so the capture thread is already exiting and drops its sender within
            // ~one buffer; the writes are bounded by DRAIN_WRITE_DEADLINE regardless. Saved (when
            // recording) like the flush tail below: the end-of-stream sliver isn't speech-gated.
            while let Some(chunk) = pcm_rx.recv().await {
                let bytes = resampler.push(&chunk);
                if !bytes.is_empty() {
                    if params.save_dir.is_some() {
                        saved.extend_from_slice(&bytes);
                    }
                    let _ = write.send(Message::Binary(bytes.into())).await;
                }
            }
            // Flush the resampler's buffered tail (< one input block — ~21 ms at 48 kHz) before asking the
            // server to finalize, so the final sliver of audio isn't dropped from the transcript
            // (or the saved recording). The trailing zeros resample to a soft decay, not a click.
            let tail = resampler.flush();
            if !tail.is_empty() {
                if params.save_dir.is_some() {
                    saved.extend_from_slice(&tail);
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
            match tokio::time::timeout(idle, evt_rx.recv()).await {
                Err(_) => break true, // silence — dead or half-open
                Ok(None) | Ok(Some(FromReader::Closed)) => break false,
                Ok(Some(FromReader::Event(e))) => {
                    saw_frame = true;
                    if saving { accumulate_transcript(&e, &mut transcript_docs, &mut transcript_cur); }
                    on_event(e);
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
        }
    }

    // We own the write half; the reader owns the read half. Once draining is done,
    // drop the reader so it can't linger after we return.
    reader.abort();

    if let Some(dir) = &params.save_dir {
        // Skip empties (a quick tap that drained without audio, or a session the silence-trim
        // reduced to nothing). Emit the saved path so the client can label it with the transcript.
        if !saved.is_empty() {
            if let Some(path) = crate::audio::save_recording(dir, &saved, 16_000) {
                // Label the .wav with the session transcript IN RUST (ungated), so a cancelled/
                // superseded recording still gets its sibling .txt — matching the batch path.
                // The same MAX_SIDECAR_BYTES budget the Boundary arm enforces: this end-of-drain
                // flush is the session's OTHER push site, and it had no check, so a server that
                // banked right up to the budget and then sent one last `final` overshot it by a
                // whole MAX_TRANSCRIPT before `join` allocated the lot again.
                let last = transcript_cur.trim();
                let banked: usize = transcript_docs.iter().map(|d| d.len()).sum();
                if !last.is_empty() && banked + last.len() <= MAX_SIDECAR_BYTES {
                    transcript_docs.push(last.to_string());
                }
                let transcript = transcript_docs.join("\n");
                if !transcript.is_empty() {
                    crate::audio::save_transcript_sidecar(&path, &transcript);
                }
                on_event(StreamEvent::RecordingSaved(path.to_string_lossy().into_owned()));
            }
        }
    }
    on_event(StreamEvent::Closed);
}

/// Fold a stream event into the running session transcript (for the saved-recording `.txt` sidecar),
/// mirroring the frontend's per-hard-break archive: a `Final` replaces the current document with
/// `committed + tail`; a `Boundary` banks the (trimmed, non-empty) current document and resets it.
fn accumulate_transcript(e: &StreamEvent, docs: &mut Vec<String>, current: &mut String) {
    match e {
        StreamEvent::Final { committed, tail, .. } => {
            current.clear();
            current.push_str(committed);
            current.push_str(tail);
        }
        StreamEvent::Boundary { .. } => {
            let trimmed = current.trim();
            // Total-size budget across the whole session. Each field is capped at MAX_TRANSCRIPT,
            // but the number of banked documents was not, so a server looping final/boundary grew
            // this without limit and `join("\n")` then allocated the whole thing a second time
            // before writing it under the user's recordings directory. Only the `.txt` sidecar
            // clips: the `.wav` and the text actually typed are untouched, and 8 MiB is well over
            // a million words.
            let banked: usize = docs.iter().map(|d| d.len()).sum();
            if !trimmed.is_empty() && banked + trimmed.len() <= MAX_SIDECAR_BYTES {
                docs.push(trimmed.to_string());
            }
            current.clear();
        }
        _ => {}
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
            if last { Frame::LastFinal } else { Frame::Continue }
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
                on_event(StreamEvent::Captured { id, utterance: ordinal_field(&v, "utterance") });
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

/// A `boundary` separator is a delimiter — " ", "\n", "\n\n", ". ". The frontend types it as
/// keystrokes into the focused window, so the server does not get to make it a payload.
const MAX_SEPARATOR: usize = 32;

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
    v.get(key).and_then(|x| x.as_u64()).and_then(|n| u32::try_from(n).ok())
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
