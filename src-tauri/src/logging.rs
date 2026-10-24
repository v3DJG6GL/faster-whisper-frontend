//! In-app log capture: a bounded ring buffer fed by a `tracing` layer, a
//! batched event stream for the Logs screen, per-session log files with
//! age-based pruning, and a live-reloadable level filter.
//!
//! Ordering contract: `LogRing`/`SwapWriter` are created in `run()` BEFORE
//! `init()` so no startup line is lost; the session file opens later (queued
//! from `.setup()`, once the config and path resolver exist) and the ring is
//! replayed into it, so the file is still complete from line 1.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Pulls the `message` field out of a tracing event, plus its structured fields as
/// ` name=value` pairs, the text `fmt` prints. tracing-log's `log.*` metadata fields are
/// skipped, as `fmt` skips them.
#[derive(Default)]
struct MsgVisitor {
    msg: String,
    fields: String,
}

impl tracing::field::Visit for MsgVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let name = field.name();
        if name == "message" {
            self.msg = format!("{value:?}");
        } else if !name.starts_with("log.") {
            use std::fmt::Write as _;
            let _ = write!(self.fields, " {name}={value:?}");
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
    fn on_event(&self, event: &tracing::Event<'_>, _cx: tracing_subscriber::layer::Context<'_, S>) {
        let mut v = MsgVisitor::default();
        event.record(&mut v);
        let (tag, msg) = split_tag(&v.msg);
        // Fields after the tag split, so `[tag]` parsing is unchanged.
        let msg = if msg.is_empty() {
            v.fields.trim_start().to_string()
        } else {
            format!("{msg}{}", v.fields)
        };
        // `log`-crate records (tauri/tao/wry) arrive through LogTracer on a shared callsite
        // whose raw target is "log"; the fmt layers print the normalized one, so the ring
        // must too or the replayed session-file head disagrees with the live tail.
        use tracing_log::NormalizeEvent;
        let norm = event.normalized_metadata();
        let meta = norm.as_ref().unwrap_or_else(|| event.metadata());
        self.ring.push(LogLine {
            seq: 0, // assigned under the ring lock
            ts: now_ms(),
            level: level_str(meta.level()),
            target: meta.target().to_string(),
            tag,
            msg,
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
    /// The open file itself. Its parent is the folder, for folder-change detection; the prune
    /// must skip it: it is matched by mtime alone, and a quiet session (Warnings level, idle in
    /// the tray) can leave it older than `keep_days`.
    path: Option<PathBuf>,
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

/// Install the subscriber stack: reloadable filter → ring → console → file.
/// Called once, first thing in `run()`.
pub fn init(ring: LogRing, writer: SwapWriter) {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt};

    // Only a non-blank RUST_LOG that parses overrides the Settings level: a blank one counts as
    // unset (it would parse to an enable-nothing filter), a mistyped one falls back to Info with a
    // warning, and the setting must stay live rather than leave the log at a level nobody chose.
    let raw = std::env::var("RUST_LOG").ok();
    let env = env_override(raw.as_deref());
    let _ = ENV_OVERRIDE.set(matches!(env, Some(Ok(_))));
    let info = || tracing_subscriber::EnvFilter::new(level_directive(LogLevel::Info));
    let (filter0, rejected) = match env {
        Some(Ok(f)) => (f, None),
        Some(Err(e)) => (info(), Some(e)),
        None => (info(), None),
    };
    let (filter, handle) = tracing_subscriber::reload::Layer::new(filter0);
    let _ = RELOAD.set(handle);
    tracing_subscriber::registry()
        .with(filter)
        .with(RingLayer { ring })
        .with(fmt::layer().with_timer(LocalTimer))
        .with(
            fmt::layer()
                .with_timer(LocalTimer)
                .with_ansi(false)
                .with_writer(writer),
        )
        .init();
    if let Some(e) = rejected {
        tracing::warn!(
            "[logging] RUST_LOG {:?} is not a valid filter ({e}); using the Settings log level",
            raw.unwrap_or_default()
        );
    }
}

/// The launch filter `RUST_LOG` asks for: `None` when it is unset or blank (every
/// comma piece empty), else whether it parses — one bad directive rejects it all.
fn env_override(raw: Option<&str>) -> Option<Result<tracing_subscriber::EnvFilter, String>> {
    let raw = raw?;
    if raw.split(',').all(|p| p.trim().is_empty()) {
        return None;
    }
    Some(tracing_subscriber::EnvFilter::try_new(raw).map_err(|e| e.to_string()))
}

/// Live level swap from the Settings control. `RUST_LOG` keeps priority: when
/// a valid one was set at launch, the setting is inert.
pub fn apply_log_level(level: LogLevel) {
    if ENV_OVERRIDE.get().copied().unwrap_or(false) {
        return;
    }
    if let Some(h) = RELOAD.get() {
        let _ = h.reload(tracing_subscriber::EnvFilter::new(level_directive(level)));
    }
}

/// The filter directive for a chosen level: our crate at that level, every other
/// target (tauri, reqwest, cpal, log-bridged crates) at the stricter of it and
/// info — so Errors/Warnings really leave lower levels unrecorded everywhere.
fn level_directive(level: LogLevel) -> String {
    let l = level.as_str();
    let other = match level {
        LogLevel::Error => "error",
        LogLevel::Warn => "warn",
        LogLevel::Info | LogLevel::Debug => "info",
    };
    format!("faster_whisper_frontend_lib={l},{other}")
}

/// The log directory: the user's custom folder when set, else `<app_local_data>/logs` —
/// on Windows `%LOCALAPPDATA%\org.fasterwhisper.frontend\logs`. Local, not
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

/// One timestamp format (local time, with a date) for the whole session file: the replayed ring
/// head (`format_line`) and the live tail (`fmt::layer`) must share one clock, or a startup line
/// cannot be correlated with a later one in the file users attach to bug reports.
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
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format(TS_FORMAT)
                .to_string()
        })
        .unwrap_or_default();
    let level = l.level.to_uppercase();
    // Right-aligned like the live tail (`tracing_subscriber` pads " INFO"/" WARN"), so the
    // replayed head and the rest of the file share one level column.
    match &l.tag {
        Some(tag) => format!("{ts} {level:>5} {}: [{tag}] {}\n", l.target, l.msg),
        None => format!("{ts} {level:>5} {}: {}\n", l.target, l.msg),
    }
}

