// The usage chart's column labels: "today" names the column that is today, not the last one.
import { describe, expect, it } from "vitest";
import { fmtDateTick } from "@/lib/format";
import { CHART_METRICS, axisTop, type ChartMetric } from "@/lib/usageDerive";
import { bucketTick, gridTick } from "./chartKit";

const TODAY = 20_740;

describe("bucketTick", () => {
  it("labels today's day column 'today'", () => {
    expect(bucketTick({ from: TODAY }, "day", TODAY)).toBe("today");
  });

  it("labels the last day of a span ending in the past with its date", () => {
    expect(bucketTick({ from: TODAY - 12 }, "day", TODAY)).toBe(fmtDateTick(TODAY - 12));
    expect(bucketTick({ from: TODAY - 12 }, "day", TODAY)).not.toBe("today");
  });

  it("never says 'today' per week or month", () => {
    expect(bucketTick({ from: TODAY }, "week", TODAY)).toBe(fmtDateTick(TODAY));
    expect(bucketTick({ from: TODAY }, "month", TODAY)).toBe(fmtDateTick(TODAY, true));
  });
});

// The stacked chart's y-axis: five gridlines at 0, 1/4, 1/2, 3/4 and the top, each labelled
// with the value its line is drawn at — whatever the tallest column.
const UNIT: Record<string, number> = { "": 1, k: 1e3, M: 1e6, s: 1, m: 60, h: 3600 };
/** A printed label back to its number: "1.5k" → 1500, "1.5m" → 90 (seconds); NaN if
 *  unreadable. */
function labelValue(label: string): number {
  const m = /^(\d+(?:\.\d+)?)([kMsmh]?)$/.exec(label);
  return m ? Number(m[1]) * UNIT[m[2]] : NaN;
}
const gridValues = (top: number) => [0, 1, 2, 3, 4].map((g) => (top * g) / 4);
const axis = (metric: ChartMetric, max: number) =>
  gridValues(axisTop(metric, max)).map((v) => gridTick(metric, v)).join(" | ");

describe("the stacked chart's y-axis", () => {
  it("duration gridlines read as whole clock steps", () => {
    // These used to read "0s | 25s | 50s | 1m | 2m" and "0s | 50s | 2m | 3m | 3m".
    expect(axis("audio_s", 90)).toBe("0s | 30s | 1m | 1.5m | 2m");
    expect(axis("audio_s", 150)).toBe("0s | 1m | 2m | 3m | 4m");
    expect(axis("audio_s", 300)).toBe("0s | 2m | 4m | 6m | 8m");
    expect(axis("processing_s", 900)).toBe("0s | 4m | 8m | 12m | 16m");
    expect(axis("audio_s", 5000)).toBe("0s | 30m | 1h | 1.5h | 2h");
    expect(axis("audio_s", 30 * 3600)).toBe("0s | 8h | 16h | 24h | 32h");
    expect(axis("audio_s", 90 * 3600)).toBe("0s | 25h | 50h | 75h | 100h");
  });

  it("count gridlines read as whole steps", () => {
    // 9 and 10 used to read "0 | 3 | 5 | 8 | 10".
    expect(axis("words", 9)).toBe("0 | 3 | 6 | 9 | 12");
    expect(axis("sessions", 10)).toBe("0 | 3 | 6 | 9 | 12");
    expect(axis("errors", 13)).toBe("0 | 4 | 8 | 12 | 16");
    expect(axis("words", 100)).toBe("0 | 25 | 50 | 75 | 100");
    expect(axis("words", 2000)).toBe("0 | 500 | 1k | 1.5k | 2k");
    expect(axis("words", 2500)).toBe("0 | 1k | 2k | 3k | 4k");
    expect(axis("words", 9000)).toBe("0 | 2.5k | 5k | 7.5k | 10k");
    expect(axis("requests", 1_700_000)).toBe("0 | 500k | 1M | 1.5M | 2M");
  });

  it("every label is exact and the top stays close, whatever the tallest column", () => {
    const maxima: number[] = [];
    for (let v = 1; v <= 5000; v++) maxima.push(v, v + 1e-6);
    for (let v = 0.3; v < 5e7; v *= 1.07) maxima.push(v, Math.round(v), Math.ceil(v) + 0.5);
    const bad: string[] = [];
    for (const metric of CHART_METRICS) {
      for (const max of maxima) {
        const top = axisTop(metric, max);
        const values = gridValues(top);
        const labels = values.map((v) => gridTick(metric, v));
        const read = labels.map(labelValue);
        const exact = read.every((v, i) => v === values[i]);
        const rising = read.every((v, i) => i === 0 || v > read[i - 1]);
        const distinct = new Set(labels).size === labels.length;
        // Holds the tallest column under at most 2× headroom (the smallest axis is 0–4).
        const fits = top >= max && top <= Math.max(4, 2 * max);
        if (exact && rising && distinct && fits) continue;
        bad.push(`${metric} ${max}: top ${top}, ${labels.join(" | ")}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
