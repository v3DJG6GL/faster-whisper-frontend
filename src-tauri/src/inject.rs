//! Insert transcribed text into the focused field of the active application.
//!
//! Two strategies (mirroring the settings):
//!   * **paste** — put the text on the clipboard and synthesize Ctrl/Cmd+V
//!     (robust, layout-agnostic; optional clipboard restore afterwards).
//!   * **direct** — type the characters directly via the OS (never touches the
//!     clipboard, but can struggle with some layouts / non-Latin input).
//!
//! Backed by `enigo` (Windows SendInput / X11 XTEST; Wayland via XWayland today —
//! a native libei path is M7) and `arboard` for the clipboard.

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Generation counter for "the injection in flight is no longer wanted".
///
/// The Wayland typing paths emit ONE KEY AT A TIME with fixed inter-key sleeps — roughly a
/// hundred characters a second — and used to run to completion unconditionally. The frontend's
/// cancel checks sit before and after the awaited injection, never inside it, so stopping
/// dictation, cancelling, or closing the window did not stop the keys already going out; a long
/// enough transcript keeps typing for hours, into whatever window happens to hold focus as the
/// user moves around. Each injection captures the counter at entry and re-reads it between keys;
/// a cancel bumps it and every loop in flight bails at its next character.
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
    // `fetch_add` returns the PREVIOUS value, so the epoch this bump produces is prev + 1.
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

/// Set when an error-abort recovery has just put an abandoned transcript on the clipboard, so
/// the SESSION-level restore does not erase it.
///
/// `inject_text`'s own per-paste restore already asks this question via
/// `injection_cancelled(epoch) && cancel_wants_recovery(epoch)`, but that guard needs the job's
/// epoch and `end_injection` has none — it runs after the job is gone, chained on the same
/// `stream://error` teardown that armed the recovery, and would serve the user's old clipboard
/// 400ms later over the top. That leaves the transcript neither typed nor recoverable while both
/// layers log success.
///
/// A one-shot flag rather than an epoch comparison: `INJECT_EPOCH` only ever advances on a
/// cancel or an abort, so `RECOVER_AT_EPOCH == INJECT_EPOCH` stays true indefinitely after one
/// error abort and would suppress every later legitimate restore.
///
/// Armed at BOTH recovery writes, and consumed at the top of `end_injection` — unconditionally,
/// above its snapshot test, so a session that never took a snapshot still clears it — or by
/// `discard_injection_snapshot`, the other way a session ends. Those two are the only session
/// teardowns, so the flag cannot outlive the session that armed it, which is what makes it safe
/// without a per-phrase clear. An earlier draft cleared it in `begin_injection` instead; that was
/// both redundant and racy, since `is_own_injected` is a single-slot compare and
/// `set_clipboard_persistent` serves the selection on a detached thread — so for a moment after
/// the recovery write the clipboard still holds the previous phrase while `LAST_INJECTED` already
/// holds the recovery text, and a fast error-recovery re-trigger's `begin_injection` would land in
/// that gap, read our own stale transcript as the user's, and clear a flag still owed a restore.
static RECOVERY_ON_CLIPBOARD: AtomicBool = AtomicBool::new(false);

/// Record that the clipboard now holds a recovered transcript (see `RECOVERY_ON_CLIPBOARD`).
pub fn note_recovery_on_clipboard() {
    RECOVERY_ON_CLIPBOARD.store(true, Ordering::SeqCst);
}

/// Take the recovery flag: true exactly once per recovery, for the restore that would erase it.
pub fn take_recovery_on_clipboard() -> bool {
    RECOVERY_ON_CLIPBOARD.swap(false, Ordering::SeqCst)
}

/// Drop a recovery flag nobody consumed (a new session is starting).
pub fn clear_recovery_on_clipboard() {
    RECOVERY_ON_CLIPBOARD.store(false, Ordering::SeqCst);
}

/// The last text WE placed on the clipboard for an insertion (transcript paste, clipboard-only
/// insert, Wayland paste). Guards every "capture the user's previous clipboard" site: if a
/// restore fails silently or is skipped, the stale transcript stays on the clipboard, the next
/// capture would adopt it as "the user's clipboard", and the restore chain would then resurrect
/// it after every future paste — seen live over RDP, where the remote's delayed clipboard fetch
/// pasted a 7-minute-old transcript (mstsc, 2026-07).
static LAST_INJECTED: Mutex<Option<String>> = Mutex::new(None);

