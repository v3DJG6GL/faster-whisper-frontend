//! Insert transcribed text into the focused field of the active application.
//!
//! Three strategies (mirroring the settings):
//!   * **paste** — put the text on the clipboard and synthesize Ctrl/Cmd+V
//!     (robust, layout-agnostic; optional clipboard restore afterwards).
//!   * **direct** — type the characters directly via the OS (never touches the
//!     clipboard, but can struggle with some layouts / non-Latin input).
//!   * **clipboard** — only leave the text on the clipboard for the user to paste (no keystrokes).
//!
//! Backed by `enigo` (Windows SendInput / X11 XTEST) and `arboard` for the clipboard; native
//! Wayland typing and paste go through the RemoteDesktop portal or the virtual keyboard.
//!
//! Submodules: the per-transcript insert behind the `inject_text` command (`text`), the
//! native-Wayland typing backends (`wayland` — portal keycodes, `virtual_keyboard`
//! — zwp_virtual_keyboard_v1), the Windows clipboard owner for remote-desktop pastes
//! (`windows_clipboard`) and remote-desktop client detection (`rdp_client`).

pub mod rdp_client;
pub mod text;
pub mod virtual_keyboard;
pub mod wayland;
pub mod windows_clipboard;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Generation counter for "the injection in flight is no longer wanted".
///
/// The Wayland typing paths emit ONE KEY AT A TIME with fixed inter-key sleeps (roughly a
/// hundred characters a second), and the frontend's cancel checks sit before and after the
/// awaited injection, never inside it — so without this, stopping dictation, cancelling or
/// closing the window would not stop keys already going out into whatever window holds focus.
/// Each injection captures the counter at entry and re-reads it between keys; a cancel bumps it
/// and every loop in flight bails at its next character.
///
/// A generation rather than a flag, so a cancel can never leak into the NEXT injection: the new
/// one captures the already-bumped value.
static INJECT_EPOCH: AtomicU64 = AtomicU64::new(0);

/// The value an injection starting NOW should carry.
pub fn injection_epoch() -> u64 {
    INJECT_EPOCH.load(Ordering::SeqCst)
}

/// Should a job abandoned by the CURRENT bump leave its text on the clipboard?
///
/// A user-initiated cancel means "I don't want this" — recovering it to the clipboard would
/// be the opposite of the request. A session that DIED (a server error frame, a fatal insert,
/// a rejected stop) is different: the user never asked for the text to go away, and the
/// stop-mode path already copies the transcript for manual recovery. Set alongside the bump so
/// the two cases stay distinguishable at the point the job bails.
///
/// Carries the epoch VALUE produced by the most recent error-abort bump, not a bare "the last
/// bump was an error" flag. A flag is read long after it is written — the job that bailed asks
/// about it at the end of `inject_text` — so two interleaved aborts let a user cancel adopt an
/// error abort's answer and put the transcript the user explicitly discarded onto the clipboard
/// as a persistent owner, clobbering whatever they had copied. Comparing the epoch instead asks
/// the precise question: was the bump that superseded MY job an error abort?
static RECOVER_AT_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Abandon whatever is currently being typed, at its next character boundary. The user asked
/// for this, so the abandoned text is NOT recovered.
pub fn cancel_injection() {
    INJECT_EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// Same abandonment, but for a session that died rather than one the user cancelled: the text
/// still being typed is left on the clipboard so it is recoverable.
pub fn abort_injection_for_error() {
    let produced = INJECT_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    RECOVER_AT_EPOCH.store(produced, Ordering::SeqCst);
}

/// Was the bump that superseded the job started at `epoch` an error abort (recover) rather than a
/// user cancel (drop)? Only the FIRST bump past `epoch` can be attributed, which is the one that
/// actually stopped this job.
pub fn cancel_wants_recovery(epoch: u64) -> bool {
    RECOVER_AT_EPOCH.load(Ordering::SeqCst) == epoch + 1
}

/// Has the injection that started at `epoch` been cancelled since?
pub fn injection_cancelled(epoch: u64) -> bool {
    INJECT_EPOCH.load(Ordering::SeqCst) != epoch
}

/// Was the job started at `epoch` stopped by an ERROR abort (its text is to be recovered)?
pub fn error_aborted(epoch: u64) -> bool {
    injection_cancelled(epoch) && cancel_wants_recovery(epoch)
}

/// Does a cancel of the job started at `epoch` discard its insert? A user cancel always does; an
/// error abort only for a withheld insert (nothing in it to recover).
pub fn cancel_discards(epoch: u64, withhold_on_divert: bool) -> bool {
    injection_cancelled(epoch) && (!cancel_wants_recovery(epoch) || withhold_on_divert)
}

/// Set when an error-abort recovery has just put an abandoned transcript on the clipboard, so
/// the SESSION-level restore does not erase it.
///
/// `inject_text`'s own per-paste restore already asks this question via `error_aborted(epoch)`,
/// but that guard needs the job's epoch and `end_injection` has none — it runs after the job is
/// gone, chained on the same `stream://error` teardown that armed the recovery, and would serve
/// the user's old clipboard 400ms later over the top. That leaves the transcript neither typed
/// nor recoverable while both layers log success.
///
/// A one-shot flag rather than an epoch comparison: `INJECT_EPOCH` only ever advances on a
/// cancel or an abort, so `RECOVER_AT_EPOCH == INJECT_EPOCH` stays true indefinitely after one
/// error abort and would suppress every later legitimate restore.
///
/// Both session-level restores honour it: the per-phrase `restore_clipboard_snapshot` peeks it
/// (a restore the frontend queued before an error abort can still run after the recovery write),
/// and `end_injection` takes it.
///
/// Armed at all four recovery writes (the Wayland paste arm's write guard, the error-abort block
/// at the end of `inject_text`, the mid-function divert arm and the entry clipboard-only arm), and
/// consumed at the top of `end_injection` — unconditionally,
/// above its snapshot test, so a session that never took a snapshot still clears it — or by
/// `discard_injection_snapshot`, the other way a session ends. Those two are the only session
/// teardowns, so the flag cannot outlive the session that armed it, which is what makes it safe
/// without a per-phrase clear. Clearing it in `begin_injection` instead would be redundant and
/// racy: `is_own_injected` is a single-slot compare and `set_clipboard_persistent` serves the
/// selection on a detached thread, so just after the recovery write the clipboard still holds the
/// previous phrase while `LAST_INJECTED` already holds the recovery text — a fast re-trigger's
/// `begin_injection` would read our own stale transcript as the user's and clear a flag still owed
/// a restore.
static RECOVERY_ON_CLIPBOARD: AtomicBool = AtomicBool::new(false);

/// Record that the clipboard now holds a recovered transcript (see `RECOVERY_ON_CLIPBOARD`).
pub fn note_recovery_on_clipboard() {
    RECOVERY_ON_CLIPBOARD.store(true, Ordering::SeqCst);
}

/// Peek at the recovery flag without consuming it: the per-phrase `restore_clipboard_snapshot`
/// declines while a recovered transcript is on the clipboard but leaves the flag for the session
/// teardown (`end_injection` / `discard_injection_snapshot`) to consume.
pub fn recovery_on_clipboard() -> bool {
    RECOVERY_ON_CLIPBOARD.load(Ordering::SeqCst)
}

/// Take the recovery flag: true exactly once per recovery, for the restore that would erase it.
pub fn take_recovery_on_clipboard() -> bool {
    RECOVERY_ON_CLIPBOARD.swap(false, Ordering::SeqCst)
}

/// Drop a recovery flag nobody consumed: the session ended without a restore
/// (`discard_injection_snapshot`). Never call this at session START — see `RECOVERY_ON_CLIPBOARD`.
pub fn clear_recovery_on_clipboard() {
    RECOVERY_ON_CLIPBOARD.store(false, Ordering::SeqCst);
}

/// The last text WE placed on the clipboard for an insertion (transcript paste, clipboard-only
/// insert, Wayland paste). Guards every "capture the user's previous clipboard" site: if a
/// restore fails silently or is skipped, the stale transcript stays on the clipboard, the next
/// capture would adopt it as "the user's clipboard", and the restore chain would then resurrect
/// it after every future paste (over RDP, the remote's delayed clipboard fetch then pastes a
/// minutes-old transcript).
static LAST_INJECTED: Mutex<Option<String>> = Mutex::new(None);

/// Record `text` as the most recent clipboard content WE set (see `LAST_INJECTED`), returning the
/// value it replaced. Read and replaced under one lock, so a caller that may have to take its note
/// back (`persist_transcript_unless`) holds exactly what it replaced, not a value a note from
/// another thread superseded between a separate read and this write.
fn note_injected(text: &str) -> Option<String> {
    LAST_INJECTED
        .lock()
        .ok()
        .and_then(|mut g| g.replace(text.to_string()))
}

/// Take back a `note_injected(text)` whose write then served nothing: put `prev` (the value before
/// it) back into `slot`, but only while `slot` still names `text` — a newer note is a newer write
/// and stays. Otherwise the slot names a string that never reached the clipboard while what IS
/// there (a divert's pasted text, say) is no longer recognised as ours, and the next capture
/// adopts our own transcript as the user's clipboard. A parameter, not the global, so it can be
/// tested without touching `LAST_INJECTED` (see `a_failed_persist_takes_its_injected_note_back`).
fn unnote_injected(slot: &Mutex<Option<String>>, prev: Option<String>, text: &str) {
    if let Ok(mut g) = slot.lock() {
        if g.as_deref() == Some(text) {
            *g = prev;
        }
    }
}

/// True when `text` is the last text we put on the clipboard ourselves — i.e. NOT something
/// the user copied. Compared with CRLF normalized to LF: the Windows clipboard round-trips
/// LF as CRLF, which would otherwise defeat the match for multi-line transcripts.
pub fn is_own_injected(text: &str) -> bool {
    fn norm(s: &str) -> String {
        s.replace("\r\n", "\n")
    }
    LAST_INJECTED
        .lock()
        .ok()
        .and_then(|g| g.as_deref().map(|last| norm(last) == norm(text)))
        .unwrap_or(false)
}

/// Did the most recent PASTE go to a remote-desktop target?
///
/// Decided by where the paste WENT, not by the CURRENT focus: the session-level restores
/// (`end_injection`, `restore_clipboard_snapshot`) run on a quiet timer or at teardown, long after
/// the paste, when the user may have moved focus INTO an RDP window (skipping a restore the local
/// paste was owed) or OUT of one (restoring over the transcript a still-pending remote fetch has
/// not collected yet — the delayed-rendering hazard this skip exists for). Set at the X11/Windows
/// write in `paste` and by `inject_text`'s Wayland arm right after its write (a phrase that bailed
/// before its write leaves the previous paste's target in place); only an Err to a remote target
/// is recorded post hoc, as `true` — the safe side, since it may or may not have written. Cleared
/// by the two session teardowns.
static LAST_PASTE_REMOTE: AtomicBool = AtomicBool::new(false);

/// Record where the paste whose transcript just reached the clipboard goes (see
/// `LAST_PASTE_REMOTE`). A paste also supersedes any transcript delivered to the clipboard
/// before it (see `DELIVERED_ON_CLIPBOARD`).
pub fn note_paste_target(remote: bool) {
    LAST_PASTE_REMOTE.store(remote, Ordering::SeqCst);
    DELIVERED_ON_CLIPBOARD.store(false, Ordering::SeqCst);
}

pub fn last_paste_was_remote() -> bool {
    LAST_PASTE_REMOTE.load(Ordering::SeqCst)
}

/// Forget the last paste target (a session ended), and with it any delivered-transcript flag.
pub fn clear_paste_target() {
    LAST_PASTE_REMOTE.store(false, Ordering::SeqCst);
    DELIVERED_ON_CLIPBOARD.store(false, Ordering::SeqCst);
}

/// The session's last clipboard write DELIVERED a transcript there for the user to paste — a
/// clipboard-only phrase or a divert (`inject_text`) — and no paste has written since.
///
/// The frontend decides the end-of-session restore from its own restore-debt flag, which a
/// delivered phrase clears; but an error teardown or a rejected stop clears that flag anyway and
/// calls `end_injection` regardless, which would then serve the session snapshot over the phrase
/// the user had just been told to paste. Recorded here, in write order (the inject queue serialises
/// the writes), rather than captured by the frontend: a paste already queued but not yet written
/// would otherwise land after a snapshot of the flags and leave them stale.
///
/// Armed by the clipboard-only/divert writes in `inject_text` and by every `diverted: true` it
/// reports (`text::settle_outcome`, the Wayland chord divert), cleared by every paste write
/// (`note_paste_target`) — that paste replaced the delivered text — and by a write a user cancel
/// superseded (`note_delivered_unless_user_cancelled`), and consumed by `end_injection`
/// or dropped by `discard_injection_snapshot` (both via `clear_paste_target`).
static DELIVERED_ON_CLIPBOARD: AtomicBool = AtomicBool::new(false);

/// Record that a delivered transcript now sits on the clipboard (see `DELIVERED_ON_CLIPBOARD`).
pub fn note_delivered_on_clipboard() {
    DELIVERED_ON_CLIPBOARD.store(true, Ordering::SeqCst);
}

/// `note_delivered_on_clipboard` for a write made by the job started at `epoch` — unless a USER
/// cancel superseded that job in the meantime. The pre-write cancel gates run before the write,
/// so a cancel landing during it still reaches the arm; the frontend then drops the outcome, and
/// the cancel's chained `end_injection` would take the flag and skip the snapshot restore,
/// leaving the discarded transcript on the clipboard and the user's own clipboard lost. A user
/// cancel owes that restore. An error abort (`cancel_wants_recovery`) still arms it: its text is
/// meant to stay recoverable.
///
/// A user cancel CLEARS the flag rather than leaving it alone: every caller has just written this
/// job's transcript, which superseded any earlier delivered text — and only paste writes clear the
/// flag themselves (`note_paste_target`), not the clipboard-only or divert writes. Left alone, an
/// earlier phrase's delivery would survive under the discarded transcript and the session-end
/// restore would still be skipped.
pub fn note_delivered_unless_user_cancelled(epoch: u64) {
    if injection_cancelled(epoch) && !cancel_wants_recovery(epoch) {
        DELIVERED_ON_CLIPBOARD.store(false, Ordering::SeqCst);
        return;
    }
    note_delivered_on_clipboard();
}

/// Take the delivered-transcript flag: true once, for the session-end restore that would erase it.
pub fn take_delivered_on_clipboard() -> bool {
    DELIVERED_ON_CLIPBOARD.swap(false, Ordering::SeqCst)
}

/// "Keep dictated text out of clipboard history & cloud clipboard" (settings.general
/// `excludeFromClipboardHistory`). A process-wide switch rather than an IPC argument, applied by
/// `commands::set_live_switches` at startup and on every save (written, or held back by the
/// webview), so EVERY transcript write honours it — paste, clipboard-only, the diverts, the
/// error-abort recovery, Quick-Add — without each call site having to carry it. 0 = off, 1 = on,
/// 2 = not applied yet (treated as on: private is the default, and the startup apply follows
/// within milliseconds).
static CLIP_PRIVATE: AtomicU8 = AtomicU8::new(2);

/// Apply the setting. Logged on change only (it is re-applied on every autosave).
pub fn set_clipboard_privacy(on: bool) {
    let prev = CLIP_PRIVATE.swap(u8::from(on), Ordering::SeqCst);
    if prev != u8::from(on) {
        tracing::info!(
            "[clip] privacy: dictated text excluded from clipboard history/cloud = {on}"
        );
    }
}

/// Should OUR transcript writes carry the history/cloud exclusion hints?
pub fn clipboard_privacy() -> bool {
    CLIP_PRIVATE.load(Ordering::SeqCst) != 0
}

/// `cb.set().text(text)`, with the platform's "do not record this" hints when `exclude`:
///   * Windows: `CanIncludeInClipboardHistory` = 0 and `CanUploadToCloudClipboard` = 0 (NOT
///     `ExcludeClipboardContentFromMonitorProcessing` — that hides the item from clipboard
///     listeners, and an RDP client is one, so it could stop the text reaching the remote).
///   * Linux: `x-kde-passwordManagerHint` (Klipper, and the managers that follow its convention).
///     On X11 arboard then also SKIPS the clipboard-manager hand-off when the `Clipboard` drops —
///     it clears the selection instead — so a write that must outlive its `Clipboard` has to go
///     through a live owner (`wait`), which is what the callers below arrange.
///   * macOS: `org.nspasteboard.ConcealedType`.
///
/// `wait` (Linux only) keeps serving the selection until another app replaces it.
pub(crate) fn set_text_ext(
    cb: &mut arboard::Clipboard,
    text: &str,
    exclude: bool,
    wait: bool,
) -> Result<(), arboard::Error> {
    #[allow(unused_mut)] // only the platform arms below rebind it
    let mut set = cb.set();
    #[cfg(windows)]
    {
        use arboard::SetExtWindows;
        let _ = wait;
        if exclude {
            set = set.exclude_from_history().exclude_from_cloud();
        }
    }
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        if exclude {
            set = set.exclude_from_history();
        }
        if wait {
            set = set.wait();
        }
    }
    #[cfg(target_os = "macos")]
    {
        use arboard::SetExtApple;
        let _ = wait;
        if exclude {
            set = set.exclude_from_history();
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (exclude, wait);
    }
    set.text(text.to_string())
}

/// Line endings for OUR transcript on its way to the clipboard. The transcript is LF-only
/// (`sanitize_injected`), and a Windows clipboard reader expects CRLF: Notepad and many edit
/// controls show a bare LF as nothing at all, so a multi-line dictation would paste as one line. Every
/// Windows write of a transcript goes through here; restores do NOT (they hand back exactly what
/// the user had). CRLF is first collapsed to LF so text that already has CRLF is never doubled.
/// Off Windows the text is returned untouched.
pub fn clipboard_newlines(text: &str, windows: bool) -> Cow<'_, str> {
    if !windows || !text.contains('\n') {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.replace("\r\n", "\n").replace('\n', "\r\n"))
}

