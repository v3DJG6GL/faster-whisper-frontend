// Unit tests for the pure transcript-export generators. These run in plain
// node (no Tauri, no DOM) — exactly why the generators live in src/lib.

import { describe, expect, it } from "vitest";
import {
  cpsWarnings, cueGrid, previewExport, DEFAULT_SPEAKER_COLORS, exportFileNames, exportOptionsFor, exportStemSuffix, generateExport, isSubtitleFormat, speakerName, tracksOf,
  generateExports,
  prettySpeaker, speakerColorIndex, speakerHex, speakerOrder,
  type ExportOptions,
} from "./transcriptFormats";
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

// ── T2T multi-track exports ─────────────────────────────────────────────────

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
    // The regression: a saved pick {"SPEAKER_01": 5} exported teal but
    // rendered amber (viewer read picks under a different key). With one
    // resolver, the viewer's palette index and the hex colorOf emits for the
    // SAME order+picks must always point at the same palette slot.
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
});

// ── multi-target: the flattening bug ────────────────────────────────────────
//
// Every format emitted translated lines with no language marker, because
// cueLines dropped `lang` between two maps. With ONE target that is merely
// redundant; with two it makes the output unusable — VTT gave EN and FR the
// same cue class, TXT concatenated every language into one sentence stream,
// and the file name carried no language at all.

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
    // The bug: "Hallo zusammen. Salut à tous. Allgemeine…" — every language
    // interleaved into a single paragraph that is no language at all.
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
    // A 2+ target export returned "" here, so the one case where the name
    // matters most produced a file with no language in it at all.
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
});

// ── subtitle cues (D83/D84) ─────────────────────────────────────────────────

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
      colors: { SPEAKER_01: DEFAULT_SPEAKER_COLORS[3] }, wordTimestamps: true, cues: undefined, tracks: ["orig", "en"],
    });
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
    expect(speakerName({ SPEAKER_00: "  Ann\n Lee " }, "SPEAKER_00")).toBe("Ann  Lee");
    expect(speakerName({ SPEAKER_00: "\u202e\u200f" }, "SPEAKER_00")).toBe("Speaker 1");
    expect(speakerName(undefined, "SPEAKER_01")).toBe("Speaker 2");
  });
});
