import { describe, expect, it } from "vitest";
import {
  derivePickedStem, embeddedSubtitleTracks, isSubtitleFormat, isVideoSourcePath, languageLabel,
  mediaExportPlan, mp4Disabled, sidecarFiles, sidecarName,
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
    // The original is a FLAG on the track, never part of its name.
    expect(tracks[0].label).toBe("German");
    expect(tracks[0].original).toBe(true);
    expect(tracks[1].label).toBe("English");
    expect(tracks[1].original).toBe(false);
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
    expect(tracks[0].label).toBe("UND");
  });
  it("sidecarFiles: one single-language file per track named stem.<code>.<ext>", () => {
    const files = sidecarFiles(result, { format: "txt" }, ["orig", "en"], "vtt");
    expect(files.map((f) => f.name("My talk"))).toEqual(["My talk.de.vtt", "My talk.en.vtt"]);
    expect(files[0].content).toMatch(/^WEBVTT/);
    expect(files[0].content).toContain("Hallo Welt");
    expect(files[0].content).not.toContain("Hello world");
    expect(files[1].content).toContain("Hello world");
    // Codes reach a path: keep them safe, never empty.
    expect(sidecarName("../x", "srt")("t")).toBe("t.x.srt");
    expect(sidecarName("!!", "srt")("t")).toBe("t.und.srt");
    expect(sidecarName("pt-BR", "srt")("t")).toBe("t.pt-BR.srt");
  });
  it("isSubtitleFormat: only SRT and VTT ride with a video", () => {
    expect(["srt", "vtt", "txt", "lrc", "json"].filter(isSubtitleFormat)).toEqual(["srt", "vtt"]);
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
      textFileNames: names, audioExt: "m4a", tracks: ["orig"], origLang: "de", hasVideoSource: true });
    expect(p.files.map((f) => f.kind)).toEqual(["text"]);
    expect(p.saveLabel).toBe("Save SRT");
    expect(p.primary.name("x")).toBe("x.srt");
  });
  it("audio → the copy first, then the text", () => {
    const p = mediaExportPlan({ choice: "audio", container: "mkv", subtitleMode: "embedded", format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig"], origLang: "de", hasVideoSource: false });
    expect(p.files.map((f) => f.kind)).toEqual(["audio", "text"]);
    expect(p.saveLabel).toBe("Save 2 files");
    expect(p.primaryExt).toBe("m4a");
  });
  it("video: embedded is one file, sidecar/both add the text and only embedded modes carry tracks", () => {
    const base = { choice: "video" as const, container: "mp4" as const, format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig", "en"], origLang: "de", hasVideoSource: true };
    const emb = mediaExportPlan({ ...base, subtitleMode: "embedded" });
    expect(emb.files.map((f) => f.kind)).toEqual(["video"]);
    expect(emb.embedded).toEqual(["orig", "en"]);
    expect(emb.sidecars).toBeNull();
    expect(emb.saveLabel).toBe("Save video");
    expect(emb.primary.name("talk")).toBe("talk.mp4");
    // Sidecars: one per language beside the video, not the bilingual text file.
    const side = mediaExportPlan({ ...base, subtitleMode: "sidecar" });
    expect(side.files.map((f) => f.name("talk"))).toEqual(["talk.mp4", "talk.de.srt", "talk.en.srt"]);
    expect(side.embedded).toEqual([]);
    expect(side.sidecars).toEqual({ tracks: ["orig", "en"], format: "srt" });
    expect(side.containerRelevant).toBe(false);
    const both = mediaExportPlan({ ...base, subtitleMode: "both", format: "vtt" });
    expect(both.files.map((f) => f.name("talk"))).toEqual(["talk.mp4", "talk.de.vtt", "talk.en.vtt"]);
    expect(both.embedded).toEqual(["orig", "en"]);
    expect(both.saveLabel).toBe("Save 3 files");
    // A stale non-subtitle format never names a sidecar nobody loads.
    const stale = mediaExportPlan({ ...base, subtitleMode: "sidecar", format: "txt" });
    expect(stale.sidecars?.format).toBe("srt");
  });
  it("video without a source degrades to the text plan", () => {
    const p = mediaExportPlan({ choice: "video", container: "mkv", subtitleMode: "embedded", format: "vtt",
      textFileNames: [], audioExt: null, tracks: [], origLang: "de", hasVideoSource: false });
    expect(p.files.map((f) => f.kind)).toEqual(["text"]);
    expect(p.saveLabel).toBe("Save VTT");
  });
});

describe("exportStem", () => {
  it("leads with the record title, cleaned for every file system, else the file's own name", async () => {
    const { exportStem } = await import("./mediaExport");
    expect(exportStem("Starkes Übergewicht – Ela | SRF", "https://www.youtube.com/watch?v=GnNIH6bCbtU&t=6s"))
      .toBe("Starkes Übergewicht – Ela SRF");
    expect(exportStem("  a/b\\c:d*e?f\"g<h>i|j.  ", "/x/y.mp4")).toBe("a b c d e f g h i j");
    expect(exportStem(undefined, "/tmp/interview-2026.mkv")).toBe("interview-2026");
    expect(exportStem("", "https://example.com/watch?v=abc")).toBe("watch?v=abc");
    expect(exportStem("x".repeat(200), "/a.mp4")).toHaveLength(120);
  });
});

describe("derivePickedStem", () => {
  it("strips the seeded first-file suffix, never double-suffixing siblings", () => {
    expect(derivePickedStem("/out/talk.de.lrc", ".de.lrc", "lrc")).toEqual({ dir: "/out/", stem: "talk" });
    expect(derivePickedStem("/out/renamed.lrc", ".de.lrc", "lrc")).toEqual({ dir: "/out/", stem: "renamed" });
    expect(derivePickedStem("C:\\out\\talk.mkv", ".mkv", "mkv")).toEqual({ dir: "C:\\out\\", stem: "talk" });
  });
});
