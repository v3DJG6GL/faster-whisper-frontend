// The ledger file exists but can't be read (a Windows AV lock at launch): the next save
// must not replace an earlier launch's rows with this session's.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedgerRow } from "./jobsLedger";

const loadJobsLedger = vi.fn<() => Promise<unknown>>();
const saveJobsLedger = vi.fn<(l: unknown) => Promise<void>>(() => Promise.resolve());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  isTauri: true,
  loadJobsLedger: () => loadJobsLedger(),
  saveJobsLedger: (l: unknown) => saveJobsLedger(l),
}));

const { _resetLedgerForTests, initLedger, persistRow } = await import("./jobsLedger");

const OLD = "a".repeat(32);
const MINE = "b".repeat(32);

function row(jobId: string): LedgerRow {
  return {
    v: 1,
    jobId,
    backendId: "b1",
    serverUrl: "http://localhost:8000",
    path: `/${jobId}.mp3`,
    kind: "file",
    ctx: { backendId: "b1", serverUrl: "http://localhost:8000", model: "large-v3", language: "", standard: false },
    startedAt: Date.now(),
  };
}

beforeEach(() => {
  _resetLedgerForTests();
  loadJobsLedger.mockReset();
  saveJobsLedger.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("an unreadable ledger file", () => {
  it("is not saved over while it still can't be read", async () => {
    loadJobsLedger.mockRejectedValue("jobs ledger unreadable: Permission denied");
    await initLedger();
    await persistRow(row(MINE));
    expect(saveJobsLedger).not.toHaveBeenCalled();
  });

  it("is read again on the next save, and its rows are kept beside this session's", async () => {
    loadJobsLedger.mockRejectedValueOnce("jobs ledger unreadable: Permission denied");
    await initLedger();
    loadJobsLedger.mockResolvedValue({ v: 1, rows: [row(OLD)] });
    await persistRow(row(MINE));
    expect(saveJobsLedger).toHaveBeenCalledTimes(1);
    const saved = saveJobsLedger.mock.calls[0][0] as { rows: LedgerRow[] };
    expect(saved.rows.map((r) => r.jobId)).toEqual([OLD, MINE]);
  });
});
