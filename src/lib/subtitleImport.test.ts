// Round-trip guards: what generateExport writes, parseImportedText reads back.
import { describe, expect, it } from "vitest";
import { generateExport } from "./transcript/transcriptFormats";
import {
  ACCEPTED_EXTS,
  TEXT_SOURCE_EXTS,
  dedupeRollingCues,
  fixBroadcasterText,
  isAcceptedSourcePath,
  isTextSourcePath,
  parseImportedText,
} from "./subtitleImport";
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
  it("clock-like prefixes never become speakers (a cue-bearing format reaches the guard)", () => {
    // Through lrc, not txt: plain text can never set a speaker, so the old fixture passed
    // for every input and the guard in cueText was untested.
    const back = parseImportedText("lrc", "[00:12.00]12: lunch at noon");
    expect(back.segments[0].speaker).toBeUndefined();
    expect(back.segments[0].text).toBe("12: lunch at noon");
    const named = parseImportedText("lrc", "[00:12.00]Kate: lunch at noon");
    expect(named.segments[0]).toMatchObject({ speaker: "Kate", text: "lunch at noon" });
  });
  it("empty input throws a user-facing message", () => {
    expect(() => parseImportedText("srt", "")).toThrow(/No text found/);
    expect(() => parseImportedText("json", "not json")).toThrow(/Not valid JSON/);
    // `null` parses fine, then the property read on it threw a raw TypeError.
    expect(() => parseImportedText("json", "null")).toThrow(/No text found/);
  });
});

// The picker's dialog filter and the drag-and-drop accept test read ONE list;
// a text source the parser handles must never be droppable-but-rejected.
describe("parseClock via SRT import", () => {
  it("parses cues without fractional seconds", () => {
    const srt = "1\r\n00:00:10 --> 00:00:14\r\nHello world.\r\n";
    const result = parseImportedText("srt", srt);
    expect(result.segments.length).toBe(1);
    expect(result.segments[0].start).toBe(10);
    expect(result.segments[0].end).toBe(14);
    expect(result.segments[0].text).toBe("Hello world.");
  });
});

describe("isAcceptedSourcePath", () => {
  it("accepts audio and text sources regardless of extension case", () => {
    expect(isAcceptedSourcePath("/tmp/a.mp3")).toBe(true);
    expect(isAcceptedSourcePath("/tmp/a.MP3")).toBe(true);
    expect(isAcceptedSourcePath("/tmp/a.srt")).toBe(true);
    expect(isAcceptedSourcePath("/tmp/a.SRT")).toBe(true);
  });
  it("accepts the video containers the server decodes (and the export panel packages)", () => {
    for (const ext of ["mkv", "mov", "m4v", "MP4"]) expect(isAcceptedSourcePath(`/tmp/a.${ext}`)).toBe(true);
  });
  it("rejects containers we do not accept, documents, and extensionless paths", () => {
    expect(isAcceptedSourcePath("/tmp/a.avi")).toBe(false);
    expect(isAcceptedSourcePath("/tmp/a.doc")).toBe(false);
    expect(isAcceptedSourcePath("/tmp/README")).toBe(false);
  });
  it("accepts every text source the parser handles", () => {
    for (const ext of TEXT_SOURCE_EXTS) expect(ACCEPTED_EXTS).toContain(ext);
  });
});

// Real-shaped excerpts: YouTube's de-orig auto captions (Dz_3b8WAWw4) and SRF Play's vtt.
const YOUTUBE_AUTO = `WEBVTT
Kind: captions
Language: de

00:00:00.160 --> 00:00:02.990 align:start position:0%
 
Ich<00:00:00.440><c> bin</c><00:00:00.640><c> mit</c><00:00:00.960><c> Gott</c>

00:00:02.990 --> 00:00:03.000 align:start position:0%
Ich bin mit Gott
 

00:00:03.000 --> 00:00:05.910 align:start position:0%
Ich bin mit Gott
aufgewachsen<00:00:03.520><c> und</c><00:00:03.900><c> [Musik]</c>

00:00:05.910 --> 00:00:05.920 align:start position:0%
aufgewachsen und [Musik]
 

00:00:05.920 --> 00:00:07.200 align:start position:0%
aufgewachsen und [Musik]
 
`;

const SRF = `WEBVTT

00:01:02.000 --> 00:01:05.400
Sie arbeitet als journa-
listische Beraterin.

00:01:05.600 --> 00:01:08.000
Das hat m i t Vertrauen zu tun,
Ein- und Ausgang, Vor-
oder Nachteil.
`;

describe("site subtitle cleanup", () => {
  it("YouTube rolling auto captions read every line once, the last cue extends the one before", () => {
    const back = parseImportedText("vtt", YOUTUBE_AUTO);
    expect(back.segments.map((s) => s.text)).toEqual(["Ich bin mit Gott", "aufgewachsen und [Musik]"]);
    expect(back.segments[1]).toMatchObject({ start: 3, end: 7.2 });
  });
  it("broadcaster hyphenation rejoins, letter-spaced emphasis collapses, conjunctions keep their hyphen", () => {
    const back = parseImportedText("vtt", SRF);
    expect(back.segments.map((s) => s.text)).toEqual([
      "Sie arbeitet als journalistische Beraterin.",
      "Das hat mit Vertrauen zu tun, Ein- und Ausgang, Vor- oder Nachteil.",
    ]);
  });
  it("character references decode after the tags go: &nbsp; is a space, &lt;i&gt; stays text", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nper Re-Prompting&nbsp; vergleichen,&nbsp;&nbsp;\nTom &amp; Jerry &#39;&#x263A;&#39; &lt;i&gt; &bogus;\n";
    expect(parseImportedText("vtt", vtt).segments[0].text).toBe("per Re-Prompting vergleichen, Tom & Jerry '\u263A' <i> &bogus;");
  });
  it("ordinary cues pass through: no repeated lines, no short cues", () => {
    const cues = [
      { start: 0, end: 2, lines: ["Hello there."] },
      { start: 2, end: 4, lines: ["General Kenobi.", "You are a bold one."] },
    ];
    expect(dedupeRollingCues(cues)).toEqual(cues);
    expect(fixBroadcasterText(["E-", "Mail an a b"])).toEqual(["E-", "Mail an a b"]);
  });
  it("cleanup runs for SRT too", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nA line\n\n2\n00:00:02,000 --> 00:00:03,000\nA line\nnext line\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["A line", "next line"]);
  });
});
