// Pure-function coverage of the stage rail with the URL flow's new
// "downloading" stage (railOf folding, ordering, weighting). The store/pump
// side is exercised through the app; these guard the math.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeRailIndex, foldProgress, mergeSegmentTranslations, openHistoryRecord,
  overallFraction, railIndex, railOf, railStages, selectPath, skippedStages,
  stageEstimateMs, stageTimeline, useTranscribeRun, _resetStageRtfForTests,
  assembleTranslatedSegments,
} from "./transcribeRun";
import type { QueueItem } from "./transcribeRun";
import type { TranscriptRecord } from "./transcriptHistory";

describe("railOf", () => {
  it("folds resolving onto the download row", () => {
    expect(railOf("downloading")).toBe("downloading");
    expect(railOf("resolving")).toBe("downloading");
  });
  it("keeps the existing folds", () => {
    expect(railOf("waiting")).toBe("transcribing");
    expect(railOf("analyzing")).toBe("transcribing");
    expect(railOf("separating")).toBe("separating");
    expect(railOf("diarizing")).toBe("diarizing");
    expect(railOf(undefined)).toBe("transcribing");
  });
  it("maps the translating stage to its own row", () => {
    expect(railOf("translating")).toBe("translating");
  });
});

describe("railStages", () => {
  it("prepends downloading only for URL items", () => {
    expect(railStages(undefined, true)).toEqual(["downloading", "transcribing"]);
    expect(railStages(undefined)).toEqual(["transcribing"]);
    expect(railStages(undefined, false)).toEqual(["transcribing"]);
  });
  it("orders download before every optional stage", () => {
    expect(railStages({ separateBgm: true, diarize: true }, true)).toEqual([
      "downloading", "separating", "transcribing", "diarizing",
    ]);
  });
  it("railIndex lights the download row during resolving", () => {
    const stages = railStages({ diarize: true }, true);
    expect(railIndex("resolving", stages)).toBe(0);
    expect(railIndex("downloading", stages)).toBe(0);
    expect(railIndex("transcribing", stages)).toBe(1);
  });
  it("appends translating last when targets are requested", () => {
    expect(railStages({ translateTo: ["de"] })).toEqual(["transcribing", "translating"]);
    expect(railStages({ separateBgm: true, diarize: true, translateTo: ["de", "fr"] }, true)).toEqual([
      "downloading", "separating", "transcribing", "diarizing", "translating",
    ]);
    expect(railStages({ translateTo: [] })).toEqual(["transcribing"]);
  });
  it("text sources run the translating stage alone", () => {
    expect(railStages(undefined, false, true)).toEqual(["translating"]);
    expect(railStages({ separateBgm: true, translateTo: ["de"] }, true, true)).toEqual(["translating"]);
  });
});

describe("activeRailIndex", () => {
  const stages = railStages(
    { separateBgm: true, diarize: true } as Parameters<typeof railStages>[0],
    true,
  ); // downloading, separating, transcribing, diarizing
  const p = (stage: string) => ({ stage }) as Parameters<typeof activeRailIndex>[0];

  it("maps a real stage through railIndex", () => {
    expect(activeRailIndex(p("downloading"), {}, stages)).toBe(0);
    expect(activeRailIndex(p("separating"), {}, stages)).toBe(1);
    expect(activeRailIndex(p("analyzing"), {}, stages)).toBe(2);
  });
  it("initial 'waiting' lights the FIRST stage, not transcribe (the seeded" +
     " registry entry must not paint the download as already done)", () => {
    expect(
      activeRailIndex(p("waiting"), { downloading: { start: 1 } }, stages),
    ).toBe(0);
    expect(activeRailIndex(p("waiting"), {}, stages)).toBe(0);
  });
  it("'waiting' after earlier stages closed lands on the first open clock", () => {
    expect(
      activeRailIndex(
        p("waiting"),
        {
          downloading: { start: 1, end: 2 },
          separating: { start: 2, end: 3 },
          transcribing: { start: 3 },
        },
        stages,
      ),
    ).toBe(2);
  });
  it("'waiting' with every clock closed falls back to the transcribe row", () => {
    expect(
      activeRailIndex(
        p("waiting"),
        {
          downloading: { start: 1, end: 2 },
          separating: { start: 2, end: 3 },
          transcribing: { start: 3, end: 4 },
          diarizing: { start: 4, end: 5 },
        },
        stages,
      ),
    ).toBe(railIndex("waiting", stages));
  });
  it("no progress at all → first stage", () => {
    expect(activeRailIndex(null, {}, stages)).toBe(0);
  });
});

