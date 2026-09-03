//! HTTP transport to a faster-whisper / OpenAI-compatible backend.
//!
//! `discovery` resolves server capabilities (`/v1/models`, `/auth/whoami`),
//! usage stats (`/v1/usage`), and override profiles;
//! `preload` sends the best-effort model pre-warm hint;
//! `batch` does the multipart `POST /v1/audio/transcriptions`; `stream` is the
//! streaming WebSocket client; `pipeline` reads/writes the server's text rules;
//! `sync` is the settings-sync client (`/v1/client-settings`);
//! `text` handles T2T translation (`/v1/text/translations`);
//! `usage` reports dictation outcomes (`/v1/usage/outcome`).

use serde::{Deserialize, Serialize};
use std::time::Duration;

pub mod batch;
pub mod discovery;
pub mod pipeline;
pub mod preload;
pub mod stream;
pub mod sync;
pub mod text;
pub mod usage;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerModel {
    pub id: String,
    #[serde(default)]
    pub loaded: bool,
}

/// Result of a connection test — mirrors the TS `ConnectionInfo`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub ok: bool,
    pub open_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub models: Vec<ServerModel>,
    /// The server's per-process `boot_id` from `/v1/models` (non-standard). Present
    /// ⇒ the full faster-whisper-backend; absent ⇒ a conventional Whisper server.
    /// The UI uses this to gate server-specific override knobs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    /// The server's build version from `/v1/models` (`server_version`, non-standard;
    /// emitted by faster-whisper-backend ≥ v0.1.0). Shown in the Detected chip;
    /// absent on standard servers and older backend builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// P11: capability + resolved-profile transport types (see commands/discovery).
/// The caller's effective request-override capabilities, from `GET /v1/me`.
/// snake_case (not camelCase) deliberately — it mirrors the backend contract
/// 1:1, like the `decode_overrides` keys, so it passes straight through both
/// the wire (deserialize) and the IPC boundary (serialize) with no remapping.
#[derive(Debug, Serialize, Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub can_request_override_profile: bool,
    #[serde(default)]
    pub can_request_decode_overrides: bool,
    /// `["*"]` = unrestricted (free choice from the names endpoint); else the
    /// explicit allowed names; `[]` = none.
    #[serde(default)]
    pub allowed_override_profiles: Vec<String>,
    /// Server-wide VAD default (additive, newer backends only) — labels the
    /// client's Skip-silence "Default" segment. Absent on older servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vad_filter_default: Option<bool>,
    /// Whether the server runs the optional pipeline stages at all (additive,
    /// newer backends only) — pre-flight-disables the client's "Separate
    /// music" / "Speaker diarization" toggles. Absent = unknown ⇒ assume
    /// available (never gate a knob we can't prove is unsupported).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bgm_separation_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diarization_enabled: Option<bool>,
    /// Whether the server downloads pasted media links (yt-dlp). Unlike the
    /// two flags above, the client shows the URL affordance only on
    /// `Some(true)` — absence means the endpoint does not exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_download_enabled: Option<bool>,
    /// Installed yt-dlp version on the server (only when the feature is on)
    /// — surfaced in download-failure guidance. Bounded in discovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yt_dlp_version: Option<String>,
    /// Whether the server runs the T2T translating stage. Shown only on
    /// `Some(true)` — absence means the feature does not exist (url_download
    /// pattern). The lists below are bounded in discovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_models: Option<Vec<ServerModel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_languages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translate_to_default: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llama_cpp_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diarization_models: Option<Vec<ServerModel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separation_models: Option<Vec<ServerModel>>,
}

/// A single override-profile's decode-relevant values + locked client keys,
/// from `GET /v1/override-profiles/{name}` — for previewing inherited defaults.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedOverrideProfile {
    pub name: String,
    /// `{client_decode_key: value}` (e.g. `{"beam_size": 8}`); `temperature`
    /// may arrive as a string (the server stores it as a ladder).
    #[serde(default)]
    pub values: serde_json::Value,
    #[serde(default)]
    pub locked: Vec<String>,
    /// The profile's own DEFAULT_PROMPT, exposed separately (it is NOT a client
    /// decode key, so it never appears in `values`) so the editor can ghost it as
    /// the inherited "Vocabulary / prompt". `null` when the profile sets none.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub prompt_locked: bool,
}

