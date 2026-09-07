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
  // Media copies are best-effort side effects; keep them inert here.
  saveTranscriptMedia: () => Promise.resolve(null),
  fetchUrlMedia: () => Promise.resolve(null),
  fetchUrlVideo: () => Promise.resolve(null),
}));
vi.mock("./persistence", () => ({ configReady: Promise.resolve() }));

const { _resetLedgerForTests, ledgerRows, persistRow } = await import("./jobsLedger");
const { _resetReconcileForTests, initJobReconcile, reconcileJobs, NOT_FOUND_ERROR } =
  await import("./jobsReconcile");
const { useTranscribeRun, forgetRecord, cancelRun } = await import("./transcribeRun");
const { useTranscriptHistory } = await import("./transcriptHistory");
const { useApp } = await import("./store");
type LedgerRow = import("./jobsLedger").LedgerRow;

const T0 = 1_800_000_000_000;
const JOB_A = "a".repeat(32);
const JOB_B = "b".repeat(32);

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
    // Both are polled.
    getJob.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    const polled = getJob.mock.calls.map((c) => c[0].jobId).sort();
    expect(polled).toEqual([JOB_A, JOB_B]);
    // The older one finishing lands in History only.
    getJob.mockImplementation(async ({ jobId }) =>
      ok(jobId === JOB_A ? { jobId, state: "done", resultAvailable: true } : { jobId, state: "running" }));
    getJobResult.mockResolvedValue(ok(RESULT));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(records().map((r) => r.id)).toEqual([JOB_A]);
    expect(useTranscribeRun.getState().running).toBe(true);
    expect(useTranscribeRun.getState().queue[0]).toMatchObject({ path: "/bb.mp3", status: "running" });
    cancelRun();
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

  it("initJobReconcile loads the persisted ledger after configReady, once", async () => {
    loadJobsLedger.mockImplementation(() => Promise.resolve({ v: 1, rows: [row(JOB_A, T0)] }));
    getJob.mockResolvedValue({ kind: "not_found" });
    await initJobReconcile();
    await initJobReconcile();
    expect(loadJobsLedger).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(1);
  });
});
