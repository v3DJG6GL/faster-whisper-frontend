// History records are the app's only durable account of what a dictation session
// actually did with the user's words — and they are read back from FILES that may be
// hand-edited, foreign, or written by an older build. This pins the two properties
// that matter for that: the dictation capture round-trips every field the UI branches
// on, and a malformed file never breaks the listing.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Tauri commands are no-ops outside Tauri (api.ts guards each on `isTauri`), except
// the disk listing, which we drive here to exercise the malformed-record filter.
const listTranscriptRecords = vi.fn<() => Promise<unknown[]>>();
const saveTranscriptRecord = vi.fn((_id: string, _json: string, _dictation: boolean) => Promise.resolve());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listTranscriptRecords: () => listTranscriptRecords(),
  saveTranscriptRecord: (id: string, json: string, d: boolean) => saveTranscriptRecord(id, json, d),
}));

const { deleteRecord, dropPendingWrites, loadHistory, recordDictation, upsertRecord, useTranscriptHistory } =
  await import("./transcriptHistory");
type TranscriptRecord = import("./transcriptHistory").TranscriptRecord;

const CAPTURE = {
  text: "hello there",
  startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  durationMs: 4200,
  backendId: "b1",
  model: "large-v3",
  language: "de",
  insertMethod: "typed" as const,
};

const saved = (id: string): TranscriptRecord => {
  const rec = useTranscriptHistory.getState().records.find((r) => r.id === id);
  if (!rec) throw new Error("record not found");
  return rec;
};

beforeEach(() => {
  useTranscriptHistory.setState({ records: [], loaded: false });
  listTranscriptRecords.mockReset();
});

describe("recordDictation", () => {
  it("round-trips a failed translation", () => {
    const rec = saved(
      recordDictation({
        ...CAPTURE,
        translationTarget: "French, Italian",
        translationInjected: false,
        translationAttempted: true,
        translationFailure: "timeout",
      }),
    );
    expect(rec.translationAttempted).toBe(true);
    expect(rec.translationFailure).toBe("timeout");
    expect(rec.translationInjected).toBe(false);
    // The transcript itself is always the ORIGINAL — that contract is what lets the
    // failure branch say "original inserted" about the body it renders.
    expect(rec.result?.text).toBe(CAPTURE.text);
  });

  it("round-trips a translation that landed", () => {
    const rec = saved(
      recordDictation({
        ...CAPTURE,
        translatedText: "bonjour",
        translationTarget: "French",
        translationInjected: true,
        translationAttempted: true,
      }),
    );
    expect(rec.translatedText).toBe("bonjour");
    expect(rec.translationFailure).toBeUndefined();
  });

  it("reads as not-configured when translation was never set up", () => {
    const rec = saved(recordDictation({ ...CAPTURE }));
    expect(rec.translationAttempted).toBeUndefined();
    expect(rec.translationFailure).toBeUndefined();
    expect(rec.translatedText).toBeUndefined();
    // The new fields are additive + optional, so the schema does NOT move: old records
    // (which have neither) stay readable and mean exactly this case.
    expect(rec.schemaVersion).toBe(1);
  });
});

describe("loadHistory", () => {
  it("keeps the listing alive when a file on disk is malformed", async () => {
    const good: TranscriptRecord = {
      schemaVersion: 1,
      kind: "dictation",
      id: "keep-me",
      createdAt: "2026-01-02T03:04:05.000Z",
      sourcePath: "",
      sourceName: "Kate",
      status: "done",
    };
    listTranscriptRecords.mockResolvedValue([
      good,
      null,
      "not an object",
      { id: "no-status", createdAt: "2026-01-01T00:00:00.000Z", sourcePath: "" },
      { schemaVersion: 1, id: 7, createdAt: "2026-01-01T00:00:00.000Z", sourcePath: "", status: "done" },
      // Otherwise valid but no sourceName: every consumer calls .toLowerCase()/.replace() on it.
      { schemaVersion: 1, id: "no-name", createdAt: "2026-01-01T00:00:00.000Z", sourcePath: "", status: "done" },
      { schemaVersion: 1, id: "num-name", createdAt: "2026-01-01T00:00:00.000Z", sourcePath: "", sourceName: 3, status: "done" },
    ]);
    await loadHistory(true);
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(["keep-me"]);
    expect(useTranscriptHistory.getState().loaded).toBe(true);
  });

  it("survives a rejected listing", async () => {
    listTranscriptRecords.mockRejectedValue(new Error("no disk"));
    await loadHistory(true);
    expect(useTranscriptHistory.getState().loaded).toBe(true);
  });
});