// P28: per-user usage stats (`GET /v1/usage`). snake_case passthrough like
// Capabilities — mirrors the backend JSON 1:1 and reaches the TS side unchanged.
// Every field defaults so a server that omits a block (or a later one that adds a
// facet) still deserializes; the bounding in `discovery::get_usage_stats` caps the lists.
/// One usage bucket's counters for one job kind (or `all`).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct UsageKindTotals {
    /// Runs: dictation SESSIONS (not utterances), file/url/text jobs.
    #[serde(default)]
    pub sessions: i64,
    #[serde(default)]
    pub requests: i64,
    #[serde(default)]
    pub errors: i64,
    #[serde(default)]
    pub words: i64,
    /// Seconds of audio (the client renders minutes/hours).
    #[serde(default)]
    pub audio_s: f64,
    /// Seconds of server processing time.
    #[serde(default)]
    pub processing_s: f64,
}

/// The per-kind split the server attaches to today / total / every series day.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct UsageKinds {
    #[serde(default)]
    pub all: UsageKindTotals,
    #[serde(default)]
    pub dictation: UsageKindTotals,
    #[serde(default)]
    pub file: UsageKindTotals,
    #[serde(default)]
    pub url: UsageKindTotals,
    #[serde(default)]
    pub text: UsageKindTotals,
}

/// One point in the trend series — a caller-local day (days-since-epoch) plus that
/// day's per-kind counters. Sparse: only days with usage are sent.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageSeriesPoint {
    #[serde(default)]
    pub day: i64,
    #[serde(default, flatten)]
    pub kinds: UsageKinds,
}

/// A translation target's share of a stage's runs.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageStageTarget {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub runs: i64,
}

/// One optional pipeline stage's usage across the window (translating, diarizing,
/// separating, vad, …). `of_runs` = the jobs the stage could have applied to.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageStage {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub runs: i64,
    #[serde(default)]
    pub of_runs: i64,
    #[serde(default)]
    pub audio_s: f64,
    #[serde(default)]
    pub secs: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speakers_avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_original: Option<i64>,
    #[serde(default)]
    pub targets: Vec<UsageStageTarget>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageActivation {
    #[serde(default)]
    pub hold: i64,
    #[serde(default)]
    pub handsfree: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageDelivery {
    #[serde(default)]
    pub typed: i64,
    #[serde(default)]
    pub clipboard: i64,
    #[serde(default)]
    pub none: i64,
    #[serde(default)]
    pub unreported: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageTranslationOutcome {
    #[serde(default)]
    pub translated: i64,
    #[serde(default)]
    pub kept_original: i64,
    #[serde(default)]
    pub not_asked: i64,
    #[serde(default)]
    pub aborted: i64,
    #[serde(default)]
    pub unreported: i64,
}

/// One language dictations were translated into: runs, and how many kept the original.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageDictationTarget {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub runs: i64,
    #[serde(default)]
    pub kept_original: i64,
}

/// The dictation facets the client reports after each session (`POST /v1/usage/outcome`).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageDictation {
    #[serde(default)]
    pub sessions: i64,
    #[serde(default)]
    pub words: i64,
    #[serde(default)]
    pub audio_s: f64,
    #[serde(default)]
    pub wpm: f64,
    #[serde(default)]
    pub activation: UsageActivation,
    #[serde(default)]
    pub delivery: UsageDelivery,
    #[serde(default)]
    pub translation: UsageTranslationOutcome,
    #[serde(default)]
    pub targets: Vec<UsageDictationTarget>,
}

/// One app the user dictated into (top-N over the window).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageApp {
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub sessions: i64,
    #[serde(default)]
    pub words: i64,
}

/// Words per kind — the calendar's and the hour grid's cell payload.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageKindWords {
    #[serde(default)]
    pub all: i64,
    #[serde(default)]
    pub dictation: i64,
    #[serde(default)]
    pub file: i64,
    #[serde(default)]
    pub url: i64,
    #[serde(default)]
    pub text: i64,
}

