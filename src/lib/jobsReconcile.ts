// Startup reconcile of the in-flight jobs ledger against the server's job resource.
//
// The pump writes a ledger row before every request it posts (lib/jobsLedger.ts).
// When the app was quit mid-run the server kept working and now holds the row —
// `running`, or already `done` with the result — while the app remembers nothing but
// the ledger. This module closes that gap once per launch:
//
//   running  → the newest such row takes the rail back (reattachRun) and is polled
//              once a second through GET /v1/jobs/{id}; any older running row is
//              watched headless and lands in History when it finishes.
//   done     → the result is fetched and ingested exactly like the POST path.
//   failed / cancelled / unknown → a failed record with the reason.
//   server unreachable → try again every 30 s for ten minutes, then leave the rows
//              for the next launch (nothing is lost — the server holds them 72 h).
//
// Every ingest is idempotent: the record id IS the job id, so a second pass upserts
// the same record; the row is forgotten only after the record was written.

import { getJob, getJobResult, isTauri } from "./api";
import { configReady } from "./persistence";
import { forgetRow, initLedger, ledgerRows, MAX_AGE_MS, type LedgerRow } from "./jobsLedger";
import { useApp } from "./store";
import {
  failJob, foldProgress, ingestJobResult, reattachRun, setReattachStop, useTranscribeRun,
} from "./transcribeRun";
import type { JobStatus } from "./types";

/** Copy for the states a returning user sees on a failed record. */
export const NOT_FOUND_ERROR =
  "The server has no record of this run — it never arrived, or the server restarted.";
export const DISABLED_ERROR = "This server no longer keeps runs.";
export const NO_RESULT_ERROR = "The server no longer has the result.";
export const GAVE_UP_ERROR = "Gave up waiting for the server.";

const RETRY_MS = 30_000;
const MAX_RETRIES = 20;
const POLL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

let started = false;
let inFlight = false;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Server-clocked wall time when both stamps are there, else our own. */
function tookMsOf(status: JobStatus, row: LedgerRow): number {
  if (status.finishedAt && status.createdAt && status.finishedAt >= status.createdAt) {
    return Math.round((status.finishedAt - status.createdAt) * 1000);
  }
  return Math.max(0, Date.now() - row.startedAt);
}

function failedText(status: JobStatus): string {
  if (status.error) return status.error;
  return status.state === "cancelled" ? "Cancelled" : "The run failed on the server";
}

/** Fetch + ingest a finished job. Returns false when the fetch must be retried. */
async function ingestDone(row: LedgerRow, status: JobStatus, attached: boolean): Promise<boolean> {
  const r = await getJobResult({ serverUrl: row.serverUrl, backendId: row.backendId, jobId: row.jobId });
  switch (r.kind) {
    case "ok":
      ingestJobResult(row, r.value, tookMsOf(status, row), { attached });
      await forgetRow(row.jobId);
      return true;
    case "running":
      // Raced the finish: the next poll sees the terminal state.
      return true;
    case "not_found":
    case "disabled":
      failJob(row, r.kind === "disabled" ? DISABLED_ERROR : NO_RESULT_ERROR, { attached });
      await forgetRow(row.jobId);
      return true;
    case "error":
      return false;
  }
}

/** Poll one job until it settles. Attached mode paints the rail and stops the moment
 *  the store's epoch moves (the user cancelled or started something else); headless
 *  mode only waits for the terminal state. */
