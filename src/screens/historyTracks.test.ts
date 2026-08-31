// The duplicate-original bug, pinned.
//
// A dictation translated to EN+FR rendered the INJECTED blob (which, with
// "include original" on, already begins with the original) and then rendered
// result.text again beneath it under an "original" label — so the source
// language appeared twice, under a heading naming only the targets. tracksOf
// is the decision that fixes it, extracted so it can be tested: nothing here
// mocks Tauri and there is no jsdom, so the rendering itself cannot be.

import { describe, expect, it } from "vitest";

import { tracksOf } from "./History";
type TranscriptRecord = import("@/lib/transcriptHistory").TranscriptRecord;

const base = {
  schemaVersion: 1 as const,
  kind: "dictation" as const,
  id: "r1",
  createdAt: "2026-08-31T18:23:00.000Z",
  sourcePath: "",
  sourceName: "kate",
  status: "done" as const,
  language: "de",
  result: { text: "Hallo das ist ein Test", duration: 11 },
};

const rec = (over: Partial<TranscriptRecord> = {}): TranscriptRecord =>
  ({ ...base, ...over }) as TranscriptRecord;

describe("tracksOf", () => {
  it("renders the original exactly once, as its own dimmed track", () => {
    const t = tracksOf(
      rec({
        translations: { en: "Hello this is a test", fr: "Salut c'est un test" },
        translationTargets: ["en", "fr"],
        includeOriginal: true,
      }),
    );
    expect(t).toEqual([
      { lang: "de", text: "Hallo das ist ein Test", orig: true },
      { lang: "en", text: "Hello this is a test" },
      { lang: "fr", text: "Salut c'est un test" },
    ]);
    // The reported bug: the source text must appear in exactly one track.
    const originals = t!.filter((x) => x.text === base.result.text);
    expect(originals).toHaveLength(1);
  });

  it("omits the original track when it was not injected", () => {
    const t = tracksOf(
      rec({
        translations: { en: "Hello" },
        translationTargets: ["en"],
        includeOriginal: undefined,
      }),
    );
    expect(t).toEqual([{ lang: "en", text: "Hello" }]);
  });

  it("keeps the configured target ORDER, not object key order", () => {
    const t = tracksOf(
      rec({
        translations: { fr: "Salut", en: "Hello" },
        translationTargets: ["en", "fr"],
      }),
    );
    expect(t!.map((x) => x.lang)).toEqual(["en", "fr"]);
  });

  it("drops a target that produced no text", () => {
    const t = tracksOf(
      rec({
        translations: { en: "Hello", fr: "   " },
        translationTargets: ["en", "fr"],
      }),
    );
    expect(t!.map((x) => x.lang)).toEqual(["en"]);
  });

  it("returns null for a record written before tracks existed", () => {
    // Its translatedText is a blank-line join and a transcript contains its
    // own line breaks, so splitting it would mislabel text rather than
    // recover it. One untitled block is the honest rendering.
    expect(tracksOf(rec({ translatedText: "Hallo\n\nHello\n\nSalut" }))).toBeNull();
    expect(tracksOf(rec({}))).toBeNull();
  });

  it("returns null rather than throwing on a hand-edited record", () => {
    // Records are read back from FILES: nothing validates the shape of an
    // optional field on load.
    expect(tracksOf(rec({ translations: "nope" as never }))).toBeNull();
    expect(tracksOf(rec({ translations: {} }))).toBeNull();
  });

  it("falls back to a neutral code when the language is unknown", () => {
    const t = tracksOf(
      rec({
        language: "auto",
        translations: { en: "Hello" },
        translationTargets: ["en"],
        includeOriginal: true,
      }),
    );
    expect(t![0]).toEqual({ lang: "orig", text: base.result.text, orig: true });
  });
});
