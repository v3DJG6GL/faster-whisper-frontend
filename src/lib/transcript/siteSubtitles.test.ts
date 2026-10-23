// One test per D86 decision-log rule (memory cue-splitting.md, v25…v39).
import { describe, expect, it } from "vitest";
import {
  addLanguage, attachSiteTracks, derive, freeAdds, frozenSiteRun, mtUsed, setTargets, linkSpoken, spokenPill, siteTimedTracks, siteWord, flip, flipChipPart, initialSiteState, listedLanguages, pickPolicy, removeLanguage, setSubs, toggleTarget, writeTargets,
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
  it("an unknown spoken language: dropping a language stops downloading its track, candidate badge included", () => {
    const inp = input({ spoken: null, tracks: [tr("de-CH", "de-CH"), tr("fr", "fr")], targets: ["fr"] });
    const st0 = initialSiteState(inp.targets);
    const keys = (i: SiteSubsInput, st: SiteSubsState) =>
      Object.fromEntries(derive(i, st).rows.flatMap((r) => r.badges).filter((b) => b.key && /^(?:ex|cand):/.test(b.key))
        .map((b) => [b.key, b.state]));
    expect(derive(inp, st0).run!.fetch).toEqual(["de-CH", "fr"]);
    // Prefer: the de chip removed in the chips' picker.
    const [i1, st1] = apply(inp, setTargets(inp, st0, ["fr"]));
    expect(derive(i1, st1).chips.map((c) => c.code)).toEqual(["fr"]);
    expect(derive(i1, st1).run!.fetch).toEqual(["fr"]);
    expect(keys(i1, st1)).toEqual({ "cand:de-CH": "off", "cand:fr": "active", "ex:de-CH": "off", "ex:fr": "active" });
    // Re-added, both badges are back as before.
    const [i2, st2] = apply(i1, setTargets(i1, st1, ["fr", "de"]));
    expect(derive(i2, st2).run!.fetch).toEqual(["de-CH", "fr"]);
    expect(keys(i2, st2)).toEqual(keys(inp, st0));
    // Custom: "Translate into" German off.
    const [i3, st3] = apply(inp, pickPolicy(inp, st0, "custom"));
    const [i4, st4] = apply(i3, toggleTarget(i3, st3, "de", false));
    expect(derive(i4, st4).run!.fetch).toEqual(["fr"]);
    expect(keys(i4, st4)).toEqual({ "cand:de-CH": "off", "cand:fr": "active", "ex:de-CH": "off", "ex:fr": "active" });
    // Re-added under Custom, machine translation serves it and the twins still agree.
    const [i5, st5] = apply(i4, toggleTarget(i4, st4, "de", true));
    expect(derive(i5, st5).run).toMatchObject({ fetch: ["fr"], mtTargets: ["de"] });
    expect(keys(i5, st5)).toMatchObject({ "cand:de-CH": "off", "ex:de-CH": "off" });
    // Another language's candidate is untouched.
    const [i6, st6] = apply(inp, toggleTarget(inp, st0, "de", false));
    expect(keys(i6, st6)).toMatchObject({ "cand:fr": "active", "ex:fr": "active" });
  });
  it("a language dropped under Custom once the spoken language is known stays off when it is unknown again", () => {
    const inp = input({ spoken: null, tracks: [tr("de-CH", "de-CH"), tr("fr", "fr"), tr("en", "en")], targets: ["fr"] });
    // Custom taken while the spoken language was unknown: its snapshot picks the de-CH candidate.
    const [i1, st1] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    const i2 = { ...i1, spoken: "en" };
    const [i3, st3] = apply(i2, toggleTarget(i2, st1, "de", false));
    expect(derive(i3, st3).run!.fetch).not.toContain("de-CH");
    const i4 = { ...i3, spoken: null };
    const v = derive(i4, st3);
    expect(v.run!.fetch).not.toContain("de-CH");
    expect(v.rows.flatMap((r) => r.badges).filter((b) => b.key === "cand:de-CH").map((b) => b.state)).toEqual(["off"]);
  });
  it("a track left out under Custom while the spoken language was known stays out as a candidate once it is unknown", () => {
    // The spoken language never is a target, so the language map cannot say it is off: only the
    // snapshot's ex: pick does, and the candidate was never in that snapshot.
    const inp = input({ spoken: "en", tracks: [tr("en", "en"), tr("de", "de")], targets: [] });
    const [i1, st1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:en"));
    expect(st1.policy).toBe("custom");
    expect(derive(i1, st1).run!.fetch).toEqual(["de"]);
    const i2 = { ...i1, spoken: null };
    const v = derive(i2, st1);
    expect(v.rows.flatMap((r) => r.badges).filter((b) => /^(?:ex|cand):en$/.test(b.key ?? "")).map((b) => [b.key, b.state]))
      .toEqual([["cand:en", "off"], ["ex:en", "off"]]);
    expect(v.run!.fetch).toEqual(["de"]);
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
  it("without machine translation a Custom row whose site subtitle downloads does not read off", () => {
    const tracks = [tr("de", "de"), tr("fr", "fr"), tr("en", "en")];
    // No machine translation: the caller feeds no targets and drops the ones a change writes.
    const inp = input({ tracks, spoken: "en", targets: [] });
    const st0 = initialSiteState([]);
    const rowsOf = (st: SiteSubsState) =>
      derive(inp, st).rows.filter((r) => r.code).map((r) => [r.code, r.sub, r.badges.map((b) => b.state)]);
    expect(rowsOf(st0)).toEqual([
      ["de", "from the site", ["idle", "active"]], ["fr", "from the site", ["idle", "active"]],
    ]);
    for (const ch of [pickPolicy(inp, st0, "custom"), flip(inp, st0, "ex:fr")]) {
      const v = derive(inp, ch.state);
      expect(v.run!.fetch).toContain("de");
      expect(v.rows.find((r) => r.code === "de")!.sub).toBe("from the site");
      expect(v.rows.find((r) => r.code === "de")!.badges[1].state).toBe("active");
    }
    // A row whose site subtitle is off still reads off.
    const off = flip(inp, st0, "ex:fr");
    expect(derive(inp, off.state).rows.find((r) => r.code === "fr")!.sub).toBe("off");
    // With machine translation the targets flow back: unchanged.
    const [i1, st1] = apply({ ...inp, targets: ["de"] }, pickPolicy({ ...inp, targets: ["de"] }, initialSiteState(["de"]), "custom"));
    expect(derive(i1, st1).rows.filter((r) => r.code).map((r) => r.sub)).toEqual(["translation target", "translation target"]);
  });
  it("switching a source on makes the language wanted again", () => {
    const inp = input();
    const [i1, st1] = apply(inp, toggleTarget(inp, initialSiteState(inp.targets), "it"));
    expect(derive(i1, st1).chips.map((c) => c.code)).not.toContain("it");
    const [i2] = apply(i1, flip(i1, st1, "ex:it"));
    expect(i2.targets).toContain("it");
  });
  it("a site language named like an Object member (constructor) switches off like any other", () => {
    // The same clicks on an ordinary code and on "constructor" end the same way: the code is
    // a key of the panel's target map, where an inherited member must not read as wanted.
    const run = (code: string) => {
      const inp = input({ tracks: [...ARTE, tr("x", code)] });
      const st0 = initialSiteState(inp.targets);
      const name = (c: string) => (c === code ? "X" : c);
      const chips = (i: SiteSubsInput, st: SiteSubsState) => derive(i, st).chips.map((c) => name(c.code));
      const sel = (st: SiteSubsState) =>
        Object.entries(st.sel ?? {}).map(([k, v]) => [k.replace(code, "X"), v]);
      // Under a preset: switched off, the language leaves the targets and the chips.
      const [i1, st1] = apply(inp, toggleTarget(inp, st0, code));
      // Under Custom, the language dropped from the targets outside the panel: its site track
      // switched off.
      const ic = { ...inp, targets: ["en"] };
      const cu = pickPolicy(ic, initialSiteState(ic.targets), "custom");
      const [i2, st2] = apply(ic, flip(ic, cu.state, "ex:x"));
      return {
        before: chips(inp, st0),
        off: [chips(i1, st1), st1.off.map(name), i1.targets.map(name)],
        flipped: [chips(i2, st2), sel(st2), i2.targets.map(name)],
      };
    };
    const plain = run("zz");
    expect(plain.off).toEqual([["en", "fr", "it"], ["X"], ["en", "fr"]]);
    expect(run("constructor")).toEqual(plain);
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
  it("a deleted language picked again outside the panel (switch off) comes back as a row and a chip", () => {
    const inp = input({ targets: ["es"] });
    const st0 = initialSiteState(inp.targets);
    const [i1, st1] = apply(inp, removeLanguage(inp, st0, "es"));
    // The switch off, the chips' plain picker writes the targets without touching the panel state.
    const i2 = { ...i1, targets: ["es"] };
    const v = derive(i2, st1);
    expect(v.rows.find((r) => r.code === "es")?.deletable).toBe(true);
    expect(v.chips.map((c) => c.code)).toContain("es");
    expect(listedLanguages(i2, st1)).toContain("es");
    const chips = v.chips.map((c) => c.code);
    expect(v.run!.mtTargets.filter((c) => !chips.includes(c))).toEqual([]);
    expect(v.run!.mtTargets).toContain("es");
  });
  it("v30 chip parts in fixed order: machine translation, then existing", () => {
    const inp = input({ targets: ["en", "es"] });
    const v = derive(inp, initialSiteState(inp.targets));
    const en = v.chips.find((c) => c.code === "en")!;
    expect(en.parts.map((p) => [p.kind, p.text])).toEqual([["mt", "Machine translation"], ["existing", "Site"]]);
    const es = v.chips.find((c) => c.code === "es")!;
    expect(es.parts.map((p) => p.text)).toEqual(["Machine translation"]);
  });
  it("a chip's site part shows the track the run uses when two tracks fold into one language", () => {
    const inp = input({ tracks: [tr("t0", "en"), tr("t1", "en-GB")], targets: [], site: "YouTube" });
    const [i1, st1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:t0"));
    const v = derive(i1, st1);
    expect(v.run!.fetch).toEqual(["t1"]);
    const en = v.chips.find((c) => c.code === "en")!;
    expect(en.parts.map((p) => [p.key, p.on])).toEqual([["mt:en", false], ["ex:t1", true]]);
    expect(en.parts[1].title).toBe("Leave out the YouTube English subtitles");
  });
  it("leaving out a chip's site part leaves out every site track of that language in one click", () => {
    const inp = input({ tracks: [tr("t0", "en"), tr("t1", "en-GB")], targets: ["en"], site: "YouTube" });
    const st = initialSiteState(inp.targets);
    const part = derive(inp, st).chips.find((c) => c.code === "en")!.parts[1];
    expect([part.key, part.on]).toEqual(["ex:t0", true]);
    const [i1, st1] = apply(inp, flipChipPart(inp, st, part.key));
    const v = derive(i1, st1);
    expect(v.rows.find((r) => r.code === "en")!.badges.filter((b) => b.key?.startsWith("ex:") && b.state === "active")).toEqual([]);
    expect(v.run!.fetch).toEqual([]);
    // English stays served: machine translation takes over, as for a single track.
    expect(v.chips.find((c) => c.code === "en")!.parts.map((p) => p.on)).toEqual([true, false]);
    // Switched back on from the chip, one track serves it again.
    const back = v.chips.find((c) => c.code === "en")!.parts[1];
    const [i2, st2] = apply(i1, flipChipPart(i1, st1, back.key));
    expect(derive(i2, st2).run!.fetch).toEqual([back.key.slice(3)]);
    // The panel's per-track badge still flips that one track alone.
    const [i3, st3] = apply(inp, flip(inp, st, "ex:t0"));
    expect(derive(i3, st3).run!.fetch).toEqual(["t1"]);
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
  it("Custom without machine translation: a row the cap cuts no longer reads 'from the site'", () => {
    // No translation on the server: the input's targets stay empty, so no row is a target. Turning
    // on auto-generated subtitles pushes pl over the cap; its row kept "from the site" beside the
    // greyed badge of a track the run never downloads.
    const langs = ["de", "en", "fr", "it", "es", "pt", "nl", "pl", "sv"];
    const inp = input({ tracks: [tr("auto-de", "de", { kind: "auto" }), ...langs.map((l) => tr(l, l))], targets: [], site: "YouTube" });
    const { state } = pickPolicy(inp, initialSiteState([]), "custom");
    expect(derive(inp, state).rows.find((r) => r.code === "pl")!.sub).toBe("from the site");
    const v = derive(inp, { ...state, auto: true });
    expect(v.run!.fetch).toEqual(["auto-de", "de", "en", "fr", "it", "es", "pt", "nl"]);
    const pl = v.rows.find((r) => r.code === "pl")!;
    expect(pl.badges.map((b) => b.state)).toEqual(["off", "idle"]);
    expect(pl.sub).toBe("over the download limit");
    // A kept site language still reads as one, and the one never switched on stays off.
    expect(v.rows.find((r) => r.code === "nl")!.sub).toBe("from the site");
    expect(v.rows.find((r) => r.code === "sv")!.sub).toBe("off");
    expect(v.run!.mtTargets).toEqual([]);
  });
  it("a language you translate into keeps machine translation when the cap cuts its site track", () => {
    // Eight targets with a site track each, plus the transcript's: Swedish, last in site order, is cut.
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl", "sv", "fi", "da"];
    const inp = input({ tracks: [...langs.map((l) => tr(l, l)), tr("de", "de")], targets: langs.slice(0, 8) });
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
  it("the download cap keeps the tracks of the languages you translate into ahead of the site's others", () => {
    // Ten site languages, one asked for — and it is the last: site order alone filled the cap
    // with eight nobody asked for and machine-translated Japanese despite its human track.
    const langs = ["ar", "bg", "cs", "da", "de", "el", "es", "fi", "fr", "ja"];
    const inp = input({ tracks: langs.map((l) => tr(l, l)), spoken: "en", targets: ["ja"] });
    const v = derive(inp, initialSiteState(inp.targets));
    expect(v.run!.fetch).toEqual(["ar", "bg", "cs", "da", "de", "el", "es", "ja"]);
    expect(v.run!.mtTargets).toEqual([]);
    const [mt, ex] = v.rows.find((r) => r.code === "ja")!.badges;
    expect([mt.state, ex.state]).toEqual(["idle", "active"]);
    expect(ex.title).not.toMatch(/download limit/);
    // The site's own languages fill the rest in its order; the overflow drops out.
    expect(v.rows.find((r) => r.code === "fi")!.sub).toBe("over the download limit");
    // Without machine translation on the server the frozen run still downloads Japanese.
    expect(frozenSiteRun(v.run!, inp.tracks, false).tracks!.map((t) => t.id)).toContain("ja");
  });
  it("under Custom the cap's grey stays temporary: freeing a slot brings the cut track back", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "sv"];
    const inp = input({ tracks: [tr("de", "de"), tr("auto-de", "de", { kind: "auto" }), ...langs.map((l) => tr(l, l))], targets: ["sv"], site: "YouTube" });
    const [i0, s0] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    expect(derive(i0, s0).rows.find((r) => r.code === "sv")!.badges.map((b) => b.state)).toEqual(["off", "active"]);
    // Auto-generated on pushes Swedish past the cap: machine translation fills in.
    const s1 = { ...s0, auto: true };
    expect(derive(i0, s1).run!.mtTargets).toEqual(["sv"]);
    // English off frees a slot: the Swedish subtitle picked is downloaded again, not translated.
    const [i2, s2] = apply(i0, flip(i0, s1, "ex:en"));
    expect(derive(i2, s2).run!.fetch).toContain("sv");
    expect(derive(i2, s2).run!.mtTargets).not.toContain("sv");
    // And auto-generated off again keeps that pick.
    const v = derive(i2, { ...s2, auto: false });
    expect(v.rows.find((r) => r.code === "sv")!.badges.map((b) => b.state)).toEqual(["off", "active"]);
    expect(v.run!.fetch).toContain("sv");
    expect(v.run!.mtTargets).not.toContain("sv");
  });
  it("under Custom, switching off a language's fetched track that frees the slot of its capped twin downloads the twin — no machine translation", () => {
    const inp = input({
      tracks: [tr("de", "de"), tr("auto-de", "de", { kind: "auto" }), tr("ja", "ja"), ...["en", "fr", "it", "es", "pt"].map((l) => tr(l, l)), tr("ja-JP", "ja")],
      targets: ["ja"],
    });
    const [i0, s0] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    const s1 = { ...s0, auto: true };
    expect(derive(i0, s1).run!.fetch).not.toContain("ja-JP");
    const [i2, s2] = apply(i0, flip(i0, s1, "ex:ja"));
    const v = derive(i2, s2);
    expect(v.run!.fetch).toContain("ja-JP");
    expect(v.run!.mtTargets).not.toContain("ja");
    expect(v.chips.find((c) => c.code === "ja")!.parts.map((p) => [p.key, p.on])).toEqual([["mt:ja", false], ["ex:ja-JP", true]]);
  });
  it("clicking the active Custom segment again keeps the pick: a cap's grey and fill-in stay temporary", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl"];
    const inp = input({ tracks: [tr("de", "de"), tr("en-auto", "en", { kind: "auto" }), ...langs.map((l) => tr(l, l))], maxTargets: 3, targets: [] });
    const [i0, s0] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    const s1 = { ...s0, auto: true };
    expect(derive(i0, s1).run!.fetch).not.toContain("pl");
    const again = pickPolicy(i0, s1, "custom");
    const [i2, s2] = apply(i0, again);
    const [i3, s3] = apply(i2, flip(i2, s2, "ex:en-auto"));
    expect(derive(i3, s3).run!.fetch).toContain("pl");
    expect(derive(i3, s3).run!.mtTargets).not.toContain("pl");
    expect(again).toEqual({ state: s1, targets: i0.targets });
  });
  it("under Custom the translation limit's grey stays temporary: a click elsewhere does not save it", () => {
    const [ib, sb] = apply(input({ targets: [] }), pickPolicy(input({ targets: [] }), initialSiteState([]), "both"));
    const [i0, s0] = apply(ib, pickPolicy(ib, sb, "custom"));
    expect(derive(i0, s0).run!.mtTargets).toEqual(["en", "fr", "it"]);
    // The server's limit drops to two: Italian's machine translation greys out.
    const lim = { ...i0, maxTargets: 2 };
    expect(badge(lim, s0, "it", "mt:it").state).toBe("idle");
    // An unrelated click, then the limit lifted again: Italian is machine-translated as picked.
    const [i1, s1] = apply(lim, flip(lim, s0, "ex:de-hoh"));
    const up = { ...i1, maxTargets: undefined };
    expect(badge(up, s1, "it", "mt:it").state).toBe("active");
    expect(derive(up, s1).run!.mtTargets).toEqual(["en", "fr", "it"]);
  });
  it("switching a site track on at a full download changes nothing — no machine translation in its place", () => {
    const langs = ["de", "fr", "es", "it", "pt", "nl", "ru", "pl", "ja"];
    const inp = input({ tracks: langs.map((l) => tr(l, l)), spoken: "en", targets: [], maxTargets: 3 });
    // German off (Custom: the cut Japanese is written as not wanted), German back on: 8 kept again.
    const [i1, s1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:de"));
    const [i2, s2] = apply(i1, flip(i1, s1, "ex:de"));
    expect(derive(i2, s2).run!.fetch).toHaveLength(8);
    // Japanese's struck site track would land past the cap: refused, nothing translated instead.
    expect(flip(i2, s2, "ex:ja")).toEqual({ state: s2, targets: i2.targets });
    const v = derive(i2, s2);
    expect(v.run!.mtTargets).not.toContain("ja");
    const ja = v.rows.find((r) => r.code === "ja")!.badges.find((b) => b.key === "ex:ja")!;
    expect(ja.title).toBe("At the 8-subtitle download limit — switch another subtitle off first");
    // Below the cap the same click works.
    const [i3, s3] = apply(i2, flip(i2, s2, "ex:fr"));
    expect(derive(i3, s3).rows.find((r) => r.code === "ja")!.badges.find((b) => b.key === "ex:ja")!.title)
      .toBe("Click to switch it on");
    const [i4, s4] = apply(i3, flip(i3, s3, "ex:ja"));
    expect(derive(i4, s4).run!.fetch).toContain("ja");
  });
  it("at a full download a site track earlier in site order than the last fetched one is refused and displaces nothing", () => {
    const langs = ["de", "fr", "es", "it", "pt", "nl", "ru", "pl", "ja"];
    const inp = input({ tracks: langs.map((l) => tr(l, l)), spoken: "en", targets: [], maxTargets: 3 });
    // French off, Japanese on, French's machine translation off: Japanese is the eighth track.
    const [i1, s1] = apply(inp, flip(inp, initialSiteState(inp.targets), "ex:fr"));
    const [i2, s2] = apply(i1, flip(i1, s1, "ex:ja"));
    const [i3, s3] = derive(i2, s2).rows.find((r) => r.code === "fr")!.badges.find((b) => b.key === "mt:fr")!.state === "active"
      ? apply(i2, flip(i2, s2, "mt:fr")) : [i2, s2];
    const v = derive(i3, s3);
    expect(v.run!.fetch).toEqual(["de", "es", "it", "pt", "nl", "ru", "pl", "ja"]);
    // French back on would push Japanese past the cap (machine translation in its place): refused.
    expect(flip(i3, s3, "ex:fr")).toEqual({ state: s3, targets: i3.targets });
    const fr = v.rows.find((r) => r.code === "fr")!.badges.find((b) => b.key === "ex:fr")!;
    expect(fr.title).toBe("At the 8-subtitle download limit — switch another subtitle off first");
    expect(v.run!.mtTargets).not.toContain("ja");
    // A fetched track's own badge (switching it off) is never titled with the limit.
    const ja = v.rows.find((r) => r.code === "ja")!.badges.find((b) => b.key === "ex:ja")!;
    expect(ja.title).not.toMatch(/download limit/);
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
  it("back under a preset, the site languages entering Custom wrote into the targets rank as the site's again", () => {
    // Entering Custom (the segment or a badge click) wrote every site language into the targets.
    // Under Generate they kept outranking the site's others at the translation limit as if you
    // had picked them, and the ones past it stayed chips with no source at all.
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl"];
    const inp = input({ tracks: [tr("de", "de"), ...langs.map((l) => tr(l, l))], targets: ["ja"], maxTargets: 3 });
    const s0 = initialSiteState(inp.targets);
    const [ig, sg] = apply(inp, pickPolicy(inp, s0, "generate"));
    for (const enter of [pickPolicy(inp, s0, "custom"), flip(inp, s0, "ex:it")]) {
      const [i1, s1] = apply(inp, enter);
      expect(i1.targets).toEqual(["ja", ...langs]);
      const [i2, s2] = apply(i1, pickPolicy(i1, s1, "generate"));
      const v = derive(i2, s2);
      expect(v.chips.filter((c) => !c.parts.some((p) => p.on)).map((c) => c.code)).toEqual([]);
      expect(v.rows.find((r) => r.code === "pl")!.sub).toBe("over the translation limit");
      // As if Custom had never been entered.
      expect(i2.targets).toEqual(["ja"]);
      expect(v.chips.map((c) => c.code)).toEqual(derive(ig, sg).chips.map((c) => c.code));
      expect(v.run!.mtTargets).toEqual(["ja", "en", "fr"]);
    }
  });
  it("a language you pick yourself under Custom stays a target when a preset takes over", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl"];
    const inp = input({ tracks: [tr("de", "de"), ...langs.map((l) => tr(l, l))], targets: ["ja"], maxTargets: 3 });
    let [i, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    // Added through "Add language", and a site language switched off and picked again.
    [i, st] = apply(i, addLanguage(i, st, "ko"));
    [i, st] = apply(i, toggleTarget(i, st, "pl", false));
    [i, st] = apply(i, toggleTarget(i, st, "pl", true));
    [i, st] = apply(i, pickPolicy(i, st, "generate"));
    expect(i.targets).toEqual(expect.arrayContaining(["ja", "ko", "pl"]));
    expect(derive(i, st).chips.map((c) => c.code)).toEqual(expect.arrayContaining(["ja", "ko", "pl"]));
  });
  it("a language picked again by a badge or chip-part click stays a target when a preset takes over, as through toggleTarget", () => {
    const langs = ["en", "fr", "it", "es", "pt", "nl", "pl"];
    const inp = input({ tracks: [tr("de", "de"), ...langs.map((l) => tr(l, l))], targets: ["ja"], maxTargets: 3 });
    type Step = (i: SiteSubsInput, st: SiteSubsState) => SiteChange;
    const drop: Step = (i, st) => flip(i, st, "mt:pl");
    // Custom, pl's site track off (machine translation takes over), then its MT off: pl drops.
    const start: Step[] = [(i, st) => pickPolicy(i, st, "custom"), (i, st) => flip(i, st, "ex:pl"), drop];
    const repicks: Step[] = [
      (i, st) => flip(i, st, "mt:pl"),
      (i, st) => flipChipPart(i, st, "mt:pl"),
      (i, st) => flip(i, st, "ex:pl"),
      (i, st) => toggleTarget(i, st, "pl", true),
    ];
    for (const repick of repicks) {
      let [i, st] = [inp, initialSiteState(inp.targets)];
      for (const step of [...start, repick, (i2: SiteSubsInput, s2: SiteSubsState) => pickPolicy(i2, s2, "generate")]) {
        [i, st] = apply(i, step(i, st));
      }
      expect(i.targets).toEqual(["ja", "pl"]);
      expect(derive(i, st).run!.mtTargets).toEqual(["ja", "pl", "en"]);
      expect(derive(i, st).rows.find((r) => r.code === "pl")!.sub).toBe("translation target");
    }
  });
  it("a language Custom promoted is yours once the site subtitles are switched off: a later preset keeps it", () => {
    // With the switch off the plain picker owns the chips, and a promoted fr there is an ordinary
    // target the run machine-translates; a preset after switching back on took it out of the list.
    const inp = input({ tracks: [tr("en", "en"), tr("fr", "fr")], spoken: "en", targets: ["de"], maxTargets: 1 });
    let [i, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    expect(i.targets).toEqual(["de", "fr"]);
    expect(st.promoted).toEqual(["fr"]);
    [i, st] = apply(i, setSubs(i, st, false));
    expect(st.promoted).toEqual([]);
    [i, st] = apply(i, setSubs(i, st, true));
    [i, st] = apply(i, pickPolicy(i, st, "generate"));
    expect(i.targets).toEqual(["de", "fr"]);
    expect(derive(i, st).chips.map((c) => c.code)).toEqual(expect.arrayContaining(["de", "fr"]));
  });
  it("a language Custom promoted is yours once the Translation switch writes the targets again: a later preset keeps it", () => {
    // Off, then on with the seed bringing en back: still counted as promoted, a preset cut it
    // from the saved list and the switch (targets.length > 0) turned itself off.
    const inp = input({ tracks: [tr("de", "de"), tr("en", "en")], spoken: "de", targets: ["ja"], maxTargets: 3 });
    let [i, st] = apply(inp, pickPolicy(inp, initialSiteState(inp.targets), "custom"));
    expect(i.targets).toEqual(["ja", "en"]);
    expect(st.promoted).toEqual(["en"]);
    [i, st] = apply(i, writeTargets(st, []));
    [i, st] = apply(i, writeTargets(st, ["en"]));
    [i, st] = apply(i, pickPolicy(i, st, "prefer"));
    expect(i.targets).toEqual(["en"]);
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
    // Nor when its own MT, greyed by the limit, would win the slot back once the track is off:
    // ko's machine translation holds the slot, and es's MT is kept on under it.
    let i = input({ tracks: [tr("es1", "es"), tr("ko1", "ko")], spoken: "en", targets: ["es", "ko"], maxTargets: 1 });
    let st = initialSiteState(i.targets);
    for (const key of ["mt:es", "ex:ko1", "ex:es1"]) [i, st] = apply(i, flip(i, st, key));
    expect(i.targets).toEqual(["ko"]);
    const w = derive(i, st);
    expect(w.run!.mtTargets).toEqual(["ko"]);
    expect(w.chips.map((c) => c.code)).toEqual(["ko"]);
    expect(w.chips.filter((c) => !c.parts.some((p) => p.on)).map((c) => c.code)).toEqual([]);
  });
  it("switching off a site track keeps its language when the freed download slot brings in its capped twin", () => {
    // ko's MT holds the one translation slot, es's MT is kept on under it; auto-generated
    // tracks push es2 over the 8-track cap. Switching es1 off frees the slot for es2.
    const auto = (id: string, lang: string) => tr(id, lang, { kind: "auto" });
    const fill = ["fr", "it", "pt", "nl", "sv"].map((l) => tr(l + "1", l));
    let i = input({
      tracks: [tr("es1", "es"), tr("ko1", "ko"), ...fill, auto("fra", "fr"), auto("ita", "it"), tr("es2", "es")],
      spoken: "en", targets: ["es", "ko"], maxTargets: 1,
    });
    let st = initialSiteState(i.targets);
    for (const key of ["mt:es", "ex:ko1"]) [i, st] = apply(i, flip(i, st, key));
    st = { ...st, auto: true };
    expect(derive(i, st).run!.fetch).not.toContain("es2");
    [i, st] = apply(i, flip(i, st, "ex:es1"));
    expect(i.targets).toContain("es");
    const v = derive(i, st);
    expect(v.run!.fetch).toContain("es2");
    expect(v.run!.mtTargets).toEqual(["ko"]);
    expect(v.chips.find((c) => c.code === "es")!.parts.map((p) => [p.key, p.on])).toEqual([["mt:es", false], ["ex:es2", true]]);
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
  it("freeAdds trials each row as the chips' picker adds it, on a link with a long auto track list", () => {
    // freeAdds ran setTargets per row, and toggleTarget built a whole model to switch a language
    // on: three model passes per row, which a link with ~160 auto tracks at the translation
    // limit paid on every render. Each shortcut gives what the long way gives.
    const codes = Array.from({ length: 200 }, (_, n) => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26)))
      .filter((c) => !["de", "en", "es", "fr"].includes(c));
    const tracks = [...codes.slice(0, 160).map((l) => tr("a-" + l, l, { kind: "auto" })), ...codes.slice(150, 170).map((l) => tr("m-" + l, l))];
    const inp = input({ tracks, spoken: "en", targets: ["de", "fr", "es"], maxTargets: 3 });
    const s0 = { ...initialSiteState(inp.targets), auto: true };
    for (const policy of ["both", "custom"] as const) {
      const [i, st] = apply(inp, pickPolicy(inp, s0, policy));
      const view = derive(i, st);
      const chips = view.chips.map((c) => c.code);
      expect(mtUsed(view), policy).toBe(3);
      const rows = view.rows.filter((r) => r.code && !chips.includes(r.code) && r.badges.some((b) => b.kind === "existing" || b.kind === "auto"));
      expect(rows.length, policy).toBeGreaterThan(150);
      if (policy === "both") {
        // The whole trial as the picker runs it: setTargets, then derive (whose limit pass only
        // retitles). Under Prefer or Custom each such derive probes every idle row: too slow here.
        const want = rows.map((r) => r.code!).filter((c) => {
          const ch = setTargets(i, st, [...chips, c]);
          const v = derive({ ...i, targets: ch.targets }, ch.state);
          return v.chips.find((x) => x.code === c)?.parts.some((p) => p.on && p.kind !== "mt") && mtUsed(v) <= mtUsed(view);
        });
        expect(want).toHaveLength(rows.length);
        expect(freeAdds(i, st, view)).toEqual(want);
      } else {
        // Under Custom no row's language is a target yet, so the plain toggle, which builds the
        // model, switches each on too: switching on without it gives the same change.
        for (const r of rows) expect(toggleTarget(i, st, r.code!, true), r.code!).toEqual(toggleTarget(i, st, r.code!));
      }
    }
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
  it("setTargets: the link's spoken language is never saved as a hidden target", () => {
    const inp = input({ tracks: [tr("en", "en")], spoken: "de", targets: ["fr"], maxTargets: 3 });
    const st = initialSiteState(inp.targets);
    const ch = setTargets(inp, st, ["fr", "en", "de"]);
    expect(ch.targets).not.toContain("de");
    expect(ch.state.added).not.toContain("de");
    const v = derive({ ...inp, targets: ch.targets }, ch.state);
    expect(ch.targets.every((c) => v.chips.some((x) => x.code === c))).toBe(true);
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