/// One calendar day's words per kind (sparse over the window).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageCalendarDay {
    #[serde(default)]
    pub day: i64,
    #[serde(default, flatten)]
    pub kinds: UsageKindWords,
}

/// One measure split per kind — the hour grid's nested `audio_s` / `processing_s` /
/// `sessions` / `requests` / `errors` blocks (backend `SLOT_MEASURES`). Floats
/// throughout: seconds are fractional and the counts round-trip exactly.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageKindSplit {
    #[serde(default)]
    pub all: f64,
    #[serde(default)]
    pub dictation: f64,
    #[serde(default)]
    pub file: f64,
    #[serde(default)]
    pub url: f64,
    #[serde(default)]
    pub text: f64,
}

/// One hour slot over the window — a weekday × hour slot (`dow` 0 = Monday, in `hours`)
/// or a day-of-month × hour slot (`dom` 1..31, in `dom_hours`): words per kind flat on
/// the slot, the other five measures nested per kind. The nested blocks are optional so
/// a server from before they existed still deserializes; when absent they are not
/// re-emitted, and the client can tell "not sent" from "zero".
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageHourCell {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dow: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom: Option<i64>,
    #[serde(default)]
    pub hour: i64,
    #[serde(default, flatten)]
    pub kinds: UsageKindWords,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_s: Option<UsageKindSplit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_s: Option<UsageKindSplit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<UsageKindSplit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests: Option<UsageKindSplit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<UsageKindSplit>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageStreak {
    #[serde(default)]
    pub current: i64,
    #[serde(default)]
    pub best: i64,
}

/// Streaks per kind over the full retained history.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageStreaks {
    #[serde(default)]
    pub all: UsageStreak,
    #[serde(default)]
    pub dictation: UsageStreak,
    #[serde(default)]
    pub file: UsageStreak,
    #[serde(default)]
    pub url: UsageStreak,
    #[serde(default)]
    pub text: UsageStreak,
}

/// Echo of the window the server applied (days-since-epoch in `tz`).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageWindow {
    #[serde(default)]
    pub from: i64,
    #[serde(default)]
    pub to: i64,
    #[serde(default)]
    pub days: i64,
    /// Earliest day with any usage ("All" starts here); None when there is none.
    #[serde(default)]
    pub first_day: Option<i64>,
    /// "rollups", or "jobs" when a stage filter recomputed the document.
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub jobs_retention_days: i64,
}

/// The caller's own usage document — one fetch feeds the Home strip, the Statistics
/// page and the chip readout.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageStats {
    #[serde(default)]
    pub username: String,
    /// The IANA zone the server reckoned days in.
    #[serde(default)]
    pub tz: String,
    #[serde(default)]
    pub range: UsageWindow,
    #[serde(default)]
    pub today: UsageKinds,
    #[serde(default)]
    pub total: UsageKinds,
    #[serde(default)]
    pub series: Vec<UsageSeriesPoint>,
    #[serde(default)]
    pub stages: Vec<UsageStage>,
    #[serde(default)]
    pub dictation: UsageDictation,
    #[serde(default)]
    pub apps: Vec<UsageApp>,
    #[serde(default)]
    pub calendar: Vec<UsageCalendarDay>,
    #[serde(default)]
    pub hours: Vec<UsageHourCell>,
    /// The same slots by day of month × hour (the busy panel's "days" rhythm). Absent on
    /// a server from before it existed; kept absent so the client can say so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom_hours: Option<Vec<UsageHourCell>>,
    #[serde(default)]
    pub streak: UsageStreaks,
    /// Window: words / 40 wpm − audio_s, dictation only (seconds).
    #[serde(default)]
    pub time_saved_s: f64,
}

/// Trim a trailing slash so we can join `/v1/...` paths cleanly.
pub fn base_url(server_url: &str) -> String {
    server_url.trim().trim_end_matches('/').to_string()
}

