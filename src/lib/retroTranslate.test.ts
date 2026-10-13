// Chunked retro-translate: the chunk-loop driver's merging/cancel contract
// and the mini progress card's poll-folding state machine. The React side
// (TranscriptViewer) only wires these to translateText + the store.
import { describe, expect, it, vi } from "vitest";
import {
  beginChunk, foldPollFailure, foldTranslatePoll, newTranslateRun,
  runChunkedTranslate, TRANSLATE_CHUNK, type TranslateRunUi,
  translateOptsFrom, untranslatedIndexes,
} from "./retroTranslate";
import type { TextTranslationResult } from "./api";

const answer = (texts: string[], lang = "en"): TextTranslationResult => ({
  results: texts.map((t) => ({ [lang]: `${lang}:${t}` })),
  model: "org/model:q4",
  source: "de",
});

describe("runChunkedTranslate", () => {
  it("splits 900 segments into 400/400/100 requests and merges per chunk", async () => {
    const indexes = Array.from({ length: 900 }, (_, i) => i);
    const sizes: number[] = [];
    const merges: { patchKeys: number[]; first: boolean }[] = [];
    const starts: [number[], number][] = [];
    const r = await runChunkedTranslate({
      indexes,
      chunk: 400,
      textOf: (i) => `t${i}`,
      translate: (texts) => {
        sizes.push(texts.length);
        return Promise.resolve(answer(texts));
      },
      onChunkStart: (idxs, d) => starts.push([idxs, d]),
      onMerge: (patch, _prov, first) =>
        merges.push({ patchKeys: Object.keys(patch).map(Number), first }),
    });
    expect(sizes).toEqual([400, 400, 100]);
    expect(starts.map(([idxs, d]) => [idxs[0], d, idxs.length]))
      .toEqual([[0, 0, 400], [400, 400, 400], [800, 800, 100]]);
    expect(merges).toHaveLength(3);
    expect(merges[0].first).toBe(true);
    expect(merges[1].first).toBe(false);
    expect(merges[0].patchKeys[0]).toBe(0);
    expect(merges[2].patchKeys[merges[2].patchKeys.length - 1]).toBe(899);
    expect(r).toMatchObject({ model: "org/model:q4", source: "de", cancelled: false, mergedChunks: 3 });
  });

  it("hands each merged segment's text as it was SENT, not as it reads when the answer lands", async () => {
    const texts: Record<number, string> = { 3: "A", 17: "B" };
    const sents: Record<number, string>[] = [];
    await runChunkedTranslate({
      indexes: [3, 17],
      textOf: (i) => texts[i],
      translate: (sent) => {
        texts[3] = "A corrected meanwhile";
        return Promise.resolve(answer(sent));
      },
      onMerge: (_patch, _prov, _first, _kept, sent) => sents.push(sent),
    });
    expect(sents).toEqual([{ 3: "A", 17: "B" }]);
  });

  it("keys the patch by SEGMENT index even for a sparse stale-row set", async () => {
    const merges: Record<number, Record<string, string>>[] = [];
    await runChunkedTranslate({
      indexes: [3, 17, 42],
      textOf: (i) => `t${i}`,
      translate: (texts) => Promise.resolve(answer(texts)),
      onMerge: (patch) => merges.push(patch),
    });
    expect(Object.keys(merges[0]).map(Number)).toEqual([3, 17, 42]);
    expect(merges[0][17]).toEqual({ en: "en:t17" });
  });

  it("drops per-segment empty results and skips an all-empty chunk's merge", async () => {
    const onMerge = vi.fn();
    const r = await runChunkedTranslate({
      indexes: [0, 1],
      textOf: (i) => `t${i}`,
      translate: (texts) => Promise.resolve({ results: texts.map(() => ({})) }),
      onMerge,
    });
    expect(onMerge).not.toHaveBeenCalled();
    expect(r.mergedChunks).toBe(0);
  });

  it("cancel between chunks keeps completed merges and stops the loop", async () => {
    let cancelled = false;
    const onMerge = vi.fn(() => {
      cancelled = true; // cancel lands right after the first chunk merged
    });
    const translate = vi.fn((texts: string[]) => Promise.resolve(answer(texts)));
    const r = await runChunkedTranslate({
      indexes: Array.from({ length: 5 }, (_, i) => i),
      chunk: 2,
      textOf: (i) => `t${i}`,
      translate,
      onMerge,
      isCancelled: () => cancelled,
    });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(r.cancelled).toBe(true);
    expect(r.mergedChunks).toBe(1);
  });

  it("cancel during an in-flight chunk drops THAT chunk's results", async () => {
    let cancelled = false;
    const onMerge = vi.fn();
    const r = await runChunkedTranslate({
      indexes: [0, 1],
      textOf: (i) => `t${i}`,
      translate: (texts) => {
        cancelled = true; // flag flips while the request is in flight
        return Promise.resolve(answer(texts));
      },
      onMerge,
      isCancelled: () => cancelled,
    });
    expect(onMerge).not.toHaveBeenCalled();
    expect(r.cancelled).toBe(true);
  });

  it("rethrows a chunk's transport error unchanged", async () => {
    await expect(
      runChunkedTranslate({
        indexes: [0],
        textOf: () => "t",
        translate: () => Promise.reject(new Error("HTTP 403: translation disabled")),
        onMerge: () => {},
      }),
    ).rejects.toThrow("HTTP 403");
  });

  it("default chunk size keeps the live fill granular", () => {
    expect(TRANSLATE_CHUNK).toBe(32);
  });
});

