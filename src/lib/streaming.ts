// Live streaming dictation: start/stop a session and fold the Rust `stream://*`
// events into the store (status / level / live transcript). The full live text
// is `committed + pending` (partials) or `committed + tail` (finals) — the server
// sends authoritative strings, so we just replace.

import { useApp } from "./store";
import { isTauri, startStream, stopStream, startRecord, stopRecord, injectText } from "./api";
import type { ModelProfile } from "./types";

let wired = false;
let activeEndpoint: "stream" | "batch" | null = null;
// The whole post-processed document through the last `final`. Partials only carry
// the CURRENT utterance (LocalAgreement resets per utterance), so we prepend this
// to keep earlier finalized lines visible while the next sentence is being spoken.
let committedDoc = "";

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
  });

  await listen<string>("stream://status", (e) => {
    if (e.payload === "ready") {
      setDictation({ status: "listening", dictationError: null });
    } else if (e.payload === "closed") {
      // Don't clobber an error — `error` is followed immediately by `closed`, and
      // we want the error to stay visible until the next attempt.
      const st = useApp.getState();
      if (st.status === "error") {
        setDictation({ level: 0 });
        return;
      }
      setDictation({ status: "idle", level: 0 });
      // Inject the final transcript into the focused app.
      const text = committedDoc.trim();
      const g = st.settings.general;
      if (text && g.autoPaste) {
        void injectText({
          text,
          method: g.insertMethod,
          autoEnter: g.autoEnter,
          restoreClipboard: g.restoreClipboard,
        });
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
  const rec = useApp.getState().settings.recording;
  setDictation({ status: "listening", partial: "", level: 0, dictationError: null });
  activeEndpoint = profile.endpoint;
  committedDoc = "";
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
