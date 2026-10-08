import { describe, expect, it } from "vitest";
import {
  CUE_PRESETS, TRANSCRIBED_CPS, buildCues, cueOptionsOf, cueResult, cutByShare, edgeChar, limitsFor, limitsTitle, trackCps, trackLimits, sanitizeCueLimits, timedTrack, trText, trackCues, trackLang, wrapLines,
  type CueOptions,
} from "./cueSplit";
import type { BatchResult, TranscriptWord } from "../types";

/** Words for `text` spread over [a, b]; `pauses` adds silence after the word index. */
function wordsOf(text: string, a: number, b: number, pauses: Record<number, number> = {}): TranscriptWord[] {
  const ws = text.trim().split(/\s+/);
  const extra = Object.values(pauses).reduce((x, y) => x + y, 0);
  const per = (b - a - extra) / ws.length;
  let t = a;
  return ws.map((w, i) => {
    const word = { word: " " + w, start: t, end: t + per * 0.9 };
    t += per + (pauses[i] ?? 0);
    return word;
  });
}

function seg1(text: string, a: number, b: number, extra: Partial<BatchResult> = {}, pauses = {}): BatchResult {
  const { segments: segX, ...rest } = extra;
  return {
    text,
    language: "en",
    words: wordsOf(text, a, b, pauses),
    ...rest,
    segments: [{ start: a, end: b, text: " " + text, ...(segX?.[0] ?? {}) }],
  };
}

