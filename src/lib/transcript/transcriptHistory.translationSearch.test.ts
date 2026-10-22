// History's search covers the translated tracks the viewer shows and the exports write: those
// live in `segments[].translations` (the viewer's Translate / Re-translate writes only there),
// not in the whole-text `result.translations` snapshot a run leaves when it first finishes.
import { describe, expect, it } from "vitest";
import { recordTranslationTexts, type TranscriptRecord } from "./transcriptHistory";
// Raw source (vite `?raw`).
import historySrc from "../../screens/History.tsx?raw";

const rec = (result: Record<string, unknown>): TranscriptRecord =>
  ({ id: "r1", kind: "file", sourceName: "a.wav", createdAt: "2026-01-01T00:00:00Z", result }) as unknown as TranscriptRecord;

describe("recordTranslationTexts", () => {
  it("a file translated in the viewer after the run is searchable in its new language", () => {
    const r = rec({
      text: "hello world",
      segments: [{ text: "hello", translations: { de: "hallo" } }, { text: " world", translations: { de: " welt" } }],
      translation: { targets: ["de"] },
    });
    expect(recordTranslationTexts(r)).toEqual(["hallo welt"]);
  });

  it("after a re-translate the new text is found and the replaced snapshot is not", () => {
    const r = rec({ text: "hello", segments: [{ text: "hello", translations: { de: "neue" } }], translations: { de: "alte" } });
    const all = recordTranslationTexts(r).join("\n");
    expect(all).toContain("neue");
    expect(all).not.toContain("alte");
  });

  it("an older record with only the whole-text map is still searchable", () => {
    expect(recordTranslationTexts(rec({ text: "hello", segments: [{ text: "hello" }], translations: { fr: "bonjour" } }))).toEqual(["bonjour"]);
  });

  it("bounds each track and tolerates malformed segments", () => {
    const segs = [null, 7, { translations: "x" }, { translations: { de: 3 } }, ...Array.from({ length: 50 }, () => ({ translations: { de: "abcdefghij" } }))];
    const [de] = recordTranslationTexts(rec({ segments: segs }), 100);
    expect(de.length).toBe(100);
  });

  it("History's search haystack reads the per-segment tracks, not the run's snapshot", () => {
    expect(historySrc).toContain("recordTranslationTexts(r, 20_000)");
    expect(historySrc).not.toMatch(/r\.result\?\.translations/);
  });
});
