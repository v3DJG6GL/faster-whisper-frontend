//! In-app log capture: a bounded ring buffer fed by a `tracing` layer, a
//! batched event stream for the Logs screen, per-session log files with
//! age-based pruning, and a live-reloadable level filter.
//!
//! Ordering contract: `LogRing`/`SwapWriter` are created in `run()` BEFORE
//! `init()` so no startup line is lost; the session file opens later (in
//! `.setup()`, once the config and path resolver exist) and the ring is
//! replayed into it, so the file is still complete from line 1.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{Config, LogLevel};

pub const RING_CAP: usize = 10_000;
/// One `log://lines` batch never exceeds this many lines, so a burst can't stall the
/// pump's tick. `get_log_tail` hydrates ONCE at screen mount and never again: a
/// sustained flood above BATCH_CAP/PUMP_INTERVAL evicts un-emitted ring lines and the
/// screen's tail is quietly incomplete (the file on disk still has them). No seq-gap
/// signal exists yet.
const BATCH_CAP: usize = 500;
const PUMP_INTERVAL_MS: u64 = 150;
/// Status (badge counters) is checked every Nth pump tick ≈ ~1 s.
const STATUS_EVERY_TICKS: u32 = 7;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    /// Milliseconds since the Unix epoch; the frontend renders local time.
    pub ts: u64,
    pub level: &'static str,
    pub target: String,
    /// Parsed leading `[subsystem]` tag, when the message carries one.
    pub tag: Option<String>,
    /// Message with the tag stripped.
    pub msg: String,
}

#[derive(Default)]
struct RingInner {
    lines: VecDeque<LogLine>,
    next_seq: u64,
    /// Cumulative since launch — the sidebar badge diffs against a baseline.
    errors: u64,
    warns: u64,
    /// Logs screen open → the pump batches new lines over `log://lines`.
    stream_active: bool,
    emitted_seq: u64,
    status_emitted: (u64, u64),
}

#[derive(Clone, Default)]
pub struct LogRing(Arc<Mutex<RingInner>>);

impl LogRing {
    fn push(&self, mut line: LogLine) {
        let Ok(mut inner) = self.0.lock() else { return };
        line.seq = inner.next_seq;
        inner.next_seq += 1;
        match line.level {
            "error" => inner.errors += 1,
            "warn" => inner.warns += 1,
            _ => {}
        }
        if inner.lines.len() >= RING_CAP {
            inner.lines.pop_front();
        }
        inner.lines.push_back(line);
    }

    fn tail(&self, since_seq: u64) -> LogTail {
        let Ok(inner) = self.0.lock() else {
            return LogTail::default();
        };
        LogTail {
            lines: inner
                .lines
                .iter()
                .filter(|l| l.seq >= since_seq)
                .cloned()
                .collect(),
            errors: inner.errors,
            warns: inner.warns,
            seq: inner.next_seq,
        }
    }
}

/// `"[pipeline] connect failed"` → `(Some("pipeline"), "connect failed")`.
/// Only a short lowercase/digit/`_`/`-` bracket counts as a tag (the shape all
/// existing call sites use); anything else stays part of the message.
pub fn split_tag(msg: &str) -> (Option<String>, &str) {
    let rest = msg.strip_prefix('[');
    if let Some(rest) = rest {
        if let Some(end) = rest.find(']') {
            let tag = &rest[..end];
            if (1..=24).contains(&tag.len())
                && tag
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            {
                return (Some(tag.to_string()), rest[end + 1..].trim_start());
            }
        }
    }
    (None, msg)
}

/// Pulls the `message` field out of a tracing event (the text `fmt` prints).
#[derive(Default)]
struct MsgVisitor {
    msg: String,
}

impl tracing::field::Visit for MsgVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.msg = format!("{value:?}");
        }
    }
}

fn level_str(level: &tracing::Level) -> &'static str {
    match *level {
        tracing::Level::ERROR => "error",
        tracing::Level::WARN => "warn",
        tracing::Level::INFO => "info",
        tracing::Level::DEBUG => "debug",
        tracing::Level::TRACE => "trace",
    }
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// The capture layer. Does one string format and one VecDeque push under a
/// short lock — and never logs itself, so it cannot re-enter.
pub struct RingLayer {
    pub ring: LogRing,
}

