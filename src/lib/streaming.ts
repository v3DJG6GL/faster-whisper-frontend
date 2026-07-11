// Live streaming dictation: start/stop a session and fold the Rust `stream://*`
// events into the store (status / level / live transcript) and into the focused
// app (text injection).
//
// Injection timing (Settings → General → Auto-insert):
//   • "off"  — never insert.
//   • "stop" — insert the whole transcript once, when dictation stops (uses the
//              chosen Insertion-method: clipboard paste or direct typing).
//   • "live" — insert each phrase AS YOU FINISH IT (streaming backends only, and
//              only when the Profile's activation is latch — never hold; see below).
//
// Live insert is NOT possible in HOLD/push-to-talk mode: the activation chord is
// physically held for the entire dictation, so the compositor folds that held
// modifier into every injected keystroke (Alt → the app's menu-mnemonic mode eats
// them, Ctrl → letters become shortcuts, Super → KWin global shortcuts). No chord
// avoids this, so hold mode always falls back to a single insert on release.
//
// Live insert is APPEND-ONLY: on each `final` we type only the new suffix of the
// whole document (committed + tail) beyond what we've already typed — we never
// backspace/revise. This honours the chosen method (clipboard paste or direct).
// On a server "boundary" (long-silence hard break) the document resets: we drop our
// baseline so the next utterance starts fresh, and optionally type a separator.

import { useApp } from "./store";
import { effectiveServerUrl } from "./backends";
import { newSpeakMemo, stepSpeaking, type SpeakMemo } from "./speaking";
import {
  isTauri,
  startStream,
  stopStream,
  cancelStream,
  startRecord,
  stopRecord,
  cancelRecord,
  retireSessionEpoch,
  injectText,
  beginInjection,
  endInjection,
  restoreClipboardSnapshot,
  discardInjectionSnapshot,
  getFocusedApp,
  reregisterShortcutsUnlessCapturing,
  shortcutModsHeld,
} from "./api";
import type { ActivationKind, AppRule, Backend, DecodeOverrides, EndpointKind, FocusedApp, GeneralSettings, InsertMethod } from "./types";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { isActiveDictation } from "./dictationVisual";

let wired = false;

// Auto-stop a hands-free (latch) session after a configured stretch of continuous silence (0 = off).
// Reuses the SAME speaking detector as the chip (lib/speaking), so "silence" means exactly what the
// chip shows as not-green; fires the normal stop (which drains the last phrase). Armed per session in
// startLive, disarmed on any stop/cancel.
let autoStopMemo: SpeakMemo = newSpeakMemo();
let autoStopMs = 0;
let lastSpokeAt = 0;

let activeEndpoint: "stream" | "batch" | null = null;

// Mic warm-up gate. A cold mic can be open but deliver SILENCE for ~1–2s before real
// audio flows (classic for a Bluetooth headset switching into its HFP/mic profile). From
// the first frame we hold the chip in "warming up…" — a neutral/grey dot, NEVER an amber
// "listening" flash before the mic is live — and defer the start cue until real audio
// actually arrives:
//   • stream://mic-live (PRIMARY) — Rust detects real audio on the RAW capture chunks
//     (session.rs LiveDetect) and announces it once; the listener below clears the gate.
//   • MIC_LIVE_LEVEL (fallback) — a warming mic delivers exact zeros (level 0); a live mic
//     usually has a faint noise floor above it even in silence (measured ~0.0002 on a quiet
//     Bluetooth headset). But this level is smoothed from a 0-seeded EMA and QUIET mics'
//     floors only hover at the threshold (a Framework 13 mic rests at ~1.4-1.9e-4), which
//     held the gate until the user spoke — hence the raw-RMS Rust signal as primary.
//   • MIC_LIVE_CONFIRM — require a couple of consecutive frames above the floor, so a
//     single open-blip (a click/DC spike when the stream opens) can't end it early.
//   • MIC_WARM_TIMEOUT_MS — hard cap on "warming up…" even if no audio is ever detected.
const MIC_LIVE_LEVEL = 0.0001;
const MIC_LIVE_CONFIRM = 2;
const MIC_WARM_TIMEOUT_MS = 5000;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
let micLiveHits = 0;
function clearWarmTimer(): void {
  if (warmTimer) {
    clearTimeout(warmTimer);
    warmTimer = null;
  }
}
// The whole post-processed document through the last `final` (committed + tail),
// for the chip/Home preview. Partials carry only the current utterance, so we
// prepend this to keep earlier lines visible while the next sentence is spoken.
let committedDoc = "";
// The exact text we've TYPED into a non-self field so far (live mode), so we can diff the next
// document against it and append only what's new. Advanced in the inject queue ONLY when a phrase
// actually lands (NOT for a phrase the own-window guard skips) — so after a focus switch, text
// dictated while our own window was focused is re-typed rather than silently dropped.
let injectedText = "";
// The last final's document (advanced synchronously per final), used ONLY for the "did the document
// grow" guard — distinguishes a real new phrase from a re-sent `final` (the flush final emitted at
// latch end), independent of whether/where it was typed. Separate from `injectedText` so the typed
// baseline can be type-time/own-window-aware without breaking re-sent-final detection.
let seenDoc = "";
// Documents completed before a hard break, accumulated for the "stop"-timing single
// insert. Live mode types as it goes, so it doesn't read this back.
let bankedDoc = "";
// Clipboard-only phrase boundary. committedDoc grows across phrases until the backend's long-silence
// hard break — which can be many seconds away, far too late to feel like "just my last phrase". So we
// detect the phrase boundary client-side: `clipBaseline` is the committedDoc text already copied as
// PRIOR phrases; the current clipboard phrase is committedDoc beyond it. Advanced by the phrase-end
// quiet timer (you paused → start fresh), reset at each hard break + session start.
let clipBaseline = "";
// Insertion config captured at dictation start.
interface InsertCfg {
  timing: "off" | "stop" | "live";
  method: "paste" | "direct" | "clipboard";
  pasteShortcut: string[]; // chord for the paste method (KeyboardEvent.code list)
  autoEnter: boolean;
  restoreClipboard: boolean;
  live: boolean; // timing === "live" on a streaming backend (latch, or clipboard in any mode)
  targetApp: FocusedApp | null; // focused app at start (per-app rules + chip + field guard)
  blocked: boolean; // a per-app rule blocks typing here → coerced to clipboard-only
  notEditable: boolean; // deep detection: focused element isn't a text field → coerced to clipboard-only
  activation: ActivationKind; // hold/PTT must never live-TYPE (the held chord folds into the keys)
}
let insertCfg: InsertCfg | null = null;
// P19: per-phrase insert feedback. `sessionTyped`/`sessionClipboard` accumulate what actually
// happened this session, so the chip's end-of-session done marker is truthful; `insertSeq`
// bumps on every landed phrase so the chip re-triggers its calm green "inserted" pulse.
let sessionTyped = false;
let sessionClipboard = false;
let insertSeq = 0;
function signalInsert(kind: "typed" | "clipboard"): void {
  useApp.getState().setDictation({ lastInsert: { kind, seq: ++insertSeq } });
}
/** The truthful end-of-session outcome from what landed this session — typed wins over
 *  clipboard wins over nothing. */
function endOutcome(): "typed" | "clipboard" | "none" {
  return sessionTyped ? "typed" : sessionClipboard ? "clipboard" : "none";
}
// Whether we've taken at least one clipboard snapshot this session (live paste) — set the first
// time a phrase is actually pasted (the snapshot is re-taken PER PHRASE, just before each paste),
// so the close handler knows it owes a final restore + snapshot-clear.
let beganInjection = false;
// "Press Enter after" in live mode fires per PHRASE, detected client-side: when speech goes
// quiet for PHRASE_END_QUIET_MS (finals/partials stop) we treat the phrase as finished and
// press Enter — instead of waiting for the backend's long-silence hard break (~20s, far too
// late). `phraseDirty` = committed text typed since the last auto-Enter.
let phraseDirty = false;
// Live PASTE only: the clipboard currently holds a pasted phrase (the transcript), so it owes a
// restore back to the user's snapshot. Set when a phrase is actually pasted, cleared once we put
// the original back. Drives per-phrase restore so the clipboard is the user's between phrases —
// not just once at stop (which an ongoing latch session never reaches).
let clipDirty = false;
// Whether the clipboard currently holds OUR dictated transcript (vs the user's original). Distinct
// from clipDirty (= restore-debt): a clipboard-only phrase clears the debt yet still leaves our text
// on the clipboard, so the per-phrase snapshot must gate on THIS, not clipDirty — else the next paste
// re-snapshots our own text as the user's "original" and the later restore clobbers their content.
let clipHoldsOurs = false;
let phraseEndTimer: ReturnType<typeof setTimeout> | null = null;
const PHRASE_END_QUIET_MS = 1200;
// Serialise every injection op so backspaces/types never interleave or race.
let injectChain: Promise<void> = Promise.resolve();
function enqueueInject(fn: () => Promise<void>): void {
  injectChain = injectChain.then(fn).catch((e) => console.error("inject failed:", e));
}

/** Enqueue a real Enter into the window focused NOW. Empty text routes through the keystroke
 *  path (no clipboard), so the per-phrase Enter never clobbers the clipboard. Clipboard-only
 *  types nothing, so it no-ops there. */
function enqueueAutoEnter(): void {
  // Capture the session token SYNCHRONOUSLY (before the queued task's awaited resolveTarget) so the
  // task bails on BOTH a cancel (insertCfg→null) AND a cancel-then-fresh-restart (insertCfg→a NEW
  // object) landing during the await — a plain `!insertCfg` catches only the null case, so a
  // cancel-then-restart would fire a stray Enter into the next session's window. Mirrors the live
  // final / boundary-separator / stop tasks (all capture cfg before their enqueue). Within a session
  // insertCfg keeps a stable identity, and stopLive leaves it intact, so a normal end-of-session
  // Enter still fires.
  const cfg = insertCfg;
  enqueueInject(async () => {
    const t = await resolveTarget();
    if (insertCfg !== cfg) return;
    // Never fire a real keystroke for a HOLD session, even after focus moved to a paste/direct window:
    // the PTT chord is still physically held, so the Enter would fold into the held modifier (mirrors
    // the live-final useClipboard guard). A hold session is clipboard-coerced, so nothing was typed here.
    if (t.method === "clipboard" || cfg?.activation === "hold") return;
    await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
  });
}

/** Enqueue a clipboard restore (live paste): put the user's clipboard back from the most-recent
 *  per-phrase snapshot, without consuming it (so the next phrase's paste + restore repeats).
 *  No-op in Rust when we never snapshotted. */
