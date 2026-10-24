// Unit tests for the pure transcript-export generators. These run in plain
// node (no Tauri, no DOM) — exactly why the generators live in src/lib.

import { describe, expect, it } from "vitest";
import {
  cpsWarnings, cueGrid, previewExport, DEFAULT_SPEAKER_COLORS, exportFileNames, exportOptionsFor, exportStemSuffix, generateExport, isSubtitleFormat, speakerName, tracksOf,
  generateExports, joinSegmentTexts, writesCue, writtenCues,
  prettySpeaker, speakerColorIndex, speakerHex, speakerOrder,
  type ExportOptions,
} from "./transcriptFormats";
import { parseImportedText } from "./subtitleImport";
import { stripControlChars } from "../sanitize";
import type { BatchResult } from "../types";

const RESULT: BatchResult = {
  text: "Hello there. General greeting.",
  language: "en",
  duration: 4.0,
  segments: [
    { start: 0.4, end: 2.0, text: " Hello there.", speaker: "SPEAKER_00" },
    { start: 2.1, end: 3.8, text: " General greeting.", speaker: "SPEAKER_01" },
  ],
  words: [
    { word: " Hello", start: 0.4, end: 0.9 },
    { word: " there.", start: 0.9, end: 1.4 },
    { word: " General", start: 2.1, end: 2.7 },
    { word: " greeting.", start: 2.7, end: 3.4 },
  ],
  speakers: ["SPEAKER_00", "SPEAKER_01"],
};

const PLAIN: BatchResult = {
  text: "Just one line of text.",
  segments: [{ start: 0.0, end: 2.0, text: "Just one line of text." }],
};

describe("prettySpeaker / speakerOrder", () => {
  it("maps pyannote labels to human names and keeps others verbatim", () => {
    expect(prettySpeaker("SPEAKER_00")).toBe("Speaker 1");
    expect(prettySpeaker("SPEAKER_11")).toBe("Speaker 12");
    expect(prettySpeaker("alice")).toBe("alice");
  });
  it("derives order from segments when the speakers list is absent", () => {
    const { speakers: _drop, ...rest } = RESULT;
    expect(speakerOrder(rest)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
  });
});

describe("txt", () => {
  it("without speakers: the flowing transcript verbatim", () => {
    expect(generateExport(PLAIN, { format: "txt" })).toBe("Just one line of text.\n");
  });
  it("with speakers: one paragraph per turn with name prefixes and renames", () => {
    const out = generateExport(RESULT, {
      format: "txt",
      renames: { SPEAKER_00: "Nadia" },
    });
    expect(out).toBe("Nadia: Hello there.\n\nSpeaker 2: General greeting.\n");
  });
  it("with speakers: a CJK turn's segments join without spaces, as the plain text does", () => {
    const ja: BatchResult = {
      text: "今日は晴れ。明日は雨。",
      language: "ja",
      speakers: ["SPEAKER_00"],
      segments: [
        { start: 0, end: 1, text: "今日は晴れ。", speaker: "SPEAKER_00", translations: { zh: "今天晴天。" } },
        { start: 1, end: 2, text: "明日は雨。", speaker: "SPEAKER_00", translations: { zh: "明天下雨。" } },
      ],
    };
    expect(generateExport(ja, { format: "txt" })).toBe("Speaker 1: 今日は晴れ。明日は雨。\n");
    expect(generateExport(ja, { format: "txt", tracks: ["orig", "zh"] }))
      .toBe("Speaker 1: 今日は晴れ。明日は雨。\n\nSpeaker 1: 今天晴天。明天下雨。\n");
    // A seam with spaced text on either side keeps its space.
    const mixed = { ...ja, segments: [ja.segments![0], { ...ja.segments![1], text: "OK." }] };
    expect(generateExport(mixed, { format: "txt" })).toBe("Speaker 1: 今日は晴れ。 OK.\n");
  });
  it("with speakers: a blank segment writes no bare name paragraph and does not split the turn around it", () => {
    const gap: BatchResult = {
      text: "Hi there",
      speakers: ["SPEAKER_00", "SPEAKER_01"],
      segments: [
        { start: 0, end: 1, text: "Hi", speaker: "SPEAKER_00" },
        { start: 1, end: 2, text: "  ", speaker: "SPEAKER_01" },
        { start: 2, end: 3, text: "there", speaker: "SPEAKER_00" },
      ],
    };
    expect(generateExport(gap, { format: "txt" })).toBe("Speaker 1: Hi there\n");
    // The interleaved (translated) branch keeps the turn whole too.
    const tr: BatchResult = {
      ...gap,
      segments: gap.segments!.map((s, i) => ({ ...s, translations: i === 1 ? {} : { de: i ? "da" : "Hallo" } as Record<string, string> })),
    };
    expect(generateExport(tr, { format: "txt", tracks: ["orig", "de"] })).not.toMatch(/Speaker 2/);
    expect(generateExport(tr, { format: "txt", tracks: ["orig", "de"] }).match(/Speaker 1/g)).toHaveLength(2);
  });
  it("a turn whose original is blank tags its lone translation, so it does not read as spoken", () => {
    const blank: BatchResult = {
      text: "",
      speakers: ["S1"],
      segments: [{ start: 0, end: 1, text: "", speaker: "S1", translations: { de: "Leer" } }],
    };
    expect(generateExport(blank, { format: "txt", tracks: ["orig", "de"] })).toBe("[DE] S1: Leer\n");
    // A turn with its original keeps the single target untagged.
    const spoken: BatchResult = {
      ...blank,
      segments: [...blank.segments!, { start: 1, end: 2, text: "Hi", speaker: "S2", translations: { de: "Hallo" } }],
    };
    expect(generateExport(spoken, { format: "txt", tracks: ["orig", "de"] }))
      .toBe("[DE] S1: Leer\n\nS2: Hi\n\nS2: Hallo\n");
  });
});

describe("srt", () => {
  it("a rounding carry rolls into the second instead of a 4-digit millisecond field", () => {
    const edge: BatchResult = {
      text: "x",
      segments: [{ start: 1.9996, end: 3.0, text: "x" }],
    };
    const out = generateExport(edge, { format: "srt" });
    expect(out).toContain("00:00:02,000 --> ");
    expect(out).not.toContain(",1000");
  });
  it("numbered cues with comma-millisecond clock times", () => {
    const out = generateExport(RESULT, { format: "srt" });
    expect(out).toContain("1\n00:00:00,400 --> 00:00:02,000\nSpeaker 1: Hello there.");
    expect(out).toContain("2\n00:00:02,100 --> 00:00:03,800\nSpeaker 2: General greeting.");
  });
  it("color modes wrap name / line / line-only in <font color>", () => {
    const name = generateExport(RESULT, { format: "srt", speakerColors: "name" });
    expect(name).toContain('<font color="#ff9e2c">Speaker 1:</font> Hello there.');
    const line = generateExport(RESULT, { format: "srt", speakerColors: "line" });
    expect(line).toContain('<font color="#6faed9">Speaker 2: General greeting.</font>');
    const only = generateExport(RESULT, { format: "srt", speakerColors: "line-only" });
    expect(only).toContain('<font color="#ff9e2c">Hello there.</font>');
    expect(only).not.toContain("Speaker 1");
  });
  it("a blank original beside its translation leaves no empty line that would end the cue", () => {
    const blank: BatchResult = {
      text: "\u200e",
      segments: [{ start: 1, end: 2, text: "\u200e", translations: { de: "Leer" } }],
    };
    const opts: ExportOptions = { format: "srt", tracks: ["orig", "de"] };
    const srt = generateExport(blank, opts);
    // The lone translation says its language (SRT has no class to mark it), or its cue would
    // read like an untranslated original's.
    expect(srt).toBe("1\n00:00:01,000 --> 00:00:02,000\n[DE] Leer\n");
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["[DE] Leer"]);
    expect(generateExport(blank, { ...opts, format: "vtt" })).toContain("00:00:01.000 --> 00:00:02.000\n<c.mt>Leer</c>\n");
    // TXT has no cue to end: the blank keeps its timed slot and the translation indents under
    // it, rather than taking the original's time and place.
    expect(generateExport(blank, { ...opts, format: "txt", timestamps: true })).toBe("[00:01]\n        Leer\n");
    // Translation first: the stamp already sits on the translation, so the blank original
    // trails no empty, space-filled line under it — and the lone translation says its
    // language, or it would read like an untranslated original.
    expect(generateExport(blank, { ...opts, format: "txt", timestamps: true, tracks: ["de", "orig"] }))
      .toBe("[00:01] [DE] Leer\n");
    // Original-only keeps its (empty) cue.
    expect(generateExport(blank, { format: "srt" })).toBe("1\n00:00:01,000 --> 00:00:02,000\n\n");
  });
  it("a blank speaker segment keeps its line but writes no bare name onto it", () => {
    const blank: BatchResult = {
      text: "",
      speakers: ["SPEAKER_01"],
      segments: [{ start: 1, end: 2, text: "", speaker: "SPEAKER_01" }],
    };
    const empty = "1\n00:00:01,000 --> 00:00:02,000\n\n";
    expect(generateExport(blank, { format: "srt" })).toBe(empty);
    expect(generateExport(blank, { format: "srt", speakerColors: "name" })).toBe(empty);
    expect(generateExport(blank, { format: "srt", speakerColors: "line" })).toBe(empty);
    expect(generateExport(blank, { format: "vtt" })).toContain("00:00:01.000 --> 00:00:02.000\n\n");
    expect(generateExport(blank, { format: "vtt", speakerColors: "name" })).toContain("00:00:01.000 --> 00:00:02.000\n\n");
    expect(generateExport(blank, { format: "lrc" })).toBe("[00:01.00]\n");
    expect(generateExport(blank, { format: "txt", timestamps: true })).toBe("[00:01]\n");
    // Re-imported, the blank cue is no phantom "Speaker 2:" line.
    const two: BatchResult = {
      ...blank,
      segments: [...blank.segments!, { start: 3, end: 4, text: "Hi", speaker: "SPEAKER_01" }],
    };
    expect(parseImportedText("srt", generateExport(two, { format: "srt" })).segments.map((s) => s.text))
      .toEqual(["Hi"]);
  });
});

