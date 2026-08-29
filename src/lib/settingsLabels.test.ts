// Drift guard for manifest labels that render as STRING LITERALS on screens
// which keep their own bespoke controls (Transcribe.tsx / TranscriptViewer /
// the Audio-storage block). Settings.tsx rows reference `SETTING.x.label`
// directly, so they can't drift; these literals could — this test pins each
// one to the manifest by reading the source. Renaming either side without
// the other fails here.

import { describe, expect, it } from "vitest";
import { SETTING } from "./settingsManifest";
// Raw source imports (vite `?raw`) — no node fs types needed under the app
// tsconfig, and vitest resolves them through the same pipeline as the app.
import transcribeSrc from "../screens/Transcribe.tsx?raw";
import settingsSrc from "../screens/Settings.tsx?raw";
import viewerSrc from "../components/TranscriptViewer.tsx?raw";

const SOURCES: Record<string, string> = {
  "screens/Transcribe.tsx": transcribeSrc,
  "screens/Settings.tsx": settingsSrc,
  "components/TranscriptViewer.tsx": viewerSrc,
};
const src = (p: string) => SOURCES[p];

describe("manifest labels match the screens' literal labels", () => {
  const cases: Array<[file: string, settingId: keyof typeof SETTING]> = [
    ["screens/Transcribe.tsx", "diarize"],
    ["screens/Transcribe.tsx", "translate"],
    ["screens/Transcribe.tsx", "separateBgm"],
    ["components/TranscriptViewer.tsx", "showTimestamps"],
    ["components/TranscriptViewer.tsx", "showSpeakerNames"],
    ["components/TranscriptViewer.tsx", "colorizeSpeakers"],
    ["components/TranscriptViewer.tsx", "wordTimestamps"],
    ["screens/Settings.tsx", "audioFolder"], // bespoke Audio-storage block heading
  ];
  for (const [file, id] of cases) {
    it(`${String(id)} ↔ ${file}`, () => {
      const label = SETTING[id].label;
      expect(
        src(file).includes(`"${label}"`) || src(file).includes(`>${label}<`),
        `"${label}" not found in ${file} — rename the manifest label or the screen's literal together`,
      ).toBe(true);
    });
  }

  it("Settings.tsx uses manifest references, not literals, for manifest-covered rows", () => {
    const s = src("screens/Settings.tsx");
    // A representative sample: these must never reappear as title literals.
    for (const id of ["openAtLogin", "trimSilence", "chipPosition", "logLevel"] as const) {
      expect(s.includes(`title="${SETTING[id].label}"`)).toBe(false);
      expect(s.includes(`SETTING.${id}.label`)).toBe(true);
    }
  });
});
