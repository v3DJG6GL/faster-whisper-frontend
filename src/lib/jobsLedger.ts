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
/** Mirrors src-tauri/src/store/jobs_ledger.rs MAX_LEDGER_BYTES — a save over it is refused whole. */
export const MAX_LEDGER_BYTES = 256 * 1024;
/** The TTL assumed when the server did not announce `jobs.ttl_s` (the server's own
 *  default), and the ceiling on one it did: a 10-year TTL must not pin a row forever. */
const DEFAULT_TTL_S = 72 * 3600;
const MAX_TTL_S = 30 * 86_400;
/** Grace past the TTL: the server sweeps on its own clock, not ours. */
const SLACK_MS = 3_600_000;

/** The server's `caps.jobs.ttl_s` within (0, 30 d] (a larger one is capped); anything
 *  else is `undefined` = assume the default. */
export function clampJobsTtl(ttlS: unknown): number | undefined {
  if (typeof ttlS !== "number" || !Number.isFinite(ttlS) || ttlS <= 0) return undefined;
  return Math.min(ttlS, MAX_TTL_S);
}

/** The server keeps a running job at least this long from its start, whatever its TTL
 *  (mirrors faster-whisper-backend jobs_store._RUNNING_FLOOR_S). */
const RUNNING_FLOOR_S = 24 * 3600;

/** A row older than ITS server's horizon (TTL frozen into the row's context at post time)
 *  plus slack names a job the server has already swept — nothing to ask about. The server
 *  keeps a running job max(TTL, 24 h) from its start and re-stamps a TTL at its finish, so
 *  a finished result can live that long plus one TTL after the request left (a row past
 *  the real horizon costs one 404). Re-clamped here because the row came back from disk. */
export function maxAgeMs(row: LedgerRow): number {
  const ttl = clampJobsTtl(row.ctx.jobsTtlS) ?? DEFAULT_TTL_S;
  return (Math.max(ttl, RUNNING_FLOOR_S) + ttl) * 1000 + SLACK_MS;
}

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
  const rows = l.rows.filter((r) => now - r.startedAt <= maxAgeMs(r));
  return rows.length === l.rows.length ? l : { v: 1, rows };
}

/** Keep the newest MAX_ROWS (rows run oldest first) — and within MAX_LEDGER_BYTES: a row's
 *  options carry user text verbatim (the glossary), and Rust refuses an oversized save whole,
 *  which froze the disk copy. The oldest rows go first, never the last one. */
export function boundLedger(rows: LedgerRow[]): Ledger {
  if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
  const enc = new TextEncoder();
  while (rows.length > 1 && enc.encode(JSON.stringify({ v: 1, rows })).length > MAX_LEDGER_BYTES) rows = rows.slice(1);
  return { v: 1, rows };
}

/** Append (replacing a row of the same id), prune, and bound (boundLedger) — never dropping
 *  the new row. */
export function addRow(l: Ledger, row: LedgerRow, now: number): Ledger {
  const rows = pruneLedger(l, now).rows.filter((r) => r.jobId !== row.jobId);
  rows.push(row);
  return boundLedger(rows);
}

export function removeRow(l: Ledger, jobId: string): Ledger {
  const rows = l.rows.filter((r) => r.jobId !== jobId);
  return rows.length === l.rows.length ? l : { v: 1, rows };
}

// ── Runtime singleton ─────────────────────────────────────────────────────────

let ledger: Ledger = EMPTY_LEDGER;
let loaded = false;
let loading: Promise<void> | null = null;
/** A read failed before (the launch's, or a save's): the next one to land brings in rows no
 *  launch pass has seen. */
let readFailed = false;
let onLateLoad: (() => void) | null = null;

/** The reconcile's hook: the disk copy was read only after an earlier read failed, so an
 *  earlier launch's rows just arrived — and nothing else would look at them this session. */
export function setLedgerLateLoad(fn: (() => void) | null): void {
  onLateLoad = fn;
}

/** Has the disk copy been read (merged) yet? Outside the desktop app there is none to read. */
export function ledgerLoaded(): boolean {
  return !isTauri || loaded;
}

async function write(): Promise<void> {
  if (!isTauri) return;
  // A save replaces the whole file: before the disk copy was read (or while it can't be — a
  // Windows AV lock), it would erase an earlier launch's rows for good. Read it now (merging),
  // and if it still can't be read keep it as is: this session's rows lose only their re-attach.
  if (!loaded) await initLedger();
  if (!loaded) {
    console.warn("jobs ledger not saved: the file on disk could not be read, so it is kept as is");
    return;
  }
  try {
    await saveJobsLedger(ledger);
  } catch (e) {
    console.error("jobs ledger save failed:", e);
  }
}

/** Load the persisted ledger once. Rows added before the read landed are kept. A failed
 *  read (the file exists but can't be read) leaves it unloaded, so the next save tries again. */
export function initLedger(): Promise<void> {
  if (!isTauri || loaded) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const persisted = pruneLedger(parseLedger(await loadJobsLedger()), Date.now());
      const mine = ledger.rows;
      // Bounded like addRow: the disk copy plus this session's rows can pass the caps, and
      // Rust would refuse every save until the next addRow re-trimmed.
      ledger = boundLedger([...persisted.rows.filter((r) => !mine.some((m) => m.jobId === r.jobId)), ...mine]);
      loaded = true;
      if (readFailed) onLateLoad?.();
    } catch (e) {
      readFailed = true;
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
  readFailed = false;
}
