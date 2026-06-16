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
import {
  isTauri,
  startStream,
  stopStream,
  startRecord,
  stopRecord,
  injectText,
  beginInjection,
  endInjection,
  restoreClipboardSnapshot,
  getFocusedApp,
  reregisterShortcuts,
} from "./api";
import type { ActivationKind, Backend, DecodeOverrides, FocusedApp } from "./types";

let wired = false;
let activeEndpoint: "stream" | "batch" | null = null;
// The whole post-processed document through the last `final` (committed + tail),
// for the chip/Home preview. Partials carry only the current utterance, so we
// prepend this to keep earlier lines visible while the next sentence is spoken.
let committedDoc = "";
// The exact text we've typed into the focused field so far (live mode), so we can
// diff the next document against it and append only what's new.
let injectedText = "";
// Documents completed before a hard break, accumulated for the "stop"-timing single
// insert. Live mode types as it goes, so it doesn't read this back.
let bankedDoc = "";
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
}
let insertCfg: InsertCfg | null = null;
// Whether we snapshotted the clipboard at session start (live paste), so the close handler
// knows to restore it. Tracked separately because the insert method is now re-resolved per
// injection (it can change as you switch windows) rather than frozen at dictation start.
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
  enqueueInject(async () => {
    const t = await resolveTarget();
    if (t.method === "clipboard") return;
    await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
  });
}

/** Enqueue a clipboard restore (live paste): put the user's ORIGINAL clipboard back from the
 *  once-captured snapshot, without consuming it (so the next phrase's paste + restore repeats).
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
 *  drives BOTH per-phrase actions: the auto-Enter and the clipboard restore. Called on every
 *  partial/final while live, so ongoing speech keeps deferring them; once speech stops for
 *  PHRASE_END_QUIET_MS the phrase is done. The backend hard-break boundary (~20s) is a backstop. */
function bumpPhraseEnd(): void {
  if (!insertCfg?.live) return;
  if (!(insertCfg.autoEnter || insertCfg.restoreClipboard)) return;
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
      enqueueRestoreSnapshot();
    }
  }, PHRASE_END_QUIET_MS);
}

/** Drop any pending phrase-end Enter/restore (session reset / abort). */
function clearPhraseEnd(): void {
  if (phraseEndTimer) {
    clearTimeout(phraseEndTimer);
    phraseEndTimer = null;
  }
  phraseDirty = false;
  clipDirty = false;
}

/** Resolve the CURRENT injection target (focused app → per-app rule) into the method +
 *  paste-shortcut to use RIGHT NOW. Called per injection — NOT once at dictation start — so
 *  per-app rules follow window switches mid-session: a latched/live dictation that moves
 *  from Konsole to another app picks up each window's own rule instead of being frozen to
 *  whatever was focused when dictation began. Mirrors the resolution in startLive. */
async function resolveTarget(): Promise<{ method: InsertCfg["method"]; pasteShortcut: string[] }> {
  const g = useApp.getState().settings.general;
  const appRules = useApp.getState().appRules;
  const targetApp = await getFocusedApp();
  const rule = targetApp
    ? appRules.find((r) => r.appId.toLowerCase() === targetApp.appId.toLowerCase())
    : undefined;
  // Opt-in deep detection: a definitely-non-editable focused element (and no rule forcing
  // typing here) → clipboard-only. Positive-only: only editable===false skips.
  const notEditable = !!(g.deepFieldDetection && !rule?.block && targetApp?.editable === false);
  const method: InsertCfg["method"] =
    rule?.block || notEditable ? "clipboard" : rule?.insertMethod ?? g.insertMethod;
  const pasteShortcut = rule?.pasteShortcut ?? g.pasteShortcut;
  return { method, pasteShortcut };
}

// Hold the "injecting" state at least this long, so the writing-out phase is actually
// perceivable on screen. A sub-frame flash would just read as the chip snapping shut
// the instant you stop — which is the very thing we're fixing.
const MIN_INJECT_VISIBLE_MS = 450;

