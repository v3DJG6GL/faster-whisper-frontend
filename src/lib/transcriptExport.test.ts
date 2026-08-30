// Unit tests for the pure transcript-export generators. These run in plain
// node (no Tauri, no DOM) — exactly why the generators live in src/lib.

import { describe, expect, it } from "vitest";
import { generateExport, speakerOrder, prettySpeaker } from "./transcriptExport";
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
