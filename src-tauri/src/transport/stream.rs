//! Streaming dictation WebSocket client.
//!
//! Connects to `ws[s]://HOST/v1/audio/transcriptions/stream`, sends the JSON
//! `config` frame, then forwards 16 kHz mono s16le PCM (resampled from the
//! capture rate) as binary frames while parsing the server's
//! `ready`/`partial`/`final`/`error`/`closing` messages into [`StreamEvent`]s.

use crate::audio::resample::Resampler16k;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;

/// Events surfaced from the stream (the session maps these to Tauri events).
pub enum StreamEvent {
    Ready,
    Partial { committed: String, pending: String },
    Final { committed: String, tail: String, last: bool },
    Error(String),
    Closed,
}

pub struct StreamParams {
    pub ws_url: String,
    pub model: String,
    pub language: String, // "" / "auto" → omit (server auto-detects)
    pub response_format: String, // "json" | "verbose_json"
    pub api_key: Option<String>,
    pub in_rate: u32,
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
/// every server message (and a final `Closed`).
pub async fn run<F>(
    params: StreamParams,
    mut pcm_rx: mpsc::UnboundedReceiver<Vec<f32>>,
    mut stop_rx: watch::Receiver<bool>,
    on_event: F,
) -> anyhow::Result<()>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let mut request = params.ws_url.as_str().into_client_request()?;
    if let Some(k) = &params.api_key {
        if !k.is_empty() {
            request
                .headers_mut()
                .insert(AUTHORIZATION, format!("Bearer {k}").parse()?);
        }
    }

    let (ws, _resp) = tokio_tungstenite::connect_async(request).await?;
    let (mut write, mut read) = ws.split();

    let lang = if params.language.is_empty() || params.language == "auto" {
        String::new()
    } else {
        params.language.clone()
    };
    let config = json!({
        "type": "config",
        "model": params.model,
        "language": lang,
        "response_format": params.response_format,
        "audio": { "format": "pcm_s16le", "sample_rate": 16000 }
    });
    write.send(text_msg(config.to_string())).await?;

    let mut resampler = Resampler16k::new(params.in_rate).map_err(|e| anyhow::anyhow!(e))?;
    let mut draining = false;

    loop {
        tokio::select! {
            res = stop_rx.changed() => {
                if res.is_err() || *stop_rx.borrow() { draining = true; break; }
            }
            maybe = pcm_rx.recv() => {
                match maybe {
                    Some(chunk) => {
                        let bytes = resampler.push(&chunk);
                        if !bytes.is_empty() && write.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
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
        // remaining finals (bounded) so the last words aren't lost.
        let _ = write.send(text_msg(json!({"type":"flush"}).to_string())).await;
        let _ = write.send(text_msg(json!({"type":"stop"}).to_string())).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
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

    on_event(StreamEvent::Closed);
    Ok(())
}

/// Parse one server text frame, emit the matching event, return true if it was the
/// terminal message (last final / closing).
fn emit_message<F: Fn(StreamEvent)>(text: &str, on_event: &F) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("ready") => {
            on_event(StreamEvent::Ready);
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
