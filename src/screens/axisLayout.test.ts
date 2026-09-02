import { describe, expect, it } from "vitest";
import { SKIPPED_EXPLANATIONS, axisLayout } from "./Transcribe";
import { pruneTargets } from "@/components/TranslationFields";
import { railStages } from "@/lib/transcribeRun";

// Pure screen helpers, tested without a DOM (the historyTracks.test.ts precedent).
describe("axisLayout", () => {
  it("never prints two labels of one row through each other", () => {
    // Two tiny early stages at the 5px floor, then a long transcribe segment.
    const px = [5, 5, 626];
    const labelPx = [52, 170, 65];
    const out = axisLayout(px, labelPx, 640);
    const starts = out.map((o, i) => px.slice(0, i).reduce((a, w) => a + w + 2, 0) + o.offset);
    for (const row of [0, 1] as const) {
      const idx = out.map((o, i) => (o.row === row ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < idx.length; k++) {
        expect(starts[idx[k]]).toBeGreaterThanOrEqual(starts[idx[k - 1]] + labelPx[idx[k - 1]]);
      }
    }
  });
  it("wide segments all sit on the top row at their own start", () => {
    expect(axisLayout([200, 200, 200], [50, 50, 50], 604)).toEqual([
      { row: 0, offset: 0 },
      { row: 0, offset: 0 },
      { row: 0, offset: 0 },
    ]);
  });
  it("a label that overflows the right edge is pulled left", () => {
    const out = axisLayout([300, 300], [50, 320], 602);
    expect(out[1].offset).toBeLessThanOrEqual(0);
    expect(300 + 2 + out[1].offset + 320).toBeLessThanOrEqual(602);
  });
});

describe("SKIPPED_EXPLANATIONS", () => {
  it("every optional stage on a full rail has its own sentence", () => {
    const rail = railStages({ separateBgm: true, diarize: true, translateTo: ["de"] } as never, true);
    for (const st of rail) {
      if (st === "transcribing") continue;
      expect(SKIPPED_EXPLANATIONS[st].length).toBeGreaterThan(0);
    }
    expect(SKIPPED_EXPLANATIONS.translating).not.toBe(SKIPPED_EXPLANATIONS.diarizing);
  });
});

describe("pruneTargets", () => {
  it("drops the known source, keeps everything under auto", () => {
    expect(pruneTargets(["de", "fr"], "de")).toEqual(["fr"]);
    expect(pruneTargets(["de"], "auto")).toEqual(["de"]);
    expect(pruneTargets(["de"], "")).toEqual(["de"]);
  });
});
