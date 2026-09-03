// Live streaming dictation: start/stop a session and fold the Rust `stream://*`
// events into the store (status / level / live transcript) and into the focused
// app (text injection).
//
// Injection timing (per-Profile "Type as I speak"):
//   • off   — insert the whole transcript once, when dictation stops.
//   • on    — insert each phrase AS YOU FINISH IT (streaming backends only, and
//             only when the Profile's activation is hands-free — never hold; see below).
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
import { translateFailureDoorway } from "./errors";
import { attachRecordingPath, recordDictation } from "./transcriptHistory";
import { enqueueOutcome } from "./usageOutcome";
import { backendPrompt, effectiveServerUrl } from "./backends";
import { effectiveServerKind } from "./serverKind";
import { refreshCaps, translationWarm } from "./capabilities";
import { acquireWarm, preloadPlanFor, type WarmLease } from "./preload";
import { ownProp } from "./own";
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
  audioBasePref,
  translateText,
  cancelTextTranslation,
  getTranscribeProgress,
} from "./api";
import {
  newAbortHandle,
  runDictationTranslate,
  translateModeFor,
  type TranslateFailure,
} from "./dictationTranslate";
import { newCaptureIdBook } from "./captureIds";
import type { ActivationKind, AppRule, BatchProgress, Backend, DecodeOverrides, EndpointKind, FocusedApp, GeneralSettings, InsertionOverrides, InsertMethod, Profile } from "./types";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { isActiveDictation } from "./dictationVisual";
import { normalizeAppId } from "./sanitize";

let wired = false;

// Auto-stop a hands-free session after a configured stretch of continuous silence (0 = off).
// Reuses the SAME speaking detector as the chip (lib/speaking), so "silence" means exactly what the
// chip shows as not-green; fires the normal stop (which drains the last phrase). Armed per session in
// startLive, disarmed on any stop/cancel.
let autoStopMemo: SpeakMemo = newSpeakMemo();
let autoStopMs = 0;
let lastSpokeAt = 0;

let activeEndpoint: "stream" | "batch" | null = null;
// Is the mic still open? NOT the same question as `activeEndpoint !== null`, which stays
// set through the finalize drain — this one goes false the moment capture ends (a user
// stop, a `closed`, a teardown). It exists because a per-phrase translate makes the
// status "translating" WHILE STILL CAPTURING, and the stop-vs-cancel branches key on that
// status: they need to know whether there is a live mic behind it. See isGracefulStop.
let capturing = false;
/** True while the Rust capture session is live (the mic is open). */
export function isCapturing(): boolean {
  return capturing;
}

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
// Coalescing state for `stream://partial` (see the handler). MODULE scope, not the listener
// closure, because `partial` has five writers and only one of them is that handler: `final`
// folds the utterance into `committedDoc` and republishes, `boundary` clears it, and
// startLiveInner / cancelLive / flashError reset it. A trailing tick armed up to
// PARTIAL_MIN_MS earlier would otherwise fire AFTER any of those and overwrite it with the
// pre-`final` text — a write REORDERING the unthrottled handler could not produce, since it
// wrote synchronously in arrival order. `inSession()` cannot catch it: it stays true through
// `boundary`, through the post-`final` drain, and into a fresh session. So every other writer
// calls `resetPartialPreview()` and the tick has nothing stale left to publish.
const PARTIAL_MIN_MS = 33;
let lastPartialAt = 0;
let partialTimer: ReturnType<typeof setTimeout> | undefined;
let latestPartial: string | null = null;
function resetPartialPreview(): void {
  if (partialTimer) {
    clearTimeout(partialTimer);
    partialTimer = undefined;
  }
  latestPartial = null;
}
function flushPartial(): void {
  if (latestPartial === null) return;
  lastPartialAt = performance.now();
  // Status is re-read HERE, not carried from the frame — same rule the level ticks follow. A
  // trailing tick fires up to PARTIAL_MIN_MS after its frame, and asserting the frame-time
  // "listening" then would resurrect the status the handler's own guard exists to protect.
  const cur = useApp.getState();
  const capturingNow = cur.status === "listening";
  cur.setDictation(
    capturingNow ? { status: "listening", partial: latestPartial } : { partial: latestPartial },
  );
}
// The exact text we've TYPED into a non-self field so far (live mode), so we can diff the next
// document against it and append only what's new. Advanced in the inject queue ONLY when a phrase
// actually lands (NOT for a phrase the own-window guard skips) — so after a focus switch, text
// dictated while our own window was focused is re-typed rather than silently dropped.
let injectedText = "";
// The last final's document (advanced synchronously per final), used ONLY for the "did the document
// grow" guard — distinguishes a real new phrase from a re-sent `final` (the flush final emitted at
// hands-free end), independent of whether/where it was typed. Separate from `injectedText` so the typed
// baseline can be type-time/own-window-aware without breaking re-sent-final detection.
let seenDoc = "";
// Documents completed before a hard break, accumulated for the "stop"-timing single
// insert. Live mode types as it goes, so it doesn't read this back.
let bankedDoc = "";
/** Ceiling on `bankedDoc`, matching Rust's `MAX_SIDECAR_BYTES` on the same per-boundary
 *  accumulation — see the bank site for why the frontend copy needed its own. */
const MAX_BANKED_DOC = 8 * 1024 * 1024;
// Clipboard-only phrase boundary. committedDoc grows across phrases until the backend's long-silence
// hard break — which can be many seconds away, far too late to feel like "just my last phrase". So we
// detect the phrase boundary client-side: `clipBaseline` is the committedDoc text already copied as
// PRIOR phrases; the current clipboard phrase is committedDoc beyond it. Advanced by the phrase-end
// quiet timer (you paused → start fresh), reset at each hard break + session start.
let clipBaseline = "";
/** The session accumulators as they stood before the current clipboard window's first
 *  booking. The clipboard is REPLACED per window, and every final inside one quiet window
 *  re-copies the whole window — so each booking replaces the window's earlier one instead of
 *  appending "A", then "A B". Null = nothing booked in this window yet. */
let clipBooked: { text: string | null; ctxLen: number } | null = null;
/** The per-language tracks for the current clipboard window.  Each final in a clipboard-live
 *  window re-translates the GROWING window, so `accumulateByLang` must receive the LAST
 *  (complete) translation only — not every growing prefix. This buffer replaces on each
 *  final; `bumpPhraseEnd` / `clearPhraseEnd` flush it into `sessionByLang` once. */
let clipByLang: Record<string, string> | undefined;
// Insertion config captured at dictation start.
interface InsertCfg {
  /** Whether the session inserts at all. "off" is gone from the UI; it survives here only
   *  so a config mid-migration still reads as it did. */
  timing: "off" | "stop" | "live";
  method: "paste" | "direct" | "clipboard";
  pasteShortcut: string[]; // chord for the paste method (KeyboardEvent.code list)
  /** The Profile's insertion overrides, frozen for the session — the one layer that CAN'T
   *  be re-read live (see resolveTarget). The app-rule layer above it stays live per phrase,
   *  which is the whole point: rules follow window switches, the profile does not change
   *  mid-session.
   *
   *  `autoEnter`/`restoreClipboard` deliberately do NOT live here as resolved values any
   *  more. They used to be frozen at start, which meant an app rule could not govern them —
   *  two controls on one App Rules screen with opposite semantics. They now come off
   *  `resolveTarget`'s result at each site, like `method` always has. */
  profileInsertion?: InsertionOverrides;
  live: boolean; // timing !== "off", hands-free (or clipboard in any mode), on a streaming backend
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

// ── Dictation history capture ────────────────────────────────────────────────
// Everything known at session START, frozen at module scope: by settle time the
// startLiveInner locals (backend/model/language) are long gone and settleIdle
// itself clears activeProfile. Cleared by cancelLive so a cancelled session's
// late `closed` can never record it.
let sessionMeta: {
  startedAt: number;
  backendId: string;
  /** The address the session talked to (per-device override applied) — the outcome
   *  post must go to the same server that holds the job. */
  serverUrl: string;
  /** The client-minted session id sent as the stream handshake's `client_job`; null for
   *  a batch-endpoint session, which the server keys itself (no outcome is posted). */
  clientJob: string | null;
  model: string;
  language: string;
  profileName?: string;
  profileTag?: string;
  activation?: "hold" | "handsfree";
  appId?: string;
  appTitle?: string;
  blocked: boolean;
} | null = null;
/** Set once the session's outcome has been queued (settle OR cancel — never both). */
let sessionOutcomeReported = false;

/** Queue this session's end-of-session facts for `POST /v1/usage/outcome` (lib/usageOutcome.ts).
 *  Once per session: settleIdle reports the truthful delivery, cancelLive reports "none".
 *  The app id goes only with "Report the app I dictate into" on and never for a target an
 *  App rule blocked (the same promise the history capture keeps). Words and audio seconds
 *  are the server's own — it counted the utterances. */
function reportSessionOutcome(delivery: "typed" | "clipboard" | "none"): void {
  const meta = sessionMeta;
  if (!meta || !meta.clientJob || sessionOutcomeReported) return;
  sessionOutcomeReported = true;
  const translation = sessionInsertSkipped
    ? "aborted"
    : sessionTranslation == null
      ? "not_asked"
      : sessionTranslatedText != null
        ? "translated"
        : "kept_original";
  const reportApp = useApp.getState().settings.recording.reportTargetApp !== false;
  const appId = reportApp && !meta.blocked ? meta.appId?.trim().slice(0, 64) : undefined;
  enqueueOutcome(meta.backendId, meta.serverUrl, {
    job_id: meta.clientJob,
    activation: meta.activation ?? "hold",
    delivery,
    translation,
    ...(appId ? { app_id: appId } : {}),
  });
}
// The saved .wav's path (Rust `stream://recording`, epoch-gated). Usually lands
// BEFORE settle (both save sites run before the terminal closed/final) — but a
// slow disk can invert that, so a late arrival patches the already-saved record.
let sessionRecordingPath: string | null = null;
let capturedRecordId: string | null = null;

// ── T2T dictation translation (per-profile "Translate output") ──────────────
// Frozen per session from Backend→Profile translationOverrides; target set =
// every injection carries the translation instead of the original. All doc
// bookkeeping (committedDoc/injectedText/seenDoc/clipBaseline) stays in
// ORIGINAL text — only the outbound copy is swapped — so phrase diffing,
// history capture and recovery paths are structurally untouched.
/** The session's resolved translation context WITHOUT targets, kept so a settle-time pick
 *  can create a translation the Profile didn't configure (`applySessionTargets`). Set at
 *  every session start, even when `sessionTranslation` itself is null. */
let sessionTranslationBase: Omit<NonNullable<typeof sessionTranslation>, "targets"> | null = null;
/** What `translateExpect.per_utterance` told the server at session start — the only time it
 *  can be said. Read by `maybeTranslate` so a phrase waits for a capture id only when one was
 *  asked for; `applyReclassify` can flip `insertCfg.live` later, but not this. */
let sessionPerUtteranceDeclared = false;
let sessionTranslation: {
  targets: string[];
  /** The resolved source language (null = let the server detect it). */
  source?: string | null;
  includeOriginal?: boolean;
  model?: string;
  glossary?: string;
  mode?: "fluent" | "faithful";
  contextSegments?: number;
  serverUrl: string;
  backendId: string;
  /** Is this server's translation model resident? Seeded at session start from
   *  the forced capability refresh (`translationWarm`), which can still leave it
   *  `null` on a backend that reports no model inventory — null is treated as
   *  cold, so the first phrase gets the long budget. A landed translate proves it
   *  regardless, and every later phrase then takes the short warm formula. */
  warm?: boolean | null;
} | null = null;
/** The session's model pre-warm lease. Held from startLiveInner to whichever
 *  teardown runs first; a leaked one would POST /v1/models/preload every two
 *  minutes for the life of the app, so EVERY exit path releases it. */
let warmLease: WarmLease | null = null;

/** Idempotent by construction (WarmLease.release is), so the overlapping
 *  teardown paths — a cancel arriving after an error frame — can all call it. */
function releaseWarmLease(): void {
  warmLease?.release();
  warmLease = null;
}

// Stop-timing: the translated text that actually got injected (History keeps both).
let sessionTranslatedText: string | null = null;
/** The same text, accumulated PER LANGUAGE across the session's phrases.
 *
 *  In live mode each phrase is translated separately and its already-joined
 *  blob used to be appended to the previous one with a space — so phrase 2's
 *  German ran straight into phrase 1's French and a multi-target session
 *  collapsed into `DE EN FR DE EN FR…` in a single paragraph, with even the
 *  blank-line boundaries destroyed at every phrase seam. Accumulating by
 *  language instead keeps each track continuous and readable, and is what
 *  History renders. */
let sessionByLang: Record<string, string[]> = {};
/** This session's capture ids, keyed by the utterance ordinal both the `final`
 *  and `captured` frames carry. See captureIds.ts for why the pairing has to be
 *  by ordinal and not by arrival order. */
const captureIds = newCaptureIdBook();

/** Fold a phrase's per-language translations into the session accumulator. */
function accumulateByLang(byLang: Record<string, string> | undefined): void {
  if (!byLang) return;
  for (const [lang, text] of Object.entries(byLang)) {
    const t = text.trim();
    if (!t) continue;
    (sessionByLang[lang] ??= []).push(t);
  }
}

/** The session's tracks as finished strings, or undefined when empty. */
function sessionTracks(): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [lang, parts] of Object.entries(sessionByLang)) {
    // A blank line per phrase, mirroring how the phrases were injected: each
    // one is its own block, so a track reads as paragraphs rather than as one
    // run-on sentence stream.
    const joined = parts.join("\n\n").trim();
    if (joined) out[lang] = joined;
  }
  return Object.keys(out).length ? out : undefined;
}
// One "translation failed" doorway per session, not one per phrase.
let sessionTranslateWarned = false;
/** Why this session's last translate didn't land — kept for the session-end
 *  readout (a timeout on a cold model reads very differently from a refused
 *  request). Reset per session alongside sessionTranslateWarned. */