/// Record `text` as the most recent clipboard content WE set (see `LAST_INJECTED`).
fn note_injected(text: &str) {
    if let Ok(mut g) = LAST_INJECTED.lock() {
        *g = Some(text.to_string());
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

/// Remote-desktop / VDI clients, matched on the focused app id. Their clipboard reaches the
/// remote host ASYNCHRONOUSLY (RDP "delayed rendering" even fetches the data only when the
/// remote app pastes), so (a) the usual 60ms local settle before Ctrl+V is not enough for the
/// new content to cross before the forwarded keystroke, and (b) a post-paste restore can be
/// what the remote's paste actually fetches. Paste into these targets uses a longer settle
/// and skips the clipboard restore entirely.
pub fn is_remote_desktop_app(app_id: &str) -> bool {
    const CLIENTS: &[&str] = &[
        "mstsc", "msrdc", "rdcman", // Microsoft RDP clients (classic / Windows-App-AVD / RDCMan)
        "vmconnect", // Hyper-V console
        "wfica32", "citrix", // Citrix Workspace
        "vmware", // VMware Horizon / Workstation (Tools clipboard sync is async too)
        "virt-viewer", "remote-viewer", // SPICE
        "remmina", "freerdp", // Linux RDP clients
        "rustdesk", "anydesk", "teamviewer", "parsec", "nxplayer",
    ];
    let a = app_id.to_lowercase();
    CLIENTS.iter().any(|c| a.contains(c))
}

/// True on a native Wayland session (where enigo's X11 text path can't type
/// Unicode into native windows — direct typing routes through the portal instead).
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
/// (legitimate keystrokes); CR is first normalized to LF. The Wayland direct-typing paths already
/// drop controls; this brings the paste / clipboard / X11-direct paths to the same posture.
pub fn sanitize_injected(text: &str) -> String {
    // Collapse CRLF and a lone CR to LF first: every direct-typing path maps BOTH '\r' and '\n' to
    // an Enter keypress (wayland_inject's KeySpec, X11), so a server's Windows CRLF line endings
    // would otherwise type TWO Enters per line break — a spurious blank line. Normalizing here makes
    // direct + paste + clipboard agree on one Enter per break.
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| (!c.is_control() || c == '\t' || c == '\n') && !is_deceptive_format_char(c))
        .collect()
}

/// Unicode FORMAT characters (category Cf) that change how text READS without being visible.
///
/// `char::is_control()` is category Cc only, so none of these were caught: the bidi overrides and
/// embeddings (U+202A–U+202E), the directional isolates (U+2066–U+2069), the invisible marks
/// (U+200B ZWSP, U+200E/U+200F LRM/RLM) and U+FEFF — ZWNJ and ZWJ are kept (see below). The transcript is server-authored
/// and gets typed or pasted into whatever has focus — an editor, a commit message, a config file,
/// a chat box — so a right-to-left override lets the server make the text that actually lands
/// differ from the text the user watched appear. Trojan-Source, via dictation.
///
/// The portal keycode path already drops these (they are not in the layout charmap); this brings
/// the clipboard/paste, X11-direct and virtual-keyboard paths to the same posture. No legitimate
/// dictation output needs them.
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
        | '\u{e0000}'..='\u{e007f}')    // TAG block — the standard invisible-payload range
}

/// How much text one `enigo.text` call may carry. The Wayland backends type character by
/// character and re-read the injection generation between keys, so a cancel lands within one
/// keystroke — but this backend hands the WHOLE string to the OS in a single blocking call, which
/// gave it no cancellation point at all: stopping dictation, cancelling, or closing the window did
/// not interrupt a long transcript being synthesized into whatever window had focus. Splitting it
/// restores that check without changing what is typed (the chunks are typed back to back, and the
/// split is on a char boundary). Small enough that the worst-case wait to notice a cancel is short,
/// large enough that a normal phrase is still a single call.
const DIRECT_CHUNK_CHARS: usize = 512;

/// What an X11/Windows job actually did. `Ok(())` alone could not tell "typed it" from "abandoned
/// it because one of our own windows took focus", and the caller has to know: the first advances
/// the typed baseline, the second must be re-sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Landed {
    /// Keystrokes were synthesized — or the job was a deliberate no-op (empty text, a cancel bail,
    /// which P16 records as reporting `landed: true` because the caller discards the phrase itself).
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