/// Create a NEW owner-only `fwf-<stamp>.log` in `dir` — never an existing name, so never through
/// a symlink planted in a shared folder, and created owner-only rather than chmod'ed after the
/// fact. A second launch (or folder change) in the same second takes `fwf-<stamp>-2.log` and so on
/// instead of truncating the first session's log; `prune_log_files` matches those names too.
fn create_session_file(dir: &Path, stamp: &str) -> std::io::Result<(std::fs::File, PathBuf)> {
    let mut last = None;
    for n in 1..=20u32 {
        let name = if n == 1 {
            format!("fwf-{stamp}.log")
        } else {
            format!("fwf-{stamp}-{n}.log")
        };
        let path = dir.join(name);
        match crate::audio::create_new_private(&path) {
            Ok(f) => return Ok((f, path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::ErrorKind::AlreadyExists.into()))
}

/// Open this session's log file in `dir` (creating it), replaying the ring's
/// current contents first so the file is complete from launch. Reused for a
/// live folder change — the new file again starts with the full history.
pub fn open_session_file(writer: &SwapWriter, ring: &LogRing, dir: &Path) {
    if let Err(e) = crate::audio::create_dir_private(dir) {
        tracing::warn!("[log] cannot create session log dir {}: {e}", dir.display());
        return;
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let (mut file, path) = match create_session_file(dir, &stamp) {
        Ok(created) => created,
        Err(e) => {
            tracing::warn!(
                "[log] cannot create session log file fwf-{stamp}.log in {}: {e}",
                dir.display()
            );
            return;
        }
    };
    if let Ok(mut inner) = writer.0.lock() {
        // Snapshot under the writer lock, so no line falls between the replay and the swap, and
        // one write: every logging thread waits on this lock, and the folder may be a slow share.
        let replay: String = ring.tail(0).lines.iter().map(format_line).collect();
        let _ = file.write_all(replay.as_bytes());
        inner.file = Some(file);
        inner.path = Some(path);
    }
}

/// Delete `fwf-*.log` files older than `keep_days` (by mtime; 0 = keep
/// forever), except `except` — the session's live file. Also removes the superseded
/// single-file scheme's `fwf.log`/`fwf.prev.log` pair.
pub fn prune_log_files(dir: &Path, keep_days: u32, except: Option<&Path>) {
    prune_legacy_dir(dir);
    // The shared sweep clamps the window (see `audio::MAX_RETENTION_DAYS` for the Windows
    // overflow panic that prevents, inside setup(), with the value already persisted).
    let _ = crate::audio::prune_older_than(dir, keep_days, |e| {
        let n = e.file_name();
        let n = n.to_string_lossy();
        n.starts_with("fwf-") && n.ends_with(".log") && Some(e.path().as_path()) != except
    });
}

/// The pruning-hold line is logged once per session: `apply_log_settings` runs on every save.
static LOGGED_PRUNE_HOLD: AtomicBool = AtomicBool::new(false);

/// Config-save side effect (also run once at launch, after the config load), always called
/// through `queue_log_settings`: move the session file if the folder changed, and prune old
/// files unless `held` — a reset nobody has saved over (`config::retention_held`, computed by the
/// caller before any write), the same hold as the retention sweeps. The defaults' `keep_days`
/// would otherwise delete logs the user's real (backed-up or unreadable) settings kept — the very
/// logs that explain the reset. The level is not applied here: it is a live switch
/// (`commands::set_live_switches`).
pub fn apply_log_settings(app: &AppHandle, config: &Config, held: bool) {
    let Some(dir) = log_dir(app, config) else {
        return;
    };
    let prune = !held;
    if !prune && !LOGGED_PRUNE_HOLD.swap(true, Ordering::SeqCst) {
        // A reset at this launch holds pruning for the whole session, saved over or not.
        if crate::config::reset_this_session() {
            tracing::info!(
                "[logging] settings were reset at this launch; log pruning skipped for the rest of this session"
            );
        } else {
            tracing::info!(
                "[logging] settings were reset; log pruning skipped until the settings are saved"
            );
        }
    }
    let writer = app.state::<SwapWriter>();
    let ring = app.state::<LogRing>();
    let current = writer.0.lock().ok().and_then(|i| {
        i.path
            .as_deref()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
    });
    if current.as_deref() != Some(dir.as_path()) {
        open_session_file(&writer, &ring, &dir);
    }
    // Read after any reopen: a failed reopen leaves the old folder's file live, and that one
    // must survive the old folder's prune too.
    let live = writer.0.lock().ok().and_then(|i| i.path.clone());
    if prune {
        if let Some(old) = current.as_deref().filter(|old| *old != dir.as_path()) {
            prune_log_files(old, config.settings.logging.keep_days, live.as_deref());
        }
        prune_log_files(&dir, config.settings.logging.keep_days, live.as_deref());
    }
    // The pre-viewer builds wrote `%LOCALAPPDATA%\faster-whisper-frontend\logs`; the
    // legacy pair there was never reached by the prune above.
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let legacy = PathBuf::from(base)
            .join("faster-whisper-frontend")
            .join("logs");
        prune_legacy_dir(&legacy);
        // …and the folder itself once it is empty, so machines that ran those builds stop
        // showing a stray second app folder. `remove_dir` only ever removes an EMPTY
        // directory. Deliberately not the parent: for a per-user (NSIS) install,
        // `%LOCALAPPDATA%\faster-whisper-frontend` is the program's install directory.
        let _ = std::fs::remove_dir(&legacy);
    }
}

/// Run `apply_log_settings` off the calling thread — setup() at launch and every written save:
/// a custom log folder can sit on a stalled mount (network share, sleeping disk), and its
/// create_dir/read_dir would otherwise freeze the app. Both callers share one newest-wins slot
/// (`drain_newest`), so a save made while the launch open is stuck replaces the pending entry and
/// runs after it, never alongside it (two `open_session_file` calls never race on the writer); a
/// skipped older entry is harmless, the newest compares its folder against the live file again.
/// Its own slot, so a slow audio sweep does not hold up the log move.
pub fn queue_log_settings(app: &AppHandle, config: Config, held: bool) {
    static NEXT: crate::NewestSlot<(AppHandle, Config, bool)> = Mutex::new((None, false));
    crate::drain_newest(&NEXT, (app.clone(), config, held), |(app, config, held)| {
        apply_log_settings(&app, &config, held)
    });
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
                if tick.is_multiple_of(STATUS_EVERY_TICKS) {
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
    custom
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
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
    // `custom` is the LIVE preference (null/blank = the default folder), not the config file: the
    // store's save is debounced, so the file lags a change — and a reset — by 400 ms.
    let dir = resolve_log_dir(&app, custom).ok_or("no log folder")?;
    // Home-relative display, same as audio_dir_path.
    if let Ok(home) = app.path().home_dir() {
        if let Ok(rest) = dir.strip_prefix(&home) {
            return Ok(format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()));
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// async + spawn_blocking: a sync command runs on the main thread, and a custom log folder can
/// sit on a slow or stalled mount (network share, sleeping disk) — as `open_audio_dir`.
#[tauri::command]
pub async fn open_log_folder(app: AppHandle, custom: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = resolve_log_dir(&app, custom).ok_or("no log folder")?;
        crate::audio::create_dir_private(&dir).map_err(|e| e.to_string())?;
        crate::open_external(&app, &dir.to_string_lossy())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_level_directive_clamps_other_targets_to_the_chosen_level() {
        assert_eq!(
            level_directive(LogLevel::Error),
            "faster_whisper_frontend_lib=error,error"
        );
        assert_eq!(
            level_directive(LogLevel::Warn),
            "faster_whisper_frontend_lib=warn,warn"
        );
        assert_eq!(
            level_directive(LogLevel::Debug),
            "faster_whisper_frontend_lib=debug,info"
        );
        // The launch filter (no valid RUST_LOG) is the Info directive.
        assert_eq!(
            level_directive(LogLevel::Info),
            "faster_whisper_frontend_lib=info,info"
        );
    }

    #[test]
    fn only_a_non_blank_rust_log_that_parses_overrides_the_level() {
        // Unset or blank: no override (a blank one would parse to an enable-nothing filter).
        for raw in [None, Some(""), Some(","), Some(" , ")] {
            assert!(env_override(raw).is_none(), "{raw:?}");
        }
        assert!(matches!(env_override(Some("debug")), Some(Ok(_))));
        // A mistyped level is rejected (and warned about), not silently dropped.
        assert!(matches!(
            env_override(Some("faster_whisper_frontend_lib=verbose")),
            Some(Err(_))
        ));
    }

    #[test]
    fn the_replayed_head_uses_the_same_stamp_format_as_the_live_tail() {
        let l = LogLine {
            seq: 1,
            ts: 1_700_000_000_123,
            level: "info",
            target: "t".into(),
            tag: None,
            msg: "m".into(),
        };
        let out = format_line(&l);
        // "YYYY-MM-DD HH:MM:SS.mmm" — a date, a space, a time with millis.
        let stamp = out.split(' ').take(2).collect::<Vec<_>>().join(" ");
        assert_eq!(stamp.len(), "2023-11-14 22:13:20.123".len(), "{out:?}");
        assert!(
            stamp.as_bytes()[4] == b'-'
                && stamp.as_bytes()[10] == b' '
                && stamp.as_bytes()[19] == b'.',
            "{out:?}"
        );
        // Level right-aligned in a 5-wide column, as `tracing_subscriber` writes the live tail.
        assert!(out[stamp.len()..].starts_with("  INFO t: m"), "{out:?}");
    }

    #[test]
    fn the_live_tail_timer_writes_the_same_stamp_shape() {
        use tracing_subscriber::fmt::{format::Writer, time::FormatTime};
        let mut s = String::new();
        LocalTimer.format_time(&mut Writer::new(&mut s)).unwrap();
        assert_eq!(s.len(), "2023-11-14 22:13:20.123".len(), "{s:?}");
        assert!(
            s.as_bytes()[4] == b'-' && s.as_bytes()[10] == b' ' && s.as_bytes()[19] == b'.',
            "{s:?}"
        );
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
        let recent = ring.tail(t.seq - 3);
        assert_eq!(recent.lines.len(), 3);
    }

    #[test]
    fn ring_records_the_real_target_of_log_crate_lines() {
        use tracing_log::log;
        use tracing_subscriber::layer::SubscriberExt;
        let ring = LogRing::default();
        let sub = tracing_subscriber::registry().with(RingLayer { ring: ring.clone() });
        tracing::subscriber::with_default(sub, || {
            // What LogTracer does with a tauri/tao/wry `log::warn!`.
            tracing_log::format_trace(
                &log::Record::builder()
                    .target("tauri::manager")
                    .level(log::Level::Warn)
                    .args(format_args!("[webview] gone"))
                    .build(),
            )
            .unwrap();
        });
        let t = ring.tail(0);
        assert_eq!(t.lines.len(), 1);
        let l = &t.lines[0];
        assert_eq!(l.target, "tauri::manager");
        assert_eq!(l.level, "warn");
        assert_eq!(l.tag.as_deref(), Some("webview"));
        // tracing-log's `log.target`/`log.file`/… fields are never appended.
        assert_eq!(l.msg, "gone");
    }

    #[test]
    fn ring_keeps_the_structured_fields_fmt_prints() {
        use tracing_subscriber::layer::SubscriberExt;
        let ring = LogRing::default();
        let sub = tracing_subscriber::registry().with(RingLayer { ring: ring.clone() });
        tracing::subscriber::with_default(sub, || {
            let locale = "xx_YY";
            tracing::info!(k = 1, ?locale, "[t] m");
            tracing::info!(only = true);
        });
        let t = ring.tail(0);
        assert_eq!(t.lines.len(), 2);
        assert_eq!(t.lines[0].tag.as_deref(), Some("t"));
        assert_eq!(t.lines[0].msg, "m k=1 locale=\"xx_YY\"");
        assert_eq!(t.lines[1].tag, None);
        assert_eq!(t.lines[1].msg, "only=true");
    }

    #[test]
    fn a_session_file_is_new_owner_only_and_never_reuses_a_name() {
        let dir = std::env::temp_dir().join(format!("fwf-session-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let stamp = "2026-10-13_12-00-00";
        let (mut first, first_path) = super::create_session_file(&dir, stamp).unwrap();
        first.write_all(b"first session\n").unwrap();
        let (_second, second_path) = super::create_session_file(&dir, stamp).unwrap();
        assert_ne!(first_path, second_path);
        assert_eq!(
            std::fs::read_to_string(&first_path).unwrap(),
            "first session\n"
        );
        assert!(second_path.ends_with(format!("fwf-{stamp}-2.log")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&second_path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            // A planted symlink at the next name is skipped, its target untouched.
            let victim = dir.join("victim.txt");
            std::fs::write(&victim, "keep").unwrap();
            let next = "2026-10-13_12-00-01";
            std::os::unix::fs::symlink(&victim, dir.join(format!("fwf-{next}.log"))).unwrap();
            let (mut f, p) = super::create_session_file(&dir, next).unwrap();
            f.write_all(b"log").unwrap();
            assert!(p.ends_with(format!("fwf-{next}-2.log")));
            assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        }
        let _ = std::fs::remove_dir_all(&dir);
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

        prune_log_files(&dir, 7, None);
        assert!(!old.exists(), "old session file pruned");
        assert!(fresh.exists(), "fresh session file kept");
        assert!(other.exists(), "unrelated files untouched");
        assert!(!dir.join("fwf.log").exists(), "legacy file removed");
        assert!(!dir.join("fwf.prev.log").exists(), "legacy prev removed");

        // keep_days = 0 → forever (only legacy files go), however old the file is.
        std::fs::write(&old, "x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(past)
            .unwrap();
        prune_log_files(&dir, 0, None);
        assert!(old.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The session's open file is matched by mtime like any other, and a quiet session can leave
    /// it past `keep_days`: the prune must still skip it.
    #[test]
    fn prune_skips_the_live_session_file() {
        let dir = std::env::temp_dir().join(format!("fwf-prune-live-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("fwf-2020-01-01_00-00-00.log");
        let stale = dir.join("fwf-2020-01-02_00-00-00.log");
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
        for p in [&live, &stale] {
            std::fs::write(p, "x").unwrap();
            std::fs::File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(past)
                .unwrap();
        }

        prune_log_files(&dir, 7, Some(&live));
        assert!(live.exists(), "live session file kept");
        assert!(!stale.exists(), "other aged session file pruned");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
