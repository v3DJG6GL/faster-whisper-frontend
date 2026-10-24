// The usage poll: its cost gates (the Statistics page's documents only while the page is
// open, a hidden main window polling every HIDDEN_EVERY ticks with a catch-up on show), cache
// evictions refetching, and a missed fetch marking kept documents failed instead of current.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { getUsageStats, vis, outcomes } = vi.hoisted(() => ({
  getUsageStats: vi.fn(async (_args: { query: Record<string, unknown> }) => ({ today: {}, total: {}, series: [] })),
  vis: { hidden: false, listeners: new Set<(h: boolean) => void>() },
  // `queued` outcome batches are delivered (counted in `sent`) by the next flush.
  outcomes: { queued: 0, sent: 0 },
}));

vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), isTauri: true, getUsageStats }));
vi.mock("./usageOutcome", () => ({
  initOutcomeQueue: async () => {},
  flushOutcomes: async () => {
    outcomes.sent += outcomes.queued;
    outcomes.queued = 0;
  },
  sentOutcomeCount: () => outcomes.sent,
}));
vi.mock("./windowVisibility", () => ({
  isWindowHidden: () => vis.hidden,
  onWindowHiddenChange: (fn: (h: boolean) => void) => {
    vis.listeners.add(fn);
    return () => vis.listeners.delete(fn);
  },
}));

