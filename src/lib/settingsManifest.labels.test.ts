// Drift guard for manifest labels that render as STRING LITERALS on screens
// which keep their own bespoke controls (Transcribe.tsx / TranscriptViewer /
// TranscriptExport / the Audio-storage block). Settings.tsx rows reference
// `SETTING.x.label` directly, so they can't drift; these literals could — this
// test pins each one to the manifest by reading the source. Renaming either
// side without the other fails here.

import { describe, expect, it } from "vitest";
import { SETTING } from "./settingsManifest";
// Raw source imports (vite `?raw`) — no node fs types needed under the app
// tsconfig, and vitest resolves them through the same pipeline as the app.
import transcribeSrc from "../screens/Transcribe.tsx?raw";
import settingsSrc from "../screens/Settings.tsx?raw";
import loggingSrc from "../components/settings/LoggingSection.tsx?raw";
import viewerSrc from "../components/transcribe/TranscriptViewer.tsx?raw";
import exportSrc from "../components/transcribe/TranscriptExport.tsx?raw";
import summarySrc from "./transcript/exportSummary.ts?raw";

const SOURCES: Record<string, string> = {
  "screens/Transcribe.tsx": transcribeSrc,
  "screens/Settings.tsx": settingsSrc,
  "components/settings/LoggingSection.tsx": loggingSrc,
  "components/transcribe/TranscriptViewer.tsx": viewerSrc,
  "components/transcribe/TranscriptExport.tsx": exportSrc,
  "lib/transcript/exportSummary.ts": summarySrc,
};
const src = (p: string) => SOURCES[p];

describe("manifest labels match the screens' literal labels", () => {
  const cases: Array<[file: string, settingId: keyof typeof SETTING]> = [
    ["screens/Transcribe.tsx", "diarize"],
    ["screens/Transcribe.tsx", "translate"],
    ["screens/Transcribe.tsx", "translateTo"],
    ["screens/Transcribe.tsx", "separateBgm"],
    ["screens/Transcribe.tsx", "keepUrlVideoCopies"], // the link card's per-link switch
    ["components/transcribe/TranscriptViewer.tsx", "showTimestamps"],
    ["components/transcribe/TranscriptViewer.tsx", "showSpeakerNames"],
    ["components/transcribe/TranscriptViewer.tsx", "colorizeSpeakers"],
    ["lib/transcript/exportSummary.ts", "wordTimestamps"], // the export's Content box
    ["components/transcribe/TranscriptExport.tsx", "subtitleLength"],
    ["components/transcribe/TranscriptExport.tsx", "translationTiming"],
    ["components/transcribe/TranscriptExport.tsx", "revealAfterSave"], // the Save button's menu
    ["components/transcribe/TranscriptExport.tsx", "exportFormat"], // aria-label on the bespoke radiogroup
    ["screens/Settings.tsx", "audioFolder"], // bespoke Audio-storage block heading
  ];
  for (const [file, id] of cases) {
    it(`${String(id)} ↔ ${file}`, () => {
      const label = SETTING[id].label;
      // Control-shaped occurrences only: a bare `includes("Translation")` also matched an
      // unrelated status-phrase map, so a renamed row title passed on the wrong string.
      const pats = [
        `title="${label}"`,
        `label="${label}"`,
        `label: "${label}"`,
        `ariaLabel="${label}"`,
        `aria-label="${label}"`,
        `["${label}",`,
        `>${label}<`,
      ];
      expect(
        pats.some((p) => src(file).includes(p)),
        `"${label}" not found as a control label in ${file} — rename the manifest label or the screen's literal together`,
      ).toBe(true);
    });
  }

  it("Settings.tsx uses manifest references, not literals, for manifest-covered rows", () => {
    // A representative sample: these must never reappear as title literals. Each id is
    // read from the file that renders its row (the Logging section has its own module).
    const sample = [
      ["screens/Settings.tsx", "openAtLogin"],
      ["screens/Settings.tsx", "trimSilence"],
      ["screens/Settings.tsx", "chipPosition"],
      ["components/settings/LoggingSection.tsx", "logLevel"],
    ] as const;
    for (const [file, id] of sample) {
      const s = src(file);
      expect(s.includes(`title="${SETTING[id].label}"`)).toBe(false);
      expect(s.includes(`SETTING.${id}.label`)).toBe(true);
    }
  });
});
