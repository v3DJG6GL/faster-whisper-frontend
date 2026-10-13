import { describe, expect, it } from "vitest";
import {
  cleanTrackTitle, defaultTrackOrder, dropSlotAt, defaultViewTracks, languageGroups, mergeOrder, moveItem, moveLanguage, moveTrack, planTracks, sourceWord, stepSlot,
  readTrackPrefs, toggleLanguage, toggleTrack, trackChipLabel, trackCode, trackFileSuffixes, trackInfo, trackOrder, transcriptTracks,
  translationTracks,
} from "./exportTracks";
import type { BatchResult } from "../types";

const site = (id: string, lang: string, extra: object = {}) =>
  ({ id, lang, source: "site" as const, kind: "manual" as const, site: "YouTube", cues: [], ...extra });
const RESULT: BatchResult = {
  text: "", language: "de",
  timedTracks: [site("de-x-site", "de"), site("de-x-site-auto", "de", { kind: "auto" }), site("de-x-site-hoh", "de", { hoh: true }),
    site("en-x-site", "en", { site: undefined })],
};

describe("source words", () => {
  it("Whisper, Machine translation, <Site>, <Site> auto, <Site> SDH — Site when unknown", () => {
    expect(["orig", "en", "de-x-site", "de-x-site-auto", "de-x-site-hoh", "en-x-site"].map((t) => trackChipLabel(RESULT, t)))
      .toEqual(["DE · Whisper", "EN · Machine translation", "DE · YouTube", "DE · YouTube auto", "DE · YouTube SDH", "EN · Site"]);
    expect(trackInfo({}, "orig")).toEqual({ id: "orig", lang: "und", source: "whisper", hoh: false });
    expect(sourceWord(trackInfo(RESULT, "de-x-site-hoh"))).toBe("YouTube SDH");
  });
  it("track codes: one fallback (UND) for the original, a target and a site track", () => {
    expect(["orig", "en", "de-x-site"].map((t) => trackCode(RESULT, t))).toEqual(["DE", "EN", "DE"]);
    expect(trackCode({}, "orig")).toBe("UND");
    expect(trackCode({ language: "  " }, "orig")).toBe("UND");
    expect(trackCode({ language: "\u200e" }, "orig")).toBe("UND");
    expect(trackChipLabel({ language: "\u200e" }, "orig")).toBe("UND · Whisper");
  });
});

// The D88 scenario: Whisper German, machine-translated to English, YouTube's German + English.
const LINK: BatchResult = {
  text: "", language: "de",
  timedTracks: [site("de-x-site", "de"), site("en-x-site", "en"), site("de-x-site-auto", "de", { kind: "auto" })],
};
const ALL = ["orig", "en", "de-x-site", "en-x-site", "de-x-site-auto"];