describe("per-language tracks", () => {
  it("round-trips the keyed map, the target array and includeOriginal", () => {
    const id = recordDictation({
      ...CAPTURE,
      translatedText: "Hallo\n\nHello\n\nSalut",
      translationTarget: "en, fr",
      translationTargets: ["en", "fr"],
      translations: { en: "Hello", fr: "Salut" },
      includeOriginal: true,
      translationInjected: true,
      translationAttempted: true,
    });
    const rec = useTranscriptHistory
      .getState()
      .records.find((r) => r.id === id) as TranscriptRecord;

    // The keyed map is what lets History render one track per language. The
    // injected blob is kept too, because it is what actually reached the
    // target app — but it is a lossy join (blank-line separated, and a
    // transcript contains its own line breaks), so it can never be split
    // back apart.
    expect(rec.translations).toEqual({ en: "Hello", fr: "Salut" });
    expect(rec.translationTargets).toEqual(["en", "fr"]);
    expect(rec.includeOriginal).toBe(true);
    // result.text stays the ORIGINAL, which is why rendering both it and the
    // blob showed the source language twice.
    expect(rec.result?.text).toBe(CAPTURE.text);
    expect(rec.schemaVersion).toBe(1);
  });

  it("normalises includeOriginal:false to absent", () => {
    // Matches how TranslationFields stores the flag, so a record written with
    // it off compares equal to one written before the field existed.
    const id = recordDictation({ ...CAPTURE, includeOriginal: false });
    const rec = useTranscriptHistory
      .getState()
      .records.find((r) => r.id === id) as TranscriptRecord;
    expect(rec.includeOriginal).toBeUndefined();
  });

  it("an older record simply has no tracks", () => {
    const id = recordDictation({ ...CAPTURE, translatedText: "Hello" });
    const rec = useTranscriptHistory
      .getState()
      .records.find((r) => r.id === id) as TranscriptRecord;
    expect(rec.translations).toBeUndefined();
    expect(rec.translationTargets).toBeUndefined();
  });
});

describe("upsertRecord coalesces the disk write, not the mirror", () => {
  it("writes leading-edge, then once more with the LAST record after the window", () => {
    vi.useFakeTimers();
    saveTranscriptRecord.mockClear();
    const base: TranscriptRecord = {
      schemaVersion: 1, kind: "file", id: "co-1", createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/c.mp3", sourceName: "c.mp3", status: "done", result: { text: "v0" },
    };
    for (let i = 1; i <= 10; i++) upsertRecord({ ...base, result: { text: `v${i}` } });
    expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
    // The mirror already has the latest version; the file will catch up.
    expect(useTranscriptHistory.getState().records.find((r) => r.id === "co-1")?.result?.text).toBe("v10");
    vi.advanceTimersByTime(2_100);
    expect(saveTranscriptRecord).toHaveBeenCalledTimes(2);
    expect(String(saveTranscriptRecord.mock.calls[1][1])).toContain("v10");
    vi.useRealTimers();
  });
});

