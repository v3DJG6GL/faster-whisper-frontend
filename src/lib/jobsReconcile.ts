// Startup reconcile of the in-flight jobs ledger against the server's job resource.
//
// The pump writes a ledger row before every request it posts (lib/jobsLedger.ts).
// When the app was quit mid-run the server kept working and now holds the row —
// `running`, or already `done` with the result — while the app remembers nothing but
// the ledger. This module closes that gap once per launch:
//
//   running  → the newest such row takes the rail back (reattachRun) and is polled
//              once a second through GET /v1/jobs/{id}; any older running row is
//              watched headless (every 5 s) and lands in History when it finishes.
//   done     → the result is fetched and ingested exactly like the POST path.
//   failed / cancelled / unknown → a failed record with the reason.
//   server unreachable → try again every 30 s for ten minutes, then leave the rows
//              for the next launch (nothing is lost — the server holds a running job
//              for max(its jobs TTL, 24 h) from its start — caps.jobs.ttl_s, 72 h by
//              default — and a finished one for a TTL from its finish; see
//              jobsLedger.maxAgeMs).
//
// Every ingest is idempotent: the record id IS the job id, so a second pass upserts
// the same record; the row is forgotten only after the record was written.

import { deleteJob, getJob, getJobResult, isTauri } from "./api";
import { effectiveServerUrl } from "./backends";
import { configReady } from "./persistence";
import { forgetRow, initLedger, ledgerRows, maxAgeMs, type LedgerRow } from "./jobsLedger";
import { useApp } from "./store";
import {
  failJob, foldProgress, ingestJobResult, reattachRun, setOrphanForget, setOrphanStop, setOrphanWatch,
  setReattachStop, useTranscribeRun, withSiteTracks,
} from "./transcribeRun";
import type { JobStatus } from "./types";

/** Where a ledgered job is asked about: its backend's CURRENT address (`effectiveServerUrl`, with
 *  this device's override), as every other surface pairs it with the key. The jobs commands
 *  resolve the key by backend id at call time, so the address frozen at post time would send the
 *  current key to a host the backend no longer points at; a backend repointed at another server
 *  then reports the job not found. A deleted backend keeps the stored address (no key resolves for
 *  it, and the reconcile pass and a watcher forget its rows). */
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
 *  (transport error, or the result is not published yet). Attached: an epoch move
 *  during either fetch (the result, then a link's site subtitles) means the user cancelled (or started something else) and the
 *  stop hook already released the rail and forgot the row — drop the result. `stopped`:
 *  the watcher was stopped meanwhile (stopOrphan: the user retried) — drop it too. */
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
      // A second network await (the link's site subtitles): the epoch can move during it too.
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
      return false;
  }
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
    // auth-gated server answers every poll 401 until maxAge — days of a "running" rail. Forget the
    // row; the rail's run settles failed and names why, and a this-session lost request settles
    // its failed record (and queue row) with the reason. An earlier launch's row is forgotten
    // without a record, like the reconcile pass.
    const app = useApp.getState();
    if (app.configLoaded && !app.configLoadFailed && !app.backends.some((b) => b.id === row.backendId)) {
      stop();
      if (opts.attached) {
        setReattachStop(null);
        failJob(row, BACKEND_GONE_ERROR, { attached: true });
      } else if (opts.lost) {
        failJob(row, BACKEND_GONE_ERROR, { attached: false });
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
        // Back off like a status error (failures is not reset on "done", so a result
        // that keeps failing slows down to MAX_BACKOFF_MS instead of 1 s for 72 h).
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
const stopped = new Set<string>();

/** The user retried a file whose lost request was handed to watchOrphan: stop that
 *  watcher and forget its row, so the old job can't land a second record (and re-point
 *  the file's latest transcript) after the retry's; best-effort, the server stops it. */
export function stopOrphan(jobId: string): void {
  // Before the watcher's stop, which drops its captured row (an evicted one is only there).
  const row = ledgerRows().find((r) => r.jobId === jobId) ?? watchedRows.get(jobId) ?? passRows.get(jobId);
  stopped.add(jobId);
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

/** Does a getJob "error" say nothing about the host being reachable? A status the server
 *  answered (Rust's "HTTP <code>": a revoked key on ONE backend entry, a 500 for one job), an
 *  over-large or unreadable body, a serde parse failure and a malformed id are per-row; only a
 *  request that got no answer (connect, timeout, a dropped connection) is per-server. Rust
 *  carries no kind on the outcome, so this reads its fixed message shapes (transport/jobs.rs,
 *  transport/mod.rs body_capped_to / json_capped_to); anything unrecognised stays per-server,
 *  which only costs the skipped rows a retry pass. */
export function isPerRowJobError(message: string): boolean {
  return (
    /^HTTP \d/.test(message) ||
    message === "malformed job id" ||
    message.startsWith("The server sent an unreasonably large response") ||
    message.startsWith("The server sent a response that wasn't valid text") ||
    / at line \d+ column \d+$/.test(message) ||
    /^(invalid (type|value|length)|unknown (variant|field)|missing field|duplicate field|expected |EOF while parsing|trailing (characters|comma)|control character|number out of range|key must be|lone leading surrogate|recursion limit exceeded)/.test(message)
  );
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
    // Servers that failed to answer this pass: a dead host costs the status call's full
    // timeout per row, so its other rows wait for the next pass instead.
    const unreachable = new Set<string>();
    // Already polled by a watcher, or a request this session's pump posted itself.
    const mine = (row: LedgerRow) => !watching.has(row.jobId) && row.startedAt < launchedAt;
    for (const row of rows) if (mine(row)) passRows.set(row.jobId, row);
    for (const row of rows) {
      if (!mine(row)) continue;
      try {
        // A backend that no longer exists (deleted, a sync pull) cannot be asked; the
        // server still holds the run for its TTL, but the app has no way to reach it.
        // Before the reachability skip: its row keeps the stored address, which another
        // backend on that host may share — a down host must not keep it queued.
        if (app.configLoaded && !app.configLoadFailed && !app.backends.some((b) => b.id === row.backendId)) {
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
        if (stopped.has(row.jobId)) continue;
        switch (r.kind) {
          case "error":
            // Only a request that got no answer says the host is down; a per-row failure
            // (one entry's revoked key, one job's 500 or unreadable body) must not hold back
            // the server's other rows every pass until it ages out.
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
          if (!(await ingestDone(row, status, false, undefined, () => stopped.has(row.jobId)))) retry = true;
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
    const live = running.filter((row) => !stopped.has(row.jobId));
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
  launchedAt = Date.now();
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
  watching.clear();
  watchedRows.clear();
  passRows.clear();
  orphans.clear();
  stopped.clear();
  attachedId = null;
  launchedAt = Infinity;
}
