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

  it("a page closed while hidden does not make every later show run a pass", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 30_000); // the hidden pass skips the open page
    await settle();
    getUsageStats.mockClear();
    close();
    setHidden(false); // no catch-up pass: the closed page took the flag with it
    await settle();
    expect(calls()).toEqual({ fixed: 0, page: 0 });
    setHidden(true);
    setHidden(false); // nothing was passed over since
    await settle();
    expect(calls()).toEqual({ fixed: 0, page: 0 });
  });

  it("refetches a backend whose cached usage was dropped without a backend edit", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    getUsageStats.mockClear();
    useApp.getState().forgetBackendCaches("b1"); // an API-key rotation: bKey does not move
    await settle();
    expect(calls().fixed).toBe(0); // debounced (a URL override evicts per keystroke)
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(calls().fixed).toBe(1); // without waiting for the next tick
  });

  it("coalesces evictions inside the debounce into one pass", async () => {
    getUsageStats.mockClear();
    useApp.getState().forgetBackendCaches("b1");
    await vi.advanceTimersByTimeAsync(500);
    // The next keystroke: the cache holds the key again (a fast failure commits a null)…
    useApp.setState((s) => ({ usage: { ...s.usage, b1: null } }));
    useApp.getState().forgetBackendCaches("b1"); // …and the new value evicts it again
    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(calls().fixed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calls().fixed).toBe(1);
  });
  it("runs the eviction pass 1 s after the LAST override keystroke, not the first", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    getUsageStats.mockClear();
    // Only the first keystroke evicts the usage key; the rest change the override alone.
    useApp.getState().setUrlOverride("b1", "http://1");
    await vi.advanceTimersByTimeAsync(600);
    useApp.getState().setUrlOverride("b1", "http://10");
    await vi.advanceTimersByTimeAsync(600);
    useApp.getState().setUrlOverride("b1", "http://10.0");
    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(calls().fixed).toBe(0); // 2.2 s after the first keystroke, still waiting
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calls().fixed).toBe(1);
    // Restore, and let the pass it arms run before the next case.
    useApp.getState().setUrlOverride("b1", null);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
  });
  it("refetches when an override keystroke lands while the eviction pass's fetch is in flight", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    getUsageStats.mockClear();
    let release!: (v: null) => void;
    getUsageStats.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    useApp.getState().setUrlOverride("b1", "http://1"); // evicts b1
    await vi.advanceTimersByTimeAsync(1_000); // the debounced pass starts; its fetch hangs
    await settle();
    expect(calls().fixed).toBe(1);
    // No timer is pending now and b1's key is already gone — the next keystroke must still re-arm.
    useApp.getState().setUrlOverride("b1", "http://10.0");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    // The held fetch resolves against the old address and bails without re-adding b1…
    release(null);
    await settle();
    // …so the folded rerun is the one that fetches the new address.
    expect(calls().fixed).toBe(2);
    expect("b1" in useApp.getState().usage).toBe(true);
    // Restore, and let the pass it arms run before the next case.
    useApp.getState().setUrlOverride("b1", null);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
  });
  it("a page reopened onto a miss marks the kept documents failed instead of current", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    let close = openStatisticsPage();
    await settle();
    close();
    const { usageView, usageYear } = useApp.getState();
    expect(usageView?.stats && !usageView.failed).toBeTruthy();
    expect(usageYear?.stats && !usageYear.failed).toBeTruthy();
    // The page closed; on the next visit the server does not answer (view + year).
    getUsageStats.mockImplementationOnce(async () => null as never).mockImplementationOnce(async () => null as never);
    close = openStatisticsPage();
    await settle();
    // Same query, so the same documents — kept up, but no longer presented as current.
    expect(useApp.getState().usageView).toEqual({ sig: usageView!.sig, stats: usageView!.stats, failed: true });
    expect(useApp.getState().usageYear).toEqual({ sig: usageYear!.sig, stats: usageYear!.stats, failed: true });
    close();
  });
  it("a reopen miss does not mark failed what a pass fetched while it was out", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    let releaseView!: (v: null) => void;
    let releaseYear!: (v: null) => void;
    getUsageStats
      .mockImplementationOnce(() => new Promise((r) => (releaseView = r)) as never)
      .mockImplementationOnce(() => new Promise((r) => (releaseYear = r)) as never);
    const close = openStatisticsPage(); // the reopen's view + year fetches hang
    await settle();
    await vi.advanceTimersByTimeAsync(30_000); // a tick answers the same query (identical data)
    await settle();
    releaseView(null);
    releaseYear(null);
    await settle();
    expect(useApp.getState().usageView?.stats).toBeTruthy();
    expect(useApp.getState().usageView?.failed).toBeFalsy();
    expect(useApp.getState().usageYear?.stats).toBeTruthy();
    expect(useApp.getState().usageYear?.failed).toBeFalsy();
    close();
  });
  it("the show catch-up marks the page documents failed on a miss after a hidden pass", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    const close = openStatisticsPage();
    await settle();
    const { usageView, usageYear } = useApp.getState();
    expect(usageView?.stats && !usageView.failed).toBeTruthy();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 30_000); // a hidden pass skips the page's documents
    await settle();
    // The server is gone for the page's documents when the window comes back.
    const ok = getUsageStats.getMockImplementation()!;
    getUsageStats.mockImplementation(async (a) =>
      a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2 ? ok(a) : (null as never),
    );
    try {
      setHidden(false);
      await settle();
      expect(useApp.getState().usageView).toEqual({ sig: usageView!.sig, stats: usageView!.stats, failed: true });
      expect(useApp.getState().usageYear).toEqual({ sig: usageYear!.sig, stats: usageYear!.stats, failed: true });
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
    }
  });
  it("refetches the page when the home profile moves the default backend under it", async () => {
    useApp.setState((s) => ({
      backends: [
        { id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never,
        { id: "b2", name: "b2", serverUrl: "https://t.example", hasApiKey: false } as never,
      ],
      profiles: [
        { id: "p1", enabled: true, backendId: "b1" } as never,
        { id: "p2", enabled: true, backendId: "b2" } as never,
      ],
      usageViewBackendId: null,
      settings: { ...s.settings, homeProfileId: "p1" },
    }));
    await vi.advanceTimersByTimeAsync(30_000); // the backend-edit pass, then a tick: both have usage
    await settle();
    const close = openStatisticsPage();
    await settle();
    getUsageStats.mockClear();
    // The overlay chip cycles the home profile while the page is open.
    useApp.setState((s) => ({ settings: { ...s.settings, homeProfileId: "p2" } }));
    await settle();
    const page = getUsageStats.mock.calls.map(([a]) => a as { backendId?: string });
    expect(page.length).toBe(2); // the view + the year, without waiting for a tick
    expect(page.every((a) => a.backendId === "b2")).toBe(true);
    // A home-profile change that leaves the default backend where it is fetches nothing.
    getUsageStats.mockClear();
    useApp.setState((s) => ({ settings: { ...s.settings, homeProfileId: "p2" }, profiles: [...s.profiles] }));
    await settle();
    expect(getUsageStats).not.toHaveBeenCalled();
    close();
    useApp.setState((s) => ({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      profiles: [],
      settings: { ...s.settings, homeProfileId: undefined },
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
  });
  it("seeds the year from the 1 year view coming back from it, refetches it from All, and reuses it between shorter ranges", async () => {
    const ok = getUsageStats.getMockImplementation()!;
    const page = (a: { query: Record<string, unknown> }) => !(a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2);
    const close = openStatisticsPage();
    try {
      await settle();
      // From here the 365-day document carries data the year fetched on open does not.
      getUsageStats.mockImplementation(async (a) =>
        a.query.days === 365 ? ({ today: {}, total: { words: 7 }, series: [] } as never) : ok(a),
      );
      useApp.setState({ usageViewQuery: { range: "365", with: [] } });
      await settle();
      await vi.advanceTimersByTimeAsync(30_000); // a poll on 1 year keeps the view current
      await settle();
      const view = useApp.getState().usageView!;
      expect(view.stats && !view.failed).toBeTruthy();
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      await settle();
      expect(calls().page).toBe(1); // the view only: the polled 1 year view is the year
      expect(useApp.getState().usageYear).toEqual({ sig: view.sig, stats: view.stats });
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: "7" as never, with: [] } });
      await settle();
      expect(calls().page).toBe(1); // the view only: the year is current
      // Back from All onto a miss: the kept year is refetched and marked failed, not shown as current.
      useApp.setState({ usageViewQuery: { range: "all", with: [] } });
      await settle();
      getUsageStats.mockImplementation(async (a) => (page(a) ? (null as never) : ok(a)));
      useApp.setState({ usageViewQuery: { range: "7" as never, with: [] } });
      await settle();
      expect(useApp.getState().usageYear).toEqual({ sig: view.sig, stats: view.stats, failed: true });
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
    }
  });

  it("a reopened 1 year view not yet refetched is no stand-in for the year: coming back fetches it", async () => {
    const ok = getUsageStats.getMockImplementation()!;
    const page = (a: { query: Record<string, unknown> }) => !(a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2);
    let close = openStatisticsPage();
    try {
      useApp.setState({ usageViewQuery: { range: "365", with: [] } });
      await settle();
      close(); // left on 1 year: the kept view is from this (now past) visit
      getUsageStats.mockImplementation((a) => (page(a) ? new Promise<never>(() => {}) : ok(a)));
      close = openStatisticsPage(); // the reopen's view fetch never lands
      await settle();
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      await settle();
      expect(calls().page).toBe(2); // the view AND the year: the kept 1 year view was not confirmed
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
    }
  });

  it("a 1 year view whose last poll missed is no stand-in for the year: coming back fetches it", async () => {
    const ok = getUsageStats.getMockImplementation()!;
    const page = (a: { query: Record<string, unknown> }) => !(a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2);
    const close = openStatisticsPage();
    try {
      await settle();
      useApp.setState({ usageViewQuery: { range: "365", with: [] } });
      await settle();
      await vi.advanceTimersByTimeAsync(30_000); // a poll on 1 year confirms the view
      await settle();
      getUsageStats.mockImplementation(async (a) => (page(a) ? (null as never) : ok(a)));
      await vi.advanceTimersByTimeAsync(30_000); // the next poll misses: the view may now be old
      await settle();
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      await settle();
      expect(calls().page).toBe(2); // the view AND the year: the missed 1 year view was not seeded
      expect(useApp.getState().usageYear?.failed).toBe(true);
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
    }
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