pub fn inject(
    text: &str,
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
                    tracing::info!("[inject] skipped at the typing sink: our own window took focus");
                    return Ok(Landed::NothingWritten);
                }
                let mut rest = text;
                while !rest.is_empty() {
                    let split = match rest.char_indices().nth(DIRECT_CHUNK_CHARS) {
                        Some((i, _)) => i,
                        None => rest.len(),
                    };
                    let (chunk, tail) = rest.split_at(split);
                    enigo.text(chunk).map_err(|e| e.to_string())?;
                    rest = tail;
                    if !rest.is_empty() {
                        if injection_cancelled(epoch) {
                            tracing::info!("[inject] cancelled mid-typing — stopping");
                            return Ok(Landed::Yes);
                        }
                        // Focus is re-asked per chunk, not only before the first one: a 512-char
                        // chunk is tens of milliseconds of typing, so a click into one of our own
                        // windows part-way through a long transcript otherwise lands every
                        // remaining chunk in that window's field.
                        //
                        // `Yes`, NOT `NothingWritten` — the chunks before this one really did land,
                        // and claiming otherwise makes the caller re-send the whole phrase on top
                        // of them (P16's duplicate-text hazard). The untyped tail is dropped, which
                        // is the same trade the mid-typing cancel above already makes.
                        //
                        // One probe per chunk, and each is an event-loop round trip (~0.1ms) — a
                        // rounding error against `enigo.text()`. What it does add is a dependency
                        // on the UI thread being responsive: if that stalls, typing stalls here.
                        // Accepted, and consistent with the guards at the entry and the sinks,
                        // which have always made the same unbounded call.
                        if own_window_focused() {
                            tracing::info!("[inject] stopped mid-typing: our own window took focus");
                            return Ok(Landed::Yes);
                        }
                    }
                }
            }
            _ => {
                match paste(
                    &mut enigo,
                    text,
                    restore_clipboard,
                    paste_shortcut,
                    remote_target,
                    epoch,
                    own_window_focused,
                )? {
                    // Nothing was pressed, so the auto-Enter below must not fire either — it would
                    // submit whatever the focused field already holds.
                    l @ (Landed::NothingWritten | Landed::OnClipboard) => return Ok(l),
                    Landed::Yes => {}
                }
            }
        }
    }

    // A cancel during the typing above must not still submit what landed.
    if auto_enter && !injection_cancelled(epoch) {
        // The three probes above all sit inside `if !text.is_empty()`, so a BARE auto-Enter job —
        // which `streaming.ts` sends routinely for the per-phrase and tail Enter, on both methods —
        // reached this Return having been checked by none of them, and fired blind into whatever
        // held focus. Same sink guard, at the sink that job actually has.
        if own_window_focused() {
            tracing::info!("[inject] skipped the auto-Enter: our own window took focus");
            // `NothingWritten` ONLY when this job was just the Enter. If text landed above, saying
            // "nothing written" makes the caller re-send it — the P16 duplicate-text hazard.
            return Ok(if text.is_empty() { Landed::NothingWritten } else { Landed::Yes });
        }
        enigo
            .key(Key::Return, Direction::Click)
            .map_err(|e| e.to_string())?;
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

/// Put `text` on the clipboard. Used by the Wayland paste path, which sets the clipboard
/// here and synthesizes Ctrl+V via the portal. The prior clipboard is captured separately
/// and TIME-BOUNDED by the caller (read_selection_bounded — see commands.rs), so this no
/// longer does the unbounded get_text() that could wedge on a dead clipboard owner.
pub fn set_clipboard(text: &str) -> Result<(), String> {
    use arboard::Clipboard;
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())?;
    note_injected(text);
    Ok(())
}