let sessionTranslateFailure: TranslateFailure | null = null;
/** What a running dictation translate would need to abort SERVER-side: a lost
 *  race leaves the GPU working on text nobody will read (Rust waits on the
 *  request for TEXT_TRANSLATE_TIMEOUT = 1 h). Module-level for the same reason
 *  as transcribeRun's `activeCancel`: the teardown paths must reach it without
 *  a component or a closure. */
let activeTranslateCancel: { serverUrl: string; backendId: string; progressId: string } | null = null;
/** Trips the in-flight translate so it resolves with the ORIGINAL text NOW. */
let activeTranslateAbort: ReturnType<typeof newAbortHandle> | null = null;
/** Stop the server working on a translation we've stopped waiting for.
 *  IDEMPOTENT, and deliberately so — the teardown paths overlap (a cancel
 *  during a stop, an error then a cancel) and each may fire it: take-and-null
 *  means the second call has nothing to send, and the API answers 404 for an
 *  id the server already retired. Never call it on a FINISHED translation. */
export function cancelDictationTranslate(): void {
  const target = activeTranslateCancel;
  activeTranslateCancel = null;
  if (target) void cancelTextTranslation(target).catch(() => {});
}
/** Give up on the in-flight translate immediately: the awaiting inject task
 *  resolves with the ORIGINAL text and proceeds normally — the user's words
 *  still land, which is exactly what the existing toast already promises — and
 *  the server is told to stop. Unlike cancelDictationTranslate this doesn't
 *  wait out the remaining budget. */
export function abortDictationTranslate(): void {
  activeTranslateAbort?.abort();
}
// Live mode: recent ORIGINAL phrases, sent as context for the next phrase.
let sessionPhraseContext: string[] = [];
const PHRASE_CONTEXT_MAX = 3;

/** What a phrase translate produced, and whether it actually translated.
 *
 *  `translated` used to be inferred as `out !== in`, which is wrong twice over:
 *  a translation that legitimately equals the original reads as a failure, and
 *  it forced every caller to re-derive a fact this function already knew. */
interface PhraseOut {
  text: string;
  translated: boolean;
  byLang?: Record<string, string>;
}

/** The gap between consecutive PHRASES of a translated live session.
 *
 *  One blank line already separates the languages WITHIN a phrase (the
 *  `\n\n` join in runDictationTranslate), so phrases need a wider gap or the
 *  two boundaries are indistinguishable — you cannot see where one phrase's
 *  French ends and the next phrase's German begins.
 *
 *  It also has to be inserted explicitly, because the two paths disagreed
 *  about whitespace: a translated phrase is trimmed and joined, arriving with
 *  no leading space at all, while a phrase whose translation was abandoned is
 *  the raw document slice and keeps Whisper's leading space. That asymmetry is
 *  what glued an untranslated German phrase onto the end of the previous
 *  phrase's French line. */
const PHRASE_GAP = "\n\n\n";

// ── Cold-translate progress ─────────────────────────────────────────────────
// A cold llama.cpp server spends tens of seconds downloading/loading the GGUF
// before a single token is produced. The chip's "translating…" alone reads as a
// hang for that long, so the stop-timing one-shot (the only path that waits
// that long) publishes a phase label from the server's progress entry.
// Same vocabulary as the retro-translate card: downloading → a real fraction,
// loading → indeterminate, translating → a real fraction.
//
// This module no longer runs its own interval: runDictationTranslate polls the
// SAME endpoint for EVERY phrase (that poll is how it tells a slow server from
// a wedged one) and hands each reading here, so one poll now serves both. The
// early-out below is what keeps a live phrase's polling invisible — the phase
// card only exists for the cold one-shot.
function foldTranslatePhase(p: BatchProgress): void {
  const cur = useApp.getState().dictationPhase;
  if (!cur) return; // the phase was cleared (settled/cancelled) — a late poll adds nothing
  const pct = typeof p.progress === "number" ? Math.min(1, Math.max(0, p.progress)) : undefined;
  switch (p.stage) {
    case "downloading":
      useApp.getState().setDictation({
        dictationPhase: { ...cur, label: "Downloading the translation model…", pct },
      });
      break;
    case "loading":
      // No fraction exists for a GGUF load — leave the bar indeterminate rather
      // than inventing one from the elapsed time.
      useApp.getState().setDictation({
        dictationPhase: { ...cur, label: "Loading the translation model…", pct: undefined },
      });
      break;
    case "translating":
      useApp.getState().setDictation({
        dictationPhase: { ...cur, label: "Translating…", pct },
      });
      break;
    default:
      break; // no entry yet (the request hasn't registered the id) — keep what we show
  }
}
/** Translate `text` for injection, or return it unchanged (no target set,
 *  timeout, failure, superseded session). Never throws; warns once.
 *
 *  A thin adapter over runDictationTranslate: this half owns the SESSION state
 *  (identity re-check, the once-per-session doorway, warm knowledge, the cold
 *  progress phase); the logic and the budget table live in dictationTranslate,
 *  where they are testable without Tauri. */
async function maybeTranslate(
  text: string,
  cfg: InsertCfg | null,
  opts?: { oneShot?: boolean; queued?: number; utterance?: number | null },
): Promise<PhraseOut> {
  const tr = sessionTranslation;
  if (!tr || !text.trim()) return { text, translated: false };
  const context = sessionPhraseContext.slice(-PHRASE_CONTEXT_MAX);
  const abort = newAbortHandle();
  activeTranslateAbort = abort;
  const oneShot = opts?.oneShot === true;
  // This request's progress id, so the `finally` below only drops ITS OWN cancel handle:
  // a translate abandoned by a teardown outlives its session (up to the cold budget), and
  // an unconditional clear here nulled the NEXT session's handle — leaving that translate
  // un-cancellable on the server and wiping its progress card.
  let myProgressId: string | null = null;
  try {
    // Pair this phrase with ITS OWN capture row before the request goes out.
    // The one-shot claims nothing: it translates the whole transcript in one
    // call, so there is no single utterance whose receipt it completes — and
    // taking "the most recent id" (what it used to do) meant stealing the last
    // live phrase's receipt.
    // …and only when this session TOLD the server to hold per-utterance receipts. A hold
    // session opens with `live` off and declares `per_utterance: false`; when its hands-free
    // superset upgrades it in place (`applyReclassify`) the phrases take the live path, but
    // the server was never asked for receipts and sends no `captured` frame — waiting for
    // one would park every phrase for the full timeout.
    const capturedId = await captureIds.take(
      oneShot || !sessionPerUtteranceDeclared ? null : (opts?.utterance ?? null),
    );
    const r = await runDictationTranslate(
      {
        text,
        context,
        targets: tr.targets,
        source: tr.source ?? null,
        includeOriginal: tr.includeOriginal,
        model: tr.model,
        glossary: tr.glossary,
        // A LIVE phrase is always translated faithfully, whatever the profile asks for.
        //
        // Live sends `[...context, phrase]` and consumes ONLY THE LAST result. Fluent mode
        // is sentence-MERGED, so the server may redistribute a sentence across output
        // segments — and when it folds the phrase's opening clause into the preceding
        // context segment, that segment is discarded and the user gets a beheaded
        // translation ("…überprüft, und dabei…"). It shows up per-target, so one language
        // can arrive whole while another is truncated from the same request.
        //
        // The one-shot path keeps the profile's choice: it translates the WHOLE transcript
        // in one call and consumes every segment, so merging is a benefit there, not a
        // hazard. `mode` is therefore a stop-timing setting in practice — the Profile
        // editor greys it out and says so when this session types as it speaks.
        mode: translateModeFor(oneShot, tr.mode),
        contextSegments: tr.contextSegments,
        serverUrl: tr.serverUrl,
        backendId: tr.backendId,
        // Completes the server-side receipt THIS utterance is waiting on.
        capturedId,
        warm: tr.warm ?? null,
        oneShot,
        queued: opts?.queued ?? 0,
        abort,
        onStart: ({ progressId, cold }) => {
          myProgressId = progressId;
          activeTranslateCancel = { serverUrl: tr.serverUrl, backendId: tr.backendId, progressId };
          // Only the one-shot waits long enough for the silence to read as a
          // hang; a live phrase's 20 s cap lands while the user is still
          // talking, and a per-phrase progress card would fight the chip.
          if (oneShot && cold) {
            useApp.getState().setDictation({
              dictationPhase: {
                kind: "translating",
                label: "Translating…",
                startedAt: Date.now(),
                cold: true,
                cancellable: true,
              },
            });
          }
        },
        // Every reading the stall detector takes. foldTranslatePhase no-ops
        // unless a phase card is up, so a live phrase's polls stay silent.
        onProgress: foldTranslatePhase,
      },
      {
        translate: translateText,
        cancel: cancelTextTranslation,
        // Deliberately NOT wrapped in a .catch: the stall detector has to see
        // the rejection to know the endpoint is unreachable (it then falls back
        // to the ceiling alone). Swallowing it here would look like a server
        // reporting the same progress forever, i.e. a stall.
        pollProgress: getTranscribeProgress,
      },
    );
    // Recorded BEFORE the supersede check: a translation that succeeded proves
    // the model is resident whether or not this phrase still has a session to
    // land in, and throwing that away made the NEXT phrase pay the cold
    // allowance all over again.
    if (r.ok) tr.warm = true;
    if (insertCfg !== cfg) return { text, translated: false }; // superseded — caller bails on its own guard too
    if (r.ok) {
      // A later success clears a previous phrase's failure: the latch is read at session
      // END, and reporting a failure when every phrase after the cold start translated fine
      // (the normal trajectory) misleads both the chip marker and the history record.
      sessionTranslateFailure = null;
      return { text: r.text, translated: true, byLang: r.byLang };
    }
    sessionTranslateFailure = r.cause ?? "error";
    console.error("dictation translation failed:", r.error ?? r.cause);
    // The chip's ✕ ("Insert the original now") is the only producer of "cancelled": the
    // user asked for exactly this outcome, so it is not reported back as a failure.
    if (r.cause !== "cancelled" && !sessionTranslateWarned) {
      sessionTranslateWarned = true;
      // Keep the dictation-specific promise ("your words still landed") but
      // name the cause instead of leaving it a mystery (truthful-toast rule).
      useApp.getState().setLogsDoorway(translateFailureDoorway(sessionTranslateFailure, r.error));
    }
    return { text, translated: false };
  } finally {
    if (activeTranslateAbort === abort) activeTranslateAbort = null;
    // The request is over either way — drop the cancel handle so a later
    // teardown can't cancel a progress id that already completed. Identity-checked,
    // like the abort handle above: never drop a newer session's.
    if (activeTranslateCancel && activeTranslateCancel.progressId === myProgressId) {
      activeTranslateCancel = null;
      if (useApp.getState().dictationPhase) {
        useApp.getState().setDictation({ dictationPhase: null });
      }
    }
  }
}

/** Translate one LIVE phrase, reporting it as its own stage.
 *
 *  The status flip is why this wrapper exists: a per-phrase translate can take
 *  seconds, and without it the chip claims "listening" while the machine is
 *  actually working — the one lie the shared visual SSOT exists to prevent.
 *
 *  It restores whatever status it displaced (rather than assuming "listening"):
 *  the live path runs while the mic is open, the tail path while injecting. And
 *  it restores ONLY if nothing else moved us on — a stop, cancel or error landing
 *  during the wait owns the status from then on, and re-stamping "listening" over
 *  a teardown would wedge the chip on a session that no longer exists. */
async function translatePhrase(
  text: string,
  cfg: InsertCfg | null,
  opts?: { queued?: number; utterance?: number | null },
): Promise<PhraseOut> {
  if (!sessionTranslation) return { text, translated: false };
  const before = useApp.getState().status;
  useApp.getState().setDictation({ status: "translating" });
  try {
    return await maybeTranslate(text, cfg, opts);
  } finally {
    if (useApp.getState().status === "translating" && isActiveDictation(before)) {
      useApp.getState().setDictation({ status: before });
    }
  }
}