describe("vtt", () => {
  it("voice tags when colors are off", () => {
    const out = generateExport(RESULT, { format: "vtt", renames: { SPEAKER_00: "Nadia" } });
    expect(out.startsWith("WEBVTT\n")).toBe(true);
    expect(out).toContain("00:00:00.400 --> 00:00:02.000\n<v Nadia>Hello there.</v>");
  });
  it("generated class names + STYLE block for color modes", () => {
    const out = generateExport(RESULT, { format: "vtt", speakerColors: "line" });
    expect(out).toContain("::cue(.spk1) { color: #ff9e2c; }");
    expect(out).toContain("<c.spk1>Speaker 1: Hello there.</c>");
    // Class names are generated, never derived from (renamable) user text.
    const renamed = generateExport(RESULT, {
      format: "vtt",
      speakerColors: "line",
      renames: { SPEAKER_00: "Ms. <Weird> Name" },
    });
    expect(renamed).toContain("<c.spk1>Ms. &lt;Weird&gt; Name: Hello there.</c>");
  });
  it("escapes markup in transcript text", () => {
    const tricky: BatchResult = {
      text: "a < b & c",
      segments: [{ start: 0, end: 1, text: "a < b & c" }],
    };
    const out = generateExport(tricky, { format: "vtt" });
    expect(out).toContain("a &lt; b &amp; c");
  });
});

describe("lrc", () => {
  it("line-level tags with name prefixes", () => {
    const out = generateExport(RESULT, { format: "lrc" });
    expect(out).toContain("[00:00.40]Speaker 1: Hello there.");
    expect(out).toContain("[00:02.10]Speaker 2: General greeting.");
  });
  it("enhanced word tags when requested", () => {
    const out = generateExport(RESULT, { format: "lrc", wordTimestamps: true });
    expect(out).toContain("[00:00.40]Speaker 1: <00:00.40>Hello <00:00.90>there.");
  });
  it("falls back to line level when no words cover a segment", () => {
    // Words exist, but none land in the first segment's window — the branch
    // the cursor merge in segmentWordRanges has to get right.
    const partial: BatchResult = {
      ...RESULT,
      words: [
        { word: " General", start: 2.1, end: 2.7 },
        { word: " greeting.", start: 2.7, end: 3.4 },
      ],
    };
    const out = generateExport(partial, { format: "lrc", wordTimestamps: true });
    expect(out).toContain("[00:00.40]Speaker 1: Hello there.");
    expect(out).toContain("[00:02.10]Speaker 2: <00:02.10>General <00:02.70>greeting.");
  });
  it("with no words at all every line is line-level", () => {
    const noWords: BatchResult = { ...RESULT, words: [] };
    const out = generateExport(noWords, { format: "lrc", wordTimestamps: true });
    expect(out).toContain("[00:00.40]Speaker 1: Hello there.");
  });
  it("a rounding carry rolls into the minute instead of printing 60 seconds", () => {
    const edge: BatchResult = {
      text: "x",
      segments: [{ start: 59.999, end: 61.0, text: "x" }],
    };
    expect(generateExport(edge, { format: "lrc" })).toContain("[01:00.00]x");
  });
});

describe("json", () => {
  it("carries labels, display names, segments and words", () => {
    const out = JSON.parse(
      generateExport(RESULT, { format: "json", renames: { SPEAKER_01: "Reto" } }),
    );
    expect(out.speakers).toEqual([
      { label: "SPEAKER_00", name: "Speaker 1", color: "#ff9e2c" },
      { label: "SPEAKER_01", name: "Reto", color: "#6faed9" },
    ]);
    expect(out.segments[1].speakerName).toBe("Reto");
    expect(out.words).toHaveLength(4);
  });
});

describe("sanitisation", () => {
  it("json speaker labels are defanged like every other emitted string", () => {
    const r: BatchResult = {
      text: "hi",
      segments: [{ start: 0, end: 1, text: "hi", speaker: "SPEAKER_\u202e00" }],
      speakers: ["SPEAKER_\u202e00"],
    };
    const parsed = JSON.parse(generateExport(r, { format: "json" }));
    expect(parsed.speakers[0].label).not.toContain("\u202e");
    expect(parsed.segments[0].speaker).not.toContain("\u202e");
  });
  it("an empty track selection writes nothing — never the deselected original", () => {
    expect(generateExport(RESULT, { format: "txt", tracks: [] })).toBe("\n");
  });
  it("a rename made only of format characters falls back to the speaker label", () => {
    const out = generateExport(RESULT, {
      format: "txt",
      renames: { SPEAKER_00: "\u202e\u200b" },
    });
    expect(out.startsWith("Speaker 1: Hello there.")).toBe(true);
    const vtt = generateExport(RESULT, { format: "vtt", renames: { SPEAKER_00: "\u202e" } });
    expect(vtt).not.toContain("<v >");
  });
  it("strips bidi/control characters from text and renames", () => {
    const evil: BatchResult = {
      text: "ok",
      segments: [{ start: 0, end: 1, text: "pay ‮005$‬ now", speaker: "SPEAKER_00" }],
      speakers: ["SPEAKER_00"],
    };
    const out = generateExport(evil, {
      format: "srt",
      renames: { SPEAKER_00: "Bad‮Name" },
    });
    expect(out).not.toContain("‮");
    expect(out).not.toContain("‬");
    expect(out).toContain("BadName: pay 005$ now");
  });
  it("a line break inside segment text flattens to one space, in CJK text too", () => {
    const r: BatchResult = {
      text: "",
      language: "ja",
      segments: [
        { start: 0, end: 1, text: "今日は\nいい天気。" },
        { start: 1, end: 2, text: "a \n b" },
        { start: 2, end: 3, text: "我们走吧\n他们在等我们" },
        { start: 3, end: 4, text: "Hello\n\nworld" },
      ],
    };
    for (const format of ["srt", "vtt", "lrc"] as const) {
      const out = generateExport(r, { format });
      expect(out).toContain("今日は いい天気。");
      // The break and the blanks around it fold into ONE space (a blank line too).
      expect(out).toContain("a b");
      expect(out).not.toContain("a  b");
      expect(out).toContain("Hello world");
      expect(out).toContain("我们走吧 他们在等我们");
    }
  });
});

