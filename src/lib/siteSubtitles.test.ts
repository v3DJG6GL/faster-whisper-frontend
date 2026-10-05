// One test per D86 decision-log rule (memory cue-splitting.md, v25…v39).
import { describe, expect, it } from "vitest";
import {
  addLanguage, attachSiteTracks, derive, frozenSiteRun, setTargets, linkSpoken, spokenPill, siteTimedTracks, siteWord, flip, initialSiteState, listedLanguages, pickPolicy, removeLanguage, toggleTarget,
  type SiteChange, type SiteSubsInput, type SiteSubsState,
} from "./siteSubtitles";
import type { SiteTrackInfo } from "./urlSource";

const tr = (id: string, lang: string, extra: Partial<SiteTrackInfo> = {}): SiteTrackInfo => ({
  id, lang, kind: "manual", ext: "vtt", hoh: false, ...extra,
});
// arte · 5 tracks (mockup example "multi")
const ARTE = [tr("de", "de"), tr("de-hoh", "de", { hoh: true }), tr("en", "en"), tr("fr", "fr"), tr("it", "it")];
// YouTube Dz_3b8WAWw4: one human de-CH, the de-orig auto track
const YT = [tr("de-CH", "de-CH"), tr("de-orig", "de", { kind: "auto" })];

const input = (over: Partial<SiteSubsInput> = {}): SiteSubsInput => ({
  tracks: ARTE, spoken: "de", multi: false, targets: ["en", "fr"], ...over,
});
/** Apply a change: the next input carries the targets it wrote. */
const apply = (inp: SiteSubsInput, ch: SiteChange): [SiteSubsInput, SiteSubsState] => [{ ...inp, targets: ch.targets }, ch.state];
const badge = (inp: SiteSubsInput, st: SiteSubsState, row: string | null, key: string) =>
  derive(inp, st).rows.find((r) => r.code === row)!.badges.find((b) => b.key === key)!;
const rowCodes = (inp: SiteSubsInput, st: SiteSubsState) => derive(inp, st).rows.map((r) => r.code);

describe("presets (v18, v31, v32)", () => {
  it("Prefer: existing subtitles replace transcription and machine translation", () => {
    const inp = input();
    const st = initialSiteState(inp.targets);
    const v = derive(inp, st);
    expect(v.rows[0].badges.map((b) => [b.text, b.state])).toEqual([
      ["Whisper", "idle"], ["Site", "active"], ["Site SDH", "active"],
    ]);
    expect(badge(inp, st, "en", "mt:en").state).toBe("idle");
    expect(v.run).toEqual({ fetch: ["de", "de-hoh", "en", "fr", "it"], transcriptTrackId: "de", mtTargets: [] });
  });
  it("Side by side: transcribe and translate, the existing subtitles ride along", () => {
    const inp = input();
    const [, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "both"));
    const run = derive(inp, st).run!;
    expect(run.transcriptTrackId).toBeNull();
    expect(run.mtTargets).toEqual(["en", "fr", "it"]);
    expect(run.fetch).toHaveLength(5);
  });
  it("v31 Generate uses nothing existing — not even for languages nobody translates into", () => {
    const inp = input();
    const [, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "generate"));
    const v = derive(inp, st);
    expect(v.run).toEqual({ fetch: [], transcriptTrackId: null, mtTargets: ["en", "fr", "it"] });
    expect(badge(inp, st, "it", "ex:it").state).toBe("idle");
  });
  it("v32 wanted languages: the site's languages are wanted under a preset, the preset sets their sources", () => {
    const inp = input({ targets: [] });
    const v = derive(inp, initialSiteState([]));
    expect(v.chips.map((c) => c.code)).toEqual(["en", "fr", "it"]);
    expect(v.chips[2].parts.map((p) => p.text)).toEqual(["Machine translation", "Site"]);
  });
  it("Prefer with an unknown spoken language behaves like Side by side: transcribe, candidates ride along", () => {
    const inp = input({ spoken: null, tracks: YT });
    const v = derive(inp, initialSiteState(inp.targets));
    expect(v.rows[0].sub).toBe("Unknown");
    expect(v.rows[0].badges.map((b) => b.text)).toEqual(["Whisper", "if German: Site"]);
    expect(v.rows[0].badges[1].tentative).toBe(true);
    expect(v.run).toEqual({ fetch: ["de-CH"], transcriptTrackId: null, mtTargets: ["en", "fr"] });
  });
});

