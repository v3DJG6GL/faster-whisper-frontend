// Startup reconcile of the in-flight ledger against the server's job resource: the
// path a run takes when the app was quit while the server kept working. Drives the
// real store + history modules; only the Tauri commands are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BatchResult, JobOutcome, JobStatus } from "./types";

const getJob = vi.fn<(args: { jobId: string }) => Promise<JobOutcome<JobStatus>>>();
const getJobResult = vi.fn<(args: { jobId: string }) => Promise<JobOutcome<BatchResult>>>();
const loadJobsLedger = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
const saveJobsLedger = vi.fn<(l: unknown) => Promise<void>>(() => Promise.resolve());
const saveTranscriptRecord = vi.fn((_id: string, _json: string, _dictation: boolean) => Promise.resolve());
type CancelArgs = { serverUrl: string; backendId?: string | null; progressId: string };
const cancelBackendTranscription = vi.fn((_a: CancelArgs) => Promise.resolve());
const deleteJob = vi.fn((_args: { jobId: string }) => Promise.resolve({ kind: "ok", value: null }));
const fetchUrlMedia = vi.fn((_a: { serverUrl: string; mediaId: string }) => Promise.resolve(null));
const listTranscriptRecords = vi.fn(() => Promise.resolve([] as unknown[]));
const getTranscribeProgress = vi.fn<(args: { progressId: string }) => Promise<unknown>>(
  () => Promise.resolve({ stage: "unknown" }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  // The reconcile runs only inside the desktop app.
  isTauri: true,
  getJob: (a: { jobId: string }) => getJob(a),
  getJobResult: (a: { jobId: string }) => getJobResult(a),
  loadJobsLedger: () => loadJobsLedger(),
  saveJobsLedger: (l: unknown) => saveJobsLedger(l),
  saveTranscriptRecord: (id: string, json: string, d: boolean) => saveTranscriptRecord(id, json, d),
  cancelBackendTranscription: (a: CancelArgs) => cancelBackendTranscription(a),
  deleteJob: (a: { jobId: string }) => deleteJob(a),
  getTranscribeProgress: (a: { progressId: string }) => getTranscribeProgress(a),
  listTranscriptRecords: () => listTranscriptRecords(),
  // Media copies are best-effort side effects; keep them inert here.
  saveTranscriptMedia: () => Promise.resolve(null),
  fetchUrlMedia: (a: { serverUrl: string; mediaId: string }) => fetchUrlMedia(a),
  fetchUrlVideo: () => Promise.resolve(null),
}));
vi.mock("./persistence", () => ({ configReady: Promise.resolve() }));

const { _resetLedgerForTests, ledgerRows, persistRow, maxAgeMs } = await import("./jobsLedger");
const { _resetReconcileForTests, initJobReconcile, isPerRowJobError, reconcileJobs, stopOrphan, watchOrphan, NOT_FOUND_ERROR, BACKEND_GONE_ERROR } =
  await import("./jobsReconcile");
const { useTranscribeRun, forgetRecord, cancelRun, closeRecord, openHistoryRecord, retryFile, startRun } =
  await import("./transcribeRun");
const { useTranscriptHistory, deleteRecord, _resetHistoryLoadForTests } = await import("./transcript/transcriptHistory");
const { useApp } = await import("./store");
type LedgerRow = import("./jobsLedger").LedgerRow;
type TranscriptRecord = import("./transcript/transcriptHistory").TranscriptRecord;

const T0 = 1_800_000_000_000;
const JOB_A = "a".repeat(32);
const JOB_B = "b".repeat(32);
const JOB_C = "c".repeat(32);

function row(jobId: string, startedAt: number, kind: "file" | "url" = "file"): LedgerRow {
  return {
    v: 1,
    jobId,
    backendId: "b1",
    serverUrl: "http://localhost:8000",
    path: kind === "url" ? "https://youtu.be/x" : `/${jobId.slice(0, 2)}.mp3`,
    kind,
    title: kind === "url" ? "A talk" : undefined,
    options: { translateTo: ["en"] },
    ctx: { backendId: "b1", serverUrl: "http://localhost:8000", model: "large-v3", language: "", standard: false },
    startedAt,
  };
}

const ok = <T,>(value: T): JobOutcome<T> => ({ kind: "ok", value });
const RESULT: BatchResult = { text: "hallo welt", language: "de", duration: 1,
  segments: [{ start: 0, end: 1, text: "hallo welt" }] };

/** The server holds the job finished, with its result published. */
function serveDone(jobId = JOB_A, result: BatchResult = RESULT): void {
  getJob.mockResolvedValue(ok({ jobId, state: "done", resultAvailable: true }));
  getJobResult.mockResolvedValue(ok(result));
}

function records() {
  return useTranscriptHistory.getState().records;
}

/** The failed record the pump wrote for a lost request (its id is the job id). */
function lostFailedRecord(r: LedgerRow): TranscriptRecord {
  return { schemaVersion: 1, kind: "file", id: r.jobId, createdAt: new Date(r.startedAt).toISOString(),
    sourcePath: r.path, sourceName: r.path, status: "failed", error: "timed out" };
}

/** An earlier launch's lost request on JOB_A, seeded (with any `more` rows): the failed record
 *  the pump wrote for it. */