impl<S> tracing_subscriber::Layer<S> for RingLayer
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _cx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut v = MsgVisitor::default();
        event.record(&mut v);
        let (tag, msg) = split_tag(&v.msg);
        self.ring.push(LogLine {
            seq: 0, // assigned under the ring lock
            ts: now_ms(),
            level: level_str(event.metadata().level()),
            target: event.metadata().target().to_string(),
            tag,
            msg: msg.to_string(),
        });
    }
}

/// A `MakeWriter` whose file can be (re)opened after subscriber init —
/// `init()` runs before Tauri's path resolver exists. Writes are dropped
/// while unset (the ring keeps those lines for the later replay).
#[derive(Clone, Default)]
pub struct SwapWriter(Arc<Mutex<SwapInner>>);

#[derive(Default)]
struct SwapInner {
    file: Option<std::fs::File>,
    /// Directory of the open file, for folder-change detection.
    dir: Option<PathBuf>,
}

pub struct SwapGuard(Arc<Mutex<SwapInner>>);

impl Write for SwapGuard {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut inner) = self.0.lock() {
            if let Some(f) = inner.file.as_mut() {
                return f.write(buf);
            }
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Ok(mut inner) = self.0.lock() {
            if let Some(f) = inner.file.as_mut() {
                return f.flush();
            }
        }
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SwapWriter {
    type Writer = SwapGuard;
    fn make_writer(&'a self) -> SwapGuard {
        SwapGuard(self.0.clone())
    }
}

type ReloadHandle =
    tracing_subscriber::reload::Handle<tracing_subscriber::EnvFilter, tracing_subscriber::Registry>;

/// Statics avoid threading the reload handle's registry generic through Tauri
/// managed state.
static RELOAD: OnceLock<ReloadHandle> = OnceLock::new();
static ENV_OVERRIDE: OnceLock<bool> = OnceLock::new();

fn env_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "faster_whisper_frontend_lib=info,info".into())
}

/// Install the subscriber stack: reloadable filter → ring → console → file.
/// Called once, first thing in `run()`.
pub fn init(ring: LogRing, writer: SwapWriter) {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt};

    let _ = ENV_OVERRIDE.set(std::env::var_os("RUST_LOG").is_some());
    let (filter, handle) = tracing_subscriber::reload::Layer::new(env_filter());
    let _ = RELOAD.set(handle);
    tracing_subscriber::registry()
        .with(filter)
        .with(RingLayer { ring })
        .with(fmt::layer().with_timer(LocalTimer))
        .with(fmt::layer().with_timer(LocalTimer).with_ansi(false).with_writer(writer))
        .init();
}

/// Live level swap from the Settings control. `RUST_LOG` keeps priority: when
/// the env var was set at launch, the setting is inert.
pub fn apply_log_level(level: LogLevel) {
    if ENV_OVERRIDE.get().copied().unwrap_or(false) {
        return;
    }
    let l = level.as_str();
    if let Some(h) = RELOAD.get() {
        let _ = h.reload(tracing_subscriber::EnvFilter::new(format!(
            "faster_whisper_frontend_lib={l},info"
        )));
    }
}

/// The log directory: the user's custom folder when set, else `<app_local_data>/logs` —
/// on Windows `%LOCALAPPDATA%\ch.informethic.faster-whisper-frontend\logs`. Local, not
/// Roaming (`app_data_dir` is `%APPDATA%` on Windows): logs must not sync between
/// machines. This is NOT the pre-viewer `%LOCALAPPDATA%\faster-whisper-frontend\logs`;
/// `prune_legacy_dir` clears that folder's pair out.
pub fn log_dir(app: &AppHandle, config: &Config) -> Option<PathBuf> {
    if let Some(dir) = config
        .settings
        .logging
        .log_dir
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return Some(PathBuf::from(dir));
    }
    app.path().app_local_data_dir().ok().map(|d| d.join("logs"))
}

/// The superseded single-file scheme's pair, wherever it landed.
pub fn prune_legacy_dir(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("fwf.log"));
    let _ = std::fs::remove_file(dir.join("fwf.prev.log"));
}