describe("badge clicks (v25, v27, v28)", () => {
  it("v25 a click flips used ↔ not used: greyed or struck → active, active → struck", () => {
    const inp = input();
    const st0 = initialSiteState(inp.targets);
    const [i1, st1] = apply(inp, flip(inp, st0, "mt:en")); // greyed under Prefer → forced on
    expect(badge(i1, st1, "en", "mt:en").state).toBe("active");
    const [i2, st2] = apply(i1, flip(i1, st1, "ex:it")); // active → struck
    expect(badge(i2, st2, "it", "ex:it").state).toBe("off");
  });
  it("v27 a click snapshots the screen into Custom (used or struck, no greyed); a preset resets", () => {
    const inp = input();
    const [i1, st1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:fr"));
    expect(st1.policy).toBe("custom");
    const states = derive(i1, st1).rows.flatMap((r) => r.badges.filter((b) => b.key).map((b) => b.state));
    expect(states).not.toContain("idle");
    // Entering Custom wrote every wanted language into the targets (v32).
    expect(i1.targets).toEqual(["en", "fr", "it"]);
    const [i2, st2] = apply(i1, pickPolicy(i1, st1, "prefer"));
    expect(st2.sel).toBeNull();
    expect(badge(i2, st2, "fr", "ex:fr").state).toBe("active");
  });
  it("v27 transcribe is clickable only while an existing subtitle covers the original", () => {
    const inp = input();
    const [, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    expect(badge(inp, st, null, "gen").key).toBe("gen");
    const none = input({ tracks: [tr("en", "en")] });
    expect(derive(none, initialSiteState(none.targets)).rows[0].badges[0].key).toBeUndefined();
  });
  it("v28 a translated language keeps a source: its last existing subtitle off → machine translation on", () => {
    const inp = input({ tracks: [tr("en", "en")] });
    const [i1, st1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:en"));
    expect(badge(i1, st1, "en", "mt:en").state).toBe("active");
    expect(i1.targets).toContain("en");
  });
  it("v28 switching off machine translation as the last source drops the language", () => {
    const inp = input({ tracks: [] });
    const [i1, st1] = apply(inp, flip(inp, initialSiteState(inp.targets), "mt:fr"));
    expect(i1.targets).toEqual(["en"]);
    expect(derive(i1, st1).rows.find((r) => r.code === "fr")!.sub).toBe("off");
  });
  it("switching a source on makes the language wanted again", () => {
    const inp = input();
    const [i1, st1] = apply(inp, toggleTarget(inp, initialSiteState(inp.targets), "it"));
    expect(derive(i1, st1).chips.map((c) => c.code)).not.toContain("it");
    const [i2] = apply(i1, flip(i1, st1, "ex:it"));
    expect(i2.targets).toContain("it");
  });
});

describe("rows and chips (v30, v34, v37)", () => {
  it("rows keep a stable order: starting languages, the site's, then added ones at the bottom", () => {
    const inp = input({ targets: ["es", "en"] });
    const st0 = initialSiteState(inp.targets);
    expect(rowCodes(inp, st0)).toEqual([null, "es", "en", "fr", "it"]);
    const [i1, st1] = apply(inp, addLanguage(inp, st0, "ja"));
    expect(rowCodes(i1, st1)).toEqual([null, "es", "en", "fr", "it", "ja"]);
    expect(i1.targets).toEqual(["es", "en", "ja"]);
    // Switching a language off keeps its row.
    const [i2, st2] = apply(i1, toggleTarget(i1, st1, "es"));
    expect(rowCodes(i2, st2)).toEqual([null, "es", "en", "fr", "it", "ja"]);
  });
  it("v37 trash only for languages the site lacks; deleting removes the row, Add language brings it back", () => {
    const inp = input({ targets: ["es"] });
    const st0 = initialSiteState(inp.targets);
    const v = derive(inp, st0);
    expect(v.rows.filter((r) => r.deletable).map((r) => r.code)).toEqual(["es"]);
    const [i1, st1] = apply(inp, removeLanguage(inp, st0, "es"));
    expect(rowCodes(i1, st1)).not.toContain("es");
    expect(i1.targets).toEqual([]);
    expect(listedLanguages(i1, st1)).not.toContain("es");
    const [i2, st2] = apply(i1, addLanguage(i1, st1, "es"));
    expect(rowCodes(i2, st2)).toContain("es");
  });
  it("v30 chip parts in fixed order: machine translation, then existing", () => {
    const inp = input({ targets: ["en", "es"] });
    const v = derive(inp, initialSiteState(inp.targets));
    const en = v.chips.find((c) => c.code === "en")!;
    expect(en.parts.map((p) => [p.kind, p.text])).toEqual([["mt", "Machine translation"], ["existing", "Site"]]);
    const es = v.chips.find((c) => c.code === "es")!;
    expect(es.parts.map((p) => p.text)).toEqual(["Machine translation"]);
  });
});

describe("tracks and switches", () => {
  it("auto-generated tracks join only with the switch; hearing-impaired comes from the track", () => {
    const inp = input({ tracks: YT, targets: [], site: "YouTube" });
    const st = initialSiteState([]);
    expect(derive(inp, st).rows[0].badges.map((b) => b.text)).toEqual(["Whisper", "YouTube"]);
    const auto = derive(inp, { ...st, auto: true }).rows[0].badges.map((b) => b.text);
    expect(auto).toEqual(["Whisper", "YouTube", "YouTube auto"]);
    expect(derive(inp, { ...st, auto: true }).run!.transcriptTrackId).toBe("de-CH");
  });
  it("Download existing subtitles off: the run ignores the site", () => {
    const inp = input();
    expect(derive(inp, { ...initialSiteState(inp.targets), subs: false }).run).toBeNull();
  });
  it("Multiple languages names the main language and transcribes each part", () => {
    const inp = input({ multi: true });
    const v = derive(inp, initialSiteState(inp.targets));
    expect(v.rows[0].sub).toBe("Multiple languages · main: German");
    expect(v.rows[0].badges[0].text).toBe("Whisper · each part in its language");
  });
  it("counter counts the tracks in use", () => {
    const inp = input();
    const [, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "generate"));
    expect(derive(inp, st).counter).toEqual({ used: 0, of: 5, existing: 5 });
  });
});

describe("site tracks in a result", () => {
  const parsed = (text: string) => ({ segments: [{ start: 1, end: 2, text }, { text: "untimed" }] });
  it("ids are <lang>-x-site, made unique by kind, hearing-impaired or a number; untimed cues drop", () => {
    const timed = siteTimedTracks(
      [
        { id: "de", lang: "de", kind: "manual", parsed: parsed("a") },
        { id: "de-hoh", lang: "de", kind: "manual", parsed: parsed("b") },
        { id: "de-orig", lang: "de", kind: "auto", parsed: parsed("c") },
        { id: "de2", lang: "de", kind: "manual", parsed: parsed("d") },
        { id: "en", lang: "en", kind: "manual", parsed: { segments: [{ text: "x" }] } },
      ],
      [tr("de-hoh", "de", { hoh: true, name: "Deutsch (SDH)" })],
    );
    expect(timed.map((t) => t.id)).toEqual(["de-x-site", "de-x-site-hoh", "de-x-site-auto", "de-x-site-2"]);
    expect(timed[1]).toMatchObject({ hoh: true, label: "Deutsch (SDH)", source: "site" });
    expect(timed[0].cues).toEqual([{ start: 1, end: 2, text: "a" }]);
    expect(siteWord(timed[2])).toBe("Site auto");
    expect(siteWord(timed[1])).toBe("Site SDH");
    expect(siteTimedTracks([{ id: "de", lang: "de", kind: "manual", parsed: parsed("a") }], [], "SRF")[0].site).toBe("SRF");
    expect(siteWord({ kind: "manual", site: "SRF" })).toBe("SRF");
    // One site name, three styles: chips, a title's brackets, a file label.
    expect(siteWord({ kind: "auto", site: "YouTube" }, "title")).toBe("YouTube, auto-generated");
    expect(siteWord({ kind: "manual", hoh: true, site: "YouTube" }, "title")).toBe("YouTube, SDH");
    expect(siteWord({ kind: "auto", site: "ARD Mediathek" }, "file")).toBe("ARD-Mediathek-auto");
    expect(siteWord({ kind: "manual", hoh: true, site: "日本" }, "file")).toBe("Site");
  });
  it("attaching keeps the result's own tracks and warnings", () => {
    const res = { text: "", segments: [], warnings: ["w1"] } as never;
    expect(attachSiteTracks(res, [], [])).toBe(res);
    const out = attachSiteTracks(res, siteTimedTracks([{ id: "it", lang: "it", kind: "manual", parsed: parsed("c") }]), ["w2"]);
    expect(out.timedTracks?.map((t) => t.id)).toEqual(["it-x-site"]);
    expect(out.warnings).toEqual(["w1", "w2"]);
  });
});

describe("the link's spoken language", () => {
  const done = (over: object = {}) => ({
    state: "done" as const,
    result: {
      language: "de", probability: 0.99, verdict: "detected" as const, also: [], media_id: null, media_expires_at: null,
      pieces: [{ at: 289, language: "de", probability: 0.98 }, { at: 963, language: "de", probability: 1 }, { at: 1638, language: "de", probability: 1 }],
      ...over,
    },
  });
  it("your pick wins, then the check, then the site, then the screen", () => {
    expect(linkSpoken({ siteLanguage: "en-US", check: done(), screen: "auto", edited: null })).toMatchObject({ value: "de", source: "detected" });
    expect(linkSpoken({ siteLanguage: "en-US", check: { state: "idle" }, screen: "auto", edited: null })).toMatchObject({ value: "en", source: "site" });
    expect(linkSpoken({ check: { state: "idle" }, screen: "fr", edited: null })).toMatchObject({ value: "fr", source: "screen" });
    expect(linkSpoken({ check: done(), screen: "auto", edited: "it" })).toMatchObject({ value: "it", spoken: "it", source: "edited" });
    expect(linkSpoken({ check: { state: "idle" }, screen: "auto", edited: null })).toMatchObject({ value: "auto", spoken: null });
  });
  it("Multiple languages keeps the detected language as the main one", () => {
    expect(linkSpoken({ check: done(), screen: "multi", edited: null })).toMatchObject({ value: "multi", spoken: "de", multi: true });
  });
  it("pills: detected in n of 3, also X, from YouTube, edited, nothing while checking", () => {
    const sp = (c: Parameters<typeof linkSpoken>[0]["check"], edited: string | null = null) =>
      spokenPill(linkSpoken({ siteLanguage: "de", check: c, screen: "auto", edited }), c, "YouTube")?.text;
    expect(sp(done())).toBe("detected in 3 of 3 pieces");
    expect(sp(done({ verdict: "mixed", also: ["en"] }))).toBe("detected · also English");
    expect(sp({ state: "idle" })).toBe("from YouTube");
    expect(sp({ state: "running" })).toBeUndefined();
    expect(sp({ state: "idle" }, "fr")).toBe("edited");
    expect(spokenPill(linkSpoken({ check: { state: "failed", error: "x" }, screen: "auto", edited: null }), { state: "failed", error: "x" })).toEqual({ text: "unknown", tone: "plain", title: "x" });
    expect(spokenPill(linkSpoken({ siteLanguage: "de", check: { state: "idle" }, screen: "auto", edited: null }), { state: "idle" })?.text)
      .toBe("from the site");
  });
});

describe("the chips' own picker and the frozen run (moved out of Transcribe)", () => {
  it("setTargets: a dropped chip switches its language off, a new code is added at the bottom", () => {
    const inp = input();
    const st = initialSiteState(inp.targets);
    expect(derive(inp, st).chips.map((c) => c.code)).toEqual(["en", "fr", "it"]);
    const [inp2, st2] = apply(inp, setTargets(inp, st, ["en", "it", "es"]));
    expect(derive(inp2, st2).chips.map((c) => c.code)).toEqual(["en", "it", "es"]);
    expect(st2.off).toEqual(["fr"]);
    expect(st2.added).toEqual(["es"]);
    expect(setTargets(inp, st, ["en", "fr", "it"])).toEqual({ state: st, targets: ["en", "fr"] });
  });
  it("frozenSiteRun: no machine translation without a translator; only the fetched tracks' facts", () => {
    const run = { fetch: ["de", "en"], transcriptTrackId: "de", mtTargets: ["fr"] };
    expect(frozenSiteRun(run, ARTE, true)).toEqual({ ...run, tracks: [ARTE[0], ARTE[2]] });
    expect(frozenSiteRun(run, ARTE, false).mtTargets).toEqual([]);
  });
});
