// History records are the app's only durable account of what a dictation session
// actually did with the user's words — and they are read back from FILES that may be
// hand-edited, foreign, or written by an older build. This pins the two properties
// that matter for that: the dictation capture round-trips every field the UI branches
// on, and a malformed file never breaks the listing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Tauri commands are no-ops outside Tauri (api.ts guards each on `isTauri`), except
// the disk listing, which we drive here to exercise the malformed-record filter.
const listTranscriptRecords = vi.fn<() => Promise<unknown[]>>();
const saveTranscriptRecord = vi.fn((_id: string, _json: string, _dictation: boolean) => Promise.resolve());
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listTranscriptRecords: () => listTranscriptRecords(),
  saveTranscriptRecord: (id: string, json: string, d: boolean) => saveTranscriptRecord(id, json, d),
}));

const {
  _resetHistoryLoadForTests, appChipLabel, appLabel, currentRecord, deleteRecord, dropPendingWrites, flushRecordWrites, loadHistory, patchRecord, recordDictation,
  recordEditedResult, recordText, recordTracks, upsertRecord, selectRecord, useTranscriptHistory,
} = await import("./transcriptHistory");
type TranscriptRecord = import("./transcriptHistory").TranscriptRecord;
const { trText } = await import("./cueSplit");
const { translationTracks } = await import("./exportTracks");

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
  _resetHistoryLoadForTests();
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

  it("keeps a record with a non-string appId, dropping only that field", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "dictation",
        id: "bad-app",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "",
        sourceName: "Dictation",
        status: "done",
        appId: 123,
      },
    ]);
    await loadHistory(true);
    const [r] = useTranscriptHistory.getState().records;
    expect(r?.id).toBe("bad-app");
    expect(r?.appId).toBeUndefined();
    expect(() => appLabel(r)).not.toThrow();
    expect(() => appChipLabel(r)).not.toThrow();
  });

  it("keeps a record with non-array target lists, repairing only those fields", async () => {
    const base = {
      schemaVersion: 1,
      kind: "dictation",
      createdAt: "2026-01-02T03:04:05.000Z",
      sourcePath: "",
      sourceName: "Dictation",
      status: "done",
    };
    listTranscriptRecords.mockResolvedValue([
      { ...base, id: "str-targets", translationTargets: "de", result: { text: "x", translation: { targets: "de", model: "m" } } },
      { ...base, id: "mixed-targets", translationTargets: ["fr", 7, null], result: { text: "x", translation: { targets: ["it", {}] } } },
    ]);
    await loadHistory(true);
    const s = saved("str-targets");
    expect(s.translationTargets).toBeUndefined();
    expect(s.result?.translation).toEqual({ targets: [], model: "m" });
    expect(s.result?.text).toBe("x");
    const m = saved("mixed-targets");
    expect(m.translationTargets).toEqual(["fr"]);
    expect(m.result?.translation?.targets).toEqual(["it"]);
  });

  it("repairs a string translateTo and non-string texts so the bug report and the snippet cannot throw", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "bad-texts",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "/a.wav",
        sourceName: "a.wav",
        status: "done",
        options: { translateTo: "de", diarize: true },
        translatedText: 5,
        result: { text: 7, translation: { targets: "de" } },
      },
    ]);
    await loadHistory(true);
    const s = saved("bad-texts");
    expect(s.options?.translateTo).toBeUndefined();
    expect(s.options?.diarize).toBe(true);
    expect(s.translatedText).toBeUndefined();
    expect(s.result?.text).toBe("");
    expect(s.result?.translation?.targets).toEqual([]);
    expect(() => [...recordText(s, 200)]).not.toThrow();
  });

  it("repairs a damaged segment list and correction map so the snippet cannot throw", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "bad-segs",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "/a.wav",
        sourceName: "a.wav",
        status: "done",
        edits: { 0: "gone", 1: 9, 2: "TWO", "2.0": "junk", "": "x" },
        speakerEdits: { 2: "Ana" },
        translationsStale: { 0: true },
        result: { text: "ok", segments: [{ start: 0, end: 1, text: 5 }, null, { start: 1, end: 2, text: "two" }] },
      },
      {
        schemaVersion: 1,
        kind: "file",
        id: "str-segs",
        createdAt: "2026-01-02T03:04:06.000Z",
        sourcePath: "/b.wav",
        sourceName: "b.wav",
        status: "done",
        edits: { 0: "x" },
        speakerEdits: { 0: "Ana" },
        translationsStale: { 0: true },
        result: { text: "plain", segments: "abc" },
      },
    ]);
    await loadHistory(true);
    const a = saved("bad-segs");
    // The bad entries go and the corrections move with their segments: the one on "two"
    // (index 2) now sits on index 0, the bad slot's key is gone.
    expect(a.result?.segments?.map((s) => s.text)).toEqual(["two"]);
    expect(a.edits).toEqual({ 0: "TWO" });
    expect(a.speakerEdits).toEqual({ 0: "Ana" });
    expect(a.translationsStale).toEqual({});
    expect(recordText(a, 200)).toBe("TWO");
    const b = saved("str-segs");
    expect(b.result?.segments).toBeUndefined();
    // No segment left for an index-keyed correction to land on: the maps go with the list,
    // or the viewer marks the record edited and rebuilds an empty text for Copy/export.
    expect(b.edits).toBeUndefined();
    expect(b.speakerEdits).toBeUndefined();
    expect(b.translationsStale).toBeUndefined();
    expect(recordText(b, 200)).toBe("plain");
  });

  it("drops a non-canonical or out-of-range correction key on a clean segment list too", async () => {
    const segs = { text: "One. Two.", segments: [{ start: 0, end: 1, text: "One." }, { start: 1, end: 2, text: "Two." }] };
    const base = {
      schemaVersion: 1, kind: "file", sourcePath: "/a.wav", sourceName: "a.wav", status: "done", result: segs,
    } as const;
    const clean = {
      ...base, id: "keys-clean", createdAt: "2026-01-02T03:04:07.000Z",
      edits: { 1: "Zwei." }, speakerEdits: { 0: "Ana" }, translationsStale: { 1: true },
    };
    listTranscriptRecords.mockResolvedValue([
      {
        ...base, id: "keys-mixed", createdAt: "2026-01-02T03:04:05.000Z",
        edits: { "01": "x", 5: "y", 1: "ok" }, speakerEdits: { "": "A" }, translationsStale: { x: true, 0: true },
      },
      { ...base, id: "keys-only-bad", createdAt: "2026-01-02T03:04:06.000Z", edits: { "01": "x" } },
      clean,
    ]);
    await loadHistory(true);
    const a = saved("keys-mixed");
    expect(a.edits).toEqual({ 1: "ok" });
    expect(a.speakerEdits).toEqual({});
    expect(a.translationsStale).toEqual({ 0: true });
    // No real correction left: the server's own result (its text included), not a rebuild.
    const b = saved("keys-only-bad");
    expect(b.edits).toEqual({});
    expect(recordEditedResult(b)).toBe(b.result);
    // A clean record is handed back as the very object the listing read.
    expect(saved("keys-clean")).toBe(clean);
  });

  it("drops non-string speaker names so the viewer's speaker-name sanitizer cannot throw", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "bad-speakers",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "/a.wav",
        sourceName: "a.wav",
        status: "done",
        speakerEdits: { 0: 5, 1: "Ana" },
        renames: { A: 1, B: "Bo" },
        result: {
          text: "hi there",
          speakers: ["A", 7, "B"],
          segments: [
            { start: 0, end: 1, text: "hi", speaker: 5 },
            { start: 1, end: 2, text: "there", speaker: "B" },
          ],
        },
      },
      {
        schemaVersion: 1,
        kind: "file",
        id: "obj-renames",
        createdAt: "2026-01-02T03:04:06.000Z",
        sourcePath: "/b.wav",
        sourceName: "b.wav",
        status: "done",
        speakerEdits: ["Ana"],
        renames: "Bo",
        result: { text: "x", speakers: "A" },
      },
    ]);
    await loadHistory(true);
    const a = saved("bad-speakers");
    expect(a.speakerEdits).toEqual({ 1: "Ana" });
    expect(a.renames).toEqual({ B: "Bo" });
    expect(a.result?.speakers).toEqual(["A", "B"]);
    // The segment keeps its text and only loses the label; nothing was dropped, nothing moved.
    expect(a.result?.segments?.map((s) => [s.text, s.speaker])).toEqual([["hi", undefined], ["there", "B"]]);
    expect(recordText(a, 200)).toBe("hi there");
    const b = saved("obj-renames");
    expect(b.speakerEdits).toBeUndefined();
    expect(b.renames).toBeUndefined();
    expect(b.result?.speakers).toBeUndefined();
  });

  it("repairs damaged per-segment translations so the viewer and the exports cannot throw", async () => {
    const seg = (text: string, extra: object) => ({ start: 0, end: 1, text, ...extra });
    const clean = {
      schemaVersion: 1,
      kind: "file",
      id: "clean-tr",
      createdAt: "2026-01-02T03:04:06.000Z",
      sourcePath: "/b.wav",
      sourceName: "b.wav",
      status: "done",
      result: { text: "hi", segments: [seg("hi", { translations: { de: "Hallo" }, translationsKept: ["fr"] })] },
    };
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "bad-tr",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "/a.wav",
        sourceName: "a.wav",
        status: "done",
        result: {
          text: "a b c d",
          segments: [
            seg("a", { translations: { de: 5, fr: "Salut" } }),
            seg("b", { translations: "hola" }),
            seg("c", { translationsKept: 7 }),
            seg("d", { translationsKept: ["de", 3] }),
          ],
        },
      },
      clean,
    ]);
    await loadHistory(true);
    const a = saved("bad-tr");
    const segs = a.result?.segments ?? [];
    expect(segs.map((s) => s.text)).toEqual(["a", "b", "c", "d"]);
    expect(segs[0]?.translations).toEqual({ fr: "Salut" });
    expect(segs[1]?.translations).toBeUndefined();
    expect(segs[2]?.translationsKept).toBeUndefined();
    expect(segs[3]?.translationsKept).toEqual(["de"]);
    for (const s of segs) for (const lang of ["de", "fr"]) expect(() => trText(s, lang)).not.toThrow();
    expect(trText(segs[0]!, "fr")).toBe("Salut");
    // A string map listed its indexes "0".."3" as language tracks.
    expect(translationTracks(a.result!)).toEqual(["fr"]);
    // A clean record is handed back as the very object the listing read.
    expect(saved("clean-tr")).toBe(clean);
  });

  it("drops corrections with no segment to land on: an empty or missing list", async () => {
    const base = {
      schemaVersion: 1,
      kind: "file",
      sourcePath: "/a.wav",
      sourceName: "a.wav",
      status: "done",
      edits: { 0: "x" },
      speakerEdits: { 0: "Ana" },
      translationsStale: { 0: true },
    };
    listTranscriptRecords.mockResolvedValue([
      { ...base, id: "empty-segs", createdAt: "2026-01-02T03:04:05.000Z", result: { text: "plain", segments: [] } },
      { ...base, id: "no-segs", createdAt: "2026-01-02T03:04:06.000Z", result: { text: "plain" } },
    ]);
    await loadHistory(true);
    for (const id of ["empty-segs", "no-segs"]) {
      const r = saved(id);
      expect(r.edits).toBeUndefined();
      expect(r.speakerEdits).toBeUndefined();
      expect(r.translationsStale).toBeUndefined();
      expect(r.result?.text).toBe("plain");
      expect(recordText(r, 200)).toBe("plain");
    }
  });

  it("keeps a failed record with a non-string error and title, dropping only those fields", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "url",
        id: "bad-error",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "https://example.com/v",
        sourceName: "v",
        status: "failed",
        error: 123,
        title: {},
      },
    ]);
    await loadHistory(true);
    const r = saved("bad-error");
    expect(r.status).toBe("failed");
    expect(r.error).toBeUndefined();
    expect(r.title).toBeUndefined();
  });

  it("drops an unknown or non-string insertMethod so the expanded row cannot render an object", async () => {
    const base = {
      schemaVersion: 1,
      kind: "dictation",
      sourcePath: "",
      sourceName: "Dictation",
      status: "done",
      result: { text: "hi" },
    };
    listTranscriptRecords.mockResolvedValue([
      { ...base, id: "im-obj", createdAt: "2026-01-02T03:04:05.000Z", insertMethod: {} },
      { ...base, id: "im-str", createdAt: "2026-01-02T03:04:06.000Z", insertMethod: "x".repeat(500) },
      { ...base, id: "im-ok", createdAt: "2026-01-02T03:04:07.000Z", insertMethod: "clipboard" },
    ]);
    await loadHistory(true);
    for (const id of ["im-obj", "im-str"]) {
      const r = saved(id);
      expect(r.insertMethod).toBeUndefined();
      expect(r.result?.text).toBe("hi");
      expect(r.sourceName).toBe("Dictation");
    }
    expect(saved("im-ok").insertMethod).toBe("clipboard");
  });

  it("maps the legacy \"latch\" activation to handsfree and drops an unknown one", async () => {
    const base = {
      schemaVersion: 1,
      kind: "dictation",
      sourcePath: "",
      sourceName: "Dictation",
      status: "done",
      result: { text: "hi" },
    };
    listTranscriptRecords.mockResolvedValue([
      { ...base, id: "act-obj", createdAt: "2026-01-02T03:04:05.000Z", activation: {} },
      { ...base, id: "act-str", createdAt: "2026-01-02T03:04:06.000Z", activation: "x".repeat(500) },
      { ...base, id: "act-latch", createdAt: "2026-01-02T03:04:07.000Z", activation: "latch" },
      { ...base, id: "act-hold", createdAt: "2026-01-02T03:04:08.000Z", activation: "hold" },
    ]);
    await loadHistory(true);
    for (const id of ["act-obj", "act-str"]) {
      const r = saved(id);
      expect(r.activation).toBeUndefined();
      expect(r.result?.text).toBe("hi");
    }
    expect(saved("act-latch").activation).toBe("handsfree");
    expect(saved("act-hold").activation).toBe("hold");
  });

  it("drops a non-number result.duration so the viewer's meta line cannot throw", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "dur-str",
        createdAt: "2026-01-02T03:04:05.000Z",
        sourcePath: "/a.wav",
        sourceName: "a.wav",
        status: "done",
        result: { text: "hi", duration: "12.5", language: "en" },
      },
      {
        schemaVersion: 1,
        kind: "file",
        id: "dur-ok",
        createdAt: "2026-01-02T03:04:06.000Z",
        sourcePath: "/b.wav",
        sourceName: "b.wav",
        status: "done",
        result: { text: "ok", duration: 12.5 },
      },
    ]);
    await loadHistory(true);
    const r = saved("dur-str");
    expect(r.result?.duration).toBeUndefined();
    expect(r.result?.text).toBe("hi");
    expect(r.result?.language).toBe("en");
    expect(saved("dur-ok").result?.duration).toBe(12.5);
  });

  it("drops a non-string result.language / language so the track readers cannot throw", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "lang-bad",
        createdAt: "2026-01-02T03:04:07.000Z",
        sourcePath: "/c.wav",
        sourceName: "c.wav",
        status: "done",
        language: {},
        result: { text: "hi", language: 5 },
      },
      {
        schemaVersion: 1,
        kind: "file",
        id: "lang-ok",
        createdAt: "2026-01-02T03:04:07.500Z",
        sourcePath: "/d.wav",
        sourceName: "d.wav",
        status: "done",
        language: "de",
        result: { text: "ok", language: "de" },
      },
    ]);
    await loadHistory(true);
    const r = saved("lang-bad");
    expect(r.result?.language).toBeUndefined();
    expect(r.language).toBeUndefined();
    expect(r.result?.text).toBe("hi");
    expect(saved("lang-ok").result?.language).toBe("de");
    expect(saved("lang-ok").language).toBe("de");
  });

  it("files a stored standard server's word language by its code", async () => {
    listTranscriptRecords.mockResolvedValue([
      {
        schemaVersion: 1,
        kind: "file",
        id: "lang-word",
        createdAt: "2026-01-02T03:04:08.000Z",
        sourcePath: "/e.wav",
        sourceName: "e.wav",
        status: "done",
        language: "english",
        result: { text: "hi", language: "english" },
      },
    ]);
    await loadHistory(true);
    expect(saved("lang-word").result?.language).toBe("en");
    expect(saved("lang-word").language).toBe("en");
  });

  it("repairs damaged site subtitle tracks so the viewer and the exports cannot throw", async () => {
    const cue = (text: unknown, start: unknown = 0, end: unknown = 1) => ({ start, end, text });
    const track = (id: string, cues: unknown) => ({ id, lang: "en", source: "site", kind: "manual", cues });
    const cleanTracks = [track("t-clean", [cue("Hello"), cue("there", 1, 2)])];
    const clean = {
      schemaVersion: 1,
      kind: "url",
      id: "tt-clean",
      createdAt: "2026-01-02T03:04:08.000Z",
      sourcePath: "https://example.com/c",
      sourceName: "c",
      status: "done",
      result: { text: "hi", timedTracks: cleanTracks },
    };
    const base = {
      schemaVersion: 1,
      kind: "url",
      sourcePath: "https://example.com/v",
      sourceName: "v",
      status: "done",
    };
    listTranscriptRecords.mockResolvedValue([
      { ...base, id: "tt-obj", createdAt: "2026-01-02T03:04:05.000Z", result: { text: "a", timedTracks: {} } },
      {
        ...base,
        id: "tt-mixed",
        createdAt: "2026-01-02T03:04:06.000Z",
        result: {
          text: "b",
          timedTracks: [
            track("t-nocues", 5),
            "junk",
            { ...track("t-noid", []), id: 7 },
            track("t-bad", [cue("keep"), cue(3), cue("nan", Number.NaN, 1), null, cue("also", 2, 3)]),
            track("t-emptied", [cue(3), null]),
            track("t-empty", []),
            { ...track("t-label", [cue("x")]), label: 5, site: {} },
          ],
        },
      },
      {
        ...base,
        id: "tt-only-empty",
        createdAt: "2026-01-02T03:04:07.000Z",
        result: { text: "e", timedTracks: [track("t-empty", [])] },
      },
      clean,
    ]);
    await loadHistory(true);
    const o = saved("tt-obj");
    expect(o.result?.timedTracks).toBeUndefined();
    expect(o.result?.text).toBe("a");
    const m = saved("tt-mixed").result?.timedTracks ?? [];
    expect(m.map((t) => t.id)).toEqual(["t-bad", "t-label"]);
    expect(m[0]?.cues.map((c) => c.text)).toEqual(["keep", "also"]);
    // A non-string label/site is dropped, not handed to the JSON export's string walk.
    expect(m[1]?.label).toBeUndefined();
    expect(m[1]?.site).toBeUndefined();
    expect(m[1]?.cues.map((c) => c.text)).toEqual(["x"]);
    for (const t of m) for (const c of t.cues) expect(() => c.text.trim()).not.toThrow();
    // A stored cue-less track goes too, even in an otherwise clean list: no blank lane, no empty export.
    expect(saved("tt-only-empty").result?.timedTracks).toEqual([]);
    // A clean list is handed back as the very object the listing read.
    expect(saved("tt-clean")).toBe(clean);
    expect(saved("tt-clean").result?.timedTracks).toBe(cleanTracks);
  });

  it("survives a rejected listing", async () => {
    listTranscriptRecords.mockRejectedValue(new Error("no disk"));
    await loadHistory(true);
    expect(useTranscriptHistory.getState().loaded).toBe(true);
  });

  it("a rejected listing is retried by the next non-forced load, not left empty for the session", async () => {
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    await loadHistory();
    // No screen waits forever on a failed listing.
    expect(useTranscriptHistory.getState().loaded).toBe(true);
    listTranscriptRecords.mockResolvedValueOnce([{
      schemaVersion: 1, kind: "file", id: "A", createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/a.mp3", sourceName: "a.mp3", status: "done",
    }]);
    await loadHistory(); // History's mount load after a failed launch-time listing
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(["A"]);
    // Once a listing succeeded, a non-forced call is a no-op again.
    await loadHistory();
    expect(listTranscriptRecords).toHaveBeenCalledTimes(2);
  });

  it("a retry after a failed listing keeps the records this session made (their saves may not be on disk)", async () => {
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    await loadHistory();
    const made: TranscriptRecord = {
      schemaVersion: 1, kind: "file", id: "B", createdAt: "2026-08-30T13:00:00Z",
      sourcePath: "/b.mp3", sourceName: "b.mp3", status: "done",
    };
    useTranscriptHistory.setState({ records: [made] }); // made after the failed listing; its save failed
    listTranscriptRecords.mockResolvedValueOnce([{
      schemaVersion: 1, kind: "file", id: "A", createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/a.mp3", sourceName: "a.mp3", status: "done",
    }]);
    await loadHistory();
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(["B", "A"]);
  });

  it("a retry after a failed FORCED listing replaces the mirror (a wipe is not undone)", async () => {
    listTranscriptRecords.mockResolvedValueOnce([{
      schemaVersion: 1, kind: "file", id: "A", createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/a.mp3", sourceName: "a.mp3", status: "done",
    }]);
    await loadHistory();
    listTranscriptRecords.mockRejectedValueOnce(new Error("no disk"));
    await loadHistory(true); // e.g. after "Delete all dictations" wiped A on disk
    listTranscriptRecords.mockResolvedValueOnce([]);
    await loadHistory();
    expect(useTranscriptHistory.getState().records).toEqual([]);
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

describe("flushRecordWrites resolves once the parked writes land", () => {
  it("a quit path can await it: it settles only after the save does, and survives a failure", async () => {
    vi.useFakeTimers();
    try {
      saveTranscriptRecord.mockClear();
      const base: TranscriptRecord = {
        schemaVersion: 1, kind: "file", id: "quit-1", createdAt: "2026-08-30T12:00:00Z",
        sourcePath: "/q.mp3", sourceName: "q.mp3", status: "done", result: { text: "v0" },
      };
      upsertRecord({ ...base, result: { text: "v1" } }); // leading edge
      upsertRecord({ ...base, result: { text: "v2" } }); // parked
      let land: () => void = () => {};
      saveTranscriptRecord.mockImplementationOnce(() => new Promise<void>((r) => { land = r; }));
      let settled = false;
      const flushed = flushRecordWrites().then(() => { settled = true; });
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(2);
      await Promise.resolve();
      expect(settled).toBe(false);
      land();
      await flushed;
      expect(settled).toBe(true);

      // A failing save still settles the flush (it must never block the exit).
      upsertRecord({ ...base, id: "quit-2", result: { text: "x1" } });
      upsertRecord({ ...base, id: "quit-2", result: { text: "x2" } });
      saveTranscriptRecord.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(flushRecordWrites()).resolves.toBeUndefined();
      err.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
  it("also waits for a save already in flight (the leading-edge write and a fired timer)", async () => {
    vi.useFakeTimers();
    try {
      saveTranscriptRecord.mockClear();
      const base: TranscriptRecord = {
        schemaVersion: 1, kind: "file", id: "quit-3", createdAt: "2026-08-30T12:00:00Z",
        sourcePath: "/q.mp3", sourceName: "q.mp3", status: "done", result: { text: "v0" },
      };
      let land: () => void = () => {};
      saveTranscriptRecord.mockImplementationOnce(() => new Promise<void>((r) => { land = r; }));
      upsertRecord(base); // leading edge: issued now, nothing parked
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      let settled = false;
      const flushed = flushRecordWrites().then(() => { settled = true; });
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      land();
      await flushed;
      expect(settled).toBe(true);

      // A coalesce timer that already fired: its write is in flight, not parked.
      let land2: () => void = () => {};
      upsertRecord({ ...base, result: { text: "v1" } }); // parked behind the window
      saveTranscriptRecord.mockImplementationOnce(() => new Promise<void>((r) => { land2 = r; }));
      vi.advanceTimersByTime(2_000);
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(2);
      settled = false;
      const flushed2 = flushRecordWrites().then(() => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      land2();
      await flushed2;
      expect(settled).toBe(true);
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

describe("loadHistory replays mirror changes made while the listing was in flight", () => {
  const deferred = () => {
    let resolve: (v: unknown[]) => void = () => {};
    const promise = new Promise<unknown[]>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const A: TranscriptRecord = {
    schemaVersion: 1, kind: "file", id: "A", createdAt: "2026-08-30T12:00:00Z",
    sourcePath: "/a.mp3", sourceName: "a.mp3", status: "done",
  };

  it("an upsert during the listing survives the snapshot", async () => {
    const d = deferred();
    listTranscriptRecords.mockReturnValueOnce(d.promise);
    const load = loadHistory(true);
    upsertRecord(A); // landed after the listing was taken
    d.resolve([]);
    await load;
    expect(useTranscriptHistory.getState().records.map((r) => r.id)).toEqual(["A"]);
  });

  it("a delete during the listing is not resurrected by the snapshot", async () => {
    const d = deferred();
    listTranscriptRecords.mockReturnValueOnce(d.promise);
    upsertRecord(A);
    const load = loadHistory(true);
    deleteRecord("A"); // file + media already gone
    d.resolve([A]);
    await load;
    expect(useTranscriptHistory.getState().records).toEqual([]);
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

describe("patchRecord merges onto the latest copy", () => {
  const base: TranscriptRecord = {
    schemaVersion: 1, kind: "url", id: "patch-1", createdAt: "2026-08-30T12:00:00Z",
    sourcePath: "https://example.com/v", sourceName: "v", status: "done", result: { text: "t" },
  };

  it("two writers each keep the other's field (the viewer's stale-`rec` overwrite)", () => {
    upsertRecord(base);
    // The on-demand fetch stores the server id, then the local copy lands later: both
    // are patches, so the second no longer spreads a snapshot taken before the first.
    patchRecord("patch-1", (r) => ({ ...r, result: { ...r.result!, sourceVideoMediaId: "m1" } }));
    patchRecord("patch-1", (r) => ({ ...r, videoPath: "/video/patch-1.mkv" }));
    const rec = currentRecord("patch-1")!;
    expect(rec.result?.sourceVideoMediaId).toBe("m1");
    expect(rec.videoPath).toBe("/video/patch-1.mkv");
  });

  it("is a no-op for a missing id: a late write never resurrects a deleted record", () => {
    saveTranscriptRecord.mockClear();
    const fn = vi.fn((r: TranscriptRecord) => r);
    patchRecord("nope", fn);
    expect(fn).not.toHaveBeenCalled();
    expect(saveTranscriptRecord).not.toHaveBeenCalled();
    expect(currentRecord("nope")).toBeUndefined();
    expect(useTranscriptHistory.getState().records).toEqual([]);
  });

  it("writes nothing when the patch hands the same record back", () => {
    useTranscriptHistory.setState({ records: [base] }); // in the mirror, no write stamp yet
    saveTranscriptRecord.mockClear();
    patchRecord("patch-1", (r) => r);
    expect(saveTranscriptRecord).not.toHaveBeenCalled();
  });
});

describe("lastWriteAt pruning keeps coalescing intact", () => {
  it("sweeps stale stamps without un-coalescing a record written inside the window", () => {
    vi.useFakeTimers();
    try {
      const at = (id: string, text = "x"): TranscriptRecord => ({
        schemaVersion: 1, kind: "file", id, createdAt: "2026-08-30T12:00:00Z",
        sourcePath: `/${id}.mp3`, sourceName: id, status: "done", result: { text },
      });
      // Enough stamps to cross the sweep threshold.
      for (let i = 0; i < 70; i++) upsertRecord(at(`prune-${i}`));
      vi.advanceTimersByTime(1_000);
      upsertRecord(at("fresh", "f1")); // stamped 1 s after the bulk
      vi.advanceTimersByTime(1_100); // bulk stamps now stale, "fresh" still inside its window
      saveTranscriptRecord.mockClear();
      upsertRecord(at("trigger")); // this write runs the sweep
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      // "fresh" kept its stamp: a second write inside the window still parks...
      upsertRecord(at("fresh", "f2"));
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(1);
      // ...and a swept record reads as "long ago": leading-edge write at once.
      upsertRecord(at("prune-3", "again"));
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(2_100);
      expect(saveTranscriptRecord).toHaveBeenCalledTimes(3);
      expect(String(saveTranscriptRecord.mock.calls[2][1])).toContain("f2");
    } finally {
      dropPendingWrites();
      vi.useRealTimers();
    }
  });
});

describe("recordEditedResult", () => {
  // The server's text need not be a space-join of its segments (CJK, punctuation).
  const result = {
    text: "你好。世界。",
    segments: [
      { id: 0, start: 0, end: 1, text: "你好。" },
      { id: 1, start: 1, end: 2, text: "世界。" },
    ],
  };
  const rec = (over: Partial<TranscriptRecord> = {}) => ({ id: "r", result, ...over }) as TranscriptRecord;

  it("leaves an unedited record's result alone, its text included (the viewer's rule)", () => {
    expect(recordEditedResult(rec())).toBe(result);
    expect(recordEditedResult(rec({ edits: {}, speakerEdits: {} })).text).toBe("你好。世界。");
  });

  it("rebuilds the text from the segments once a segment is corrected", () => {
    const out = recordEditedResult(rec({ edits: { 1: "地球。" } }));
    expect(out.segments?.[1].text).toBe("地球。");
    // An unspaced script keeps its seams unspaced (the TXT writer's join, not a space-join).
    expect(out.text).toBe("你好。地球。");
  });

  it("joins Japanese segments without spaces and spaced scripts with one", () => {
    const ja = {
      text: "今日は晴れ。明日は雨。",
      segments: [
        { id: 0, start: 0, end: 1, text: "今日は晴れ。" },
        { id: 1, start: 1, end: 2, text: "明日も雨。" },
      ],
    };
    const jaOut = recordEditedResult({ id: "j", result: ja, edits: { 1: "明日は雨。" } } as Partial<TranscriptRecord> as TranscriptRecord);
    expect(jaOut.text).toBe("今日は晴れ。明日は雨。");
    const en = { text: "Hello there. Bye.", segments: [{ id: 0, start: 0, end: 1, text: "Hello there." }, { id: 1, start: 1, end: 2, text: "Bye." }] };
    expect(recordEditedResult({ id: "e", result: en, edits: { 1: "Goodbye." } } as Partial<TranscriptRecord> as TranscriptRecord).text).toBe("Hello there. Goodbye.");
  });
});

describe("recordText", () => {
  // History's copy, snippet and search read this: its seams must match the viewer's and
  // the exports' (joinSegmentTexts), not a plain space-join.
  const cjk = {
    text: "你好。世界。",
    segments: [
      { id: 0, start: 0, end: 1, text: "你好。" },
      { id: 1, start: 1, end: 2, text: "世界。" },
      { id: 2, start: 2, end: 3, text: "再见。" },
    ],
  };
  const rec = (result: unknown, over: Partial<TranscriptRecord> = {}) =>
    ({ id: "r", result, ...over }) as TranscriptRecord;

  it("joins unspaced-script segments without a space, corrections applied", () => {
    expect(recordText(rec(cjk))).toBe("你好。世界。再见。");
    expect(recordText(rec(cjk, { edits: { 1: "地球。" } }))).toBe("你好。地球。再见。");
  });

  it("keeps the bounded snippet's seams the same", () => {
    expect(recordText(rec(cjk), 160)).toBe("你好。世界。再见。");
    expect(recordText(rec(cjk), 5)).toBe("你好。世界");
  });

  it("space-joins spaced scripts exactly as before", () => {
    const en = { text: "", segments: [{ id: 0, start: 0, end: 1, text: "Hello there." }, { id: 1, start: 1, end: 2, text: "Bye." }] };
    expect(recordText(rec(en))).toBe("Hello there. Bye.");
    expect(recordText(rec(en), 160)).toBe("Hello there. Bye.");
    expect(recordText(rec(en), 8)).toBe("Hello th");
  });

  it("trims each segment's raw leading space before joining", () => {
    // faster-whisper's segment.text usually leads with a space.
    const raw = {
      text: "",
      segments: [
        { id: 0, start: 0, end: 1, text: " 今日は" },
        { id: 1, start: 1, end: 2, text: " 天気です" },
      ],
    };
    expect(recordText(rec(raw))).toBe("今日は天気です");
    expect(recordText(rec(raw), 160)).toBe("今日は天気です");
    const en = { text: "", segments: [{ id: 0, start: 0, end: 1, text: " Hello." }, { id: 1, start: 1, end: 2, text: " Bye." }] };
    expect(recordText(rec(en))).toBe("Hello. Bye.");
    expect(recordText(rec(en), 160)).toBe("Hello. Bye.");
  });

  it("bounds to the unbounded join's prefix on mixed CJK/Latin seams and blank segments", () => {
    const texts = [" Hello.", "你好。", "  ", "世界", " world", "テスト。", "", "end.", "再见", "x"];
    const mixed = {
      text: "",
      segments: texts.map((text, i) => ({ id: i, start: i, end: i + 1, text })),
    };
    const full = recordText(rec(mixed));
    for (const max of [0, 1, 3, 6, 7, 9, 12, 15, 20, 30, full.length, 200]) {
      expect(recordText(rec(mixed), max)).toBe(full.slice(0, max));
    }
    const edited = rec(mixed, { edits: { 1: "Bonjour.", 5: "" } });
    const fullEdited = recordText(edited);
    for (const max of [2, 8, 10, 14, 25, 200]) expect(recordText(edited, max)).toBe(fullEdited.slice(0, max));
    // Format-only segments: the join drops them, so the bound must not count them.
    const marks = {
      text: "",
      segments: ["a", "\u200e", "\u200e", "bcd"].map((text, i) => ({ id: i, start: i, end: i + 1, text })),
    };
    const fullMarks = recordText(rec(marks));
    for (const max of [1, 2, 3, 4, 5, 6]) expect(recordText(rec(marks), max)).toBe(fullMarks.slice(0, max));
  });

  it("fills the bound with many short CJK segments (no phantom seam spaces counted)", () => {
    const many = {
      text: "",
      segments: Array.from({ length: 300 }, (_, i) => ({ id: i, start: i, end: i + 1, text: "あ。" })),
    };
    const out = recordText(rec(many), 200);
    expect(out).toHaveLength(200);
    expect(out).toBe("あ。".repeat(100));
  });
});

describe("selectRecord (useRecord's selector)", () => {
  it("one record by id; none without an id", () => {
    const a = { id: "a" } as TranscriptRecord;
    const b = { id: "b" } as TranscriptRecord;
    expect(selectRecord("b")({ records: [a, b] })).toBe(b);
    expect(selectRecord("c")({ records: [a, b] })).toBeUndefined();
    expect(selectRecord(undefined)({ records: [a] })).toBeUndefined();
  });
});

// The duplicate-original bug, pinned.
//
// A dictation translated to EN+FR rendered the INJECTED blob (which, with
// "include original" on, already begins with the original) and then rendered
// result.text again beneath it under an "original" label — so the source
// language appeared twice, under a heading naming only the targets. recordTracks
// is the decision that fixes it, extracted so it can be tested: there is no
// jsdom, so the rendering itself cannot be.
describe("history record display", () => {
  const base = {
    schemaVersion: 1 as const,
    kind: "dictation" as const,
    id: "r1",
    createdAt: "2026-08-31T18:23:00.000Z",
    sourcePath: "",
    sourceName: "kate",
    status: "done" as const,
    language: "de",
    result: { text: "Hallo das ist ein Test", duration: 11 },
  };

  const rec = (over: Partial<TranscriptRecord> = {}): TranscriptRecord =>
    ({ ...base, ...over }) as TranscriptRecord;

  describe("recordTracks", () => {
    it("renders the original exactly once, as its own dimmed track", () => {
      const t = recordTracks(
        rec({
          translations: { en: "Hello this is a test", fr: "Salut c'est un test" },
          translationTargets: ["en", "fr"],
          includeOriginal: true,
        }),
      );
      expect(t).toEqual([
        { lang: "de", text: "Hallo das ist ein Test", orig: true },
        { lang: "en", text: "Hello this is a test" },
        { lang: "fr", text: "Salut c'est un test" },
      ]);
      // The reported bug: the source text must appear in exactly one track.
      const originals = t!.filter((x) => x.text === base.result.text);
      expect(originals).toHaveLength(1);
    });

    it("keeps the original track even when it was not injected", () => {
      // `includeOriginal` is about the injected blob; the record must still show what was
      // spoken, or a translated dictation's transcript is unreachable in the UI.
      const t = recordTracks(
        rec({
          translations: { en: "Hello" },
          translationTargets: ["en"],
          includeOriginal: undefined,
        }),
      );
      expect(t).toEqual([
        { lang: "de", text: "Hallo das ist ein Test", orig: true },
        { lang: "en", text: "Hello" },
      ]);
    });

    it("keeps the configured target ORDER, not object key order", () => {
      const t = recordTracks(
        rec({
          translations: { fr: "Salut", en: "Hello" },
          translationTargets: ["en", "fr"],
        }),
      );
      expect(t!.filter((x) => !x.orig).map((x) => x.lang)).toEqual(["en", "fr"]);
    });

    it("drops a target that produced no text", () => {
      const t = recordTracks(
        rec({
          translations: { en: "Hello", fr: "   " },
          translationTargets: ["en", "fr"],
        }),
      );
      expect(t!.filter((x) => !x.orig).map((x) => x.lang)).toEqual(["en"]);
    });

    it("returns null for a record written before tracks existed", () => {
      // Its translatedText is a blank-line join and a transcript contains its
      // own line breaks, so splitting it would mislabel text rather than
      // recover it. One untitled block is the honest rendering.
      expect(recordTracks(rec({ translatedText: "Hallo\n\nHello\n\nSalut" }))).toBeNull();
      expect(recordTracks(rec({}))).toBeNull();
    });

    it("returns null rather than throwing on a hand-edited record", () => {
      // Records are read back from FILES: nothing validates the shape of an
      // optional field on load.
      expect(recordTracks(rec({ translations: "nope" as never }))).toBeNull();
      expect(recordTracks(rec({ translations: {} }))).toBeNull();
      // A string where the target list belongs, a number where a track belongs.
      expect(() => recordTracks(rec({ translations: { en: "hi" }, translationTargets: "en" as never }))).not.toThrow();
      const t = recordTracks(rec({ translations: { en: "hi" }, translationTargets: "en" as never }));
      expect(t![t!.length - 1]).toEqual({ lang: "en", text: "hi" });
      expect(recordTracks(rec({ translations: { en: 5 } as never, translationTargets: ["en"] }))).toBeNull();
    });

    it("falls back to a neutral code when the language is unknown", () => {
      const t = recordTracks(
        rec({
          language: "auto",
          translations: { en: "Hello" },
          translationTargets: ["en"],
          includeOriginal: true,
        }),
      );
      expect(t![0]).toEqual({ lang: "orig", text: base.result.text, orig: true });
    });

    it("falls back too when the language is only format marks or not a string", () => {
      for (const language of ["\u200e", 5 as never]) {
        const t = recordTracks(rec({ language, translations: { en: "Hello" }, translationTargets: ["en"] }));
        expect(t![0]).toEqual({ lang: "orig", text: base.result.text, orig: true });
      }
    });
  });

  describe("appChipLabel", () => {
    it("names the app, never the grouped session's window title", () => {
      expect(
        appChipLabel({ appId: "org.mozilla.thunderbird", sourceName: "Re: invoice — Mozilla Thunderbird" }),
      ).toBe("Thunderbird");
    });
    it("falls back to the stored name when there is no app id", () => {
      expect(appChipLabel({ appId: undefined, sourceName: "Notes" })).toBe("Notes");
      expect(appChipLabel({ appId: undefined, sourceName: "Dictation" })).toBe("Dictation");
    });
  });
});
