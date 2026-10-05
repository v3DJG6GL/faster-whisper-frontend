import { describe, expect, it } from "vitest";
import { sourceWord, trackChipLabel, trackInfo } from "./exportTracks";
import type { BatchResult } from "./types";

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
});