describe("display-toggle model (speakerNames / timestamps)", () => {
  it("srt: names off + color mode drops the name, keeps the colored line", () => {
    const out = generateExport(RESULT, {
      format: "srt",
      speakerColors: "line",
      speakerNames: false,
    });
    expect(out).toContain('<font color="#ff9e2c">Hello there.</font>');
    expect(out).not.toContain("Speaker 1");
  });

  it("srt: names off + colors off is plain text", () => {
    const out = generateExport(RESULT, { format: "srt", speakerNames: false });
    expect(out).toContain("Hello there.");
    expect(out).not.toContain("Speaker 1");
    expect(out).not.toContain("<font");
  });

  it("vtt: names off drops voice tags and name prefixes", () => {
    const out = generateExport(RESULT, { format: "vtt", speakerNames: false });
    expect(out).not.toContain("<v ");
    expect(out).toContain("Hello there.");
  });

  it("txt: timestamps on emits per-segment [mm:ss] lines", () => {
    const out = generateExport(RESULT, { format: "txt", timestamps: true });
    expect(out).toContain("[00:00] Speaker 1: Hello there.");
  });

  it("txt: timestamps on + names off has bare timestamped lines", () => {
    const out = generateExport(RESULT, {
      format: "txt",
      timestamps: true,
      speakerNames: false,
    });
    expect(out).toContain("[00:00] Hello there.");
    expect(out).not.toContain("Speaker 1");
  });
});

const TRANSLATED: BatchResult = {
  ...RESULT,
  segments: RESULT.segments!.map((s, i) => ({
    ...s,
    translations: {
      de: i === 0 ? "Hallo zusammen." : "Allgemeine Begrüßung.",
    },
  })),
  translation: { model: "tencent/HY-MT1.5-7B-GGUF:Q4_K_M", targets: ["de"], source: "en", mode: "fluent" },
};

describe("multi-track (tracks option)", () => {
  it("tracks undefined ⇒ byte-identical to the pre-translation output", () => {
    const a = generateExport(TRANSLATED, { format: "srt" });
    const b = generateExport(RESULT, { format: "srt" });
    expect(a).toBe(b);
  });
  it("srt: one line per selected track inside each cue, orig first", () => {
    const out = generateExport(TRANSLATED, { format: "srt", tracks: ["orig", "de"] });
    expect(out).toContain(
      "1\n00:00:00,400 --> 00:00:02,000\nSpeaker 1: Hello there.\nSpeaker 1: Hallo zusammen.",
    );
  });
  it("srt: the track order is the line order", () => {
    const out = generateExport(TRANSLATED, { format: "srt", tracks: ["de", "orig"] });
    expect(out).toContain("Speaker 1: Hallo zusammen.\nSpeaker 1: Hello there.");
  });
  it("txt: the first line of a segment carries the time, the rest indent under it", () => {
    const out = generateExport(TRANSLATED, { format: "txt", timestamps: true, tracks: ["de", "orig"] });
    expect(out.split("\n").slice(0, 2)).toEqual(["[00:00] Speaker 1: Hallo zusammen.", "        Speaker 1: Hello there."]);
    const paras = generateExport(TRANSLATED, { format: "txt", tracks: ["de", "orig"] });
    expect(paras.indexOf("Hallo zusammen.")).toBeLessThan(paras.indexOf("Hello there."));
  });
  it("srt: translations-only drops the original line", () => {
    const out = generateExport(TRANSLATED, { format: "srt", tracks: ["de"] });
    expect(out).toContain("Speaker 1: Hallo zusammen.");
    expect(out).not.toContain("Hello there.");
  });
  it("vtt: translated lines ride a generated .mt class + STYLE entry", () => {
    const out = generateExport(TRANSLATED, { format: "vtt", tracks: ["orig", "de"] });
    expect(out).toContain("::cue(.mt) { color: #4dd0c4; }");
    expect(out).toContain("<c.mt>Speaker 1: Hallo zusammen.</c>");
  });
  it("srt: color modes style translated lines too (speaker is language-independent)", () => {
    const out = generateExport(TRANSLATED, {
      format: "srt", tracks: ["orig", "de"], speakerColors: "line",
    });
    expect(out).toContain('<font color="#ff9e2c">Speaker 1: Hello there.</font>');
    expect(out).toContain('<font color="#ff9e2c">Speaker 1: Hallo zusammen.</font>');
    const only = generateExport(TRANSLATED, {
      format: "srt", tracks: ["de"], speakerColors: "line",
    });
    expect(only).toContain('<font color="#ff9e2c">Speaker 1: Hallo zusammen.</font>');
  });
  it("vtt: colorized translated lines stack .mt with the speaker class", () => {
    const out = generateExport(TRANSLATED, {
      format: "vtt", tracks: ["orig", "de"], speakerColors: "line",
    });
    expect(out).toContain("::cue(.spk1) { color: #ff9e2c; }");
    expect(out).toContain("<c.mt.spk1>Speaker 1: Hallo zusammen.</c>");
  });
  it("json: always full fidelity — translations embedded regardless of tracks", () => {
    const out = JSON.parse(generateExport(TRANSLATED, { format: "json", tracks: ["de"] }));
    expect(out.segments[0].translations.de).toBe("Hallo zusammen.");
    expect(out.translation.targets).toEqual(["de"]);
    expect(out.segments[0].text).toBe(" Hello there."); // json keeps raw segment text
  });
});

describe("generateExports / filenames / cps", () => {
  it("keeps a track code out of the path it would otherwise write into", () => {
    // Codes come from server-advertised / synced settings and land in a filename that
    // Rust writes with no containment check.
    const files = generateExports(TRANSLATED, { format: "lrc", tracks: ["orig", "../de", "a:b*c"] });
    for (const f of files) {
      const n = f.name("out");
      expect(n).not.toMatch(/[/\\:*]/);
      expect(n).not.toContain("..");
    }
  });

  it("lrc with two tracks = one file per track, suffixed", () => {
    const files = generateExports(TRANSLATED, { format: "lrc", tracks: ["orig", "de"] });
    expect(files).toHaveLength(2);
    expect(files[0].name("talk")).toBe("talk.lrc");
    expect(files[1].name("talk")).toBe("talk.de.lrc");
    expect(files[1].content).toContain("Hallo zusammen.");
    expect(files[1].content).not.toContain("Hello there.");
  });
  it("single translated track suffixes the stem; orig included does not", () => {
    expect(exportStemSuffix(["de"])).toBe(".de");
    expect(exportStemSuffix(["orig", "de"])).toBe("");
    expect(exportStemSuffix(undefined)).toBe("");
  });
  it("cps flags cues over 20 chars/sec without cue options", () => {
    const slow = cpsWarnings(TRANSLATED, { tracks: ["orig", "de"] });
    expect(slow).toEqual([]); // both cues are comfortably under 20 cps
    const fast: BatchResult = {
      ...TRANSLATED,
      segments: [{ start: 0, end: 1, text: "Hi.", translations: { de: "x".repeat(30) } }],
    };
    const warns = cpsWarnings(fast, { tracks: ["de"] });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ lang: "de", index: 0, cps: 30 });
  });
});