const STD: CueOptions = { length: "standard", timing: "same" };
/** No lone surrogate: an emoji was never cut in half. */
const wellFormed = (s: string) => !/[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
const LONG =
  "The glacier behind me has lost almost forty percent of its volume since 1980. " +
  "The scientists who measure it every summer say the pace is still accelerating, " +
  "so the valley below will look completely different within a generation.";

describe("limits", () => {
  it("presets adapt reading speed and CJK line length", () => {
    expect(limitsFor(STD, "en")).toEqual({ cpl: 42, lines: 2, maxDur: 7, cps: 20 });
    expect(limitsFor(STD, "de-CH").cps).toBe(17);
    expect(limitsFor(STD, "ja").cpl).toBe(13);
    expect(limitsFor({ length: "short", timing: "same" }, "zh").cpl).toBe(16);
    expect(limitsFor({ length: "custom", custom: { cpl: 30, lines: 1, maxDur: 5, cps: 12 }, timing: "same" }, "en"))
      .toEqual({ cpl: 30, lines: 1, maxDur: 5, cps: 12 });
    // An imported language naming an Object.prototype member is not a CJK entry.
    expect(limitsFor(STD, "constructor").cpl).toBe(42);
  });
  it("sanitizes untrusted custom limits", () => {
    expect(sanitizeCueLimits({ cpl: 999, lines: 0, maxDur: 3.3, cps: 15 })).toEqual({ cpl: 60, lines: 1, maxDur: 3.5, cps: 15 });
    expect(sanitizeCueLimits({ cpl: "42" })).toBeUndefined();
    expect(sanitizeCueLimits(null)).toBeUndefined();
  });
  it("settings → options: as transcribed is no options, standard is the default", () => {
    expect(cueOptionsOf({ subtitleLength: "transcribed" })).toBeUndefined();
    expect(cueOptionsOf(undefined)).toEqual({ length: "standard", custom: undefined, timing: "same" });
    expect(cueOptionsOf({ translationTiming: "own" })?.timing).toBe("own");
  });
});

describe("buildCues", () => {
  it("splits a 20 s three-sentence segment at the sentence ends and keeps the segment bounds", () => {
    const r = seg1(LONG, 10, 30);
    const { cues } = buildCues(r, STD, ["orig"]);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues[0].start).toBe(10);
    expect(cues[cues.length - 1].end).toBe(30);
    for (const c of cues) {
      expect(c.text.length).toBeLessThanOrEqual(84);
      expect(c.end - c.start).toBeLessThanOrEqual(7.01);
      expect(c.seg).toBe(0);
    }
    expect(cues.some((c) => c.text.endsWith("since 1980."))).toBe(true);
    expect(cues.map((c) => c.text).join(" ")).toBe(LONG);
  });

  it("a pause beats a comma", () => {
    const text = "We went down to the river, it was cold that morning and we waited there for hours";
    // Pause after "morning" (index 10).
    const r = seg1(text, 0, 9, {}, { 10: 1.2 });
    const { cues } = buildCues(r, { length: "short", timing: "same" }, ["orig"]);
    expect(cues.some((c) => c.text.endsWith("morning"))).toBe(true);
  });

  it("never breaks after an article or on an abbreviation", () => {
    const text = "Yesterday Dr. Miller explained the new results of the study to the whole team in the lab";
    const { cues } = buildCues(seg1(text, 0, 8), { length: "short", timing: "same" }, ["orig"]);
    for (const c of cues.slice(0, -1)) {
      expect(c.text).not.toMatch(/\b(the|of|to|Dr\.)$/);
    }
  });

  it("a segment that fits stays one cue with its exact bounds", () => {
    const { cues } = buildCues(seg1("Short line.", 1.25, 2.5), STD, ["orig"]);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start: 1.25, end: 2.5, text: "Short line." });
  });

  it("no words, mismatching words or synthesized clocks: the segment stays whole", () => {
    const noWords: BatchResult = { text: LONG, segments: [{ start: 0, end: 20, text: LONG }] };
    expect(buildCues(noWords, STD, ["orig"]).cues).toHaveLength(1);
    const mismatch = seg1(LONG, 0, 20);
    mismatch.words![3] = { word: " banana", start: 1, end: 1.2 };
    expect(buildCues(mismatch, STD, ["orig"]).cues).toHaveLength(1);
    expect(buildCues({ ...seg1(LONG, 0, 20), timingSynthesized: true }, STD, ["orig"]).cues).toHaveLength(1);
    // The last words timed past the segment (another segment's range): never cut text off.
    const short = seg1(LONG, 0, 20);
    short.words = short.words!.slice(0, -2);
    expect(buildCues(short, STD, ["orig"]).cues.map((c) => c.text)).toEqual([LONG]);
  });

  it("punctuation outside the word tokens stays in the cue text", () => {
    const r = seg1(LONG, 0, 20);
    r.words = r.words!.map((w) => ({ ...w, word: w.word.replace(/[.,]$/, "") }));
    expect(buildCues(r, STD, ["orig"]).cues.map((c) => c.text).join(" ")).toBe(LONG);
  });

  it("a name prefix counts against the cue's room", () => {
    const text = "The scientists who measure it every summer say the pace is still accelerating.";
    expect(buildCues(seg1(text, 0, 6), STD, ["orig"]).cues).toHaveLength(1);
    expect(buildCues(seg1(text, 0, 6), STD, ["orig"], () => 11).cues.length).toBeGreaterThan(1);
  });

  it("as transcribed (no options) = one cue per segment", () => {
    expect(buildCues(seg1(LONG, 0, 20), undefined, ["orig"]).cues).toHaveLength(1);
  });

  it("CJK: cue text is a slice of the segment text, no spaces inserted", () => {
    const text = "今日はとても良い天気ですね。散歩に行きましょう。公園でお弁当を食べたいです。";
    const words = Array.from(text).map((ch, i) => ({ word: ch, start: i * 0.3, end: i * 0.3 + 0.25 }));
    const r: BatchResult = { text, language: "ja", segments: [{ start: 0, end: words.length * 0.3, text }], words };
    const { cues } = buildCues(r, STD, ["orig"]);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((c) => c.text).join("")).toBe(text);
    for (const c of cues) expect(c.text).not.toMatch(/\s/);
  });

  it("same timing: the translation is cut onto the source cues, kept lines excluded", () => {
    const de =
      "Der Gletscher hinter mir hat seit 1980 fast vierzig Prozent seines Volumens verloren. " +
      "Die Forscher, die ihn jeden Sommer messen, sagen, dass es immer schneller geht, " +
      "und so wird das Tal unter uns in einer Generation ganz anders aussehen.";
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { de, fr: "x" }, translationsKept: ["fr"] }] });
    const grid = buildCues(r, STD, ["orig", "de", "fr"]);
    const parts = grid.cues.map((c) => c.tr.de);
    expect(parts.every(Boolean)).toBe(true);
    expect(parts.join(" ")).toBe(de);
    expect(grid.cues.every((c) => c.tr.fr === undefined)).toBe(true);
    expect(trackCues(grid, "de").map((c) => c.text)).toEqual(parts);
  });

  it("same timing: a translation lane keeps the segment's speaker", () => {
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, speaker: "SPEAKER_00", translations: { de: "Hallo." } }] });
    const grid = buildCues(r, STD, ["orig", "de"]);
    expect(trackCues(grid, "de").every((c) => c.speaker === "SPEAKER_00")).toBe(true);
    expect(trackCues(grid, "orig").every((c) => c.speaker === "SPEAKER_00")).toBe(true);
  });

  it("own timing: each translation gets its own split with its own limits", () => {
    const de = "Der Gletscher hinter mir hat seit 1980 fast vierzig Prozent seines Volumens verloren, sagen alle.";
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { de } }] });
    const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "de"]);
    expect(grid.cues.every((c) => !c.tr.de)).toBe(true);
    expect(grid.own.de.length).toBeGreaterThan(1);
    expect(grid.own.de[0].start).toBe(10);
    expect(grid.own.de[grid.own.de.length - 1].end).toBe(30);
    expect(grid.own.de.map((c) => c.text).join(" ")).toBe(de);
  });

  it("own timing: spaceless text splits per code point, never inside an emoji", () => {
    const ja = "🎉".repeat(4) + "今日は朝から雨が降っていて🎉駅までの道はとても混んでいました🎉電車も遅れていました🎉";
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
    const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "ja"]);
    expect(grid.own.ja.length).toBeGreaterThan(1);
    expect(grid.own.ja.every((c) => wellFormed(c.text))).toBe(true);
    expect(grid.own.ja.map((c) => c.text).join("")).toBe(ja);
  });

  it("a one-word translation of a split segment stays one word, never cut into letters", () => {
    const text = "We walked along the river for hours and nobody said a word";
    for (const timing of ["same", "own"] as const) {
      const r = seg1(text, 0, 18, { segments: [{ start: 0, end: 18, text: " " + text, translations: { de: "Ja." } }] });
      const grid = buildCues(r, { ...STD, timing }, ["orig", "de"]);
      expect(trackCues(grid, "orig").length).toBeGreaterThan(1);
      expect(trackCues(grid, "de").map((c) => c.text)).toEqual(["Ja."]);
    }
  });

  it("own timing: a CJK translation with one Latin word still splits between its characters", () => {
    const ja = "今日は朝から iPhone の新しい機能について説明しますが駅までの道はとても混んでいて電車も遅れていました";
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
    const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "ja"]);
    const L = limitsFor(STD, "ja");
    expect(grid.own.ja.length).toBeGreaterThan(2);
    expect(grid.own.ja.every((c) => c.text.length <= L.cpl * L.lines)).toBe(true);
    expect(grid.own.ja.map((c) => c.text).join("").replace(/\s/g, "")).toBe(ja.replace(/\s/g, ""));
  });

  it("own timing: an opening bracket stays with the character it opens", () => {
    const ja = "iPhone の「新機能」と「新しい画面」と「便利な設定」と「速い通信」と「長い電池」と「明るい表示」について説明します";
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
    const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "ja"]);
    expect(grid.own.ja.length).toBeGreaterThan(1);
    expect(grid.own.ja.every((c) => !/[「（]$/.test(c.text.trim()))).toBe(true);
    expect(grid.own.ja.every((c) => !/^[」）。、]/.test(c.text.trim()))).toBe(true);
    expect(grid.own.ja.map((c) => c.text).join("").replace(/\s/g, "")).toBe(ja.replace(/\s/g, ""));
  });

  it("own timing: an opening bracket stays with its character in space-free text too", () => {
    const ja = "彼は「新機能」と「新しい画面」と「便利な設定」と「速い通信」と「長い電池」と「明るい表示」について説明します";
    for (const length of ["standard", "short"] as const) {
      const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
      const grid = buildCues(r, { ...STD, length, timing: "own" }, ["orig", "ja"]);
      expect(grid.own.ja.length).toBeGreaterThan(1);
      expect(grid.own.ja.every((c) => !/[「（]$/.test(c.text.trim()))).toBe(true);
      // …and a closing bracket or stop stays with the character it closes.
      expect(grid.own.ja.every((c) => !/^[」）。、]/.test(c.text.trim()))).toBe(true);
      expect(grid.own.ja.map((c) => c.text).join("")).toBe(ja);
    }
  });

  it("own timing: a Latin word or number before an opening bracket never ends a cue on it", () => {
    const ja = "iOS 18「新機能」と「新しい画面」と「便利な設定」と「速い通信」と「長い電池」と「明るい表示」について説明します";
    for (const length of ["standard", "short"] as const) {
      const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
      const grid = buildCues(r, { ...STD, length, timing: "own" }, ["orig", "ja"]);
      expect(grid.own.ja.length).toBeGreaterThan(1);
      expect(grid.own.ja.every((c) => !/[「（]$/.test(c.text.trim()))).toBe(true);
      expect(grid.own.ja.map((c) => c.text).join("").replace(/\s/g, "")).toBe(ja.replace(/\s/g, ""));
    }
  });

  it("site tracks always keep their own timing", () => {
    const r: BatchResult = {
      ...seg1("Hello there.", 0, 2),
      timedTracks: [{ id: "de-x-site", lang: "de", source: "site", kind: "manual", cues: [{ start: 0.5, end: 1.5, text: " Hallo. " }] }],
    };
    const grid = buildCues(r, undefined, ["orig", "de-x-site"]);
    expect(grid.own["de-x-site"]).toEqual([{ seg: -1, start: 0.5, end: 1.5, text: "Hallo.", tr: {} }]);
    expect(buildCues(r, STD, ["orig"]).own["de-x-site"]).toBeUndefined();
  });

  it("a site track alone skips the original's split: one cue per segment, the track unchanged", () => {
    const r: BatchResult = {
      ...seg1(LONG, 10, 30),
      timedTracks: [{ id: "de-x-site", lang: "de", source: "site", kind: "manual", cues: [{ start: 10, end: 12, text: "Hallo." }] }],
    };
    const grid = buildCues(r, STD, ["de-x-site"]);
    expect(grid.cues).toHaveLength(1);
    expect(grid.own["de-x-site"]).toEqual(buildCues(r, STD, ["orig", "de-x-site"]).own["de-x-site"]);
  });

  it("a target spelled like an Object.prototype member reads as absent, not as a function", () => {
    const r: BatchResult = {
      text: "One. Two.",
      language: "en",
      segments: [
        { start: 0, end: 1, text: " One.", translations: { toString: "x" } },
        { start: 1, end: 2, text: " Two.", translations: {} },
      ],
    };
    const grid = buildCues(r, STD, ["orig", "toString"]);
    expect(trackCues(grid, "toString").map((c) => c.text)).toEqual(["x"]);
    expect(trText(r.segments![1], "toString")).toBeNull();
    expect(cueResult(r, grid, "valueOf").segments).toEqual([]);
  });

  it("cueResult renders cues as segments for the existing generators", () => {
    const r = seg1(LONG, 10, 30, { speakers: ["S0"], segments: [{ start: 10, end: 30, text: " " + LONG, speaker: "S0" }] });
    const grid = buildCues(r, STD, ["orig"]);
    const out = cueResult(r, grid);
    expect(out.segments!.length).toBe(grid.cues.length);
    expect(out.segments!.every((s) => s.speaker === "S0")).toBe(true);
  });
});

