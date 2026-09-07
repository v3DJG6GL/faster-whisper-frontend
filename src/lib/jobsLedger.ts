// The in-flight jobs ledger: which server job ids the app has posted and not ingested
// yet, with everything the pump had in hand when it posted them — so a run survives
// the app being quit mid-flight. A row is written BEFORE the request leaves (the
// server's row and ours share the client-minted id) and removed once the result was
// ingested or the run settled as failed/cancelled. At launch `lib/jobsReconcile.ts`
// asks the server about every row still here.
//
// The row carries the RESOLVED run context and options verbatim, not the settings they
// came from: decode overrides, the override profile and the capability gates are
// transient screen state that cannot be re-derived after a restart.
//
// Persisted through Rust (`jobs-ledger.json`, opaque there). The pure half
// (`parseLedger` / `pruneLedger` / `addRow` / `removeRow`) is unit-tested; the runtime
// wrapper at the bottom owns the singleton and the awaited save.

import { isTauri, loadJobsLedger, saveJobsLedger } from "./api";
import type { RunContext, TranscribeRunState } from "./transcribeRun";
import type { DecodeOverrides, TranscribeOptions } from "./types";

export interface LedgerRow {
  v: 1;
  /** The client-minted progress id = the server's job id (8..64 hex). */
  jobId: string;
  backendId: string;
  /** The address the run actually talked to (per-device override applied). */
  serverUrl: string;
  /** The queue key: a file path or a media URL. */
  path: string;
  kind: "file" | "url";
  title?: string;
  options?: TranscribeOptions;
  ctx: RunContext;
  urlMeta?: TranscribeRunState["urlMeta"][string];
  overrides?: DecodeOverrides;
  /** ms epoch the request left. */
  startedAt: number;
}

export interface Ledger {
  v: 1;
  rows: LedgerRow[];
}

export const EMPTY_LEDGER: Ledger = { v: 1, rows: [] };

/** Bound on rows — a run per file, so a big multi-file drop is the realistic ceiling. */
export const MAX_ROWS = 20;
/** A row older than the server's 72 h TTL (plus slack) names a job the server has
 *  already swept — nothing to ask about. */
export const MAX_AGE_MS = 73 * 3_600_000;

const JOB_ID_RE = /^[0-9a-f]{8,64}$/;

function isRow(v: unknown): v is LedgerRow {
  const r = v as LedgerRow;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.jobId === "string" &&
    JOB_ID_RE.test(r.jobId) &&
    typeof r.backendId === "string" &&
    typeof r.serverUrl === "string" &&
    typeof r.path === "string" &&
    (r.kind === "file" || r.kind === "url") &&
    !!r.ctx &&
    typeof r.ctx === "object" &&
    typeof r.ctx.serverUrl === "string" &&
    typeof r.startedAt === "number" &&
    Number.isFinite(r.startedAt)
  );
}

/** Defensive parse of the on-disk document: malformed rows (hand-edited, a foreign
 *  build) are dropped one by one, never the whole ledger. */
export function parseLedger(raw: unknown): Ledger {
  const doc = raw as Partial<Ledger> | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.rows)) return EMPTY_LEDGER;
  const rows = doc.rows.filter(isRow);
  return { v: 1, rows };
}

/** Drop rows the server cannot still know about. */
export function pruneLedger(l: Ledger, now: number): Ledger {
  const rows = l.rows.filter((r) => now - r.startedAt <= MAX_AGE_MS);
  return rows.length === l.rows.length ? l : { v: 1, rows };
}

/** Append (replacing a row of the same id), prune, keep the newest MAX_ROWS. */
export function addRow(l: Ledger, row: LedgerRow, now: number): Ledger {
  const rows = pruneLedger(l, now).rows.filter((r) => r.jobId !== row.jobId);
  rows.push(row);
  return { v: 1, rows: rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows };
}

export function removeRow(l: Ledger, jobId: string): Ledger {
  const rows = l.rows.filter((r) => r.jobId !== jobId);
  return rows.length === l.rows.length ? l : { v: 1, rows };
}

// ── Runtime singleton ─────────────────────────────────────────────────────────

let ledger: Ledger = EMPTY_LEDGER;
let loaded = false;
let loading: Promise<void> | null = null;

async function write(): Promise<void> {
  if (!isTauri) return;
  try {
    await saveJobsLedger(ledger);
  } catch (e) {
    console.error("jobs ledger save failed:", e);
  }
}

/** Load the persisted ledger once. Rows added before the read landed are kept. */
export function initLedger(): Promise<void> {
  if (!isTauri || loaded) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const persisted = pruneLedger(parseLedger(await loadJobsLedger()), Date.now());
      const mine = ledger.rows;
      ledger = { v: 1, rows: [...persisted.rows.filter((r) => !mine.some((m) => m.jobId === r.jobId)), ...mine] };
      loaded = true;
    } catch (e) {
      console.error("jobs ledger load failed:", e);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function ledgerRows(): LedgerRow[] {
  return ledger.rows;
}

/** Record a run the pump is about to post. AWAITED by the caller: the row must be on
 *  disk before the request leaves, or a quit in the first second loses the run. */
export async function persistRow(row: LedgerRow): Promise<void> {
  ledger = addRow(ledger, row, Date.now());
  await write();
}

/** The run settled (ingested, failed, cancelled) — forget it. */
export async function forgetRow(jobId: string): Promise<void> {
  const next = removeRow(ledger, jobId);
  if (next === ledger) return;
  ledger = next;
  await write();
}

/** Tests only. */
export function _resetLedgerForTests(): void {
  ledger = EMPTY_LEDGER;
  loaded = false;
  loading = null;
}
