import { describe, expect, it } from "vitest";
import { contentStates, exportSummary, lengthNeedsWords, type ContentItem } from "./exportSummary";

describe("lengthNeedsWords", () => {
  it("marks a split that has no word timing to work with", () => {
    expect(lengthNeedsWords(false, "standard")).toBe(true);
    expect(lengthNeedsWords(false, "custom")).toBe(true);
  });
  it("as transcribed, or with words, there is nothing to say", () => {
    expect(lengthNeedsWords(false, "transcribed")).toBe(false);
    expect(lengthNeedsWords(true, "short")).toBe(false);
  });
});

const base = {
  showTs: false, showNames: true, colorize: true, wordTs: false,
  hasSpeakers: true, hasWords: true, origIncluded: true,
};
const states = (c: ContentItem[]) => Object.fromEntries(c.map((i) => [i.key, i.state]));

describe("contentStates", () => {
  it("subtitle formats: timing fixed, names and colors toggle, no word timing", () => {
    expect(states(contentStates({ ...base, format: "srt" }))).toEqual({ ts: "fixed", names: "on", colors: "on", words: "na" });
  });
  it("txt toggles timestamps; colors can't ride plain text", () => {
    expect(states(contentStates({ ...base, format: "txt", showTs: true }))).toEqual({ ts: "on", names: "on", colors: "na", words: "na" });
  });
  it("lrc word timing toggles only while the original is exported", () => {
    expect(states(contentStates({ ...base, format: "lrc" })).words).toBe("off");
    expect(states(contentStates({ ...base, format: "lrc", origIncluded: false })).words).toBe("na");
  });
  it("json carries everything; a transcript without speakers or words says so", () => {
    expect(states(contentStates({ ...base, format: "json" }))).toEqual({ ts: "fixed", names: "fixed", colors: "fixed", words: "fixed" });
    expect(states(contentStates({ ...base, format: "srt", hasSpeakers: false, hasWords: false })))
      .toEqual({ ts: "fixed", names: "na", colors: "na", words: "na" });
  });
});

describe("exportSummary", () => {
  const sum = (over: Partial<Parameters<typeof exportSummary>[0]> = {}) => {
    const format = over.format ?? "srt";
    return exportSummary({
      format, trackCodes: ["EN", "DE"], stacked: true, filePerTrack: false, cueCount: 1300, segCount: 1204,
      showTs: false, content: contentStates({ ...base, format }), hasSpeakers: true, firstName: "Narrator",
      cpsCount: 0, cpsLimit: "17 chars/s", editCount: 0, media: null, ...over,
    });
  };
  const row = (rows: ReturnType<typeof exportSummary>, label: string) => rows.find((r) => r.label === label);

  it("srt with cues: subtitles from segments, tracks stacked, reading speed fine", () => {
    const rows = sum();
    expect(rows.map((r) => r.label)).toEqual([
      "Cue timings", "Tracks", "Subtitle length", "Speaker names", "Speaker colors", "Reading speed", "Corrections",
    ]);
    expect(row(rows, "Subtitle length")).toEqual({ label: "Subtitle length", state: "on", why: "1,300 subtitles from 1,204 segments" });
    expect(row(rows, "Tracks")?.why).toBe("EN · DE — in that order inside each subtitle");
    expect(row(rows, "Speaker names")?.why).toBe("“Narrator:” before each line");
    expect(row(rows, "Reading speed")?.state).toBe("on");
  });
  it("as transcribed, own timing, fast subtitles, corrections and media", () => {
    const rows = sum({ cueCount: null, filePerTrack: true, stacked: false, cpsCount: 3, editCount: 2,
      media: { choice: "video", container: "mkv", subtitleMode: "both", audioExt: null } });
    expect(row(rows, "Subtitle length")).toMatchObject({ state: "off", why: "as transcribed — 1,204 subtitles" });
    expect(row(rows, "Tracks")?.why).toBe("EN · DE — one file each");
    expect(row(rows, "Reading speed")).toMatchObject({ state: "warn", why: "3 subtitles faster than 17 chars/s" });
    expect(row(rows, "Corrections")?.why).toBe("2 included");
    expect(row(rows, "Media")?.why).toBe("video in MKV, subtitles embedded and as files");
  });
  it("txt: no subtitle rows apply, no speaker rows without speakers", () => {
    const rows = sum({ format: "txt", hasSpeakers: false, content: contentStates({ ...base, format: "txt", hasSpeakers: false }) });
    expect(row(rows, "Subtitle length")?.state).toBe("na");
    expect(row(rows, "Reading speed")?.state).toBe("na");
    expect(row(rows, "Speaker names")).toBeUndefined();
  });
});