/** Save the finished session to History — the settleIdle hook. Skips: empty
 *  sessions, App-rules-blocked targets, and the "Keep dictation history" off
 *  switch. Runs once per session (capturedRecordId latch). Returns whether a record
 *  was written by THIS call — the chip's "not inserted · saved to History" note must
 *  only promise a record that exists. */
function captureDictationHistory(): boolean {
  const meta = sessionMeta;
  if (!meta || capturedRecordId) return false;
  if (meta.blocked) return false; // blocked apps are never recorded (the setting's promise)
  if (useApp.getState().settings.transcribe?.keepDictationHistory === false) return false;
  const text = (bankedDoc + committedDoc).trim();
  if (!text) return false;
  try {
    capturedRecordId = recordDictation({
      text,
      startedAt: meta.startedAt,
      durationMs: Math.max(0, Date.now() - meta.startedAt),
      backendId: meta.backendId,
      model: meta.model,
      language: meta.language,
      appId: meta.appId,
      appTitle: meta.appTitle,
      profileName: meta.profileName,
      profileTag: meta.profileTag,
      activation: meta.activation,
      insertMethod: endOutcome(),
      recordingPath: sessionRecordingPath ?? undefined,
      translatedText: sessionTranslatedText ?? undefined,
      translationTarget: sessionTranslation?.targets.join(", "),
      translationInjected: sessionTranslatedText != null,
      // The tracks kept apart, plus the target list as an ARRAY. The joined
      // `translationTarget` above stays for records already on disk, but it
      // is display-only: RouteBadge needs the parts, and a 3+ target list was
      // being truncated mid-code.
      translations: sessionTracks(),
      translationTargets: sessionTranslation
        ? [...sessionTranslation.targets]
        : undefined,
      includeOriginal: sessionTranslation?.includeOriginal || undefined,
      // Without these, a failed translation is indistinguishable in History from a
      // session that never had translation configured — the record would quietly
      // present the original as the intended output.
      translationAttempted: sessionTranslation != null,
      translationFailure: sessionTranslateFailure ?? undefined,
    });
    return true;
  } catch (e) {
    // History is a convenience — it must never break the session settle.
    console.error("dictation history capture failed:", e);
    return false;
  }
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
// not just once at stop (which an ongoing hands-free session never reaches).
let clipDirty = false;
// Whether the clipboard currently holds OUR dictated transcript (vs the user's original). Distinct
// from clipDirty (= restore-debt): a clipboard-only phrase clears the debt yet still leaves our text
// on the clipboard, so the per-phrase snapshot must gate on THIS, not clipDirty — else the next paste
// re-snapshots our own text as the user's "original" and the later restore clobbers their content.
let clipHoldsOurs = false;
let phraseEndTimer: ReturnType<typeof setTimeout> | null = null;
const PHRASE_END_QUIET_MS = 1200;
// Chord family: a hands-free superset completed during the start prologue (insertCfg not
// built yet) — startLiveInner applies the upgrade right after it exists. Cleared on
// every fresh start and on cancel so a stale flip can't latch an unrelated session.
let pendingReclassify: Profile | null = null;
// Serialise every injection op so backspaces/types never interleave or race.
let injectChain: Promise<void> = Promise.resolve();
/** Pending links on `injectChain`. The queue is fed by `stream://final`, whose rate the untrusted
 *  server chooses — Rust bounds each FIELD at MAX_TRANSCRIPT and the message at MAX_WS_MESSAGE,
 *  but emits one Final per frame with no rate or count limit — and it drains at one
 *  `resolveTarget()` per task, i.e. a `get_focused_app` IPC round trip plus an AT-SPI/D-Bus query
 *  on Linux: tens of milliseconds. Each queued closure retains its `target` and `phraseClip`, so
 *  the backlog holds up to two 4 MiB strings per link in the shared WebKitGTK renderer, and every
 *  link is also one more AT-SPI query amplified from one frame. `bankedDoc` was given an 8 MiB
 *  budget for exactly this shape; the queue that holds a full copy of each document had none. */
let injectDepth = 0;
/** Far above any legitimate backlog — real speech produces finals seconds apart and the queue
 *  drains in tens of ms, so a depth this large means the server is emitting faster than the
 *  machine can inject, which is the flood and not a user. Dropping the newest rather than the
 *  oldest keeps the text already committed to the queue intact. */
const MAX_INJECT_DEPTH = 64;
function enqueueInject(fn: () => Promise<void>): void {
  if (injectDepth >= MAX_INJECT_DEPTH) {
    console.warn(`inject queue at ${injectDepth} — dropping this insert (server outpacing injection)`);
    return;
  }
  injectDepth++;
  injectChain = injectChain
    .then(fn)
    .catch((e) => console.error("inject failed:", e))
    .finally(() => {
      injectDepth--;
    });
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
    const t = await resolveTarget(cfg);
    if (insertCfg !== cfg) return;
    // Never fire a real keystroke for a HOLD session, even after focus moved to a paste/direct window:
    // the PTT chord is still physically held, so the Enter would fold into the held modifier (mirrors
    // the live-final useClipboard guard). A hold session is clipboard-coerced, so nothing was typed here.
    if (holdCoerced(cfg?.activation, t.method)) return;
    // The target decides: an app rule can turn Enter off for this window even when the
    // profile/global has it on (a chat client submits, an editor must not).
    if (!t.autoEnter) return;
    await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId });
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
    // No autoEnter gate here: it is a property of the WINDOW being typed into, which only
    // resolveTarget knows. enqueueAutoEnter tests it after resolving and returns if unwanted.
    if (phraseDirty) {
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
    clipBooked = null;
    if (clipByLang) { accumulateByLang(clipByLang); clipByLang = undefined; }
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
  clipBooked = null;
  if (clipByLang) { accumulateByLang(clipByLang); clipByLang = undefined; }
}

/** Must this injection go to the CLIPBOARD rather than the keyboard?
 *
 *  Two independent reasons, and both have to be checked at every keystroke site:
 *   • the resolved method really is clipboard-only, or
 *   • this is a HOLD session, whose trigger chord is physically held for its whole
 *     duration — so any injected key folds into the held Ctrl/Alt/Super and fires a
 *     shortcut in the focused app instead of typing. Live-in-hold is therefore allowed
 *     only for clipboard; that is enforced at session start, but focus can move
 *     mid-session to a window whose rule resolves to paste/direct, so the check has to
 *     repeat per phrase.
 *
 *  Extracted because it was written out five times across three files. Four of those
 *  were the same expression; the fifth (`applyReclassify`) had silently dropped a term
 *  while its comment claimed it recomputed the others "exactly". */
export function holdCoerced(activation: ActivationKind | undefined, method: InsertMethod): boolean {
  return method === "clipboard" || activation === "hold";
}

/** May this session deliver phrase-by-phrase as the user speaks?
 *
 *  Three independent preconditions, all of which have to hold:
 *   • the user asked for it (per-Profile "Type as I speak");
 *   • the transport can deliver partial results at all — batch sends the audio once and
 *     answers once, so there are no live phrases to insert;
 *   • per-phrase delivery is SAFE, which is not the same question as `holdCoerced`.
 *
 *  That last term is the subtle one, and inverting `holdCoerced` gets it wrong. The two
 *  ask different things:
 *
 *    holdCoerced  — "must THIS keystroke go to the clipboard?"  clipboard OR hold
 *    liveAllowed  — "is per-phrase delivery safe at all?"       clipboard OR not-hold
 *
 *  Clipboard-only is a live-ENABLER, not a blocker: it types nothing, so it is safe under
 *  a held chord and may run live in any activation — it just refreshes the clipboard per
 *  phrase. `!holdCoerced` would forbid exactly that, and would also forbid the ordinary
 *  hands-free + clipboard-only session. (Caught by insertionResolve.test.ts, which is why
 *  the two predicates are stated separately rather than one defined from the other.)
 *
 *  `activation` is the RUNTIME value, not the Profile's: the Home button and the chip's
 *  quick-launch both start a hold Profile hands-free, so a Profile-only test would be
 *  wrong for exactly those two entry points. */
export function liveAllowed(args: {
  /** Did the user ask for it? (Item 6 moves this from the global insert-timing to a
   *  per-Profile "Type as I speak"; the other two terms are unaffected either way.) */
  wants: boolean;
  endpoint: EndpointKind;
  activation: ActivationKind;
  method: InsertMethod;
}): boolean {
  const deliverySafe = args.method === "clipboard" || args.activation !== "hold";
  return args.wants && args.endpoint === "stream" && deliverySafe;
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
  /** The running Profile's overrides, FROZEN at session start. Absent for callers with no
   *  session context (QuickAdd's correct-on-close paste), which then resolve global ← rule
   *  exactly as they always did. */
  prof?: InsertionOverrides,
): {
  rule: AppRule | undefined;
  notEditable: boolean;
  method: InsertMethod;
  pasteShortcut: string[];
  autoEnter: boolean;
  restoreClipboard: boolean;
  /** Our own window is focused — nothing is typed here, and no app rule matched. */
  isSelf: boolean;
} {
  // Our own window is focused → dictation won't type here (the Rust injection guard skips it).
  // Don't match an app rule or the field guard, and don't coerce to clipboard-only.
  //
  // Folded IN here rather than left at the two call sites that used to open-code it. Both
  // read `g.insertMethod`/`g.pasteShortcut` directly, which was already the cause of one
  // documented divergence — and with a Profile layer they would have silently ignored it.
  // This function's own docblock forbids exactly that duplication.
  if (targetApp?.isSelf) {
    return {
      rule: undefined,
      notEditable: false,
      method: prof?.insertMethod ?? g.insertMethod,
      pasteShortcut: prof?.pasteShortcut ?? g.pasteShortcut,
      autoEnter: prof?.autoEnter ?? g.autoEnter,
      restoreClipboard: prof?.restoreClipboard ?? g.restoreClipboard,
      isSelf: true,
    };
  }
  // Normalize BOTH sides, not just the stored key. The rule floors already run `normalizeAppId`,
  // but the live id comes from Rust's `bounded_server_text`, whose character class is not the same
  // one — so an app naming itself with an invisible character (a variation selector, U+2800, the
  // combining grapheme joiner) publishes an id the normalized key can never equal, and a rule that
  // reads "Blocked — never typed here" silently stops blocking. Normalizing the live id here is
  // what keeps the fix from inverting: doing it on the rule alone would break the Windows case,
  // where an exe basename may legitimately carry such a character.
  //
  // Both injecting windows route through this function, so this covers the main window and QuickAdd
  // in one place. `expectAppId` still crosses to Rust raw, so the sink re-check is unchanged.
  const liveId = targetApp ? normalizeAppId(targetApp.appId).toLowerCase() : null;
  const rule =
    liveId !== null
      ? appRules.find((r) => normalizeAppId(r.appId).toLowerCase() === liveId)
      : undefined;
  const notEditable = !!(
    g.deepFieldDetection && !rule?.block && !rule?.insertMethod && targetApp?.editable === false
  );
  // A blocked app OR a non-editable target is coerced to clipboard-only: nothing is typed there, but
  // the text isn't lost — it lands on the clipboard for the user to paste.
  //
  // Precedence for the four preference fields: constraint > app rule > profile > global.
  // The CONSTRAINT (block / notEditable) applies to `method` only — a blocked app is already
  // clipboard-only, and the `holdCoerced` guards downstream suppress the Enter from there.
  // Below it the app rule wins over the profile because it expresses what the TARGET can
  // accept, and an unachievable preference is not satisfiable.
  const method: InsertCfg["method"] =
    rule?.block || notEditable
      ? "clipboard"
      : rule?.insertMethod ?? prof?.insertMethod ?? g.insertMethod;
  const pasteShortcut = rule?.pasteShortcut ?? prof?.pasteShortcut ?? g.pasteShortcut;
  const autoEnter = rule?.autoEnter ?? prof?.autoEnter ?? g.autoEnter;
  const restoreClipboard = rule?.restoreClipboard ?? prof?.restoreClipboard ?? g.restoreClipboard;
  return { rule, notEditable, method, pasteShortcut, autoEnter, restoreClipboard, isSelf: false };
}

/** Resolve the CURRENT injection target (focused app → per-app rule) into the method +
 *  paste-shortcut to use RIGHT NOW. Called per injection — NOT once at dictation start — so
 *  per-app rules follow window switches mid-session: a hands-free/live dictation that moves
 *  from Konsole to another app picks up each window's own rule instead of being frozen to
 *  whatever was focused when dictation began. Shares resolveInjectionTarget with startLive. */