describe("foldProgress stage clocks (the phantom-transcribe regression)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
  });
  const at = (ms: number, stage: string, extra: object = {}) => {
    vi.setSystemTime(100_000 + ms);
    foldProgress({ stage, ...extra });
  };

  it("re-entering a closed stage restarts its clock (the request-entry" +
     " 'waiting' seeds a transcribing clock the first real stage closes)", () => {
    // The live-run sequence from the server log, in seconds:
    at(0, "waiting");            // registry seed → phantom transcribing clock
    at(11_000, "resolving");     // model loaded → phantom stamped SHUT (11s)
    at(14_000, "downloading");
    at(18_000, "separating");
    at(147_000, "waiting");      // pre-transcribe semaphore → transcribe row
    at(150_000, "transcribing");
    at(353_000, "diarizing");
    const t = useTranscribeRun.getState().stageTimes.transcribing!;
    // NOT the phantom's 11s — the real ~3m 26s span (from the semaphore wait).
    expect(t.start).toBe(100_000 + 147_000);
    expect(t.end).toBe(100_000 + 353_000);
  });

  it("a normal linear run keeps first-start semantics (waiting time counts" +
     " toward the transcribe row)", () => {
    at(0, "separating");
    at(60_000, "waiting");
    at(63_000, "transcribing");
    at(120_000, "diarizing");
    const t = useTranscribeRun.getState().stageTimes.transcribing!;
    expect(t.start).toBe(100_000 + 60_000);
    expect(t.end).toBe(100_000 + 120_000);
    expect(useTranscribeRun.getState().stageTimes.separating!.end).toBe(100_000 + 60_000);
  });

  it("stamps dlStart only on the exact downloading stage, never resolving", () => {
    at(0, "resolving");
    expect(useTranscribeRun.getState().stageMeta.downloading?.dlStart).toBeUndefined();
    at(14_000, "downloading", { totalBytes: 21_800_000 });
    at(15_000, "downloading", { totalBytes: 21_800_000 });
    const dl = useTranscribeRun.getState().stageMeta.downloading!;
    expect(dl.dlStart).toBe(100_000 + 14_000); // first downloading poll wins
    expect(dl.bytes).toBe(21_800_000);
  });
});

describe("skippedStages with a download rail", () => {
  it("convicts a jumped-over separate stage once transcribe is observed", () => {
    const skipped = skippedStages({
      progress: { stage: "transcribing", progress: 0.5 },
      stageTimes: { downloading: { start: 1, end: 2, observed: true } },
      lastOptions: { separateBgm: true },
      forUrl: true,
    });
    expect(skipped.has("separating")).toBe(true);
    expect(skipped.has("downloading")).toBe(false);
  });
});

describe("overallFraction with a download rail", () => {
  const queue: QueueItem[] = [{ path: "https://x/", status: "running", kind: "url" }];
  it("credits the download stage by its own fraction", () => {
    const frac = overallFraction({
      queue,
      progress: { stage: "downloading", progress: 0.5 },
      stageTimes: {},
      lastOptions: undefined,
      forUrl: true,
    });
    // weights: downloading 15, transcribing 60 → 7.5/75
    expect(frac).toBeCloseTo(0.1, 5);
  });
  it("counts a finished download in full once transcribe runs", () => {
    const frac = overallFraction({
      queue,
      progress: { stage: "transcribing", progress: 0.5 },
      stageTimes: { downloading: { start: 1, end: 2, observed: true } },
      lastOptions: undefined,
      forUrl: true,
    });
    // (15 + 0.5*60) / 75
    expect(frac).toBeCloseTo(0.6, 5);
  });
  it("matches the file-only math when forUrl is absent", () => {
    const fileQueue: QueueItem[] = [{ path: "/a.mp3", status: "running" }];
    const frac = overallFraction({
      queue: fileQueue,
      progress: { stage: "transcribing", progress: 0.25 },
      stageTimes: {},
      lastOptions: undefined,
    });
    expect(frac).toBeCloseTo(0.25, 5);
  });
  it("credits a running translating stage by its own fraction", () => {
    const fileQueue: QueueItem[] = [{ path: "/a.mp3", status: "running" }];
    const frac = overallFraction({
      queue: fileQueue,
      progress: { stage: "translating", progress: 0.5 },
      stageTimes: { transcribing: { start: 1, end: 2, observed: true } },
      lastOptions: { translateTo: ["de"] },
    });
    // weights: transcribing 60, translating 12 → (60 + 0.5*12) / 72
    expect(frac).toBeCloseTo(66 / 72, 5);
  });
});

