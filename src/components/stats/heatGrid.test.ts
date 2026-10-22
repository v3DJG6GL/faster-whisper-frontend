// The calendar / busy-grid level legend never prints an impossible range: sub-second duration
// breaks under the 0.1 s floor, and a top step that ties leave empty.
import { describe, expect, it } from "vitest";
import { activeFloor, levelOf, quantileBreaks } from "@/lib/usageDerive";
import { levelLegendLabels } from "./heatGrid";

const impossible = (labels: string[]) =>
  labels.filter((l) => {
    const m = /^([\d.]+)s–([\d.]+)s$/.exec(l);
    return m !== null && Number(m[1]) >= Number(m[2]);
  });

/** The printed seconds of every bound, left to right, where one is lower than the one before. */
const backwards = (labels: string[]) => {
  const bounds = labels.flatMap((l) => [...l.matchAll(/([\d.]+)s/g)].map((m) => Number(m[1])));
  return bounds.filter((v, i) => i > 0 && v < bounds[i - 1]);
};

describe("levelLegendLabels", () => {
  it("a first duration break under 0.05 s opens at its own decade, not '0.1s–0s' or '<0.1s · 0s–0.4s'", () => {
    const labels = levelLegendLabels([0.03, 0.4, 2], [0, 2, 2, 2, 2], "processing_s");
    expect(labels).toEqual(["0", "0.01s–0.03s", "0.03s–0.4s", "0.4s–2s", "2s+"]);
    expect(impossible(labels)).toEqual([]);
    expect(backwards(labels)).toEqual([]);
  });

  it("a first duration break between 0.05 and 0.1 s keeps its printed value", () => {
    const labels = levelLegendLabels([0.07, 0.4, 2], [0, 2, 2, 2, 2], "audio_s");
    expect(labels).toEqual(["0", "0.01s–0.07s", "0.07s–0.4s", "0.4s–2s", "2s+"]);
    expect(impossible(labels)).toEqual([]);
  });

  // Every step of a sub-0.1 s legend, not only the first: no non-zero bound prints as "0s",
  // no step opens below the bound the step before it printed, and the top step opens at b3.
  it.each([
    ["all breaks under 0.05 s", [0.01, 0.02, 0.03, 0.04], ["0", "0.01s", "0.01s–0.02s", "0.02s–0.03s", "0.03s+"]],
    ["all breaks under 0.1 s", [0.03, 0.04, 0.05, 0.06], ["0", "0.01s–0.03s", "0.03s–0.04s", "0.04s–0.05s", "0.05s+"]],
    ["breaks around 0.1 s", [0.02, 0.03, 0.04, 0.06, 0.08, 0.09, 0.2, 0.3], ["0", "0.01s–0.03s", "0.03s–0.06s", "0.06s–0.09s", "0.09s+"]],
    ["a tiny first quarter under a spread", [0.01, 0.02, 0.04, 0.3, 2, 5, 8, 12], ["0", "0.01s–0.02s", "0.02s–0.3s", "0.3s–5s", "5s+"]],
    ["equal tiny breaks", [0.03, 0.03, 0.03, 0.03], ["0", "0.01s–0.03s", "—", "—", "—"]],
  ])("%s", (_name, values, expected) => {
    const b = quantileBreaks(values);
    const counts = [0, 0, 0, 0, 0];
    for (const v of values) counts[levelOf(v, b)]++;
    const labels = levelLegendLabels(b, counts, "processing_s");
    expect(labels).toEqual(expected);
    expect(labels.filter((l) => /(^|[^.\d])0s/.test(l))).toEqual([]);
    expect(impossible(labels)).toEqual([]);
    expect(backwards(labels)).toEqual([]);
  });

  it("legends at or above 0.1 s print as before the sub-second fix", () => {
    expect(levelLegendLabels([0.4, 3, 30], [0, 1, 1, 1, 1], "audio_s")).toEqual(["0", "0.1s–0.4s", "0.4s–3s", "3s–30s", "30s+"]);
    expect(levelLegendLabels([0.25, 0.5, 4], [0, 1, 1, 1, 1], "processing_s")).toEqual(["0", "0.1s–0.3s", "0.3s–0.5s", "0.5s–4s", "4s+"]);
    expect(levelLegendLabels([1.5, 3, 8], [0, 2, 2, 2, 2], "processing_s")).toEqual(["0", "1s–1.5s", "1.5s–3s", "3s–8s", "8s+"]);
    expect(levelLegendLabels([0, 0.4, 0.4], [0, 0, 1, 0, 1], "audio_s")).toEqual(["0", "—", "0.1s–0.4s", "—", "0.4s+"]);
  });

  it("an empty top step reads '—', not '5+'", () => {
    expect(levelLegendLabels([5, 5, 5], [3, 4, 0, 0, 0], "words")).toEqual(["0", "1–5", "—", "—", "—"]);
  });

  it("an ordinary spread is unchanged", () => {
    expect(levelLegendLabels([60, 400, 2100], [1, 3, 3, 3, 3], "words")).toEqual(["0", "1–60", "60–400", "400–2.1k", "2.1k+"]);
    expect(levelLegendLabels([0.4, 3, 30], [0, 1, 1, 1, 1], "audio_s")).toEqual(["0", "0.1s–0.4s", "0.4s–3s", "3s–30s", "30s+"]);
  });

  // The first step's floor comes from the smallest VALUE, not from its break (the step's max):
  // a step must never be labelled with a range that excludes a value it shades.
  it.each([
    ["one short dictation", [0.03], ["0", "—", "—", "—", "0.01s+"]],
    ["a sub-second day under a 2 s break", [0.3, 2, 5, 6, 7, 8, 9, 10], ["0", "0.1s–2s", "2s–6s", "6s–8s", "8s+"]],
    ["a 0.03 s day under a 0.2 s break", [0.03, 0.2, 0.5, 2, 3, 4, 5, 6], ["0", "0.01s–0.2s", "0.2s–2s", "2s–4s", "4s+"]],
    ["a 0.3 s day under a 1.5 s break", [0.3, 1.5, 2, 3, 5, 8, 9, 12], ["0", "0.1s–1.5s", "1.5s–3s", "3s–8s", "8s+"]],
  ])("%s: the first step opens at or below its smallest value", (_name, values, expected) => {
    const b = quantileBreaks(values);
    const counts = [0, 0, 0, 0, 0];
    for (const v of values) counts[levelOf(v, b)]++;
    const labels = levelLegendLabels(b, counts, "processing_s", activeFloor(values));
    expect(labels).toEqual(expected);
    const first = labels.find((l, i) => i > 0 && l !== "—") ?? "";
    expect(Number(/^([\d.]+)s/.exec(first)?.[1])).toBeLessThanOrEqual(Math.min(...values));
  });

  it("activeFloor is the smallest value above zero, 0 with none", () => {
    expect(activeFloor([0, 2, 0.3, Number.NaN, 5])).toBe(0.3);
    expect(activeFloor([0, 0])).toBe(0);
  });
});
