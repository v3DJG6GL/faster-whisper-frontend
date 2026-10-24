// The pipeline payload arrives server-shaped (Rust forwards it opaque), so the leaf values
// of a `callback:map` rule are coerced at the boundary: an entry whose value is not the
// declared type is dropped rather than stringified into a corrected phrase or PATCHed back.
import { describe, expect, it } from "vitest";
import {
  applyMap, collapseCounts, envPinnedOf, mapBodyFromRows, mapEntryProblem, mapKeyTwinProblem, mapRowEditProblem, mapRowTwinProblems,
  MAP_ENTRIES_MAX, mapRowsFromRule, mapRowsProblem, rulePatchProblem, ruleCountOf, ruleListOf, ruleLockedFor, ruleMapWritable, saveLanded,
  type MapRow,
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

describe("mapEntryProblem", () => {
  // The server's MapRule: key ^[\w \-.,!?ßẞÄÖÜäöü]{1,64}$ (Rust-regex Unicode \w), value ≤ 64.
  // One pair outside it 422s the whole-map PATCH, so Quick-Add must refuse it before sending.
  it("refuses a phrase the server's word-list pattern rejects", () => {
    for (const k of ["don't", "C++", "user@host", "a\tb", "x".repeat(65), "ä".repeat(65), "line\nbreak"]) {
      expect(mapEntryProblem(k, ","), k).not.toBeNull();
    }
    expect(mapEntryProblem("", ",")).not.toBeNull();
  });

  it("takes what the pattern takes", () => {
    for (const k of ["Grüße", "k8s", "hello world", " Prozent", "STRASSE ẞ", "snake_case", "Ausrufezeichen!", "x".repeat(64), "ä".repeat(64), "café", "日本語"]) {
      expect(mapEntryProblem(k, ","), k).toBeNull();
    }
    // A decomposed accent is a combining mark — inside Rust's Unicode \w.
    expect(mapEntryProblem("cafe\u0301", ",")).toBeNull();
  });

  it("bounds the value at 64 code points", () => {
    expect(mapEntryProblem("comma", "x".repeat(64))).toBeNull();
    expect(mapEntryProblem("comma", "\u{1F600}".repeat(64))).toBeNull(); // 128 UTF-16 units, 64 code points
    expect(mapEntryProblem("comma", "x".repeat(65))).toMatch(/insert is too long/);
  });

  it("names the offending character, by code point when it is invisible", () => {
    expect(mapEntryProblem("don't", "")).toMatch(/^“'” /);
    expect(mapEntryProblem("a\tb", "")).toMatch(/^A tab /);
    expect(mapEntryProblem("a\u00a0b", "")).toMatch(/^U\+00A0 /);
  });
});

// The server lower-cases a map's keys and 422s the whole PATCH when two collide ("map keys
// ['Komma', 'komma'] collide when lowercased"), so a case twin must be refused before it is sent.
describe("mapKeyTwinProblem", () => {
  const rows = [{ id: 1, k: "komma", v: "," }];

  it("refuses a key that differs from another row's only in letter case", () => {
    expect(mapKeyTwinProblem("Komma", rows)).toMatch(/“komma” is already in this list/);
    expect(mapKeyTwinProblem("STRAẞE", [{ id: 2, k: "straße", v: "" }])).not.toBeNull(); // ẞ lower-cases to ß
  });

  it("takes a new key, an exact duplicate, and a row's own case change", () => {
    expect(mapKeyTwinProblem("punkt", rows)).toBeNull();
    expect(mapKeyTwinProblem("komma", rows)).toBeNull(); // one key on the wire: the newest row wins
    expect(mapKeyTwinProblem("Komma", rows, 1)).toBeNull(); // editing the "komma" row itself
    expect(mapKeyTwinProblem(" komma", rows)).toBeNull(); // spaces are part of the server's key
  });
});

describe("mapRowEditProblem + mapRowTwinProblems (the inline list editor)", () => {
  // The row editor: each keystroke is taken unless mapRowEditProblem refuses it, as QuickAdd's
  // editRow does. Select-all then type: the first character replaces the phrase.
  function typeInto(rows: MapRow[], id: number, text: string, seen: (rows: MapRow[]) => void = () => {}): MapRow[] {
    for (let i = 1; i <= text.length; i++) {
      const row = rows.find((r) => r.id === id)!;
      const next = { ...row, k: text.slice(0, i) };
      if (mapRowEditProblem(row, next) === null) rows = rows.map((r) => (r.id === id ? next : r));
      seen(rows);
    }
    return rows;
  }

  it("types through a case twin of another row on the way to a different phrase", () => {
    const start = [{ id: 1, k: "komma", v: "," }, { id: 2, k: "x", v: ";" }];
    let atTwin: Map<number, string> | null = null;
    const end = typeInto(start, 2, "Kommandozeile", (rs) => {
      if (rs.find((r) => r.id === 2)!.k === "Komma") atTwin = mapRowTwinProblems(rs);
    });
    expect(end.find((r) => r.id === 2)!.k).toBe("Kommandozeile");
    // While the row read "Komma" the twin showed under it — and held the save (a non-empty map).
    expect(atTwin!.get(2)).toMatch(/“komma” is already in this list/);
    expect(atTwin!.get(1)).toMatch(/“Komma” is already in this list/);
    expect(mapRowTwinProblems(end).size).toBe(0);
    // Adding "Komma" from the capture row is still refused.
    expect(mapKeyTwinProblem("Komma", start)).not.toBeNull();
  });

  it("still refuses a keystroke the schema rejects, and lets an out-of-bounds row be fixed", () => {
    const row = { id: 1, k: "don", v: "" };
    expect(mapRowEditProblem(row, { ...row, k: "don'" })).toMatch(/^“'” /);
    const bad = { id: 1, k: "C++", v: "" };
    expect(mapRowEditProblem(bad, { ...bad, k: "C+" })).toBeNull();
    expect(mapRowEditProblem({ id: 1, k: "", v: "" }, { id: 1, k: "", v: "x".repeat(65) })).toBeNull(); // a blank phrase is never sent
  });

  it("an exact duplicate or blank rows are not twins", () => {
    expect(mapRowTwinProblems([{ id: 1, k: "komma", v: "," }, { id: 2, k: "komma", v: ";" }, { id: 3, k: " ", v: "" }, { id: 4, k: "", v: "" }]).size).toBe(0);
  });
});

describe("mapRowsProblem (the Dictionary's Save gate)", () => {
  it("holds the Save for a case twin, naming the other spelling", () => {
    expect(mapRowsProblem([{ id: 1, k: "Komma", v: ";" }, { id: 2, k: "komma", v: "," }])).toMatch(/“komma” is already in this list/);
  });

  it("holds the Save for a pair the schema rejects", () => {
    expect(mapRowsProblem([{ id: 1, k: "punkt", v: "." }, { id: 2, k: "C++", v: "c" }])).toMatch(/^“\+” /);
    expect(mapRowsProblem([{ id: 1, k: "x".repeat(65), v: "" }])).toMatch(/phrase is too long/);
  });

  it("takes a valid map, an exact duplicate and an unfilled row", () => {
    expect(mapRowsProblem([{ id: 1, k: "komma", v: "," }, { id: 2, k: "komma", v: ";" }, { id: 3, k: "", v: "'" }, { id: 4, k: "punkt", v: "." }])).toBeNull();
  });

  it("holds the Save past the server's per-map entry cap, counting keys as they go on the wire", () => {
    // MapRule.map's max_length: the server refuses a 10,001-key map whole.
    expect(MAP_ENTRIES_MAX).toBe(10_000);
    const full: MapRow[] = Array.from({ length: MAP_ENTRIES_MAX }, (_, i) => ({ id: i + 1, k: `w${i}`, v: "" }));
    // At the cap, plus an exact duplicate and a blank row (neither adds a key), it still saves.
    expect(mapRowsProblem([...full, { id: -1, k: "w0", v: "x" }, { id: -2, k: " ", v: "" }])).toBeNull();
    expect(mapRowsProblem([{ id: 0, k: "one more", v: "" }, ...full])).toMatch(/list is too long \(at most 10,000 mappings\) — delete 1 to save/);
  });
});

describe("rulePatchProblem (the Dictionary's Save gate for the other rule bodies)", () => {
  // Each bound is settings/schema.py's: the server re-validates the whole merged list, so one of
  // these sent beside a valid map edit 422s the whole save, the map edit included.
  it("holds a lowercase word outside the server's pattern, or over its length", () => {
    expect(rulePatchProblem({ pattern: "x", wordlist: ["und", "café"] })).toMatch(/^“é” can’t be in a lowercase word/);
    expect(rulePatchProblem({ wordlist: ["don't"] })).toMatch(/^“'” /);
    expect(rulePatchProblem({ wordlist: ["Mrs."] })).toMatch(/^“\.” /);
    expect(rulePatchProblem({ wordlist: ["a b"] })).toMatch(/^U\+0020 /);
    expect(rulePatchProblem({ wordlist: ["x".repeat(33)] })).toMatch(/too long for a lowercase word \(at most 32 letters\)/);
    expect(rulePatchProblem({ wordlist: Array.from({ length: 2001 }, () => "und") })).toMatch(/Too many lowercase words \(at most 2,000\)/);
  });

  it("takes the words the server takes", () => {
    expect(rulePatchProblem({ pattern: "x", wordlist: ["x".repeat(32), "Straße", "ÄÖÜäöü"] })).toBeNull();
    expect(rulePatchProblem({ wordlist: Array.from({ length: 2000 }, () => "und") })).toBeNull();
  });

  it("holds an over-long pattern, or a regex-list entry field past its bound", () => {
    expect(rulePatchProblem({ pattern: "a".repeat(513) })).toMatch(/^The pattern is too long \(at most 512 characters\)/);
    expect(rulePatchProblem({ pattern: "a".repeat(512) })).toBeNull();
    const entry = { pattern: "p", replacement: "r", label: "l", note: "n" };
    expect(rulePatchProblem({ entries: [entry, { ...entry, pattern: "a".repeat(600) }] })).toMatch(/^Entry 2’s pattern is too long \(at most 512/);
    expect(rulePatchProblem({ entries: [{ ...entry, replacement: "a".repeat(513) }] })).toMatch(/^Entry 1’s replacement is too long/);
    expect(rulePatchProblem({ entries: [{ ...entry, label: "a".repeat(81) }] })).toMatch(/^Entry 1’s label is too long \(at most 80/);
    expect(rulePatchProblem({ entries: [{ ...entry, note: "a".repeat(4001) }] })).toMatch(/^Entry 1’s note is too long \(at most 4,000/);
    expect(rulePatchProblem({ entries: [{ ...entry, label: "a".repeat(80), note: "a".repeat(4000) }] })).toBeNull();
  });

  it("counts code points, as the server does", () => {
    expect(rulePatchProblem({ pattern: "\u{1F600}".repeat(512) })).toBeNull(); // 1024 UTF-16 units
  });
});

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