async function seedLost(...more: LedgerRow[]): Promise<TranscriptRecord> {
  const r = row(JOB_A, T0);
  await seed(r, ...more);
  return lostFailedRecord(r);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 60_000);
  vi.stubGlobal("window", globalThis);
  _resetLedgerForTests();
  _resetReconcileForTests();
  // A failed listing in an earlier test must not change how this one's first listing merges.
  _resetHistoryLoadForTests();
  forgetRecord(null);
  useTranscriptHistory.setState({ records: [], loaded: true });
  useTranscribeRun.setState({ files: [], queue: [], progress: null, stageTimes: {}, stageMeta: {},
    running: false, selectedPath: null, openRecordId: null });
  useApp.setState({ configLoaded: true, configLoadFailed: false,
    backends: [{ id: "b1", name: "Local", serverUrl: "http://localhost:8000" } as never] });
  getJob.mockReset();
  getJobResult.mockReset();
  getTranscribeProgress.mockClear();
  // An earlier test's cancel or stop must not satisfy this one's assertion.
  cancelBackendTranscription.mockClear();
  deleteJob.mockClear();
  fetchUrlMedia.mockClear();
  saveTranscriptRecord.mockClear();
  saveJobsLedger.mockClear();
  // An unconsumed once-listing (a test that failed early) must not answer the next test's.
  listTranscriptRecords.mockReset();
  loadJobsLedger.mockImplementation(() => Promise.resolve(null));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function seed(...rows: LedgerRow[]) {
  for (const r of rows) await persistRow(r);
}