describe("speakerColorIndex / speakerHex (one resolver for viewer + exports)", () => {
  const order = ["SPEAKER_00", "SPEAKER_01"];

  it("pick wins; else first-appearance index mod palette length", () => {
    expect(speakerColorIndex(order, undefined, "SPEAKER_00")).toBe(0);
    expect(speakerColorIndex(order, undefined, "SPEAKER_01")).toBe(1);
    expect(speakerColorIndex(order, { SPEAKER_01: 5 }, "SPEAKER_01")).toBe(5);
    expect(speakerColorIndex(order, { SPEAKER_01: 5 }, "SPEAKER_00")).toBe(0);
    // Unknown label → first palette slot; out-of-range picks wrap.
    expect(speakerColorIndex(order, undefined, "GHOST")).toBe(0);
    expect(speakerColorIndex(order, { SPEAKER_00: 9 }, "SPEAKER_00"))
      .toBe(9 % DEFAULT_SPEAKER_COLORS.length);
  });

  it("viewer var(--spk-N) index and export hex agree for the same picks", () => {
    const picks = { SPEAKER_01: 5 };
    const idx = speakerColorIndex(order, picks, "SPEAKER_01");
    expect(speakerHex(order, picks, "SPEAKER_01")).toBe(DEFAULT_SPEAKER_COLORS[idx]);
    // A persisted out-of-range index wraps instead of yielding undefined — History's
    // quickExport goes through this resolver too, so viewer and export agree.
    expect(speakerHex(order, { SPEAKER_01: -1 }, "SPEAKER_01")).toBe(
      DEFAULT_SPEAKER_COLORS[DEFAULT_SPEAKER_COLORS.length - 1],
    );
    // colorOf receives picks as explicit hexes (the wire format callers
    // build via speakerHex) — the emitted <font color> matches slot 5 (teal).
    const out = generateExport(RESULT, {
      format: "srt",
      speakerColors: "line",
      colors: { SPEAKER_01: speakerHex(order, picks, "SPEAKER_01") },
    });
    expect(out).toContain(`<font color="${DEFAULT_SPEAKER_COLORS[5]}">Speaker 2: General greeting.</font>`);
    expect(DEFAULT_SPEAKER_COLORS[5]).toBe("#4dd0c4");
  });
});

describe("kept-original translations (quality guard)", () => {
  // Segment 2's "de" entry carries the SOURCE text — flagged translationsKept.
  const KEPT: BatchResult = {
    ...RESULT,
    translation: { targets: ["de"] },
    segments: [
      { start: 0.4, end: 2.0, text: " Hello there.", speaker: "SPEAKER_00",
        translations: { de: "Hallo." } },
      { start: 2.1, end: 3.8, text: " General greeting.", speaker: "SPEAKER_01",
        translations: { de: " General greeting." }, translationsKept: ["de"] },
    ],
  };

  it("srt keeps the original line but never emits the kept 'translation'", () => {
    const out = generateExport(KEPT, { format: "srt", tracks: ["orig", "de"] });
    expect(out).toContain("Hallo.");
    // The kept segment's text appears exactly once — as the original line.
    expect(out.match(/General greeting\./g)).toHaveLength(1);
  });

  it("translated-only tracks drop the kept segment entirely (vtt/txt/lrc)", () => {
    const vtt = generateExport(KEPT, { format: "vtt", tracks: ["de"] });
    expect(vtt).toContain("Hallo.");
    expect(vtt).not.toContain("General greeting");
    const txt = generateExport(KEPT, { format: "txt", tracks: ["de"] });
    expect(txt).toContain("Hallo.");
    expect(txt).not.toContain("General greeting");
    const lrc = generateExport(KEPT, { format: "lrc", tracks: ["de"] });
    expect(lrc).toContain("Hallo.");
    expect(lrc).not.toContain("General greeting");
  });

  it("json carries the marker (full-data format)", () => {
    const j = JSON.parse(generateExport(KEPT, { format: "json" }));
    expect(j.segments[1].translationsKept).toEqual(["de"]);
    expect(j.segments[0].translationsKept).toBeUndefined();
  });

  it("cps warnings skip kept lines", () => {
    const long = {
      ...KEPT,
      segments: KEPT.segments!.map((s, i) =>
        i === 1 ? { ...s, translations: { de: "x".repeat(200) } } : s,
      ),
    };
    expect(cpsWarnings(long, { tracks: ["de"] })).toEqual([]);
  });

  it("cps warnings are silent when the source carried no timing (synthesized 1 s clocks)", () => {
    const synth: BatchResult = {
      ...KEPT,
      timingSynthesized: true,
      segments: [{ start: 0, end: 1, text: "Hello there.", translations: { de: "x".repeat(60) } }],
    };
    expect(cpsWarnings(synth, { tracks: ["de"] })).toEqual([]);
  });

  it("json says when the clocks are synthesized, and only then", () => {
    const synth: BatchResult = { ...KEPT, timingSynthesized: true };
    expect(JSON.parse(generateExport(synth, { format: "json" })).timingSynthesized).toBe(true);
    expect(JSON.parse(generateExport(KEPT, { format: "json" }))).not.toHaveProperty("timingSynthesized");
  });
});

// With ONE target a language marker is redundant; with two, every format (VTT cue class,
// SRT/TXT tag, TXT block) and the file name must say which language each line is.

const TWO_TARGETS: BatchResult = {
  ...RESULT,
  segments: RESULT.segments!.map((s, i) => ({
    ...s,
    translations: {
      de: i === 0 ? "Hallo zusammen." : "Allgemeine Begrüßung.",
      fr: i === 0 ? "Salut à tous." : "Salutation générale.",
    },
  })),
  translation: {
    model: "m", targets: ["de", "fr"], source: "en", mode: "fluent",
  },
};

describe("multi-target language tagging", () => {
  it("txt with timestamps and translations only carries the time on every line", () => {
    const out = generateExport(TRANSLATED, { format: "txt", timestamps: true, tracks: ["de"] });
    for (const line of out.split("\n").filter(Boolean)) expect(line).toMatch(/^\[\d\d:\d\d\] /);
    const both = generateExport(TRANSLATED, { format: "txt", timestamps: true, tracks: ["orig", "de"] });
    expect(both.split("\n").filter((l) => l.startsWith("        ")).length).toBeGreaterThan(0);
  });
  it("lrc file names stay distinct for codes whose slug is empty", () => {
    const names = exportFileNames({ format: "lrc", tracks: ["orig", "!!", "??"] }).map((n) => n("out"));
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe("out.lrc");
  });
  const two = { tracks: ["orig", "de", "fr"] };

  it("srt: tags each translated line, since SRT has no class mechanism", () => {
    const out = generateExport(TWO_TARGETS, { format: "srt", ...two });
    expect(out).toContain("[DE] Hallo zusammen.");
    expect(out).toContain("[FR] Salut à tous.");
    // The original is never tagged — it is identified by position and by not
    // being a translation.
    expect(out).toContain("Speaker 1: Hello there.");
  });

  it("srt: a single target stays untagged, and its original lines are byte-identical", () => {
    const one = generateExport(TRANSLATED, { format: "srt", tracks: ["orig", "de"] });
    expect(one).not.toContain("[DE]");
    // Strip the (untagged) translated lines: what remains must be the untranslated render.
    const de = TRANSLATED.segments!.map((s) => s.translations!.de);
    const origOnly = one
      .split("\n")
      .filter((l) => !de.some((t) => l.endsWith(t)))
      .join("\n");
    expect(origOnly).toBe(generateExport(RESULT, { format: "srt" }));
  });

  it("vtt: emits a distinct cue class per language", () => {
    const out = generateExport(TWO_TARGETS, { format: "vtt", ...two });
    expect(out).toContain("::cue(.mt-de)");
    expect(out).toContain("::cue(.mt-fr)");
    // .mt is still emitted, so a player styling only that keeps working.
    expect(out).toContain("::cue(.mt) { color: #4dd0c4; }");
    expect(out).toContain("<c.mt.mt-de");
    expect(out).toContain("<c.mt.mt-fr");
  });

  it("vtt: a single target keeps the plain .mt class", () => {
    const out = generateExport(TRANSLATED, { format: "vtt", tracks: ["orig", "de"] });
    expect(out).not.toContain(".mt-de");
    expect(out).toContain("<c.mt>");
  });

  it("txt translations-only: one block per language, not one sentence stream", () => {
    const out = generateExport(TWO_TARGETS, {
      format: "txt", tracks: ["de", "fr"], speakerNames: false,
    });
    expect(out).not.toMatch(/Hallo zusammen\. Salut/);
    expect(out).toContain("[DE]");
    expect(out).toContain("[FR]");
    // Every paragraph is tagged, and no paragraph mixes two languages.
    // (Paragraphs group by speaker TURN, so the tracks alternate per turn
    // rather than forming two document-length blocks.)
    const paras = out.trim().split("\n\n");
    expect(paras.length).toBeGreaterThan(1);
    for (const para of paras) {
      expect(para).toMatch(/^\[(DE|FR)\] /);
      const isDe = para.startsWith("[DE]");
      expect(para.includes("Salut") || para.includes("Salutation")).toBe(!isDe);
    }
  });

  it("txt with timestamps: tags the indented translated lines", () => {
    const out = generateExport(TWO_TARGETS, {
      format: "txt", timestamps: true, ...two,
    });
    expect(out).toContain("[DE] ");
    expect(out).toContain("[FR] ");
  });

  it("file name carries every language, not just a lone one", () => {
    expect(exportStemSuffix(["de", "fr"])).toBe(".de+fr");
    expect(exportStemSuffix(["de"])).toBe(".de");
    expect(exportStemSuffix(["orig", "de"])).toBe("");
    expect(exportStemSuffix(undefined)).toBe("");
  });

  it("a hostile language code cannot break the cue markup or a path", () => {
    // Target codes are user-editable settings and come from synced backends.
    const evil: BatchResult = {
      ...RESULT,
      segments: RESULT.segments!.map((s) => ({
        ...s,
        translations: { de: "Hallo.", "x>.<y z": "Boom." },
      })),
    };
    const out = generateExport(evil, {
      format: "vtt", tracks: ["orig", "de", "x>.<y z"],
    });
    expect(out).not.toMatch(/::cue\(\.mt-[^)]*[>.< ]/);
    expect(out).toContain("::cue(.mt-xyz)");
    expect(exportStemSuffix(["de", "x>.<y z"])).toBe(".de+xyz");
  });
});

