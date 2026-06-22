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
    Final { committed: String, tail: String, last: bool },
    /// Long-silence hard break: the server reset its document. The client should
    /// reset its injection baseline and optionally type `separator` between docs.
    Boundary { separator: String },
    Error(String),
    Closed,
}

pub struct StreamParams {
    pub ws_url: String,
    pub model: String,
    pub language: String, // "" / "auto" → omit (server auto-detects)
    pub response_format: String, // "json" | "verbose_json"
    // None = omit the field (inherit DEFAULT_PROMPT); Some("") = explicit clear
    // (send no initial_prompt); Some(v) = use v.
    pub prompt: Option<String>,
    pub decode_overrides: Option<serde_json::Value>, // opaque JSON object → handshake "decode_overrides"
    pub override_profile: Option<String>, // server override-profile name → handshake "override_profile"
    pub api_key: Option<String>,
    pub in_rate: u32,
    pub save_dir: Option<PathBuf>, // Some → save the streamed 16 kHz audio as .wav
    pub trim_silence: bool, // when saving: keep only spoken spans (drop silence) in the .wav
}

/// Derive the streaming WS URL from a profile's http(s) server URL.
pub fn http_to_ws(server_url: &str) -> String {
    let s = server_url.trim().trim_end_matches('/');
    let scheme_swapped = if let Some(rest) = s.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = s.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{s}")
    };
    format!("{scheme_swapped}/v1/audio/transcriptions/stream")
}

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
            on_event(StreamEvent::Error($msg));
            on_event(StreamEvent::Closed);
            return;
        }};
    }

    let mut request = match params.ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => fail!(format!("Invalid stream URL {}: {e}", params.ws_url)),
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
    let connect = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request));
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
                Ok(Err(e)) => fail!(format!("Could not connect to {}: {e}", params.ws_url)),
                Err(_) => fail!(format!(
                    "Could not connect to {} — timed out after {}s (server unreachable?)",
                    params.ws_url,
                    CONNECT_TIMEOUT.as_secs()
                )),
            },
        }
    };
    let (mut write, mut read) = ws.split();

    let lang = if params.language.is_empty() || params.language == "auto" {
        String::new()
    } else {
        params.language.clone()
    };
    let mut config = json!({
        "type": "config",
        "model": params.model,
        "language": lang,
        "response_format": params.response_format,
        "audio": { "format": "pcm_s16le", "sample_rate": 16000 }
    });
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
    // the chip shows as "speaking" + a short lead-in, so a long latch session doesn't store hours
    // of silence. The detector itself lives in `crate::audio::SpeechGate` (shared with the batch
    // record save so both paths trim identically); here it's fed chunk-by-chunk as audio arrives.
    let mut gate = crate::audio::SpeechGate::new();

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
                    // Forward each parsed event; stop on the terminal frame.
                    let terminal =
                        emit_message(t.as_str(), &|e| {
                            let _ = evt_tx.send(FromReader::Event(e));
                        });
                    if terminal {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                // Ping/Pong/Binary: ignored here. The PONG to a server PING is queued
                // by tungstenite and flushed by this very read poll — that's the point.
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    let _ = evt_tx.send(FromReader::Event(StreamEvent::Error(e.to_string())));
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
                            match tokio::time::timeout(
                                SEND_TIMEOUT,
                                write.send(Message::Binary(bytes.into())),
                            )
                            .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(_)) => break, // socket closed/errored → finish + Closed
                                Err(_) => {
                                    // Stalled send → the connection is gone. Surface it and
                                    // close so the UI returns to idle instead of hanging.
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
                        if saving { accumulate_transcript(&e, &mut transcript_docs, &mut transcript_cur); }
                        on_event(e);
                    }
                    // Server closed the socket (or the read errored, already surfaced
                    // above) — stop now; not draining, so fall through to Closed.
                    Some(FromReader::Closed) | None => break,
                }
            }
            _ = keepalive.tick() => {
                match tokio::time::timeout(SEND_TIMEOUT, write.send(Message::Ping(Vec::<u8>::new().into()))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break, // socket closed/errored → finish + Closed (reader surfaces it)
                    Err(_) => {
                        // Stalled send → the connection is gone. Surface it and close.
                        on_event(StreamEvent::Error(
                            "stream connection lost (keepalive timed out)".into(),
                        ));
                        break;
                    }
                }
            }
        }
    }

    if draining {
        // Finalize the current utterance and ask the server to close, then read the
        // remaining finals (delivered by the reader task) so the last words aren't
        // lost. The WHOLE block is bounded by one deadline: the flush/stop writes are
        // inside it too, so a half-open socket (suspend / dropped link) can't park
        // them indefinitely — we always fall through to the terminal `Closed` below
        // within a few seconds.
        const DRAIN_DEADLINE: Duration = Duration::from_secs(6);
        let _ = tokio::time::timeout(DRAIN_DEADLINE, async {
            // Drain the PCM the capture thread queued but the main loop hadn't consumed when the stop
            // signal won the (non-biased) select — push it through the resampler and send it, so the
            // final tens of ms aren't silently dropped from the transcript. `recv().await` (not a
            // one-shot try_recv) keeps draining until the channel CLOSES, so we also catch the chunks
            // the capture callback enqueues during its own shutdown: finish()/Drop set capture_stop
            // BEFORE ws_stop, so the capture thread is already exiting and drops its sender within
            // ~one buffer; the whole block is bounded by DRAIN_DEADLINE regardless. Saved (when
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
            while let Some(from) = evt_rx.recv().await {
                match from {
                    FromReader::Event(e) => {
                        if saving { accumulate_transcript(&e, &mut transcript_docs, &mut transcript_cur); }
                        on_event(e);
                    }
                    FromReader::Closed => break,
                }
            }
        })
        .await;
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
                let last = transcript_cur.trim();
                if !last.is_empty() {
                    transcript_docs.push(last.to_string());
                }
                let transcript = transcript_docs.join("\n");
                if !transcript.is_empty() {
                    crate::audio::save_transcript_sidecar(&path, &transcript);
                }
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
            if !trimmed.is_empty() {
                docs.push(trimmed.to_string());
            }
            current.clear();
        }
        _ => {}
    }
}

/// Parse one server text frame, emit the matching event, return true if it was the
/// terminal message (last final / closing).
fn emit_message<F: Fn(StreamEvent)>(text: &str, on_event: &F) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("ready") => {
            on_event(StreamEvent::Ready {
                overrides_ignored: str_vec_field(&v, "overrides_ignored"),
            });
            false
        }
        Some("partial") => {
            on_event(StreamEvent::Partial {
                committed: str_field(&v, "committed"),
                pending: str_field(&v, "pending"),
            });
            false
        }
        Some("final") => {
            let last = v.get("last").and_then(|b| b.as_bool()).unwrap_or(false);
            on_event(StreamEvent::Final {
                committed: str_field(&v, "committed"),
                tail: str_field(&v, "tail"),
                last,
            });
            last
        }
        Some("boundary") => {
            on_event(StreamEvent::Boundary {
                separator: str_field(&v, "separator"),
            });
            false
        }
        Some("error") => {
            on_event(StreamEvent::Error(str_field(&v, "message")));
            false
        }
        Some("closing") => true,
        _ => false,
    }
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn str_vec_field(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect())
        .unwrap_or_default()
}