// Return to idle once the injection queue has fully drained (the text has landed in
// the focused field) — but never before MIN_INJECT_VISIBLE_MS, and never over a status
// that has moved on (a fresh session, or an error that arrived meanwhile).
function settleToIdleAfterInjection(startedAt: number): void {
  void injectChain.then(() => {
    const wait = Math.max(0, MIN_INJECT_VISIBLE_MS - (performance.now() - startedAt));
    setTimeout(() => {
      if (useApp.getState().status === "injecting") {
        useApp.getState().setDictation({ status: "idle" });
      }
    }, wait);
  });
}

// Backstop for a wedged "finalizing…": stopLive() sets "transcribing" and then waits
// for the stream's terminal `closed`. If the socket died silently (suspend, dropped
// link) that event may never arrive, leaving the chip stuck. After this long with no
// resolution we force a clean idle. Streaming only — a batch transcription can take a
// while legitimately (bounded by the HTTP client's own 120 s timeout), and the Rust
// drain deadline (~6 s) normally resolves a live stream well before this fires.
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
      void cancelLive();
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
  wired = true;
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
  await listen<number>("stream://level", (e) => {
    latestLevel = e.payload;
    const wait = LEVEL_MIN_MS - (performance.now() - lastLevelAt);
    if (wait <= 0) {
      if (levelTimer) {
        clearTimeout(levelTimer);
        levelTimer = undefined;
      }
      lastLevelAt = performance.now();
      setDictation({ level: latestLevel });
    } else if (!levelTimer) {
      levelTimer = setTimeout(() => {
        levelTimer = undefined;
        lastLevelAt = performance.now();
        setDictation({ level: latestLevel });
      }, wait);
    }
  });

  await listen<{ committed: string; pending: string }>("stream://partial", (e) => {
    const live = e.payload.committed + e.payload.pending;
    const sep = committedDoc && live && !/\s$/.test(committedDoc) ? " " : "";
    setDictation({ status: "listening", partial: committedDoc + sep + live });
    // Still speaking → push the per-phrase Enter + clipboard restore back until you pause.
    if (phraseDirty || clipDirty) bumpPhraseEnd();
  });

  await listen<{ committed: string; tail: string; last: boolean }>("stream://final", (e) => {
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
      // Compute both candidate payloads synchronously (so the append baseline stays in
      // event order), then pick + inject inside the queue after resolving the CURRENT
      // window's rule — so the method/paste-shortcut follow window switches per segment.
      //   • clipboard → the FULL transcript-so-far (set_clipboard_persistent replaces the
      //     prior owner); bankedDoc carries pre-boundary utterances so it accumulates.
      //   • typed (paste/direct), append-only → only the new suffix beyond what we've typed.
      //     Strip the document's leading whitespace (Whisper prefixes a space) so the first
      //     phrase has none; inner/inter-phrase spacing is preserved. Never backspace/revise.
      const fullDoc = (bankedDoc + committedDoc).trim();
      const target = committedDoc.replace(/^\s+/, "");
      const c = commonPrefixLen(injectedText, target);
      const toType = target.slice(c);
      injectedText = target;
      enqueueInject(async () => {
        const t = await resolveTarget();
        if (t.method === "clipboard") {
          await injectText({ text: fullDoc, method: "clipboard", autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
        } else if (toType.length > 0) {
          await injectText({ text: toType, method: t.method, autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
          // A real paste just clobbered the user's clipboard with the transcript → it owes a
          // restore at phrase end. Direct typing never touches the clipboard, so don't.
          if (t.method === "paste") clipDirty = true;
        }
      });
      // A phrase's text just landed AND the document actually GREW (`toType` is empty for a
      // re-sent final — e.g. the flush `final` the drain emits when you end latch — so we must
      // NOT re-arm for text that was already typed + Entered; doing so is what fired a second
      // Enter at latch end). (Re)start the quiet timer so the per-phrase Enter + clipboard
      // restore fire ~PHRASE_END_QUIET_MS after you stop speaking (not at the ~20s hard break).
      // Ongoing speech keeps bumping the timer via stream://partial.
      if (toType.length > 0) {
        if (insertCfg.autoEnter) phraseDirty = true;
        bumpPhraseEnd();
      }
    }
  });

  await listen<string>("stream://boundary", (e) => {
    // Long-silence hard break: the server reset its document. Bank what we have (for
    // the stop-timing single insert), drop our live baseline so the next utterance
    // starts fresh, clear the preview, and optionally type the configured separator.
    const sep = e.payload || "";
    // Always bank the finished document: the "stop" single insert reads it back, and so
    // does clipboard-only live (full transcript on the clipboard). It's cheap, and typed
    // live ignores it (it resets committedDoc/injectedText below and appends from there).
    if (committedDoc) bankedDoc += committedDoc + sep;
    committedDoc = "";
    injectedText = "";
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
    if (phraseEndTimer) {
      clearTimeout(phraseEndTimer);
      phraseEndTimer = null;
    }
    if (insertCfg?.live) {
      if (insertCfg.autoEnter) {
        if (phraseDirty) enqueueAutoEnter();
      } else if (sep) {
        enqueueInject(async () => {
          const t = await resolveTarget();
          if (t.method === "clipboard") return;
          if (sep.includes("\n")) {
            await injectText({ text: "", method: t.method, autoEnter: true, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
          } else {
            await injectText({ text: sep, method: t.method, autoEnter: false, restoreClipboard: false, pasteShortcut: t.pasteShortcut });
          }
        });
      }
      // The phrase ended hard → restore the clipboard too, as a backstop in case the quiet
      // timer hadn't already (the timer normally fires ~PHRASE_END_QUIET_MS before this).
      if (clipDirty && beganInjection) enqueueRestoreSnapshot();
    }
    phraseDirty = false;
    clipDirty = false;
  });

  await listen<string>("stream://status", (e) => {
    if (e.payload === "ready") {
      setDictation({ status: "listening", dictationError: null });
    } else if (e.payload === "closed") {
      clearStuckWatchdog(); // the stream resolved on its own
      // Stop the pending phrase-end Enter from firing after the session closes; the stop tail
      // below decides the final phrase's Enter. Keep `phraseDirty` for that decision.
      if (phraseEndTimer) {
        clearTimeout(phraseEndTimer);
        phraseEndTimer = null;
      }
      // Don't clobber an error — `error` is followed immediately by `closed`.
      const st = useApp.getState();
      if (st.status === "error") {
        setDictation({ level: 0 });
        return;
      }
      // Capture has stopped; freeze the meter. From here we hold an "injecting" state
      // while the transcript is written out to the focused field — so the chip keeps
      // showing a processing indicator until the text actually lands, rather than
      // collapsing the instant the server closes (the injection is async). We only
      // return to idle once the queue drains (see settleToIdleAfterInjection).
      setDictation({ level: 0 });

      const cfg = insertCfg;
      if (!cfg || cfg.timing === "off") {
        setDictation({ status: "idle" });
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
        clipDirty = false; // end_injection below does the final restore + clears the snapshot
        const hasTail = enterTail || beganInjection;
        if (!hasTail) {
          setDictation({ status: "idle" });
          return;
        }
        setDictation({ status: "injecting" });
        if (enterTail) enqueueAutoEnter();
        if (beganInjection) enqueueInject(() => endInjection());
        settleToIdleAfterInjection(startedAt);
      } else {
        // "stop" (and "live" on a batch profile): insert the whole transcript once, into the
        // window focused NOW (resolved in-queue) — not whatever was focused at start.
        // bankedDoc holds any documents finalized before a hard break this session.
        const text = (bankedDoc + committedDoc).trim();
        if (!text) {
          setDictation({ status: "idle" });
          return;
        }
        setDictation({ status: "injecting" });
        enqueueInject(async () => {
          const t = await resolveTarget();
          await injectText({
            text,
            method: t.method,
            autoEnter: cfg.autoEnter,
            restoreClipboard: cfg.restoreClipboard,
            pasteShortcut: t.pasteShortcut,
          });
        });
        settleToIdleAfterInjection(startedAt);
      }
    }
  });

  await listen<string>("stream://error", (e) => {
    clearStuckWatchdog();
    console.error("stream error:", e.payload);
    setDictation({ status: "error", dictationError: e.payload, level: 0 });
    // Tear down the Rust capture session so the mic closes and system audio
    // un-mutes immediately — the dead WS task doesn't drop it, so without this the
    // mic light + speaker mute linger until the next dictation. The visible error
    // status is preserved (the subsequent `closed` keeps it; we don't reset to idle).
    const endpoint = activeEndpoint;
    activeEndpoint = null;
    void (endpoint === "batch" ? stopRecord() : stopStream()).catch((err) =>
      console.error("stream error teardown failed:", err),
    );
  });

  // The server refused one or more decode overrides because the field is
  // admin-locked (reported in the stream `ready` frame). Non-blocking FYI;
  // cleared at the start of the next dictation.
  await listen<string[]>("stream://overrides-ignored", (e) => {
    setDictation({ overridesIgnored: e.payload });
  });
}

/** Merge a Backend's decode defaults with a Profile's overrides (profile wins per
 *  field). Unset values (undefined/null/empty string = "inherit") are dropped, so a
 *  field only reaches the server when explicitly set. Returns undefined when nothing
 *  is set — the wire then carries no decode_overrides at all. */
function mergeDecodeOverrides(
  base?: DecodeOverrides,
  over?: DecodeOverrides,
): DecodeOverrides | undefined {
  const out: Record<string, unknown> = {};
  for (const src of [base, over]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== null && v !== "") out[k] = v;
    }
  }
  return Object.keys(out).length ? (out as DecodeOverrides) : undefined;
}

export async function startLive(
  backend: Backend,
  deviceId: string | null,
  activation: ActivationKind,
  pov?: { language?: string; prompt?: string; decodeOverrides?: DecodeOverrides; overrideProfile?: string },
): Promise<void> {
  await ensureListeners();
  const setDictation = useApp.getState().setDictation;
  const s = useApp.getState().settings;
  const g = s.general;
  const rec = s.recording;
  // Effective values: a set per-Profile override wins; else inherit the Backend.
  const language = pov?.language?.trim() ? pov.language : backend.language;
  // prompt is a 3-state sentinel sent to the backend: undefined → omit (inherit the
  // server DEFAULT_PROMPT); "" → explicit clear (no initial_prompt); value → use it.
  // A profile that set its prompt (incl. an explicit "" clear) wins; else the
  // backend's prompt; an empty backend prompt means inherit, so omit.
  const prompt =
    pov?.prompt !== undefined ? pov.prompt : backend.prompt !== "" ? backend.prompt : undefined;
  const decodeOverrides = mergeDecodeOverrides(backend.decodeOverrides, pov?.decodeOverrides);
  // A set per-Profile override-profile name wins; else inherit the Backend's.
  const overrideProfile = pov?.overrideProfile?.trim() ? pov.overrideProfile : backend.overrideProfile;

  // Per-app rule (P16): the focused app at start decides block/method/paste-shortcut.
  // Resolved once here — you dictate into the app you triggered from. Via AT-SPI;
  // getFocusedApp returns null when nothing is known yet → no rule, global settings apply.
  const targetApp = await getFocusedApp();
  const rule = targetApp
    ? useApp.getState().appRules.find((r) => r.appId.toLowerCase() === targetApp.appId.toLowerCase())
    : undefined;
  // Opt-in deep field detection: if the focused element definitively isn't editable — and
  // no rule forces typing here — don't type into it. Positive-only: editable===false is the
  // ONLY skip; null/undefined (unknown / app not on the a11y bus) still types.
  const notEditable =
    g.deepFieldDetection && !rule?.block && targetApp?.editable === false;
  // A blocked app OR a non-editable target is coerced to clipboard-only: nothing is typed
  // there, but the text isn't lost — it lands on the clipboard for the user to paste.
  const method: InsertCfg["method"] =
    rule?.block || notEditable ? "clipboard" : rule?.insertMethod ?? g.insertMethod;
  const pasteShortcut = rule?.pasteShortcut ?? g.pasteShortcut;

  insertCfg = {
    timing: g.insertTiming,
    method,
    pasteShortcut,
    autoEnter: g.autoEnter,
    restoreClipboard: g.restoreClipboard,
    targetApp: targetApp ?? null,
    blocked: rule?.block ?? false,
    notEditable,
    // Hold/PTT holds the chord the whole time → live TYPING collides with the held modifier,
    // so paste/direct fall back to the single insert-on-release ("stop"). Clipboard-only types
    // nothing, so it can run live in any activation — it just refreshes the clipboard per segment.
    live:
      g.insertTiming === "live" &&
      backend.endpoint === "stream" &&
      (method === "clipboard" || activation !== "hold"),
  };
  committedDoc = "";
  injectedText = "";
  bankedDoc = "";
  beganInjection = false;
  clearPhraseEnd();
  injectChain = Promise.resolve();
  clearStuckWatchdog(); // fresh session — drop any leftover backstop

  setDictation({ status: "listening", partial: "", level: 0, dictationError: null, overridesIgnored: [] });
  activeEndpoint = backend.endpoint;

  // Live paste: snapshot the clipboard ONCE here, then restore the original from it after each
  // pasted phrase (driven by the phrase-end quiet timer) — so an ongoing latch session, which
  // never reaches the stop-time restore, still hands the user's clipboard back between phrases.
  // Keyed off the start method; if focus later moves to a non-paste window we still restore.
  if (insertCfg.live && insertCfg.method === "paste" && insertCfg.restoreClipboard) {
    try {
      await beginInjection();
      beganInjection = true;
    } catch (e) {
      console.error("beginInjection failed:", e);
    }
  }

  try {
    if (backend.endpoint === "batch") {
      await startRecord({
        serverUrl: backend.serverUrl,
        backendId: backend.id,
        model: backend.model,
        language,
        prompt,
        decodeOverrides,
        overrideProfile,
        deviceId,
        save: rec.saveRecordings,
        muteSystem: rec.muteSystemAudio,
      });
    } else {
      await startStream({
        serverUrl: backend.serverUrl,
        backendId: backend.id,
        model: backend.model,
        language,
        prompt,
        decodeOverrides,
        overrideProfile,
        responseFormat: backend.responseFormat,
        deviceId,
        save: rec.saveRecordings,
        muteSystem: rec.muteSystemAudio,
      });
    }
  } catch (e) {
    console.error("start dictation failed:", e);
    setDictation({ status: "error", dictationError: String(e) });
  }
}

export async function stopLive(): Promise<void> {
  // Streaming: server flushes + drains. Batch: transcription runs now. Either way the
  // `closed` event then moves us "transcribing" → "injecting" (while the text is
  // written out) → "idle" — so the chip shows progress the whole way through.
  useApp.getState().setDictation({ status: "transcribing" });
  // Guard against a `closed` that never comes (socket died mid-finalize).
  armStuckWatchdog();
  if (activeEndpoint === "batch") await stopRecord();
  else await stopStream();
}

/** Hard-reset dictation to idle immediately: abort the in-flight session, drop the
 *  pending transcript, and return the UI to idle. This is the escape hatch for a
 *  wedged "finalizing…"/"inserting…" — where the stream died (suspend / dropped link)
 *  and the normal stop path is waiting on an event that will never arrive. Also
 *  re-applies the hotkey bindings, since a suspend can leave a hold-to-talk chord
 *  stuck "down" in the evdev backend (a dropped key-release) — so the one action
 *  recovers both the recording state AND the shortcuts. */
export async function cancelLive(): Promise<void> {
  clearStuckWatchdog();
  committedDoc = "";
  injectedText = "";
  bankedDoc = "";
  // If we snapshotted the clipboard for live paste, give the user's original back and clear the
  // snapshot so it can't leak into the next session (end_injection restores + consumes it).
  if (beganInjection) void endInjection();
  beganInjection = false;
  clearPhraseEnd();
  insertCfg = null;
  injectChain = Promise.resolve();
  useApp
    .getState()
    .setDictation({ status: "idle", partial: "", level: 0, dictationError: null });
  const endpoint = activeEndpoint;
  activeEndpoint = null;
  try {
    if (endpoint === "batch") await stopRecord();
    else await stopStream();
  } catch (e) {
    console.error("cancelLive: stop failed:", e);
  }
  // Clear any stuck hardware-hotkey state (re-enumerates keyboards → fresh held-set).
  try {
    await reregisterShortcuts();
  } catch (e) {
    console.error("cancelLive: reregister shortcuts failed:", e);
  }
}
