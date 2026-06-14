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
  reregisterShortcuts,
} from "./api";
import type { ActivationKind, Backend, DecodeOverrides } from "./types";

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
  method: "paste" | "direct";
  autoEnter: boolean;
  restoreClipboard: boolean;
  live: boolean; // timing === "live", a streaming backend, AND latch activation (never hold)
}
let insertCfg: InsertCfg | null = null;
// Serialise every injection op so backspaces/types never interleave or race.
let injectChain: Promise<void> = Promise.resolve();
function enqueueInject(fn: () => Promise<void>): void {
  injectChain = injectChain.then(fn).catch((e) => console.error("inject failed:", e));
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

  await listen<number>("stream://level", (e) => setDictation({ level: e.payload }));

  await listen<{ committed: string; pending: string }>("stream://partial", (e) => {
    const live = e.payload.committed + e.payload.pending;
    const sep = committedDoc && live && !/\s$/.test(committedDoc) ? " " : "";
    setDictation({ status: "listening", partial: committedDoc + sep + live });
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
      // Strip the document's leading whitespace (Whisper prefixes a space) so the
      // first phrase isn't injected with a leading space. Only the START — inner
      // and inter-phrase spacing is preserved.
      const target = committedDoc.replace(/^\s+/, "");
      const c = commonPrefixLen(injectedText, target);
      const toType = target.slice(c);
      injectedText = target;
      if (toType.length > 0) {
        const method = insertCfg.method;
        // Append-only → paste works too; honour the chosen method. No per-segment
        // clipboard restore (begin/endInjection snapshots once around the session).
        enqueueInject(() =>
          injectText({ text: toType, method, autoEnter: false, restoreClipboard: false }),
        );
      }
    }
  });

  await listen<string>("stream://boundary", (e) => {
    // Long-silence hard break: the server reset its document. Bank what we have (for
    // the stop-timing single insert), drop our live baseline so the next utterance
    // starts fresh, clear the preview, and optionally type the configured separator.
    const sep = e.payload || "";
    if (committedDoc) bankedDoc += committedDoc + sep;
    committedDoc = "";
    injectedText = "";
    setDictation({ partial: "" });
    if (insertCfg?.live && sep) {
      const method = insertCfg.method;
      // A "\n" separator is a real Enter (a pasted newline gets swallowed by some
      // apps); anything else is typed/pasted literally.
      if (sep.includes("\n")) {
        enqueueInject(() =>
          injectText({ text: "", method, autoEnter: true, restoreClipboard: false }),
        );
      } else {
        enqueueInject(() =>
          injectText({ text: sep, method, autoEnter: false, restoreClipboard: false }),
        );
      }
    }
  });

  await listen<string>("stream://status", (e) => {
    if (e.payload === "ready") {
      setDictation({ status: "listening", dictationError: null });
    } else if (e.payload === "closed") {
      clearStuckWatchdog(); // the stream resolved on its own
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
        // Phrases were injected live as you spoke; only the tail is left — a real Enter
        // (not a pasted "\n", which some apps swallow) and the one-shot clipboard
        // restore. Show "injecting" only if there's actually tail work to write out,
        // and only until the queue (any still-in-flight live phrases + the tail) drains.
        const hasTail = cfg.autoEnter || (cfg.method === "paste" && cfg.restoreClipboard);
        if (!hasTail) {
          setDictation({ status: "idle" });
          return;
        }
        setDictation({ status: "injecting" });
        if (cfg.autoEnter) {
          enqueueInject(() =>
            injectText({ text: "", method: cfg.method, autoEnter: true, restoreClipboard: false }),
          );
        }
        if (cfg.method === "paste" && cfg.restoreClipboard) {
          enqueueInject(() => endInjection());
        }
        settleToIdleAfterInjection(startedAt);
      } else {
        // "stop" (and "live" on a batch profile): insert the whole transcript once.
        // bankedDoc holds any documents finalized before a hard break this session.
        const text = (bankedDoc + committedDoc).trim();
        if (!text) {
          setDictation({ status: "idle" });
          return;
        }
        setDictation({ status: "injecting" });
        enqueueInject(() =>
          injectText({
            text,
            method: cfg.method,
            autoEnter: cfg.autoEnter,
            restoreClipboard: cfg.restoreClipboard,
          }),
        );
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

  insertCfg = {
    timing: g.insertTiming,
    method: g.insertMethod,
    autoEnter: g.autoEnter,
    restoreClipboard: g.restoreClipboard,
    // Hold/PTT holds the chord the whole time → live injection collides with the
    // held modifier. Fall back to the single insert-on-release (the "stop" path).
    live: g.insertTiming === "live" && backend.endpoint === "stream" && activation !== "hold",
  };
  committedDoc = "";
  injectedText = "";
  bankedDoc = "";
  injectChain = Promise.resolve();
  clearStuckWatchdog(); // fresh session — drop any leftover backstop

  setDictation({ status: "listening", partial: "", level: 0, dictationError: null, overridesIgnored: [] });
  activeEndpoint = backend.endpoint;

  // Live paste: snapshot the clipboard once so we can restore it on stop (we skip
  // per-segment restore to avoid churn while pasting each phrase).
  if (insertCfg.live && insertCfg.method === "paste" && insertCfg.restoreClipboard) {
    try {
      await beginInjection();
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
