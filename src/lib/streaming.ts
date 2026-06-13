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
} from "./api";
import type { ActivationKind, Backend } from "./types";

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
      // Don't clobber an error — `error` is followed immediately by `closed`.
      const st = useApp.getState();
      if (st.status === "error") {
        setDictation({ level: 0 });
        return;
      }
      setDictation({ status: "idle", level: 0 });

      const cfg = insertCfg;
      if (!cfg || cfg.timing === "off") return;
      if (cfg.live) {
        // Phrases were injected live; the `last` final already delivered the rest.
        // Press a real Enter (not a pasted "\n", which some apps swallow).
        if (cfg.autoEnter) {
          enqueueInject(() =>
            injectText({ text: "", method: cfg.method, autoEnter: true, restoreClipboard: false }),
          );
        }
        // Restore the clipboard once, after the last paste in the queue.
        if (cfg.method === "paste" && cfg.restoreClipboard) {
          enqueueInject(() => endInjection());
        }
      } else {
        // "stop" (and "live" on a batch profile): insert the whole transcript once.
        // bankedDoc holds any documents finalized before a hard break this session.
        const text = (bankedDoc + committedDoc).trim();
        if (text) {
          void injectText({
            text,
            method: cfg.method,
            autoEnter: cfg.autoEnter,
            restoreClipboard: cfg.restoreClipboard,
          });
        }
      }
    }
  });

  await listen<string>("stream://error", (e) => {
    console.error("stream error:", e.payload);
    setDictation({ status: "error", dictationError: e.payload, level: 0 });
  });
}

export async function startLive(
  backend: Backend,
  deviceId: string | null,
  activation: ActivationKind,
  overrides: { language: string; prompt: string },
): Promise<void> {
  await ensureListeners();
  const setDictation = useApp.getState().setDictation;
  const s = useApp.getState().settings;
  const g = s.general;
  const rec = s.recording;

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

  setDictation({ status: "listening", partial: "", level: 0, dictationError: null });
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
        language: overrides.language,
        prompt: overrides.prompt,
        deviceId,
        save: rec.saveRecordings,
        muteSystem: rec.muteSystemAudio,
      });
    } else {
      await startStream({
        serverUrl: backend.serverUrl,
        backendId: backend.id,
        model: backend.model,
        language: overrides.language,
        prompt: overrides.prompt,
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
  // Streaming: server flushes + drains. Batch: transcription runs now. Either
  // way the `closed` status resets us to idle.
  useApp.getState().setDictation({ status: "transcribing" });
  if (activeEndpoint === "batch") await stopRecord();
  else await stopStream();
}
