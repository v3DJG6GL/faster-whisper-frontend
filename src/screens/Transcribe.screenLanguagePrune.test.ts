// The screen Language picker must not prune the translation chips by the SCREEN's source while
// the site-subtitle panel holds them: their source is then the link's spoken language
// (chipSource), and the prune would silently drop (and save the loss of) a target valid for the
// link — e.g. German on an English link, after the screen is switched to German. Only for a link
// with its OWN spoken language, though: one that follows the screen speaks the new screen
// language, and skipping the prune there would leave it as a hidden target (a de→de copy track).
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the screen in.
import src from "./Transcribe.tsx?raw";
import siteSubtitlesSrc from "../lib/transcript/siteSubtitles.ts?raw";
import { runTargets } from "../lib/translationTargets";
import { initialSiteState, pickPolicy, type SiteSubsInput } from "../lib/transcript/siteSubtitles";
import type { SiteTrackInfo } from "../lib/urlSource";
import { targetsOnLeave } from "./Transcribe";

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

// The skipped prune leaves the screen's spoken language in translateTo while the panel holds the
// chips, and the re-prune effect waits for the panel to let go — but Run is not gated on that, and
// translateTo is also what every queued file is sent: unpruned, a German file would get
// translate_to ["de"].
describe("a run while the panel holds the chips", () => {
  it("sends the queued files the chips less the screen's known source", () => {
    // Screen German, chips ["de"] (kept for an English link): nothing to translate a German file into.
    expect(runTargets(["de"], "de")).toEqual([]);
    expect(runTargets(["de", "fr"], "de")).toEqual(["fr"]);
    // Screen English: German is a real target.
    expect(runTargets(["de"], "en")).toEqual(["de"]);
    // Unknown or auto-detected source: nothing is pruned.
    expect(runTargets(["de"], undefined)).toEqual(["de"]);
    expect(runTargets(["de"], "auto")).toEqual(["de"]);
  });

  it("is what run() sends and the warm-up warms for the queued files", () => {
    expect(src).toContain("const effTargets = translationAvailable ? runTargets(translateTo, knownSource) : [];");
    expect(src).toContain("const runT = translationAvailable ? runTargets(translateTo, knownSource) : [];");
    expect(src).not.toContain("wireCodes(translateTo)");
  });
});

// Leaving the screen drops the site panel like a new preview does: the languages its Custom only
// promoted must leave the saved targets too, or they come back as your own picks — a plain file
// run translates into them, and a later preset on the next link keeps them.
describe("leaving the screen with the site-subtitle panel open", () => {
  it("drops the languages Custom only promoted from the saved targets", () => {
    const tr = (lang: string): SiteTrackInfo => ({ id: lang, lang, kind: "manual", ext: "vtt", hoh: false });
    const inp: SiteSubsInput = { tracks: [tr("de"), tr("en"), tr("es")], spoken: "de", multi: false, targets: ["en"], maxTargets: 3 };
    const custom = pickPolicy(inp, initialSiteState(inp.targets), "custom");
    expect(custom.targets).toEqual(["en", "es"]);
    expect(custom.state.promoted).toEqual(["es"]);
    // Saved ["en", "es"] while the panel held the chips (taken at length 1, limit 3).
    expect(targetsOnLeave(custom.targets, custom.state, 3, true, 1)).toEqual(["en"]);
    // Also once the panel no longer held the chips: the promoted code is still not yours.
    expect(targetsOnLeave(custom.targets, custom.state, 3, false, 1)).toEqual(["en"]);
    // No panel, nothing promoted, or no translation: the saved list stays.
    expect(targetsOnLeave(["en", "es"], null, 3, false, 0)).toBeNull();
    expect(targetsOnLeave(["en", "es"], initialSiteState(["en", "es"]), 3, true, 2)).toBeNull();
    expect(targetsOnLeave(custom.targets, custom.state, null, true, 1)).toBeNull();
    // The over-limit cut on a held release is unchanged: never below the list the panel took.
    expect(targetsOnLeave(["en", "fr", "it"], initialSiteState(["en"]), 1, true, 1)).toEqual(["en"]);
    expect(targetsOnLeave(["en", "fr", "it"], initialSiteState(["en"]), 1, true, 3)).toBeNull();
  });
});
