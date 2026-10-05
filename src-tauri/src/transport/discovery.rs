//! Connection test + model discovery against `/v1/models` and `/auth/whoami`.

use super::{
    base_url, client, friendly_err, get_json, with_auth, Capabilities, ConnectionInfo,
    DecodeDefault, DecodeDefaults, ServerModel, UsageStats,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct WhoAmI {
    #[serde(default)]
    open_mode: bool,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResp {
    #[serde(default)]
    data: Vec<ModelObj>,
    /// Non-standard per-process marker emitted by faster-whisper-backend. Its mere
    /// presence is our signal that this is the full backend (vs a conventional
    /// OpenAI-compatible Whisper server, which never sends it).
    #[serde(default)]
    boot_id: Option<String>,
    /// Non-standard build version (faster-whisper-backend ≥ v0.1.0), e.g.
    /// "v0.1.0-3-g1a2b3c4". Older builds send boot_id but not this.
    #[serde(default)]
    server_version: Option<String>,
}

#[derive(Deserialize)]
struct ModelObj {
    id: String,
    #[serde(default)]
    loaded: bool,
}

/// Probe a server: list its models and resolve auth state. Never errors — failures
/// are reported in `ConnectionInfo { ok: false, error }` so the UI can show them.
/// Ceiling on server-supplied identifier lists (model ids, override-profile names). Orders of
/// magnitude above any real server's inventory; it exists so one response cannot make the settings
/// window lay out an unbounded number of DOM nodes.
const MAX_MODELS: usize = 500;
/// Ceiling on a single server-supplied name rendered in the UI.
const MAX_NAME: usize = 120;
/// Ceiling on the usage trend points kept. With `all=1` and `from`/`to` the server sends up
/// to a 10-year daily window (3,653 points). The per-field caps below trim the result after
/// the read; `USAGE_MAX_BODY` sizes the read itself.
const MAX_SERIES: usize = 3_700;

/// Ceiling on the usage-stats body. The `all=1` window can produce ~2 MB of
/// `series` (3,700 points x ~500 B) plus `calendar`, `hours`, `stages` — past
/// the shared `MAX_META_BODY` (1 MiB) that `get_json` applies. Without a
/// dedicated ceiling the document is silently rejected and the Statistics page
/// stays blank for any multi-year user who picks the "All" range.
const USAGE_MAX_BODY: usize = 8 * 1024 * 1024;

fn bounded_name(s: &str) -> String {
    super::bounded_server_text(s, MAX_NAME)
}

pub async fn test_connection(server_url: &str, api_key: Option<&str>) -> ConnectionInfo {
    let base = base_url(server_url);
    let http = client();

    // The two probes are independent: fire them concurrently so the happy path
    // costs one round trip instead of two, and a black-holed server stalls for
    // one default timeout instead of doubling it.
    let whoami_fut = async {
        let (mut open_mode, mut username) = (false, None);
        if let Ok(resp) = with_auth(http.get(format!("{base}/auth/whoami")), api_key)
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(who) = super::json_capped_to::<WhoAmI>(resp, super::MAX_META_BODY).await {
                    open_mode = who.open_mode;
                    username = who.username.map(|u| bounded_name(&u));
                }
            }
        }
        (open_mode, username)
    };
    let models_fut = with_auth(http.get(format!("{base}/v1/models")), api_key).send();
    let ((open_mode, username), models_result) = tokio::join!(whoami_fut, models_fut);

    // /v1/models is the actual connectivity gate.
    match models_result {
        Ok(resp) => {
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
                    server_version: None,
                    error: Some(
                        "Unauthorized — an API key is required or the key is invalid.".into(),
                    ),
                };
            }
            if !status.is_success() {
                return ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
                    server_version: None,
                    error: Some(format!("Server returned HTTP {}.", status.as_u16())),
                };
            }
            match super::json_capped_to::<ModelsResp>(resp, super::MAX_META_BODY).await {
                Ok(parsed) => ConnectionInfo {
                    ok: true,
                    open_mode,
                    username,
                    // Count and length ceiling on the one server-supplied list in this layer that
                    // never got one: the editor maps EVERY entry into a rendered chip, and the
                    // probe runs on screen entry, not only behind the manual button.
                    models: parsed
                        .data
                        .into_iter()
                        .take(MAX_MODELS)
                        .map(|m| ServerModel {
                            id: bounded_name(&m.id),
                            loaded: m.loaded,
                            languages: None,
                        })
                        .collect(),
                    boot_id: parsed.boot_id.map(|s| bounded_name(&s)),
                    server_version: parsed.server_version.map(|s| bounded_name(&s)),
                    error: None,
                },
                Err(e) => ConnectionInfo {
                    ok: false,
                    open_mode,
                    username,
                    models: vec![],
                    boot_id: None,
                    server_version: None,
                    // `json_capped_to`'s error can include the server body (serde's
                    // `invalid_type` Display echoes the offending value untruncated). Every
                    // sibling field is already `bounded_name`d and both static error arms plus
                    // `friendly_err` are bounded to `MAX_ERR`. Bound this one to match.
                    error: Some(super::bounded_server_text(
                        &format!("Unexpected /v1/models response: {e}"),
                        super::MAX_ERR,
                    )),
                },
            }
        }
        Err(e) => ConnectionInfo {
            ok: false,
            open_mode,
            username,
            models: vec![],
            boot_id: None,
            server_version: None,
            error: Some(friendly_err(&e)),
        },
    }
}

