// The route readout's bounds. Both halves are user- or peer-authored — a profile's
// language, a synced backend's, the translate-to list — and `languageLabel` passes an
// unknown code through UNCHANGED, so an unbounded leaf reaches the pill. ui.tsx records
// what that cost the last time (a single field pushed a card's controls off screen);
// a LIST of them multiplies it, hence the per-part cap AND the "+N" list cap.

import { describe, expect, it } from "vitest";
import { routeParts } from "./ui";

describe("routeParts", () => {
  it("renders as a plain language badge with no targets", () => {
    expect(routeParts("German")).toEqual({ source: "German", targets: [], more: 0 });
    expect(routeParts("German", [])).toEqual({ source: "German", targets: [], more: 0 });
    expect(routeParts("German", null)).toEqual({ source: "German", targets: [], more: 0 });
  });

  it("labels the target codes", () => {
    expect(routeParts("German", ["fr", "it"]).targets).toEqual(["French", "Italian"]);
  });

  it("passes an unknown code through, as languageLabel does", () => {
    expect(routeParts("de-CH", ["rm"]).targets).toEqual(["rm"]);
  });

  it("drops blank entries instead of rendering an empty chip", () => {
    expect(routeParts("German", ["", "  ", "fr"]).targets).toEqual(["French"]);
  });

  it("caps the list at three and counts the rest", () => {
    const r = routeParts("German", ["fr", "it", "es", "pt", "nl"]);
    expect(r.targets).toEqual(["French", "Italian", "Spanish"]);
    expect(r.more).toBe(2);
    expect(routeParts("German", ["fr", "it", "es"]).more).toBe(0);
  });

  it("bounds every part", () => {
    const long = "x".repeat(200);
    const r = routeParts(long, [long, long]);
    // Code points, not UTF-16 units — safeDisplayText bounds code points.
    expect([...r.source].length).toBeLessThanOrEqual(24);
    const astral = "😀".repeat(200);
    const a = routeParts(astral, [astral]);
    expect([...a.source].length).toBeLessThanOrEqual(24);
    for (const t of r.targets) expect(t.length).toBeLessThanOrEqual(24);
  });
});
