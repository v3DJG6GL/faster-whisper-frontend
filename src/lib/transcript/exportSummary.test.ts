import { describe, expect, it } from "vitest";
import { contentStates, exportSummary, lengthNeedsWords, summaryCount, type ContentItem } from "./exportSummary";
import { cueGrid } from "./transcriptFormats";
import type { BatchResult } from "../types";

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
  it("site tracks alone carry no speakers: names and colors are na, JSON keeps them as data", () => {
    const site = { ...base, origIncluded: false, mtIncluded: false };
    for (const format of ["srt", "vtt", "txt", "lrc"] as const) {
      const c = contentStates({ ...site, format, colorize: false });
      expect([states(c).names, states(c).colors]).toEqual(["na", "na"]);
      expect(c.find((i) => i.key === "names")?.why).toBe("the site's own subtitles carry no speakers");
      expect(c.find((i) => i.key === "names")?.vttNames).toBeUndefined();
    }
    expect(states(contentStates({ ...site, format: "json" }))).toMatchObject({ names: "fixed", colors: "fixed" });
    // A site track beside the original: the original's lines still name their speakers.
    const withOrig = contentStates({ ...base, format: "vtt", colorize: false, mtIncluded: false });
    expect(withOrig.find((i) => i.key === "names")).toMatchObject({ state: "on", vttNames: "voice" });
  });
});

