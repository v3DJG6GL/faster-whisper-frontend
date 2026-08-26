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
      { label: "SPEAKER_00", name: "Speaker 1" },
      { label: "SPEAKER_01", name: "Reto" },
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