/// One timestamp format for the whole session file: the replayed ring head (`format_line`)
/// and the live tail (`fmt::layer`) used to write two different clocks into one file — local
/// time without a date, then UTC RFC-3339 — so correlating a startup line with a later one
/// meant comparing clocks hours apart in the artifact users attach to bug reports.
const TS_FORMAT: &str = "%Y-%m-%d %H:%M:%S%.3f";

/// `tracing_subscriber` timer matching `format_line`: local time, `TS_FORMAT`.
struct LocalTimer;

impl tracing_subscriber::fmt::time::FormatTime for LocalTimer {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> std::fmt::Result {
        write!(w, "{}", chrono::Local::now().format(TS_FORMAT))
    }
}

fn format_line(l: &LogLine) -> String {
    let ts = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(l.ts as i64)
        .map(|t| t.with_timezone(&chrono::Local).format(TS_FORMAT).to_string())
        .unwrap_or_default();
    let level = l.level.to_uppercase();
    match &l.tag {
        Some(tag) => format!("{ts} {level:5} {}: [{tag}] {}\n", l.target, l.msg),
        None => format!("{ts} {level:5} {}: {}\n", l.target, l.msg),
    }
}

/// Open this session's log file in `dir` (creating it), replaying the ring's
/// current contents first so the file is complete from launch. Reused for a
/// live folder change — the new file again starts with the full history.
pub fn open_session_file(writer: &SwapWriter, ring: &LogRing, dir: &Path) {
    if crate::audio::create_dir_private(dir).is_err() {
        return;
    }
    let name = format!(
        "fwf-{}.log",
        chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")
    );
    let path = dir.join(name);
    let Ok(mut file) = std::fs::File::create(&path) else {
        return;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    if let Ok(mut inner) = writer.0.lock() {
        for line in ring.tail(0).lines {
            let _ = file.write_all(format_line(&line).as_bytes());
        }
        inner.file = Some(file);
        inner.dir = Some(dir.to_path_buf());
    }
}

/// Delete `fwf-*.log` files older than `keep_days` (by mtime; 0 = keep
/// forever). Also removes the superseded single-file scheme's
/// `fwf.log`/`fwf.prev.log` pair.
pub fn prune_log_files(dir: &Path, keep_days: u32) {
    prune_legacy_dir(dir);
    if keep_days == 0 {
        return;
    }
    // Clamp before the arithmetic — see `audio::prune_recordings` for the Windows overflow
    // panic this prevents (inside setup(), with the value already persisted).
    const MAX_RETENTION_DAYS: u32 = 3650;
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(u64::from(keep_days.min(MAX_RETENTION_DAYS)) * 24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("fwf-") && name.ends_with(".log")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Config-save side effect (also run once in setup): reload the level, move
/// the session file if the folder changed, and prune old files.
pub fn apply_log_settings(app: &AppHandle, config: &Config) {
    apply_log_level(config.settings.logging.log_level);
    let Some(dir) = log_dir(app, config) else { return };
    let writer = app.state::<SwapWriter>();
    let ring = app.state::<LogRing>();
    let current = writer.0.lock().ok().and_then(|i| i.dir.clone());
    if current.as_deref() != Some(dir.as_path()) {
        open_session_file(&writer, &ring, &dir);
        if let Some(old) = current.as_deref() {
            prune_log_files(old, config.settings.logging.keep_days);
        }
    }
    prune_log_files(&dir, config.settings.logging.keep_days);
    // The pre-viewer builds wrote `%LOCALAPPDATA%\faster-whisper-frontend\logs`; the
    // legacy pair there was never reached by the prune above.
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        prune_legacy_dir(&PathBuf::from(base).join("faster-whisper-frontend").join("logs"));
    }
}

/// Batches ring lines to the Logs screen (only while it's open) and pushes
/// badge counters when they change. All emits happen outside the ring lock.
pub fn spawn_emit_pump(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick: u32 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(PUMP_INTERVAL_MS)).await;
            tick = tick.wrapping_add(1);
            let ring = app.state::<LogRing>();

            let mut batch: Vec<LogLine> = Vec::new();
            let mut status: Option<(u64, u64, u64)> = None;
            if let Ok(mut inner) = ring.0.lock() {
                if inner.stream_active && inner.emitted_seq < inner.next_seq {
                    let from = inner.emitted_seq;
                    batch = inner
                        .lines
                        .iter()
                        .filter(|l| l.seq >= from)
                        .take(BATCH_CAP)
                        .cloned()
                        .collect();
                    if let Some(last) = batch.last() {
                        inner.emitted_seq = last.seq + 1;
                    }
                }
                if tick % STATUS_EVERY_TICKS == 0 {
                    let now = (inner.errors, inner.warns);
                    if now != inner.status_emitted {
                        inner.status_emitted = now;
                        status = Some((inner.next_seq, now.0, now.1));
                    }
                }
            }
            if !batch.is_empty() {
                let _ = app.emit("log://lines", serde_json::json!({ "lines": batch }));
            }
            if let Some((seq, errors, warns)) = status {
                let _ = app.emit(
                    "log://status",
                    serde_json::json!({ "seq": seq, "errors": errors, "warns": warns }),
                );
            }
        }
    });
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    pub lines: Vec<LogLine>,
    pub errors: u64,
    pub warns: u64,
    pub seq: u64,
}

