// Live streaming dictation: start/stop a session and fold the Rust `stream://*`
// events into the store (status / level / live transcript) and into the focused
// app (text injection).
//
// Injection timing (Settings → General → Auto-insert):
//   • "off"  — never insert.
//   • "stop" — insert the whole transcript once, when dictation stops (uses the
//              chosen Insertion-method: clipboard paste or direct typing).
//   • "live" — insert each phrase AS YOU FINISH IT (streaming profiles only).
//
// Live insert uses DIFF-CORRECT keystroke typing: on each `final` we type the new
// suffix of the whole document (committed + tail), and on the rare occasion the
// backend revises an already-typed word (cross-phrase post-processing), we
// backspace the changed part and retype it. This needs keystrokes (clipboard
// can't backspace), so live always types regardless of the paste/direct setting.

import { useApp } from "./store";
import {
  isTauri,
  startStream,
  stopStream,
  startRecord,
  stopRecord,
  injectText,
  injectLive,
} from "./api";
import type { ModelProfile } from "./types";

let wired = false;
let activeEndpoint: "stream" | "batch" | null = null;
// The whole post-processed document through the last `final` (committed + tail),
// for the chip/Home preview. Partials carry only the current utterance, so we
// prepend this to keep earlier lines visible while the next sentence is spoken.
let committedDoc = "";
// The exact text we've typed into the focused field so far (live mode), so we can
// diff the next document against it and backspace+retype only what changed.
let injectedText = "";
// Insertion config captured at dictation start.
interface InsertCfg {
  timing: "off" | "stop" | "live";
  method: "paste" | "direct";
  autoEnter: boolean;
  restoreClipboard: boolean;
  live: boolean; // timing === "live" AND a streaming profile
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
    // Live mode: diff the new document against what we've typed and inject the
    // delta (backspacing any revised suffix). The newest phrase is in `tail`, so
    // this types it immediately rather than waiting for the next phrase to lock it.
    if (insertCfg?.live) {
      const target = committedDoc;
      const c = commonPrefixLen(injectedText, target);
      const backspaces = injectedText.length - c;
      const toType = target.slice(c);
      injectedText = target;
      if (backspaces > 0 || toType.length > 0) {
        enqueueInject(() => injectLive(backspaces, toType));
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
        // Phrases were injected live; the `last` final already reconciled the
        // whole document. Just append Enter if requested.
        if (cfg.autoEnter) enqueueInject(() => injectLive(0, "\n"));
      } else {
        // "stop" (and "live" on a batch profile): insert the whole transcript once.
        const text = committedDoc.trim();
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

export async function startLive(profile: ModelProfile, deviceId: string | null): Promise<void> {
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
    live: g.insertTiming === "live" && profile.endpoint === "stream",
  };
  committedDoc = "";
  injectedText = "";
  injectChain = Promise.resolve();

  setDictation({ status: "listening", partial: "", level: 0, dictationError: null });
  activeEndpoint = profile.endpoint;

  try {
    if (profile.endpoint === "batch") {
      await startRecord({
        serverUrl: profile.serverUrl,
        profileId: profile.id,
        model: profile.model,
        language: profile.language,
        prompt: profile.prompt,
        deviceId,
        save: rec.saveRecordings,
        muteSystem: rec.muteSystemAudio,
      });
    } else {
      await startStream({
        serverUrl: profile.serverUrl,
        profileId: profile.id,
        model: profile.model,
        language: profile.language,
        responseFormat: profile.responseFormat,
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