describe("track order (D92)", () => {
  it("default: the spoken language first; Whisper, the site's, its auto, machine translation", () => {
    expect(defaultTrackOrder(LINK, ALL)).toEqual(["orig", "de-x-site", "de-x-site-auto", "en-x-site", "en"]);
    expect(defaultTrackOrder({ ...LINK, language: "fr" }, ALL)).toEqual(["orig", "en-x-site", "en", "de-x-site", "de-x-site-auto"]);
  });
  it("a saved order wins; new tracks join their language, new languages the end", () => {
    const saved = ["en", "en-x-site", "de-x-site", "orig"];
    expect(trackOrder(LINK, ALL, saved)).toEqual(["en", "en-x-site", "de-x-site", "orig", "de-x-site-auto"]);
    expect(trackOrder(LINK, [...ALL, "fr"], ["de-x-site"])).toEqual(["de-x-site", "orig", "de-x-site-auto", "en-x-site", "en", "fr"]);
    expect(trackOrder(LINK, ALL, ["gone"])).toEqual(defaultTrackOrder(LINK, ALL));
  });
  it("moves languages and tracks within their language, by drop slot or Alt+arrow step", () => {
    const order = defaultTrackOrder(LINK, ALL);
    expect(languageGroups(LINK, order).map((g) => g.lang)).toEqual(["de", "en"]);
    expect(moveLanguage(LINK, order, "en", 0)).toEqual(["en-x-site", "en", "orig", "de-x-site", "de-x-site-auto"]);
    expect(moveLanguage(LINK, order, "de", stepSlot(0, 1))).toEqual(["en-x-site", "en", "orig", "de-x-site", "de-x-site-auto"]);
    expect(moveLanguage(LINK, order, "de", stepSlot(0, -1))).toEqual(order);
    expect(moveTrack(LINK, order, "de-x-site", 0)).toEqual(["de-x-site", "orig", "de-x-site-auto", "en-x-site", "en"]);
    expect(moveTrack(LINK, order, "orig", 3)).toEqual(["de-x-site", "de-x-site-auto", "orig", "en-x-site", "en"]);
    expect(moveTrack(LINK, order, "en", stepSlot(1, -1))).toEqual(["orig", "de-x-site", "de-x-site-auto", "en", "en-x-site"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("a view that hides some tracks (Read's Segments)", () => {
  const order = defaultTrackOrder(LINK, ALL);
  it("merges a reorder of the shown tracks back into the whole order", () => {
    expect(mergeOrder(LINK, order, ["en", "orig"])).toEqual(["en-x-site", "en", "orig", "de-x-site", "de-x-site-auto"]);
    expect(mergeOrder(LINK, order, ["orig", "en"])).toEqual(order);
    // A language the view doesn't show at all keeps its slot.
    const fr = ["orig", "de-x-site", "fr-x-site", "en"];
    const withFr = { ...LINK, timedTracks: [...LINK.timedTracks!, site("fr-x-site", "fr")] };
    expect(mergeOrder(withFr, fr, ["en", "orig"])).toEqual(["en", "fr-x-site", "orig", "de-x-site"]);
  });
  it("shows the original and the first track of each other language — three at most", () => {
    expect(defaultViewTracks(LINK, order)).toEqual(["orig", "en-x-site"]);
    expect(defaultViewTracks(LINK, ["en", "en-x-site", "de-x-site", "orig"])).toEqual(["en", "orig"]);
    expect(defaultViewTracks(LINK, [...order, "fr", "es"])).toEqual(["orig", "en-x-site", "fr"]);
    expect(defaultViewTracks(LINK, ["de-x-site", "en"])).toEqual(["de-x-site", "en"]);
  });
});

describe("picking tracks (D88)", () => {
  const order = defaultTrackOrder(LINK, ALL);
  it("the code switches the whole language: off, then on again without the auto-generated", () => {
    const off = toggleLanguage(LINK, order, order, "de")!;
    expect(off).toEqual(["en-x-site", "en"]);
    expect(toggleLanguage(LINK, order, off, "de")).toEqual(["orig", "de-x-site", "en-x-site", "en"]);
    expect(toggleLanguage(LINK, order, ["orig"], "de")).toBeNull();
    const autoOnly = { ...LINK, language: "fr" };
    expect(toggleLanguage(autoOnly, ["de-x-site-auto", "en"], ["en"], "de")).toEqual(["de-x-site-auto", "en"]);
  });
  it("a part switches its track; at least one stays on", () => {
    expect(toggleTrack(order, ["orig"], "en")).toEqual(["orig", "en"]);
    expect(toggleTrack(order, ["orig", "en"], "orig")).toEqual(["en"]);
    expect(toggleTrack(order, ["orig"], "orig")).toBeNull();
  });
});

describe("names, flags and files (D89)", () => {
  it("a language's single track is plain; several each name their source", () => {
    const plan = planTracks(LINK, ["orig", "de-x-site", "de-x-site-auto", "en"]);
    expect(plan.map((t) => [t.title, t.plain, t.original])).toEqual([
      ["German [Whisper]", true, true],
      ["German [YouTube]", false, true],
      ["German [YouTube, auto-generated]", false, true],
      ["English", true, false],
    ]);
    expect(planTracks(LINK, ["en", "en-x-site"]).map((t) => t.title)).toEqual(["English [Machine translation]", "English [YouTube]"]);
    expect(planTracks(RESULT, ["de-x-site-hoh", "orig"]).map((t) => [t.title, t.plain, t.hoh]))
      .toEqual([["German [YouTube, SDH]", true, true], ["German [Whisper]", false, false]]);
  });
  it("custom titles: cleaned, bounded to 64, blank = the default", () => {
    const plan = planTracks(LINK, ["orig", "en"], { orig: "Deutsch\u0000 (Whisper)", en: "   " });
    expect(plan.map((t) => t.title)).toEqual(["Deutsch (Whisper)", "English"]);
    expect(cleanTrackTitle("x".repeat(80))).toHaveLength(64);
  });
  it("the 64 cap counts code points, never leaving half an emoji", () => {
    const r = cleanTrackTitle("a" + "\u{1F600}".repeat(80));
    expect(Array.from(r)).toHaveLength(64);
    expect(r).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("a spoken language of only format marks still marks the original track original and first", () => {
    const r = { language: "\u200e" };
    expect(planTracks(r, ["orig", "fr"]).map((t) => t.original)).toEqual([true, false]);
    expect(defaultTrackOrder(r, ["fr", "orig"])).toEqual(["orig", "fr"]);
    expect(planTracks({}, ["orig"])[0].original).toBe(false);
  });
  it("a target spelled like an Object.prototype member gets its default title, not a crash", () => {
    const plan = planTracks({ language: "de" }, ["orig", "toString"]);
    expect(plan[1].title).toBe(plan[1].defaultTitle);
    expect(cleanTrackTitle({} as unknown as string)).toBe("");
  });
  it("files: plain stem.de.srt, others stem.<Label>.de.srt, SDH after the language, never two alike", () => {
    const plan = planTracks(RESULT, ["orig", "de-x-site", "de-x-site-auto", "de-x-site-hoh", "en", "en-x-site"]);
    expect(trackFileSuffixes(plan, "srt")).toEqual([
      ".de.srt", ".YouTube.de.srt", ".YouTube-auto.de.srt", ".YouTube.de.sdh.srt", ".en.srt", ".Site.en.srt",
    ]);
    expect(trackFileSuffixes(plan, "srt", { origBare: true }).slice(0, 2)).toEqual([".srt", ".YouTube.de.srt"]);
    // A plain name already taken falls back to the labelled one; a labelled clash numbers.
    const twins = planTracks({ ...RESULT, timedTracks: [site("a", "de"), site("b", "de")] }, ["a", "b", "en"]);
    expect(trackFileSuffixes(twins, "vtt", { taken: [".en.vtt"] })).toEqual([".de.vtt", ".YouTube.de.vtt", ".Machine-translation.en.vtt"]);
    expect(trackFileSuffixes(planTracks({ ...RESULT, timedTracks: [site("a", "de"), site("b", "de"), site("c", "de")] }, ["a", "b", "c"]), "srt"))
      .toEqual([".de.srt", ".YouTube.de.srt", ".YouTube-2.de.srt"]);
    expect(trackFileSuffixes(planTracks({ timedTracks: [site("x", "de", { site: "ARD Mediathek/../" })] }, ["orig", "x"]), "srt"))
      .toEqual([".und.srt", ".de.srt"]);
    expect(trackFileSuffixes(planTracks({ language: "de", timedTracks: [site("x", "de", { site: "ARD Mediathek/../" })] }, ["orig", "x"]), "srt"))
      .toEqual([".de.srt", ".ARD-Mediathek.de.srt"]);
  });
});

describe("per-transcript prefs", () => {
  it("reads back only well-formed order and names", () => {
    expect(readTrackPrefs({ order: ["orig", 3, "en"], names: { en: "English", x: 1, y: "z".repeat(99) } }))
      .toEqual({ order: ["orig", "en"], names: { en: "English", y: "z".repeat(64) } });
    expect(readTrackPrefs("nope")).toEqual({});
    expect(readTrackPrefs({ names: ["a"] })).toEqual({});
    const emoji = readTrackPrefs({ names: { en: "a" + "\u{1F600}".repeat(80) } }).names!.en;
    expect(emoji).toBe("a" + "\u{1F600}".repeat(63));
  });
});

describe("a transcript's tracks", () => {
  it("the original, the targets then any other translated language, the site's tracks", () => {
    const r: BatchResult = {
      text: "",
      translation: { targets: ["fr", "en"] },
      segments: [{ start: 0, end: 1, text: "a", translations: { en: "x", it: "y" } }],
      timedTracks: [site("de-x-site", "de")],
    };
    expect(translationTracks(r)).toEqual(["fr", "en", "it"]);
    expect(transcriptTracks(r)).toEqual(["orig", "fr", "en", "it", "de-x-site"]);
    expect(transcriptTracks({})).toEqual(["orig"]);
  });
});

describe("dropSlotAt", () => {
  // Three 28-px chips on one row: [0..40] [50..90] [100..140].
  const row = [0, 50, 100].map((left) => ({ top: 100, bottom: 128, left, width: 40 }));

  it("on the row: before the first item whose middle is right of the pointer, else the end", () => {
    expect(dropSlotAt(row, 45, 114)).toBe(1);
    expect(dropSlotAt(row, 10, 114)).toBe(0);
    expect(dropSlotAt(row, 200, 114)).toBe(3);
  });

  it("a pointer drifting a little above or below a one-row strip still drops along the row", () => {
    expect(dropSlotAt(row, 45, 98)).toBe(1);
    expect(dropSlotAt(row, 45, 130)).toBe(1);
    expect(dropSlotAt(row, 200, 60)).toBe(3);
  });

  it("wrapped rows: a pointer above a lower row's item still means before it", () => {
    // Two rows: [0..40] [50..90] on top, [0..40] below.
    const rows = [
      { top: 100, bottom: 128, left: 0, width: 40 },
      { top: 100, bottom: 128, left: 50, width: 40 },
      { top: 136, bottom: 164, left: 0, width: 40 },
    ];
    expect(dropSlotAt(rows, 200, 132)).toBe(2);
    expect(dropSlotAt(rows, 10, 150)).toBe(2);
    expect(dropSlotAt(rows, 200, 170)).toBe(3);
    // A missing rect (an unmounted chip) is skipped.
    expect(dropSlotAt([undefined, ...rows], 200, 132)).toBe(3);
  });
});