#[tauri::command]
pub fn get_log_tail(since_seq: u64, ring: State<'_, LogRing>) -> LogTail {
    ring.tail(since_seq)
}

/// Logs screen open/closed — gates the `log://lines` stream. On open the
/// screen hydrates via `get_log_tail`, so the stream starts from "now".
#[tauri::command]
pub fn set_log_stream(active: bool, ring: State<'_, LogRing>) {
    if let Ok(mut inner) = ring.0.lock() {
        inner.stream_active = active;
        if active {
            inner.emitted_seq = inner.next_seq;
        }
    }
}

/// Badge hydration at startup: counters only, no lines.
#[tauri::command]
pub fn get_log_status(ring: State<'_, LogRing>) -> LogTail {
    let mut t = ring.tail(u64::MAX);
    t.lines = Vec::new();
    t
}

/// The live `logDir` preference as the config field: a blank or absent custom folder means
/// the default, never "no opinion".
fn live_log_dir(custom: Option<String>) -> Option<String> {
    custom.map(|c| c.trim().to_string()).filter(|c| !c.is_empty())
}

/// Resolve the effective log directory from the LIVE custom preference, without
/// loading (and potentially recovering/backing-up) config.json. `log_dir` only
/// reads `settings.logging.log_dir`, so inlining its logic avoids the destructive
/// recovery path that `config::load` triggers on an unreadable or corrupt config.
fn resolve_log_dir(app: &AppHandle, custom: Option<String>) -> Option<std::path::PathBuf> {
    if let Some(dir) = live_log_dir(custom) {
        return Some(std::path::PathBuf::from(dir));
    }
    app.path().app_local_data_dir().ok().map(|d| d.join("logs"))
}

