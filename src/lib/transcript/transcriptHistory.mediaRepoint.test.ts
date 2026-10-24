// An audio-folder move rewrites the records' media paths on disk, and Rust re-points every
// later save that still names a moved path (MOVED, save_transcript_record). The History
// mirror is not on disk: a translate chunk parked or upserted around the move's forced reload
// would replay the PRE-move paths over the reloaded listing, so the save hands the re-pointed
// fields back and the mirror adopts them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepointedMedia } from "../api";

const listTranscriptRecords = vi.fn<() => Promise<unknown[]>>();
const saveTranscriptRecord = vi.fn(
  (_id: string, _json: string, _dictation: boolean): Promise<RepointedMedia | null> => Promise.resolve(null),
);
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listTranscriptRecords: () => listTranscriptRecords(),
  saveTranscriptRecord: (id: string, json: string, d: boolean) => saveTranscriptRecord(id, json, d),
}));

const { _resetHistoryLoadForTests, currentRecord, flushRecordWrites, loadHistory, setRecordRepointHook, upsertRecord, useTranscriptHistory } =
  await import("./transcriptHistory");
type TranscriptRecord = import("./transcriptHistory").TranscriptRecord;

const OLD = "/old/files/a.webm";
const NEW = "/new/files/a.webm";

const record = (id: string, extra: Partial<TranscriptRecord> = {}): TranscriptRecord => ({
  schemaVersion: 1, kind: "file", id, createdAt: "2026-10-23T12:00:00Z",
  sourcePath: "/src/a.mp4", sourceName: "a.mp4", status: "done", mediaPath: OLD,
  result: { text: "a" }, ...extra,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  useTranscriptHistory.setState({ records: [], loaded: true });
  _resetHistoryLoadForTests();
  listTranscriptRecords.mockReset();
  saveTranscriptRecord.mockReset();
  saveTranscriptRecord.mockResolvedValue(null);
});

/** A translate merges chunk 1 (written at once) and chunk 2 (parked in the coalesce window)
 *  before the move; from then on Rust re-points every save of the old path. */
function chunkParkedAcrossTheMove(id: string): void {
  upsertRecord(record(id, { result: { text: "eins" } }));
  upsertRecord(record(id, { result: { text: "eins zwei" } }));
  expect(saveTranscriptRecord).toHaveBeenCalledTimes(1); // chunk 2 is parked
  saveTranscriptRecord.mockResolvedValue({ mediaPath: NEW });
}

describe("a save Rust re-points after a move re-points the History mirror too", () => {
  it("a write parked at the forced reload keeps its chunk AND takes the moved path (save answers first)", async () => {
    chunkParkedAcrossTheMove("rp-1");
    // The disk after the move: the moved path, but not the parked chunk.
    listTranscriptRecords.mockResolvedValue([record("rp-1", { mediaPath: NEW, result: { text: "eins" } })]);
    await loadHistory(true);
    await flushRecordWrites();
    expect(currentRecord("rp-1")?.mediaPath).toBe(NEW);
    expect(currentRecord("rp-1")?.result?.text).toBe("eins zwei");
  });

  it("the same when the listing lands before the save answers", async () => {
    chunkParkedAcrossTheMove("rp-2");
    const save = deferred<RepointedMedia | null>();
    saveTranscriptRecord.mockReturnValueOnce(save.promise);
    listTranscriptRecords.mockResolvedValue([record("rp-2", { mediaPath: NEW, result: { text: "eins" } })]);
    await loadHistory(true);
    // The replay put the parked copy (old path) over the listing; the save's answer fixes it.
    save.resolve({ mediaPath: NEW });
    await flushRecordWrites();
    expect(currentRecord("rp-2")?.mediaPath).toBe(NEW);
    expect(currentRecord("rp-2")?.result?.text).toBe("eins zwei");
  });

  it("a chunk upserted while the forced listing runs is re-pointed too", async () => {
    upsertRecord(record("rp-3")); // the immediate write, before the move
    saveTranscriptRecord.mockResolvedValue({ mediaPath: NEW });
    const listing = deferred<unknown[]>();
    listTranscriptRecords.mockReturnValue(listing.promise);
    const loading = loadHistory(true);
    vi.useFakeTimers();
    try {
      upsertRecord(record("rp-3", { result: { text: "a b" } })); // parked during the listing
      vi.advanceTimersByTime(2_100); // its coalesced write fires
    } finally {
      vi.useRealTimers();
    }
    await flushRecordWrites();
    listing.resolve([record("rp-3", { mediaPath: NEW })]);
    await loading;
    expect(currentRecord("rp-3")?.mediaPath).toBe(NEW);
    expect(currentRecord("rp-3")?.result?.text).toBe("a b");
  });

  it("a field a later writer changed since the save stands, and the queue hook hears the move", async () => {
    const heard: [string, string][] = [];
    setRecordRepointHook((from, to) => heard.push([from, to]));
    const save = deferred<RepointedMedia | null>();
    saveTranscriptRecord.mockReturnValueOnce(save.promise);
    upsertRecord(record("rp-4", { videoPath: "/old/video/a.mp4" }));
    // A media fetch stamped a fresh video copy before the save answered.
    useTranscriptHistory.setState((s) => ({
      records: s.records.map((r) => (r.id === "rp-4" ? { ...r, videoPath: "/fresh/video/a.mp4" } : r)),
    }));
    save.resolve({ mediaPath: NEW, videoPath: "/new/video/a.mp4" });
    await flushRecordWrites();
    expect(currentRecord("rp-4")?.mediaPath).toBe(NEW);
    expect(currentRecord("rp-4")?.videoPath).toBe("/fresh/video/a.mp4");
    expect(heard).toEqual([[OLD, NEW]]);
    // The mirror adopts the paths without a second disk write: Rust already wrote them.
    expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
  });
});
