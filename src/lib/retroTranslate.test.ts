// Chunked retro-translate: the chunk-loop driver's merging/cancel contract
// and the mini progress card's poll-folding state machine. The React side
// (TranscriptViewer) only wires these to translateText + the store.
import { describe, expect, it, vi } from "vitest";
import {
  beginChunk, foldPollFailure, foldTranslatePoll, newTranslateRun,
  runChunkedTranslate, TRANSLATE_CHUNK, type TranslateRunUi,
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
    const s = foldTranslatePoll(beginChunk(start(), idxs(0, 400), 0), {});
    expect(s.phase).toBe("starting");
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

  it("terminal phases are sticky against late polls", () => {
    const done: TranslateRunUi = { ...start(), phase: "done", pct: 1 };
    expect(foldTranslatePoll(done, { stage: "translating", progress: 0.1 })).toBe(done);
    expect(foldPollFailure(done)).toBe(done);
  });
});
