import { describe, expect, it, vi } from "vitest";

// The runtime flush posts through these; the pure state machine below never touches them.
const post = vi.hoisted(() => ({
  release: [] as (() => void)[],
  saves: [] as unknown[],
  // When set, a save stays pending until `saveRelease` runs it out.
  holdSaves: false,
  saveRelease: [] as (() => void)[],
}));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  isTauri: true,
  saveUsageOutcomes: (q: unknown) => {
    post.saves.push(q);
    return post.holdSaves ? new Promise<void>((res) => post.saveRelease.push(res)) : Promise.resolve();
  },
  postUsageOutcomes: () => new Promise((res) => post.release.push(() => res({ ok: true, status: 200 }))),
}));
vi.mock("./store", () => ({ useApp: { getState: () => ({ configLoaded: false, configLoadFailed: false, backends: [] }) } }));

import {
  EMPTY_QUEUE,
  enqueueOutcome,
  flushOutcomeSave,
  flushOutcomes,
  applyPost,
  backoffMs,
  enqueue,
  nextBatch,
  parseQueue,
  pruneQueue,
  verdictFor,
  MAX_AGE_MS,
  BATCH_MAX,
} from "./usageOutcome";
import type { UsageOutcome } from "./types";

const oc = (id: string, extra: Partial<UsageOutcome> = {}): UsageOutcome => ({
  job_id: id,
  activation: "hold",
  delivery: "typed",
  translation: "not_asked",
  ...extra,
});
const hex = (n: number) => n.toString(16).padStart(32, "0");

describe("usage outcome queue", () => {
  it("enqueues with attempts 0 and due immediately; a re-enqueue by job_id replaces", () => {
    let q = enqueue(EMPTY_QUEUE, { backendId: "b", serverUrl: "u", outcome: oc(hex(1)) }, 1000);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ attempts: 0, nextAt: 1000, queuedAt: 1000 });
    q = enqueue(q, { backendId: "b", serverUrl: "u", outcome: oc(hex(1), { delivery: "none" }) }, 2000);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].outcome.delivery).toBe("none");
  });

  it("drops an app_id cut mid surrogate pair (serde_json would reject the whole batch)", () => {
    const cut = "a".repeat(63) + "\u{1F600}".slice(0, 1);
    let q = enqueue(EMPTY_QUEUE, { backendId: "b", serverUrl: "u", outcome: oc(hex(1), { app_id: cut }) }, 1000);
    expect(q.items[0].outcome).not.toHaveProperty("app_id");
    q = enqueue(q, { backendId: "b", serverUrl: "u", outcome: oc(hex(2), { app_id: "chat \u{1F600}" }) }, 1000);
    expect(q.items[1].outcome.app_id).toBe("chat \u{1F600}");
    const parsed = parseQueue({ version: 1, items: [{ backendId: "b", serverUrl: "u", outcome: oc(hex(3), { app_id: cut }) }] });
    expect(parsed.items[0].outcome.app_id).toBeUndefined();
  });

  it("batches only due items of one backend + address, in order, up to the ceiling", () => {
    let q = EMPTY_QUEUE;
    for (let i = 0; i < BATCH_MAX + 5; i++) {
      q = enqueue(q, { backendId: "a", serverUrl: "u", outcome: oc(hex(i)) }, i);
    }
    q = enqueue(q, { backendId: "b", serverUrl: "u", outcome: oc(hex(500)) }, 0);
    // The cap keeps the newest 200; the first due item is the oldest kept.
    const batch = nextBatch(q, 10_000);
    expect(batch).not.toBeNull();
    expect(batch!.backendId).toBe("a");
    expect(batch!.items.length).toBe(BATCH_MAX);
    expect(batch!.items.every((x) => x.backendId === "a")).toBe(true);
    // Nothing due → null.
    const later = applyPost(q, q.items.map((x) => x.outcome.job_id), "retry", 10_000);
    expect(nextBatch(later, 10_001)).toBeNull();
  });

  it("verdicts: 2xx sent, 0/5xx/401/403/408/429 retry, other 4xx drop", () => {
    expect(verdictFor({ ok: true, status: 200 })).toBe("sent");
    expect(verdictFor({ ok: false, status: 0 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 503 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 408 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 429 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 401 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 403 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 404 })).toBe("drop");
    expect(verdictFor({ ok: false, status: 422 })).toBe("drop");
  });

  it("applyPost: sent/drop remove, retry backs off exponentially", () => {
    let q = enqueue(EMPTY_QUEUE, { backendId: "b", serverUrl: "u", outcome: oc(hex(1)) }, 0);
    q = enqueue(q, { backendId: "b", serverUrl: "u", outcome: oc(hex(2)) }, 0);
    const r1 = applyPost(q, [hex(1)], "retry", 1000);
    expect(r1.items[0]).toMatchObject({ attempts: 1, nextAt: 1000 + backoffMs(1) });
    const r2 = applyPost(r1, [hex(1)], "retry", 5000);
    expect(r2.items[0]).toMatchObject({ attempts: 2, nextAt: 5000 + backoffMs(2) });
    expect(backoffMs(2)).toBe(backoffMs(1) * 2);
    expect(backoffMs(40)).toBe(6 * 3_600_000);
    expect(applyPost(q, [hex(1)], "sent", 0).items.map((x) => x.outcome.job_id)).toEqual([hex(2)]);
    expect(applyPost(q, [hex(1), hex(2)], "drop", 0).items).toHaveLength(0);
  });

  it("prunes items older than 7 days", () => {
    const q = enqueue(EMPTY_QUEUE, { backendId: "b", serverUrl: "u", outcome: oc(hex(1)) }, 0);
    expect(pruneQueue(q, MAX_AGE_MS).items).toHaveLength(1);
    expect(pruneQueue(q, MAX_AGE_MS + 1).items).toHaveLength(0);
  });

  it("parseQueue validates item-wise and tolerates garbage", () => {
    expect(parseQueue(null)).toEqual(EMPTY_QUEUE);
    expect(parseQueue([])).toEqual(EMPTY_QUEUE);
    expect(parseQueue({ items: "x" })).toEqual(EMPTY_QUEUE);
    const parsed = parseQueue({
      version: 1,
      items: [
        { backendId: "b", serverUrl: "u", outcome: oc(hex(1), { app_id: "thunderbird" }), queuedAt: 5, attempts: 2, nextAt: 9 },
        { backendId: "b", serverUrl: "u", outcome: oc("not-hex!") },
        { backendId: "b", serverUrl: "u", outcome: { ...oc(hex(3)), delivery: "teleport" } },
        { backendId: "b", serverUrl: "u", outcome: oc(hex(4), { app_id: "" }), queuedAt: "soon" },
        "junk",
      ],
    });
    expect(parsed.items.map((x) => x.outcome.job_id)).toEqual([hex(1), hex(4)]);
    expect(parsed.items[0]).toMatchObject({ queuedAt: 5, attempts: 2, nextAt: 9 });
    expect(parsed.items[0].outcome.app_id).toBe("thunderbird");
    expect(parsed.items[1].outcome.app_id).toBeUndefined();
    expect(parsed.items[1].queuedAt).toBe(0);
  });
});

