// One-time move of a microphone saved by display name (before pins were device ids) to its id.
//
// The old Linux names were ALSA descriptions like "RØDE PodMic USB, USB Audio", which resolved to
// the raw hw: path (exclusive, and the source of the hands-free freeze). Rust maps such a name to
// the sound-server source of the same card. While that mic isn't connected the name stays: dictation
// still finds it by name when it is back, and the move is retried at the next launch.

import { configReady } from "./persistence";
import { resolveLegacyMic } from "./api";
import { isLegacyPin } from "./micOptions";
import { useApp } from "./store";

let done = false;

export async function migrateLegacyMicPin(): Promise<void> {
  if (done) return;
  done = true;
  await configReady;
  const old = useApp.getState().settings.microphoneId;
  if (!isLegacyPin(old)) return;
  try {
    const hit = await resolveLegacyMic(old);
    // Only if the user didn't pick another mic meanwhile.
    if (hit && useApp.getState().settings.microphoneId === old) {
      useApp.getState().updateSettings({ microphoneId: hit.id, microphoneLabel: hit.label });
    }
  } catch (e) {
    console.error("microphone pin migration failed:", e);
  }
}
