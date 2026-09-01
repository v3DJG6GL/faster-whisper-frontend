import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE,
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

  it("verdicts: 2xx sent, 0/5xx/408/429 retry, other 4xx drop", () => {
    expect(verdictFor({ ok: true, status: 200 })).toBe("sent");
    expect(verdictFor({ ok: false, status: 0 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 503 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 408 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 429 })).toBe("retry");
    expect(verdictFor({ ok: false, status: 401 })).toBe("drop");
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
