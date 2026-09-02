// The usage-outcome queue: what only the client knows about a dictation session —
// how it was activated, how the text landed, the translation outcome, the app it
// was typed into — posted to `POST /v1/usage/outcome` after settle. The server has
// words and audio seconds from its own utterance rows, so none of that rides here.
//
// Delivery is at-least-once with the server deduplicating by `job_id` (a retry is a
// `duplicate`, which counts as success). The queue is persisted through Rust
// (`usage-outcomes.json`) so a session that ends while the server is down still
// lands on the next poll after it comes back — or after an app restart. Flushed on
// enqueue, on the 30 s usage poll (lib/usage.ts) and at launch.
//
// The state machine (`enqueue` / `nextBatch` / `verdictFor` / `applyPost` /
// `pruneQueue`) is pure and unit-tested; the runtime wrapper at the bottom owns the
// singleton queue, the debounced save and the flush loop.

import { isTauri, loadUsageOutcomes, postUsageOutcomes, saveUsageOutcomes } from "./api";
import { useApp } from "./store";
import type { UsageOutcome } from "./types";

export interface QueuedOutcome {
  backendId: string;
  /** The address the session actually talked to (per-device override applied). */
  serverUrl: string;
  outcome: UsageOutcome;
  queuedAt: number;
  attempts: number;
  /** Earliest time (ms epoch) the next attempt may run. */
  nextAt: number;
}

export interface OutcomeQueue {
  version: 1;
  items: QueuedOutcome[];
}

export const EMPTY_QUEUE: OutcomeQueue = { version: 1, items: [] };

/** Server batch ceiling (`≤100 items`). */
export const BATCH_MAX = 100;
/** An outcome older than this is dropped unposted: the server has already marked the
 *  job "unreported" (24 h) and the row is only noise by then. */
export const MAX_AGE_MS = 7 * 86_400_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
/** Bound on queued items — 64 KiB on disk, and a stuck server must not grow it forever. */
const MAX_ITEMS = 200;

/** Exponential backoff: 30 s, 1 m, 2 m, … capped at 6 h. */
export function backoffMs(attempts: number): number {
  const a = Math.max(1, Math.floor(attempts));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (a - 1));
}

/** Append (or replace by `job_id` — a session reports exactly once, so a second enqueue
 *  for the same id is a correction, not a duplicate). Oldest items fall off past the cap. */
export function enqueue(
  q: OutcomeQueue,
  item: { backendId: string; serverUrl: string; outcome: UsageOutcome },
  now: number,
): OutcomeQueue {
  const items = q.items.filter((x) => x.outcome.job_id !== item.outcome.job_id);
  items.push({ ...item, queuedAt: now, attempts: 0, nextAt: now });
  return { version: 1, items: items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items };
}

/** Drop what is too old to be worth posting. */
export function pruneQueue(q: OutcomeQueue, now: number): OutcomeQueue {
  const items = q.items.filter((x) => now - x.queuedAt <= MAX_AGE_MS);
  return items.length === q.items.length ? q : { version: 1, items };
}

/** The next batch to post: every due item sharing the FIRST due item's backend + address,
 *  in queue order, up to the server's ceiling. Null when nothing is due. */
export function nextBatch(
  q: OutcomeQueue,
  now: number,
): { backendId: string; serverUrl: string; items: QueuedOutcome[] } | null {
  const head = q.items.find((x) => x.nextAt <= now);
  if (!head) return null;
  const items = q.items
    .filter((x) => x.nextAt <= now && x.backendId === head.backendId && x.serverUrl === head.serverUrl)
    .slice(0, BATCH_MAX);
  return { backendId: head.backendId, serverUrl: head.serverUrl, items };
}

export type PostVerdict = "sent" | "retry" | "drop";

/** What a post result means for the batch: a 2xx is delivered (`duplicate` included — the
 *  server already has it); unreachable (0), 5xx, 408 and 429 are transient → retry with
 *  backoff; any other 4xx is a request the server will refuse every time → drop. */
export function verdictFor(r: { ok: boolean; status: number }): PostVerdict {
  if (r.ok) return "sent";
  const s = r.status;
  if (s === 0 || s >= 500 || s === 408 || s === 429) return "retry";
  if (s >= 400) return "drop";
  return "retry";
}

/** Apply a verdict to the posted `jobIds`: sent/drop remove them, retry bumps the attempt
 *  count and pushes `nextAt` out by the backoff. */
export function applyPost(q: OutcomeQueue, jobIds: string[], verdict: PostVerdict, now: number): OutcomeQueue {
  const ids = new Set(jobIds);
  if (verdict !== "retry") {
    return { version: 1, items: q.items.filter((x) => !ids.has(x.outcome.job_id)) };
  }
  return {
    version: 1,
    items: q.items.map((x) =>
      ids.has(x.outcome.job_id)
        ? { ...x, attempts: x.attempts + 1, nextAt: now + backoffMs(x.attempts + 1) }
        : x,
    ),
  };
}

