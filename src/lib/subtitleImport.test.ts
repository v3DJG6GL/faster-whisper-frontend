// Round-trip guards: what generateExport writes, parseImportedText reads back.
import { describe, expect, it } from "vitest";
import { generateExport } from "./transcriptExport";
import { isTextSourcePath, parseImportedText } from "./subtitleImport";
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

describe("isTextSourcePath", () => {
  it("accepts subtitle/text extensions, rejects media", () => {
    expect(isTextSourcePath("/a/b/talk.srt")).toBe(true);
    expect(isTextSourcePath("/a/b/talk.VTT")).toBe(true);
    expect(isTextSourcePath("/a/b/talk.lrc")).toBe(true);
    expect(isTextSourcePath("/a/b/notes.txt")).toBe(true);
    expect(isTextSourcePath("/a/b/talk.json")).toBe(true);
    expect(isTextSourcePath("/a/b/talk.mp3")).toBe(false);
    expect(isTextSourcePath("https://example.com/watch?v=x")).toBe(false);
  });
});

describe("round-trips against generateExport", () => {
  it("srt: cues, timing and speakers survive", () => {
    const srt = generateExport(RESULT, { format: "srt" });
    const back = parseImportedText("srt", srt);
    expect(back.segments).toHaveLength(2);
    expect(back.segments[0]).toMatchObject({
      start: 0.4, end: 2.0, text: "Hello there.", speaker: "Speaker 1",
    });
  });
  it("vtt: voice tags become speakers", () => {
    const vtt = generateExport(RESULT, { format: "vtt" });
    const back = parseImportedText("vtt", vtt);
    expect(back.segments).toHaveLength(2);
    expect(back.segments[1]).toMatchObject({ text: "General greeting.", speaker: "Speaker 2" });
  });
  it("lrc: line tags parse, enhanced word tags reduce to text", () => {
    const lrc = generateExport(RESULT, { format: "lrc", wordTimestamps: true });
    const back = parseImportedText("lrc", lrc);
    expect(back.segments).toHaveLength(2);
    expect(back.segments[0].start).toBeCloseTo(0.4, 2);
    expect(back.segments[0].text).toBe("Hello there.");
    expect(back.segments[0].end).toBeCloseTo(2.1, 2); // next line's start
  });
  it("json: our export shape incl. language and speakerName", () => {
    const json = generateExport(RESULT, { format: "json" });
    const back = parseImportedText("json", json);
    expect(back.language).toBe("en");
    expect(back.segments[0]).toMatchObject({
      start: 0.4, end: 2.0, text: "Hello there.", speaker: "Speaker 1",
    });
  });
});

describe("plain text + errors", () => {
  it("paragraphs become segments; single paragraph falls back to lines", () => {
    expect(parseImportedText("txt", "One para.\n\nTwo para.").segments).toHaveLength(2);
    expect(parseImportedText("txt", "line a\nline b\nline c").segments).toHaveLength(3);
  });
  it("clock-like prefixes never become speakers", () => {
    const back = parseImportedText("txt", "12: lunch at noon");
    expect(back.segments[0].speaker).toBeUndefined();
  });
  it("empty input throws a user-facing message", () => {
    expect(() => parseImportedText("srt", "")).toThrow(/No text found/);
    expect(() => parseImportedText("json", "not json")).toThrow(/Not valid JSON/);
  });
});