describe("flushOutcomes", () => {
  it("a flush asked for mid-pass waits for the running post (refreshAll's ordering)", async () => {
    enqueueOutcome("b", "u", oc(hex(1))); // starts the pass; its post hangs
    expect(post.release).toHaveLength(1);
    let done = false;
    const second = flushOutcomes().then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    post.release.shift()!();
    await second;
    expect(done).toBe(true);
    expect(post.release).toHaveLength(0); // the extra pass found nothing left to post
  });
});

// A real exit never fires beforeunload: the quit handshake has to land the 300 ms debounced
// save itself, or a session enqueued just before Quit never reaches the on-disk retry backlog.
describe("flushOutcomeSave", () => {
  it("lands a pending debounced save now, once", async () => {
    await flushOutcomeSave(); // drain a timer an earlier test left armed
    vi.useFakeTimers();
    try {
      const before = post.saves.length;
      enqueueOutcome("b", "u", oc(hex(2)));
      expect(post.saves).toHaveLength(before); // still in its debounce
      await flushOutcomeSave();
      expect(post.saves).toHaveLength(before + 1);
      expect((post.saves[post.saves.length - 1] as { items: { outcome: UsageOutcome }[] }).items.map((i) => i.outcome.job_id)).toContain(hex(2));
      await flushOutcomeSave(); // nothing pending any more
      vi.advanceTimersByTime(1000); // and the debounce was consumed
      expect(post.saves).toHaveLength(before + 1);
    } finally {
      vi.useRealTimers();
      while (post.release.length) post.release.shift()!();
    }
  });

  it("waits for a save the debounce already started", async () => {
    await flushOutcomeSave();
    vi.useFakeTimers();
    post.holdSaves = true;
    try {
      const before = post.saves.length;
      enqueueOutcome("b", "u", oc(hex(3)));
      vi.advanceTimersByTime(300); // the timer fires; its save is still in flight
      expect(post.saves).toHaveLength(before + 1);
      let landed = false;
      const flushed = flushOutcomeSave().then(() => {
        landed = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(landed).toBe(false);
      expect(post.saves).toHaveLength(before + 1); // awaited, not re-written
      while (post.saveRelease.length) post.saveRelease.shift()!();
      await flushed;
      expect(landed).toBe(true);
    } finally {
      post.holdSaves = false;
      while (post.saveRelease.length) post.saveRelease.shift()!();
      vi.useRealTimers();
      while (post.release.length) post.release.shift()!();
    }
  });
});