/// One piece of a direct-typing job: a run of text, or a separator that must be a real KEY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeSeg<'a> {
    Text(&'a str),
    Enter,
    Tab,
}

/// Split `text` for enigo: `\n` → an Enter click, `\t` → a Tab click, everything else as text
/// runs of at most `max_chars` characters (split on char boundaries — see `DIRECT_CHUNK_CHARS`).
///
/// Separators are keys, not characters, because `enigo.text("\n")` does not type Enter: on X11 it
/// maps '\n' to the XK_Linefeed keysym (ignored by most apps), on Windows it goes out as a
/// VK_PACKET for U+000A that edit controls drop, and on macOS it can come out as U+200B.
pub fn typing_segments(text: &str, max_chars: usize) -> Vec<TypeSeg<'_>> {
    fn push_run<'a>(mut run: &'a str, max_chars: usize, out: &mut Vec<TypeSeg<'a>>) {
        while !run.is_empty() {
            let split = match run.char_indices().nth(max_chars) {
                Some((i, _)) => i,
                None => run.len(),
            };
            let (chunk, tail) = run.split_at(split);
            out.push(TypeSeg::Text(chunk));
            run = tail;
        }
    }
    let max_chars = max_chars.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        let sep = match c {
            '\n' => TypeSeg::Enter,
            '\t' => TypeSeg::Tab,
            _ => continue,
        };
        push_run(&text[start..i], max_chars, &mut out);
        out.push(sep);
        start = i + c.len_utf8();
    }
    push_run(&text[start..], max_chars, &mut out);
    out
}

/// Single-flight flag for the time-bounded clipboard/PRIMARY reads (`commands::read_selection_bounded`).
/// It stays set while a read that outlived its 400ms cap is STILL running on its blocking thread —
/// which on Windows means that thread still holds (or is waiting on) `OpenClipboard`. Any write we
/// make meanwhile either fails outright or, worse, races the stuck reader, so every write path asks
/// `wait_clip_read_idle` first. Lives here (not in commands/) so the writers can see it.
pub(crate) static CLIP_READ_BUSY: AtomicBool = AtomicBool::new(false);

fn clip_read_busy() -> bool {
    CLIP_READ_BUSY.load(Ordering::Acquire)
}

/// What a transcript write does after waiting out a stuck clipboard read.
#[derive(Debug, PartialEq, Eq)]
enum AfterIdleWait {
    Write,
    /// Cancelled during the wait: write nothing. Wins over `Stuck` — a deliberate no-op, not a
    /// re-send.
    Cancelled,
    /// The read is still stuck: write nothing.
    Stuck,
}

/// The stuck-read wait (≤ `CLIP_IDLE_WAIT` on Windows) plus the cancel re-check behind it, shared
/// by `paste` and `persist_transcript_unless`. Their callers ask about a cancel BEFORE this wait,
/// so a cancel that lands during it must be asked again here: otherwise the transcript the user
/// discarded is still written, and on these paths — the same stuck read is the snapshot read that
/// never came back — there is no prior clipboard to restore.
fn after_idle_wait(wait: impl FnOnce() -> bool, cancelled: impl Fn() -> bool) -> AfterIdleWait {
    let idle = wait();
    if cancelled() {
        AfterIdleWait::Cancelled
    } else if !idle {
        AfterIdleWait::Stuck
    } else {
        AfterIdleWait::Write
    }
}

/// `paste`'s stuck-read wait — see `after_idle_wait`. `Some` = bail before the write: a cancel is
/// a deliberate no-op (`Yes`), a still-stuck read is `NothingWritten` (the caller re-sends).
fn idle_wait_gate(wait: impl FnOnce() -> bool, cancelled: impl Fn() -> bool) -> Option<Landed> {
    match after_idle_wait(wait, cancelled) {
        AfterIdleWait::Cancelled => {
            tracing::info!(
                "[clip] paste: cancelled while waiting out a stuck clipboard read — skipping"
            );
            Some(Landed::Yes)
        }
        AfterIdleWait::Stuck => {
            tracing::warn!("[clip] paste: nothing written — the caller re-sends");
            Some(Landed::NothingWritten)
        }
        AfterIdleWait::Write => None,
    }
}

