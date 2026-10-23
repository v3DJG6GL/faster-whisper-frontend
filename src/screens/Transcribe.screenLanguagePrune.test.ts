// The screen Language picker must not prune the translation chips by the SCREEN's source while
// the site-subtitle panel holds them: their source is then the link's spoken language
// (chipSource), and the prune silently dropped (and saved the loss of) a target valid for the
// link — e.g. German on an English link, after the screen was switched to German.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the screen in.
import src from "./Transcribe.tsx?raw";

/** The body of the screen Language picker's onChange. */
const languageOnChange = () => {
  const picker = src.indexOf('ariaLabel="Language"');
  expect(picker).toBeGreaterThanOrEqual(0);
  const start = src.indexOf("onChange={(v) => {", picker);
  expect(start).toBeGreaterThan(picker);
  const end = src.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("screen Language picker vs the site-subtitle panel's chips", () => {
  it("skips the screen-source prune while the panel holds the chips, but still saves the language", () => {
    const body = languageOnChange();
    const prune = body.indexOf("pruneTargets(translateTo, sourceOf(lang))");
    expect(prune).toBeGreaterThanOrEqual(0);
    const gate = body.indexOf("if (siteChips) {");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(prune);
    // The held branch persists the language alone and leaves before the prune.
    const held = body.slice(gate, prune);
    expect(held).toContain("persistScoped({ language: lang });");
    expect(held).toContain("return;");
    expect(held).not.toContain("translateTo");
    // The re-prune effect stays gated on the panel and re-runs on its release, so the skipped
    // prune catches up once the panel lets go.
    expect(src).toContain("if (busy || siteChips) return;");
    expect(src).toContain("}, [knownSource, busy, !!siteChips]);");
  });
});