pub fn client() -> reqwest::Client {
    // One process-wide client: a reqwest::Client owns the connection pool + TLS session cache,
    // so rebuilding it per request threw away keep-alive reuse and paid a fresh TCP/TLS handshake
    // on every call (incl. the 30s usage poll). The config is constant (no per-request timeout/
    // header), and clone is cheap (Arc inside) so callers still get an owned client sharing the pool.
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .user_agent(concat!("faster-whisper-frontend/", env!("CARGO_PKG_VERSION")))
                // Never follow a redirect to a DIFFERENT host. reqwest strips `Authorization` on a
                // cross-host hop, but it does NOT strip the request BODY, and 307/308 replay method
                // + body verbatim to the `Location` host — and the sync push's body is the settings
                // blob, which carries `backends.secrets`, i.e. every backend's plaintext API key.
                // A hostile (or MITM'd — cleartext http is permitted) server answering the PUT with
                // a 308 would have that key set POSTed to a host of its choosing.
                //
                // Same-host hops still follow, so a server that redirects http→https or normalizes
                // a trailing slash keeps working. Cross-host, TLS-downgrade and same-scheme
                // port changes are all refused — see each rule below.
                // The same-host test alone was not enough, because it says nothing about the
                // SCHEME. reqwest drops `Authorization` when host, port or scheme changes, but it
                // replays the BODY verbatim on 307/308 — and the sync PUT body carries every
                // backend's plaintext API key. So `308 Location: http://<same host>/…` counted as
                // same-host, was followed, and re-sent that credential set in the clear for anyone
                // on the path to read. Refuse the downgrade specifically: http→https (the proxy
                // case) and every same-scheme hop still follow.
                // And the PORT, for the same reason one level down. A different port is a
                // different listener, and on a multi-tenant box — or on the loopback/LAN
                // deployments where plaintext is deliberately un-warned — any unprivileged local
                // process can bind a high one. reqwest strips `Authorization` on a port change but
                // still replays the body, so `308 Location: https://<same host>:9443/…` handed the
                // whole key set to that listener, which needed no credential to read it.
                //
                // Compared only WITHIN a scheme: an http→https upgrade almost always moves the
                // port too (80→443, 8000→8443), and refusing on port equality alone would break
                // the very hop the downgrade rule above deliberately keeps working.
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let prev = attempt.previous().last();
                    let same_host = prev.and_then(|u| u.host_str()) == attempt.url().host_str();
                    let same_scheme = prev.map(|u| u.scheme()) == Some(attempt.url().scheme());
                    let same_port = prev.and_then(|u| u.port_or_known_default())
                        == attempt.url().port_or_known_default();
                    let downgrades_tls =
                        prev.is_some_and(|u| u.scheme() == "https") && attempt.url().scheme() != "https";
                    if !same_host || downgrades_tls || (same_scheme && !same_port) {
                        attempt.stop()
                    } else if attempt.previous().len() > 5 {
                        attempt.error("too many redirects")
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .expect("failed to build reqwest client")
        })
        .clone()
}

/// A short, user-facing message for a request-level reqwest failure.
pub fn friendly_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Could not connect — is the server running and the URL correct?".into()
    } else if e.is_timeout() {
        "Timed out waiting for the server.".into()
    } else {
        // `is_connect`/`is_timeout` catch two kinds; everything else lands here, and reqwest's
        // Display appends " for url ({url})" with `Url`'s FULL serialization — userinfo included.
        // A `serverUrl` of the form `https://user:secret@host/` would then be written verbatim
        // into the UI banners below AND into the pipeline `tracing::warn!` calls, i.e. the log
        // file users are asked to attach to a support report. `without_url()` consumes the error
        // and we only have a reference, so strip the suffix reqwest itself appends.
        let mut msg = e.to_string();
        if e.url().is_some() {
            if let Some(i) = msg.find(" for url (") {
                msg.truncate(i);
            }
        }
        // The remainder is still a server-influenced string on its way to a banner and a log.
        bounded_server_text(&msg, MAX_ERR)
    }
}

/// Cap for the transport's own error text (server-supplied `detail` strings are bounded tighter,
/// at [`MAX_ERROR_TEXT`]) — an error line is a single-line banner, not a document.
pub(crate) const MAX_ERR: usize = 300;