function enqueueRestoreSnapshot(): void {
  enqueueInject(async () => {
    try {
      await restoreClipboardSnapshot();
    } catch (e) {
      console.error("restore clipboard snapshot failed:", e);
    }
  });
}

/** (Re)arm the phrase-end quiet timer — the single "you paused, the phrase is done" signal that
 *  drives the per-phrase actions: auto-Enter, clipboard restore, AND advancing the clipboard-only
 *  phrase baseline. Called on every partial/final while live, so ongoing speech keeps deferring
 *  them; once speech stops for PHRASE_END_QUIET_MS the phrase is done. The backend hard-break
 *  boundary (~20s) is a backstop. Armed for ANY live session (not just Enter/restore) so the
 *  clipboard-only baseline still advances on a pause. */
function bumpPhraseEnd(): void {
  if (!insertCfg?.live) return;
  if (phraseEndTimer) clearTimeout(phraseEndTimer);
  phraseEndTimer = setTimeout(() => {
    phraseEndTimer = null;
    // Press Enter for the just-finished phrase — only if new text landed since the last Enter.
    if (insertCfg?.autoEnter && phraseDirty) {
      phraseDirty = false;
      enqueueAutoEnter();
    }
    // Restore the user's clipboard now the phrase's paste has long since landed (the quiet gap
    // guarantees it) — so between phrases the clipboard is theirs, not the transcript. The
    // snapshot survives in Rust, so the next pasted phrase restores again.
    if (clipDirty && beganInjection) {
      clipDirty = false;
      clipHoldsOurs = false; // the restore below puts the user's clipboard back
      enqueueRestoreSnapshot();
    }
    // You paused → end the current clipboard-only phrase, so the next utterance copies fresh and
    // "Clipboard only" holds just your latest phrase instead of the whole hard-break window.
    clipBaseline = committedDoc;
  }, PHRASE_END_QUIET_MS);
}

/** Clear just the per-phrase quiet timer (NOT the dirty flags) — the boundary/closed handlers
 *  cancel the pending Enter/restore but deliberately keep phraseDirty/clipDirty for the tail. */
function clearPhraseEndTimer(): void {
  if (phraseEndTimer) {
    clearTimeout(phraseEndTimer);
    phraseEndTimer = null;
  }
}

/** Drop any pending phrase-end Enter/restore (session reset / abort). */
function clearPhraseEnd(): void {
  clearPhraseEndTimer();
  phraseDirty = false;
  clipDirty = false;
  clipHoldsOurs = false; // session reset — start clean
  clipBaseline = "";
}

/** The per-app injection policy: focused app + per-app rule + opt-in deep detection → the effective
 *  insertion method, paste shortcut, the matched rule, and whether a non-editable target was coerced
 *  to clipboard. This MUST be the single source: it is resolved both at session start (startLive,
 *  frozen into insertCfg + the chip's blocked/notEditable flags) AND per phrase / on the focus poll
 *  (resolveTarget) — open-coding it twice risks the chip readout, the start-of-session decision, and
 *  the per-phrase injection silently disagreeing. `targetApp` null (nothing known yet) → no rule, so
 *  global settings apply. Opt-in deep detection is positive-only (only editable===false coerces) and
 *  an explicit per-app insert method opts out — the user already decided how to inject here (e.g.
 *  "konsole → paste": a terminal isn't an editable AT-SPI field, yet the user told us to paste). */
export function resolveInjectionTarget(
  targetApp: FocusedApp | null,
  appRules: AppRule[],
  g: GeneralSettings,
): { rule: AppRule | undefined; notEditable: boolean; method: InsertMethod; pasteShortcut: string[] } {
  const rule = targetApp
    ? appRules.find((r) => r.appId.toLowerCase() === targetApp.appId.toLowerCase())
    : undefined;
  const notEditable = !!(
    g.deepFieldDetection && !rule?.block && !rule?.insertMethod && targetApp?.editable === false
  );
  // A blocked app OR a non-editable target is coerced to clipboard-only: nothing is typed there, but
  // the text isn't lost — it lands on the clipboard for the user to paste.
  const method: InsertCfg["method"] =
    rule?.block || notEditable ? "clipboard" : rule?.insertMethod ?? g.insertMethod;
  const pasteShortcut = rule?.pasteShortcut ?? g.pasteShortcut;
  return { rule, notEditable, method, pasteShortcut };
}

/** Resolve the CURRENT injection target (focused app → per-app rule) into the method +
 *  paste-shortcut to use RIGHT NOW. Called per injection — NOT once at dictation start — so
 *  per-app rules follow window switches mid-session: a latched/live dictation that moves
 *  from Konsole to another app picks up each window's own rule instead of being frozen to
 *  whatever was focused when dictation began. Shares resolveInjectionTarget with startLive. */
async function resolveTarget(): Promise<{ method: InsertCfg["method"]; pasteShortcut: string[]; isSelf: boolean }> {
  const g = useApp.getState().settings.general;
  const appRules = useApp.getState().appRules;
  const targetApp = await getFocusedApp();
  // Our own window is focused → dictation won't type here (the Rust injection guard skips it).
  // Show it as "→ this app" (neutral, no warn hint) and don't match an app rule / field guard.
  if (targetApp?.isSelf) {
    publishTarget(targetApp, null);
    return { method: g.insertMethod, pasteShortcut: g.pasteShortcut, isSelf: true };
  }
  const { rule, notEditable, method, pasteShortcut } = resolveInjectionTarget(targetApp ?? null, appRules, g);
  // Keep the chip's "→ app" readout + skip hint live as focus moves mid-session: this resolves
  // the CURRENT window on every call, so it's the chip's source of truth — not the frozen
  // start-of-session value.
  publishTarget(targetApp ?? null, rule?.block ? "blocked" : notEditable ? "notEditable" : null);
  return { method, pasteShortcut, isSelf: false };
}

/** Push the resolved injection target into the store (deduped) so the chip's "→ app" readout +
 *  skip hint reflect the CURRENT focus. getFocusedApp returns a fresh object each call, so compare
 *  by value to avoid churning a cross-window emit + chip re-render on every poll tick. */
function publishTarget(app: FocusedApp | null, skip: "blocked" | "notEditable" | null): void {
  const cur = useApp.getState();
  const sameApp =
    (cur.targetApp?.appId ?? null) === (app?.appId ?? null) &&
    (cur.targetApp?.title ?? null) === (app?.title ?? null);
  if (sameApp && cur.targetSkip === skip) return;
  cur.setDictation({ targetApp: app, targetSkip: skip });
}

// Poll the focused app while a session is active so the chip tracks window/field switches even
// when you pause between phrases (each injection ALSO re-resolves via resolveTarget). Cheap — a
// cached AT-SPI read — and deduped by publishTarget, so a steady focus never emits/re-renders.
let targetPollTimer: ReturnType<typeof setInterval> | null = null;
const TARGET_POLL_MS = 700;
function startTargetPoll(): void {
  stopTargetPoll();
  // resolveTarget awaits getFocusedApp(), which (unlike the seed reads) does NOT swallow IPC
  // errors. In this fire-and-forget poll there's no caller to surface them, so attach .catch here
  // to avoid an unhandled rejection on each tick — matching every other void-ed IPC in this file.
  const poll = () => void resolveTarget().catch((e) => console.error("target poll failed:", e));
  poll(); // resolve once immediately, then keep it fresh
  targetPollTimer = setInterval(poll, TARGET_POLL_MS);
}
function stopTargetPoll(): void {
  if (targetPollTimer) {
    clearInterval(targetPollTimer);
    targetPollTimer = null;
  }
}

// Hold the "injecting" state at least this long, so the writing-out phase is actually
// perceivable on screen. A sub-frame flash would just read as the chip snapping shut
// the instant you stop — which is the very thing we're fixing.
const MIN_INJECT_VISIBLE_MS = 450;

// A hold PRESS that landed while the previous session was still "finalizing…"/"inserting…"
// (the fast re-press — dictation.ts queues it instead of dropping it). Consumed when the
// session settles: if the chord is still physically held (Rust HeldKeys), the start fires
// and dictation resumes the moment the previous text lands — no second press needed. If the
// user already released, it's dropped (starting then would wedge "listening" with nothing
// left to stop it). Speech during the finalize gap itself is not captured (the mic was closed).
const PENDING_START_MAX_AGE_MS = 15_000;
let pendingHoldStart: { profileId: string; at: number } | null = null;
let pendingStartRunner: ((profileId: string) => void) | null = null;

export function queuePendingHoldStart(profileId: string): void {
  pendingHoldStart = { profileId, at: performance.now() };
}

/** dictation.ts registers its start entry point here (a direct import would be a cycle). */
export function registerPendingStartRunner(run: (profileId: string) => void): void {
  pendingStartRunner = run;
}

function consumePendingHoldStart(): void {
  const pending = pendingHoldStart;
  pendingHoldStart = null;
  const run = pendingStartRunner;
  if (!pending || !run) return;
  if (performance.now() - pending.at > PENDING_START_MAX_AGE_MS) return;
  // Check THE PRESSED PROFILE's chord (its modifier subset — non-modifier keys aren't
  // observable, and a modifier-less chord reads false = never auto-start). Testing the
  // specific chord, not "any modifier", keeps an unrelated held Shift from starting a
  // hold session whose release would never come.
  const chord = useApp.getState().profiles.find((p) => p.id === pending.profileId)?.hotkey ?? [];
  void shortcutModsHeld(chord)
    .then((held) => {
      if (held && useApp.getState().status === "idle") run(pending.profileId);
    })
    .catch(() => {}); // plugin-only backend / IPC failure → treat as released
}

/** Settle the chip to idle, stamping the session's insert outcome (typed/clipboard/none) and
 *  clearing the active profile — the single definition of the end-of-session contract so its
 *  four call sites can't drift. `partial` is deliberately NOT cleared here: the chip's 2 s
 *  collapse linger and Home's 10 s "done" card both keep showing the finished transcript
 *  after settle (the next startLive clears it). Fires a queued fast re-press start last. */
function settleIdle(): void {
  useApp.getState().setDictation({ status: "idle", sessionOutcome: endOutcome(), activeProfile: null });
  consumePendingHoldStart();
}

/** A stream-event handler should fold in / act on a late emit only while genuinely busy — a
 *  post-cancel (idle) or post-error (error) drain emit on the un-advanced epoch must be dropped. */
function inSession(): boolean {
  return isActiveDictation(useApp.getState().status);
}

