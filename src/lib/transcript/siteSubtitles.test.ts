// One test per D86 decision-log rule (memory cue-splitting.md, v25…v39).
import { describe, expect, it } from "vitest";
import {
  addLanguage, attachSiteTracks, derive, freeAdds, frozenSiteRun, setTargets, linkSpoken, spokenPill, siteTimedTracks, siteWord, flip, initialSiteState, listedLanguages, pickPolicy, removeLanguage, toggleTarget,
  type SiteChange, type SiteSubsInput, type SiteSubsState,
} from "./siteSubtitles";
import type { SiteTrackInfo } from "../urlSource";
import { parseImportedText } from "./subtitleImport";

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
  it("an unknown spoken language: a track shown twice (candidate + its own row) switches off from either badge", () => {
    const inp = input({ spoken: null, tracks: YT });
    const st0 = initialSiteState(inp.targets);
    const states = (i: SiteSubsInput, st: SiteSubsState, key: string) =>
      derive(i, st).rows.flatMap((r) => r.badges).filter((b) => b.key === key).map((b) => b.state);
    expect(states(inp, st0, "cand:de-CH")).toEqual(["active"]);
    expect(states(inp, st0, "ex:de-CH")).toEqual(["active"]);
    for (const key of ["cand:de-CH", "ex:de-CH"]) {
      const [i1, st1] = apply(inp, flip(inp, st0, key));
      expect(derive(i1, st1).run!.fetch).not.toContain("de-CH");
      expect(states(i1, st1, "cand:de-CH")).toEqual(["off"]);
      expect(states(i1, st1, "ex:de-CH")).toEqual(["off"]);
    }
  });
  it("an unknown spoken language: a candidate switched off and on again leaves the translation targets alone", () => {
    const inp0 = input({ spoken: null, tracks: YT, targets: ["en"] });
    const [inp, st0] = apply(inp0, toggleTarget(inp0, initialSiteState(inp0.targets), "de", false));
    const targets = [...inp.targets];
    expect(targets).not.toContain("de");
    const [i1, st1] = apply(inp, flip(inp, st0, "cand:de-CH"));
    const [i2] = apply(i1, flip(i1, st1, "cand:de-CH"));
    expect(i1.targets).toEqual(targets);
    expect(i2.targets).toEqual(targets);
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
  it("a run fetches at most 8 tracks, always including the transcript's own, and counts those", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl", "sv", "fi", "da"];
    const inp = input({ tracks: [...langs.map((l) => tr(l, l)), tr("de", "de")], targets: [] });
    const v = derive(inp, initialSiteState(inp.targets));
    const run = v.run!;
    expect(run.transcriptTrackId).toBe("de");
    expect(run.fetch).toHaveLength(8);
    expect(run.fetch).toContain("de");
    // The site's order holds; the overflow drops from the end.
    expect(run.fetch).toEqual(["en", "fr", "it", "es", "pt", "nl", "pl", "de"]);
    expect(v.counter.used).toBe(8);
    // The overflow languages were wanted only because the site brings them: cut off, they
    // drop out — no machine translation nobody asked for, no chips; their site badges grey out.
    expect(run.mtTargets).toEqual([]);
    for (const code of ["sv", "fi", "da"]) {
      const row = v.rows.find((r) => r.code === code)!;
      const [mt, ex] = row.badges;
      expect([mt.state, ex.state]).toEqual(["off", "idle"]);
      expect(ex.title).toBe("Over the 8-subtitle download limit — not downloaded");
      expect(mt.title).toBe(`Click to translate into ${row.label}`);
      expect(row.sub).toBe("over the download limit");
      expect(v.chips.map((c) => c.code)).not.toContain(code);
    }
    // A kept language keeps its site track and needs no machine translation.
    expect(v.rows.find((r) => r.code === "en")!.badges.map((b) => b.state)).toEqual(["idle", "active"]);
    // Custom starts from what is on screen: the overflow tracks stay out, nothing is translated,
    // and the cut languages are not written into the targets.
    const [ci, cu] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    const vc = derive(ci, cu);
    expect(vc.run!.fetch).toEqual(run.fetch);
    expect(vc.run!.mtTargets).toEqual([]);
    expect(ci.targets).not.toContain("sv");
    // Clicking a greyed over-cap badge changes nothing — not even the preset.
    const st0 = initialSiteState(inp.targets);
    const exSv = v.rows.find((r) => r.code === "sv")!.badges[1].key!;
    expect(flip(inp, st0, exSv)).toEqual({ state: st0, targets: inp.targets });
  });
  it("a language you translate into keeps machine translation when the cap cuts its site track", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl", "sv", "fi", "da"];
    const inp = input({ tracks: [...langs.map((l) => tr(l, l)), tr("de", "de")], targets: ["sv"] });
    const v = derive(inp, initialSiteState(inp.targets));
    expect(v.run!.fetch).not.toContain("sv");
    expect(v.run!.mtTargets).toEqual(["sv"]);
    const [mt, ex] = v.rows.find((r) => r.code === "sv")!.badges;
    expect([mt.state, ex.state]).toEqual(["active", "idle"]);
    expect(mt.title).toBe("Click to stop translating into Swedish");
    expect(ex.title).toBe("Over the 8-subtitle download limit — machine translation fills in");
    const chip = v.chips.find((c) => c.code === "sv")!;
    expect(chip.parts.map((p) => p.on)).toEqual([true, false]);
    // The faint site part says why it is off — its click does nothing.
    expect(chip.parts[1].title).toMatch(/8-subtitle download limit/);
    // The site-only overflow languages still drop out.
    expect(v.chips.map((c) => c.code)).not.toContain("fi");
  });
  it("a preset machine-translates into at most the server's limit, your targets first", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl", "sv", "fi", "da", "nb", "cs"];
    const inp = input({ tracks: [...langs.map((l) => tr(l, l)), tr("de", "de")], targets: ["ja", "fi"], maxTargets: 5 });
    for (const policy of ["generate", "both"] as const) {
      const [i1, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), policy));
      const v = derive(i1, st);
      expect(v.run!.mtTargets).toEqual(["ja", "fi", "en", "fr", "it"]);
      const da = v.rows.find((r) => r.code === "da")!;
      expect([da.badges[0].state, da.badges[0].title]).toEqual(["idle", "Over the 5-language translation limit"]);
      // Its greyed badge's click changes nothing — not even the preset.
      expect(flip(i1, st, "mt:da")).toEqual({ state: st, targets: i1.targets });
      // Machine translation was its only source left: the site language drops out.
      expect(da.sub).toBe("over the translation limit");
      expect(v.chips.map((c) => c.code)).not.toContain("da");
      if (policy === "generate") {
        expect(v.chips.map((c) => c.code)).toEqual(["ja", "fi", "en", "fr", "it"]);
        // Custom starts from what is on screen: the dropped languages are not written into the targets.
        const [ci, cu] = apply(i1, pickPolicy(i1, st, "custom"));
        expect(ci.targets).toEqual(["ja", "fi", "en", "fr", "it"]);
        expect(derive(ci, cu).run!.mtTargets).toEqual(["ja", "fi", "en", "fr", "it"]);
      } else {
        // Side by side: a downloaded site track still brings the language (da's fell past the 8-download cap).
        const es = v.rows.find((r) => r.code === "es")!;
        expect([es.sub, es.badges.map((x) => x.state)]).toEqual(["from the site", ["idle", "active"]]);
        expect(v.chips.map((c) => c.code)).toContain("es");
        // Switching off its site track: machine translation takes over es, its slot taken from
        // a language a site track still covers (it keeps that track) — not from your targets.
        const [fi1, fst] = apply(i1, flip(i1, st, es.badges[1].key!));
        expect(fi1.targets).toContain("es");
        const fv = derive(fi1, fst);
        expect(fv.run!.fetch).not.toContain("es");
        expect(fv.run!.mtTargets).toEqual(["ja", "fi", "en", "fr", "es"]);
        expect(fv.chips.find((c) => c.code === "es")!.parts.map((p) => p.on)).toEqual([true, false]);
        expect(fv.chips.find((c) => c.code === "it")!.parts.map((p) => p.on)).toEqual([false, true]);
      }
    }
    // Without a known limit nothing is cut.
    const [i2, st2] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "generate"));
    expect(derive({ ...i2, maxTargets: undefined }, st2).run!.mtTargets).toHaveLength(13);
  });
  it("switching off a site track drops its language when the translation limit leaves no slot", () => {
    // Prefer: es comes from the site, its MT badge idle — it never counted against the limit.
    const inp = input({ tracks: [tr("de", "de"), tr("es", "es")], targets: ["ja"], maxTargets: 1 });
    const st = initialSiteState(inp.targets);
    const es = derive(inp, st).rows.find((r) => r.code === "es")!;
    expect(es.badges.map((b) => b.state)).toEqual(["idle", "active"]);
    const [i1, s1] = apply(inp, flip(inp, st, es.badges[1].key!));
    expect(i1.targets).toEqual(["ja"]);
    const v = derive(i1, s1);
    expect(v.chips.map((c) => c.code)).not.toContain("es");
    expect(v.run!.mtTargets).toEqual(["ja"]);
    // With a free slot machine translation still takes over.
    const wide = { ...inp, maxTargets: 2 };
    const [i2, s2] = apply(wide, flip(wide, st, es.badges[1].key!));
    expect(i2.targets).toEqual(["ja", "es"]);
    expect(derive(i2, s2).run!.mtTargets).toEqual(["ja", "es"]);
  });
  it("switching off a site track never takes the translation slot of another language's only source", () => {
    // ja holds the one slot; es comes from the site and is listed first among your targets.
    const inp = input({ tracks: [tr("de", "de"), tr("es", "es")], targets: ["es", "ja"], maxTargets: 1 });
    const [i1, s1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:es"));
    expect(i1.targets).toEqual(["ja"]);
    const v = derive(i1, s1);
    expect(v.run!.mtTargets).toEqual(["ja"]);
    expect(v.chips.map((c) => c.code)).toEqual(["ja"]);
  });
  it("switching machine translation on at a full translation limit changes nothing", () => {
    // Prefer: es is covered by its site track, its MT badge idle; ja holds the one slot.
    const inp = input({ tracks: [tr("en", "en"), tr("es", "es")], spoken: "en", targets: ["ja"], maxTargets: 1 });
    const st = initialSiteState(inp.targets);
    expect(flip(inp, st, "mt:es")).toEqual({ state: st, targets: ["ja"] });
    // The dead click says why, on the row's badge and the chip's part alike.
    const limit = "At the 1-language translation limit — switch another translation off first";
    const v = derive(inp, st);
    expect(v.rows.find((r) => r.code === "es")!.badges[0].title).toBe(limit);
    expect(v.chips.find((c) => c.code === "es")!.parts[0].title).toBe(limit);
    // With a free slot the click works and the titles offer it.
    const wide = { ...inp, maxTargets: 2 };
    const vw = derive(wide, st);
    expect(vw.rows.find((r) => r.code === "es")!.badges[0].title).toBe("Not needed: existing subtitles cover Spanish — click to machine-translate anyway");
    expect(vw.chips.find((c) => c.code === "es")!.parts[0].title).toBe("Machine-translate into Spanish as well");
    // Its site track switched off first (es drops, as above): switching MT on is refused too,
    // rather than leaving es wanted with no source at all.
    const inp2 = input({ tracks: [tr("de", "de"), tr("es", "es")], targets: ["ja"], maxTargets: 1 });
    const [i1, s1] = apply(inp2, flip(inp2, initialSiteState(inp2.targets), "ex:es"));
    expect(derive(i1, s1).rows.find((r) => r.code === "es")!.badges[0].title).toBe(limit);
    const [i2, s2] = apply(i1, flip(i1, s1, "mt:es"));
    expect(i2.targets).toEqual(["ja"]);
    expect(derive(i2, s2).chips.map((c) => c.code)).toEqual(["ja"]);
  });
  it("at a full translation limit only a language a site track would serve adds free", () => {
    // ja holds the one slot; es's chip was removed.
    const inp = input({ tracks: [tr("en", "en"), tr("es", "es")], spoken: "en", targets: ["ja"], maxTargets: 1 });
    const st = initialSiteState(inp.targets);
    const [i1, s1] = apply(inp, setTargets(inp, st, derive(inp, st).chips.map((c) => c.code).filter((c) => c !== "es")));
    expect(derive(i1, s1).chips.map((c) => c.code)).not.toContain("es");
    // Prefer: re-adding es lights its site track and needs no translation slot.
    expect(freeAdds(i1, s1)).toEqual(["es"]);
    expect(freeAdds(i1, s1, derive(i1, s1))).toEqual(["es"]);
    // Generate: the site track stays idle, so es would need the full machine translation.
    const [i2, s2] = apply(i1, pickPolicy(i1, s1, "generate"));
    expect(freeAdds(i2, s2)).not.toContain("es");
  });
  it("a preset gives the translation slot to a language with no other source first", () => {
    // de is a target the site covers; fr was added and only machine translation can bring it.
    const inp = input({ tracks: [tr("en", "en"), tr("de", "de")], spoken: "en", targets: ["de"], maxTargets: 1 });
    const [i1, s1] = apply(inp, addLanguage(inp, initialSiteState(inp.targets), "fr"));
    expect(derive(i1, s1).run!.mtTargets).toEqual(["fr"]);
    const [i2, s2] = apply(i1, pickPolicy(i1, s1, "both"));
    const v = derive(i2, s2);
    expect(v.run!.mtTargets).toEqual(["fr"]);
    expect(v.chips.find((c) => c.code === "de")!.parts.map((p) => p.on)).toEqual([false, true]);
    // Under Prefer, de's redundant machine translation cannot take fr's slot either.
    expect(flip(i1, s1, "mt:de")).toEqual({ state: s1, targets: i1.targets });
  });
  it("Custom: a machine-translation badge the rules switch keeps a title that matches its state", () => {
    const inp = input({ tracks: [tr("en", "en"), tr("de-orig", "de", { kind: "auto" })], spoken: "en", targets: ["de"] });
    // German's only track is auto-generated and the auto switch went off: translation fills in.
    const st: SiteSubsState = { ...initialSiteState(["de", "fr"]), policy: "custom", sel: { "mt:de": false, "mt:fr": true } };
    const de = badge(inp, st, "de", "mt:de");
    expect([de.state, de.title]).toEqual(["active", "Click to switch it off"]);
    // A stale pick for a language you do not translate into stays off.
    const fr = badge(inp, st, "fr", "mt:fr");
    expect([fr.state, fr.title]).toEqual(["off", "Click to switch it on"]);
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
  it("a speaker the import split off a cue stays in the site cue's text", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nJOHN: Hello\n\n00:00:03.000 --> 00:00:04.000\n<v Kate>Hi</v>\n";
    const timed = siteTimedTracks([{ id: "en", lang: "en", kind: "manual", parsed: parseImportedText("vtt", vtt) }]);
    expect(timed[0].cues.map((c) => c.text)).toEqual(["JOHN: Hello", "Kate: Hi"]);
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
      language: "de", probability: 0.99, verdict: "detected" as const, also: [], mediaId: null, mediaExpiresAt: null,
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
  it("setTargets under Custom: a dropped chip stops downloading its site track", () => {
    const inp = input();
    const [inp1, st1] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    expect(derive(inp1, st1).run!.fetch).toContain("fr");
    const [inp2, st2] = apply(inp1, setTargets(inp1, st1, ["en", "it"]));
    expect(derive(inp2, st2).chips.map((c) => c.code)).toEqual(["en", "it"]);
    expect(derive(inp2, st2).run!.fetch).not.toContain("fr");
    expect(badge(inp2, st2, "fr", "ex:fr").state).toBe("off");
  });
  it("frozenSiteRun: no machine translation without a translator; only the fetched tracks' facts", () => {
    const run = { fetch: ["de", "en"], transcriptTrackId: "de", mtTargets: ["fr"] };
    expect(frozenSiteRun(run, ARTE, true)).toEqual({ ...run, tracks: [ARTE[0], ARTE[2]] });
    expect(frozenSiteRun(run, ARTE, false).mtTargets).toEqual([]);
  });
});