#[tauri::command]
pub fn log_folder_path(app: AppHandle, custom: Option<String>) -> Result<String, String> {
    // `custom` is the LIVE preference (null/blank = the default folder): the store's save is
    // debounced, so the on-disk config lags a change by 400 ms — and it lags a RESET too, so
    // "None = read the config" showed (and opened) the just-cleared custom folder.
    let dir = resolve_log_dir(&app, custom).ok_or("no log folder")?;
    // Home-relative display, same as audio_dir_path.
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Ok(format!("~/{}", rest.display()));
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_log_folder(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = resolve_log_dir(&app, custom).ok_or("no log folder")?;
    crate::audio::create_dir_private(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_replayed_head_uses_the_same_stamp_format_as_the_live_tail() {
        let l = LogLine { seq: 1, ts: 1_700_000_000_123, level: "info", target: "t".into(), tag: None, msg: "m".into() };
        let out = format_line(&l);
        // "YYYY-MM-DD HH:MM:SS.mmm" — a date, a space, a time with millis.
        let stamp = out.split(' ').take(2).collect::<Vec<_>>().join(" ");
        assert_eq!(stamp.len(), "2023-11-14 22:13:20.123".len(), "{out:?}");
        assert!(stamp.as_bytes()[4] == b'-' && stamp.as_bytes()[10] == b' ' && stamp.as_bytes()[19] == b'.', "{out:?}");
    }

    #[test]
    fn the_live_tail_timer_writes_the_same_stamp_shape() {
        use tracing_subscriber::fmt::{format::Writer, time::FormatTime};
        let mut s = String::new();
        LocalTimer.format_time(&mut Writer::new(&mut s)).unwrap();
        assert_eq!(s.len(), "2023-11-14 22:13:20.123".len(), "{s:?}");
        assert!(s.as_bytes()[4] == b'-' && s.as_bytes()[10] == b' ' && s.as_bytes()[19] == b'.', "{s:?}");
    }

    fn line(msg: &str, level: &'static str) -> LogLine {
        let (tag, rest) = split_tag(msg);
        LogLine {
            seq: 0,
            ts: 0,
            level,
            target: "t".into(),
            tag,
            msg: rest.to_string(),
        }
    }

    #[test]
    fn split_tag_parses_known_shapes() {
        assert_eq!(
            split_tag("[pipeline] connect failed"),
            (Some("pipeline".into()), "connect failed")
        );
        assert_eq!(
            split_tag("[wayland-inject] ok"),
            (Some("wayland-inject".into()), "ok")
        );
        assert_eq!(split_tag("no tag here"), (None, "no tag here"));
        // Uppercase, spaces, over-long, or non-ascii brackets are not tags.
        assert_eq!(split_tag("[HTTP] x"), (None, "[HTTP] x"));
        assert_eq!(split_tag("[two words] x"), (None, "[two words] x"));
        assert_eq!(
            split_tag("[abcdefghijklmnopqrstuvwxyz0] x"),
            (None, "[abcdefghijklmnopqrstuvwxyz0] x")
        );
        assert_eq!(split_tag("[töö] x"), (None, "[töö] x"));
        assert_eq!(split_tag("[] x"), (None, "[] x"));
    }

    #[test]
    fn ring_caps_and_counts() {
        let ring = LogRing::default();
        for i in 0..(RING_CAP + 5) {
            let lvl = if i % 3 == 0 { "warn" } else { "info" };
            ring.push(line(&format!("[audio] m{i}"), lvl));
        }
        ring.push(line("boom", "error"));
        let t = ring.tail(0);
        assert_eq!(t.lines.len(), RING_CAP);
        assert_eq!(t.seq, (RING_CAP + 6) as u64);
        // Oldest lines were dropped; seqs stay monotonic and dense.
        assert_eq!(t.lines.first().unwrap().seq, 6);
        assert_eq!(t.lines.last().unwrap().seq, (RING_CAP + 5) as u64);
        assert_eq!(t.errors, 1);
        assert!(t.warns >= 1);
        // since_seq filter
        let recent = ring.tail(t.seq - 3);
        assert_eq!(recent.lines.len(), 3);
    }

    #[test]
    fn prune_selects_by_name_and_age() {
        let dir = std::env::temp_dir().join(format!("fwf-prune-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("fwf-2020-01-01_00-00-00.log");
        let fresh = dir.join("fwf-2099-01-01_00-00-00.log");
        let other = dir.join("keep.txt");
        std::fs::write(&old, "x").unwrap();
        std::fs::write(&fresh, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        std::fs::write(dir.join("fwf.log"), "x").unwrap();
        std::fs::write(dir.join("fwf.prev.log"), "x").unwrap();
        // Age the old file's mtime beyond the window.
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(past).unwrap();
        drop(f);

        prune_log_files(&dir, 7);
        assert!(!old.exists(), "old session file pruned");
        assert!(fresh.exists(), "fresh session file kept");
        assert!(other.exists(), "unrelated files untouched");
        assert!(!dir.join("fwf.log").exists(), "legacy file removed");
        assert!(!dir.join("fwf.prev.log").exists(), "legacy prev removed");

        // keep_days = 0 → forever (only legacy files go).
        std::fs::write(&old, "x").unwrap();
        prune_log_files(&dir, 0);
        assert!(old.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
