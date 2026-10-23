// The screen Language picker must not prune the translation chips by the SCREEN's source while
// the site-subtitle panel holds them: their source is then the link's spoken language
// (chipSource), and the prune silently dropped (and saved the loss of) a target valid for the
// link — e.g. German on an English link, after the screen was switched to German. Only for a link
// with its OWN spoken language, though: one that follows the screen speaks the new screen
// language, and skipping the prune there left it as a hidden target (a de→de copy track).
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the screen in.
import src from "./Transcribe.tsx?raw";
import siteSubtitlesSrc from "../lib/transcript/siteSubtitles.ts?raw";

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
    const gate = body.indexOf("if (siteChips && linkOwnsSpoken) {");
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

  it("still prunes by the new screen language when the link only follows the screen", () => {
    const body = languageOnChange();
    const def = body.indexOf("const linkOwnsSpoken =");
    expect(def).toBeGreaterThanOrEqual(0);
    const gate = body.indexOf("if (siteChips && linkOwnsSpoken) {");
    expect(gate).toBeGreaterThan(def);
    // The held branch is for a link whose spoken language is its own …
    const owns = body.slice(def, gate);
    for (const source of ["edited", "detected", "site"]) expect(owns).toContain(`linkLang.sp.source === "${source}"`);
    // … not one that follows the screen ("screen", or null when nothing names one): its spoken
    // language is the new screen language, so the chips' source is sourceOf(lang).
    expect(owns).not.toContain('"screen"');
    expect(owns).not.toContain("null");
    expect(owns).not.toContain("!==");
    // Those are all the sources there are: a new one must be sorted into one side or the other.
    expect(siteSubtitlesSrc).toContain('source: "edited" | "detected" | "site" | "screen" | null;');
    // Such a link falls through to the prune, and the pruned list is saved with the language.
    const prune = body.indexOf("const next = pruneTargets(translateTo, sourceOf(lang));", gate);
    expect(prune).toBeGreaterThan(gate);
    expect(body.slice(prune)).toContain("persistScoped({ language: lang, translateTo: next });");
  });
});