import { useApp } from "./store";
import { initUsageController, openStatisticsPage, sameViewSource, TREND_DAYS } from "./usage";
import { forgetCredential } from "./capabilities";

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

  it("a tray reopen fetches the page documents once, unless the catch-up pass delivers an outcome", async () => {
    for (const queued of [0, 1]) {
      await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous round left pending
      await settle();
      const close = openStatisticsPage();
      await settle();
      setHidden(true);
      await vi.advanceTimersByTimeAsync(12 * 30_000); // a hidden pass skips the page, two ticks pass over
      await settle();
      outcomes.queued = queued; // a session outcome the catch-up pass's flush delivers
      getUsageStats.mockClear();
      try {
        setHidden(false);
        await settle();
        await settle();
        // The show fetches the view + year at once; the pass refetches them only when an outcome
        // landed after that fetch went out (the documents may not include it).
        expect(calls()).toEqual({ fixed: 1, page: queued ? 4 : 2 });
      } finally {
        setHidden(false);
        close();
      }
    }
  });

  it("a tray reopen whose own page fetch missed leaves the catch-up pass to retry it", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(12 * 30_000);
    await settle();
    getUsageStats.mockClear();
    // The show's direct view + year fetches miss (the network is not back yet); the rest answer.
    getUsageStats.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never);
    try {
      setHidden(false);
      await settle();
      await settle();
      expect(calls()).toEqual({ fixed: 1, page: 4 });
    } finally {
      close();
    }
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

  it("a page mounted around a tray show fetches its documents once, whichever lands first", async () => {
    for (const mountFirst of [false, true]) {
      await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous round left pending
      await settle();
      setHidden(true);
      await vi.advanceTimersByTimeAsync(2 * 30_000); // two ticks passed over, the page closed
      await settle();
      getUsageStats.mockClear();
      let close: (() => void) | undefined;
      try {
        // Tray → Statistics: the show and the navigation land in either order.
        if (mountFirst) close = openStatisticsPage();
        setHidden(false);
        if (!mountFirst) close = openStatisticsPage();
        await settle();
        await settle();
        // The mount's view + year; the catch-up pass takes them instead of refetching.
        expect(calls()).toEqual({ fixed: 1, page: 2 });
      } finally {
        setHidden(false);
        close?.();
      }
    }
  });

  it("a page mounted while hidden a tick before the show is refetched by the catch-up pass", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    getUsageStats.mockClear();
    const close = openStatisticsPage();
    try {
      await settle();
      await vi.advanceTimersByTimeAsync(30_000); // another tick passes over: the mount's fetch ages
      await settle();
      setHidden(false);
      await settle();
      await settle();
      expect(calls()).toEqual({ fixed: 1, page: 4 });
    } finally {
      setHidden(false);
      close();
    }
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
  it("a fetch sent with a rotated-out key does not re-install the old caller's numbers", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    getUsageStats.mockClear();
    const OLD = { today: { words: 111 }, total: {}, series: [] };
    let release!: (v: typeof OLD) => void;
    getUsageStats
      .mockImplementationOnce(() => new Promise((r) => (release = r)) as never)
      .mockResolvedValueOnce(null as never); // the new key cannot read /v1/usage (403)
    await vi.advanceTimersByTimeAsync(30_000); // the tick's fetch, with the old key, hangs
    await settle();
    expect(calls().fixed).toBe(1);
    forgetCredential("b1"); // another user's key saved for the same address
    await vi.advanceTimersByTimeAsync(1_000); // the eviction pass folds into the running one
    await settle();
    release(OLD);
    await settle();
    // The rerun fetched with the new key and missed: nothing of the old caller's is kept.
    expect(calls().fixed).toBe(2);
    expect(useApp.getState().usage.b1).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000); // restore b1's document before the next case
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
  it("a default backend moved while hidden with the page open is fetched on show, not on the next tick", async () => {
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
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    getUsageStats.mockClear();
    // The overlay chip cycles the home profile while the window sits in the tray.
    useApp.setState((s) => ({ settings: { ...s.settings, homeProfileId: "p2" } }));
    await settle();
    expect(getUsageStats).not.toHaveBeenCalled(); // hidden: nothing fetched yet
    setHidden(false); // before any tick was passed over
    await settle();
    const pageCalls = () =>
      getUsageStats.mock.calls
        .map(([a]) => a as { backendId?: string; query: Record<string, unknown> })
        .filter((a) => !(a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2));
    expect(pageCalls().length).toBe(2); // the view + the year
    expect(pageCalls().every((a) => a.backendId === "b2")).toBe(true);
    // With no page open, a hidden move records nothing: the show runs no pass.
    close();
    setHidden(true);
    getUsageStats.mockClear();
    useApp.setState((s) => ({ settings: { ...s.settings, homeProfileId: "p1" } }));
    await settle();
    setHidden(false);
    await settle();
    expect(getUsageStats).not.toHaveBeenCalled();
    useApp.setState((s) => ({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      profiles: [],
      settings: { ...s.settings, homeProfileId: undefined },
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
  });
  it("the show catch-up fetches the page documents at once, not behind a pass stuck on another backend", async () => {
    useApp.setState({
      backends: [
        { id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never,
        { id: "b2", name: "b2", serverUrl: "https://t.example", hasApiKey: false } as never,
      ],
      usageViewBackendId: "b1",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 30_000); // a hidden pass skips the page's documents
    await settle();
    // b2 stops answering its trend document; two more ticks are passed over.
    const ok = getUsageStats.getMockImplementation()!;
    let releaseB2!: (v: null) => void;
    getUsageStats.mockImplementation((a) =>
      (a as { backendId?: string }).backendId === "b2" && a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2
        ? (new Promise((r) => (releaseB2 = r)) as never)
        : ok(a),
    );
    try {
      await vi.advanceTimersByTimeAsync(2 * 30_000);
      await settle();
      getUsageStats.mockClear();
      setHidden(false); // the catch-up pass hangs on b2's trend fetch
      await settle();
      expect(calls()).toEqual({ fixed: 2, page: 2 }); // b1 + the pending b2, and the page's view + year
      expect(useApp.getState().usageView?.failed).toBeFalsy();
      getUsageStats.mockClear();
      releaseB2(null);
      await settle();
      expect(calls().page).toBe(0); // the show already fetched the page and no outcome was delivered since
    } finally {
      releaseB2?.(null); // never leave the pass stuck for the later cases
      await settle();
      getUsageStats.mockImplementation(ok);
      close();
    }
    useApp.setState({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      usageViewBackendId: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
  });
  it("a hide and show before the page step of the pass a show started makes that step refetch the page", async () => {
    useApp.setState({
      backends: [
        { id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never,
        { id: "b2", name: "b2", serverUrl: "https://t.example", hasApiKey: false } as never,
      ],
      usageViewBackendId: "b1",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 30_000); // a hidden pass skips the page's documents
    await settle();
    const ok = getUsageStats.getMockImplementation()!;
    let releaseB2!: (v: null) => void;
    getUsageStats.mockImplementation((a) =>
      (a as { backendId?: string }).backendId === "b2" && a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2
        ? (new Promise((r) => (releaseB2 = r)) as never)
        : ok(a),
    );
    try {
      await vi.advanceTimersByTimeAsync(2 * 30_000); // two ticks passed over: the show starts a pass
      await settle();
      setHidden(false); // the direct fetch, and a catch-up pass that hangs on b2's trend fetch
      await settle();
      setHidden(true); // closed to the tray again: the direct fetch may be old by the next show
      await settle();
      setHidden(false); // nothing passed over and no page missed, so no fetch of its own
      await settle();
      getUsageStats.mockClear();
      releaseB2(null);
      await settle();
      await settle();
      expect(calls().page).toBe(2); // the pass's page step refetches the view + year
    } finally {
      releaseB2?.(null); // never leave the pass stuck for the later cases
      await settle();
      getUsageStats.mockImplementation(ok);
      setHidden(false);
      close();
    }
    useApp.setState({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      usageViewBackendId: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
  });
  it("a show while a hidden pass is running hands it the direct fetch: its page step does not refetch", async () => {
    const isTrend = (a: { query: Record<string, unknown> }) => a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2;
    // skipped 0: the show only fetches the page (no pass of its own); 2: it also folds a rerun,
    // which fetches the page as usual.
    for (const skipped of [0, 2]) {
      useApp.setState({
        backends: [
          { id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never,
          { id: "b2", name: "b2", serverUrl: "https://t.example", hasApiKey: false } as never,
        ],
        usageViewBackendId: "b1",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      const close = openStatisticsPage();
      await settle();
      setHidden(true);
      await vi.advanceTimersByTimeAsync(10 * 30_000); // a hidden pass skips the page's documents
      await settle();
      const ok = getUsageStats.getMockImplementation()!;
      let releaseB2!: (v: null) => void;
      getUsageStats.mockImplementation((a) =>
        (a as { backendId?: string }).backendId === "b2" && isTrend(a) ? (new Promise((r) => (releaseB2 = r)) as never) : ok(a),
      );
      try {
        await vi.advanceTimersByTimeAsync(10 * 30_000); // the next hidden pass hangs on b2's trend fetch
        await settle();
        await vi.advanceTimersByTimeAsync(skipped * 30_000);
        await settle();
        getUsageStats.mockImplementation(ok);
        getUsageStats.mockClear();
        setHidden(false);
        await settle();
        expect(calls().page).toBe(2); // the show's direct view + year
        getUsageStats.mockClear();
        releaseB2(null);
        await settle();
        await settle();
        // The held pass's page step takes the confirmed direct fetch; only a folded rerun refetches.
        expect(calls().page).toBe(skipped ? 2 : 0);
      } finally {
        releaseB2?.(null);
        await settle();
        getUsageStats.mockImplementation(ok);
        setHidden(false);
        close();
      }
      useApp.setState({
        backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
        usageViewBackendId: null,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
    }
  });
  it("the catch-up pass fetches the picked backend's page when its trend fetch brings it back during the pass", async () => {
    const isTrend = (a: { query: Record<string, unknown> }) => a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2;
    const ok = getUsageStats.getMockImplementation()!;
    // b2 — the user's pick — is down: no usage, so the page falls back to b1.
    getUsageStats.mockImplementation((a) => ((a as { backendId?: string }).backendId === "b2" && isTrend(a) ? (Promise.resolve(null) as never) : ok(a)));
    useApp.setState((s) => {
      const usage = { ...s.usage };
      delete usage.b2;
      return {
        backends: [
          { id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never,
          { id: "b2", name: "b2", serverUrl: "https://t.example", hasApiKey: false } as never,
        ],
        usage,
        usageViewBackendId: "b2",
      };
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const close = openStatisticsPage();
    try {
      await settle();
      setHidden(true);
      await vi.advanceTimersByTimeAsync(12 * 30_000); // a hidden pass skips the page, two ticks pass over
      await settle();
      getUsageStats.mockImplementation(ok); // b2 is back
      getUsageStats.mockClear();
      setHidden(false); // the show confirms b1's page; the pass then brings b2's usage in
      await settle();
      await settle();
      const page = getUsageStats.mock.calls.map(([a]) => a as { backendId?: string; query: Record<string, unknown> }).filter((a) => !isTrend(a));
      expect(page.filter((a) => a.backendId === "b2").length).toBe(2); // b2's view + year, not left to the next tick
      expect(useApp.getState().usageView?.sig).toContain('"b2"');
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
    }
    useApp.setState({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      usageViewBackendId: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
  });
  it("the catch-up pass refetches the page when a range change's fetch missed after the show's direct fetch landed", async () => {
    const isTrend = (a: { query: Record<string, unknown> }) => a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2;
    useApp.setState({
      backends: [
        { id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never,
        { id: "b2", name: "b2", serverUrl: "https://t.example", hasApiKey: false } as never,
      ],
      usageViewBackendId: "b1",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const close = openStatisticsPage();
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 30_000); // a hidden pass skips the page's documents
    await settle();
    const ok = getUsageStats.getMockImplementation()!;
    let releaseB2!: (v: null) => void;
    getUsageStats.mockImplementation((a) =>
      (a as { backendId?: string }).backendId === "b2" && isTrend(a) ? (new Promise((r) => (releaseB2 = r)) as never) : ok(a),
    );
    try {
      await vi.advanceTimersByTimeAsync(2 * 30_000);
      await settle();
      setHidden(false); // the direct fetch lands; the catch-up pass hangs on b2's trend fetch
      await settle();
      // A range change whose view fetch misses: the page no longer answers what is asked.
      getUsageStats.mockImplementation((a) => (isTrend(a) ? ok(a) : (Promise.resolve(null) as never)));
      useApp.setState({ usageViewQuery: { range: "7" as never, with: [] } });
      await settle();
      expect(useApp.getState().usageView?.failed).toBe(true);
      getUsageStats.mockImplementation(ok);
      getUsageStats.mockClear();
      releaseB2(null);
      await settle();
      await settle();
      expect(calls().page).toBe(2); // the pass refetches the view + year instead of trusting the show's answer
      expect(useApp.getState().usageView?.failed).toBeFalsy();
    } finally {
      releaseB2?.(null);
      await settle();
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
    }
    useApp.setState({
      backends: [{ id: "b1", name: "b1", serverUrl: "https://s.example", hasApiKey: false } as never],
      usageViewBackendId: null,
    });
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

  it("switching back to the last visit's query before the reopen fetch lands marks its kept documents failed on a miss", async () => {
    const ok = getUsageStats.getMockImplementation()!;
    const page = (a: { query: Record<string, unknown> }) => !(a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2);
    const last = { range: "7", with: ["vad"] } as const;
    let close = openStatisticsPage();
    try {
      useApp.setState({ usageViewQuery: { range: last.range, with: [...last.with] } });
      await settle();
      close(); // the last visit ends on 7 days + vad: its view and year stay in the store
      const { usageView, usageYear } = useApp.getState();
      expect(usageView?.stats && !usageView.failed).toBeTruthy();
      expect(usageYear?.stats && !usageYear.failed).toBeTruthy();
      // The sidebar reopens on the default query; the server hangs, then misses.
      const pending: ((v: null) => void)[] = [];
      getUsageStats.mockImplementation((a) => (page(a) ? new Promise<never>((r) => pending.push(r as never)) : ok(a)));
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      close = openStatisticsPage();
      await settle();
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: last.range, with: [...last.with] } });
      await settle();
      expect(calls().page).toBe(2); // the view AND the year: the kept year was never confirmed this visit
      pending.splice(0).forEach((r) => r(null));
      await settle();
      expect(useApp.getState().usageView).toEqual({ sig: usageView!.sig, stats: usageView!.stats, failed: true });
      expect(useApp.getState().usageYear).toEqual({ sig: usageYear!.sig, stats: usageYear!.stats, failed: true });
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      await settle();
    }
  });

  it("switching back to the last visit's query while only the reopen's year fetch is out refetches the kept year", async () => {
    const ok = getUsageStats.getMockImplementation()!;
    const last = { range: "7", with: ["vad"] } as const;
    const pending: ((v: null) => void)[] = [];
    let close = openStatisticsPage();
    try {
      useApp.setState({ usageViewQuery: { range: last.range, with: [...last.with] } });
      await settle();
      close(); // the last visit ends on 7 days + vad: its year stays in the store
      const { usageYear } = useApp.getState();
      expect(usageYear?.stats && !usageYear.failed).toBeTruthy();
      // The sidebar reopens on the default query: the view answers, the 365-day fetch hangs.
      getUsageStats.mockImplementation((a) => (a.query.days === 365 ? new Promise<never>((r) => pending.push(r as never)) : ok(a)));
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      close = openStatisticsPage();
      await settle();
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: last.range, with: [...last.with] } });
      await settle();
      expect(calls().page).toBe(2); // the view AND the year: the view's confirmation is not the year's
      pending.splice(0).forEach((r) => r(null));
      await settle();
      expect(useApp.getState().usageYear).toEqual({ sig: usageYear!.sig, stats: usageYear!.stats, failed: true });
    } finally {
      pending.splice(0).forEach((r) => r(null));
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      await settle();
    }
  });

  it("a poll that missed only the view leaves the year it confirmed reused by a range change, not refetched or failed", async () => {
    const ok = getUsageStats.getMockImplementation()!;
    const page = (a: { query: Record<string, unknown> }) => !(a.query.days === TREND_DAYS && Object.keys(a.query).length <= 2);
    const close = openStatisticsPage();
    try {
      await settle();
      await vi.advanceTimersByTimeAsync(30_000); // a poll confirms the view and the year
      await settle();
      getUsageStats.mockImplementation(async (a) => (a.query.days === 90 ? (null as never) : ok(a)));
      await vi.advanceTimersByTimeAsync(30_000); // the next poll misses the view only
      await settle();
      const { usageYear } = useApp.getState();
      expect(usageYear?.stats && !usageYear.failed).toBeTruthy();
      getUsageStats.mockImplementation(async (a) => (page(a) ? (null as never) : ok(a)));
      getUsageStats.mockClear();
      useApp.setState({ usageViewQuery: { range: "7" as never, with: [] } });
      await settle();
      expect(calls().page).toBe(1); // the view only: the year was confirmed this visit
      expect(useApp.getState().usageYear).toBe(usageYear);
    } finally {
      getUsageStats.mockImplementation(ok);
      close();
      useApp.setState({ usageViewQuery: { range: "90", with: [] } });
      await settle();
    }
  });

  it("a backend set to Standard clears its kept numbers once, instead of freezing them", async () => {
    await vi.advanceTimersByTimeAsync(30_000); // settle any pass the previous case left pending
    await settle();
    const doc = { today: { words: 12 }, total: {}, series: [] } as never;
    useApp.setState((s) => ({ usage: { ...s.usage, b1: doc } }));
    const before = useApp.getState().backends;
    try {
      useApp.setState({ backends: before.map((b) => ({ ...b, kind: "standard" as const })) }); // a server-type edit: a pass now
      await settle();
      expect(useApp.getState().usage.b1).toBeNull();
      const setUsage = vi.spyOn(useApp.getState(), "setUsage");
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(setUsage).not.toHaveBeenCalled(); // already null: no per-poll churn
      setUsage.mockRestore();
    } finally {
      useApp.setState({ backends: before });
      await settle();
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
