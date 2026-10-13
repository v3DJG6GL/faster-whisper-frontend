// The usage chart's column labels: "today" names the column that is today, not the last one.
import { describe, expect, it } from "vitest";
import { fmtDateTick } from "@/lib/format";
import { bucketTick } from "./chartKit";

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
