// Round-trip guards: what generateExport writes, parseImportedText reads back.
import { describe, expect, it } from "vitest";
import { generateExport } from "./transcriptFormats";
import {
  ACCEPTED_EXTS,
  AUDIO_SOURCE_EXTS,
  TEXT_SOURCE_EXTS,
  dedupeRollingCues,
  dialogFilterExts,
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
  it("vtt: a speaker name over 40 characters (an older rename) still re-imports as the speaker", () => {
    for (const name of [
      "Professor Maximilian von Hohenzollern-Sigmaringen", // 49
      "Professor Maximilian von Hohenzollern-Sigmaringen und Freunde aus Berlin am Rhein", // 81
    ]) {
      const vtt = generateExport(RESULT, { format: "vtt", renames: { SPEAKER_00: name } });
      expect(vtt).toContain(`<v ${name}>`);
      const back = parseImportedText("vtt", vtt);
      expect(back.segments[0]).toMatchObject({ text: "Hello there.", speaker: name.slice(0, 40).trim() });
      expect(back.segments.some((s) => s.text.includes("<v"))).toBe(false);
    }
  });
  it("srt: a 'Name: ' speaker is bounded at 40 code points, not UTF-16 units", () => {
    const cue = (name: string) => `1\n00:00:01,000 --> 00:00:02,000\n${name}: hello\n`;
    const fits = "🎤𠮷" + "A".repeat(37); // 39 code points, 41 UTF-16 units
    expect(parseImportedText("srt", cue(fits)).segments[0]).toMatchObject({ speaker: fits, text: "hello" });
    const over = "🎤𠮷" + "A".repeat(39); // 41 code points
    expect(parseImportedText("srt", cue(over)).segments[0]).toEqual({ start: 1, end: 2, text: `${over}: hello` });
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
  it("srt/vtt: a CJK cue the export wrapped at a phrase space reads back with that space", () => {
    const text = "我们今天去公园散步了 然后回家吃饭再看一会儿电视吧";
    const zh: BatchResult = {
      text,
      language: "zh",
      segments: [{ start: 0, end: 4, text }],
      words: [...text].filter((c) => c !== " ").map((word, i) => ({ word, start: i * 0.15, end: i * 0.15 + 0.15 })),
    };
    for (const format of ["srt", "vtt"] as const) {
      const out = generateExport(zh, { format, cues: { length: "standard", timing: "same" } });
      expect(out).toContain("我们今天去公园散步了\n然后回家吃饭再看一会儿电视吧"); // wrapped at the phrase space
      expect(parseImportedText(format, out).segments.map((s) => s.text)).toEqual([text]);
    }
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
  it("lrc: a spaced Thai line round-trips with only its own spaces", () => {
    const text = "สวัสดี ครับ";
    const th: BatchResult = {
      text,
      language: "th",
      segments: [{ start: 0, end: 1.5, text }],
      words: [
        { word: "สวัส", start: 0, end: 0.5 },
        { word: "ดี", start: 0.5, end: 1 },
        { word: "ครับ", start: 1, end: 1.5 },
      ],
    };
    const lrc = generateExport(th, { format: "lrc", wordTimestamps: true });
    expect(parseImportedText("lrc", lrc).segments[0].text).toBe(text);
    // A space after the line stamp or a speaker prefix is no seam space.
    expect(parseImportedText("lrc", "[00:01.00] <00:01.00>Hello<00:01.50>world\n").segments[0].text).toBe("Hello world");
    expect(parseImportedText("lrc", "[00:01.00]Alice: <00:01.00>Hello<00:01.50>world\n").segments[0].text).toContain("Hello world");
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
  it("srt/lrc: literal angle brackets in the text are no markup and re-import verbatim", () => {
    const lines = ["If x<5 and y>3 we stop.", "Use the <Enter> key."];
    const r: BatchResult = {
      text: lines.join(" "),
      language: "en",
      segments: lines.map((text, i) => ({ start: i * 2, end: i * 2 + 1.5, text })),
    };
    for (const format of ["srt", "lrc"] as const) {
      const back = parseImportedText(format, generateExport(r, { format }));
      expect(back.segments.map((s) => s.text)).toEqual(lines);
    }
  });
  it("srt: a foreign file's real markup still strips", () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i> <font color="#ff0">there</font>, <B>friend</B>.\n\n'
      + "2\n00:00:03,000 --> 00:00:04,000\n<c.mt>Line</c><br/> <00:00:03.500>two {\\an8}here.\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["Hello there, friend.", "Line two here."]);
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
  it("json language named as a word (OpenAI verbose_json) becomes its Whisper code", () => {
    const seg = (language: string) =>
      parseImportedText("json", JSON.stringify({ language, segments: [{ start: 0, end: 1, text: "Hi" }] })).language;
    const plain = (language: string) => parseImportedText("json", JSON.stringify({ language, text: "Hi" })).language;
    expect([seg("English"), seg("english"), seg(" ENGLISH "), plain("english")]).toEqual(["en", "en", "en", "en"]);
    // Whisper's own spellings the runtime names differently.
    expect([seg("tagalog"), seg("myanmar"), seg("Maori"), seg("cantonese")]).toEqual(["tl", "my", "mi", "yue"]);
    // A code stays as the file wrote it; a word no language goes by stays too.
    expect([seg("EN"), seg("pt-BR"), seg("klingon")]).toEqual(["EN", "pt-BR", "klingon"]);
  });
  it("a CJK line break joins without a space only in a file that wraps its CJK lines (。，、 and no phrase space)", () => {
    const srt = (body: string) => parseImportedText("srt", `1\n00:00:01,000 --> 00:00:02,000\n${body}\n`).segments[0];
    // Punctuated: the break only wraps the phrase.
    expect(srt("今日はとても\n良い天気ですね。").text).toBe("今日はとても良い天気ですね。");
    expect(srt("<i>今日は</i>\n<i>晴れです。</i>").text).toBe("今日は晴れです。");
    expect(srt("Alice: 我们\n去了。")).toMatchObject({ speaker: "Alice", text: "我们去了。" });
    // A tag split over two lines still strips.
    expect(srt('<font color="#fff"\nface="Arial">今日は</font>\n晴れです。').text).toBe("今日は晴れです。");
    // The unpunctuated convention: the break separates phrases, and ？！： do not count.
    expect(srt("我们走吧\n他们在等我们").text).toBe("我们走吧 他们在等我们");
    expect(srt("我不知道他去哪儿了\n你知道吗？").text).toBe("我不知道他去哪儿了 你知道吗？");
    expect(srt("张三：我们走吧\n他们在等我们").text).toBe("张三：我们走吧 他们在等我们");
    const vtt = parseImportedText("vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v 田中>今日は天気が\nいいですね！\n").segments[0];
    expect(vtt).toMatchObject({ speaker: "田中", text: "今日は天気が いいですね！" });
    // Phrase-spaced text (Whisper's, and our exports of it) keeps its separator.
    expect(srt("你好。 我们\n走吧。").text).toBe("你好。 我们 走吧。");
    expect(srt("今日は　ありがとう\nまた明日ね").text).toBe("今日は ありがとう また明日ね");
    // Latin and mixed seams keep one space either way.
    expect(srt("Hello there\nmy friend").text).toBe("Hello there my friend");
    expect(srt("我喜欢\niPhone。").text).toBe("我喜欢 iPhone。");
    // Two voices in one cue still split per voice.
    const two = parseImportedText("vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n- <v Alice>你好\n- <v Bob>再见\n").segments;
    expect(two.map((s) => [s.speaker, s.text])).toEqual([["Alice", "你好"], ["Bob", "再见"]]);
    // A .txt file decides once for the whole file: punctuated line ends, every CJK wrap joins.
    expect(parseImportedText("txt", "我们今天去公园，\n散步然后回家。\n\n我爱你\n你爱我。\n\nSecond\npara").segments.map((s) => s.text))
      .toEqual(["我们今天去公园，散步然后回家。", "我爱你你爱我。", "Second para"]);
    // A mid-line ， is phrase punctuation too (sentences may end on ？！」 instead of 。).
    expect(parseImportedText("txt", "我们今天去公园\n散步，然后回家\n\n我爱你\n你爱我").segments.map((s) => s.text))
      .toEqual(["我们今天去公园散步，然后回家", "我爱你你爱我"]);
    // zh's 、 is an enumeration mark the unpunctuated convention keeps: the file keeps its separators.
    expect(parseImportedText("txt", "我买了苹果、香蕉\n我们走吧\n\n快点\n别迟到了").segments.map((s) => s.text))
      .toEqual(["我买了苹果、香蕉 我们走吧", "快点 别迟到了"]);
    expect(parseImportedText("txt", "我们今天去公园\n散步\n\n我爱你\n你爱我").segments.map((s) => s.text))
      .toEqual(["我们今天去公园 散步", "我爱你 你爱我"]);
  });
  it("an unpunctuated subtitle file keeps its phrase breaks despite one credit line or a 。 in a NOTE", () => {
    const cue = (n: number, body: string) => `${n}\n00:00:0${n},000 --> 00:00:0${n},900\n${body}\n`;
    const file = [cue(1, "我们走吧\n他们在等我们"), cue(2, "快点\n别迟到了"), cue(3, "好的\n马上来"), cue(4, "翻译：小明。")].join("\n");
    expect(parseImportedText("srt", file).segments.map((s) => s.text).slice(0, 3)).toEqual(["我们走吧 他们在等我们", "快点 别迟到了", "好的 马上来"]);
    const vtt = "WEBVTT\n\nNOTE 字幕制作。完成。\n\n00:00:01.000 --> 00:00:02.000\n我们走吧\n他们在等我们\n";
    expect(parseImportedText("vtt", vtt).segments[0].text).toBe("我们走吧 他们在等我们");
  });
  it("a CJK file is judged on the text its cues keep: without the speaker prefix, per voice span", () => {
    const cue = (n: number, body: string) => `${n}\n00:00:0${n},000 --> 00:00:0${n},900\n${body}\n`;
    const srt = (bodies: string[]) => parseImportedText("srt", bodies.map((b, i) => cue(i + 1, b)).join("\n")).segments;
    // Our export with speaker names: a ？！ dialogue whose only marks follow the "Name: " prefix.
    expect(srt(["SPEAKER_00: 你好，你今天要\n去哪里？", "SPEAKER_01: 我想去公园，\n你要一起来吗？", "SPEAKER_00: 当然，我们什么\n时候出发？", "SPEAKER_01: 现在就走吧！"])
      .map((s) => [s.speaker, s.text])).toEqual([
      ["SPEAKER_00", "你好，你今天要去哪里？"],
      ["SPEAKER_01", "我想去公园，你要一起来吗？"],
      ["SPEAKER_00", "当然，我们什么时候出发？"],
      ["SPEAKER_01", "现在就走吧！"],
    ]);
    // ASCII-colon credit lines are no speaker: their fields keep discounting their marks.
    const credits = srt([
      "翻译: 小明。校对: 小刚", "时间轴: 小李。压制: 小王", "监制: 小张。后期: 小赵",
      ...Array.from({ length: 10 }, (_, i) => `我们今天去公园\n然后回家吃饭${i}`),
    ]);
    expect(credits[12].text).toBe("我们今天去公园 然后回家吃饭9");
    // A one-field credit with text after its mark is no speaker either (its name opens one cue).
    expect(srt(["翻译: 小明。谢谢观看", ...Array.from({ length: 3 }, (_, i) => `我们今天去公园\n然后回家${i}`)])[3].text)
      .toBe("我们今天去公园 然后回家2");
    // A recurring speaker is stripped whatever the text holds: a quotation, a colon, a time, and
    // a spaced Japanese name never reaches the phrase-space check.
    const said = srt(Array.from({ length: 6 }, (_, i) => `Alice: 他说：“你好，今天我们\n去哪里${i}？”`));
    expect(said[5]).toMatchObject({ speaker: "Alice", text: "他说：“你好，今天我们去哪里5？”" });
    expect(srt(Array.from({ length: 6 }, (_, i) => `Alice: 你好，现在是10:30我们\n走吧${i}`))[5].text).toBe("你好，现在是10:30我们走吧5");
    const yamada = srt([
      ...Array.from({ length: 8 }, (_, i) => `山田 太郎: 今日はいい天気ですね、\nそうですね${i}`),
      "山田 太郎: 彼は言った：「行こう」",
    ]);
    expect(yamada[0]).toMatchObject({ speaker: "山田 太郎", text: "今日はいい天気ですね、そうですね0" });
    // A one-off spaced speaker name is no phrase space either.
    const once = srt([...Array.from({ length: 6 }, (_, i) => `花子: 今日はいい天気ですね、公園に\n行きましょう${i}。`), "山田 太郎: そうですね、\n行きましょう。"]);
    expect(once[0].text).toBe("今日はいい天気ですね、公園に行きましょう0。");
    expect(once[6]).toMatchObject({ speaker: "山田 太郎", text: "そうですね、行きましょう。" });
    // A credit or note repeated verbatim at the start and the end is still a credit.
    const unp = Array.from({ length: 6 }, (_, i) => `我们今天去公园\n然后回家吃饭${i}`);
    for (const credit of ["翻译: 小明。校对: 小刚", "注: 本片仅供学习交流，请勿商用"]) {
      expect(srt([credit, ...unp, credit])[1].text).toBe("我们今天去公园 然后回家吃饭0");
    }
    expect(srt(["字幕: XX字幕组。", ...unp.slice(0, 3), "字幕: XX字幕组。"])[1].text).toBe("我们今天去公园 然后回家吃饭0");
    const alice = srt([...Array<string>(6).fill("Alice: 好的。"), "Alice: 今天天气很好，我们\n去公园吧。"]);
    expect(alice[6]).toMatchObject({ speaker: "Alice", text: "今天天气很好，我们去公园吧。" });
    // A quotation after a colon carries its marks.
    expect(srt(["他问：“你好，你今天要\n去哪里？”"])[0].text).toBe("他问：“你好，你今天要去哪里？”");
    // One cue holding two voices on one line: the blank between the spans is no phrase space.
    const vtt = "WEBVTT\n\n" + ["我今天去了商店，买了很多\n东西。", "他说这个地方很好，我们\n明天再来。", "天气很好，我们\n出去玩吧。", "<v 甲>你好。</v> <v 乙>你好。</v>"]
      .map((b, i) => `00:00:0${i}.000 --> 00:00:0${i}.900\n${b}\n`).join("\n");
    expect(parseImportedText("vtt", vtt).segments.map((s) => [s.speaker, s.text])).toEqual([
      [undefined, "我今天去了商店，买了很多东西。"],
      [undefined, "他说这个地方很好，我们明天再来。"],
      [undefined, "天气很好，我们出去玩吧。"],
      ["甲", "你好。"],
      ["乙", "你好。"],
    ]);
  });
  it("a tag-only line and a curly quote at a seam join like any other CJK wrap", () => {
    const srt = (bodies: string[]) =>
      parseImportedText("srt", bodies.map((b, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${b}\n`).join("\n")).segments.map((s) => s.text);
    expect(srt(["我今天去了，商店\n<i>\n东西。</i>"])).toEqual(["我今天去了，商店东西。"]);
    expect(srt(["Hello\n<i>\nworld</i>"])).toEqual(["Hello world"]);
    expect(srt(["今天天气很好，\n我们去公园吧。", "他说：\n“我们走吧。”", "他说：“我们走吧。”\n然后他就走了。"]))
      .toEqual(["今天天气很好，我们去公园吧。", "他说：“我们走吧。”", "他说：“我们走吧。”然后他就走了。"]);
    // An unpunctuated file keeps its phrase break at a quote too.
    expect(srt(["我们走吧\n他们在等我们", "他说\n“走吧”"])).toEqual(["我们走吧 他们在等我们", "他说 “走吧”"]);
  });
  it("a JSON segment's line break folds by the file's decision, so every later view agrees", () => {
    const json = (texts: string[]) => JSON.stringify({ segments: texts.map((text, i) => ({ start: i, end: i + 1, text })) });
    expect(parseImportedText("json", json(["今日は\nいい天気ですね。", "明日も\n晴れるでしょう。"])).segments.map((s) => s.text))
      .toEqual(["今日はいい天気ですね。", "明日も晴れるでしょう。"]);
    expect(parseImportedText("json", json(["我们走吧\n他们在等我们"])).segments[0].text).toBe("我们走吧 他们在等我们");
  });
  it("a long punctuated CJK .txt file with no blank lines joins in linear time", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `今日は${i}いい天気ですね。`).join("\n");
    const t0 = performance.now();
    expect(parseImportedText("txt", body).segments.length).toBe(20_000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it("srt/vtt: punctuated CJK the export wrapped reads back unchanged, whatever its sentences end on", () => {
    for (const [language, text] of [
      ["ja", "今日はとてもいい天気ですね、明日も晴れるでしょうか？"],
      ["ja", "彼は「明日は雨だ。」と言っていましたが、本当に降るのでしょうか」"],
      ["zh", "我们今天去公园散步，然后回家吃饭再看一会儿电视吧！"],
    ] as const) {
      const r: BatchResult = {
        text,
        language,
        segments: [{ start: 0, end: 6, text }],
        words: [...text].map((word, i) => ({ word, start: i * 0.2, end: i * 0.2 + 0.2 })),
      };
      for (const format of ["srt", "vtt"] as const) {
        const out = generateExport(r, { format, cues: { length: "standard", timing: "same" } });
        expect(parseImportedText(format, out).segments.map((s) => s.text).join("")).toBe(text);
      }
    }
  });
  it("srt/vtt: a ja dialogue ending its lines on ？！ with one mid-line 。 reads back unchanged", () => {
    const texts = [
      "あなたは本当に明日の会議に来るつもりなの？",
      "もちろん行くよでも少し遅れるかもしれない！",
      "それなら先に資料を送っておいてくれる？",
      "わかった。今夜のうちに必ず送るからね！",
    ];
    let t = 0;
    const segments = texts.map((text) => ({ start: t, end: (t += 5), text }));
    const words = segments.flatMap((g) => [...g.text].map((word, i) => ({ word, start: g.start + i * 0.2, end: g.start + i * 0.2 + 0.2 })));
    const r: BatchResult = { text: texts.join(""), language: "ja", segments, words };
    for (const format of ["srt", "vtt"] as const) {
      const out = generateExport(r, { format, cues: { length: "standard", timing: "same" } });
      expect(out).toMatch(/[\u3040-\u9fff]\n[\u3040-\u9fff]/); // the export did wrap
      expect(parseImportedText(format, out).segments.map((s) => s.text).join("")).toBe(texts.join(""));
    }
  });
  it("srt/vtt: a punctuated CJK cue the export wrapped over two lines reads back without a space at the break", () => {
    const text = "今日はとてもいい天気ですね。明日も晴れるでしょう。";
    const ja: BatchResult = {
      text,
      language: "ja",
      segments: [{ start: 0, end: 4, text }],
      words: [...text].map((word, i) => ({ word, start: i * 0.15, end: i * 0.15 + 0.15 })),
    };
    for (const format of ["srt", "vtt"] as const) {
      const out = generateExport(ja, { format, cues: { length: "standard", timing: "same" } });
      expect(out).toMatch(/[\u3040-\u9fff]\n[\u3040-\u9fff]/); // the export did wrap a cue
      expect(parseImportedText(format, out).segments.map((s) => s.text).join("")).toBe(text);
      expect(parseImportedText(format, out).segments.every((s) => !/\s/.test(s.text))).toBe(true);
    }
  });
  it("srt/vtt: a CJK cue the export wrapped beside a glued number reads back without a space there", () => {
    // The export wraps "2025年10月" / "17日" at a CJK|digit seam, which holds no space.
    const text = "今日は2025年10月17日です。天気が良いですね、散歩に行きましょう。";
    const ja: BatchResult = {
      text,
      language: "ja",
      segments: [{ start: 0, end: 6, text }],
      words: [...text].map((word, i) => ({ word, start: i * 0.2, end: i * 0.2 + 0.2 })),
    };
    for (const format of ["srt", "vtt"] as const) {
      const out = generateExport(ja, { format, cues: { length: "standard", timing: "same" } });
      expect(out).toContain("今日は2025年10月\n17日です。"); // the export did wrap there
      expect(parseImportedText(format, out).segments.map((s) => s.text)).toEqual([text]);
    }
  });
  it("srt: a CJK cue wrapped beside a glued Latin word reads back without a space there; a word on a line of its own keeps its spaces", () => {
    const srt = (body: string) => `1\n00:00:01,000 --> 00:00:02,000\n${body}\n`;
    for (const [body, text] of [
      ["今日はMicrosoft\nの会議です。", "今日はMicrosoftの会議です。"],
      ["我们今天用\nChatGPT写代码。", "我们今天用ChatGPT写代码。"],
      ["今日の会議で\nGoogleとApple\nの話をします。", "今日の会議でGoogleとAppleの話をします。"],
      // Whisper's spaced style keeps its space, also around a word our wrap set on a line of its own.
      ["我们今天讨论 AI\n的发展。", "我们今天讨论 AI 的发展。"],
      ["我的电话号码是\n13812345678\n请打给我。", "我的电话号码是 13812345678 请打给我。"],
    ]) expect(parseImportedText("srt", srt(body)).segments.map((s) => s.text)).toEqual([text]);
    // Our export's wrap (wrapLines at 16) of Whisper's spaced style, in a file whose 。， say it wraps.
    const bodies = ["我们今天讨论的是\nKubernetes\n集群的部署方案和监控。", "好的，我明白了。", "今年公司的总收入达到了\n1234567890\n元比去年增长了很多。", "然后，我们走吧。"];
    const file = bodies.map((b, i) => `${i + 1}\n00:00:0${i + 1},000 --> 00:00:0${i + 2},000\n${b}\n`).join("\n");
    expect(parseImportedText("srt", file).segments.map((s) => s.text))
      .toEqual(["我们今天讨论的是 Kubernetes 集群的部署方案和监控。", "好的，我明白了。", "今年公司的总收入达到了 1234567890 元比去年增长了很多。", "然后，我们走吧。"]);
  });
  it("a times line holding a long blank run parses in linear time, to the same cues", () => {
    const ws = " ".repeat(100_000);
    const srt = `1\n00:00:01,000 --> 00:00:02,000\nHello\n \nx${ws}y\n\n2\n00:00:03,000${ws}-->${ws}00:00:04,000\nWorld\n`;
    const t0 = performance.now();
    const segs = parseImportedText("srt", srt).segments;
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(segs.map((s) => [s.start, s.end, s.text])).toEqual([[1, 2, "Hello x y"], [3, 4, "World"]]);
  });
  it("a whitespace-only line separates paragraphs", () => {
    expect(parseImportedText("txt", "One para.\n \t\nTwo para.").segments.map((s) => s.text))
      .toEqual(["One para.", "Two para."]);
  });
  it("lrc: a word tag after a trailing mark or variation selector joins unspaced", () => {
    expect(parseImportedText("lrc", "[00:00.00]葛\u{E0100}<00:00.50>城").segments[0].text).toBe("葛\u{E0100}城");
    expect(parseImportedText("lrc", "[00:00.00]か\u3099<00:00.50>次").segments[0].text).toBe("か\u3099次");
  });
  it("lrc: a word tag after the prolonged sound mark ー joins unspaced", () => {
    expect(parseImportedText("lrc", "[00:01.00]<00:01.00>サーバー<00:02.00>に<00:03.00>接続").segments[0].text)
      .toBe("サーバーに接続");
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

describe("dialogFilterExts", () => {
  // The Linux GTK3 dialog matches `*.mov` case-sensitively: an upper-case camera file
  // (MVI_0042.MOV) must still be listed, as a drop of it is accepted.
  it("lists every accepted extension in upper case too", () => {
    const exts = [...dialogFilterExts(AUDIO_SOURCE_EXTS), ...dialogFilterExts(TEXT_SOURCE_EXTS)];
    for (const ext of ACCEPTED_EXTS) {
      expect(exts).toContain(ext);
      expect(exts).toContain(ext.toUpperCase());
    }
    expect(dialogFilterExts(["json"])).toEqual(["json", "JSON"]);
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
  it("a freeze cue of exactly 100 ms counts wherever it sits in the file", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nIch bin mit Gott\n\n"
      + "00:00:01.000 --> 00:00:01.100\nIch bin mit Gott\n\n"
      + "00:00:01.100 --> 00:00:03.000\nIch bin mit Gott\naufgewachsen\n";
    expect(parseImportedText("vtt", vtt).segments.map((s) => s.text)).toEqual(["Ich bin mit Gott", "aufgewachsen"]);
  });
  it("a short auto-caption file that rolls only once still reads every line once", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello there\n\n"
      + "00:00:02.000 --> 00:00:02.010\nhello there\n\n"
      + "00:00:02.010 --> 00:00:04.000\nhello there\nhow are you\n";
    expect(parseImportedText("vtt", vtt).segments).toMatchObject([
      { start: 0, end: 2, text: "hello there" },
      { start: 2.01, end: 4, text: "how are you" },
    ]);
  });
  it("an auto-caption file that rolls several times reads every line once", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello there\n\n"
      + "00:00:02.000 --> 00:00:02.010\nhello there\n\n"
      + "00:00:02.010 --> 00:00:04.000\nhello there\nhow are you\n\n"
      + "00:00:04.000 --> 00:00:04.010\nhow are you\n\n"
      + "00:00:04.010 --> 00:00:06.000\nhow are you\nfine thanks\n";
    expect(parseImportedText("vtt", vtt).segments.map((s) => s.text)).toEqual(["hello there", "how are you", "fine thanks"]);
  });
  it("one short cue repeating its neighbour does not make a whole file rolling", () => {
    // A Whisper SRT's doubled "Thank you." lasts 50 ms; the later "Wait." the file really says
    // twice must stay — the repeat bridges no roll: the cue after it does not open with it.
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nThank you.\n\n2\n00:00:02,000 --> 00:00:02,050\nThank you.\n\n"
      + "3\n00:00:03,000 --> 00:00:05,000\nWait.\n\n4\n00:00:05,000 --> 00:00:07,000\nWait.\nDid you hear?\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "Thank you.", "Thank you.", "Wait.", "Wait. Did you hear?",
    ]);
  });
  it("a line repeated twice in short cues does not make a whole file rolling", () => {
    // The first 50 ms repeat opens the next cue but adds no line; the second opens nothing.
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nThank you.\n\n2\n00:00:02,000 --> 00:00:02,050\nThank you.\n\n"
      + "3\n00:00:02,050 --> 00:00:02,100\nThank you.\n\n"
      + "4\n00:00:03,000 --> 00:00:05,000\nWait.\n\n5\n00:00:05,000 --> 00:00:07,000\nWait.\nDid you hear?\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "Thank you.", "Thank you.", "Thank you.", "Wait.", "Wait. Did you hear?",
    ]);
  });
  it("two separate short repeats do not make a whole file rolling", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nThank you.\n\n2\n00:00:02,000 --> 00:00:02,050\nThank you.\n\n"
      + "3\n00:00:03,000 --> 00:00:05,000\nWait.\n\n4\n00:00:05,000 --> 00:00:07,000\nWait.\nDid you hear?\n\n"
      + "5\n00:00:08,000 --> 00:00:09,000\nBye.\n\n6\n00:00:09,000 --> 00:00:09,040\nBye.\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "Thank you.", "Thank you.", "Wait.", "Wait. Did you hear?", "Bye.", "Bye.",
    ]);
  });
  it("a short cue that only opens a later cue does not make a whole file rolling", () => {
    // "Right." repeats nothing before it, and the cue it opens starts ten seconds later.
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nThank you.\n\n2\n00:00:02,000 --> 00:00:03,000\nThank you.\n\n"
      + "3\n00:00:05,000 --> 00:00:06,000\nWait.\n\n4\n00:00:06,000 --> 00:00:08,000\nWait.\nDid you hear that?\n\n"
      + "5\n00:00:20,000 --> 00:00:20,050\nRight.\n\n6\n00:00:30,000 --> 00:00:32,000\nRight.\nLet's go.\n";
    expect(parseImportedText("srt", srt).segments).toMatchObject([
      { start: 1, end: 2, text: "Thank you." },
      { start: 2, end: 3, text: "Thank you." },
      { start: 5, end: 6, text: "Wait." },
      { start: 6, end: 8, text: "Wait. Did you hear that?" },
      { start: 20, end: 20.05, text: "Right." },
      { start: 30, end: 32, text: "Right. Let's go." },
    ]);
    // A 50 ms Whisper fragment repeating only the NEXT cue's first wrapped line, right after it.
    const next =
      "1\n00:00:01,000 --> 00:00:02,000\nThank you.\n\n2\n00:00:02,000 --> 00:00:03,000\nThank you.\n\n"
      + "3\n00:00:05,000 --> 00:00:05,050\nWait.\n\n4\n00:00:05,050 --> 00:00:08,000\nWait.\nDid you hear that noise?\n";
    expect(parseImportedText("srt", next).segments.map((s) => s.text)).toEqual([
      "Thank you.", "Thank you.", "Wait.", "Wait. Did you hear that noise?",
    ]);
  });
  it("rolling-caption shape matrix against the two-freeze rule it replaced", () => {
    const c = (start: number, end: number, ...lines: string[]) => ({ start, end, lines });
    const rows: { name: string; cues: ReturnType<typeof c>[]; want: [number, number, string][] }[] = [
      // Unchanged from the two-freeze rule: a freeze that repeats nothing before it, one whose
      // roll comes far later, a single 50 ms repeat, and a file that rolls several times.
      {
        name: "short cue opening a far later cue",
        cues: [c(1, 2, "Thank you."), c(2, 3, "Thank you."), c(5, 6, "Wait."), c(6, 8, "Wait.", "Did you hear that?"), c(20, 20.05, "Right."), c(30, 32, "Right.", "Let's go.")],
        want: [[1, 2, "Thank you."], [2, 3, "Thank you."], [5, 6, "Wait."], [6, 8, "Wait.|Did you hear that?"], [20, 20.05, "Right."], [30, 32, "Right.|Let's go."]],
      },
      {
        name: "short cue opening only the next cue",
        cues: [c(1, 2, "Thank you."), c(2, 3, "Thank you."), c(5, 5.05, "Wait."), c(5.05, 8, "Wait.", "Did you hear that noise?")],
        want: [[1, 2, "Thank you."], [2, 3, "Thank you."], [5, 5.05, "Wait."], [5.05, 8, "Wait.|Did you hear that noise?"]],
      },
      {
        name: "freeze whose roll comes ten seconds later",
        cues: [c(0, 2, "hello there"), c(2, 2.01, "hello there"), c(10, 12, "hello there", "how are you"), c(12, 14, "Bye."), c(14, 16, "Bye.")],
        want: [[0, 2, "hello there"], [2, 2.01, "hello there"], [10, 12, "hello there|how are you"], [12, 14, "Bye."], [14, 16, "Bye."]],
      },
      {
        name: "rolls several times",
        cues: [c(0, 2, "hello there"), c(2, 2.01, "hello there"), c(2.01, 4, "hello there", "how are you"), c(4, 4.01, "how are you"), c(4.01, 6, "how are you", "fine thanks")],
        want: [[0, 2, "hello there"], [2.01, 4, "how are you"], [4.01, 6, "fine thanks"]],
      },
      // Changed on purpose: a single roll (YouTube's short file, an empty cue in between) now
      // dedupes, and a tripled Whisper repeat no longer counts as two freezes.
      {
        name: "rolls once",
        cues: [c(0, 2, "hello there"), c(2, 2.01, "hello there"), c(2.01, 4, "hello there", "how are you")],
        want: [[0, 2, "hello there"], [2.01, 4, "how are you"]],
      },
      {
        name: "rolls once over an empty cue",
        cues: [c(0, 2, "hello"), c(2, 2.01, "hello"), c(2.01, 2.01), c(2.01, 4, "hello", "there")],
        want: [[0, 2, "hello"], [2.01, 4, "there"]],
      },
      {
        name: "tripled 50 ms repeat",
        cues: [c(1, 2, "Thank you."), c(2, 2.05, "Thank you."), c(2.05, 2.1, "Thank you."), c(3, 5, "Wait."), c(5, 7, "Wait.", "Did you hear?")],
        want: [[1, 2, "Thank you."], [2, 2.05, "Thank you."], [2.05, 2.1, "Thank you."], [3, 5, "Wait."], [5, 7, "Wait.|Did you hear?"]],
      },
      // Accepted ambiguity: our export of "Okay." / 50 ms "Okay." / "Okay. So let's start…" has
      // exactly YouTube's single-roll shape, so it reads as rolling (the two-freeze rule kept all).
      {
        name: "export shape indistinguishable from a single roll",
        cues: [c(0, 2, "Okay."), c(2, 2.05, "Okay."), c(2.05, 6, "Okay.", "So let's start"), c(6, 8, "Thank you."), c(8, 10, "Thank you.")],
        want: [[0, 2, "Okay."], [2.05, 6, "So let's start"], [6, 10, "Thank you."]],
      },
    ];
    for (const { name, cues, want } of rows) {
      expect([name, dedupeRollingCues(cues).map((x) => [x.start, x.end, x.lines.join("|")])]).toEqual([name, want]);
    }
  });
  it("broadcaster hyphenation rejoins, letter-spaced emphasis collapses, conjunctions keep their hyphen", () => {
    const back = parseImportedText("vtt", SRF);
    expect(back.segments.map((s) => s.text)).toEqual([
      "Sie arbeitet als journalistische Beraterin.",
      "Das hat mit Vertrauen zu tun, Ein- und Ausgang, Vor- oder Nachteil.",
    ]);
  });
  it("broadcaster hyphenation rejoins through a colour or italic tag around each line", () => {
    const srt = (a: string, b: string) => parseImportedText("srt", `1\n00:00:01,000 --> 00:00:03,000\n${a}\n${b}\n`).segments[0].text;
    expect(srt('<font color="#ffff00">Ein journa-</font>', '<font color="#ffff00">listischer Text</font>')).toBe("Ein journalistischer Text");
    expect(srt("<i>Ein journa-</i>", "<i>listischer Text</i>")).toBe("Ein journalistischer Text");
    expect(srt("<i>Ein journa- </i>", "<i>listischer Text</i>")).toBe("Ein journalistischer Text");
    // A conjunction after the tag still keeps the hyphen.
    expect(srt("<i>Ein- </i>", "<i>und Ausgang</i>")).toBe("Ein- und Ausgang");
  });
  it("a line opening a voice turn or holding our .mt translation is never a hyphenated word's second half", () => {
    const vtt = (...lines: string[]) =>
      parseImportedText("vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${lines.join("\n")}\n`).segments.map((s) => [s.speaker ?? null, s.text]);
    // Colour, italic and plain wraps still rejoin.
    expect(vtt("<c.yellow>Ein journa-</c>", "<c.white>listisch</c>")).toEqual([[null, "Ein journalistisch"]]);
    expect(vtt("<i>Kranken-</i>", "<i>haus</i>")).toEqual([[null, "Krankenhaus"]]);
    expect(vtt("Ein journa-", "listischer Text")).toEqual([[null, "Ein journalistischer Text"]]);
    expect(vtt("<v Bob>Ein journa-", "listischer Text</v>")).toEqual([["Bob", "Ein journalistischer Text"]]);
    expect(vtt("Hallo", "<c.mt>a journa-", "listic text</c>")).toEqual([[null, "Hallo a journalistic text"]]);
    // A voice tag opens a new turn: the interruption keeps its dash and nothing glues.
    expect(vtt("I was going to-", "<v Bob>what?")).toEqual([[null, "I was going to- what?"]]);
    expect(vtt("<v Alice>so a self-", "<v Bob>what?")).toEqual([["Alice", "so a self-"], ["Bob", "what?"]]);
    expect(vtt("<v Alice>so a self-</v>", "<v Bob>what?</v>")).toEqual([["Alice", "so a self-"], ["Bob", "what?"]]);
    expect(vtt("<v Alice>Ich war im Kranken-", "<v Bob>haus?")).toEqual([["Alice", "Ich war im Kranken-"], ["Bob", "haus?"]]);
    expect(vtt("<v Anna>Ich bin gera-</v>", "<v Anna>de da</v>")).toEqual([["Anna", "Ich bin gera-"], ["Anna", "de da"]]);
    expect(vtt("<v.loud Anna>Ich bin gera-</v>", "<v.loud Anna>de da</v>")).toEqual([["Anna", "Ich bin gera-"], ["Anna", "de da"]]);
    // Our VTT export's translation line under an original that ends on a dash.
    expect(vtt("Ich wollte gera-", "<c.mt>i wanted to</c>")).toEqual([[null, "Ich wollte gera- i wanted to"]]);
    expect(vtt("Ich wollte gera-", "<c.mt.mt-en>i wanted to</c>")).toEqual([[null, "Ich wollte gera- i wanted to"]]);
    expect(vtt("<c.spk1>Ich wollte gera-</c>", "<c.mt.spk1>i wanted to</c>")).toEqual([[null, "Ich wollte gera- i wanted to"]]);
    expect(vtt("<v Bob>Ich wollte gera-</v>", "<c.mt>i wanted to</c>")).toEqual([["Bob", "Ich wollte gera- i wanted to"]]);
    expect(vtt("<c.spk1>bob:</c> Ich wollte gera-", "<c.spk1>bob:</c> <c.mt>i wanted to</c>")).toEqual([["bob", "Ich wollte gera- bob: i wanted to"]]);
  });
  it("a closed voice turn that breaks off keeps its dash above an unvoiced line", () => {
    const vtt = (...lines: string[]) =>
      parseImportedText("vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${lines.join("\n")}\n`).segments.map((s) => [s.speaker ?? null, s.text]);
    expect(vtt("<v Alice>so a self-</v>", "what?")).toEqual([["Alice", "so a self- what?"]]);
    expect(vtt("<v.loud Alice>Ich bin gera-</v>", "de da")).toEqual([["Alice", "Ich bin gera- de da"]]);
    // A voice span still open on the line rejoins its wrapped word.
    expect(vtt("<v Bob>Ein journa-", "listischer Text</v>")).toEqual([["Bob", "Ein journalistischer Text"]]);
  });
  it("a cut-off translation line above its original keeps its dash: the closed .mt span is a whole line", () => {
    // Translation-first track order: the original under the .mt line carries no .mt and no voice tag.
    const r: BatchResult = {
      text: "ich wollte",
      segments: [{ start: 0, end: 2, text: " ich wollte", speaker: "SPEAKER_00", translations: { en: "I was going to-" } }],
      speakers: ["SPEAKER_00"],
    };
    const back = (opts: Partial<Parameters<typeof generateExport>[1]>) =>
      parseImportedText("vtt", generateExport(r, { format: "vtt", tracks: ["en", "orig"], ...opts })).segments.map((s) => s.text);
    // No speaker markup: `<c.mt>I was going to-</c>` / `ich wollte`.
    expect(back({ speakerNames: false })).toEqual(["I was going to- ich wollte"]);
    // Colour mode, names hidden: `<c.mt.spk1>I was going to-</c>` / `<c.spk1>ich wollte</c>`.
    expect(back({ speakerNames: false, speakerColors: "line" })).toEqual(["I was going to- ich wollte"]);
    const vtt = (...lines: string[]) =>
      parseImportedText("vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${lines.join("\n")}\n`).segments.map((s) => s.text);
    expect(vtt("<c.mt>I was going to-</c>", "ich wollte")).toEqual(["I was going to- ich wollte"]);
    expect(vtt("<c.mt.mt-en>I was going to-</c>", "<c.spk1>ich wollte</c>")).toEqual(["I was going to- ich wollte"]);
    // A translation wrapped over two lines closes its span on the second.
    expect(vtt("<c.mt>so I was really", "going to-</c>", "ich wollte")).toEqual(["so I was really going to- ich wollte"]);
    // Shape matrix, unchanged: original first, a span still open on the line, plain text.
    expect(vtt("Ich wollte gera-", "<c.mt>i wanted to</c>")).toEqual(["Ich wollte gera- i wanted to"]);
    expect(vtt("Hallo", "<c.mt>a journa-", "listic text</c>")).toEqual(["Hallo a journalistic text"]);
    expect(vtt("<c.mt>Hallo</c>", "Ein journa-", "listischer Text")).toEqual(["Hallo Ein journalistischer Text"]);
    expect(fixBroadcasterText(["well-", "known"])).toEqual(["wellknown"]);
    expect(fixBroadcasterText(["<c.yellow>Ein journa-</c>", "<c.white>listisch</c>"])).toEqual(["<c.yellow>Ein journa</c><c.white>listisch</c>"]);
  });
  it("a suspended hyphen before bzw. / sowie / ou / vs keeps its hyphen", () => {
    const kept: string[][] = [
      ["Die Vor-", "bzw. Nachteile"],
      ["Groß-", "sowie Kleinbuchstaben"],
      ["pré-", "ou post-opératoire"],
      ["pre-", "vs. post-war"],
      ["pre-", "vs post-war"],
      // The conjunctions already listed, unchanged.
      ["Ein-", "und Ausgang"],
      ["Vor-", "oder Nachteil"],
    ];
    for (const lines of kept) expect(fixBroadcasterText(lines)).toEqual(lines);
    expect(parseImportedText("srt", "1\n00:00:01,000 --> 00:00:02,000\nDie Vor-\nbzw. Nachteile\n").segments[0].text).toBe("Die Vor- bzw. Nachteile");
    // Whole words only: a syllable that merely starts like one still rejoins, and "to" / "nor"
    // / "et" / "wie" are left out because they end words too.
    expect(fixBroadcasterText(["Sie hat ihn ver-", "wiesen"])).toEqual(["Sie hat ihn verwiesen"]);
    expect(fixBroadcasterText(["ver-", "etwas"])).toEqual(["veretwas"]);
    expect(fixBroadcasterText(["toma-", "to sauce"])).toEqual(["tomato sauce"]);
    expect(fixBroadcasterText(["a mi-", "nor key"])).toEqual(["a minor key"]);
  });
  it("a word wrapped before its last syllable \"et\" or \"wie\" rejoins", () => {
    expect(fixBroadcasterText(["Please be qui-", "et now."])).toEqual(["Please be quiet now."]);
    expect(fixBroadcasterText(["a tick-", "et for the show"])).toEqual(["a ticket for the show"]);
    expect(fixBroadcasterText(["ein Po-", "et und Maler"])).toEqual(["ein Poet und Maler"]);
    expect(fixBroadcasterText(["Kosten so-", "wie Nutzen"])).toEqual(["Kosten sowie Nutzen"]);
    expect(parseImportedText("srt", "1\n00:00:01,000 --> 00:00:02,000\nPlease be qui-\net now.\n").segments[0].text).toBe("Please be quiet now.");
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
  it("Cyrillic and Slavic one-letter words stay words; a run with other letters still glues", () => {
    expect(fixBroadcasterText(["А я в шоке.", "Ты и я в одной лодке.", "tam a w z nim"])).toEqual([
      "А я в шоке.", "Ты и я в одной лодке.", "tam a w z nim",
    ]);
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nИ я в Москве.\n";
    expect(parseImportedText("srt", srt).segments[0].text).toBe("И я в Москве.");
    expect(fixBroadcasterText(["В Н И М А Н И Е", "W I C H T I G"])).toEqual(["ВНИМАНИЕ", "WICHTIG"]);
  });
  it("letter-spaced emphasis glues unless every letter is a one-letter word of ONE language", () => {
    expect(
      fixBroadcasterText([
        "Das ist w i e immer", "s i e kommt", "z w e i Mal", "W A S soll das?", "Y E S!", "m i t", "s e h r",
      ]),
    ).toEqual(["Das ist wie immer", "sie kommt", "zwei Mal", "WAS soll das?", "YES!", "mit", "sehr"]);
    expect(fixBroadcasterText(["Il y a à boire", "tam a w z nim", "А я в шоке.", "a k s"])).toEqual([
      "Il y a à boire", "tam a w z nim", "А я в шоке.", "a k s",
    ]);
  });
  it("Ukrainian and Belarusian one-letter words (я, є, ў) stay words; Cyrillic emphasis still glues", () => {
    const kept = [
      "Мама і я з дітьми", "Він і я в місті", "А я і ти", "А я з тобою.", "І я в шоці.", "Я і в тебе",
      "Я є у тебе", "Вона і я ў хаце", "А я в шоке.",
    ];
    expect(fixBroadcasterText(kept)).toEqual(kept);
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nМама і я з дітьми\n";
    expect(parseImportedText("srt", srt).segments[0].text).toBe("Мама і я з дітьми");
    expect(fixBroadcasterText(["У В А Г А", "w i e immer", "z w e i Mal"])).toEqual(["УВАГА", "wie immer", "zwei Mal"]);
  });
  it("the particles б and ж and the Greek one-letter words stay words; emphasis with other letters still glues", () => {
    const kept = [
      "Я б в лётчики пошёл, пусть меня научат", "Ну я ж и говорю", "Я б с тобой", "Я б и сам пошёл", "А я б с тобой",
      "Я ж в шоке", "Ти ж і я", "Вось я б у горад", "Ή ο ένας ή ο άλλος", "ο ή η υπεύθυνος", "Ο Η Ή",
      // Unchanged from before: every letter a word of one language.
      "Il y a à boire", "tam a w z nim", "А я в шоке.", "a k s", "Мама і я з дітьми", "Я є у тебе", "О К О",
    ];
    expect(fixBroadcasterText(kept)).toEqual(kept);
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A J Smith>Я б в рабочие пошёл</v>\n";
    expect(parseImportedText("vtt", vtt).segments[0]).toMatchObject({ speaker: "A J Smith", text: "Я б в рабочие пошёл" });
    // A run with a letter outside every set still glues, as before — Cyrillic, Greek and Latin.
    expect(
      fixBroadcasterText([
        "Б О Ж Е", "Б Ы Л О", "Ж Д И", "ж и в о й", "В Н И М А Н И Е", "У В А Г А", "С Л А В А",
        "Ο Χ Ι", "Ν Α Ι", "Π Ρ Ο Σ Ο Χ Η", "w i e immer", "W A S soll das?", "s e h r", "a b c",
      ]),
    ).toEqual([
      "БОЖЕ", "БЫЛО", "ЖДИ", "живой", "ВНИМАНИЕ", "УВАГА", "СЛАВА",
      "ΟΧΙ", "ΝΑΙ", "ΠΡΟΣΟΧΗ", "wie immer", "WAS soll das?", "sehr", "abc",
    ]);
  });
  it("a voice tag whose name opens with initials keeps its tag, its speaker and its name", () => {
    const cue = (text: string) =>
      parseImportedText("vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`).segments.map((s) => ({
        speaker: s.speaker,
        text: s.text,
      }));
    expect(cue("<v A J Smith>Hello there</v>")).toEqual([{ speaker: "A J Smith", text: "Hello there" }]);
    expect(cue("<v C S Lewis>Hi</v> - <v Bob>Yo</v>")).toEqual([
      { speaker: "C S Lewis", text: "Hi" },
      { speaker: "Bob", text: "Yo" },
    ]);
    expect(cue("<v A B C>Hi</v>")).toEqual([{ speaker: "A B C", text: "Hi" }]);
    expect(cue("<v A J Smith>Hi <i>a b c</i></v>")).toEqual([{ speaker: "A J Smith", text: "Hi abc" }]);
    // Emphasis inside or beside tags still glues; a stray "<" that is no tag changes nothing.
    expect(cue("<v Bob>w i e immer</v>")).toEqual([{ speaker: "Bob", text: "wie immer" }]);
    expect(fixBroadcasterText(["<i>w i e</i> immer", "<c.yellow>W A S</c>", "x < a b c > y", "a <i>b</i> c d"])).toEqual([
      "<i>wie</i> immer", "<c.yellow>WAS</c>", "x < abc > y", "a <i>b</i> c d",
    ]);
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
  it("a JSON export of a plain-text source re-imports without timing", () => {
    const r: BatchResult = {
      ...RESULT,
      timingSynthesized: true,
      segments: [{ start: 0, end: 1, text: "Hello." }, { start: 1, end: 2, text: "Bye." }],
    };
    const segs = parseImportedText("json", generateExport(r, { format: "json" })).segments;
    expect(segs.map((s) => [s.text, s.start, s.end])).toEqual([["Hello.", undefined, undefined], ["Bye.", undefined, undefined]]);
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
  it("an arrow in cue text after a whitespace-only line stays text", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nfirst\n \nthen A --> B\n\n2\n00:00:03,000 --> 00:00:04,000\nNext\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["first then A --> B", "Next"]);
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst\n \nthen A --> B\n\n00:00:03.000 --> 00:00:04.000\nNext\n";
    expect(parseImportedText("vtt", vtt).segments.map((s) => s.text)).toEqual(["first then A --> B", "Next"]);
  });
  it("a zero-length repeat in our own export is a segment, not a rolling freeze", () => {
    const r: BatchResult = {
      text: "",
      segments: [
        { start: 0, end: 2, text: " Thank you." },
        { start: 2, end: 2, text: " Thank you." },
        { start: 2, end: 4, text: " Bye." },
        { start: 10, end: 12, text: " Yes." },
        { start: 12, end: 14, text: " Yes." },
      ],
    };
    for (const format of ["srt", "vtt"] as const) {
      expect(parseImportedText(format, generateExport(r, { format })).segments).toMatchObject([
        { start: 0, end: 2, text: "Thank you." },
        { start: 2, end: 2, text: "Thank you." },
        { start: 2, end: 4, text: "Bye." },
        { start: 10, end: 12, text: "Yes." },
        { start: 12, end: 14, text: "Yes." },
      ]);
    }
  });
  it("an empty cue outside a rolling file does not stretch the line before it", () => {
    const r: BatchResult = {
      text: "",
      segments: [
        { start: 0, end: 2, text: " Hello" },
        { start: 2, end: 5, text: "" },
        { start: 5, end: 6, text: " Bye" },
      ],
    };
    for (const format of ["srt", "vtt"] as const) {
      expect(parseImportedText(format, generateExport(r, { format })).segments).toMatchObject([
        { start: 0, end: 2, text: "Hello" },
        { start: 5, end: 6, text: "Bye" },
      ]);
    }
  });
  it("an empty cue inside a rolling file does not stretch the line before it", () => {
    const vtt =
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello\n\n00:00:02.000 --> 00:00:02.010\nhello\n\n"
      + "00:00:02.010 --> 00:00:04.000\nhello\nthere\n\n00:00:04.000 --> 00:00:06.000\n\n"
      + "00:00:06.500 --> 00:00:08.000\nnext\n";
    expect(parseImportedText("vtt", vtt).segments).toMatchObject([
      { start: 0, end: 2, text: "hello" },
      { start: 2.01, end: 4, text: "there" },
      { start: 6.5, end: 8, text: "next" },
    ]);
  });
  it("a two-cue file is too short to call a roll-up: its repeated line stays", () => {
    // One cue opening with the line before is a short roll-up OR an ordinary repeat — keep it.
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nWait.\n\n2\n00:00:02,000 --> 00:00:03,000\nWait.\nDid you hear that?\n";
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["Wait.", "Wait. Did you hear that?"]);
  });
  it("a three-cue file with two opening repeats is still too short: its repeated lines stay", () => {
    // Two cues open with the line before — one short of the minimum of three.
    const cue = (n: number, a: string, b?: string) =>
      `${n}\n00:00:0${n},000 --> 00:00:0${n + 1},000\n${a}${b ? "\n" + b : ""}\n\n`;
    const srt = cue(1, "Wait.") + cue(2, "Wait.", "Did you hear that?") + cue(3, "Did you hear that?", "No.");
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "Wait.", "Wait. Did you hear that?", "Did you hear that? No.",
    ]);
  });
  it("cleans a longer roll-up file without freeze cues", () => {
    const cue = (n: number, a: string, b?: string) =>
      `${n}\n00:00:0${n},000 --> 00:00:0${n + 1},000\n${a}${b ? "\n" + b : ""}\n\n`;
    const srt = cue(1, "one") + cue(2, "one", "two") + cue(3, "two", "three") + cue(4, "three", "four");
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["one", "two", "three", "four"]);
  });
  it("cleans a three-line roll-up file", () => {
    // Each cue repeats the cue before's last TWO lines: its first line is never that cue's last.
    const cue = (n: number, ...lines: string[]) => `${n}\n00:00:0${n},000 --> 00:00:0${n + 1},000\n${lines.join("\n")}\n\n`;
    const srt = cue(1, "one") + cue(2, "one", "two") + cue(3, "one", "two", "three")
      + cue(4, "two", "three", "four") + cue(5, "three", "four", "five");
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual(["one", "two", "three", "four", "five"]);
  });
  it("keeps a word said at the end of one cue and the start of the next in an ordinary file", () => {
    // Our own export of "Wait." / "Wait. Did you hear that?" among other two-line cues.
    const cue = (n: number, a: string, b?: string) =>
      `${n}\n00:00:0${n},000 --> 00:00:0${n + 1},000\n${a}${b ? "\n" + b : ""}\n\n`;
    const srt = cue(1, "Wait.") + cue(2, "Wait.", "Did you hear that?") + cue(3, "It came from", "the attic.")
      + cue(4, "Let's go", "and look.");
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "Wait.", "Wait. Did you hear that?", "It came from the attic.", "Let's go and look.",
    ]);
  });
  it("a cue repeated whole does not make an ordinary file a roll-up", () => {
    const cue = (n: number, ...lines: string[]) => `${n}\n00:00:0${n},000 --> 00:00:0${n + 1},000\n${lines.join("\n")}\n\n`;
    const srt = cue(1, "Na na na", "Hey hey") + cue(2, "Na na na", "Hey hey") + cue(3, "Hey hey", "goodbye");
    expect(parseImportedText("srt", srt).segments.map((s) => s.text)).toEqual([
      "Na na na Hey hey", "Na na na Hey hey", "Hey hey goodbye",
    ]);
  });
});

describe("markup shape matrix", () => {
  // Real subtitle markup strips; a literal comparison or an unknown <word> is the line's own
  // text. Only b/i/u/s/c/ruby/rt/… with a space after the name were tags before — and a voice
  // tag past the 64th character leaked when it was not the cue's first.
  const N70 = "N".repeat(70);
  const cue = (fmt: "srt" | "vtt", text: string) =>
    fmt === "srt" ? `1\n00:00:01,000 --> 00:00:02,000\n${text}\n` : `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`;
  const rows: [fmt: "srt" | "vtt", input: string, speaker: string | null, text: string][] = [
    ["srt", "<b>bold</b> text", null, "bold text"],
    ["srt", "<B>Bold</B> <I>it</I>", null, "Bold it"],
    ["srt", "<i>x</i> y", null, "x y"],
    ["srt", "<u>under</u> line", null, "under line"],
    ["srt", "<s>gone</s> here", null, "gone here"],
    ["srt", "end </b> tag", null, "end tag"],
    ["srt", "one<br>two", null, "onetwo"],
    ["srt", "one<br/>two", null, "onetwo"],
    ["srt", "one<br />two", null, "onetwo"],
    ["vtt", "<c.yellow>x</c> y", null, "x y"],
    ["vtt", "<c.a.b>multi</c> class", null, "multi class"],
    ["vtt", "<c>plain</c> c", null, "plain c"],
    ["vtt", "<v Bob>hi</v>", "Bob", "hi"],
    ["vtt", "<v.loud Bob>hi", "Bob", "hi"],
    ["vtt", `<v ${N70}>hello</v>`, "N".repeat(40), "hello"],
    ["vtt", `- <v ${N70}>hello</v>`, null, "- hello"],
    ["vtt", "<lang en>x</lang> y", null, "x y"],
    ["srt", '<font color="red">x</font> y', null, "x y"],
    ["srt", '<font face="Arial Unicode MS" color="#ffffff" size="22">long attr</font>', null, "long attr"],
    ["srt", '<span class="a">x</span> y', null, "x y"],
    ["srt", '<i class="x">Hello</i>', null, "Hello"],
    ["srt", "<b style='color:red'>Hi</b>", null, "Hi"],
    ["srt", "<u id=a>U</u>", null, "U"],
    ["srt", '<i class="x" lang="en"/>A<br class=y />B', null, "AB"],
    ["vtt", "<ruby>漢<rt>かん</rt></ruby>字", null, "漢かん字"],
    ["srt", "<em>em</em> and <strong>strong</strong>", null, "em and strong"],
    ["srt", "H<sub>2</sub>O and x<sup>2</sup>", null, "H2O and x2"],
    ["vtt", "<00:00:01.200>one <00:00:01.500>two", null, "one two"],
    ["srt", "{\\an8}top line", null, "top line"],
    ["srt", "if a<b and c>d then", null, "if a<b and c>d then"],
    ["srt", "if a<b and b>c then", null, "if a<b and b>c then"],
    ["srt", "set s <s and s> t", null, "set s <s and s> t"],
    ["srt", "x <i and y> z", null, "x <i and y> z"],
    ["srt", "a <b and c> d", null, "a <b and c> d"],
    ["srt", "a <b c=d and e> f", null, "a <b c=d and e> f"],
    ["srt", "x<5 and y>3", null, "x<5 and y>3"],
    ["srt", "I <3 you", null, "I <3 you"],
    ["srt", "a < b", null, "a < b"],
    ["srt", "Use the <Enter> key.", null, "Use the <Enter> key."],
    ["srt", "<unknown tag> here", null, "<unknown tag> here"],
    ["srt", "<i>Anna: hallo</i>", "Anna", "hallo"],
  ];
  it.each(rows)("%s %j", (fmt, input, speaker, text) => {
    const segs = parseImportedText(fmt, cue(fmt, input)).segments;
    expect(segs.map((s) => [s.speaker ?? null, s.text])).toEqual([[speaker, text]]);
  });
});
