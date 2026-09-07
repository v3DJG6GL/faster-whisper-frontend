// The in-flight jobs ledger's pure half: what survives a read back from disk, and
// the caps that keep a runaway file from ever being written.
import { describe, expect, it } from "vitest";

import { addRow, EMPTY_LEDGER, MAX_AGE_MS, MAX_ROWS, parseLedger, pruneLedger, removeRow, type LedgerRow } from "./jobsLedger";

const NOW = 1_800_000_000_000;

function row(jobId: string, startedAt = NOW): LedgerRow {
  return {
    v: 1,
    jobId,
    backendId: "b1",
    serverUrl: "http://localhost:8000",
    path: "/a.mp3",
    kind: "file",
    ctx: { backendId: "b1", serverUrl: "http://localhost:8000", model: "large-v3", language: "", standard: false },
    startedAt,
  };
}

describe("parseLedger", () => {
  it("drops malformed rows and foreign ids, never the whole ledger", () => {
    const good = row("cafe".repeat(8));
    const doc = {
      v: 1,
      rows: [
        good,
        { ...good, jobId: "../../etc" },
        { ...good, jobId: "CAFE" },
        { ...good, kind: "text" },
        { ...good, ctx: null },
        { ...good, startedAt: "yesterday" },
        null,
        "x",
      ],
    };
    expect(parseLedger(doc).rows).toEqual([good]);
  });
  it("returns the empty ledger for anything that is not a ledger", () => {
    expect(parseLedger(null)).toBe(EMPTY_LEDGER);
    expect(parseLedger([1, 2])).toBe(EMPTY_LEDGER);
    expect(parseLedger({ v: 1 })).toBe(EMPTY_LEDGER);
  });
});

describe("addRow / pruneLedger / removeRow", () => {
  it("caps at the newest MAX_ROWS", () => {
    let l = EMPTY_LEDGER;
    for (let i = 0; i < MAX_ROWS + 3; i++) l = addRow(l, row(i.toString(16).padStart(8, "0"), NOW + i), NOW + i);
    expect(l.rows).toHaveLength(MAX_ROWS);
    expect(l.rows[0].jobId).toBe((3).toString(16).padStart(8, "0"));
  });
  it("replaces a row of the same id instead of duplicating it", () => {
    const l = addRow(addRow(EMPTY_LEDGER, row("aaaaaaaa"), NOW), { ...row("aaaaaaaa"), path: "/b.mp3" }, NOW);
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].path).toBe("/b.mp3");
  });
  it("prunes rows older than the server's TTL", () => {
    const l = addRow(addRow(EMPTY_LEDGER, row("aaaaaaaa", NOW - MAX_AGE_MS - 1), NOW), row("bbbbbbbb"), NOW);
    expect(pruneLedger(l, NOW).rows.map((r) => r.jobId)).toEqual(["bbbbbbbb"]);
    // Same object back when nothing changed.
    const fresh = addRow(EMPTY_LEDGER, row("cccccccc"), NOW);
    expect(pruneLedger(fresh, NOW)).toBe(fresh);
  });
  it("removeRow is a no-op (same object) for an unknown id", () => {
    const l = addRow(EMPTY_LEDGER, row("aaaaaaaa"), NOW);
    expect(removeRow(l, "bbbbbbbb")).toBe(l);
    expect(removeRow(l, "aaaaaaaa").rows).toEqual([]);
  });
});