describe("exportSummary", () => {
  const sum = (over: Partial<Parameters<typeof exportSummary>[0]> = {}) => {
    const format = over.format ?? "srt";
    return exportSummary({
      format, trackCodes: ["EN", "DE"], stacked: true, filePerTrack: false, split: true, written: 1300, segCount: 1204,
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
  it("untimed txt names each speaker turn once, timed txt every line", () => {
    const txt = (showTs: boolean) => {
      const content = contentStates({ ...base, format: "txt", showTs });
      return [row(sum({ format: "txt", showTs, content }), "Speaker names")?.why, content.find((c) => c.key === "names")?.why];
    };
    expect(txt(false)).toEqual(["“Narrator:” before each turn", "the speaker's name before each turn"]);
    expect(txt(true)).toEqual(["“Narrator:” before each line", "the speaker's name before each line"]);
  });
  it("uncolored vtt names original lines as a voice tag, translated lines and colored vtt with Name:", () => {
    const vtt = (colorize: boolean, tracks: { origIncluded?: boolean; mtIncluded?: boolean }) => {
      const content = contentStates({ ...base, format: "vtt", colorize, ...tracks });
      return [row(sum({ format: "vtt", content }), "Speaker names")?.why, content.find((c) => c.key === "names")?.why];
    };
    expect(vtt(false, { mtIncluded: true })).toEqual([
      "as a voice tag (<v Narrator>) on original lines, “Narrator:” before translated lines",
      "the speaker's name as a voice tag on original lines (players may hide it), “Name:” before translated lines",
    ]);
    // Untranslated: every line is a voice span.
    expect(vtt(false, {})).toEqual([
      "as a voice tag (<v Narrator>) on each line",
      "the speaker's name as a voice tag on each line (players may hide it)",
    ]);
    // Translations only: every line carries "Name: ".
    expect(vtt(false, { origIncluded: false, mtIncluded: true })).toEqual([
      "“Narrator:” before each line", "the speaker's name before each line",
    ]);
    expect(vtt(true, { mtIncluded: true })).toEqual(["“Narrator:” before each line", "the speaker's name before each line"]);
  });
  it("site tracks alone: the speaker rows say the site has none, not “Name:” before each line", () => {
    for (const format of ["srt", "vtt"] as const) {
      const content = contentStates({ ...base, format, colorize: false, origIncluded: false, mtIncluded: false });
      const rows = sum({ format, content });
      const why = "the site's own subtitles carry no speakers";
      expect(row(rows, "Speaker names")).toEqual({ label: "Speaker names", state: "na", why });
      expect(row(rows, "Speaker colors")).toEqual({ label: "Speaker colors", state: "na", why });
    }
  });
  it("as transcribed, own timing, fast subtitles, corrections and media", () => {
    const rows = sum({ split: false, written: 1204, filePerTrack: true, stacked: false, cpsCount: 3, editCount: 2,
      media: { choice: "video", container: "mkv", subtitleMode: "both", audioExt: null } });
    expect(row(rows, "Subtitle length")).toMatchObject({ state: "off", why: "as transcribed — 1,204 subtitles" });
    expect(row(rows, "Tracks")?.why).toBe("EN · DE — one file each");
    expect(row(rows, "Reading speed")).toMatchObject({ state: "warn", why: "3 subtitles faster than 17 chars/s" });
    expect(row(rows, "Corrections")?.why).toBe("2 included");
    expect(row(rows, "Media")?.why).toBe("video in MKV, subtitles embedded and as files");
  });
  it("subtitle length counts what the shared file writes; own cues alone show no count", () => {
    // Translations only: the untranslated cues are not written, so fewer than the segments.
    expect(row(sum({ split: false, written: 3 }), "Subtitle length"))
      .toEqual({ label: "Subtitle length", state: "off", why: "as transcribed — 3 subtitles" });
    expect(row(sum({ written: 900 }), "Subtitle length")?.why).toBe("900 subtitles from 1,204 segments");
    const own = "each track's file has its own count";
    expect(row(sum({ ownOnly: true }), "Subtitle length")).toEqual({ label: "Subtitle length", state: "on", why: own });
    expect(row(sum({ ownOnly: true, split: false }), "Subtitle length")).toEqual({ label: "Subtitle length", state: "off", why: own });
  });
  it("a site track on its own beside a shared file: not \"one file each\"", () => {
    const rows = sum({ trackCodes: ["EN", "DE", "YouTube EN"], fileCount: 2, filePerTrack: false, stacked: false });
    expect(row(rows, "Tracks")?.why).toBe("EN · DE · YouTube EN — in 2 files, each site track on its own");
  });
  it("txt: no subtitle rows apply, no speaker rows without speakers", () => {
    const rows = sum({ format: "txt", hasSpeakers: false, content: contentStates({ ...base, format: "txt", hasSpeakers: false }) });
    expect(row(rows, "Subtitle length")?.state).toBe("na");
    expect(row(rows, "Reading speed")?.state).toBe("na");
    expect(row(rows, "Speaker names")).toBeUndefined();
  });
  it("plain-text source: placeholder clocks leave the reading speed unchecked, never fine", () => {
    expect(row(sum({ timingSynthesized: true }), "Reading speed"))
      .toEqual({ label: "Reading speed", state: "na", why: "not checked — the source has no timing" });
    expect(row(sum({ format: "txt", timingSynthesized: true, content: contentStates({ ...base, format: "txt" }) }), "Reading speed")?.state)
      .toBe("na");
  });
  it("plain-text source: the placeholder clocks are flagged, never a green timing row", () => {
    const warn = { state: "warn", why: "placeholders, 1 s per line — the source has no timing" };
    expect(row(sum({ timingSynthesized: true }), "Cue timings")).toMatchObject(warn);
    expect(row(sum({ format: "lrc", timingSynthesized: true, content: contentStates({ ...base, format: "lrc" }) }), "Line timings"))
      .toMatchObject(warn);
    expect(row(sum({ format: "json", timingSynthesized: true, content: contentStates({ ...base, format: "json" }) }), "Timestamps"))
      .toMatchObject(warn);
    const txt = (showTs: boolean) =>
      row(sum({ format: "txt", showTs, timingSynthesized: true, content: contentStates({ ...base, format: "txt", showTs }) }), "Timestamps");
    expect(txt(true)).toMatchObject(warn);
    expect(txt(false)).toMatchObject({ state: "off", why: "off" });
  });
  it("txt with two tracks: interleaved, never \"inside each subtitle\"", () => {
    const rows = sum({ format: "txt", content: contentStates({ ...base, format: "txt" }) });
    expect(row(rows, "Tracks")?.why).toBe("EN · DE — in that order, interleaved");
  });
});

describe("summaryCount", () => {
  /** A blank segment, an untranslated one, a zero-width-only translation, and a site track. */
  const r: BatchResult = {
    text: "a b c",
    language: "en",
    segments: [
      { start: 0, end: 1, text: "Hello.", translations: { de: "Hallo." } },
      { start: 1, end: 2, text: " " },
      { start: 2, end: 3, text: "Again.", translations: { de: "\u200B" } },
      { start: 3, end: 4, text: "Last." },
    ],
    timedTracks: [{ id: "de-x-site", lang: "de", source: "site", kind: "manual", cues: [{ start: 0, end: 1, text: "Hallo." }] }],
  };
  const grid = (tracks: string[], timing: "same" | "own" = "same") =>
    cueGrid(r, { format: "srt", cues: { length: "standard", timing } }, ["orig", ...tracks.filter((t) => t !== "orig")]);

  it("the original exported: every one of its cues, the blank one included", () => {
    expect(summaryCount(r, grid([]), [], undefined)).toEqual({ written: 4, ownOnly: false });
    expect(summaryCount(r, grid(["orig", "de"]), ["orig", "de"], undefined)).toEqual({ written: 4, ownOnly: false });
  });
  it("translations only: the shared file's cues, not the original's", () => {
    expect(summaryCount(r, grid(["de"]), ["de"], undefined)).toEqual({ written: 1, ownOnly: false });
    // A site track beside it has a file of its own; the count stays the shared file's.
    expect(summaryCount(r, grid(["de", "de-x-site"]), ["de", "de-x-site"], undefined)).toEqual({ written: 1, ownOnly: false });
  });
  it("every track on its own cues: no count, never a sum across files", () => {
    expect(summaryCount(r, grid(["de-x-site"]), ["de-x-site"], undefined)).toEqual({ written: 0, ownOnly: true });
    const own = { length: "standard", timing: "own" } as const;
    expect(summaryCount(r, grid(["de", "de-x-site"], "own"), ["de", "de-x-site"], own)).toEqual({ written: 0, ownOnly: true });
  });
  it("a file per track (sidecars, a video's streams): no count without the original, one track counts its file", () => {
    const fr: BatchResult = { ...r, segments: r.segments!.map((s, i) => (i === 3 ? { ...s, translations: { fr: "Fin." } } : s)) };
    const g = cueGrid(fr, { format: "srt", cues: { length: "standard", timing: "same" } }, ["orig", "de", "fr"]);
    expect(summaryCount(fr, g, ["de", "fr"], undefined)).toEqual({ written: 2, ownOnly: false });
    expect(summaryCount(fr, g, ["de", "fr"], undefined, true)).toEqual({ written: 0, ownOnly: true });
    expect(summaryCount(fr, g, ["de"], undefined, true)).toEqual({ written: 1, ownOnly: false });
    expect(summaryCount(fr, g, ["orig", "de", "fr"], undefined, true)).toEqual({ written: 4, ownOnly: false });
  });
});