async function resolveTarget(cfg: InsertCfg | null): Promise<{
  method: InsertCfg["method"];
  pasteShortcut: string[];
  autoEnter: boolean;
  restoreClipboard: boolean;
  isSelf: boolean;
  /** The app the rule below was resolved against, handed to Rust so it can confirm focus hasn't
   *  moved by the time the keys actually go out. */
  appId: string | null;
}> {
  const g = useApp.getState().settings.general;
  const appRules = useApp.getState().appRules;
  const targetApp = await getFocusedApp();
  // The Profile layer comes from the SESSION TOKEN, never from a store lookup. This runs from
  // the 700ms focus poll and from tail tasks queued behind a slow paste, both of which can
  // outlive `activeProfile` (settleIdle clears it) — and a cancel-then-restart could otherwise
  // have session A's queued task resolve against session B's profile. Every task already
  // re-checks `insertCfg !== cfg` AFTER its await, but publishTarget below fires BEFORE that
  // check, so the token is what makes the wrong-session read structurally impossible.
  const {
    rule,
    notEditable,
    method,
    pasteShortcut,
    autoEnter,
    restoreClipboard,
    isSelf,
  } = resolveInjectionTarget(targetApp ?? null, appRules, g, cfg?.profileInsertion);
  // Keep the chip's "→ app" readout + skip hint live as focus moves mid-session: this resolves
  // the CURRENT window on every call, so it's the chip's source of truth — not the frozen
  // start-of-session value. Our own window shows as "→ this app": neutral, no warn hint.
  publishTarget(targetApp ?? null, isSelf ? null : rule?.block ? "blocked" : notEditable ? "notEditable" : null);
  // Always hand Rust the app we resolved against, our own window included. `null` DISABLES the
  // sink-side focus re-check, so a null here meant: alt-tab between this resolve and the keys
  // going out and the resolved method was used with no re-check and no per-app rule — `block`
  // included. A real id makes that move a mismatch, which degrades to clipboard-only.
  return { method, pasteShortcut, autoEnter, restoreClipboard, isSelf, appId: targetApp?.appId ?? null };
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
  const poll = () => void resolveTarget(insertCfg).catch((e) => console.error("target poll failed:", e));
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
// Bumped by every void: the consume's held-check is an async IPC round-trip, and a
// chord RELEASE landing during that flight has no other handle (pendingHoldStart is
// already nulled) — without this, the resolved "held" starts a hold session for a
// chord that is up, and nothing ever stops it.
let pendingStartGen = 0;

/** A chord release (or anything that makes a queued start wrong) voids it — including
 *  one whose held-check IPC is currently in flight. */
export function voidPendingHoldStart(): void {
  pendingHoldStart = null;
  pendingStartGen++;
}

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
  const gen = pendingStartGen;
  void shortcutModsHeld(chord)
    .then((held) => {
      if (gen !== pendingStartGen) return; // released while the check was in flight
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
  // The success end of a session: the models this run asked the server to keep
  // hot are no longer ours to hold. Unlike the cancel below this is NOT paired
  // with cancelDictationTranslate — releasing a lease stops a renew timer, it
  // never interrupts server-side work.
  releaseWarmLease();
  // NO cancelDictationTranslate() here, deliberately. Settling is the SUCCESS
  // path: we only reach it after the injection queue drained, which means every
  // translate already resolved and maybeTranslate's finally dropped the handle.
  // Cancelling a finished translation would either 404 or, worse, abort a
  // translate belonging to a session that started meanwhile. The teardown paths
  // (cancelLive / stopLive-reject / stream://error / teardownAfterFatalInject)
  // are the ones that abandon work mid-flight, and they all cancel.
  //
  // Flush any buffered clipboard-window translations before capture reads them.
  if (clipByLang) { accumulateByLang(clipByLang); clipByLang = undefined; }
  // Before the state flip: the capture reads the session docs (reset only by
  // the NEXT startLiveInner / cancelLive) and must run while they're intact.
  const saved = captureDictationHistory();
  // The outcome post reads the same session docs (translation state, insert-skipped)
  // and the delivery flags — all intact until the next start — so it rides right after.
  reportSessionOutcome(endOutcome());
  // `dictationPhase` is cleared in the SAME call as the status move — a phase
  // published for a status that no longer exists would keep a cold-translate
  // card on screen over an idle chip.
  // `translateFailure` rides the SAME call as `sessionOutcome`, for the same reason
  // `dictationPhase` does: the chip's done marker is edge-triggered on the outcome, so a
  // cause published a tick later would arrive after the marker it is meant to qualify.
  // Without it a session that inserted the ORIGINAL because the translate timed out shows
  // an unqualified "typed" — indistinguishable from one that translated successfully.
  useApp.getState().setDictation({
    status: "idle",
    sessionOutcome: endOutcome(),
    translateFailure: sessionTranslateFailure,
    // A push-to-talk session whose picker was aborted ends with outcome "none" like a
    // cancel — but it is NOT a cancel: the transcript was kept. The note rides the same
    // call as the outcome so the chip can tell the two apart on the very edge it reads.
    sessionNote: sessionInsertSkipped ? (saved ? "not-inserted-saved" : "not-inserted") : null,
    activeProfile: null,
    dictationPhase: null,
    // The session's resolved route dies with the session — otherwise the standby dock
    // previews the finished run's targets under the home Profile's own tag, and the tray
    // tooltip keeps them with no source language to pair them with.
    sessionTargets: null,
    routePending: null,
  });
  // The settle picker is armed per session by dictation.ts; a consumed or unused arming
  // must not survive into a session started by a path that doesn't arm (overlay, Home).
  askTargetsAtSettle = null;
  consumePendingHoldStart();
}

/** The translate-to picker's answer (dictation.ts `askTranslationTargets`):
 *   • `picked`      — the chosen targets, `[]` meaning "insert the original only";
 *   • `aborted`     — Esc / Cancel / a closed window: abandon the action (hands-free never
 *                     starts; push-to-talk keeps the transcript but does NOT insert it);
 *   • `unavailable` — no picker could be shown: not a gesture, the configured targets stand. */
export type TargetPick =
  | { kind: "picked"; targets: string[] }
  | { kind: "aborted" }
  | { kind: "unavailable" };

/** Set by dictation.ts when the running Profile asks for its targets after release (the
 *  push-to-talk path). Injected rather than imported: dictation.ts already imports this
 *  module, so the dependency can only go this way. Armed BEFORE startLive, which is how
 *  startLiveInner knows to publish the route as "undecided" (`routePending`). */
let askTargetsAtSettle: (() => Promise<TargetPick>) | null = null;
export function setSettleTargetPicker(fn: (() => Promise<TargetPick>) | null): void {
  askTargetsAtSettle = fn;
}

/** One-shot hint for the NEXT session's `routePending`, set by dictation.ts when the
 *  hands-free picker answered "0" (insert the original only). A session that merely has no
 *  targets configured must not be acknowledged as a decision, and startLiveInner republishes
 *  `sessionTargets` itself a tick after any store write dictation.ts could make — so the
 *  hint travels on this seam and is consumed exactly once, by the session it was set for. */
let routeHint: "original" | null = null;
export function setRouteHint(hint: "original" | null): void {
  routeHint = hint;
}

/** True when this session's end-of-session insert was skipped because the user aborted the
 *  translate-to picker. Read by settleIdle to stamp `sessionNote`; reset per session. */
let sessionInsertSkipped = false;

/** Replace this session's translation targets with the user's pick.
 *
 *  Mutates the frozen `sessionTranslation` in place rather than rebuilding it, so the
 *  server/model/glossary/mode this session already resolved (and warmed) are kept — only
 *  the targets change. An EMPTY list is a real answer ("insert the original only") and
 *  clears translation for the session, which is why it isn't treated as "no opinion". */
function applySessionTargets(targets: string[]): void {
  const clean = targets.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) {
    sessionTranslation = null;
  } else if (sessionTranslation) {
    sessionTranslation.targets = clean;
  } else if (sessionTranslationBase) {
    // A Profile that asks but configures no targets: the pick CREATES the translation.
    // It pays a cold model load — the preload plan and warm lease were made without it.
    sessionTranslation = { ...sessionTranslationBase, targets: clean };
  } else {
    // No session context to build on — don't advertise a route nothing will produce.
    return;
  }
  // Republish so the chip's route matches what will actually be injected.
  // `[]`, not null, while the session lives: null means "no session" (the chip then previews
  // the Profile's configured route), and an EMPTY pick is a real answer — publishing null for it
  // made the chip advertise "→ FR IT" for a session that inserts the original untranslated.
  // The pick settles the "undecided" route: a real target list clears the pending glyph, an
  // empty one becomes the brief "· original" acknowledgement.
  useApp.getState().setDictation({ sessionTargets: clean, routePending: clean.length ? null : "original" });
}

/** A stream-event handler should fold in / act on a late emit only while genuinely busy — a
 *  post-cancel (idle) or post-error (error) drain emit on the un-advanced epoch must be dropped. */
function inSession(): boolean {
  return isActiveDictation(useApp.getState().status);
}

// Return to idle once the injection queue has fully drained (the text has landed in
// the focused field) — but never before MIN_INJECT_VISIBLE_MS, and never over a status
// that has moved on (a fresh session started meanwhile). When the status is "error"
// (a failed inject called flashError), the settle runs the bookkeeping (lease release,
// history capture, outcome) but leaves the error status and message intact for
// ERROR_LINGER_MS — see the guard inside.
function settleToIdleAfterInjection(startedAt: number, cfg: InsertCfg | null): void {
  void injectChain.then(() => {
    const wait = Math.max(0, MIN_INJECT_VISIBLE_MS - (performance.now() - startedAt));
    setTimeout(() => {
      // Identity-check the session, not just the status: this `.then` was attached to THIS session's
      // injectChain, but a slow/stuck paste can keep it pending until after a cancel + a fresh session
      // B has independently reached "injecting" — settling on status alone would idle B mid-injection
      // (and stamp its outcome wrong). A normal end keeps insertCfg===cfg; a cancel (→null) or restart
      // (→new object) makes this a no-op. Mirrors the inject tasks' `insertCfg !== cfg` guard.
      const curStatus = useApp.getState().status;
      if (insertCfg === cfg && curStatus === "injecting") {
        settleIdle();
      } else if (insertCfg === cfg && curStatus === "error") {
        // The inject failed and flashError is showing the message for ERROR_LINGER_MS.
        // Run the same bookkeeping settleIdle does (lease, history, outcome, session fields)
        // but leave status/dictationError intact so the user can read the recovery hint.
        // flashError's own timer will clear to idle when it expires.
        releaseWarmLease();
        captureDictationHistory();
        reportSessionOutcome(endOutcome());
        useApp.getState().setDictation({
          sessionOutcome: endOutcome(),
          translateFailure: sessionTranslateFailure,
          activeProfile: null,
          dictationPhase: null,
          sessionTargets: null,
          routePending: null,
        });
        askTargetsAtSettle = null;
        consumePendingHoldStart();
      }
    }, wait);
  });
}

// Backstop for a wedged "finalizing…": stopLive() sets "transcribing" and then waits
// for the stream's terminal `closed`. If the socket died silently (suspend, dropped
// link) that event may never arrive, leaving the chip stuck. After this long with no
// resolution we force a clean idle. Streaming only — a batch transcription can take a
// while legitimately (bounded by the HTTP client's own 120 s timeout). Must outlast
// the Rust drain bounds, which are SEQUENTIAL: up to 10 s of PCM-drain / flush / stop
// writes (DRAIN_WRITE_DEADLINE), THEN a first-frame idle window of 10 s warm or 30 s
// when the server sent nothing (a model cold-load) — ~40 s worst case, and the 30 s
// branch is exactly the one no `loading` keepalive re-arms this watchdog in. The
// overlay's ✕ stays available throughout for anyone who'd rather bail early.
const STUCK_FINALIZE_MS = 45_000;
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
      // Captured BEFORE cancelLive() below, which nulls insertCfg — by the time the async
      // recovery runs there is no session left to read the target from.
      const pendingAppId = insertCfg?.targetApp?.appId ?? null;
      void cancelLive();
      if (pending) {
        void (async () => {
          let onClipboard = false;
          try {
            // Believe the ANSWER, not the attempt: `inject_text`'s own-window guard sits above the
            // clipboard branch and returns `landed: false` having written nothing, so a promise of
            // "it's on the clipboard" made on "the invoke didn't throw" can be false — and these
            // recovery paths fire exactly when the user is most likely looking at (or clicking
            // into) our own window. No re-send is introduced, so this cannot duplicate text.
            //
            // `expectAppId` is passed for uniformity only: on a clipboard-method call Rust
            // returns from its clipboard arm BEFORE the per-app sink re-check that reads it, so
            // the argument is inert here (and at every other clipboard-method site). The guard
            // that CAN answer `landed: false` on this call is inject_text's own-window ENTRY
            // check — which is what the "believe the answer" logic above relies on.
            ({ landed: onClipboard } = await injectText({ text: pending, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: [], expectAppId: pendingAppId }));
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
  // `stream://partial`'s coalescing state lives at module scope — see it there for why.
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
    // Hands-free auto-stop (when armed): track silence via the shared speaking detector and end the
    // session after the configured quiet stretch. Fires once, then disarms itself.
    if (autoStopMs > 0) {
      const tNow = performance.now();
      // "Is the mic open", NOT "is the status listening": a per-phrase translate holds the
      // status on "translating" for seconds while capture continues — a status gate here
      // reset the silence accounting for the whole translate and froze the chip's meter.
      const listening = isCapturing();
      if (stepSpeaking(autoStopMemo, latestLevel, listening, tNow)) {
        lastSpokeAt = tNow;
      } else if (listening && tNow - lastSpokeAt >= autoStopMs) {
        autoStopMs = 0;
        console.info("[dictation] hands-free auto-stop: silence threshold reached");
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
      if (isCapturing()) setDictation({ level: latestLevel });
    } else if (!levelTimer) {
      levelTimer = setTimeout(() => {
        levelTimer = undefined;
        lastLevelAt = performance.now();
        // Only publish while a session is still capturing: this trailing tick is closure-
        // local and can't be cleared on teardown, so if it fires after `closed`/cancelLive
        // froze the meter to 0 it must not resurrect the last non-zero level (it would stick
        // until the next session and churn a needless cross-window emit).
        if (isCapturing()) setDictation({ level: latestLevel });
      }, wait);
    }
  });

  // Rust confirmed real audio on the RAW capture (a few consecutive non-silent chunks — see
  // session.rs LiveDetect). This is the PRIMARY go-live signal: the smoothed+gained level gate
  // below starts from a 0-seeded EMA against a threshold a quiet mic's noise floor only hovers
  // AT, so on such mics it held "warming up…" until the user actually spoke (~2s of grey chip
  // after the hands-free press). The level gate stays as a fallback (it can only fire later, and the
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
    // Capture state, not status: during a per-phrase translate (status "translating", mic
    // open) a status gate stopped bumping the phrase-end timer, so it expired mid-speech —
    // firing the auto-Enter and resetting the clipboard baseline while the user was talking.
    const capturing = isCapturing();
    // Coalesced for the same measured reason as `stream://level` above, and against a worse
    // pacer. `overlay.ts` subscribes on `state.partial !== prev.partial` exactly as it does on
    // `level`, so every partial rebuilds the whole chip payload, IPC-emits it cross-window and
    // re-renders both windows — the churn that comment records as having bloated the shared
    // WebKitGTK renderer to multiple GB over a long session. But `level` is hardware-paced at
    // 50-100 Hz, while the partial rate is chosen entirely by the untrusted server: Rust bounds
    // each field at MAX_TRANSCRIPT and applies no frame-rate or frame-count limit, and
    // `store.ts`'s patch apply does no coalescing. A server flooding partials pins the main
    // thread of the main window AND the chip — including the cancel affordance the user would
    // reach for. Leading edge then a trailing tick, so the preview still settles on the last
    // text rather than freezing mid-throttle.
    //
    // Only the preview setState is throttled. `bumpPhraseEnd()` below stays on every frame, so
    // per-phrase timing (Enter, clipboard restore, phrase boundary) is unchanged.
    latestPartial = committedDoc + sep + live;
    const pWait = PARTIAL_MIN_MS - (performance.now() - lastPartialAt);
    if (pWait <= 0) {
      if (partialTimer) {
        clearTimeout(partialTimer);
        partialTimer = undefined;
      }
      flushPartial();
    } else if (!partialTimer) {
      partialTimer = setTimeout(() => {
        partialTimer = undefined;
        // Closure-local like the level tick: it cannot be cleared on teardown, so re-ask the
        // same `inSession()` question the leading edge asked rather than resurrecting a stale
        // preview into an idle or errored chip.
        if (inSession()) flushPartial();
      }, pWait);
    }
    // Still speaking → keep deferring the per-phrase actions (Enter / clipboard restore / clipboard
    // phrase boundary) until you actually pause. Armed for any live session, but only while capturing.
    if (insertCfg?.live && capturing) bumpPhraseEnd();
  });

  type FinalFrame = { committed: string; tail: string; last: boolean; utterance: number | null };
  await reg<FinalFrame>("stream://final", (e) => {
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
    // Drop any pending partial tick first: it holds the PRE-final text and would otherwise
    // land up to PARTIAL_MIN_MS later and regress this publish.
    resetPartialPreview();
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
      // `final` (the flush final the drain emits at hands-free end). Advanced synchronously per final and
      // kept SEPARATE from the typed baseline (injectedText), so re-sent-final detection stays correct
      // regardless of whether/where the phrase actually typed.
      const grew = commonPrefixLen(seenDoc, target) < target.length;
      seenDoc = target;
      // Capture the session token SYNCHRONOUSLY (before the task's awaited resolveTarget) so the task
      // bails on BOTH a cancel (insertCfg→null) AND a cancel-then-fresh-restart (insertCfg→a NEW object)
      // landing during EITHER await — mirrors the stop-timing task (cfg captured before its enqueue).
      // Within a session insertCfg keeps a stable identity, so a normal phrase still injects.
      const cfg = insertCfg;
      // Inject-queue depth read HERE, synchronously at enqueue time, and carried
      // into the queued task: it decides how long this phrase's translate may
      // wait on a cold model (20 s when nothing is behind it, the short
      // length-based budget when a backlog exists — see translateCeilingMs).
      // Read inside the task instead and it would report the depth at DRAIN
      // time, by which point this task is the one being drained.
      //
      // NB the translate deliberately happens INSIDE the queue, after the
      // append-only diff: `toType` is computed in-queue on purpose so a phrase
      // the own-window guard skips leaves `injectedText` untouched and gets
      // retyped later. Translating before the diff (in a separate serial
      // translate queue, say) would advance the typed baseline at diff time and
      // lose skip-and-retype.
      const queuedAtEnqueue = injectDepth;
      // The server's ordinal for THIS utterance, captured synchronously with
      // everything else the queued task needs. It is how the phrase finds its
      // own capture id (and so its own held log receipt) instead of taking
      // whichever id happened to arrive last.
      // `null` from a server that predates the ordinal: pair nothing, rather than
      // keying every phrase of the session onto ordinal 0.
      const utterance = typeof e.payload.utterance === "number" ? e.payload.utterance : null;
      enqueueInject(async () => {
        const t = await resolveTarget(cfg);
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
        const useClipboard = holdCoerced(insertCfg?.activation, t.method);
        if (useClipboard) {
          // Clipboard: copy just the current hard-break window (everything since your last pause) —
          // never the whole session — so the clipboard doesn't pile up. Each copy flashes the chip's
          // clipboard glyph PER PHRASE (mirroring the typed green pulse) so a hands-free session shows
          // confirmation continuously. Skip our own window (the injection guard copies nothing there →
          // would be a false confirmation). `grew` is the document-grew guard: false for a re-sent
          // final (the flush final the drain emits at hands-free end), so a clipboard hands-free session that ends
          // mid-speech doesn't re-copy + re-pulse the last phrase on the re-sent final.
          if (phraseClip.length > 0 && grew) {
            // T2T live: translate the outbound copy only; clipBaseline and the
            // grew guard keep working in original text.
            const { text: clipOut, translated, byLang } = await translatePhrase(phraseClip, cfg, {
              queued: queuedAtEnqueue,
              utterance,
            });
            if (insertCfg !== cfg) return;
            let landed = true;
            try {
              ({ landed } = await injectText({ text: clipOut, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId }));
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
            // `!t.isSelf` alone is the answer resolved one IPC hop EARLIER — the same start-time vs
            // sink-time divergence the typed sibling below fixed with `delivered`. If our own window
            // took focus during the await, Rust wrote nothing and returned `landed: false`; booking
            // the copy anyway pulses a "copied" confirmation for a phrase that reached no clipboard,
            // and clears a restore debt an earlier real paste still owes the user.
            // Booked only for a DELIVERED copy (mirrors the typed branch's `if (delivered)`): an
            // own-window skip or a failed write must not add a phrase History never got. And
            // per WINDOW: the copy re-sends the whole quiet window on every final, so this
            // replaces the window's earlier booking instead of appending it again.
            if (translated && !t.isSelf && landed) {
              clipBooked ??= { text: sessionTranslatedText, ctxLen: sessionPhraseContext.length };
              sessionPhraseContext.length = clipBooked.ctxLen;
              sessionPhraseContext.push(phraseClip);
              // The clipboard is REPLACED per phrase (never appended to), so the copied text
              // needs no phrase gap — only this session accumulator, which History renders as
              // one document, does.
              sessionTranslatedText = clipBooked.text
                ? clipBooked.text + PHRASE_GAP + clipOut.trim()
                : clipOut.trim();
              // Per-language tracks: each final in this window translates the GROWING window,
              // so the latest byLang supersedes every earlier one. Buffer it here; bumpPhraseEnd
              // / clearPhraseEnd flush the final version into sessionByLang once per window.
              if (byLang) clipByLang = byLang;
            }
            if (!t.isSelf && landed) {
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
            // T2T live: translate the outbound copy only. injectedText still
            // advances by the ORIGINAL document below, so per-phrase diffing,
            // skip-and-retype and re-sent-final detection are untouched.
            const phrase = await translatePhrase(toType, cfg, {
              queued: queuedAtEnqueue,
              utterance,
            });
            if (insertCfg !== cfg) return;
            // A translated session types BLOCKS, so normalise the seam here
            // rather than inheriting whichever whitespace each path happened to
            // carry. `injectedText` is the already-typed original document, so
            // a non-empty one means a previous phrase really landed — a phrase
            // the own-window guard skipped leaves it untouched and so does not
            // buy a leading gap for text that was never typed.
            const typeOut = sessionTranslation
              ? (injectedText.length > 0 ? PHRASE_GAP : "") + phrase.text.trim()
              : phrase.text;
            // The translated-document accumulators advance further down, inside `if (delivered)`:
            // a sink-skipped phrase is deliberately re-sent with the next insert (injectedText
            // stays un-advanced), and booking it here appended its translation to history twice.
            // Snapshot the user's CURRENT clipboard right before this paste overwrites it — per phrase,
            // not once at session start — and only when the clipboard does NOT already hold our own text
            // (clipHoldsOurs false), so we never capture our own transcript. Gating on clipHoldsOurs (not
            // clipDirty) covers the clipboard-only→paste case: a clipboard-only phrase clears clipDirty
            // but leaves our text on the clipboard, which !clipDirty would wrongly re-snapshot.
            if (t.method === "paste" && t.restoreClipboard && !clipHoldsOurs && !t.isSelf) {
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
            let landed = true;
            let diverted = false;
            try {
              ({ landed, diverted } = await injectText({ text: typeOut, method: t.method, autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId }));
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
                  const copied = await injectText({ text: typeOut, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId });
                  flashError(
                    copied.landed
                      ? "Couldn’t type the text — it’s on the clipboard to paste manually."
                      : "Couldn’t insert the text.",
                  );
                } catch (e2) {
                  console.error("clipboard fallback after failed live insert failed:", e2);
                  flashError("Couldn’t insert the text.");
                }
              } else {
                // Paste failed, but the Rust paste path leaves the transcript on the clipboard on
                // failure (skip-restore-on-failed-paste) AND the teardown below drops the snapshot
                // WITHOUT restoring, so it should still be recoverable — ASK, don't assert.
                //
                // The comment that used to sit here claimed `inject_text` returns `landed: true`
                // unconditionally for the clipboard method, so asking was pointless. That stopped
                // being true: `set_clipboard_persistent` now returns a Result and the clipboard
                // branch reports `landed: false` on a write failure. Asserting therefore promised
                // a clipboard recovery in exactly the broken-clipboard environment where there
                // isn't one. Re-issuing the copy cannot duplicate text — the paste already failed.
                let recoverable = false;
                try {
                  ({ landed: recoverable } = await injectText({
                    text: typeOut, method: "clipboard", autoEnter: false, restoreClipboard: false,
                    pasteShortcut: t.pasteShortcut, expectAppId: t.appId,
                  }));
                } catch (e2) {
                  console.error("clipboard fallback after failed paste failed:", e2);
                }
                flashError(
                  recoverable
                    ? "Couldn’t paste the text — it’s on the clipboard to paste manually."
                    : "Couldn’t insert the text.",
                );
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
            //
            // `landed` is the SINK's answer, and `t.isSelf` is the answer we resolved ~1s earlier.
            // Both are needed. `t.isSelf` covers a start-time skip; `landed` covers the case this
            // block used to get wrong — our own window taking focus DURING the insert, where
            // `t.isSelf` is false because we really did resolve another window, and Rust's skip is
            // indistinguishable from success. Booking that phrase advanced `injectedText`, so the
            // next final's common-prefix slice skipped it and it was dropped for good — with a
            // green "Inserted" pulse claiming otherwise, and nothing on the clipboard to recover
            // from, because the sink skip returns before any clipboard write.
            const delivered = !t.isSelf && landed;
            if (delivered && diverted) {
              // Rust wrote a persistent clipboard owner INSTEAD of pasting, so our transcript is
              // what the user must now paste — we owe no restore over it. Mirrors the clipboard-only
              // phrase path above exactly; without this the end-of-phrase restore would put the
              // user's old clipboard back over the text we just told them to paste.
              clipDirty = false;
              clipHoldsOurs = true;
            } else if (t.method === "paste" && delivered) {
              clipDirty = true;
              clipHoldsOurs = true;
            }
            // Advance the TYPED baseline + pulse ONLY when the phrase actually landed: leaving it
            // un-advanced re-sends the skipped text with the next insert, which is the whole point.
            if (delivered) {
              injectedText = target;
              if (phrase.translated) {
                sessionPhraseContext.push(toType);
                sessionTranslatedText = sessionTranslatedText
                  ? sessionTranslatedText + PHRASE_GAP + phrase.text.trim()
                  : phrase.text.trim();
                accumulateByLang(phrase.byLang);
              }
              // Tell the truth about WHERE it went. Rust can divert a typed/pasted insert to the
              // clipboard — the trigger chord is still held, or focus moved to another app — and
              // until it reported that back, this stamped the green "typed" pulse over it either
              // way. The user saw a success confirmation and no text, with nothing to explain it.
              if (diverted) {
                // The chip's clipboard glyph IS the signal here — the same one the clipboard-only
                // phrase path uses, for the same reason: it repeats per phrase, so a hands-free session
                // shows it continuously. Deliberately NOT flashError: that sets status "error",
                // which drops out of `isActiveDictation`, so every later frame of a session that is
                // still capturing would be discarded while Rust holds the mic and the system mute —
                // a session-killer in exchange for a message. And this fires on the routine
                // focus-moved-to-another-app divert too, which the sink comment expects in any live
                // or hands-free session.
                sessionClipboard = true;
                signalInsert("clipboard");
              } else {
                sessionTyped = true;
                signalInsert("typed");
              }
            }
          }
        }
      });
      // A phrase's text just landed AND the document actually GREW (`grew` is false for a re-sent
      // final — e.g. the flush `final` the drain emits when you end a hands-free session — so we must NOT re-arm
      // for text that was already typed + Entered; doing so is what fired a second Enter at hands-free
      // end). (Re)start the quiet timer so the per-phrase Enter + clipboard restore fire
      // ~PHRASE_END_QUIET_MS after you stop speaking (not at the ~20s hard break). Ongoing speech
      // keeps bumping the timer via stream://partial.
      if (grew) {
        // Unconditional: this flag means "text landed since the last Enter", not "Enter is
        // armed" — whether an Enter is actually wanted is resolved per target, later.
        phraseDirty = true;
        bumpPhraseEnd();
      }
    }
  });

  await reg<string>("stream://recording", (e) => {
    // The saved .wav's path. Stash for the capture at settle; if the session
    // already settled (slow disk), patch the record it produced.
    sessionRecordingPath = e.payload;
    if (capturedRecordId) attachRecordingPath(capturedRecordId, e.payload);
  });

  await reg<{ id: string; utterance: number | null }>("stream://captured", (e) => {
    // Epoch-gated in Rust, so a cancelled session's id never lands here and
    // gets attached to whatever session started next.
    const id = e.payload?.id;
    if (!id) return;
    // No ordinal = nothing to pair it with (an older server): the receipt stays unclaimed.
    if (typeof e.payload.utterance !== "number") return;
    captureIds.resolve(e.payload.utterance, id);
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
    // Bounded, the mirror of Rust's MAX_SIDECAR_BYTES on the same accumulation. Rust caps each
    // `final` field at MAX_TRANSCRIPT and caps the banked sidecar `Vec` at 8 MiB precisely because
    // "a server looping final/boundary grew this without limit" — but this string, the frontend's
    // copy of the same thing, had no ceiling and no frame-count limit. It grows once per boundary
    // frame for the whole session in the shared WebKitGTK renderer, and at `closed` a second full
    // copy is allocated, crossed over the IPC in one call, and on direct typing synthesized key by
    // key. Same budget and same trade as Rust's: drop the overflow rather than the session, so a
    // real dictation (an hour is ~50 KB) is untouched and what was already typed still stands.
    if (committedDoc && bankedDoc.length + committedDoc.length + sep.length <= MAX_BANKED_DOC) {
      bankedDoc += committedDoc + sep;
    }
    committedDoc = "";
    clipBaseline = "";
    clipBooked = null;
    injectedText = "";
    seenDoc = "";
    // Same reason as the final handler's: a pending tick would undo this clear.
    resetPartialPreview();
    setDictation({ partial: "" });
    // A hard break = a finished phrase. In live mode, emit (into the window focused NOW)
    // any configured separator AND — when "Press Enter after" is on — a REAL Enter, so each
    // phrase is submitted/newlined as you speak. This is what makes "Press Enter after" work
    // in hands-free/ongoing dictation, which never reaches the stop-time tail. A "\n" is always a
    // real Enter (a pasted newline gets swallowed by some apps); clipboard-only types nothing
    // (the full transcript is already on the clipboard via bankedDoc).
    // The phrase ended (hard break). The per-phrase Enter is normally driven by the quiet
    // timer (~PHRASE_END_QUIET_MS after you stop, well before this ~20s hard break), so it's
    // already been pressed. Cancel the pending timer; only Enter here as a backstop if it
    // somehow hasn't. When auto-enter is off, fall back to the configured separator behavior.
    clearPhraseEndTimer();
    if (insertCfg?.live) {
      // Enter-vs-separator is now decided INSIDE the queued task, after the target resolves.
      // It used to fork synchronously on the frozen `insertCfg.autoEnter`, which is precisely
      // what stopped an app rule from governing Enter: the branch was taken before anyone
      // asked which window the text was going to. Costs one extra focus round-trip per hard
      // break (~20s), the cost already noted for this path.
      if (phraseDirty || sep) {
        // Capture the session token synchronously (mirrors the live/stop tasks) so a cancel-then-restart
        // during resolveTarget OR the paste below bails — don't fire a stray separator/Enter into the
        // new/refocused window, nor stamp the old session's clipboard bookkeeping onto session B.
        const cfg = insertCfg;
        const dirtyAtBreak = phraseDirty;
        enqueueInject(async () => {
          const t = await resolveTarget(cfg);
          if (insertCfg !== cfg) return;
          // Hold session: same as enqueueAutoEnter — never emit a keystroke while the PTT chord is held
          // (the held modifier would fold into the separator/Enter once focus moved to a typing window).
          if (holdCoerced(insertCfg?.activation, t.method)) return;
          // Enter wins over the separator when this target wants it — the same precedence the
          // synchronous fork had, just evaluated against the window actually being typed into.
          if (t.autoEnter) {
            if (dirtyAtBreak) {
              await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId });
            }
            return;
          }
          if (!sep) return;
          if (sep.includes("\n")) {
            await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId });
          } else {
            const { landed } = await injectText({ text: sep, method: t.method, autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId });
            // A cancel-then-fresh-start during the paste await must not stamp the OLD session's clipboard
            // bookkeeping (clipHoldsOurs / a restore) onto the new one — mirrors the inject tasks' guard.
            if (insertCfg !== cfg) return;
            // The separator paste just clobbered the clipboard with `sep` (set_clipboard + Ctrl+V).
            // (!t.isSelf: an own-window separator is Rust-guard-skipped, so the clipboard is untouched
            // there and the boundary backstop below handles any owed restore — don't touch bookkeeping.)
            // `landed` for the same reason as the phrase task: a sink-side own-window skip wrote
            // nothing, so there is no clobber to restore and setting clipHoldsOurs would suppress the
            // NEXT real paste's snapshot — leaving a later paste with nothing recorded to put back.
            if (t.method === "paste" && t.restoreClipboard && !t.isSelf && landed) {
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
    } else if (e.payload === "loading") {
      // Keepalive while the server cold-loads its model (every ~3s): alive,
      // just slow. Re-arm the stuck-finalize watchdog so an arbitrarily long
      // load can't force-idle a dictation whose transcript is seconds away —
      // the Rust drain's idle window resets on the same frames.
      if (useApp.getState().status === "transcribing") armStuckWatchdog();
    } else if (e.payload === "closed") {
      capturing = false; // covers the closes that ran no stopLive (capture death, server-initiated)
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
        // Enter for the LAST, in-progress phrase — one you ended a hands-free session on before pausing, so its
        // quiet-timer Enter never fired — plus a FINAL clipboard restore that also clears the
        // snapshot. `phraseDirty` is true only if that last Enter hasn't already fired (the quiet
        // timer / boundary clear it), and crucially we only set it for a final that GREW the
        // document — so the drain's re-sent flush `final` can't resurrect it into a double Enter.
        // Skip the "injecting" flash when there's no tail work.
        // `phraseDirty` alone here, deliberately. Whether an Enter is actually wanted is now
        // the TARGET's decision, and this runs outside the queue — there is no resolved target
        // yet. So the tail is armed on "is there an un-Entered phrase", and enqueueAutoEnter
        // resolves and drops it if the window doesn't want one. The only cost of arming
        // optimistically is the brief "injecting" flash below on a session that then sends
        // nothing; the cost of the reverse would be a missed Enter, which loses a submit.
        const enterTail = phraseDirty;
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
        setDictation({ status: sessionTranslation ? "translating" : "injecting" });
        enqueueInject(async () => {
          // T2T: translate the whole transcript once, then inject the result.
          // Falls back to the original on timeout/failure (maybeTranslate warns).
          //
          // `oneShot`: this is the LAST task in the inject chain — the session is
          // over, nothing is queued behind it — so it can afford to wait out a
          // cold model load (tens of seconds for a GGUF) instead of timing out
          // and inserting the original. That is why the long wait is scoped
          // HERE and not given to live phrases, which block the next phrase.
          let outText = text;
          // Push-to-talk asks for its targets HERE, not at session start: the chord is held
          // for the whole dictation, so a prompt then would have eaten the keystrokes. The
          // transcript is finished and nothing has been typed yet, which makes this the one
          // seam where the answer can still change the outcome.
          //
          // Unlike the hands-free path this misses the four session-start commitments —
          // the preload plan, the warm lease, the capability probe and `translateExpect`
          // were all made with the Profile's CONFIGURED targets. Those are preselected, so
          // they are usually the answer; a differently-picked target just pays a cold load.
          //
          // An ABORTED picker (Esc / "Don’t insert" / a closed window) skips the translate AND
          // the insert, but the session still settles like a landed one: the transcript is
          // recorded to History, the chip settles to idle with outcome "none" and a
          // "not inserted" note (settleIdle reads `sessionInsertSkipped`). Nothing is
          // inserted, so there is no outcome to book and no clipboard fallback to offer.
          if (askTargetsAtSettle) {
            const pick = await askTargetsAtSettle();
            if (insertCfg !== cfg) return;
            if (pick.kind === "picked") applySessionTargets(pick.targets);
            else if (pick.kind === "aborted") {
              sessionInsertSkipped = true;
              // Settle NOW rather than flashing "inserting…" for MIN_INJECT_VISIBLE_MS over a
              // session that inserts nothing. Safe from inside the task: settleIdle only
              // flips state + releases the lease, and `settleToIdleAfterInjection` (attached
              // to this same chain) then finds status "idle" and does nothing. The queued
              // hold-start it may fire resets `injectChain` for its own session; this task
              // returns right after and never touches the chain again.
              // Route: this session translates nothing now, and its "→ ?" is answered.
              setDictation({ sessionTargets: [], routePending: null });
              settleIdle();
              return;
            }
            // "unavailable": no picker could be shown → the configured targets stand.
          }
          if (sessionTranslation) {
            setDictation({ status: "translating" });
            const one = await maybeTranslate(text, cfg, { oneShot: true });
            if (insertCfg !== cfg) return;
            outText = one.text;
            if (one.translated) {
              sessionTranslatedText = one.text;
              accumulateByLang(one.byLang);
            }
          }
          // Unconditionally, not only after a translate: the status was set to "translating"
          // above whenever the Profile had targets, and an EMPTY settle-time pick (a real
          // answer: insert the original only) nulls `sessionTranslation` — so the block above
          // is skipped and, with the move inside it, nothing ever said "injecting". Then
          // `settleToIdleAfterInjection` (which requires "injecting") never settled: the chip
          // wedged on "translating…", the outcome was never stamped, history never recorded
          // the session and the warm lease renewed forever.
          setDictation({ status: "injecting" });
          const t = await resolveTarget(cfg);
          // A cancel (insertCfg→null) OR a cancel-then-fresh-session (insertCfg→a new object) landing
          // during the awaited resolve must not paste the OLD session's whole transcript into the new/
          // refocused window. Identity-check, mirroring the post-inject guard below + the live tasks;
          // a normal stop keeps insertCfg===cfg so the end-of-session insert still lands.
          if (insertCfg !== cfg) return;
          let landed = true;
          let diverted = false;
          try {
            ({ landed, diverted } = await injectText({
              text: outText,
              method: t.method,
              autoEnter: t.autoEnter,
              restoreClipboard: t.restoreClipboard,
              pasteShortcut: t.pasteShortcut, expectAppId: t.appId,
            }));
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
            // Did the transcript actually end up on the clipboard? Ask on EVERY method, not just
            // direct. The clipboard branch used to be asserted on the premise that a
            // clipboard-method `inject_text` always returns `landed: true`; it now reports a real
            // write failure, so the assertion promised a recovery that may not exist. Asking costs
            // one extra clipboard write on a path that has already failed, and cannot duplicate
            // text (nothing was inserted).
            let onClipboard = false;
            try {
              ({ landed: onClipboard } = await injectText({ text: outText, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId }));
            } catch (e2) {
              console.error("clipboard fallback after failed insert failed:", e2);
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
          // per-phrase pulse; this IS the whole session). Same `landed` term as the per-phrase
          // path, and it matters more here: this ONE call carries the entire transcript, so a sink
          // skip booked as success stamped a "typed" done marker on a dictation that went nowhere
          // — while every other failure mode on this path deliberately copies the text to the
          // clipboard and says so.
          if (!t.isSelf && landed) {
            // A divert means the transcript went to the clipboard rather than into the window,
            // so record THAT outcome — `endOutcome()` reports it and the done marker shows the
            // clipboard result instead of a green "typed" over text that was never typed. No
            // flashError, for the reason given on the per-phrase path: it would set status "error"
            // and `settleToIdleAfterInjection` would then never call `settleIdle()`, leaving the
            // outcome unstamped and dropping a queued hold-start — in the very scenario where the
            // user is still holding the chord.
            if (t.method === "clipboard" || diverted) sessionClipboard = true;
            else sessionTyped = true;
          } else if (!t.isSelf && !landed) {
            // Nothing was written: our own window took focus mid-insert (the sink skip returns
            // before any write), or — on a clipboard-method insert — the clipboard write itself
            // failed, which Rust reports the same way. Offer the same recovery, but believe the
            // ANSWER rather than the attempt: this retry goes back through the same own-window
            // guard, so while our window still holds focus it writes nothing and reports false.
            // Claiming a clipboard recovery there would be the false confirmation this whole fix
            // removes. `outText`, not `text`: the translated transcript is what was being inserted,
            // and history has already booked it as the delivered translation.
            let onClipboard = false;
            try {
              onClipboard = (await injectText({ text: outText, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut, expectAppId: t.appId })).landed;
            } catch (e2) {
              console.error("clipboard fallback after a sink-skipped insert failed:", e2);
            }
            if (onClipboard) {
              sessionClipboard = true;
              // A clipboard-method skip has two possible causes (see sinkSkipMessage): no focus claim there.
              flashError(
                t.method === "clipboard"
                  ? "The transcript is on the clipboard to paste manually."
                  : "Focus moved to this app — the transcript is on the clipboard to paste manually.",
              );
            } else {
              flashError(sinkSkipMessage(t.method));
            }
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
    // The session is over; any in-flight translate belongs to a phrase that will
    // never be injected, so stop the server's side of it too (mirrors cancelLive
    // / teardownAfterFatalInject / the stopLive reject).
    cancelDictationTranslate();
    releaseWarmLease();
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
          // Same as the stuck-finalize sibling: `landed: false` means nothing was written.
          ({ landed: onClipboard } = await injectText({ text: pending, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: [] }));
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
    capturing = false;
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
  // The failed phrase (or one queued behind it) may still have a translate in
  // flight; nothing will consume it now, so stop the server's work too.
  cancelDictationTranslate();
  releaseWarmLease();
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
  capturing = false;
  void (endpoint === "batch" ? stopRecord() : stopStream()).catch((err) =>
    console.error("teardown after fatal inject failed:", err),
  );
  // Retire the epoch (drain kept → sidecar still writes) so its late final/closed can't bleed onto a
  // session re-triggered during the error linger. Mirrors the stream://error teardown + cancel paths.
  void retireSessionEpoch().catch((err) => console.error("retire epoch after fatal inject failed:", err));
}

/** The wording for "nothing was written and the clipboard retry failed too". On a
 *  clipboard-method insert `landed:false` has TWO producers this side cannot tell apart —
 *  Rust's own-window guard runs for every method before the clipboard arm, and `t.isSelf`
 *  is a ~1 s-old answer — so the message names neither cause alone; blaming focus (or the
 *  clipboard) outright sent the user after the wrong problem. */
export function sinkSkipMessage(method: InsertMethod): string {
  return method === "clipboard"
    ? "Nothing was inserted — the text couldn’t be put on the clipboard, or this app has focus."
    : "Focus moved to this app — nothing was inserted.";
}

/** Show an error on the chip, then auto-clear it to idle after ERROR_LINGER_MS so it doesn't stick.
 *  Guarded: if a new session starts first (status leaves "error"), the pending clear is a no-op. */
function flashError(message: string): void {
  // Every call site is terminal for the session (a failed start, a failed insert, a lost
  // connection), and `settleIdle` — the normal releaser — only runs for a session that reached
  // "injecting". Release the preload lease here, or a session that died on this path kept
  // POSTing the warm hint every RENEW_MS until the next successful start. Idempotent.
  releaseWarmLease();
  voidPendingHoldStart(); // don't chain a queued start onto a failed session (in-flight check included)
  // Clear the live preview too (like level:0 freezes the meter): the error supersedes it, and
  // otherwise the stale `partial` lingers in the store — when the error auto-clears to idle the
  // Home transcript card (which lingers longer than the error) would flip from the red message to
  // the leftover preview text labelled "done". cancelLive/startLive clear it on their paths; the
  // error auto-clear didn't. Clear `warming` for the same reason: a start-failure lands here with
  // warming:true AND the warm-timer backstop already cancelled (start-reject catch), so without this
  // the chip would stay stuck on "warming up…" (read ungated) and expanded until the next session.
  // Fifth writer of `partial`: drop any pending tick so it cannot repaint a preview over the
  // error the user is being shown.
  resetPartialPreview();
  // Same call as the status move (see settleIdle): the error supersedes whatever
  // the cold-translate phase was reporting.
  useApp.getState().setDictation({ status: "error", dictationError: message, level: 0, partial: "", warming: false, dictationPhase: null, sessionTargets: null, routePending: null });
  // Failure doorway: the dictation error itself lingers only briefly (chip/Home);
  // the banner persists with a "View logs" path to the full story.
  useApp.getState().setLogsDoorway("Dictation failed — the log has the details.");
  if (errorClearTimer) clearTimeout(errorClearTimer);
  errorClearTimer = setTimeout(() => {
    errorClearTimer = null;
    if (useApp.getState().status === "error") {
      useApp.getState().setDictation({ status: "idle", dictationError: null, activeProfile: null, dictationPhase: null });
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

/** The inverse, for key chatter: a worn switch can bounce a held chord (phantom release +
 *  re-press, ms apart), which lands here as "stop" then "start" during the start prologue.
 *  The stop sets stopRequestedDuringStart and the re-press start is swallowed by the busy
 *  gate — so the bounce always killed the session with 0 audio while the chord was still
 *  physically held. dictate()'s start path calls this when a start for the ALREADY-STARTING
 *  profile arrives mid-prologue: the re-press proves the chord is still down, so the newest
 *  press wins and the owed stop is dropped. The startingSession check also keeps it a no-op
 *  against the stale-flag window after a rejected prologue (flag survives, startingSession
 *  false). Returns whether a pending stop was cleared. */
export function cancelStopIfStarting(): boolean {
  if (!startingSession || !stopRequestedDuringStart) return false;
  stopRequestedDuringStart = false;
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
  pov?: Pick<Profile, "model" | "language" | "prompt" | "decodeOverrides" | "translationOverrides" | "overrideProfile" | "endpoint" | "typeAsISpeak" | "insertionOverrides">,
  /** The app focused BEFORE the caller took focus for a prompt (the translation-target
   *  picker). Without it, `startLiveInner`'s own `getFocusedApp` would resolve to OUR
   *  window and dictation would refuse to type. Absent = resolve normally. */
  preresolvedTarget?: FocusedApp | null,
): Promise<void> {
  if (startingSession) return;
  startingSession = true;
  stopRequestedDuringStart = false; // fresh start; a prologue stop sets it (see requestStopIfStarting)
  pendingReclassify = null; // a stale queued upgrade must not latch this unrelated session
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
    await startLiveInner(backend, deviceId, activation, pov, preresolvedTarget);
  } catch (e) {
    // startLiveInner awaits ensureListeners() + getFocusedApp() BEFORE its own try/catch, so a
    // reject there (e.g. an AT-SPI error out of get_focused_app) escapes to here. Surface it and
    // log — otherwise it leaks as an unhandled rejection through every `void startLive(...)` caller
    // (Home toggle, dictate, runOverlayAction) and the user sees nothing. The target poll and
    // activeEndpoint are not armed yet at the prologue stage, but the warm lease IS (it is taken
    // before the focus read) — flashError releases it.
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
  pov?: Pick<Profile, "model" | "language" | "prompt" | "decodeOverrides" | "translationOverrides" | "overrideProfile" | "endpoint" | "typeAsISpeak" | "insertionOverrides">,
  preresolvedTarget?: FocusedApp | null,
): Promise<void> {
  await ensureListeners();
  const setDictation = useApp.getState().setDictation;
  const s = useApp.getState().settings;
  const g = s.general;
  const rec = s.recording;
  // Arm hands-free auto-stop (0 = off): end a hands-free session after N min of continuous silence.
  // Hold/push-to-talk ends on key-release, so this is hands-free-only. Disarmed by stopLive/cancelLive.
  autoStopMemo = newSpeakMemo();
  lastSpokeAt = performance.now();
  autoStopMs = activation !== "hold" && rec.handsFreeAutoStopMin > 0 ? rec.handsFreeAutoStopMin * 60_000 : 0;
  // Effective values: a set per-Profile override wins; else inherit the Backend.
  const model = pov?.model?.trim() ? pov.model.trim() : backend.model;
  const language = pov?.language?.trim() ? pov.language.trim() : backend.language;
  // prompt is a 3-state sentinel sent to the backend: undefined → omit (inherit the
  // server DEFAULT_PROMPT); "" → explicit clear (no initial_prompt); value → use it.
  // A profile that set its prompt (incl. an explicit "" clear) wins; else the backend's
  // own tri-state — `backendPrompt` reads it, so a backend CLEARED to "" sends "" and
  // only an un-set one is omitted (a bare `backend.prompt !== ""` collapsed both).
  const prompt = pov?.prompt !== undefined ? pov.prompt : backendPrompt(backend);
  const decodeOverrides = mergeDecodeOverrides(backend.decodeOverrides, pov?.decodeOverrides);
  // A set per-Profile override-profile name wins; else inherit the Backend's.
  const overrideProfile = pov?.overrideProfile?.trim() ? pov.overrideProfile.trim() : backend.overrideProfile;
  // A set per-Profile endpoint wins; else inherit the Backend's (stream vs batch transport).
  const endpoint = pov?.endpoint ?? backend.endpoint;
  // T2T dictation translation: per-field merge (Profile wins over Backend);
  // any targets set = translate every injection this session (all targets,
  // blank-line separated, original first when includeOriginal).
  {
    const trOv = { ...backend.translationOverrides, ...pov?.translationOverrides };
    const trTargets = (trOv.translateTo ?? []).map((t) => t.trim()).filter(Boolean);
    sessionTranslationBase = {
      // The resolved source language, so the per-phrase request does not leave the server
      // to auto-detect a few words (every other T2T caller passes it); "auto"/"" → null.
      source: language && language !== "auto" ? language : null,
      includeOriginal: trOv.includeOriginal,
      model: trOv.model,
      glossary: trOv.glossary,
      mode: trOv.mode,
      contextSegments: trOv.contextSegments,
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      backendId: backend.id,
      // Unknown until this session sees a translate land: a server warm for
      // the LAST session may have evicted the model since, so warmth is
      // never carried across sessions.
      warm: null,
    };
    sessionTranslation = trTargets.length ? { ...sessionTranslationBase, targets: trTargets } : null;
    sessionTranslatedText = null;
    sessionByLang = {};
    clipByLang = undefined;
    sessionPerUtteranceDeclared = false;
    captureIds.reset();
    sessionTranslateWarned = false;
    sessionTranslateFailure = null;
    sessionPhraseContext = [];
    // Publish the RESOLVED route so the chip can show it. `sessionTranslation` is module
    // state the overlay's own webview can never read, and the chip must not re-derive it
    // from the Profile: the two are the same only until something can change the targets
    // for one session (a per-session picker). Cleared alongside the rest of the session's
    // state, so the standby dock falls back to previewing the home Profile's own route.
    // `routePending` says what the chip may NOT promise yet: a push-to-talk session with the
    // picker armed has no route until release ("undecided" → the chip's dashed "→ ?"), and a
    // hands-free "0" is acknowledged once as "original" (the one-shot hint from dictation.ts).
    const hint = routeHint;
    routeHint = null;
    useApp.getState().setDictation({
      sessionTargets: trTargets, // `[]` = this session translates nothing (see applySessionTargets)
      routePending: askTargetsAtSettle ? "undecided" : hint,
      translateFailure: null,
    });

    // Warm the models this session will need before the first phrase arrives.
    // Best-effort and silent: a server that doesn't know the endpoint is
    // indistinguishable from one that does.
    releaseWarmLease(); // a previous session's lease, if a teardown was skipped
    const trModel = sessionTranslation?.model?.trim() || undefined;
    const plan = preloadPlanFor({
      stages: sessionTranslation ? ["transcribing", "translating"] : ["transcribing"],
      whisperModel: model,
      translationModel: trModel,
    });
    if (plan.length) {
      warmLease = acquireWarm("dictation", {
        serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
        backendId: backend.id,
        models: plan,
      });
    }
    // Ask the server what is already resident, so the FIRST phrase can take the
    // short budget when the model is warm instead of always paying the cold
    // allowance. Forced: staleness is the entire point at session start, and the
    // answer is only useful before the first translate goes out — hence the
    // fire-and-forget shape (a session must never wait on a capability probe).
    if (sessionTranslation) {
      const tr = sessionTranslation;
      void refreshCaps(backend, { force: true })
        .then(() => {
          // The session may have ended (or been replaced) during the fetch;
          // only the session that asked may take the answer.
          if (sessionTranslation !== tr) return;
          // Never downgrade a PROVEN warm: this probe is fire-and-forget and
          // can resolve after a phrase has already had a translation land, and
          // its answer is a snapshot of the inventory, not of what just ran.
          if (tr.warm === true) return;
          tr.warm = translationWarm(ownProp(useApp.getState().caps, backend.id) ?? null, trModel);
        })
        .catch(() => {});
    }
  }

  // Per-app rule (P16): the focused app at start decides block/method/paste-shortcut. Resolved
  // once here — you dictate into the app you triggered from — via the shared resolveInjectionTarget
  // (same policy resolveTarget re-runs per phrase, so the frozen start value can't diverge).
  // A caller that had to take focus first (the picker) already read this — using its
  // value keeps the session aimed at the app the user was actually in.
  const targetApp = preresolvedTarget !== undefined ? preresolvedTarget : await getFocusedApp();
  // The own-window short-circuit now lives INSIDE resolveInjectionTarget, so this and the
  // per-phrase path share it by construction rather than by two hand-copied literals — which
  // is what diverged once already, and what a Profile layer would have silently bypassed.
  // The Profile's own overrides, frozen for the session. `resolveTarget` re-reads the
  // app-rule layer per phrase but never this one — a profile does not change mid-session,
  // and the poll can outlive `activeProfile`.
  const profileInsertion: InsertionOverrides = pov?.insertionOverrides ?? {};
  const { rule, notEditable, method, pasteShortcut } = resolveInjectionTarget(
    targetApp ?? null,
    useApp.getState().appRules,
    g,
    profileInsertion,
  );

  insertCfg = {
    timing: g.insertTiming,
    method,
    pasteShortcut,
    profileInsertion,
    targetApp: targetApp ?? null,
    blocked: rule?.block ?? false,
    notEditable,
    activation,
    // Hold/PTT holds the chord the whole time → live TYPING collides with the held modifier,
    // so paste/direct fall back to the single insert-on-release ("stop"). Clipboard-only types
    // nothing, so it can run live in any activation — it just refreshes the clipboard per segment.
    // The user's ask now comes from the PROFILE, not a global three-way. The other two
    // terms are unchanged — see liveAllowed for why the activation must be the runtime one.
    // Profile override wins; absent = inherit the Dictation-tab default. Without the
    // fallback the editor's "Inherit" would silently mean "off".
    // `insertTiming === "off"` still reaches here via sync apply (a pre-migration peer
    // that slips past the "off"→"stop" remap, or a race with a local migration): the
    // `closed` handler's `cfg.timing === "off"` guard drops the whole insert, but only
    // when `live` is false — otherwise phrases are injected live and that guard never runs.
    live: g.insertTiming !== "off" && liveAllowed({ wants: pov?.typeAsISpeak ?? g.typeAsISpeak, endpoint, activation, method }),
  };
  // Freeze the history-capture metadata for this session (see sessionMeta).
  // The profile was stamped into the store synchronously before startLive.
  {
    const profId = useApp.getState().activeProfile;
    const prof = profId ? useApp.getState().profiles.find((p) => p.id === profId) : undefined;
    sessionMeta = {
      startedAt: Date.now(),
      backendId: backend.id,
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      // 32 hex, the shape the server validates (`^[0-9a-f]{8,64}$`).
      clientJob: endpoint === "batch" ? null : crypto.randomUUID().replace(/-/g, ""),
      model,
      language,
      profileName: prof?.name,
      profileTag: prof?.tag?.trim() || undefined,
      activation,
      appId: targetApp?.isSelf ? undefined : targetApp?.appId,
      appTitle: targetApp?.isSelf ? undefined : targetApp?.title?.trim() || undefined,
      blocked: rule?.block ?? false,
    };
    sessionRecordingPath = null;
    capturedRecordId = null;
    sessionOutcomeReported = false;
  }
  committedDoc = "";
  injectedText = "";
  seenDoc = "";
  bankedDoc = "";
  // The listener closure outlives every session, so a tick armed by the PREVIOUS session would
  // otherwise write its transcript into this one's just-cleared chip — `inSession()` is true and
  // cannot tell the two apart.
  resetPartialPreview();
  beganInjection = false;
  sessionTyped = false;
  sessionClipboard = false;
  sessionInsertSkipped = false;
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
    // Clear any prior session's done marker / pulse / note so the fresh session starts clean.
    lastInsert: null,
    sessionOutcome: null,
    sessionNote: null,
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
  capturing = true;
  // A chord-family upgrade landed during the prologue (the common case — Space
  // arrives well inside the ~1s start) — the session context exists now, apply it
  // so this session comes up hands-free from its first frame.
  if (pendingReclassify) {
    const upgraded = pendingReclassify;
    pendingReclassify = null;
    applyReclassify(upgraded);
  }
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
        model,
        language,
        prompt,
        decodeOverrides,
        overrideProfile,
        deviceId,
        save: rec.saveRecordings,
        recordingsDir: audioBasePref(rec),
        trimSilence: rec.trimSilence,
        muteSystem: rec.muteSystemAudio,
        standard: effectiveServerKind(backend, ownProp(useApp.getState().connections, backend.id)) === "standard",
      });
    } else {
      await startStream({
        serverUrl: sessionServerUrl,
        backendId: backend.id,
        model,
        language,
        prompt,
        decodeOverrides,
        overrideProfile,
        // Tell the server a translation is coming on a separate request, so
        // it holds each utterance's log receipt open and merges the two
        // halves into one block instead of logging a receipt and then orphan
        // [translate] lines with nothing linking them. sessionTranslation was
        // frozen a few lines above, so this is the same intent the session
        // will actually act on — not a second, drifting source of truth.
        translateExpect: sessionTranslation
          ? {
              targets: [...sessionTranslation.targets],
              include_original: !!sessionTranslation.includeOriginal,
              // Stop-timing translates the whole transcript in ONE call at the
              // end, so there is no per-utterance translation to wait for and
              // holding a receipt per utterance would strand every one of them
              // until the server's idle sweep.
              per_utterance: (sessionPerUtteranceDeclared = !!insertCfg?.live),
            }
          : null,
        responseFormat: backend.responseFormat,
        // Session id for the server's usage rollup (one run per session) + the outcome post.
        clientJob: sessionMeta?.clientJob ?? null,
        deviceId,
        save: rec.saveRecordings,
        recordingsDir: audioBasePref(rec),
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
    capturing = false;
    // The lease was acquired before the start invoke; every other exit releases it, and a
    // leaked one pings the server that just refused us every two minutes (preload.ts).
    releaseWarmLease();
    console.error("start dictation failed:", e);
    flashError(String(e));
  }
}

/** Chord family: upgrade the RUNNING hold session to hands-free in place — no
 *  restart, the capture/transport keep going. Flips what hands-free changes:
 *  the auto-stop timer arms, live TYPING becomes allowed once the chord is
 *  released (recomputed below), and the chip/usage relabel to the hands-free
 *  Profile. That Profile's own backend/language/prompt overrides do NOT
 *  apply — the transport was opened for the hold's backend and stays there.
 *  Mid-prologue (insertCfg not built yet) the flip is queued and applied by
 *  startLiveInner the moment the session context exists. */
export function reclassifyLive(profile: Profile): void {
  if (startingSession) {
    pendingReclassify = profile;
    return;
  }
  if (!insertCfg) return; // no session — dictate() only calls this while busy
  applyReclassify(profile);
}

function applyReclassify(profile: Profile): void {
  const st = useApp.getState();
  if (insertCfg) {
    insertCfg.activation = "handsfree";
    // The chord gets released now the session is hands-free, so live TYPING becomes
    // safe — recompute `live` exactly as startLiveInner does (activation is no longer
    // "hold"). The append-only delta insert catches up anything committed before the
    // flip. EXCEPT when a hard break already banked text (a long hold upgraded late):
    // the live path never re-reads bankedDoc, so flipping `live` would drop it at stop
    // — keep the session in its started insert mode in that rare case.
    if (bankedDoc === "") {
      // Through the SAME helper as startLiveInner, which is the point of extracting it: this
      // site used to open-code the expression and had already drifted — it dropped the
      // hold/clipboard term while its comment above claimed it recomputed "exactly as
      // startLiveInner does". Equal only because activation is "handsfree" by now; any term
      // added to the derivation would silently not have applied to an upgraded session.
      insertCfg.live = liveAllowed({
        wants: profile.typeAsISpeak ?? useApp.getState().settings.general.typeAsISpeak,
        // `activeEndpoint` is null only with no transport open, and this runs on a live
        // session — but "batch" is the safe read either way (it forbids live typing).
        endpoint: activeEndpoint ?? "batch",
        activation: insertCfg.activation ?? "handsfree",
        method: insertCfg.method,
      });
    }
  }
  // Arm the hands-free auto-stop (a hold session leaves it off — key-release ends it).
  const rec = st.settings.recording;
  autoStopMemo = newSpeakMemo();
  lastSpokeAt = performance.now();
  autoStopMs = rec.handsFreeAutoStopMin > 0 ? rec.handsFreeAutoStopMin * 60_000 : 0;
  st.setDictation({ activeProfile: profile.id });
  if (sessionMeta) {
    sessionMeta.activation = "handsfree";
    sessionMeta.profileName = profile.name;
    sessionMeta.profileTag = profile.tag?.trim() || undefined;
  }
}

export async function stopLive(): Promise<void> {
  autoStopMs = 0; // disarm hands-free auto-stop — we're stopping now
  // The mic closes with this call, not with the `closed` that follows it: from here a
  // second stop gesture is a CANCEL again (the recovery for a wedged finalize), even if a
  // per-phrase translate still has the status on "translating".
  capturing = false;
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
    capturing = false;
    // A rejected stop leaves no `closed` behind to clean anything up, so the
    // stop-timing one-shot's translate (which can be waiting out a 60 s cold
    // model load) would keep the server busy for text this path is about to
    // recover to the clipboard instead. Stop it here.
    cancelDictationTranslate();
    releaseWarmLease();
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
          // Same as the stuck-finalize sibling: `landed: false` means nothing was written.
          ({ landed: onClipboard } = await injectText({ text: pending, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: [] }));
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
  autoStopMs = 0; // disarm hands-free auto-stop
  voidPendingHoldStart(); // a deliberate cancel also voids a queued fast re-press (in-flight check included)
  pendingReclassify = null; // …and a queued chord-family upgrade
  clearWarmTimer();
  clearStuckWatchdog();
  stopTargetPoll();
  // A cancelled session still happened on the server (its utterances are counted); tell it
  // nothing landed, so the Dictation panel shows "Nothing" rather than "unreported".
  reportSessionOutcome("none");
  sessionMeta = null; // a cancelled session is never recorded to History
  // A translate may be in flight for a phrase this cancel just discarded. Tell
  // the server to stop: dropping our end leaves it generating tokens for text
  // nobody will read (Rust waits an hour on that request). Every cancel entry
  // point in the app — dictation.ts's five call sites, Home's stop button,
  // App.tsx's resume handler and the chip's ✕ — routes through THIS function,
  // so this one call covers them all; don't add duplicates at those sites.
  cancelDictationTranslate();
  releaseWarmLease();
  committedDoc = "";
  injectedText = "";
  seenDoc = "";
  bankedDoc = "";
  resetPartialPreview();
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
  sessionInsertSkipped = false;
  clearPhraseEnd();
  insertCfg = null;
  injectChain = Promise.resolve();
  askTargetsAtSettle = null; // see settleIdle
  routeHint = null;
  useApp
    .getState()
    // Cancelled → no done marker (outcome "none"); clear any pending per-phrase pulse.
    // `warming: false` so a cancel during warm-up doesn't strand the chip on "warming up…".
    .setDictation({ status: "idle", warming: false, partial: "", level: 0, dictationError: null, targetApp: null, targetSkip: null, sessionOutcome: "none", sessionNote: null, lastInsert: null, activeProfile: null, dictationPhase: null, sessionTargets: null, routePending: null, translateFailure: null });
  const endpoint = activeEndpoint;
  activeEndpoint = null;
  capturing = false;
  try {
    // ABORT, don't finish: a cancel discards the in-flight session, so skip the drain (streaming) /
    // the transcription POST (batch) — they'd produce a result we immediately throw away. This also
    // releases the system-mute guard right away.
    // `true`: the user pressed Cancel, so Rust also aborts a transcript that is being typed
    // right now — in stop-timing mode the session is already gone by then, and the flag is
    // the only thing that distinguishes this from the closed-handler's release below.
    if (endpoint === "batch") await cancelRecord(true);
    else await cancelStream(true);
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
