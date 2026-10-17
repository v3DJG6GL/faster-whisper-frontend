import { describe, expect, it } from "vitest";
import { alignSegmentWords, applyTextEdits, segmentWordRanges } from "./wordAlign";
import type { BatchResult, TranscriptWord } from "../types";

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

  it("tells apart words that differ only in an Indic vowel sign", () => {
    const old = [w("काम", 0, 1), w("कम", 1, 2), w("है", 2, 3)];
    const out = alignSegmentWords(old, "कम है");
    expect(out).toEqual([old[1], old[2]]);
  });

  it("returns nothing for an emptied line or a line without words", () => {
    expect(alignSegmentWords(LINE, "   ")).toEqual([]);
    expect(alignSegmentWords([], "Hallo Welt")).toEqual([]);
  });

  it("keeps the untouched words' timings when one character of a CJK line changes", () => {
    // Unspaced text: a whitespace split used to give one token that matched no old word,
    // and the whole line collapsed into one segment-long word.
    const ja: TranscriptWord[] = [
      { word: "今日", start: 0, end: 0.4 },
      { word: "は", start: 0.4, end: 0.6 },
      { word: "晴れ", start: 0.6, end: 1.1 },
      { word: "です", start: 1.1, end: 1.5 },
    ];
    const out = alignSegmentWords(ja, "今日は雨です");
    expect(out.map((x) => x.word)).toEqual(["今日", "は", "雨", "です"]);
    expect(out[0]).toBe(ja[0]);
    expect(out[1]).toBe(ja[1]);
    expect(out[3]).toBe(ja[3]);
    expect(out[2].start).toBe(ja[2].start);
    expect(out[2].end).toBeCloseTo(ja[2].end, 9);
  });

  it("puts no space mid-line on a rebuilt CJK token (only where an old word had one)", () => {
    const ja: TranscriptWord[] = [
      { word: " 今日", start: 0, end: 0.4 },
      { word: "は", start: 0.4, end: 0.6 },
      { word: "晴れ", start: 0.6, end: 1.1 },
      { word: "です", start: 1.1, end: 1.5 },
    ];
    expect(alignSegmentWords(ja, "今日は雨です").map((x) => x.word)).toEqual([" 今日", "は", "雨", "です"]);
    // A rebuilt first token keeps the segment's leading space; the piece after it does not.
    expect(alignSegmentWords(ja, "明日は晴れです").map((x) => x.word)).toEqual([" 明", "日", "は", "晴れ", "です"]);
    // A Latin word that carried its own space keeps it when corrected.
    const mixed: TranscriptWord[] = [
      { word: " 今日", start: 0, end: 0.4 },
      { word: " AI", start: 0.4, end: 0.8 },
      { word: "です", start: 0.8, end: 1.2 },
    ];
    expect(alignSegmentWords(mixed, "今日MLです").map((x) => x.word)).toEqual([" 今日", " ML", "です"]);
  });

  it("keeps the untouched words' timings when one syllable of a Thai line changes", () => {
    // Thai is unspaced too: the edit used to collapse the line into one 0-3 word.
    const th: TranscriptWord[] = [
      { word: "สวัสดี", start: 0, end: 1 },
      { word: "ครับ", start: 1, end: 2 },
      { word: "วันนี้", start: 2, end: 3 },
    ];
    const out = alignSegmentWords(th, "สวัสดีค่ะวันนี้");
    // The inserted ค่ะ stays one word (its tone mark and vowel never open a token of their own).
    expect(out.map((x) => x.word)).toEqual(["สวัสดี", "ค่ะ", "วันนี้"]);
    expect(out[0]).toBe(th[0]);
    expect(out[2]).toBe(th[2]);
    expect(out[1].start).toBe(1);
    expect(out[1].end).toBeCloseTo(2, 9);
  });

  it("cuts each unspaced run of a spaced line per old word (ja with a Latin word)", () => {
    // The whitespace split used to keep "今日は雨" as one token that matched nothing,
    // collapsing 今日/は/晴れ into one word.
    const ja: TranscriptWord[] = [
      { word: " 今日", start: 0, end: 0.4 },
      { word: "は", start: 0.4, end: 0.6 },
      { word: "晴れ", start: 0.6, end: 1.1 },
      { word: " AI", start: 1.1, end: 1.5 },
      { word: "です", start: 1.5, end: 1.9 },
    ];
    const out = alignSegmentWords(ja, "今日は雨 AIです");
    expect(out.map((x) => x.word)).toEqual([" 今日", "は", "雨", " AI", "です"]);
    expect(out[0]).toBe(ja[0]);
    expect(out[1]).toBe(ja[1]);
    expect(out[3]).toBe(ja[3]);
    expect(out[4]).toBe(ja[4]);
    expect(out[2].start).toBe(ja[2].start);
    expect(out[2].end).toBeCloseTo(ja[2].end, 9);
    expect(out.map((x) => x.word).join("").trim()).toBe("今日は雨 AIです");
  });

  it("keeps a spaced Thai line's word count when one syllable changes", () => {
    const th: TranscriptWord[] = [
      { word: "สวัสดี", start: 0, end: 1 },
      { word: "ครับ", start: 1, end: 2 },
      { word: " ผม", start: 2, end: 2.5 },
      { word: "ชื่อ", start: 2.5, end: 3 },
    ];
    const out = alignSegmentWords(th, "สวัสดีค่ะ ผมชื่อ");
    expect(out.map((x) => x.word)).toEqual(["สวัสดี", "ค่ะ", " ผม", "ชื่อ"]);
    expect(out[0]).toBe(th[0]);
    expect(out[2]).toBe(th[2]);
    expect(out[3]).toBe(th[3]);
    expect(out[1].start).toBe(1);
    expect(out[1].end).toBeCloseTo(2, 9);
  });

  it("keeps a syllable the model split across two words split on a punctuation-only edit", () => {
    // faster-whisper cuts Thai per decodable token, so a word may start with a tone mark.
    const th: TranscriptWord[] = [
      { word: "ค", start: 0, end: 1 },
      { word: "่ะ", start: 1, end: 2 },
      { word: "วันนี้", start: 2, end: 3 },
    ];
    const out = alignSegmentWords(th, "ค่ะวันนี้!");
    expect(out[0]).toBe(th[0]);
    expect(out[1]).toBe(th[1]);
  });

  it("does not keep Whisper's leading space on a matched word that now sits mid-run", () => {
    const ja: TranscriptWord[] = [
      { word: " 今日", start: 0, end: 1 },
      { word: "は", start: 1, end: 1.2 },
      { word: "晴れ", start: 1.2, end: 2 },
      { word: "です", start: 2, end: 2.5 },
    ];
    const out = alignSegmentWords(ja, "ああ今日は晴れです");
    expect(out.map((x) => x.word).join("").trim()).toBe("ああ今日は晴れです");
    expect(out[1]).toMatchObject({ word: "今日", start: 0, end: 1 });
    const zh: TranscriptWord[] = [
      { word: " 我们", start: 0, end: 1 },
      { word: "今天", start: 1, end: 2 },
      { word: "去", start: 2, end: 3 },
    ];
    expect(alignSegmentWords(zh, "所以我们今天去").map((x) => x.word).join("").trim()).toBe("所以我们今天去");
    const th: TranscriptWord[] = [
      { word: "สวัสดี", start: 0, end: 1 },
      { word: "ค่ะ", start: 1, end: 2 },
      { word: " ผม", start: 2, end: 2.5 },
      { word: "ชื่อ", start: 2.5, end: 3 },
    ];
    expect(alignSegmentWords(th, "สวัสดีค่ะผมชื่อ").map((x) => x.word).join("")).toBe("สวัสดีค่ะผมชื่อ");
    // A Latin word inside the run keeps its space, and an English edit is untouched.
    const mixed: TranscriptWord[] = [
      { word: " 今日", start: 0, end: 1 },
      { word: "は", start: 1, end: 1.2 },
      { word: " AI", start: 1.2, end: 2 },
      { word: "です", start: 2, end: 2.5 },
    ];
    expect(alignSegmentWords(mixed, "ああ今日はAIです").map((x) => x.word).join("").trim()).toBe("ああ今日は AIです");
    const en = alignSegmentWords(LINE, "So Das ist so passiert im Velonavitest des TCS");
    expect(en.slice(1)).toEqual(LINE);
  });

  it("drops the leading space mid-run after ー, CJK punctuation or an astral Han character", () => {
    // ー 、 「 are Script=Common, and a per-UTF-16-unit look read 𠮷 as a lone surrogate:
    // each kept Whisper's " 今日" inside the run.
    const ja: TranscriptWord[] = [
      { word: " 今日", start: 0, end: 1 },
      { word: "は", start: 1, end: 1.2 },
      { word: "晴れ", start: 1.2, end: 2 },
    ];
    const text = (edit: string) => alignSegmentWords(ja, edit).map((x) => x.word).join("").trim();
    expect(text("コーヒー今日は晴れ")).toBe("コーヒー今日は晴れ");
    expect(text("ああ、今日は晴れ")).toBe("ああ、今日は晴れ");
    expect(text("「今日は晴れ")).toBe("「今日は晴れ");
    expect(text("𠮷今日は晴れ")).toBe("𠮷今日は晴れ");
    expect(text("ああ今日は晴れ")).toBe("ああ今日は晴れ");
    // The matched word itself opening with an astral character.
    const yoshi: TranscriptWord[] = [
      { word: " 𠮷野", start: 0, end: 1 },
      { word: "家", start: 1, end: 2 },
    ];
    expect(alignSegmentWords(yoshi, "あ𠮷野家").map((x) => x.word)).toEqual([" あ", "𠮷野", "家"]);
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

  it("a word appended at a shared boundary stays in its own segment", () => {
    const r: BatchResult = {
      text: "",
      segments: [
        { start: 0, end: 1, text: "Hello there" },
        { start: 1, end: 2, text: "How are you" },
      ],
      words: [w("Hello", 0, 0.4), w("there", 0.5, 1), w("How", 1, 1.3), w("are", 1.35, 1.6), w("you", 1.65, 2)],
    };
    const words = applyTextEdits(r, { 0: "Hello there friend." });
    expect(segmentWordRanges(r.segments!, words)).toEqual([[0, 3], [3, 6]]);
    expect(words[2].word).toBe(" friend.");
    expect(words[2].start).toBeLessThan(1);
    expect(words.slice(3)).toEqual(r.words!.slice(2));
  });

  it("returns the original array when no edit applies", () => {
    expect(applyTextEdits(result, {})).toBe(result.words);
    expect(applyTextEdits(result, undefined)).toBe(result.words);
    expect(applyTextEdits({ text: "" }, { 0: "x" })).toEqual([]);
  });

  it("ignores a malformed edit key instead of aligning against nothing", () => {
    const bad = { "": "x", "01": "y", "0.5": "z" } as unknown as Record<number, string>;
    expect(applyTextEdits(result, bad)).toBe(result.words);
  });
});
