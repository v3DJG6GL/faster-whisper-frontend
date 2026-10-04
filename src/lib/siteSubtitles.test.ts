// One test per D86 decision-log rule (memory cue-splitting.md, v25…v39).
import { describe, expect, it } from "vitest";
import {
  addLanguage, derive, flip, initialSiteState, listedLanguages, pickPolicy, removeLanguage, toggleTarget,
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
      ["transcribe", "idle"], ["existing", "active"], ["existing · hearing-impaired", "active"],
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
    expect(v.chips[2].parts.map((p) => p.text)).toEqual(["+ machine translation", "existing"]);
  });
  it("Prefer with an unknown spoken language behaves like Side by side: transcribe, candidates ride along", () => {
    const inp = input({ spoken: null, tracks: YT });
    const v = derive(inp, initialSiteState(inp.targets));
    expect(v.rows[0].sub).toBe("Unknown");
    expect(v.rows[0].badges.map((b) => b.text)).toEqual(["transcribe", "if German: existing"]);
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
    expect(en.parts.map((p) => [p.kind, p.text])).toEqual([["mt", "+ machine translation"], ["existing", "existing"]]);
    const es = v.chips.find((c) => c.code === "es")!;
    expect(es.parts.map((p) => p.text)).toEqual(["machine translation"]);
  });
});

describe("tracks and switches", () => {
  it("auto-generated tracks join only with the switch; hearing-impaired comes from the track", () => {
    const inp = input({ tracks: YT, targets: [] });
    const st = initialSiteState([]);
    expect(derive(inp, st).rows[0].badges.map((b) => b.text)).toEqual(["transcribe", "existing"]);
    const auto = derive(inp, { ...st, auto: true }).rows[0].badges.map((b) => b.text);
    expect(auto).toEqual(["transcribe", "existing", "auto-generated"]);
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
    expect(v.rows[0].badges[0].text).toBe("transcribe · each part in its language");
  });
  it("counter counts the tracks in use", () => {
    const inp = input();
    const [, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "generate"));
    expect(derive(inp, st).counter).toEqual({ used: 0, of: 5, existing: 5 });
  });
});