describe("wrapLines", () => {
  it("fits on one line when short", () => {
    expect(wrapLines("Short line.", 42, 2)).toEqual(["Short line."]);
  });
  it("two lines, bottom-heavy, within the limit, no break after an article", () => {
    const lines = wrapLines("The scientists who measure it every summer say the pace", 42, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBeLessThanOrEqual(42);
    expect(lines[1].length).toBeLessThanOrEqual(42);
    expect(lines[0].length).toBeLessThanOrEqual(lines[1].length + 6);
    expect(lines[0]).not.toMatch(/\b(the|a)$/i);
  });
  it("never drops text that cannot fit", () => {
    const lines = wrapLines(LONG, 42, 2);
    expect(lines.join(" ")).toBe(LONG);
    expect(lines.length).toBeGreaterThan(2);
  });
  it("reserves room for a prefix on the first line", () => {
    const lines = wrapLines("one two three four five six seven eight", 20, 2, 10);
    expect(lines[0].length).toBeLessThanOrEqual(10);
  });
  it("uses the fewest lines the text needs, not the line cap", () => {
    const lines = wrapLines("The quick brown fox jumps over the lazy dog near the river bank", 42, 3);
    expect(lines).toEqual(["The quick brown fox jumps over", "the lazy dog near the river bank"]);
  });
  it("long unsplit paragraphs wrap fast and exactly as before", () => {
    const p =
      "When the river rose that spring, the town council met every evening, and the mayor, who had lived there " +
      "since the flood of 1980, said the levee would hold. It did not. By Thursday the water had reached the " +
      "bakery on Main Street, and the old bridge was closed.";
    expect(wrapLines(p, 42, 2, 9)).toEqual([
      "When the river rose that spring,", "the town council met every evening,", "and the mayor, who had lived there",
      "since the flood of 1980, said the levee", "would hold. It did not. By Thursday", "the water had reached the bakery on Main",
      "Street, and the old bridge was closed.",
    ]);
    const ja = "今日は朝から雨が降っていて、駅までの道はとても混んでいました。電車も遅れていたので、会社に着いたのは十時過ぎでした。🎉それでも午後には晴れて、皆で外に出ました。";
    // The 、 rides with the character before it (the old snapshot started line 2 with it).
    expect(wrapLines(ja, 16, 2)).toEqual([
      "今日は朝から雨が降ってい", "て、駅までの道はとても混ん", "でいました。電車も遅れていた", "ので、会社に着いたのは十時過",
      "ぎでした。🎉それでも午後に", "は晴れて、皆で外に出ました。",
    ]);
    // 1200 words used to take seconds (every candidate rejoined both halves).
    const big = Array.from({ length: 1200 }, (_, i) => `word${i % 17}${i % 9 ? "" : ","}`).join(" ");
    const t0 = performance.now();
    const lines = wrapLines(big, 42, 2);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(lines.join(" ")).toBe(big);
  });
  it("a ~3,000-word paragraph wraps quickly and exactly as the full candidate scan did", () => {
    const W = ["the", "Hello,", "world.", "and", "extraordinarily", "of", "so;", "running"];
    const big = Array.from({ length: 3000 }, (_, i) => W[(i * 7 + (i >> 3)) % W.length]).join(" ");
    const t0 = performance.now();
    const lines = wrapLines(big, 42, 2);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(lines.join(" ")).toBe(big);
    // Pre-change snapshot: the candidate cut-off changes speed, never the chosen breaks.
    expect(lines.length).toBe(510);
    expect(lines[12]).toBe("Hello, Hello, the running so; of extraordinarily and world.");
  });
  it("a CJK line never ends on an opening bracket nor starts with a closer or stop", () => {
    for (const t of [
      "あいうえおかきくけこ「さしすせそたちつてとなに」",
      "あいうえおかきくけこさ。しすせそたちつてとなにぬ",
      "あいうえおかきくけこさ」しすせそたちつてとなにぬ、ねのはひふへほ（まみむめもやゆよ）",
    ]) {
      const lines = wrapLines(t, 13, 2);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.every((l) => !/[「（]$/.test(l))).toBe(true);
      expect(lines.every((l) => !/^[」）。、]/.test(l))).toBe(true);
      expect(lines.join("")).toBe(t);
    }
  });
  it("an over-long word left alone on the last line wraps per character", () => {
    const w = "x".repeat(50);
    expect(wrapLines(`a ${w}`, 42, 2)).toEqual(["a", "x".repeat(25), "x".repeat(25)]);
  });
  it("a long CJK run before a Latin word wraps per character too, not only a trailing one", () => {
    const t = "我们今天要讨论的是如何使用大型语言模型来处理数据和文本 AI 工具";
    const lines = wrapLines(t, 16, 2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(16);
    expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
  });
  it("a word that fits alone but not after the name prefix stays whole", () => {
    const lines = wrapLines("Verantwortlichkeiten sind wichtig für alle Beteiligten hier heute", 42, 2, 30);
    expect(lines[0]).toBe("Verantwortlichkeiten");
    expect(lines.join(" ")).toBe("Verantwortlichkeiten sind wichtig für alle Beteiligten hier heute");
  });
  it("a CJK run that fits alone but not after the name prefix still wraps", () => {
    const t = "我们今天要讨论的是如何使 AI 工具";
    const lines = wrapLines(t, 16, 2, 6);
    expect(lines[0].length + 6).toBeLessThanOrEqual(16);
    expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
  });
  it("an over-cpl CJK run still wraps per character under a name prefix", () => {
    const t = "我们今天要讨论的是如何使用大型语言模型来处理数据和文本 AI 工具";
    const lines = wrapLines(t, 16, 2, 6);
    expect(lines[0].length + 6).toBeLessThanOrEqual(16);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(16);
    expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
  });
});

/** Unspaced Thai with tone marks and vowel signs (combining marks, \p{M}). */
const THAI = "วันนี้อากาศดีมากและฉันอยากไปเที่ยวทะเลกับเพื่อนๆที่น่ารักมากที่สุดในโลกนี้";

describe("combining marks stay with their base", () => {
  it("wrapLines never opens a line with a combining mark", () => {
    for (let cpl = 28; cpl <= 60; cpl++) {
      const lines = wrapLines(THAI, cpl, 2);
      expect(lines.join("")).toBe(THAI);
      expect(lines.every((l) => !/^\p{M}/u.test(l))).toBe(true);
    }
  });
  it("cutByShare never cuts before a combining mark or inside a ZWJ sequence", () => {
    const parts = cutByShare(THAI, [10, 10, 10]);
    expect(parts.join("")).toBe(THAI);
    expect(parts.every((p) => !/^\p{M}/u.test(p))).toBe(true);
    for (let k = 1; k < 20; k++) {
      expect(cutByShare(THAI, [k, 20 - k]).every((p) => !/^\p{M}/u.test(p))).toBe(true);
    }
    const family = "今日👨\u200d👩\u200d👧楽しい";
    for (let k = 1; k < 10; k++) {
      const p = cutByShare(family, [k, 10 - k]);
      expect(p.join("")).toBe(family);
      expect(p.every((x) => !x.startsWith("\u200d") && !x.endsWith("\u200d"))).toBe(true);
    }
  });
});

describe("edgeChar", () => {
  it("skips trailing combining marks and variation selectors at the end", () => {
    expect(edgeChar("か\u3099", true)).toBe("か");
    expect(edgeChar("葛\u{E0100}", true)).toBe("葛");
    expect(edgeChar("𠀋", true)).toBe("𠀋");
    expect(edgeChar("\u3099", true)).toBe("");
  });
});

describe("skin tones and flags stay whole", () => {
  const EMOJI = "今日は👍🏽ですね🇯🇵いい天気🇺🇸🇯🇵です";
  const broken = (p: string) => /^\p{Emoji_Modifier}/u.test(p) || [...p.matchAll(/\p{RI}+/gu)].some((m) => [...m[0]].length % 2);
  it("cutByShare never cuts before a skin tone or inside a flag", () => {
    for (let n = 2; n <= 12; n++) {
      const parts = cutByShare(EMOJI, Array(n).fill(1));
      expect(parts.join("")).toBe(EMOJI);
      expect(parts.some(broken)).toBe(false);
    }
  });
  it("wrapLines never opens a line with a skin tone or a flag half", () => {
    for (let cpl = 2; cpl <= 12; cpl++) {
      const lines = wrapLines(EMOJI, cpl, 2);
      expect(lines.join("")).toBe(EMOJI);
      expect(lines.some(broken)).toBe(false);
    }
  });
  it("own timing: a decomposed kana or a variation selector stays with its base", () => {
    // Slide the marked characters across the cut so one lands right where it falls.
    for (let n = 0; n < 30; n++) {
      const ja = "iOS の" + "あ".repeat(n) + "か\u3099葛\u{E0100}" + "い".repeat(40 - n);
      const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
      const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "ja"]);
      expect(grid.own.ja.length).toBeGreaterThan(1);
      expect(grid.own.ja.every((c) => !/^\p{M}/u.test(c.text.trim()))).toBe(true);
      expect(grid.own.ja.map((c) => c.text).join("").replace(/\s/g, "")).toBe(ja.replace(/\s/g, ""));
    }
  });
});

