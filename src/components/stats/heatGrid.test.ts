// The calendar / busy-grid level legend never prints an impossible range: sub-second duration
// breaks under the 0.1 s floor, and a top step that ties leave empty.
import { describe, expect, it } from "vitest";
import { levelLegendLabels } from "./heatGrid";

const impossible = (labels: string[]) =>
  labels.filter((l) => {
    const m = /^([\d.]+)s–([\d.]+)s$/.exec(l);
    return m !== null && Number(m[1]) >= Number(m[2]);
  });

describe("levelLegendLabels", () => {
  it("a first duration break under 0.05 s does not read '0.1s–0s'", () => {
    const labels = levelLegendLabels([0.03, 0.4, 2], [0, 2, 2, 2, 2], "processing_s");
    expect(labels).toEqual(["0", "<0.1s", "0s–0.4s", "0.4s–2s", "2s+"]);
    expect(impossible(labels)).toEqual([]);
  });

  it("a first duration break between 0.05 and 0.1 s does not read '0.1s–0.1s'", () => {
    const labels = levelLegendLabels([0.07, 0.4, 2], [0, 2, 2, 2, 2], "audio_s");
    expect(labels).toEqual(["0", "0.1s", "0.1s–0.4s", "0.4s–2s", "2s+"]);
    expect(impossible(labels)).toEqual([]);
  });

  it("an empty top step reads '—', not '5+'", () => {
    expect(levelLegendLabels([5, 5, 5], [3, 4, 0, 0, 0], "words")).toEqual(["0", "1–5", "—", "—", "—"]);
  });

  it("an ordinary spread is unchanged", () => {
    expect(levelLegendLabels([60, 400, 2100], [1, 3, 3, 3, 3], "words")).toEqual(["0", "1–60", "60–400", "400–2.1k", "2.1k+"]);
    expect(levelLegendLabels([0.4, 3, 30], [0, 1, 1, 1, 1], "audio_s")).toEqual(["0", "0.1s–0.4s", "0.4s–3s", "3s–30s", "30s+"]);
  });
});