const JOB_ID = /^[0-9a-f]{8,64}$/;
const ACTIVATIONS = new Set(["hold", "handsfree"]);
const DELIVERIES = new Set(["typed", "clipboard", "none"]);
const TRANSLATIONS = new Set(["translated", "kept_original", "not_asked", "aborted"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a queue document off disk. Anything malformed is dropped item-wise; a document
 *  that is not a queue at all yields the empty queue. */
export function parseQueue(raw: unknown): OutcomeQueue {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return EMPTY_QUEUE;
  const items: QueuedOutcome[] = [];
  for (const it of raw.items) {
    if (!isRecord(it) || !isRecord(it.outcome)) continue;
    const o = it.outcome;
    if (
      typeof it.backendId !== "string" ||
      typeof it.serverUrl !== "string" ||
      typeof o.job_id !== "string" ||
      !JOB_ID.test(o.job_id) ||
      typeof o.activation !== "string" ||
      !ACTIVATIONS.has(o.activation) ||
      typeof o.delivery !== "string" ||
      !DELIVERIES.has(o.delivery) ||
      typeof o.translation !== "string" ||
      !TRANSLATIONS.has(o.translation)
    ) {
      continue;
    }
    const outcome: UsageOutcome = {
      job_id: o.job_id,
      activation: o.activation as UsageOutcome["activation"],
      delivery: o.delivery as UsageOutcome["delivery"],
      translation: o.translation as UsageOutcome["translation"],
    };
    if (typeof o.app_id === "string" && o.app_id.length > 0 && o.app_id.length <= 64) outcome.app_id = o.app_id;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    items.push({
      backendId: it.backendId,
      serverUrl: it.serverUrl,
      outcome,
      queuedAt: num(it.queuedAt, 0),
      attempts: Math.max(0, Math.floor(num(it.attempts, 0))),
      nextAt: num(it.nextAt, 0),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return { version: 1, items };
}

/* ── runtime (main window only) ─────────────────────────────────────────── */

let queue: OutcomeQueue = EMPTY_QUEUE;
let loaded = false;
let flushing = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let flushAgain = false;

/** Debounced persist — an enqueue and the flush that follows it a moment later would
 *  otherwise write the file twice. */
function persist(): void {
  if (!isTauri) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void saveUsageOutcomes(queue).catch((e) => console.error("usage outcome queue save failed:", e));
  }, 300);
}

/** Load the persisted queue (once) and post whatever is due. */
export async function initOutcomeQueue(): Promise<void> {
  if (!isTauri || loaded) return;
  loaded = true;
  try {
    const persisted = pruneQueue(parseQueue(await loadUsageOutcomes()), Date.now());
    queue = { ...persisted, items: [...persisted.items, ...queue.items] };
  } catch (e) {
    console.error("usage outcome queue load failed:", e);
  }
  await flushOutcomes();
}

/** Queue one session's outcome and try to post it right away. */
export function enqueueOutcome(backendId: string, serverUrl: string, outcome: UsageOutcome): void {
  if (!isTauri) return;
  queue = enqueue(queue, { backendId, serverUrl, outcome }, Date.now());
  persist();
  void flushOutcomes();
}

/** Post every due batch. One in-flight flush at a time; a request that arrives meanwhile
 *  runs one more pass afterwards. A transient failure stops the pass (the backoff decides
 *  when that server is tried again) — the next poll picks it up. */
export async function flushOutcomes(): Promise<void> {
  if (!isTauri) return;
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const now = Date.now();
        queue = pruneQueue(queue, now);
        const batch = nextBatch(queue, now);
        if (!batch) break;
        const ids = batch.items.map((x) => x.outcome.job_id);
        // A backend the user removed can no longer be authenticated (its key left the
        // keyring with it): its outcomes have nowhere to go.  Guard on configLoaded so
        // the empty boot-time list doesn't look like "all backends removed."
        const st = useApp.getState();
        if (st.configLoaded && !st.backends.some((b) => b.id === batch.backendId)) {
          queue = applyPost(queue, ids, "drop", now);
          persist();
          continue;
        }
        let verdict: PostVerdict;
        try {
          const r = await postUsageOutcomes({
            serverUrl: batch.serverUrl,
            backendId: batch.backendId,
            outcomes: batch.items.map((x) => x.outcome),
          });
          verdict = verdictFor(r);
        } catch {
          verdict = "retry";
        }
        queue = applyPost(queue, ids, verdict, Date.now());
        persist();
        if (verdict === "retry") break;
      }
    } while (flushAgain);
  } finally {
    flushing = false;
  }
}


