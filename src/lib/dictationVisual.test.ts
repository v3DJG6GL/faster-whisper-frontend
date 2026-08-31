// dictationVisual is the SSOT every dictation surface reads its colour/label from,
// and the two membership helpers gate stop-vs-cancel, chip visibility and epoch
// checks. Both are pure, so the drift they used to suffer (a new status landing in
// one surface's hand-rolled map and not another's) is cheap to pin here.

import { describe, expect, it } from "vitest";
// Raw source import (vite `?raw`), as settingsLabels.test.ts does: Overlay.tsx pulls in
// motion/react and DOM globals, and there is no jsdom in this repo — but the maps'
// COMPLETENESS is exactly what a missing entry breaks (a tone with no fill/glow renders
// as `undefined`, i.e. an invisible dot), so read them out of the source instead.
import overlaySrc from "../Overlay.tsx?raw";
import { dictationVisual, isActiveDictation, isProcessing, type DictationTone } from "./dictationVisual";
import type { DictationStatus } from "./types";

const STATUSES: DictationStatus[] = [
  "idle",
  "listening",
  "transcribing",
  "translating",
  "injecting",
  "error",
];

const TONES: DictationTone[] = ["faint", "accent", "live", "dim", "rec", "think", "translate"];

/** Pull the keys out of a `const NAME: Record<DictationTone, string> = { … }` literal. */
function mapKeys(name: string): string[] {
  const m = new RegExp(`const ${name}: Record<DictationTone, string> = \\{([^}]*)\\}`).exec(overlaySrc);
  if (!m) throw new Error(`${name} not found in Overlay.tsx`);
  return [...m[1].matchAll(/^\s*([a-z]+):/gm)].map((k) => k[1]);
}

describe("dictationVisual", () => {
  it("maps every status to a known tone", () => {
    for (const s of STATUSES) {
      const v = dictationVisual(s, false);
      expect(TONES, `status ${s}`).toContain(v.tone);
      expect(v.label).not.toBe("");
    }
  });

  it("gives the translating stage its own teal tone", () => {
    const v = dictationVisual("translating", false);
    expect(v.tone).toBe("translate");
    expect(v.state).toBe("processing");
    expect(v.label).toBe("translating…");
  });

  it("keeps finalizing/inserting on the working blue", () => {
    expect(dictationVisual("transcribing", false).tone).toBe("think");
    expect(dictationVisual("injecting", false).tone).toBe("think");
  });

  it("warming wins over plain listening, but only while listening", () => {
    expect(dictationVisual("listening", false, true).label).toBe("warming up…");
    expect(dictationVisual("listening", false, true).tone).toBe("think");
    // Speaking is irrelevant while the mic is still opening — no audio is flowing yet.
    expect(dictationVisual("listening", true, true).label).toBe("warming up…");
    // …and a stale warming flag must never repaint a post-capture state.
    expect(dictationVisual("translating", false, true).tone).toBe("translate");
  });

  it("splits listening on `speaking`", () => {
    expect(dictationVisual("listening", true).tone).toBe("live");
    expect(dictationVisual("listening", false).tone).toBe("accent");
  });

  it("renders idle hollow and everything else filled", () => {
    expect(dictationVisual("idle", false).filled).toBe(false);
    for (const s of STATUSES.filter((x) => x !== "idle")) {
      expect(dictationVisual(s, false).filled, `status ${s}`).toBe(true);
    }
  });
});

describe("status membership", () => {
  it("pins the active-session set", () => {
    expect(STATUSES.filter(isActiveDictation)).toEqual([
      "listening",
      "transcribing",
      "translating",
      "injecting",
    ]);
  });

  it("pins the post-capture processing subset", () => {
    expect(STATUSES.filter(isProcessing)).toEqual(["transcribing", "translating", "injecting"]);
  });
});

describe("the chip's tone maps", () => {
  // A tone with no entry yields `undefined` — an unstyled (invisible) dot with no glow,
  // and TS can't catch it because the maps live in a file the union doesn't import.
  for (const name of ["TONE_BG", "TONE_GLOW"]) {
    it(`${name} covers every DictationTone`, () => {
      expect(mapKeys(name).sort()).toEqual([...TONES].sort());
    });
  }
});
