//! Connection test + model discovery against `/v1/models` and `/auth/whoami`.

use super::{
    base_url, client, friendly_err, get_json, with_auth, Capabilities, ConnectionInfo,
    ResolvedOverrideProfile, ServerModel, UsageStats,
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
/// Whisper caps `initial_prompt` at 224 tokens server-side, so this cannot clip a real one.
const PROMPT_MAX: usize = 2000;
/// The decode-values map is a handful of scalars; anything past this is not a real profile.
const VALUES_MAX_BYTES: usize = 64 * 1024;
/// Ceiling on the usage trend points kept. The server clamps `days` to 366 and the client
/// renders the tail, so this removes the 32 MiB body headroom without clipping a real window.
const MAX_SERIES: usize = 366;

fn bounded_name(s: &str) -> String {
    super::bounded_server_text(s, MAX_NAME)
}

pub async fn test_connection(server_url: &str, api_key: Option<&str>) -> ConnectionInfo {
    let base = base_url(server_url);
    let http = client();

    // /auth/whoami is best-effort (open-mode banner / username); ignore its failures.
    let (mut open_mode, mut username) = (false, None);
    // Status-gated like every sibling probe (`get_json`, the `/v1/models` arm below,
    // `get_recent_words`): without it a 401 or 500 whose body happens to parse was rendered as a
    // successful identity — an unauthenticated error response showing an open-mode banner and a
    // username in the connection UI.
    if let Ok(resp) = with_auth(http.get(format!("{base}/auth/whoami")), api_key).send().await {
        if resp.status().is_success() {
            if let Ok(who) = super::json_capped_to::<WhoAmI>(resp, super::MAX_META_BODY).await {
                open_mode = who.open_mode;
                // Bounded and control-folded HERE so every consumer inherits it: the username is
                // rendered inline with the connection verdict ("· open mode (no auth)" / "· name"),
                // which is the text the user reads to judge the connection. Unbounded it was a
                // 32 MiB layout freeze; with bidi marks it reorders the verdict around it.
                username = who.username.map(|u| bounded_name(&u));
            }
        }
    }

    // /v1/models is the actual connectivity gate.
    match with_auth(http.get(format!("{base}/v1/models")), api_key).send().await {
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
                    error: Some("Unauthorized — an API key is required or the key is invalid.".into()),
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
                        .map(|m| ServerModel { id: bounded_name(&m.id), loaded: m.loaded })
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
                    // serde's `invalid_type` Display echoes the OFFENDING VALUE untruncated, so
                    // `{"data":"<1 MiB string>"}` — well inside MAX_META_BODY — yields a ~1 MiB
                    // error string (measured: a 1 MB value produces 1,000,069 bytes). serde
                    // formats it with `{:?}`, which already escapes the bidi class, so this is a
                    // volume defect rather than a spoofing one — but volume is the whole harm here.
                    // Every sibling field on these arms is already `bounded_name`d, and both
                    // static error arms plus `friendly_err` are bounded to 300; this was the one
                    // unbounded server-authored string left in `ConnectionInfo`. Its three renders
                    // pass it through raw into a wrapping Notice — millions of line boxes in the
                    // window that owns the debounced config save — and it is the text the user
                    // reads to decide whether to keep pointing at this address, immediately
                    // before the restore offer that applies a whole settings blob.
                    error: Some(super::bounded_server_text(
                        &format!("Unexpected /v1/models response: {e}"),
                        300,
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
        .map(|r| r.profiles.iter().take(MAX_MODELS).map(|p| bounded_name(p)).collect())
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
    // sibling here — `models`, `list_override_profiles`, `ResolvedOverrideProfile.locked` — takes
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
    // Per-stage model lists feed pickers — same treatment as `models`.
    let bound_models = |list: Option<Vec<ServerModel>>| {
        list.map(|mut v| {
            v.truncate(MAX_MODELS);
            v.into_iter()
                .map(|m| ServerModel { id: bounded_name(&m.id), loaded: m.loaded })
                .collect::<Vec<_>>()
        })
    };
    caps.translation_models = bound_models(caps.translation_models);
    caps.diarization_models = bound_models(caps.diarization_models);
    caps.separation_models = bound_models(caps.separation_models);
    let bound_langs = |list: Option<Vec<String>>| {
        list.map(|mut v| {
            v.truncate(MAX_MODELS);
            v.iter().map(|s| super::bounded_server_text(s, 16)).collect::<Vec<_>>()
        })
    };
    caps.translation_languages = bound_langs(caps.translation_languages);
    caps.translate_to_default = caps.translate_to_default.map(|mut v| {
        v.truncate(8);
        v.iter().map(|s| super::bounded_server_text(s, 16)).collect()
    });
    Some(caps)
}

/// Ceiling on the list blocks of the usage document (stages / targets-per-stage / apps).
const MAX_USAGE_LIST: usize = 16;
/// Ceiling on the calendar days kept (the client asks for 90).
const MAX_CALENDAR: usize = 400;

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
    days: Option<i64>,
    tz: Option<&str>,
) -> Option<UsageStats> {
    let base = base_url(server_url);
    let mut q: Vec<String> = Vec::new();
    if let Some(d) = days {
        q.push(format!("days={d}"));
    }
    if let Some(z) = tz {
        if iana_zone_ok(z) {
            q.push(format!("tz={z}"));
        }
    }
    let url = if q.is_empty() {
        format!("{base}/v1/usage")
    } else {
        format!("{base}/v1/usage?{}", q.join("&"))
    };
    // Every string and list here rides in a struct the store re-serializes with TWO
    // JSON.stringify passes on the main thread every 30s for every backend — the same reason
    // `series` is sliced client-side. The `test_connection` sibling caps `username`.
    let mut u: UsageStats = get_json(url, api_key).await?;
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
    u.stages.truncate(MAX_USAGE_LIST);
    for st in &mut u.stages {
        st.stage = super::bounded_server_text(&st.stage, 32);
        st.targets.truncate(MAX_USAGE_LIST);
        for t in &mut st.targets {
            t.code = super::bounded_server_text(&t.code, 16);
        }
    }
    u.apps.truncate(MAX_USAGE_LIST);
    for a in &mut u.apps {
        a.app_id = super::bounded_server_text(&a.app_id, 64);
    }
    Some(u)
}

/// A single override-profile's decode values + locked client keys
/// (`GET /v1/override-profiles/{name}`), for previewing inherited defaults.
/// Best-effort: any error (incl. 404 when the caller may not request it) → None.
pub async fn get_override_profile(
    server_url: &str,
    name: &str,
    api_key: Option<&str>,
) -> Option<ResolvedOverrideProfile> {
    // Enforce the slug invariant before interpolating `name` into the path: server profile
    // names are `[a-z0-9-_]`. A free-typed "custom name" that isn't one can't match a real
    // profile, and pasting it raw could escape the path (e.g. "../") or break URL parsing —
    // so a non-slug name is treated as "no such profile" (None), consistent with best-effort.
    if name.is_empty()
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let base = base_url(server_url);
    let url = format!("{base}/v1/override-profiles/{name}");
    // Its sibling `list_override_profiles` is capped; this one returned every field straight off
    // the wire, and the editor fetches it from a `useEffect` with no user gesture — `prompt`
    // becomes a textarea placeholder and each `values` entry a Segmented option label.
    let mut p: ResolvedOverrideProfile = get_json(url, api_key).await?;
    p.name = bounded_name(&p.name);
    p.prompt = p.prompt.map(|s| super::bounded_server_text(&s, PROMPT_MAX));
    p.locked.truncate(MAX_MODELS);
    p.locked = p.locked.iter().map(|s| bounded_name(s)).collect();
    // `values` is an opaque map rendered as option labels; drop it wholesale if it is absurd
    // rather than trying to bound each leaf of an arbitrary JSON shape.
    if serde_json::to_string(&p.values).map_or(true, |s| s.len() > VALUES_MAX_BYTES) {
        p.values = serde_json::json!({});
    }
    // Under that ceiling, still bound each leaf: `values` is documented as a FLAT
    // {client_decode_key: scalar} map, and `DecodeFields` puts `String(v)` into a Segmented
    // option label and an input placeholder. A single 64 KiB string, or one carrying bidi marks,
    // reached both surfaces raw — the one field in this response that skipped the treatment its
    // three siblings above get. Flat pass only: never recurse into attacker-chosen nesting.
    if let Some(map) = p.values.as_object_mut() {
        for v in map.values_mut() {
            if let Some(text) = v.as_str() {
                *v = serde_json::Value::String(super::bounded_server_text(text, MAX_NAME));
            }
        }
    }
    Some(p)
}