function watchJob(row: LedgerRow, opts: { attached: boolean; epoch?: number }): void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let failures = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  if (opts.attached) {
    setReattachStop(() => {
      stop();
      useTranscribeRun.setState({ running: false });
      void forgetRow(row.jobId);
    });
  }
  const tick = async () => {
    if (stopped) return;
    if (opts.attached && useTranscribeRun.getState().epoch !== opts.epoch) {
      // Someone else owns the rail now; abandonActiveRun already ran our stop hook.
      stop();
      return;
    }
    if (Date.now() - row.startedAt > MAX_AGE_MS) {
      stop();
      if (opts.attached) setReattachStop(null);
      failJob(row, GAVE_UP_ERROR, { attached: opts.attached });
      await forgetRow(row.jobId);
      return;
    }
    if (busy) return;
    busy = true;
    let delay = POLL_MS;
    try {
      const r = await getJob({ serverUrl: row.serverUrl, backendId: row.backendId, jobId: row.jobId });
      if (stopped) return;
      if (r.kind === "error") {
        failures += 1;
        delay = Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
        return;
      }
      failures = 0;
      if (r.kind === "not_found" || r.kind === "disabled") {
        stop();
        if (opts.attached) setReattachStop(null);
        failJob(row, r.kind === "disabled" ? DISABLED_ERROR : NOT_FOUND_ERROR, { attached: opts.attached });
        await forgetRow(row.jobId);
        return;
      }
      if (r.kind !== "ok") return;
      const status = r.value;
      if (status.state === "running") {
        if (opts.attached && status.progress) foldProgress(status.progress);
        return;
      }
      if (status.state === "done") {
        if (opts.attached) setReattachStop(null);
        if (await ingestDone(row, status, opts.attached)) stop();
        else if (opts.attached) setReattachStop(() => stop());
        return;
      }
      stop();
      if (opts.attached) setReattachStop(null);
      failJob(row, failedText(status), { attached: opts.attached });
      await forgetRow(row.jobId);
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(() => void tick(), delay);
    }
  };
  void tick();
}

/** One pass over the ledger. Single-flight; schedules its own retry while the server
 *  cannot be reached. */
export async function reconcileJobs(): Promise<void> {
  if (!isTauri || inFlight) return;
  inFlight = true;
  let retry = false;
  try {
    const app = useApp.getState();
    const rows = [...ledgerRows()].sort((a, b) => a.startedAt - b.startedAt);
    const running: LedgerRow[] = [];
    for (const row of rows) {
      // A backend that no longer exists (deleted, a sync pull) cannot be asked; the
      // server still holds the run for its TTL, but the app has no way to reach it.
      if (app.configLoaded && !app.configLoadFailed && !app.backends.some((b) => b.id === row.backendId)) {
        await forgetRow(row.jobId);
        continue;
      }
      const r = await getJob({ serverUrl: row.serverUrl, backendId: row.backendId, jobId: row.jobId });
      switch (r.kind) {
        case "error":
          retry = true;
          continue;
        case "disabled":
          failJob(row, DISABLED_ERROR, { attached: false });
          await forgetRow(row.jobId);
          continue;
        case "not_found":
          failJob(row, NOT_FOUND_ERROR, { attached: false });
          await forgetRow(row.jobId);
          continue;
        case "running":
          // GET /v1/jobs/{id} never answers 409; treat like a transport hiccup.
          retry = true;
          continue;
        case "ok":
          break;
      }
      const status = r.value;
      if (status.state === "running") {
        running.push(row);
      } else if (status.state === "done") {
        if (!(await ingestDone(row, status, false))) retry = true;
      } else {
        failJob(row, failedText(status), { attached: false });
        await forgetRow(row.jobId);
      }
    }
    // The newest running row takes the rail back — unless the user already started
    // something; every other running row is watched headless.
    const newest = running[running.length - 1];
    for (const row of running) {
      if (row === newest && !useTranscribeRun.getState().running) {
        const epoch = reattachRun(row);
        watchJob(row, { attached: true, epoch });
      } else {
        watchJob(row, { attached: false });
      }
    }
  } catch (e) {
    console.error("jobs reconcile failed:", e);
  } finally {
    inFlight = false;
  }
  if (retry && retries < MAX_RETRIES) {
    retries += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void reconcileJobs(), RETRY_MS);
  }
}

/** Once per launch: load the ledger after the config (backends) is in, then reconcile. */
export async function initJobReconcile(): Promise<void> {
  if (!isTauri || started) return;
  started = true;
  await configReady;
  await initLedger();
  await reconcileJobs();
}

/** Tests only. */
export function _resetReconcileForTests(): void {
  started = false;
  inFlight = false;
  retries = 0;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}
