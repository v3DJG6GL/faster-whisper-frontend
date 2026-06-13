// Live streaming dictation: start/stop a session and fold the Rust `stream://*`
// events into the store (status / level / live transcript) and into the focused
// app (text injection).
//
// Injection timing (Settings → General → Auto-insert):
//   • "off"  — never insert.
//   • "stop" — insert the whole transcript once, when dictation stops.
//   • "live" — insert each finalized segment AS YOU SPEAK (streaming profiles only;
//              batch has a single final, so it falls back to on-stop).
//
// Live insert is safe because the backend's `final.committed` is append-only across
// the whole session (LocalAgreement) — we only ever inject the NEW committed suffix,
// never correcting. `tail` and partials are revisable, so they are preview-only.

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
import type { ModelProfile } from "./types";

let wired = false;
let activeEndpoint: "stream" | "batch" | null = null;
// The whole post-processed document through the last `final` (committed + tail).
// Partials only carry the CURRENT utterance, so we prepend this to keep earlier
// finalized lines visible while the next sentence is being spoken. Display only.
let committedDoc = "";
// How many chars of `final.committed` we've already injected (live mode).
let injectedLen = 0;
// Insertion config captured at dictation start (so mid-session setting changes
// don't split a dictation between behaviours).
interface InsertCfg {
  timing: "off" | "stop" | "live";
  method: "paste" | "direct";
  autoEnter: boolean;
  restoreClipboard: boolean;
  live: boolean; // timing === "live" AND a streaming profile
}
let insertCfg: InsertCfg | null = null;
// Serialise every injection op (segment deltas, the trailing Enter, the clipboard
// restore) so the restore can never run before the last paste completes.
let injectChain: Promise<void> = Promise.resolve();
function enqueueInject(fn: () => Promise<void>): void {
  injectChain = injectChain.then(fn).catch((e) => console.error("inject failed:", e));
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
    // Live mode: inject only the newly-committed (append-only) suffix.
    if (insertCfg?.live) {
      const committed = e.payload.committed;
      if (committed.length > injectedLen) {
        const delta = committed.slice(injectedLen);
        injectedLen = committed.length;
        const method = insertCfg.method;
        if (delta) enqueueInject(() => injectText({ text: delta, method, autoEnter: false, restoreClipboard: false }));
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
        // Segments already injected via `final`. Finish: optional Enter, then
        // restore the clipboard once (queued AFTER the last delta).
        if (cfg.autoEnter) {
          enqueueInject(() => injectText({ text: "\n", method: cfg.method, autoEnter: false, restoreClipboard: false }));
        }
        if (cfg.method === "paste" && cfg.restoreClipboard) {
          enqueueInject(() => endInjection());
        }
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
  injectedLen = 0;
  injectChain = Promise.resolve();

  setDictation({ status: "listening", partial: "", level: 0, dictationError: null });
  activeEndpoint = profile.endpoint;

  // Snapshot the clipboard once if we'll be live-pasting (restored on stop).
  if (insertCfg.live && insertCfg.method === "paste" && insertCfg.restoreClipboard) {
    try {
      await beginInjection();
    } catch (e) {
      console.error("beginInjection failed:", e);
    }
  }

  try {
    if (profile.endpoint === "batch") {
      // Record the whole clip; transcription happens on stop.
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
