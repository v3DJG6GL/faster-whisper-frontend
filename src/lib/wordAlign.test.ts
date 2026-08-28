import { describe, expect, it } from "vitest";
import { alignSegmentWords, applyTextEdits, segmentWordRanges } from "./wordAlign";
import type { BatchResult, TranscriptWord } from "./types";

/** Whisper-style words: leading space, tight timings. */
const w = (word: string, start: number, end: number): TranscriptWord => ({
  word: ` ${word}`,
  start,
  end,
});

const LINE = [
  w("Das", 0.3, 0.4),
  w("ist", 0.42, 0.5),
  w("so", 0.52, 0.6),
  w("passiert", 0.62, 1.0),
  w("im", 1.02, 1.1),
  w("Velonavitest", 1.12, 1.7),
  w("des", 1.72, 1.8),
  w("TCS", 1.82, 2.1),
];

describe("alignSegmentWords", () => {
  it("keeps every timing when only one word is replaced", () => {
    const out = alignSegmentWords(LINE, "Das ist so passiert im Velo-Navi-Test des TCS");
    expect(out).toHaveLength(8);
    // Untouched words keep their objects' timings verbatim.
    expect(out[0]).toEqual(LINE[0]);
    expect(out[3]).toEqual(LINE[3]);
    expect(out[7]).toEqual(LINE[7]);
    // The correction inherits the replaced word's slot.
    expect(out[5].word).toBe(" Velo-Navi-Test");
    expect(out[5].start).toBe(LINE[5].start);
    expect(out[5].end).toBe(LINE[5].end);
  });

  it("ignores punctuation and case when matching", () => {
    const out = alignSegmentWords(LINE, "das ist so passiert, im Velonavitest des TCS!");
    // Every token matches something — all original timings survive.
    expect(out.map((x) => x.start)).toEqual(LINE.map((x) => x.start));
  });

  it("splits an inserted word's time out of the gap it lands in", () => {
    const out = alignSegmentWords(LINE, "Das ist so passiert im grossen Velonavitest des TCS");
    expect(out).toHaveLength(9);
    const inserted = out[5];
    expect(inserted.word).toBe(" grossen");
    // Inserted between "im" (ends 1.1) and "Velonavitest" (starts 1.12).
    expect(inserted.start).toBeGreaterThanOrEqual(LINE[4].end);
    expect(inserted.end).toBeLessThanOrEqual(LINE[5].start + 1e-9);
    // The following matched word is untouched.
    expect(out[6]).toEqual(LINE[5]);
  });

  it("shares a replaced span across a split correction by character count", () => {
    const out = alignSegmentWords(LINE, "Das ist so passiert im Velo Navi Test des TCS");
    const replaced = out.slice(5, 8);
    expect(replaced.map((x) => x.word)).toEqual([" Velo", " Navi", " Test"]);
    expect(replaced[0].start).toBe(LINE[5].start);
    expect(replaced[2].end).toBeCloseTo(LINE[5].end, 6);
    // Monotonic inside the span.
    expect(replaced[0].end).toBeLessThanOrEqual(replaced[1].start + 1e-9);
    expect(replaced[1].end).toBeLessThanOrEqual(replaced[2].start + 1e-9);
  });

  it("drops deleted words without disturbing the rest", () => {
    const out = alignSegmentWords(LINE, "Das ist passiert im Velonavitest des TCS");
    expect(out).toHaveLength(7);
    expect(out.map((x) => x.word.trim())).not.toContain("so");
    expect(out[2]).toEqual(LINE[3]);
  });

  it("returns nothing for an emptied line or a line without words", () => {
    expect(alignSegmentWords(LINE, "   ")).toEqual([]);
    expect(alignSegmentWords([], "Hallo Welt")).toEqual([]);
  });
});

describe("segmentWordRanges", () => {
  it("gives a word on an exact segment boundary to the segment it starts", () => {
    // Real case: seg[7] ends at 34.27 and seg[8] starts at 34.27; "den" starts
    // at 34.27 and must belong to seg[8], not fall into seg[7]'s +0.05 slack.
    const segments = [
      { start: 31.45, end: 34.27, text: "… noch jemand durchschickt," },
      { start: 34.27, end: 35.75, text: "den man gar nicht durchdürfen darf." },
    ];
    const words = [
      w("durchschickt,", 33.6, 34.2),
      w("den", 34.27, 34.4),
      w("man", 34.42, 34.6),
    ];
    expect(segmentWordRanges(segments, words)).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });
});

describe("applyTextEdits", () => {
  const result: BatchResult = {
    text: "",
    segments: [
      { start: 0, end: 2.2, text: "Das ist so passiert im Velonavitest des TCS" },
      { start: 2.3, end: 3.0, text: "Auch das ein bisschen später" },
    ],
    words: [
      ...LINE,
      w("Auch", 2.3, 2.4),
      w("das", 2.42, 2.5),
      w("ein", 2.52, 2.6),
      w("bisschen", 2.62, 2.8),
      w("später", 2.82, 3.0),
    ],
  };

  it("substitutes only the edited segment's words", () => {
    const words = applyTextEdits(result, { 0: "Das ist so passiert im Velo-Navi-Test des TCS" });
    expect(words).toHaveLength(13);
    expect(words[5].word).toBe(" Velo-Navi-Test");
    // Second segment untouched, ranges still line up.
    const ranges = segmentWordRanges(result.segments!, words);
    expect(ranges[1]).toEqual([8, 13]);
    expect(words.slice(8)).toEqual(result.words!.slice(8));
  });

  it("returns the original array when no edit applies", () => {
    expect(applyTextEdits(result, {})).toBe(result.words);
    expect(applyTextEdits(result, undefined)).toBe(result.words);
    expect(applyTextEdits({ text: "" }, { 0: "x" })).toEqual([]);
  });
});