#[derive(Deserialize)]
struct OverrideProfilesResp {
    #[serde(default)]
    profiles: Vec<String>,
}

/// Names of the server-side override-profiles a client may reference (the full
/// faster-whisper-backend's `GET /v1/override-profiles`). Best-effort: any error
/// (endpoint absent, unauthorized, unreachable, feature gated off) → empty list,
/// so the picker falls back to free-text entry.
pub async fn list_override_profiles(server_url: &str, api_key: Option<&str>) -> Vec<String> {
    let base = base_url(server_url);
    let url = format!("{base}/v1/override-profiles");
    // Best-effort: get_json → None on any failure, so the picker falls back to free-text.
    get_json::<OverrideProfilesResp>(url, api_key)
        .await
        .map(|r| {
            r.profiles
                .iter()
                .take(MAX_MODELS)
                .map(|p| bounded_name(p))
                .collect()
        })
        .unwrap_or_default()
}

/// The caller's effective request-override capabilities (`GET /v1/me`, full
/// backend only). Best-effort: any error (endpoint absent, unauthorized,
/// unreachable) → None, which the UI treats as "unknown ⇒ assume permitted"
/// (never gate a knob we can't prove is unsupported).
pub async fn get_capabilities(server_url: &str, api_key: Option<&str>) -> Option<Capabilities> {
    let base = base_url(server_url);
    let mut caps: Capabilities = get_json(format!("{base}/v1/me"), api_key).await?;
    // The one server-supplied string list in this module with no ceiling of its own, while every
    // sibling here — `models`, `list_override_profiles` — takes
    // `MAX_MODELS` plus a per-entry `bounded_name`. `get_json`'s only ceiling is the generic 32 MiB
    // body cap, and `Capabilities` is `Serialize`, so the whole list crossed the IPC and was
    // JSON-parsed on the webview main thread from a gesture-free effect that re-fires as the
    // server address is typed. Nothing in the frontend reads the field at all.
    caps.allowed_override_profiles.truncate(MAX_MODELS);
    for name in caps.allowed_override_profiles.iter_mut() {
        *name = bounded_name(name);
    }
    // Server string rendered as a UI label (download-failure guidance).
    caps.yt_dlp_version = caps
        .yt_dlp_version
        .map(|v| super::bounded_server_text(&v, 32));
    caps.llama_cpp_version = caps
        .llama_cpp_version
        .map(|v| super::bounded_server_text(&v, 32));
    caps.media_package = caps.media_package.map(bound_media_package);
    caps.translation_models = bound_models(caps.translation_models);
    caps.diarization_models = bound_models(caps.diarization_models);
    caps.separation_models = bound_models(caps.separation_models);
    caps.translate_to_default = caps
        .translate_to_default
        .map(|v| bound_codes(v, super::MAX_TARGETS));
    Some(caps)
}

