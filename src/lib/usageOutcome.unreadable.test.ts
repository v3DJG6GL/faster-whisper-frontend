// The outcome queue file exists but can't be read (a Windows AV lock at launch): no save may
// replace its backlog of unposted outcomes with this session's queue.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageOutcome } from "./types";

const loadUsageOutcomes = vi.fn<() => Promise<unknown>>();
const saveUsageOutcomes = vi.fn<(q: unknown) => Promise<void>>(() => Promise.resolve());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  isTauri: true,
  loadUsageOutcomes: () => loadUsageOutcomes(),
  saveUsageOutcomes: (q: unknown) => saveUsageOutcomes(q),
  // Posts never land, so every queued outcome stays in the queue that is saved.
  postUsageOutcomes: () => new Promise(() => {}),
}));
vi.mock("./store", () => ({ useApp: { getState: () => ({ configLoaded: false, configLoadFailed: false, backends: [] }) } }));
vi.mock("./persistence", () => ({ configReady: Promise.resolve() }));

const OLD = "a".repeat(32);
const MINE = "b".repeat(32);

const oc = (job_id: string): UsageOutcome => ({
  job_id,
  activation: "hold",
  delivery: "typed",
  translation: "not_asked",
});

beforeEach(() => {
  vi.resetModules(); // a fresh, unloaded queue per test
  loadUsageOutcomes.mockReset();
  saveUsageOutcomes.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("an unreadable outcome queue file", () => {
  it("is not saved over while it still can't be read", async () => {
    const { enqueueOutcome, flushOutcomeSave, initOutcomeQueue } = await import("./usageOutcome");
    loadUsageOutcomes.mockRejectedValue("usage outcome queue unreadable: Permission denied");
    await initOutcomeQueue();
    enqueueOutcome("b", "u", oc(MINE));
    await flushOutcomeSave();
    expect(saveUsageOutcomes).not.toHaveBeenCalled();
  });

  it("is read again on the next save, and its backlog is kept beside this session's", async () => {
    const { enqueueOutcome, flushOutcomeSave, initOutcomeQueue } = await import("./usageOutcome");
    loadUsageOutcomes.mockRejectedValueOnce("usage outcome queue unreadable: Permission denied");
    await initOutcomeQueue();
    const now = Date.now();
    loadUsageOutcomes.mockResolvedValue({
      version: 1,
      items: [{ backendId: "b", serverUrl: "u", outcome: oc(OLD), queuedAt: now, attempts: 1, nextAt: now + 60_000 }],
    });
    enqueueOutcome("b", "u", oc(MINE));
    await flushOutcomeSave();
    expect(saveUsageOutcomes).toHaveBeenCalledTimes(1);
    const saved = saveUsageOutcomes.mock.calls[0][0] as { items: { outcome: UsageOutcome }[] };
    expect(saved.items.map((i) => i.outcome.job_id)).toEqual([OLD, MINE]);
  });
});

describe("a backlog read late", () => {
  const hex = (i: number) => i.toString(16).padStart(32, "0");
  const item = (i: number, now: number) => ({ backendId: "b", serverUrl: "u", outcome: oc(hex(i)), queuedAt: now, attempts: 1, nextAt: now + 60_000 });

  it("is merged within the item bound, keeping this session's newest outcomes", async () => {
    const { enqueueOutcome, flushOutcomeSave, initOutcomeQueue } = await import("./usageOutcome");
    loadUsageOutcomes.mockRejectedValueOnce("usage outcome queue unreadable: Permission denied");
    await initOutcomeQueue();
    const now = Date.now();
    loadUsageOutcomes.mockResolvedValue({ version: 1, items: Array.from({ length: 150 }, (_, i) => item(i, now)) });
    for (let i = 1000; i < 1100; i++) enqueueOutcome("b", "u", oc(hex(i)));
    await flushOutcomeSave();
    const saved = saveUsageOutcomes.mock.calls[0][0] as { items: { outcome: UsageOutcome }[] };
    const ids = saved.items.map((i) => i.outcome.job_id);
    expect(ids).toHaveLength(200);
    expect(ids.slice(-100)).toEqual(Array.from({ length: 100 }, (_, i) => hex(1000 + i)));
    expect(ids[0]).toBe(hex(50)); // the oldest backlog items went
  });

  it("an oversize file keeps its newest 200 items", async () => {
    const { parseQueue } = await import("./usageOutcome");
    const now = Date.now();
    const q = parseQueue({ version: 1, items: Array.from({ length: 250 }, (_, i) => item(i, now)) });
    expect(q.items).toHaveLength(200);
    expect(q.items[0].outcome.job_id).toBe(hex(50));
    expect(q.items[199].outcome.job_id).toBe(hex(249));
  });
});
