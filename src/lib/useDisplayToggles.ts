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

export function useDisplayToggles() {
  const t = useApp((s) => s.settings.transcribe);
  const updateSettings = useApp((s) => s.updateSettings);
  // Read the store at call time: two setters fired in one tick must not
  // overwrite each other from the same render's snapshot.
  const set = (patch: Partial<TranscribeSettings>) =>
    updateSettings({ transcribe: { ...useApp.getState().settings.transcribe, ...patch } });
  return {
    ...displayToggles(t),
    setShowTs: (v: boolean) => set({ showTimestamps: v }),
    setShowNames: (v: boolean) => set({ showSpeakerNames: v }),
    setColorize: (v: boolean) => set({ colorizeSpeakers: v }),
    setWordTs: (v: boolean) => set({ wordTimestamps: v }),
  };
}