// Return to idle once the injection queue has fully drained (the text has landed in
// the focused field) — but never before MIN_INJECT_VISIBLE_MS, and never over a status
// that has moved on (a fresh session, or an error that arrived meanwhile).
function settleToIdleAfterInjection(startedAt: number, cfg: InsertCfg | null): void {
  void injectChain.then(() => {
    const wait = Math.max(0, MIN_INJECT_VISIBLE_MS - (performance.now() - startedAt));
    setTimeout(() => {
      // Identity-check the session, not just the status: this `.then` was attached to THIS session's
      // injectChain, but a slow/stuck paste can keep it pending until after a cancel + a fresh session
      // B has independently reached "injecting" — settling on status alone would idle B mid-injection
      // (and stamp its outcome wrong). A normal end keeps insertCfg===cfg; a cancel (→null) or restart
      // (→new object) makes this a no-op. Mirrors the inject tasks' `insertCfg !== cfg` guard.
      if (insertCfg === cfg && useApp.getState().status === "injecting") {
        settleIdle();
      }
    }, wait);
  });
}

// Backstop for a wedged "finalizing…": stopLive() sets "transcribing" and then waits
// for the stream's terminal `closed`. If the socket died silently (suspend, dropped
// link) that event may never arrive, leaving the chip stuck. After this long with no
// resolution we force a clean idle. Streaming only — a batch transcription can take a
// while legitimately (bounded by the HTTP client's own 120 s timeout), and the Rust
// drain deadline (10 s) normally resolves a live stream just before this fires.
const STUCK_FINALIZE_MS = 12_000;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
function clearStuckWatchdog(): void {
  if (stuckTimer !== null) {
    clearTimeout(stuckTimer);
    stuckTimer = null;
  }
}
function armStuckWatchdog(): void {
  clearStuckWatchdog();
  if (activeEndpoint !== "stream") return;
  stuckTimer = setTimeout(() => {
    stuckTimer = null;
    if (useApp.getState().status === "transcribing") {
      console.warn(
        `[dictation] no stream close within ${STUCK_FINALIZE_MS}ms — forcing idle (connection lost?)`,
      );
      // Same "no `closed` will ever arrive" condition as stream://error and the stopLive reject: in
      // stop-timing mode the whole transcript lives only in committedDoc/bankedDoc until the `closed`
      // tail injects it. Read it BEFORE cancelLive() clears those globals, then copy it to the
      // clipboard so a lost connection doesn't silently drop the transcript — the (N+1)th sibling of
      // those two recovery paths. Live mode injected per-phrase already → "". endInjection (chained by
      // cancelLive) is a no-op in stop mode (nothing snapshotted), so there's no clobber race, and
      // cancelLive sets status "idle" synchronously and never re-touches it, so the flashError wins.
      const pending = insertCfg && !insertCfg.live ? (bankedDoc + committedDoc).trim() : "";
      void cancelLive();
      if (pending) {
        void (async () => {
          let onClipboard = false;
          try {
            await injectText({ text: pending, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: [] });
            onClipboard = true;
          } catch (err) {
            console.error("clipboard recovery after stuck-finalize failed:", err);
          }
          // Notify in BOTH branches, mirroring the stream://error / stopLive-reject siblings: on a
          // double failure (link died AND the clipboard copy threw) the text is genuinely lost, so
          // surface it rather than silently idling. (No error payload here — it's a watchdog timeout.)
          flashError(onClipboard ? "Connection lost — your text is on the clipboard to paste manually." : "Connection lost — couldn't recover your text.");
        })();
      }
    }
  }, STUCK_FINALIZE_MS);
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

async function ensureListeners(): Promise<void> {
  if (wired || !isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  const setDictation = useApp.getState().setDictation;

  // The level meter arrives per audio callback (~50–100 Hz). Pushing every sample
  // into the store fans out to a cross-window IPC `emit` + a full overlay re-render
  // on EVERY frame (overlay.ts re-broadcasts on any `level` change) — over a multi-
  // hour session that churn alone bloated the shared WebKitGTK renderer to multiple
  // GB. ~30 Hz is indistinguishable for a level meter, so coalesce: fire on the
  // leading edge, then trail the latest value so the meter still settles to its true
  // resting level instead of freezing mid-throttle.
  const LEVEL_MIN_MS = 33;
  let lastLevelAt = 0;
  let levelTimer: ReturnType<typeof setTimeout> | undefined;
  let latestLevel = 0;
  // Register every stream://* listener through reg() so their unlisten handles are collected, and roll
  // them ALL back if any registration rejects mid-sequence — else the survivors stay live with no
  // handle while `wired` is still false, so the next (serialized) startLive re-registers atop them and
  // each stream://* event gets double-handled (double inject / double cue) until restart.
  const uns: UnlistenFn[] = [];
  const reg = async <T>(event: string, cb: EventCallback<T>): Promise<void> => {
    uns.push(await listen<T>(event, cb));
  };
  try {
  await reg<number>("stream://level", (e) => {
    latestLevel = e.payload;
    // Mic warm-up gate (see startLive): while gating, detect the mic going live. Real
    // audio sits above the digital-silence floor for a couple of consecutive frames; a
    // warming mic delivers zeros and a lone open-click is a single frame. Going live
    // cancels the pending "warming up…" (a warm mic never flashes it) and clears it if
    // already shown, flipping the chip to "listening" + firing the start cue.
    if (warmTimer !== null) {
      if (latestLevel > MIC_LIVE_LEVEL) {
        if (++micLiveHits >= MIC_LIVE_CONFIRM) {
          clearWarmTimer();
          // Real audio flowed → the mic genuinely went live. micLive gates the start/stop cues so
          // they don't fire for a session that starts/ends during warm-up (mic never live).
          setDictation({ warming: false, micLive: true });
        }
      } else {
        micLiveHits = 0;
      }
    }
    // Latch auto-stop (when armed): track silence via the shared speaking detector and end the
    // session after the configured quiet stretch. Fires once, then disarms itself.
    if (autoStopMs > 0) {
      const tNow = performance.now();
      const listening = useApp.getState().status === "listening";
      if (stepSpeaking(autoStopMemo, latestLevel, listening, tNow)) {
        lastSpokeAt = tNow;
      } else if (listening && tNow - lastSpokeAt >= autoStopMs) {
        autoStopMs = 0;
        console.info("[dictation] latch auto-stop: silence threshold reached");
        void stopLive();
      }
    }
    const wait = LEVEL_MIN_MS - (performance.now() - lastLevelAt);
    if (wait <= 0) {
      if (levelTimer) {
        clearTimeout(levelTimer);
        levelTimer = undefined;
      }
      lastLevelAt = performance.now();
      // Same guard as the trailing tick below: the capture thread keeps emitting level for a few ms
      // after cancelLive sets {idle, level:0} and awaits the join (level emits are NOT epoch-gated),
      // so a late leading-edge level must not resurrect a non-zero meter over the just-cleared idle
      // state (it would stick until the next session + churn a cross-window emit). Bookkeeping above
      // stays unconditional so coalescing remains correct regardless of status.
      if (useApp.getState().status === "listening") setDictation({ level: latestLevel });
    } else if (!levelTimer) {
      levelTimer = setTimeout(() => {
        levelTimer = undefined;
        lastLevelAt = performance.now();
        // Only publish while a session is still capturing: this trailing tick is closure-
        // local and can't be cleared on teardown, so if it fires after `closed`/cancelLive
        // froze the meter to 0 it must not resurrect the last non-zero level (it would stick
        // until the next session and churn a needless cross-window emit).
        if (useApp.getState().status === "listening") setDictation({ level: latestLevel });
      }, wait);
    }
  });

  // Rust confirmed real audio on the RAW capture (a few consecutive non-silent chunks — see
  // session.rs LiveDetect). This is the PRIMARY go-live signal: the smoothed+gained level gate
  // below starts from a 0-seeded EMA against a threshold a quiet mic's noise floor only hovers
  // AT, so on such mics it held "warming up…" until the user actually spoke (~2s of grey chip
  // after the latch press). The level gate stays as a fallback (it can only fire later, and the
  // warmTimer guard makes whichever lands first the only one that acts). Same stale-emit safety
  // as level events: the capture thread is joined before the next session starts, and a post-stop
  // arrival no-ops because stopLive/cancelLive already cleared the warm timer.
  await reg<null>("stream://mic-live", () => {
    if (warmTimer !== null) {
      clearWarmTimer();
      setDictation({ warming: false, micLive: true });
    }
  });

  await reg<{ committed: string; pending: string }>("stream://partial", (e) => {
    const live = e.payload.committed + e.payload.pending;
    const sep = committedDoc && live && !/\s$/.test(committedDoc) && !/^\s/.test(live) ? " " : "";
    // A partial can still arrive AFTER stopLive() — the finalize drain emits buffered
    // transcription — or even after `closed`. Update the preview text, but NEVER resurrect
    // "listening" once we've left it: that stuck the indicator at "listening" with the mic
    // already closed, and disabled the stuck-finalize watchdog (which only fires while
    // "transcribing"). Only hold the status / defer per-phrase actions while truly capturing.
    // Drop a late drain partial once the session has fully settled (post-cancel idle / post-error):
    // re-populating `partial` there resurrects a stale preview into an idle/errored chip. A legitimate
    // post-stop drain (transcribing/injecting) still passes and updates the preview. Mirrors the
    // inSession() guard the final/boundary/overrides-ignored handlers already carry.
    if (!inSession()) return;
    const capturing = useApp.getState().status === "listening";
    setDictation(
      capturing
        ? { status: "listening", partial: committedDoc + sep + live }
        : { partial: committedDoc + sep + live },
    );
    // Still speaking → keep deferring the per-phrase actions (Enter / clipboard restore / clipboard
    // phrase boundary) until you actually pause. Armed for any live session, but only while capturing.
    if (insertCfg?.live && capturing) bumpPhraseEnd();
  });

  await reg<{ committed: string; tail: string; last: boolean }>("stream://final", (e) => {
    // A cancelled/errored session's detached drain can still emit a late `final` on the
    // un-advanced epoch (cancelLive/stopRecord don't bump ACTIVE_EPOCH, so emit_if_active
    // still passes). Don't let it resurrect the preview / re-inject after the cancel cleared
    // everything: only fold in a final while genuinely busy. Mirrors the partial handler's
    // `capturing` discriminator — a legitimate post-stop drain runs while transcribing/
    // injecting and the trailing `closed` then idles, so real finals pass; only post-cancel
    // (idle) and post-error (error) late emits are dropped.
    if (!inSession()) return;
    // committed+tail is the whole document so far — fold it in and show it.
    committedDoc = e.payload.committed + e.payload.tail;
    setDictation({ partial: committedDoc });
    // Live mode (append-only): type the newest phrase from `tail` immediately,
    // only ever APPENDING what's new beyond what we've already typed — we never
    // backspace/revise. On the rare occasion the backend re-tidies a seam (e.g.
    // a space before a comma) this can leave a tiny artifact, but nothing is ever
    // un-typed. `injectedText` tracks the backend's document so later phrases
    // append at the right point.
    if (insertCfg?.live) {
      // Snapshot the document synchronously (so it can't change under the queued task), then pick +
      // inject inside the queue after resolving the CURRENT window's rule — so the method/paste-
      // shortcut follow window switches per segment.
      //   • clipboard → just the CURRENT hard-break window (committedDoc) — everything since your
      //     last pause; set_clipboard_persistent replaces the prior owner. It resets each boundary,
      //     so the clipboard never accumulates the whole session.
      //   • typed (paste/direct), append-only → only the new suffix beyond what we've TYPED (diffed
      //     in-queue against injectedText, below). Strip the document's leading whitespace (Whisper
      //     prefixes a space) so the first phrase has none; inner spacing preserved. Never revise.
      const phraseClip = committedDoc.slice(commonPrefixLen(clipBaseline, committedDoc)).trim();
      const target = committedDoc.replace(/^\s+/, "");
      // Did the document GROW vs the last final? Distinguishes a real new phrase from a re-sent
      // `final` (the flush final the drain emits at latch end). Advanced synchronously per final and
      // kept SEPARATE from the typed baseline (injectedText), so re-sent-final detection stays correct
      // regardless of whether/where the phrase actually typed.
      const grew = commonPrefixLen(seenDoc, target) < target.length;
      seenDoc = target;
      // Capture the session token SYNCHRONOUSLY (before the task's awaited resolveTarget) so the task
      // bails on BOTH a cancel (insertCfg→null) AND a cancel-then-fresh-restart (insertCfg→a NEW object)
      // landing during EITHER await — mirrors the stop-timing task (cfg captured before its enqueue).
      // Within a session insertCfg keeps a stable identity, so a normal phrase still injects.
      const cfg = insertCfg;
      enqueueInject(async () => {
        const t = await resolveTarget();
        // Discard a cancelled/superseded session's phrase — don't inject it into the new/refocused
        // window, and don't let the bookkeeping/catches below touch the next session (insertCfg!==cfg
        // catches both a cancel→null and a cancel-then-restart→new object; stopLive keeps cfg, so a
        // normal end-of-session phrase still lands).
        if (insertCfg !== cfg) return;
        // HOLD/PTT must never live-TYPE: the trigger chord is still physically held, so injected keys
        // fold into the held modifier and fire shortcuts — which is why live-in-hold is allowed only
        // when the method is clipboard. At start that's enforced; but focus can move mid-session to a
        // window that resolves to paste/direct, so for a hold session copy the phrase to the clipboard
        // instead (types nothing, recoverable) rather than typing with the chord down.
        const useClipboard = t.method === "clipboard" || insertCfg?.activation === "hold";
        if (useClipboard) {
          // Clipboard: copy just the current hard-break window (everything since your last pause) —
          // never the whole session — so the clipboard doesn't pile up. Each copy flashes the chip's
          // clipboard glyph PER PHRASE (mirroring the typed green pulse) so a latch session shows
          // confirmation continuously. Skip our own window (the injection guard copies nothing there →
          // would be a false confirmation). `grew` is the document-grew guard: false for a re-sent
          // final (the flush final the drain emits at latch end), so a clipboard latch that ends
          // mid-speech doesn't re-copy + re-pulse the last phrase on the re-sent final.
          if (phraseClip.length > 0 && grew) {
            try {
              await injectText({ text: phraseClip, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
            } catch (e) {
              // A live phrase's clipboard copy failed: surface it AND tear the session down. Once
              // flashError sets status "error" no further phrase reaches this catch (the old "just
              // refresh the one red state" model was wrong), so without teardown the Rust capture keeps
              // the mic open + system muted while the rest of the speech is silently dropped.
              console.error("live clipboard insert failed:", e);
              // A cancel / fresh session landed during the await — this reject is the DISCARDED
              // session's, so don't flash a red error or tear down the freshly-started session B.
              if (insertCfg !== cfg) return;
              flashError("Couldn’t copy the text to the clipboard.");
              teardownAfterFatalInject();
              return;
            }
            // A cancel / fresh session that landed during the awaited inject nulled or replaced
            // insertCfg — don't stamp this discarded phrase's bookkeeping onto the idle/next session.
            if (insertCfg !== cfg) return;
            if (!t.isSelf) {
              sessionClipboard = true;
              signalInsert("clipboard");
              // The clipboard now holds THIS clipboard-only transcript (what the user wants to
              // paste), not our earlier paste transcript — so we no longer owe a restore. Clear
              // clipDirty so neither the per-phrase restore (bumpPhraseEnd) nor the end-of-session
              // restore puts the old snapshot back over it. Covers a fast paste→clipboard-only
              // switch with no pause between, which would otherwise leave clipDirty set from the paste.
              clipDirty = false;
              // The clipboard now holds OUR text, so a later paste must NOT re-snapshot it as the
              // user's original (the snapshot guard keys on clipHoldsOurs, not clipDirty).
              clipHoldsOurs = true;
            }
          }
        } else {
          // Typed (paste/direct), append-only. Diff IN-QUEUE against the typed baseline (NOT
          // synchronously): the queue is serial, so a phrase that actually lands advances the
          // baseline before the next phrase diffs — AND a phrase the own-window guard SKIPS (our
          // window focused) leaves the baseline untouched, so after a focus switch that text is
          // re-typed into the real window instead of being silently dropped. Empty toType = a
          // re-sent final or already-typed text → skip.
          const toType = target.slice(commonPrefixLen(injectedText, target));
          if (toType.length > 0) {
            // Snapshot the user's CURRENT clipboard right before this paste overwrites it — per phrase,
            // not once at session start — and only when the clipboard does NOT already hold our own text
            // (clipHoldsOurs false), so we never capture our own transcript. Gating on clipHoldsOurs (not
            // clipDirty) covers the clipboard-only→paste case: a clipboard-only phrase clears clipDirty
            // but leaves our text on the clipboard, which !clipDirty would wrongly re-snapshot.
            if (t.method === "paste" && insertCfg?.restoreClipboard && !clipHoldsOurs && !t.isSelf) {
              // !t.isSelf: when our own window is focused the Rust guard skips the paste, so there's
              // nothing to snapshot/restore — and latching beganInjection/clipDirty here would flash a
              // spurious "injecting" tail AND pin the stale own-window clipboard over a later real paste.
              try {
                await beginInjection();
                beganInjection = true;
              } catch (e) {
                console.error("beginInjection failed:", e);
              }
            }
            // A cancel (insertCfg→null) OR cancel-then-restart (insertCfg→a new object) landing during
            // the awaited beginInjection above must not paste this discarded phrase into the now-
            // refocused / next session's window — mirrors the post-resolveTarget (549) and injectText-
            // catch (631) guards; beginInjection was the lone await between guard and paste left open.
            // Any snapshot taken is restored by cancelLive's unconditional chained endInjection.
            if (insertCfg !== cfg) return;
            try {
              await injectText({ text: toType, method: t.method, autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
            } catch (e) {
              // A live phrase insert failed: surface it, then tear the session down (mirrors
              // stream://error) so the mic + system-mute don't leak — once status is "error" no
              // further phrase reaches this catch.
              console.error("live insert failed:", e);
              // A cancel / fresh session landed during the await — this reject is the DISCARDED
              // session's, so don't recover/flash/teardown the freshly-started session B.
              if (insertCfg !== cfg) return;
              if (t.method === "direct") {
                // Direct typing never touches the clipboard → copy the phrase so it's recoverable.
                try {
                  await injectText({ text: toType, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
                  flashError("Couldn’t type the text — it’s on the clipboard to paste manually.");
                } catch (e2) {
                  console.error("clipboard fallback after failed live insert failed:", e2);
                  flashError("Couldn’t insert the text.");
                }
              } else {
                // Paste failed, but the Rust paste path leaves the transcript on the clipboard on
                // failure (skip-restore-on-failed-paste) AND the teardown below drops the snapshot
                // WITHOUT restoring, so it stays recoverable — surface that (mirrors the direct
                // fallback above and the end-of-session insert), instead of claiming nothing landed.
                flashError("Couldn’t paste the text — it’s on the clipboard to paste manually.");
              }
              teardownAfterFatalInject();
              return;
            }
            // A cancel / fresh session that landed during the awaited inject nulled or replaced
            // insertCfg — don't stamp this discarded phrase's bookkeeping onto the idle/next session.
            if (insertCfg !== cfg) return;
            // A real paste just clobbered the user's clipboard with the transcript → it owes a
            // restore at phrase end. Direct typing never touches the clipboard, so don't — and our own
            // window (guard-skipped, !t.isSelf) clobbered nothing either.
            if (t.method === "paste" && !t.isSelf) {
              clipDirty = true;
              clipHoldsOurs = true;
            }
            // Advance the TYPED baseline + pulse ONLY when the phrase actually landed (NOT our own
            // window, where the guard typed nothing): leaving it un-advanced re-types the skipped
            // text after a focus switch, and a green pulse there would be a false confirmation.
            if (!t.isSelf) {
              injectedText = target;
              sessionTyped = true;
              signalInsert("typed");
            }
          }
        }
      });
      // A phrase's text just landed AND the document actually GREW (`grew` is false for a re-sent
      // final — e.g. the flush `final` the drain emits when you end latch — so we must NOT re-arm
      // for text that was already typed + Entered; doing so is what fired a second Enter at latch
      // end). (Re)start the quiet timer so the per-phrase Enter + clipboard restore fire
      // ~PHRASE_END_QUIET_MS after you stop speaking (not at the ~20s hard break). Ongoing speech
      // keeps bumping the timer via stream://partial.
      if (grew) {
        if (insertCfg.autoEnter) phraseDirty = true;
        bumpPhraseEnd();
      }
    }
  });

  await reg<string>("stream://boundary", (e) => {
    // Same un-advanced-epoch path as `final`/`overrides-ignored`: a cancelled/errored session's
    // detached WS drain can still emit a late boundary. Unlike cancel, a stream://error does NOT
    // null insertCfg, so without this the separator-inject below would land in the now-refocused
    // window after the error handler deliberately suppressed the trailing Enter. Only process a
    // boundary while genuinely busy — post-cancel (idle) / post-error (error) drain emits drop.
    if (!inSession()) return;
    // Long-silence hard break: the server reset its document. Bank what we have (for
    // the stop-timing single insert), drop our live baseline so the next utterance
    // starts fresh, clear the preview, and optionally type the configured separator.
    const sep = e.payload || "";
    // Always bank the finished document for the "stop"-timing single insert (it reads bankedDoc
    // back). Typed live ignores it (resets committedDoc/injectedText below and appends from there),
    // and clipboard-only now ignores it too (it copies just the current window per phrase).
    if (committedDoc) bankedDoc += committedDoc + sep;
    committedDoc = "";
    clipBaseline = "";
    injectedText = "";
    seenDoc = "";
    setDictation({ partial: "" });
    // A hard break = a finished phrase. In live mode, emit (into the window focused NOW)
    // any configured separator AND — when "Press Enter after" is on — a REAL Enter, so each
    // phrase is submitted/newlined as you speak. This is what makes "Press Enter after" work
    // in latch/ongoing dictation, which never reaches the stop-time tail. A "\n" is always a
    // real Enter (a pasted newline gets swallowed by some apps); clipboard-only types nothing
    // (the full transcript is already on the clipboard via bankedDoc).
    // The phrase ended (hard break). The per-phrase Enter is normally driven by the quiet
    // timer (~PHRASE_END_QUIET_MS after you stop, well before this ~20s hard break), so it's
    // already been pressed. Cancel the pending timer; only Enter here as a backstop if it
    // somehow hasn't. When auto-enter is off, fall back to the configured separator behavior.
    clearPhraseEndTimer();
    if (insertCfg?.live) {
      if (insertCfg.autoEnter) {
        if (phraseDirty) enqueueAutoEnter();
      } else if (sep) {
        // Capture the session token synchronously (mirrors the live/stop tasks) so a cancel-then-restart
        // during resolveTarget OR the paste below bails — don't fire a stray separator/Enter into the
        // new/refocused window, nor stamp the old session's clipboard bookkeeping onto session B.
        const cfg = insertCfg;
        enqueueInject(async () => {
          const t = await resolveTarget();
          if (insertCfg !== cfg) return;
          // Hold session: same as enqueueAutoEnter — never emit a keystroke while the PTT chord is held
          // (the held modifier would fold into the separator/Enter once focus moved to a typing window).
          if (t.method === "clipboard" || insertCfg?.activation === "hold") return;
          if (sep.includes("\n")) {
            await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
          } else {
            await injectText({ text: sep, method: t.method, autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
            // A cancel-then-fresh-start during the paste await must not stamp the OLD session's clipboard
            // bookkeeping (clipHoldsOurs / a restore) onto the new one — mirrors the inject tasks' guard.
            if (insertCfg !== cfg) return;
            // The separator paste just clobbered the clipboard with `sep` (set_clipboard + Ctrl+V).
            // (!t.isSelf: an own-window separator is Rust-guard-skipped, so the clipboard is untouched
            // there and the boundary backstop below handles any owed restore — don't touch bookkeeping.)
            if (t.method === "paste" && insertCfg?.restoreClipboard && !t.isSelf) {
              if (beganInjection) {
                // A prior paste snapshotted the user's clipboard — put it back (mirrors the per-phrase
                // restore contract); the snapshot survives in Rust and isn't consumed.
                await restoreClipboardSnapshot();
                clipHoldsOurs = false;
              } else {
                // No prior snapshot: `sep` (OUR text) is on the clipboard. Mark clipHoldsOurs so a later
                // phrase's begin_injection (gated on !clipHoldsOurs) won't snapshot `sep` as the user's
                // original and then permanently restore it over their content.
                clipHoldsOurs = true;
              }
            }
          }
        });
      }
      // The phrase ended hard → restore the clipboard too, as a backstop in case the quiet
      // timer hadn't already (the timer normally fires ~PHRASE_END_QUIET_MS before this). Clear
      // clipHoldsOurs ONLY here (we restored the user's clipboard) — NOT at the unconditional
      // clipDirty=false below, where a clipboard-only-last phrase still holds our text.
      if (clipDirty && beganInjection) {
        clipHoldsOurs = false;
        enqueueRestoreSnapshot();
      }
    }
    phraseDirty = false;
    clipDirty = false;
  });

  await reg<string>("stream://status", (e) => {
    if (e.payload === "ready") {
      // Drop a late `ready` that lands after a stop (a short PTT tap, or a stop during a cold-model
      // handshake delay): stopLive already moved us to "transcribing", and resurrecting "listening"
      // here would make the subsequent `closed` skip its transcribing-gated settle and wedge the chip
      // at "listening" with the mic already closed. startLiveInner sets "listening" before connecting,
      // so a legit ready always passes.
      if (useApp.getState().status !== "listening") return;
      // NOTE: do NOT clear `warming` here. "ready" is just the WS/model handshake and
      // usually arrives BEFORE a cold (Bluetooth) mic finishes warming up — clearing it
      // here would flip the chip to "listening" while the mic is still silent. Warming is
      // cleared only by real audio (the level handler) or the safety timeout.
      setDictation({ status: "listening", dictationError: null });
    } else if (e.payload === "closed") {
      clearStuckWatchdog(); // the stream resolved on its own
      stopTargetPoll(); // session ending — stop tracking focus for the chip
      clearWarmTimer(); // reconcile the warm-up gate: a close that bypasses stopLive/cancelLive
      // (e.g. a silent-mic capture-thread death emits `closed` directly) would otherwise leave the
      // armed backstop running and `warming` stuck true (the chip reads it ungated by status).
      // Stop the pending phrase-end Enter from firing after the session closes; the stop tail
      // below decides the final phrase's Enter. Keep `phraseDirty` for that decision.
      clearPhraseEndTimer();
      // Don't clobber an error — `error` is followed immediately by `closed`.
      const st = useApp.getState();
      if (st.status === "error") {
        setDictation({ level: 0 });
        return;
      }
      // A late `closed` from the drain lands ~6s after the server closed — AFTER the 4s error-linger
      // has already flipped the chip to idle (the error path leaves insertCfg + committedDoc/bankedDoc
      // intact). Re-running the tail here would re-inject the whole transcript into the now-refocused
      // window. Treat an already-settled idle as terminal (post-cancel also lands here with insertCfg
      // null — handled below too, but bailing early is harmless and clearer).
      if (st.status === "idle") {
        setDictation({ level: 0 });
        return;
      }
      // Capture has stopped; freeze the meter and move to "transcribing" (finalizing). No-op on a
      // normal stop (stopLive already set it), but a capture-death / server-initiated close ran no
      // stopLive, so status would still be "listening" — and the no-tail live branch below settles
      // to idle only from "transcribing", so without this a no-tail capture-death close would wedge
      // the chip at "listening" with the mic already gone (no stuck-watchdog runs for it either).
      // From here the hasTail branch moves to "injecting" while the transcript is written out.
      setDictation({ level: 0, warming: false, status: "transcribing" });
      // (The saved recording's transcript .txt sidecar is written in Rust, in the streaming drain —
      // ungated, so a cancelled/superseded session still gets it, matching the batch path.)
      // Release a session that reached `closed` WITHOUT a user stop (capture-thread death / a
      // server-initiated close): stopLive's finish() already removed the session from Rust state, so
      // this is a no-op on a normal stop — but on a never-stopped session it drops the parked session
      // and releases the system-mute guard (otherwise other apps stay muted until the next dictation).
      // Fire-and-forget + idempotent.
      void (activeEndpoint === "batch" ? cancelRecord() : cancelStream()).catch((e) =>
        console.error("closed: release parked session failed:", e),
      );

      const cfg = insertCfg;
      if (!cfg || cfg.timing === "off") {
        settleIdle();
        return;
      }

      const startedAt = performance.now();
      if (cfg.live) {
        // Phrases were written + Enter'd + clipboard-restored live (per phrase, off the quiet
        // timer) as you spoke. The tail handles only what's left when the session ends: a real
        // Enter for the LAST, in-progress phrase — one you ended latch on before pausing, so its
        // quiet-timer Enter never fired — plus a FINAL clipboard restore that also clears the
        // snapshot. `phraseDirty` is true only if that last Enter hasn't already fired (the quiet
        // timer / boundary clear it), and crucially we only set it for a final that GREW the
        // document — so the drain's re-sent flush `final` can't resurrect it into a double Enter.
        // Skip the "injecting" flash when there's no tail work.
        const enterTail = cfg.autoEnter && phraseDirty;
        phraseDirty = false;
        // The final clipboard action is decided once the inject queue has DRAINED (finalClip, run
        // below), reading the LIVE clipDirty: restore the user's clipboard only if it still holds
        // OUR paste transcript; if the last phrase to land was clipboard-only, the clipboard holds
        // the transcript the user wants to paste, so discard the snapshot (clear, no restore). We
        // decide at drain time — not here — so a late paste OR late clipboard-only still queued when
        // `closed` fires is honored on BOTH the tail and the no-tail path. (clipDirty is reset for
        // the next session by startLive's clearPhraseEnd, and microtask ordering guarantees finalClip
        // runs before any new session could reset it.)
        const finalClip = (): Promise<void> =>
          beganInjection ? (clipDirty ? endInjection() : discardInjectionSnapshot()) : Promise.resolve();
        const hasTail = enterTail || beganInjection;
        if (!hasTail) {
          // No visible write-out tail (clipboard-only, direct typing, or nothing landed): skip the
          // "injecting" flash, but still drain the queue before reading the outcome — otherwise the
          // done marker resolves to "none" before sessionTyped/sessionClipboard is set and the
          // glyph/✓ never shows. If a late paste set beganInjection after this sync check, honor its
          // final clipboard restore too (can't double-fire: the injecting branch handles the rest).
          void injectChain.then(() => {
            // Same stale-callback guard as settleToIdleAfterInjection: if a cancel + fresh session B
            // landed while this session's queue was draining, bail — else finalClip reads/clobbers B's
            // beganInjection/clipDirty and settleIdle wrongly idles B from "transcribing" (after which
            // B's own `closed` bails on status "idle" and never injects B's transcript). A's snapshot is
            // already restored by cancelLive's chained endInjection.
            if (insertCfg !== cfg) return;
            void finalClip().catch((e) => console.error("final clip failed:", e));
            if (useApp.getState().status === "transcribing") {
              settleIdle();
            }
          });
          return;
        }
        setDictation({ status: "injecting" });
        if (enterTail) enqueueAutoEnter();
        // Restore/discard once the queue drains (finalClip): restore only if we still owe one, else
        // keep a final clipboard-only transcript on the clipboard (and drop the snapshot).
        enqueueInject(finalClip);
        settleToIdleAfterInjection(startedAt, cfg);
      } else {
        // "stop" (and "live" on a batch profile): insert the whole transcript once, into the
        // window focused NOW (resolved in-queue) — not whatever was focused at start.
        // bankedDoc holds any documents finalized before a hard break this session.
        const text = (bankedDoc + committedDoc).trim();
        if (!text) {
          settleIdle();
          return;
        }
        setDictation({ status: "injecting" });
        enqueueInject(async () => {
          const t = await resolveTarget();
          // A cancel (insertCfg→null) OR a cancel-then-fresh-session (insertCfg→a new object) landing
          // during the awaited resolve must not paste the OLD session's whole transcript into the new/
          // refocused window. Identity-check, mirroring the post-inject guard below + the live tasks;
          // a normal stop keeps insertCfg===cfg so the end-of-session insert still lands.
          if (insertCfg !== cfg) return;
          try {
            await injectText({
              text,
              method: t.method,
              autoEnter: cfg.autoEnter,
              restoreClipboard: cfg.restoreClipboard,
              pasteShortcut: t.pasteShortcut,
            });
          } catch (e) {
            // The whole-session insert IS the product of the dictation. A failure here (portal
            // denied, VK + portal both fail, …) would otherwise drop the entire transcript silently
            // and resolve the chip to a benign-looking "nothing landed" idle. Surface it, and keep
            // the transcript on the clipboard so it's recoverable: paste leaves it there on failure
            // (the Rust skip-restore-on-failed-paste), clipboard-only already put it there, so only
            // direct typing (which never touches the clipboard) needs an explicit copy.
            console.error("end-of-session insert failed:", e);
            // A cancel (insertCfg→null) or a fresh session (insertCfg→a new object) that landed during
            // the awaited injectText must not recover this discarded session's transcript to the
            // clipboard nor flash its error onto the idled/next session (mirrors the success guard below).
            if (insertCfg !== cfg) return;
            // Did the transcript actually end up on the clipboard? paste leaves it there on a failed
            // paste (Rust skip-restore-on-failed-paste) and clipboard-only already put it there; only
            // direct typing needs an explicit copy — and that copy can ALSO fail. Tell the truth
            // either way (mirrors the per-phrase handler), so a double failure doesn't promise a
            // clipboard recovery that isn't there.
            let onClipboard = t.method !== "direct";
            if (t.method === "direct") {
              try {
                await injectText({ text, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
                onClipboard = true;
              } catch (e2) {
                console.error("clipboard fallback after failed insert failed:", e2);
              }
            }
            flashError(
              onClipboard
                ? "Couldn’t insert the text — it’s on the clipboard to paste manually."
                : "Couldn’t insert the text.",
            );
            return;
          }
          // A cancel (insertCfg→null) or a fresh session (insertCfg→a new object) that landed during
          // the awaited injectText must not stamp this finished session's outcome onto the idled/next
          // session's globals — mirrors the live per-phrase tasks' post-inject guard.
          if (insertCfg !== cfg) return;
          // Single end-of-session insert — record the outcome for the done marker (no separate
          // per-phrase pulse; this IS the whole session).
          if (!t.isSelf) {
            if (t.method === "clipboard") sessionClipboard = true;
            else sessionTyped = true;
          }
        });
        settleToIdleAfterInjection(startedAt, cfg);
      }
    }
  });

  await reg<string>("stream://error", (e) => {
    // Drop a cancelled/stopped session's detached-drain late error: stop/cancel don't bump
    // ACTIVE_EPOCH, so a finish()-detached drain that errors after a stop→cancel still passes
    // emit_if_active and would flashError a spurious red chip over the idle chip the user cleared.
    // The first real session error always arrives while busy. Mirrors partial/final/boundary/overrides.
    if (!inSession()) return;
    clearStuckWatchdog();
    stopTargetPoll();
    // Reconcile the warm-up gate, like every other terminal path (stop/cancel/closed): an error
    // during warm-up otherwise leaves the backstop armed, so it fires MIC_WARM_TIMEOUT_MS later and
    // stamps micLive:true onto the errored/idle chip — a spurious go-live that can mis-fire a cue.
    clearWarmTimer();
    // Cancel any pending per-phrase Enter / clipboard-restore. A server error frame is
    // NON-terminal (no prompt `closed`; the real one only arrives ~6s later from the drain),
    // so without this the ~1.2s quiet timer armed by the last `final` would fire a stray Enter
    // into the user's now-refocused window. On error we want no trailing Enter (like cancel).
    clearPhraseEnd();
    // clearPhraseEnd cancelled the pending per-phrase clipboard restore, so a pasted phrase would
    // leave the clipboard holding the transcript (and the un-consumed snapshot would leak into the
    // next session, whose begin_injection keeps the prior snapshot). Restore the user's clipboard: a
    // swap ONLY, no keystroke, so nothing lands in the now-refocused window (unlike a stray Enter).
    // Capture the queue (with any in-flight paste) and restore UNCONDITIONALLY once it drains — we
    // must NOT re-read beganInjection here: it's set only INSIDE the queued paste task (a sync read
    // misses a paste in flight), AND a fast error-recovery re-trigger runs startLive, which resets
    // beganInjection to false before this drains (which would wrongly skip the restore + leak the
    // snapshot). end_injection is idempotent — it take()s the snapshot, a no-op when none was taken —
    // so the unconditional call restores exactly the sessions that snapshotted, no double-restore.
    const owed = injectChain;
    void owed.then(() => endInjection()).catch((err) => console.error("end injection on error failed:", err));
    // Stop-timing streaming injects the WHOLE transcript only from the `closed` tail — which never runs
    // after an error (closed bails on status "error", and we retire the epoch below). So an error mid-
    // session would silently lose the fully-assembled transcript with no recovery, unlike every other
    // failure path. Copy it to the clipboard (swap only, no keystroke into the refocused window) so it
    // stays recoverable. Read synchronously before the async copy (committedDoc/bankedDoc are left
    // intact by the error path, reset only by the next startLive). Live mode injected per-phrase → "".
    // endInjection above is a no-op in stop mode (beganInjection false → nothing snapshotted), so no race.
    const pending = insertCfg && !insertCfg.live ? (bankedDoc + committedDoc).trim() : "";
    // Null insertCfg (AFTER reading it for `pending`) so a live phrase still queued behind the error
    // can't type/paste into the now-refocused window after the session errored — mirrors cancelLive /
    // teardownAfterFatalInject. endInjection is chained on `owed` above, so any snapshot still restores.
    insertCfg = null;
    console.error("stream error:", e.payload);
    if (pending) {
      void (async () => {
        let onClipboard = false;
        try {
          await injectText({ text: pending, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: [] });
          onClipboard = true;
        } catch (err) {
          console.error("clipboard recovery after stream error failed:", err);
        }
        flashError(onClipboard ? `${e.payload} — your text is on the clipboard to paste manually.` : e.payload);
      })();
    } else {
      flashError(e.payload);
    }
    // Tear down the Rust capture session so the mic closes and system audio
    // un-mutes immediately — the dead WS task doesn't drop it, so without this the
    // mic light + speaker mute linger until the next dictation. The visible error
    // status is preserved (the subsequent `closed` keeps it; we don't reset to idle).
    const endpoint = activeEndpoint;
    activeEndpoint = null;
    void (endpoint === "batch" ? stopRecord() : stopStream()).catch((err) =>
      console.error("stream error teardown failed:", err),
    );
    // Retire the epoch so the detached drain (kept, so the sidecar still writes) can't bleed a late
    // final/closed onto a session re-triggered during the 4s error linger. Independent of the stop
    // above so it fires even if that rejects. Mirrors the cancel-path retire.
    void retireSessionEpoch().catch((err) => console.error("retire epoch on error failed:", err));
  });

  // The server refused one or more decode overrides because the field is
  // admin-locked (reported in the stream `ready` frame). Non-blocking FYI;
  // cleared at the start of the next dictation.
  await reg<string[]>("stream://overrides-ignored", (e) => {
    // Same un-advanced-epoch path as `final`: ignore a cancelled/errored session's late drain
    // emit so a stale overrides-ignored notice can't appear after the session was dropped. The
    // legitimate emit rides the `ready` frame (status already "listening") or the batch drain
    // (transcribing), so real notices pass.
    if (!inSession()) return;
    setDictation({ overridesIgnored: e.payload });
  });
  } catch (e) {
    // A mid-sequence import/listen reject: roll back every listener already registered so none are
    // orphaned (wired stays false below → the next startLive retries with a clean single set), then
    // rethrow so startLive's catch surfaces the failure.
    for (const un of uns) {
      try {
        un();
      } catch {
        /* best-effort teardown */
      }
    }
    throw e;
  }
  // Set the once-only flag ONLY after every registration succeeded: a rejected import/listen otherwise
  // leaves `wired` true forever, so every later startLive short-circuits here and opens a session with
  // NO stream://* handlers (mic + system-mute open, chip stuck, no transcript, until restart). Deferring
  // it lets the next start retry. Safe: the sole caller (startLiveInner) is serialized by startLive's
  // startingSession guard, so this await window admits no concurrent ensureListeners (no double-register).
  wired = true;
}

/** Merge a Backend's decode defaults with a Profile's overrides (profile wins per
 *  field). Only true-inherit (undefined/null) is dropped, so a field reaches the server
 *  when explicitly set. NB: an empty string "" is a SET value, not inherit — the text
 *  fields (hotwords, suppress_tokens, prepend/append_punctuations) expose an explicit
 *  "clear" (DecodeFields' Eraser button) that sends "" to suppress the inherited value,
 *  exactly like the prompt 3-state; dropping "" here silently lost that clear (and let a
 *  backend value win over a profile's clear). Numbers/bools never produce "" (the number
 *  input maps ""→undefined), so keeping "" only affects the text fields. Returns undefined
 *  when nothing is set — the wire then carries no decode_overrides at all. */
function mergeDecodeOverrides(
  base?: DecodeOverrides,
  over?: DecodeOverrides,
): DecodeOverrides | undefined {
  const out: Record<string, unknown> = {};
  for (const src of [base, over]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== null) out[k] = v;
    }
  }
  return Object.keys(out).length ? (out as DecodeOverrides) : undefined;
}

/** How long a dictation error lingers on the chip before it auto-clears back to idle. Without
 *  this a transient failure (server unreachable, refused start) sticks forever — most visibly
 *  with the persistent dock on, where the chip never hides on its own (overlay.ts keeps it shown
 *  while the dock is enabled, so its error hide-timer never runs). */
const ERROR_LINGER_MS = 4000;
let errorClearTimer: ReturnType<typeof setTimeout> | null = null;

/** Tear down a live session whose per-phrase injection just failed fatally. flashError has already
 *  set status "error", so inSession() is now false and no further phrase will land — without this the
 *  Rust capture keeps the mic open, holds the system-audio mute, and the target poll keeps firing for
 *  a dead session (and a HOLD/PTT chord-release "stop" is dropped, since status is no longer
 *  listening/processing). Mirrors the stream://error teardown EXCEPT the clipboard: a failed
 *  paste/clipboard phrase leaves the transcript on the clipboard for manual recovery (what the error
 *  message promises), so drop the snapshot WITHOUT restoring (restoring would clobber the transcript;
 *  clipDirty is false on a failed paste, so the end-of-session drain would discard it the same way). */
function teardownAfterFatalInject(): void {
  clearStuckWatchdog();
  stopTargetPoll();
  clearWarmTimer();
  clearPhraseEnd();
  // Null insertCfg (like cancelLive) so any inject task still QUEUED behind the failed one bails on
  // its `insertCfg !== cfg` guard — its only gate — instead of typing/pasting a phrase and firing a
  // green "inserted" pulse onto the now-red error chip. Safe: the failing task `return`s without
  // re-reading insertCfg, and the late drain `closed` bails on status "error"/"idle" before it would
  // read insertCfg at the tail. endInjection is still chained on `owed` below, so snapshots restore.
  insertCfg = null;
  const owed = injectChain;
  void owed
    .then(() => discardInjectionSnapshot())
    .catch((err) => console.error("discard injection snapshot after fatal inject failed:", err));
  const endpoint = activeEndpoint;
  activeEndpoint = null;
  void (endpoint === "batch" ? stopRecord() : stopStream()).catch((err) =>
    console.error("teardown after fatal inject failed:", err),
  );
  // Retire the epoch (drain kept → sidecar still writes) so its late final/closed can't bleed onto a
  // session re-triggered during the error linger. Mirrors the stream://error teardown + cancel paths.
  void retireSessionEpoch().catch((err) => console.error("retire epoch after fatal inject failed:", err));
}

/** Show an error on the chip, then auto-clear it to idle after ERROR_LINGER_MS so it doesn't stick.
 *  Guarded: if a new session starts first (status leaves "error"), the pending clear is a no-op. */
function flashError(message: string): void {
  pendingHoldStart = null; // don't chain a queued start onto a failed session
  // Clear the live preview too (like level:0 freezes the meter): the error supersedes it, and
  // otherwise the stale `partial` lingers in the store — when the error auto-clears to idle the
  // Home transcript card (which lingers longer than the error) would flip from the red message to
  // the leftover preview text labelled "done". cancelLive/startLive clear it on their paths; the
  // error auto-clear didn't. Clear `warming` for the same reason: a start-failure lands here with
  // warming:true AND the warm-timer backstop already cancelled (start-reject catch), so without this
  // the chip would stay stuck on "warming up…" (read ungated) and expanded until the next session.
  useApp.getState().setDictation({ status: "error", dictationError: message, level: 0, partial: "", warming: false });
  if (errorClearTimer) clearTimeout(errorClearTimer);
  errorClearTimer = setTimeout(() => {
    errorClearTimer = null;
    if (useApp.getState().status === "error") {
      useApp.getState().setDictation({ status: "idle", dictationError: null, activeProfile: null });
    }
  }, ERROR_LINGER_MS);
}

// Synchronous in-flight guard for startLive. dictate()'s isBusy() gate reads `status`,
// but startLiveInner doesn't flip status to "listening" until AFTER its awaits
// (ensureListeners + getFocusedApp). Without this, two triggers landing inside that window
// both pass the gate and launch overlapping sessions — and because stream and record are
// independent Rust states, a stream+batch double-fire leaves one session's capture thread +
// system-mute guard leaked when the later stop routes to only the other endpoint. Ignoring
// the second concurrent start closes that window; the finally guarantees the flag resets
// even if a pre-status await (ensureListeners/getFocusedApp) rejects.
let startingSession = false;
// A stop/cancel trigger that arrives DURING the start prologue (before startLiveInner flips status
// to "listening") finds status still "idle", so dictate()'s stopOrCancel no-ops it. For HOLD/PTT a
// fast tap releases the chord inside that window — the emitted "stop" would be dropped and the
// session left wedged "listening" forever (the chord is already released, nothing re-triggers a
// stop). This records that a stop is owed; startLiveInner honors it the moment the session is up.
let stopRequestedDuringStart = false;

/** Called by dictate()'s stopOrCancel when status is idle/error: if a session is mid-start (status
 *  not yet "listening"), remember a stop was requested so the starting session is torn down as soon
 *  as it goes live (a short tap-dictation) instead of wedging. Returns whether a start was in flight. */
export function requestStopIfStarting(): boolean {
  if (!startingSession) return false;
  stopRequestedDuringStart = true;
  return true;
}

/** Read-only: is a session currently mid-start (the prologue is running but status hasn't flipped to
 *  "listening" yet)? dictate()'s START path uses this to no-op a concurrent cross-profile start —
 *  isBusy() only reads `status`, which is still "idle" through the prologue, so without this a second
 *  start would overwrite the in-flight session's activeProfile and then no-op on the guard below. */
export function isStarting(): boolean {
  return startingSession;
}

export async function startLive(
  backend: Backend,
  deviceId: string | null,
  activation: ActivationKind,
  pov?: { language?: string; prompt?: string; decodeOverrides?: DecodeOverrides; overrideProfile?: string; endpoint?: EndpointKind },
): Promise<void> {
  if (startingSession) return;
  startingSession = true;
  stopRequestedDuringStart = false; // fresh start; a prologue stop sets it (see requestStopIfStarting)
  // Cancel a prior error's lingering auto-clear timer: its body nulls activeProfile + blips the chip
  // to idle, guarded only by status==="error" at fire time. A re-trigger during the ~1s start prologue
  // (status stays "error" until startLiveInner sets "listening") would otherwise let it fire on the
  // now-live session, stranding it with activeProfile=null (wrong chip tag + usage attribution).
  // flashError re-arms its own timer on any fresh failure, so dropping the stale one is safe.
  if (errorClearTimer) {
    clearTimeout(errorClearTimer);
    errorClearTimer = null;
  }
  try {
    await startLiveInner(backend, deviceId, activation, pov);
  } catch (e) {
    // startLiveInner awaits ensureListeners() + getFocusedApp() BEFORE its own try/catch, so a
    // reject there (e.g. an AT-SPI error out of get_focused_app) escapes to here. Surface it and
    // log — otherwise it leaks as an unhandled rejection through every `void startLive(...)` caller
    // (Home toggle, dictate, runOverlayAction) and the user sees nothing. Nothing is armed yet at
    // the prologue stage (warm timer / target poll / activeEndpoint), so there's nothing to undo.
    console.error("start dictation failed (prologue):", e);
    flashError(String(e));
  } finally {
    startingSession = false;
  }
}

async function startLiveInner(
  backend: Backend,
  deviceId: string | null,
  activation: ActivationKind,
  pov?: { language?: string; prompt?: string; decodeOverrides?: DecodeOverrides; overrideProfile?: string; endpoint?: EndpointKind },
): Promise<void> {
  await ensureListeners();
  const setDictation = useApp.getState().setDictation;
  const s = useApp.getState().settings;
  const g = s.general;
  const rec = s.recording;
  // Arm latch auto-stop (0 = off): end a hands-free session after N min of continuous silence.
  // Hold/push-to-talk ends on key-release, so this is latch-only. Disarmed by stopLive/cancelLive.
  autoStopMemo = newSpeakMemo();
  lastSpokeAt = performance.now();
  autoStopMs = activation !== "hold" && rec.latchAutoStopMin > 0 ? rec.latchAutoStopMin * 60_000 : 0;
  // Effective values: a set per-Profile override wins; else inherit the Backend.
  const language = pov?.language?.trim() ? pov.language.trim() : backend.language;
  // prompt is a 3-state sentinel sent to the backend: undefined → omit (inherit the
  // server DEFAULT_PROMPT); "" → explicit clear (no initial_prompt); value → use it.
  // A profile that set its prompt (incl. an explicit "" clear) wins; else the
  // backend's prompt; an empty backend prompt means inherit, so omit.
  const prompt =
    pov?.prompt !== undefined ? pov.prompt : backend.prompt !== "" ? backend.prompt : undefined;
  const decodeOverrides = mergeDecodeOverrides(backend.decodeOverrides, pov?.decodeOverrides);
  // A set per-Profile override-profile name wins; else inherit the Backend's.
  const overrideProfile = pov?.overrideProfile?.trim() ? pov.overrideProfile.trim() : backend.overrideProfile;
  // A set per-Profile endpoint wins; else inherit the Backend's (stream vs batch transport).
  const endpoint = pov?.endpoint ?? backend.endpoint;

  // Per-app rule (P16): the focused app at start decides block/method/paste-shortcut. Resolved
  // once here — you dictate into the app you triggered from — via the shared resolveInjectionTarget
  // (same policy resolveTarget re-runs per phrase, so the frozen start value can't diverge).
  const targetApp = await getFocusedApp();
  // Our own window is focused at start → dictation won't type here (the Rust injection guard skips
  // it), so don't match an app rule or field guard and don't coerce to clipboard-only / flash a
  // "not a text field" skip on our own window. Mirror resolveTarget's isSelf short-circuit, which
  // the per-phrase path already applies — without this the start-of-session resolution diverged.
  const { rule, notEditable, method, pasteShortcut } = targetApp?.isSelf
    ? { rule: undefined, notEditable: false, method: g.insertMethod, pasteShortcut: g.pasteShortcut }
    : resolveInjectionTarget(targetApp ?? null, useApp.getState().appRules, g);

  insertCfg = {
    timing: g.insertTiming,
    method,
    pasteShortcut,
    autoEnter: g.autoEnter,
    restoreClipboard: g.restoreClipboard,
    targetApp: targetApp ?? null,
    blocked: rule?.block ?? false,
    notEditable,
    activation,
    // Hold/PTT holds the chord the whole time → live TYPING collides with the held modifier,
    // so paste/direct fall back to the single insert-on-release ("stop"). Clipboard-only types
    // nothing, so it can run live in any activation — it just refreshes the clipboard per segment.
    live:
      g.insertTiming === "live" &&
      endpoint === "stream" &&
      (method === "clipboard" || activation !== "hold"),
  };
  committedDoc = "";
  injectedText = "";
  seenDoc = "";
  bankedDoc = "";
  beganInjection = false;
  sessionTyped = false;
  sessionClipboard = false;
  clearPhraseEnd();
  injectChain = Promise.resolve();
  clearStuckWatchdog(); // fresh session — drop any leftover backstop

  // P16/D: surface the injection target + why (if at all) it's coerced to clipboard, for the
  // chip's "→ app" readout. blocked (per-app rule) takes precedence over the deep-detect guard.
  const targetSkip = insertCfg.blocked ? "blocked" : insertCfg.notEditable ? "notEditable" : null;
  setDictation({
    status: "listening",
    // Warm-up gate: grey "warming up…" from the first frame (never an amber "listening"
    // flash before the mic is live); cleared by real audio or the safety timeout below.
    warming: true,
    micLive: false, // fresh session: the mic hasn't gone live yet (gates the start/stop cues)
    partial: "",
    level: 0,
    dictationError: null,
    overridesIgnored: [],
    targetApp: insertCfg.targetApp,
    targetSkip,
    // Clear any prior session's done marker / pulse so the fresh session starts clean.
    lastInsert: null,
    sessionOutcome: null,
  });
  // Warm-up gate: hold "warming up…" until real audio actually flows (a cold/Bluetooth
  // mic is silent for ~1–2s first). The level handler clears it on sustained real audio
  // (a single open-blip is ignored); a safety timeout caps it. micLiveHits resets here.
  micLiveHits = 0;
  clearWarmTimer();
  warmTimer = setTimeout(() => {
    warmTimer = null;
    // Safety cap: treat the mic as live even if no audio was detected (a genuinely-silent-but-live
    // mic should still cue), so micLive lets the start cue fire here too.
    useApp.getState().setDictation({ warming: false, micLive: true });
  }, MIC_WARM_TIMEOUT_MS);
  activeEndpoint = endpoint;
  startTargetPoll(); // keep the chip's target readout live as focus moves during the session

  // The clipboard snapshot for "restore after" is taken PER PHRASE now, just before each paste
  // (see the live `final` handler) — not once here — so it tracks what you actually had on the
  // clipboard at each phrase, and a session that starts in a non-paste window still restores once
  // it pastes. beginInjection is no longer called at session start.

  // Per-device address override ("use this URL on this device") wins over the
  // synced canonical serverUrl for the actual connection.
  const sessionServerUrl = effectiveServerUrl(backend, useApp.getState().settings);
  try {
    if (endpoint === "batch") {
      await startRecord({
        serverUrl: sessionServerUrl,
        backendId: backend.id,
        model: backend.model,
        language,
        prompt,
        decodeOverrides,
        overrideProfile,
        deviceId,
        save: rec.saveRecordings,
        recordingsDir: rec.recordingsDir,
        trimSilence: rec.trimSilence,
        muteSystem: rec.muteSystemAudio,
      });
    } else {
      await startStream({
        serverUrl: sessionServerUrl,
        backendId: backend.id,
        model: backend.model,
        language,
        prompt,
        decodeOverrides,
        overrideProfile,
        responseFormat: backend.responseFormat,
        deviceId,
        save: rec.saveRecordings,
        recordingsDir: rec.recordingsDir,
        trimSilence: rec.trimSilence,
        muteSystem: rec.muteSystemAudio,
      });
    }
    // A stop landed during the start prologue (a fast PTT tap released the chord before status was
    // "listening", so stopOrCancel no-op'd against idle). The session is up now → stop it promptly
    // (a short tap-dictation) instead of leaving it wedged "listening" with the chord released.
    if (stopRequestedDuringStart) {
      stopRequestedDuringStart = false;
      void stopLive();
    }
  } catch (e) {
    clearWarmTimer();
    // The start invoke rejected before any stream exists, so no closed/error event will fire to
    // tear these down — do it here, else the 700ms focus-poll interval leaks (republishing a
    // stale target forever) and activeEndpoint stays set.
    stopTargetPoll();
    activeEndpoint = null;
    console.error("start dictation failed:", e);
    flashError(String(e));
  }
}

export async function stopLive(): Promise<void> {
  autoStopMs = 0; // disarm latch auto-stop — we're stopping now
  clearWarmTimer(); // drop the warm-up gate if we stop before the mic went live
  // Streaming: server flushes + drains. Batch: transcription runs now. Either way the
  // `closed` event then moves us "transcribing" → "injecting" (while the text is
  // written out) → "idle" — so the chip shows progress the whole way through.
  // Clear `warming` too: stopping DURING warm-up (before the mic went live) otherwise
  // left the chip stuck on "warming up…" instead of showing "finalizing…".
  useApp.getState().setDictation({ status: "transcribing", warming: false });
  // Guard against a `closed` that never comes (socket died mid-finalize).
  armStuckWatchdog();
  try {
    if (activeEndpoint === "batch") await stopRecord();
    else await stopStream();
  } catch (e) {
    // A rejected stop would otherwise wedge the chip at "finalizing…" — batch has no stuck-
    // watchdog (it's stream-only), so surface the error to return the UI to a clear state.
    // Also tear down the focus-poll + endpoint here, mirroring startLiveInner's reject path: a
    // rejected stop means no stream is left to emit `closed`, so nothing else stops the 700ms
    // targetPollTimer (it would republish a stale target forever) or resets activeEndpoint, and
    // the stuck-watchdog can't recover it (flashError flips status to "error", which gates off its
    // status==="transcribing" cancelLive).
    clearStuckWatchdog();
    stopTargetPoll();
    activeEndpoint = null;
    // The detached drain (if any) can still emit a late final/closed on this epoch; retire it so it
    // can't bleed onto a session re-triggered during the error linger (mirrors stream://error).
    void retireSessionEpoch().catch((err) => console.error("retire epoch on stop-reject failed:", err));
    // No `closed` will follow a rejected stop, so the closed handler's per-phrase teardown never
    // runs — mirror the stream://error handler: cancel the ~1.2s quiet timer so a pending live-mode
    // phrase can't fire a stray auto-Enter into the now-refocused window, and restore the user's
    // clipboard unconditionally once the queue drains (endInjection is idempotent) so a pasted
    // phrase doesn't strand our transcript or leak the snapshot into the next session.
    clearPhraseEnd();
    const owed = injectChain;
    void owed.then(() => endInjection()).catch((err) => console.error("end injection on stop failed:", err));
    console.error("stop dictation failed:", e);
    // Mirror the stream://error recovery: no `closed` follows a rejected stop (epoch retired above +
    // closed bails on "error"), so the stop-timing transcript would be silently lost. Copy the
    // assembled committedDoc+bankedDoc to the clipboard. endInjection above is a no-op in stop mode
    // (nothing snapshotted), so there's no clobber race; committedDoc/bankedDoc aren't reset by stopLive.
    const pending = insertCfg && !insertCfg.live ? (bankedDoc + committedDoc).trim() : "";
    // Null insertCfg (AFTER reading it for `pending`) so a LIVE phrase still queued behind the rejected
    // stop can't type/paste into the now-refocused window and pulse a green/amber "inserted" onto the
    // red error chip — the 4th sibling of stream://error / teardownAfterFatalInject / cancelLive, which
    // all null it (this catch mirrored every OTHER teardown step but missed this one). endInjection is
    // chained on `owed` above, so any snapshot still restores; the recovery below doesn't read insertCfg.
    insertCfg = null;
    if (pending) {
      void (async () => {
        let onClipboard = false;
        try {
          await injectText({ text: pending, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: [] });
          onClipboard = true;
        } catch (err) {
          console.error("clipboard recovery after stop reject failed:", err);
        }
        flashError(onClipboard ? `${String(e)} — your text is on the clipboard to paste manually.` : String(e));
      })();
    } else {
      flashError(String(e));
    }
  }
}

/** Hard-reset dictation to idle immediately: abort the in-flight session, drop the
 *  pending transcript, and return the UI to idle. This is the escape hatch for a
 *  wedged "finalizing…"/"inserting…" — where the stream died (suspend / dropped link)
 *  and the normal stop path is waiting on an event that will never arrive. Also
 *  re-applies the hotkey bindings, since a suspend can leave a hold-to-talk chord
 *  stuck "down" in the evdev backend (a dropped key-release) — so the one action
 *  recovers both the recording state AND the shortcuts. */
export async function cancelLive(): Promise<void> {
  autoStopMs = 0; // disarm latch auto-stop
  pendingHoldStart = null; // a deliberate cancel also voids a queued fast re-press
  clearWarmTimer();
  clearStuckWatchdog();
  stopTargetPoll();
  committedDoc = "";
  injectedText = "";
  seenDoc = "";
  bankedDoc = "";
  // If we snapshotted the clipboard for live paste, give the user's original back and clear the
  // snapshot so it can't leak into the next session (end_injection restores + consumes it).
  // Chain it on the existing queue so it runs AFTER any in-flight paste — calling it directly
  // would race a still-running paste (the restore could win and the paste reads the wrong
  // clipboard). Then reset the queue for the next session.
  // Chain endInjection() unconditionally on the in-flight queue, NOT gated on `beganInjection`:
  // that flag is set true INSIDE the queued paste task, AFTER beginInjection() already snapshotted
  // the clipboard. A cancel that lands while a phrase's paste is in flight (snapshot taken, flag not
  // yet set) would otherwise skip the restore and strand the user's clipboard with our transcript.
  // end_injection is idempotent (g.take() restores+consumes when a snapshot exists, no-op otherwise),
  // so the unconditional call restores exactly the sessions that snapshotted, with no double-restore.
  const pending = injectChain;
  void pending.then(() => endInjection()).catch((e) => console.error("end injection failed:", e));
  beganInjection = false;
  // Reset the per-phrase insert-feedback flags too (startLiveInner does, on the next start). Without
  // this, the cancelled session's detached drain emits a late stream://status:"closed" on the
  // un-advanced epoch; the closed handler's insertCfg===null branch then re-stamps sessionOutcome via
  // endOutcome(), which would read the STALE typed/clipboard flags and flip the cancel's intended
  // "none" to a false "typed"/"clipboard" — firing a bogus "Inserted"/"Copied" chip pulse on a
  // CANCELLED session. Reset here so endOutcome() returns "none" and the late re-stamp is a no-op.
  sessionTyped = false;
  sessionClipboard = false;
  clearPhraseEnd();
  insertCfg = null;
  injectChain = Promise.resolve();
  useApp
    .getState()
    // Cancelled → no done marker (outcome "none"); clear any pending per-phrase pulse.
    // `warming: false` so a cancel during warm-up doesn't strand the chip on "warming up…".
    .setDictation({ status: "idle", warming: false, partial: "", level: 0, dictationError: null, targetApp: null, targetSkip: null, sessionOutcome: "none", lastInsert: null, activeProfile: null });
  const endpoint = activeEndpoint;
  activeEndpoint = null;
  try {
    // ABORT, don't finish: a cancel discards the in-flight session, so skip the drain (streaming) /
    // the transcription POST (batch) — they'd produce a result we immediately throw away. This also
    // releases the system-mute guard right away.
    if (endpoint === "batch") await cancelRecord();
    else await cancelStream();
  } catch (e) {
    console.error("cancelLive: cancel failed:", e);
  }
  // Clear any stuck hardware-hotkey state (re-enumerates keyboards → fresh held-set). Use the
  // capture-aware variant: cancelLive runs on system://resumed, and if a binding capture is in
  // progress the suspend-watch deliberately left shortcuts suspended — re-arming here would let the
  // user's next chord both rebind AND fire dictation. The capture-end reregister re-arms when done.
  try {
    await reregisterShortcutsUnlessCapturing();
  } catch (e) {
    console.error("cancelLive: reregister shortcuts failed:", e);
  }
}
