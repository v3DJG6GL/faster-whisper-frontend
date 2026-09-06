import { describe, expect, it } from "vitest";
import {
  derivePickedStem, embeddedSubtitleTracks, isVideoSourcePath, languageLabel,
  mediaExportPlan, mp4Disabled,
} from "./mediaExport";
import type { BatchResult } from "./types";

describe("isVideoSourcePath", () => {
  it("accepts the video containers, not audio or text", () => {
    expect(isVideoSourcePath("/a/talk.MP4")).toBe(true);
    expect(isVideoSourcePath("/a/talk.mkv")).toBe(true);
    expect(isVideoSourcePath("/a/talk.m4a")).toBe(false);
    expect(isVideoSourcePath("/a/talk.srt")).toBe(false);
    expect(isVideoSourcePath("https://x/v")).toBe(false);
  });
});

describe("mp4Disabled", () => {
  it("the server's verdict wins, then the file's streams, else allowed", () => {
    expect(mp4Disabled(null, { media_package: { containers: ["mkv"] } } as never)).toMatch(/MKV only/);
    expect(mp4Disabled({ mp4Ok: false, mp4Reason: "MP4 can't carry VP9" }, null)).toBe("MP4 can't carry VP9");
    expect(mp4Disabled({ mp4Ok: false }, null)).toMatch(/choose MKV/);
    expect(mp4Disabled({ mp4Ok: true }, { media_package: { containers: ["mkv", "mp4"] } } as never)).toBeNull();
    expect(mp4Disabled(null, null)).toBeNull();
  });
});

describe("embeddedSubtitleTracks", () => {
  const result: BatchResult = {
    text: "Hallo Welt",
    language: "de",
    segments: [
      { start: 0, end: 1, text: "Hallo Welt", speaker: "SPEAKER_00",
        translations: { en: "Hello world", fr: "Bonjour" } },
      { start: 1, end: 2, text: "Zweiter", speaker: "SPEAKER_01",
        translations: { en: "Second", fr: "Deuxième" } },
    ],
  };
  it("emits one single-language SRT per track, the original tagged by the result language", () => {
    const tracks = embeddedSubtitleTracks(result, { format: "srt", renames: { SPEAKER_00: "Anna" } }, ["orig", "en"]);
    expect(tracks.map((t) => t.lang)).toEqual(["de", "en"]);
    expect(tracks[0].label).toBe("German · original");
    expect(tracks[1].label).toBe("English");
    expect(tracks[0].srt).toContain("Hallo Welt");
    expect(tracks[0].srt).not.toContain("Hello world");
    expect(tracks[1].srt).toContain("Hello world");
    expect(tracks[1].srt).not.toContain("Hallo Welt");
    // Edits/renames ride along exactly as in the SRT export.
    expect(tracks[0].srt).toContain("Anna");
  });
  it("falls back to 'und' without a source language and skips empty tracks", () => {
    const tracks = embeddedSubtitleTracks({ ...result, language: undefined }, { format: "srt" }, ["orig", "xx"]);
    expect(tracks.map((t) => t.lang)).toEqual(["und"]);
    expect(tracks[0].label).toBe("UND · original");
  });
});

describe("languageLabel", () => {
  it("names known codes and keeps a region", () => {
    expect(languageLabel("pt-BR")).toBe("Portuguese (BR)");
    expect(languageLabel("fi")).toBe("Finnish");
    expect(languageLabel("xx")).toBe("XX");
  });
});

describe("mediaExportPlan", () => {
  const names = [(s: string) => `${s}.srt`];
  it("none → the text files only", () => {
    const p = mediaExportPlan({ choice: "none", container: "mkv", subtitleMode: "embedded", format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig"], hasVideoSource: true });
    expect(p.files.map((f) => f.kind)).toEqual(["text"]);
    expect(p.saveLabel).toBe("Save SRT");
    expect(p.primary.name("x")).toBe("x.srt");
  });
  it("audio → the copy first, then the text", () => {
    const p = mediaExportPlan({ choice: "audio", container: "mkv", subtitleMode: "embedded", format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig"], hasVideoSource: false });
    expect(p.files.map((f) => f.kind)).toEqual(["audio", "text"]);
    expect(p.saveLabel).toBe("Save 2 files");
    expect(p.primaryExt).toBe("m4a");
  });
  it("video: embedded is one file, sidecar/both add the text and only embedded modes carry tracks", () => {
    const base = { choice: "video" as const, container: "mp4" as const, format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig", "en"], hasVideoSource: true };
    const emb = mediaExportPlan({ ...base, subtitleMode: "embedded" });
    expect(emb.files.map((f) => f.kind)).toEqual(["video"]);
    expect(emb.embedded).toEqual(["orig", "en"]);
    expect(emb.saveLabel).toBe("Save video");
    expect(emb.primary.name("talk")).toBe("talk.mp4");
    const side = mediaExportPlan({ ...base, subtitleMode: "sidecar" });
    expect(side.files.map((f) => f.kind)).toEqual(["video", "text"]);
    expect(side.embedded).toEqual([]);
    expect(side.containerRelevant).toBe(false);
    const both = mediaExportPlan({ ...base, subtitleMode: "both" });
    expect(both.files.length).toBe(2);
    expect(both.embedded).toEqual(["orig", "en"]);
    expect(both.saveLabel).toBe("Save 2 files");
  });
  it("video without a source degrades to the text plan", () => {
    const p = mediaExportPlan({ choice: "video", container: "mkv", subtitleMode: "embedded", format: "vtt",
      textFileNames: [], audioExt: null, tracks: [], hasVideoSource: false });
    expect(p.files.map((f) => f.kind)).toEqual(["text"]);
    expect(p.saveLabel).toBe("Save VTT");
  });
});

describe("derivePickedStem", () => {
  it("strips the seeded first-file suffix, never double-suffixing siblings", () => {
    expect(derivePickedStem("/out/talk.de.lrc", ".de.lrc", "lrc")).toEqual({ dir: "/out/", stem: "talk" });
    expect(derivePickedStem("/out/renamed.lrc", ".de.lrc", "lrc")).toEqual({ dir: "/out/", stem: "renamed" });
    expect(derivePickedStem("C:\\out\\talk.mkv", ".mkv", "mkv")).toEqual({ dir: "C:\\out\\", stem: "talk" });
  });
});
