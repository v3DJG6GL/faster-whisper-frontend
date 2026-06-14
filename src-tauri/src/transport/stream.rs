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
    pub prompt: String, // profile "Vocabulary / prompt" → initial_prompt ("" → server default)
    pub decode_overrides: Option<serde_json::Value>, // opaque JSON object → handshake "decode_overrides"
    pub api_key: Option<String>,
    pub in_rate: u32,
    pub save_dir: Option<PathBuf>, // Some → save the streamed 16 kHz audio as .wav
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
        // Empty string = let the server fall back to its DEFAULT_PROMPT (then None).
        "prompt": params.prompt,
        "audio": { "format": "pcm_s16le", "sample_rate": 16000 }
    });
    // Forward per-request decode overrides as a nested object (only when non-empty).
    if let Some(v) = &params.decode_overrides {
        if v.as_object().map_or(false, |m| !m.is_empty()) {
            config["decode_overrides"] = v.clone();
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
    let mut saved: Vec<u8> = Vec::new();

    // A single audio frame should send in well under a second; if a send can't make
    // progress for this long the link is dead/half-open (suspend, network loss) —
    // bail rather than park on the OS TCP retransmit timeout.
    const SEND_TIMEOUT: Duration = Duration::from_secs(5);

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
                            if saving {
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
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => { emit_message(t.as_str(), &on_event); }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { on_event(StreamEvent::Error(e.to_string())); break; }
                }
            }
        }
    }

    if draining {
        // Finalize the current utterance and ask the server to close, then read the
        // remaining finals so the last words aren't lost. The WHOLE block is bounded
        // by one deadline: the flush/stop writes are inside it too, so a half-open
        // socket (suspend / dropped link) can't park them indefinitely — we always
        // fall through to the terminal `Closed` below within a few seconds.
        const DRAIN_DEADLINE: Duration = Duration::from_secs(6);
        let _ = tokio::time::timeout(DRAIN_DEADLINE, async {
            let _ = write.send(text_msg(json!({"type":"flush"}).to_string())).await;
            let _ = write.send(text_msg(json!({"type":"stop"}).to_string())).await;
            while let Some(Ok(msg)) = read.next().await {
                if let Message::Text(t) = msg {
                    if emit_message(t.as_str(), &on_event) {
                        break;
                    }
                }
            }
        })
        .await;
    }

    if let Some(dir) = &params.save_dir {
        // Skip empties (e.g. a quick tap that connected then drained without audio).
        if !saved.is_empty() {
            crate::audio::save_recording(dir, &saved, 16_000);
        }
    }
    on_event(StreamEvent::Closed);
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
