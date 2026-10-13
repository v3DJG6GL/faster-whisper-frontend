// Pure-function coverage of the stage rail with the URL flow's new
// "downloading" stage (railOf folding, ordering, weighting). The store/pump
// side is exercised through the app; these guard the math.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The only Tauri command these tests care about is the history write: a record the
// workbench must NOT re-save has to be observable. The rest of api.ts is no-op outside
// Tauri (each command guards on `isTauri`), so the original module is kept.
const saveTranscriptRecord = vi.fn((_id: string, _json: string, _dictation: boolean) => Promise.resolve());
// Unset = the real outside-Tauri command; the lost-request tests make it reject.
const transcribeFile = vi.fn<(args: Parameters<typeof import("./api").transcribeFile>[0]) => Promise<never>>();
// Unset = the real outside-Tauri command; the text-source join test answers it.
const translateText = vi.fn<(args: Parameters<typeof import("./api").translateText>[0]) => Promise<import("./api").TextTranslationResult>>();
// Unset = the real outside-Tauri commands; the site-transcript fallback test answers them.
const transcribeUrl = vi.fn<(args: Parameters<typeof import("./api").transcribeUrl>[0]) => Promise<never>>();
const fetchUrlSubtitles = vi.fn<(args: Parameters<typeof import("./api").fetchUrlSubtitles>[0]) => Promise<import("./api").UrlSubtitles>>();
// Unset = the real outside-Tauri command; the site-transcript audio-expiry test answers it.
const fetchUrlAudioOnDemand = vi.fn<(args: Parameters<typeof import("./api").fetchUrlAudioOnDemand>[0]) => Promise<import("./api").UrlMediaDownload>>();
// Unset = the real outside-Tauri command; the video-poll cadence test answers it.
const getTranscribeProgress = vi.fn<(args: Parameters<typeof import("./api").getTranscribeProgress>[0]) => Promise<import("./types").BatchProgress>>();
// Unset = the real outside-Tauri commands; the on-demand video completion tests answer them.
const fetchUrlVideoOnDemand = vi.fn<(args: Parameters<typeof import("./api").fetchUrlVideoOnDemand>[0]) => Promise<import("./api").UrlMediaDownload>>();
const fetchUrlVideo = vi.fn<(args: Parameters<typeof import("./api").fetchUrlVideo>[0]) => Promise<string | null>>();
// Unset = the real outside-Tauri command (no copy); the late audio-copy test answers it.
const saveTranscriptMedia = vi.fn<(...a: Parameters<typeof import("./api").saveTranscriptMedia>) => Promise<string | null>>();
// Unset = the real caps fetch; the translateParsed caps-miss test answers it.
const refreshCaps = vi.fn<(...a: Parameters<typeof import("./capabilities").refreshCaps>) => Promise<void>>();
// False = the window is on screen; the hidden-window cadence test flips it.
let windowHidden = false;
// The show/hide listeners the module under test subscribed; a test fires them by hand.
const hiddenListeners = new Set<(hidden: boolean) => void>();
vi.mock("./windowVisibility", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./windowVisibility")>();
  return {
    ...orig,
    isWindowHidden: () => windowHidden,
    onWindowHiddenChange: (fn: (hidden: boolean) => void) => {
      hiddenListeners.add(fn);
      return () => void hiddenListeners.delete(fn);
    },
  };
});
vi.mock("./capabilities", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./capabilities")>();
  return {
    ...orig,
    refreshCaps: (...a: Parameters<typeof orig.refreshCaps>) =>
      refreshCaps.getMockImplementation() ? refreshCaps(...a) : orig.refreshCaps(...a),
  };
});
vi.mock("./api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./api")>();
  return {
    ...orig,
    saveTranscriptRecord: (id: string, json: string, d: boolean) => saveTranscriptRecord(id, json, d),
    transcribeFile: (a: Parameters<typeof orig.transcribeFile>[0]) =>
      transcribeFile.getMockImplementation() ? transcribeFile(a) : orig.transcribeFile(a),
    translateText: (a: Parameters<typeof orig.translateText>[0]) =>
      translateText.getMockImplementation() ? translateText(a) : orig.translateText(a),
    transcribeUrl: (a: Parameters<typeof orig.transcribeUrl>[0]) =>
      transcribeUrl.getMockImplementation() ? transcribeUrl(a) : orig.transcribeUrl(a),
    fetchUrlSubtitles: (a: Parameters<typeof orig.fetchUrlSubtitles>[0]) =>
      fetchUrlSubtitles.getMockImplementation() ? fetchUrlSubtitles(a) : orig.fetchUrlSubtitles(a),
    fetchUrlAudioOnDemand: (a: Parameters<typeof orig.fetchUrlAudioOnDemand>[0]) =>
      fetchUrlAudioOnDemand.getMockImplementation() ? fetchUrlAudioOnDemand(a) : orig.fetchUrlAudioOnDemand(a),
    getTranscribeProgress: (a: Parameters<typeof orig.getTranscribeProgress>[0]) =>
      getTranscribeProgress.getMockImplementation() ? getTranscribeProgress(a) : orig.getTranscribeProgress(a),
    fetchUrlVideoOnDemand: (a: Parameters<typeof orig.fetchUrlVideoOnDemand>[0]) =>
      fetchUrlVideoOnDemand.getMockImplementation() ? fetchUrlVideoOnDemand(a) : orig.fetchUrlVideoOnDemand(a),
    fetchUrlVideo: (a: Parameters<typeof orig.fetchUrlVideo>[0]) =>
      fetchUrlVideo.getMockImplementation() ? fetchUrlVideo(a) : orig.fetchUrlVideo(a),
    saveTranscriptMedia: (...a: Parameters<typeof orig.saveTranscriptMedia>) =>
      saveTranscriptMedia.getMockImplementation() ? saveTranscriptMedia(...a) : orig.saveTranscriptMedia(...a),
  };
});

import {
  activeRailIndex, axisLayout, clearEdits, flushPersistEdits, setOrphanWatch, startRun, foldProgress, forgetRecord, mergeSegmentTranslations, openHistoryRecord,
  setSegmentEdit,
  overallOf, etaSecOf, planOf, planTimeline, unitsFraction,
  linkPrefetchFor, linkTranslateTo, railIndex, railOf, railStages, selectPath, setRename, SKIPPED_EXPLANATIONS, skippedStages, stagePick,
  useTranscribeRun, type RailStage,
  assembleTranslatedSegments,
  cancelRun, lostContact, translateParsed, reconcileRetryOptions, refreshRowMediaPaths, retryFile, retryRunVideo, withSiteTracks, runBadgeFraction, runTotals, settledPanelItem,
  SITE_TRANSCRIPT_FALLBACK,
} from "./transcribeRun";
import { MULTI_LANGUAGE } from "./languages";
import type { PlanStage } from "./types";
import type { QueueItem } from "./transcribeRun";
import { deleteRecord, patchRecord, type TranscriptRecord } from "./transcript/transcriptHistory";

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