describe("translate progress state machine", () => {
  const t0 = 1_000_000;
  const start = (): TranslateRunUi => newTranslateRun(800, ["en", "fr"], t0);
  const idxs = (from: number, len: number) =>
    Array.from({ length: len }, (_, i) => from + i);

  it("starts idle-ish with the frontier unset", () => {
    const s = start();
    expect(s).toMatchObject({ phase: "starting", pct: 0, frontierIdx: -1, total: 800 });
  });

  it("beginChunk floors pct at the merged prefix and moves the frontier", () => {
    const s = beginChunk(start(), idxs(400, 400), 400);
    expect(s.frontierIdx).toBe(400);
    expect(s.pct).toBeCloseTo(0.5);
  });

  it("a chunk leaving promotes 'starting' to 'translating' and nothing else", () => {
    // Against a server with no progress entry nothing else ever left "starting".
    expect(beginChunk(start(), idxs(0, 32), 0).phase).toBe("translating");
    const downloading = { ...start(), phase: "downloading" as const };
    expect(beginChunk(downloading, idxs(0, 32), 0).phase).toBe("downloading");
  });

  it("folds downloading → loading → translating with the model lane", () => {
    let s = beginChunk(start(), idxs(0, 400), 0);
    s = foldTranslatePoll(s, { stage: "downloading", progress: 0.25, totalBytes: 4e9 }, t0 + 1000);
    expect(s).toMatchObject({ phase: "downloading", modelPhaseSeen: true, modelPct: 0.25, totalBytes: 4e9, dlStartedAt: t0 + 1000 });
    s = foldTranslatePoll(s, { stage: "loading" });
    expect(s).toMatchObject({ phase: "loading", modelPct: 1 });
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.5, step: "en 3/12", lastText: "Hallo" });
    expect(s.phase).toBe("translating");
    expect(s.pct).toBeCloseTo((0.5 * 400) / 800);
    expect(s.step).toBe("en 3/12");
    expect(s.lastText).toBe("Hallo");
  });

  it("combines completed chunks with the in-flight chunk's fraction", () => {
    let s = beginChunk(start(), idxs(400, 400), 400);
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.5 });
    expect(s.pct).toBeCloseTo((400 + 200) / 800);
  });

  it("is defensive: an empty poll changes nothing but returns a new object", () => {
    // A chunk has left, so the run IS translating (beginChunk promotes "starting");
    // the empty poll must not move it anywhere else.
    const s = foldTranslatePoll(beginChunk(start(), idxs(0, 400), 0), {});
    expect(s.phase).toBe("translating");
    expect(s.pct).toBe(0);
  });

  it("poll network failure → reconnecting; a good poll recovers", () => {
    let s = beginChunk(start(), idxs(0, 400), 0);
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.2 });
    const pct = s.pct;
    s = foldPollFailure(s);
    expect(s.phase).toBe("reconnecting");
    expect(s.pct).toBe(pct); // bar frozen, not reset
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.3 });
    expect(s.phase).toBe("translating");
  });

  it("the next chunk leaving recovers from 'reconnecting' when no poll ever succeeds", () => {
    // A server with no progress entry 404s every poll, so only the chunk loop proves
    // the network is back.
    let s = beginChunk(start(), idxs(0, 400), 0);
    s = foldPollFailure(s);
    expect(s.phase).toBe("reconnecting");
    s = beginChunk(s, idxs(400, 400), 400);
    expect(s.phase).toBe("translating");
  });

  it("a later chunk leaving 'reconnecting' reads translating even if no translating poll landed", () => {
    // Chunk 1 answered, so the model is up — the stale pct 0 must not pick "loading".
    let s = beginChunk(start(), idxs(0, 400), 0);
    s = foldTranslatePoll(s, { stage: "loading" });
    s = foldPollFailure(s);
    s = beginChunk(s, idxs(400, 400), 400);
    expect(s).toMatchObject({ phase: "translating", modelPct: 1 });
  });

  it("a later chunk leaving a model phase reads translating with a full model lane", () => {
    // Chunk 1 answered inside the poll gap, so no translating poll ever cleared the model phase.
    let s = foldTranslatePoll(beginChunk(start(), idxs(0, 400), 0), { stage: "loading" });
    expect(beginChunk(s, idxs(400, 400), 400)).toMatchObject({ phase: "translating", modelPct: 1 });
    s = foldTranslatePoll(beginChunk(start(), idxs(0, 400), 0), { stage: "downloading", progress: 0.4 });
    expect(beginChunk(s, idxs(400, 400), 400)).toMatchObject({ phase: "translating", modelPct: 1 });
  });

  it("a reconnect mid-download fills the model lane once a chunk answered, not before", () => {
    let s = beginChunk(start(), idxs(0, 400), 0);
    s = foldTranslatePoll(s, { stage: "downloading", progress: 0.4 });
    s = foldPollFailure(s);
    expect(beginChunk(s, idxs(400, 400), 400)).toMatchObject({ phase: "translating", modelPct: 1 });
    // The first chunk itself leaving proves nothing about the model.
    expect(beginChunk(s, idxs(0, 400), 0)).toMatchObject({ phase: "loading", modelPct: 0.4 });
  });

  it("a model-phase poll sent before a later chunk began cannot set the phase back", () => {
    const s = beginChunk(foldTranslatePoll(beginChunk(start(), idxs(0, 400), 0, 10), { stage: "loading" }), idxs(400, 400), 400, 100);
    expect(foldTranslatePoll(s, { stage: "loading" }, 120, 50).phase).toBe("translating");
    expect(foldTranslatePoll(s, { stage: "downloading", progress: 0.2 }, 120, 50)).toMatchObject({ phase: "translating", modelPct: 1 });
  });

  it("a poll sent before the newest folded poll is dropped, answered or failed", () => {
    let s = beginChunk(start(), idxs(0, 400), 0, 100);
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.5 }, 210, 200);
    const pct = s.pct;
    const frontier = s.frontierIdx;
    // An older poll that hung through a blip and timed out after the newer one answered.
    expect(foldPollFailure(s, 150).phase).toBe("translating");
    // An older success after a newer one cannot lower pct/frontier.
    const older = foldTranslatePoll(s, { stage: "translating", progress: 0.1 }, 220, 150);
    expect(older.pct).toBe(pct);
    expect(older.frontierIdx).toBe(frontier);
    // A newer failure still flags it, and a poll answered after that one clears it.
    s = foldPollFailure(s, 230);
    expect(s.phase).toBe("reconnecting");
    expect(foldTranslatePoll(s, {}, 300, 220).phase).toBe("reconnecting");
    expect(foldTranslatePoll(s, {}, 300, 240).phase).toBe("translating");
  });

  it("an answered-but-empty poll (an HTTP error) only ever clears 'reconnecting'", () => {
    // What the viewer folds for a server without a progress entry: every poll 404s.
    const loading = foldTranslatePoll(beginChunk(start(), idxs(0, 400), 0, 100), { stage: "loading" }, 110, 105);
    expect(foldTranslatePoll(loading, {}, 130, 120).phase).toBe("loading");
    const downloading = { ...loading, phase: "downloading" as const };
    expect(foldTranslatePoll(downloading, {}, 130, 120).phase).toBe("downloading");
  });

  it("a poll sent before the current chunk began cannot flag 'reconnecting' late", () => {
    const s = beginChunk(start(), idxs(0, 400), 0, 100);
    expect(foldPollFailure(s, 50).phase).toBe("translating");
    expect(foldPollFailure(s, 150).phase).toBe("reconnecting");
  });

  it("a reconnect recovery with no entry settles on a safe busy phase", () => {
    let s = beginChunk(start(), idxs(0, 400), 0);
    s = foldPollFailure(s);
    s = foldTranslatePoll(s, { stage: "unknown" });
    expect(s.phase).toBe("translating");
  });

  it("the frontier advances through the chunk as polls arrive", () => {
    // 2 targets: the server fraction sweeps the chunk twice — position is
    // taken within the current sweep.
    let s = beginChunk(start(), idxs(100, 400), 100);
    expect(s.frontierIdx).toBe(100);
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.25 });
    expect(s.frontierIdx).toBe(300); // halfway through target 1 of 2
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.75 });
    expect(s.frontierIdx).toBe(300); // halfway through target 2
    s = foldTranslatePoll(s, { stage: "translating", progress: 1 });
    expect(s.frontierIdx).toBe(499); // clamped to the chunk's last row
  });

  it("a sparse stale-row chunk maps the frontier onto real indexes", () => {
    let s = beginChunk({ ...start(), targets: ["en"] }, [3, 17, 42], 0);
    s = foldTranslatePoll(s, { stage: "translating", progress: 0.5 });
    expect(s.frontierIdx).toBe(17);
  });

  it("a poll sent before the current chunk began does not scale onto it", () => {
    const s = beginChunk({ ...start(), targets: ["en"] }, idxs(400, 400), 400, 10);
    const late = foldTranslatePoll(s, { stage: "translating", progress: 0.95 }, 12, 9);
    expect(late.pct).toBe(s.pct);
    expect(late.frontierIdx).toBe(s.frontierIdx);
    const fresh = foldTranslatePoll(s, { stage: "translating", progress: 0.95 }, 12, 11);
    expect(fresh.pct).toBeGreaterThan(s.pct);
    expect(fresh.frontierIdx).not.toBe(s.frontierIdx);
  });

  it("terminal phases are sticky against late polls", () => {
    const done: TranslateRunUi = { ...start(), phase: "done", pct: 1 };
    expect(foldTranslatePoll(done, { stage: "translating", progress: 0.1 })).toBe(done);
    expect(foldPollFailure(done)).toBe(done);
  });
});

