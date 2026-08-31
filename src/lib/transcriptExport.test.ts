// Unit tests for the pure transcript-export generators. These run in plain
// node (no Tauri, no DOM) — exactly why the generators live in src/lib.

import { describe, expect, it } from "vitest";
import {
  cpsWarnings, DEFAULT_SPEAKER_COLORS, exportStemSuffix, generateExport,
  prettySpeaker, speakerColorIndex, speakerHex, speakerOrder,
} from "./transcriptExport";
import type { BatchResult } from "./types";

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
    const noWords: BatchResult = { ...RESULT, words: [] };
    const out = generateExport(noWords, { format: "lrc", wordTimestamps: true });
    expect(out).toContain("[00:00.40]Speaker 1: Hello there.");
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
  it("srt: trans-first flips the line order", () => {
    const out = generateExport(TRANSLATED, {
      format: "srt", tracks: ["orig", "de"], lineOrder: "trans-first",
    });
    expect(out).toContain("Speaker 1: Hallo zusammen.\nSpeaker 1: Hello there.");
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
  it("lrc with two tracks = one file per track, suffixed", async () => {
    const { generateExports } = await import("./transcriptExport");
    const files = generateExports(TRANSLATED, { format: "lrc", tracks: ["orig", "de"] });
    expect(files).toHaveLength(2);
    expect(files[0].name("talk")).toBe("talk.lrc");
    expect(files[1].name("talk")).toBe("talk.de.lrc");
    expect(files[1].content).toContain("Hallo zusammen.");
    expect(files[1].content).not.toContain("Hello there.");
  });
  it("single translated track suffixes the stem; orig included does not", async () => {
    const { exportStemSuffix } = await import("./transcriptExport");
    expect(exportStemSuffix(["de"])).toBe(".de");
    expect(exportStemSuffix(["orig", "de"])).toBe("");
    expect(exportStemSuffix(undefined)).toBe("");
  });
  it("cps flags only translated cues over 20 chars/sec", async () => {
    const { cpsWarnings } = await import("./transcriptExport");
    const slow = cpsWarnings(TRANSLATED, ["orig", "de"]);
    expect(slow).toEqual([]); // both cues are comfortably under 20 cps
    const fast: BatchResult = {
      ...TRANSLATED,
      segments: [{ start: 0, end: 1, text: "Hi.", translations: { de: "x".repeat(30) } }],
    };
    const warns = cpsWarnings(fast, ["de"]);
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
    expect(cpsWarnings(long, ["de"])).toEqual([]);
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
  const two = { tracks: ["orig", "de", "fr"] };

  it("srt: tags each translated line, since SRT has no class mechanism", () => {
    const out = generateExport(TWO_TARGETS, { format: "srt", ...two });
    expect(out).toContain("[DE] Hallo zusammen.");
    expect(out).toContain("[FR] Salut à tous.");
    // The original is never tagged — it is identified by position and by not
    // being a translation.
    expect(out).toContain("Speaker 1: Hello there.");
  });

  it("srt: a single target stays untagged and byte-identical", () => {
    const one = generateExport(TRANSLATED, { format: "srt", tracks: ["orig", "de"] });
    expect(one).not.toContain("[DE]");
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
    expect(out).not.toContain("::cue(.mt-x>");
    expect(out).toContain("::cue(.mt-xy-z)".replace("-z", "z"));
    expect(exportStemSuffix(["de", "x>.<y z"])).toBe(".de+xyz");
  });
});
