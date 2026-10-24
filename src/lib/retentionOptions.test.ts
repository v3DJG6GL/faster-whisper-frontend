import { describe, expect, it } from "vitest";
import {
  DICTATION_RETENTION_OPTIONS,
  HISTORY_RETENTION_OPTIONS,
  LOG_RETENTION_OPTIONS,
  withCurrentDay,
} from "./retentionOptions";

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

  it("groups the thousands of a large unlisted value like every other count", () => {
    const out = withCurrentDay(LOG_RETENTION_OPTIONS, 3650);
    expect(out[out.length - 1]).toEqual({ value: "3650", label: "3,650 days" });
  });

  it("the three retention lists agree with the day the app would persist", () => {
    // Each value is one an older config can carry and its own list lacks.
    const out = withCurrentDay(DICTATION_RETENTION_OPTIONS, 14);
    expect(out.map((o) => o.value)).toContain("14");
    expect(withCurrentDay(HISTORY_RETENTION_OPTIONS, 14).map((o) => o.value)).toContain("14");
    expect(withCurrentDay(LOG_RETENTION_OPTIONS, 365).map((o) => o.value)).toContain("365");
  });
});
