// Startup reconcile of the in-flight jobs ledger against the server's job resource.
//
// The pump writes a ledger row before every request it posts (lib/jobsLedger.ts).
// When the app was quit mid-run the server kept working and now holds the row —
// `running`, or already `done` with the result — while the app remembers nothing but
// the ledger. This module closes that gap once per launch:
//
//   running  → the newest such row takes the rail back (reattachRun) when the workbench
//              is idle and is polled once a second through GET /v1/jobs/{id}; every
//              other running row is watched headless (every 5 s) and lands in History
//              when it finishes.
//   done     → the result is fetched and ingested exactly like the POST path.
//   failed / cancelled / unknown → a failed record with the reason.
//   server unreachable → try again every 30 s for ten minutes, then leave the rows
//              for the next launch (nothing is lost — the server still holds the job;
//              its horizon is jobsLedger.maxAgeMs).
//
// Every ingest is idempotent: the record id IS the job id, so a second pass upserts
// the same record; the row is forgotten only after the record was written.

import { deleteJob, getJob, getJobResult, isTauri } from "./api";
import { effectiveServerUrl } from "./backends";
import { isAnsweredError } from "./errors";
import { configReady } from "./persistence";
import { forgetRow, initLedger, ledgerLoaded, ledgerRows, maxAgeMs, setLedgerLateLoad, type LedgerRow } from "./jobsLedger";
import { useApp } from "./store";
import {
  failJob, foldProgress, ingestJobResult, reattachRun, setOrphanForget, setOrphanStop, setOrphanWatch,
  setReattachStop, useTranscribeRun, withSiteTracks,
} from "./transcribeRun";
import { currentRecord, historyLoadFailed, loadHistory } from "./transcript/transcriptHistory";
import type { JobStatus } from "./types";

/** Where a ledgered job is asked about: its backend's CURRENT address. The jobs commands resolve
 *  the key by backend id at call time, so the address frozen at post time would send the current
 *  key to a host the backend no longer points at (trade-off: a backend repointed at another server
 *  reports the job not found). A deleted backend keeps the stored address (no key resolves for it,
 *  and the reconcile pass and a watcher forget its rows). */
function rowServerUrl(row: LedgerRow): string {
  const st = useApp.getState();
  const b = st.backends.find((x) => x.id === row.backendId);
  return b ? effectiveServerUrl(b, st.settings) : row.serverUrl;
}

/** Copy for the states a returning user sees on a failed record. */
export const NOT_FOUND_ERROR =
  "The server has no record of this run — it never arrived, or the server restarted.";
export const DISABLED_ERROR = "This server no longer keeps runs.";
export const NO_RESULT_ERROR = "The server no longer has the result.";
export const GAVE_UP_ERROR = "Gave up waiting for the server.";
export const BACKEND_GONE_ERROR = "The backend this run was sent to was removed.";

const RETRY_MS = 30_000;
const MAX_RETRIES = 20;
const POLL_MS = 1_000;
/** A headless watcher folds no progress — it only waits for the terminal state, which
 *  is not worth a round trip a second for hours (it keeps polling in the tray too). */
const HEADLESS_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

let started = false;
let inFlight = false;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** A retry timer fired while a pass was in flight: that pass runs one more right after it. */
let rerun = false;
/** The pass is reading the ledger itself: a late load it lands is its own to reconcile. */
let passReading = false;
/** Job ids a watcher is polling right now (→ its stop): a retry pass re-reads the live
 *  ledger, where a watched row stays until it settles, and must not start a second watcher. */
const watching = new Map<string, () => void>();
/** Job ids a headless watcher (watchOrphan's, or reconcile's) is polling (→ the file's path): the queue row that
 *  names the job can be rebuilt without it (a History record opened, the workbench
 *  closed), so a re-run of the path finds the watcher by path, not by row. */
const orphans = new Map<string, string>();
/** Job ids a watcher is polling (→ the row it captured): the ledger evicts rows on its own
 *  (the newest-20 cap on every new request), so a big lost batch can drop a watched row
 *  while its job still runs — stopOrphan must still reach that job's server. */
const watchedRows = new Map<string, LedgerRow>();
/** Rows the running reconcile pass still works on (→ the row it snapshotted): the ledger can
 *  evict one mid-pass (the newest-20 cap, the byte cap) while its status or result is in
 *  flight, and the path-keyed stop and stopOrphan must still find it — else the pass lands
 *  an old job beside the user's re-run of its file. Held only for the pass's lifetime. */
