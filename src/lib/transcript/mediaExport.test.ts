import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_MAX_WAIT_MS, BUSY_RETRY_MS, audioPackageLang, cueTracks, dequeueMediaExport, derivePickedStem, embeddedSubtitleTracks, exportStem, fileStem, packageLang,
  isVideoSourcePath, legacyTrackIndices, linkServerAudioLive, linkSiteName, MAX_EMBED_SRT_BYTES, mediaExportPlan, oversizedEmbeddedTrack, queueMediaExport, queuedExportFor, revealAfterSaveOn,
  siteDisplayName, subscribeExportQueue, withTrackSites, mp4Disabled, sidecarFiles, sidecarNames, sidecarSource, stemTimestamp, tracksAtWrite,
} from "./mediaExport";
import type { BatchResult } from "../types";

describe("isVideoSourcePath", () => {
  it("accepts the video containers, not audio or text", () => {
    expect(isVideoSourcePath("/a/talk.MP4")).toBe(true);
    expect(isVideoSourcePath("/a/talk.mkv")).toBe(true);
    expect(isVideoSourcePath("/a/talk.m4a")).toBe(false);
    expect(isVideoSourcePath("/a/talk.srt")).toBe(false);
    expect(isVideoSourcePath("https://x/v")).toBe(false);
  });
});

describe("revealAfterSaveOn", () => {
  it("is on unless the user turned it off", () => {
    expect(revealAfterSaveOn(undefined)).toBe(true);
    expect(revealAfterSaveOn({})).toBe(true);
    expect(revealAfterSaveOn({ revealAfterSave: true })).toBe(true);
    expect(revealAfterSaveOn({ revealAfterSave: false })).toBe(false);
  });
});