/// Per-stage model lists feed pickers — same treatment as `models`; a translation model's
/// language list feeds the target picker's rows.
fn bound_models(list: Option<Vec<ServerModel>>) -> Option<Vec<ServerModel>> {
    list.map(|mut v| {
        v.truncate(MAX_MODELS);
        v.into_iter()
            .map(|m| ServerModel {
                id: bounded_name(&m.id),
                loaded: m.loaded,
                languages: m.languages.map(|v| bound_codes(v, MAX_MODELS)),
            })
            .collect()
    })
}

/// A server list of language codes: a code [`super::is_lang_code`] refuses is dropped (the
/// batch form's rule — a truncated code is no code at all), at most `max` kept.
fn bound_codes(v: Vec<String>, max: usize) -> Vec<String> {
    v.into_iter()
        .filter(|c| super::is_lang_code(c))
        .take(max)
        .collect()
}

/// The packaging detail block carries two server strings rendered as UI
/// labels (the off-reason and the ffmpeg version) and a container list the
/// export panel matches by name — bound all three, clamp the counts.
fn bound_media_package(m: super::MediaPackageCaps) -> super::MediaPackageCaps {
    super::MediaPackageCaps {
        containers: m
            .containers
            .into_iter()
            .filter(|c| c == "mkv" || c == "mp4")
            .take(2)
            .collect(),
        max_tracks: m.max_tracks.min(64),
        max_srt_bytes: m.max_srt_bytes,
        max_upload_bytes: m.max_upload_bytes,
        reason: m.reason.map(|r| super::bounded_server_text(&r, 200)),
        ffmpeg_version: m.ffmpeg_version.map(|v| super::bounded_server_text(&v, 32)),
    }
}

/// Ceiling on the list blocks of the usage document (stages / targets-per-stage / apps).
const MAX_USAGE_LIST: usize = 16;
/// Ceiling on the calendar days kept (a 10-year "All" window is 3,653 days).
const MAX_CALENDAR: usize = 3_700;
/// The hour grid is at most 7 × 24 slots.
const MAX_HOURS: usize = 168;
/// 31 days of month × 24 hours.
const MAX_DOM_HOURS: usize = 744;
/// The stages a `with=` filter may name; anything else is dropped before it reaches the URL.
const USAGE_STAGES: [&str; 4] = ["translating", "diarizing", "separating", "vad"];

/// The Statistics page's query (`GET /v1/usage`): one window form — `days`, `from`/`to`
/// (days-since-epoch), or `all` — plus the `with=` stage filter. Mirrors TS `UsageQuery`.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub with: Vec<String>,
    #[serde(default)]
    pub tz: Option<String>,
}

impl UsageQuery {
    /// The query string (without `?`), every value validated: integers only, a bounded
    /// IANA zone, and only the four known stage names.
    pub fn to_query(&self) -> String {
        let mut q: Vec<String> = Vec::new();
        if self.all {
            q.push("all=1".into());
        } else if self.from.is_some() || self.to.is_some() {
            if let Some(f) = self.from {
                q.push(format!("from={f}"));
            }
            if let Some(t) = self.to {
                q.push(format!("to={t}"));
            }
        } else if let Some(d) = self.days {
            q.push(format!("days={d}"));
        }
        let stages: Vec<&str> = self
            .with
            .iter()
            .map(String::as_str)
            .filter(|s| USAGE_STAGES.contains(s))
            .collect();
        if !stages.is_empty() {
            q.push(format!("with={}", stages.join(",")));
        }
        if let Some(z) = self.tz.as_deref() {
            if iana_zone_ok(z) {
                let encoded: String = z
                    .bytes()
                    .map(|b| {
                        if b == b'+' {
                            "%2B".to_string()
                        } else {
                            (b as char).to_string()
                        }
                    })
                    .collect();
                q.push(format!("tz={encoded}"));
            }
        }
        q.join("&")
    }
}