describe("kept-original + warnings threading", () => {
  it("mirrors the patch with per-index kept lists and accumulates distinct warnings", async () => {
    const kepts: Record<number, string[]>[] = [];
    const warnCalls: string[][] = [];
    const r = await runChunkedTranslate({
      indexes: [0, 1, 2, 3],
      chunk: 2,
      textOf: (i) => `t${i}`,
      translate: (texts) =>
        Promise.resolve({
          results: texts.map((t) => ({ en: `en:${t}` })),
          // First segment of every chunk fails the quality guard.
          kept: texts.map((_, k) => (k === 0 ? ["en"] : [])),
          warnings: ["1 segment kept original"],
        }),
      onMerge: (_patch, _prov, _first, kept) => kepts.push(kept),
      onWarnings: (all) => warnCalls.push(all),
    });
    expect(kepts).toEqual([
      { 0: ["en"], 1: [] },
      { 2: ["en"], 3: [] },
    ]);
    // Warnings accumulate across chunks — DE-DUPLICATED: the server emits its notice per
    // request, and "29 warnings" for one recurring condition misread as 29 problems.
    expect(warnCalls).toEqual([["1 segment kept original"]]);
    expect(r.warnings).toHaveLength(1);
  });

  it("a response without kept/warnings yields empty kept lists and no calls", async () => {
    const kepts: Record<number, string[]>[] = [];
    const onWarnings = vi.fn();
    await runChunkedTranslate({
      indexes: [0, 1],
      textOf: (i) => `t${i}`,
      translate: (texts) => Promise.resolve(answer(texts)),
      onMerge: (_patch, _prov, _first, kept) => kepts.push(kept),
      onWarnings,
    });
    expect(kepts).toEqual([{ 0: [], 1: [] }]);
    expect(onWarnings).not.toHaveBeenCalled();
  });
});

