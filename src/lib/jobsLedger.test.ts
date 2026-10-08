// The in-flight jobs ledger's pure half: what survives a read back from disk, and
// the caps that keep a runaway file from ever being written.
import { describe, expect, it } from "vitest";

import {
  addRow, clampJobsTtl, EMPTY_LEDGER, maxAgeMs, MAX_LEDGER_BYTES, MAX_ROWS, parseLedger, pruneLedger, removeRow, type LedgerRow,
} from "./jobsLedger";

const NOW = 1_800_000_000_000;

function row(jobId: string, startedAt = NOW, jobsTtlS?: number): LedgerRow {
  return {
    v: 1,
    jobId,
    backendId: "b1",
    serverUrl: "http://localhost:8000",
    path: "/a.mp3",
    kind: "file",
    ctx: { backendId: "b1", serverUrl: "http://localhost:8000", model: "large-v3", language: "", standard: false, jobsTtlS },
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
  it("trims the oldest rows to the byte budget Rust enforces, never the new one", () => {
    const glossary = "x = y\n".repeat(20_000 / 6);
    const big = (i: number): LedgerRow => ({
      ...row(i.toString(16).padStart(8, "0"), NOW + i),
      options: { translationGlossary: glossary },
    });
    const input = Array.from({ length: 20 }, (_, i) => big(i));
    const l = addRow({ v: 1, rows: input }, big(20), NOW + 20);
    expect(new TextEncoder().encode(JSON.stringify({ v: 1, rows: l.rows })).length).toBeLessThanOrEqual(MAX_LEDGER_BYTES);
    expect(l.rows[l.rows.length - 1].jobId).toBe(big(20).jobId);
    // The kept rows are the newest suffix of the input order.
    const kept = l.rows.slice(0, -1).map((r) => r.jobId);
    expect(kept).toEqual(input.slice(input.length - kept.length).map((r) => r.jobId));
    expect(kept.length).toBeLessThan(MAX_ROWS - 1);
  });
  it("replaces a row of the same id instead of duplicating it", () => {
    const l = addRow(addRow(EMPTY_LEDGER, row("aaaaaaaa"), NOW), { ...row("aaaaaaaa"), path: "/b.mp3" }, NOW);
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].path).toBe("/b.mp3");
  });
  it("prunes rows older than the server's TTL", () => {
    const l = addRow(addRow(EMPTY_LEDGER, row("aaaaaaaa", NOW - maxAgeMs(row("aaaaaaaa")) - 1), NOW), row("bbbbbbbb"), NOW);
    expect(pruneLedger(l, NOW).rows.map((r) => r.jobId)).toEqual(["bbbbbbbb"]);
    // Same object back when nothing changed.
    const fresh = addRow(EMPTY_LEDGER, row("cccccccc"), NOW);
    expect(pruneLedger(fresh, NOW)).toBe(fresh);
  });
  it("each row lives as long as its own server keeps the job", () => {
    const H = 3_600_000;
    // A week-long server keeps a 5-day-old row; a default (72 h) one drops its 7-day-old row.
    let l = addRow(EMPTY_LEDGER, row("aaaaaaaa", NOW - 5 * 24 * H, 7 * 86_400), NOW - 5 * 24 * H);
    l = addRow(l, row("bbbbbbbb", NOW - 7 * 24 * H), NOW - 7 * 24 * H);
    // A 1 h server still runs a job up to 24 h from its start, then keeps the result 1 h.
    l = addRow(l, row("cccccccc", NOW - 27 * H, 3600), NOW - 27 * H);
    expect(pruneLedger(l, NOW).rows.map((r) => r.jobId)).toEqual(["aaaaaaaa"]);
    expect(maxAgeMs(row("ffffffff", NOW, 3600))).toBe(26 * H);
    expect(pruneLedger(addRow(EMPTY_LEDGER, row("ffffffff", NOW - 4 * H, 3600), NOW - 4 * H), NOW).rows).toHaveLength(1);
    // The default is twice the server's 72 h (a TTL from the start, re-stamped at the
    // finish) plus an hour of slack: a 100-hour-old row may still hold a finished result.
    expect(maxAgeMs(row("dddddddd"))).toBe(145 * H);
    expect(pruneLedger(addRow(EMPTY_LEDGER, row("eeeeeeee", NOW - 100 * H), NOW - 100 * H), NOW).rows).toHaveLength(1);
  });
  it("clampJobsTtl keeps (0, 30 d] and falls back on anything else", () => {
    expect(clampJobsTtl(3600)).toBe(3600);
    expect(clampJobsTtl(1e12)).toBe(30 * 86_400);
    for (const bad of [0, -5, NaN, Infinity, "3600", null, undefined]) expect(clampJobsTtl(bad)).toBeUndefined();
    // A hand-edited row is re-clamped on read.
    expect(maxAgeMs(row("aaaaaaaa", NOW, 1e12))).toBe(2 * 30 * 86_400_000 + 3_600_000);
    expect(maxAgeMs(row("aaaaaaaa", NOW, -1))).toBe(maxAgeMs(row("aaaaaaaa")));
  });
  it("removeRow is a no-op (same object) for an unknown id", () => {
    const l = addRow(EMPTY_LEDGER, row("aaaaaaaa"), NOW);
    expect(removeRow(l, "bbbbbbbb")).toBe(l);
    expect(removeRow(l, "aaaaaaaa").rows).toEqual([]);
  });
});
