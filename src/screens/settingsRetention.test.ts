import { describe, expect, it } from "vitest";
import {
  DICTATION_RETENTION_OPTIONS,
  HISTORY_RETENTION_OPTIONS,
  LOG_RETENTION_OPTIONS,
  withCurrentDay,
} from "./retentionOptions";

// Pure screen helper, tested without a DOM (the axisLayout.test.ts precedent).
describe("withCurrentDay", () => {
  it("returns the same list when the value is already offered", () => {
    expect(withCurrentDay(LOG_RETENTION_OPTIONS, 30)).toBe(LOG_RETENTION_OPTIONS);
    expect(withCurrentDay(DICTATION_RETENTION_OPTIONS, 0)).toBe(DICTATION_RETENTION_OPTIONS);
    expect(withCurrentDay(HISTORY_RETENTION_OPTIONS, 365)).toBe(HISTORY_RETENTION_OPTIONS);
  });

  it("appends an unlisted value so the select can show it", () => {
    const out = withCurrentDay(LOG_RETENTION_OPTIONS, 60);
    expect(out).toHaveLength(LOG_RETENTION_OPTIONS.length + 1);
    expect(out[out.length - 1]).toEqual({ value: "60", label: "60 days" });
    expect(out.slice(0, -1)).toEqual(LOG_RETENTION_OPTIONS);
    // The lists themselves are never mutated.
    expect(LOG_RETENTION_OPTIONS.some((o) => o.value === "60")).toBe(false);
  });

  it("singularises a one-day value", () => {
    const out = withCurrentDay(HISTORY_RETENTION_OPTIONS, 1);
    expect(out[out.length - 1]).toEqual({ value: "1", label: "1 day" });
  });

  it("the three retention lists agree with the day the app would persist", () => {
    // 14 is a dictation value older configs carry; the dictation list lacks it.
    const out = withCurrentDay(DICTATION_RETENTION_OPTIONS, 14);
    expect(out.map((o) => o.value)).toContain("14");
  });
});
