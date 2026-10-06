// The Statistics calendar's year document on a failed fetch: same rule as the page document —
// the last good year from the same backend + target stays up, marked failed, never another's.

import { describe, expect, it } from "vitest";
import { useApp } from "./store";

const sig = (backendId: string, target: string, w: string) => JSON.stringify([backendId, target, { range: "365", with: w }]);

describe("the Statistics year document on a failed fetch", () => {
  it("keeps the last good year up and marks the new query failed", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    useApp.setState({ usageYear: null });
    useApp.getState().setUsageYear(sig("a", "http://a", "all"), good);
    useApp.getState().setUsageYear(sig("a", "http://a", "dictate"), null);
    expect(useApp.getState().usageYear).toEqual({ sig: sig("a", "http://a", "dictate"), stats: good, failed: true });
    // A repeat failure for the same query is a no-op (same reference).
    const before = useApp.getState().usageYear;
    useApp.getState().setUsageYear(sig("a", "http://a", "dictate"), null);
    expect(useApp.getState().usageYear).toBe(before);
    // A later success for that query clears the failure, even when it equals the carried year.
    useApp.getState().setUsageYear(sig("a", "http://a", "dictate"), good);
    expect(useApp.getState().usageYear).toEqual({ sig: sig("a", "http://a", "dictate"), stats: good });
  });

  it("never carries another backend's or target's year over a failure", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    for (const next of [sig("b", "http://a", "all"), sig("a", "http://other", "all")]) {
      useApp.setState({ usageYear: null });
      useApp.getState().setUsageYear(sig("a", "http://a", "all"), good);
      useApp.getState().setUsageYear(next, null);
      expect(useApp.getState().usageYear).toEqual({ sig: next, stats: null, failed: true });
    }
  });
});