describe("newest-first ordering", () => {
  // Equal `createdAt` stamps are reachable (two records minted in the same millisecond),
  // and the mirror's order is what History renders — so the tie order has to be pinned.
  it("floats a re-upserted record to the front of its tie group, newest group first", () => {
    const at = (id: string, createdAt: string): TranscriptRecord => ({
      schemaVersion: 1, kind: "file", id, createdAt,
      sourcePath: `/${id}.mp3`, sourceName: `${id}.mp3`, status: "done",
    });
    const TIE = "2026-08-30T12:00:00.000Z";
    upsertRecord(at("a", TIE));
    upsertRecord(at("mid", TIE));
    upsertRecord(at("c", TIE));
    // Newest-first: the last upsert leads. (Ties keep insertion order, newest first.)
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(["c", "mid", "a"]);
    upsertRecord({ ...at("mid", TIE), sourceName: "renamed" });
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(["mid", "c", "a"]);
    // A genuinely newer stamp still wins over the whole tie group.
    upsertRecord(at("newer", "2026-08-30T12:00:01.000Z"));
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(
      ["newer", "mid", "c", "a"],
    );
  });
});

describe("pending writes are droppable and flushable", () => {
  it("dropPendingWrites lands nothing (leading edge only); loadHistory flushes first", async () => {
    vi.useFakeTimers();
    try {
      saveTranscriptRecord.mockClear();
      const base: TranscriptRecord = {
        schemaVersion: 1, kind: "file", id: "drop-1", createdAt: "2026-08-30T12:00:00Z",
        sourcePath: "/d.mp3", sourceName: "d.mp3", status: "done", result: { text: "v0" },
      };
      upsertRecord({ ...base, result: { text: "v1" } }); // leading edge → 1 write
      upsertRecord({ ...base, result: { text: "v2" } }); // parked in the window
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      dropPendingWrites();
      vi.advanceTimersByTime(2_100);
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);

      // A forced load flushes what is still parked BEFORE the listing is taken —
      // otherwise the listing (older on disk) reverts the just-edited record.
      saveTranscriptRecord.mockClear();
      upsertRecord({ ...base, id: "flush-1", result: { text: "w1" } });
      upsertRecord({ ...base, id: "flush-1", result: { text: "w2" } });
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      let resolveList: (v: unknown[]) => void = () => {};
      listTranscriptRecords.mockReturnValue(new Promise((r) => { resolveList = r; }));
      const load = loadHistory(true);
      // Flushed synchronously, while the listing is still in flight.
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(2);
      expect(String(saveTranscriptRecord.mock.calls[1][1])).toContain("w2");
      resolveList([]);
      await load;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadHistory(force) chains onto an in-flight listing", () => {
  it("the forced listing wins: it was taken after the files changed", async () => {
    const deferred = () => {
      let resolve: (v: unknown[]) => void = () => {};
      const promise = new Promise<unknown[]>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const d1 = deferred();
    const d2 = deferred();
    listTranscriptRecords.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const first = loadHistory();
    const forced = loadHistory(true); // chains, does NOT adopt the in-flight listing
    d1.resolve([{
      schemaVersion: 1, kind: "file", id: "A", createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/a.mp3", sourceName: "a.mp3", status: "done",
    }]);
    await first;
    d2.resolve([]); // the caller deleted A before forcing
    await forced;
    expect(useTranscriptHistory.getState().records).toEqual([]);
    expect(listTranscriptRecords).toHaveBeenCalledTimes(2);
  });
});

describe("deleteRecord", () => {
  it("cancels a coalesced write so the deleted record cannot come back", () => {
    vi.useFakeTimers();
    try {
      saveTranscriptRecord.mockClear();
      const base: TranscriptRecord = {
        schemaVersion: 1, kind: "file", id: "del-1", createdAt: "2026-08-30T12:00:00Z",
        sourcePath: "/x.mp3", sourceName: "x.mp3", status: "done", result: { text: "v0" },
      };
      upsertRecord({ ...base, result: { text: "v1" } });
      upsertRecord({ ...base, result: { text: "v2" } });
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      deleteRecord("del-1");
      vi.advanceTimersByTime(2_100);
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      expect(useTranscriptHistory.getState().records.find((r) => r.id === "del-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