describe("untranslatedIndexes (the resume set after a cancelled run)", () => {
  const segs = [{ translations: { de: "a" } }, { translations: { de: " " } }, {}, { translations: { de: "d" } }];
  it("lists every segment missing one of the langs", () => {
    expect(untranslatedIndexes(segs, ["de"])).toEqual([1, 2]);
    expect(untranslatedIndexes(segs, ["de", "fr"])).toEqual([0, 1, 2, 3]);
  });
  it("is empty for a fully merged run and for no langs", () => {
    expect(untranslatedIndexes([{ translations: { de: "a" } }], ["de"])).toEqual([]);
    expect(untranslatedIndexes(segs, [])).toEqual([]);
    expect(untranslatedIndexes(undefined, ["de"])).toEqual([]);
  });
  it("never lists a blank-source segment (its translation is blank by design)", () => {
    expect(untranslatedIndexes([{ text: "  ", translations: { de: "" } }, { text: "hi", translations: { de: "" } }], ["de"])).toEqual([1]);
  });
  it("judges blankness on the edited text the resume run sends, edits first", () => {
    const s = [{ text: " ", translations: { de: "" } }, { text: "hi", translations: { de: "" } }];
    // A blank original edited into words needs translating; words edited to blank do not.
    expect(untranslatedIndexes(s, ["de"], { 0: "now words", 1: "  " })).toEqual([0]);
    expect(untranslatedIndexes(s, ["de"], {})).toEqual([1]);
  });
  it("reads an inherited key like valueOf as missing instead of throwing", () => {
    expect(untranslatedIndexes([{ translations: { valueOf: "x" } }, { translations: {} }], ["valueOf"])).toEqual([1]);
  });
});