describe("stageTimeline (the proportional strip)", () => {
  beforeEach(() => _resetStageRtfForTests());
  const stages = railStages(
    { separateBgm: true, diarize: true } as never, true);

  it("sizes finished segments by measured wall time on a completed run", () => {
    const tl = stageTimeline({
      stages,
      skipped: new Set(),
      stageTimes: {
        downloading: { start: 0, end: 18_000, observed: true },
        separating: { start: 18_000, end: 184_000, observed: true },
        transcribing: { start: 184_000, end: 405_000, observed: true },
        diarizing: { start: 405_000, end: 523_000, observed: true },
      },
      progress: { stage: "diarizing", progress: 1 },
      audioDurSec: 1348,
      complete: true,
      now: 523_000,
    });
    expect(tl.map((e) => e.state)).toEqual(["done", "done", "done", "done"]);
    expect(tl.map((e) => e.ms)).toEqual([18_000, 166_000, 221_000, 118_000]);
    const total = tl.reduce((a, e) => a + e.ms, 0);
    expect(Math.round((tl[2].ms / total) * 100)).toBe(42);
  });

  it("estimates active and pending stages from the audio duration", () => {
    const tl = stageTimeline({
      stages,
      skipped: new Set(),
      stageTimes: {
        downloading: { start: 0, end: 18_000, observed: true },
        separating: { start: 18_000, observed: true },
      },
      progress: { stage: "separating", progress: 0.4 },
      audioDurSec: 1348,
      complete: false,
      now: 78_000,
    });
    expect(tl[0]).toMatchObject({ state: "done", ms: 18_000 });
    // active: default separating RTF 8 → est 168.5 s, elapsed 60 s < est
    expect(tl[1].state).toBe("active");
    expect(tl[1].ms).toBeCloseTo((1348 / 8) * 1000, 3);
    expect(tl[1].fill).toBeCloseTo(0.4, 5);
    expect(tl[1].overrun).toBe(false);
    // pending stages carry tilde-able estimates
    expect(tl[2]).toMatchObject({ state: "pending", fill: 0 });
    expect(tl[2].estMs).toBeCloseTo((1348 / 6) * 1000, 3);
    expect(tl[3].estMs).toBeCloseTo((1348 / 11) * 1000, 3);
  });

  it("widens an overrunning stage in 15 s steps and clamps its fill", () => {
    const est = stageEstimateMs("separating", 100)!; // 12.5 s
    const tl = stageTimeline({
      stages: ["separating", "transcribing"],
      skipped: new Set(),
      stageTimes: { separating: { start: 0, observed: true } },
      progress: { stage: "separating", progress: 0.9 },
      audioDurSec: 100,
      complete: false,
      now: Math.round(est) + 20_000,
    });
    expect(tl[0].overrun).toBe(true);
    expect(tl[0].fill).toBe(0.96);
    // one whole 15 s step past the estimate, not per-tick creep
    expect(tl[0].ms).toBeCloseTo(est + 30_000, 0);
  });

  it("drops skipped stages from the strip entirely", () => {
    const tl = stageTimeline({
      stages,
      skipped: new Set(["separating"] as const),
      stageTimes: { downloading: { start: 0, end: 5_000, observed: true } },
      progress: { stage: "transcribing", progress: 0.1 },
      audioDurSec: 600,
      complete: false,
      now: 20_000,
    });
    expect(tl.map((e) => e.stage)).toEqual(
      ["downloading", "transcribing", "diarizing"]);
  });

  it("falls back to weight-scaled widths with no estMs when the audio duration is unknown", () => {
    const tl = stageTimeline({
      stages: ["transcribing", "diarizing"],
      skipped: new Set(),
      stageTimes: { transcribing: { start: 0, observed: true } },
      progress: { stage: "transcribing", progress: 0.2 },
      audioDurSec: null,
      complete: false,
      now: 10_000,
    });
    expect(tl[0].ms).toBe(120_000); // 60 * 2000
    expect(tl[0].estMs).toBeNull();
    expect(tl[1].ms).toBe(30_000); // 15 * 2000
    expect(tl[1].estMs).toBeNull();
  });

  it("learns a stage's realtime factor from a finished, observed clock", () => {
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      foldProgress({ stage: "separating", progress: 0.1, duration: 1000 });
      vi.setSystemTime(100_000);
      // transition closes the separating clock: 100 s wall for 1000 s audio
      foldProgress({ stage: "transcribing", progress: 0, duration: 1000 });
    } finally {
      vi.useRealTimers();
    }
    expect(stageEstimateMs("separating", 1000)).toBeCloseTo(100_000, 0);
  });
});