/// An IANA zone name is `Area/City`-shaped ASCII (`Europe/Zurich`, `America/Argentina/
/// Buenos_Aires`, `Etc/GMT+2`). Anything else is not a zone the server could resolve, and
/// pasting it raw into the query could break URL parsing — so it is simply omitted (the
/// server then falls back to its local zone, as it does when the param is absent).
fn iana_zone_ok(tz: &str) -> bool {
    !tz.is_empty()
        && tz.len() <= 64
        && tz
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+'))
}

/// The caller's own usage document (`GET /v1/usage`, full backend only): today + total
/// per kind, the per-kind daily series, stage usage, dictation facets, apps, the
/// activity calendar and streak. Best-effort: any error (endpoint absent on a
/// standard/old server, unauthorized, unreachable) → None, so the UI simply hides the
/// stats surfaces (Home section + chip line). Query params are omitted when None so the
/// server applies its own defaults.
pub async fn get_usage_stats(
    server_url: &str,
    api_key: Option<&str>,
    query: &UsageQuery,
) -> Option<UsageStats> {
    let base = base_url(server_url);
    let q = query.to_query();
    let url = if q.is_empty() {
        format!("{base}/v1/usage")
    } else {
        format!("{base}/v1/usage?{q}")
    };
    // Every string and list here rides in a struct the store re-serializes with TWO
    // JSON.stringify passes on the main thread every 30s for every backend — the same reason
    // `series` is sliced client-side. The `test_connection` sibling caps `username`.
    // Read at the usage-specific ceiling (not the shared MAX_META_BODY): the "All"
    // window can legitimately exceed 1 MiB — see USAGE_MAX_BODY.
    let mut u: UsageStats = match with_auth(client().get(url), api_key).send().await {
        Ok(resp) if resp.status().is_success() => {
            super::json_capped_to::<UsageStats>(resp, USAGE_MAX_BODY)
                .await
                .ok()?
        }
        _ => return None,
    };
    u.username = bounded_name(&u.username);
    u.tz = bounded_name(&u.tz);
    // Keep the NEWEST points: the client renders the tail, so truncating from the front
    // would show a long-lived server's oldest window instead of its current one.
    if u.series.len() > MAX_SERIES {
        u.series.drain(..u.series.len() - MAX_SERIES);
    }
    if u.calendar.len() > MAX_CALENDAR {
        u.calendar.drain(..u.calendar.len() - MAX_CALENDAR);
    }
    u.hours.truncate(MAX_HOURS);
    if let Some(d) = u.dom_hours.as_mut() {
        d.truncate(MAX_DOM_HOURS);
    }
    u.range.source = super::bounded_server_text(&u.range.source, 16);
    u.stages.truncate(MAX_USAGE_LIST);
    for st in &mut u.stages {
        st.stage = super::bounded_server_text(&st.stage, 32);
        st.targets.truncate(MAX_USAGE_LIST);
        for t in &mut st.targets {
            t.code = super::bounded_server_text(&t.code, 16);
        }
    }
    u.dictation.targets.truncate(MAX_USAGE_LIST);
    for t in &mut u.dictation.targets {
        t.code = super::bounded_server_text(&t.code, 16);
    }
    u.apps.truncate(MAX_USAGE_LIST);
    for a in &mut u.apps {
        a.app_id = super::bounded_server_text(&a.app_id, 64);
    }
    Some(u)
}

/// The longest model id sent to `/v1/decode-defaults` (the server refuses longer ones too).
const MODEL_ID_MAX: usize = 200;
/// Prompts and hotwords: the server caps both at 2048 characters.
const SERVER_TEXT_MAX: usize = 2048;

