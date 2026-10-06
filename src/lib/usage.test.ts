// The usage poll's cost gates: the Statistics page's documents only while the page is
// open, and a hidden main window polling every HIDDEN_EVERY ticks with a catch-up on show.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { getUsageStats, vis } = vi.hoisted(() => ({
  getUsageStats: vi.fn(async (_args: { query: Record<string, unknown> }) => ({ today: {}, total: {}, series: [] })),
  vis: { hidden: false, listeners: new Set<(h: boolean) => void>() },
}));

vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), isTauri: true, getUsageStats }));
vi.mock("./usageOutcome", () => ({ initOutcomeQueue: async () => {}, flushOutcomes: async () => {} }));
vi.mock("./windowVisibility", () => ({
  isWindowHidden: () => vis.hidden,
  onWindowHiddenChange: (fn: (h: boolean) => void) => {
    vis.listeners.add(fn);
    return () => vis.listeners.delete(fn);
  },
}));

import { useApp } from "./store";
import { initUsageController, openStatisticsPage, sameViewSource, TREND_DAYS } from "./usage";

const setHidden = (h: boolean) => {
  vis.hidden = h;
  for (const fn of vis.listeners) fn(h);
};
/** Settle the awaited chain of a refresh pass. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** Calls since the last reset, split into the fixed per-backend document and the page's. */
function calls() {
  const all = getUsageStats.mock.calls.map(([a]) => a.query);
  const fixed = all.filter((q) => q.days === TREND_DAYS && Object.keys(q).length <= 2).length;
  return { fixed, page: all.length - fixed };
}

describe("usage poll gates", () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    useApp.setState({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      // Not the 30-day default: its query would look exactly like the fixed document's, and
      // `calls()` could not tell the page's own fetch from it.
      usageViewQuery: { range: "90", with: [] },
    });
    initUsageController();
    await settle(); // the launch pass
  });
  afterAll(() => vi.useRealTimers());

  it("fetches the page documents only while the Statistics page is open", async () => {
    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(calls()).toEqual({ fixed: 1, page: 0 });

    getUsageStats.mockClear();
    const close = openStatisticsPage();
    await settle();
    expect(calls().page).toBe(2); // the view + the year, fetched on open, not on the next tick

    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(calls().page).toBe(2);

    close();
    close(); // a second cleanup call must not unbalance the count
    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(calls()).toEqual({ fixed: 1, page: 0 });
  });

  it("polls every 10th tick while hidden, and catches up when shown", async () => {
    setHidden(true);
    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(9 * 30_000);
    await settle();
    expect(calls().fixed).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(calls().fixed).toBe(1);

    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 30_000); // three ticks passed over
    setHidden(false);
    await settle();
    expect(calls().fixed).toBe(1); // the catch-up pass, without waiting for a tick
  });

  it("a hidden window skips the page documents even with the page open", async () => {
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 30_000);
    await settle();
    expect(calls()).toEqual({ fixed: 1, page: 0 });
    close();
    setHidden(false);
  });

  it("shown right after a hidden pass, the open page still catches up", async () => {
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 30_000); // the 10th tick runs a pass without the page
    await settle();
    getUsageStats.mockClear();
    setHidden(false); // no tick passed over since, yet the page's documents are stale
    await settle();
    expect(calls().page).toBe(2);
    close();
  });

  it("shown right after a hidden after-session pass, the open page still catches up", async () => {
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    useApp.setState({ status: "recording" } as never);
    useApp.setState({ status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(1_500); // the after-session pass runs without the page
    await settle();
    getUsageStats.mockClear();
    setHidden(false); // no tick passed over, yet that pass skipped the page's documents
    await settle();
    expect(calls().page).toBe(2);
    close();
  });
});

describe("the Statistics page document on a failed fetch", () => {
  const sig = (backendId: string, target: string, range: string) => JSON.stringify([backendId, target, { range }]);

  it("keeps the last good document up and marks the new query failed", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    useApp.setState({ usageView: null });
    useApp.getState().setUsageView(sig("a", "http://a", "30"), good);
    useApp.getState().setUsageView(sig("a", "http://a", "365"), null);
    expect(useApp.getState().usageView).toEqual({ sig: sig("a", "http://a", "365"), stats: good, failed: true });
    // A later success for that query clears the failure.
    const fresh = { today: {}, total: { words: 1 }, series: [] } as never;
    useApp.getState().setUsageView(sig("a", "http://a", "365"), fresh);
    expect(useApp.getState().usageView).toEqual({ sig: sig("a", "http://a", "365"), stats: fresh });
  });

  it("never carries another backend's or target's document over a failure", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    for (const next of [sig("b", "http://a", "30"), sig("a", "http://other", "30")]) {
      useApp.setState({ usageView: null });
      useApp.getState().setUsageView(sig("a", "http://a", "30"), good);
      useApp.getState().setUsageView(next, null);
      expect(useApp.getState().usageView).toEqual({ sig: next, stats: null, failed: true });
    }
  });
});

describe("sameViewSource", () => {
  const sig = (backendId: string, target: string, range: string) => JSON.stringify([backendId, target, { range }]);

  it("matches on backend + target whatever the query", () => {
    expect(sameViewSource(sig("a", "http://a", "30"), sig("a", "http://a", "365"))).toBe(true);
    expect(sameViewSource(sig("a", "http://a", "30"), sig("b", "http://a", "30"))).toBe(false);
    expect(sameViewSource(sig("a", "http://a", "30"), sig("a", "http://other", "30"))).toBe(false);
  });

  it("never matches a missing or malformed signature", () => {
    expect(sameViewSource(null, null)).toBe(false);
    expect(sameViewSource("not json", "not json")).toBe(false);
    expect(sameViewSource("[1]", "[1]")).toBe(false);
    expect(sameViewSource(undefined, sig("a", "http://a", "30"))).toBe(false);
  });
});