describe("linkServerAudioLive", () => {
  it("needs an id, and an expiry that is absent or still ahead", () => {
    expect(linkServerAudioLive(undefined, 100)).toBe(false);
    expect(linkServerAudioLive({ sourceMediaExpiresAt: 200 }, 100)).toBe(false);
    expect(linkServerAudioLive({ sourceMediaId: "m1" }, 100)).toBe(true);
    expect(linkServerAudioLive({ sourceMediaId: "m1", sourceMediaExpiresAt: 50 }, 100)).toBe(false);
    expect(linkServerAudioLive({ sourceMediaId: "m1", sourceMediaExpiresAt: 100 }, 100)).toBe(false);
    expect(linkServerAudioLive({ sourceMediaId: "m1", sourceMediaExpiresAt: 200 }, 100)).toBe(true);
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
    expect(sidecarNames({ language: "!!" }, ["orig", "../x", "pt-BR"], "srt").map((n) => n("t")))
      .toEqual(["t.und.srt", "t.x.srt", "t.pt-BR.srt"]);
  });
  it("sidecarFiles skips a cue-less VTT track (a header and STYLE blocks are not subtitles)", () => {
    // Not translated yet, and every line kept as the source: both render no cue at all.
    expect(sidecarFiles(result, { format: "txt" }, ["orig", "xx"], "vtt").map((f) => f.name("s"))).toEqual(["s.de.vtt"]);
    const kept: BatchResult = { ...result, segments: result.segments?.map((s) => ({ ...s, translationsKept: ["fr"] })) };
    expect(sidecarFiles(kept, { format: "txt" }, ["orig", "fr"], "vtt").map((f) => f.name("s"))).toEqual(["s.de.vtt"]);
    expect(sidecarFiles(kept, { format: "txt" }, ["orig", "fr"], "srt").map((f) => f.name("s"))).toEqual(["s.de.srt"]);
  });
  it("a language's further tracks are labelled and carry their flags (D89)", () => {
    const site: BatchResult = {
      ...result,
      timedTracks: [
        { id: "de-x-site", lang: "de", source: "site", kind: "manual", site: "YouTube", hoh: true,
          cues: [{ start: 0, end: 1, text: "Hallo" }] },
        { id: "en-x-site", lang: "en", source: "site", kind: "auto", site: "YouTube", cues: [{ start: 0, end: 1, text: "Hi" }] },
      ],
    };
    const order = ["orig", "de-x-site", "en", "en-x-site"];
    const tracks = embeddedSubtitleTracks(site, { format: "srt" }, order, { en: "  English (DeepL)\u0007 " });
    expect(tracks.map((t) => [t.label, t.original, t.default, t.hearingImpaired])).toEqual([
      ["German [Whisper]", true, true, false],
      ["German [YouTube, SDH]", true, false, true],
      ["English (DeepL)", false, true, false],
      ["English [YouTube, auto-generated]", false, false, false],
    ]);
    expect(legacyTrackIndices(tracks)).toEqual({ defaultTrack: 0, originalTrack: 0 });
    expect(legacyTrackIndices(tracks.slice(2))).toEqual({ defaultTrack: 0, originalTrack: null });
    expect(legacyTrackIndices([])).toEqual({ defaultTrack: null, originalTrack: null });
    expect(sidecarFiles(site, { format: "srt" }, order, "srt").map((f) => f.name("s")))
      .toEqual(["s.de.srt", "s.YouTube.de.sdh.srt", "s.en.srt", "s.YouTube-auto.en.srt"]);
  });
  it("a language whose first track has no cue: the next one is its plain track (name, default, file)", () => {
    // French is a translation target with no French text yet; the YouTube French track has cues.
    const site: BatchResult = {
      text: "Hallo",
      language: "de",
      segments: [{ start: 0, end: 1, text: "Hallo" }],
      timedTracks: [
        { id: "fr-x-site", lang: "fr", source: "site", kind: "manual", site: "YouTube", cues: [{ start: 0, end: 1, text: "Salut" }] },
      ],
    };
    const chosen = ["orig", "fr", "fr-x-site"];
    const tracks = embeddedSubtitleTracks(site, { format: "srt" }, chosen);
    expect(tracks.map((t) => [t.lang, t.label, t.default])).toEqual([["de", "German", true], ["fr", "French", true]]);
    expect(tracks[1].srt).toContain("Salut");
    expect(sidecarFiles(site, { format: "srt" }, chosen, "srt").map((f) => f.name("s"))).toEqual(["s.de.srt", "s.fr.srt"]);
    // The panel plans over the same cue-bearing tracks, so its names match what is written.
    const kept = cueTracks(site, { format: "srt" }, chosen);
    expect(kept).toEqual(["orig", "fr-x-site"]);
    const plan = mediaExportPlan({
      choice: "video", container: "mkv", subtitleMode: "both", format: "srt", textFileNames: [],
      audioExt: null, tracks: kept, result: site, hasVideoSource: true,
    });
    expect(plan.files.filter((f) => f.kind === "text").map((f) => f.name("s"))).toEqual(["s.de.srt", "s.fr.srt"]);
  });
  it("a picked track with no cue at the click is written once its translation lands before the write", () => {
    const site = (fr?: string): BatchResult => ({
      text: "Hallo",
      language: "de",
      segments: [{ start: 0, end: 1, text: "Hallo", ...(fr ? { translations: { fr } } : {}) }],
      timedTracks: [
        { id: "fr-x-site", lang: "fr", source: "site", kind: "manual", site: "YouTube", cues: [{ start: 0, end: 1, text: "Salut" }] },
      ],
    });
    const picked = ["orig", "fr", "fr-x-site"];
    const opts = { format: "srt" as const };
    // At the click the French translation is still running: the plan holds the cue-bearing tracks.
    const planned = cueTracks(site(), opts, picked);
    expect(planned).toEqual(["orig", "fr-x-site"]);
    // It lands during the video's fetch: the write takes it, named as its language's plain track.
    const live = site("Bonjour");
    const now = tracksAtWrite(planned, picked, live, opts);
    expect(now).toEqual(["orig", "fr", "fr-x-site"]);
    expect(sidecarFiles(live, opts, now, "srt").map((f) => f.name("s"))).toEqual(["s.de.srt", "s.fr.srt", "s.YouTube.fr.srt"]);
    expect(embeddedSubtitleTracks(live, opts, now).map((t) => t.srt.includes("Bonjour"))).toEqual([false, true, false]);
    // Still running at the write: dropped, and the site track keeps the plain name.
    const still = tracksAtWrite(planned, picked, site(), opts);
    expect(still).toEqual(["orig", "fr-x-site"]);
    expect(sidecarFiles(site(), opts, still, "srt").map((f) => f.name("s"))).toEqual(["s.de.srt", "s.fr.srt"]);
  });
  it("the click's plan stands when the late tracks would go over the embed cap, or none has a cue", () => {
    const res: BatchResult = {
      text: "Hallo", language: "de",
      segments: [{ start: 0, end: 1, text: "Hallo", translations: { fr: "Salut", en: "Hello" } }],
    };
    const opts = { format: "srt" as const };
    expect(tracksAtWrite(["orig", "fr"], ["orig", "fr", "en"], res, opts, 2)).toEqual(["orig", "fr"]);
    expect(tracksAtWrite(["orig", "fr"], ["orig", "fr", "en"], res, opts, 3)).toEqual(["orig", "fr", "en"]);
    const empty: BatchResult = { text: "", language: "de", segments: [] };
    expect(tracksAtWrite(["orig"], ["orig"], empty, opts)).toEqual(["orig"]);
  });
  it("in \"both\" mode the sidecars carry exactly the embedded streams' result and tracks", () => {
    const at = (fr?: string, en?: string): BatchResult => ({
      text: "Hallo", language: "de",
      segments: [{ start: 0, end: 1, text: "Hallo", translations: { ...(fr ? { fr } : {}), ...(en ? { en } : {}) } }],
    });
    const opts = { format: "srt" as const };
    const picked = ["orig", "fr", "en"];
    // The streams were built before the queue wait: English was still running, French in.
    const early = at("Salut");
    const embedded = { res: early, tracks: tracksAtWrite(["orig", "fr"], picked, early, opts, 2) };
    // English lands while the video waits in the queue.
    const late = at("Salut", "Hello");
    const both = sidecarSource("both", embedded, ["orig", "fr"], picked, late, opts);
    expect(both.tracks).toEqual(["orig", "fr"]);
    expect(sidecarFiles(both.res, opts, both.tracks, "srt").map((f) => f.name("s"))).toEqual(["s.de.srt", "s.fr.srt"]);
    // Files beside the video only: decided at the write, no embed cap.
    const side = sidecarSource("sidecar", null, ["orig", "fr"], picked, late, opts);
    expect(side.tracks).toEqual(["orig", "fr", "en"]);
    expect(side.res).toBe(late);
    // "both" whose video carried no streams (none decided) falls back to the write's decision.
    expect(sidecarSource("both", null, ["orig", "fr"], picked, late, opts).tracks).toEqual(["orig", "fr", "en"]);
  });
  it("a site track's looser language tag embeds as one the packager accepts", () => {
    const site: BatchResult = {
      ...result,
      timedTracks: [
        { id: "zh-Hant-TW-x-site", lang: "zh-Hant-TW", source: "site", kind: "manual", site: "YouTube",
          cues: [{ start: 0, end: 1, text: "你好" }] },
        { id: "en-x-autogen-x-site", lang: "en-x-autogen", source: "site", kind: "auto", site: "Vimeo",
          cues: [{ start: 0, end: 1, text: "Hi" }] },
      ],
    };
    const tracks = embeddedSubtitleTracks(site, { format: "srt" }, ["orig", "zh-Hant-TW-x-site", "en-x-autogen-x-site"]);
    expect(tracks.map((t) => t.lang)).toEqual(["de", "zh", "en"]);
    expect(packageLang("pt-BR")).toBe("pt-BR");
    expect(packageLang("!!")).toBe("und");
  });
  it("tags the audio with the spoken language the way the original subtitle track is filed", () => {
    const tag = (language: string | undefined) => audioPackageLang({ language })?.lang ?? null;
    expect(["de", "pt-BR", "EN", "pt_BR", "zh-Hant-TW", " de "].map(tag)).toEqual(["de", "pt-BR", "en", "pt", "zh", "de"]);
    // Unknown (only format marks, blank, missing, a word): the source file's tag is kept.
    expect(["\u200e", "", undefined, "english"].map(tag)).toEqual([null, null, null, null]);
    // The title names the full spoken value, not the packager's cut.
    expect(audioPackageLang({ language: "zh-Hant-TW" })).toEqual({ lang: "zh", spoken: "zh-Hant-TW" });
    // The same tag the Original subtitle track gets.
    const res: BatchResult = { text: "Hi", language: "EN", segments: [{ start: 0, end: 1, text: "Hi" }] };
    expect(embeddedSubtitleTracks(res, { format: "srt" }, ["orig"])[0].lang).toBe(tag("EN"));
  });
});

