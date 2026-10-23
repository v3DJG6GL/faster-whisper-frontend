import { describe, expect, it } from "vitest";
import {
  CUE_PRESETS, TRANSCRIBED_CPS, buildCues, cjkWraps, cjkWrapsLines, cueOptionsOf, cueResult, cutByShare, edgeChar, joinLineBreaks, limitsFor, limitsTitle, trackCps, trackLimits, sanitizeCueLimits, timedTrack, trText, trackCues, trackLang, wrapLines,
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

  it("a cue whose words would wrap to a third line splits, so no cue exceeds its line cap", () => {
    const text = "Wir sprechen heute über Verantwortungsbewusstsein und Zusammengehörigkeitsgefühl.";
    expect(text.length).toBeLessThanOrEqual(84);
    const { cues } = buildCues(seg1(text, 0, 4.4, { language: "de" }), STD, ["orig"]);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(wrapLines(c.text, 42, 2).length).toBeLessThanOrEqual(2);
    expect(cues.map((c) => c.text).join(" ")).toBe(text);
  });

  it("a clause ending on a preposition (\"lights on,\") is a good seam, not a dangling one", () => {
    const text = "We need to figure out how to turn the lights on, and then we can finally start the show tonight.";
    const { cues } = buildCues(seg1(text, 0, 19 * 0.25), STD, ["orig"]);
    expect(cues.map((c) => c.text)).toEqual(["We need to figure out how to turn the lights on,", "and then we can finally start the show tonight."]);
    // An abbreviation still dangles: no cue ends on "Mr.".
    const mr = "Yesterday afternoon I finally met Mr. Johnson and his wife at the station in the city centre.";
    expect(buildCues(seg1(mr, 0, 17 * 0.25), STD, ["orig"]).cues.some((c) => c.text.endsWith("Mr."))).toBe(false);
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

  it("a title or ordinal behind an opening bracket or quote is no sentence end either", () => {
    const short: CueOptions = { length: "short", timing: "same" };
    for (const t of [
      "Yesterday we finally went to visit our old friend (Dr. Martin Keller) at his home",
      "Yesterday we finally went to visit her and she said “Mr. Keller is not at home”",
      'Yesterday we finally went to visit her and she said "Prof. Keller is not at home"',
    ]) {
      const cues = buildCues(seg1(t, 0, 6), short, ["orig"]).cues.map((c) => c.text);
      expect(cues.some((c) => /(?:Dr|Mr|Prof)\.$/.test(c)), JSON.stringify(cues)).toBe(false);
    }
    const de = "Wir haben uns damals im Sommer getroffen und zwar am Freitag (12. Mai) in einem kleinen Café am See";
    const cues = buildCues(seg1(de, 0, 9, { language: "de" }), STD, ["orig"]).cues.map((c) => c.text);
    expect(cues.some((c) => c.endsWith("(12.")), JSON.stringify(cues)).toBe(false);
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

  it("own timing: a translation stays in the spoken stretches, never over a pause", () => {
    const es = "Ocurrió hace medio siglo. Durante casi mil días, estos paisajes se vieron asolados por una cruel guerra civil.";
    const de = "Es geschah vor einem halben Jahrhundert. Fast tausend Tage lang wurden diese Landschaften von einem grausamen Bürgerkrieg verwüstet.";
    const r = seg1(es, 152.5, 188.8, { segments: [{ start: 152.5, end: 188.8, text: " " + es, translations: { de } }] }, { 3: 30 });
    const grid = buildCues(r, { ...STD, timing: "own" }, ["de"]);
    const pause = [r.words![3].end, r.words![4].start];
    expect(grid.own.de.every((c) => c.end <= pause[0] || c.start >= pause[1])).toBe(true);
    expect(grid.own.de.find((c) => c.end <= pause[0])?.text).toBe("Es geschah vor einem halben Jahrhundert.");
    expect(grid.own.de.map((c) => c.text).join(" ")).toBe(de);
    expect(grid.own.de[grid.own.de.length - 1].end).toBe(188.8);
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

  it("own timing: a quote whose partner lies in the next cue of its segment opens forward", () => {
    // Its cue (or line) was tokenized alone, where the partner is missing: it ended on 说".
    const zh = '今天下午他终于对我说"我今天真的很累很累，想早点回家休息一下"然后就走了';
    const short: CueOptions = { length: "short", timing: "own" };
    const L = limitsFor(short, "zh");
    for (const pause of [3, 8, 13, 20, 25]) {
      const r = seg1(LONG, 0, 20, { segments: [{ start: 0, end: 20, text: " " + LONG, translations: { zh } }] }, { [pause]: 1.5 });
      const own = buildCues(r, short, ["orig", "zh"]).own.zh;
      expect(own.map((c) => c.text).join("")).toBe(zh);
      for (const c of own) {
        expect(c.text, `${pause}: ${own.map((x) => x.text).join(" | ")}`).not.toMatch(/说"$/);
        for (const l of wrapLines(c.text, L.cpl, L.lines, 0, c.q)) expect(l).not.toMatch(/说"$/);
      }
    }
  });

  it("a bracket Whisper times as a word of its own never ends or starts a cue", () => {
    // Whisper's merge_punctuations leaves 「 」 （ ） alone: each arrives as its own timed word.
    const ja = ["私", "は", "昨日", "の", "夜", "に", "友達", "と", "一緒", "に", "「", "美味しい", "ラーメン", "屋", "さん", "」", "に", "行って", "、", "とても", "楽しい", "時間", "を", "過ごし", "ました", "。"];
    const zh = ["我", "昨天", "和", "朋友", "去", "了", "一家", "（", "非常", "有名", "的", "）", "餐厅", "，", "吃", "得", "很", "开心", "。"];
    for (const [lang, ws] of [["ja", ja], ["zh", zh]] as const) {
      const text = ws.join("");
      // No pause, and a pause right before the closing bracket.
      for (const pauseBefore of [-1, ws.findIndex((w) => /^[」）]$/.test(w))]) {
        let t = 0;
        const words = ws.map((w, i) => {
          if (i === pauseBefore) t += 0.6;
          const word = { word: w, start: t, end: t + 0.12 * w.length };
          t = word.end;
          return word;
        });
        const r: BatchResult = { text, language: lang, words, segments: [{ start: 0, end: t, text }] };
        for (const length of ["standard", "short"] as const) {
          const { cues } = buildCues(r, { length, timing: "same" }, ["orig"]);
          const all = cues.map((c) => c.text).join(" | ");
          if (length === "short" || lang === "ja") expect(cues.length, all).toBeGreaterThan(1);
          expect(cues.some((c) => /[「（]$/.test(c.text)), all).toBe(false);
          expect(cues.some((c) => /^[」）。、，]/.test(c.text)), all).toBe(false);
          expect(cues.map((c) => c.text).join("")).toBe(text);
        }
      }
    }
  });

  it("a pause after a glued 」\" lands on the seam before the split-off opener", () => {
    // The opener's clock sat at the end of 」": the pause fell on the seam after it (never cut),
    // a cue ran over the silence and own timing lost the gap.
    const ws = ["他说", "今天", "天气", "很好", "「真的", '」"', '再见"', "然后", "我们", "一起", "走了", "很远", "很远", "的路", "回家"];
    let t = 0;
    const words = ws.map((word, i) => {
      const w = { word, start: t, end: t + 0.3 };
      t = w.end + 0.05 + (i === 5 ? 2 : 0);
      return w;
    });
    const text = ws.join("");
    const r: BatchResult = { text, language: "zh", words, segments: [{ start: 0, end: t, text }] };
    const [pauseFrom, pauseTo] = [words[5].end, words[6].start];
    for (const length of ["short", "standard"] as const) {
      const { cues } = buildCues(r, { length, timing: "same" }, ["orig"]);
      const all = cues.map((c) => `${c.text} [${c.start}–${c.end}]`).join(" | ");
      expect(cues.every((c) => c.end <= pauseFrom + 1e-9 || c.start >= pauseTo - 1e-9), all).toBe(true);
      expect(cues.some((c) => c.text.startsWith('"再见"')), all).toBe(true);
      expect(cues.map((c) => c.text).join("")).toBe(text);
    }
    const en = 'He said the weather today is nice, "really", goodbye, and then we walked a very long way home together';
    const own = buildCues(
      { ...r, segments: [{ start: 0, end: t, text, translations: { en } }] },
      { length: "short", timing: "own" },
      ["orig", "en"],
    ).own.en;
    expect(own.some((c, k) => k > 0 && c.start - own[k - 1].end > 1.9)).toBe(true);
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

  it("own timing: a word mixing fullwidth and ASCII letters or digits never ends a cue inside", () => {
    for (const w of ["ＰＳ5", "ＮＨＫnews"]) {
      for (let p = 0; p < 30; p++) {
        const ja = "新しい " + "あ".repeat(p) + w + "を 買いました 今日は とても 楽しかったです";
        const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
        const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "ja"]);
        expect(grid.own.ja.some((c) => /(ＰＳ|ＮＨＫ)$/.test(c.text.trim()))).toBe(false);
        expect(grid.own.ja.map((c) => c.text).join("").replace(/\s/g, "")).toBe(ja.replace(/\s/g, ""));
      }
    }
  });

  it("own timing: a Latin word glued into a CJK translation is never split across cues", () => {
    const ja = "今日は朝から新しいiPhoneProMaxを買いに行きましたが駅までの道はとても混んでいて電車も遅れていました";
    for (const length of ["standard", "short"] as const) {
      const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { ja } }] });
      const grid = buildCues(r, { ...STD, length, timing: "own" }, ["orig", "ja"]);
      expect(grid.own.ja.length).toBeGreaterThan(1);
      expect(grid.own.ja.some((c) => c.text.includes("iPhoneProMax"))).toBe(true);
      expect(grid.own.ja.map((c) => c.text).join("")).toBe(ja);
    }
  });

  it("own timing: a cue whose glued quote pairs with the next cue stays in its line cap as its export wraps it", () => {
    // The " after 好 opens a quotation the next cue closes: wrapped with the cue's quotes (Cue.q,
    // as the export and the Subtitles view do) it rides forward, judged without them it joined
    // backward, and the cue the splitter accepted took a third line.
    const zh = '园他，的天"好说去起们气他好"OKiPhone公"天"天，今气OK们我天好"公OK"很的的';
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { zh } }] });
    const o: CueOptions = { ...STD, timing: "own" };
    const L = trackLimits(r, o, "zh")!;
    const cues = buildCues(r, o, ["orig", "zh"], () => 9).own.zh;
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(wrapLines(c.text, L.cpl, L.lines, 9, c.q).length, c.text).toBeLessThanOrEqual(L.lines);
    expect(cues.map((c) => c.text).join("")).toBe(zh);
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
  it("keeps one spaced-script word whole when only the prefix pushes it over", () => {
    expect(wrapLines("감사합니다.", 16, 2, 11)).toEqual(["감사합니다."]);
    expect(wrapLines("Okay.", 42, 2, 45)).toEqual(["Okay."]);
    // An unspaced run has no word to protect: it still wraps to fit the prefixed line.
    const kana = "あいうえおかきくけこさしすせ";
    const lines = wrapLines(kana, 16, 2, 11);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(kana);
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
    // Snapshot: the candidate cut-off changes speed, never the chosen breaks.
    expect(lines.length).toBe(592);
    expect(lines[12]).toBe("Hello, Hello, the running so;");
    // A line never runs over the cap while its words fit on more lines.
    expect(lines.every((l) => l.length <= 42)).toBe(true);
  });
  it("takes more lines rather than one over the cap when the words fit", () => {
    expect(wrapLines("to go yesterday and it was", 13, 2)).toEqual(["to go", "yesterday", "and it was"]);
    const de = "Wir haben das Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz gelsen";
    const lines = wrapLines(de, 42, 2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    expect(lines.join("").replace(/\s/g, "")).toBe(de.replace(/\s/g, ""));
    // A word over the cap by itself: its line ends right after it (and wraps), never at a
    // better break further on.
    const x = "x".repeat(50);
    for (const l of wrapLines(`a ${x} is. Then we go`, 42, 2)) expect(l.length).toBeLessThanOrEqual(42);
  });
  it("a Latin word or number glued into unspaced text stays whole", () => {
    expect(wrapLines("明日はMicrosoftの会議があります", 13, 2)).toEqual(["明日はMicrosoft", "の会議があります"]);
    const js = "今日はJavaScriptとTypeScriptについて話します";
    const lines = wrapLines(js, 13, 2);
    expect(lines.join("")).toBe(js);
    expect(lines.slice(1).some((l, i) => /[A-Za-z]$/.test(lines[i]) && /^[A-Za-z]/.test(l))).toBe(false);
    expect(wrapLines("昨日東京に行きました,とても楽しかったです", 13, 2).some((l) => l.startsWith(","))).toBe(false);
    expect(cutByShare("今日はiPhoneを買いました", [1, 1])).toEqual(["今日はiPhone", "を買いました"]);
    const zh = "我昨天去了北京(中国的首都)玩得很开心呀朋友们";
    const parts = cutByShare(zh, [1, 1, 1]);
    expect(parts.join("")).toBe(zh);
    expect(parts.some((p) => p.endsWith("(") || p.startsWith(")"))).toBe(false);
  });
  it("a CJK line with phrase spaces breaks at a space on every line, not only on two", () => {
    const lines = wrapLines("2024年に東京へ行った 楽しかったです 本当にありがとうございました", 16, 2);
    expect(lines.some((l) => l.endsWith("行っ"))).toBe(false);
    expect(lines.join("").replace(/\s/g, "")).toBe("2024年に東京へ行った楽しかったです本当にありがとうございました");
  });
  it("French spaced punctuation stays with its word", () => {
    for (const [t, cpl] of [["Il a dit « bonjour » à Paris et ailleurs", 16], ["Il a dit « bonjour » à 東京の人たち", 16],
      ["Ça va ? Oui, très bien merci, et toi ? Je vais bien aussi !", 13]] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.every((l) => l.length <= cpl && !/«$/.test(l) && !/^[»?!]/.test(l))).toBe(true);
      expect(lines.join(" ")).toBe(t);
    }
    const parts = cutByShare("Il a dit « bonjour » à Paris", [1, 1]);
    expect(parts).toEqual(["Il a dit", "« bonjour » à Paris"]);
  });
  it("a no-break space is no word break, and a line keeps it as written", () => {
    // /\s/ matches U+00A0, U+202F and U+2007: "25 000" was cut and wrapped across its
    // no-break space, and a wrapped line rewrote "viens ?" with a plain space.
    const parts = cutByShare("Le prix est de 1 250 000 euros", [1, 1], "fr");
    expect(parts.some((p) => p.includes("1 250 000")), JSON.stringify(parts)).toBe(true);
    expect(parts.join(" ")).toBe("Le prix est de 1 250 000 euros");
    const won = "Il a gagné 25 000 euros hier soir avec";
    const lines = wrapLines(won, 13, 2, 0, undefined, "fr");
    expect(lines.some((l) => l.includes("25 000")), JSON.stringify(lines)).toBe(true);
    expect(lines.join(" ")).toBe(won);
    const ask = "Tu viens ? Oui, je viens tout de suite";
    const asked = wrapLines(ask, 12, 2, 0, undefined, "fr");
    expect(asked.some((l) => l.includes("viens ?")), JSON.stringify(asked)).toBe(true);
    expect(asked.join(" ")).toBe(ask);
    // A no-break run longer than a line still wraps at its spaces, losing none of them.
    const run = "un deux trois quatre cinq six sept";
    expect(wrapLines(run, 13, 2).join(" ").replace(/\s/g, "")).toBe(run.replace(/\s/g, ""));
  });
  it("an own-timed translation and a line with a CJK run keep a no-break space too", () => {
    // Their tokens (mixedTokens) split at every \s: an own-timed cue ended on "25" and the next
    // opened with "000", and a line of mixed text broke there and wrote it back as a plain space.
    const en = "The glacier behind me has lost almost forty percent of its volume since 1980, and twenty five thousand people live in the valley below it today.";
    const W = "les gens du village voisin ont vu".split(" ");
    for (const length of ["short", "standard"] as const) {
      for (let a = 0; a <= W.length; a++) {
        for (let b = 0; b <= 3; b++) {
          const fr = `${W.slice(0, a).join(" ")} 25 000 ${"mots ".repeat(b)}personnes sont venues voir le glacier hier soir avec nous tous.`.trim();
          const r = seg1(en, 10, 30, { segments: [{ start: 10, end: 30, text: " " + en, translations: { fr } }] });
          const own = buildCues(r, { length, timing: "own" }, ["orig", "fr"]).own.fr.map((c) => c.text);
          expect(own.join(" "), JSON.stringify(own)).toBe(fr);
        }
      }
    }
    const mix = "Il a dit que 東京 avait 25 000 visiteurs hier soir, tu viens ?";
    for (const cpl of [12, 14, 16, 20]) expect(wrapLines(mix, cpl, 2).join(" "), String(cpl)).toBe(mix);
    // Beside a CJK character, a guillemet or an opener it stays as written too, and no line breaks there.
    for (const t of [
      "Il a dit\u00a0: «\u00a0さようなら\u00a0» puis il est parti",
      "Nous allons visiter le temple «\u00a0東京寺\u00a0» demain matin",
      "Le mot x\u00a0(東京) est là",
    ]) {
      for (let cpl = 10; cpl <= 42; cpl++) {
        const lines = wrapLines(t, cpl, 2);
        // Every no-break space kept as written (a forced break inside 東京寺 drops nothing).
        expect(lines.join("").replace(/ /g, ""), `${cpl}: ${JSON.stringify(lines)}`).toBe(t.replace(/ /g, ""));
        expect(lines.some((l) => /^[\u00a0(]|[\u00a0(]$/.test(l)), `${cpl}: ${JSON.stringify(lines)}`).toBe(false);
      }
    }
    // A no-break run longer than a line still wraps at its spaces, losing none of its characters.
    const run = "東京 un deux trois quatre cinq six sept";
    expect(wrapLines(run, 13, 2).join("").replace(/\s/g, "")).toBe(run.replace(/\s/g, ""));
  });
  it("a word with a no-break space beside a CJK character, pushed over only by a speaker name, keeps it", () => {
    // The per-character fallback for the prefixed first line dropped the no-break space and
    // cut where it holds: "京a" / "vaitxx", a line opening on "!".
    for (const [t, cpl, reserve] of [
      ["京 avaitxx 東京", 10, 4],
      ["さ !今日はいい天気です", 8, 7],
      ["京 avait。今日は", 8, 4],
    ] as const) {
      const lines = wrapLines(t, cpl, 2, reserve);
      expect(lines.join("").replace(/ /g, ""), JSON.stringify(lines)).toBe(t.replace(/ /g, ""));
      expect(lines.some((l) => /^[!  ]|[  ]$/.test(l)), JSON.stringify(lines)).toBe(false);
    }
  });
  it("a spaced & is a conjunction, not a closing mark glued to the word before it", () => {
    const t = "We met the people from Procter & Gamble at the big conference yesterday";
    // At 38 the only seam keeping both lines within the cap is after the "&".
    expect(wrapLines(t, 42, 2)).toEqual(["We met the people from Procter", "& Gamble at the big conference yesterday"]);
    let s = 0;
    const words = t.split(/(?= )/).map((word) => ({ word, start: s, end: (s += 0.4) }));
    const r: BatchResult = { text: t, language: "en", words, segments: [{ start: 0, end: s, text: t }] };
    for (const maxDur of [2, 3, 4]) {
      const cues = buildCues(r, { length: "custom", custom: { cpl: 42, lines: 1, maxDur, cps: 17 }, timing: "same" }, ["orig"])
        .cues.map((c) => c.text);
      expect(cues.filter((c) => c.endsWith("&")), cues.join(" | ")).toEqual([]);
    }
    expect(cutByShare(t, [4, 6], "en")).toEqual(["We met the people from Procter", "& Gamble at the big conference yesterday"]);
    expect(wrapLines("Tu viens ce soir avec nous au cinéma ou pas, vraiment ?", 30, 2))
      .toEqual(["Tu viens ce soir avec nous", "au cinéma ou pas, vraiment ?"]);
  });
  it("Arabic and Hindi sentence marks are seams like a Latin stop", () => {
    const ar = "هل أنت بخير اليوم؟ نعم أنا بخير والحمد لله";
    expect(cutByShare(ar, [1, 1], "ar")).toEqual(["هل أنت بخير اليوم؟", "نعم أنا بخير والحمد لله"]);
    expect(wrapLines(ar, 30, 2, 0, undefined, "ar")[0]).toBe("هل أنت بخير اليوم؟");
    const hi = "मैं आज बाजार गया था। वहाँ बहुत भीड़ थी और गर्मी भी";
    expect(cutByShare(hi, [1, 1], "hi")[0]).toBe("मैं आज बाजार गया था।");
    expect(wrapLines(hi, 30, 2, 0, undefined, "hi")[0]).toBe("मैं आज बाजार गया था।");
  });
  it("Khmer, Burmese and Tibetan sentence and clause marks are seams like a Latin stop", () => {
    expect(cutByShare("សួស្តី។ខ្ញុំឈ្មោះចន។ថ្ងៃនេះអាកាសធាតុល្អ។", [1, 1, 1], "km")).toEqual([
      "សួស្តី។", "ខ្ញុំឈ្មោះចន។", "ថ្ងៃនេះអាកាសធាតុល្អ។",
    ]);
    expect(cutByShare("ខ្ញុំទៅផ្ទះ។បន្ទាប់មកខ្ញុំញ៉ាំបាយ។", [1, 1], "km")).toEqual(["ខ្ញុំទៅផ្ទះ។", "បន្ទាប់មកខ្ញុំញ៉ាំបាយ។"]);
    expect(cutByShare("ကျွန်တော်အိမ်ပြန်သွားတယ်။ပြီးတော့ထမင်းစားတယ်။", [1, 1], "my")).toEqual([
      "ကျွန်တော်အိမ်ပြန်သွားတယ်။", "ပြီးတော့ထမင်းစားတယ်။",
    ]);
    // Spaced text: the cut lands where it lands with "." in the mark's place.
    for (const [t, mark, lang, shares] of [
      ["ខ្ញុំ បាន ទៅ ផ្សារ ថ្ងៃនេះ។ នៅទីនោះ មាន មនុស្ស ច្រើន ណាស់ ហើយ ក្តៅ", "។", "km", [1, 1]],
      ["ကျွန်တော် ဈေး ကို သွားခဲ့တယ်။ အဲဒီမှာ လူ အများကြီး ရှိတယ် ပြီးတော့ ပူတယ်", "။", "my", [1, 1]],
      ["ང་ ཉི་མ་ འདི་ ལ་ ཁྲོམ་ ལ་ ཕྱིན་བྱུང་། དེར་ མི་ མང་པོ་ འདུག་ ཚ་པོ་ ཡང་ ཡོད", "།", "bo", [1, 2]],
      ["ང་ ཁྲོམ་ ལ་ ཕྱིན་བྱུང་༎ དེར་ མི་ མང་པོ་ འདུག", "༎", "bo", [1, 1, 1]],
    ] as const) {
      const parts = cutByShare(t, [...shares], lang);
      expect(parts[0].endsWith(mark)).toBe(true);
      expect(parts).toEqual(cutByShare(t.replace(mark, "."), [...shares], lang).map((p) => p.replace(".", mark)));
    }
    // The Burmese comma is a clause seam.
    expect(cutByShare("ကျွန်တော် ဈေး ကို သွားခဲ့တယ်၊ အဲဒီမှာ လူ အများကြီး ရှိတယ်", [1, 2], "my")[0]).toBe(
      "ကျွန်တော် ဈေး ကို သွားခဲ့တယ်၊",
    );
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
  it("an opener glued to the end of a Latin word moves onto the line it opens", () => {
    expect(wrapLines("私たちは昨日 Python(パイソン)について学びました", 16, 2)).toEqual([
      "私たちは昨日 Python",
      "(パイソン)について学びました",
    ]);
    expect(wrapLines("東京 Google(グーグル)本社に行きました", 16, 2, 6)).toEqual([
      "東京 Google",
      "(グーグル)本社に行きました",
    ]);
  });
  it("a Spanish ¿ or ¡ before a word longer than a line rides with it: no line ends on a bare ¿ or ¡", () => {
    expect(wrapLines("Entonces ella me dijo ¿https://www.ejemplo.com/ruta/muy/larga/de/verdad/aqui?", 28, 2, 4)[0])
      .toBe("Entonces ella me dijo");
    expect(wrapLines("Dijo ¡¡Electroencefalografistas!!", 15, 2, 6)[0]).toBe("Dijo");
    for (const word of ["¿https://www.ejemplo.com/ruta/muy/larga/de/verdad/aqui?", "¡¡Electroencefalografistas!!"])
      for (const pre of ["Dijo", "Entonces ella me dijo", "Ella preguntó en voz alta otra vez"])
        for (const reserve of [0, 4, 6])
          for (let cpl = 13; cpl <= 42; cpl++) {
            const lines = wrapLines(`${pre} ${word}`, cpl, 2, reserve);
            expect(lines.some((l) => /[¿¡]$/.test(l))).toBe(false);
            expect(lines.join("").replace(/\s/g, "")).toBe(`${pre}${word}`.replace(/\s/g, ""));
          }
  });
  it("a line never starts with the prolonged sound mark ー", () => {
    for (const [t, cpl] of [["コーヒーとケーキが大好きです", 4], ["東京 Google(グーグル)本社に行きました", 13]] as const) {
      const lines = wrapLines(t, cpl, 9);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.some((l) => l.startsWith("ー"))).toBe(false);
      expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
    }
    for (const p of cutByShare("コーヒーコーヒー", [1, 1, 1, 1, 1, 1, 1])) expect(p.startsWith("ー")).toBe(false);
  });
  it("a run of ー longer than the cap still wraps and cuts within it (only one ー rides along)", () => {
    for (const t of ["え" + "ー".repeat(19) + "と 次は", "うわ" + "ー".repeat(29), "すご" + "ー".repeat(22) + "い"]) {
      const lines = wrapLines(t, 16, 2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(16);
      expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
    }
    expect(cutByShare("すご" + "ー".repeat(22) + "い", [1, 1, 1])).toEqual([
      "すご" + "ー".repeat(6),
      "ー".repeat(9),
      "ー".repeat(7) + "い",
    ]);
  });
  it("a German closing quote stays on its word before a glued CJK run", () => {
    expect(wrapLines("Er sagte „Hallo“東京に行きました", 14, 2)).toEqual(["Er sagte", "„Hallo“", "東京に行きました"]);
  });
  it("an ASCII quote opening a quotation in CJK text rides with what it opens", () => {
    // As a stop by class it joined the character before it: a line or part ended on the opening ".
    expect(wrapLines('他说我们明天一起去北京"看看那"里的风景然后回家', 13, 2)).toEqual(["他说我们明天一起去北京", '"看看那"里的风景然后回家']);
    expect(wrapLines('彼は"東京"と言いました', 13, 2, 6)).toEqual(["彼は", '"東京"と言いました']);
    expect(wrapLines('我说"好"，他说"不"。然后走了', 4, 2)).toEqual(["我说", '"好"，', "他说", '"不"。', "然后走了"]);
    expect(wrapLines('他说（"你好"）然后走了回家', 5, 2).some((l) => /["（]$/.test(l))).toBe(false);
    expect(cutByShare('私たちは"東京"と言いました', [1, 1, 1])).toEqual(["私たちは", '"東京"と', "言いました"]);
    expect(cutByShare("他说'你好'然后", [1, 1, 1])).toEqual(["他说", "'你好'", "然后"]);
    // One glued to a Latin word or number before it opens too (iPhone"新機能"), not an inch mark (6.1")
    // nor a lone possessive (James').
    expect(wrapLines('私はiPhone"新機能"が好きです', 13, 2)).toEqual(["私はiPhone", '"新機能"が好きです']);
    expect(cutByShare('私はiPhone"新機能"が好きです', [1, 1], "ja")).toEqual(["私はiPhone", '"新機能"が好きです']);
    expect(cutByShare('我们公司最近推出了AI"助手"功能大家都很喜欢', [1, 1], "zh")).toEqual(["我们公司最近推出了AI", '"助手"功能大家都很喜欢']);
    expect(cutByShare("昨日の会議ではUSB-C'規格'について話し合いました", [1, 1], "ja").some((p) => /'$/.test(p))).toBe(false);
    expect(cutByShare('新款手机屏幕6.1"大小非常合适大家都很喜欢', [1, 1], "zh").some((p) => p.includes('6.1"'))).toBe(true);
    expect(cutByShare("我读了James'新书然后就走了大家都很喜欢", [1, 1], "zh").some((p) => p.includes("James'"))).toBe(true);
    // Not one that may close a quotation opened between two letters, which no count sees (RTX"Super"):
    // its count's parity is off, and split off it cut what it closes off — but a ' a word after
    // an apostrophe (I'm) still opens.
    expect(wrapLines('我们的产品叫RTX"Super"和"Ultra"两个版本', 12, 2)).toEqual(["我们的产品叫", 'RTX"Super"', '和"Ultra"两个版本']);
    expect(wrapLines("我们的产品叫RTX'Super'和'Ultra'两个版本", 12, 2)).toEqual(["我们的产品叫", "RTX'Super'", "和'Ultra'两个版本"]);
    expect(cutByShare('我们的产品叫RTX"Super"和"Ultra"两个版本', [1, 1])).toEqual(['我们的产品叫RTX"Super"', '和"Ultra"两个版本']);
    // Also in a cue cut right after RTX: its leading " is judged by the X before it, as in the segment.
    const afterRtx = { before: { '"': 0, "'": 0 }, after: { '"': 0, "'": 0 }, prev: "X" };
    for (const cpl of [8, 10, 12, 13]) {
      const lines = wrapLines('"Super"和"Ultra"两个版本然后我们一起走了', cpl, 2, 0, afterRtx, "zh");
      expect(lines[0], lines.join(" | ")).toBe('"Super"');
    }
    expect(wrapLines('新しいApple"Vision Pro"と"iPhone"を発表しました', 10, 2)).toContain('Pro"');
    expect(wrapLines('我们用的是Model"X"和Model"Y"两款车', 8, 2)).toContain('Model"X"');
    expect(wrapLines("I'm Mike'新功能'很好用大家都很喜欢", 8, 2)).toEqual(["I'm Mike", "'新功能'很好", "用大家都很喜欢"]);
    // One after a bracket glued to a word (print(") moves onto what it opens with the bracket.
    expect(cutByShare('使用print("你好")函数', [1, 1])).toEqual(["使用print", '("你好")函数']);
    // The closing quote still joins what it closes, and an apostrophe (it's) is no quote.
    expect(cutByShare('我说"好"，他说"不"。', [1, 1])).toEqual(['我说"好"，', '他说"不"。']);
    expect(cutByShare("我觉得it's很好，他说'好'然后走了", [1, 1, 1])).toEqual(["我觉得it's很好，", "他说", "'好'然后走了"]);
    // With no later quote of its kind it closes: the quotation opened in the previous segment,
    // or a stray inch mark before it flipped the count.
    expect(cutByShare('去北京"然后回家', [1, 1])).toEqual(['去北京"', "然后回家"]);
    expect(cutByShare("去北京'然后回家", [1, 1])).toEqual(["去北京'", "然后回家"]);
    expect(wrapLines('我们明天去北京看看"然后回家吧', 6, 2)).toEqual(["我们明天去", '北京看看"', "然后回家吧"]);
    expect(wrapLines('屏幕是6.1"的手机，他说"很好"然后走了回家吧', 8, 2).some((l) => /^"|"$/.test(l))).toBe(false);
  });
  it("an inch or foot mark after a digit is no quote: the quotation after it still opens", () => {
    for (const t of ['屏幕是6.1"的手机，他说"很好"然后走了回家吧', '我买了27"的显示器，他说"真大"然后笑了']) {
      for (let cpl = 4; cpl <= 16; cpl++) {
        const lines = wrapLines(t, cpl, 2);
        expect(lines.some((l) => /说"$/.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
        expect(lines.join("")).toBe(t);
      }
      for (let n = 2; n <= 6; n++) {
        const parts = cutByShare(t, Array(n).fill(1));
        expect(parts.some((p) => /说"$/.test(p)), `${n}: ${parts.join(" | ")}`).toBe(false);
        expect(parts.join("")).toBe(t);
      }
    }
    // At an odd count a quote after a digit closes, as before: the pair after it still opens.
    expect(wrapLines('他说"是2024"然后"好"了', 6, 2)).toEqual(['他说"是', '2024"', '然后"好"了']);
    expect(cutByShare('他说"是2024"然后"好"了', [1, 1, 1, 1])).toEqual(['他说"是', '2024"', "然后", '"好"了']);
  });
  it("a cue's lines pair its quotes over its whole segment (QuoteCtx)", () => {
    const none = { '"': 0, "'": 0 };
    // The opening quote's partner lies in the next cue of the segment: it still opens forward,
    // as the whole segment wraps it.
    const whole = '今天下午他终于对我说"我今天真的很累很累，想早点回家休息一下"然后就走了';
    const cue = '今天下午他终于对我说"我今天真的很累很累，想';
    expect(wrapLines(whole, 16, 2).some((l) => /说"$/.test(l))).toBe(false);
    expect(wrapLines(cue, 16, 2, 0, { before: none, after: { ...none, '"': 1 } }))
      .toEqual(["今天下午他终于对我说", '"我今天真的很累很累，想']);
    // A cue that starts inside a quotation: its first quote closes it, the next one opens.
    const inner = '我们明天一起去北京"然后他说"好的我们走吧';
    const q = { before: { ...none, '"': 1 }, after: { ...none, '"': 1 } };
    for (let cpl = 6; cpl <= 16; cpl++) {
      const lines = wrapLines(inner, cpl, 2, 0, q);
      expect(lines.some((l) => /^"然|说"$/.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
      expect(lines.join("")).toBe(inner);
    }
  });
  it("two quotations glued back to back: the second one's opening quote rides with what it opens", () => {
    // `""` is one run: judged as one, the quote opening "再见朋友" joined the one closing "你好朋友".
    const t = '他说"你好朋友""再见朋友"然后走了';
    expect(wrapLines(t, 10, 2)).toEqual(['他说"你好朋友"', '"再见朋友"然后走了']);
    for (let cpl = 4; cpl <= 16; cpl++) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.some((l) => /""$/.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
      expect(lines.join("")).toBe(t);
    }
    expect(cutByShare(t, [8, 9])).toEqual(['他说"你好朋友"', '"再见朋友"然后走了']);
    for (let k = 1; k < 20; k++) expect(cutByShare(t, [k, 20 - k]).some((p) => /""$/.test(p))).toBe(false);
    // A closing quote with nothing after it to open still stays with what it closes.
    expect(wrapLines('我们明天去北京"看看""', 6, 2).some((l) => /^"/.test(l))).toBe(false);
    // The two quotations may be of different kinds: the closer still stays, the opener rides.
    for (const m of [`他说'你好朋友'"再见朋友"然后走了`, `他说"你好朋友"'再见朋友'然后走了`, `他说'你好'"OK"然后走了很远很远`,
      `他说'你好朋友'"Hello"然后走了`, `他说"你好朋友"'OK朋友'然后走了`, `他说'你好朋友''M'然后走了很远`, `他说"你好朋友"'S'然后走了很远`,
      `他说"你好朋友"'T恤'然后走了很远`, `他说"你好朋友"'M号'然后走了很远`, `他说"你好朋友"'M1'然后走了很远`]) {
      for (let cpl = 4; cpl <= 16; cpl++) {
        const lines = wrapLines(m, cpl, 2);
        expect(lines.some((l) => /['"]{2}$/.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
        expect(lines.join("")).toBe(m);
      }
      for (let k = 1; k < 20; k++) expect(cutByShare(m, [k, 20 - k]).some((p) => /['"]{2}$/.test(p))).toBe(false);
    }
    expect(wrapLines(`他说'你好朋友'"再见朋友"然后走了`, 10, 2)).toEqual([`他说'你好朋友'`, `"再见朋友"然后走了`]);
    // A quoted word that only starts like an English clitic (T恤, M号) is a quotation too.
    expect(wrapLines(`他说"你好朋友"'T恤'然后走了很远`, 10, 3)).toEqual([`他说"你好朋友"`, `'T恤'然后走了很远`]);
    // A possessive after a closing quote is no second quotation: the 's stays with what it follows.
    for (const m of [`我们看"东京"'s 夜景和"大阪"'s 美食吧`, `用"東京"'s 地图 and "大阪"'s 地图看看`,
      `用'東京''s 地图 and '大阪''s 地图看看`, `我们看'东京''s 夜景和'大阪''s 美食吧`]) {
      for (let cpl = 4; cpl <= 16; cpl++) {
        for (let n = 1; n <= 3; n++) {
          const lines = wrapLines(m, cpl, n);
          expect(lines.some((l) => /^'s/.test(l)), `@${cpl}x${n}: ${lines.join(" | ")}`).toBe(false);
          expect(lines.join("").replace(/\s/g, "")).toBe(m.replace(/\s/g, "")); // a wrap eats its space
        }
      }
      for (let k = 1; k < 20; k++) expect(cutByShare(m, [k, 20 - k]).some((p) => /^'s/.test(p))).toBe(false);
    }
  });
  it("a closing quote glued to the next quotation's typographic opener: the opener rides with what it opens", () => {
    // ”“ (or "“, »«, ’‘) was one glued match judged as one: it joined the text before it, and a
    // line or part ended on the next quotation's opening mark.
    const endsOnOpener = (l: string) => /[“‘«]$/.test(l) || /[\p{Pe}\p{Pf}"']["']$/u.test(l);
    for (const m of ["他说：“你好。”“我很好。”然后他们走了回家吧", "坚持“四个全面”“五位一体”的总体布局", "他说“Hello”“再见”然后回家吃饭了",
      '他说"Hello""再见朋友"然后走了很远', '他说“你好朋友”"再见朋友"然后走了', '他说"你好朋友"“再见朋友”然后走了', "他说«东京»«你好»的然后走了",
      "他说‘东京’‘你好’的然后走了"]) {
      for (let cpl = 4; cpl <= 16; cpl++) {
        const lines = wrapLines(m, cpl, 2);
        expect(lines.slice(0, -1).some(endsOnOpener), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
        expect(lines.join("")).toBe(m);
      }
      for (let k = 1; k < 20; k++) {
        const parts = cutByShare(m, [k, 20 - k]);
        expect(parts.slice(0, -1).some(endsOnOpener), `[${k}]: ${parts.join(" | ")}`).toBe(false);
        expect(parts.join("")).toBe(m);
      }
    }
    expect(cutByShare("他说：“你好。”“我很好。”然后我们一起回家了", [1, 2])[0]).toBe("他说：“你好。”");
    // A quoted brand name is no longer torn to keep the opener off the line end.
    expect(wrapLines("我们看到了“Microsoft”“Google”两个牌子", 16, 2)).toEqual(["我们看到了“Microsoft”", "“Google”两个牌子"]);
    // A German or Scandinavian closer is no opener of the next quotation: those stay as they were.
    expect(wrapLines("„Hallo“東京です", 8, 2)).toEqual(["„Hallo“", "東京です"]);
    expect(wrapLines("”Ja””Nej”東京", 6, 2)).toEqual(["”Ja””", "Nej”東京"]);
    expect(wrapLines("»Ja«»Nej«東京", 10, 2)).toEqual(["»Ja«»Nej«", "東京"]);
  });
  it("a cue right after an inch mark counts its quotes as its segment does", () => {
    // The cue starts on the " after the 6 of the cue before: an inch mark in the segment, but
    // counted alone the cue took it for a quote and the opening one of "很好" ended a line.
    const ws = ["屏幕有6", '"大的手机', "他说", '"很好"', "然后", "走了"];
    const text = ws.join("");
    let t = 0;
    const words = ws.map((w, i) => {
      const word = { word: w, start: t, end: t + 0.12 * w.length };
      t = word.end + (i === 0 ? 1 : 0);
      return word;
    });
    const r: BatchResult = { text, language: "zh", words, segments: [{ start: 0, end: t, text }] };
    const L = { cpl: 8, lines: 3, maxDur: 2, cps: 17 };
    const { cues } = buildCues(r, { length: "custom", custom: L, timing: "same" }, ["orig"]);
    expect(cues.map((c) => c.text)).toEqual(["屏幕有6", '"大的手机他说"很好"然后走了']);
    const lines = wrapLines(cues[1].text, L.cpl, L.lines, 0, cues[1].q);
    expect(lines.some((l) => /说"$/.test(l)), lines.join(" | ")).toBe(false);
    expect(lines).toEqual(['"大的手机他说', '"很好"然后走了']);
  });
  it("an over-long word of spaced text wraps per character, sharing a line with its neighbour", () => {
    const w = "x".repeat(50);
    expect(wrapLines(`a ${w}`, 42, 2)).toEqual(["a " + "x".repeat(24), "x".repeat(26)]);
  });
  it("a URL or compound longer than a line in spaced Latin text keeps the cue on two lines", () => {
    for (const t of [
      "Visit https://example.com/a/very/long/path/to/some/resource/index.html today please",
      "Der Donaudampfschiffahrtsgesellschaftskapitänsmützenhalter kam heute",
    ]) {
      const lines = wrapLines(t, 42, 2);
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
      expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
    }
    for (let cpl = 12; cpl <= 15; cpl++) {
      const lines = wrapLines("ok Donaudampfschifffahrts.gesellschaftskapitän!!!", cpl, 2);
      expect(lines.some((l) => /^[.!]/.test(l))).toBe(false);
    }
  });
  it("a hyphenated compound longer than a line wraps after a hyphen, never opening a line with it", () => {
    // A line opened with "-" reads as the dialogue dash of a change of speaker.
    for (let cpl = 28; cpl <= 42; cpl++) {
      expect(wrapLines("Die Donaudampfschifffahrts-Gesellschaftskapitän heute", cpl, 2), String(cpl))
        .toEqual(["Die Donaudampfschifffahrts-", "Gesellschaftskapitän heute"]);
    }
    expect(wrapLines("Die neue state-of-the-art-machine-learning-infrastructure heute", 28, 2))
      .toEqual(["Die neue state-of-", "the-art-machine-learning-", "infrastructure heute"]);
    expect(wrapLines("Wir sprechen über die state-of-the-art-machine-learning-infrastructure heute", 42, 2))
      .toEqual(["Wir sprechen über die state-of-the-", "art-machine-learning-infrastructure heute"]);
    const compounds = ["Bundesverfassungsgerichts-Entscheidung", "Arbeitnehmer-Entsendegesetz-Novelle", "Rindfleischetikettierungs-Überwachungsaufgaben"];
    for (const c of compounds) {
      for (const pre of ["Die", "Wir sprechen über die", "Gestern kam die neue"]) {
        for (let cpl = 28; cpl <= 42; cpl++) {
          const lines = wrapLines(`${pre} ${c} heute`, cpl, 2);
          expect(lines.some((l) => l.startsWith("-")), lines.join(" | ")).toBe(false);
        }
      }
    }
  });
  it("a compound's hyphen never leaves a stub alone on a line nor costs one", () => {
    const lines = wrapLines("Die Donaudampfschifffahrtsgesellschafts-Kapitänsmütze liegt", 20, 2);
    expect(lines.some((l) => l.length <= 3), lines.join(" | ")).toBe(false);
    expect(lines).toHaveLength(3);
    // As many lines as the hyphen as a unit of its own takes (opening a line with it) at most.
    const most: Record<string, [number, number]> = {
      "Covid-19-Pandemiebekämpfungsmaßnahmen wurden heute gelockert": [17, 4],
      "Die neue state-of-the-art-machine-learning-infrastructure heute": [21, 3],
    };
    for (const [t, [cpl, n]] of Object.entries(most)) {
      const l = wrapLines(t, cpl, 2);
      expect(l.length, l.join(" | ")).toBeLessThanOrEqual(n);
      expect(l.some((x) => x.length <= 3 && /-$/.test(x)), l.join(" | ")).toBe(false);
    }
  });
  it("an over-long word of spaced text never takes more lines than kept whole on lines of its own", () => {
    const mail = "a".repeat(20) + "@" + "b".repeat(15) + ".com";
    for (const [t, cpl, most] of [
      ["wonderful https://example.com/a/very/long/path/to/resource.html", 14, 5],
      [`${mail} ${mail}`, 20, 4],
    ] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.length).toBeLessThanOrEqual(most);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(cpl);
      expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
    }
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
  it("a CJK run beside a spaced Latin word wraps inside the run, not onto lines of its own", () => {
    for (const t of ["今日はとても良い天気ですね私たち AI", "AI 今日はとても良い天気ですね私たち"]) {
      const lines = wrapLines(t, 13, 2);
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(13);
      // Rejoined at the original seams: the only space is the one before/after "AI".
      expect(lines.join(t.indexOf(" ") === lines[0].length ? " " : "")).toBe(t);
    }
    const kana = "AI " + "あ".repeat(45);
    const lines = wrapLines(kana, 42, 2);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe(kana);
    // ASCII punctuation glued to a CJK character stays with it (slid across every cut).
    for (let n = 0; n < 20; n++) {
      const t = "AI " + "あ".repeat(n) + "(東京)." + "い".repeat(20 - n);
      const lines = wrapLines(t, 13, 2);
      expect(lines.join("")).toBe(t);
      expect(lines.some((l) => /^[.)]|\($/.test(l))).toBe(false);
    }
  });
  it("wraps a token longer than a line (a Latin word, URL, e-mail, compound) per unit", () => {
    const fits = (t: string, cpl: number, n: number, lines = wrapLines(t, cpl, 2)) => {
      expect(lines).toHaveLength(n);
      expect(lines.every((l) => l.length > 0 && l.length <= cpl)).toBe(true);
      expect(lines.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
    };
    // Kept whole, the word took lines of its own: four lines under a two-line cap.
    expect(wrapLines("明日はMicrosoftTeamsAccountで会議をします", 16, 2)).toEqual(["明日はMicrosoftTea", "msAccountで会議をします"]);
    fits("请发邮件到someone.name@example.com联系我们", 16, 3);
    // A lone word or run with nothing to break at came back as one line over the cap.
    fits("Donaudampfschifffahrtsgesellschaftskapitän", 28, 2);
    fits("あ" + "・".repeat(28), 13, 3);
    fits("え" + "？".repeat(18), 13, 2);
    // Halfwidth kana and 〜 are characters of their own, as CJK_UNIT has them; a fullwidth
    // letter/digit run is one word, wrapped per character only when longer than a line.
    fits("ＩＢＭ".repeat(4), 6, 2);
    expect(wrapLines("今年は２０２６年です", 6, 2)).toEqual(["今年は", "２０２６", "年です"]); // as "2026" wraps
    expect(wrapLines("今年の売上は１２３，４５６円でした", 13, 2).join("|")).not.toMatch(/[０-９，]\|[０-９，]/);
    expect(wrapLines("新しいｺﾝﾋﾟｭｰﾀｰを買いました", 9, 2).some((l) => l.startsWith("ｰ"))).toBe(false);
    expect(wrapLines("我们需要ＣＰＵ，ＧＰＵ，ＲＡＭ和ＳＳＤ", 6, 2).join("|")).not.toMatch(/[Ａ-Ｚ]\|[Ａ-Ｚ]/);
    expect(wrapLines("ＡＢ\u0301ＣＤＥＦ", 2, 2).some((l) => /^\p{M}/u.test(l))).toBe(false);
    fits("ﾃｷｽﾄ".repeat(4), 6, 3);
    fits("〜".repeat(12), 6, 2);
    // A halfwidth voicing mark rides with its kana, before a following ｰ.
    for (const [t, cpls] of [["ﾃﾞｰﾀを見る", [2, 3, 4]], ["ｹﾞｰﾑをする", [2, 3]], ["ｽﾋﾟｰﾄﾞ", [2]], ["新しいﾃﾞｰﾀﾍﾞｰｽを作りました", [9]]] as const) {
      for (const cpl of cpls) {
        const lines = wrapLines(t, cpl, 2);
        expect(lines.some((l) => /^[ｰﾞﾟ]/.test(l))).toBe(false);
        expect(lines.join("")).toBe(t);
      }
    }
    expect(wrapLines("ｶﾞ。", 4, 2, 3)).toEqual(["ｶﾞ。"]);
    // A quote that ends the token closes it; an opener rides with what it opens.
    expect(wrapLines("„Hallo“", 4, 2)).toEqual(["„Ha", "llo“"]);
    // So does one followed by a comma or stop: “ was glued onto the "," and opened a line.
    const quoted = "Please look at „Rechtsschutzversicherungsgesellschaften“, before the meeting starts";
    const q28 = wrapLines(quoted, 28, 2);
    expect(q28.some((l) => l.startsWith("“"))).toBe(false);
    expect(q28.some((l) => l.endsWith("n“,"))).toBe(true);
    expect(wrapLines("Go to „Rechtsschutzversicherungsgesellschaften“,, then click.", 14, 2, 6)
      .some((l) => /^[\p{P}]+$/u.test(l))).toBe(false);
    // Even after three stops on the last letter, which cap what else rides along.
    for (const stops of ["...", "!?!"]) {
      const s = `Please look at „Rechtsschutzversicherungsgesellschaften${stops}“, before the meeting starts`;
      for (const cpl of [13, 14, 28, 30, 31, 42]) {
        const lines = wrapLines(s, cpl, 2);
        expect(lines.some((l) => l.startsWith("“")), `${stops} @${cpl}: ${lines.join(" | ")}`).toBe(false);
        expect(lines.join(" ").replace(/ /g, "")).toBe(s.replace(/ /g, ""));
      }
    }
    expect(wrapLines("東京で「Microsoft(Teams)」を使いました。", 10, 2).some((l) => /^[)」“]|[(「„]$/.test(l))).toBe(false);
    // A “ glued to a letter closes mid-token too: „…“-Verband opened a line with “.
    const verband = "Laut „Rechtsschutzversicherungsgesellschaften“-Verband Laut dem neuen";
    const v28 = wrapLines(verband, 28, 3);
    expect(v28.some((l) => l.startsWith("“")), v28.join(" | ")).toBe(false);
    expect(v28.join(" ").replace(/ /g, "")).toBe(verband.replace(/ /g, ""));
    // A closing ” » ) or ' rides past the three-stop cap as „…...“ does.
    for (const [t, cpl] of [
      ["He said “Supercalifragilisticexpialidocious...” and left", 10],
      ["Il a dit «anticonstitutionnellementxyzabc...» et partit", 11],
      ["(Donaudampfschifffahrts...) und “word”", 14],
      ["He said 'Supercalifragilisticexpialidocious...' and left", 10],
    ] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.slice(1).some((l) => /^(?:[”»)]|'(?!\p{L}))/u.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
      expect(lines.join("").replace(/ /g, "")).toBe(t.replace(/ /g, ""));
    }
    // So does the comma or stop after that closer: the stop cap counts only stops, not the
    // closer that rode (a "," after "…...\"" or "?\")" started the next line).
    for (const [t, cpl] of [
      ['She said "Supercalifragilisticexpialidocious...", and left', 10],
      ['She said "Supercalifragilisticexpialidocious...", and left', 14],
      ["He said “Supercalifragilisticexpialidocious...”, and left", 10],
      ['Er sagte ("Bundesverfassungsgericht?"), und ging', 10],
      ["He said (“Supercalifragilistic...”), then left", 13],
    ] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.some((l) => /^[.,]/.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
      expect(lines.join("").replace(/ /g, "")).toBe(t.replace(/ /g, ""));
    }
    // A » or ” before the word opens it (German »…«, Swedish ”…”): no line ends on a bare one,
    // and the closing « or ” still closes.
    for (const [t, cpl] of [
      ["Er sagte »Donaudampfschifffahrtsgesellschaft« und ging", 10],
      ["Er sagte »Donaudampfschifffahrtsgesellschaft« und ging", 12],
      ["Han sa ”Donaudampfschifffahrtsgesellschaft” och gick", 10],
    ] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.some((l) => /(?:^|\s)[»”]$/u.test(l) || /^[«”](?!\p{L})/u.test(l)), `@${cpl}: ${lines.join(" | ")}`).toBe(false);
      expect(lines.join("").replace(/ /g, "")).toBe(t.replace(/ /g, ""));
    }
    // An ASCII quote opening an over-long word opens it: no line ends on a bare " or '.
    for (const q of ["\"", "'"]) {
      expect(wrapLines(`He said ${q}Supercalifragilisticexpialidocious${q} and left`, 10, 2)[0]).toBe("He said");
    }
    // A hallucinated run of quotes or closers still wraps three to a piece, as before.
    for (const [t, cpl, n] of [[`He said ${'"'.repeat(40)} ok`, 28, 2], [`He said ${")".repeat(40)} ok`, 28, 2], [`東京${"」".repeat(30)}`, 13, 3], [`他说${"”".repeat(30)}`, 13, 3]] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.length, lines.join(" | ")).toBe(n);
      expect(lines.join("").replace(/ /g, "")).toBe(t.replace(/ /g, ""));
    }
    expect(wrapLines(`東京${"」".repeat(30)}`, 13, 2)[0].startsWith("東京")).toBe(true);
    // …and so does a wall of opening brackets before a character: at most three ride along.
    for (const [t, cpl] of [[`東京${"「".repeat(30)}です`, 13], [`東京は${"（".repeat(30)}本当`, 13]] as const) {
      const lines = wrapLines(t, cpl, 2);
      expect(lines.every((l) => l.length <= cpl), lines.join(" | ")).toBe(true);
      expect(lines.join("")).toBe(t);
      expect(lines[0]).toMatch(/^東京/);
    }
    expect(wrapLines(`他说${"”".repeat(30)}`, 13, 2)[0].startsWith("他说")).toBe(true);
    const run = `He said ${'"'.repeat(40)}word ok`;
    const runLines = wrapLines(run, 28, 2);
    expect(runLines.length, runLines.join(" | ")).toBe(3);
    expect(runLines.some((l) => /\p{L}"|"$/u.test(l) && /w$/.test(l))).toBe(false);
    expect(runLines.join("").replace(/ /g, "")).toBe(run.replace(/ /g, ""));
    // A short run of quotes before a word still opens it: no line ends on bare quotes.
    expect(wrapLines('He said """"wordwordwordwordword ok', 12, 2)[1].startsWith('""""w')).toBe(true);
    expect(wrapLines('He said """(wordwordwordwordword ok', 8, 2).some((l) => /"$/.test(l))).toBe(false);
    // In CJK text “ after a character still opens (他说“再见”).
    expect(wrapLines("他说：“你好？”“我很好。”他说“再见”", 6, 3)).toEqual(["他说：“你", "好？”“我", "很好。”他", "说“再见”"]);
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

describe("Thai/Lao syllables and Burmese/Khmer stacks stay whole", () => {
  const LEAD = /[\u0e40-\u0e44]$/u;
  const TRAIL = /^[\u0e30\u0e32\u0e33]/u;
  it("cutByShare never strands a leading vowel or orphans a following one", () => {
    for (let k = 1; k < 20; k++) {
      const [a, b] = cutByShare(THAI, [k, 20 - k]);
      expect(a + b).toBe(THAI);
      expect(a).not.toMatch(LEAD);
      expect(b).not.toMatch(TRAIL);
    }
  });
  it("cutByShare never cuts right after a stacking virama", () => {
    const my = "ကမ္ဘာကမ္ဘာကမ္ဘာ";
    for (let k = 1; k < 10; k++) {
      const p = cutByShare(my, [k, 10 - k]);
      expect(p.join("")).toBe(my);
      expect(p[0].endsWith("\u1039")).toBe(false);
    }
  });
  it("a killed Burmese/Khmer consonant (asat, bantoc) stays with the syllable before it", () => {
    const KILLED_START = /^[က-အ]့?်|^[ក-អ]់/u;
    const my = "ကျွန်တော်တို့မနက်ဖြန်ရန်ကုန်မြို့ကိုသွားမယ်။ အဲဒီမှာသူငယ်ချင်းတွေနဲ့တွေ့ပြီးထမင်းစားမယ်။";
    const myUn = "ကျွန်တော်အိမ်ပြန်သွားတယ်။ပြီးတော့ထမင်းစားတယ်။";
    const km = "ខ្ញុំទៅផ្ទះ។បន្ទាប់មកខ្ញុំញ៉ាំបាយ។";
    const lines = wrapLines(my, 28, 2, 0, undefined, "my");
    expect(lines.join("").replace(/\s/g, "")).toBe(my.replace(/\s/g, ""));
    expect(lines.some((l) => l.includes("ရန်ကုန်"))).toBe(true);
    for (const t of [my, myUn, km]) {
      for (let cpl = 6; cpl <= 30; cpl++) {
        const w = wrapLines(t, cpl, 2);
        expect(w.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
        expect(w.filter((l) => KILLED_START.test(l))).toEqual([]);
      }
      for (const s of [[1, 1], [1, 2], [2, 1], [1, 1, 1], [1, 1, 1, 1]]) {
        const p = cutByShare(t, s);
        expect(p.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
        expect(p.filter((x) => KILLED_START.test(x))).toEqual([]);
      }
    }
    expect(cutByShare(km, [1, 1], "km")[1].startsWith("ប់")).toBe(false);
  });
  it("the repetition marks ๆ ໆ ៗ and the abbreviation mark ฯ stay with the word before them", () => {
    const REP_START = /^[ฯๆໆៗ]/u;
    expect(cutByShare("ค่อยๆเดิน", [1, 1], "th")).toEqual(["ค่อยๆ", "เดิน"]);
    expect(cutByShare("ទៅៗមក", [1, 1], "km")).toEqual(["ទៅៗ", "មក"]);
    expect(wrapLines("เด็กๆชอบเล่นกันมากๆเลยนะครับวันนี้", 5, 2)).not.toContainEqual(expect.stringMatching(REP_START));
    expect(wrapLines("ເດັກໆມັກຫຼິ້ນກັນຫຼາຍໆເລີຍ", 6, 2)).not.toContainEqual(expect.stringMatching(REP_START));
    // Standard Thai spacing: ๆ written with a space on both sides.
    const spaced = "วันนี้เราไปเที่ยวทะเลกันบ่อย ๆ แล้วก็กินอาหารทะเลอร่อย ๆ ที่กรุงเทพฯ ด้วยกันเสมอ ๆ นะครับเพื่อน ๆ ทุกคน";
    for (let cpl = 28; cpl <= 42; cpl++) {
      const lines = wrapLines(spaced, cpl, 2);
      expect(lines.join("").replace(/\s/g, "")).toBe(spaced.replace(/\s/g, ""));
      expect(lines.filter((l) => REP_START.test(l)), lines.join(" | ")).toEqual([]);
    }
    expect(wrapLines(spaced, 32, 2)).toEqual([
      "วันนี้เราไปเที่ยวทะเลกันบ่อย ๆ", "แล้วก็กินอาหารทะเลอร่อย ๆ", "ที่กรุงเทพฯ ด้วยกันเสมอ ๆ", "นะครับเพื่อน ๆ ทุกคน",
    ]);
    const glued = spaced.replace(/ ([ๆฯ])/g, "$1");
    const bkk = "กรุงเทพฯเป็นเมืองหลวงของประเทศไทยที่มีคนอาศัยอยู่มาก";
    for (const t of [THAI, glued, bkk]) {
      for (let k = 1; k < 20; k++) for (const s of [[k, 20 - k], [k, 10, 20 - k]]) {
        const p = cutByShare(t, s, "th");
        expect(p.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
        expect(p.filter((x) => REP_START.test(x))).toEqual([]);
      }
      for (let cpl = 5; cpl <= 32; cpl++) expect(wrapLines(t, cpl, 2).filter((l) => REP_START.test(l))).toEqual([]);
    }
  });
  it("one repetition mark rides, a run of them wraps, and a ฯ after a space opens its word", () => {
    // A run longer than a line (emphasis, a repetition loop) wraps between its marks, as ー runs do.
    for (const t of ["มาก" + "ๆ".repeat(50), "ຂອບໃຈຫຼາຍ" + "ໆ".repeat(50), "ดีมาก" + "ๆ".repeat(24)]) {
      for (const cpl of [10, 13, 42]) {
        const lines = wrapLines(t, cpl, 2, 0, undefined, "th");
        expect(lines.join("")).toBe(t);
        expect(lines.filter((l) => l.length > cpl), lines.join(" | ")).toEqual([]);
      }
    }
    const parts = cutByShare("ดีมาก" + "ๆ".repeat(24), [1, 1, 1], "th");
    expect(parts.map((x) => x.length).every((n) => n >= 7 && n <= 13), parts.join(" | ")).toBe(true);
    // ฯลฯ ("etc.") is one word: no line ends on its first ฯ or starts with its ลฯ.
    for (let cpl = 6; cpl <= 20; cpl++) {
      const lines = wrapLines("สินค้า ฯลฯ ทั้งหมดอยู่ที่นี่", cpl, 2);
      expect(lines.filter((l) => /(?:^|\s)ฯ$/u.test(l) || l.startsWith("ลฯ")), lines.join(" | ")).toEqual([]);
    }
    expect(wrapLines("สินค้า ฯลฯ ทั้งหมดอยู่ที่นี่", 8, 2)[0]).toBe("สินค้า");
    // The title ฯพณฯ goes with the name after it.
    expect(cutByShare("ขอเชิญท่านผู้มีเกียรติ ฯพณฯ นายกรัฐมนตรี กล่าวเปิดงาน", [1, 1], "th")[1])
      .toMatch(/^ฯพณฯ นายกรัฐมนตรี/u);
    const ws = ["ขอเชิญ", "ท่าน", "ผู้มี", "เกียรติ", " ฯพณฯ", " นายก", "รัฐมนตรี", " กล่าว", "เปิด", "งาน"];
    let t = 0;
    const words = ws.map((word) => ({ word, start: t, end: (t += 0.4) }));
    const text = ws.join("");
    const r: BatchResult = { text, language: "th", words, segments: [{ start: 0, end: t, text }] };
    for (const cpl of [20, 24, 28, 32]) {
      const cues = buildCues(r, { length: "custom", custom: { cpl, lines: 1, maxDur: 3, cps: 17 }, timing: "same" }, ["orig"])
        .cues.map((c) => c.text);
      expect(cues.filter((c) => c.endsWith("ฯพณฯ")), cues.join(" | ")).toEqual([]);
    }
  });
  it("a cue split at Whisper's per-token words never starts on a mark, a following vowel or a killed consonant", () => {
    // faster-whisper times th/lo/my per decoded token: a "word" can be one code point.
    const BAD_START = /^(?:[\p{M}ะาำๅະາຳ]|[က-အ]့?်|[ក-អ]់)/u;
    const BAD_END = /[เ-ไເ-ໄ္្]$/u;
    const texts: [string, string][] = [
      ["my", "ကျွန်တော်တို့မနက်ဖြန်ရန်ကုန်မြို့ကိုသွားမယ်လို့ပြောခဲ့တယ်ရန်ကုန်မြို့ကိုသွားမယ်နော်"],
      ["th", THAI],
      ["th", "พรุ่งนี้เราจะไปกรุงเทพด้วยกันแล้วก็กินข้าวผัดอร่อยมากเพราะว่าอร่อยมากและถูกด้วยครับ"],
      ["km", "ខ្ញុំចង់ទៅលេងសមុទ្រជាមួយមិត្តភក្តិរបស់ខ្ញុំនៅថ្ងៃស្អែកដើម្បីលេងទឹកនិងញ៉ាំបាយ"],
      ["lo", "ມື້ນີ້ອາກາດດີຫຼາຍແລະຂ້ອຍຢາກໄປທ່ຽວທະເລກັບເພື່ອນໆທີ່ໜ້າຮັກທີ່ສຸດໃນໂລກນີ້"],
    ];
    const opts: CueOptions[] = [STD, { length: "short", timing: "same" }];
    for (const cpl of [20, 32, 42]) for (const lines of [1, 2]) for (const maxDur of [2, 3, 4]) {
      opts.push({ length: "custom", custom: { cpl, lines, maxDur, cps: 17 }, timing: "same" });
    }
    for (const [language, text] of texts) {
      let t = 0;
      const words = [...text].map((word) => ({ word, start: t, end: (t += 0.15) }));
      const r: BatchResult = { text, language, words, segments: [{ start: 0, end: t, text }] };
      for (const o of opts) {
        const cues = buildCues(r, o, ["orig"]).cues.map((c) => c.text);
        expect(cues.join("")).toBe(text);
        expect(cues.filter((c, k) => (k > 0 && BAD_START.test(c)) || (k < cues.length - 1 && BAD_END.test(c))), cues.join(" | "))
          .toEqual([]);
      }
    }
  });
  // Two Thai sentences joined by one space: spaced text, but each sentence is still one run.
  const THAI2 = THAI + " " + "พรุ่งนี้ฝนจะตกหนักมากดังนั้นเราควรอยู่บ้านและดูหนังด้วยกันทั้งวันเลยนะครับ";
  it("own timing: a spaced multi-sentence Thai translation splits inside its sentences", () => {
    const r = seg1(LONG, 10, 30, { segments: [{ start: 10, end: 30, text: " " + LONG, translations: { th: THAI2 } }] });
    const grid = buildCues(r, { ...STD, timing: "own" }, ["orig", "th"]);
    const L = limitsFor(STD, "th");
    expect(grid.own.th.length).toBeGreaterThan(2);
    expect(grid.own.th.every((c) => c.end - c.start <= L.maxDur)).toBe(true);
    expect(grid.own.th.every((c) => !LEAD.test(c.text) && !TRAIL.test(c.text) && !/^\p{M}/u.test(c.text))).toBe(true);
    expect(grid.own.th.map((c) => c.text).join("").replace(/\s/g, "")).toBe(THAI2.replace(/\s/g, ""));
  });
  it("cutByShare cuts a spaced Thai text inside its runs, leaving no part empty", () => {
    const parts = cutByShare(THAI2, [1, 1, 1, 1]);
    expect(parts).toHaveLength(4);
    expect(parts.every((p) => p.length > 0)).toBe(true);
    expect(parts.join("").replace(/\s/g, "")).toBe(THAI2.replace(/\s/g, ""));
    expect(parts.every((p, k) => (k === 3 || !LEAD.test(p)) && !TRAIL.test(p) && !/^\p{M}/u.test(p))).toBe(true);
  });
  it("cutByShare prefers a phrase space of a spaced Thai text over a syllable seam", () => {
    expect(cutByShare("ขอบคุณมากครับ วันนี้อากาศดี", [1, 1])).toEqual(["ขอบคุณมากครับ", "วันนี้อากาศดี"]);
    expect(cutByShare("สวัสดีครับ ยินดีที่ได้รู้จักคุณ", [1, 1])).toEqual(["สวัสดีครับ", "ยินดีที่ได้รู้จักคุณ"]);
  });
  it("own timing: a spaced Thai line breaks at its phrase spaces before any syllable seam", () => {
    const en = Array(18).fill("w").join(" ");
    const phrases = ["ขอบคุณมากครับสำหรับทุกอย่าง", "วันนี้อากาศดีมากเลยนะครับ", "เราไปเที่ยวทะเลกันดีไหม"];
    const r = seg1(en, 0, 9, { segments: [{ start: 0, end: 9, text: " " + en, translations: { th: phrases.join(" ") } }] });
    const grid = buildCues(r, { length: "short", timing: "own" }, ["orig", "th"]);
    expect(trackCues(grid, "th").map((c) => c.text)).toEqual(phrases);
  });
  it("wrapLines keeps a spaced Thai first line within the cap under a name prefix", () => {
    const thai38 = "ขอบคุณมากครับสำหรับทุกอย่างที่ทำให้เรา";
    expect(thai38).toHaveLength(38);
    const t = thai38 + " ครับผม";
    const lines = wrapLines(t, 42, 2, 6);
    expect(lines[0].length + 6).toBeLessThanOrEqual(42);
    expect(lines.join("")).toBe(t);
  });
  it("wrapLines breaks a spaced Thai line at its phrase space before a syllable seam", () => {
    // The space lies 10 chars off the balanced cut: still preferred to a syllable seam.
    const t = "ขอบคุณมากครับ วันนี้อากาศดีมากเลยนะครับเพื่อน AI";
    expect(wrapLines(t, 42, 2)).toEqual(["ขอบคุณมากครับ", "วันนี้อากาศดีมากเลยนะครับเพื่อน AI"]);
  });
  it("wrapLines keeps a short CJK word or a Thai phrase whole when a space fits both lines", () => {
    // Latin-dominant lines with a CJK name break at a word space, as before the run was split.
    expect(wrapLines("I went to Tokyo yesterday and saw 東京 tower which was very tall indeed ok", 42, 2)).toEqual([
      "I went to Tokyo yesterday and saw 東京 tower",
      "which was very tall indeed ok",
    ]);
    expect(wrapLines("We met the Tokyo team at 東京駅 yesterday and it was fine", 42, 2)).toEqual([
      "We met the Tokyo team",
      "at 東京駅 yesterday and it was fine",
    ]);
    // A CJK sentence is no word to keep whole: a Latin word or number at its edge does not
    // get a line of its own.
    expect(wrapLines("AI あいうえおかきくけこさしすせそたちつて", 20, 2)).toEqual(["AI あいうえおかきく", "けこさしすせそたちつて"]);
    expect(wrapLines("我今天在东京站见了朋友非常开心 2024 年", 16, 2)).toEqual(["我今天在东京站见了朋友", "非常开心 2024 年"]);
    // A phrase space far from the balanced cut still beats a cut inside a Thai syllable.
    const p38 = "ขอบคุณมากครับสำหรับทุกอย่างที่ทำให้เรา";
    expect(wrapLines(p38 + " ครับ", 42, 2)).toEqual([p38, "ครับ"]);
  });
  it("wrapLines breaks a CJK sentence at its phrase space when that fits both lines", () => {
    for (const cpl of [13, 16]) {
      expect(wrapLines("今日は東京に行った 楽しかったです", cpl, 2)).toEqual(["今日は東京に行った", "楽しかったです"]);
    }
    // A short Latin word or number beside the space still balances into its sentence.
    expect(wrapLines("今日は東京に行った Tokyo", 13, 2)).toEqual(["今日は東京に行", "った Tokyo"]);
    expect(wrapLines("昨日 2024 年の計画を立てました", 13, 2)).toEqual(["昨日 2024 年", "の計画を立てました"]);
  });
  it("wrapLines never ends a line on a leading vowel", () => {
    for (let cpl = 28; cpl <= 60; cpl++) {
      const lines = wrapLines(THAI + THAI, cpl, 2);
      expect(lines.join("")).toBe(THAI + THAI);
      expect(lines.some((l) => LEAD.test(l) || TRAIL.test(l))).toBe(false);
    }
  });
});

describe("buildCues keeps quotation marks with what they open and close", () => {
  /** Whisper-style words (no space before a CJK word; a quote glued to the word before it). */
  const resOf = (ws: string[], language: string, pauses: Record<number, number> = {}): BatchResult => {
    let t = 0;
    const words = ws.map((word, i) => {
      const w = { word, start: t, end: t + 0.3 };
      t = w.end + 0.05 + (pauses[i] ?? 0);
      return w;
    });
    const text = ws.join("");
    return { text, language, words, segments: [{ start: 0, end: t, text }] };
  };
  it("a quote Whisper glued to a closing bracket (」\") opens the next quotation: no cue ends on it", () => {
    const r = resOf(["他说", "今天", "天气", "「two", " words", '」"', '再见"', "然后", "我们", "一起", "走了", "很远", "很远", "的路"], "zh");
    for (const length of ["short", "standard"] as const) {
      const texts = buildCues(r, { length, timing: "same" }, ["orig"]).cues.map((c) => c.text);
      expect(texts.slice(0, -1).some((c) => /」"$/.test(c)), texts.join(" | ")).toBe(false);
      expect(texts.some((c) => /^」/.test(c)), texts.join(" | ")).toBe(false);
      expect(texts.join("")).toBe(r.text);
    }
  });
  it("a spaced guillemet or „ timed as a word of its own neither ends nor starts a cue", () => {
    const fr = resOf([" Alors", " il", " a", " crié", " «", " attention !", " »", " avant", " de", " partir", " vers", " la", " gare",
      " du", " nord", " ce", " soir"], "fr");
    const de = (p: number) => resOf([" Er", " sagte", " dann", " ganz", " leise", " „", "Hallo", " Welt“", " und", " ging", " nach",
      " Hause", " zurück"], "de", { [p]: 0.3 });
    for (const cpl of [32, 42]) for (const lines of [1, 2]) {
      for (const maxDur of [1.5, 2, 3]) {
        const texts = buildCues(fr, { length: "custom", custom: { cpl, lines, maxDur, cps: 17 }, timing: "same" }, ["orig"]).cues.map((c) => c.text);
        expect(texts.some((c, k) => (k > 0 && /^»/.test(c)) || (k < texts.length - 1 && /«$/.test(c))), texts.join(" | ")).toBe(false);
      }
      // Beside a pause on either side of it.
      for (const p of [4, 5]) {
        const texts = buildCues(de(p), { length: "custom", custom: { cpl, lines, maxDur: 3, cps: 17 }, timing: "same" }, ["orig"]).cues.map((c) => c.text);
        expect(texts.slice(0, -1).some((c) => /„$/.test(c)), texts.join(" | ")).toBe(false);
      }
    }
  });
  it("a quote Whisper glued after a colon or comma (说，\" 说：\" me:\") opens the next quotation: no cue ends on it", () => {
    const zh1 = ["我", "昨天", "在", "学校", "遇到", "了", "老师", "他", "对", "我", "说", '，"', "你", "明天", "一定", "要", "早点", "来", "上课", '"'];
    const zh2 = ["他", "说", '："', "今天", "天气", "很", "好", "我们", "一起", "去", "公园", "散步", "吧", '"'];
    const en = [" I", " met", " my", " teacher", " at", " school", " yesterday", " and", " she", " told", ' me:"', "Come", " early",
      " tomorrow", " to", ' class"'];
    for (const r of [resOf(zh1, "zh"), resOf(zh2, "zh"), resOf(en, "en")]) {
      for (const length of ["short", "standard"] as const) {
        const texts = buildCues(r, { length, timing: "same" }, ["orig"]).cues.map((c) => c.text);
        expect(texts.slice(0, -1).some((c) => /"$/.test(c)), texts.join(" | ")).toBe(false);
        expect(texts.join("").replace(/\s/g, "")).toBe(r.text.replace(/\s/g, ""));
      }
    }
    // Or to a Latin word or number (AI").
    const zh3 = ["我们", "公司", "最近", "推出", "了", 'AI"', "助手", '"', "功能", "大家", "都", "很", "喜欢", "然后", "我们", "一起", "走了"];
    for (const pauses of [{}, { 5: 0.8 }] as Record<number, number>[]) {
      const r = resOf(zh3, "zh", pauses);
      for (const length of ["short", "standard"] as const) {
        const texts = buildCues(r, { length, timing: "same" }, ["orig"]).cues.map((c) => c.text);
        expect(texts.some((c) => /AI"$/.test(c)), texts.join(" | ")).toBe(false);
        expect(texts.join("")).toBe(r.text);
      }
    }
    // Not one closing a quotation opened between two letters (RTX"Super"), which no count sees.
    const zh4 = ["我们", "的", "产品", "叫", 'RTX"Super"', "和", '"Ultra"', "两个", "版本", "然后", "我们", "一起", "走了", "很远", "的路"];
    const r4 = resOf(zh4, "zh", { 4: 0.8 }); // the pause right after RTX"Super" ends the cue there
    for (const length of ["short", "standard"] as const) {
      const texts = buildCues(r4, { length, timing: "same" }, ["orig"]).cues.map((c) => c.text);
      expect(texts[0], texts.join(" | ")).toBe('我们的产品叫RTX"Super"');
      expect(texts.join("")).toBe(r4.text);
    }
    // Nor in the cue a pause after RTX starts with "Super", wrapped with its quotes.
    const zh5 = ["我们", "的", "产品", "叫", "RTX", '"Super"', "和", '"Ultra"', "两个", "版本", "然后", "我们", "一起", "走了", "很远", "的路"];
    const cue = buildCues(resOf(zh5, "zh", { 4: 0.8 }), { length: "standard", timing: "same" }, ["orig"]).cues
      .find((c) => c.text.startsWith('"Super"'));
    expect(cue).toBeDefined();
    for (const cpl of [8, 10, 12, 13]) {
      const lines = wrapLines(cue!.text, cpl, 2, 0, cue!.q, "zh");
      expect(lines[0], lines.join(" | ")).toBe('"Super"');
    }
    // A quote closing a quotation after its comma stays with it.
    const close = resOf([" She", " said", ' "Come', ' here,"', " and", " then", " she", " left", " the", " room", " quickly", " without",
      " another", " word"], "en");
    const texts = buildCues(close, { length: "short", timing: "same" }, ["orig"]).cues.map((c) => c.text);
    expect(texts.some((c) => c.endsWith('here,"')), texts.join(" | ")).toBe(true);
  });
  it("an ASCII quote Whisper glued to the closing quote before it (\"你好\"\") opens the next quotation: no cue ends on it", () => {
    const head = ["我们", "的", "产品", "叫"];
    const tail = ["然后", "我们", "一起", "走了"];
    const long = [...tail, "很远", "很远", "的路", "大家", "都", "很", "开心", "地", "回到", "了", "家里", "休息", "了", "一下"];
    const cuesOf = (ws: string[], length: "short" | "standard", pauses: Record<number, number> = {}) =>
      buildCues(resOf(ws, "zh", pauses), { length, timing: "same" }, ["orig"]).cues.map((c) => c.text);
    // Glued into the quoted word ('"你好""') or timed as a word of its own ('""').
    for (const [ws, q] of [[[...head, '"你好""', "再见", '"'], 4], [[...head, '"你好', '""', "再见", '"'], 5]] as const) {
      expect(cuesOf([...ws, ...tail], "short").join(" | ")).toBe('我们的产品叫"你好" | "再见"然后我们一起走了');
      expect(cuesOf([...ws, ...tail], "short", { [q]: 0.8 }).join(" | ")).toBe('我们的产品叫"你好" | "再见"然后我们一起走了');
      expect(cuesOf([...ws, ...long], "standard", { [q]: 0.8 }).join(" | "))
        .toBe('我们的产品叫"你好" | "再见"然后我们一起走了很远很远的路 | 大家都很开心地回到了家里休息了一下');
    }
    // A Latin word quoted, a ' pair, or a " after a closing '.
    for (const [g, q] of [['"Hello""', '"'], ['"AI""', '"'], ["'你好''", "'"], ["'你好'\"", '"']]) {
      expect(cuesOf([...head, g, "再见", q, ...tail], "short", { 4: 0.8 }).join(" | "))
        .toBe(`我们的产品叫${g.slice(0, -1)} | ${g.slice(-1)}再见${q}然后我们一起走了`);
    }
    // Unchanged: a quote closing one opened between two letters (RTX"Super"), one glued to a Latin
    // word or number (AI", iPhone", Model"X"), and a lone " timed as a word of its own.
    for (const [ws, pauses, short, standard] of [
      [["我们", "的", "产品", "叫", 'RTX"Super"', "和", '"Ultra"', "两个", "版本", "然后", "我们", "一起", "走了", "很远", "的路"], { 4: 0.8 },
        '我们的产品叫RTX"Super" | 和"Ultra"两个版本 | 然后我们一起走了很远的路', '我们的产品叫RTX"Super" | 和"Ultra"两个版本然后我们一起走了很远的路'],
      [["我们", "公司", "最近", "推出", "了", 'AI"', "助手", '"', "功能", "大家", "都", "很", "喜欢", "然后", "我们", "一起", "走了"], {},
        '我们公司最近推出了AI"助手" | 功能大家都很喜欢然后我们一起走了', '我们公司最近推出了AI"助手"功能大家都很喜欢然后我们一起走了'],
      [["我们", "公司", "最近", "推出", "了", 'AI"', "助手", '"', "功能", "大家", "都", "很", "喜欢", "然后", "我们", "一起", "走了"], { 5: 0.8 },
        '我们公司最近推出了AI | "助手"功能大家都很 | 喜欢然后我们一起走了', '我们公司最近推出了AI"助手"功能大家都很喜欢然后我们一起走了'],
      [["私は", 'iPhone"', "新機能", '"', "が", "好き", "です", "そして", "毎日", "使って", "います"], { 1: 0.8 },
        '私はiPhone | "新機能"が好きです | そして毎日使っています', '私はiPhone"新機能"が好きですそして毎日使っています'],
      [["我们", "用", "的", "是", 'Model"X"', "和", 'Model"Y"', "两款", "车", "然后", "我们", "一起", "走了"], { 4: 0.8 },
        '我们用的是Model"X" | 和Model"Y"两款车 | 然后我们一起走了', '我们用的是Model"X" | 和Model"Y"两款车然后我们一起走了'],
      [["他", "说", "了", '"', "你好", "朋友", '"', "再见", "然后", "我们", "一起", "走了"], { 3: 0.8 },
        '他说了" | 你好朋友"再见然后我们一起走了', '他说了"你好朋友"再见然后我们一起走了'],
      [["他", "说", "了", '"你好"', '"', "再见", "朋友", '"', "然后", "我们", "一起", "走了"], { 4: 0.8 },
        '他说了"你好"" | 再见朋友"然后我们一起走了', '他说了"你好""再见朋友"然后我们一起走了'],
    ] as [string[], Record<number, number>, string, string][]) {
      expect(cuesOf(ws, "short", pauses).join(" | ")).toBe(short);
      expect(cuesOf(ws, "standard", pauses).join(" | ")).toBe(standard);
    }
  });
  it("a closing quote and an ASCII quote timed as one word start no cue, and the 's after them stays", () => {
    // Words on an even 0.35 s grid, as Whisper times them.
    const even = (ws: string[], language: string): BatchResult => {
      const text = ws.join("");
      const words = ws.map((word, k) => ({ word, start: k * 0.35, end: k * 0.35 + 0.3 }));
      return { text, language, words, segments: [{ start: 0, end: ws.length * 0.35, text }] };
    };
    const tail = ["と", "言", "っ", "て", "か", "ら", "遠", "く", "ま", "で", "歩", "い", "て", "行", "き", "ま", "し", "た"];
    for (const [o, c] of [["‘", "’'"], ["«", "»'"]]) {
      for (const r of [even(["彼", "は", "今", "日", "東", "京", o, "S", c, "s", ...tail], "ja"),
        even(["he", " said", " that", " 東", "京", o, "S", c, "s", " to", " them", " today", " and", " then", " left"], "en")]) {
        const texts = buildCues(r, { length: "short", timing: "same" }, ["orig"]).cues.map((x) => x.text);
        expect(texts.some((x, k) => k > 0 && /^[’»']/.test(x)), texts.join(" | ")).toBe(false);
        expect(texts.some((x, k) => k < texts.length - 1 && /'$/.test(x) && /^s/.test(texts[k + 1])), texts.join(" | ")).toBe(false);
      }
    }
  });
  it("a cue starting with a quote split off a glued word starts once that word ends; the cue before keeps its time", () => {
    const words = [
      { word: " We", start: 0, end: 0.45 }, { word: ' “Okay”"', start: 0.5, end: 1.7 },
      { word: "再", start: 2.2, end: 2.65 }, { word: "见", start: 2.7, end: 3.15 },
      { word: "你", start: 3.2, end: 3.65 }, { word: "好", start: 3.7, end: 4.15 }, { word: '"', start: 4.2, end: 4.65 },
    ];
    const text = words.map((w) => w.word).join("").trim();
    for (const language of ["en", "zh", "ja"]) {
      const r: BatchResult = { text, language, words, segments: [{ start: 0, end: 4.65, text }] };
      const cues = buildCues(r, { length: "short", timing: "same" }, ["orig"]).cues;
      const k = cues.findIndex((c) => c.text.startsWith('"'));
      expect(k, JSON.stringify(cues)).toBeGreaterThan(0);
      expect(cues[k].start, JSON.stringify(cues)).toBeGreaterThanOrEqual(1.7);
      expect(cues[k - 1].end, JSON.stringify(cues)).toBeGreaterThanOrEqual(1.7);
    }
  });
});

describe("joinLineBreaks", () => {
  it("joins two lines with one space, unspaced (CJK) text too", () => {
    expect(joinLineBreaks("你好\n世界。")).toBe("你好 世界。");
    expect(joinLineBreaks("東京は\n\n大阪より、")).toBe("東京は 大阪より、");
    expect(joinLineBreaks("今日は \n いい天気｡")).toBe("今日は いい天気｡");
    expect(joinLineBreaks("我们走吧\n他们在等我们")).toBe("我们走吧 他们在等我们");
    expect(joinLineBreaks("東京は\n\n大阪より")).toBe("東京は 大阪より");
    expect(joinLineBreaks("Hello\nworld")).toBe("Hello world");
    expect(joinLineBreaks("Hello \n world")).toBe("Hello world");
    expect(joinLineBreaks("東京\nTokyo")).toBe("東京 Tokyo");
    expect(joinLineBreaks("我喜欢\niPhone")).toBe("我喜欢 iPhone");
    expect(joinLineBreaks("no  break ")).toBe("no  break ");
  });
  it("with wraps, joins two unspaced characters with nothing and everything else with one space", () => {
    expect(joinLineBreaks("你好\n世界。", true)).toBe("你好世界。");
    expect(joinLineBreaks("東京は \n\n 大阪より、", true)).toBe("東京は大阪より、");
    expect(joinLineBreaks("東京\nTokyo", true)).toBe("東京 Tokyo");
    expect(joinLineBreaks("Hello\nworld", true)).toBe("Hello world");
  });
  it("with wraps, a number glued into CJK text joins its neighbour with nothing, either side", () => {
    // wrapLines wraps "2025年10月17日" at a CJK|digit seam, which holds no space.
    expect(joinLineBreaks("今日は2025年10月\n17日です。", true)).toBe("今日は2025年10月17日です。");
    expect(joinLineBreaks("価格は100\n円です。", true)).toBe("価格は100円です。");
    expect(joinLineBreaks("今日は2025年10月\n17日です。")).toBe("今日は2025年10月 17日です。");
    expect(joinLineBreaks("Hello 2025\n17 times", true)).toBe("Hello 2025 17 times");
  });
  it("with wraps, a number spaced on its far side (Whisper's spaced style) keeps its space at the seam", () => {
    expect(joinLineBreaks("我们一共有 25\n个人。然后，", true)).toBe("我们一共有 25 个人。然后，");
    expect(joinLineBreaks("我们一共有\n3 个人。然后，", true)).toBe("我们一共有 3 个人。然后，");
    expect(joinLineBreaks("我们今天讨论的是第 3\n季度的计划，", true)).toBe("我们今天讨论的是第 3 季度的计划，");
    // Glued on its far side, it still joins with nothing — also past a 4-digit run.
    expect(joinLineBreaks("我们讨论的是\n2025年的计划，", true)).toBe("我们讨论的是2025年的计划，");
    expect(joinLineBreaks("价格是1,000\n元。然后，", true)).toBe("价格是1,000元。然后，");
    // Our own wrap of a spaced-number line joins back to it.
    for (const [t, cpls] of [
      ["我们一共有 25 个人参加了今天的会议，大家都很开心。", [10, 12, 13]],
      ["这个会议室一共有 300 个座位，今天差不多都坐满了。", [16]],
      ["他们公司今年一共卖出了 2000 台机器，比去年多了很多。", [13, 14, 16]],
      ["我们今天一共有很多 365 个人然后，在湖边坐了很久很久。", [10, 12, 14, 16]],
      ["我们今天要讨论的是 2025 年的计划，还有一些别的事情。", [10, 12, 14, 16]],
    ] as const) {
      for (const cpl of cpls) {
        const j = wrapLines(t, cpl, 2).join("\n");
        expect(j).toContain("\n");
        expect(joinLineBreaks(j, cjkWraps(j))).toBe(t);
      }
    }
  });
  it("with wraps, a Latin word glued into CJK text joins like a glued number; a word on a line of its own keeps its spaces", () => {
    expect(joinLineBreaks("今日はMicrosoft\nの会議です。", true)).toBe("今日はMicrosoftの会議です。");
    expect(joinLineBreaks("今日の会議で\nGoogleとApple\nの話を", true)).toBe("今日の会議でGoogleとAppleの話を");
    expect(joinLineBreaks("我们今天用\nChatGPT写代码，", true)).toBe("我们今天用ChatGPT写代码，");
    // On a line of its own a word reads the same glued or in Whisper's spaced style: spaced wins.
    expect(joinLineBreaks("今年公司的总收入达到了\n1234567890\n元比去年增长了很多", true))
      .toBe("今年公司的总收入达到了 1234567890 元比去年增长了很多");
    expect(joinLineBreaks("我的电话号码是\n13812345678\n请打给我。", true)).toBe("我的电话号码是 13812345678 请打给我。");
    // Whisper's spaced style keeps its spaces; a word at the text's edge and Latin text too.
    expect(joinLineBreaks("我们今天讨论 AI\n的发展，", true)).toBe("我们今天讨论 AI 的发展，");
    expect(joinLineBreaks("今日の会議で\nGoogle と Apple の話", true)).toBe("今日の会議で Google と Apple の話");
    expect(joinLineBreaks("我们一共有 25\n个人。然后，", true)).toBe("我们一共有 25 个人。然后，");
    expect(joinLineBreaks("東京\nTokyo", true)).toBe("東京 Tokyo");
    expect(joinLineBreaks("Hello\nworld\n2025", true)).toBe("Hello world 2025");
    // Our own wrap of a Whisper-spaced word onto a line of its own joins back to it with its
    // spaces; the same wrap of a glued one cannot tell, and regains them.
    for (const [t, cpl] of [
      ["我们今天讨论的是 Kubernetes 集群的部署方案和监控。", 16],
      ["今年公司的总收入达到了 1234567890 元比去年增长了很多。", 16],
      ["我的电话号码是 13812345678 请打给我", 13],
    ] as const) {
      const j = wrapLines(t, cpl, 3).join("\n");
      expect(j.split("\n").length).toBeGreaterThan(2);
      expect(joinLineBreaks(j, true)).toBe(t);
      expect(wrapLines(t.replace(/ /g, ""), cpl, 3).join("\n")).toBe(j);
    }
  });
  it("cjkWraps: a quarter of the CJK lines carry 。，(or a ja 、) and no phrase space; ？！： alone, zh's enumeration 、 and phrase-spaced text do not wrap", () => {
    expect(cjkWraps("今日はとても\n良い天気ですね。")).toBe(true);
    expect(cjkWraps("我们今天去公园､\n散步然后")).toBe(true);
    expect(cjkWraps("我们今天去公园\n散步､然后")).toBe(false); // zh's enumeration mark, mid-line
    expect(cjkWraps("今日はいい天気ですね。明日も\n晴れるでしょうか？")).toBe(true); // 。 mid-line
    expect(cjkWraps("東京へ、大阪へ\nそして京都")).toBe(true); // ja's phrase comma
    expect(cjkWrapsLines(["我们走吧", "他们在等我们", "快点", "好的", "翻译：小明。"])).toBe(false); // one credit line
    expect(cjkWraps("我们走吧\n他们在等我们")).toBe(false);
    expect(cjkWraps("我不知道他去哪儿了\n你知道吗？")).toBe(false);
    expect(cjkWraps("张三：我们走吧！")).toBe(false);
    expect(cjkWraps("你好。 我们走吧。")).toBe(false);
    expect(cjkWraps("今日は　ありがとう。")).toBe(false);
    expect(cjkWraps("Hello, world.")).toBe(false);
  });
  it("cjkWrapsLines: one two-field credit does not flip an unpunctuated file, and a long mark run stays linear", () => {
    const lines = ["我们走吧", "他们在等我们", "快点", "别迟到了", "好的", "马上来", "你在哪里", "我在门口", "翻译：小明。字幕：小红"];
    expect(cjkWrapsLines(lines)).toBe(false);
    expect(cjkWrapsLines(["今日は晴れ。明日は雨", "そうですか", "はい"])).toBe(true);
    // A credit, note or title is no evidence, however short the file.
    expect(cjkWrapsLines(["我们走吧", "他们在等我们", "快点", "别迟到了", "好的", "马上来", "翻译：小明。字幕：小红"])).toBe(false);
    expect(cjkWrapsLines(["我们走吧", "他们在等我们", "快点", "别迟到了", "（注：这是一个地名。）就在南方"])).toBe(false);
    expect(cjkWrapsLines(["我在读", "《三体。黑暗森林》这本书", "很好看", "你也看吧"])).toBe(false);
    const long = "中" + "，".repeat(60_000);
    const t0 = performance.now();
    expect(cjkWrapsLines([long])).toBe(true); // one line, marked anywhere: the quarter holds
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it("cjkWraps: a colon opening a quotation is no credit field, so the quote's marks count", () => {
    expect(cjkWraps("他问：“你好，你今天要\n去哪里？”")).toBe(true);
    expect(cjkWrapsLines(["他问：“你好，你今天要", "去哪里？”"])).toBe(true);
    expect(cjkWraps("彼は言った：「今日は、とても\nいい天気だ」")).toBe(true);
    // The credit shapes stay no evidence.
    expect(cjkWrapsLines(["我们走吧", "他们在等我们", "快点", "好的", "翻译：小明。"])).toBe(false);
    // A quoted name closed before the mark is a credit's, not a quotation the mark sits in.
    expect(cjkWrapsLines(["字幕：「XX字幕组」。翻译：小红", "我们今天去公园", "然后回家吃饭"])).toBe(false);
    expect(cjkWrapsLines(["翻译：“小明”。字幕：小红", "我们今天去公园", "然后回家吃饭"])).toBe(false);
    // A long run of colons stays linear.
    const t0 = performance.now();
    expect(cjkWrapsLines(["：“".repeat(50_000) + "你好，世界"])).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it("cjkWrapsLines: a mark counts while any colon's quotation is still open, so a second speaker's or an outer quote counts", () => {
    // Seven unpunctuated lines plus one: the eighth line alone decides (one line in eight).
    const file = (l: string) => cjkWrapsLines(["我们今天去公园", "然后去吃饭", "天气很好", "我很开心", "明天再见", "大家都来了", "晚上回家", l]);
    // Two speakers, the first quote closed, the mark inside the second (false before this fix).
    expect(file("甲问：“好吗” 乙答：“好的，我来了”")).toBe(true);
    expect(file("甲问：「好吗」乙答：「好的，我来了」")).toBe(true);
    expect(file("乙答：“好的，我来了”")).toBe(true);
    expect(file("他问：“你好，你今天要去哪里”")).toBe(true);
    // An inner quote closed, the mark inside the outer one (false at 9ed9c273).
    expect(file("他说：“她说：‘好’，我们走吧”")).toBe(true);
    // A quoted credit name closed before the mark stays no evidence, also behind an earlier
    // credit (both counted before 9ed9c273, which let any colon opening a quote through).
    expect(file("字幕：「XX字幕组」。翻译：小红")).toBe(false);
    expect(file("字幕：「XX字幕组」翻译：「小红」。谢谢观看")).toBe(false);
    // A plain credit field stays no evidence.
    expect(file("翻译: 小明，字幕: 小红")).toBe(false);
  });
  it("with wraps, a seam on a curly quote is judged by the character past the quotes", () => {
    expect(joinLineBreaks("他说：\n“我们走吧。”", true)).toBe("他说：“我们走吧。”");
    expect(joinLineBreaks("他说：“我们走吧。”\n然后他就走了。", true)).toBe("他说：“我们走吧。”然后他就走了。");
    expect(joinLineBreaks("他说：\n“我们走吧。”")).toBe("他说： “我们走吧。”");
    expect(joinLineBreaks("他说：“我们走吧。”\n然后他就走了。")).toBe("他说：“我们走吧。” 然后他就走了。");
    // Latin inside the quotes keeps its space; a line of quotes only is no unspaced seam.
    expect(joinLineBreaks("he said “hi”\n然后", true)).toBe("he said “hi” 然后");
    expect(joinLineBreaks("然后\n“hi”", true)).toBe("然后 “hi”");
    expect(joinLineBreaks("你好，\n“”\n世界。", true)).toBe("你好， “” 世界。");
  });
  it("with wraps, a seam on an ASCII quote is judged by the character past the quotes too", () => {
    // " and ' are Po, not Pi/Pf: a seam on one used to keep a space between two CJK characters.
    expect(joinLineBreaks('他说："我们走吧。"\n然后他们一起走了回家', true)).toBe('他说："我们走吧。"然后他们一起走了回家');
    expect(joinLineBreaks('我看完了。\n"好的"他回答说', true)).toBe('我看完了。"好的"他回答说');
    expect(joinLineBreaks("他说：'我们走吧。'\n然后他们走了", true)).toBe("他说：'我们走吧。'然后他们走了");
    // Our own wrap of such a line joins back to it.
    const t = '他说："我们走吧。"然后他们一起走了回家';
    expect(joinLineBreaks(wrapLines(t, 12, 2).join("\n"), true)).toBe(t);
    // A Latin neighbour past the quote keeps its space; a line of quotes only is no unspaced seam.
    expect(joinLineBreaks('he said "hello"\n然后', true)).toBe('he said "hello" 然后');
    expect(joinLineBreaks("the dogs'\n然后", true)).toBe("the dogs' 然后");
    expect(joinLineBreaks('然后\n"hi"', true)).toBe('然后 "hi"');
    expect(joinLineBreaks('你好，\n""\n世界。', true)).toBe('你好， "" 世界。');
  });
  it("a long blank run before no line break stays fast", () => {
    const s = "x" + " ".repeat(60_000) + "y\nz";
    const t0 = performance.now();
    expect(joinLineBreaks(s)).toBe("x" + " ".repeat(60_000) + "y z");
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("edgeChar", () => {
  it("skips trailing combining marks and variation selectors at the end", () => {
    expect(edgeChar("か\u3099", true)).toBe("か");
    expect(edgeChar("葛\u{E0100}", true)).toBe("葛");
    expect(edgeChar("𠀋", true)).toBe("𠀋");
    expect(edgeChar("\u3099", true)).toBe("");
  });
  it("a long run of combining marks anywhere in the text is scanned once", () => {
    const s = "x" + "\u0e48".repeat(30_000) + " rest";
    const t0 = performance.now();
    expect(edgeChar(s, true)).toBe("t");
    expect(edgeChar("x" + "\u0e48".repeat(30_000), true)).toBe("x");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(edgeChar("が\u3099", true)).toBe("が");
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
  it("a stop inside a closing quote or bracket is a sentence end: the cut goes after the closer", () => {
    expect(cutByShare('He said, "Go home now." Then we all left the place quickly.', [1, 1]))
      .toEqual(['He said, "Go home now."', "Then we all left the place quickly."]);
    expect(cutByShare("他说：「我们走吧。」然后大家一起离开了这个地方好吗", [1, 1]))
      .toEqual(["他说：「我们走吧。」", "然后大家一起离开了这个地方好吗"]);
    // A Japanese quote the sentence goes on from (」と言った) is no sentence end.
    expect(cutByShare("彼は『行こう！』と言ったそれから皆で一緒に離れました", [1, 1])[0]).not.toMatch(/』$/);
  });
  it("judges a sentence or clause end by the original splitter's rules", () => {
    // No sentence ends after an abbreviation or a German ordinal: the real stop nearby wins.
    expect(cutByShare("Wir kaufen heute viel Obst z.B. Äpfel und Birnen. Dann gehen wir nach Hause.", [1, 1]))
      .toEqual(["Wir kaufen heute viel Obst z.B. Äpfel und Birnen.", "Dann gehen wir nach Hause."]);
    expect(cutByShare("Am 3. Mai kaufen wir Obst und Birnen. Dann gehen wir alle nach Hause zurück.", [1, 3])[0]).not.toBe("Am 3.");
    // Behind an opening bracket too: "(Dr." and "(3." end nothing, so the cut leaves them with what follows.
    expect(cutByShare("We finally went to visit our old friend (Dr. Martin Keller) at his home", [1, 1], "en"))
      .toEqual(["We finally went to visit our old", "friend (Dr. Martin Keller) at his home"]);
    for (const l of ["de", undefined]) {
      expect(cutByShare("Wir sehen uns am Dienstag (3. Mai) wieder im Büro und reden dann", [1, 1], l)[0]).not.toMatch(/\(3\.$/);
    }
  });
  it("ends a sentence on 'no.' unless a number follows, and on a number unless the language dots ordinals", () => {
    expect(cutByShare("I said no. But tomorrow we go to the beach with everyone", [1, 2], "en"))
      .toEqual(["I said no.", "But tomorrow we go to the beach with everyone"]);
    expect(cutByShare("Yo creo que no. Pero mañana vamos a la playa con todos", [1, 2], "es"))
      .toEqual(["Yo creo que no.", "Pero mañana vamos a la playa con todos"]);
    expect(cutByShare("He was 12. Then they moved to a new city far away", [1, 1], "en"))
      .toEqual(["He was 12.", "Then they moved to a new city far away"]);
    // "No. 5" / "Nr. 5" stay abbreviations, a German ordinal stays one (also with a region or no
    // language), and "z.B." still ends nothing.
    expect(cutByShare("Take no. 5 and then go home with all the others", [1, 4], "en")[0]).toBe("Take no. 5");
    expect(cutByShare("Wir nehmen Nr. 5 und gehen dann nach Hause", [1, 3], "de")[0]).toBe("Wir nehmen");
    const am3 = "Am 3. Mai kaufen wir Obst und Birnen. Dann gehen wir alle nach Hause zurück.";
    for (const l of ["de", "de-AT", undefined]) expect(cutByShare(am3, [1, 3], l)[0]).not.toBe("Am 3.");
    expect(cutByShare("Wir kaufen heute viel Obst z.B. Äpfel und Birnen. Dann gehen wir nach Hause.", [1, 1], "de"))
      .toEqual(["Wir kaufen heute viel Obst z.B. Äpfel und Birnen.", "Dann gehen wir nach Hause."]);
  });
  it("a title or number abbreviation and a dotted ordinal stay with the word after them in the cut and the wrap", () => {
    // Not only the "Mr." "Mrs." "Dr." of NOBREAK: every title and number abbreviation isSentenceEnd
    // holds no sentence end, and a German ordinal, dangle as they do.
    const ms = "Yesterday I met Ms. Johnson at the station";
    expect(cutByShare(ms, [19, 23], "en")).toEqual(["Yesterday I met", "Ms. Johnson at the station"]);
    expect(wrapLines(ms, 30, 2, 0, undefined, "en")).toEqual(["Yesterday I met", "Ms. Johnson at the station"]);
    const prof = "Gestern traf ich Prof. Johnson am Bahnhof dort";
    expect(cutByShare(prof, [5, 5], "de")).toEqual(["Gestern traf ich", "Prof. Johnson am Bahnhof dort"]);
    expect(wrapLines(prof, 30, 2, 0, undefined, "de")).toEqual(["Gestern traf ich", "Prof. Johnson am Bahnhof dort"]);
    const am3 = "Wir treffen uns am 3. Mai im Büro der Stadt";
    expect(cutByShare(am3, [5, 5], "de")).toEqual(["Wir treffen uns am 3. Mai", "im Büro der Stadt"]);
    expect(wrapLines(am3, 26, 2, 0, undefined, "de")).toEqual(["Wir treffen uns am 3. Mai", "im Büro der Stadt"]);
    expect(cutByShare("Wir nehmen die Nr. 5 ganz bestimmt mit uns", [4, 6], "de"))
      .toEqual(["Wir nehmen die Nr. 5", "ganz bestimmt mit uns"]);
    // Unchanged: "Mrs." and "Dr." as before, a real sentence end on "no." or an English "3.",
    // and "etc.", after which a piece may end.
    expect(cutByShare("Yesterday I met Mrs. Johnson at the station", [19, 23], "en"))
      .toEqual(["Yesterday I met", "Mrs. Johnson at the station"]);
    expect(cutByShare("Gestern traf ich Dr. Johnson am Bahnhof dort", [5, 5], "de"))
      .toEqual(["Gestern traf ich", "Dr. Johnson am Bahnhof dort"]);
    expect(wrapLines("Gestern traf ich Dr. Johnson am Bahnhof dort", 30, 2, 0, undefined, "de"))
      .toEqual(["Gestern traf ich", "Dr. Johnson am Bahnhof dort"]);
    const no = "I said no. Then we went home to sleep";
    expect(cutByShare(no, [1, 2], "en")).toEqual(["I said no.", "Then we went home to sleep"]);
    expect(wrapLines(no, 30, 2, 0, undefined, "en")).toEqual(["I said no.", "Then we went home to sleep"]);
    const kids = "The kids were 3. Then we moved away to Bern";
    expect(cutByShare(kids, [2, 3], "en")).toEqual(["The kids were 3.", "Then we moved away to Bern"]);
    expect(wrapLines(kids, 30, 2, 0, undefined, "en")).toEqual(["The kids were 3.", "Then we moved away to Bern"]);
    const etc = "We bought apples, pears etc. and then went home";
    expect(cutByShare(etc, [1, 1], "en")).toEqual(["We bought apples,", "pears etc. and then went home"]);
    expect(wrapLines(etc, 26, 2, 0, undefined, "en")).toEqual(["We bought apples, pears", "etc. and then went home"]);
    expect(cutByShare("We bought pears etc. Then we went home happy", [1, 1], "en"))
      .toEqual(["We bought pears etc.", "Then we went home happy"]);
  });
  it("a lowercase unit \"m.\" or \"ms.\" ends a sentence; only the titles \"M.\" and \"Ms.\" stay with the next word", () => {
    // Read as the titles, the units were held to the next word: "about 300" / "m. Then …".
    const m = "The tower is about 300 m. Then we walked back home";
    expect(cutByShare(m, [1, 1], "en")).toEqual(["The tower is about 300 m.", "Then we walked back home"]);
    expect(wrapLines(m, 30, 2)).toEqual(["The tower is about 300 m.", "Then we walked back home"]);
    const ms = "It took about 5 ms. Then it crashed again";
    expect(cutByShare(ms, [1, 1], "en")).toEqual(["It took about 5 ms.", "Then it crashed again"]);
    expect(wrapLines(ms, 30, 2, 0, undefined, "en")).toEqual(["It took about 5 ms.", "Then it crashed again"]);
    // The titles as before.
    expect(wrapLines("Yesterday I met Ms. Johnson at the station", 30, 2, 0, undefined, "en"))
      .toEqual(["Yesterday I met", "Ms. Johnson at the station"]);
    expect(wrapLines("Hier j'ai vu M. Dupont à la gare du nord", 30, 2, 0, undefined, "fr"))
      .toEqual(["Hier j'ai vu", "M. Dupont à la gare du nord"]);
  });
  it("a dotted initialism before a lowercase word ends no sentence: the cue split and the cut run on past it", () => {
    for (const t of [
      "Officials in the U.S. government said on Tuesday that the new rules would take effect next spring, according to reports",
      "We will meet tomorrow at 9 a.m. in the main office downstairs, and after that we will drive to the airport together",
    ]) {
      const cues = buildCues(seg1(t, 0, 12), STD, ["orig"]).cues.map((c) => c.text);
      expect(cues.some((c) => /(?:U\.S|a\.m)\.$/.test(c)), JSON.stringify(cues)).toBe(false);
    }
    expect(cutByShare("Officials in the U.S. government said on Tuesday that the new rules apply", [1, 1], "en")[0])
      .not.toMatch(/U\.S\.$/);
    // Before a capital it still ends one.
    expect(cutByShare("They moved to the U.S. The rest of the family stayed in Ireland for good", [1, 1], "en"))
      .toEqual(["They moved to the U.S.", "The rest of the family stayed in Ireland for good"]);
  });
  it("the cue split and the line wrap judge 'no.' and '12.' as the translation cut does", () => {
    const party = (x: string) => `When he asked me to come along to the party I said ${x} Then we went home and talked about the whole evening for hours`;
    const cuesOf = (r: BatchResult, tracks = ["orig"]) => buildCues(r, STD, tracks);
    // The original: a sentence ends on "no." and "12." as on "yes.", but not on "no. 5".
    for (const x of ["yes.", "no.", "12."]) {
      expect(cuesOf(seg1(party(x), 0, 9)).cues[0].text).toBe(`When he asked me to come along to the party I said ${x}`);
    }
    expect(cuesOf(seg1(party("no. 5"), 0, 9)).cues[0].text).not.toMatch(/no\.$/);
    // German keeps "12." an ordinal: no cue ends on "am 12.".
    const de = "Wir haben uns damals im Sommer getroffen und zwar am 12. Mai in einem kleinen Café am See";
    expect(cuesOf(seg1(de, 0, 9, { language: "de" })).cues.map((c) => c.text).some((t) => t.endsWith("12."))).toBe(false);
    // An own-timed English translation of a German original splits at its sentence end too.
    const orig = "Als der Krieg begann, war er gerade einmal zwölf Jahre alt. Dann zog die ganze Familie weit weg in eine neue Stadt.";
    const en = "When the war began he was barely 12. Then the whole family moved to a new city far away from home.";
    const r = seg1(orig, 0, 9, { language: "de", segments: [{ start: 0, end: 9, text: " " + orig, translations: { en } }] });
    expect(buildCues(r, { ...STD, timing: "own" }, ["orig", "en"]).own.en[0].text).toBe("When the war began he was barely 12.");
    // The line wrap prefers the seam after the sentence-final number or "no." in English.
    for (const x of ["12.", "no."]) {
      expect(wrapLines(`He was told ${x} Then they all moved to Bern in May`, 42, 2, 0, undefined, "en"))
        .toEqual([`He was told ${x}`, "Then they all moved to Bern in May"]);
    }
    // An unknown language, filed as "und" (trackLang), keeps "12." an ordinal as no language does.
    const twelve = "He was told 12. Then they all moved to Bern in May";
    expect(wrapLines(twelve, 42, 2, 0, undefined, "und")).toEqual(wrapLines(twelve, 42, 2));
    expect(wrapLines(twelve, 42, 2)).not.toEqual(wrapLines(twelve, 42, 2, 0, undefined, "en"));
  });
  it("a same-timed translation's cut knows its track's language", () => {
    const orig = "Ich habe ihr gestern ganz klar nein gesagt. Aber morgen fahren wir trotzdem alle zusammen an den Strand.";
    const en = "Yesterday I told her no. But tomorrow we all drive together to the beach and swim.";
    const r = seg1(orig, 0, 7.2, { language: "de", segments: [{ start: 0, end: 7.2, text: " " + orig, translations: { en } }] });
    expect(buildCues(r, STD, ["orig", "en"]).cues.map((c) => c.tr.en))
      .toEqual(["Yesterday I told her no.", "But tomorrow we all drive together to the beach and swim."]);
    // An ellipsis ends a sentence; a fullwidth colon and a dash end a clause.
    expect(cutByShare("Nun ja… dann gehen wir eben morgen wieder nach Hause zurück", [1, 2]))
      .toEqual(["Nun ja…", "dann gehen wir eben morgen wieder nach Hause zurück"]);
    expect(cutByShare("他说：「我们今天一起去公园散步吧」", [1, 3])).toEqual(["他说：", "「我们今天一起去公园散步吧」"]);
    expect(cutByShare("Er kam zu spät – und ging dann gleich wieder nach Hause", [1, 1]))
      .toEqual(["Er kam zu spät –", "und ging dann gleich wieder nach Hause"]);
  });
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
    // A 7-character run: a sentence, whose seams weigh like the space (a short word's do not).
    const pre = cutByShare("AI \u304c\u6b21\u306e\u6587を読む", [4, 6]);
    expect(pre).toEqual(["AI \u304c", "\u6b21\u306e\u6587を読む"]);
    // A decomposed "が" (か + U+3099) cuts like the precomposed one.
    expect(cutByShare("AI \u304b\u3099\u6b21\u306e\u6587を読む", [4, 6])).toEqual(["AI \u304b\u3099", "\u6b21\u306e\u6587を読む"]);
    // An Ext-B Han character (a surrogate pair) can be followed — and preceded — by a cut.
    const extB = cutByShare("AI \u{20B9F}\u6b21\u306e\u6587を読む", [4, 6]);
    expect(extB).toEqual(["AI \u{20B9F}", "\u6b21\u306e\u6587を読む"]);
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
  it("prefers a space over a seam inside a short CJK word of spaced text", () => {
    expect(cutByShare("Tomorrow we fly to 東京 and then we go home", [1, 1])).toEqual(["Tomorrow we fly to 東京", "and then we go home"]);
    expect(cutByShare("Tomorrow we fly to 東京 and then", [1, 1, 1])).toEqual(["Tomorrow we", "fly to 東京", "and then"]);
    expect(cutByShare("昨日 浅草 でご飯を食べました", [1, 3])).toEqual(["昨日 浅草", "でご飯を食べました"]);
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
  it("keeps a glued number, version, e-mail or URL whole in unspaced text, as wrapLines does", () => {
    for (const [text, tok] of [["円周率は3.14159です", "3.14159"], ["人口は1,234,567人です", "1,234,567"],
      ["バージョン2.0.1をリリース", "2.0.1"], ["メールはfoo@bar.comまで", "foo@bar.com"], ["見てhttps://example.com", "https://example.com"]]) {
      expect(wrapLines(text, Math.max(8, tok.length), 2)).toContain(tok);
      for (const shares of [[1, 1], [1, 1, 1], [1, 1, 1, 1, 1], [1, 9], [9, 1], [3, 1, 3, 1]]) {
        const parts = cutByShare(text, shares);
        expect(parts.join("")).toBe(text);
        expect(parts.some((p) => p.includes(tok))).toBe(true);
      }
    }
    expect(cutByShare("円周率は3.14159です", [1, 1, 1])).toEqual(["円周率は", "3.14159", "です"]);
  });
  it("leaves no part empty while the text has a seam for every cut", () => {
    expect(cutByShare("これはiPhoneProMax", [1, 1, 1])).toEqual(["これ", "は", "iPhoneProMax"]);
    expect(cutByShare("東京2026", [1, 1, 1])).toEqual(["東", "京", "2026"]);
    expect(cutByShare("電話番号は0123456789012345です", [1, 1, 1, 1, 1]).every(Boolean)).toBe(true);
    expect(cutByShare("  今日はiPhoneです  ", [1, 1, 8]).every(Boolean)).toBe(true);
    // Fewer seams than cuts: every seam is used, only the trailing parts stay empty.
    expect(cutByShare("これはiPhoneProMax", [1, 1, 1, 1, 1])).toEqual(["こ", "れ", "は", "iPhoneProMax", ""]);
    // Fullwidth and halfwidth forms are characters of their own, not one glued word.
    expect(cutByShare("ﾃｷｽﾄ", [1, 1, 1]).every(Boolean)).toBe(true);
    expect(cutByShare("東京ＡＢＣ", [1, 1, 1])).toEqual(["東", "京", "ＡＢＣ"]);
    expect(cutByShare("売上は１２３，４５６円", [1, 1, 1]).some((p) => /^[，４５６]/.test(p))).toBe(false);
    expect(cutByShare("ｺﾝﾋﾟｭｰﾀｰ", [1, 1, 1]).some((p) => p.startsWith("ｰ"))).toBe(false);
    // ，/： join digits only: between fullwidth words they are clause seams.
    expect(cutByShare("ＣＰＵ，ＧＰＵ，ＲＡＭ", [1, 1, 1])).toEqual(["ＣＰＵ，", "ＧＰＵ，", "ＲＡＭ"]);
    expect(cutByShare("ＵＲＬ：ｈｔｔｐ", [1, 1]).every(Boolean)).toBe(true);
    expect(cutByShare("開始は１２：３０です", [1, 1, 1]).some((p) => /^[：３０]/.test(p))).toBe(false);
    // A word mixing fullwidth and ASCII letters or digits is one word.
    expect(cutByShare("ＰＳ5を買った", [1, 1, 1])[0]).toBe("ＰＳ5");
    expect(cutByShare("ＮＨＫnewsを見た", [1, 1])[0]).toBe("ＮＨＫnews");
  });
  it("cuts after a German closing quote glued to CJK, not inside its word", () => {
    expect(cutByShare("„Hallo“東京", [1, 1])).toEqual(["„Hallo“", "東京"]);
    expect(cutByShare("„Hallo“東京", [1, 1, 1])).toEqual(["„Hallo“", "東", "京"]);
  });
  it("leaves no one-character part where a longer one is near the target", () => {
    expect(cutByShare("Hello there. また行きたいです!", [1, 1, 1, 1, 1])).toEqual(["Hello there.", "また", "行き", "たい", "です!"]);
    // A supplementary-plane character (a surrogate pair) is one character, too.
    expect(cutByShare("𠮷野家に行った𠮷", [1, 1, 1])).toEqual(["𠮷野", "家に行っ", "た𠮷"]);
    expect(cutByShare("𠮷野家に行った𠮷", [1, 4, 1])).toEqual(["𠮷野", "家に行っ", "た𠮷"]);
  });
});

describe("trackLang", () => {
  it("the original's language, a site track's own, a target's code — und when unknown", () => {
    const r: BatchResult = { text: "", language: " de ", timedTracks: [{ id: "x", lang: "fr", source: "site", kind: "manual", cues: [] }] };
    expect(["orig", "en", "x"].map((t) => trackLang(r, t))).toEqual(["de", "en", "fr"]);
    expect(trackLang({}, "orig")).toBe("und");
    expect(timedTrack(r, "x")?.lang).toBe("fr");
  });
  it("a code of only format marks is unknown too", () => {
    expect(trackLang({ language: "\u200e" }, "orig")).toBe("und");
    const r: BatchResult = { text: "", timedTracks: [{ id: "x", lang: "\u200b", source: "site", kind: "manual", cues: [] }] };
    expect(trackLang(r, "x")).toBe("und");
    expect(timedTrack(r, "orig")).toBeUndefined();
    // Joiners too: the viewer tags such an original "??".
    expect(trackLang({ language: "\u200d" }, "orig")).toBe("und");
    expect(trackLang({}, "\u200c")).toBe("und");
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

describe("shape matrix: cues, their lines and translation cuts", () => {
  // Realistic shapes pinned whole, so a heuristic change shows every row it moves. A cue reads
  // "text ⟨lines it wraps to⟩"; CJK words are two-character chunks with no spaces.
  const OPTS = {
    std: { length: "standard", timing: "same" },
    short: { length: "short", timing: "same" },
    c3: { length: "custom", custom: { cpl: 42, lines: 3, maxDur: 7, cps: 17 }, timing: "same" },
    c1: { length: "custom", custom: { cpl: 42, lines: 1, maxDur: 7, cps: 17 }, timing: "same" },
  } satisfies Record<string, CueOptions>;
  const split = (lang: string, text: string, spw: number, preset: keyof typeof OPTS, cjk: boolean, tok = false) => {
    const ws = tok ? text.split("|") : cjk ? (text.match(/.{1,2}/gu) ?? []) : text.split(/\s+/);
    if (tok) text = ws.join("");
    const words = ws.map((w, i) => ({ word: (cjk ? "" : " ") + w, start: i * spw, end: i * spw + spw * 0.9 }));
    const r: BatchResult = { text, language: lang, words, segments: [{ start: 0, end: ws.length * spw, text: (cjk ? "" : " ") + text }] };
    const L = limitsFor(OPTS[preset], lang);
    return buildCues(r, OPTS[preset], ["orig"]).cues
      .map((c) => `${c.text} ⟨${wrapLines(c.text, L.cpl, L.lines, 0, c.q).length}⟩`).join(" | ");
  };
  const SPLIT: [label: string, lang: string, text: string, secPerWord: number, preset: keyof typeof OPTS, want: string][] = [
    ["en short", "en", "Hello there, how are you?", 0.3, "std", "Hello there, how are you? ⟨1⟩"],
    ["en LONG std", "en", LONG, 0.3, "std", "The glacier behind me has lost almost forty percent of its volume since 1980. ⟨2⟩ | The scientists who measure it every summer say the pace is still accelerating, ⟨2⟩ | so the valley below will look completely different within a generation. ⟨2⟩"],
    ["en LONG short", "en", LONG, 0.3, "short", "The glacier behind me has lost almost ⟨1⟩ | forty percent of its volume since 1980. ⟨1⟩ | The scientists who measure it every summer ⟨1⟩ | say the pace is still accelerating, ⟨1⟩ | so the valley below will look completely ⟨1⟩ | different within a generation. ⟨1⟩"],
    ["en lights on,", "en", "We need to figure out how to turn the lights on, and then we can finally start the show tonight.", 0.25, "std", "We need to figure out how to turn the lights on, ⟨2⟩ | and then we can finally start the show tonight. ⟨2⟩"],
    ["en lights up,", "en", "We need to figure out how to turn the lights up, and then we can finally start the show tonight.", 0.25, "std", "We need to figure out how to turn the lights up, ⟨2⟩ | and then we can finally start the show tonight. ⟨2⟩"],
    ["en to her,", "en", "I gave the old letter back to her, because she asked me for it last night after dinner.", 0.25, "std", "I gave the old letter back to her, ⟨1⟩ | because she asked me for it last night after dinner. ⟨2⟩"],
    ["en in,", "en", "Please come in, sit down and tell me everything that happened at the station this morning.", 0.25, "std", "Please come in, sit down and tell me everything ⟨2⟩ | that happened at the station this morning. ⟨1⟩"],
    ["en Mr.", "en", "Yesterday afternoon I finally met Mr. Johnson and his wife at the station in the city centre.", 0.25, "std", "Yesterday afternoon I finally met Mr. Johnson ⟨2⟩ | and his wife at the station in the city centre. ⟨2⟩"],
    ["en Dr. long", "en", "After a very long and tiring meeting with the board we spoke to Dr. Watson about the results of the study.", 0.25, "std", "After a very long and tiring meeting with the board ⟨2⟩ | we spoke to Dr. Watson about the results of the study. ⟨2⟩"],
    ["en the end", "en", "It was the best thing I have ever seen in my whole life and I will never forget the moment.", 0.25, "std", "It was the best thing I have ever seen in my whole life ⟨2⟩ | and I will never forget the moment. ⟨1⟩"],
    ["en quotes", "en", "He said, \"Go home now.\" Then we all left the place quickly and nobody said a word on the way.", 0.25, "std", "He said, \"Go home now.\" ⟨1⟩ | Then we all left the place quickly and nobody said a word on the way. ⟨2⟩"],
    ["en quote ?", "en", "She asked, \"Are you coming with us?\" and I did not know what to answer her at that moment.", 0.25, "std", "She asked, \"Are you coming with us?\" ⟨1⟩ | and I did not know what to answer her at that moment. ⟨2⟩"],
    ["en paren", "en", "The new model (released last year.) is faster, cheaper and much easier to use than the old one.", 0.25, "std", "The new model (released last year.) ⟨1⟩ | is faster, cheaper and much easier to use than the old one. ⟨2⟩"],
    ["en numbers", "en", "In 2024 we sold 1,234,567 units at 3.99 dollars each, which is 12.5 percent more than in 2023.", 0.25, "std", "In 2024 we sold 1,234,567 units at 3.99 dollars each, ⟨2⟩ | which is 12.5 percent more than in 2023. ⟨1⟩"],
    ["en 3-line probe", "en", "The quick brown fox jumps over the lazy dog while the extraordinarily uncomfortable farmer watches.", 0.3, "std", "The quick brown fox jumps over the lazy dog ⟨2⟩ | while the extraordinarily uncomfortable farmer watches. ⟨2⟩"],
    ["en custom 3 lines", "en", LONG, 0.3, "c3", "The glacier behind me has lost almost forty percent of its volume since 1980. ⟨2⟩ | The scientists who measure it every summer say the pace is still accelerating, ⟨2⟩ | so the valley below will look completely different within a generation. ⟨2⟩"],
    ["en custom 1 line", "en", "We need to figure out how to turn the lights on, and then we can finally start the show tonight.", 0.25, "c1", "We need to figure out how ⟨1⟩ | to turn the lights on, ⟨1⟩ | and then we can finally ⟨1⟩ | start the show tonight. ⟨1⟩"],
    ["de compounds", "de", "Wir sprechen heute über Verantwortungsbewusstsein und Zusammengehörigkeitsgefühl.", 0.4, "std", "Wir sprechen heute ⟨1⟩ | über Verantwortungsbewusstsein und Zusammengehörigkeitsgefühl. ⟨2⟩"],
    ["de long", "de", "Die Bundesregierung hat gestern beschlossen, die Mehrwertsteuer auf Lebensmittel zu senken, weil die Inflation weiterhin sehr hoch ist und viele Familien darunter leiden.", 0.3, "std", "Die Bundesregierung hat gestern beschlossen, ⟨2⟩ | die Mehrwertsteuer auf Lebensmittel zu senken, ⟨2⟩ | weil die Inflation weiterhin sehr hoch ist und viele Familien darunter leiden. ⟨2⟩"],
    ["de z.B.", "de", "Wir brauchen z.B. mehr Geld für die Schulen, die Krankenhäuser und die öffentlichen Verkehrsmittel im ganzen Land.", 0.3, "std", "Wir brauchen z.B. mehr Geld für die Schulen, ⟨2⟩ | die Krankenhäuser und die öffentlichen Verkehrsmittel im ganzen Land. ⟨2⟩"],
    ["de 3. Mai", "de", "Am 3. Mai treffen wir uns wieder in der Kantine im Erdgeschoss des neuen Verwaltungsgebäudes der Stadt.", 0.3, "std", "Am 3. Mai treffen wir uns wieder in der Kantine ⟨2⟩ | im Erdgeschoss des neuen Verwaltungsgebäudes der Stadt. ⟨2⟩"],
    ["de quote", "de", "Er sagte: „Wir gehen jetzt nach Hause.“ Dann sind wir alle zusammen gegangen und haben nichts mehr gesagt.", 0.3, "std", "Er sagte: „Wir gehen jetzt nach Hause.“ Dann sind wir alle zusammen gegangen ⟨2⟩ | und haben nichts mehr gesagt. ⟨1⟩"],
    ["fr guillemets", "fr", "Il a dit : « Rentrons à la maison maintenant. » Puis nous sommes tous partis sans dire un seul mot.", 0.3, "std", "Il a dit : ⟨1⟩ | « Rentrons à la maison maintenant. » Puis nous ⟨2⟩ | sommes tous partis sans dire un seul mot. ⟨1⟩"],
    ["en short preset quotes", "en", "He said, \"Go home now.\" Then we all left the place quickly.", 0.3, "short", "He said, \"Go home now.\" ⟨1⟩ | Then we all left the place quickly. ⟨1⟩"],
  ];
  const SPLIT_CJK: [label: string, lang: string, text: string, secPerWord: number, preset: keyof typeof OPTS, want: string][] = [
    ["zh 。」", "zh", "他说：「我们走吧。」然后大家一起离开了这个地方，好吗？我们明天再见面吧。", 0.3, "std", "他说：「我们走吧。」 ⟨1⟩ | 然后大家一起离开了这个地方，好吗？我们明天再见面吧。 ⟨2⟩"],
    ["zh 、", "zh", "今天我们去了商店、市场、还有公园，然后在河边吃了午饭，最后坐公交车回家了。", 0.3, "std", "今天我们去了商店、市场、 ⟨1⟩ | 还有公园，然后在河边吃了午饭，最后坐公交车回家了。 ⟨2⟩"],
    ["ja 「」", "ja", "彼は「もう帰ろう。」と言った。それから私たちは皆で一緒にその場所を離れました。", 0.3, "std", "彼は「もう帰ろう。」と言った。それから私 ⟨2⟩ | たちは皆で一緒にその場所を離れました。 ⟨2⟩"],
    ["ja short", "ja", "今日はとても良い天気ですね。散歩に行きましょう。", 0.3, "short", "今日はとても良い ⟨1⟩ | 天気ですね。 ⟨1⟩ | 散歩に行きましょう。 ⟨1⟩"],
    ["zh numbers", "zh", "我们在2024年卖出了123万台手机，比去年多了百分之十二点五。", 0.3, "std", "我们在2024年卖出了123万台手机，比去年多了百分之十二点五。 ⟨2⟩"],
  ];
  // Whisper-like CJK words ("|" between them, punctuation riding with the word before).
  const SPLIT_TOK: [label: string, lang: string, words: string, secPerWord: number, preset: keyof typeof OPTS, want: string][] = [
    ["ja 「」と言った", "ja", "彼は|「もう|帰ろう。」|と|言った。|それから|私たちは|皆で|一緒に|その|場所を|離れました。", 0.4, "std", "彼は「もう帰ろう。」と言った。 ⟨2⟩ | それから私たちは皆で一緒にその場所を離れました。 ⟨2⟩"],
    ["ja 『！』", "ja", "彼女は|『絶対に|行かない！』|と|叫んだ。|でも|結局|一緒に|来てくれた。", 0.4, "std", "彼女は『絶対に行かない！』と叫んだ。 ⟨2⟩ | でも結局一緒に来てくれた。 ⟨1⟩"],
    ["zh 。」然后", "zh", "他说：|「我们|走吧。」|然后|大家|一起|离开了|这个|地方，|好吗？|我们|明天|再|见面吧。", 0.4, "std", "他说：「我们走吧。」 ⟨1⟩ | 然后大家一起离开了这个地方，好吗？我们明天再见面吧。 ⟨2⟩"],
    ["zh （）", "zh", "这个|问题|（我们|昨天|讨论过。）|今天|还|需要|再|讨论|一次|才能|决定。", 0.4, "std", "这个问题（我们昨天讨论过。）今天还需要再讨论一次才能决定。 ⟨2⟩"],
    ["ja 、", "ja", "今日は|天気が|良いので、|公園に|行って、|それから|買い物を|しましょう。", 0.4, "std", "今日は天気が良いので、公園に行って、 ⟨2⟩ | それから買い物をしましょう。 ⟨2⟩"],
  ];
  const WRAP: [label: string, text: string, cpl: number, lines: number, reserve: number, want: string][] = [
    ["w lights on", "how to turn the lights on, and then we can start", 42, 2, 0, "how to turn the lights on, / and then we can start"],
    ["w to her,", "I gave it back to her, because she asked me", 30, 2, 0, "I gave it back to her, / because she asked me"],
    ["w quote", "He said, \"Go home now.\" Then we all left the place", 42, 2, 0, "He said, \"Go home now.\" / Then we all left the place"],
    ["w Mr.", "Yesterday I met Mr. Johnson at the station", 30, 2, 0, "Yesterday I met / Mr. Johnson at the station"],
    ["w Ms.", "Yesterday I met Ms. Johnson at the station", 30, 2, 0, "Yesterday I met / Ms. Johnson at the station"],
    ["w de", "Wir sprechen heute über Verantwortungsbewusstsein und Zusammengehörigkeitsgefühl.", 42, 2, 0, "Wir sprechen heute / über Verantwortungsbewusstsein / und Zusammengehörigkeitsgefühl."],
    ["w zh 。」", "他说：「我们走吧。」然后大家一起离开了这个地方", 16, 2, 0, "他说：「我们走吧。」然 / 后大家一起离开了这个地方"],
    ["w ja 。」", "彼は「もう帰ろう。」と言った。それから皆で", 13, 2, 0, "彼は「もう帰ろう。」 / と言った。それから皆で"],
    ["w ja ）", "東京（とうきょう）は日本の首都です。大きい", 13, 2, 0, "東京（とうきょう）は / 日本の首都です。大きい"],
    ["w prefix", "the lights on, and then we can finally start", 42, 2, 8, "the lights on, / and then we can finally start"],
  ];
  const CUT: [label: string, text: string, shares: number[], want: string][] = [
    ["c quote.", "He said, \"Go home now.\" Then we all left the place quickly.", [1, 1], "He said, \"Go home now.\" | Then we all left the place quickly."],
    ["c quote?", "She asked, \"Are you coming?\" Then we all left the place quickly.", [1, 1], "She asked, \"Are you coming?\" | Then we all left the place quickly."],
    ["c curly", "He said, “Go home now.” Then we all left the place quickly.", [1, 1], "He said, “Go home now.” | Then we all left the place quickly."],
    ["c paren", "We bought it (all of it.) Then we went home together quickly.", [1, 1], "We bought it (all of it.) | Then we went home together quickly."],
    ["c zh 。」", "他说：「我们走吧。」然后大家一起离开了这个地方好吗", [1, 1], "他说：「我们走吧。」 | 然后大家一起离开了这个地方好吗"],
    ["c ja 。）", "彼は帰った（もう遅い。）それから皆で一緒に離れました", [1, 1], "彼は帰った（もう遅い。） | それから皆で一緒に離れました"],
    ["c ja ！』", "彼は『行こう！』と言ったそれから皆で一緒に離れました", [1, 1], "彼は『行こう！』と言ったそ | れから皆で一緒に離れました"],
    ["c plain .", "We went home. Then we all left the place quickly and quietly.", [1, 1], "We went home. Then we all left | the place quickly and quietly."],
    ["c plain ,", "We went home, then we all left the place quickly and quietly.", [1, 1], "We went home, then we all left | the place quickly and quietly."],
    ["c on,", "Turn the lights on, and then we can finally start the show.", [1, 1], "Turn the lights on, | and then we can finally start the show."],
    ["c Mr.", "Yesterday I met Mr. Johnson at the old station near home.", [1, 1], "Yesterday I met Mr. Johnson | at the old station near home."],
    ["c 3 parts", "First we ate. \"Then we drank,\" he said. After that we slept for hours.", [1, 1, 1], "First we ate. | \"Then we drank,\" he said. | After that we slept for hours."],
    ["c de „“", "Er sagte: „Geh jetzt nach Hause.“ Dann gingen wir alle schnell.", [1, 1], "Er sagte: „Geh jetzt nach Hause.“ | Dann gingen wir alle schnell."],
    ["c fr »", "Il a dit : « Rentre maintenant. » Puis nous sommes tous partis vite.", [1, 1], "Il a dit : « Rentre maintenant. » | Puis nous sommes tous partis vite."],
    ["c number", "It costs 3.99 dollars. That is cheaper than the 4.50 last year.", [1, 1], "It costs 3.99 dollars. | That is cheaper than the 4.50 last year."],
    ["c ja 』と real", "彼は『行こう！』と言った。それから皆で一緒に離れました。", [1, 1], "彼は『行こう！』と言った。 | それから皆で一緒に離れました。"],
    ["c ja 」ところで", "「もう帰ろう。」ところで明日の予定はどうなっていますか。", [1, 1], "「もう帰ろう。」ところで明日 | の予定はどうなっていますか。"],
    ["c zh 」他说", "「我们走吧。」他说完就离开了这个地方，大家都很安静。", [1, 1], "「我们走吧。」 | 他说完就离开了这个地方，大家都很安静。"],
  ];
  it.each(SPLIT)("split %s", (_, lang, text, spw, preset, want) => expect(split(lang, text, spw, preset, false)).toBe(want));
  it.each(SPLIT_CJK)("split %s", (_, lang, text, spw, preset, want) => expect(split(lang, text, spw, preset, true)).toBe(want));
  it.each(SPLIT_TOK)("split %s", (_, lang, words, spw, preset, want) => expect(split(lang, words, spw, preset, true, true)).toBe(want));
  it.each(WRAP)("wrap %s", (_, text, cpl, lines, reserve, want) => expect(wrapLines(text, cpl, lines, reserve).join(" / ")).toBe(want));
  it.each(CUT)("cut %s", (_, text, shares, want) => expect(cutByShare(text, shares).join(" | ")).toBe(want));
});