const passRows = new Map<string, LedgerRow>();
/** The job the rail's reattached watcher polls: never torn down by a record delete. */
let attachedId: string | null = null;
/** When this launch's reconcile started. Rows the pump persists from then on are its
 *  own live requests, never something to reconcile. */
let launchedAt = Infinity;

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

/** Fetch + ingest a finished job. Returns false when the fetch must be retried
 *  (transport error, an HTTP status, or the result is not published yet). A stored result
 *  Rust can never accept (over the body cap, not valid text, a parse failure) settles the run
 *  failed with the reason, as the live POST path does: re-polling would refuse the same bytes
 *  for days of a "running" rail. Attached: an epoch move during either fetch (the result, then
 *  a link's site subtitles) means the user moved on and the stop hook already released the
 *  rail and forgot the row — drop the result. `stopped`: the watcher was stopped meanwhile
 *  (stopOrphan: the user retried) — drop it too. */
async function ingestDone(
  row: LedgerRow, status: JobStatus, attached: boolean, epoch?: number, stopped: () => boolean = () => false,
): Promise<boolean> {
  const serverUrl = rowServerUrl(row);
  // The ingest's own fetches (a link's audio/video copy, the pending-video poll) read the
  // address off ctx: the current one, like the result's, not the one frozen at post time.
  const ctx = { ...row.ctx, serverUrl };
  const r = await getJobResult({ serverUrl, backendId: row.backendId, jobId: row.jobId });
  if (stopped() || (attached && useTranscribeRun.getState().epoch !== epoch)) return true;
  switch (r.kind) {
    case "ok": {
      const result = await withSiteTracks(r.value, row.path, row.urlMeta, ctx);
      if (stopped() || (attached && useTranscribeRun.getState().epoch !== epoch)) return true;
      ingestJobResult({ ...row, ctx }, result, tookMsOf(status, row), { attached });
      await forgetRow(row.jobId);
      return true;
    }
    case "running":
      // The status said done but the result endpoint still answers 409 (the server
      // publishes the two a moment apart). Retry like a fetch error: nothing was
      // ingested yet, so reporting success here would abandon the finished run.
      return false;
    case "not_found":
    case "disabled":
      failJob(row, r.kind === "disabled" ? DISABLED_ERROR : NO_RESULT_ERROR, { attached });
      await forgetRow(row.jobId);
      return true;
    case "error":
      if (isAnsweredError(r.message) && !/^HTTP \d/.test(r.message)) {
        failJob(row, `The server's result could not be read: ${r.message}`, { attached });
        await forgetRow(row.jobId);
        return true;
      }
      return false;
  }
}

/** A lost request's failed record still stands (the pump wrote it under the job id when contact
 *  was lost, this launch or an earlier one): a settle must name the real reason on it. Loads
 *  History first — nothing else has at launch (the Dashboard never does), and a row forgotten
 *  on an empty mirror can never settle its record later. "unknown": the listing failed and the
 *  mirror has no failed record for the job — keep the row for a later pass or launch (the next
 *  loadHistory lists again). */
async function lostRecord(row: LedgerRow): Promise<"failed" | "none" | "unknown"> {
  await loadHistory();
  if (currentRecord(row.jobId)?.status === "failed") return "failed";
  return historyLoadFailed() ? "unknown" : "none";
}

/** Poll one job until it settles. Attached mode paints the rail and stops the moment
 *  the store's epoch moves (the user cancelled or started something else); headless
 *  mode only waits for the terminal state. `lost`: a request this session's pump lost
 *  contact with (watchOrphan), whose failed record and queue row already exist. */