/// Pull FastAPI's `detail` string from an error body, falling back to the raw text.
///
/// Bounded HERE rather than at each call site: every caller surfaces the result to the UI or the
/// log, the fallback arm returns the WHOLE response body (32 MiB, see [`MAX_BODY`]), and only the
/// two `session.rs` sites had picked up [`bounded_server_text`]. The sync pull runs unattended at
/// startup and on every window focus, so a hostile server needed no user action to plant a
/// multi-megabyte, newline-bearing string in a `<Notice>` and in the log file.
pub fn detail_from(body: &str) -> String {
    let raw = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_else(|| body.to_string());
    bounded_server_text(&raw, MAX_ERROR_TEXT)
}

/// Attach a bearer token if one is provided.
pub fn with_auth(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    match api_key {
        Some(k) if !k.is_empty() => req.bearer_auth(k),
        _ => req,
    }
}

/// Hard ceiling on any response body we buffer in memory. reqwest has no built-in body limit, and
/// the only other bound is the request timeout — 3600s on the file-transcribe path, long enough for
/// a hostile server to stream tens of gigabytes into one allocation. 32 MiB is orders of magnitude
/// above any legitimate transcription or settings payload.
pub const MAX_BODY: usize = 32 * 1024 * 1024;

/// A server-supplied error string is surfaced in the UI and written to the log file users are
/// asked to attach to support reports. Same ceiling the streaming parse path uses.
pub const MAX_ERROR_TEXT: usize = 200;

/// Ceiling on server-supplied notice/override lists (streaming notices, batch overrides).
pub const MAX_NOTICES: usize = 50;

/// Ceiling on a body we read ONLY to pull a `detail` string out of. `detail_from` full-parses the
/// whole body as JSON to extract at most [`MAX_ERROR_TEXT`] characters, so the transcription-sized
/// [`MAX_BODY`] buys nothing on a non-2xx arm — it just lets a hostile server bill us 32 MiB and a
/// full serde tree for 200 characters it will then discard. `sync.rs` already reads its error arms
/// at `SYNC_MAX_BODY` for exactly this reason; this is the same bound for the routes left behind.
pub const MAX_ERROR_BODY: usize = 256 * 1024;

/// Ceiling on a METADATA response — capabilities, model lists, usage counters, pipeline rules,
/// recent words. Every one of these has a per-field cap applied AFTER the read, so leaving them at
/// the transcription-sized [`MAX_BODY`] meant the 32 MiB buffer and the full serde tree were paid
/// first and the cap only trimmed the result. Several fire on screen entry or from a gesture-free
/// effect. [`MAX_BODY`] should now be reachable only from the routes that can legitimately carry
/// a transcription (`batch`) or a T2T translation (`text`).
pub const MAX_META_BODY: usize = 1024 * 1024;

/// Bound and defang a server-supplied string on its way to the UI or the log.
///
/// The streaming parse path caps its `error` frames at [`MAX_ERROR_TEXT`], but the BATCH sibling
/// formatted the transport error straight into the emitted message — and that error carries
/// `detail_from(&body)`, which falls back to the whole response body (bounded only by
/// [`MAX_BODY`]). Newlines are folded too, so a server cannot forge log records.
/// The fold is Cc AND the invisible-format set, not `is_control()` alone. These strings are
/// single-line labels printed next to a connection verdict or inside a consent dialog, and a bidi
/// override there reorders the sentence the user is reading to make a trust decision — the same
/// reason the injection path strips them. Doing it here means every consumer of a bounded server
/// string inherits it, instead of each render site remembering to sanitize.
pub fn bounded_server_text(s: &str, n: usize) -> String {
    let mut out = String::with_capacity(n.min(s.len()));
    let mut kept = 0usize;
    for c in s.chars() {
        if crate::inject::is_deceptive_format_char(c) {
            continue;
        }
        if kept >= n {
            out.push('…');
            return out;
        }
        out.push(if c.is_control() { ' ' } else { c });
        kept += 1;
    }
    out
}