fn is_profile_slug(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `{base}/v1/decode-defaults?model=…&override_profile=…`. Model ids carry `/` and `:`, so both
/// go through the URL's own query encoder. An over-long model is sent as "" (the server's default
/// model) rather than refused; a profile that is not a server slug (`[A-Za-z0-9_-]`, which
/// includes `__none__`) is left out — it could not name a real profile.
fn decode_defaults_url(
    server_url: &str,
    model: &str,
    profile: Option<&str>,
) -> Option<reqwest::Url> {
    let mut url =
        reqwest::Url::parse(&format!("{}/v1/decode-defaults", base_url(server_url))).ok()?;
    {
        let mut q = url.query_pairs_mut();
        let model = model.trim();
        q.append_pair(
            "model",
            if model.chars().count() > MODEL_ID_MAX {
                ""
            } else {
                model
            },
        );
        if let Some(p) = profile.map(str::trim).filter(|p| is_profile_slug(p)) {
            q.append_pair("override_profile", p);
        }
    }
    Some(url)
}

/// Every server string here ends up in a Segmented label, a placeholder or a tooltip.
fn bound_decode_default(d: &mut DecodeDefault, text_max: usize) {
    d.value = match std::mem::take(&mut d.value) {
        serde_json::Value::String(s) => {
            serde_json::Value::String(super::bounded_server_text(&s, text_max))
        }
        // Documented as a scalar; an array or object is not a value the editor can show.
        v @ (serde_json::Value::Bool(_) | serde_json::Value::Number(_)) => v,
        _ => serde_json::Value::Null,
    };
    d.source = bounded_name(&d.source);
    d.label = bounded_name(&d.label);
}

fn bound_decode_defaults(d: &mut DecodeDefaults) {
    d.model = bounded_name(&d.model);
    d.profile_applied = d.profile_applied.as_deref().map(bounded_name);
    for entry in d.settings.each_mut() {
        bound_decode_default(entry, SERVER_TEXT_MAX);
    }
    bound_decode_default(&mut d.prompt, SERVER_TEXT_MAX);
}

/// The decode values the caller inherits from the server for `model` (and `profile`, the
/// override profile the request would name) — `GET /v1/decode-defaults`. Best-effort: any
/// error → None, and the editor shows the bare "Inherit".
pub async fn get_decode_defaults(
    server_url: &str,
    model: &str,
    profile: Option<&str>,
    api_key: Option<&str>,
) -> Option<DecodeDefaults> {
    let url = decode_defaults_url(server_url, model, profile)?;
    let mut d: DecodeDefaults = get_json(url.into(), api_key).await?;
    bound_decode_defaults(&mut d);
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::{bound_decode_defaults, decode_defaults_url};
    use crate::transport::DecodeDefaults;

    #[test]
    fn decode_defaults_url_encodes_the_model_and_keeps_only_a_slug_profile() {
        let u = decode_defaults_url("http://h:8000", "org/repo:q8 x", Some("studio")).unwrap();
        assert_eq!(
            u.as_str(),
            "http://h:8000/v1/decode-defaults?model=org%2Frepo%3Aq8+x&override_profile=studio"
        );
        let none = decode_defaults_url("http://h:8000", "", Some("__none__")).unwrap();
        assert_eq!(none.query(), Some("model=&override_profile=__none__"));
        let bad = decode_defaults_url("http://h:8000", "tiny", Some("../x")).unwrap();
        assert_eq!(bad.query(), Some("model=tiny"));
        let long = decode_defaults_url("http://h:8000", &"m".repeat(201), None).unwrap();
        assert_eq!(long.query(), Some("model="));
    }

    /// The typed mirror drops what it does not name: every decode key, the prompt and the
    /// streaming pins must survive the round trip to the webview.
    #[test]
    fn decode_defaults_keep_every_key() {
        let keys = [
            "beam_size",
            "best_of",
            "vad_filter",
            "vad_min_silence_duration_ms",
            "vad_speech_pad_ms",
            "vad_threshold",
            "condition_on_previous_text",
            "no_speech_threshold",
            "log_prob_threshold",
            "compression_ratio_threshold",
            "hotwords",
            "temperature",
            "patience",
            "length_penalty",
            "repetition_penalty",
            "no_repeat_ngram_size",
            "suppress_tokens",
            "prepend_punctuations",
            "append_punctuations",
            "multilingual",
        ];
        let settings: serde_json::Map<String, serde_json::Value> = keys
            .iter()
            .enumerate()
            .map(|(i, k)| {
                let v = serde_json::json!({"value": i, "source": "server", "label": "global default", "locked": i == 3});
                (k.to_string(), v)
            })
            .collect();
        let raw = serde_json::json!({
            "model": "tiny", "profile_applied": "studio", "settings": settings,
            "prompt": {"value": "Hallo", "source": "account", "label": "key · direct", "locked": true},
            "streaming": {"condition_on_previous_text": {"final": false, "partial": false, "pinned": true},
                          "best_of": {"value": 1}},
        });
        let d: DecodeDefaults = serde_json::from_value(raw).unwrap();
        let out = serde_json::to_value(d).unwrap();
        for (i, k) in keys.iter().enumerate() {
            assert_eq!(out["settings"][k]["value"], i, "{k}");
        }
        assert_eq!(
            out["settings"]["vad_min_silence_duration_ms"]["locked"],
            true
        );
        assert_eq!(out["prompt"]["value"], "Hallo");
        assert_eq!(out["profile_applied"], "studio");
        assert_eq!(
            out["streaming"]["condition_on_previous_text"]["pinned"],
            true
        );
        assert_eq!(
            out["streaming"]["condition_on_previous_text"]["final"],
            false
        );
        assert_eq!(out["streaming"]["best_of"]["value"], 1);
    }

    #[test]
    fn decode_defaults_are_bounded_scalars() {
        let raw = serde_json::json!({
            "model": "m".repeat(500),
            "settings": {
                "beam_size": {"value": [1, 2]},
                "temperature": {"value": "0.0,0.2"},
                "hotwords": {"value": "w".repeat(5000), "label": "l".repeat(500)},
                "vad_filter": {"value": {"x": 1}},
            },
            "prompt": {"value": "p\u{202e}x"},
        });
        let mut d: DecodeDefaults = serde_json::from_value(raw).unwrap();
        bound_decode_defaults(&mut d);
        assert!(d.settings.beam_size.value.is_null());
        assert!(d.settings.vad_filter.value.is_null());
        assert_eq!(d.settings.temperature.value, "0.0,0.2");
        assert!(d.settings.hotwords.value.as_str().unwrap().chars().count() <= 2049); // + "…"
        assert!(d.settings.hotwords.label.chars().count() <= 121);
        assert!(d.model.chars().count() <= 121);
        assert!(!d.prompt.value.as_str().unwrap().contains('\u{202e}'));
    }

    use super::UsageQuery;

    /// The typed mirror drops what it does not name: the jobs keys the
    /// reconcile step gates on must survive the round trip.
    #[test]
    fn capabilities_parse_jobs_flags() {
        let raw = serde_json::json!({"jobs_enabled": true, "jobs": {"ttl_s": 259200}});
        let caps: super::super::Capabilities = serde_json::from_value(raw).unwrap();
        assert_eq!(caps.jobs_enabled, Some(true));
        assert_eq!(caps.jobs.as_ref().map(|j| j.ttl_s), Some(259200.0));
        let out = serde_json::to_value(caps).unwrap();
        assert_eq!(out["jobs_enabled"], true);
        assert_eq!(out["jobs"]["ttl_s"], 259200.0);
        let none: super::super::Capabilities =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(none.jobs_enabled, None);
    }

    /// The typed mirror drops what it does not name: the video/packaging
    /// keys the frontend gates its UI on must survive the round trip.
    #[test]
    fn capabilities_keep_the_video_and_packaging_keys() {
        let raw = serde_json::json!({
            "url_download_enabled": true,
            "url_video_enabled": true,
            "url_video_default_max_height": null,
            "url_subtitles_enabled": true,
            "url_language_check_enabled": false,
            "media_max_bytes": 10_000_000_000u64,
            "media_package_enabled": true,
            "media_package": {
                "containers": ["mkv", "mp4", "avi"],
                "max_tracks": 12,
                "max_srt_bytes": 2_097_152,
                "max_upload_bytes": 10_000_000_000u64,
                "reason": null,
                "ffmpeg_version": "7.0.2"
            }
        });
        let caps: super::super::Capabilities = serde_json::from_value(raw).unwrap();
        assert_eq!(caps.url_video_enabled, Some(true));
        assert_eq!(caps.url_subtitles_enabled, Some(true));
        assert_eq!(caps.url_language_check_enabled, Some(false));
        assert_eq!(caps.url_video_default_max_height, None);
        assert_eq!(caps.media_max_bytes, Some(10_000_000_000));
        assert_eq!(caps.media_package_enabled, Some(true));
        let pk = super::bound_media_package(caps.media_package.unwrap());
        assert_eq!(pk.containers, vec!["mkv", "mp4"]);
        assert_eq!(pk.max_tracks, 12);
        assert_eq!(pk.ffmpeg_version.as_deref(), Some("7.0.2"));
        let out = serde_json::to_value(super::super::Capabilities {
            media_package: Some(pk),
            ..serde_json::from_value(serde_json::json!({})).unwrap()
        })
        .unwrap();
        assert_eq!(
            out["media_package"]["containers"],
            serde_json::json!(["mkv", "mp4"])
        );
    }

    /// Per-model translation languages survive the typed mirror, bounded; an unknown model
    /// (no list) stays unknown rather than becoming an empty list.
    #[test]
    fn capabilities_keep_bounded_translation_languages() {
        let raw = serde_json::json!({
            "translation_models": [
                {"id": "hy-mt", "loaded": true, "languages": ["de", "x".repeat(40)]},
                {"id": "custom", "loaded": false, "languages": null},
                {"id": "big", "loaded": false, "languages": vec!["en"; 600]},
            ]
        });
        let caps: super::super::Capabilities = serde_json::from_value(raw).unwrap();
        let models = super::bound_models(caps.translation_models).unwrap();
        let langs = models[0].languages.as_ref().unwrap();
        assert_eq!(langs, &["de"]); // the 40-char "code" is dropped, not truncated
        assert_eq!(models[1].languages, None);
        assert_eq!(models[2].languages.as_ref().unwrap().len(), 500);
        let out = serde_json::to_value(&models).unwrap();
        assert_eq!(out[0]["languages"][0], "de");
        assert!(out[1].get("languages").is_none());
    }

    #[test]
    fn usage_query_validates_every_value_before_it_reaches_the_url() {
        let q = UsageQuery {
            days: Some(30),
            tz: Some("Europe/Zurich".into()),
            ..Default::default()
        };
        assert_eq!(q.to_query(), "days=30&tz=Europe/Zurich");
        // from/to win over days; all wins over both; unknown stages and a bad zone are dropped.
        let q = UsageQuery {
            days: Some(30),
            from: Some(100),
            to: Some(200),
            with: vec!["vad".into(), "bogus; DROP".into(), "translating".into()],
            tz: Some("../etc".into()),
            ..Default::default()
        };
        assert_eq!(q.to_query(), "from=100&to=200&with=vad,translating");
        let q = UsageQuery {
            all: true,
            from: Some(1),
            ..Default::default()
        };
        assert_eq!(q.to_query(), "all=1");
        assert_eq!(UsageQuery::default().to_query(), "");
    }
}
