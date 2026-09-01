import { describe, expect, it } from "vitest";
import { chipCodes } from "./TranslationFields";

// `translationOverrides.translateTo` is peer-synced and never element-clamped by the
// sanitizers; the chip renderer is the last line of defence (mirrors overlay.test.ts).
describe("chipCodes", () => {
  it("keeps only trimmed non-empty strings", () => {
    expect(chipCodes([123, null, {}, "", "  ", "fr", " de "])).toEqual(["fr", "de"]);
  });
  it("bounds each code and the count, and de-duplicates", () => {
    expect(chipCodes(["x".repeat(40)])[0].length).toBeLessThanOrEqual(13);
    expect(chipCodes(Array.from({ length: 100 }, (_, i) => `l${i}`), 5)).toHaveLength(5);
    expect(chipCodes(["fr", "fr", "de"])).toEqual(["fr", "de"]);
  });
  it("returns nothing for a non-array", () => {
    expect(chipCodes("fr")).toEqual([]);
  });
});