function watchJob(row: LedgerRow, opts: { attached: boolean; epoch?: number; lost?: boolean }): void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let failures = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    watching.delete(row.jobId);
    watchedRows.delete(row.jobId);
    orphans.delete(row.jobId);
    if (attachedId === row.jobId) attachedId = null;
  };
  watching.set(row.jobId, stop);
  watchedRows.set(row.jobId, row);
  if (opts.attached) attachedId = row.jobId;
  // The rail's stop hook (abandonActiveRun): the user moved on, so the row goes too.
  const abandon = () => {
    stop();
    useTranscribeRun.setState({ running: false });
    void forgetRow(row.jobId);
  };
  if (opts.attached) setReattachStop(abandon);
  const base = opts.attached ? POLL_MS : HEADLESS_POLL_MS;
  const tick = async () => {
    if (stopped) return;
    if (opts.attached && useTranscribeRun.getState().epoch !== opts.epoch) {
      // Someone else owns the rail now; abandonActiveRun already ran our stop hook.
      stop();
      return;
    }
    if (Date.now() - row.startedAt > maxAgeMs(row)) {
      stop();
      if (opts.attached) setReattachStop(null);
      failJob(row, GAVE_UP_ERROR, { attached: opts.attached });
      await forgetRow(row.jobId);
      return;
    }
    // The backend was deleted mid-watch (here, or by a sync pull): no key resolves for it, so an
    // auth-gated server answers every poll 401 until maxAge — days of a "running" rail. Settle the
    // run or lost record (and queue row) with the reason and forget the row; a row with no record
    // (the app quit mid-request) is forgotten without one.
    const app = useApp.getState();
    if (app.configLoaded && !app.configLoadFailed && !app.backends.some((b) => b.id === row.backendId)) {
      stop();
      if (opts.attached) {
        setReattachStop(null);
        failJob(row, BACKEND_GONE_ERROR, { attached: true });
      } else if (opts.lost) {
        failJob(row, BACKEND_GONE_ERROR, { attached: false });
      } else {
        const lost = await lostRecord(row);
        // Stopped during the listing (a retry of its file, a delete of its record): stopOrphan
        // already forgot the row, and a settle now would re-point the file at the old job.
        if (stoppedIds.has(row.jobId)) return;
        // The listing failed: keep the row (no longer watched, an earlier launch's) for a
        // later reconcile pass — scheduled here, nothing else would run one — or the next launch.
        if (lost === "unknown") {
          scheduleRetry();
          return;
        }
        if (lost === "failed") failJob(row, BACKEND_GONE_ERROR, { attached: false });
      }
      await forgetRow(row.jobId);
      return;
    }
    if (busy) return;
    busy = true;
    let delay = base;
    try {
      // Re-read per poll: an address edit mid-watch applies to the next status call.
      const r = await getJob({ serverUrl: rowServerUrl(row), backendId: row.backendId, jobId: row.jobId });
      if (stopped) return;
      if (r.kind === "error") {
        failures += 1;
        delay = Math.min(base * 2 ** failures, MAX_BACKOFF_MS);
        return;
      }
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
        failures = 0;
        if (opts.attached && status.progress) foldProgress(status.progress);
        return;
      }
      if (status.state === "done") {
        // The stop hook stays installed through the fetch, so a cancel meanwhile still
        // releases the rail; settleReattached clears it once the run is ingested/failed.
        if (await ingestDone(row, status, opts.attached, opts.epoch, () => stopped)) {
          stop();
          return;
        }
        // Back off like a status error, so a result that keeps failing slows down to
        // MAX_BACKOFF_MS instead of polling at base until maxAge.
        failures += 1;
        delay = Math.min(base * 2 ** failures, MAX_BACKOFF_MS);
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

/** A live request lost contact with the server (the pump's wait ran out, or the
 *  connection dropped) while its job may still run there: watch the job headless,
 *  so a transcript the server finishes still lands in History. */
export function watchOrphan(jobId: string): void {
  if (watching.has(jobId)) return;
  const row = ledgerRows().find((r) => r.jobId === jobId);
  if (!row) return;
  orphans.set(jobId, row.path);
  watchJob(row, { attached: false, lost: true });
}
setOrphanWatch(watchOrphan);

/** Jobs the user stopped this session (stopOrphan). A reconcile pass checks this, not ledger
 *  membership: the ledger also evicts rows on its own (age, the newest-20 cap on every new
 *  request), and a finished result must still land then. */
const stoppedIds = new Set<string>();

/** The user retried a file whose lost request was handed to watchOrphan: stop that
 *  watcher and forget its row, so the old job can't land a second record (and re-point
 *  the file's latest transcript) after the retry's; best-effort, the server stops it. */
export function stopOrphan(jobId: string): void {
  // Before the watcher's stop, which drops its captured row (an evicted one is only there).
  const row = ledgerRows().find((r) => r.jobId === jobId) ?? watchedRows.get(jobId) ?? passRows.get(jobId);
  stoppedIds.add(jobId);
  watching.get(jobId)?.();
  if (!row) return;
  void forgetRow(jobId);
  void deleteJob({ serverUrl: rowServerUrl(row), backendId: row.backendId, jobId }).catch(() => {});
}
/** The pump's hook (retryFile, startRun): stop every lost request whose file the user is
 *  about to run again — a watched one (found by path in `orphans`: the ledger may have
 *  evicted its row), and an earlier launch's row reconcile could not reach yet (server
 *  unreachable: no watcher, but a retry pass would still land it). The rail's reattached
 *  watcher and this launch's own requests are left alone. */
setOrphanStop((paths) => {
  const ids = new Set<string>();
  for (const [jobId, p] of orphans) if (paths.includes(p)) ids.add(jobId);
  // A row the reconcile pass is still on, which the ledger may already have evicted.
  for (const [jobId, r] of passRows) if (r.path && paths.includes(r.path)) ids.add(jobId);
  for (const r of ledgerRows()) {
    if (!r.path || !paths.includes(r.path)) continue;
    if (orphans.has(r.jobId) || (r.startedAt < launchedAt && !watching.has(r.jobId))) ids.add(r.jobId);
  }
  for (const id of ids) stopOrphan(id);
});

/** The user deleted the failed record of a lost request (its id is the job id): stop the
 *  job like a retry does, or it lands the deleted record again when it finishes. */
setOrphanForget((jobId) => {
  if (attachedId === jobId) return;
  stopOrphan(jobId);
});

/** Does a getJob "error" say nothing about the host being reachable? An answered request (a
 *  revoked key on ONE backend entry, a 500 for one job) is per-row; only one that got no answer
 *  is per-server (see isAnsweredError). Anything unrecognised stays per-server, which only costs
 *  the skipped rows a retry pass. */
export const isPerRowJobError = isAnsweredError;

/** One pass over the ledger. Single-flight; schedules its own retry while the server
 *  cannot be reached. */
export async function reconcileJobs(): Promise<void> {
  if (!isTauri) return;
  if (inFlight) {
    rerun = true;
    return;
  }
  inFlight = true;
  let retry = false;
  try {
    // The launch's read failed (a Windows AV lock): read again, and while it still fails keep
    // retrying — an earlier launch's rows are only on disk, and no pass would look at them.
    passReading = true;
    try {
      await initLedger();
    } finally {
      passReading = false;
    }
    if (!ledgerLoaded()) retry = true;
    const app = useApp.getState();
    const rows = [...ledgerRows()].sort((a, b) => a.startedAt - b.startedAt);
    const running: LedgerRow[] = [];
    // Servers that failed to answer this pass: a dead host costs the status call's full
    // timeout per row, so its other rows wait for the next pass instead.
    const unreachable = new Set<string>();
    // Already polled by a watcher, or a request this session's pump posted itself.
    const mine = (row: LedgerRow) => !watching.has(row.jobId) && row.startedAt < launchedAt;
    for (const row of rows) if (mine(row)) passRows.set(row.jobId, row);
    for (const row of rows) {
      if (!mine(row)) continue;
      try {
        // Stopped before the pass could see its row (a record deleted while the launch's ledger
        // read failed): stopOrphan found nothing to forget or cancel, so do both here, or the
        // row is saved again and the next launch lands the deleted record. A stop during one of
        // the awaits below found the row in passRows and did both already.
        if (stoppedIds.has(row.jobId)) {
          await forgetRow(row.jobId);
          void deleteJob({ serverUrl: rowServerUrl(row), backendId: row.backendId, jobId: row.jobId }).catch(() => {});
          continue;
        }
        // A backend that no longer exists (deleted, a sync pull) cannot be asked; the
        // server still holds the run for its TTL, but the app has no way to reach it.
        // Before the reachability skip: its row keeps the stored address, which another
        // backend on that host may share — a down host must not keep it queued.
        if (app.configLoaded && !app.configLoadFailed && !app.backends.some((b) => b.id === row.backendId)) {
          const lost = await lostRecord(row);
          // Stopped during the listing: stopOrphan already forgot the row.
          if (stoppedIds.has(row.jobId)) continue;
          // The listing failed: the row stays, and the next pass lists again.
          if (lost === "unknown") {
            retry = true;
            continue;
          }
          if (lost === "failed") failJob(row, BACKEND_GONE_ERROR, { attached: false });
          await forgetRow(row.jobId);
          continue;
        }
        const url = rowServerUrl(row);
        if (unreachable.has(url)) {
          retry = true;
          continue;
        }
        const r = await getJob({ serverUrl: url, backendId: row.backendId, jobId: row.jobId });
        // Stopped meanwhile (a retry of its file, a delete of its record).
        if (stoppedIds.has(row.jobId)) continue;
        switch (r.kind) {
          case "error":
            // A per-row failure must not hold back the server's other rows every pass until
            // it ages out.
            if (!isPerRowJobError(r.message)) unreachable.add(url);
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
          // Not watched, so stopOrphan (a retry of its file, a delete of its record) cannot
          // reach this ingest: re-check after each of its awaits instead.
          if (!(await ingestDone(row, status, false, undefined, () => stoppedIds.has(row.jobId)))) retry = true;
        } else {
          failJob(row, failedText(status), { attached: false });
          await forgetRow(row.jobId);
        }
      } finally {
        // Handled (or left for the next pass); a running row stays until it is watched.
        if (!running.includes(row)) passRows.delete(row.jobId);
      }
    }
    // The newest running row takes the rail back — only from an untouched workbench
    // (no run, no picked files, no queue, no open record: a retry pass can come long
    // after launch, and reattachRun replaces all of them); every other running row,
    // or the newest one then, is watched headless and still lands in History.
    // A row stopped during a later row's await (forgotten) is neither reattached nor watched.
    const live = running.filter((row) => !stoppedIds.has(row.jobId));
    const newest = live[live.length - 1];
    const s = useTranscribeRun.getState();
    const idle = !s.running && s.files.length === 0 && s.queue.length === 0 && s.openRecordId === null;
    for (const row of live) {
      if (row === newest && idle) {
        const epoch = reattachRun(row, () => rowServerUrl(row));
        watchJob(row, { attached: true, epoch });
      } else {
        // Stoppable by the path-keyed orphan stop like watchOrphan's: a History record
        // of this lost request can be retried, and the old job must not land beside it.
        if (row.path) orphans.set(row.jobId, row.path);
        watchJob(row, { attached: false });
      }
    }
  } catch (e) {
    console.error("jobs reconcile failed:", e);
  } finally {
    // Every row is handled or handed to a watcher (watchedRows holds it from here).
    passRows.clear();
    inFlight = false;
  }
  // A call that landed mid-pass (a retry timer, which already waited and spent its budget unit,
  // or a late ledger read): run its pass now, which schedules its own (charged) retry if it
  // still needs one.
  const owed = rerun;
  rerun = false;
  if (owed) void reconcileJobs();
  else if (retry) scheduleRetry();
}

/** Run another reconcile pass after RETRY_MS (one timer; at most MAX_RETRIES per launch). A call
 *  while a pass is already scheduled joins it and spends nothing — several watchers failing on
 *  one listing are one retry. A timer that lands during a pass (a watcher armed it mid-pass) runs
 *  right after that pass, without re-arming or spending budget. */
function scheduleRetry(): void {
  if (retryTimer !== undefined || retries >= MAX_RETRIES) return;
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void reconcileJobs();
  }, RETRY_MS);
}

/** A late read that lands outside a pass's own (a save's, after the retry budget ran out, or
 *  mid-pass): reconcile what it brought — mid-pass, as the rerun right after that pass. */
setLedgerLateLoad(() => {
  if (started && !passReading) void reconcileJobs();
});

/** Once per launch: load the ledger after the config (backends) is in, then reconcile. */
export async function initJobReconcile(): Promise<void> {
  if (!isTauri || started) return;
  started = true;
  launchedAt = Date.now();
  await configReady;
  await initLedger();
  await reconcileJobs();
}

export function _resetReconcileForTests(): void {
  started = false;
  inFlight = false;
  retries = 0;
  rerun = false;
  passReading = false;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  watching.clear();
  watchedRows.clear();
  passRows.clear();
  orphans.clear();
  stoppedIds.clear();
  attachedId = null;
  launchedAt = Infinity;
}
