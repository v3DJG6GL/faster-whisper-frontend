//! Dictation sessions, streaming (microphone capture → resample → WebSocket) and batch record
//! (one buffered clip POSTed on stop), surfacing transcript events to the UI.
//!
//! The `cpal::Stream` lives on a dedicated capture thread (it is `!Send`) and
//! forwards mono f32 chunks over a channel to an async WS task. Levels are
//! emitted as `stream://level`; transcripts as `stream://partial`/`final`;
//! state as `stream://status`. Dropping a [`StreamSession`] stops everything.

use crate::audio::resample::Resampler16k;
use crate::transport::batch;
use crate::transport::stream::{self, StreamEvent, StreamParams};
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{Device, FromSample, Sample, SampleFormat, StreamConfig};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

/// Monotonic dictation-session epoch. Each new streaming/record session claims the next value
/// (which thereby becomes the "active" one). A session emits `stream://*` transcript/status
/// events ONLY while it is still the active epoch. This matters because a stopped session keeps
/// running in the BACKGROUND after the foreground returns: `StreamSession::finish` detaches the
/// WS task to drain the last utterance, and the batch path spawns its transcribe POST — both
/// emit `final`/`closed` later. The events are global and carry no session id, so without this
/// gate a session that was CANCELLED (cancelLive, e.g. on suspend/resume or an impatient
/// stop-then-restart) could, once a NEW session starts, inject its leftover transcript into the
/// new target and kill the new session's focus poll. Gating at the emit (not the listener) means
/// the moment a newer session claims the epoch, the older one's late drain goes silent.
/// (Level emits don't need this: the capture thread is always joined before the next session
/// starts, so they can't outlive their session.)
static ACTIVE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Claim the next epoch for a starting session (also makes it the active one).
fn next_session_epoch() -> u64 {
    ACTIVE_EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

/// Retire the active epoch when a session is DISCARDED (cancel) before any successor claims one, so
/// the discarded session and its detached background drain can never emit again. Without this the
/// cancelled epoch stays active until the NEXT start claims one, leaving that next session's start
/// prologue (status flips to "listening" before start() runs next_session_epoch) a window where the
/// stale drain's final/closed would pass BOTH emit_if_active AND the frontend inSession() guard.
/// Safe: a fresh start always claims a strictly higher epoch, and a discarded session's late
/// `closed` can only reach the (cancelStream-calling) handler while its own epoch is still active.
pub fn retire_active_epoch() {
    ACTIVE_EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// The epoch of the batch transcription most recently DETACHED, published by `stop_record`
/// (`RecordSession::claim_detached`, under the RecordState lock) or by the capture thread's
/// device-loss salvage arm, never by `finish()` itself; [`CANCELLED_BATCHES`] holds the epochs a
/// cancel has since disowned.
///
/// `stop_record` takes the session out of managed state and `finish` spawns the transcribe POST
/// on its own task, so a cancel during the "transcribing…" phase finds no session; this slot lets
/// it still disown the detached work, which would otherwise POST the audio and write the `.wav` and
/// its `.txt` sidecar behind a UI showing a clean cancel.
///
/// A dedicated pair rather than reusing `ACTIVE_EPOCH`: that one is also bumped when the NEXT
/// session starts, so gating on "still active" would throw away a legitimate transcription
/// whenever the user began dictating again before the previous batch POST returned.
///
/// The cancelled side is a short list, not one slot: in stop A → cancel while A transcribes → start
/// B → cancel B, one slot would lose A's mark, so A's POST would keep its `.wav` and write its
/// `.txt`. A few recent epochs cover any realistic overlap of detached POSTs.
static DETACHED_BATCH_EPOCH: AtomicU64 = AtomicU64::new(0);
static CANCELLED_BATCHES: Mutex<VecDeque<u64>> = Mutex::new(VecDeque::new());
/// How many cancelled epochs [`CANCELLED_BATCHES`] remembers (oldest dropped first).
const CANCELLED_BATCHES_CAP: usize = 16;

/// Record `epoch` as cancelled. Epoch 0 ("none detached yet") is never recorded.
fn mark_batch_cancelled(epoch: u64) {
    if epoch == 0 {
        return;
    }
    if let Ok(mut q) = CANCELLED_BATCHES.lock() {
        if !q.contains(&epoch) {
            q.push_back(epoch);
            while q.len() > CANCELLED_BATCHES_CAP {
                q.pop_front();
            }
        }
    }
}

/// Disown whatever batch transcription is currently detached, if any. Called (via
/// [`settle_detached_batch_on_cancel`]) only for a user's Cancel that found no live session,
/// because a preceding stop already took it out of state.
pub fn cancel_detached_batch() {
    mark_batch_cancelled(DETACHED_BATCH_EPOCH.load(Ordering::SeqCst));
}

/// A recovery cancel's keep is final (the batch twin of [`forget_detached_stream`]): no later
/// Cancel that finds no live session — the next session's start window — may still disown the
/// transcription it kept and delete its `.wav`. Called under the `RecordState` lock, as every
/// claim is.
pub fn forget_detached_batch() {
    DETACHED_BATCH_EPOCH.store(0, Ordering::SeqCst);
}

/// Publish a device-loss salvage's epoch (the salvage arm in `start_record`). A salvage firing
/// inside `finish()`'s capture join runs after `stop_record`'s claim and outside the lock, so a
/// session N+1 may already have claimed the slot; epochs only grow, so `fetch_max` never moves the
/// slot backwards (see `RecordSession::claim_detached`), and after a forget (0) it still publishes
/// the salvage.
fn publish_salvaged_batch(epoch: u64) {
    DETACHED_BATCH_EPOCH.fetch_max(epoch, Ordering::SeqCst);
}

/// The detached-batch half of `cancel_record`, decided under the `RecordState` lock — the batch
/// twin of [`settle_detached_on_cancel`]. Taking a LIVE session (any Cancel, the closed-handler
/// release) supersedes the earlier detached batch as the Cancel target, so a later Cancel cannot
/// disown it; a recovery cancel (`discard_recording: false`) releases it so its keep is final.
/// With no live session, only a user's Cancel disowns it; the release leaves it alone.
pub fn settle_detached_batch_on_cancel(
    took_live: bool,
    user_initiated: bool,
    discard_recording: bool,
) {
    if took_live || !discard_recording {
        forget_detached_batch();
    } else if user_initiated {
        cancel_detached_batch();
    }
}

/// Was the detached transcription for `epoch` cancelled? Epoch 0 is "none detached yet".
fn batch_cancelled(epoch: u64) -> bool {
    epoch != 0
        && CANCELLED_BATCHES
            .lock()
            .map(|q| q.contains(&epoch))
            .unwrap_or(false)
}

/// The discard state of the stream session most recently DETACHED by `stop_stream` — the stream
/// twin of [`DETACHED_BATCH_EPOCH`]. `finish()` detaches the WS drain, so a Cancel pressed while
/// it finalizes finds no session; without this the drain would still write the `.wav` and its
/// `.txt` behind a UI showing a clean cancel. One slot is enough: a cancel that finds a live
/// session is aimed at that one and only empties this slot, never discarding a drain, so only the
/// newest detached drain can be the one the user means.
///
/// The drain retires its own entry at its one decision point ([`settle_detached_stream`]), so a
/// Cancel after the recording was already written finds the slot empty instead of logging a
/// discard that never happens — and a stop that claims the session only after that (its WS task
/// failed first) publishes nothing. Every access holds the lock across the flag's store/load, which
/// totally orders a Cancel against that decision.
static DETACHED_STREAM: Mutex<Option<Arc<DetachedStream>>> = Mutex::new(None);

/// One stream session's entry in [`DETACHED_STREAM`], shared by the session (which claims it on
/// stop) and its WS task (which settles it, see `StreamParams::detached`).
#[derive(Default)]
pub struct DetachedStream {
    /// Set by a user's Cancel after stop: the drain writes no recording from then on.
    pub discard: AtomicBool,
    /// Set once the drain has decided, and never cleared: a claim landing after it (the
    /// frontend's stopStream on a session whose WS task already failed) publishes nothing, so a
    /// later Cancel cannot log a discard for a session that saved nothing.
    settled: AtomicBool,
}

/// Discard the recording of the stream session still draining after a stop, if any. Called (via
/// [`settle_detached_on_cancel`]) only for a user's Cancel that found no live session. The guard is held across
/// the store so the drain's [`settle_detached_stream`] sees either the flag set or an empty slot.
pub fn cancel_detached_stream() {
    if let Ok(mut s) = DETACHED_STREAM.lock() {
        if let Some(flag) = s.take() {
            flag.discard.store(true, Ordering::SeqCst);
            tracing::info!(
                "[stream] cancel after stop: the draining session will save no recording"
            );
        }
    }
}

/// The detached-drain half of `cancel_stream`, decided under the stream state lock. Taking a LIVE
/// session (any Cancel, the closed-handler release) supersedes an earlier drain as the Cancel
/// target, as a settled claim does, so a later Cancel meant for that session cannot discard the
/// one before it. With no live session, a user's Cancel discards the drain and a recovery cancel
/// (`discard_recording: false`) releases it, so its keep is final; the release leaves it alone.
pub fn settle_detached_on_cancel(took_live: bool, user_initiated: bool, discard_recording: bool) {
    if took_live || (user_initiated && !discard_recording) {
        forget_detached_stream();
    } else if user_initiated {
        cancel_detached_stream();
    }
}

/// Release the detached drain WITHOUT discarding it — a recovery cancel's keep is final, so no
/// later stray Cancel (the next session's start window, its end-of-session insert) reaches it.
pub fn forget_detached_stream() {
    if let Ok(mut s) = DETACHED_STREAM.lock() {
        s.take();
    }
}

/// Publish `flag` as the newest detached drain — unless that drain already settled (see
/// [`DetachedStream::settled`]); checked under the lock, so a settle and a claim never interleave.
/// A settled claim still EMPTIES the slot: the newest stopped session supersedes any earlier
/// drain as the Cancel target, so a later Cancel meant for it cannot discard the one before.
pub fn claim_detached_stream(flag: &Arc<DetachedStream>) {
    if let Ok(mut s) = DETACHED_STREAM.lock() {
        *s = (!flag.settled.load(Ordering::SeqCst)).then(|| flag.clone());
    }
}

/// The drain's single decision point: retire its own slot entry (by `Arc` identity, so a newer
/// session's claim is never wiped), mark it settled so no later claim re-publishes it, and return
/// whether a Cancel discarded it — read under the lock, so a Cancel either landed before this
/// (discard) or finds the slot empty (no-op).
pub fn settle_detached_stream(flag: &Arc<DetachedStream>) -> bool {
    match DETACHED_STREAM.lock() {
        Ok(mut s) => {
            flag.settled.store(true, Ordering::SeqCst);
            if s.as_ref().is_some_and(|f| Arc::ptr_eq(f, flag)) {
                *s = None;
            }
            flag.discard.load(Ordering::SeqCst)
        }
        Err(_) => {
            flag.settled.store(true, Ordering::SeqCst);
            flag.discard.load(Ordering::SeqCst)
        }
    }
}

/// Emit a `stream://*` event only if `epoch` is still the active session (see [`ACTIVE_EPOCH`]).
fn emit_if_active<S: Serialize + Clone>(app: &AppHandle, epoch: u64, event: &str, payload: S) {
    if ACTIVE_EPOCH.load(Ordering::SeqCst) == epoch {
        let _ = app.emit(event, payload);
    }
}

#[derive(Default)]
pub struct StreamState(pub Mutex<Option<StreamSession>>);

/// Tear down any in-flight dictation on app exit. Dropping the session aborts capture and runs
/// `SystemMuteGuard::drop`, which ENQUEUES the unmute on the detached mute worker (the restore is a
/// blocking pactl/wpctl shell-out kept off the UI thread). The tray "Quit" calls `AppHandle::exit`,
/// which ends the process WITHOUT running destructors for managed state AND would kill the worker
/// before it runs that unmute — so after dropping the sessions we BLOCK on a bounded flush barrier
/// until the queued unmute completes, else an explicit quit mid-`mute_system` dictation would strand
/// the user's other apps muted. Takes the session out under the lock, then drops it outside (matches
/// `stop_stream`/`stop_record`, so the capture-thread join doesn't run while the state is locked).
pub fn cleanup_for_exit(app: &AppHandle) {
    let mut dropped = false;
    if let Some(state) = app.try_state::<StreamState>() {
        let sess = state.0.lock().ok().and_then(|mut g| g.take());
        dropped |= sess.is_some();
        drop(sess);
    }
    if let Some(state) = app.try_state::<RecordState>() {
        let sess = state.0.lock().ok().and_then(|mut g| g.take());
        dropped |= sess.is_some();
        drop(sess);
    }
    // The exit path runs this up to three times (the quit handler, then RunEvent::ExitRequested and
    // RunEvent::Exit). A healthy worker is flushed on every pass (microseconds), which also catches
    // the late Unmute of a stop_stream/stop_record already in flight (it took the session out of
    // state before us and enqueues only after its capture join). A timed-out flush latches, so a
    // wedged sound server (untimed pactl/wpctl on the worker) costs its 2 s only once, plus once per
    // pass that actually dropped a session.
    static EXIT_FLUSH_WEDGED: AtomicBool = AtomicBool::new(false);
    if (dropped || !EXIT_FLUSH_WEDGED.load(Ordering::SeqCst))
        && !flush_mute_worker(std::time::Duration::from_secs(2))
    {
        EXIT_FLUSH_WEDGED.store(true, Ordering::SeqCst);
    }
    // The remote-paste clipboard owner holds the last transcript DELAY-RENDERED: destroying its
    // window makes Windows ask it to render everything it still owes, so the text stays pasteable
    // after we exit. No exit path destroys that window otherwise (`exit()` skips destructors).
    // A no-op when the owner never started.
    #[cfg(windows)]
    crate::inject::windows_clipboard::shutdown(std::time::Duration::from_millis(500));
}

pub struct StartParams {
    pub server_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub language: String,
    pub response_format: String,
    /// None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    pub prompt: Option<String>,
    /// Per-request decode overrides (opaque JSON object) forwarded to the backend.
    pub decode_overrides: Option<serde_json::Value>,
    /// Server override-profile name forwarded to the backend (None/empty = none).
    pub override_profile: Option<String>,
    /// Declares that this session will translate on a separate request, so the
    /// server keeps each utterance's log receipt open until it lands.
    pub translate_expect: Option<serde_json::Value>,
    /// Client-minted session id forwarded as the handshake's `client_job`.
    pub client_job: Option<String>,
    pub device_id: Option<String>,
    pub save_dir: Option<PathBuf>,
    pub trim_silence: bool,
    /// One `.wav` per utterance instead of per session (see `stream::ClipCutter`).
    pub per_utterance_clips: bool,
    pub mute_system: bool,
}

pub struct StreamSession {
    epoch: u64,
    capture_stop: Arc<AtomicBool>,
    capture_join: Option<JoinHandle<()>>,
    ws_stop: watch::Sender<bool>,
    ws_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Shared with the WS task's `StreamParams::detached` (see [`cancel_detached_stream`]).
    detached: Arc<DetachedStream>,
    /// "Keep recordings": the session was started with a save dir (see [`Self::keeps_recording`]).
    keeps_recording: bool,
    // Unmutes system audio on drop (after the Drop body below runs).
    _mute: SystemMuteGuard,
}

impl StreamSession {
    /// Whether this session has a save dir ("Keep recordings"), as `RecordSession::keeps_recording`.
    /// A recovery cancel finishes a live session only when this is true; otherwise it aborts it.
    /// Without a save dir the drain writes nothing and every event is already suppressed by the
    /// cancel's epoch retire, so a flush would only make the server decode the last utterance.
    pub fn keeps_recording(&self) -> bool {
        self.keeps_recording
    }

    /// Claim this session as the detached drain BEFORE the state lock is released, as
    /// `RecordSession::claim_detached` does: a Cancel landing between stop and finish must
    /// reach this session, not the one before it.
    pub fn claim_detached(&self) {
        claim_detached_stream(&self.detached);
    }

    /// User-requested stop: stop capture, then let the WS task drain (flush, stop,
    /// final) in the background so the last utterance is still delivered. Takes
    /// the task out first so the `Drop` below won't abort it.
    pub fn finish(mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        let _ = self.ws_stop.send(true);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        drop(self.ws_task.take());
        tracing::info!("[stream] session {} finished (draining)", self.epoch);
    }
}

impl Drop for StreamSession {
    fn drop(&mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        let _ = self.ws_stop.send(true);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        // Abort the WS task immediately (no drain). This path runs when a session
        // is cancelled or REPLACED by a new one; draining a stale session would keep
        // emitting finals/closed and spam the UI. The explicit-stop path (`finish`)
        // drains — it took the task, so this abort is a no-op after a normal stop.
        if let Some(task) = self.ws_task.take() {
            task.abort();
            tracing::info!("[stream] session {} cancelled (no drain)", self.epoch);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartialPayload {
    committed: String,
    pending: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalPayload {
    committed: String,
    tail: String,
    last: bool,
    /// The server's utterance ordinal, forwarded so the client can pair this
    /// phrase with the `stream://captured` frame that follows it. `null` when the
    /// server sent none (older backends) — then the client pairs nothing.
    utterance: Option<u32>,
}

/// `stream://recording`: a saved `.wav`. `utterance` names the utterance a per-utterance
/// clip belongs to (None = the whole session); `durationMs` is None when unmeasured (batch).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingPayload {
    path: String,
    utterance: Option<u32>,
    duration_ms: Option<u64>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedPayload {
    id: String,
    utterance: Option<u32>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UtterancePayload {
    /// "open" | "decoding" | "dropped" — already validated at the parse boundary.
    state: crate::transport::stream::UtteranceState,
    utterance: Option<u32>,
}

pub fn start(app: AppHandle, p: StartParams) -> Result<StreamSession, String> {
    let input = open_input(p.device_id.clone())?;
    let mute = SystemMuteGuard::new(p.mute_system);
    let epoch = next_session_epoch();

    let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (ws_stop_tx, ws_stop_rx) = watch::channel(false);
    let detached = Arc::new(DetachedStream::default());
    let level = Arc::new(AtomicU32::new(0));
    let capture_stop = Arc::new(AtomicBool::new(false));
    announce_mic(
        &app,
        epoch,
        &input,
        p.device_id.as_deref(),
        capture_stop.clone(),
    );
    let OpenedInput {
        device,
        format,
        channels,
        config,
        rate: in_rate,
        ..
    } = input;

    let capture_join = spawn_capture(
        app.clone(),
        epoch,
        device,
        format,
        channels,
        config,
        pcm_tx,
        level,
        capture_stop.clone(),
    )?;

    let keeps_recording = p.save_dir.is_some();
    let params = StreamParams {
        ws_url: stream::http_to_ws(&p.server_url),
        model: p.model,
        language: p.language,
        response_format: p.response_format,
        prompt: p.prompt,
        translate_expect: p.translate_expect,
        decode_overrides: p.decode_overrides,
        override_profile: p.override_profile,
        client_job: p.client_job,
        api_key: p.api_key,
        in_rate,
        save_dir: p.save_dir,
        trim_silence: p.trim_silence,
        per_utterance_clips: p.per_utterance_clips,
        detached: detached.clone(),
    };

    let appc = app.clone();
    // This closure runs on the WS task, which `finish()` DETACHES to drain in the background —
    // so it can fire after the session is gone. Gate every emit on `epoch` so a superseded/
    // cancelled session's late drain can't bleed into the next one (see ACTIVE_EPOCH).
    let on_event = move |ev: StreamEvent| match ev {
        StreamEvent::Ready { overrides_ignored } => {
            emit_if_active(&appc, epoch, "stream://status", "ready");
            if !overrides_ignored.is_empty() {
                emit_if_active(
                    &appc,
                    epoch,
                    "stream://overrides-ignored",
                    overrides_ignored,
                );
            }
        }
        StreamEvent::Partial { committed, pending } => {
            emit_if_active(
                &appc,
                epoch,
                "stream://partial",
                PartialPayload { committed, pending },
            );
        }
        StreamEvent::Final {
            committed,
            tail,
            last,
            utterance,
        } => {
            tracing::info!(
                "[stream] session {epoch} final committed={} tail={} last={}",
                committed.len(),
                tail.len(),
                last
            );
            emit_if_active(
                &appc,
                epoch,
                "stream://final",
                FinalPayload {
                    committed,
                    tail,
                    last,
                    utterance,
                },
            );
        }
        StreamEvent::RecordingSaved {
            path,
            utterance,
            duration_ms,
        } => {
            emit_if_active(
                &appc,
                epoch,
                "stream://recording",
                RecordingPayload {
                    path,
                    utterance,
                    duration_ms: Some(duration_ms),
                },
            );
        }
        StreamEvent::Captured { id, utterance } => {
            emit_if_active(
                &appc,
                epoch,
                "stream://captured",
                CapturedPayload { id, utterance },
            );
        }
        StreamEvent::Loading => {
            // Server is cold-loading its model — alive, just slow. The client
            // re-arms its stuck-finalize watchdog on this so a long load can't
            // force-idle a dictation whose transcript is seconds away.
            emit_if_active(&appc, epoch, "stream://status", "loading");
        }
        StreamEvent::Utterance { state, utterance } => {
            emit_if_active(
                &appc,
                epoch,
                "stream://utterance",
                UtterancePayload { state, utterance },
            );
        }
        StreamEvent::Boundary { separator, .. } => {
            tracing::info!("[stream] session {epoch} boundary (hard break)");
            emit_if_active(&appc, epoch, "stream://boundary", separator);
        }
        StreamEvent::Incomplete(m) => {
            // Non-terminal: the UI shows a warning and still runs its normal `closed` tail.
            tracing::warn!("[stream] session {epoch} incomplete: {m}");
            emit_if_active(&appc, epoch, "stream://incomplete", m);
        }
        StreamEvent::Error(m) => {
            // Log it here (not just emit): a superseded session's error is epoch-
            // suppressed from the UI and would otherwise vanish entirely.
            // The message is server-supplied and this log is the file users are asked to send
            // for support — fold control chars to spaces so embedded newlines can't forge records.
            let safe: String = m
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            tracing::warn!("[stream] session {epoch} error: {safe}");
            emit_if_active(&appc, epoch, "stream://error", m);
        }
        StreamEvent::Closed => {
            tracing::info!("[stream] session {epoch} closed");
            emit_if_active(&appc, epoch, "stream://status", "closed");
        }
    };

    tracing::info!("[stream] session {epoch} start (mic rate {in_rate} Hz)");
    let ws_task = tauri::async_runtime::spawn(async move {
        stream::run(params, pcm_rx, ws_stop_rx, on_event).await;
    });

    Ok(StreamSession {
        epoch,
        capture_stop,
        capture_join: Some(capture_join),
        ws_stop: ws_stop_tx,
        ws_task: Some(ws_task),
        detached,
        keeps_recording,
        _mute: mute,
    })
}

struct OpenedInput {
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    rate: u32,
    /// Set when the pinned mic isn't connected and the default input stands in.
    fallback: Option<crate::audio::device::MicFallback>,
    /// A pinned sound-server source to watch for unplugging while recording.
    watch_source: Option<String>,
}

/// Open the pinned microphone, or the default input when it isn't connected (the pin is kept,
/// dictation still works, and the UI is told which mic stands in). A working default mic beats a
/// cryptic "input device not found" that breaks dictation until the user re-picks in Settings.
fn open_input(device_id: Option<String>) -> Result<OpenedInput, String> {
    let r = crate::audio::device::resolve_input(device_id.as_deref())?;
    let supported = crate::audio::device::input_config(&r.device)?;
    let config = crate::audio::device::capture_config(&r.device, &supported);
    Ok(OpenedInput {
        device: r.device,
        format: supported.sample_format(),
        channels: supported.channels() as usize,
        config,
        rate: supported.sample_rate(),
        fallback: r.fallback,
        watch_source: r.watch_source,
    })
}

/// Say so when the mic dictation records from isn't the pinned one: at once if the pin fell back
/// at start, and — for a pinned sound-server source — when it disappears mid-session (the server
/// then moves the recording to another source on its own). Polls every 3 s until `stop`.
fn announce_mic(
    app: &AppHandle,
    epoch: u64,
    input: &OpenedInput,
    pin: Option<&str>,
    stop: Arc<AtomicBool>,
) {
    if let Some(fb) = &input.fallback {
        emit_if_active(app, epoch, "stream://mic-fallback", fb.clone());
    }
    #[cfg(target_os = "linux")]
    if let (Some(source), Some(pin)) = (input.watch_source.clone(), pin) {
        let app = app.clone();
        let pin = pin.to_string();
        let _ = std::thread::Builder::new()
            .name("mic-watch".into())
            .spawn(move || {
                use std::time::Duration;
                'watch: loop {
                    for _ in 0..30 {
                        if stop.load(Ordering::SeqCst) {
                            break 'watch;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    let Some(snap) = crate::audio::pulse::snapshot() else {
                        continue;
                    };
                    if snap.microphones().any(|s| s.name == source) {
                        continue;
                    }
                    let using = snap
                        .default_source
                        .as_deref()
                        .and_then(|d| snap.microphones().find(|s| s.name == d))
                        .map(|s| s.label.clone())
                        .unwrap_or_else(|| "the default input".into());
                    tracing::warn!("[audio] microphone '{pin}' disconnected mid-session");
                    if !stop.load(Ordering::SeqCst) {
                        emit_if_active(
                            &app,
                            epoch,
                            "stream://mic-fallback",
                            crate::audio::device::MicFallback {
                                wanted_id: pin,
                                using,
                            },
                        );
                    }
                    break;
                }
            });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (&input.watch_source, pin, stop);
}

/// Build a cpal stream error callback that signals `stop` on a TERMINAL device error (which errors
/// count: `stream_errors`). After a mid-session disconnect no more data callbacks fire, so without
/// this the capture thread stays blocked in publish_levels_with_live (loops until stop), its pcm
/// sender never drops, and the session wedges at "listening" with a frozen meter until the user
/// cancels. Tripping stop lets the channel close and the session drain to Closed (the same teardown
/// a user stop triggers).
fn err_cb_with_stop(stop: Arc<AtomicBool>) -> impl FnMut(cpal::Error) + Send + 'static {
    crate::audio::stream_errors::error_callback("stream", move || {
        stop.store(true, Ordering::SeqCst);
    })
}

/// Like `err_cb_with_stop`, but also records that the stop was caused by a TERMINAL device loss (vs a
/// user/finish stop). The record/batch path has no channel-close teardown like the streaming path, so
/// it inspects this flag after capture returns to salvage and transcribe the clip ONLY on a real
/// disconnect — a normal stop is `finish()`'s, and a second transcribe would settle the chip before
/// the final transcript lands.
fn err_cb_with_lost(
    stop: Arc<AtomicBool>,
    device_lost: Arc<AtomicBool>,
) -> impl FnMut(cpal::Error) + Send + 'static {
    crate::audio::stream_errors::error_callback("record", move || {
        device_lost.store(true, Ordering::SeqCst);
        stop.store(true, Ordering::SeqCst);
    })
}

fn downmix<T: Copy>(data: &[T], channels: usize) -> Vec<f32>
where
    f32: FromSample<T>,
{
    let mut out = Vec::new();
    downmix_into(data, channels, &mut out);
    out
}

/// Downmix to mono into a caller-owned scratch buffer (cleared first), so a per-buffer capture
/// callback can reuse one `Vec` instead of allocating every ~10-20 ms. Mirrors `capture::analyze`.
fn downmix_into<T: Copy>(data: &[T], channels: usize, out: &mut Vec<f32>)
where
    f32: FromSample<T>,
{
    out.clear();
    if channels <= 1 {
        out.extend(data.iter().map(|&s| f32::from_sample(s)));
        return;
    }
    out.reserve(data.len() / channels + 1);
    for frame in data.chunks(channels) {
        let mut acc = 0.0;
        for &s in frame {
            acc += f32::from_sample(s);
        }
        out.push(acc / frame.len() as f32);
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// RAW-audio floor above which a chunk counts as the mic actually delivering signal. A live mic's
/// noise floor always clears this (measured ~2.4e-5 RMS on the QUIETEST resting chunk of a laptop
/// mic at low gain) while a still-warming device delivers exact digital zeros — so the gap is wide
/// on both sides. Deliberately checked on the RAW chunk RMS, NOT the smoothed+gained meter level:
/// that one passes through chip_level's clamp and a 0-seeded EMA against a threshold
/// (streaming.ts MIC_LIVE_LEVEL) that quiet mics only hover AT, which held "warming up…" until the
/// user actually spoke.
const MIC_LIVE_RMS: f32 = 1.0e-5;
/// Consecutive above-floor callbacks required before the mic counts as live (~30 ms), so the
/// single open-click/DC blip a warming device can emit doesn't end the warm-up gate early.
const MIC_LIVE_CONFIRM: u8 = 3;

/// Per-callback "did the mic actually go live?" detector, one per capture stream. Sets `flag`
/// (announced once as `stream://mic-live` by `publish_levels_with_live`, on the level cadence)
/// after MIC_LIVE_CONFIRM consecutive chunks above MIC_LIVE_RMS. Cheap: one extra O(n) RMS pass
/// per ~10-20 ms chunk, and none at all once live.
struct LiveDetect {
    hits: u8,
    flag: Arc<AtomicBool>,
}

impl LiveDetect {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self { hits: 0, flag }
    }
    fn feed(&mut self, mono: &[f32]) {
        if self.flag.load(Ordering::Relaxed) {
            return;
        }
        if rms(mono) > MIC_LIVE_RMS {
            self.hits += 1;
            if self.hits >= MIC_LIVE_CONFIRM {
                self.flag.store(true, Ordering::Relaxed);
            }
        } else {
            self.hits = 0;
        }
    }
}

/// One EMA step of the level meter (chip_level gain + clamp, 0.7/0.3 smoothing) — mirrors the
/// capture meter. Shared by every per-sample-format arm of both capture loops so the coefficients
/// stay in one place.
fn smooth(prev: f32, mono: &[f32]) -> f32 {
    prev * 0.7 + crate::audio::chip_level(rms(mono)) * 0.3
}

/// The `stream://error` text for a capture thread whose microphone open failed.
fn mic_open_error(e: &str) -> String {
    crate::transport::bounded_server_text(
        &format!("Microphone could not be opened: {e}"),
        crate::transport::MAX_ERROR_TEXT,
    )
}

#[allow(clippy::too_many_arguments)]
fn spawn_capture(
    app: AppHandle,
    epoch: u64,
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    pcm_tx: mpsc::UnboundedSender<Vec<f32>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    std::thread::Builder::new()
        .name("stream-capture".into())
        .spawn(move || {
            if let Err(e) = run_capture(&app, device, format, channels, config, pcm_tx, level, stop)
            {
                tracing::warn!("[stream] capture: {e}");
                // Err only means the open failed (device loss trips `stop` and returns Ok). The
                // dropped pcm_tx still closes the session, but without this the chip would settle
                // to idle with no word of why dictation never started.
                emit_if_active(&app, epoch, "stream://error", mic_open_error(&e));
            }
        })
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn run_capture(
    app: &AppHandle,
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    pcm_tx: mpsc::UnboundedSender<Vec<f32>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    // Raw-audio go-live detector (→ one-shot `stream://mic-live`), shared between the format arms'
    // callbacks and the publish loop below. See MIC_LIVE_RMS for why it is raw-RMS, not the meter.
    let live = Arc::new(AtomicBool::new(false));
    let stream = match format {
        SampleFormat::F32 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[f32], _| {
                    let mono = downmix(data, channels);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        SampleFormat::I16 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[i16], _| {
                    let mono = downmix(data, channels);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        SampleFormat::U16 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[u16], _| {
                    let mono = downmix(data, channels);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        SampleFormat::I32 => {
            let tx = pcm_tx.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[i32], _| {
                    let mono = downmix(data, channels);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let _ = tx.send(mono);
                },
                err_cb_with_stop(stop.clone()),
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;

    crate::audio::publish_levels_with_live(app, "stream://level", &level, &stop, Some(&live));
    // `stream` (and the cloned sender) drop here, ending capture and the channel.
    Ok(())
}

// Batch-mode dictation: record to a buffer, transcribe the whole clip on stop.
// Emits the same stream:// events the UI already handles (level, then final +
// closed after the POST).

#[derive(Default)]
pub struct RecordState(pub Mutex<Option<RecordSession>>);

#[derive(Clone)]
pub struct RecordParams {
    pub server_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub language: String,
    /// None = inherit DEFAULT_PROMPT; Some("") = explicit clear; Some(v) = use v.
    pub prompt: Option<String>,
    /// Per-request decode overrides (opaque JSON object) forwarded to the backend.
    pub decode_overrides: Option<serde_json::Value>,
    /// Server override-profile name forwarded to the backend (None/empty = none).
    pub override_profile: Option<String>,
    pub device_id: Option<String>,
    pub save_dir: Option<PathBuf>,
    /// When saving: keep only the spoken spans (drop silence) in the `.wav`, matching the
    /// streaming save path. Affects ONLY the saved file, never what's sent for transcription.
    pub trim_silence: bool,
    pub mute_system: bool,
    /// The backend is a plain OpenAI-compatible server (shapes the `language` field).
    pub standard: bool,
}

pub struct RecordSession {
    app: AppHandle,
    epoch: u64,
    params: RecordParams,
    buffer: Arc<Mutex<Vec<u8>>>,
    capture_stop: Arc<AtomicBool>,
    capture_join: Option<JoinHandle<()>>,
    // Set by the capture thread's err_cb on a TERMINAL device loss; finish() reads it to avoid
    // double-transcribing (the device-loss arm already salvaged the buffer + spawned its transcribe).
    device_lost: Arc<AtomicBool>,
    // Set by `discard()` (the user cancelled). The device-loss salvage arm runs INSIDE Drop's join,
    // so without it a cancel racing a mic disconnect would still upload the clip and write the
    // .wav/.txt — `retire_active_epoch` suppresses only the UI events, not the POST or the write.
    discard: Arc<AtomicBool>,
    _mute: SystemMuteGuard,
}

impl Drop for RecordSession {
    fn drop(&mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
    }
}

impl RecordSession {
    /// Throw the clip away: mark it discarded BEFORE `Drop` joins the capture thread, so the
    /// device-loss salvage arm does not upload it or write its sidecar, then let `Drop` stop and
    /// join as usual.
    ///
    /// Also name THIS session's epoch as cancelled. The flag above is a fast path that stops the
    /// clip ever being saved, but it is only read at the instant capture exits — if the salvage
    /// arm already fired, the flag is too late and only the epoch can reach the spawned work.
    /// Marking `self.epoch` rather than "whatever is currently detached" is what makes this safe
    /// to do unconditionally: epochs are strictly monotonic, so this can never match an earlier
    /// session's still-in-flight transcription (the hazard `cancel_record`'s no-live-session gate
    /// exists for — leave that gate exactly as it is).
    pub fn discard(self) {
        self.discard.store(true, Ordering::SeqCst);
        mark_batch_cancelled(self.epoch);
    }

    /// Claim this session as the detached batch BEFORE the state lock is released.
    ///
    /// `finish()` never publishes, and `stop_record` drops the `RecordState` guard before it runs.
    /// A `cancel_record` in that gap would find no live session, and `cancel_detached_batch()` would
    /// disown whatever `DETACHED_BATCH_EPOCH` still held: 0 (the cancelled clip is uploaded and
    /// archived while the UI says cancelled) or the PREVIOUS session's epoch (an earlier in-flight
    /// POST is disowned and its `.wav` deleted).
    ///
    /// Publishing early is safe: the device-loss salvage arm (in `start_record`) publishes with
    /// `fetch_max` ([`publish_salvaged_batch`]), so a late salvage inside `finish()`'s capture join
    /// never moves the slot below a newer claim; the only other accesses are
    /// `cancel_detached_batch` (reads it) and `forget_detached_batch` (clears it).
    pub fn claim_detached(&self) {
        DETACHED_BATCH_EPOCH.store(self.epoch, Ordering::SeqCst);
    }

    /// Whether this session has a save dir ("Keep recordings"). A recovery cancel finishes a live
    /// session only when this is true; otherwise it discards it. Its point is to keep the saved
    /// audio, and without a save dir `finish()` (or a device-loss salvage) would upload the whole
    /// clip for a transcription whose every event the cancel's epoch retire already suppresses.
    /// A save dir does not promise a file: trimming an all-silence clip, or a failed write, still
    /// leaves nothing on disk after the upload.
    pub fn keeps_recording(&self) -> bool {
        self.params.save_dir.is_some()
    }

    /// Stop recording and transcribe the captured clip in the background.
    pub fn finish(mut self) {
        self.capture_stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.capture_join.take() {
            let _ = j.join();
        }
        // On a mid-capture device loss the capture thread already salvaged the buffer and spawned its
        // own transcribe (final + closed). Proceeding would spawn a SECOND, empty-pcm transcribe whose
        // immediate "closed" settles the chip to idle BEFORE the salvaged final lands (which is then
        // dropped by the idle-epoch/inSession guard) — silently losing the salvaged transcript. Bail;
        // Drop still runs (capture_join already None → no double-join) and unmutes via SystemMuteGuard.
        if self.device_lost.load(Ordering::SeqCst) {
            return;
        }
        let pcm = self
            .buffer
            .lock()
            .map(|mut b| std::mem::take(&mut *b))
            .unwrap_or_default();
        let app = self.app.clone();
        let epoch = self.epoch;
        let params = self.params.clone();
        // Never publish the epoch here: `stop_record` already claimed it under the RecordState
        // lock, and a recovery cancel's keep is final (`settle_detached_batch_on_cancel` forgot
        // it). A store after the ~33-50ms capture join above can move a monotonic epoch BACKWARDS —
        // session N+1's `start_record`/`stop_record` can take the freed lock inside that join and
        // claim N+1 — so a Cancel during N+1's "transcribing…" would disown finished session N
        // instead, and the clip the user cancelled would be POSTed and its .wav + .txt kept while
        // the UI showed cancelled.
        tauri::async_runtime::spawn(async move {
            transcribe_recording(app, epoch, params, pcm).await;
        });
    }
}

pub fn start_record(app: AppHandle, p: RecordParams) -> Result<RecordSession, String> {
    let input = open_input(p.device_id.clone())?;
    let mute = SystemMuteGuard::new(p.mute_system);
    let epoch = next_session_epoch();
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let level = Arc::new(AtomicU32::new(0));
    let capture_stop = Arc::new(AtomicBool::new(false));
    announce_mic(
        &app,
        epoch,
        &input,
        p.device_id.as_deref(),
        capture_stop.clone(),
    );
    let OpenedInput {
        device,
        format,
        channels,
        config,
        rate: in_rate,
        ..
    } = input;
    let device_lost = Arc::new(AtomicBool::new(false));
    let discard = Arc::new(AtomicBool::new(false));

    let capture_join = {
        let app = app.clone();
        let buffer = buffer.clone();
        let level = level.clone();
        let stop = capture_stop.clone();
        let device_lost = device_lost.clone();
        let discard = discard.clone();
        let params = p.clone();
        std::thread::Builder::new()
            .name("record-capture".into())
            .spawn(move || {
                match run_record_capture(
                    &app,
                    device,
                    format,
                    channels,
                    config,
                    in_rate,
                    buffer.clone(),
                    level,
                    stop,
                    device_lost.clone(),
                ) {
                    Err(e) => {
                        tracing::warn!("[record] capture: {e}");
                        // Same as the streaming path: say why, then close (the frontend's error
                        // handler tears the session down; the trailing closed is then ignored).
                        emit_if_active(&app, epoch, "stream://error", mic_open_error(&e));
                        // The streaming path gets this close from the dropped pcm_tx ending its
                        // channel loop; the batch path has no such loop, so without it the chip
                        // strands on "listening" over a dead mic. committedDoc is empty
                        // pre-transcription, so the frontend just returns to idle.
                        emit_if_active(&app, epoch, "stream://status", "closed");
                    }
                    // A mid-capture device disconnect trips `stop` and returns Ok with
                    // `device_lost` set. Transcribe (and save, per "Keep recordings") what was
                    // captured, as the streaming drain does on the same loss; transcribe_recording
                    // emits the final + the trailing "closed" that unsticks the chip. A racing
                    // finish() joins this thread first and bails on `device_lost`, and discard()
                    // never transcribes, so nothing is transcribed twice.
                    // A cancel must beat the salvage, but `discard` is read only at this instant
                    // and nearly every real cancel comes later (the dead chip is what prompts it).
                    // So also publish the epoch, as `stop_record`'s `claim_detached` does for a
                    // normal stop: `transcribe_recording`'s `batch_cancelled` checks then reach
                    // this spawn, and a stale `DETACHED_BATCH_EPOCH` can't make a later
                    // `cancel_detached_batch()` disown an EARLIER session's POST.
                    Ok(())
                        if device_lost.load(Ordering::SeqCst)
                            && !discard.load(Ordering::SeqCst) =>
                    {
                        let pcm = buffer
                            .lock()
                            .map(|mut b| std::mem::take(&mut *b))
                            .unwrap_or_default();
                        publish_salvaged_batch(epoch);
                        tauri::async_runtime::spawn(transcribe_recording(
                            app.clone(),
                            epoch,
                            params,
                            pcm,
                        ));
                    }
                    Ok(()) => {}
                }
            })
            .map_err(|e| e.to_string())?
    };

    Ok(RecordSession {
        app,
        epoch,
        params: p,
        buffer,
        capture_stop,
        capture_join: Some(capture_join),
        device_lost,
        discard,
        _mute: mute,
    })
}

/// Remove a discarded batch recording — and its `.txt` sidecar when this session wrote one — on
/// the blocking pool: an unlink on a sleeping disk or an offline share must not park a runtime
/// worker.
async fn discard_recording(wav: PathBuf, with_sidecar: bool) {
    let _ =
        tauri::async_runtime::spawn_blocking(move || remove_recording(&wav, with_sidecar)).await;
}

fn remove_recording(wav: &std::path::Path, with_sidecar: bool) {
    let _ = std::fs::remove_file(wav);
    if with_sidecar {
        let _ = std::fs::remove_file(wav.with_extension("txt"));
    }
}

async fn transcribe_recording(app: AppHandle, epoch: u64, params: RecordParams, pcm: Vec<u8>) {
    // Cancelled between the stop and this task getting scheduled: archive nothing, send nothing.
    // "Cancel" has to mean discard here too, not just for a session still held in state.
    if batch_cancelled(epoch) {
        tracing::info!(
            "[record] session {epoch} cancelled before transcribing — discarding the clip"
        );
        return;
    }
    // Save FIRST, regardless of length, as the streaming save path does: whether a too-short
    // recording is worth keeping is the BACKEND's call (CAPTURES_RECORDING_MIN_DURATION_S), so
    // "Keep recordings" produces the same files on a streaming and a batch backend. An
    // all-silence clip can trim to nothing, which save_recording skips.
    // On the blocking pool, like the streaming drain's save: trim + write + fsync of a long clip
    // on a sleeping disk or an offline share must not park a runtime worker.
    // The clip moves in and comes back out, so it is never copied.
    let (pcm, saved_path) = match params.save_dir.clone() {
        Some(dir) => {
            let trim = params.trim_silence;
            let saving = tauri::async_runtime::spawn_blocking(move || {
                let path = if trim {
                    crate::audio::save_recording(
                        &dir,
                        &crate::audio::trim_silence_16k(&pcm),
                        16_000,
                    )
                } else {
                    crate::audio::save_recording(&dir, &pcm, 16_000)
                };
                (pcm, path)
            });
            match saving.await {
                Ok(done) => done,
                Err(e) => {
                    // The clip went down with the save (a panic): nothing left to transcribe.
                    tracing::warn!("[record] saving session {epoch}'s recording failed: {e}");
                    emit_if_active(
                        &app,
                        epoch,
                        "stream://error",
                        "Saving the recording failed".to_string(),
                    );
                    emit_if_active(&app, epoch, "stream://status", "closed");
                    return;
                }
            }
        }
        None => (pcm, None),
    };
    if pcm.is_empty() {
        // Nothing captured (an instant tap / misfire): close without sending, as the streaming path
        // does.
        emit_if_active(&app, epoch, "stream://status", "closed");
        return;
    }
    // Cancelled while the clip was being saved (trim + write + fsync can take a while on a long
    // recording): keeps `cancel_record`'s "a POST not yet sent is skipped" true. Removes only the
    // file this function just wrote, as the in-flight arm below does.
    if batch_cancelled(epoch) {
        tracing::info!(
            "[record] session {epoch} cancelled while saving — discarding before upload"
        );
        if let Some(p) = saved_path {
            discard_recording(p, false).await;
        }
        return;
    }
    // Wrapped in place (the buffer grows by the header), so the clip is never held twice across
    // the POST.
    let wav = crate::audio::into_wav_pcm16(pcm, 16_000, 1);
    match batch::transcribe_wav_bytes(
        &params.server_url,
        params.api_key.as_deref(),
        &params.model,
        &params.language,
        params.prompt.as_deref(),
        params.decode_overrides.as_ref(),
        params.override_profile.as_deref(),
        params.standard,
        wav,
    )
    .await
    {
        // Cancelled while the POST was in flight. The clip was written BEFORE the POST, so remove
        // it rather than leaving an orphan the user believes they discarded — and do not write the
        // transcript beside it or emit its text.
        //
        // Checked ahead of the match so it covers BOTH arms: which arm runs is the untrusted
        // server's choice (any non-2xx, a reset, or a stall past the 120s timeout lands in `Err`),
        // so an Ok-only check let a hostile server keep every cancelled clip on disk. Only ever
        // deletes a file this function just created, and only on the user's own discard.
        _ if batch_cancelled(epoch) => {
            tracing::info!("[record] session {epoch} cancelled during transcription — discarding");
            if let Some(p) = saved_path {
                discard_recording(p, false).await;
            }
        }
        Ok(res) => {
            // Bound the transcript as the streaming path does at its parse: this is the other
            // `stream://final` producer, and it feeds a `.txt` beside the recording and keystrokes
            // into the focused window. Bound it HERE, not in `transport::batch`: `post()` is shared
            // with `commands::transcribe_file` (3600s timeout), where a long transcript IS the
            // product. At ~50 KB per hour of speech, 4 MiB is ~80 hours; this path's 120s POST
            // timeout caps a legitimate one far below that.
            let text = crate::transport::stream::bounded(
                &res.text,
                crate::transport::stream::MAX_TRANSCRIPT,
            );
            // Label the saved recording with its transcript (sibling .txt), same as streaming —
            // and tell the client where it landed so its history record can link the audio.
            // On the blocking pool, like the WAV save above and the streaming drain's sidecar:
            // open + write + fsync into the same folder can hang on a disk or share that went
            // away during the POST, and must not park a runtime worker.
            if let Some(p) = &saved_path {
                let (sidecar_path, sidecar_text) = (p.clone(), text.clone());
                let wrote = tauri::async_runtime::spawn_blocking(move || {
                    crate::audio::save_transcript_sidecar(&sidecar_path, &sidecar_text)
                })
                .await
                .unwrap_or(false);
                // Cancelled while the sidecar was written — slow exactly when the disk or share
                // stalls: the user discarded this dictation, so neither file stays and nothing is
                // emitted, as in the in-flight arm above.
                if batch_cancelled(epoch) {
                    tracing::info!(
                        "[record] session {epoch} cancelled while saving its transcript — discarding"
                    );
                    discard_recording(p.clone(), wrote).await;
                    return;
                }
                emit_if_active(
                    &app,
                    epoch,
                    "stream://recording",
                    RecordingPayload {
                        path: p.to_string_lossy().to_string(),
                        utterance: None,
                        duration_ms: None,
                    },
                );
            }
            // Surface server-locked decode overrides as the streaming path's `ready` frame does
            // (the batch POST returns the same list), so a batch backend shows the "Server ignored
            // N override(s)" notice too.
            if !res.overrides_ignored.is_empty() {
                // Already bounded by to_batch_result; re-bound through the same helper as a
                // cheap boundary guard so the count/length ceilings cannot drift.
                let notices = batch::bound_notices(&res.overrides_ignored);
                emit_if_active(&app, epoch, "stream://overrides-ignored", notices);
            }
            emit_if_active(
                &app,
                epoch,
                "stream://final",
                FinalPayload {
                    committed: text,
                    tail: String::new(),
                    last: true,
                    // The batch sibling produces ONE final for the whole
                    // recording — there are no utterances to pair with, and no
                    // `captured` frame ever follows on this path.
                    utterance: None,
                },
            );
            emit_if_active(&app, epoch, "stream://status", "closed");
        }
        Err(e) => {
            // Capped like the streaming path's `error` frames: the transport bounds each piece it
            // reads, but `{e:#}` joins the whole context chain behind this prefix.
            let msg = crate::transport::bounded_server_text(
                &format!("Transcription failed: {e:#}"),
                crate::transport::MAX_ERROR_TEXT,
            );
            emit_if_active(&app, epoch, "stream://error", msg);
            emit_if_active(&app, epoch, "stream://status", "closed");
        }
    }
}

// System-audio mute guard: optionally silences OTHER apps' audio for the duration of a dictation,
// so playback / notification sounds don't leak into the mic — while leaving OUR OWN start/stop cues
// audible. Per-app: snapshot the playback streams (PulseAudio / PipeWire sink-inputs) at session
// start and mute every one that isn't ours (matched by PID) and isn't already muted, restoring
// exactly those on drop. There's no mid-session watcher, so audio that STARTS after dictation
// begins isn't muted. Falls back to muting the whole default sink when pactl can't enumerate
// streams (no PulseAudio / pipewire-pulse); off unix a deliberate no-op (see `apply_mute`). A hard
// crash mid-dictation leaves those streams muted: the next session sees them as already muted and
// skips them, so nothing restores them automatically.

/// What the guard did, so Drop undoes exactly that.
///
/// Both non-None variants are unix-only: off unix `apply_mute` is a real no-op (see below), so
/// gating them keeps the Windows build free of dead-code warnings for a state it can never reach.
#[derive(Default)]
enum MuteMode {
    #[default]
    None,
    /// Per-app: the sink-input ids WE muted (others' playback). Unmute these on drop.
    #[cfg(unix)]
    PerApp(Vec<u32>),
    /// Fallback: the whole default sink was muted; restore its prior mute state on drop.
    #[cfg(unix)]
    WholeSink(bool),
}

/// Mute / Unmute carry the sending guard's id (from `MUTE_SEQ`), so the worker can tell a stale
/// Unmute from the one that owns the mute currently applied.
enum MuteCmd {
    Mute(u64),
    Unmute(u64),
    /// Exit barrier: ack once the worker has drained to here, so cleanup_for_exit can block until a
    /// just-enqueued Unmute's pactl/wpctl restore has actually run before the process terminates.
    Flush(std::sync::mpsc::Sender<()>),
}

/// Apply the system mute (per-app, falling back to whole-sink) and return the mode to restore later.
///
/// PulseAudio/PipeWire only; off unix it must stay a real no-op: the helpers below spawn `pactl` /
/// `wpctl` by BARE PROGRAM NAME, and Windows process creation searches the current working
/// directory, so a planted `pactl.exe` there would run whenever "mute system audio" is on.
#[cfg(not(unix))]
fn apply_mute() -> MuteMode {
    MuteMode::None
}

#[cfg(unix)]
fn apply_mute() -> MuteMode {
    // Per-app first so our own cues stay audible.
    if let Some(muted) = mute_other_streams() {
        return MuteMode::PerApp(muted);
    }
    let prior = get_system_mute().unwrap_or(false);
    set_system_mute(true);
    MuteMode::WholeSink(prior)
}

#[cfg(not(unix))]
fn restore_mute(_mode: &MuteMode) {}

#[cfg(unix)]
fn restore_mute(mode: &MuteMode) {
    match mode {
        MuteMode::None => {}
        MuteMode::PerApp(ids) => {
            for &id in ids {
                set_sink_input_mute(id, false);
            }
        }
        MuteMode::WholeSink(prior) => set_system_mute(*prior),
    }
}

/// A single worker thread that runs the (blocking) pactl/wpctl mute shell-outs OFF the UI thread.
/// SystemMuteGuard::new / Drop only SEND a Mute / Unmute message. Session Drop can land on any
/// thread including the GTK/UI one, and a wedged PulseAudio/PipeWire socket must never stall
/// whichever thread holds the guard. FIFO order alone does NOT order one session's Unmute before
/// the next one's Mute: stop/cancel drop the old session outside the state lock (after a capture
/// join), so a new session can enqueue its Mute first. See `MuteSlot`.
fn mute_worker() -> &'static std::sync::mpsc::Sender<MuteCmd> {
    static WORKER: OnceLock<std::sync::mpsc::Sender<MuteCmd>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<MuteCmd>();
        std::thread::spawn(move || {
            let mut slot = MuteSlot::<MuteMode>::default();
            while let Ok(cmd) = rx.recv() {
                slot.handle(cmd, apply_mute, restore_mute);
            }
        });
        tx
    })
}

/// The worker's state: the mute currently applied and the id of the guard that owns it (0 = none).
/// Generic over the mode so the ownership rule is unit-testable without a sound server.
#[derive(Default)]
struct MuteSlot<M> {
    owner: u64,
    mode: M,
}

impl<M: Default> MuteSlot<M> {
    fn handle(&mut self, cmd: MuteCmd, apply: impl FnOnce() -> M, restore: impl Fn(&M)) {
        match cmd {
            MuteCmd::Mute(id) => {
                // Restore whatever is applied before muting again, so the worker never leaves an
                // unmatched mute behind; the new guard now owns the mute.
                restore(&self.mode);
                self.mode = apply();
                self.owner = id;
            }
            // Only the owner's Unmute restores. Any other is a guard whose mute a newer Mute already
            // restored above (its drop was enqueued late), so it must not undo the live session's mute.
            MuteCmd::Unmute(id) if id == self.owner => {
                restore(&self.mode);
                *self = Self::default();
            }
            MuteCmd::Unmute(_) => {}
            MuteCmd::Flush(ack) => {
                restore(&self.mode);
                *self = Self::default();
                let _ = ack.send(());
            }
        }
    }
}

/// Block (up to `timeout`) until the worker has drained every queued command — used on app exit so a
/// just-enqueued Unmute's blocking pactl/wpctl restore actually completes before the process dies
/// (AppHandle::exit skips destructors and the worker is detached / never joined). Bounded so a wedged
/// audio socket can't hang the quit. False when the worker did not answer in time.
fn flush_mute_worker(timeout: std::time::Duration) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    mute_worker().send(MuteCmd::Flush(tx)).is_err() || rx.recv_timeout(timeout).is_ok()
}

/// Guard ids for `MuteCmd`; starts at 1 so 0 can mean "no owner" in `MuteSlot`.
static MUTE_SEQ: AtomicU64 = AtomicU64::new(0);

struct SystemMuteGuard {
    id: Option<u64>,
}

impl SystemMuteGuard {
    fn new(enabled: bool) -> Self {
        let id = enabled.then(|| MUTE_SEQ.fetch_add(1, Ordering::SeqCst) + 1);
        if let Some(id) = id {
            let _ = mute_worker().send(MuteCmd::Mute(id));
        }
        Self { id }
    }
}

impl Drop for SystemMuteGuard {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            let _ = mute_worker().send(MuteCmd::Unmute(id));
        }
    }
}

/// Parse `pactl list sink-inputs` output → the ids of streams to MUTE: every block that is neither
/// ours (`application.process.id` == our PID, so our cues stay audible) nor already muted (so we
/// never restore something the user muted). Pure (no IO) for testability.
///
/// unix-only in the shipped binary (only `mute_other_streams` calls it), but the unit tests below
/// are platform-independent and cover it on every target.
#[cfg(any(unix, test))]
fn streams_to_mute(text: &str, our_pid: u32) -> Vec<u32> {
    // Each block: (sink-input id, already-muted, owner pid).
    let mut blocks: Vec<(u32, bool, Option<u32>)> = Vec::new();
    let mut cur: Option<(u32, bool, Option<u32>)> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Sink Input #") {
            blocks.extend(cur.take());
            cur = rest.trim().parse::<u32>().ok().map(|id| (id, false, None));
        } else if let Some(b) = cur.as_mut() {
            if let Some(rest) = t.strip_prefix("Mute:") {
                b.1 = rest.trim().eq_ignore_ascii_case("yes");
            } else if let Some(rest) = t.strip_prefix("application.process.id = ") {
                b.2 = rest.trim().trim_matches('"').parse::<u32>().ok();
            }
        }
    }
    blocks.extend(cur);
    blocks
        .into_iter()
        .filter(|&(_, already_muted, pid)| !already_muted && pid != Some(our_pid))
        .map(|(id, _, _)| id)
        .collect()
}

/// Mute every other app's playback stream (see streams_to_mute); returns the ids muted (to restore
/// on drop), or None when pactl is unavailable so the caller falls back to a whole-sink mute.
#[cfg(unix)]
fn mute_other_streams() -> Option<Vec<u32>> {
    // LC_ALL=C: pactl localizes the labels we parse ("Sink Input #", "Mute:", "yes"/"no"), so on a
    // non-English desktop the parse would find nothing → Some(vec![]) → no whole-sink fallback →
    // muting silently does nothing. Force the C locale so the parse is language-independent.
    let out = std::process::Command::new("pactl")
        .args(["list", "sink-inputs"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let ids = streams_to_mute(&String::from_utf8_lossy(&out.stdout), std::process::id());
    for &id in &ids {
        set_sink_input_mute(id, true);
    }
    Some(ids)
}

#[cfg(unix)]
fn set_sink_input_mute(id: u32, mute: bool) {
    let _ = std::process::Command::new("pactl")
        .args([
            "set-sink-input-mute",
            &id.to_string(),
            if mute { "1" } else { "0" },
        ])
        .status();
}

/// Current mute state of the default sink: PipeWire (`wpctl get-volume` → "[MUTED]") first, then
/// PulseAudio (`pactl get-sink-mute` → "Mute: yes"). The fallback MUST mirror set_system_mute's
/// wpctl→pactl fallback: on a PulseAudio-only host wpctl is absent, so a wpctl-only read returns
/// None → the guard records "unmuted" and then wrongly UN-mutes a user who began muted on drop.
#[cfg(unix)]
fn get_system_mute() -> Option<bool> {
    if let Ok(out) = std::process::Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SINK@"])
        .env("LC_ALL", "C")
        .output()
    {
        if out.status.success() {
            return Some(String::from_utf8_lossy(&out.stdout).contains("[MUTED]"));
        }
    }
    let out = std::process::Command::new("pactl")
        .args(["get-sink-mute", "@DEFAULT_SINK@"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .to_lowercase()
            .contains("yes"),
    )
}

#[cfg(unix)]
fn set_system_mute(mute: bool) {
    let v = if mute { "1" } else { "0" };
    let ok = std::process::Command::new("wpctl")
        .args(["set-mute", "@DEFAULT_AUDIO_SINK@", v])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        let _ = std::process::Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", v])
            .status();
    }
}

/// Append resampled PCM to the batch recording. Stops at `MAX_RECORD_PCM_BYTES` (4 h): a forgotten
/// session is then transcribed up to the cap instead of the buffer growing until memory runs out.
fn push_recording(buf: &Mutex<Vec<u8>>, bytes: &[u8], capped: &AtomicBool) {
    let Ok(mut b) = buf.lock() else { return };
    if !crate::audio::push_pcm_capped(&mut b, bytes) && !capped.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            "[record] recording reached the {} MB cap (4 h) — later audio is not kept; the clip is transcribed up to the cap",
            crate::audio::MAX_RECORD_PCM_BYTES / 1_000_000
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn run_record_capture(
    app: &AppHandle,
    device: Device,
    format: SampleFormat,
    channels: usize,
    config: StreamConfig,
    in_rate: u32,
    buffer: Arc<Mutex<Vec<u8>>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    device_lost: Arc<AtomicBool>,
) -> Result<(), String> {
    // Shared with the `move` capture closure via Arc<Mutex> so its buffered tail can still be
    // flushed after capture stops.
    let resampler = Arc::new(Mutex::new(
        Resampler16k::new(in_rate).map_err(|e| e.to_string())?,
    ));
    // Same raw-audio go-live detector as the streaming path (batch parity): the frontend's
    // warm-up gate runs for BOTH endpoints, so both must announce `stream://mic-live`.
    let live = Arc::new(AtomicBool::new(false));
    // Latched on the first append the recording cap cuts, so the warning is logged once per session.
    let capped = Arc::new(AtomicBool::new(false));
    let stream = match format {
        SampleFormat::F32 => {
            let buf = buffer.clone();
            let capped = capped.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[f32], _| {
                    downmix_into(data, channels, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let bytes = resampler
                        .lock()
                        .map(|mut r| r.push(&mono))
                        .unwrap_or_default();
                    if !bytes.is_empty() {
                        push_recording(&buf, &bytes, &capped);
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        SampleFormat::I16 => {
            let buf = buffer.clone();
            let capped = capped.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[i16], _| {
                    downmix_into(data, channels, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let bytes = resampler
                        .lock()
                        .map(|mut r| r.push(&mono))
                        .unwrap_or_default();
                    if !bytes.is_empty() {
                        push_recording(&buf, &bytes, &capped);
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        SampleFormat::U16 => {
            let buf = buffer.clone();
            let capped = capped.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[u16], _| {
                    downmix_into(data, channels, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let bytes = resampler
                        .lock()
                        .map(|mut r| r.push(&mono))
                        .unwrap_or_default();
                    if !bytes.is_empty() {
                        push_recording(&buf, &bytes, &capped);
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        SampleFormat::I32 => {
            let buf = buffer.clone();
            let capped = capped.clone();
            let lvl = level.clone();
            let mut sm = 0.0f32;
            let mut mono: Vec<f32> = Vec::new();
            let resampler = resampler.clone();
            let mut ld = LiveDetect::new(live.clone());
            device.build_input_stream(
                config,
                move |data: &[i32], _| {
                    downmix_into(data, channels, &mut mono);
                    sm = smooth(sm, &mono);
                    lvl.store(sm.to_bits(), Ordering::Relaxed);
                    ld.feed(&mono);
                    let bytes = resampler
                        .lock()
                        .map(|mut r| r.push(&mono))
                        .unwrap_or_default();
                    if !bytes.is_empty() {
                        push_recording(&buf, &bytes, &capped);
                    }
                },
                err_cb_with_lost(stop.clone(), device_lost.clone()),
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    crate::audio::publish_levels_with_live(app, "stream://level", &level, &stop, Some(&live));
    // Drop the stream first so no callback pushes after the resampler's tail is flushed in.
    drop(stream);
    if let Ok(mut r) = resampler.lock() {
        let tail = r.flush();
        if !tail.is_empty() {
            push_recording(&buffer, &tail, &capped);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{streams_to_mute, MuteCmd, MuteSlot};

    #[test]
    fn a_discarded_recording_takes_its_sidecar_along() {
        let dir = std::env::temp_dir().join(format!("fwf-discard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("dictation-1.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        std::fs::write(wav.with_extension("txt"), b"text\n").unwrap();
        super::remove_recording(&wav, true);
        assert!(!wav.exists());
        assert!(!wav.with_extension("txt").exists());
        // Sidecar flagged but missing on disk: the clip still goes, and the missing .txt is fine.
        std::fs::write(&wav, b"RIFF").unwrap();
        super::remove_recording(&wav, true);
        assert!(!wav.exists());
        // A .txt this session did not write stays.
        std::fs::write(&wav, b"RIFF").unwrap();
        std::fs::write(wav.with_extension("txt"), b"other\n").unwrap();
        super::remove_recording(&wav, false);
        assert!(!wav.exists());
        assert!(wav.with_extension("txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    use std::cell::RefCell;

    // stop/cancel drop the old session outside the state lock, so the next session's Mute can reach
    // the worker before the old Unmute. That late Unmute must not restore the live session's mute.
    #[test]
    fn late_unmute_from_a_replaced_guard_keeps_the_new_mute() {
        let restored = RefCell::new(Vec::new());
        let restore = |m: &u32| restored.borrow_mut().push(*m);
        let mut slot = MuteSlot::<u32>::default();
        slot.handle(MuteCmd::Mute(1), || 10, restore);
        slot.handle(MuteCmd::Mute(2), || 20, restore);
        slot.handle(MuteCmd::Unmute(1), || unreachable!(), restore);
        assert_eq!((slot.owner, slot.mode), (2, 20));
        slot.handle(MuteCmd::Unmute(2), || unreachable!(), restore);
        assert_eq!((slot.owner, slot.mode), (0, 0));
        // 0 = the no-op restore of the initial empty slot.
        assert_eq!(*restored.borrow(), vec![0, 10, 20]);
    }

    #[test]
    fn flush_restores_the_live_mute_and_acks() {
        let restored = RefCell::new(Vec::new());
        let restore = |m: &u32| restored.borrow_mut().push(*m);
        let mut slot = MuteSlot::<u32>::default();
        slot.handle(MuteCmd::Mute(1), || 10, restore);
        let (tx, rx) = std::sync::mpsc::channel();
        slot.handle(MuteCmd::Flush(tx), || unreachable!(), restore);
        assert!(rx.try_recv().is_ok());
        assert_eq!((slot.owner, slot.mode), (0, 0));
        assert_eq!(*restored.borrow(), vec![0, 10]);
    }

    // A trimmed `pactl list sink-inputs` with three streams: a normal other-app stream, one the
    // user already muted, and our own (matched by PID).
    const SAMPLE: &str = "Sink Input #10\n\
\tCorked: no\n\
\tMute: no\n\
\tProperties:\n\
\t\tapplication.name = \"Firefox\"\n\
\t\tapplication.process.id = \"100\"\n\
Sink Input #11\n\
\tMute: yes\n\
\t\tapplication.process.id = \"200\"\n\
Sink Input #12\n\
\tMute: no\n\
\t\tapplication.process.id = \"999\"\n";

    #[test]
    fn mutes_others_but_skips_ours_and_already_muted() {
        // our pid = 999 → skip #12 (ours) + #11 (already muted) → only #10 gets muted.
        assert_eq!(streams_to_mute(SAMPLE, 999), vec![10]);
    }

    #[test]
    fn empty_or_garbage_input_mutes_nothing() {
        assert!(streams_to_mute("", 1).is_empty());
        assert!(streams_to_mute("no sink inputs here\nSink Input #notanumber\n", 1).is_empty());
    }

    #[test]
    fn a_cancel_after_stop_discards_only_the_newest_detached_stream() {
        // Everything touching the DETACHED_STREAM static stays in this ONE fn: tests run in
        // parallel, and a second fn would race the global.
        use super::{
            cancel_detached_stream, claim_detached_stream, forget_detached_stream,
            settle_detached_on_cancel, settle_detached_stream, DetachedStream, DETACHED_STREAM,
        };
        use std::sync::atomic::Ordering;
        use std::sync::Arc;
        let claim = claim_detached_stream;
        let flag = || Arc::new(DetachedStream::default());
        let discarded = |f: &Arc<DetachedStream>| f.discard.load(Ordering::SeqCst);
        let (a, b) = (flag(), flag());
        claim(&a);
        claim(&b);
        cancel_detached_stream();
        assert!(discarded(&b), "the newest drain is discarded");
        assert!(!discarded(&a), "an earlier drain is left alone");
        // The slot is consumed: a second Cancel with nothing detached does nothing.
        assert!(DETACHED_STREAM.lock().unwrap().is_none());
        b.discard.store(false, Ordering::SeqCst);
        cancel_detached_stream();
        assert!(!discarded(&b), "a consumed slot discards nothing again");

        // The drain settles its own entry: a Cancel after that decision is a no-op.
        let d = flag();
        claim(&d);
        assert!(
            !settle_detached_stream(&d),
            "no Cancel came: the drain keeps its recording"
        );
        assert!(
            DETACHED_STREAM.lock().unwrap().is_none(),
            "the drain retired its slot"
        );
        cancel_detached_stream();
        assert!(
            !discarded(&d),
            "a Cancel after the drain decided reaches nothing"
        );

        // Settling is sticky: a stop that claims a drain only after it settled (the WS task
        // failed first, then the error handler's stopStream ran) publishes nothing, so a later
        // Cancel neither reaches it nor logs a discard.
        // An earlier drain still running is superseded all the same (A stopped and draining, B
        // failed at connect and was then stopped): that Cancel must not discard A.
        let (e, f) = (flag(), flag());
        claim(&e);
        settle_detached_stream(&f);
        claim(&f);
        assert!(
            DETACHED_STREAM.lock().unwrap().is_none(),
            "a settled drain is never re-published"
        );
        cancel_detached_stream();
        assert!(
            !discarded(&f),
            "a Cancel after a settled claim reaches nothing"
        );
        assert!(
            !discarded(&e),
            "nor the earlier drain the settled claim superseded"
        );

        // Taking a live session supersedes an earlier drain on every cancel path (the release of a
        // server-closed session included); with none, only the user's Cancel discards.
        let h = flag();
        claim(&h);
        settle_detached_on_cancel(true, false, true);
        cancel_detached_stream();
        assert!(
            !discarded(&h),
            "the release of a newer session superseded the drain"
        );
        claim(&h);
        settle_detached_on_cancel(true, true, true);
        cancel_detached_stream();
        assert!(
            !discarded(&h),
            "a Cancel of a newer live session superseded the drain"
        );
        claim(&h);
        settle_detached_on_cancel(false, false, true);
        assert!(
            !discarded(&h),
            "the release with no live session leaves the drain alone"
        );
        assert!(
            DETACHED_STREAM
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|f| Arc::ptr_eq(f, &h)),
            "the release with no live session leaves the drain published"
        );
        settle_detached_on_cancel(false, true, false);
        cancel_detached_stream();
        assert!(
            !discarded(&h),
            "a recovery cancel releases the drain for good"
        );
        claim(&h);
        settle_detached_on_cancel(false, true, true);
        assert!(
            discarded(&h),
            "a user's Cancel with no live session discards the drain"
        );

        // A Cancel before the decision is the one the drain reads.
        let g = flag();
        claim(&g);
        cancel_detached_stream();
        assert!(
            settle_detached_stream(&g),
            "a Cancel before the decision discards"
        );

        // An older drain settling never wipes a newer session's claim.
        let e = flag();
        claim(&e);
        settle_detached_stream(&a);
        assert!(DETACHED_STREAM
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|f| Arc::ptr_eq(f, &e)));

        // A recovery cancel's keep is final: a later stray Cancel cannot reach that drain.
        let c = flag();
        claim(&c);
        forget_detached_stream();
        cancel_detached_stream();
        assert!(!discarded(&c), "a forgotten drain is never discarded");
        *DETACHED_STREAM.lock().unwrap() = None;
    }

    #[test]
    fn a_later_cancel_keeps_an_earlier_batch_cancelled() {
        // Everything touching the DETACHED_BATCH_EPOCH static stays in this ONE fn: tests run in
        // parallel, and a second fn would race the global.
        use super::{
            batch_cancelled, cancel_detached_batch, forget_detached_batch, mark_batch_cancelled,
            publish_salvaged_batch, settle_detached_batch_on_cancel, DETACHED_BATCH_EPOCH,
        };
        use std::sync::atomic::Ordering;
        // Epochs far above anything a real session claims in a test run.
        let (a, b, c) = (u64::MAX - 3, u64::MAX - 2, u64::MAX - 1);
        // stop A → cancel while A transcribes (disowns the detached A)…
        DETACHED_BATCH_EPOCH.store(a, Ordering::SeqCst);
        cancel_detached_batch();
        // …→ start B → cancel B (RecordSession::discard marks B's own epoch).
        mark_batch_cancelled(b);
        assert!(batch_cancelled(a), "B's cancel must not un-cancel A");
        assert!(batch_cancelled(b));
        assert!(!batch_cancelled(c));
        assert!(!batch_cancelled(0));
        // A recovery cancel kept C: a later stray Cancel finds nothing to disown.
        DETACHED_BATCH_EPOCH.store(c, Ordering::SeqCst);
        forget_detached_batch();
        cancel_detached_batch();
        assert!(!batch_cancelled(c), "a kept transcription stays kept");

        // Taking a live session supersedes the earlier detached batch on every cancel path; with
        // none, only the user's Cancel disowns it.
        let (d, e, f, g) = (u64::MAX - 7, u64::MAX - 6, u64::MAX - 5, u64::MAX - 4);
        DETACHED_BATCH_EPOCH.store(d, Ordering::SeqCst);
        settle_detached_batch_on_cancel(true, true, true);
        cancel_detached_batch();
        assert!(
            !batch_cancelled(d),
            "a Cancel of a newer live session superseded the batch"
        );
        DETACHED_BATCH_EPOCH.store(e, Ordering::SeqCst);
        settle_detached_batch_on_cancel(false, false, true);
        assert!(
            !batch_cancelled(e),
            "the release with no live session leaves the batch alone"
        );
        assert_eq!(DETACHED_BATCH_EPOCH.load(Ordering::SeqCst), e);
        DETACHED_BATCH_EPOCH.store(f, Ordering::SeqCst);
        settle_detached_batch_on_cancel(false, true, false);
        assert_eq!(
            DETACHED_BATCH_EPOCH.load(Ordering::SeqCst),
            0,
            "a recovery cancel releases the batch"
        );
        assert!(!batch_cancelled(f));
        DETACHED_BATCH_EPOCH.store(g, Ordering::SeqCst);
        settle_detached_batch_on_cancel(false, true, true);
        assert!(
            batch_cancelled(g),
            "a user's Cancel with no live session disowns the batch"
        );

        // A salvage firing inside finish()'s capture join, after session N+1 claimed, never moves
        // the slot back to N; after a forget it still publishes.
        let (s, h) = (u64::MAX - 9, u64::MAX - 8);
        DETACHED_BATCH_EPOCH.store(h, Ordering::SeqCst);
        publish_salvaged_batch(s);
        assert_eq!(
            DETACHED_BATCH_EPOCH.load(Ordering::SeqCst),
            h,
            "a late salvage keeps the newer claim"
        );
        DETACHED_BATCH_EPOCH.store(0, Ordering::SeqCst);
        publish_salvaged_batch(s);
        assert_eq!(DETACHED_BATCH_EPOCH.load(Ordering::SeqCst), s);
        DETACHED_BATCH_EPOCH.store(0, Ordering::SeqCst);
    }
}
