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