/// Target-language codes are short ISO-ish tags ("de", "pt-BR") — screened before they join
/// a form field or a JSON body. Shared by the batch form and the T2T text route, which used
/// to carry two hand-copied versions of this predicate.
pub(crate) fn is_lang_code(s: &str) -> bool {
    (2..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Most target languages one request carries. NOTE the two routes apply it differently and
/// deliberately so: the batch form TRUNCATES to the first 8 valid codes, the text route
/// REFUSES a request with more — changing either is a behaviour decision, not a cleanup.
pub(crate) const MAX_TARGETS: usize = 8;

/// The `language` a request should carry, as the three states the server distinguishes:
/// `None` = omit the field (the server inherits its override-profile's DEFAULT_LANGUAGE),
/// `Some("")` = send an empty value (auto-detect, stated explicitly, which OVERRIDES that
/// inherited language), `Some(code)` = that language.
///
/// "auto" must be said on the wire: folding it onto "omit" (which both transports did)
/// meant a user picking auto-detect on a backend bound to a server profile silently got that
/// profile's language instead. The three states are the wire contract; today no picker
/// actually emits `""` (every backend is seeded "auto" and the Backends/Transcribe pickers
/// have no inherit row — the Profile's inherit row resolves to the backend's language first),
/// so `None` is reserved for a future inherit row and for a config synced with an empty
/// `language`.
pub fn wire_language(language: &str) -> Option<&str> {
    match language {
        "" => None,
        "auto" => Some(""),
        code => Some(code),
    }
}

/// `wire_language`, but a STANDARD (plain OpenAI-compatible) server keeps the old
/// omit-on-auto: it has no override profile whose language an empty value would override,
/// and an empty `language` is not a valid code for a strict server to accept.
pub fn wire_language_for(standard: bool, language: &str) -> Option<&str> {
    if standard {
        return (!language.is_empty() && language != "auto").then_some(language);
    }
    wire_language(language)
}

#[cfg(test)]
mod wire_language_tests {
    use super::wire_language;

    #[test]
    fn auto_is_sent_as_empty_and_unset_is_omitted() {
        // The whole point: these two used to be the same request.
        assert_eq!(wire_language("auto"), Some(""));
        assert_eq!(wire_language(""), None);
    }

    #[test]
    fn a_real_code_rides_through_untouched() {
        assert_eq!(wire_language("de"), Some("de"));
        assert_eq!(wire_language("pt-BR"), Some("pt-BR"));
    }

    #[test]
    fn a_standard_server_never_receives_an_empty_language() {
        use super::wire_language_for;
        assert_eq!(wire_language_for(true, "auto"), None);
        assert_eq!(wire_language_for(true, ""), None);
        assert_eq!(wire_language_for(true, "de"), Some("de"));
        assert_eq!(wire_language_for(false, "auto"), Some(""));
    }
}

#[cfg(test)]
mod usage_hour_cell_tests {
    use super::{UsageHourCell, UsageStats};

    /// The busy-hours grid reads the nested per-kind splits the server puts on every
    /// slot beside the flat words. They used to be dropped on the way through this
    /// typed mirror, which left the grid empty for every measure but words.
    #[test]
    fn nested_measure_splits_survive_the_typed_mirror() {
        let body = r#"{"hours":[{"dow":1,"hour":9,"all":120,"dictation":100,"file":20,"url":0,"text":0,
            "audio_s":{"all":61.5,"dictation":41.5,"file":20.0,"url":0.0,"text":0.0},
            "processing_s":{"all":3.25,"dictation":2.0,"file":1.25,"url":0.0,"text":0.0},
            "sessions":{"all":3,"dictation":2,"file":1,"url":0,"text":0},
            "requests":{"all":5,"dictation":4,"file":1,"url":0,"text":0},
            "errors":{"all":1,"dictation":0,"file":1,"url":0,"text":0}}]}"#;
        let u: UsageStats = serde_json::from_str(body).unwrap();
        let out = serde_json::to_value(&u.hours[0]).unwrap();
        assert_eq!(out["dictation"], 100);
        assert_eq!(out["audio_s"]["dictation"], 41.5);
        assert_eq!(out["processing_s"]["all"], 3.25);
        assert_eq!(out["sessions"]["file"], 1.0);
        assert_eq!(out["requests"]["all"], 5.0);
        assert_eq!(out["errors"]["file"], 1.0);
    }

    /// An older server sends only the flat words: the nested blocks stay absent
    /// rather than becoming zero-filled objects the client would mistake for data.
    #[test]
    fn an_old_server_slot_keeps_its_blocks_absent() {
        let c: UsageHourCell = serde_json::from_str(r#"{"dow":0,"hour":8,"all":7,"dictation":7}"#).unwrap();
        let out = serde_json::to_value(&c).unwrap();
        assert_eq!(out["all"], 7);
        assert_eq!(out["dow"], 0);
        assert!(out.get("dom").is_none());
        assert!(out.get("audio_s").is_none());
        assert!(out.get("sessions").is_none());
        let u: UsageStats = serde_json::from_str(r#"{"hours":[]}"#).unwrap();
        assert!(serde_json::to_value(&u).unwrap().get("dom_hours").is_none());
    }

    /// The day-of-month grid rides through beside the weekday one.
    #[test]
    fn the_day_of_month_grid_keeps_its_dom_key() {
        let u: UsageStats = serde_json::from_str(r#"{"dom_hours":[{"dom":29,"hour":5,"all":3,"sessions":{"all":1}}]}"#).unwrap();
        let out = serde_json::to_value(&u).unwrap();
        assert_eq!(out["dom_hours"][0]["dom"], 29);
        assert!(out["dom_hours"][0].get("dow").is_none());
        assert_eq!(out["dom_hours"][0]["sessions"]["all"], 1.0);
    }
}

/// Buffer a response body with an explicit ceiling, giving up once it passes the limit instead of
/// growing without bound. Every caller now names its own ceiling: an error arm that only wants a
/// `detail` string takes [`MAX_ERROR_BODY`], a sync payload takes `sync::SYNC_MAX_BODY`, and only a
/// route that can legitimately carry a transcription takes [`MAX_BODY`].
pub async fn body_capped_to(mut resp: reqwest::Response, limit: usize) -> Result<String, String> {
    if resp.content_length().is_some_and(|n| n > limit as u64) {
        return Err(TOO_LARGE.into());
    }
    // Pre-allocate when the server declares the size (already proven <= limit above),
    // avoiding the geometric doubling that otherwise pushes peak RSS to ~1.5x on
    // multi-megabyte transcription / sync bodies.
    let capacity = resp.content_length().map(|n| n as usize).unwrap_or(0);
    let mut buf: Vec<u8> = Vec::with_capacity(capacity);
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > limit {
                    return Err(TOO_LARGE.into());
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(friendly_err(&e)),
        }
    }
    String::from_utf8(buf).map_err(|_| "The server sent a response that wasn't valid text.".into())
}

/// [`body_capped_to`] plus a JSON parse.
pub async fn json_capped<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, String> {
    json_capped_to(resp, MAX_BODY).await
}

/// [`json_capped`] with an explicit ceiling.
pub async fn json_capped_to<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    limit: usize,
) -> Result<T, String> {
    let text = body_capped_to(resp, limit).await?;
    // serde embeds the offending value VERBATIM in its message (`Unexpected::Str` formats as
    // `string {:?}`), so a 32 MiB field yields a 32 MiB error — larger still once Debug escaping
    // expands each character. That string is what the unattended sync pull surfaces in the
    // settings banner. Bound it here, where every caller inherits the bound.
    serde_json::from_str(&text).map_err(|e| bounded_server_text(&e.to_string(), MAX_ERROR_TEXT))
}

const TOO_LARGE: &str = "The server sent an unreasonably large response — ignoring it.";

/// Best-effort `GET <url>` deserialized as `T`: any failure — transport error, non-2xx, an
/// over-large body, or one that won't deserialize — collapses to `None`. The discovery probes
/// (`/v1/me`, `/v1/usage`, `/v1/override-profiles/{name}`) all treat an unreachable/absent/
/// unauthorized endpoint this way.
pub async fn get_json<T: serde::de::DeserializeOwned>(url: String, api_key: Option<&str>) -> Option<T> {
    match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => json_capped_to::<T>(resp, MAX_META_BODY).await.ok(),
        _ => None,
    }
}