/// Hold `text` on the clipboard as a LIVE owner, blocking the calling thread until the
/// selection is replaced. On Wayland a selection only persists while its source app stays
/// alive to serve it (arboard's `set().wait()`), so this is needed BOTH for clipboard-only
/// insertion AND for restoring the user's previous clipboard after a paste — a plain
/// `set_text` that returns and drops doesn't stick on Wayland (the "clipboard never
/// restored" bug). Always run this on a detached thread.
/// `what` names the operation for the failure log. Failures MUST be visible: a silently-failed
/// RESTORE leaves our transcript on the clipboard, which every later "capture the previous
/// clipboard" would have adopted as the user's content and re-restored forever (the mstsc
/// stale-paste bug hid behind exactly this `let _ =`). `is_own_injected` now breaks that chain,
/// but the failure itself still needs to show up in the log.
///
/// `report`, when present, receives the outcome AS SOON AS IT IS KNOWABLE and before this
/// function blocks — see `set_clipboard_persistent` for why that split exists and what it can and
/// cannot answer.
fn serve_clipboard_blocking(
    text: String,
    what: &str,
    report: Option<std::sync::mpsc::SyncSender<Result<(), String>>>,
) {
    let tell = |r: Result<(), String>| {
        if let Some(tx) = report.as_ref() {
            // The caller may already have timed out and dropped the receiver; that is a normal
            // outcome, not an error — it means it decided to believe the optimistic answer.
            let _ = tx.send(r);
        }
    };
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        match arboard::Clipboard::new() {
            // Blocks here serving the selection until another app replaces it — that's what
            // keeps the text on the clipboard after a plain set would return + drop it.
            Ok(mut cb) => {
                // Report BEFORE the wait, not after: `set().wait()` does not return until another
                // app takes the selection, which may be never. Connecting to the clipboard is the
                // whole answer that can be given synchronously on this platform, and it is the one
                // that matters — it is what fails when the session has no clipboard at all.
                tell(Ok(()));
                if let Err(e) = cb.set().wait().text(text) {
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
                let r = cb.set_text(text).map_err(|e| e.to_string());
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
/// clipboard-only insert method, where (unlike paste) nothing consumes the clipboard
/// immediately, so it must persist via a live owner.
/// Returns whether the text actually reached the clipboard, as far as that is knowable.
///
/// This used to be `-> ()`, and every caller reported success as a compile-time constant: six
/// sites answered `landed: true` on the strength of a call that spawned a thread and returned.
/// That is not only a reassuring message — on the DIVERT path it is data loss. `streaming.ts`
/// computes `delivered = !t.isSelf && landed`, then advances `injectedText` so the phrase leaves
/// the re-send stream permanently, clears `clipDirty` so no restore is owed, and pulses the
/// "on the clipboard" glyph. On a machine where the clipboard does not work, a routine divert
/// therefore dropped the phrase for good while the UI confirmed it was pasteable.
///
/// The answer cannot come from re-issuing a clipboard insert and believing it — that was tried
/// (R21) and reverted, because `inject_text` short-circuits `method == "clipboard"` and the value
/// it returns is a constant. It has to come from the thread that does the work, so the thread
/// reports through a `sync_channel(1)` at the first point the outcome is knowable: after
/// `Clipboard::new()`, before the blocking `set().wait()`.
///
/// **Ambiguity fails OPEN — deliberately.** A timeout or a dead channel returns `Ok`. The hazard
/// the ledger records twice (P16, Q33) is that a wrong `false` makes the caller RE-TYPE text the
/// user already has, which is worse than a wrong `true` at every current call site, since none of
/// them has transmitted a keystroke. A slow-but-working compositor must not be misreported.
///
/// **What it does not cover:** on Linux, `set().wait()` failing after the handshake. That cannot
/// be answered synchronously by construction — the call does not return until another app takes
/// the selection. It stays a log line. The dominant real failure, and the one this closes, is
/// having no clipboard connection at all.
pub fn set_clipboard_persistent(text: &str) -> Result<(), String> {
    note_injected(text);
    let text = text.to_string();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    std::thread::spawn(move || serve_clipboard_blocking(text, "clipboard-only set", Some(tx)));
    // Normally sub-millisecond: this waits for a local connect, not for a paste. The bound exists
    // so a wedged compositor cannot park an injection, and it is long enough that a slow one still
    // gets to answer for itself rather than being reported as broken.
    match rx.recv_timeout(Duration::from_millis(200)) {
        Ok(r) => r,
        Err(_) => Ok(()),
    }
}

/// Restore clipboard text captured (time-bounded) by the caller before the paste, after a short delay so the paste
/// has consumed the clipboard first. No-op when `prev` is None. Restores via a LIVE owner
/// (not a plain set_text) so the restored value actually persists on Wayland.
pub fn restore_clipboard_later(prev: Option<String>) {
    if let Some(prev) = prev {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            // No report channel: nothing user-facing rests on a RESTORE succeeding (the ledger
            // verified all four call sites), and this already runs detached behind a 400ms sleep.
            serve_clipboard_blocking(prev, "clipboard restore", None);
        });
    }
}

fn paste(
    enigo: &mut Enigo,
    text: &str,
    restore_clipboard: bool,
    chord: &[String],
    remote_target: bool,
    // See `injection_cancelled`. The pre-job check in `inject` runs before `Enigo::new`, and this
    // function then does an unbounded blocking `get_text()` plus a settle sleep before it touches
    // anything — so "checked at the top of the job" is not the same as "checked at the sink", the
    // distinction the Wayland twin was already fixed for.
    epoch: u64,
    own_window_focused: OwnWindowFocused<'_>,
) -> Result<Landed, String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    // Never capture (→ never restore) for a remote-desktop target: its clipboard sync is
    // asynchronous, and with RDP delayed rendering the RESTORED value can be what the remote's
    // paste actually fetches — no fixed delay makes that safe, so skipping the restore is the
    // only airtight option. The transcript stays on the clipboard instead.
    let previous = if restore_clipboard && !remote_target {
        // Refuse to adopt OUR OWN last transcript as "the user's previous clipboard": it lingers
        // there after a failed/skipped restore, and restoring it here would resurrect stale
        // dictation after every future paste (the mstsc wrong-text bug).
        clipboard.get_text().ok().filter(|p| {
            let own = is_own_injected(p);
            if own {
                tracing::info!("[clip] paste: prior clipboard is our own transcript — skipping restore");
            }
            !own
        })
    } else {
        None
    };
    // A cancel that landed during `Enigo::new` / `Clipboard::new` / the un-timed `get_text()` above
    // must not still clobber the user's clipboard with the transcript they discarded. Bailing here
    // is clean: nothing has been written yet and `previous` was only read, never replaced. The
    // caller (`inject`) returns `Ok(())` into `inject_text`'s `res`, so the error-abort recovery
    // block at the end of that function still runs and a died session keeps its text.
    if injection_cancelled(epoch) {
        tracing::info!("[clip] paste: cancelled before the clipboard write — skipping");
        return Ok(Landed::Yes);
    }
    // Own-window check at the clipboard WRITE. `inject_text`'s guard ran before `spawn_blocking`,
    // and between it and here sit `Enigo::new`, `Clipboard::new` and an explicitly UN-TIMED
    // blocking `get_text()` — the longest guard-to-sink gap on any injection path. Without it, a
    // click into one of our own windows mid-injection clobbers the user's clipboard and then
    // pastes into our own field. `NothingWritten`: `previous` was only READ, so the caller
    // re-sends and no text is duplicated.
    if own_window_focused() {
        tracing::info!("[clip] paste: skipped at the clipboard write — our own window took focus");
        return Ok(Landed::NothingWritten);
    }
    // A remote target's clipboard fetch is DEFERRED: the client requests the data only when
    // the remote app actually pastes — after the forwarded chord, i.e. after this function
    // returns and the local `clipboard` binding is dropped. On X11 with no clipboard manager,
    // arboard tears the selection down on that drop, so the remote would paste nothing AND the
    // "transcript stays on the clipboard" consolation above would be false. Same rule as the
    // chord-divert guard: data that must outlive the call goes through the live owner.
    if remote_target {
        set_clipboard_persistent(text)?; // note_injected's for us
    } else {
        clipboard.set_text(text.to_string()).map_err(|e| e.to_string())?;
        note_injected(text);
    }
    // Let the new clipboard owner settle before pasting. A remote-desktop client additionally
    // needs the new content to cross the network (format-list announcement) before the forwarded
    // Ctrl+V lands, or the remote pastes its previously-synced clipboard — give it a longer window.
    std::thread::sleep(Duration::from_millis(if remote_target { 300 } else { 60 }));
    // Second check, at the sink. The one above guards the clipboard WRITE; this one guards the
    // KEYSTROKE, and the settle between them is 60ms (300ms remote) of wall clock during which
    // `cancel_stream`/`cancel_record` run un-chained on another blocking thread. The Wayland twin
    // has always re-asked on this leg (`wayland_inject::paste`'s own pre-job check), and P3's
    // verifier named this gap explicitly; only the first half was applied.
    //
    // It bails differently from the check above, and must: the transcript is already ON the
    // clipboard here, so the choice is who owns it afterwards. A USER cancel means "I don't want
    // this", so the user's prior clipboard goes back. An ERROR abort deliberately leaves the
    // transcript, because `inject_text`'s recovery block is what makes a died session's text
    // recoverable — scheduling a restore here would erase it 400ms later.
    if injection_cancelled(epoch) {
        tracing::info!("[clip] paste: cancelled during the settle — not pasting");
        if !cancel_wants_recovery(epoch) {
            restore_clipboard_later(previous);
        }
        return Ok(Landed::Yes);
    }
    // And again before the chord. The transcript is on the clipboard by now, so the honest answer
    // is a DIVERT, not "nothing written" — and the restore is skipped deliberately so the text
    // stays pasteable, exactly as the failed-paste arm below does.
    if own_window_focused() {
        tracing::info!("[clip] paste: skipped at the chord — our own window took focus");
        // Hand the selection to the persistent owner BEFORE returning. The `set_text` above went
        // through this local `Clipboard`, which is dropped when this function returns — and on X11
        // with no clipboard manager running, arboard tears the selection down on that drop. So
        // reporting "it's on the clipboard" without this is a FALSE confirmation: the caller
        // advances its baseline, the phrase leaves the re-send stream, and the text is gone. This
        // is the rule `set_clipboard_persistent`'s own doc states — nothing consumes the clipboard
        // here, so it must persist via a live owner.
        // Believe the answer now that there is one. `NothingWritten` is safe here specifically
        // because no chord was pressed on this arm — the caller re-sends, and re-sending cannot
        // duplicate text that was never typed. (The `set_text` above went through a local
        // `Clipboard` that is dropped on return, so it is not a fallback.)
        if !remote_target {
            if let Err(e) = set_clipboard_persistent(text) {
                tracing::warn!("[clip] paste: clipboard divert failed, reporting nothing written: {e}");
                return Ok(Landed::NothingWritten);
            }
        }
        return Ok(Landed::OnClipboard);
    }
    let res = paste_keystroke(enigo, chord);

    // Restore the user's prior clipboard ONLY when the paste SUCCEEDED — via a live owner (same path
    // as the Wayland branch) so it actually persists; a plain set_text that drops doesn't stick on
    // Wayland and is harmless on X11. On FAILURE, deliberately leave our dictated text on the
    // clipboard so it's recoverable by a manual paste: the dictation is the product, and losing it is
    // worse than losing the prior clipboard. This matches the Wayland paste path AND streaming.ts's
    // end-of-session "it's on the clipboard to paste manually" message, which documents this
    // skip-restore-on-failure contract. No-op when restore is off (`previous` is None).
    if res.is_ok() {
        restore_clipboard_later(previous);
    }
    res.map(|()| Landed::Yes)
}

/// Map a KeyboardEvent.code to an enigo key + whether it's a modifier. "Control" maps to
/// Cmd on macOS so the default paste chord stays correct there.
fn code_to_enigo(code: &str) -> Option<(Key, bool)> {
    let ctrl = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
    Some(match code {
        "ControlLeft" | "ControlRight" => (ctrl, true),
        "ShiftLeft" | "ShiftRight" => (Key::Shift, true),
        "AltLeft" | "AltRight" => (Key::Alt, true),
        "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => (Key::Meta, true),
        "Insert" => (Key::Insert, false),
        c if c.len() == 4 && c.starts_with("Key") => {
            (Key::Unicode(c.as_bytes()[3].to_ascii_lowercase() as char), false)
        }
        _ => return None,
    })
}

fn paste_keystroke(enigo: &mut Enigo, chord: &[String]) -> Result<(), String> {
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
    // Fall back to Ctrl/Cmd+V if the chord didn't map to a usable main key.
    let main = main.unwrap_or(Key::Unicode('v'));
    if mods.is_empty() {
        mods.push(if cfg!(target_os = "macos") { Key::Meta } else { Key::Control });
    }
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
    // Release exactly the modifiers we pressed, in reverse, regardless of the outcome
    // above (best-effort: we're already unwinding, so don't mask the original error).
    for m in mods[..pressed].iter().rev() {
        let _ = enigo.key(*m, Direction::Release);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::sanitize_injected;

    /// Category Cf is invisible but reorders what the reader sees, and `char::is_control()` (Cc
    /// only) never caught it — so a hostile transcript could make the text that lands differ from
    /// the text the user watched appear.
    #[test]
    fn strips_bidi_overrides_and_invisible_marks() {
        let hostile = "rm -rf /\u{202e}# harmless\u{202c}";
        let out = sanitize_injected(hostile);
        assert!(!out.contains('\u{202e}'), "RLO survived: {out:?}");
        assert!(!out.contains('\u{202c}'), "PDF survived: {out:?}");
        for c in ['\u{200b}', '\u{200e}', '\u{200f}', '\u{2066}', '\u{2069}', '\u{feff}'] {
            assert_eq!(sanitize_injected(&format!("a{c}b")), "ab", "{c:?} survived");
        }
        // ZWNJ (U+200C) and ZWJ (U+200D) are NOT stripped: they are orthographically
        // required in Persian/Urdu (ZWNJ) and Indic scripts / emoji sequences (ZWJ).
        for c in ['\u{200c}', '\u{200d}'] {
            let s = format!("a{c}b");
            assert_eq!(sanitize_injected(&s), s, "{c:?} was wrongly stripped");
        }
        // The Cf set is wider than the first pass covered: soft hyphen, the Arabic letter mark
        // (a bidi control like LRM/RLM), the invisible operators, the annotation anchors and the
        // TAG block are all invisible-but-meaningful and none are category Cc.
        for c in [
            '\u{00ad}', '\u{061c}', '\u{180e}', '\u{2060}', '\u{2064}', '\u{fff9}', '\u{fffb}',
            '\u{e0001}', '\u{e007f}',
        ] {
            assert_eq!(sanitize_injected(&format!("a{c}b")), "ab", "{c:?} survived");
        }
        // Zero-width characters that no CATEGORY rule reaches: the Hangul fillers are category Lo
        // (letters), and the line/paragraph separators are Zl/Zp — `is_control()` returns false
        // for all of them, yet U+2028/U+2029 are UAX#14 mandatory breaks, so on the typing paths
        // they land as a real Enter.
        for c in [
            '\u{115f}', '\u{1160}', '\u{3164}', '\u{ffa0}', '\u{2028}', '\u{2029}', '\u{206a}',
            '\u{206f}', '\u{1bca0}', '\u{1d173}',
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
        assert_eq!(sanitize_injected("Grüße, 日本語\tund\nZeile 2"), "Grüße, 日本語\tund\nZeile 2");
    }

    #[test]
    fn own_injected_matches_last_set_modulo_crlf() {
        // Only this test touches the LAST_INJECTED global (keep it that way — tests run in
        // parallel within one process).
        super::note_injected("Befund\nZeile 2");
        assert!(super::is_own_injected("Befund\nZeile 2"));
        // The Windows clipboard round-trips LF as CRLF — still ours.
        assert!(super::is_own_injected("Befund\r\nZeile 2"));
        // The user's own copy is not ours.
        assert!(!super::is_own_injected("etwas anderes"));
        // A newer set replaces the remembered value.
        super::note_injected("neu");
        assert!(!super::is_own_injected("Befund\nZeile 2"));
        assert!(super::is_own_injected("neu"));
    }

    #[test]
    fn remote_desktop_app_ids() {
        for id in ["mstsc", "MSRDC", "org.remmina.Remmina", "xfreerdp", "wfica32", "vmconnect"] {
            assert!(super::is_remote_desktop_app(id), "{id} should be remote");
        }
        for id in ["firefox", "kate", "ms-teams", "code"] {
            assert!(!super::is_remote_desktop_app(id), "{id} should not be remote");
        }
    }

    #[test]
    fn sanitize_drops_controls_keeps_tab_lf_normalizes_cr() {
        // Printable text + Tab/LF survive; a trailing CR is normalized to LF (not kept), so a
        // CRLF break can't type a second Enter in the direct paths.
        assert_eq!(sanitize_injected("hello\tworld\nline\r"), "hello\tworld\nline\n");
        // CRLF collapses to a single LF (one Enter, not two).
        assert_eq!(sanitize_injected("a\r\nb"), "a\nb");
        // ESC, BEL, NUL, DEL, and a C1 control are stripped; the surrounding text stays.
        assert_eq!(sanitize_injected("a\x1bb\x07c\0d\x7fe\u{0085}f"), "abcdef");
        // Non-ASCII printable (incl. astral) is untouched.
        assert_eq!(sanitize_injected("café 😀"), "café 😀");
    }
}
