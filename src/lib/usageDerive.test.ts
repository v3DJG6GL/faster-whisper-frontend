import { describe, expect, it } from "vitest";
import {
  bucketMode,
  bucketize,
  calendarModel,
  dayToIso,
  densifyKinds,
  dowOf,
  hourModel,
  isoToDay,
  legendRanges,
  levelOf,
  orderedStageRows,
  pageQueryParams,
  parsePageQuery,
  quantileBreaks,
  resolveWindow,
  spanPresets,
  stageAppliesToScope,
  streakFor,
  toUsageQuery,
  weekColumns,
  facetRows,
  translationRows,
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
import type { UsageCalendarDay, UsageSeriesPoint, UsageStage } from "./types";

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

  it("quantileBreaks: quarters of the active values, upper-median rule; zero is its own step", () => {
    // The user's report: one 26,850 day, one 12k, a long tail — every quarter fills.
    const vals = [26850, 12040, 3800, 2100, 900, 640, 400, 210, 120, 60, 30, 10];
    const b = quantileBreaks(vals);
    expect(b).toEqual([60, 400, 2100]);
    const counts = [0, 0, 0, 0, 0];
    for (const v of vals) counts[levelOf(v, b)]++;
    expect(counts).toEqual([0, 3, 3, 3, 3]);
    expect(levelOf(0, b)).toBe(0);
    // Three active days still get three shades, and the busiest is always the darkest.
    expect(quantileBreaks([5, 50, 500])).toEqual([0, 5, 50]);
    expect([5, 50, 500].map((v) => levelOf(v, quantileBreaks([5, 50, 500])))).toEqual([2, 3, 4]);
    expect(levelOf(7, quantileBreaks([7]))).toBe(4);
    expect([3, 9].map((v) => levelOf(v, quantileBreaks([3, 9])))).toEqual([2, 4]);
    expect(quantileBreaks([])).toEqual([0, 0, 0]);
    expect(legendRanges([60, 400, 2100], String)).toEqual(["0", "1–60", "60–400", "400–2100", "2100+"]);
  });

  it("calendarModel: one cell per window day for the scoped kind, quantile-levelled, counts per level", () => {
    const today = 20_000;
    const row = (day: number, dictation: number, file = 0): UsageCalendarDay => ({ day, all: dictation + file, dictation, file, url: 0, text: 0 });
    const cal = [row(today, 1000, 5), row(today - 1, 100), row(today - 2, 400, 50), row(today - 3, 600), row(today - 4, 800), row(today - 90, 5)];
    const m = calendarModel(cal, "all", today - 4, today);
    expect(m.cells.map((c) => c.day)).toEqual([today - 4, today - 3, today - 2, today - 1, today]);
    expect(m.breaks).toEqual([100, 450, 600]);
    expect(m.cells.map((c) => c.level)).toEqual([4, 3, 2, 1, 4]);
    expect(m.counts).toEqual([0, 1, 1, 1, 2]);
    // Scoped to files: only two active days; the rest are zero cells.
    const f = calendarModel(cal, "file", today - 4, today);
    expect(f.cells.map((c) => c.words)).toEqual([0, 0, 50, 0, 5]);
    expect(f.counts[0]).toBe(3);
    // Malformed rows never throw.
    expect(calendarModel([{ day: -1 } as UsageCalendarDay, null as unknown as UsageCalendarDay], "all", 1, 3).cells).toHaveLength(3);
  });

  it("weekColumns: Monday-first columns with leading blanks and month labels", () => {
    // Day 20_000 is Friday 4 Oct 2024 (1970-01-01 was a Thursday).
    expect(dowOf(20_000)).toBe(4);
    expect(dowOf(0)).toBe(3);
    const m = calendarModel([], "all", 20_000, 20_013);
    const cols = weekColumns(m.cells);
    expect(cols).toHaveLength(3);
    expect(cols[0].cells.slice(0, 4)).toEqual([null, null, null, null]);
    expect(cols[0].cells[4]?.day).toBe(20_000);
    expect(cols[2].cells.filter(Boolean)).toHaveLength(4);
    expect(cols[0].month).not.toBeNull();
  });

  it("hourModel: 7×24 grid for the scoped kind with a peak", () => {
    const m = hourModel(
      [
        { dow: 1, hour: 10, all: 4200, dictation: 4000, file: 200, url: 0, text: 0 },
        { dow: 4, hour: 15, all: 300, dictation: 300, file: 0, url: 0, text: 0 },
        { dow: 9, hour: 10, all: 1, dictation: 1, file: 0, url: 0, text: 0 }, // bogus dow
      ],
      "all",
    );
    expect(m.rows).toHaveLength(7);
    expect(m.rows[1]).toHaveLength(24);
    expect(m.peak).toMatchObject({ dow: 1, hour: 10, words: 4200 });
    expect(m.rows[1][10].level).toBe(4);
    expect(m.rows[4][15].level).toBeGreaterThan(0);
    expect(m.counts[0]).toBe(168 - 2);
    expect(hourModel(undefined, "file").peak).toBeNull();
  });

  it("bucketing: days ≤ 120, ISO weeks ≤ 730, months beyond; sums per bucket", () => {
    expect(bucketMode(30)).toBe("day");
    expect(bucketMode(120)).toBe("day");
    expect(bucketMode(365)).toBe("week");
    expect(bucketMode(1000)).toBe("month");
    const today = 20_000; // a Friday
    const dense = densifyKinds([pt(today, 10), pt(today - 1, 20), pt(today - 2, 30), pt(today - 5, 40)], 10, today);
    const weeks = bucketize(dense, "week");
    // Monday of this week is today-4; the previous week holds today-5 and earlier.
    expect(weeks).toHaveLength(2);
    expect(weeks[1].from).toBe(today - 4);
    expect(weeks[1].to).toBe(today);
    expect(weeks[1].all.words).toBe(60);
    expect(weeks[0].all.words).toBe(40);
    expect(weeks[0].to).toBe(today - 5);
    expect(bucketize(dense, "day")).toHaveLength(10);
    const months = bucketize(densifyKinds([], 70, today), "month");
    expect(months.length).toBeGreaterThanOrEqual(3);
    expect(months.every((b) => b.from <= b.to)).toBe(true);
  });

  it("page query: URL parse/format round trip, wire form, window resolution", () => {
    const get = (o: Record<string, string>) => (k: string) => o[k] ?? null;
    expect(parsePageQuery(get({}))).toEqual({ scope: "all", query: { range: "30", with: [] } });
    expect(parsePageQuery(get({ scope: "file" })).scope).toBe("file"); // the older deep link
    const p = parsePageQuery(get({ kind: "url", range: "custom", from: "100", to: "200", with: "vad,translating,bogus" }));
    expect(p).toEqual({ scope: "url", query: { range: "custom", from: 100, to: 200, with: ["translating", "vad"] } });
    expect(pageQueryParams(p.scope, p.query)).toEqual({ kind: "url", range: "custom", from: "100", to: "200", with: "translating,vad" });
    // A custom range without a usable span falls back.
    expect(parsePageQuery(get({ range: "custom", from: "200", to: "100" })).query.range).toBe("30");
    expect(parsePageQuery(get({ range: "9999" })).query.range).toBe("30");
    expect(toUsageQuery({ range: "365", with: [] }, "Europe/Zurich")).toEqual({ days: 365, tz: "Europe/Zurich" });
    expect(toUsageQuery({ range: "all", with: ["diarizing"] })).toEqual({ all: true, with: ["diarizing"] });
    expect(toUsageQuery({ range: "custom", from: 5, to: 9, with: [] })).toEqual({ from: 5, to: 9 });
    expect(resolveWindow({ range: "7", with: [] }, 100)).toEqual({ from: 94, to: 100, days: 7 });
    expect(resolveWindow({ range: "all", with: [] }, 100, 40)).toEqual({ from: 40, to: 100, days: 61 });
    expect(resolveWindow({ range: "all", with: [] }, 100, null)).toEqual({ from: 100, to: 100, days: 1 });
    expect(resolveWindow({ range: "custom", from: 10, to: 12, with: [] }, 100)).toEqual({ from: 10, to: 12, days: 3 });
  });

  it("dates: iso round trip and the custom-span presets", () => {
    const day = isoToDay("2026-09-02")!;
    expect(dayToIso(day)).toBe("2026-09-02");
    expect(isoToDay("nope")).toBeUndefined();
    const presets = spanPresets(day);
    expect(presets.map((p) => p.label)).toEqual(["This month", "Last month", "This quarter", "This year", "Last year"]);
    expect(dayToIso(presets[0].from)).toBe("2026-09-01");
    expect(dayToIso(presets[1].from)).toBe("2026-08-01");
    expect(dayToIso(presets[1].to)).toBe("2026-08-31");
    expect(dayToIso(presets[2].from)).toBe("2026-07-01");
    expect(dayToIso(presets[3].from)).toBe("2026-01-01");
    expect(dayToIso(presets[4].from)).toBe("2025-01-01");
    expect(dayToIso(presets[4].to)).toBe("2025-12-31");
  });

  it("stage rows: chosen stages pin to the top; audio stages apply to files and links only", () => {
    expect(orderedStageRows(["vad"]).map((r) => r.key)).toEqual(["vad", "translating", "diarizing", "separating"]);
    expect(orderedStageRows([]).map((r) => r.key)).toEqual(["translating", "diarizing", "vad", "separating"]);
    expect(stageAppliesToScope("diarizing", "dictation")).toBe(false);
    expect(stageAppliesToScope("translating", "dictation")).toBe(true);
    expect(stageAppliesToScope("vad", "url")).toBe(true);
    expect(streakFor({ all: { current: 3, best: 9 }, file: { current: 1, best: 1 } } as never, "file")).toEqual({ current: 1, best: 1 });
    expect(streakFor(undefined, "all")).toEqual({ current: 0, best: 0 });
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

  it("translationRows: languages as upper-case codes scaled among themselves, outcomes dim", () => {
    const rows = translationRows({
      targets: [
        { code: "de", runs: 41, kept_original: 6 },
        { code: "en", runs: 12, kept_original: 0 },
        { code: " fr ", runs: 3, kept_original: 1 },
        { code: "", runs: 9, kept_original: 0 },
      ],
      translation: { kept_original: 9, not_asked: 87, aborted: 0, unreported: 2 },
    });
    expect(rows.map((r) => [r.label, r.value, r.pct, !!r.dim])).toEqual([
      ["DE", 41, 100, false],
      ["EN", 12, 29, false],
      ["FR", 3, 7, false],
      ["Kept original", 9, 22, true],
      ["Not asked", 87, 100, true], // wider than the languages' scale: clamped, not dominant
      ["Unreported", 2, 5, true],
    ]);
    expect(rows[0].title).toBe("DE · 41 dictations · 6 kept the original");
    expect(rows[1].title).toBe("EN · 12 dictations");
    expect(rows[2].title).toBe("FR · 3 dictations · 1 kept the original");
    expect(rows[0].colorVar).toBe("var(--c-translate)");
  });

  it("translationRows without any target keeps the two outcome rows", () => {
    const rows = translationRows({ translation: { kept_original: 0, not_asked: 4, aborted: 0, unreported: 0 } });
    expect(rows.map((r) => [r.label, r.pct])).toEqual([["Kept original", 0], ["Not asked", 100]]);
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