describe("selectPath keeps a same-path open record", () => {
  const recOf = (id: string, sourcePath: string): TranscriptRecord => ({
    schemaVersion: 1,
    kind: "file",
    id,
    createdAt: "2026-08-30T12:00:00Z",
    sourcePath,
    sourceName: sourcePath,
    status: "done",
  });

  it("re-selecting the open record's path does not swap to the last-registered record", () => {
    // r1 and r2 are two records of the SAME source; registering r2 makes it
    // the historyByPath entry, but the user still has r1 open on screen.
    openHistoryRecord(recOf("rec-1", "/a.mp3"));
    openHistoryRecord(recOf("rec-2", "/a.mp3"));
    useTranscribeRun.setState({ openRecordId: "rec-1" });
    selectPath("/a.mp3");
    expect(useTranscribeRun.getState().openRecordId).toBe("rec-1");
  });

  it("selecting a different path recomputes (or clears) the open record", () => {
    openHistoryRecord(recOf("rec-3", "/a.mp3"));
    openHistoryRecord(recOf("rec-4", "/b.mp3"));
    useTranscribeRun.setState({ openRecordId: "rec-3" });
    selectPath("/b.mp3"); // rec-3 is not a record of /b.mp3
    expect(useTranscribeRun.getState().openRecordId).toBe("rec-4");
    selectPath("/nowhere.mp3"); // no record at all
    expect(useTranscribeRun.getState().openRecordId).toBeNull();
    selectPath(null);
    expect(useTranscribeRun.getState().openRecordId).toBeNull();
  });
});

describe("mergeSegmentTranslations kept-original marks", () => {
  it("sets translationsKept per merged segment; a clean re-merge clears it", async () => {
    const { useTranscriptHistory } = await import("./transcriptHistory");
    const rec: TranscriptRecord = {
      schemaVersion: 1,
      kind: "file",
      id: "kept-1",
      createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/k.mp3",
      sourceName: "k.mp3",
      status: "done",
      result: {
        text: "a b",
        segments: [
          { start: 0, end: 1, text: "a" },
          { start: 1, end: 2, text: "b" },
        ],
      },
    };
    openHistoryRecord(rec);
    mergeSegmentTranslations(
      "kept-1",
      { 0: { de: "a" }, 1: { de: "B" } },
      { targets: ["de"] },
      { 0: ["de"], 1: [] },
    );
    const saved = () =>
      useTranscriptHistory.getState().records.find((r) => r.id === "kept-1")!;
    expect(saved().result!.segments![0].translationsKept).toEqual(["de"]);
    expect(saved().result!.segments![1].translationsKept).toBeUndefined();
    // A successful re-translate REPLACES the mark (clears it) — not a union.
    mergeSegmentTranslations("kept-1", { 0: { de: "A!" } }, { targets: ["de"] }, { 0: [] });
    expect(saved().result!.segments![0].translationsKept).toBeUndefined();
    expect(saved().result!.segments![0].translations).toEqual({ de: "A!" });
    // Untouched segment keeps its earlier merge untouched.
    expect(saved().result!.segments![1].translations).toEqual({ de: "B" });
  });
});

describe("assembleTranslatedSegments (text-source kept-original marks)", () => {
  it("marks a target the server kept as the source, like the audio path does", () => {
    const segs = assembleTranslatedSegments(
      [{ text: "a" }, { text: "b" }],
      [{ en: "A" }, { en: "b" }],
      [[], ["en"]],
    );
    expect(segs[0].translationsKept).toBeUndefined();
    expect(segs[0].translations).toEqual({ en: "A" });
    expect(segs[1].translationsKept).toEqual(["en"]);
  });

  it("an older backend that omits kept marks nothing", () => {
    const segs = assembleTranslatedSegments([{ text: "a" }], [{ en: "A" }], []);
    expect(segs[0].translationsKept).toBeUndefined();
  });
});
