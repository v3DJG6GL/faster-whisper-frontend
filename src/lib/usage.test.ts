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
import { initUsageController, openStatisticsPage, TREND_DAYS } from "./usage";

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
    expect(calls().page).toBeGreaterThan(0); // fetched on open, not on the next tick

    getUsageStats.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(calls().page).toBeGreaterThan(0);

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
});
