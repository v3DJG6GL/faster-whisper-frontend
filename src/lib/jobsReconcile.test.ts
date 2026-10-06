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
const cancelBackendTranscription = vi.fn(() => Promise.resolve());
const deleteJob = vi.fn((_args: { jobId: string }) => Promise.resolve({ kind: "ok", value: null }));
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
  cancelBackendTranscription: () => cancelBackendTranscription(),
  deleteJob: (a: { jobId: string }) => deleteJob(a),
  getTranscribeProgress: (a: { progressId: string }) => getTranscribeProgress(a),
  // Media copies are best-effort side effects; keep them inert here.
  saveTranscriptMedia: () => Promise.resolve(null),
  fetchUrlMedia: () => Promise.resolve(null),
  fetchUrlVideo: () => Promise.resolve(null),
}));
vi.mock("./persistence", () => ({ configReady: Promise.resolve() }));

const { _resetLedgerForTests, ledgerRows, persistRow, maxAgeMs } = await import("./jobsLedger");
const { _resetReconcileForTests, initJobReconcile, reconcileJobs, stopOrphan, watchOrphan, NOT_FOUND_ERROR } =
  await import("./jobsReconcile");
const { useTranscribeRun, forgetRecord, cancelRun, closeRecord, openHistoryRecord, retryFile, startRun } =
  await import("./transcribeRun");
const { useTranscriptHistory, deleteRecord } = await import("./transcript/transcriptHistory");
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

function records() {
  return useTranscriptHistory.getState().records;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 60_000);
  vi.stubGlobal("window", globalThis);
  _resetLedgerForTests();
  _resetReconcileForTests();
  forgetRecord(null);
  useTranscriptHistory.setState({ records: [], loaded: true });
  useTranscribeRun.setState({ files: [], queue: [], progress: null, stageTimes: {}, stageMeta: {},
    running: false, selectedPath: null, openRecordId: null });
  useApp.setState({ configLoaded: true, configLoadFailed: false,
    backends: [{ id: "b1", name: "Local", serverUrl: "http://localhost:8000" } as never] });
  getJob.mockReset();
  getJobResult.mockReset();
  getTranscribeProgress.mockClear();
  saveTranscriptRecord.mockClear();
  saveJobsLedger.mockClear();
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
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
    expect(cancelBackendTranscription).toHaveBeenCalled();
    expect(useTranscribeRun.getState().running).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerRows()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getJob).not.toHaveBeenCalled();
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
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok({ ...RESULT, sourceVideoPending: true }));
    await reconcileJobs();
    expect(records()[0].id).toBe(JOB_A);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getTranscribeProgress).toHaveBeenCalledWith(expect.objectContaining({ progressId: JOB_A }));
    // Headless: the poll never paints the rail.
    expect(useTranscribeRun.getState().stageMeta).toEqual({});
  });

  it("a headless video poll runs at the headless watcher's 5 s cadence, not once a second", async () => {
    await seed(row(JOB_A, T0, "url"));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok({ ...RESULT, sourceVideoPending: true }));
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

  it("a lost request's job is watched headless and its transcript lands under the job id", async () => {
    await persistRow(row(JOB_A, Date.now()));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
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
    const rec: TranscriptRecord = { schemaVersion: 1, kind: "file", id: JOB_A, createdAt: new Date(r.startedAt).toISOString(),
      sourcePath: r.path, sourceName: r.path, status: "failed", error: "timed out" };
    expect(openHistoryRecord(rec)).toBe(true);
    // The rebuilt row still names the job, so the watcher's ingest would settle it.
    expect(useTranscribeRun.getState().queue[0].orphanJobId).toBe(JOB_A);
    deleteJob.mockClear();
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
    const rec: TranscriptRecord = { schemaVersion: 1, kind: "file", id: JOB_A, createdAt: new Date(r.startedAt).toISOString(),
      sourcePath: r.path, sourceName: r.path, status: "failed", error: "timed out" };
    expect(openHistoryRecord(rec)).toBe(true);
    deleteJob.mockClear();
    retryFile(r.path, r.ctx);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
    const rec: TranscriptRecord = { schemaVersion: 1, kind: "file", id: JOB_A, createdAt: new Date(r.startedAt).toISOString(),
      sourcePath: r.path, sourceName: r.path, status: "failed", error: "timed out" };
    useTranscriptHistory.setState({ records: [rec] });
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "running" }));
    watchOrphan(JOB_A);
    await vi.advanceTimersByTimeAsync(0);
    deleteJob.mockClear();
    deleteRecord(JOB_A);
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_A }));
    expect(ledgerRows().some((x) => x.jobId === JOB_A)).toBe(false);
    getJob.mockResolvedValue(ok({ jobId: JOB_A, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJob.mock.calls.filter(([a]) => a.jobId === JOB_A)).toEqual([]);
    expect(records().some((x) => x.id === JOB_A)).toBe(false);
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
    getJob.mockResolvedValue(ok({ jobId: JOB_B, state: "done", resultAvailable: true }));
    getJobResult.mockResolvedValue(ok(RESULT));
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
