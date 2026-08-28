// Pure-function coverage of the stage rail with the URL flow's new
// "downloading" stage (railOf folding, ordering, weighting). The store/pump
// side is exercised through the app; these guard the math.
import { describe, expect, it } from "vitest";
import {
  overallFraction, railIndex, railOf, railStages, skippedStages,
} from "./transcribeRun";
import type { QueueItem } from "./transcribeRun";

describe("railOf", () => {
  it("folds resolving onto the download row", () => {
    expect(railOf("downloading")).toBe("downloading");
    expect(railOf("resolving")).toBe("downloading");
  });
  it("keeps the existing folds", () => {
    expect(railOf("waiting")).toBe("transcribing");
    expect(railOf("analyzing")).toBe("transcribing");
    expect(railOf("separating")).toBe("separating");
    expect(railOf("diarizing")).toBe("diarizing");
    expect(railOf(undefined)).toBe("transcribing");
  });
});

describe("railStages", () => {
  it("prepends downloading only for URL items", () => {
    expect(railStages(undefined, true)).toEqual(["downloading", "transcribing"]);
    expect(railStages(undefined)).toEqual(["transcribing"]);
    expect(railStages(undefined, false)).toEqual(["transcribing"]);
  });
  it("orders download before every optional stage", () => {
    expect(railStages({ separateBgm: true, diarize: true }, true)).toEqual([
      "downloading", "separating", "transcribing", "diarizing",
    ]);
  });
  it("railIndex lights the download row during resolving", () => {
    const stages = railStages({ diarize: true }, true);
    expect(railIndex("resolving", stages)).toBe(0);
    expect(railIndex("downloading", stages)).toBe(0);
    expect(railIndex("transcribing", stages)).toBe(1);
  });
});

describe("skippedStages with a download rail", () => {
  it("convicts a jumped-over separate stage once transcribe is observed", () => {
    const skipped = skippedStages({
      progress: { stage: "transcribing", progress: 0.5 },
      stageTimes: { downloading: { start: 1, end: 2, observed: true } },
      lastOptions: { separateBgm: true },
      forUrl: true,
    });
    expect(skipped.has("separating")).toBe(true);
    expect(skipped.has("downloading")).toBe(false);
  });
});

describe("overallFraction with a download rail", () => {
  const queue: QueueItem[] = [{ path: "https://x/", status: "running", kind: "url" }];
  it("credits the download stage by its own fraction", () => {
    const frac = overallFraction({
      queue,
      progress: { stage: "downloading", progress: 0.5 },
      stageTimes: {},
      lastOptions: undefined,
      forUrl: true,
    });
    // weights: downloading 15, transcribing 60 → 7.5/75
    expect(frac).toBeCloseTo(0.1, 5);
  });
  it("counts a finished download in full once transcribe runs", () => {
    const frac = overallFraction({
      queue,
      progress: { stage: "transcribing", progress: 0.5 },
      stageTimes: { downloading: { start: 1, end: 2, observed: true } },
      lastOptions: undefined,
      forUrl: true,
    });
    // (15 + 0.5*60) / 75
    expect(frac).toBeCloseTo(0.6, 5);
  });
  it("matches the file-only math when forUrl is absent", () => {
    const fileQueue: QueueItem[] = [{ path: "/a.mp3", status: "running" }];
    const frac = overallFraction({
      queue: fileQueue,
      progress: { stage: "transcribing", progress: 0.25 },
      stageTimes: {},
      lastOptions: undefined,
    });
    expect(frac).toBeCloseTo(0.25, 5);
  });
});
