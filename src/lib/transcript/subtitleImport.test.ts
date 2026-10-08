// Round-trip guards: what generateExport writes, parseImportedText reads back.
import { describe, expect, it } from "vitest";
import { generateExport } from "./transcriptFormats";
import {
  ACCEPTED_EXTS,
  TEXT_SOURCE_EXTS,
  dedupeRollingCues,
  fixBroadcasterText,
  isAcceptedSourcePath,
  isTextSourcePath,
  parseImportedText,
} from "./subtitleImport";
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
  it("vtt: an escaped speaker name decodes back", () => {
    const vtt = generateExport(RESULT, { format: "vtt", renames: { SPEAKER_00: "Tom & <Jerry>" } });
    expect(vtt).toContain("<v Tom &amp; &lt;Jerry&gt;>");
    const back = parseImportedText("vtt", vtt);
    expect(back.segments[0]).toMatchObject({ text: "Hello there.", speaker: "Tom & <Jerry>" });
  });
  it("lrc: line tags parse, enhanced word tags reduce to text", () => {
    const lrc = generateExport(RESULT, { format: "lrc", wordTimestamps: true });
    const back = parseImportedText("lrc", lrc);
    expect(back.segments).toHaveLength(2);
    expect(back.segments[0].start).toBeCloseTo(0.4, 2);
    expect(back.segments[0].text).toBe("Hello there.");
    expect(back.segments[0].end).toBeCloseTo(2.1, 2); // next line's start
  });
  it("lrc: CJK word tags reduce to text without spaces the export never wrote", () => {
    const ja: BatchResult = {
      text: "今日は晴れ",
      language: "ja",
      segments: [{ start: 0, end: 1.5, text: "今日は晴れ" }],
      words: [
        { word: "今日", start: 0, end: 0.5 },
        { word: "は", start: 0.5, end: 1 },
        { word: "晴れ", start: 1, end: 1.5 },
      ],
    };
    const back = parseImportedText("lrc", generateExport(ja, { format: "lrc", wordTimestamps: true }));
    expect(back.segments[0].text).toBe("今日は晴れ");
    // Tags with no space between Latin words still separate them.
    expect(parseImportedText("lrc", "[00:01.00]<00:01.00>Hello<00:01.50>there\n").segments[0].text).toBe("Hello there");
  });
  it("lrc: a tag beside CJK punctuation round-trips without a space (same seam rule as the export)", () => {
    const tagged = (text: string, ws: string[]): BatchResult => ({
      text,
      language: "ja",
      segments: [{ start: 0, end: ws.length * 0.5, text }],
      words: ws.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 })),
    });
    const lrc = (r: BatchResult) => generateExport(r, { format: "lrc", wordTimestamps: true });
    const period = lrc(tagged("晴れです。明日は雨", ["晴れ", "です。", "明日", "は", "雨"]));
    expect(period).toContain("です。<00:01.00>明日");
    expect(parseImportedText("lrc", period).segments[0].text).toBe("晴れです。明日は雨");
    const bracket = lrc(tagged("彼は「新機能」です", ["彼は", "「新機能」", "です"]));
    expect(bracket).toContain("彼は<00:00.50>「新機能」");
    expect(parseImportedText("lrc", bracket).segments[0].text).toBe("彼は「新機能」です");
  });
  it("lrc: an astral (Ext-B) Han character at a word-tag seam round-trips without a space", () => {
    // 𠮷 is a surrogate pair: the seam test used to look at one UTF-16 unit and miss it.
    const text = "私は𠮷野家に行った山𠮷";
    const ws = ["私は", "𠮷野家", "に行った", "山𠮷"];
    const r: BatchResult = {
      text,
      language: "ja",
      segments: [{ start: 0, end: ws.length * 0.5, text }],
      words: ws.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 })),
    };
    const lrc = generateExport(r, { format: "lrc", wordTimestamps: true });
    expect(lrc).toContain("私は<00:00.50>𠮷野家");
    expect(parseImportedText("lrc", lrc).segments[0].text).toBe(text);
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
  it("json language is trimmed and a blank one dropped, with or without segments", () => {
    const seg = (language: string) =>
      parseImportedText("json", JSON.stringify({ language, segments: [{ start: 0, end: 1, text: "Hallo" }] })).language;
    const plain = (language: string) => parseImportedText("json", JSON.stringify({ language, text: "Hallo" })).language;
    expect([seg(" de "), plain(" de ")]).toEqual(["de", "de"]);
    expect([seg("  "), plain("  ")]).toEqual([undefined, undefined]);
  });
  it("a whitespace-only line separates paragraphs", () => {
    expect(parseImportedText("txt", "One para.\n \t\nTwo para.").segments.map((s) => s.text))
      .toEqual(["One para.", "Two para."]);
  });
  it("lrc: a word tag after a trailing mark or variation selector joins unspaced", () => {
    expect(parseImportedText("lrc", "[00:00.00]葛\u{E0100}<00:00.50>城").segments[0].text).toBe("葛\u{E0100}城");
    expect(parseImportedText("lrc", "[00:00.00]か\u3099<00:00.50>次").segments[0].text).toBe("か\u3099次");
  });
  it("lrc: a text-less timestamp line ends the line before it (instrumental break)", () => {
    const back = parseImportedText("lrc", "[00:10.00]Hello\n[00:13.00]\n[00:40.00]World\n[00:44.00]");
    expect(back.segments).toEqual([
      { start: 10, end: 13, text: "Hello", speaker: undefined },
      { start: 40, end: 44, text: "World", speaker: undefined },
    ]);
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
  it("a zero-length cue with its own text survives a re-import", () => {
    const srt =
      "1\n00:00:28,000 --> 00:00:29,980\nFirst line.\n\n"
      + "2\n00:00:29,980 --> 00:00:29,980\nA blink of a line.\n\n"
      + "3\n00:00:29,980 --> 00:00:32,000\nLast line.\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "First line.", "A blink of a line.", "Last line.",
    ]);
  });
  it("ordinary cues pass through: no repeated lines, no short cues", () => {
    const cues = [
      { start: 0, end: 2, lines: ["Hello there."] },
      { start: 2, end: 4, lines: ["General Kenobi.", "You are a bold one."] },
    ];
    expect(dedupeRollingCues(cues)).toEqual(cues);
    expect(fixBroadcasterText(["E-", "Mail an a b"])).toEqual(["E-", "Mail an a b"]);
  });
  it("a run of one-letter words is text, not letter-spaced emphasis", () => {
    expect(fixBroadcasterText(["Il y a à boire"])).toEqual(["Il y a à boire"]);
    expect(fixBroadcasterText(["m i t"])).toEqual(["mit"]);
  });
  it("decoded references and JSON escapes cannot smuggle control or bidi characters", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\n&#x202E;abc &#27;x\n";
    expect(parseImportedText("srt", srt).segments[0].text).toBe("abc x");
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v &#x202E;Bob>Hi there</v>\n";
    const seg = parseImportedText("vtt", vtt).segments[0];
    expect(seg).toMatchObject({ speaker: "Bob", text: "Hi there" });
    const json = '{"segments":[{"text":"a\\u202eb","speaker":"S\\u0007"}]}';
    expect(parseImportedText("json", json).segments[0]).toMatchObject({ text: "ab", speaker: "S" });
  });
  it("a JSON top-level text fallback is sanitized too", () => {
    const json = '{"text":"abc\\u202edef \\u001bx"}';
    expect(parseImportedText("json", json).segments.map((s) => s.text).join(" ")).toBe("abcdef x");
  });
  it("a VTT cue with two voices yields one segment per speaker", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>Hi</v>\n<v.loud Bob>Hello</v>\n";
    expect(parseImportedText("vtt", vtt).segments).toEqual([
      { start: 1, end: 3, text: "Hi", speaker: "Alice" },
      { start: 1, end: 3, text: "Hello", speaker: "Bob" },
    ]);
  });
  it("a voice tag the span regex rejects keeps the cue's text", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>Hi</v> <v Dr. Bartholomew Featherstonehaugh-Montgomery III>Hello</v>\n";
    expect(parseImportedText("vtt", vtt).segments.map((s) => s.text).join(" ")).toBe("Hi Hello");
  });
  it("a single classed voice tag still carries the speaker", () => {
    const dashed = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n- <v Alice>Hi there</v>\n- <v Bob>Hello</v>\n";
    expect(parseImportedText("vtt", dashed).segments).toEqual([
      { start: 1, end: 3, text: "Hi there", speaker: "Alice" },
      { start: 1, end: 3, text: "Hello", speaker: "Bob" },
    ]);
    // Only a dash right before a voice tag goes: an interruption keeps its own.
    const cut = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>I was going to—</v>\n<v Bob>Go on</v>\n";
    expect(parseImportedText("vtt", cut).segments.map((s) => s.text)).toEqual(["I was going to—", "Go on"]);
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v.loud Alice>Hi\n";
    expect(parseImportedText("vtt", vtt).segments).toEqual([{ start: 1, end: 2, text: "Hi", speaker: "Alice" }]);
  });
  it("a line said twice back to back stays two cues outside a rolling file", () => {
    const r: BatchResult = {
      text: "Thank you. Thank you. Bye.",
      segments: [
        { start: 0, end: 2, text: " Thank you." },
        { start: 2, end: 4, text: " Thank you." },
        { start: 4, end: 6, text: " Bye." },
      ],
    };
    for (const format of ["srt", "vtt"] as const) {
      expect(parseImportedText(format, generateExport(r, { format })).segments).toEqual([
        { start: 0, end: 2, text: "Thank you." },
        { start: 2, end: 4, text: "Thank you." },
        { start: 4, end: 6, text: "Bye." },
      ]);
    }
  });
  it("a JSON clock that is not finite is no clock", () => {
    const json = '{"segments":[{"text":"Hi","start":1e999,"end":-1},{"text":"Yo","start":1,"end":2}]}';
    const segs = parseImportedText("json", json).segments;
    expect(segs[0].start).toBeUndefined();
    expect(segs[0].end).toBeUndefined();
    expect(segs[1]).toMatchObject({ start: 1, end: 2 });
  });
  it("an empty cue does not make a file look rolling", () => {
    // srtExport writes an empty segment as an empty zero-length cue: it "repeats" its
    // neighbours vacuously and used to merge the line said twice.
    const srt =
      "1\n00:00:00,000 --> 00:00:02,000\nThank you.\n\n2\n00:00:02,000 --> 00:00:04,000\nThank you.\n\n"
      + "3\n00:00:04,000 --> 00:00:04,000\n\n4\n00:00:04,000 --> 00:00:06,000\nBye.\n";
    expect(parseImportedText("srt", srt).segments).toEqual([
      { start: 0, end: 2, text: "Thank you.", speaker: undefined },
      { start: 2, end: 4, text: "Thank you.", speaker: undefined },
      { start: 4, end: 6, text: "Bye.", speaker: undefined },
    ]);
  });
  it("a whitespace-only separator line still ends a cue", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello there\n \n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n";
    expect(parseImportedText("srt", srt).segments).toMatchObject([
      { start: 1, end: 2, text: "Hello there" },
      { start: 3, end: 4, text: "Second line" },
    ]);
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello there\n\t\n00:00:03.000 --> 00:00:04.000\nSecond line\n";
    expect(parseImportedText("vtt", vtt).segments).toMatchObject([
      { start: 1, end: 2, text: "Hello there" },
      { start: 3, end: 4, text: "Second line" },
    ]);
  });
  it("cleanup runs for SRT too", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nA line\n\n2\n00:00:02,000 --> 00:00:03,000\nA line\nnext line\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["A line", "next line"]);
  });
});
