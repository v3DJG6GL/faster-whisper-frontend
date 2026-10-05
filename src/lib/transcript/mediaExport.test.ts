import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_MAX_WAIT_MS, BUSY_RETRY_MS, dequeueMediaExport, derivePickedStem, embeddedSubtitleTracks, exportStem, fileStem,
  isVideoSourcePath, legacyTrackIndices, linkSiteName, mediaExportPlan, queueMediaExport, queuedExportFor, revealAfterSaveOn,
  siteDisplayName, subscribeExportQueue, withTrackSites, mp4Disabled, sidecarFiles, sidecarNames, stemTimestamp,
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
    // The link info is ignored for a local file — its names stay as before.
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
    expect(stem).toHaveLength(prefix.length + 120);
    expect(stem).not.toMatch(/[\\/:*?"<>|\s]/);
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
