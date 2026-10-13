// History's day groups stay one per label, with damaged stamps in one "Earlier" group, last.
import { describe, expect, it } from "vitest";
import { dayBuckets, startOfDay } from "./historyBuckets";

const now = new Date(2026, 9, 13, 15, 0);
const todayStart = startOfDay(now);
const rec = (id: string, createdAt: string) => ({ id, createdAt });
const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
/** The instant `d` written with an explicit, non-Z offset: built from the local clock so it
 *  lands on the intended local day in every time zone the tests run in. */
const withOffset = (d: Date, offsetMin: number) => {
  const wall = new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMin);
  return `${wall}${offsetMin < 0 ? "-" : "+"}${pad(abs / 60)}:${pad(abs % 60)}`;
};

describe("dayBuckets", () => {
  it("puts unparseable stamps in exactly one 'Earlier' group, last", () => {
    const today = new Date(2026, 9, 13, 10, 0).toISOString();
    const yesterday = new Date(2026, 9, 12, 10, 0).toISOString();
    // Sorted on the raw strings: 'garbage' above ISO, '' below.
    const groups = dayBuckets([rec("g", "garbage"), rec("t", today), rec("y", yesterday), rec("e", "")], todayStart);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups[2].items.map((r) => r.id)).toEqual(["g", "e"]);
  });

  it("keeps one group per day when a foreign stamp splits it", () => {
    const a = new Date(2026, 9, 13, 12, 0).toISOString();
    const b = new Date(2026, 9, 12, 12, 0).toISOString();
    // Today, written with a foreign offset: a raw string sort can put it below yesterday's Z stamp.
    const c = withOffset(new Date(2026, 9, 13, 9, 0), 120);
    const groups = dayBuckets([rec("a", a), rec("b", b), rec("c", c)], todayStart);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0].items.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("leaves valid newest-first records in their order", () => {
    const ts = [13, 13, 12, 10, 10].map((d, i) => new Date(2026, 9, d, 20 - i).toISOString());
    const groups = dayBuckets(ts.map((t, i) => rec(String(i), t)), todayStart);
    expect(groups.map((g) => g.items.map((r) => r.id))).toEqual([["0", "1"], ["2"], ["3", "4"]]);
    expect(groups.slice(0, 2).map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });
});