/// Wait (≤ `max`) for a stuck clipboard read to finish before writing. True = go ahead. Only
/// Windows waits: there the clipboard is a lock (`OpenClipboard`) the stuck reader holds. On
/// Linux a stuck read is a pending selection transfer that does not block a new owner, so this
/// returns true at once.
pub fn wait_clip_read_idle(max: Duration) -> bool {
    #[cfg(windows)]
    {
        if !clip_read_busy() {
            return true;
        }
        let t0 = std::time::Instant::now();
        tracing::info!("[clip] a clipboard read is still running — waiting before the write");
        while clip_read_busy() {
            if t0.elapsed() >= max {
                tracing::warn!(
                    "[clip] the clipboard read is still stuck after {}ms — not writing",
                    max.as_millis()
                );
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        tracing::info!(
            "[clip] the clipboard read finished after {}ms — writing",
            t0.elapsed().as_millis()
        );
        true
    }
    #[cfg(not(windows))]
    {
        let _ = max;
        true
    }
}

/// How long a writer waits for a stuck read (see `wait_clip_read_idle`).
const CLIP_IDLE_WAIT: Duration = Duration::from_secs(1);

/// One clipboard JOB at a time between the jobs that write the clipboard and then press a chord
/// whose effect depends on what is on it: `paste` (write the transcript, Ctrl+V) and the Windows
/// quick-add copy grab (`win_seed::grab`: Ctrl+Insert, wait for the copy, read it, put the user's
/// text back), which runs on summon and again as the correct-on-close re-grab. Both wait out the
/// same chord-modifier release gate, so a phrase held back by the quick-add chord is released in
/// the same tick as the grab: the paste's write then bumps the sequence number the grab reads as
/// "the copy landed", the grab puts the user's old clipboard back during the paste's settle, and
/// the Ctrl+V pastes that instead of the phrase. A third, try-only taker (Windows only, like the
/// grab) is `begin_injection`'s session-snapshot read: mid-grab the clipboard holds the user's
/// SELECTION, which that read would otherwise store and the end-of-session restore write over
/// their real clipboard. It holds the
/// lock only across one capped read (a read stuck past its 400 ms cap keeps it, so a paste then
/// waits up to `CLIP_JOB_WAIT` and answers `NothingWritten` — the same answer a stuck read already
/// gives via `wait_clip_read_idle`, only later). Only `paste` waits for it (`wait_clip_job`); the
/// others take it with `try_clip_job` and never a blocking `lock`, and no holder calls another, so
/// it cannot deadlock. The 400 ms restore timer is NOT covered: the restore slot has its own take
/// protocol.
static CLIP_JOB: Mutex<()> = Mutex::new(());

/// Take the clipboard-job lock if it is free (see `CLIP_JOB`). A poisoned lock is recovered: it
/// guards no data, so a panicked holder leaves nothing inconsistent behind.
pub(crate) fn try_clip_job() -> Option<std::sync::MutexGuard<'static, ()>> {
    match CLIP_JOB.try_lock() {
        Ok(g) => Some(g),
        Err(std::sync::TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

/// How long `paste` waits for a quick-add copy grab to finish, instead of bailing mid-grab: a
/// stop-mode insert that bailed turned into a clipboard recovery the grab then put the user's old
/// text over. The grab's `COPY_DEADLINE_RDP_MS` (6 s) starts at the copy chord and bounds the copy
/// poll and the read retries; the clipboard prologue before it and each single read are un-timed
/// and can stall over RDP. 8 s covers the usual grab; a stalled one still ends the wait mid-grab
/// (`NothingWritten`, or for an error abort its recovery). Only a USER cancel ends the
/// wait early (or any cancel of a withheld insert, which has nothing to recover): an error abort
/// waits too, so its clipboard recovery (`inject_text`) cannot land mid-grab, where the grab
/// would read it as the copy or put the user's old text over it. Where a
/// phrase that waited lands: the summon grab shows and focuses the quick-add window, so `paste`'s
/// own-window check skips the phrase (as it does for any focus moved into our windows) and it
/// is re-sent with the next insert; the correct-on-close re-grab runs with quick-add hidden and the
/// source app focused, so the phrase IS pasted there once the grab ends, ahead of the correction.
/// Accepted: the lock only orders the two, and the alternative is a paste in the middle of the
/// grab.
const CLIP_JOB_WAIT: Duration = Duration::from_secs(8);

/// `try_clip_job`, polled every 15 ms for up to `max`, or until `give_up` says so. None = still
/// held.
fn wait_clip_job(
    max: Duration,
    give_up: impl Fn() -> bool,
) -> Option<std::sync::MutexGuard<'static, ()>> {
    let t0 = std::time::Instant::now();
    loop {
        if let Some(g) = try_clip_job() {
            return Some(g);
        }
        if t0.elapsed() >= max || give_up() {
            return None;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// Read the clipboard's text before a paste overwrites it, for the restore. arboard gives up
/// opening the clipboard after ~25 ms when another process holds it (`ClipboardOccupied`, Windows):
/// clipboard listeners (rdpclip, clipboard history) do exactly that right after any write. Read as
/// "nothing to restore", that would let the paste overwrite the user's text with no restore
/// scheduled, so retry it briefly (≤ 50 ms), like the quick-add grab's snapshot does. Any other
/// error is "nothing to restore".
pub(crate) fn read_prior_text(cb: &mut arboard::Clipboard) -> Option<String> {
    read_prior_text_with(|| cb.get_text(), Duration::from_millis(25))
}

fn read_prior_text_with(
    mut get_text: impl FnMut() -> Result<String, arboard::Error>,
    retry_after: Duration,
) -> Option<String> {
    let mut tries = 0;
    loop {
        tries += 1;
        match get_text() {
            Ok(t) => return Some(t),
            Err(arboard::Error::ClipboardOccupied) if tries < 3 => {
                std::thread::sleep(retry_after);
            }
            Err(arboard::Error::ClipboardOccupied) => {
                tracing::info!(
                    "[clip] prior clipboard read: clipboard busy (held by another process) after 3 tries"
                );
                return None;
            }
            Err(_) => return None,
        }
    }
}

/// Is a prior clipboard read worth restoring after the paste? Not OUR OWN last transcript: it
/// lingers there after a failed/skipped restore, and restoring it would resurrect stale dictation
/// after every future paste. Not an empty read either: a stalled delayed
/// render (a copy made inside an RDP session) reads back "", and writing "" back 400 ms later would
/// erase the user's remote copy — and would supersede a real restore still pending from the
/// previous paste (`merge_pending_restore` adopts that one only when this read yields nothing). A
/// clipboard that really is empty loses nothing. Shared by both paste paths (`paste`, Wayland).
pub(crate) fn worth_restoring(prior: &str) -> bool {
    if prior.is_empty() {
        tracing::info!(
            "[clip] paste: prior clipboard text read back empty (stalled delayed render?) — skipping restore"
        );
        return false;
    }
    if is_own_injected(prior) {
        tracing::info!("[clip] paste: prior clipboard is our own transcript — skipping restore");
        return false;
    }
    true
}

/// The restore scheduled by `restore_clipboard_later`, generation-stamped so a NEWER clipboard
/// write can supersede it — otherwise a restore owed by phrase N lands on top of phrase N+1's
/// transcript pasted inside the 400ms window (a slow target pastes the user's OLD clipboard). The
/// newer write takes the pending restore: a local paste ADOPTS it as its own "previous" (the user's
/// clipboard still comes back, once, after the newest paste); anything else drops it.
#[derive(Debug, Default)]
struct RestoreSlot {
    gen: u64,
    pending: Option<String>,
}

impl RestoreSlot {
    /// Schedule `text`, superseding whatever was pending. Returns the generation to check.
    fn schedule(&mut self, text: String) -> u64 {
        self.gen += 1;
        self.pending = Some(text);
        self.gen
    }

    /// The timer fired: the text, only if nothing superseded it meanwhile.
    fn take_if_current(&mut self, gen: u64) -> Option<String> {
        if self.gen == gen {
            self.pending.take()
        } else {
            None
        }
    }

    /// A newer write took over: invalidate the timer and hand back what was pending.
    fn cancel(&mut self) -> Option<String> {
        self.gen += 1;
        self.pending.take()
    }
}

static RESTORE: Mutex<RestoreSlot> = Mutex::new(RestoreSlot {
    gen: 0,
    pending: None,
});

/// Take (and cancel) the restore still waiting out its 400ms, if any.
pub fn take_pending_restore() -> Option<String> {
    RESTORE.lock().ok().and_then(|mut s| s.cancel())
}

/// Merge a restore taken by `take_pending_restore` into this paste's `previous`. `eligible` = a
/// LOCAL paste (a remote target never restores — see `paste`). A pending restore is ADOPTED only
/// when this paste has no better answer of its own — its prior read came back empty or as our own
/// previous transcript (which is exactly what it reads when it lands inside the previous paste's
/// restore window), or it did not read at all (restore off for THIS paste: the pending restore
/// was still owed by an earlier one, and without the adoption it would simply be lost). A real
/// prior read means the user copied something since, and that wins. Anything else — a remote
/// target, a clipboard-only write, a divert — drops it: that text has to STAY on the clipboard.
pub fn merge_pending_restore(
    previous: Option<String>,
    pending: Option<String>,
    eligible: bool,
) -> Option<String> {
    match pending {
        None => previous,
        Some(p) if eligible && previous.is_none() => {
            tracing::info!(
                "[clip] paste: adopting the restore still pending from the previous paste ({} bytes)",
                p.len()
            );
            Some(p)
        }
        Some(p) => {
            tracing::info!(
                "[clip] a pending restore ({} bytes) was superseded by this write",
                p.len()
            );
            previous
        }
    }
}

/// Re-schedules a pending restore this paste took but never got to supersede (it bailed before
/// writing, on any path including `?`). Emptied (`.0.take()`) once the write happened.
pub(crate) struct RequeueRestore(pub(crate) Option<String>);

impl Drop for RequeueRestore {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            restore_clipboard_later(Some(p));
        }
    }
}

/// True on a native Wayland session (where enigo's X11 text path can't type
/// Unicode into native windows — direct typing routes through the virtual keyboard or the portal
/// instead).
pub fn is_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Strip C0/C1 control characters (except Tab and LF) from text bound for injection, so a
/// malicious / compromised / garbled transcription server can't smuggle terminal-escape or
/// other control sequences onto the clipboard or into a typed paste. Tab and newline are kept
/// (legitimate keystrokes); CR is first normalized to LF. Applies to every path; the Wayland
/// typing backends also drop controls themselves.
pub fn sanitize_injected(text: &str) -> String {
    // Collapse CRLF and a lone CR to LF so every path sees one '\n' per line break: the Wayland
    // typing paths map both '\r' and '\n' to an Enter keypress (`wayland`'s KeySpec, the virtual
    // keyboard), so a server's CRLF would otherwise type TWO Enters per break. The enigo path types
    // each LF as a Return key (`typing_segments`), and the clipboard paths turn it back into CRLF on
    // Windows (`clipboard_newlines`).
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| (!c.is_control() || c == '\t' || c == '\n') && !is_deceptive_format_char(c))
        .collect()
}

/// Unicode FORMAT characters (category Cf) that change how text READS without being visible.
///
/// `char::is_control()` is category Cc only and misses them. The transcript is server-authored and
/// gets typed or pasted into whatever has focus, so e.g. a right-to-left override lets the server
/// make the text that lands differ from the text the user watched appear — Trojan Source, via
/// dictation. The portal keycode path drops these anyway (they are not in the layout charmap).
///
/// Kept deliberately NARROW. Every entry below is invisible when rendered and has no legitimate
/// producer in dictation output. Category alone is the wrong test: plenty of Cf characters are
/// genuinely printable — U+0600–U+0605 span the digits that follow them, U+06DD and U+08E2 draw
/// the decorative circle around a verse number, U+070F overlines a Syriac abbreviation, and
/// U+0890–U+0891 are visible currency marks. Filtering those would silently corrupt real Arabic
/// and Syriac transcripts, which is worse than the attack. Do not "complete the category".
pub fn is_deceptive_format_char(c: char) -> bool {
    matches!(c,
        '\u{00ad}'                      // SOFT HYPHEN — invisible, splits a word for search/diff
        | '\u{061c}'                    // ARABIC LETTER MARK — bidi control, sibling of LRM/RLM
        | '\u{115f}' | '\u{1160}'       // HANGUL CHOSEONG/JUNGSEONG FILLER — zero-width, and
        | '\u{3164}' | '\u{ffa0}'       // HANGUL FILLER — category Lo, so no category rule catches these
        | '\u{180e}'                    // MONGOLIAN VOWEL SEPARATOR
        | '\u{200b}' | '\u{200e}' | '\u{200f}'
        // U+200C ZWNJ and U+200D ZWJ are NOT stripped: ZWNJ is orthographically
        // required in Persian/Urdu, and ZWJ selects conjunct forms in Indic scripts
        // and joins emoji sequences — stripping them corrupts real transcripts.
        | '\u{2028}' | '\u{2029}'       // LINE/PARAGRAPH SEPARATOR — Zl/Zp, so is_control() misses
                                        // them, yet both are UAX#14 mandatory breaks: a hard line
                                        // break in a label, and a real Enter on the typing paths
        | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}'       // word joiner + invisible times/separator/plus
        | '\u{2066}'..='\u{2069}'
        | '\u{206a}'..='\u{206f}'       // deprecated Cf controls (symmetric swapping, Arabic
                                        // shaping, digit shapes) — no renderer draws these
        | '\u{feff}'
        | '\u{fff9}'..='\u{fffb}'       // interlinear annotation — hides text between the anchors
        | '\u{1bca0}'..='\u{1bca3}'     // Duployan shorthand format controls
        | '\u{1d173}'..='\u{1d17a}'     // musical beam/slur/phrase controls — invisible
        | '\u{e0000}'..='\u{e007f}') // TAG block — the standard invisible-payload range
}

/// How much text one `enigo.text` call may carry. That call hands its whole string to the OS in
/// one blocking call, so the chunk boundaries are this backend's only cancellation points (the
/// Wayland backends check between keys). Chunks are typed back to back on char boundaries, so what
/// is typed does not change. Small enough that a cancel is noticed quickly, large enough that a
/// normal phrase is still a single call.
const DIRECT_CHUNK_CHARS: usize = 512;

/// What a keystroke sink's job actually did (X11/Windows, the virtual keyboard, the Wayland portal).
/// `Ok(())` alone could not tell "typed it" from "abandoned it because one of our own windows took
/// focus", and the caller has to know: the first advances the typed baseline, the second must be
/// re-sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Landed {
    /// Keystrokes were synthesized — or the job was a deliberate no-op (empty text, or a cancel bail,
    /// which reports `landed: true` because the caller discards the phrase itself).
    Yes,
    /// Nothing was written and nothing sits on the clipboard. The caller re-sends.
    NothingWritten,
    /// The transcript IS on the clipboard but the paste chord was never pressed.
    OnClipboard,
}

/// Is one of our own windows focused right now?
///
/// Passed in as a closure rather than an `AppHandle` so this module stays Tauri-free. Safe to call
/// from the blocking pool: Tauri's `is_focused` posts to the event loop and waits on a channel
/// (`send_user_message` branches on the thread id), so the toolkit call always runs on the main
/// thread no matter who asks.
pub type OwnWindowFocused<'a> = &'a (dyn Fn() -> bool + Sync);

/// What a keystroke sink may do next (see [`sink_gate`]).
#[derive(Debug, PartialEq)]
pub(crate) enum SinkGate {
    Proceed,
    OwnWindow,
    Cancelled,
}

/// Run the own-window probe FIRST and read the cancel AFTER it. The probe is a main-thread round
/// trip, so a cancel read before it misses one that lands during it, and the paste chord and
/// auto-Enter have no later check. A cancel wins over the own window: the job is dropped
/// (`Landed::Yes`), not diverted. Shared by `inject`/`paste` here and the Wayland portal sinks.
pub(crate) fn sink_gate(
    own_window: impl FnOnce() -> bool,
    cancelled: impl FnOnce() -> bool,
) -> SinkGate {
    let own = own_window();
    if cancelled() {
        SinkGate::Cancelled
    } else if own {
        SinkGate::OwnWindow
    } else {
        SinkGate::Proceed
    }
}

/// The per-step gate of a typing loop (the `direct` segments here, the Wayland portal characters):
/// [`sink_gate`] (probe first, cancel after) on a step that probes focus — including the one before
/// a line break's Return — and the cancel alone on one that does not.
pub(crate) fn typing_gate(
    probe: bool,
    own_window: impl FnOnce() -> bool,
    cancelled: impl FnOnce() -> bool,
) -> SinkGate {
    if probe {
        sink_gate(own_window, cancelled)
    } else if cancelled() {
        SinkGate::Cancelled
    } else {
        SinkGate::Proceed
    }
}

#[allow(clippy::too_many_arguments)]
pub fn inject(
    text: &str,
    // The clipboard form of `text` (`inject_text`'s `clipboard_text`, already resolved: equal to
    // `text` when the caller sent none). The paste writes `text` — it goes INTO the field — but a
    // transcript left on the clipboard for the user (the chord-time divert, a failed paste) is
    // this one.
    clip_text: &str,
    method: &str,
    auto_enter: bool,
    restore_clipboard: bool,
    paste_shortcut: &[String],
    remote_target: bool,
    // The generation captured when this job was queued; see `injection_cancelled`.
    epoch: u64,
    // Re-asked at the sinks below — see `OwnWindowFocused`. `inject_text`'s own-window guard runs
    // before `spawn_blocking`, and everything in this function happens after it.
    own_window_focused: OwnWindowFocused<'_>,
    // `inject_text`'s `withhold_on_divert`: the paste never leaves `text` on the clipboard for the
    // user — see `paste`.
    withhold_on_divert: bool,
) -> Result<Landed, String> {
    if text.is_empty() && !auto_enter {
        return Ok(Landed::Yes);
    }
    // Before anything is typed, matching the Wayland backends' pre-job check: a cancel that lands
    // between queueing and execution must not still fire a paste or a bare auto-Enter.
    if injection_cancelled(epoch) {
        tracing::info!("[inject] cancelled before typing — dropping the job");
        return Ok(Landed::Yes);
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    if !text.is_empty() {
        match method {
            "direct" => {
                // The caller's own-window guard ran before `spawn_blocking`; `Enigo::new` and the
                // dispatch sit between it and the first keystroke. Without this, a click into our
                // own settings field mid-injection types the transcript into it.
                if own_window_focused() {
                    tracing::info!(
                        "[inject] skipped at the typing sink: our own window took focus"
                    );
                    return Ok(Landed::NothingWritten);
                }
                // Text runs go out via `enigo.text`, line breaks and tabs as real key clicks —
                // see `typing_segments` for why a '\n' character is not an Enter.
                for (i, seg) in typing_segments(text, DIRECT_CHUNK_CHARS)
                    .into_iter()
                    .enumerate()
                {
                    // The cancel is read before EVERY segment (at i == 0 it covers the gap across
                    // `Enigo::new` and the probe above) and, on a probed segment, AFTER the probe
                    // (`typing_gate`), so a cancel landing during its main-thread round trip does
                    // not still type this segment, a line break's Return included.
                    //
                    // Focus is re-asked per segment: a 512-char chunk is tens of milliseconds of
                    // typing, so a click into our own window part-way through otherwise lands
                    // every remaining chunk in its field.
                    //
                    // `Yes`, NOT `NothingWritten`, on both stops — earlier segments really landed,
                    // and a re-send would duplicate them. The untyped tail is dropped.
                    //
                    // Each probe is an event-loop round trip (~0.1ms), but it makes typing stall
                    // if the UI thread stalls — accepted, as for the entry and sink guards.
                    match typing_gate(i > 0, own_window_focused, || injection_cancelled(epoch)) {
                        SinkGate::Cancelled => {
                            tracing::info!("[inject] cancelled mid-typing — stopping");
                            return Ok(Landed::Yes);
                        }
                        SinkGate::OwnWindow => {
                            tracing::info!(
                                "[inject] stopped mid-typing: our own window took focus"
                            );
                            return Ok(Landed::Yes);
                        }
                        SinkGate::Proceed => {}
                    }
                    match seg {
                        TypeSeg::Text(chunk) => enigo.text(chunk),
                        TypeSeg::Enter => enigo.key(Key::Return, Direction::Click),
                        TypeSeg::Tab => enigo.key(Key::Tab, Direction::Click),
                    }
                    .map_err(|e| e.to_string())?;
                }
            }
            _ => {
                match paste(
                    &mut enigo,
                    text,
                    clip_text,
                    restore_clipboard,
                    paste_shortcut,
                    remote_target,
                    epoch,
                    own_window_focused,
                    withhold_on_divert,
                )? {
                    // Nothing was pressed, so the auto-Enter below must not fire either — it would
                    // submit whatever the focused field already holds.
                    l @ (Landed::NothingWritten | Landed::OnClipboard) => return Ok(l),
                    Landed::Yes => {}
                }
            }
        }
    }

    if auto_enter {
        // The probes above all sit inside `if !text.is_empty()`, so a BARE auto-Enter job (the
        // per-phrase and tail Enter `streaming.ts` sends on both methods) gets its guard here. The
        // cancel is read AFTER the probe (`sink_gate`): a cancel during the typing above, or during
        // the probe's main-thread round trip, must not still submit what landed.
        match sink_gate(own_window_focused, || injection_cancelled(epoch)) {
            SinkGate::Cancelled => {}
            SinkGate::OwnWindow => {
                tracing::info!("[inject] skipped the auto-Enter: our own window took focus");
                // `NothingWritten` ONLY when this job was just the Enter. If text landed above,
                // saying "nothing written" makes the caller re-send it as duplicate text.
                return Ok(if text.is_empty() {
                    Landed::NothingWritten
                } else {
                    Landed::Yes
                });
            }
            SinkGate::Proceed => enigo
                .key(Key::Return, Direction::Click)
                .map_err(|e| e.to_string())?,
        }
    }
    Ok(Landed::Yes)
}

/// Read the focus-independent PRIMARY selection (the Linux "highlight to select" buffer) as
/// plain text, or `None` if it's empty / unavailable. Seeds Quick-Add from whatever the user
/// has highlighted in the SOURCE app: PRIMARY is separate from the normal copy/paste clipboard
/// and isn't tied to window focus, so it still reads the source app's highlight after OUR
/// window has taken focus. BLOCKING (a Wayland round-trip to the selection's owner) — always
/// call from a time-bounded `spawn_blocking`, never on the UI thread (same freeze hazard as
/// `begin_injection`'s clipboard read).
#[cfg_attr(windows, allow(dead_code))] // PRIMARY is a Linux concept; Windows seeds via win_seed
pub fn read_primary_selection() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        use arboard::{Clipboard, GetExtLinux, LinuxClipboardKind};
        let mut cb = Clipboard::new().ok()?;
        cb.get().clipboard(LinuxClipboardKind::Primary).text().ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Put `text` on the clipboard for the Wayland paste path, which then synthesizes Ctrl+V via the
/// portal. The prior clipboard is read separately and TIME-BOUNDED by the caller
/// (`read_selection_bounded` in commands/mod.rs) — an unbounded read wedges on a dead owner.
///
/// The write always goes through the live owner (`persist_transcript`), so it sticks: arboard's
/// X11 backend — which is also what a Wayland session WITHOUT the data-control protocol (GNOME)
/// runs on, through XWayland — tears the selection down when the `Clipboard` drops with no
/// clipboard manager running, and CLEARS it on that drop with clipboard privacy on, so a plain set
/// could be gone before the portal's Ctrl+V reads it.
pub fn set_clipboard(text: &str) -> Result<(), String> {
    persist_transcript(text)
}

/// The plain (non-owner) transcript write, shared by `paste` and the Windows
/// legacy remote write: CRLF on Windows, the user's history/cloud setting, and `note_injected`
/// once the write succeeded, so a later capture does not adopt this transcript as the user's
/// clipboard (`is_own_injected`).
fn write_transcript(cb: &mut arboard::Clipboard, text: &str) -> Result<(), arboard::Error> {
    set_text_ext(
        cb,
        &clipboard_newlines(text, cfg!(windows)),
        clipboard_privacy(),
        false,
    )?;
    note_injected(text);
    Ok(())
}

/// Hold `text` on the clipboard as a LIVE owner, blocking the calling thread until the
/// selection is replaced. On Wayland a selection only persists while its source app stays
/// alive to serve it (arboard's `set().wait()`) — a plain `set_text` that returns and drops
/// doesn't stick — so this backs BOTH every transcript write that must outlive its call
/// (`persist_transcript`) AND the restore of the user's previous clipboard after a paste. Always
/// run this on a detached thread.
/// `what` names the operation for the failure log. Failures MUST be visible: a silently failed
/// RESTORE leaves our transcript on the clipboard (`is_own_injected` keeps later captures from
/// adopting it as the user's content, but the failure still has to show in the log).
///
/// `exclude` = carry the history/cloud hints (see `set_text_ext`). Transcript writes pass the
/// user's setting; RESTORES always pass true — a restored snapshot has lost whatever flags its
/// source set (a password manager marks its copies), so re-publishing it to the history would leak
/// exactly what the source had kept out.
///
/// `report`, when present, receives the outcome AS SOON AS IT IS KNOWABLE and before this
/// function blocks — see `set_clipboard_persistent` for why that split exists and what it can and
/// cannot answer. Success is `Ok(true)` (written); `Ok(false)` is `persist_transcript_unless`'s
/// cancelled skip, which never reaches this function.
fn serve_clipboard_blocking(
    text: String,
    what: &str,
    exclude: bool,
    report: Option<std::sync::mpsc::SyncSender<Result<bool, String>>>,
) {
    let tell = |r: Result<(), String>| {
        if let Some(tx) = report.as_ref() {
            // The caller may already have timed out and dropped the receiver; that is a normal
            // outcome, not an error — it means it decided to believe the optimistic answer.
            let _ = tx.send(r.map(|()| true));
        }
    };
    #[cfg(target_os = "linux")]
    {
        match arboard::Clipboard::new() {
            Ok(mut cb) => {
                // Report BEFORE the wait, not after: `set().wait()` does not return until another
                // app takes the selection, which may be never. Connecting to the clipboard is the
                // whole answer that can be given synchronously on this platform, and it is the one
                // that matters — it is what fails when the session has no clipboard at all.
                tell(Ok(()));
                if let Err(e) = set_text_ext(&mut cb, &text, exclude, true) {
                    // The residual this design cannot answer synchronously. The caller has already
                    // been told Ok, so this stays a log line — see `set_clipboard_persistent`.
                    tracing::warn!("[clip] {what} failed after the handshake: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("[clip] {what}: clipboard unavailable: {e}");
                tell(Err(e.to_string()));
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        match arboard::Clipboard::new() {
            Ok(mut cb) => {
                // No `wait()` off Linux: `set_text` completes, so the FULL outcome is knowable
                // here and the residual above does not exist on this platform.
                let r = set_text_ext(&mut cb, &text, exclude, false).map_err(|e| e.to_string());
                if let Err(ref e) = r {
                    tracing::warn!("[clip] {what} failed: {e}");
                }
                tell(r);
            }
            Err(e) => {
                tracing::warn!("[clip] {what}: clipboard unavailable: {e}");
                tell(Err(e.to_string()));
            }
        }
    }
}

/// Put `text` on the clipboard and KEEP it there for the user to paste later. Used by the
/// clipboard-only insert method, the divert and recovery arms of `inject_text` and the Wayland
/// typer, and `recover_to_clipboard`, where (unlike paste) nothing consumes the clipboard
/// immediately, so it must persist via a live owner — and by the Wayland paste arm's remote-target
/// write, whose fetch is deferred the same way.
/// Returns whether the text actually reached the clipboard, as far as that is knowable.
///
/// The answer matters on the DIVERT path: `streaming.ts` treats a landed divert as delivered —
/// the phrase leaves the re-send stream, no restore is owed, the "on the clipboard" glyph pulses —
/// so a constant success would drop the phrase for good on a machine whose clipboard does not
/// work. It comes from the serving thread, through a `sync_channel(1)`, at the first point the
/// outcome is knowable: after `Clipboard::new()`, before the blocking `set().wait()`.
///
/// **Ambiguity fails OPEN — deliberately.** A timeout or a dead channel returns `Ok`: a wrong
/// `false` makes the caller RE-TYPE text the user already has, which is worse than a wrong `true`
/// at every current call site, since none of them has transmitted a keystroke. A slow-but-working
/// compositor must not be misreported.
///
/// **What it does not cover:** on Linux, `set().wait()` failing after the handshake — the call
/// does not return until another app takes the selection, so it stays a log line. The dominant
/// real failure is having no clipboard connection at all.
///
/// This is a NEW clipboard write, so it supersedes a restore still waiting out its delay (see
/// `RestoreSlot`): that restore would otherwise land on top of the text this call promises stays.
pub fn set_clipboard_persistent(text: &str) -> Result<(), String> {
    set_clipboard_persistent_unless(text, || false).map(|_| ())
}

/// `set_clipboard_persistent` for a transcript write its caller gates on a cancel: `cancelled` is
/// asked again after the serving thread's stuck-read wait (see `persist_transcript_unless`).
/// `Ok(false)` = cancelled during that wait: nothing written, and the pending restore this took is
/// booked again, since no new write superseded it.
pub fn set_clipboard_persistent_unless(
    text: &str,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<bool, String> {
    let pending = take_pending_restore();
    let r = persist_transcript_unless(text, cancelled);
    if matches!(r, Ok(false)) {
        restore_clipboard_later(pending);
    } else {
        let _ = merge_pending_restore(None, pending, false);
    }
    r
}

/// The body of `set_clipboard_persistent`, minus the pending-restore take — for `paste` and the
/// Wayland paste (through `set_clipboard`), which have already taken (and possibly adopted) it.
///
/// `note_injected` gets the LF text (`is_own_injected` normalizes); the clipboard gets CRLF on
/// Windows (`clipboard_newlines`). The serving thread first waits out a stuck clipboard read
/// (`wait_clip_read_idle`) and reports Err if it never finishes, so the caller's recv bound is
/// raised by that wait on Windows (the only platform where it waits).
///
/// `note_injected` runs before the write, so a fast capture cannot miss it; an Err takes it back
/// (`unnote_injected`), since an Err only ever comes back when nothing was served. A timeout keeps
/// it — the write may still land.
fn persist_transcript(text: &str) -> Result<(), String> {
    persist_transcript_unless(text, || false).map(|_| ())
}

/// `persist_transcript`, re-asking `cancelled` after the serving thread's stuck-read wait (up to
/// `CLIP_IDLE_WAIT` on Windows): the callers ask about a cancel only before this call, so a cancel
/// landing during the wait would still install the discarded transcript — and when the stuck read
/// is the session's snapshot read, nothing restores the user's clipboard after it (`paste` has the
/// same check, `idle_wait_gate`). `Ok(false)` = cancelled, nothing written, the note taken back.
fn persist_transcript_unless(
    text: &str,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<bool, String> {
    let prev_note = note_injected(text);
    let noted = text;
    let text = clipboard_newlines(text, cfg!(windows)).into_owned();
    let exclude = clipboard_privacy();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<bool, String>>(1);
    std::thread::spawn(move || {
        serve_transcript(
            || wait_clip_read_idle(CLIP_IDLE_WAIT),
            cancelled,
            |tx| serve_clipboard_blocking(text, "transcript write", exclude, Some(tx)),
            tx,
        )
    });
    // Normally sub-millisecond: this waits for a local connect, not for a paste. The bound exists
    // so a wedged compositor cannot park an injection, and it is long enough that a slow one still
    // gets to answer for itself rather than being assumed fine (a timeout fails open — see
    // `set_clipboard_persistent`).
    let bound = if cfg!(windows) {
        CLIP_IDLE_WAIT + Duration::from_millis(250)
    } else {
        Duration::from_millis(200)
    };
    match rx.recv_timeout(bound) {
        Ok(Err(e)) => {
            unnote_injected(&LAST_INJECTED, prev_note, noted);
            Err(e)
        }
        Ok(Ok(false)) => {
            unnote_injected(&LAST_INJECTED, prev_note, noted);
            Ok(false)
        }
        Ok(Ok(true)) => Ok(true),
        Err(_) => Ok(true),
    }
}

/// `persist_transcript_unless`'s serving-thread body, with the wait and the write passed in.
fn serve_transcript(
    wait: impl FnOnce() -> bool,
    cancelled: impl Fn() -> bool,
    write: impl FnOnce(std::sync::mpsc::SyncSender<Result<bool, String>>),
    tx: std::sync::mpsc::SyncSender<Result<bool, String>>,
) {
    match after_idle_wait(wait, cancelled) {
        AfterIdleWait::Write => write(tx),
        AfterIdleWait::Cancelled => {
            tracing::info!(
                "[clip] transcript write: cancelled while waiting out a stuck clipboard read — skipping"
            );
            let _ = tx.send(Ok(false));
        }
        AfterIdleWait::Stuck => {
            let _ = tx.send(Err("a clipboard read is still stuck".to_string()));
        }
    }
}

/// Restore clipboard text the caller captured before the paste, after a short delay so the paste
/// has consumed the clipboard first. Restores via a LIVE owner (not a plain set_text) so the
/// restored value actually persists on Wayland.
///
/// Scheduled through `RestoreSlot`: a newer clipboard write inside the 400ms takes it over (a
/// local paste adopts it, anything else drops it), and the timer then finds itself superseded.
pub fn restore_clipboard_later(prev: Option<String>) {
    let Some(prev) = prev else { return };
    let Ok(gen) = RESTORE.lock().map(|mut s| s.schedule(prev)) else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        // A read still stuck on the clipboard would fight this write (and on Windows block it).
        // Skipping loses only the restore; the transcript stays, which is the documented fallback.
        // Waited out BEFORE the slot is claimed: the slot stays cancellable during the wait, so a
        // paste that starts meanwhile takes (and adopts) it instead of racing this write inside
        // its own settle.
        if !wait_clip_read_idle(CLIP_IDLE_WAIT) {
            // Drop the entry only if it is still ours — a newer schedule must keep its own.
            let _ = RESTORE.lock().ok().and_then(|mut s| s.take_if_current(gen));
            tracing::warn!("[clip] restore skipped: a clipboard read is still stuck");
            return;
        }
        let Some(prev) = RESTORE.lock().ok().and_then(|mut s| s.take_if_current(gen)) else {
            tracing::info!(
                "[clip] restore superseded by a newer clipboard write or restore — skipped"
            );
            return;
        };
        // No report channel: nothing user-facing rests on a restore succeeding, and this already
        // runs detached behind a 400ms sleep. Always excluded from history/cloud — see
        // `serve_clipboard_blocking`.
        serve_clipboard_blocking(prev, "clipboard restore", true, None);
    });
}

/// The Windows remote-target write: the delayed-rendering owner (`windows_clipboard`) unless the mode is
/// `legacy` or the owner is unavailable, in which case the plain synchronous write. Ok carries the
/// offer id when the owner took it (None for the legacy write); Err is the `Landed` to report —
/// always `NothingWritten`, because no chord has been pressed and the caller's re-send is safe.
#[cfg(windows)]
fn write_remote_windows(text: &str) -> Result<Option<u64>, Landed> {
    use crate::inject::windows_clipboard::{self, Mode, OfferError};
    let exclude = clipboard_privacy();
    let legacy = || -> Result<Option<u64>, Landed> {
        match arboard::Clipboard::new().and_then(|mut cb| write_transcript(&mut cb, text)) {
            Ok(()) => Ok(None),
            Err(e) => {
                tracing::warn!(
                    "[clip] paste: remote write failed — nothing written, the caller re-sends: {e}"
                );
                Err(Landed::NothingWritten)
            }
        }
    };
    if windows_clipboard::mode() == Mode::Legacy {
        return legacy();
    }
    match windows_clipboard::offer(text, exclude) {
        Ok(id) => {
            note_injected(text);
            Ok(Some(id))
        }
        Err(OfferError::Unavailable) => legacy(),
        Err(e) => {
            // A timed-out offer may still land behind our back (the owner drops only commands it
            // had not started). Remembering the text as ours costs nothing if it did not, and keeps
            // the next snapshot from adopting it as the user's clipboard if it did.
            if e == OfferError::Timeout {
                note_injected(text);
            }
            tracing::warn!(
                "[clip] paste: clipboard owner {e:?} — nothing written, the caller re-sends"
            );
            Err(Landed::NothingWritten)
        }
    }
}

/// Whether a paste writes the transcript through the live owner (`persist_transcript`) rather than
/// a function-local `Clipboard` — for `paste` (X11/Windows/macOS; the Wayland portal paste always
/// does, through `set_clipboard`). A remote target always needs a write that outlives the call (its
/// fetch is deferred — see the comment at `paste`'s write, which routes it before asking, through
/// `windows_clipboard` on Windows). So does every local paste on Linux: the target
/// reads the selection asynchronously, after the synthesized chord and possibly after the writer
/// has returned and dropped its `Clipboard`. arboard's X11 drop of the last instance hands
/// the data to a clipboard manager if one runs and otherwise destroys the selection — and with
/// clipboard privacy on, the history hint turns that drop into a CLEAR (see `set_text_ext`). So a
/// plain write could leave a slow target pasting nothing while the paste reports `Landed::Yes`.
/// Windows and macOS keep the synchronous write: their clipboard outlives the handle.
fn paste_write_via_live_owner(remote_target: bool, linux: bool) -> bool {
    remote_target || linux
}

/// What the chord-time own-window divert in `paste` still writes: `None` when the paste write
/// already IS the divert, else `Some(fatal)` to write the clipboard form over it, where `fatal`
/// means that write failing leaves nothing on the clipboard. The paste write is durable when it
/// went through the live owner (`persisted`) or off Linux, where the plain write outlives its
/// `Clipboard` (see `paste_write_via_live_owner`); only a durable write survives the re-write
/// failing, and only a differing form (`same_form` false) needs the re-write at all.
fn divert_rewrite(persisted: bool, linux: bool, same_form: bool) -> Option<bool> {
    let durable = persisted || !linux;
    (!durable || !same_form).then_some(!durable)
}

/// What `paste` does with the clipboard once the chord went out: a pasted (or withheld) insert
/// books the restore of the user's prior clipboard; a failed one leaves the transcript there to
/// paste by hand, under the chord-time divert's rule (`divert_rewrite`) — so a durable write of
/// the same form is kept as it is, never re-written into a second Win+V history entry.
#[derive(Debug, PartialEq)]
enum AfterChord {
    Restore,
    /// Write the clipboard form; `fatal` as in `divert_rewrite`.
    Rewrite(bool),
    Keep,
}

fn after_chord(restore: bool, persisted: bool, linux: bool, same_form: bool) -> AfterChord {
    if restore {
        return AfterChord::Restore;
    }
    divert_rewrite(persisted, linux, same_form).map_or(AfterChord::Keep, AfterChord::Rewrite)
}

#[allow(clippy::too_many_arguments)]
fn paste(
    enigo: &mut Enigo,
    text: &str,
    // See `inject`: what a divert or a failed paste leaves on the clipboard.
    clip_text: &str,
    restore_clipboard: bool,
    chord: &[String],
    remote_target: bool,
    // See `injection_cancelled`. The pre-job check in `inject` runs before `Enigo::new`, and this
    // function then waits on the clipboard-job lock and does an un-timed blocking `get_text()`
    // before its write, and a settle sleep before its chord, so it checks again at each.
    epoch: u64,
    own_window_focused: OwnWindowFocused<'_>,
    // Nothing here is worth leaving on the clipboard (the hard-break separator, a whitespace-only
    // live phrase): every arm that would keep the pasted text there for the user — the chord-time
    // divert, a failed paste, an error abort's cancel — schedules the restore a pasted one gets
    // instead, never a persistent owner.
    withhold_on_divert: bool,
) -> Result<Landed, String> {
    use arboard::Clipboard;
    // The clipboard-job lock (see `CLIP_JOB`), held until this function returns — across the
    // write, the settle and the chord. A Windows quick-add copy grab in flight would otherwise put
    // the user's old clipboard back between our write and our Ctrl+V. Waited out for the grab's
    // whole bound (`CLIP_JOB_WAIT`), or until the user cancels this job; an error abort waits, so
    // its clipboard recovery cannot land mid-grab (it then hits the cancel check below, writes
    // nothing, and the lock is free again before `inject_text` recovers). A withheld insert stops
    // on any cancel, error abort included, as the cancel check below does: it has nothing to
    // recover. Only a holder (a grab or a stuck snapshot read) still there after that bails.
    // Nothing has been read or written yet, so `NothingWritten` is truthful and the caller's
    // re-send cannot duplicate text.
    let Some(_clip_job) =
        wait_clip_job(CLIP_JOB_WAIT, || cancel_discards(epoch, withhold_on_divert))
    else {
        if injection_cancelled(epoch) {
            // Answered as the cancel check below answers (see there). An error abort only gets
            // here once the whole wait ran out (unless withheld), so its line names the wait and
            // the recovery.
            if !cancel_discards(epoch, withhold_on_divert) {
                tracing::info!(
                    "[clip] paste: error abort — the clipboard-job lock (a quick-add copy grab or \
                     a stuck snapshot read) was still held after {}s; nothing written, the \
                     transcript is recovered",
                    CLIP_JOB_WAIT.as_secs()
                );
            } else {
                tracing::info!(
                    "[clip] paste: cancelled while waiting for the clipboard-job lock — skipping"
                );
            }
            return Ok(Landed::Yes);
        }
        tracing::info!(
            "[clip] paste: the clipboard-job lock (a quick-add copy grab or a stuck snapshot \
             read) is still held after {}s — nothing written",
            CLIP_JOB_WAIT.as_secs()
        );
        return Ok(Landed::NothingWritten);
    };
    // A restore the PREVIOUS paste scheduled and that is still waiting out its 400ms. Taken first,
    // so it cannot fire in the middle of this paste (between our write and our chord it would
    // make the target paste the user's old clipboard). If this paste bails before it writes — on
    // any path, `?` included — the guard re-schedules it; once the write happened it is adopted or
    // dropped below.
    let mut requeue = RequeueRestore(take_pending_restore());
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    // Never capture (→ never restore) for a remote-desktop target: its clipboard sync is
    // asynchronous, and with RDP delayed rendering the RESTORED value can be what the remote's
    // paste actually fetches — no fixed delay makes that safe, so skipping the restore is the
    // only airtight option. The transcript stays on the clipboard instead.
    let previous = if restore_clipboard && !remote_target {
        if clip_read_busy() {
            // The un-timed read below would queue behind the stuck one (on Windows, spin on
            // `OpenClipboard`) with no bound at all. Skipping it costs only this paste's restore.
            tracing::info!(
                "[clip] paste: a clipboard read is still stuck — skipping the prior read (no restore)"
            );
            None
        } else {
            // Neither our own last transcript nor an empty read is the user's clipboard — see
            // `worth_restoring`.
            read_prior_text(&mut clipboard).filter(|p| worth_restoring(p))
        }
    } else {
        None
    };
    // A cancel that landed during `inject`'s `Enigo::new` / the clipboard-job wait /
    // `Clipboard::new` / the un-timed `get_text()` above must not still clobber the user's
    // clipboard with the transcript they discarded. Bailing here is clean: nothing has been written
    // yet and `previous` was only read, never replaced. The caller (`inject`) returns
    // `Ok(Landed::Yes)` into `inject_text`'s `res`, so the error-abort recovery block at the end of
    // that function still runs and a died session keeps its text.
    if injection_cancelled(epoch) {
        tracing::info!("[clip] paste: cancelled before the clipboard write — skipping");
        return Ok(Landed::Yes);
    }
    // Own-window check at the clipboard WRITE: between `inject_text`'s guard and here sit
    // `Enigo::new`, the clipboard-job wait and the un-timed read above — the longest guard-to-sink
    // gap on any injection path — and a click into one of our own windows during them would
    // clobber the user's clipboard and then paste into our own field.
    // `NothingWritten`: `previous` was only READ, so the caller re-sends and no text is duplicated.
    if own_window_focused() {
        tracing::info!("[clip] paste: skipped at the clipboard write — our own window took focus");
        return Ok(Landed::NothingWritten);
    }
    // A clipboard read that outlived its cap still holds the clipboard (Windows). Writing now
    // would fail or race it; nothing is written yet, so reporting that is safe — the caller
    // re-sends, and no chord has been pressed. The wait can last up to a second, so the cancel
    // check above is asked again after it — see `idle_wait_gate`.
    if let Some(landed) = idle_wait_gate(
        || wait_clip_read_idle(CLIP_IDLE_WAIT),
        || injection_cancelled(epoch),
    ) {
        return Ok(landed);
    }
    // A remote target's clipboard fetch is DEFERRED until the remote app pastes — after this
    // function returns and drops `clipboard` — so its write must outlive the call, or the remote
    // pastes nothing and the "transcript stays on the clipboard" fallback above is false (see
    // `paste_write_via_live_owner`). On Windows that write is the delayed-rendering owner
    // (`windows_clipboard`), which makes the remote's fetch observable — and, in enforce mode,
    // orderable.
    #[cfg(windows)]
    let mut offer_id: Option<u64> = None;
    // Did the write go through an owner that outlives this function? Read by the divert/failure
    // arms (`divert_rewrite`, `after_chord`).
    let persisted = if remote_target {
        #[cfg(windows)]
        {
            match write_remote_windows(text) {
                Ok(id) => offer_id = id,
                Err(landed) => return Ok(landed),
            }
        }
        #[cfg(not(windows))]
        {
            persist_transcript(text)?;
        }
        true
    } else if paste_write_via_live_owner(remote_target, cfg!(target_os = "linux")) {
        persist_transcript(text)?;
        true
    } else {
        write_transcript(&mut clipboard, text).map_err(|e| e.to_string())?;
        false
    };
    // The transcript is on the clipboard now, so this is where the paste went — see
    // LAST_PASTE_REMOTE. Recorded here, at the write, because only this function knows where the
    // write happened: every return above wrote nothing and leaves the previous paste's target, and
    // a cancel landing after this line (the settle, the chord) cannot un-write it.
    note_paste_target(remote_target);
    // Written: the pending restore is now either this paste's own "previous" or superseded.
    let previous = merge_pending_restore(previous, requeue.0.take(), !remote_target);
    // Let the new clipboard owner settle before pasting. A remote-desktop client additionally
    // needs the new content to cross the network (format-list announcement) before the forwarded
    // Ctrl+V lands, or the remote pastes its previously-synced clipboard — give it a longer window
    // (`FWF_RDP_SETTLE_MS` on Windows, so the race can be measured; see `windows_clipboard`).
    let settle_ms = if remote_target {
        #[cfg(windows)]
        {
            crate::inject::windows_clipboard::settle_ms()
        }
        #[cfg(not(windows))]
        {
            300
        }
    } else {
        60
    };
    std::thread::sleep(Duration::from_millis(settle_ms));
    // Second check, at the sink. The one above guards the clipboard WRITE; this one guards the
    // KEYSTROKE, and the settle between them is 60ms (300ms remote) of wall clock during which
    // `cancel_stream`/`cancel_record` run un-chained on another blocking thread.
    //
    // It bails differently from the check above, and must: the transcript is already ON the
    // clipboard here, so the choice is who owns it afterwards. A USER cancel means "I don't want
    // this", so the user's prior clipboard goes back. An ERROR abort deliberately leaves the
    // transcript, because `inject_text`'s recovery block is what makes a died session's text
    // recoverable — scheduling a restore here would erase it 400ms later.
    if injection_cancelled(epoch) {
        tracing::info!("[clip] paste: cancelled during the settle — not pasting");
        // A withheld insert has nothing for that recovery to keep (`inject_text` skips it).
        if cancel_discards(epoch, withhold_on_divert) {
            restore_clipboard_later(previous);
        }
        return Ok(Landed::Yes);
    }
    // And again before the chord. The transcript is on the clipboard by now, so the honest answer
    // is a DIVERT, not "nothing written" — and the restore is skipped deliberately so the text
    // stays pasteable, exactly as the failed-paste arm below does.
    //
    // The probe is an event-loop round trip, so a cancel can land during it — from Cancel in our
    // own window (the probe then answers true), but just as well from the global hotkey, the tray
    // or an error abort, which leave focus in the target app (it answers false, and the chord
    // below has no later check). So the cancel is read AFTER the probe, whatever it answered
    // (`sink_gate`), and bails exactly as the settle check above does.
    let gate = sink_gate(own_window_focused, || injection_cancelled(epoch));
    if gate == SinkGate::Cancelled {
        tracing::info!("[clip] paste: cancelled during the own-window probe — not pasting");
        if cancel_discards(epoch, withhold_on_divert) {
            restore_clipboard_later(previous);
        }
        return Ok(Landed::Yes);
    }
    if gate == SinkGate::OwnWindow {
        tracing::info!("[clip] paste: skipped at the chord — our own window took focus");
        // A withheld insert is not diverted: no persistent owner and no `OnClipboard` (which
        // would arm `DELIVERED_ON_CLIPBOARD`), just the restore a pasted one gets. `Yes`, not
        // `NothingWritten`: the paste write above already replaced the clipboard, and the caller
        // reads `landed` as "the clipboard was clobbered" to give the user's copy back.
        if withhold_on_divert {
            tracing::info!(
                "[clip] paste: separator not pasted (our own window took focus) — withheld"
            );
            restore_clipboard_later(previous);
            return Ok(Landed::Yes);
        }
        // `OnClipboard` must be true when returned: a non-durable write dies with its dropped
        // `Clipboard` on X11 without a clipboard manager, and the caller would advance its
        // baseline past text that is gone — so it is handed to the persistent owner, and if that
        // fails the answer is `NothingWritten` (safe: no chord was pressed, so the re-send cannot
        // duplicate text). A durable paste write (the live owner, or the Windows/macOS plain write
        // that outlives its handle) already IS the divert: a failed re-write still leaves the
        // transcript there, and `NothingWritten` would drop the user's prior clipboard with no
        // restore booked.
        //
        // A clipboard form that differs from the pasted text (a translated block's field gap, a
        // plain phrase's seam space) is written over it even after a durable paste write: the user
        // pastes it now, and the paste write went out before the divert was known. See
        // `divert_rewrite`.
        if let Some(fatal) = divert_rewrite(persisted, cfg!(target_os = "linux"), clip_text == text)
        {
            if let Err(e) = persist_transcript(clip_text) {
                if fatal {
                    tracing::warn!(
                        "[clip] paste: clipboard divert failed, reporting nothing written: {e}"
                    );
                    return Ok(Landed::NothingWritten);
                }
                tracing::warn!(
                    "[clip] paste: the clipboard form could not replace the pasted text: {e}"
                );
            }
        }
        return Ok(Landed::OnClipboard);
    }
    // Tell the clipboard owner the chord is going out — BEFORE pressing it, not after. The remote's
    // fetch can come back within the 30ms `paste_keystroke` sleeps after the key (a LAN round trip
    // is ~1ms), and a fetch the owner sees before it knows about the chord is classified as
    // "before our chord": no re-announce in enforce, and a false NO FETCH warning. The owner
    // thread is idle, so this posted message is handled long before any fetch can arrive. The
    // target is the foreground process now, which is where the keystroke goes.
    #[cfg(windows)]
    if let Some(id) = offer_id {
        crate::inject::windows_clipboard::note_chord(
            id,
            crate::inject::windows_clipboard::foreground_pid(),
        );
    }
    let res = paste_keystroke(enigo, chord);
    // Enforce: wait (bounded) for the target's fetch of THIS offer before returning, so the next
    // phrase's offer is ordered after it. The chord was pressed, so the answer is `Yes` whatever
    // the wait says — re-sending would type the phrase twice.
    #[cfg(windows)]
    if let (Some(id), Ok(())) = (offer_id, &res) {
        use crate::inject::windows_clipboard::{await_target_fetch, mode, FetchWait, Mode};
        if mode() == Mode::Enforce {
            match await_target_fetch(id, Duration::from_millis(1500)) {
                FetchWait::Fetched {
                    after_chord_ms,
                    reannounced,
                } => tracing::info!(
                    "[winclip] #{id}: target fetched {after_chord_ms}ms after the chord (re-announce scheduled={reannounced})"
                ),
                FetchWait::NoFetch => tracing::info!(
                    "[winclip] #{id}: no target fetch seen within 1500ms of the chord — returning anyway"
                ),
            }
        }
    }

    // Restore the user's prior clipboard ONLY when the paste SUCCEEDED. On FAILURE the dictated
    // text deliberately stays on the clipboard for a manual paste — losing the dictation is worse
    // than losing the prior clipboard — matching the Wayland paste path and streaming.ts's
    // end-of-session "on the clipboard to paste manually" message. No-op when restore is off
    // (`previous` is None). A withheld insert restores either way: there is nothing in it to
    // paste manually.
    match after_chord(
        res.is_ok() || withhold_on_divert,
        persisted,
        cfg!(target_os = "linux"),
        clip_text == text,
    ) {
        AfterChord::Restore => restore_clipboard_later(previous),
        AfterChord::Keep => {}
        // Keeps "it's on the clipboard to paste manually" true, in the clipboard form the user now
        // pastes: a non-durable write is handed to the persistent owner (its dropped `Clipboard`
        // destroys the selection without a clipboard manager); after a durable one the clipboard
        // form (a translated block without its field gap, a plain phrase without its seam space)
        // is written over the pasted text, as the chord-time divert arm above does — if only that
        // write fails, the pasted text still sits on the clipboard.
        AfterChord::Rewrite(fatal) => {
            if let Err(e) = persist_transcript(clip_text) {
                if fatal {
                    tracing::warn!(
                        "[clip] paste failed and the clipboard hand-off failed too — the transcript may not stay on the clipboard: {e}"
                    );
                } else {
                    tracing::warn!(
                        "[clip] paste failed: the clipboard form could not replace the pasted text: {e}"
                    );
                }
            }
        }
    }
    res.map(|()| Landed::Yes)
}

const PASTE_MOD: Key = if cfg!(target_os = "macos") {
    Key::Meta
} else {
    Key::Control
};

/// Map a KeyboardEvent.code to an enigo key + whether it's a modifier. "Control" maps to
/// Cmd on macOS so the default paste chord stays correct there.
fn code_to_enigo(code: &str) -> Option<(Key, bool)> {
    Some(match code {
        "ControlLeft" | "ControlRight" => (PASTE_MOD, true),
        "ShiftLeft" | "ShiftRight" => (Key::Shift, true),
        "AltLeft" | "AltRight" => (Key::Alt, true),
        "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => (Key::Meta, true),
        // enigo declares `Key::Insert` only off macOS; there an "Insert" chord falls to `None`
        // and the caller's unmapped-key fallback, so Shift + Insert sends a plain Cmd+V.
        #[cfg(not(target_os = "macos"))]
        "Insert" => (Key::Insert, false),
        c if c.len() == 4 && c.starts_with("Key") => (
            Key::Unicode(c.as_bytes()[3].to_ascii_lowercase() as char),
            false,
        ),
        _ => return None,
    })
}

/// Resolve a paste chord's `KeyboardEvent.code`s to the modifiers to hold and the key to click.
fn paste_chord_keys(chord: &[String]) -> (Vec<Key>, Key) {
    let (mut mods, mut main) = (Vec::new(), None);
    for code in chord {
        if let Some((k, is_mod)) = code_to_enigo(code) {
            if is_mod {
                mods.push(k);
            } else {
                main = Some(k);
            }
        }
    }
    // Fall back to a WHOLE Ctrl/Cmd+V if the chord didn't map to a usable main key. Its
    // modifiers go too: keeping them (Shift + an unmapped Insert) would send Shift+V, typing
    // a literal 'V' while reporting a paste. Same fallback as the Wayland `chord_to_keycodes`.
    let main = match main {
        Some(k) => k,
        None => {
            mods.clear();
            Key::Unicode('v')
        }
    };
    if mods.is_empty() {
        mods.push(PASTE_MOD);
    }
    (mods, main)
}

fn paste_keystroke(enigo: &mut Enigo, chord: &[String]) -> Result<(), String> {
    let (mods, main) = paste_chord_keys(chord);
    // Settle delays: without them a modifier can arrive after the key, so the target
    // sees a literal character instead of a paste (an XTEST timing race).
    //
    // Track how many modifiers we actually pressed so we can release them even when the
    // main-key click (or a later modifier press) fails: enigo synthesizes REAL key events
    // here (X11/Win/macOS), so a Ctrl/Cmd left logically DOWN wedges the whole desktop.
    let mut pressed = 0usize;
    let mut result = Ok(());
    for m in &mods {
        if let Err(e) = enigo.key(*m, Direction::Press) {
            result = Err(e.to_string());
            break;
        }
        pressed += 1;
        std::thread::sleep(Duration::from_millis(30));
    }
    if result.is_ok() {
        match enigo.key(main, Direction::Click) {
            Ok(()) => std::thread::sleep(Duration::from_millis(30)),
            Err(e) => result = Err(e.to_string()),
        }
    }
    // Best-effort: we're already unwinding, so a release error must not mask the original one.
    for m in mods[..pressed].iter().rev() {
        let _ = enigo.key(*m, Direction::Release);
    }
    result
}

/// A probe or wait during which a cancel lands: it raises `cancelled`, then answers `answer`.
#[cfg(test)]
pub(crate) fn cancel_lands_during(
    cancelled: &std::cell::Cell<bool>,
    answer: bool,
) -> impl Fn() -> bool + '_ {
    move || {
        cancelled.set(true);
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::{cancel_lands_during, sanitize_injected};

    /// A cancel that lands during `paste`'s stuck-read wait (up to 1s on Windows) must write
    /// nothing: the discarded transcript would go out with no prior read to restore.
    #[test]
    fn a_cancel_during_the_stuck_read_wait_writes_nothing() {
        use super::{idle_wait_gate, Landed};
        use std::cell::Cell;
        for idle in [true, false] {
            let cancelled = Cell::new(false);
            let gate = idle_wait_gate(cancel_lands_during(&cancelled, idle), || cancelled.get());
            assert_eq!(gate, Some(Landed::Yes), "idle={idle}");
        }
        assert_eq!(
            idle_wait_gate(|| false, || false),
            Some(Landed::NothingWritten)
        );
        assert_eq!(idle_wait_gate(|| true, || false), None);
    }

    /// A cancel that lands during the own-window probe (a main-thread round trip) must stop the
    /// paste chord and auto-Enter on every backend: a cancel from the hotkey, the tray or an error
    /// abort leaves focus in the target app, so the probe answers false and only a cancel read
    /// after it keeps Ctrl+V or Return off the transcript.
    #[test]
    fn a_cancel_during_the_own_window_probe_stops_the_sink() {
        use super::{sink_gate, SinkGate};
        use std::cell::Cell;
        for own in [true, false] {
            let cancelled = Cell::new(false);
            let gate = sink_gate(cancel_lands_during(&cancelled, own), || cancelled.get());
            // A cancel also wins over our own focused window: dropped, not diverted.
            assert_eq!(gate, SinkGate::Cancelled, "own={own}");
        }
        assert_eq!(sink_gate(|| true, || false), SinkGate::OwnWindow);
        assert_eq!(sink_gate(|| false, || false), SinkGate::Proceed);
    }

    /// A typing loop (the `direct` segments, the Wayland portal characters) must read the cancel
    /// AFTER its per-step own-window probe: that probe sits right in front of every line break, so
    /// a cancel landing during it, if read before, would still press the cancelled transcript's
    /// Return, which submits a chat or form.
    #[test]
    fn a_cancel_during_the_typing_probe_stops_the_line_break() {
        use super::{typing_gate, typing_segments, SinkGate, TypeSeg};
        use std::cell::Cell;
        let cancelled = Cell::new(false);
        let mut pressed = Vec::new();
        // The `direct` loop's shape: probe before every segment but the first.
        for (i, seg) in typing_segments("Hi team,\nthanks", 512)
            .into_iter()
            .enumerate()
        {
            let gate = typing_gate(
                i > 0,
                cancel_lands_during(&cancelled, false), // focus stayed in the target app
                || cancelled.get(),
            );
            if gate != SinkGate::Proceed {
                assert_eq!(gate, SinkGate::Cancelled);
                break;
            }
            pressed.push(seg);
        }
        assert_eq!(pressed, vec![TypeSeg::Text("Hi team,")]);

        // A step that does not probe still reads the cancel, and never asks for focus.
        let probe = || -> bool { panic!("no probe on this step") };
        assert_eq!(typing_gate(false, probe, || true), SinkGate::Cancelled);
        assert_eq!(typing_gate(false, probe, || false), SinkGate::Proceed);
        assert_eq!(typing_gate(true, || true, || false), SinkGate::OwnWindow);
    }

    /// `persist_transcript_unless` (the clipboard-only insert and the mid-function divert write
    /// through it) re-asks about a cancel after waiting out a stuck read (up to 1s on Windows): a
    /// cancel during the wait must not install the discarded transcript.
    #[test]
    fn a_cancel_during_the_persist_wait_writes_nothing() {
        use super::serve_transcript;
        use std::cell::Cell;
        for idle in [true, false] {
            let cancelled = Cell::new(false);
            let writes = Cell::new(0);
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            serve_transcript(
                cancel_lands_during(&cancelled, idle),
                || cancelled.get(),
                |_| writes.set(writes.get() + 1),
                tx,
            );
            assert_eq!(writes.get(), 0, "idle={idle}");
            assert_eq!(rx.recv(), Ok(Ok(false)), "idle={idle}");
        }
        // No cancel: an idle clipboard is written, a still-stuck read reports Err.
        let writes = Cell::new(0);
        let (tx, _rx) = std::sync::mpsc::sync_channel(1);
        serve_transcript(|| true, || false, |_| writes.set(writes.get() + 1), tx);
        assert_eq!(writes.get(), 1);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        serve_transcript(|| false, || false, |_| unreachable!(), tx);
        assert!(matches!(rx.recv(), Ok(Err(_))));
    }

    /// Every Linux paste write goes through the live owner, privacy on or off: with no clipboard
    /// manager a plain write's selection dies with the function-local `Clipboard` before a slow
    /// target fetches it.
    #[test]
    fn every_linux_paste_write_goes_through_the_live_owner() {
        use super::paste_write_via_live_owner;
        assert!(paste_write_via_live_owner(false, true));
        assert!(paste_write_via_live_owner(true, true));
        assert!(paste_write_via_live_owner(true, false));
        assert!(!paste_write_via_live_owner(false, false));
    }

    /// Off Linux the plain paste write outlives its `Clipboard`, so a chord-time divert keeps it:
    /// re-writing the same text could only fail into a false "nothing written" that drops the
    /// user's prior clipboard with no restore.
    #[test]
    fn a_durable_paste_write_is_the_divert() {
        use super::divert_rewrite;
        // Windows/macOS plain write: nothing to re-write, and a differing form's failure is not
        // fatal.
        assert_eq!(divert_rewrite(false, false, true), None);
        assert_eq!(divert_rewrite(false, false, false), Some(false));
        // Through the live owner, anywhere: the same.
        assert_eq!(divert_rewrite(true, true, true), None);
        assert_eq!(divert_rewrite(true, true, false), Some(false));
        // A Linux plain write dies with its handle: the divert must persist, or nothing is there.
        assert_eq!(divert_rewrite(false, true, true), Some(true));
    }

    /// A failed paste keeps the transcript on the clipboard by the divert's rule: off Linux the
    /// plain write already holds it, so re-writing the same text would only duplicate it in the
    /// Win+V history (and could log a false "may not stay on the clipboard").
    #[test]
    fn a_failed_paste_keeps_a_durable_write_of_the_same_form() {
        use super::{after_chord, AfterChord};
        // Windows/macOS plain write of the same form: nothing more to write.
        assert_eq!(after_chord(false, false, false, true), AfterChord::Keep);
        // A differing form is written over it; its failure still leaves the pasted text.
        assert_eq!(
            after_chord(false, false, false, false),
            AfterChord::Rewrite(false)
        );
        // A Linux plain write dies with its handle: the hand-off is all there is.
        assert_eq!(
            after_chord(false, false, true, true),
            AfterChord::Rewrite(true)
        );
        // A pasted or withheld insert restores the prior clipboard either way.
        assert_eq!(after_chord(true, false, true, false), AfterChord::Restore);
    }

    /// Category Cf is invisible but reorders what the reader sees, and `char::is_control()` (Cc
    /// only) never caught it — so a hostile transcript could make the text that lands differ from
    /// the text the user watched appear.
    #[test]
    fn strips_bidi_overrides_and_invisible_marks() {
        let hostile = "rm -rf /\u{202e}# harmless\u{202c}";
        let out = sanitize_injected(hostile);
        assert!(!out.contains('\u{202e}'), "RLO survived: {out:?}");
        assert!(!out.contains('\u{202c}'), "PDF survived: {out:?}");
        for c in [
            '\u{200b}', '\u{200e}', '\u{200f}', '\u{2066}', '\u{2069}', '\u{feff}',
        ] {
            assert_eq!(sanitize_injected(&format!("a{c}b")), "ab", "{c:?} survived");
        }
        // ZWNJ (U+200C) and ZWJ (U+200D) are NOT stripped: they are orthographically
        // required in Persian/Urdu (ZWNJ) and Indic scripts / emoji sequences (ZWJ).
        for c in ['\u{200c}', '\u{200d}'] {
            let s = format!("a{c}b");
            assert_eq!(sanitize_injected(&s), s, "{c:?} was wrongly stripped");
        }
        // The rest of the invisible Cf set: soft hyphen, the Arabic letter mark (a bidi control
        // like LRM/RLM), the invisible operators, the annotation anchors and the TAG block are all
        // invisible-but-meaningful and none are category Cc.
        for c in [
            '\u{00ad}',
            '\u{061c}',
            '\u{180e}',
            '\u{2060}',
            '\u{2064}',
            '\u{fff9}',
            '\u{fffb}',
            '\u{e0001}',
            '\u{e007f}',
        ] {
            assert_eq!(sanitize_injected(&format!("a{c}b")), "ab", "{c:?} survived");
        }
        // Zero-width characters `is_control()` misses: the Hangul fillers are category Lo
        // (letters) and the line/paragraph separators Zl/Zp — yet U+2028/U+2029 are UAX#14
        // mandatory breaks, so on the typing paths they would land as a real Enter. The rest are
        // further invisible Cf controls (deprecated format controls, Duployan shorthand, musical
        // beams).
        for c in [
            '\u{115f}',
            '\u{1160}',
            '\u{3164}',
            '\u{ffa0}',
            '\u{2028}',
            '\u{2029}',
            '\u{206a}',
            '\u{206f}',
            '\u{1bca0}',
            '\u{1d173}',
        ] {
            assert_eq!(sanitize_injected(&format!("a{c}b")), "ab", "{c:?} survived");
        }
    }

    /// The denylist must stay narrow. These are all category Cf — the same class as the marks
    /// above — but every one of them RENDERS: U+0600–U+0605 span the digits that follow, U+06DD
    /// and U+08E2 draw the circle around a verse number, U+070F overlines a Syriac abbreviation,
    /// and U+0890/U+0891 are currency marks. Filtering by category would silently corrupt
    /// ordinary Arabic and Syriac transcripts.
    #[test]
    fn keeps_printable_format_characters() {
        for c in [
            '\u{0600}', '\u{0605}', '\u{06dd}', '\u{070f}', '\u{0890}', '\u{0891}', '\u{08e2}',
        ] {
            let s = format!("a{c}b");
            assert_eq!(sanitize_injected(&s), s, "{c:?} was wrongly stripped");
        }
        // Variation selectors pick a glyph variant; VS15/VS16 are the emoji text/presentation
        // selectors, and the supplement carries CJK ideographic variation sequences.
        for c in ['\u{fe0e}', '\u{fe0f}', '\u{e0100}'] {
            let s = format!("a{c}b");
            assert_eq!(sanitize_injected(&s), s, "{c:?} was wrongly stripped");
        }
    }

    /// Ordinary dictation output, including non-Latin scripts and the whitespace the typing paths
    /// rely on, must pass through untouched.
    #[test]
    fn leaves_normal_transcript_text_alone() {
        assert_eq!(
            sanitize_injected("Grüße, 日本語\tund\nZeile 2"),
            "Grüße, 日本語\tund\nZeile 2"
        );
    }

    /// An empty prior read is a stalled delayed render, not the user's clipboard: restoring ""
    /// would erase their remote copy (and supersede a real pending restore).
    #[test]
    fn empty_prior_read_is_not_worth_restoring() {
        assert!(!super::worth_restoring(""));
        assert!(super::worth_restoring("the user's copy 7c1f"));
    }

    /// A clipboard briefly held by another process (rdpclip, clipboard history) is retried, not
    /// read as "nothing to restore"; it gives up after three tries, and other errors at once.
    #[test]
    fn prior_read_retries_a_busy_clipboard() {
        use std::time::Duration;
        let mut calls = 0;
        let got = super::read_prior_text_with(
            || {
                calls += 1;
                if calls < 3 {
                    Err(arboard::Error::ClipboardOccupied)
                } else {
                    Ok("user text".to_string())
                }
            },
            Duration::ZERO,
        );
        assert_eq!(got.as_deref(), Some("user text"));
        assert_eq!(calls, 3);

        let mut calls = 0;
        let got = super::read_prior_text_with(
            || {
                calls += 1;
                Err(arboard::Error::ClipboardOccupied)
            },
            Duration::ZERO,
        );
        assert_eq!(got, None);
        assert_eq!(calls, 3);

        let mut calls = 0;
        let got = super::read_prior_text_with(
            || {
                calls += 1;
                Err(arboard::Error::ContentNotAvailable)
            },
            Duration::ZERO,
        );
        assert_eq!(got, None);
        assert_eq!(calls, 1);
    }

    /// The clipboard-job lock: a second taker is refused (bounded wait included), it is free
    /// again once the guard drops, and a panicked holder does not lock it for good. Only this test
    /// touches CLIP_JOB (keep it that way — tests run in parallel within one process).
    #[test]
    fn clip_job_lock_is_exclusive_bounded_and_survives_poisoning() {
        use std::time::{Duration, Instant};
        let held = super::try_clip_job().expect("free at start");
        assert!(super::try_clip_job().is_none());
        let t0 = Instant::now();
        assert!(super::wait_clip_job(Duration::from_millis(40), || false).is_none());
        assert!(t0.elapsed() >= Duration::from_millis(40));
        let t0 = Instant::now();
        assert!(super::wait_clip_job(Duration::from_secs(5), || true).is_none());
        assert!(
            t0.elapsed() < Duration::from_secs(1),
            "give_up ends the wait early"
        );
        drop(held);
        assert!(super::wait_clip_job(Duration::from_millis(40), || false).is_some());

        let _ = std::thread::spawn(|| {
            let _g = super::try_clip_job().expect("free");
            panic!("poison the clip-job lock");
        })
        .join();
        let g = super::try_clip_job();
        assert!(g.is_some(), "a poisoned lock must still be taken");
        drop(g);
        assert!(super::try_clip_job().is_some());
    }

    #[test]
    fn own_injected_matches_last_set_modulo_crlf() {
        // Only this test touches the LAST_INJECTED global (keep it that way — tests run in
        // parallel within one process).
        super::note_injected("Befund\nZeile 2");
        assert!(super::is_own_injected("Befund\nZeile 2"));
        // The Windows clipboard round-trips LF as CRLF — still ours.
        assert!(super::is_own_injected("Befund\r\nZeile 2"));
        assert!(!super::is_own_injected("etwas anderes"));
        // A newer set replaces the remembered value, and hands back the one it replaced (what
        // `persist_transcript` puts back if its write then serves nothing).
        assert_eq!(
            super::note_injected("neu").as_deref(),
            Some("Befund\nZeile 2")
        );
        assert!(!super::is_own_injected("Befund\nZeile 2"));
        assert!(super::is_own_injected("neu"));
    }

    /// A persistent write that served nothing gives its `note_injected` back, so the slot keeps
    /// naming what IS on the clipboard — unless a newer note replaced it meanwhile.
    #[test]
    fn a_failed_persist_takes_its_injected_note_back() {
        let slot = std::sync::Mutex::new(Some("Second phrase.".to_string()));
        super::unnote_injected(&slot, Some(" Second phrase.".into()), "Second phrase.");
        assert_eq!(slot.lock().unwrap().as_deref(), Some(" Second phrase."));
        // A newer write noted its own text in between: that one stays.
        let slot = std::sync::Mutex::new(Some("Third phrase.".to_string()));
        super::unnote_injected(&slot, Some(" Second phrase.".into()), "Second phrase.");
        assert_eq!(slot.lock().unwrap().as_deref(), Some("Third phrase."));
        // Nothing noted before: back to nothing.
        let slot = std::sync::Mutex::new(Some("Second phrase.".to_string()));
        super::unnote_injected(&slot, None, "Second phrase.");
        assert_eq!(slot.lock().unwrap().as_deref(), None);
    }

    #[test]
    fn sanitize_drops_controls_keeps_tab_lf_normalizes_cr() {
        // Printable text + Tab/LF survive; a trailing CR is normalized to LF (not kept), so a
        // CRLF break can't type a second Enter in the direct paths.
        assert_eq!(
            sanitize_injected("hello\tworld\nline\r"),
            "hello\tworld\nline\n"
        );
        assert_eq!(sanitize_injected("a\r\nb"), "a\nb");
        // ESC, BEL, NUL, DEL, and a C1 control are stripped; the surrounding text stays.
        assert_eq!(sanitize_injected("a\x1bb\x07c\0d\x7fe\u{0085}f"), "abcdef");
        assert_eq!(sanitize_injected("café 😀"), "café 😀");
    }

    #[test]
    fn clipboard_newlines_crlf_on_windows_only_and_never_doubled() {
        use super::clipboard_newlines;
        use std::borrow::Cow;
        assert_eq!(clipboard_newlines("a\nb\n", true), "a\r\nb\r\n");
        // Already-CRLF text is not doubled into CR CR LF.
        assert_eq!(clipboard_newlines("a\r\nb\nc", true), "a\r\nb\r\nc");
        // Off Windows, and for text without a line break, nothing is copied.
        assert!(matches!(
            clipboard_newlines("a\nb", false),
            Cow::Borrowed("a\nb")
        ));
        assert!(matches!(
            clipboard_newlines("one line", true),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn typing_segments_turn_breaks_and_tabs_into_keys() {
        use super::{typing_segments, TypeSeg};
        assert_eq!(
            typing_segments("Befund:\n\tZeile 2\n", 512),
            vec![
                TypeSeg::Text("Befund:"),
                TypeSeg::Enter,
                TypeSeg::Tab,
                TypeSeg::Text("Zeile 2"),
                TypeSeg::Enter,
            ]
        );
        assert_eq!(typing_segments("", 512), Vec::<TypeSeg>::new());
        assert_eq!(
            typing_segments("\n\n", 512),
            vec![TypeSeg::Enter, TypeSeg::Enter]
        );
    }

    #[test]
    fn typing_segments_cap_runs_on_char_boundaries() {
        use super::{typing_segments, TypeSeg};
        // 1030 multi-byte chars → 512 + 512 + 6, every chunk valid UTF-8 by construction.
        let long: String = "ü".repeat(1030);
        let segs = typing_segments(&long, 512);
        let lens: Vec<usize> = segs
            .iter()
            .map(|s| match s {
                TypeSeg::Text(t) => t.chars().count(),
                _ => panic!("unexpected separator"),
            })
            .collect();
        assert_eq!(lens, vec![512, 512, 6]);
        // The cap restarts after a separator; the text round-trips exactly.
        let mixed = format!("{}\n{}", "a".repeat(600), "😀".repeat(3));
        let segs = typing_segments(&mixed, 512);
        assert_eq!(segs.len(), 4);
        let mut rebuilt = String::new();
        for s in &segs {
            match s {
                TypeSeg::Text(t) => rebuilt.push_str(t),
                TypeSeg::Enter => rebuilt.push('\n'),
                TypeSeg::Tab => rebuilt.push('\t'),
            }
        }
        assert_eq!(rebuilt, mixed);
    }

    #[test]
    fn restore_slot_supersedes_and_cancels() {
        use super::RestoreSlot;
        let mut s = RestoreSlot::default();
        let g1 = s.schedule("old".into());
        let g2 = s.schedule("user".into());
        // The first timer finds itself superseded; the second restores the newest text.
        assert_eq!(s.take_if_current(g1), None);
        assert_eq!(s.take_if_current(g2).as_deref(), Some("user"));
        assert_eq!(s.take_if_current(g2), None, "a restore fires once");
        // A newer write takes the pending restore and invalidates its timer.
        let g3 = s.schedule("clip".into());
        assert_eq!(s.cancel().as_deref(), Some("clip"));
        assert_eq!(s.take_if_current(g3), None);
        assert_eq!(s.cancel(), None);
    }

    #[test]
    fn a_pending_restore_is_adopted_only_when_the_paste_has_none_of_its_own() {
        use super::merge_pending_restore;
        let p = || Some("pending".to_string());
        assert_eq!(merge_pending_restore(None, p(), true), p());
        // A real prior read wins: the user copied something since.
        assert_eq!(
            merge_pending_restore(Some("new copy".into()), p(), true).as_deref(),
            Some("new copy")
        );
        // Remote target / a write that must stay: the pending restore is dropped.
        assert_eq!(merge_pending_restore(None, p(), false), None);
        assert_eq!(merge_pending_restore(None, None, true), None);
    }

    /// The per-phrase `restore_clipboard_snapshot` only PEEKS the recovery flag: a restore queued
    /// before an error abort must decline, and the flag must still be there for the session
    /// teardown (`end_injection`) to take, or that teardown restores the old clipboard over the
    /// recovered transcript. Only this test touches the flag, so the shared static is safe here.
    #[test]
    fn recovery_flag_peek_does_not_consume() {
        use super::{
            clear_recovery_on_clipboard, note_recovery_on_clipboard, recovery_on_clipboard,
            take_recovery_on_clipboard,
        };
        clear_recovery_on_clipboard();
        assert!(!recovery_on_clipboard());
        note_recovery_on_clipboard();
        assert!(recovery_on_clipboard());
        assert!(recovery_on_clipboard(), "a peek consumed the flag");
        assert!(take_recovery_on_clipboard());
        assert!(!recovery_on_clipboard());
        assert!(!take_recovery_on_clipboard());
    }

    /// A transcript delivered to the clipboard (clipboard-only phrase or divert) keeps the
    /// session-end restore off it exactly once, and a later paste write supersedes it — that paste
    /// replaced the delivered text, so the restore is owed again. Only this test touches the
    /// delivered flag and the paste target, so the shared statics are safe here.
    #[test]
    fn delivered_flag_is_one_shot_and_superseded_by_a_paste() {
        use super::{
            clear_paste_target, last_paste_was_remote, note_delivered_on_clipboard,
            note_paste_target, take_delivered_on_clipboard,
        };
        clear_paste_target();
        assert!(!take_delivered_on_clipboard());
        note_delivered_on_clipboard();
        assert!(take_delivered_on_clipboard());
        assert!(!take_delivered_on_clipboard(), "the take is not one-shot");
        note_delivered_on_clipboard();
        note_paste_target(false);
        assert!(
            !take_delivered_on_clipboard(),
            "a later paste did not supersede it"
        );
        note_delivered_on_clipboard();
        clear_paste_target();
        assert!(
            !take_delivered_on_clipboard(),
            "a session teardown left it armed"
        );
        assert!(!last_paste_was_remote());

        // Every `diverted: true` answer arms it — the chord-time own-window divert after its
        // paste target was noted — and no other answer does.
        use super::{text::settle_outcome, Landed};
        note_paste_target(false);
        let live = super::injection_epoch();
        let o = settle_outcome(Ok(Landed::OnClipboard), false, live).unwrap();
        assert!(o.landed && o.diverted);
        assert!(
            take_delivered_on_clipboard(),
            "a chord divert left it unarmed"
        );
        // A user cancel that landed during the write owes the session-end restore, so the
        // divert must not arm it — nor leave an EARLIER phrase's delivery armed: the write
        // replaced that text. A never-reached epoch reads as cancelled (and not as an error
        // abort) without bumping the shared `INJECT_EPOCH` other tests read.
        let stale = u64::MAX - 7;
        note_delivered_on_clipboard();
        let _ = settle_outcome(Ok(Landed::OnClipboard), false, stale);
        assert!(
            !take_delivered_on_clipboard(),
            "a user-cancelled divert left an earlier delivery armed"
        );
        let o = settle_outcome(Ok(Landed::NothingWritten), true, live).unwrap();
        assert!(o.landed && o.diverted);
        assert!(
            take_delivered_on_clipboard(),
            "a recovered abort left it unarmed"
        );
        for (res, recovered) in [
            (Ok(Landed::Yes), false),
            (Ok(Landed::NothingWritten), false),
            (Err("boom".to_string()), true),
        ] {
            let _ = settle_outcome(res, recovered, live);
            assert!(!take_delivered_on_clipboard(), "armed without a divert");
        }
        clear_paste_target();
    }

    /// A chord whose main key does not map (Shift + Insert on macOS, or any unmapped key) falls
    /// back to the WHOLE platform paste chord: keeping its modifiers would send Shift+V, typing a
    /// literal 'V' while reporting a paste.
    #[test]
    fn unmapped_paste_key_falls_back_to_the_whole_paste_chord() {
        use super::{paste_chord_keys, Key, PASTE_MOD};
        let paste_mod = PASTE_MOD;
        let chord = |codes: &[&str]| codes.iter().map(|c| c.to_string()).collect::<Vec<_>>();
        assert_eq!(
            paste_chord_keys(&chord(&["ShiftLeft", "F13"])),
            (vec![paste_mod], Key::Unicode('v'))
        );
        assert_eq!(
            paste_chord_keys(&chord(&["ControlLeft", "ShiftLeft", "KeyV"])),
            (vec![paste_mod, Key::Shift], Key::Unicode('v'))
        );
        assert_eq!(
            paste_chord_keys(&chord(&[])),
            (vec![paste_mod], Key::Unicode('v'))
        );
    }
}
