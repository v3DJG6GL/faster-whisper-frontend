import { describe, expect, it } from "vitest";
import {
  CUE_PRESETS, TRANSCRIBED_CPS, buildCues, cueOptionsOf, cueResult, cutByShare, limitsFor, limitsTitle, trackLimits, sanitizeCueLimits, timedTrack, trText, trackCues, trackLang, wrapLines,
  type CueOptions,
} from "./cueSplit";
import type { BatchResult, TranscriptWord } from "./types";

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

  it("site tracks always keep their own timing", () => {
    const r: BatchResult = {
      ...seg1("Hello there.", 0, 2),
      timedTracks: [{ id: "de-x-site", lang: "de", source: "site", kind: "manual", cues: [{ start: 0.5, end: 1.5, text: " Hallo. " }] }],
    };
    const grid = buildCues(r, undefined, ["orig", "de-x-site"]);
    expect(grid.own["de-x-site"]).toEqual([{ seg: -1, start: 0.5, end: 1.5, text: "Hallo.", tr: {} }]);
    expect(buildCues(r, STD, ["orig"]).own["de-x-site"]).toBeUndefined();
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
});

describe("cutByShare", () => {
  it("prefers punctuation near the share target", () => {
    expect(cutByShare("Erstens das hier, zweitens das dort.", [1, 1])).toEqual(["Erstens das hier,", "zweitens das dort."]);
  });
  it("cuts CJK text at character boundaries", () => {
    expect(cutByShare("今日は晴れ。明日は雨。", [1, 1])).toEqual(["今日は晴れ。", "明日は雨。"]);
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
  });
  it("the tooltip names lines, characters, duration and speed", () => {
    expect(limitsTitle(CUE_PRESETS.standard)).toBe("2 lines × 42 characters · up to 7 s · 17 chars/s");
    expect(limitsTitle(CUE_PRESETS.short)).toBe("1 line × 42 characters · up to 4 s · 17 chars/s");
  });
});
