// One-time move of a microphone saved by display name (before pins were device ids) to its id.
//
// The old Linux names were ALSA descriptions like "RØDE PodMic USB, USB Audio", which resolved to
// the raw hw: path (exclusive, and the source of the hands-free freeze). Rust maps such a name to
// the sound-server source of the same card. While that mic isn't connected the name stays: dictation
// still finds it by name when it is back, and the move is retried at the next launch and whenever
// Settings > Audio lists a changed set of mics (AudioTab).

import { configReady } from "./persistence";
import { resolveLegacyMic } from "./api";
import { isLegacyPin } from "./micOptions";
import { useApp } from "./store";

let done = false;
let retrying = false;
let again = false;

export async function migrateLegacyMicPin(): Promise<void> {
  if (done) return;
  done = true;
  await configReady;
  await retryLegacyMicPin();
}

/** Move the current pin to its device id if it is still a legacy name and that mic is listed now.
 *  Overlapping calls coalesce into one trailing rerun once the in-flight one settles (a call made
 *  mid-lookup may be for a mic that got listed, or a pin that changed, after that lookup began). */
export async function retryLegacyMicPin(): Promise<void> {
  if (retrying) {
    again = true;
    return;
  }
  retrying = true;
  try {
    do {
      again = false;
      const old = useApp.getState().settings.microphoneId;
      if (!isLegacyPin(old)) break;
      try {
        const hit = await resolveLegacyMic(old);
        // Only if the user didn't pick another mic meanwhile.
        if (hit && useApp.getState().settings.microphoneId === old) {
          // An old sound-server route ("PipeWire Sound Server", …) recorded from the default
          // input: it becomes the picker's System default row, not a pin named "default".
          useApp.getState().updateSettings(
            hit.id === "default"
              ? { microphoneId: null, microphoneLabel: null }
              : { microphoneId: hit.id, microphoneLabel: hit.label },
          );
        }
      } catch (e) {
        console.error("microphone pin migration failed:", e);
      }
    } while (again);
  } finally {
    retrying = false;
  }
}
