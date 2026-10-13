// The pipeline payload arrives server-shaped (Rust forwards it opaque), so the leaf values
// of a `callback:map` rule are coerced at the boundary: an entry whose value is not the
// declared type is dropped rather than stringified into a corrected phrase or PATCHed back.
import { describe, expect, it } from "vitest";
import {
  applyMap, collapseCounts, envPinnedOf, mapBodyFromRows, mapRowsFromRule, ruleCountOf, ruleListOf, ruleLockedFor,
  ruleMapWritable, saveLanded,
} from "./pipelineMap";
import type { PipelineFetch, PipelineRule, PipelineRulesState, PipelineSaveResult } from "./types";

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

  it("caps the list while ruleCountOf still counts every rule the server sent", () => {
    const res = fetchWith([...Array.from({ length: 600 }, (_, i) => ({ name: `r${i}`, type: "callback:map" })), "junk", null]);
    expect(ruleListOf(res)).toHaveLength(500);
    expect(ruleCountOf(res)).toBe(600);
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

  it("lets a ß key match its ss spelling, like the backend's derived variant", () => {
    expect(applyMap("grösser als", [{ id: 1, k: "größer als", v: ">" }])).toBe(">");
    expect(applyMap("GROSSE", [{ id: 1, k: "GROẞE", v: "big" }])).toBe("big");
  });

  it("lets a key written with ss win over a derived one, whatever the row order", () => {
    const ss = { id: 1, k: "grösser als", v: "ss" };
    const sz = { id: 2, k: "größer als", v: "sz" };
    expect(applyMap("grösser als", [ss, sz])).toBe("ss");
    expect(applyMap("grösser als", [sz, ss])).toBe("ss");
    expect(applyMap("größer als", [sz, ss])).toBe("sz");
  });

  it("gives two ß keys differing only in case the server's value for their shared ss spelling", () => {
    // The saved map is code-point sorted, so the server derives "STRASSE" from "STRAẞE" first.
    const rows = [{ id: 1, k: "Straße", v: "A" }, { id: 2, k: "STRAẞE", v: "B" }];
    expect(applyMap("Strasse", rows)).toBe("B");
    expect(applyMap("Straße", rows)).toBe("A");
  });

  it("gives keys differing only in case the server's one value, whatever the row order", () => {
    // The server's lookup is keyed lower-cased, filled in the saved map's code-point order:
    // "komma" sorts after "Komma", so its value wins for both spellings.
    const upper = { id: 1, k: "Komma", v: ";" };
    const lower = { id: 2, k: "komma", v: "," };
    for (const rows of [[upper, lower], [lower, upper]]) {
      expect(applyMap("Komma", rows)).toBe(",");
      expect(applyMap("komma", rows)).toBe(",");
    }
    // The ß pair in the other row order: the same saved map, so the same values.
    const rows = [{ id: 2, k: "STRAẞE", v: "B" }, { id: 1, k: "Straße", v: "A" }];
    expect(applyMap("Straße", rows)).toBe("A");
    expect(applyMap("Strasse", rows)).toBe("B");
  });
});

describe("envPinnedOf", () => {
  it("keeps only string names from an array and ignores any other shape", () => {
    expect(envPinnedOf({ env_pinned_ignored: ["PIPELINE_RULES", 3] } as unknown as PipelineSaveResult)).toEqual(["PIPELINE_RULES"]);
    expect(envPinnedOf({ env_pinned_ignored: "PIPELINE_RULES" } as unknown as PipelineSaveResult)).toEqual([]);
    expect(envPinnedOf({} as PipelineSaveResult)).toEqual([]);
  });
});

describe("saveLanded", () => {
  const save = (ok: boolean, status: number) => ({ ok, status, saved: [], conflicts: [], requires_restart: false }) as PipelineSaveResult;
  it("counts a readable 2xx and a 2xx whose reply was unreadable as landed", () => {
    expect(saveLanded(save(true, 200))).toBe(true);
    expect(saveLanded(save(false, 200))).toBe(true);
    expect(saveLanded(save(false, 204))).toBe(true);
  });
  it("treats a transport failure, a rejection or a server error as not landed", () => {
    expect(saveLanded(save(false, 0))).toBe(false);
    expect(saveLanded(save(false, 422))).toBe(false);
    expect(saveLanded(save(false, 500))).toBe(false);
    expect(saveLanded(save(false, 300))).toBe(false);
  });
});

describe("ruleMapWritable", () => {
  const rule = (locked?: boolean): PipelineRule =>
    ({ name: "sym", label: "Symbols", type: "callback:map", enabled: true, locked, map: {} }) as PipelineRule;
  const state = (role: "admin" | "user", ef: unknown = { "callback:map": ["enabled", "map"] }) =>
    ({ rules: [], role, editable_fields: ef }) as PipelineRulesState;

  it("refuses a locked list for a non-admin, as the server's PATCH does", () => {
    expect(ruleMapWritable(rule(true), state("user"))).toBe(false);
    expect(ruleLockedFor(rule(true), "user")).toBe(true);
    expect(ruleLockedFor(rule(true), undefined)).toBe(true);
  });

  it("lets an admin write a locked list, and anyone an unlocked one", () => {
    expect(ruleMapWritable(rule(true), state("admin"))).toBe(true);
    expect(ruleMapWritable(rule(false), state("user"))).toBe(true);
    expect(ruleMapWritable(rule(), state("user"))).toBe(true);
  });

  it("refuses when editable_fields does not list map for the type, or is malformed", () => {
    expect(ruleMapWritable(rule(), state("user", { "callback:map": ["enabled"] }))).toBe(false);
    expect(ruleMapWritable(rule(), state("user", {}))).toBe(false);
    expect(ruleMapWritable(rule(), state("user", ["map"]))).toBe(false);
    expect(ruleMapWritable(rule(), state("user", { "callback:map": "map" }))).toBe(false);
    expect(ruleMapWritable(rule(), undefined)).toBe(false);
  });
});