describe("exportFileNames (names without content)", () => {
  it("matches generateExports' names for every shape", () => {
    const shapes: ExportOptions[] = [
      { format: "lrc", tracks: ["orig", "de"] },
      { format: "lrc", tracks: ["de"] },
      { format: "srt", tracks: ["orig", "de"] },
      { format: "json" },
    ];
    for (const opts of shapes) {
      expect(exportFileNames(opts).map((n) => n("clip"))).toEqual(
        generateExports(TRANSLATED, opts).map((f) => f.name("clip")),
      );
    }
  });
});

describe("lrc word tags", () => {
  it("a word on an exact segment boundary is tagged once, on the segment it starts", () => {
    const r: BatchResult = {
      text: "a b",
      segments: [
        { start: 0, end: 1, text: "a" },
        { start: 1, end: 2, text: "b" },
      ],
      words: [
        { word: "a", start: 0, end: 1 },
        { word: "b", start: 1, end: 2 },
      ],
    };
    const out = generateExport(r, { format: "lrc", wordTimestamps: true });
    expect(out.split("<00:01.00>").length - 1).toBe(1);
    expect(out).toContain("[00:01.00]<00:01.00>b");
  });
  it("unspaced (CJK) words are tagged without a space between them", () => {
    const r: BatchResult = {
      text: "今日は晴れ",
      language: "ja",
      segments: [{ start: 0, end: 1.5, text: "今日は晴れ" }],
      words: [
        { word: "今日", start: 0, end: 0.5 },
        { word: "は", start: 0.5, end: 1 },
        { word: "晴れ", start: 1, end: 1.5 },
      ],
    };
    expect(generateExport(r, { format: "lrc", wordTimestamps: true }))
      .toBe("[00:00.00]<00:00.00>今日<00:00.50>は<00:01.00>晴れ\n");
  });
  it("one Latin word in a CJK line keeps its spaces, the CJK seams stay joined", () => {
    const ja = ["これは", "iPhone", "の", "新しい", "機能", "です"];
    const r: BatchResult = {
      text: "これは iPhone の新しい機能です",
      language: "ja",
      segments: [{ start: 0, end: 3, text: "これは iPhone の新しい機能です" }],
      words: ja.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 })),
    };
    expect(generateExport(r, { format: "lrc", wordTimestamps: true }))
      .toBe("[00:00.00]<00:00.00>これは <00:00.50>iPhone <00:01.00>の<00:01.50>新しい<00:02.00>機能<00:02.50>です\n");
  });
  it("a segment without whitespace joins every tag without a space (Thai, CJK + digits)", () => {
    const one = (text: string, ws: string[]): BatchResult => ({
      text,
      segments: [{ start: 0, end: ws.length * 0.5, text }],
      words: ws.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 })),
    });
    expect(generateExport(one("สวัสดีครับ", ["สวัสดี", "ครับ"]), { format: "lrc", wordTimestamps: true }))
      .toBe("[00:00.00]<00:00.00>สวัสดี<00:00.50>ครับ\n");
    expect(generateExport(one("今年是2024年", ["今年", "是", "2024", "年"]), { format: "lrc", wordTimestamps: true }))
      .toBe("[00:00.00]<00:00.00>今年<00:00.50>是<00:01.00>2024<00:01.50>年\n");
  });
  it("a spaced Thai line takes its seams from the text: a space only where the text has one", () => {
    const ws = ["สวัสดี", "ครับ", " ผม", "ชื่อ"];
    const r: BatchResult = {
      text: "สวัสดีครับ ผมชื่อ",
      language: "th",
      segments: [{ start: 0, end: 2, text: "สวัสดีครับ ผมชื่อ" }],
      words: ws.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 })),
    };
    expect(generateExport(r, { format: "lrc", wordTimestamps: true }))
      .toBe("[00:00.00]<00:00.00>สวัสดี<00:00.50>ครับ <00:01.00>ผม<00:01.50>ชื่อ\n");
  });
  it("a word the text does not hold falls back to the script rule for its seams", () => {
    const r: BatchResult = {
      text: "Hello there",
      segments: [{ start: 0, end: 1, text: "Hello there" }],
      words: [
        { word: " Hallo", start: 0, end: 0.5 },
        { word: " there", start: 0.5, end: 1 },
      ],
    };
    expect(generateExport(r, { format: "lrc", wordTimestamps: true }))
      .toBe("[00:00.00]<00:00.00>Hallo <00:00.50>there\n");
  });
});

describe("joinSegmentTexts", () => {
  it("spaces spaced text, joins CJK seams, spaces a Latin/CJK seam", () => {
    expect(joinSegmentTexts(["Hello there.", "How are you?"])).toBe("Hello there. How are you?");
    expect(joinSegmentTexts(["今日は晴れ。", "明日は雨。"])).toBe("今日は晴れ。明日は雨。");
    expect(joinSegmentTexts(["今日は", "iPhone"])).toBe("今日は iPhone");
  });

  it("joins a seam after the kana marks ー and ・ unspaced (they are Script=Common)", () => {
    expect(joinSegmentTexts(["新しいサーバー", "に接続しました。"])).toBe("新しいサーバーに接続しました。");
    expect(joinSegmentTexts(["そうですねー", "次は東京です"])).toBe("そうですねー次は東京です");
    expect(joinSegmentTexts(["コーヒー", "ください"])).toBe("コーヒーください");
    expect(joinSegmentTexts(["サーバー", "OK"])).toBe("サーバー OK");
  });

  it("keeps the seam rules with empty parts, mixed scripts and astral chars", () => {
    expect(joinSegmentTexts(["日", "", "本"])).toBe("日本");
    expect(joinSegmentTexts(["日本", "abc", "語"])).toBe("日本 abc 語");
    expect(joinSegmentTexts(["𠀋", "日"])).toBe("𠀋日");
    // A trailing combining mark / variation selector: the base character judges the seam.
    expect(joinSegmentTexts(["今日はか\u3099", "次"])).toBe("今日はか\u3099次");
    expect(joinSegmentTexts(["葛\u{E0100}", "城"])).toBe("葛\u{E0100}城");
    const latin = ["one", "two", "", "three"];
    expect(joinSegmentTexts(latin)).toBe(latin.filter(Boolean).join(" "));
  });

  it("skips an empty part: no double, leading or trailing space", () => {
    expect(joinSegmentTexts(["Hello", "", "world"])).toBe("Hello world");
    expect(joinSegmentTexts(["", "world"])).toBe("world");
    expect(joinSegmentTexts(["world", ""])).toBe("world");
    expect(joinSegmentTexts(["", ""])).toBe("");
  });

  it("skips a format-character-only part (a bare U+200E survives trim)", () => {
    expect(joinSegmentTexts(["a", "\u200e", "b"])).toBe("a b");
    expect(joinSegmentTexts(["你好", "\u200e", "世界"])).toBe("你好世界");
    expect(joinSegmentTexts(["a", "\u200e \u200f", "b"])).toBe("a b");
    // Hangul fillers are category Lo, yet the output strips them: still a blank part.
    expect(joinSegmentTexts(["a", "\u3164\u115f", "b"])).toBe("a b");
  });

  it("judges a CJK seam past an edge format character the caller's trim() kept", () => {
    expect(stripControlChars(joinSegmentTexts(["你好\u200e", "世界"]))).toBe("你好世界");
    expect(stripControlChars(joinSegmentTexts(["你好", "\u200b世界"]))).toBe("你好世界");
  });
});