describe("oversizedEmbeddedTrack", () => {
  const track = (label: string, srt: string) =>
    ({ lang: "de", label, srt, original: false, default: false, hearingImpaired: false });
  it("names the first track over the packager's cap, counted in UTF-8 bytes", () => {
    const atCap = track("At cap", "a".repeat(MAX_EMBED_SRT_BYTES));
    const over = track("Over", "a".repeat(MAX_EMBED_SRT_BYTES + 1));
    // 3 bytes per char: under the cap in UTF-16 units, over it in UTF-8 bytes.
    const wide = track("Wide", "語".repeat(Math.floor(MAX_EMBED_SRT_BYTES / 3) + 1));
    expect(wide.srt.length).toBeLessThan(MAX_EMBED_SRT_BYTES);
    expect(oversizedEmbeddedTrack([atCap])).toBeNull();
    expect(oversizedEmbeddedTrack([])).toBeNull();
    expect(oversizedEmbeddedTrack([atCap, over, wide])?.label).toBe("Over");
    expect(oversizedEmbeddedTrack([atCap, wide])?.label).toBe("Wide");
  });
});

describe("mediaExportPlan", () => {
  const names = [(s: string) => `${s}.srt`];
  it("none → the text files only", () => {
    const p = mediaExportPlan({ choice: "none", container: "mkv", subtitleMode: "embedded", format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig"], result: { language: "de" }, hasVideoSource: true });
    expect(p.files.map((f) => f.kind)).toEqual(["text"]);
    expect(p.saveLabel).toBe("Save SRT");
    expect(p.primary.name("x")).toBe("x.srt");
  });
  it("audio → the copy first, then the text", () => {
    const p = mediaExportPlan({ choice: "audio", container: "mkv", subtitleMode: "embedded", format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig"], result: { language: "de" }, hasVideoSource: false });
    expect(p.files.map((f) => f.kind)).toEqual(["audio", "text"]);
    expect(p.saveLabel).toBe("Save 2 files");
    expect(p.primaryExt).toBe("m4a");
  });
  it("video: embedded is one file, sidecar/both add the text and only embedded modes carry tracks", () => {
    const base = { choice: "video" as const, container: "mp4" as const, format: "srt",
      textFileNames: names, audioExt: "m4a", tracks: ["orig", "en"], result: { language: "de" }, hasVideoSource: true };
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
    const both = mediaExportPlan({ ...base, subtitleMode: "both", format: "vtt" });
    expect(both.files.map((f) => f.name("talk"))).toEqual(["talk.mp4", "talk.de.vtt", "talk.en.vtt"]);
    expect(both.embedded).toEqual(["orig", "en"]);
    expect(both.saveLabel).toBe("Save 3 files");
    // A stale non-subtitle format never names a sidecar nobody loads.
    const stale = mediaExportPlan({ ...base, subtitleMode: "sidecar", format: "txt" });
    expect(stale.sidecars?.format).toBe("srt");
  });
  it("video, sidecar plain copy: the file keeps the local video's own extension", () => {
    const base = { choice: "video" as const, container: "mkv" as const, format: "srt",
      textFileNames: names, audioExt: null, tracks: ["orig"], result: { language: "de" }, hasVideoSource: true,
      copyExt: "webm" };
    const side = mediaExportPlan({ ...base, subtitleMode: "sidecar" });
    expect(side.primary.name("talk")).toBe("talk.webm");
    expect(side.primaryExt).toBe("webm");
    expect(side.files.map((f) => f.name("talk"))).toEqual(["talk.webm", "talk.de.srt"]);
    // Packaged on the server (tracks ride inside): the chosen container names it.
    const emb = mediaExportPlan({ ...base, subtitleMode: "embedded" });
    expect(emb.primary.name("talk")).toBe("talk.mkv");
    expect(emb.primaryExt).toBe("mkv");
  });
  it("video without a source degrades to the text plan", () => {
    const p = mediaExportPlan({ choice: "video", container: "mkv", subtitleMode: "embedded", format: "vtt",
      textFileNames: [], audioExt: null, tracks: [], result: { language: "de" }, hasVideoSource: false });
    expect(p.files.map((f) => f.kind)).toEqual(["text"]);
    expect(p.saveLabel).toBe("Save VTT");
  });
});

describe("exportStem", () => {
  it("local files: the record title, cleaned for every file system, else the file's own name", () => {
    expect(exportStem("Starkes Übergewicht – Ela | SRF", "/v/talk.mp4")).toBe("Starkes Übergewicht – Ela SRF");
    expect(exportStem("  a/b\\c:d*e?f\"g<h>i|j.  ", "/x/y.mp4")).toBe("a b c d e f g h i j");
    expect(exportStem(undefined, "/tmp/interview-2026.mkv")).toBe("interview-2026");
    expect(exportStem(undefined, "C:\\rec\\Interview 2026.wav")).toBe("Interview 2026");
    expect(exportStem("x".repeat(200), "/a.mp4")).toHaveLength(120);
    // The bound never splits an emoji into a lone surrogate.
    expect(exportStem("a".repeat(119) + "\u{1F600}" + "b", "/a.mp4")).toBe("a".repeat(119));
    // The file's own name is bounded too: a sidecar's suffix plus ".tmp" fits the 255-byte name cap.
    const long = exportStem(undefined, "/home/u/" + "会議".repeat(39) + ".mp4");
    expect(new TextEncoder().encode(long + ".Machine-translation.de.srt.tmp").length).toBeLessThanOrEqual(255);
    expect(long).toBe(exportStem("会議".repeat(39), "/home/u/x.mp4"));
    expect(exportStem(undefined, "/tmp/a:b?.mkv")).toBe("a b");
    expect(exportStem("Talk", "/a.mp4", { createdAt: new Date(2026, 9, 4, 19, 34), extractor: "Youtube" })).toBe("Talk");
  });

  it("links: <YYYY.MM.DD>_<HH.MM>_<site>___<title>, local time, underscores, accents kept", () => {
    const createdAt = new Date(2026, 9, 4, 19, 34).toISOString();
    expect(exportStem("El declive de un régimen", "https://www.rtve.es/play/videos/x/123/", { createdAt }))
      .toBe("2026.10.04_19.34_rtve___El_declive_de_un_régimen");
    expect(exportStem("Starkes Übergewicht – Ela | SRF", "https://www.youtube.com/watch?v=GnNIH6bCbtU&t=6s", { createdAt }))
      .toBe("2026.10.04_19.34_youtube___Starkes_Übergewicht_–_Ela_SRF");
  });

  it("links: unknown parts are left out, the URL tail is the title's cleaned last resort", () => {
    expect(exportStem("Talk", "https://youtu.be/q")).toBe("youtube___Talk");
    expect(exportStem("Talk", "http://192.168.1.5/a.mp4", { createdAt: new Date(2026, 0, 2, 3, 4) }))
      .toBe("2026.01.02_03.04___Talk");
    expect(exportStem("Talk", "http://192.168.1.5/a.mp4", { extractor: "Vimeo" })).toBe("vimeo___Talk");
    expect(exportStem("", "https://example.com/watch?v=abc")).toBe("example___watch_v=abc");
    expect(exportStem(null, "https://example.com/")).toBe("example___transcript");
    expect(exportStem("Talk", "https://www.rtve.es/x", { createdAt: "not a date" })).toBe("rtve___Talk");
  });

  it("links: a long title is bounded and stays path-safe", () => {
    const prefix = "2026.10.04_19.34_rtve___";
    const stem = exportStem(`${"é".repeat(150)} a/b`, "https://www.rtve.es/x", { createdAt: new Date(2026, 9, 4, 19, 34) });
    expect(stem.startsWith(prefix)).toBe(true);
    // 2-byte letters: the UTF-8 budget (140 B) binds before the 120-unit cap.
    expect(stem).toHaveLength(prefix.length + 70);
    expect(stem).not.toMatch(/[\\/:*?"<>|\s]/);
  });

  it("links: a CJK title fits a 255-byte file name with the longest suffix and .tmp", () => {
    const createdAt = new Date(2026, 9, 4, 19, 34);
    const title = "【公式】" + "日本語のタイトル".repeat(12); // 100 characters, 300 bytes
    const stem = exportStem(title, "https://www.youtube.com/watch?v=abc", { createdAt, extractor: "Youtube" });
    expect(stem.startsWith("2026.10.04_19.34_youtube___【公式】日本語")).toBe(true);
    const bytes = new TextEncoder().encode(stem + ".YouTube-auto.zh-Hant.sdh.srt.tmp").length;
    expect(bytes).toBeLessThanOrEqual(255);
    // Cut at a code point, never inside a character.
    expect(stem).not.toContain("\uFFFD");
    expect(stem).not.toMatch(/[\uD800-\uDFFF]/);
    // An ASCII title under both caps is unchanged.
    expect(exportStem("A plain talk title", "https://www.youtube.com/watch?v=abc", { createdAt }))
      .toBe("2026.10.04_19.34_youtube___A_plain_talk_title");
    // A cut that ends on a space or dot leaves neither behind.
    expect(exportStem("日".repeat(46) + " .x", "/a.mp4")).toBe("日".repeat(46));
  });
});

describe("stemTimestamp", () => {
  it("zero-pads every field and reads the LOCAL clock", () => {
    expect(stemTimestamp(new Date(2026, 0, 5, 7, 3))).toBe("2026.01.05_07.03");
    // An ISO (UTC) string renders in local time, like the viewer's "04 OCT, 19:34".
    expect(stemTimestamp(new Date(2026, 11, 31, 23, 59).toISOString())).toBe("2026.12.31_23.59");
    expect(stemTimestamp(undefined)).toBe("");
    expect(stemTimestamp("garbage")).toBe("");
  });
});

describe("linkSiteName", () => {
  it("takes the label just left of the public suffix", () => {
    expect(linkSiteName("https://www.rtve.es/play/x")).toBe("rtve");
    expect(linkSiteName("https://youtube.com/watch?v=1")).toBe("youtube");
    expect(linkSiteName("https://m.youtube.com/watch?v=1")).toBe("youtube");
    expect(linkSiteName("https://youtu.be/abc")).toBe("youtube");
    expect(linkSiteName("https://play.srf.ch/x")).toBe("srf");
    expect(linkSiteName("https://www.bbc.co.uk/iplayer/x")).toBe("bbc");
    expect(linkSiteName("https://abc.net.au/x")).toBe("abc");
    expect(linkSiteName("https://www.nhk.or.jp/x")).toBe("nhk");
    expect(linkSiteName("https://WWW.Arte.TV./x")).toBe("arte");
  });

  it("falls back to the extractor (lowercased) for IPs and unusable hosts, else nothing", () => {
    expect(linkSiteName("http://192.168.1.5:8080/a.mp4", "Youtube")).toBe("youtube");
    expect(linkSiteName("http://[::1]/a.mp4", "BBCiPlayer")).toBe("bbciplayer");
    expect(linkSiteName("http://localhost/a.mp4", "youtube:tab")).toBe("youtube");
    expect(linkSiteName("http://192.168.1.5/a.mp4", "Generic")).toBe("");
    expect(linkSiteName("http://192.168.1.5/a.mp4")).toBe("");
    expect(linkSiteName("not a url")).toBe("");
  });

  it("never reads Object.prototype for a site named like one of its keys", () => {
    expect(linkSiteName("https://www.constructor.io/v")).toBe("constructor");
    expect(siteDisplayName("https://www.constructor.io/v")).toBe("Constructor");
    expect(siteDisplayName("http://192.168.1.5/a.mp4", "toString")).toBe("Tostring");
    expect(exportStem("Talk", "https://www.constructor.io/v")).toBe("constructor___Talk");
  });
});

describe("siteDisplayName", () => {
  it("writes a site as people do, capitalises the rest, empty when unknown", () => {
    expect(siteDisplayName("https://youtu.be/abc")).toBe("YouTube");
    expect(siteDisplayName("https://play.srf.ch/x")).toBe("SRF");
    expect(siteDisplayName("https://www.rtve.es/play/x")).toBe("RTVE");
    expect(siteDisplayName("https://www.arte.tv/x")).toBe("arte");
    expect(siteDisplayName("https://vimeo.com/1")).toBe("Vimeo");
    expect(siteDisplayName("https://www.example.org/v")).toBe("Example");
    expect(siteDisplayName("http://192.168.1.5/a.mp4", "Generic")).toBe("");
  });

  it("withTrackSites fills a missing site from the link, else leaves the result alone", () => {
    const tt = { id: "de-x-site", lang: "de", source: "site" as const, kind: "manual" as const, cues: [] };
    const res = { text: "", timedTracks: [tt, { ...tt, id: "en-x-site", site: "SRF" }] };
    const out = withTrackSites(res, "https://www.youtube.com/watch?v=1");
    expect(out.timedTracks!.map((t) => t.site)).toEqual(["YouTube", "SRF"]);
    expect(withTrackSites(res, "/home/a.mp4")).toBe(res);
    expect(withTrackSites(out, "https://www.youtube.com/watch?v=1")).toBe(out);
    // A host that names no site falls back to the extractor, as the run's own naming does.
    expect(withTrackSites(res, "http://192.168.1.5/a.mp4", "Youtube").timedTracks![0].site).toBe("YouTube");
  });
});

describe("derivePickedStem", () => {
  it("strips the seeded first-file suffix, never double-suffixing siblings", () => {
    expect(derivePickedStem("/out/talk.de.lrc", ".de.lrc", "lrc")).toEqual({ dir: "/out/", stem: "talk" });
    expect(derivePickedStem("/out/renamed.lrc", ".de.lrc", "lrc")).toEqual({ dir: "/out/", stem: "renamed" });
    expect(derivePickedStem("C:\\out\\talk.mkv", ".mkv", "mkv")).toEqual({ dir: "C:\\out\\", stem: "talk" });
  });
});

describe("fileStem", () => {
  it("the file name without its last extension, either separator", () => {
    expect(fileStem("/out/talk.de.srt")).toBe("talk.de");
    expect(fileStem("C:\\out\\talk.mkv")).toBe("talk");
    expect(fileStem("/out/")).toBe("");
  });
});

describe("queueMediaExport", () => {
  type Out = { kind: string };
  /** An attempt the test settles by hand; `calls` counts how often it ran. */
  function gate() {
    const g = { calls: 0, settle: (_o: Out) => {}, fail: (_e: Error) => {} };
    const attempt = () => {
      g.calls += 1;
      return new Promise<Out>((res, rej) => {
        g.settle = res;
        g.fail = rej;
      });
    };
    return { g, attempt };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs exports one at a time in Save order; the waiting one reads as queued", async () => {
    const a = gate();
    const b = gate();
    const seen: (string | null)[] = [];
    const unsub = subscribeExportQueue(() => seen.push(queuedExportFor("rec-b")));
    const pa = queueMediaExport("ja", "rec-a", a.attempt);
    const pb = queueMediaExport("jb", "rec-b", b.attempt);
    await flush();
    expect([a.g.calls, b.g.calls]).toEqual([1, 0]);
    expect(queuedExportFor("rec-a")).toBeNull(); // running, not waiting
    expect(queuedExportFor("rec-b")).toBe("jb");
    a.g.settle({ kind: "ok" });
    await expect(pa).resolves.toEqual({ kind: "ok" });
    await flush();
    expect(b.g.calls).toBe(1);
    expect(queuedExportFor("rec-b")).toBeNull();
    b.g.settle({ kind: "error" });
    await expect(pb).resolves.toEqual({ kind: "error" });
    expect(seen).toContain("jb");
    expect(seen[seen.length - 1]).toBeNull();
    unsub();
  });

  it("cancelling a waiting export only dequeues it; the running one carries on", async () => {
    const a = gate();
    const b = gate();
    const c = gate();
    const pa = queueMediaExport("ja", "rec-a", a.attempt);
    const pb = queueMediaExport("jb", "rec-b", b.attempt);
    const pc = queueMediaExport("jc", "rec-c", c.attempt);
    await flush();
    expect(dequeueMediaExport("ja")).toBe(false); // running: not the queue's to cancel
    expect(dequeueMediaExport("jb")).toBe(true);
    await expect(pb).resolves.toBeNull();
    expect(dequeueMediaExport("jb")).toBe(false);
    a.g.settle({ kind: "ok" });
    await expect(pa).resolves.toEqual({ kind: "ok" });
    await flush();
    expect(b.g.calls).toBe(0);
    expect(c.g.calls).toBe(1);
    c.g.settle({ kind: "ok" });
    await expect(pc).resolves.toEqual({ kind: "ok" });
  });

  it("a busy server slot is retried every BUSY_RETRY_MS, holding the turn and reading as queued", async () => {
    const a = gate();
    const b = gate();
    const pa = queueMediaExport("ja", "rec-a", a.attempt);
    const pb = queueMediaExport("jb", "rec-b", b.attempt);
    await flush();
    a.g.settle({ kind: "busy" });
    await flush();
    expect(queuedExportFor("rec-a")).toBe("ja");
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS - 1);
    expect(a.g.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.g.calls).toBe(2);
    expect(b.g.calls).toBe(0); // the head keeps its turn
    a.g.settle({ kind: "ok" });
    await expect(pa).resolves.toEqual({ kind: "ok" });
    await flush();
    expect(b.g.calls).toBe(1);
    b.g.settle({ kind: "ok" });
    await pb;
  });

  it("cancelling during a busy wait stops the retries and lets the next export start at once", async () => {
    const a = gate();
    const b = gate();
    const pa = queueMediaExport("ja", "rec-a", a.attempt);
    const pb = queueMediaExport("jb", "rec-b", b.attempt);
    await flush();
    a.g.settle({ kind: "busy" });
    await flush();
    expect(dequeueMediaExport("ja")).toBe(true);
    await expect(pa).resolves.toBeNull();
    await flush();
    expect(b.g.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
    expect(a.g.calls).toBe(1);
    b.g.settle({ kind: "ok" });
    await pb;
  });

  it("counts the busy wait from the first busy answer, not from a long upload before it", async () => {
    let calls = 0;
    // The first attempt uploads for longer than the whole busy window, then hears "busy".
    const p = queueMediaExport("ju", "rec-u", async () => {
      calls += 1;
      if (calls === 1) await new Promise((r) => setTimeout(r, BUSY_MAX_WAIT_MS + 60_000));
      return { kind: calls < 3 ? "busy" : "ok" };
    });
    await vi.advanceTimersByTimeAsync(BUSY_MAX_WAIT_MS + 60_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * BUSY_RETRY_MS);
    await expect(p).resolves.toEqual({ kind: "ok" });
    expect(calls).toBe(3);
  });

  it("gives up on a slot that stays busy past BUSY_MAX_WAIT_MS, and a throw never wedges the chain", async () => {
    let calls = 0;
    const pa = queueMediaExport("ja", "rec-a", async () => {
      calls += 1;
      return { kind: "busy" };
    });
    const b = gate();
    const pb = queueMediaExport("jb", "rec-b", b.attempt);
    const c = gate();
    const pc = queueMediaExport("jc", "rec-c", c.attempt);
    await vi.advanceTimersByTimeAsync(BUSY_MAX_WAIT_MS);
    await expect(pa).resolves.toEqual({ kind: "busy" });
    expect(calls).toBe(BUSY_MAX_WAIT_MS / BUSY_RETRY_MS + 1);
    await flush();
    b.g.fail(new Error("boom"));
    await expect(pb).rejects.toThrow("boom");
    await flush();
    expect(c.g.calls).toBe(1);
    c.g.settle({ kind: "ok" });
    await pc;
  });
});