describe("stagePick", () => {
  it("the screen's own pick wins, an explicit off included", () => {
    expect(stagePick(false, { value: true })).toBe(false);
    expect(stagePick(true, { value: false })).toBe(true);
  });
  it("a locked server default wins over the screen's pick", () => {
    expect(stagePick(false, { value: true, locked: true })).toBe(true);
    expect(stagePick(true, { value: false, locked: true })).toBe(false);
  });
  it("else the server's default for this caller", () => {
    expect(stagePick(undefined, { value: true })).toBe(true);
    expect(stagePick(undefined, { value: false })).toBe(false);
  });
  it("an older server that names no default gets no field", () => {
    expect(stagePick(undefined, undefined)).toBeUndefined();
    expect(stagePick(undefined, { value: "true" })).toBeUndefined();
  });
  it("feeds the rail: only a true pick lights the stage", () => {
    expect(railStages({ diarize: stagePick(undefined, { value: true }) })).toContain("diarizing");
    expect(railStages({ diarize: stagePick(false, { value: true }) })).not.toContain("diarizing");
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
  it("a saved target the wire refuses is no translating stage", () => {
    // A History record from before the chips were wire-checked: the run sends nothing for it.
    expect(railStages({ translateTo: ["de_CH"] })).toEqual(["transcribing"]);
    expect(railStages({ translateTo: ["x"] }, true, false, true)).toEqual(["downloading"]);
    expect(railStages({ translateTo: ["de_CH", "fr"] })).toEqual(["transcribing", "translating"]);
  });
  it("a link whose site tracks cover every target drops the translating stage", () => {
    const site = { fetch: ["de"], transcriptTrackId: null, mtTargets: [] as string[] };
    const opts = { translateTo: ["de"] };
    const to = linkTranslateTo(opts, { siteSubs: site });
    expect(to).toEqual([]);
    expect(railStages({ ...opts, translateTo: to }, true, false)).not.toContain("translating");
    // The site lacks a target the run did not ask for itself (chips cleared after Add on a T2T
    // server): still translated.
    expect(linkTranslateTo({ translateTo: [] }, { siteSubs: { ...site, mtTargets: ["fr"] } })).toEqual(["fr"]);
    // The backend has no T2T stage: nothing is translated.
    expect(linkTranslateTo({}, { siteSubs: { ...site, mtTargets: ["fr"] } })).toBeUndefined();
    // No site plan: the run's own targets.
    expect(linkTranslateTo(opts, {})).toEqual(["de"]);
  });
  it("text sources run the translating stage alone", () => {
    expect(railStages(undefined, false, true)).toEqual(["translating"]);
    expect(railStages({ separateBgm: true, translateTo: ["de"] }, true, true)).toEqual(["translating"]);
  });
  it("a link answered by the site's transcript track downloads and translates only", () => {
    const opts = { translateTo: ["de"], diarize: true, separateBgm: true };
    expect(railStages(opts, true, false, true)).toEqual(["downloading", "translating"]);
    expect(railStages({ diarize: true, separateBgm: true }, true, false, true)).toEqual(["downloading"]);
    const skipped = skippedStages({
      progress: { stage: "translating", plan: [{ stage: "translating", state: "done" }] },
      stageTimes: {},
      lastOptions: opts,
      forUrl: true,
      siteTranscript: true,
    });
    expect([...skipped]).toEqual([]);
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

  it("the request-entry 'waiting' seed never marks the transcribe clock observed", () => {
    at(0, "waiting", { duration: 1000 }); // phantom transcribing clock
    expect(useTranscribeRun.getState().stageTimes.transcribing?.observed).toBeFalsy();
    at(11_000, "resolving", { duration: 1000 }); // closes it 11 s later
    // Closed but never observed: a seeded phantom, not a stage that ran.
    expect(useTranscribeRun.getState().stageTimes.transcribing?.observed).toBeFalsy();
  });

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

  it("a cold MT-model fetch after the rail moved on stays on the translating row" +
     " and keeps the media download's receipt", () => {
    at(0, "downloading", { totalBytes: 20_000_000 });
    at(4_000, "transcribing");
    at(30_000, "translating");
    at(61_000, "downloading", { totalBytes: 5_000_000_000 }); // the GGUF fetch
    const mid = useTranscribeRun.getState();
    expect(activeRailIndex(mid.progress, mid.stageTimes, ["downloading", "transcribing", "translating"])).toBe(2);
    at(100_000, "downloading", { totalBytes: 5_000_000_000 });
    at(161_000, "translating");
    const { stageTimes, stageMeta } = useTranscribeRun.getState();
    expect(stageMeta.downloading?.bytes).toBe(20_000_000);
    expect(stageMeta.downloading?.dlStart).toBe(100_000);
    expect(stageTimes.downloading).toMatchObject({ start: 100_000, end: 100_000 + 4_000 });
    expect(stageTimes.translating?.start).toBe(100_000 + 30_000);
    expect(stageTimes.translating?.end).toBeUndefined();
  });
  it("a translation-model fetch is told apart by the poll itself, whatever stage the client saw last", () => {
    const gguf = { model: "org/mt:Q4", compute: "gguf", totalBytes: 5_000_000_000 };
    const link = ["downloading", "transcribing", "translating"] as const;
    const active = (rail: readonly string[]) => {
      const st = useTranscribeRun.getState();
      return rail[activeRailIndex(st.progress, st.stageTimes, rail as never)];
    };
    // (1) The 1 s poll never saw the translating tick: transcribing → downloading{gguf}.
    at(0, "downloading", { totalBytes: 20_000_000 });
    at(1_000, "transcribing", { model: "large-v3", compute: "float16" });
    at(20_000, "transcribing", { model: "large-v3", compute: "float16" });
    at(21_000, "downloading", gguf);
    expect(active(link)).toBe("translating");
    at(200_000, "translating", { model: "org/mt:Q4", compute: "gguf" });
    let { stageTimes, stageMeta } = useTranscribeRun.getState();
    expect(stageTimes.transcribing).toMatchObject({ start: 101_000, end: 121_000 });
    expect(stageTimes.translating).toMatchObject({ start: 121_000, observed: true });
    expect(stageMeta.transcribing).toMatchObject({ model: "large-v3", compute: "float16" });
    expect(stageMeta.translating).toMatchObject({ model: "org/mt:Q4", compute: "gguf" });
    expect(stageMeta.downloading?.bytes).toBe(20_000_000);

    // (3) A site-transcript link (rail: downloading, translating) sees no later stage at all.
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    at(0, "downloading", { totalBytes: 20_000_000 });
    at(6_000, "downloading", gguf);
    expect(active(["downloading", "translating"])).toBe("translating");
    ({ stageTimes, stageMeta } = useTranscribeRun.getState());
    expect(stageTimes.downloading).toMatchObject({ start: 100_000, end: 106_000 });
    expect(stageMeta.downloading).toMatchObject({ bytes: 20_000_000, dlStart: 100_000 });
    expect(stageMeta.downloading?.model).toBeUndefined();

    // (4) A Whisper model fetch (not gguf) before transcribing stays on the download side.
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    at(0, "downloading", { totalBytes: 20_000_000 });
    at(5_000, "downloading", { model: "large-v3", compute: "float16" });
    expect(active(link)).toBe("downloading");
    expect(useTranscribeRun.getState().stageTimes.translating).toBeUndefined();

    // (5) Diarized first: the diarize row keeps its own chips and closes at the fetch.
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    at(0, "transcribing", { model: "large-v3", compute: "float16" });
    at(20_000, "diarizing", { model: "pyannote", compute: "float32" });
    at(40_000, "downloading", gguf);
    ({ stageTimes, stageMeta } = useTranscribeRun.getState());
    expect(stageTimes.diarizing).toMatchObject({ start: 120_000, end: 140_000 });
    expect(stageMeta.diarizing).toMatchObject({ model: "pyannote", compute: "float32" });
    expect(active(["transcribing", "diarizing", "translating"])).toBe("translating");
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

  it("never convicts a stage whose clock was seeded but never sampled", () => {
    // The pump seeds the first stage's clock without `observed`; a fast stage can finish
    // between two polls. That stage RAN.
    const skipped = skippedStages({
      progress: { stage: "diarizing", progress: 0.2 },
      stageTimes: { transcribing: { start: 1 } },
      lastOptions: { diarize: true },
    });
    expect(skipped.has("transcribing")).toBe(false);
  });

  it("trusts a backend that names its skipped stages, even an empty list", () => {
    const skipped = skippedStages({
      progress: { stage: "transcribing", progress: 0.5, skipped: [] },
      stageTimes: {},
      lastOptions: { separateBgm: true },
      forUrl: true,
    });
    expect(skipped.size).toBe(0);
  });
});

describe("overallOf / etaSecOf (the server's numbers, verbatim)", () => {
  const queue: QueueItem[] = [{ path: "https://x/", status: "running", kind: "url" }];
  it("is the server's overall while something runs, 0 before the first poll", () => {
    expect(overallOf({ queue, progress: { stage: "translating", progress: 0.9, overall: 0.47 } }))
      .toBeCloseTo(0.47, 5);
    expect(overallOf({ queue, progress: null })).toBe(0);
    expect(overallOf({ queue, progress: { stage: "transcribing", progress: 0.5 } })).toBe(0);
  });
  it("clamps a bad value and is null when nothing runs", () => {
    expect(overallOf({ queue, progress: { stage: "x", overall: 3 } })).toBe(1);
    expect(overallOf({ queue: [{ path: "/a", status: "done" }], progress: { overall: 0.5 } })).toBeNull();
  });
  it("the sidebar badge equals the header number", () => {
    useTranscribeRun.setState({ queue, progress: { stage: "translating", overall: 0.61 } });
    expect(runBadgeFraction(useTranscribeRun.getState())).toBeCloseTo(0.61, 5);
    useTranscribeRun.setState({ queue: [], progress: null });
  });
  it("etaSecOf drops missing, negative and non-finite values", () => {
    expect(etaSecOf({ etaS: 42 })).toBe(42);
    expect(etaSecOf({ etaS: -1 })).toBeNull();
    expect(etaSecOf({})).toBeNull();
    expect(etaSecOf(null)).toBeNull();
  });
});

describe("planOf", () => {
  const live: PlanStage[] = [
    { stage: "transcribing", state: "done", tookS: 10 },
    { stage: "translating", state: "active", estS: 30, elapsedS: 5 },
  ];
  const receipt: PlanStage[] = [
    { stage: "transcribing", state: "done", tookS: 10 },
    { stage: "translating", state: "done", tookS: 33 },
  ];
  it("a running item (no settled result) shows the live poll, a settled one its receipt", () => {
    expect(planOf({ plan: live }, undefined)).toBe(live);
    expect(planOf({ plan: live }, { text: "", plan: receipt })).toBe(receipt);
    expect(planOf(null, { text: "", plan: receipt })).toBe(receipt);
    expect(planOf({ stage: "transcribing" }, { text: "" })).toBeNull();
  });
  it("a finished run whose last snapshot had no active stage still shows its receipt", () => {
    // Between stage_done and the next tick: the last stage still "pending ~est".
    const between: PlanStage[] = [
      { stage: "transcribing", state: "done", tookS: 10 },
      { stage: "translating", state: "pending", estS: 30 },
    ];
    expect(planOf({ plan: between }, { text: "", plan: receipt })).toBe(receipt);
  });
});

describe("unitsFraction", () => {
  it("weights done and running units by their cost and ignores instant copies", () => {
    expect(unitsFraction([
      { target: "de", state: "instant", instant: true, tookS: 0 },
      { target: "en", state: "done", tookS: 100 },
      { target: "fr", state: "running", estS: 100, progress: 0.5 },
      { target: "fi", state: "queued", estS: 100 },
    ])).toBeCloseTo(0.5, 5);
    expect(unitsFraction([])).toBeNull();
    expect(unitsFraction([{ target: "de", state: "instant", instant: true }])).toBeNull();
  });
});

describe("skippedStages / activeRailIndex read the plan first", () => {
  const stages = railStages({ separateBgm: true, diarize: true } as never, true);
  it("a plan's skipped stage is authoritative", () => {
    const skipped = skippedStages({
      progress: { stage: "transcribing", plan: [
        { stage: "downloading", state: "done", tookS: 5 },
        { stage: "separating", state: "skipped" },
        { stage: "transcribing", state: "active" },
        { stage: "diarizing", state: "pending" },
      ] },
      stageTimes: {},
      lastOptions: { separateBgm: true, diarize: true } as never,
      forUrl: true,
    });
    expect([...skipped]).toEqual(["separating"]);
  });
  it("the active row is the plan's active stage, past the end once all are done", () => {
    const plan: PlanStage[] = [
      { stage: "downloading", state: "done" },
      { stage: "separating", state: "done" },
      { stage: "transcribing", state: "active" },
      { stage: "diarizing", state: "pending" },
    ];
    expect(activeRailIndex({ stage: "downloading", plan }, {}, stages)).toBe(2);
    const done = plan.map((p) => ({ ...p, state: "done" as const }));
    expect(activeRailIndex({ stage: "diarizing", plan: done }, {}, stages)).toBe(stages.length);
  });
});

describe("planTimeline (the proportional strip)", () => {
  const stages = railStages({ separateBgm: true, diarize: true } as never, true);

  it("sizes segments by the plan's measured and estimated seconds", () => {
    const tl = planTimeline({
      stages,
      skipped: new Set(),
      plan: [
        { stage: "downloading", state: "done", tookS: 9 },
        { stage: "separating", state: "done", tookS: 108 },
        { stage: "transcribing", state: "active", estS: 191, elapsedS: 40 },
        { stage: "diarizing", state: "pending", estS: 101 },
      ],
      stageTimes: {
        downloading: { start: 0, end: 9_000, observed: true },
        separating: { start: 9_000, end: 117_000, observed: true },
        transcribing: { start: 117_000, observed: true },
      },
      progress: { stage: "transcribing", progress: 0.2 },
      complete: false,
      now: 157_000,
    });
    expect(tl.map((e) => e.state)).toEqual(["done", "done", "active", "pending"]);
    expect(tl.map((e) => e.ms)).toEqual([9_000, 108_000, 191_000, 101_000]);
    expect(tl.map((e) => e.estimated)).toEqual([false, false, true, true]);
    expect(tl[2].elapsedMs).toBe(40_000);
    expect(tl[2].fill).toBeCloseTo(0.2, 5);
    expect(tl[2].overrun).toBe(false);
    expect(tl[3].estMs).toBe(101_000);
  });

  it("does not fill a warm-up phase by the clock", () => {
    const base = {
      stages: ["transcribing"] as RailStage[],
      skipped: new Set<RailStage>(),
      stageTimes: { transcribing: { start: 0, observed: true } },
      complete: false,
      now: 30_000,
    };
    // "skipping silence…": the registry says analyzing, the plan names the phase.
    const warm = planTimeline({
      ...base,
      plan: [{ stage: "transcribing", state: "active", estS: 200, elapsedS: 30, phase: "analyzing" }],
      progress: { stage: "analyzing" },
    });
    expect(warm[0].fill).toBe(0);
    expect(warm[0].overrun).toBe(false);
    // Separation's transcode rides as a step on the plain stage.
    const prep = planTimeline({
      ...base,
      stages: ["separating"] as RailStage[],
      stageTimes: { separating: { start: 0, observed: true } },
      plan: [{ stage: "separating", state: "active", estS: 100, elapsedS: 30 }],
      progress: { stage: "separating", step: "preparing" },
    });
    expect(prep[0].fill).toBe(0);
    // The decoder's plain tick with no fraction yet still fills by time.
    const work = planTimeline({
      ...base,
      plan: [{ stage: "transcribing", state: "active", estS: 200, elapsedS: 30 }],
      progress: { stage: "transcribing" },
    });
    expect(work[0].fill).toBeCloseTo(0.15, 5);
  });

  it("gives the translate segment one lane per non-instant target", () => {
    const tl = planTimeline({
      stages: ["transcribing", "translating"],
      skipped: new Set(),
      plan: [
        { stage: "transcribing", state: "done", tookS: 191 },
        { stage: "translating", state: "active", estS: 330, units: [
          { target: "de", state: "instant", instant: true, tookS: 0 },
          { target: "en", state: "done", tookS: 160 },
          { target: "fr", state: "running", estS: 170, progress: 0.5 },
        ] },
      ],
      stageTimes: { translating: { start: 0, observed: true } },
      progress: { stage: "translating", progress: 0.4 },
      complete: false,
      now: 200_000,
    });
    expect(tl[1].lanes?.map((l) => l.target)).toEqual(["en", "fr"]);
    expect(tl[1].lanes?.map((l) => l.fill)).toEqual([1, 0.5]);
    // unit-weighted: 160 done of 330 → ~0.48 + half of 170
    expect(tl[1].fill).toBeCloseTo((160 + 85) / 330, 5);
  });

  it("keeps a failed translate stage's unfinished languages empty instead of filling them as done", () => {
    const tl = planTimeline({
      stages: ["transcribing", "translating"],
      skipped: new Set(),
      plan: [
        { stage: "transcribing", state: "done", tookS: 191 },
        { stage: "translating", state: "failed", tookS: 200, units: [
          { target: "en", state: "done", tookS: 160 },
          { target: "fr", state: "failed", tookS: 40 },
          { target: "ja", state: "queued", estS: 170 },
        ] },
      ],
      stageTimes: {},
      progress: null,
      complete: true,
      now: 400_000,
    });
    expect(tl[1].lanes?.map((l) => [l.target, l.state, l.fill])).toEqual([
      ["en", "done", 1], ["fr", "failed", 0], ["ja", "queued", 0],
    ]);
  });

  it("widens an overrunning stage in 15 s steps, never narrower than elapsed, and clamps the fill", () => {
    const tl = planTimeline({
      stages: ["separating", "transcribing"],
      skipped: new Set(),
      plan: [
        { stage: "separating", state: "active", estS: 12.5 },
        { stage: "transcribing", state: "pending", estS: 100 },
      ],
      stageTimes: { separating: { start: 0, observed: true } },
      progress: { stage: "separating", progress: 0.9 },
      complete: false,
      now: 32_500,
    });
    expect(tl[0].overrun).toBe(true);
    expect(tl[0].fill).toBe(0.96);
    expect(tl[0].ms).toBe(45_000);
  });

  it("drops skipped stages and falls back to the stage clocks without a plan", () => {
    const tl = planTimeline({
      stages,
      skipped: new Set(["separating"] as const),
      plan: null,
      stageTimes: {
        downloading: { start: 0, end: 5_000, observed: true },
        transcribing: { start: 5_000, observed: true },
      },
      progress: { stage: "transcribing", progress: 0.1 },
      complete: false,
      now: 20_000,
    });
    expect(tl.map((e) => e.stage)).toEqual(["downloading", "transcribing", "diarizing"]);
    expect(tl[0]).toMatchObject({ state: "done", ms: 5_000, estimated: false });
    expect(tl[1]).toMatchObject({ state: "active", elapsedMs: 15_000, estMs: null });
  });
});

describe("foldProgress no longer learns; it stamps per-language clocks", () => {
  it("stamps a unit's start the first time a poll names the target", () => {
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      foldProgress({ stage: "translating", progress: 0.1, target: "en", targetProgress: 0.2 });
      vi.setSystemTime(5_000);
      foldProgress({ stage: "translating", progress: 0.3, target: "en", targetProgress: 0.6 });
      foldProgress({ stage: "translating", progress: 0.5, target: "fr", targetProgress: 0.0 });
    } finally {
      vi.useRealTimers();
    }
    expect(useTranscribeRun.getState().stageMeta.translating?.unitStarts).toEqual({ en: 1_000, fr: 5_000 });
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
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

  it("opening a record drops an earlier run's decode overrides (the record stores none)", () => {
    useTranscribeRun.setState({ lastOverrides: { beam_size: 1 } });
    openHistoryRecord(recOf("rec-5", "/c.mp3"));
    expect(useTranscribeRun.getState().lastOverrides).toEqual({});
  });

  it("opening a record without options drops an earlier run's options (its retry must not inherit them)", () => {
    useTranscribeRun.setState({ lastOptions: { diarize: true } });
    openHistoryRecord(recOf("rec-6", "/d.mp3"));
    expect(useTranscribeRun.getState().lastOptions).toBeUndefined();
  });
});

describe("mergeSegmentTranslations kept-original marks", () => {
  it("sets translationsKept per merged segment; a clean re-merge clears it", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
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

describe("dropping a correction a re-translate was made from", () => {
  // The overlay persist debounces through window timers.
  beforeEach(() => vi.stubGlobal("window", globalThis));
  afterEach(() => vi.unstubAllGlobals());
  const recOf = (id: string): TranscriptRecord => ({
    schemaVersion: 1, kind: "file", id, createdAt: "2026-10-13T12:00:00Z",
    sourcePath: `/${id}.mp3`, sourceName: `${id}.mp3`, status: "done",
    result: {
      text: "I red the book",
      segments: [{ start: 0, end: 1, text: "I red the book", translations: { de: "Ich rot das Buch" } }],
      translation: { targets: ["de"] },
    },
  });
  const stale = (id: string) => useTranscribeRun.getState().translationsStale[id] ?? {};

  it("Discard marks the segment stale: the restored original was never translated", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    openHistoryRecord(recOf("fromedit-1"));
    setSegmentEdit("fromedit-1", 0, "I read the book");
    mergeSegmentTranslations("fromedit-1", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    expect(stale("fromedit-1")).toEqual({});
    clearEdits("fromedit-1");
    expect(stale("fromedit-1")).toEqual({ 0: true });
    flushPersistEdits();
    const saved = useTranscriptHistory.getState().records.find((r) => r.id === "fromedit-1")!;
    expect(saved.translationsStale).toEqual({ 0: true });
  });

  it("reverting the one line marks it stale too", () => {
    openHistoryRecord(recOf("fromedit-2"));
    setSegmentEdit("fromedit-2", 0, "I read the book");
    mergeSegmentTranslations("fromedit-2", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    setSegmentEdit("fromedit-2", 0, null);
    expect(stale("fromedit-2")).toEqual({ 0: true });
  });

  it("the marker survives a reopen of the record", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    openHistoryRecord(recOf("fromedit-3"));
    setSegmentEdit("fromedit-3", 0, "I read the book");
    mergeSegmentTranslations("fromedit-3", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    flushPersistEdits();
    const saved = useTranscriptHistory.getState().records.find((r) => r.id === "fromedit-3")!;
    useTranscribeRun.setState({ translatedFromEdit: {} });
    openHistoryRecord(saved);
    clearEdits("fromedit-3");
    expect(stale("fromedit-3")).toEqual({ 0: true });
  });

  it("a translation made from the original text leaves Discard clearing the mark", () => {
    openHistoryRecord(recOf("fromedit-4"));
    mergeSegmentTranslations("fromedit-4", { 0: { de: "Ich rot das Buch!" } }, { targets: ["de"] });
    setSegmentEdit("fromedit-4", 0, "I read the book");
    expect(stale("fromedit-4")).toEqual({ 0: true });
    clearEdits("fromedit-4");
    expect(stale("fromedit-4")).toEqual({});
  });

  it("a later merge with the correction gone drops the marker", () => {
    openHistoryRecord(recOf("fromedit-5"));
    setSegmentEdit("fromedit-5", 0, "I read the book");
    mergeSegmentTranslations("fromedit-5", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    setSegmentEdit("fromedit-5", 0, null);
    // Re-translate flagged: the original text goes out, the mark clears.
    mergeSegmentTranslations("fromedit-5", { 0: { de: "Ich rot das Buch" } }, { targets: ["de"] });
    expect(stale("fromedit-5")).toEqual({});
    setSegmentEdit("fromedit-5", 0, "I read the book");
    setSegmentEdit("fromedit-5", 0, null);
    expect(stale("fromedit-5")).toEqual({});
  });

  it("re-committing the same correction (focus + blur) leaves its translation fresh", () => {
    openHistoryRecord(recOf("fromedit-6"));
    setSegmentEdit("fromedit-6", 0, "I read the book");
    mergeSegmentTranslations("fromedit-6", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    setSegmentEdit("fromedit-6", 0, "I read the book");
    expect(stale("fromedit-6")).toEqual({});
    // A real change still flags it.
    setSegmentEdit("fromedit-6", 0, "I read the books");
    expect(stale("fromedit-6")).toEqual({ 0: true });
  });
  it("clicking into an uncorrected line and out again keeps its stale mark (revert, Discard)", () => {
    openHistoryRecord(recOf("fromedit-7"));
    setSegmentEdit("fromedit-7", 0, "I read the book");
    mergeSegmentTranslations("fromedit-7", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    setSegmentEdit("fromedit-7", 0, null);
    expect(stale("fromedit-7")).toEqual({ 0: true });
    // The bare focus + blur on the now uncorrected line commits null again.
    setSegmentEdit("fromedit-7", 0, null);
    expect(stale("fromedit-7")).toEqual({ 0: true });

    openHistoryRecord(recOf("fromedit-8"));
    setSegmentEdit("fromedit-8", 0, "I read the book");
    mergeSegmentTranslations("fromedit-8", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] });
    clearEdits("fromedit-8");
    setSegmentEdit("fromedit-8", 0, null);
    expect(stale("fromedit-8")).toEqual({ 0: true });
  });
  const fromEdit = (id: string) => useTranscribeRun.getState().translatedFromEdit[id] ?? {};

  it("a merge into a new language alone leaves the stale mark of the line's other languages", () => {
    openHistoryRecord(recOf("cover-1"));
    // The German translation is of the uncorrected text: stale.
    setSegmentEdit("cover-1", 0, "I read the book");
    expect(stale("cover-1")).toEqual({ 0: true });
    // "Translate now" into Spanish only: German still translates the old text.
    mergeSegmentTranslations("cover-1", { 0: { es: "Leo el libro" } }, { targets: ["es"] }, undefined, { 0: "I read the book" });
    expect(stale("cover-1")).toEqual({ 0: true });
    // Re-translated into every language the line holds: fresh.
    mergeSegmentTranslations(
      "cover-1", { 0: { de: "Ich lese das Buch", es: "Leo el libro" } }, { targets: ["de", "es"] }, undefined,
      { 0: "I read the book" },
    );
    expect(stale("cover-1")).toEqual({});
    expect(fromEdit("cover-1")).toEqual({ 0: true });
  });

  it("a line corrected while its chunk was in flight stays stale, and the translation is not marked as made from the correction", () => {
    openHistoryRecord(recOf("sent-1"));
    // Sent as the original text; corrected before the answer lands.
    setSegmentEdit("sent-1", 0, "I read the book");
    mergeSegmentTranslations("sent-1", { 0: { de: "Ich rot das Buch!" } }, { targets: ["de"] }, undefined, { 0: "I red the book" });
    expect(stale("sent-1")).toEqual({ 0: true });
    expect(fromEdit("sent-1")).toEqual({});
    // Reverting the correction: the translation matches the original again.
    setSegmentEdit("sent-1", 0, null);
    expect(stale("sent-1")).toEqual({});
  });

  it("a correction dropped while its chunk was in flight leaves the line stale and the translation marked as from it", () => {
    openHistoryRecord(recOf("sent-2"));
    setSegmentEdit("sent-2", 0, "I read the book");
    setSegmentEdit("sent-2", 0, null);
    mergeSegmentTranslations("sent-2", { 0: { de: "Ich lese das Buch" } }, { targets: ["de"] }, undefined, { 0: "I read the book" });
    expect(stale("sent-2")).toEqual({ 0: true });
    expect(fromEdit("sent-2")).toEqual({ 0: true });
  });
});

describe("refreshRowMediaPaths after a storage move", () => {
  it("points the open link's queue row at its record's moved copy", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    const rec: TranscriptRecord = {
      schemaVersion: 1, kind: "url", id: "moved-1", createdAt: "2026-10-13T12:00:00Z",
      sourcePath: "https://host/v", sourceName: "v", status: "done", mediaPath: "/old/links/moved-1.m4a",
      result: { text: "x", segments: [{ start: 0, end: 1, text: "x" }] },
    };
    openHistoryRecord(rec);
    const row = () => useTranscribeRun.getState().queue.find((q) => q.path === "https://host/v");
    expect(row()?.mediaPath).toBe("/old/links/moved-1.m4a");
    // Rust rewrote the record on disk; loadHistory(true) brought the moved copy into the mirror.
    useTranscriptHistory.setState((h) => ({
      records: [...h.records.filter((r) => r.id !== "moved-1"), { ...rec, mediaPath: "/new/links/moved-1.m4a" }],
    }));
    refreshRowMediaPaths();
    expect(row()?.mediaPath).toBe("/new/links/moved-1.m4a");
  });
});

describe("mergeSegmentTranslations keeps a known translation source", () => {
  it("an auto-detect answer's empty source never overwrites the record's code", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    openHistoryRecord({
      schemaVersion: 1, kind: "file", id: "src-1", createdAt: "2026-10-11T12:00:00Z",
      sourcePath: "/s.json", sourceName: "s.json", status: "done",
      result: {
        text: "a", language: "english",
        segments: [{ start: 0, end: 1, text: "a" }],
        translation: { source: "en", targets: ["de"] },
      },
    });
    mergeSegmentTranslations("src-1", { 0: { de: "A" } }, { targets: ["de"], source: "" });
    const saved = useTranscriptHistory.getState().records.find((r) => r.id === "src-1")!;
    expect(saved.result!.translation?.source).toBe("en");
  });
});

describe("mergeSegmentTranslations respects the OPEN record", () => {
  it("a background merge of record A never repaints the open record B of the same source", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    const of = (id: string, text: string): TranscriptRecord => ({
      schemaVersion: 1,
      kind: "file",
      id,
      createdAt: "2026-08-30T12:00:00Z",
      // The SAME source: the queue row is keyed by path, so both records share it.
      sourcePath: "/same.mp3",
      sourceName: "same.mp3",
      status: "done",
      result: { text, segments: [{ start: 0, end: 1, text }] },
    });
    const a = of("open-a", "a");
    const b = of("open-b", "b");
    openHistoryRecord(a);
    openHistoryRecord(b); // the user moved on to B while A's chunks are still merging
    mergeSegmentTranslations("open-a", { 0: { de: "A-de" } }, { targets: ["de"] });
    // The viewer still shows B's transcript...
    expect(useTranscribeRun.getState().openRecordId).toBe("open-b");
    expect(useTranscribeRun.getState().queue[0].result).toEqual(b.result);
    // ...while A's merge did land in the persisted record.
    const savedA = useTranscriptHistory.getState().records.find((r) => r.id === "open-a")!;
    expect(savedA.result!.segments![0].translations).toEqual({ de: "A-de" });
  });

  it("an open record of a DIFFERENT path does not suppress A's own queue row", () => {
    const of = (id: string, path: string): TranscriptRecord => ({
      schemaVersion: 1,
      kind: "file",
      id,
      createdAt: "2026-08-30T12:00:00Z",
      sourcePath: path,
      sourceName: path.slice(1),
      status: "done",
      result: { text: id, segments: [{ start: 0, end: 1, text: id }] },
    });
    const a = of("diff-a", "/a.mp3");
    const b = of("diff-b", "/b.mp3");
    openHistoryRecord(a);
    openHistoryRecord(b); // B open from History while A's retro-translate merges in the background
    // The multi-file run's queue still lists A's row beside B's.
    useTranscribeRun.setState((s) => ({
      queue: [...s.queue, { path: "/a.mp3", status: "done", kind: "file", result: a.result }],
    }));
    mergeSegmentTranslations("diff-a", { 0: { de: "A-de" } }, { targets: ["de"] });
    const rowA = useTranscribeRun.getState().queue.find((q) => q.path === "/a.mp3")!;
    expect(rowA.result!.segments![0].translations).toEqual({ de: "A-de" });
    expect(useTranscribeRun.getState().openRecordId).toBe("diff-b");
  });
});

describe("a run's late audio copy respects the OPEN record", () => {
  const ctx = { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false };
  // Runs /late.mp3 to done with its audio copy held open; returns the copy's resolver.
  async function runHeldCopy() {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    useTranscriptHistory.setState({ records: [], loaded: true });
    let land!: (p: string) => void;
    saveTranscriptMedia.mockImplementation(() => new Promise<string | null>((r) => { land = r; }));
    transcribeFile.mockImplementation((async () => ({ text: "new", segments: [{ start: 0, end: 1, text: "new" }] })) as never);
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    useTranscribeRun.setState({ files: ["/late.mp3"], queue: [], running: false, stageMeta: {}, stageTimes: {} });
    startRun(undefined, {}, ctx);
    await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
    await vi.waitFor(() => expect(saveTranscriptMedia).toHaveBeenCalled());
    const fresh = useTranscriptHistory.getState().records.find((r) => r.sourcePath === "/late.mp3")!;
    const saved = () => useTranscriptHistory.getState().records.find((r) => r.id === fresh.id)!;
    return { land, fresh, saved };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    transcribeFile.mockReset();
    saveTranscriptMedia.mockReset();
    useTranscribeRun.setState({ files: [], queue: [], stageMeta: {}, stageTimes: {} });
  });

  it("an older record of the same file opened meanwhile keeps its own audio", async () => {
    const { land, saved } = await runHeldCopy();
    const older: TranscriptRecord = {
      schemaVersion: 1, kind: "file", id: "late-older", createdAt: "2026-08-30T12:00:00Z",
      sourcePath: "/late.mp3", sourceName: "late.mp3", status: "done",
      result: { text: "old", segments: [{ start: 0, end: 1, text: "old" }] },
    };
    expect(openHistoryRecord(older)).toBe(true);
    land("/store/new-copy.mp3");
    // The fresh record still gets its copy...
    await vi.waitFor(() => expect(saved().mediaPath).toBe("/store/new-copy.mp3"));
    // ...but the open older transcript's row never plays (or exports) it.
    expect(useTranscribeRun.getState().openRecordId).toBe("late-older");
    expect(useTranscribeRun.getState().queue[0].mediaPath).toBeUndefined();
  });

  it("the run's own row still gets its copy", async () => {
    const { land, fresh, saved } = await runHeldCopy();
    land("/store/own-copy.mp3");
    await vi.waitFor(() => expect(saved().mediaPath).toBe("/store/own-copy.mp3"));
    expect(useTranscribeRun.getState().openRecordId).toBe(fresh.id);
    expect(useTranscribeRun.getState().queue[0].mediaPath).toBe("/store/own-copy.mp3");
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

describe("settledPanelItem (the completed panel's identity)", () => {
  const q = [
    { path: "A", status: "done" },
    { path: "B", status: "done" },
  ] as QueueItem[];
  it("follows the file the pump ran last, not the last queue row", () => {
    expect(settledPanelItem(q, "A")?.path).toBe("A");
  });
  it("falls back to the last settled row when nothing is selected", () => {
    expect(settledPanelItem(q, null)?.path).toBe("B");
    expect(settledPanelItem([{ path: "A", status: "queued" }] as QueueItem[], null)).toBeNull();
  });
});

describe("runTotals (whole-run footer figures)", () => {
  it("sums the finished items only", () => {
    const q = [
      { path: "A", status: "done", tookMs: 20_000, result: { text: "", duration: 60 } },
      { path: "B", status: "done", tookMs: 25_000, result: { text: "", duration: 90 } },
      { path: "C", status: "failed", tookMs: 5_000 },
    ] as unknown as QueueItem[];
    expect(runTotals(q)).toEqual({ tookMs: 45_000, audioSec: 150 });
  });
});

describe("retryFile carries new decode overrides into the store", () => {
  it("the rail's honesty line reads the store, so a VAD-off retry must update it", () => {
    useTranscribeRun.setState({
      queue: [{ path: "A", status: "failed" }] as QueueItem[],
      lastOverrides: { vad_filter: true },
      running: false,
    });
    retryFile(
      "A",
      { serverUrl: "http://x", backendId: "b", standard: true } as never,
      { vad_filter: false },
    );
    expect(useTranscribeRun.getState().lastOverrides.vad_filter).toBe(false);
    cancelRun();
  });
});

describe("reconcileRetryOptions (a retry after a backend switch)", () => {
  it("the wire-shaping keys follow the server the retry goes to", () => {
    // Last run on a standard server, retry on a full one: auto must not go out the standard way.
    expect(reconcileRetryOptions({ standard: true, task: "translate", useTranslationsEndpoint: true }, false))
      .toEqual({ task: "translate", useTranslationsEndpoint: false });
    // Last run on a full server, retry on a standard one.
    expect(reconcileRetryOptions({ task: "translate", useTranslationsEndpoint: false, diarize: true }, true))
      .toEqual({ standard: true, task: "translate", useTranslationsEndpoint: true, diarize: true });
    // No translate task: no endpoint key appears.
    expect(reconcileRetryOptions({ diarize: true }, true)).toEqual({ standard: true, diarize: true });
  });

  it("a retry on a standard server drops the translation slice", () => {
    // A link run failed on a T2T backend; the retry goes to a standard one, which has no
    // translating stage — the site plan's frozen targets must not go out either.
    const opts = { translateTo: ["fr"], translationMode: "fluent" as const, translationModel: "m", diarize: true };
    expect(reconcileRetryOptions(opts, true)).toEqual({ standard: true, diarize: true });
    expect(linkTranslateTo(reconcileRetryOptions(opts, true)!, { siteSubs: { mtTargets: ["fr"] } as never })).toBeUndefined();
    // A full backend keeps it — unless its translation is switched off.
    expect(reconcileRetryOptions(opts, false)).toEqual({ ...opts, standard: undefined });
    expect(reconcileRetryOptions(opts, false, false)).toEqual({ diarize: true, standard: undefined });
    // Caps not loaded yet (unknown): a full backend keeps the slice, as before caps gated it.
    expect(reconcileRetryOptions(opts, false, undefined)).toEqual({ ...opts, standard: undefined });
  });

  it("a retry onto a translating server leaves a missing slice missing", () => {
    // An explicit [] would switch a link's frozen site targets back on (linkTranslateTo) while the
    // rail, reading the un-reconciled options, shows no Translating stage.
    const out = reconcileRetryOptions({ diarize: true }, false, true);
    expect(out).toEqual({ diarize: true, standard: undefined });
    expect(linkTranslateTo(out!, { siteSubs: { mtTargets: ["de"] } as never })).toBeUndefined();
    expect(reconcileRetryOptions(undefined, false, true)).toBeUndefined();
  });

  it("a retried History record keeps only the wire-valid targets", () => {
    // Records saved before the chips were wire-checked may hold codes the transport refuses.
    expect(reconcileRetryOptions({ translateTo: ["de_CH", "fr"] }, false, true)!.translateTo).toEqual(["fr"]);
    // Still defined (an explicit "no targets"), so a site plan's choice is unchanged.
    expect(reconcileRetryOptions({ translateTo: ["x"] }, false, true)!.translateTo).toEqual([]);
    expect(reconcileRetryOptions({ diarize: true }, false, true)!.translateTo).toBeUndefined();
  });

  it("no last options: a standard server still gets its flag", () => {
    expect(reconcileRetryOptions(undefined, true)).toEqual({ standard: true });
    expect(reconcileRetryOptions(undefined, false)).toBeUndefined();
  });

  it("the store's lastOptions become the reconciled ones, so the rail shows only the stages the retry runs", async () => {
    useTranscribeRun.setState({
      queue: [{ path: "/s.srt", status: "failed", kind: "text" }] as QueueItem[],
      lastOptions: { translateTo: ["de"], translationMode: "faithful" },
      running: false,
    });
    retryFile("/s.srt", { serverUrl: "http://x", backendId: "b", standard: false, translationAvailable: false } as never);
    expect(useTranscribeRun.getState().lastOptions?.translateTo).toBeUndefined();
    expect(useTranscribeRun.getState().lastOptions?.translationMode).toBeUndefined();
    await vi.waitFor(() => expect(useTranscribeRun.getState().queue[0].status).toBe("failed"));
  });

  it("a text source retried on a full server with translation off names the server, not a hidden switch", async () => {
    useTranscribeRun.setState({
      queue: [{ path: "/s.srt", status: "failed", kind: "text" }] as QueueItem[],
      lastOptions: { translateTo: ["de"] },
      running: false,
    });
    retryFile("/s.srt", { serverUrl: "http://x", backendId: "b", standard: false, translationAvailable: false } as never);
    await vi.waitFor(() => expect(useTranscribeRun.getState().queue[0].status).toBe("failed"));
    expect(useTranscribeRun.getState().queue[0].error).toBe("Text files need a full backend with translation enabled.");
  });
});

describe("startRun releases the open record", () => {
  it("drops openRecordId with the selection", async () => {
    transcribeFile.mockImplementation((async () => { throw new Error("offline"); }) as never);
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    useTranscribeRun.setState({
      files: ["/next.mp3"], queue: [], running: false, stageMeta: {}, stageTimes: {},
      selectedPath: "/open.mp3", openRecordId: "A",
    });
    startRun(undefined, {}, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
    expect(useTranscribeRun.getState().selectedPath).toBeNull();
    expect(useTranscribeRun.getState().openRecordId).toBeNull();
    await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
    vi.unstubAllGlobals();
  });
});

describe("runBadgeFraction (the sidebar badge)", () => {
  const state = (over: Partial<ReturnType<typeof useTranscribeRun.getState>>) => {
    useTranscribeRun.setState({
      queue: [], progress: null, stageTimes: {}, stageMeta: {}, lastOptions: undefined,
      ...over,
    });
    return useTranscribeRun.getState();
  };
  afterEach(() => {
    useTranscribeRun.setState({ queue: [], progress: null, stageTimes: {}, stageMeta: {} });
  });

  it("is the server's overall for the running item, null when nothing runs", () => {
    // Nothing running or queued: there is no run to describe.
    expect(runBadgeFraction(state({ queue: [{ path: "/a.mp3", status: "done" }] as QueueItem[] }))).toBeNull();

    // Whatever the server's plan says, verbatim — a URL mid-download, a file
    // mid-decode and a text source all read the same field.
    expect(runBadgeFraction(state({
      queue: [{ path: "https://x/v", status: "running", kind: "url" }] as QueueItem[],
      progress: { stage: "downloading", progress: 0.5, overall: 0.04 },
    }))).toBeCloseTo(0.04, 5);
    expect(runBadgeFraction(state({
      queue: [{ path: "/s.srt", status: "running", kind: "text" }] as QueueItem[],
      progress: { stage: "translating", progress: 0.5, overall: 0.5 },
      lastOptions: { translateTo: ["de"] },
    }))).toBeCloseTo(0.5, 5);

    // Before the first poll answers there is no number yet: 0, never a guess.
    expect(runBadgeFraction(state({
      queue: [{ path: "/a.mp3", status: "running" }] as QueueItem[],
      progress: { stage: "transcribing", progress: 0.25 },
    }))).toBe(0);
  });
});

describe("forgetRecord (a deleted record must stay deleted)", () => {
  it("a later overlay edit cannot re-save a forgotten record", async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    vi.useFakeTimers();
    // The workbench's persist debounce runs on window timers (it lives in a webview);
    // the test env is `node`, so point `window` at the (faked) globals.
    vi.stubGlobal("window", globalThis);
    try {
      const rec: TranscriptRecord = {
        schemaVersion: 1,
        kind: "file",
        id: "gone-1",
        createdAt: "2026-08-30T12:00:00Z",
        sourcePath: "/gone.mp3",
        sourceName: "gone.mp3",
        status: "done",
        result: { text: "a", segments: [{ start: 0, end: 1, text: "a", speaker: "SPEAKER_00" }] },
      };
      // Opened from History's list, so the mirror holds it.
      useTranscriptHistory.setState({ records: [rec], loaded: false });
      saveTranscriptRecord.mockClear();
      openHistoryRecord(rec);
      forgetRecord(rec.id); // History deleted it out from under the open workbench
      setRename(rec.id, "SPEAKER_00", "Kate"); // the 800 ms persist debounce
      vi.advanceTimersByTime(900);
      expect(saveTranscriptRecord).not.toHaveBeenCalled();
      expect(useTranscriptHistory.getState().records).toEqual([rec]);
      expect(useTranscribeRun.getState().openRecordId).toBeNull();
    } finally {
      vi.useRealTimers();
      forgetRecord(null, { deleted: true });
      vi.unstubAllGlobals();
    }
  });
});

describe("forgetRecord(null) without deleted (a storage move or reset re-homes the records)", () => {
  const rec: TranscriptRecord = {
    schemaVersion: 1, kind: "file", id: "move-1", createdAt: "2026-10-13T12:00:00Z",
    sourcePath: "/old/m.mp3", sourceName: "m.mp3", status: "done",
    renames: { SPEAKER_00: "Alice" },
    result: { text: "a", segments: [{ start: 0, end: 1, text: "a", speaker: "SPEAKER_00" }] },
  };
  beforeEach(async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    useTranscriptHistory.setState({ records: [rec], loaded: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    forgetRecord(null, { deleted: true });
    vi.unstubAllGlobals();
  });

  it("the open record keeps its overlays, and a later rename saves onto the moved copy", async () => {
    const { currentRecord, useTranscriptHistory } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    setRename(rec.id, "SPEAKER_00", "Bob"); // pending when the move lands
    forgetRecord(null);
    // The pre-move write is dropped, not landed later on the reloaded mirror.
    vi.advanceTimersByTime(900);
    expect(currentRecord(rec.id)?.renames).toEqual({ SPEAKER_00: "Alice" });
    expect(useTranscribeRun.getState().openRecordId).toBe(rec.id);
    // loadHistory(true) lands the re-homed copy under the same id.
    useTranscriptHistory.setState({ records: [{ ...rec, sourcePath: "/new/m.mp3" }] });
    setRename(rec.id, "SPEAKER_00", "Carol");
    flushPersistEdits();
    const cur = currentRecord(rec.id)!;
    expect(cur.renames).toEqual({ SPEAKER_00: "Carol" });
    expect(cur.sourcePath).toBe("/new/m.mp3");
  });

  it("with deleted, the registry and the open record still go", async () => {
    const { currentRecord } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    forgetRecord(null, { deleted: true });
    expect(useTranscribeRun.getState().openRecordId).toBeNull();
    setRename(rec.id, "SPEAKER_00", "Carol");
    flushPersistEdits();
    expect(currentRecord(rec.id)?.renames).toEqual({ SPEAKER_00: "Alice" });
  });
});

describe("one current copy per record (the registries hold ids, never copies)", () => {
  const rec: TranscriptRecord = {
    schemaVersion: 1,
    kind: "url",
    id: "cur-1",
    createdAt: "2026-08-30T12:00:00Z",
    sourcePath: "https://example.com/watch?v=1",
    sourceName: "clip",
    status: "done",
    result: {
      text: "a",
      sourceMediaId: "srv-audio",
      segments: [{ start: 0, end: 1, text: "a", speaker: "SPEAKER_00" }],
    },
  };
  const saves = () => saveTranscriptRecord.mock.calls.filter(([id]) => id === rec.id);

  beforeEach(async () => {
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    useTranscriptHistory.setState({ records: [rec], loaded: true });
    saveTranscriptRecord.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    forgetRecord(null, { deleted: true });
    vi.unstubAllGlobals();
  });

  it("a viewer write, then a rename, keeps the viewer's fields", async () => {
    const { currentRecord } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    // The export panel's writes go straight to the history, not through the workbench.
    patchRecord(rec.id, (r) => ({ ...r, videoPath: "/video/cur-1.mkv" }));
    patchRecord(rec.id, (r) => ({
      ...r, result: { ...r.result!, sourceVideoMediaId: "srv-video" },
    }));
    setRename(rec.id, "SPEAKER_00", "Kate");
    vi.advanceTimersByTime(900);
    const cur = currentRecord(rec.id)!;
    expect(cur.renames).toEqual({ SPEAKER_00: "Kate" });
    expect(cur.videoPath).toBe("/video/cur-1.mkv");
    expect(cur.result?.sourceMediaId).toBe("srv-audio");
    expect(cur.result?.sourceVideoMediaId).toBe("srv-video");
    // ...and the file on disk: the persist wrote the merged record, not the opened copy.
    vi.advanceTimersByTime(2_100); // the coalesced tail
    const all = saves();
    const last = JSON.parse(String(all[all.length - 1][1])) as TranscriptRecord;
    expect(last.renames).toEqual({ SPEAKER_00: "Kate" });
    expect(last.videoPath).toBe("/video/cur-1.mkv");
    expect(last.result?.sourceVideoMediaId).toBe("srv-video");
  });

  it("flushPersistEdits lands a pending edit without waiting out the debounce", async () => {
    const { currentRecord, flushRecordWrites } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    setRename(rec.id, "SPEAKER_00", "Kate"); // parked in the 800 ms persist debounce
    expect(currentRecord(rec.id)?.renames).toBeUndefined();
    flushPersistEdits(); // the quit / reload / session-end path; no timer advanced
    expect(currentRecord(rec.id)?.renames).toEqual({ SPEAKER_00: "Kate" });
    await flushRecordWrites();
    const all = saves();
    expect(all.length).toBeGreaterThan(0);
    const last = JSON.parse(String(all[all.length - 1][1])) as TranscriptRecord;
    expect(last.renames).toEqual({ SPEAKER_00: "Kate" });
    // The debounce was consumed: its timer firing later writes nothing more.
    saveTranscriptRecord.mockClear();
    vi.advanceTimersByTime(900);
    expect(saves()).toEqual([]);
  });

  it("a record deleted during the edit debounce is not re-saved", async () => {
    const { currentRecord } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    setRename(rec.id, "SPEAKER_00", "Kate");
    deleteRecord(rec.id);
    saveTranscriptRecord.mockClear();
    vi.advanceTimersByTime(900);
    expect(saves()).toEqual([]);
    expect(currentRecord(rec.id)).toBeUndefined();
  });

  it("a record gone from the mirror (a wipe's reload) resolves to nothing", async () => {
    const { currentRecord, useTranscriptHistory } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    // The forced listing after a wipe no longer lists it; nothing told the registry.
    useTranscriptHistory.setState({ records: [] });
    saveTranscriptRecord.mockClear();
    setRename(rec.id, "SPEAKER_00", "Kate");
    mergeSegmentTranslations(rec.id, { 0: { de: "A-de" } }, { targets: ["de"] });
    vi.advanceTimersByTime(900);
    expect(saves()).toEqual([]);
    expect(currentRecord(rec.id)).toBeUndefined();
  });

  it("a translation merge lands on the latest copy too", async () => {
    const { currentRecord } = await import("./transcript/transcriptHistory");
    openHistoryRecord(rec);
    patchRecord(rec.id, (r) => ({ ...r, videoPath: "/video/cur-1.mkv" }));
    mergeSegmentTranslations(rec.id, { 0: { de: "A-de" } }, { targets: ["de"] });
    const cur = currentRecord(rec.id)!;
    expect(cur.videoPath).toBe("/video/cur-1.mkv");
    expect(cur.result?.segments?.[0].translations).toEqual({ de: "A-de" });
  });
});

describe("stageFiles: a pick that lands while a run is live waits for the next run", () => {
  it("appends to the list without touching the running queue", async () => {
    const { addFiles, stageFiles } = await import("./transcribeRun");
    const queue: QueueItem[] = [{ path: "/a.wav", status: "running", kind: "file" }];
    useTranscribeRun.setState({ files: ["/a.wav", "https://youtu.be/q"], queue, running: true, progress: null, stageTimes: {}, stageMeta: {} });
    const before = useTranscribeRun.getState();
    stageFiles(["/b.wav", "/a.wav", "HTTPS://YouTu.be/q"]);
    const s = useTranscribeRun.getState();
    expect(s.files).toEqual(["/a.wav", "https://youtu.be/q", "/b.wav"]);
    expect(s.queue).toBe(before.queue);
    expect(s.epoch).toBe(before.epoch);
    expect(s.running).toBe(true);
    // addFiles still resets: a changed input abandons the unsettled queue.
    addFiles(["/c.wav"]);
    expect(useTranscribeRun.getState().epoch).toBe(before.epoch + 1);
    expect(useTranscribeRun.getState().queue).toEqual([]);
    expect(useTranscribeRun.getState().files).toEqual(["/a.wav", "https://youtu.be/q", "/b.wav", "/c.wav"]);
    useTranscribeRun.setState({ files: [], queue: [], running: false, progress: null, stageTimes: {}, stageMeta: {} });
  });
});

describe("reattachRun: a run found in the ledger takes the rail back", () => {
  it("seeds the first stage clock from the row's start and routes Cancel to the job id", async () => {
    const { reattachRun } = await import("./transcribeRun");
    useTranscribeRun.setState({ files: [], queue: [], running: false, progress: null, stageTimes: {}, stageMeta: {} });
    const before = useTranscribeRun.getState().epoch;
    const epoch = reattachRun({
      v: 1, jobId: "c".repeat(32), backendId: "b1", serverUrl: "http://x", path: "https://youtu.be/q",
      kind: "url", title: "Talk", options: { separateBgm: true },
      ctx: { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false },
      urlMeta: { title: "Talk", extractor: "Youtube" }, startedAt: 123_000,
    }, () => "http://x");
    const s = useTranscribeRun.getState();
    expect(epoch).toBe(before + 1);
    expect(s.epoch).toBe(epoch);
    expect(s.running).toBe(true);
    expect(s.files).toEqual(["https://youtu.be/q"]);
    expect(s.queue).toEqual([{ path: "https://youtu.be/q", status: "running", kind: "url", title: "Talk" }]);
    // A link run starts on the download row, whatever the options say.
    expect(s.stageTimes).toEqual({ downloading: { start: 123_000 } });
    expect(s.urlMeta["https://youtu.be/q"]?.extractor).toBe("Youtube");
    expect(s.lastOptions).toEqual({ separateBgm: true });
    cancelRun();
    expect(useTranscribeRun.getState().running).toBe(true); // cancelRun leaves `running` to the pump/watcher
    useTranscribeRun.setState({ files: [], queue: [], running: false, progress: null, stageTimes: {}, stageMeta: {} });
  });

  it("a reattached link planned on the site's transcript is the fallback transcription", async () => {
    const { reattachRun } = await import("./transcribeRun");
    useTranscribeRun.setState({ files: [], queue: [], running: false, progress: null, stageTimes: {}, stageMeta: {} });
    reattachRun({
      v: 1, jobId: "d".repeat(32), backendId: "b1", serverUrl: "http://x", path: "https://youtu.be/f",
      kind: "url", title: "Talk", options: {},
      ctx: { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false },
      urlMeta: { title: "Talk", siteSubs: { fetch: ["en"], transcriptTrackId: "en", mtTargets: [] } }, startedAt: 1,
    }, () => "http://x");
    expect(useTranscribeRun.getState().queue[0].siteFallback).toBe(true);
    cancelRun();
    useTranscribeRun.setState({ files: [], queue: [], running: false, progress: null, stageTimes: {}, stageMeta: {} });
  });
});

describe("a link whose site transcript track cannot be fetched", () => {
  it("marks the RUNNING item as a fallback before the audio transcription is posted", async () => {
    const url = "https://youtu.be/site";
    fetchUrlSubtitles.mockImplementation(async () => { throw new Error("HTTP 403"); });
    let atPost: QueueItem | undefined;
    transcribeUrl.mockImplementation(async () => {
      atPost = useTranscribeRun.getState().queue.find((it) => it.path === url);
      throw new Error("HTTP 500: boom");
    });
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    try {
      useTranscribeRun.setState({
        files: [url], queue: [], running: false, stageMeta: {}, stageTimes: {},
        urlMeta: { [url]: { siteSubs: { fetch: ["en"], transcriptTrackId: "en", mtTargets: [] } } },
      });
      startRun(undefined, {}, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
      expect(atPost?.status).toBe("running");
      expect(atPost?.siteFallback).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      fetchUrlSubtitles.mockReset();
      transcribeUrl.mockReset();
      useTranscribeRun.setState({ files: [], queue: [], stageMeta: {}, stageTimes: {}, urlMeta: {} });
    }
  });
});

describe("a link card's spoken pick and an unoffered Multiple languages", () => {
  // The card freezes its pick at Add link; the model/profile/caps may stop offering the flag by
  // Run or Retry, and then the pick must not touch `multilingual` (as spokenField drops it).
  const url = "https://youtu.be/multi";
  const posted = async (
    meta: Record<string, unknown>,
    offered: boolean | undefined,
    extra: Record<string, unknown> = {},
  ) => {
    let sent: Parameters<typeof import("./api").transcribeUrl>[0] | undefined;
    transcribeUrl.mockImplementation(async (a) => {
      sent = a;
      throw new Error("HTTP 500: boom");
    });
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    try {
      useTranscribeRun.setState({
        files: [url], queue: [], running: false, stageMeta: {}, stageTimes: {},
        urlMeta: { [url]: meta },
      });
      startRun(undefined, { vad_filter: false }, {
        backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false,
        decodeOverrides: { vad_filter: false },
        ...(offered === undefined ? {} : { multilingualOffered: offered }),
        ...extra,
      });
      await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
      return sent;
    } finally {
      vi.unstubAllGlobals();
      transcribeUrl.mockReset();
      useTranscribeRun.setState({ files: [], queue: [], stageMeta: {}, stageTimes: {}, urlMeta: {} });
    }
  };

  it("an unoffered Multiple languages pick goes out as plain auto-detect", async () => {
    const sent = await posted({ spokenLanguage: MULTI_LANGUAGE }, false);
    expect(sent?.language).toBe("auto");
    expect(sent?.decodeOverrides).toEqual({ vad_filter: false });
  });

  it("an offered (or unknown, an older ledger row) pick still sends the flag", async () => {
    for (const offered of [true, undefined]) {
      const sent = await posted({ spokenLanguage: MULTI_LANGUAGE }, offered);
      expect(sent?.language).toBe("auto");
      expect(sent?.decodeOverrides).toEqual({ vad_filter: false, multilingual: true });
    }
  });

  it("an inherited-on Auto-detect sends no explicit false once the flag is unoffered", async () => {
    const sent = await posted({ spokenLanguage: "auto", spokenMultiInherited: true }, false);
    expect(sent?.language).toBe("auto");
    expect(sent?.decodeOverrides).toEqual({ vad_filter: false });
  });

  it("an Auto-detect added under a non-multilingual default sends false once the server's default is", async () => {
    // The card froze false (an English-only model, or the server values not loaded yet at Add).
    const sent = await posted(
      { spokenLanguage: "auto", spokenMultiInherited: false },
      true,
      { multilingualInherited: true },
    );
    expect(sent?.language).toBe("auto");
    expect(sent?.decodeOverrides).toEqual({ vad_filter: false, multilingual: false });
  });

  it("a live inherited-on default still sends no flag while it is unoffered", async () => {
    const sent = await posted({ spokenLanguage: "auto" }, false, { multilingualInherited: true });
    expect(sent?.language).toBe("auto");
    expect(sent?.decodeOverrides).toEqual({ vad_filter: false });
  });
});

describe("a link transcribed from the site's own subtitles keeps its audio's expiry", () => {
  // Without it the export panel reads the server audio as kept forever and keeps offering it.
  const url = "https://youtu.be/sitetx";
  const site = { fetch: ["en"], transcriptTrackId: "en", mtTargets: [] };
  // The on-demand downloads of the last run, read before the mock is reset below.
  let downloads = 0;
  const runOnce = async (meta: Record<string, unknown>) => {
    fetchUrlSubtitles.mockImplementation(async () => ({
      tracks: [{ id: "en", lang: "en", kind: "manual" as const, ext: "srt" as const, text: "1\n00:00:00,000 --> 00:00:01,000\nHi.\n" }],
      failed: [],
    }));
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    try {
      useTranscribeRun.setState({
        files: [url], queue: [], running: false, stageMeta: {}, stageTimes: {},
        urlMeta: { [url]: { siteSubs: site, ...meta } },
      });
      startRun(undefined, {}, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
      return useTranscribeRun.getState().queue.find((it) => it.path === url)?.result;
    } finally {
      vi.unstubAllGlobals();
      downloads = fetchUrlAudioOnDemand.mock.calls.length;
      fetchUrlSubtitles.mockReset();
      fetchUrlAudioOnDemand.mockReset();
      useTranscribeRun.setState({ files: [], queue: [], stageMeta: {}, stageTimes: {}, urlMeta: {} });
    }
  };

  it("stamps the on-demand download's expiry", async () => {
    fetchUrlAudioOnDemand.mockImplementation(async () => ({ mediaId: "a1", expiresAt: 1_900_000_000, height: null, container: null, bytes: null }));
    const res = await runOnce({});
    expect(res?.sourceMediaId).toBe("a1");
    expect(res?.sourceMediaExpiresAt).toBe(1_900_000_000);
  });

  it("stamps the language check's expiry when its audio is reused", async () => {
    fetchUrlAudioOnDemand.mockImplementation(async () => { throw new Error("not reached"); });
    // Relative to now: a fixed date would turn into the expired case below one day.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const res = await runOnce({ prefetchMediaId: "p1", prefetchBackendId: "b1", prefetchExpiresAt: exp });
    expect(downloads).toBe(0);
    expect(res?.sourceMediaId).toBe("p1");
    expect(res?.sourceMediaExpiresAt).toBe(exp);
  });

  it("downloads afresh when the language check's audio has already expired", async () => {
    // A check finished long before Run: the server dropped that id, so reusing it would leave
    // the transcript without playback.
    fetchUrlAudioOnDemand.mockImplementation(async () => ({ mediaId: "a3", expiresAt: 1_900_000_000, height: null, container: null, bytes: null }));
    const res = await runOnce({ prefetchMediaId: "p1", prefetchBackendId: "b1", prefetchExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    expect(downloads).toBe(1);
    expect(res?.sourceMediaId).toBe("a3");
    expect(res?.sourceMediaExpiresAt).toBe(1_900_000_000);
  });

  it("stamps none when the server names no expiry", async () => {
    fetchUrlAudioOnDemand.mockImplementation(async () => ({ mediaId: "a2", expiresAt: null, height: null, container: null, bytes: null }));
    const res = await runOnce({});
    expect(res?.sourceMediaId).toBe("a2");
    expect(res && "sourceMediaExpiresAt" in res).toBe(false);
  });
});

describe("keep_video: the secondary download folds into the Download row's meta", () => {
  it("keeps the video state and stamps its own rate clock, never reopening the stage clock", () => {
    useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      foldProgress({ stage: "transcribing", progress: 0.1,
        video: { state: "queued" } });
      expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("queued");
      expect(useTranscribeRun.getState().stageMeta.downloading?.videoDlStart).toBeUndefined();
      vi.setSystemTime(12_000);
      foldProgress({ stage: "transcribing", progress: 0.2,
        video: { state: "downloading", progress: 0.4, downloadedBytes: 40, totalBytes: 100 } });
      const meta = useTranscribeRun.getState().stageMeta.downloading;
      expect(meta?.video?.progress).toBe(0.4);
      expect(meta?.videoDlStart).toBe(12_000);
      // The download stage's own clock is untouched by the video fetch.
      expect(useTranscribeRun.getState().stageTimes.downloading).toBeUndefined();
      expect(meta?.videoDlEnd).toBeUndefined();
      // A finished video freezes its clock at the first terminal poll; later polls keep it.
      vi.setSystemTime(20_000);
      foldProgress({ stage: "transcribing", progress: 0.5,
        video: { state: "done", progress: 1, downloadedBytes: 100, totalBytes: 100 } });
      expect(useTranscribeRun.getState().stageMeta.downloading?.videoDlEnd).toBe(20_000);
      vi.setSystemTime(25_000);
      foldProgress({ stage: "transcribing", progress: 0.7,
        video: { state: "done", progress: 1, downloadedBytes: 100, totalBytes: 100 } });
      expect(useTranscribeRun.getState().stageMeta.downloading?.videoDlEnd).toBe(20_000);
    } finally {
      vi.useRealTimers();
      useTranscribeRun.setState({ progress: null, stageTimes: {}, stageMeta: {} });
    }
  });
});

describe("an on-demand video that fails outright shows on the Video row", () => {
  it("retryRunVideo queues the row, then marks it failed with the request's error", async () => {
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    const url = "https://youtu.be/v";
    try {
      openHistoryRecord({
        schemaVersion: 1, kind: "url", id: "rec-v", createdAt: "2026-10-05T12:00:00Z",
        sourcePath: url, sourceName: "Talk", status: "done",
      });
      // The settled panel is the link the run ran last.
      useTranscribeRun.setState({ lastRunPath: url,
        stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
      retryRunVideo(url, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("queued");
      // Outside Tauri the request rejects at once — the run used to only log that.
      await vi.waitFor(() => expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("failed"));
      expect(useTranscribeRun.getState().stageMeta.downloading?.video?.error).toBe("Video download requires the desktop app.");
    } finally {
      vi.unstubAllGlobals();
      useTranscribeRun.setState({ stageMeta: {} });
    }
  });
});

describe("an on-demand video that finishes is pulled once", () => {
  // The server closes an on-demand fetch's progress entry the moment the video is done, so
  // the poll reads "unknown" with no video: the request's own answer must pull the file.
  const url = "https://youtu.be/ondemand";
  const ctx = { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false };
  const dl = { mediaId: "v1", expiresAt: 123, height: 720, container: "mp4", bytes: 1000 };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let tick: (() => void) | null = null;
  let cleared = 0;
  beforeEach(() => {
    tick = null;
    cleared = 0;
    vi.stubGlobal("window", {
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      clearInterval: () => { cleared += 1; },
    });
    fetchUrlVideo.mockImplementation(() => Promise.resolve("/videos/rec-od.mp4"));
    openHistoryRecord({
      schemaVersion: 1, kind: "url", id: "rec-od", createdAt: "2026-10-05T12:00:00Z",
      sourcePath: url, sourceName: "Talk", status: "done",
    });
    useTranscribeRun.setState({ lastRunPath: url,
      stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
  });
  afterEach(() => {
    getTranscribeProgress.mockReset();
    fetchUrlVideoOnDemand.mockReset();
    fetchUrlVideo.mockReset();
    vi.unstubAllGlobals();
    useTranscribeRun.setState({ stageMeta: {} });
  });

  it("the request's answer pulls the video while the poll only reads the closed entry", async () => {
    getTranscribeProgress.mockImplementation(() =>
      Promise.resolve({ stage: "unknown" } as import("./types").BatchProgress));
    let answer: (d: typeof dl) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((r) => { answer = r; }));
    retryRunVideo(url, ctx);
    // Before the handler claims the id (or after it closes it) there is no entry: an open
    // request keeps the poll alive instead of giving up.
    tick!(); await flush();
    expect(cleared).toBe(0);
    answer(dl);
    await vi.waitFor(() => expect(fetchUrlVideo).toHaveBeenCalledTimes(1));
    expect(fetchUrlVideo.mock.calls[0][0].mediaId).toBe("v1");
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("done");
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.mediaId).toBe("v1");
    expect(cleared).toBe(1);
  });

  it("a request that answers before any poll names the video's format on the row", async () => {
    let answer: (d: typeof dl) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((r) => { answer = r; }));
    retryRunVideo(url, ctx);
    answer(dl);
    await vi.waitFor(() => expect(fetchUrlVideo).toHaveBeenCalledTimes(1));
    const video = useTranscribeRun.getState().stageMeta.downloading?.video;
    expect(video?.state).toBe("done");
    expect(video?.container).toBe("mp4");
    expect(video?.height).toBe(720);
  });

  it("an answer at another height drops the earlier attempt's rung label and codec", async () => {
    useTranscribeRun.setState({ stageMeta: { downloading: { video: {
      state: "failed", error: "old", height: 1080, label: "1080p Premium", vcodec: "avc1.640028", container: "mp4",
    } } } });
    let answer: (d: typeof dl) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((r) => { answer = r; }));
    retryRunVideo(url, ctx);
    answer(dl);
    await vi.waitFor(() => expect(fetchUrlVideo).toHaveBeenCalledTimes(1));
    const video = useTranscribeRun.getState().stageMeta.downloading?.video;
    expect(video?.height).toBe(720);
    expect(video?.label ?? null).toBeNull();
    expect(video?.vcodec ?? null).toBeNull();
  });

  it("an answer at the same height keeps the rung label and codec the poll saw", async () => {
    useTranscribeRun.setState({ stageMeta: { downloading: { video: {
      state: "failed", error: "old", height: 720, label: "720p60", vcodec: "vp09.00.40.08", container: "webm",
    } } } });
    let answer: (d: typeof dl) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((r) => { answer = r; }));
    retryRunVideo(url, ctx);
    answer(dl);
    await vi.waitFor(() => expect(fetchUrlVideo).toHaveBeenCalledTimes(1));
    const video = useTranscribeRun.getState().stageMeta.downloading?.video;
    expect(video?.label).toBe("720p60");
    expect(video?.vcodec).toBe("vp09.00.40.08");
  });

  it("a poll that sees done first pulls it, and the request's answer does not pull it again", async () => {
    getTranscribeProgress.mockImplementation(() => Promise.resolve({
      stage: "downloading", video: { state: "done", mediaId: "v1" },
    } as import("./types").BatchProgress));
    let answer: (d: typeof dl) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((r) => { answer = r; }));
    retryRunVideo(url, ctx);
    tick!(); await flush();
    expect(fetchUrlVideo).toHaveBeenCalledTimes(1);
    answer(dl);
    await flush(); await flush();
    expect(fetchUrlVideo).toHaveBeenCalledTimes(1);
  });
});

describe("an on-demand video whose request fails stays failed", () => {
  // The request's catch paints the row failed; a poll still out (or a later one while the
  // server keeps downloading) must not fold "downloading" back over it and hide Try again.
  const url = "https://youtu.be/ondemand-fail";
  const ctx = { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let tick: (() => void) | null = null;
  let cleared = 0;
  beforeEach(() => {
    tick = null;
    cleared = 0;
    vi.stubGlobal("window", {
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      // A cleared timer never fires again.
      clearInterval: () => { cleared += 1; tick = null; },
    });
    fetchUrlVideo.mockImplementation(() => Promise.resolve("/videos/rec-odf.mp4"));
    openHistoryRecord({
      schemaVersion: 1, kind: "url", id: "rec-odf", createdAt: "2026-10-05T12:00:00Z",
      sourcePath: url, sourceName: "Talk", status: "done",
    });
    useTranscribeRun.setState({ lastRunPath: url,
      stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
  });
  afterEach(() => {
    getTranscribeProgress.mockReset();
    fetchUrlVideoOnDemand.mockReset();
    fetchUrlVideo.mockReset();
    vi.unstubAllGlobals();
    useTranscribeRun.setState({ stageMeta: {} });
  });

  it("a poll answering 'downloading' after the request failed does not repaint the row", async () => {
    let poll: (p: import("./types").BatchProgress) => void = () => {};
    getTranscribeProgress.mockImplementation(() => new Promise((r) => { poll = r; }));
    let fail: (e: unknown) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((_r, j) => { fail = j; }));
    retryRunVideo(url, ctx);
    tick!();
    expect(getTranscribeProgress).toHaveBeenCalledTimes(1);
    fail(new Error("boom"));
    await vi.waitFor(() => expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("failed"));
    poll({ stage: "downloading", video: { state: "downloading", progress: 0.4 } } as import("./types").BatchProgress);
    await flush(); await flush();
    const video = useTranscribeRun.getState().stageMeta.downloading?.video;
    expect(video?.state).toBe("failed");
    expect(video?.error).toContain("boom");
    expect(fetchUrlVideo).not.toHaveBeenCalled();
  });

  it("the poll ends with the failed request, and Try again starts a fresh one", async () => {
    getTranscribeProgress.mockImplementation(() => Promise.resolve({
      stage: "downloading", video: { state: "downloading", progress: 0.4 },
    } as import("./types").BatchProgress));
    fetchUrlVideoOnDemand.mockImplementation(() => Promise.reject(new Error("boom")));
    retryRunVideo(url, ctx);
    await flush(); await flush();
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("failed");
    expect(cleared).toBe(1);
    // No timer left to tick: no further polls.
    tick?.(); await flush();
    expect(getTranscribeProgress).not.toHaveBeenCalled();
    // Try again: the row is queued afresh and its own poll paints it.
    let answer: (d: import("./api").UrlMediaDownload) => void = () => {};
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((r) => { answer = r; }));
    retryRunVideo(url, ctx);
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("queued");
    tick!(); await flush();
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("downloading");
    answer({ mediaId: "v2", expiresAt: null, height: null, container: null, bytes: null });
    await vi.waitFor(() => expect(fetchUrlVideo).toHaveBeenCalledTimes(1));
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("done");
  });

  it("an earlier attempt's late failure does not mark a Try again's download failed", async () => {
    getTranscribeProgress.mockImplementation(() => Promise.resolve({
      stage: "downloading", video: { state: "downloading", progress: 0.4 },
    } as import("./types").BatchProgress));
    // Two attempts, two timers: clearing the stale one must leave the new one ticking.
    const timers = new Map<number, () => void>();
    let nextId = 0;
    vi.stubGlobal("window", {
      setInterval: (fn: () => void) => { timers.set(++nextId, fn); return nextId; },
      clearInterval: (id: number) => { timers.delete(id); },
    });
    const fails: ((e: unknown) => void)[] = [];
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise((_r, j) => { fails.push(j); }));
    retryRunVideo(url, ctx);
    // Try again while the first request is still out: a new attempt.
    retryRunVideo(url, ctx);
    expect(fails).toHaveLength(2);
    fails[0](new Error("stale"));
    await flush(); await flush();
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("queued");
    expect(timers.has(2)).toBe(true);
    timers.get(2)!(); await flush();
    expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("downloading");
  });
});

describe("a pending video's poll slows down once its link is off screen", () => {
  it("polls every second while painting, every fifth tick once another link is shown", async () => {
    let tick: (() => void) | null = null;
    vi.stubGlobal("window", { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {} });
    getTranscribeProgress.mockImplementation(() => Promise.resolve({
      stage: "done", progress: 1, video: { state: "downloading", progress: 0.5 },
    } as import("./types").BatchProgress));
    // The on-demand request is still out (a failed one ends the poll).
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise(() => {}));
    const url = "https://youtu.be/cadence";
    const flush = () => new Promise((r) => setTimeout(r, 0));
    try {
      openHistoryRecord({
        schemaVersion: 1, kind: "url", id: "rec-cadence", createdAt: "2026-10-05T12:00:00Z",
        sourcePath: url, sourceName: "Talk", status: "done",
      });
      useTranscribeRun.setState({ lastRunPath: url,
        stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
      retryRunVideo(url, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      const run = async (n: number) => { for (let i = 0; i < n; i++) { tick!(); await flush(); } };
      // On screen: one GET per tick.
      await run(3);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(3);
      // Another link takes the panel: the poll paints nothing, so it drops to every fifth tick.
      useTranscribeRun.setState({ lastRunPath: "https://youtu.be/other" });
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(4);
      await run(4);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(4);
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(5);
      // Back on screen: the next poll resumes the 1 s cadence.
      useTranscribeRun.setState({ lastRunPath: url });
      await run(5);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(6);
      await run(2);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(8);
    } finally {
      getTranscribeProgress.mockReset();
      fetchUrlVideoOnDemand.mockReset();
      vi.unstubAllGlobals();
      useTranscribeRun.setState({ stageMeta: {} });
    }
  });

  it("a painting link's poll also drops to every fifth tick while the window is hidden", async () => {
    let tick: (() => void) | null = null;
    vi.stubGlobal("window", { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {} });
    getTranscribeProgress.mockImplementation(() => Promise.resolve({
      stage: "done", progress: 1, video: { state: "downloading", progress: 0.5 },
    } as import("./types").BatchProgress));
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise(() => {}));
    const url = "https://youtu.be/cadence-hidden";
    const flush = () => new Promise((r) => setTimeout(r, 0));
    try {
      openHistoryRecord({
        schemaVersion: 1, kind: "url", id: "rec-cadence-hidden", createdAt: "2026-10-05T12:00:00Z",
        sourcePath: url, sourceName: "Talk", status: "done",
      });
      useTranscribeRun.setState({ lastRunPath: url,
        stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
      retryRunVideo(url, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      const run = async (n: number) => { for (let i = 0; i < n; i++) { tick!(); await flush(); } };
      await run(2);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(2);
      // Closed to the tray: still the link on screen, but nobody sees it.
      windowHidden = true;
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(3);
      await run(4);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(3);
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(4);
      // Shown again: the next poll resumes the 1 s cadence.
      windowHidden = false;
      await run(5);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(5);
      await run(2);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(7);
    } finally {
      windowHidden = false;
      getTranscribeProgress.mockReset();
      fetchUrlVideoOnDemand.mockReset();
      vi.unstubAllGlobals();
      useTranscribeRun.setState({ stageMeta: {} });
    }
  });

  it("showing the window resumes the 1 s poll at once, keeps a failure backoff, and unsubscribes at the end", async () => {
    let tick: (() => void) | null = null;
    vi.stubGlobal("window", { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {} });
    let answer: () => Promise<import("./types").BatchProgress> = () => Promise.resolve({
      stage: "done", progress: 1, video: { state: "downloading", progress: 0.5 },
    } as import("./types").BatchProgress);
    getTranscribeProgress.mockImplementation(() => answer());
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise(() => {}));
    const url = "https://youtu.be/cadence-show";
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const before = hiddenListeners.size;
    const show = () => { windowHidden = false; for (const fn of [...hiddenListeners]) fn(false); };
    try {
      openHistoryRecord({
        schemaVersion: 1, kind: "url", id: "rec-cadence-show", createdAt: "2026-10-05T12:00:00Z",
        sourcePath: url, sourceName: "Talk", status: "done",
      });
      useTranscribeRun.setState({ lastRunPath: url,
        stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
      retryRunVideo(url, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      expect(hiddenListeners.size).toBe(before + 1);
      const run = async (n: number) => { for (let i = 0; i < n; i++) { tick!(); await flush(); } };
      // A hidden poll sets the slow cadence; the show clears it: the very next tick polls.
      windowHidden = true;
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(1);
      show();
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(2);
      // A failed poll's backoff (one skipped tick after the first failure) outlives a show.
      windowHidden = true;
      answer = () => Promise.reject(new Error("offline"));
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(3);
      show();
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(3);
      // A terminal state ends the poll and drops its show listener with the timer.
      answer = () => Promise.resolve({
        stage: "done", progress: 1, video: { state: "failed", error: "gone" },
      } as import("./types").BatchProgress);
      await run(1);
      expect(getTranscribeProgress).toHaveBeenCalledTimes(4);
      expect(hiddenListeners.size).toBe(before);
    } finally {
      windowHidden = false;
      getTranscribeProgress.mockReset();
      fetchUrlVideoOnDemand.mockReset();
      vi.unstubAllGlobals();
      useTranscribeRun.setState({ stageMeta: {} });
    }
  });
});

describe("a same-link retry takes the Video row from the first run's watcher", () => {
  it("the first run's still-polling video watcher stops painting once the retry has the rail", async () => {
    const ticks: (() => void)[] = [];
    vi.stubGlobal("window", { setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {} });
    // Only the first watcher's id reports a video; every other poll (the retry's) has none.
    let watcherPid: string | null = null;
    getTranscribeProgress.mockImplementation((a) => {
      watcherPid ??= a.progressId;
      return Promise.resolve((a.progressId === watcherPid
        ? { stage: "done", progress: 1, video: { state: "downloading", progress: 0.5 } }
        : { stage: "waiting", progress: 0 }) as import("./types").BatchProgress);
    });
    // The first watcher's on-demand request is still out (a failed one ends its poll).
    fetchUrlVideoOnDemand.mockImplementation(() => new Promise(() => {}));
    const url = "https://youtu.be/retry";
    const ctx = { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    try {
      openHistoryRecord({
        schemaVersion: 1, kind: "url", id: "rec-retry", createdAt: "2026-10-05T12:00:00Z",
        sourcePath: url, sourceName: "Talk", status: "done",
      });
      useTranscribeRun.setState({ lastRunPath: url,
        stageMeta: { downloading: { video: { state: "failed", error: "old" } } } });
      retryRunVideo(url, ctx);
      const watcher = ticks[0];
      // The retry queued the row; clear it, then the watcher paints.
      await flush();
      useTranscribeRun.setState({ stageMeta: {} });
      watcher();
      await flush();
      expect(useTranscribeRun.getState().stageMeta.downloading?.video?.state).toBe("downloading");
      // The same link is retried under the same epoch (outside Tauri it fails at once).
      useTranscribeRun.setState({ queue: [{ path: url, status: "failed", kind: "url" }] as QueueItem[], running: false });
      retryFile(url, ctx);
      await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
      expect(useTranscribeRun.getState().lastRunPath).toBe(url);
      useTranscribeRun.setState({ stageMeta: {} });
      for (let i = 0; i < 6; i++) { watcher(); await flush(); }
      expect(useTranscribeRun.getState().stageMeta.downloading?.video).toBeUndefined();
    } finally {
      getTranscribeProgress.mockReset();
      fetchUrlVideoOnDemand.mockReset();
      vi.unstubAllGlobals();
      useTranscribeRun.setState({ stageMeta: {} });
    }
  });
});

describe("withSiteTracks", () => {
  it("a site-track download that fails becomes a warning on the result, never an error", async () => {
    const res = { text: "x", warnings: ["w1"] };
    const meta = { siteSubs: { fetch: ["de"], transcriptTrackId: null, mtTargets: [] } };
    const out = await withSiteTracks(res, "https://youtu.be/q", meta, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
    expect(out.timedTracks).toBeUndefined();
    expect(out.warnings).toEqual(["w1", "The site's subtitles could not be downloaded: Subtitle download requires the desktop app."]);
    expect(await withSiteTracks(res, "https://youtu.be/q", undefined, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false })).toBe(res);
  });
  it("a link ledgered with a site transcript is the audio fallback: it keeps that warning and gains no extra track", async () => {
    const res = { text: "x" };
    const meta = { siteSubs: { fetch: ["en"], transcriptTrackId: "en", mtTargets: [] } };
    const out = await withSiteTracks(res, "https://youtu.be/q", meta, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
    expect(out.timedTracks).toBeUndefined();
    expect(out.warnings).toContain(SITE_TRANSCRIPT_FALLBACK);
    expect(out.warnings?.filter((w) => w === SITE_TRANSCRIPT_FALLBACK)).toHaveLength(1);
  });
  it("a ledgered site transcript that downloads fine now still rides as the fallback warning, not a track", async () => {
    // The download succeeding is the case only withSiteTracks' own push covers: fetchSiteSubs
    // finds the transcript and adds no warning of its own.
    fetchUrlSubtitles.mockImplementation(async () => ({ tracks: [{ id: "en", lang: "en", kind: "manual", ext: "vtt",
      text: "WEBVTT\n\n00:00.000 --> 00:01.000\nhi" }], failed: [] }) as never);
    try {
      const res = { text: "x" };
      const meta = { siteSubs: { fetch: ["en"], transcriptTrackId: "en", mtTargets: [] } };
      const out = await withSiteTracks(res, "https://youtu.be/q", meta, { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false });
      expect(fetchUrlSubtitles).toHaveBeenCalledTimes(1);
      expect(out.timedTracks).toBeUndefined();
      expect(out.warnings?.filter((w) => w === SITE_TRANSCRIPT_FALLBACK)).toHaveLength(1);
    } finally {
      fetchUrlSubtitles.mockReset();
    }
  });
});

describe("axisLayout", () => {
  it("never prints two labels of one row through each other", () => {
    // Two tiny early stages at the 5px floor, then a long transcribe segment.
    const px = [5, 5, 626];
    const labelPx = [52, 170, 65];
    const out = axisLayout(px, labelPx, 640);
    const starts = out.map((o, i) => px.slice(0, i).reduce((a, w) => a + w + 2, 0) + o.offset);
    for (const row of [0, 1] as const) {
      const idx = out.map((o, i) => (o.row === row ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < idx.length; k++) {
        expect(starts[idx[k]]).toBeGreaterThanOrEqual(starts[idx[k - 1]] + labelPx[idx[k - 1]]);
      }
    }
  });
  it("wide segments all sit on the top row at their own start", () => {
    expect(axisLayout([200, 200, 200], [50, 50, 50], 604)).toEqual([
      { row: 0, offset: 0 },
      { row: 0, offset: 0 },
      { row: 0, offset: 0 },
    ]);
  });
  it("a label that overflows the right edge is pulled left", () => {
    const out = axisLayout([300, 300], [50, 320], 602);
    expect(out[1].offset).toBeLessThanOrEqual(0);
    expect(300 + 2 + out[1].offset + 320).toBeLessThanOrEqual(602);
  });
});

describe("SKIPPED_EXPLANATIONS", () => {
  it("every optional stage on a full rail has its own sentence", () => {
    const rail = railStages({ separateBgm: true, diarize: true, translateTo: ["de"] } as never, true);
    for (const st of rail) {
      if (st === "transcribing") continue;
      expect(SKIPPED_EXPLANATIONS[st].length).toBeGreaterThan(0);
    }
    expect(SKIPPED_EXPLANATIONS.translating).not.toBe(SKIPPED_EXPLANATIONS.diarizing);
  });
});

describe("a ledgered file whose request lost contact", () => {
  const ctx = { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false, jobsEnabled: true };
  async function run(error: string) {
    const { ledgerRows, _resetLedgerForTests } = await import("./jobsLedger");
    const { useTranscriptHistory } = await import("./transcript/transcriptHistory");
    const { useApp } = await import("./store");
    _resetLedgerForTests();
    useTranscriptHistory.setState({ records: [], loaded: true });
    useApp.setState({ logsDoorway: null });
    let pid: string | undefined;
    transcribeFile.mockImplementation(async (a) => {
      pid = a.options?.progressId;
      throw new Error(error);
    });
    const watch = vi.fn();
    setOrphanWatch(watch);
    vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
    try {
      useTranscribeRun.setState({ files: ["/lost.mp3"], queue: [], running: false, stageMeta: {}, stageTimes: {} });
      startRun(undefined, {}, ctx);
      await vi.waitFor(() => expect(useTranscribeRun.getState().running).toBe(false));
      await Promise.resolve();
      return {
        pid: pid!, watch, rows: ledgerRows(), records: useTranscriptHistory.getState().records,
        doorway: useApp.getState().logsDoorway?.msg ?? "",
      };
    } finally {
      vi.unstubAllGlobals();
      setOrphanWatch(null);
      transcribeFile.mockReset();
      useTranscribeRun.setState({ files: [], queue: [], stageMeta: {}, stageTimes: {} });
    }
  }

  it("a timeout keeps the ledger row for a headless watcher and records under the job id", async () => {
    const { pid, watch, rows, records } = await run("Timed out waiting for the server.");
    expect(pid).toMatch(/^[0-9a-f]+$/);
    expect(watch).toHaveBeenCalledWith(pid);
    expect(rows.map((r) => r.jobId)).toEqual([pid]);
    expect(records.map((r) => [r.id, r.status])).toEqual([[pid, "failed"]]);
    // Stamped with the request start, the createdAt the watcher's ingest upserts with.
    expect(records[0].createdAt).toBe(new Date(rows[0].startedAt).toISOString());
  });

  it("a handed-off run's banner says it may still land in History, not 'try again'", async () => {
    // A retry would stop the watcher and delete the server job that is still finishing.
    const { doorway } = await run("Timed out waiting for the server.");
    expect(doorway).toContain("History");
    expect(doorway).not.toContain("try again");
  });

  it("a refused connection started no job: forgets the row, is never watched, says nothing was started", async () => {
    const { watch, rows, doorway } = await run("Could not connect — is the server running and the URL correct?");
    expect(watch).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(doorway).toContain("nothing was started");
    expect(doorway).not.toContain("History");
  });

  it("a server answer (HTTP 500) still forgets the row and is never watched", async () => {
    const { pid, watch, rows, records, doorway } = await run("HTTP 500: boom");
    expect(doorway).not.toContain("History");
    expect(watch).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0].id).not.toBe(pid);
  });

  it("a connection dropped mid-wait is handed off like a timeout", async () => {
    const { pid, watch, rows } = await run("error sending request");
    expect(watch).toHaveBeenCalledWith(pid);
    expect(rows.map((r) => r.jobId)).toEqual([pid]);
  });
});

describe("lostContact (which failures leave a job the server may still finish)", () => {
  it.each([
    ["Timed out waiting for the server.", true],
    ["Could not connect — is the server running and the URL correct?", false],
    ["error sending request", true],
    ["HTTP 504: Gateway Timeout", true],
    ["HTTP 502: Bad Gateway", true],
    ["HTTP 503: timed out waiting for a peer worker", false],
    ["HTTP 500: boom", false],
    ["HTTP 500: error sending request upstream", false],
    ["error decoding response body", false],
    ["upload_too_large:300000000:200000000", false],
  ])("%s → %s", (msg, lost) => {
    expect(lostContact(new Error(msg))).toBe(lost);
  });
});

describe("translateParsed joins a text source like the TXT export", () => {
  const ctx = { backendId: "b1", serverUrl: "http://x", model: "m", language: "", standard: false };
  afterEach(() => translateText.mockReset());

  it("no seam space inside CJK, one space between Latin cues", async () => {
    const ja = await translateParsed({ segments: [{ text: "こんにちは。" }, { text: " 元気ですか。" }] }, {}, ctx);
    expect(ja.text).toBe("こんにちは。元気ですか。");
    const en = await translateParsed({ segments: [{ text: "Hello." }, { text: "How are you?" }] }, {}, ctx);
    expect(en.text).toBe("Hello. How are you?");
  });

  it("the per-target translations join the same way", async () => {
    translateText.mockImplementation(() =>
      Promise.resolve({ results: [{ ja: "やあ。", de: "Hallo." }, { ja: "元気？", de: "Wie geht's?" }] }),
    );
    const r = await translateParsed(
      { segments: [{ text: "Hi." }, { text: "How are you?" }] }, { translateTo: ["ja", "de"] }, ctx,
    );
    expect(r.translations).toEqual({ ja: "やあ。元気？", de: "Hallo. Wie geht's?" });
  });

  it("a list over the server's limit sends the first ones and names the rest", async () => {
    // The text route rejects an over-limit list whole (a link's frozen site plan, a list kept
    // from a higher-limit backend): cut it here, in the audio route's own warning words.
    const { useApp } = await import("./store");
    const before = useApp.getState().caps;
    useApp.setState({
      caps: { ...before, b1: { server_info: { limits: { translation_max_targets: 2 } } } as never },
    });
    try {
      translateText.mockImplementation(() => Promise.resolve({ results: [{ de: "Hallo.", fr: "Salut." }] }));
      const r = await translateParsed(
        { segments: [{ text: "Hi." }] }, { translateTo: ["de", "fr", "es", "it"] }, ctx,
      );
      expect(translateText.mock.calls[0][0].targets).toEqual(["de", "fr"]);
      expect(r.warnings).toContain("translation targets over TRANSLATION_MAX_TARGETS (2) were dropped: es, it");
    } finally {
      useApp.setState({ caps: before });
    }
  });

  it("caps never fetched for this backend are fetched once, then the list is cut to the server's limit", async () => {
    // A retry against a backend whose caps were never loaded: the text route would 422 the
    // whole list, so the caps are fetched here first, then the cap is read from them.
    const { useApp } = await import("./store");
    const before = useApp.getState().caps;
    const prevBackends = useApp.getState().backends;
    const { b1: _b1, ...rest } = before as Record<string, unknown>;
    useApp.setState({
      caps: rest as never,
      backends: [...prevBackends, { id: "b1", name: "B1", serverUrl: "http://x" } as never],
    });
    refreshCaps.mockImplementation(async () => {
      useApp.setState({
        caps: { ...useApp.getState().caps, b1: { server_info: { limits: { translation_max_targets: 2 } } } as never },
      });
    });
    try {
      translateText.mockImplementation(() => Promise.resolve({ results: [{ de: "Hallo.", fr: "Salut." }] }));
      const r = await translateParsed(
        { segments: [{ text: "Hi." }] }, { translateTo: ["de", "fr", "es"] }, ctx,
      );
      expect(refreshCaps).toHaveBeenCalledTimes(1);
      expect(refreshCaps).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }), { force: true });
      expect(translateText.mock.calls[0][0].targets).toEqual(["de", "fr"]);
      expect(r.warnings).toContain("translation targets over TRANSLATION_MAX_TARGETS (2) were dropped: es");
    } finally {
      refreshCaps.mockReset();
      useApp.setState({ caps: before, backends: prevBackends });
    }
  });

  it("a saved target the wire refuses is neither sent nor recorded", async () => {
    const { useApp } = await import("./store");
    const before = useApp.getState().caps;
    useApp.setState({
      caps: { ...before, b1: { server_info: { limits: { translation_max_targets: 1 } } } as never },
    });
    try {
      translateText.mockImplementation(() => Promise.resolve({ results: [{ fr: "Salut." }] }));
      const r = await translateParsed({ segments: [{ text: "Hi." }] }, { translateTo: ["de_CH", "fr"] }, ctx);
      // Within the limit of one once the refused code is gone: no dropped-targets warning.
      expect(translateText.mock.calls[0][0].targets).toEqual(["fr"]);
      expect(Object.keys(r.translations ?? {})).toEqual(["fr"]);
      expect(r.warnings ?? []).toEqual([]);
    } finally {
      useApp.setState({ caps: before });
    }
  });

  it("a language named as a word is not sent as the source (the route 422s it); a code is", async () => {
    // An OpenAI verbose_json import says `"language": "english"`.
    translateText.mockImplementation(() => Promise.resolve({ results: [{ fr: "Salut." }] }));
    const word = await translateParsed({ language: "english", segments: [{ text: "Hi." }] }, { translateTo: ["fr"] }, ctx);
    expect(translateText.mock.calls[0][0].source).toBeNull();
    expect(word.translation?.source).toBeUndefined();
    // The display language stays what the file said.
    expect(word.language).toBe("english");
    translateText.mockClear();
    const code = await translateParsed({ language: "de", segments: [{ text: "Hi." }] }, { translateTo: ["fr"] }, ctx);
    expect(translateText.mock.calls[0][0].source).toBe("de");
    expect(code.translation?.source).toBe("de");
  });

  it("within the limit, or with an unknown limit (the app's ceiling), the whole list goes out without a warning", async () => {
    // undefined = no caps for b1: the app's ceiling applies.
    const { useApp } = await import("./store");
    const before = useApp.getState().caps;
    translateText.mockImplementation(() => Promise.resolve({ results: [{ de: "Hallo.", fr: "Salut." }] }));
    try {
      for (const max of [2, undefined]) {
        const rest: Record<string, unknown> = { ...before };
        delete rest.b1;
        useApp.setState({
          caps: (max === undefined
            ? rest
            : { ...rest, b1: { server_info: { limits: { translation_max_targets: max } } } }) as never,
        });
        translateText.mockClear();
        const r = await translateParsed(
          { segments: [{ text: "Hi." }] }, { translateTo: ["de", "fr"] }, ctx,
        );
        expect(translateText.mock.calls[0][0].targets).toEqual(["de", "fr"]);
        expect(r.warnings ?? []).toEqual([]);
      }
    } finally {
      useApp.setState({ caps: before });
    }
  });
});

describe("linkPrefetchFor — a prefetched media id only goes back to the server that issued it", () => {
  it("reuses the id on its issuer and drops it anywhere else", () => {
    const meta = { prefetchMediaId: "m", prefetchBackendId: "A" };
    expect(linkPrefetchFor(meta, "A")).toBe("m");
    expect(linkPrefetchFor(meta, "B")).toBeUndefined();
    expect(linkPrefetchFor({ prefetchMediaId: "m" }, "A")).toBeUndefined(); // issuer unknown
    expect(linkPrefetchFor(undefined, "A")).toBeUndefined();
  });

  it("drops an expired id or one inside the last minute, and keeps one whose expiry is unknown", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(linkPrefetchFor({ prefetchMediaId: "m", prefetchBackendId: "A", prefetchExpiresAt: 1 }, "A")).toBeUndefined();
    // The 60 s margin: an id the server drops mid-run would cost the transcript its playback.
    expect(linkPrefetchFor({ prefetchMediaId: "m", prefetchBackendId: "A", prefetchExpiresAt: now + 30 }, "A")).toBeUndefined();
    expect(linkPrefetchFor({ prefetchMediaId: "m", prefetchBackendId: "A", prefetchExpiresAt: now + 600 }, "A")).toBe("m");
    expect(linkPrefetchFor({ prefetchMediaId: "m", prefetchBackendId: "A", prefetchExpiresAt: undefined }, "A")).toBe("m");
  });
});