describe("reconcileJobs", () => {
  it("a done row ingests one record with createdAt = startedAt and forgets the row", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", createdAt: T0 / 1000,
      finishedAt: T0 / 1000 + 42, resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
    await reconcileJobs();
    expect(records()).toHaveLength(1);
    const rec = records()[0];
    expect(rec.id).toBe(JOB_A);
    expect(rec.status).toBe("done");
    expect(rec.createdAt).toBe(new Date(T0).toISOString());
    expect(rec.tookMs).toBe(42_000);
    expect(rec.result?.text).toBe("hallo welt");
    expect(rec.options).toEqual({ translateTo: ["en"] });
    expect(ledgerRows()).toEqual([]);
    // Headless: the rail was not touched.
    expect(useTranscribeRun.getState().queue).toEqual([]);
    expect(useTranscribeRun.getState().running).toBe(false);
  });

  it("re-ingesting a job id upserts the same record, never a duplicate", async () => {
    await seed(row(JOB_A, T0));
    serveDone();
    await reconcileJobs();
    await seed(row(JOB_A, T0));
    await reconcileJobs();
    expect(records()).toHaveLength(1);
  });

  it("a done row stopped while its result is in flight lands no record", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    let land: (v: JobOutcome<BatchResult>) => void = () => {};
    getJobResult.mockImplementation(() => new Promise((res) => { land = res; }));
    const pass = reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(getJobResult).toHaveBeenCalledTimes(1);
    // The user deletes the lost request's failed record (or retries its file) meanwhile.
    stopOrphan(JOB_A);
    land(ok(RESULT));
    await pass;
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
    expect(ledgerRows()).toEqual([]);
  });

  it("a done row the ledger evicts while its result is in flight still lands", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    let land: (v: JobOutcome<BatchResult>) => void = () => {};
    getJobResult.mockImplementation(() => new Promise((res) => { land = res; }));
    const pass = reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(getJobResult).toHaveBeenCalledTimes(1);
    // New requests push the oldest row past the newest-20 cap: not a stop.
    for (let i = 0; i < 20; i++) await persistRow(row(i.toString(16).padStart(32, "0"), T0 + 1 + i));
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    land(ok(RESULT));
    await pass;
    expect(records().some((x) => x.id === JOB_A)).toBe(true);
  });

  it("not_found writes a failed record with the not-found reason and forgets the row", async () => {
    await seed(row(JOB_A, T0, "url"));
    getJob.mockResolvedValue({ kind: "not_found" });
    await reconcileJobs();
    const rec = records()[0];
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe(NOT_FOUND_ERROR);
    expect(rec.title).toBe("A talk");
    expect(rec.kind).toBe("url");
    expect(ledgerRows()).toEqual([]);
  });

  it("a failed row carries the server's error; a cancelled one says so", async () => {
    await seed(row(JOB_A, T0), row(JOB_B, T0 + 1));
    getJob.mockImplementation(async ({ jobId }) =>
      ok(jobId === JOB_A
        ? { jobId, state: "failed", error: "server restarted" }
        : { jobId, state: "cancelled" }));
    await reconcileJobs();
    const byId = Object.fromEntries(records().map((r) => [r.id, r]));
    expect(byId[JOB_A].error).toBe("server restarted");
    expect(byId[JOB_B].error).toBe("Cancelled");
    expect(ledgerRows()).toEqual([]);
  });

  it("an unreachable server keeps the rows and retries every 30 s", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue({ kind: "error", message: "Could not connect" });
    await reconcileJobs();
    expect(ledgerRows()).toHaveLength(1);
    expect(records()).toEqual([]);
    expect(getJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(ledgerRows()).toHaveLength(1);
  });

  it("a row is asked at its backend's current address, not the one it was posted to", async () => {
    // The key resolves by backend id at call time: the posted address would send the current key
    // to a host the backend no longer points at.
    await seed({ ...row(JOB_A, T0), serverUrl: "http://old:8000" });
    getJob.mockResolvedValue({ kind: "not_found" });
    await reconcileJobs();
    expect((getJob.mock.calls[0][0] as { serverUrl?: string }).serverUrl).toBe("http://localhost:8000");
  });

  it("a done link run copies its media from the backend's current address too", async () => {
    // The ingest's own fetches read the address off the row's ctx: the posted one would send the
    // current key to the old host and the record would land without playback.
    const old = row(JOB_A, T0, "url");
    await seed({ ...old, serverUrl: "http://old:8000", ctx: { ...old.ctx, serverUrl: "http://old:8000" } });
    serveDone(JOB_A, { ...RESULT, sourceMediaId: "m1" });
    await reconcileJobs();
    expect(records().map((r) => r.id)).toEqual([JOB_A]);
    expect(fetchUrlMedia).toHaveBeenCalledTimes(1);
    expect(fetchUrlMedia.mock.calls[0][0]).toMatchObject({ serverUrl: "http://localhost:8000", mediaId: "m1" });
  });

  it("a deleted backend's row is forgotten even when its host is down for another backend", async () => {
    // The deleted backend's row keeps its stored address, which b1 shares; b1's row failing to
    // connect first must not leave it queued for a retry it can never get.
    await seed(row(JOB_A, T0), { ...row(JOB_B, T0 + 1), backendId: "gone" });
    getJob.mockResolvedValue({ kind: "error", message: "timed out" });
    await reconcileJobs();
    expect(getJob.mock.calls.map(([a]) => a.jobId)).toEqual([JOB_A]);
    expect(ledgerRows().map((r) => r.jobId)).toEqual([JOB_A]);
  });

  it("one unreachable server costs one status call per pass, not one per row", async () => {
    // A second backend on another host, whose row b1's unreachable host must not hold back.
    useApp.setState({ backends: [...useApp.getState().backends,
      { id: "b2", name: "Other", serverUrl: "http://other:8000" } as never] });
    const other = { ...row(JOB_C, T0 + 2), backendId: "b2", serverUrl: "http://other:8000" };
    await seed(row(JOB_A, T0), row(JOB_B, T0 + 1), other);
    getJob.mockImplementation(({ jobId }) => Promise.resolve(jobId === JOB_C
      ? { kind: "not_found" } : { kind: "error", message: "timed out" }));
    await reconcileJobs();
    expect(getJob.mock.calls.map(([a]) => a.jobId)).toEqual([JOB_A, JOB_C]);
    // The skipped row is kept for a later pass.
    expect(ledgerRows().map((r) => r.jobId)).toEqual([JOB_A, JOB_B]);
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJob.mock.calls.map(([a]) => a.jobId)).toEqual([JOB_A]);
  });

  it("a per-row error (an HTTP status, an unreadable body) does not hold back the server's other rows", async () => {
    // The server answered (a revoked key at a shared URL, a body Rust can't parse): only the erroring row waits.
    await seed(row(JOB_A, T0), row(JOB_B, T0 + 1), row(JOB_C, T0 + 2));
    getJob.mockImplementation(async ({ jobId }) =>
      jobId === JOB_A
        ? { kind: "error", message: "HTTP 401" }
        : jobId === JOB_B
          ? { kind: "error", message: "missing field `state` at line 1 column 2" }
          : ok({ jobId, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
    await reconcileJobs();
    expect(getJob.mock.calls.map(([a]) => a.jobId)).toEqual([JOB_A, JOB_B, JOB_C]);
    expect(records().map((r) => r.id)).toEqual([JOB_C]);
    // The erroring rows are kept for the retry pass.
    expect(ledgerRows().map((r) => r.jobId)).toEqual([JOB_A, JOB_B]);
  });

  it("isPerRowJobError: answered statuses and body failures are per-row, no answer is per-server", () => {
    for (const m of [
      "HTTP 401", "HTTP 500", "malformed job id",
      "The server sent an unreasonably large response — ignoring it.",
      "The server sent a response that wasn't valid text.",
      "expected value at line 1 column 1", "invalid type: string \"x\", expected f64",
    ]) expect(isPerRowJobError(m)).toBe(true);
    for (const m of [
      "Could not connect — is the server running and the URL correct?",
      "Timed out waiting for the server.", "error sending request", "error decoding response body",
    ]) expect(isPerRowJobError(m)).toBe(false);
  });

  it("a row the ledger evicts mid-pass is still stopped by a re-run of its file", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    let land: (v: JobOutcome<BatchResult>) => void = () => {};
    getJobResult.mockImplementation(() => new Promise((res) => { land = res; }));
    const pass = reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(getJobResult).toHaveBeenCalledTimes(1);
    // A run of other files pushes the row past the newest-20 cap…
    for (let i = 0; i < 20; i++) await persistRow(row(i.toString(16).padStart(32, "0"), T0 + 1 + i));
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    // …then the user re-runs its file: the path-keyed stop must still find it.
    const path = row(JOB_A, T0).path;
    useTranscribeRun.setState({ files: [path], running: false, queue: [] });
    deleteJob.mockClear();
    startRun(undefined, {}, row(JOB_A, T0).ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    land(ok(RESULT));
    await pass;
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
    cancelRun();
  });

  it("drops a row whose backend no longer exists, without a record", async () => {
    await seed({ ...row(JOB_A, T0), backendId: "gone" });
    await reconcileJobs();
    expect(getJob).not.toHaveBeenCalled();
    expect(ledgerRows()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it("a running row re-attaches the rail, folds progress, and ingests on done", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running",
      progress: { stage: "transcribing", progress: 0.4 } }));
    await reconcileJobs();
    const s = useTranscribeRun.getState();
    expect(s.running).toBe(true);
    expect(s.queue).toEqual([{ path: "/aa.mp3", status: "running", kind: "file", title: undefined }]);
    expect(s.lastOptions).toEqual({ translateTo: ["en"] });
    expect(s.stageTimes.transcribing?.start).toBe(T0);
    // The first tick folded the embedded progress into the rail.
    await vi.advanceTimersByTimeAsync(0);
    expect(useTranscribeRun.getState().progress?.stage).toBe("transcribing");
    // Next poll: done → result → the queue row settles and the record opens.
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", createdAt: T0 / 1000,
      finishedAt: T0 / 1000 + 90, resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    const after = useTranscribeRun.getState();
    expect(after.running).toBe(false);
    expect(after.queue[0]).toMatchObject({ status: "done", tookMs: 90_000 });
    expect(after.openRecordId).toBe(JOB_A);
    expect(after.stageTimes.transcribing?.end).toBeDefined();
    expect(records()).toHaveLength(1);
    expect(ledgerRows()).toEqual([]);
  });

  it("Cancel on a re-attached run goes to the backend's address at cancel time", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    expect(useTranscribeRun.getState().running).toBe(true);
    // The user edits the backend's address while the resumed run is on screen.
    useApp.setState({ backends: [{ id: "b1", name: "Local", serverUrl: "http://new:8000" } as never] });
    cancelRun();
    expect(cancelBackendTranscription).toHaveBeenCalledTimes(1);
    // A plain object over the IPC: the resolver never crosses it.
    expect(cancelBackendTranscription.mock.calls[0][0]).toEqual({
      serverUrl: "http://new:8000", backendId: "b1", progressId: JOB_A,
    });
  });

  it("two running rows: the newest owns the rail, the older is watched headless", async () => {
    await seed(row(JOB_A, T0), row(JOB_B, T0 + 5_000));
    getJob.mockImplementation(async ({ jobId }) => ok({ jobId, state: "running" }));
    await reconcileJobs();
    expect(useTranscribeRun.getState().queue[0].path).toBe("/bb.mp3");
    // Both are polled: the rail's every second, the headless one every 5 s.
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    const polled = getJob.mock.calls.map((c) => c[0].jobId);
    expect(polled.filter((id) => id === JOB_A)).toHaveLength(1);
    expect(polled.filter((id) => id === JOB_B)).toHaveLength(5);
    // The older one finishing lands in History only.
    getJob.mockImplementation(async ({ jobId }) =>
      ok(jobId === JOB_A ? { jobId, state: "done", resultAvailable: true } : { jobId, state: "running" }));
    getJobResult.mockResolvedValue(ok(RESULT));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(records().map((r) => r.id)).toEqual([JOB_A]);
    expect(useTranscribeRun.getState().running).toBe(true);
    expect(useTranscribeRun.getState().queue[0]).toMatchObject({ path: "/bb.mp3", status: "running" });
    cancelRun();
  });

  it("a running row is watched headless when the user already picked files", async () => {
    await seed(row(JOB_A, T0));
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    let s = useTranscribeRun.getState();
    expect(s.files).toEqual(["/picked.wav"]);
    expect(s.queue).toEqual([]);
    expect(s.running).toBe(false);
    // Done: the record lands in History; the workbench is left alone.
    serveDone();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(records().map((r) => r.id)).toEqual([JOB_A]);
    s = useTranscribeRun.getState();
    expect(s.files).toEqual(["/picked.wav"]);
    expect(s.queue).toEqual([]);
    expect(s.openRecordId).toBeNull();
    expect(ledgerRows()).toEqual([]);
  });

  it("cancelling a re-attached run stops the watcher, tells the server, forgets the row", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    expect(useTranscribeRun.getState().running).toBe(true);
    getJob.mockClear();
    cancelRun();
    expect(cancelBackendTranscription).toHaveBeenCalledWith(expect.objectContaining({
      progressId: JOB_A, serverUrl: "http://localhost:8000", backendId: "b1" }));
    expect(useTranscribeRun.getState().running).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerRows()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("a re-attached run whose backend is deleted settles failed instead of polling for days", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(useTranscribeRun.getState().running).toBe(true);
    // The user deletes the backend while the resumed run is on screen.
    useApp.setState({ backends: [] });
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useTranscribeRun.getState().running).toBe(false);
    expect(useTranscribeRun.getState().queue[0]).toMatchObject({ status: "failed", error: BACKEND_GONE_ERROR });
    expect(ledgerRows()).toEqual([]);
    expect(records().map((r) => [r.id, r.status, r.error])).toEqual([[JOB_A, "failed", BACKEND_GONE_ERROR]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("a lost request whose backend is deleted settles its failed record and queue row with the reason", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    // The pump's lost-contact catch already left a failed queue row naming the orphan job.
    useTranscribeRun.setState({ queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob).toHaveBeenCalledTimes(1);
    useApp.setState({ backends: [] });
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ledgerRows()).toEqual([]);
    expect(records().map((x) => [x.id, x.status, x.error])).toEqual([[JOB_A, "failed", BACKEND_GONE_ERROR]]);
    const it0 = useTranscribeRun.getState().queue[0];
    expect([it0.status, it0.error, it0.orphanJobId]).toEqual(["failed", BACKEND_GONE_ERROR, undefined]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("an earlier launch's headless row whose backend is deleted is forgotten, without a record", async () => {
    await seed(row(JOB_A, T0));
    // A non-idle workbench: the reconcile pass watches the running row headless.
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(useTranscribeRun.getState().running).toBe(false);
    useApp.setState({ backends: [] });
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ledgerRows()).toEqual([]);
    expect(records()).toEqual([]);
    expect(useTranscribeRun.getState().queue).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("an earlier launch's lost request whose backend is deleted settles its failed record with the reason", async () => {
    const rec = await seedLost();
    useTranscriptHistory.setState({ records: [rec] });
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    useApp.setState({ backends: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ledgerRows()).toEqual([]);
    expect(records().map((x) => [x.id, x.status, x.error])).toEqual([[JOB_A, "failed", BACKEND_GONE_ERROR]]);
  });

  it("the reconcile pass settles an earlier launch's lost record whose backend is gone", async () => {
    const rec = await seedLost();
    // At launch nothing has loaded History yet (the app opens on the Dashboard): the record is on disk only.
    useTranscriptHistory.setState({ records: [], loaded: false });
    listTranscriptRecords.mockResolvedValueOnce([rec]);
    useApp.setState({ backends: [] });
    await reconcileJobs();
    expect(getJob).not.toHaveBeenCalled();
    expect(ledgerRows()).toEqual([]);
    expect(records().map((x) => [x.id, x.status, x.error])).toEqual([[JOB_A, "failed", BACKEND_GONE_ERROR]]);
  });

  it("a failed History listing keeps a gone backend's row; a later pass settles its record", async () => {
    const rec = await seedLost();
    useTranscriptHistory.setState({ records: [], loaded: false });
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    useApp.setState({ backends: [] });
    await reconcileJobs();
    // Unknown whether a record stands: forgetting the row now would lose its settle for good.
    expect(ledgerRows().map((x) => x.jobId)).toEqual([JOB_A]);
    expect(records()).toEqual([]);
    listTranscriptRecords.mockResolvedValueOnce([rec]);
    await vi.advanceTimersByTimeAsync(30_000); // the retry pass lists again
    expect(ledgerRows()).toEqual([]);
    expect(records().map((x) => [x.id, x.status, x.error])).toEqual([[JOB_A, "failed", BACKEND_GONE_ERROR]]);
  });

  it("a gone backend's headless row is kept when the History listing fails, and settled by the retry pass it schedules", async () => {
    const rec = await seedLost();
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    useTranscriptHistory.setState({ records: [], loaded: false });
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    useApp.setState({ backends: [] });
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ledgerRows().map((x) => x.jobId)).toEqual([JOB_A]);
    expect(records()).toEqual([]);
    // The watcher ended all the same (nothing polls a backend that is gone), but it scheduled a
    // reconcile pass, which lists again and settles the record.
    listTranscriptRecords.mockResolvedValueOnce([rec]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJob).not.toHaveBeenCalled();
    expect(ledgerRows()).toEqual([]);
    expect(records().map((x) => [x.id, x.status, x.error])).toEqual([[JOB_A, "failed", BACKEND_GONE_ERROR]]);
  });

  it("a retry the headless watcher schedules while a pass is in flight runs after that pass", async () => {
    const rec = await seedLost(row(JOB_B, T0 + 1));
    // A non-idle workbench: A is watched headless; B's per-row error arms the retry timer.
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    let resolveB: (v: JobOutcome<JobStatus>) => void = () => {};
    let bCalls = 0;
    getJob.mockImplementation(({ jobId }) => {
      if (jobId === JOB_A) return Promise.resolve(ok({ jobId, state: "running" }));
      bCalls += 1;
      return bCalls === 1
        ? Promise.resolve({ kind: "error", message: "HTTP 500" })
        : new Promise((res) => { resolveB = res; });
    });
    await reconcileJobs();
    // The retry pass starts and hangs on B's status.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bCalls).toBe(2);
    // A's backend goes while the History listing fails: the watcher keeps the row and arms the timer.
    useTranscriptHistory.setState({ records: [], loaded: false });
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    useApp.setState({ backends: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ledgerRows().map((x) => x.jobId)).toEqual([JOB_A, JOB_B]);
    // That timer fires while the pass is still in flight, which then ends with nothing to retry.
    await vi.advanceTimersByTimeAsync(30_000);
    // The timer already waited: its pass runs right after the in-flight one, lists again and
    // settles A's record — no second 30 s wait.
    listTranscriptRecords.mockResolvedValueOnce([rec]);
    resolveB({ kind: "not_found" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerRows()).toEqual([]);
    expect(records().find((x) => x.id === JOB_A)).toMatchObject({ status: "failed", error: BACKEND_GONE_ERROR });
  });

  it("the last retry of the launch's budget firing mid-pass still runs its pass", async () => {
    const rec = await seedLost(row(JOB_B, T0 + 1));
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    let resolveB: (v: JobOutcome<JobStatus>) => void = () => {};
    let bCalls = 0;
    // B fails per row on 19 passes (19 timers spent), then hangs on the 20th.
    getJob.mockImplementation(({ jobId }) => {
      if (jobId === JOB_A) return Promise.resolve(ok({ jobId, state: "running" }));
      bCalls += 1;
      return bCalls < 20
        ? Promise.resolve({ kind: "error", message: "HTTP 500" })
        : new Promise((res) => { resolveB = res; });
    });
    await reconcileJobs();
    while (bCalls < 20) await vi.advanceTimersByTimeAsync(30_000);
    // A's backend goes while the listing fails: its watcher arms the 20th and last timer.
    useTranscriptHistory.setState({ records: [], loaded: false });
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    useApp.setState({ backends: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000); // it fires while B's pass is still in flight
    listTranscriptRecords.mockResolvedValueOnce([rec]);
    resolveB({ kind: "not_found" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerRows()).toEqual([]);
    expect(records().find((x) => x.id === JOB_A)).toMatchObject({ status: "failed", error: BACKEND_GONE_ERROR });
  });

  it("a gone backend's row stopped during the History listing settles nothing", async () => {
    const rec = await seedLost();
    useTranscriptHistory.setState({ records: [], loaded: false });
    let resolveListing: (v: unknown[]) => void = () => {};
    listTranscriptRecords.mockReturnValueOnce(new Promise<unknown[]>((res) => { resolveListing = res; }));
    useApp.setState({ backends: [] });
    const pass = reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    // The user re-runs the file (or deletes the record) while the launch's listing is pending.
    stopOrphan(JOB_A);
    resolveListing([rec]);
    await pass;
    expect(ledgerRows()).toEqual([]);
    // The old job does not re-point the file: its record keeps the error it had.
    expect(records().map((x) => [x.id, x.status, x.error])).toEqual([[JOB_A, "failed", "timed out"]]);
  });

  it("a done status whose result is not published yet re-polls, then ingests", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    // The result endpoint still answers 409 on the first try.
    getJobResult.mockResolvedValueOnce({ kind: "running" }).mockResolvedValue(ok(RESULT));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJobResult).toHaveBeenCalledTimes(1);
    expect(records()).toEqual([]);
    expect(ledgerRows()).toHaveLength(1);
    expect(useTranscribeRun.getState().running).toBe(true);
    // A later poll fetches it and settles the rail.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(getJobResult).toHaveBeenCalledTimes(2);
    expect(records().map((r) => r.id)).toEqual([JOB_A]);
    expect(ledgerRows()).toEqual([]);
    expect(useTranscribeRun.getState().running).toBe(false);
  });

  it("a result fetch that keeps failing backs off, and still gives up past the row's age limit", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    const at: number[] = [];
    getJobResult.mockImplementation(async () => {
      at.push(Date.now());
      return { kind: "error", message: "Could not connect" };
    });
    await vi.advanceTimersByTimeAsync(120_000);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...gaps)).toBe(30_000);
    expect(ledgerRows()).toHaveLength(1);
    // Past the ledger's age limit the watcher fails the run instead of polling forever.
    vi.setSystemTime(T0 + maxAgeMs(row(JOB_A, T0)) + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(records()[0]).toMatchObject({ id: JOB_A, status: "failed" });
    expect(ledgerRows()).toEqual([]);
    expect(useTranscribeRun.getState().running).toBe(false);
    const calls = getJobResult.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJobResult).toHaveBeenCalledTimes(calls);
  });

  it("a stored result Rust can never read settles the run failed instead of re-polling", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(useTranscribeRun.getState().running).toBe(true);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue({
      kind: "error", message: "The server sent an unreasonably large response — ignoring it.",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJobResult).toHaveBeenCalledTimes(1);
    expect(records().map((r) => [r.id, r.status, r.error])).toEqual([[
      JOB_A, "failed",
      "The server's result could not be read: The server sent an unreasonably large response — ignoring it.",
    ]]);
    expect(ledgerRows()).toEqual([]);
    expect(useTranscribeRun.getState().running).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJobResult).toHaveBeenCalledTimes(1);
  });

  it("a reconcile pass settles an unreadable stored result once, but retries an HTTP status", async () => {
    await seed(row(JOB_A, T0), row(JOB_B, T0 + 1));
    getJob.mockImplementation(async ({ jobId }) => ok({ jobId, state: "done", resultAvailable: true }));
    getJobResult.mockImplementation(async ({ jobId }) => jobId === JOB_A
      ? { kind: "error", message: "missing field `text` at line 1 column 2" }
      : { kind: "error", message: "HTTP 500" });
    await reconcileJobs();
    expect(records().map((r) => [r.id, r.status])).toEqual([[JOB_A, "failed"]]);
    expect(ledgerRows().map((r) => r.jobId)).toEqual([JOB_B]);
  });

  it("a row from a long-TTL server is still watched past the 72 h default", async () => {
    const long = row(JOB_A, T0);
    long.ctx = { ...long.ctx, jobsTtlS: 7 * 86_400 };
    await seed(long);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(T0 + 100 * 3_600_000);
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJob).toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(1);
    expect(records()).toEqual([]);
    vi.setSystemTime(T0 + maxAgeMs(long) + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(records()[0]).toMatchObject({ id: JOB_A, status: "failed" });
    expect(ledgerRows()).toEqual([]);
  });

  it("cancelling after a failed result fetch still forgets the row", async () => {
    await seed(row(JOB_A, T0));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue({ kind: "error", message: "Could not connect" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJobResult).toHaveBeenCalledTimes(1);
    getJob.mockClear();
    cancelRun();
    expect(useTranscribeRun.getState().running).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerRows()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob).not.toHaveBeenCalled();
  });

  for (const outcome of ["error", "ok"] as const) {
    it(`cancelling while a re-attached run's result is in flight releases the rail (${outcome})`, async () => {
      await seed(row(JOB_A, T0));
      getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
      await reconcileJobs();
      await vi.advanceTimersByTimeAsync(0);
      getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
      let resolve!: (r: JobOutcome<BatchResult>) => void;
      getJobResult.mockImplementation(() => new Promise((res) => { resolve = res; }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getJobResult).toHaveBeenCalledTimes(1);
      getJob.mockClear();
      cancelRun();
      resolve(outcome === "ok" ? ok(RESULT) : { kind: "error", message: "Could not connect" });
      await vi.advanceTimersByTimeAsync(0);
      const s = useTranscribeRun.getState();
      expect(s.running).toBe(false);
      expect(s.queue[0].status).toBe("cancelled");
      expect(ledgerRows()).toEqual([]);
      expect(records()).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getJob).not.toHaveBeenCalled();
    });
  }

  it("a retry pass never starts a second watcher for a row already being watched", async () => {
    await seed(row(JOB_A, T0), row(JOB_B, T0 + 1));
    getJob.mockImplementation(async ({ jobId }) =>
      jobId === JOB_A ? ok({ jobId, state: "running" }) : { kind: "error", message: "Could not connect" });
    await reconcileJobs();
    expect(useTranscribeRun.getState().running).toBe(true);
    // The 30 s retry pass (for B) re-reads the ledger, where A still sits.
    await vi.advanceTimersByTimeAsync(30_000);
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJob.mock.calls.filter((c) => c[0].jobId === JOB_A)).toHaveLength(1);
    // After a cancel no orphaned watcher writes a "Cancelled" record for A.
    cancelRun();
    getJob.mockImplementation(async ({ jobId }) =>
      jobId === JOB_A ? ok({ jobId, state: "cancelled" }) : { kind: "error", message: "Could not connect" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(records().filter((r) => r.id === JOB_A)).toEqual([]);
  });

  it("a ledger the launch could not read is read again by the retry pass, and its rows are reconciled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadJobsLedger.mockRejectedValueOnce("jobs ledger unreadable: Permission denied");
    loadJobsLedger.mockRejectedValueOnce("jobs ledger unreadable: Permission denied");
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [row(JOB_A, T0)] }));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "cancelled" }));
    await initJobReconcile();
    expect(getJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJob.mock.calls.map((c) => c[0].jobId)).toEqual([JOB_A]);
    expect(records().find((r) => r.id === JOB_A)?.status).toBe("failed");
    expect(ledgerRows()).toEqual([]);
  });

  it("a ledger first read by a later save is reconciled then, not only at the next launch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadJobsLedger.mockImplementation(() => Promise.reject("jobs ledger unreadable: Permission denied"));
    getJob.mockImplementation(async ({ jobId }) => ok({ jobId, state: "cancelled" }));
    await initJobReconcile();
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [row(JOB_A, T0)] }));
    // This session's own request: its save is the read that lands.
    await persistRow(row(JOB_C, Date.now() + 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob.mock.calls.map((c) => c[0].jobId)).toEqual([JOB_A]);
    expect(records().find((r) => r.id === JOB_A)?.status).toBe("failed");
  });

  it("a record deleted while the launch's ledger read failed is forgotten and cancelled by the late pass", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadJobsLedger.mockImplementation(() => Promise.reject("jobs ledger unreadable: Permission denied"));
    await initJobReconcile();
    const r = row(JOB_A, T0);
    useTranscriptHistory.setState({ records: [lostFailedRecord(r)] });
    deleteJob.mockClear();
    deleteRecord(JOB_A);
    // stopOrphan had no row to find yet.
    expect(deleteJob).not.toHaveBeenCalled();
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [r] }));
    serveDone();
    saveJobsLedger.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    // The saved ledger drops it too, so the next launch does not reconcile it back.
    const saved = saveJobsLedger.mock.calls[saveJobsLedger.mock.calls.length - 1]?.[0] as { rows: LedgerRow[] } | undefined;
    expect(saved?.rows.some((x) => x.jobId === JOB_A)).toBe(false);
    expect(getJobResult).not.toHaveBeenCalled();
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
  });

  it("a retry pass skips rows the pump persisted during this launch", async () => {
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [row(JOB_B, T0)] }));
    getJob.mockResolvedValue({ kind: "error", message: "Could not connect" });
    await initJobReconcile();
    await persistRow(row(JOB_C, Date.now() + 1));
    await vi.advanceTimersByTimeAsync(30_000);
    const polled = getJob.mock.calls.map((c) => c[0].jobId);
    expect(polled.filter((id) => id === JOB_B).length).toBeGreaterThanOrEqual(2);
    expect(polled).not.toContain(JOB_C);
  });

  it("a headless done link whose video was still downloading polls for it under the job id", async () => {
    await seed(row(JOB_A, T0, "url"));
    serveDone(JOB_A, { ...RESULT, sourceVideoPending: true });
    await reconcileJobs();
    expect(records()[0].id).toBe(JOB_A);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getTranscribeProgress).toHaveBeenCalledWith(expect.objectContaining({ progressId: JOB_A }));
    // Headless: the poll never paints the rail.
    expect(useTranscribeRun.getState().stageMeta).toEqual({});
  });

  it("a headless video poll runs at the headless watcher's 5 s cadence, not once a second", async () => {
    await seed(row(JOB_A, T0, "url"));
    serveDone(JOB_A, { ...RESULT, sourceVideoPending: true });
    getTranscribeProgress.mockImplementation(() =>
      Promise.resolve({ stage: "done", video: { state: "downloading", downloaded: 1, total: 10 } }));
    try {
      await reconcileJobs();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(2);
    } finally {
      // Settle the poller so it does not outlive the test.
      getTranscribeProgress.mockImplementation(() => Promise.resolve({ stage: "unknown" }));
      await vi.advanceTimersByTimeAsync(6_000);
    }
  });

  it("deleting a headless link whose video is still downloading stops its video poll", async () => {
    await seed(row(JOB_A, T0, "url"));
    serveDone(JOB_A, { ...RESULT, sourceVideoPending: true });
    getTranscribeProgress.mockImplementation(() =>
      Promise.resolve({ stage: "done", video: { state: "downloading", downloaded: 1, total: 10 } }));
    try {
      await reconcileJobs();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(1);
      deleteRecord(JOB_A);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(1);
    } finally {
      getTranscribeProgress.mockImplementation(() => Promise.resolve({ stage: "unknown" }));
      await vi.advanceTimersByTimeAsync(6_000);
    }
  });

  it("a lost request's job is watched headless and its transcript lands under the job id", async () => {
    await persistRow(row(JOB_A, Date.now()));
    serveDone();
    watchOrphan(JOB_A);
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(records().map((r) => [r.id, r.status])).toEqual([[JOB_A, "done"]]);
    expect(ledgerRows()).toEqual([]);
    // Headless: the rail was not touched.
    expect(useTranscribeRun.getState().queue).toEqual([]);
  });

  it("a lost request's watcher settles its still-failed queue row when the server finishes", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    useTranscribeRun.setState({ queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    serveDone();
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    const it0 = useTranscribeRun.getState().queue[0];
    expect([it0.status, it0.error, it0.orphanJobId]).toEqual(["done", undefined, undefined]);
    expect(it0.result?.text).toBe("hallo welt");
  });

  it("retrying a lost request's row stops its orphan watcher, forgets the row, cancels the job", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    useTranscribeRun.setState({ files: [r.path], running: false, lastOptions: undefined,
      queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob).toHaveBeenCalledTimes(1);
    deleteJob.mockClear();
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    expect(useTranscribeRun.getState().queue[0].orphanJobId).toBeUndefined();
    // The old job's watcher is gone: no more polls, its row is forgotten, and the
    // job can't land a record under the old id.
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
  });

  /** Watch JOB_A as a lost request, then push it out of the ledger with 20 newer rows
   *  (a big lost batch): only the watcher still knows the job. */
  async function watchEvicted() {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) await persistRow({ ...row((i + 16).toString(16).repeat(16), Date.now()), path: `/n${i}.mp3` });
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    deleteJob.mockClear();
    return r;
  }

  it("a retry stops a lost request's watcher after the ledger evicted its row", async () => {
    const r = await watchEvicted();
    useTranscribeRun.setState({ files: [r.path], running: false, lastOptions: undefined,
      queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
  });

  it("deleting a lost request's record stops its watcher after the ledger evicted its row", async () => {
    await watchEvicted();
    forgetRecord(JOB_A);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
  });

  it("starting a new run over a lost request's row stops its orphan watcher too", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    useTranscribeRun.setState({ files: [r.path], running: false,
      queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    deleteJob.mockClear();
    startRun(undefined, {}, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
  });

  it("a lost request opened from History settles its row and a retry stops its watcher", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    const rec = lostFailedRecord(r);
    expect(openHistoryRecord(rec)).toBe(true);
    // The rebuilt row still names the job, so the watcher's ingest would settle it.
    expect(useTranscribeRun.getState().queue[0].orphanJobId).toBe(JOB_A);
    deleteJob.mockClear();
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records().some((x) => x.id === JOB_A && x.status === "done")).toBe(false);
  });

  it("a lost request reconciled headless after a restart is stopped by a retry from History", async () => {
    const r = row(JOB_A, T0);
    await seed(r);
    // Not idle: the row is watched headless, not re-attached.
    useTranscribeRun.setState({ files: ["/picked.wav"] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    await reconcileJobs();
    expect(useTranscribeRun.getState().queue).toEqual([]);
    const rec = lostFailedRecord(r);
    expect(openHistoryRecord(rec)).toBe(true);
    deleteJob.mockClear();
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records().some((x) => x.id === JOB_A && x.status === "done")).toBe(false);
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
  });

  it("a lost request's watcher is stopped by a re-run of its file after the workbench was closed", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    useTranscribeRun.setState({ queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    closeRecord();
    expect(useTranscribeRun.getState().queue).toEqual([]);
    useTranscribeRun.setState({ files: [r.path] });
    deleteJob.mockClear();
    startRun(undefined, {}, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
  });

  it("a new run of OTHER files leaves a removed file's lost request watched", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    // removeFile kept the settled failed row, but the file is no longer in the list.
    useTranscribeRun.setState({ files: ["/other.mp3"], running: false,
      queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    deleteJob.mockClear();
    startRun(undefined, {}, r.ctx);
    expect(deleteJob).not.toHaveBeenCalled();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toHaveLength(1);
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(true);
    stopOrphan(JOB_A);
  });

  it("a lost request whose job then fails on the server names the server's reason on its row", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    useTranscribeRun.setState({ queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_A }] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "failed", error: "CUDA out of memory" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    const it0 = useTranscribeRun.getState().queue[0];
    expect([it0.status, it0.error, it0.orphanJobId]).toEqual(["failed", "CUDA out of memory", undefined]);
    expect(records().find((x) => x.id === JOB_A)?.error).toBe("CUDA out of memory");
    expect(ledgerRows()).toEqual([]);
  });

  it("deleting a lost request's failed record stops its watcher, so the finished job can't re-add it", async () => {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    const rec = lostFailedRecord(r);
    useTranscriptHistory.setState({ records: [rec] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    deleteJob.mockClear();
    deleteRecord(JOB_A);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
  });

  /** A watched lost request with its failed record in History; `register` = this launch
   *  registered the record (opened from History), else only the mirror holds it. */
  async function watchLostFailed(register: boolean) {
    const r = row(JOB_A, Date.now());
    await persistRow(r);
    const rec = lostFailedRecord(r);
    useTranscriptHistory.setState({ records: [rec] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    if (register) expect(openHistoryRecord(rec)).toBe(true);
    deleteJob.mockClear();
  }

  async function expectNoReAdd() {
    serveDone();
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records()).toEqual([]);
  }

  it("clearing every record stops a lost request's watcher, so the finished job can't re-add it", async () => {
    await watchLostFailed(false);
    forgetRecord(null, { deleted: true });
    useTranscriptHistory.setState({ records: [] }); // the clear itself
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    await expectNoReAdd();
  });

  it("clearing every record stops a registered lost request even when the mirror dropped it first", async () => {
    await watchLostFailed(true);
    useTranscriptHistory.setState({ records: [] });
    forgetRecord(null, { deleted: true });
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    await expectNoReAdd();
  });

  it("a bulk forget that keeps the records (a storage move) leaves the lost request watched", async () => {
    await watchLostFailed(true);
    forgetRecord(null);
    expect(deleteJob).not.toHaveBeenCalled();
    serveDone();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(records().map((x) => [x.id, x.status])).toEqual([[JOB_A, "done"]]);
  });

  it("a retry stops an earlier launch's lost request that reconcile could not reach yet", async () => {
    const r = row(JOB_B, T0);
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [r] }));
    getJob.mockResolvedValue({ kind: "error", message: "Could not connect" });
    await initJobReconcile();
    expect(ledgerRows()).toHaveLength(1);
    useTranscribeRun.setState({ files: [r.path], running: false,
      queue: [{ path: r.path, status: "failed", error: "timed out", orphanJobId: JOB_B }] });
    deleteJob.mockClear();
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_B }));
    expect(ledgerRows().some((x) => x.jobId === JOB_B)).toBe(false);
    // The 30 s retry pass no longer finds it: nothing is fetched or ingested.
    serveDone(JOB_B);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJobResult).not.toHaveBeenCalled();
    expect(records().some((x) => x.id === JOB_B)).toBe(false);
  });

  it("a row stopped while reconcile awaits its status is neither re-attached nor watched", async () => {
    await seed(row(JOB_A, T0));
    let answer!: (v: JobOutcome<JobStatus>) => void;
    getJob.mockImplementationOnce(() => new Promise((res) => { answer = res; }));
    const pass = reconcileJobs();
    await vi.advanceTimersByTimeAsync(0);
    stopOrphan(JOB_A);
    answer(ok({ jobId: JOB_A, state: "running" }));
    await pass;
    expect(useTranscribeRun.getState().running).toBe(false);
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("initJobReconcile loads the persisted ledger after configReady, once", async () => {
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [row(JOB_A, T0)] }));
    getJob.mockResolvedValue({ kind: "not_found" });
    await initJobReconcile();
    await initJobReconcile();
    expect(loadJobsLedger).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(1);
  });
});