const GLACIER =
  "The glacier behind me has lost almost forty percent of its volume since 1980. " +
  "The scientists who measure it every summer say the pace is still accelerating.";
const GLACIER_WORDS = GLACIER.split(" ");
/** One 12 s diarized segment with evenly spread word timings and two targets. */
const CUED: BatchResult = {
  text: GLACIER,
  language: "en",
  speakers: ["SPEAKER_00"],
  segments: [{
    start: 10, end: 22, text: " " + GLACIER, speaker: "SPEAKER_00",
    translations: {
      de: "Der Gletscher hinter mir hat seit 1980 fast vierzig Prozent seines Volumens verloren. " +
        "Die Forscher, die ihn jeden Sommer messen, sagen, dass es immer schneller geht.",
      fr: "Le glacier derrière moi a perdu près de quarante pour cent de son volume depuis 1980. " +
        "Les scientifiques qui le mesurent chaque été disent que le rythme s'accélère encore.",
    },
  }],
  words: GLACIER_WORDS.map((w, i) => ({ word: " " + w, start: 10 + i * 0.44, end: 10 + i * 0.44 + 0.4 })),
};
const STANDARD = { length: "standard", timing: "same" } as const;

describe("subtitle cues", () => {
  it("a cue's lines pair a quote with its partner in the next cue of the segment", () => {
    // Wrapped alone (after its "Speaker 1: "), a cue's opening quote would lose its partner and
    // end the line on 说".
    for (const zh of ['今天下午他终于对我说"我今天真的很累很累，想早点回家休息一下"然后就走了', '冰川失去了四成体积，科学家们说"速度还在加快"然后离开了']) {
      const r: BatchResult = { ...CUED, segments: [{ ...CUED.segments![0], translations: { zh } }] };
      for (const format of ["srt", "vtt"] as const) {
        const out = generateExport(r, { format, tracks: ["zh"], cues: STANDARD });
        expect(out.split("\n").some((l) => /说"(?:<\/c>)?$/.test(l)), out).toBe(false);
      }
    }
  });

  it("the export wraps a cue's lines with its track's language, as the cue split judged them", () => {
    const text = "He was told 12. Then they all moved to Bern in May";
    const words = text.split(" ").map((w, i) => ({ word: " " + w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const r: BatchResult = { text, language: "en", segments: [{ start: 0, end: 6, text: " " + text }], words };
    expect(cueGrid(r, { format: "srt", cues: STANDARD }, ["orig"]).cues).toHaveLength(1);
    // English: "12." ends a sentence, so the line ends there too.
    expect(generateExport(r, { format: "srt", tracks: ["orig"], cues: STANDARD }))
      .toContain("He was told 12.\nThen they all moved to Bern in May");
  });

  it("no cue options ⇒ one cue per segment, unwrapped (the pre-cue output)", () => {
    const out = generateExport(CUED, { format: "srt", tracks: ["orig", "de"] });
    expect(out.split("\n\n").filter(Boolean)).toHaveLength(1);
    expect(out).toContain(`Speaker 1: ${GLACIER}`);
  });

  it("srt: split cues, wrapped lines inside the <font> span, [DE]/[FR] tags kept first", () => {
    const out = generateExport(CUED, {
      format: "srt", tracks: ["orig", "de", "fr"], speakerColors: "line", cues: STANDARD,
    });
    expect(out.startsWith(
      "1\n00:00:10,000 --> 00:00:13,080\n" +
      '<font color="#ff9e2c">Speaker 1: The glacier\nbehind me has lost almost</font>\n' +
      '<font color="#ff9e2c">Speaker 1: [DE] Der Gletscher\nhinter mir hat seit 1980</font>\n' +
      '<font color="#ff9e2c">Speaker 1: [FR] Le glacier\nderrière moi a perdu près</font>\n\n' +
      "2\n00:00:13,080 --> 00:00:16,160\n" +
      '<font color="#ff9e2c">Speaker 1: forty percent\nof its volume since 1980.</font>\n' +
      '<font color="#ff9e2c">Speaker 1: [DE] fast vierzig\nProzent seines Volumens verloren.</font>\n',
    )).toBe(true);
    for (const cue of out.trim().split("\n\n")) {
      const lines = cue.split("\n").slice(2).map((l) => l.replace(/<[^>]+>/g, ""));
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    }
  });

  it("vtt: the wrapped line break stays inside the <c> span", () => {
    const out = generateExport(CUED, {
      format: "vtt", tracks: ["orig", "de"], speakerColors: "line", cues: STANDARD,
    });
    expect(out).toContain(
      "00:00:10.000 --> 00:00:13.080\n" +
      "<c.spk1>Speaker 1: The glacier\nbehind me has lost almost</c>\n" +
      "<c.mt.spk1>Speaker 1: Der Gletscher\nhinter mir hat seit 1980</c>\n",
    );
  });

  it("own timing: stem.srt + stem.de.srt, each language on its own cues", () => {
    const files = generateExports(CUED, {
      format: "srt", tracks: ["orig", "de"], cues: { ...STANDARD, timing: "own" },
    });
    expect(files.map((f) => f.name("stem"))).toEqual(["stem.srt", "stem.de.srt"]);
    expect(files[0].content).not.toContain("Gletscher");
    expect(files[1].content).not.toContain("glacier");
    expect(files[1].content).toMatch(/^1\n00:00:10,000 --> /);
    expect(files[1].content).toContain("--> 00:00:22,000\n");
    expect(exportFileNames({ format: "srt", tracks: ["orig", "de"], cues: { ...STANDARD, timing: "own" } })
      .map((n) => n("stem"))).toEqual(["stem.srt", "stem.de.srt"]);
  });

  it("lrc names stay byte-identical with cue options", () => {
    const names = exportFileNames({ format: "lrc", tracks: ["orig", "de"], cues: { ...STANDARD, timing: "own" } });
    expect(names.map((n) => n("talk"))).toEqual(["talk.lrc", "talk.de.lrc"]);
  });

  it("a site track gets its own file, on its own cues, in every format", () => {
    const site: BatchResult = {
      ...CUED,
      timedTracks: [{
        id: "de-x-site", lang: "de", source: "site", kind: "manual",
        cues: [{ start: 10.5, end: 12, text: "Hallo zusammen." }, { start: 12.5, end: 14, text: "Grüezi." }],
      }],
    };
    const srt = generateExports(site, { format: "srt", tracks: ["orig", "fr", "de-x-site"] });
    expect(srt.map((f) => f.name("s"))).toEqual(["s.srt", "s.de.srt"]);
    expect(srt[1].content).toBe("1\n00:00:10,500 --> 00:00:12,000\nHallo zusammen.\n\n2\n00:00:12,500 --> 00:00:14,000\nGrüezi.\n");
    expect(srt[0].content).toContain("Le glacier");
    // A machine translation into the same language keeps the plain name.
    expect(exportFileNames({ format: "vtt", tracks: ["de", "de-x-site"] }, site).map((n) => n("s")))
      .toEqual(["s.de.vtt", "s.Site.de.vtt"]);
    const txt = generateExports(site, { format: "txt", tracks: ["de-x-site"] });
    expect(txt[0].content).toBe("Hallo zusammen. Grüezi.\n");
    // A site's own subtitles are not machine translation: no .mt STYLE, no .mt class.
    const vtt = generateExports(site, { format: "vtt", tracks: ["orig", "fr", "de-x-site"] });
    expect(vtt[1].content).not.toContain("::cue(.mt");
    expect(vtt[1].content).not.toContain("<c.mt");
    expect(vtt[1].content).toContain("00:00:10.500 --> 00:00:12.000\nHallo zusammen.\n");
    expect(vtt[0].content).toContain("::cue(.mt)");
    const json = JSON.parse(generateExport(site, { format: "json" }));
    expect(json.timedTracks[0]).toEqual({
      id: "de-x-site", lang: "de", source: "site", kind: "manual",
      cues: [{ start: 10.5, end: 12, text: "Hallo zusammen." }, { start: 12.5, end: 14, text: "Grüezi." }],
    });
  });

  it("preview: the first n subtitles of one file, counted against that file", () => {
    const site: BatchResult = {
      ...CUED,
      timedTracks: [{
        id: "de-x-site", lang: "de", source: "site", kind: "manual",
        cues: [1, 2, 3, 4].map((i) => ({ start: i, end: i + 0.5, text: `Satz ${i}` })),
      }],
    };
    const orig = previewExport(site, { format: "srt", tracks: ["orig"], cues: STANDARD }, 2);
    const all = cueGrid(site, { format: "srt", cues: STANDARD }, ["orig"]).cues.length;
    expect(orig.total).toBe(all);
    expect(orig.count).toBe(all); // one segment: all its cues come along
    expect(orig.text).toContain("00:00:10,000");
    const own = previewExport(site, { format: "srt", tracks: ["de-x-site"] }, 2);
    expect([own.count, own.total]).toEqual([2, 4]);
    expect(own.text).toContain("Satz 2");
    expect(own.text).not.toContain("Satz 3");
    const txt = previewExport(CUED, { format: "txt", tracks: ["orig", "de"] }, 12);
    expect([txt.count, txt.total]).toEqual([1, 1]);
  });

  it("the preview's last segment never takes the next segment's boundary word", () => {
    const w0 = "This is a fairly long first line that keeps going on and on so that the cue splitter has to cut it into more than one subtitle".split(" ");
    const w1 = ["Second", "line", "here."];
    const r: BatchResult = {
      text: ` ${w0.join(" ")} ${w1.join(" ")}`,
      segments: [
        { start: 0, end: 8, text: ` ${w0.join(" ")}` },
        { start: 8, end: 10, text: ` ${w1.join(" ")}` },
      ],
      words: [
        ...w0.map((w, i) => ({ word: ` ${w}`, start: (i * 8) / w0.length, end: ((i + 1) * 8) / w0.length })),
        ...w1.map((w, i) => ({ word: ` ${w}`, start: 8 + i * 0.6, end: 8 + (i + 1) * 0.6 })),
      ],
    };
    const opts: ExportOptions = { format: "srt", cues: STANDARD };
    const preview = previewExport(r, opts, 1).text;
    // Split like the saved file: the first segment's cues, then the file goes on.
    expect(generateExport(r, opts).startsWith(preview)).toBe(true);
    expect(preview).toContain("\n\n2\n");
    const lrc = previewExport(r, { format: "lrc", wordTimestamps: true }, 1).text;
    expect(lrc).not.toContain("Second");
  });

  it("the TXT preview keeps the text's own spacing (CJK has none between sentences)", () => {
    const zh: BatchResult = {
      text: "你好。世界。",
      language: "zh",
      segments: [{ start: 0, end: 1, text: "你好。" }, { start: 1, end: 2, text: "世界。" }],
    };
    expect(previewExport(zh, { format: "txt" }, 12).text).toBe(generateExport(zh, { format: "txt" }));
    expect(previewExport(zh, { format: "txt" }, 1).text).toBe("你好。\n");
  });

  it("the TXT preview's fallback (a segment not found in the text) joins like the export", () => {
    const zh: BatchResult = {
      text: "edited",
      language: "zh",
      segments: [{ start: 0, end: 1, text: "你好。" }, { start: 1, end: 2, text: " " }, { start: 2, end: 3, text: "世界。" }, { start: 3, end: 4, text: "再见。" }],
    };
    // Two cues (the blank segment has none) = the first three segments.
    expect(previewExport(zh, { format: "txt" }, 2).text).toBe("你好。世界。\n");
  });

  it("a single translation's TXT/LRC preview counts the lines its file writes", () => {
    const r: BatchResult = {
      text: " Line 0 Line 1 Line 2",
      segments: [0, 1, 2].map((i) => ({
        start: i, end: i + 1, text: ` Line ${i}`, translations: { de: i < 2 ? `Zeile ${i}` : "\u200b" },
      })),
    };
    for (const format of ["lrc", "txt"] as const) {
      const p = previewExport(r, { format, tracks: ["de"] }, 2);
      expect([p.count, p.total]).toEqual([2, 2]); // the format-mark line is never written
    }
  });

  it("a multi-translation TXT preview never counts a segment whose translations clean to nothing", () => {
    const r: BatchResult = {
      text: " Line 0 Line 1 Line 2",
      segments: [0, 1, 2].map((i) => ({
        start: i, end: i + 1, text: ` Line ${i}`,
        translations: (i === 1 ? { de: "\u200b" } : { de: `Zeile ${i}`, fr: `Ligne ${i}` }) as Record<string, string>,
      })),
    };
    for (const timestamps of [true, false]) {
      const opts: ExportOptions = { format: "txt", tracks: ["de", "fr"], timestamps };
      const p = previewExport(r, opts, 2);
      expect([p.count, p.total]).toEqual([2, 2]); // the format-mark segment writes no line
      expect(p.text).toBe(generateExport(r, opts));
    }
  });

  it("an original-carrying LRC / timestamped TXT preview counts a blank segment's bare stamp", () => {
    const r: BatchResult = {
      text: " A B",
      segments: ["A", "B", ""].map((text, i) => ({ start: i, end: i + 1, text })),
    };
    for (const opts of [{ format: "lrc" }, { format: "txt", timestamps: true }] as ExportOptions[]) {
      const two = previewExport(r, opts, 2);
      expect([two.count, two.total]).toEqual([2, 3]); // so it says "start of the file"
      const all = previewExport(r, opts, 12);
      expect(all.total).toBe(3);
      expect(all.text).toBe(generateExport(r, opts));
      expect(all.text.trimEnd().split("\n")).toHaveLength(3);
    }
  });

  it("a JSON preview counts every segment whatever the track pick", () => {
    const r: BatchResult = {
      text: " Line 0 Line 1 Line 2",
      segments: [0, 1, 2].map((i) => ({
        start: i, end: i + 1, text: ` Line ${i}`, ...(i === 0 ? { translations: { de: "Zeile 0" } } : {}),
      })),
    };
    const p = previewExport(r, { format: "json", tracks: ["de"] }, 1);
    expect([p.count, p.total]).toEqual([1, 3]);
    expect(previewExport(r, { format: "json", tracks: ["de"] }, 12).total).toBe(3);
  });

  it("preview and cps reuse a grid the caller already built", () => {
    const opts: ExportOptions = { format: "srt", tracks: ["orig"], cues: STANDARD };
    const grid = cueGrid(CUED, opts, ["orig"]);
    expect(previewExport(CUED, opts, 2, grid)).toEqual(previewExport(CUED, opts, 2));
    expect(cpsWarnings(CUED, opts, grid)).toEqual(cpsWarnings(CUED, opts));
  });

  it("json strips control characters from timed tracks", () => {
    const evil: BatchResult = {
      ...RESULT,
      timedTracks: [{ id: "de‮", lang: "de", label: "x‮y", source: "site", kind: "auto",
        cues: [{ start: 0, end: 1, text: "a‮b" }] }],
    };
    const j = JSON.parse(generateExport(evil, { format: "json" }));
    expect(j.timedTracks[0]).toMatchObject({ id: "de", label: "xy", cues: [{ text: "ab" }] });
  });

  it("cps runs on the cues, original included, against each language's limit", () => {
    const fast: BatchResult = {
      text: "x", language: "de",
      segments: [{ start: 0, end: 1, text: "Achtzehn Zeichen!!", translations: { en: "Nineteen chars here" } }],
    };
    // 18 chars/s: over German's 17, under English's 20.
    expect(cpsWarnings(fast, { tracks: ["orig", "en"], cues: STANDARD })).toEqual([{ lang: "orig", index: 0, cps: 18 }]);
    expect(cpsWarnings(fast, { tracks: ["orig", "en"] })).toEqual([]);
    expect(cpsWarnings(CUED, { tracks: ["orig", "de", "fr"], cues: STANDARD })).toEqual([]);
  });

  it("cps skips a cue of only format characters, which no file or lane writes", () => {
    const marks: BatchResult = {
      text: "x", language: "en",
      segments: [{ start: 0, end: 0.1, text: "Hi.", translations: { de: "\u200B\u200B\u200B" } }],
      timedTracks: [{
        id: "de-x-site", lang: "de", source: "site", kind: "manual",
        cues: [{ start: 0, end: 0.1, text: "\u200B\u200B\u200B" }],
      }],
    };
    expect(cpsWarnings(marks, { tracks: ["de"] })).toEqual([]);
    expect(cpsWarnings(marks, { tracks: ["de-x-site"] })).toEqual([]);
  });
});

/** A blank middle segment, an untranslated one and a translation of only a zero-width space. */
const GAPPY: BatchResult = {
  text: "Hello there. General greeting. Last one.",
  language: "en",
  segments: [
    { start: 0, end: 1, text: " Hello there.", translations: { de: "Hallo." } },
    { start: 1, end: 2, text: " " },
    { start: 2, end: 3, text: " General greeting.", translations: { de: "\u200B" } },
    { start: 3, end: 4, text: " Last one." },
  ],
};
const cueBlocks = (out: string) => out.split("\n").filter((l) => l.includes(" --> ")).length;

describe("writesCue / writtenCues (what one subtitle file writes)", () => {
  it("the original rides: every cue, even a blank one; translations alone: only a real line", () => {
    const grid = cueGrid(GAPPY, { format: "srt" }, ["orig", "de"]);
    expect(grid.cues.map((c) => writesCue(c, ["orig"]))).toEqual([true, true, true, true]);
    expect(grid.cues.map((c) => writesCue(c, ["orig", "de"]))).toEqual([true, true, true, true]);
    // Untranslated, and a format-character-only translation the writer cleans away.
    expect(grid.cues.map((c) => writesCue(c, ["de"]))).toEqual([true, false, false, false]);
  });

  it("preview totals match the cue blocks the file writes", () => {
    for (const format of ["srt", "vtt"] as const) {
      for (const cues of [undefined, STANDARD]) {
        for (const tracks of [["orig"], ["orig", "de"], ["de"]]) {
          const opts: ExportOptions = { format, tracks, cues };
          const written = cueBlocks(generateExport(GAPPY, opts));
          expect(previewExport(GAPPY, opts, 12).total).toBe(written);
          expect(writtenCues(cueGrid(GAPPY, opts, tracks), tracks)).toHaveLength(written);
        }
      }
    }
    expect(previewExport(GAPPY, { format: "srt", tracks: ["orig"] }, 12).total).toBe(4);
    expect(previewExport(GAPPY, { format: "srt", tracks: ["de"] }, 12).total).toBe(1);
  });

  it("a single own-timed track counts its own cues that clean to a line", () => {
    const site: BatchResult = {
      ...GAPPY,
      timedTracks: [{
        id: "de-x-site", lang: "de", source: "site", kind: "manual",
        cues: [{ start: 0, end: 1, text: "Hallo." }, { start: 1, end: 2, text: "\u200E" }],
      }],
    };
    const siteOpts: ExportOptions = { format: "srt", tracks: ["de-x-site"] };
    expect(writtenCues(cueGrid(site, siteOpts, ["de-x-site"]), ["de-x-site"]).map((c) => c.text)).toEqual(["Hallo."]);
    expect(cueBlocks(generateExport(site, siteOpts))).toBe(1);
    expect(previewExport(site, siteOpts, 12).total).toBe(1);
    // A translation under own timing: the zero-width-only cue is dropped as well.
    const own: ExportOptions = { format: "srt", tracks: ["de"], cues: { ...STANDARD, timing: "own" } };
    expect(writtenCues(cueGrid(GAPPY, own, ["de"]), ["de"])).toHaveLength(1);
    expect(cueBlocks(generateExport(GAPPY, own))).toBe(1);
    expect(previewExport(GAPPY, own, 12).total).toBe(1);
  });
});

describe("exportOptionsFor (the panel's and History's one builder)", () => {
  const toggles = { showTs: true, showNames: false, colorize: true, wordTs: true };
  it("maps the display toggles and resolves the palette picks to hexes", () => {
    const o = exportOptionsFor({
      format: "srt", speakers: ["SPEAKER_00", "SPEAKER_01"], renames: { SPEAKER_00: "Ann" },
      colorPicks: { SPEAKER_01: 3 }, toggles, cues: undefined, tracks: ["orig", "en"],
    });
    expect(o).toEqual({
      format: "srt", renames: { SPEAKER_00: "Ann" }, speakerColors: "line", speakerNames: false, timestamps: true,
      colors: { SPEAKER_00: DEFAULT_SPEAKER_COLORS[0], SPEAKER_01: DEFAULT_SPEAKER_COLORS[3] }, wordTimestamps: true, cues: undefined, tracks: ["orig", "en"],
    });
  });
  it("unpicked speakers keep the viewer's colour after an edit changes first appearance", () => {
    // An import carries no `speakers` list, so the fallback order is first appearance.
    const original: BatchResult = {
      text: "x", language: "en",
      segments: [
        { start: 0, end: 1, text: "One.", speaker: "A" },
        { start: 1, end: 2, text: "Two.", speaker: "B" },
      ],
    };
    const o = exportOptionsFor({
      format: "srt", speakers: speakerOrder(original), renames: {}, colorPicks: {},
      toggles: { showTs: false, showNames: false, colorize: true, wordTs: false }, cues: undefined,
    });
    const edited: BatchResult = {
      ...original,
      segments: (original.segments ?? []).map((s, i) => (i === 0 ? { ...s, speaker: "B" } : s)),
    };
    const out = generateExport(edited, o);
    expect(speakerHex(speakerOrder(original), {}, "B")).toBe(DEFAULT_SPEAKER_COLORS[1]);
    expect(out).toContain(DEFAULT_SPEAKER_COLORS[1]);
    expect(out).not.toContain(DEFAULT_SPEAKER_COLORS[0]);
  });
  it("no speakers → no colour mode; no tracks → the original only", () => {
    const o = exportOptionsFor({ format: "txt", speakers: [], renames: {}, colorPicks: {}, toggles, cues: undefined, tracks: [] });
    expect(o.speakerColors).toBe("off");
    expect("tracks" in o).toBe(false);
  });
});

describe("isSubtitleFormat", () => {
  it("only SRT and VTT carry subtitle cues (and ride with a video)", () => {
    expect(["srt", "vtt", "txt", "lrc", "json"].filter(isSubtitleFormat)).toEqual(["srt", "vtt"]);
  });
});

describe("cueGrid / tracksOf", () => {
  it("only subtitle formats split cues; no pick = the original only", () => {
    expect(cueGrid(CUED, { format: "srt", cues: STANDARD }, ["orig"]).cues.length).toBeGreaterThan(1);
    expect(cueGrid(CUED, { format: "txt", cues: STANDARD }, ["orig"]).cues).toHaveLength(1);
    expect(tracksOf({})).toEqual(["orig"]);
    expect(tracksOf({ tracks: ["en"] })).toEqual(["en"]);
  });
});

describe("speakerName (viewer, panel and exports)", () => {
  it("the rename, else the prettified label — a bidi-only rename never blanks it", () => {
    expect(speakerName({ SPEAKER_00: "  Ann\n Lee " }, "SPEAKER_00")).toBe("Ann Lee");
    expect(speakerName({ SPEAKER_00: "\u202e\u200f" }, "SPEAKER_00")).toBe("Speaker 1");
    expect(speakerName(undefined, "SPEAKER_01")).toBe("Speaker 2");
  });
  it("a label spelled like an Object.prototype member reads as unrenamed", () => {
    expect(() => speakerName({}, "constructor")).not.toThrow();
    expect(speakerName({}, "constructor")).toBe(speakerName(undefined, "constructor"));
    expect(() => speakerName({}, "toString")).not.toThrow();
  });
});