describe("cutByShare", () => {
  it("prefers punctuation near the share target", () => {
    expect(cutByShare("Erstens das hier, zweitens das dort.", [1, 1])).toEqual(["Erstens das hier,", "zweitens das dort."]);
  });
  it("keeps one unspaced word of a spaced script whole, in the first part", () => {
    expect(cutByShare("Hallo.", [40, 40, 30])).toEqual(["Hallo.", "", ""]);
  });
  it("cuts CJK text at character boundaries", () => {
    expect(cutByShare("今日は晴れ。明日は雨。", [1, 1])).toEqual(["今日は晴れ。", "明日は雨。"]);
  });
  it("never cuts inside a surrogate pair", () => {
    const parts = cutByShare("今日🎉楽しい", [3, 4]);
    expect(parts.join("")).toBe("今日🎉楽しい");
    expect(parts.every(wellFormed)).toBe(true);
  });
  it("cuts a CJK run between its characters even when one Latin word adds a space", () => {
    const text = "A案 は今日の会議で正式に承認されましたので来週から実施します";
    const parts = cutByShare(text, [10, 10, 10]);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length > 0)).toBe(true);
    expect(parts.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
  it("judges a spaced line's CJK seams by code point (decomposed kana, Ext-B)", () => {
    const pre = cutByShare("AI \u304c\u6b21\u306e\u6587", [1, 1]);
    expect(pre).toEqual(["AI \u304c", "\u6b21\u306e\u6587"]);
    // A decomposed "が" (か + U+3099) cuts like the precomposed one.
    expect(cutByShare("AI \u304b\u3099\u6b21\u306e\u6587", [1, 1])).toEqual(["AI \u304b\u3099", "\u6b21\u306e\u6587"]);
    // An Ext-B Han character (a surrogate pair) can be followed — and preceded — by a cut.
    const extB = cutByShare("AI \u{20B9F}\u6b21\u306e\u6587", [1, 1]);
    expect(extB).toEqual(["AI \u{20B9F}", "\u6b21\u306e\u6587"]);
    expect(extB.every(wellFormed)).toBe(true);
  });
  it("never cuts right after an opening bracket", () => {
    for (const text of [
      "iPhone の「新機能」と「新しい画面」と「便利な設定」と「速い通信」について",
      "彼は「新機能」と「新しい画面」と「便利な設定」と「速い通信」について説明します",
    ]) {
      for (let k = 1; k < 20; k++) {
        const parts = cutByShare(text, [k, 20 - k]);
        expect(parts.every((p) => !/[「（]$/.test(p))).toBe(true);
        expect(parts.every((p) => !/^[」）。、]/.test(p))).toBe(true);
      }
    }
  });
  it("may cut right before an opening bracket in spaced text", () => {
    const text = "iPhone の新機能と「新しい画面」";
    const cuts = new Set<string>();
    for (let k = 1; k < 20; k++) cuts.add(cutByShare(text, [k, 20 - k])[0]);
    expect(cuts.has("iPhone の新機能と")).toBe(true);
  });
  it("never cuts before an astral variation selector (a surrogate-pair mark)", () => {
    const text = "今日は葛\u{E0100}城さんが来ました";
    for (let k = 1; k < 20; k++) {
      const parts = cutByShare(text, [k, 20 - k]);
      expect(parts.join("")).toBe(text);
      expect(parts.every((p) => !p.startsWith("\u{E0100}") && wellFormed(p))).toBe(true);
    }
  });
  it("still avoids a cut right after an article past the bounded look-back", () => {
    const text = "Understandably everyone waited for the announcement";
    expect(cutByShare(text, [38, 13]).every((p) => !/\bthe$/.test(p))).toBe(true);
  });
});

describe("trackLang", () => {
  it("the original's language, a site track's own, a target's code — und when unknown", () => {
    const r: BatchResult = { text: "", language: " de ", timedTracks: [{ id: "x", lang: "fr", source: "site", kind: "manual", cues: [] }] };
    expect(["orig", "en", "x"].map((t) => trackLang(r, t))).toEqual(["de", "en", "fr"]);
    expect(trackLang({}, "orig")).toBe("und");
    expect(timedTrack(r, "x")?.lang).toBe("fr");
    expect(timedTrack(r, "orig")).toBeUndefined();
  });
});

describe("trText", () => {
  it("a usable translation, trimmed; none when kept-original, absent or blank", () => {
    const seg = { start: 0, end: 1, text: "Hallo", translations: { en: " Hello ", fr: "  ", it: "Ciao" }, translationsKept: ["it"] };
    expect(["en", "fr", "it", "es"].map((l) => trText(seg, l))).toEqual(["Hello", null, null, null]);
  });
});

describe("trackLimits / limitsTitle", () => {
  it("a track's language's limits; null as transcribed", () => {
    const r: BatchResult = { text: "", language: "de" };
    const o: CueOptions = { length: "standard", timing: "same" };
    expect(trackLimits(r, o, "orig")?.cps).toBe(17);
    expect(trackLimits(r, o, "en")?.cps).toBe(20);
    expect(trackLimits(r, o, "ja")?.cpl).toBe(13);
    expect(trackLimits(r, undefined, "orig")).toBeNull();
    expect(TRANSCRIBED_CPS).toBe(20);
    expect(trackCps(r, o, "orig")).toBe(17);
    expect(trackCps(r, undefined, "orig")).toBe(TRANSCRIBED_CPS);
  });
  it("the tooltip names lines, characters, duration and speed", () => {
    expect(limitsTitle(CUE_PRESETS.standard)).toBe("2 lines × 42 characters · up to 7 s · 17 chars/s");
    expect(limitsTitle(CUE_PRESETS.short)).toBe("1 line × 42 characters · up to 4 s · 17 chars/s");
  });
});
