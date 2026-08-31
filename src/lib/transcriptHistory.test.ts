// History records are the app's only durable account of what a dictation session
// actually did with the user's words — and they are read back from FILES that may be
// hand-edited, foreign, or written by an older build. This pins the two properties
// that matter for that: the dictation capture round-trips every field the UI branches
// on, and a malformed file never breaks the listing.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Tauri commands are no-ops outside Tauri (api.ts guards each on `isTauri`), except
// the disk listing, which we drive here to exercise the malformed-record filter.
const listTranscriptRecords = vi.fn<() => Promise<unknown[]>>();
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listTranscriptRecords: () => listTranscriptRecords(),
}));

const { loadHistory, recordDictation, useTranscriptHistory } = await import("./transcriptHistory");
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
