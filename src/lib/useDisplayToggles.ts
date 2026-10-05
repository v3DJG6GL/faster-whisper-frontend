// The transcript's display toggles — the view IS the export: Read's toggle row
// and the export's Content box read and flip the same persisted values, so
// Copy and Save always match what is on screen.

import { useApp } from "@/lib/store";
import type { TranscribeSettings } from "@/lib/types";

/** The toggles' values from the saved settings. Defaults migrate from the
 *  legacy speakerColorMode (old synced blobs). Pure — History's quick export
 *  reads the same values without the hook. */
export function displayToggles(t: TranscribeSettings | undefined) {
  const legacy = t?.speakerColorMode;
  return {
    showTs: t?.showTimestamps ?? false,
    showNames: t?.showSpeakerNames ?? legacy !== "line-only",
    colorize: t?.colorizeSpeakers ?? (legacy ? legacy !== "off" : true),
    wordTs: t?.wordTimestamps ?? false,
  };
}

/** Patch the saved Transcribe settings. Reads the store at call time: two
 *  patches fired in one tick must not overwrite each other from the same
 *  render's snapshot. */
export function patchTranscribe(patch: Partial<TranscribeSettings>) {
  const { settings, updateSettings } = useApp.getState();
  updateSettings({ transcribe: { ...settings.transcribe, ...patch } });
}

export function useDisplayToggles() {
  const t = useApp((s) => s.settings.transcribe);
  return {
    ...displayToggles(t),
    setShowTs: (v: boolean) => patchTranscribe({ showTimestamps: v }),
    setShowNames: (v: boolean) => patchTranscribe({ showSpeakerNames: v }),
    setColorize: (v: boolean) => patchTranscribe({ colorizeSpeakers: v }),
    setWordTs: (v: boolean) => patchTranscribe({ wordTimestamps: v }),
  };
}
