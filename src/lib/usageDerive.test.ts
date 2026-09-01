import { describe, expect, it } from "vitest";
import {
  calendarCells,
  densifyKinds,
  facetRows,
  findStage,
  fmtTimeSaved,
  niceMax,
  parseScope,
  pct,
  runsBreakdown,
  scopeTotals,
  targetShares,
  timeSavedS,
  zeroKinds,
} from "./usageDerive";
import type { UsageSeriesPoint, UsageStage } from "./types";

const T = (words = 0, sessions = 0, audio_s = 0) => ({ sessions, requests: sessions, errors: 0, words, audio_s, proc_s: 0 });
const pt = (day: number, dict = 0, file = 0): UsageSeriesPoint => ({
  day,
  all: T(dict + file, (dict ? 1 : 0) + (file ? 1 : 0)),
  dictation: T(dict, dict ? 1 : 0),
  file: T(file, file ? 1 : 0),
  url: T(),
  text: T(),
});

describe("usageDerive", () => {
  it("parseScope accepts the four kinds and falls back to all", () => {
    expect(parseScope("file")).toBe("file");
    expect(parseScope("url")).toBe("url");
    expect(parseScope("bogus")).toBe("all");
    expect(parseScope(null)).toBe("all");
  });

  it("densifyKinds zero-fills the window ending today and drops bogus days", () => {
    const today = 20_000;
    const dense = densifyKinds([pt(today - 2, 100), pt(today, 50, 500), pt(1e12, 9), { day: -1 } as UsageSeriesPoint], 7, today);
    expect(dense).toHaveLength(7);
    expect(dense[0].day).toBe(today - 6);
    expect(dense[6].day).toBe(today);
    expect(dense[4].dictation.words).toBe(100);
    expect(dense[6].file.words).toBe(500);
    expect(dense[6].all.words).toBe(550);
    expect(dense[3].all.words).toBe(0);
    // A partially-shaped point (missing blocks) reads as zeros, not a throw.
    const partial = densifyKinds([{ day: today, dictation: T(7) } as unknown as UsageSeriesPoint], 1, today);
    expect(partial[0].dictation.words).toBe(7);
    expect(partial[0].url.words).toBe(0);
  });

  it("densifyKinds extends to a data day past today rather than cutting it off", () => {
    const today = 100;
    const dense = densifyKinds([pt(today + 1, 3)], 3, today);
    expect(dense.map((p) => p.day)).toEqual([99, 100, 101]);
  });

  it("scopeTotals picks the kind block", () => {
    const k = zeroKinds();
    k.file.words = 42;
    k.all.words = 50;
    expect(scopeTotals(k, "file").words).toBe(42);
    expect(scopeTotals(k, "all").words).toBe(50);
  });

  it("niceMax rounds to 1/2/4/8/10 steps with a floor of 4", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(17)).toBe(20);
    expect(niceMax(2500)).toBe(4000);
    expect(niceMax(9000)).toBe(10000);
  });

  it("time saved: words at 40 wpm minus speech, never negative; formatted", () => {
    expect(timeSavedS(400, 300)).toBe(300);
    expect(timeSavedS(10, 600)).toBe(0);
    expect(fmtTimeSaved(0)).toBe("0 min");
    expect(fmtTimeSaved(38 * 60)).toBe("38 min");
    expect(fmtTimeSaved(14 * 3600 + 2 * 60)).toBe("14h 02m");
  });

  it("runsBreakdown lists non-zero kinds with plurals", () => {
    const k = zeroKinds();
    expect(runsBreakdown(k)).toBe("no runs");
    k.dictation.sessions = 14;
    k.file.sessions = 2;
    k.url.sessions = 1;
    expect(runsBreakdown(k)).toBe("14 dictations · 2 files · 1 link");
  });

  it("calendarCells levels against the window max in five steps", () => {
    const today = 500;
    const cells = calendarCells(
      [
        { day: today, words: 1000 },
        { day: today - 1, words: 100 },
        { day: today - 2, words: 400 },
        { day: today - 3, words: 600 },
        { day: today - 4, words: 800 },
        { day: today - 90, words: 5 }, // outside the window
      ],
      5,
      today,
    );
    expect(cells.map((c) => c.level)).toEqual([4, 3, 2, 1, 4]);
    expect(cells[0].day).toBe(today - 4);
    expect(calendarCells([], 3, today).map((c) => c.level)).toEqual([0, 0, 0]);
  });

  it("stage helpers: findStage ignores zero-run rows; shares and pct", () => {
    const st: UsageStage = { stage: "translating", runs: 10, of_runs: 40, audio_s: 0, secs: 0, targets: [{ code: "en", runs: 6 }, { code: "fr", runs: 3 }, { code: "it", runs: 0 }] };
    expect(findStage([st], "translating")).toBe(st);
    expect(findStage([{ ...st, runs: 0 }], "translating")).toBeUndefined();
    expect(findStage(undefined, "vad")).toBeUndefined();
    expect(pct(10, 40)).toBe(25);
    expect(pct(3, 0)).toBe(0);
    expect(targetShares(st)).toEqual([
      { code: "EN", pct: 60 },
      { code: "FR", pct: 30 },
    ]);
  });

  it("facetRows scales to the largest row", () => {
    const rows = facetRows([
      { label: "Typed", value: 314 },
      { label: "Clipboard", value: 66 },
      { label: "Nothing", value: 0, dim: true },
    ]);
    expect(rows.map((r) => r.pct)).toEqual([100, 21, 0]);
    expect(facetRows([{ label: "a", value: 0 }], true)).toEqual([]);
  });
});