describe("translateOptsFrom", () => {
  it("passes the record's own regime through", () => {
    expect(translateOptsFrom({ mode: "faithful", model: "m" })).toEqual({ mode: "faithful", model: "m" });
  });
  it("narrows an unknown mode and an empty model to inherit", () => {
    expect(translateOptsFrom({ mode: "weird", model: "" })).toEqual({ mode: undefined, model: undefined });
    expect(translateOptsFrom(undefined)).toEqual({ mode: undefined, model: undefined });
  });
});

describe("per-target ticks", () => {
  it("the frontier follows targetProgress when the server reports it, and the tag rides along", () => {
    let s = newTranslateRun(10, ["en", "fr"], 0);
    s = beginChunk(s, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0);
    // Global fraction 0.75 with two targets would put the derived sweep at 0.5;
    // the server says French is at 0.9.
    const next = foldTranslatePoll(s, { stage: "translating", progress: 0.75, target: "fr", targetProgress: 0.9 }, 1);
    expect(next.frontierIdx).toBe(9);
    expect(next.target).toBe("fr");
    expect(next.targetProgress).toBeCloseTo(0.9, 5);
    // Without it, the old derivation stands.
    const derived = foldTranslatePoll(s, { stage: "translating", progress: 0.75 }, 1);
    expect(derived.frontierIdx).toBe(5);
    expect(derived.target).toBeUndefined();
  });
});
