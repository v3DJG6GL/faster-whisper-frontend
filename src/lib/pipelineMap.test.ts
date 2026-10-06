// The pipeline payload arrives server-shaped (Rust forwards it opaque), so the leaf values
// of a `callback:map` rule are coerced at the boundary: an entry whose value is not the
// declared type is dropped rather than stringified into a corrected phrase or PATCHed back.
import { describe, expect, it } from "vitest";
import { applyMap, collapseCounts, mapBodyFromRows, mapRowsFromRule, ruleListOf } from "./pipelineMap";
import type { PipelineFetch, PipelineRule } from "./types";

function fetchWith(rules: unknown): PipelineFetch {
  return { ok: true, state: { rules } } as unknown as PipelineFetch;
}

describe("ruleListOf", () => {
  it("drops non-string map values and non-finite map_meta values", () => {
    const [rule] = ruleListOf(
      fetchWith([
        {
          name: "m",
          label: "Word mappings",
          type: "callback:map",
          map: { hello: "hi", bad: { nested: true }, num: 3, keep: "" },
          map_meta: { hello: 2, bad: 1, num: "3", nan: NaN, inf: Infinity },
        },
      ]),
    );
    expect(rule.map).toEqual({ hello: "hi", keep: "" });
    expect(rule.map_meta).toEqual({ hello: 2, bad: 1 });
  });

  it("turns a non-object map into undefined", () => {
    const [rule] = ruleListOf(fetchWith([{ name: "m", type: "callback:map", map: "abc", map_meta: [1] }]));
    expect(rule.map).toBeUndefined();
    expect(rule.map_meta).toBeUndefined();
  });
});

describe("mapRowsFromRule", () => {
  it("orders newest first by stamp, treating an unstamped or non-numeric stamp as oldest", () => {
    const [rule] = ruleListOf(
      fetchWith([
        {
          name: "m",
          type: "callback:map",
          map: { old: "1", newest: "3", middle: "2", unstamped: "0", bogus: "?" },
          map_meta: { old: 10, newest: 30, middle: 20, bogus: "late" },
        },
      ]),
    );
    const rows = mapRowsFromRule(rule as PipelineRule);
    expect(rows.map((r) => r.k)).toEqual(["newest", "middle", "old", "unstamped", "bogus"]);
  });
});

describe("mapBodyFromRows", () => {
  it("keeps a '__proto__' phrase as an own key, newest row winning, key-sorted", () => {
    const body = mapBodyFromRows([
      { id: 1, k: "__proto__", v: "new" },
      { id: 2, k: "b", v: "2" },
      { id: 3, k: "__proto__", v: "old" },
      { id: 4, k: "  ", v: "blank" },
      { id: 5, k: "A", v: "1" },
    ]);
    expect(JSON.stringify(body.map)).toBe('{"A":"1","__proto__":"new","b":"2"}');
  });
});

// A collapsed cb:map list makes two separate promises: `hidden` is what the
// "show all" toggle can still reveal, `unshown` is what the render cap keeps
// off screen forever. Conflating them told users the toggle would reveal rows
// the screen never renders.
describe("collapseCounts", () => {
  it("splits the toggle-revealable rows from the ones past the render cap", () => {
    expect(collapseCounts(5000, 15, 500)).toEqual({ hidden: 485, unshown: 4500 });
  });

  it("promises nothing when the whole list already fits under the collapse point", () => {
    expect(collapseCounts(10, 15, 500)).toEqual({ hidden: 0, unshown: 0 });
  });

  it("hides nothing when collapsing is switched off", () => {
    expect(collapseCounts(5000, 0, 500).hidden).toBe(0);
    expect(collapseCounts(5000, 0, 500).unshown).toBe(4500);
  });

  it("between the collapse point and the cap, every hidden row is revealable", () => {
    expect(collapseCounts(200, 15, 500)).toEqual({ hidden: 185, unshown: 0 });
  });
});

describe("applyMap", () => {
  it("treats an astral letter at a key's edge as one word char, like Python's \\b", () => {
    expect(applyMap(" \u{20BB7}野家 ", [{ id: 1, k: "\u{20BB7}野家", v: "X" }])).toBe("X");
  });

  it("finds no boundary between an astral letter and a key", () => {
    expect(applyMap("\u{1D400}ok", [{ id: 1, k: "ok", v: "Y" }])).toBe("\u{1D400}ok");
  });
});
