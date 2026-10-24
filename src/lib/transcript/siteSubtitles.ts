// The link card's "Download existing subtitles" model: which of a link's own subtitle tracks a
// run uses, which languages it transcribes or machine-translates, and how the Subtitles table
// and the compound translation chips show it. Pure, so every rule is tested without a DOM.
//
// Words: a language is WANTED when it is a translation target, or — under a preset — a
// language the site brings that you did not switch off. A wanted language gets its SOURCES from
// the preset: Prefer = existing subtitles, else machine translation; Side by side = both;
// Generate = machine translation only (nothing existing is used). Every badge shows one of
// three states: active (used), idle (chosen but not needed — greyed), off (not chosen — struck).
// Any badge click flips used ↔ not used and snapshots everything into Custom.

import type { UrlLanguageCheck } from "../api";
import { MULTI_LANGUAGE, languageLabel, namedLanguage, primarySubtag, spokenLabel } from "../languages";
import { hasOwn, ownProp } from "../own";
import { safeDisplayText } from "../sanitize";
import type { ImportedText } from "./subtitleImport";
import type { BatchResult, TimedTrack } from "../types";
import type { SiteTrackInfo } from "../urlSource";

export type SitePolicy = "prefer" | "both" | "generate" | "custom";

export const SITE_POLICIES: { value: SitePolicy; label: string; title: string }[] = [
  { value: "prefer", label: "Prefer them", title: "Existing subtitles replace transcription and machine translation for their language" },
  { value: "both", label: "Side by side", title: "Transcribe and translate as usual, and add the existing subtitles next to them" },
  { value: "generate", label: "Generate", title: "Everything is transcribed and machine-translated; existing subtitles are not used" },
  { value: "custom", label: "Custom", title: "Your own picks — click any badge to switch it on or off" },
];

/** What the link card knows besides the panel's own state. */
export interface SiteSubsInput {
  /** The preview's subtitle tracks (all of them, auto-generated included). */
  tracks: readonly SiteTrackInfo[];
  /** The spoken language as the run will use it (picked, detected or named by the site);
   *  null = unknown. With "Multiple languages" this is the main language. */
  spoken: string | null;
  /** "Multiple languages" is picked. */
  multi: boolean;
  /** The Processing card's translation targets — the languages explicitly wanted. */
  targets: readonly string[];
  /** The site's display name ("YouTube", siteDisplayName) for the source words; absent = "Site". */
  site?: string;
  /** How many languages one run may machine-translate into (maxTranslationTargets); absent = no cap. */
  maxTargets?: number;
}

/** The panel's own state for one link. */
export interface SiteSubsState {
  /** "Download existing subtitles". */
  subs: boolean;
  /** "Include auto-generated subtitles". */
  auto: boolean;
  policy: SitePolicy;
  /** Custom: every badge's pick by key; null under a preset. */
  sel: Record<string, boolean> | null;
  /** Languages explicitly not wanted (a site language you switched off). */
  off: string[];
  /** Languages added through "Add language", newest last. */
  added: string[];
  /** Languages whose row was deleted (only those the site has no subtitles for). */
  removed: string[];
  /** The translation targets when the link appeared — the first rows, in that order, so a
   *  row never moves or vanishes while you work. */
  initial: string[];
  /** The languages entering Custom wrote into the targets only because the preset wanted them
   *  (the site brings them) — not ones you picked. A preset takes them back out: kept as targets
   *  they would outrank the site's other languages at the translation limit, and one past it
   *  would stay a chip with no source instead of dropping out. Picking one yourself (toggleTarget) keeps it. */
  promoted: string[];
}

export function initialSiteState(targets: readonly string[]): SiteSubsState {
  return {
    subs: true, auto: false, policy: "prefer", sel: null, off: [], added: [], removed: [], initial: [...targets], promoted: [],
  };
}

export type BadgeState = "active" | "idle" | "off";

export interface SiteBadge {
  /** Click key ("gen", "mt:<lang>", "ex:<track>", "cand:<track>"); absent = fixed. */
  key?: string;
  kind: "transcribe" | "existing" | "auto" | "mt";
  text: string;
  state: BadgeState;
  title: string;
  hoh?: boolean;
  /** Dotted: a guess until the spoken language is known. */
  tentative?: boolean;
}

export interface SiteRow {
  /** null = the "Original language" row. */
  code: string | null;
  label: string;
  sub: string;
  badges: SiteBadge[];
  /** Only languages the site has no subtitles for can be deleted. */
  deletable: boolean;
}

/** One part of a compound chip (translation targets: machine translation, then the site's;
 *  the export's tracks: every track of a language), coloured by its source. */
export interface ChipPart {
  kind: SiteBadge["kind"];
  hoh?: boolean;
  on: boolean;
  key: string;
  text: string;
  title: string;
}

/** What a run does with the link's subtitles — frozen into the link's metadata at Add link. */
export interface SiteSubsRun {
  /** Track ids to download (≤ 8). */
  fetch: string[];
  /** The fetched track that IS the transcript (no transcription); null = transcribe. */
  transcriptTrackId: string | null;
  /** Languages to machine-translate into. */
  mtTargets: string[];
  /** The preview's facts about the fetched tracks (name, hearing-impaired), for their labels. */
  tracks?: SiteTrackInfo[];
}

export interface SiteSubsView {
  rows: SiteRow[];
  /** The wanted languages in row order — the Processing card's chips. */
  chips: { code: string; parts: ChipPart[] }[];
  counter: { used: number; of: number; existing: number };
  /** null = the switch is off: the run ignores the site's subtitles. */
  run: SiteSubsRun | null;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
/** The site track an ex:/cand: badge key names, else null. */
const keyTrack = (key: string | undefined): string | null => (key ? /^(?:ex|cand):(.+)$/.exec(key)?.[1] ?? null : null);

/** The source words every place uses for a subtitle: our transcript, a machine translation,
 *  and the site's own — by the site's name. */
export const WHISPER_WORD = "Whisper";
export const MT_WORD = "Machine translation";

/** Where a source word goes: chips and badges ("YouTube auto"), a track title's brackets
 *  ("YouTube, auto-generated"), a file name ("YouTube-auto"). */
export type SourceWordStyle = "word" | "title" | "file";

const siteOf = (t: { site?: string }) => safeDisplayText(t.site ?? "", 40) || "Site";

/** A site track's source word: "YouTube", "YouTube auto" (auto-generated), "YouTube SDH"
 *  (hearing-impaired); as a title "YouTube, auto-generated" / "YouTube, SDH"; in a file name
 *  "YouTube-auto" (SDH is the file's own `.sdh` part there), path-safe. */
export function siteWord(
  t: { kind: "manual" | "auto"; hoh?: boolean; site?: string }, style: SourceWordStyle = "word",
): string {
  const site = siteOf(t);
  if (style === "file") {
    const safe = site.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "Site";
    return t.kind === "auto" ? `${safe}-auto` : safe;
  }
  if (style === "title") return t.kind === "auto" ? `${site}, auto-generated` : t.hoh ? `${site}, SDH` : site;
  return t.kind === "auto" ? `${site} auto` : t.hoh ? `${site} SDH` : site;
}

/** The targets as a map: true = wanted, false = explicitly not wanted. A site track's
 *  language is any short code (`constructor` included), so the map is read own-only: an
 *  inherited `Object.prototype` member is neither wanted nor off. */
function targetMap(input: SiteSubsInput, st: SiteSubsState): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const c of input.targets) m[c] = true;
  for (const c of st.off) if (!hasOwn(m, c)) m[c] = false;
  return m;
}

/** A state change that may also change the Processing card's targets. */
export interface SiteChange {
  state: SiteSubsState;
  targets: string[];
}

/** Write a target map back: wanted codes keep the targets' order (new ones appended). */
function fromMap(input: SiteSubsInput, state: SiteSubsState, tg: Record<string, boolean>): SiteChange {
  const on = Object.keys(tg).filter((c) => tg[c]);
  return {
    state: { ...state, off: Object.keys(tg).filter((c) => !tg[c]) },
    targets: [...input.targets.filter((c) => on.includes(c)), ...on.filter((c) => !input.targets.includes(c))],
  };
}

/** Everything one render needs, plus the click machinery (snapshot + key → language). */
function model(input: SiteSubsInput, st: SiteSubsState) {
  const tracks = input.tracks.map((t) => ({ ...t, code: primarySubtag(t.lang) }));
  type T = (typeof tracks)[number];
  const avail = tracks.filter((t) => t.kind === "manual" || st.auto);
  const use = (t: T) => st.subs && (t.kind === "manual" || st.auto);
  const sp = input.spoken;
  const multi = input.multi;
  const custom = st.policy === "custom";
  const site = input.site;
  const tmap = targetMap(input, st);
  const shown = new Set<string>();
  const siteCodes = uniq(avail.map((t) => t.code)).filter((c) => c !== sp);
  const targets = uniq([...Object.keys(tmap), ...siteCodes]).filter(
    (c) => c !== sp && (tmap[c] === true || (!custom && siteCodes.includes(c) && ownProp(tmap, c) !== false)),
  );
  // Display order: the starting languages, then what the site brings, then what you added —
  // newest last; a target added elsewhere (the chips' own picker) joins at the bottom.
  const order = uniq([...st.initial, ...siteCodes, ...st.added, ...input.targets]);
  const snap: Record<string, boolean> = {};
  const codeOf: Record<string, string> = {};
  const decide = (key: string | undefined, preset: BadgeState): BadgeState => {
    if (!custom || !key) return preset;
    if (st.sel && key in st.sel) return st.sel[key] ? "active" : "off";
    // A candidate the snapshot never saw (the spoken language was known then) stays off when its
    // twin on the language's row was picked off: lit, it would download the track that row left out.
    if (st.sel && key.startsWith("cand:") && st.sel["ex:" + key.slice(5)] === false) return "off";
    return preset === "active" ? "active" : "off";
  };
  const mk = (b: Omit<SiteBadge, "state">, state0: BadgeState): SiteBadge => {
    const state = decide(b.key, state0);
    if (b.key) snap[b.key] = state === "active";
    const tid = keyTrack(b.key);
    if (tid && state === "active") shown.add(tid);
    const title = custom && b.key ? (state === "active" ? "Click to switch it off" : "Click to switch it on") : b.title;
    return { ...b, state, title };
  };
  // A machine-translation badge switched after mk(): its state, snapshot and title move together.
  const setMt = (b: SiteBadge, code: string, on: boolean) => {
    b.state = on ? "active" : "off";
    snap["mt:" + code] = on;
    b.title = custom
      ? on ? "Click to switch it off" : "Click to switch it on"
      : on ? `Click to stop translating into ${languageLabel(code)}` : `Click to translate into ${languageLabel(code)}`;
  };
  const exState = (t: T, wanted: boolean): BadgeState => (!use(t) ? "off" : wanted ? "active" : "idle");
  const exBadge = (t: T, state: BadgeState, tentative: boolean, prefix = ""): SiteBadge => {
    const why = state === "off"
      ? "Not included — click to include (switches to Custom)"
      : state === "idle"
        ? "Not needed with this setting — click to include it anyway (switches to Custom)"
        : "Click to leave it out (switches to Custom)";
    const name = t.name ? `${t.name} · ` : "";
    return mk({
      key: (prefix ? "cand:" : "ex:") + t.id,
      kind: t.kind === "auto" ? "auto" : "existing",
      text: prefix + siteWord({ ...t, site }),
      title: name + why,
      hoh: t.hoh,
      tentative,
    }, state);
  };
  const sourcesCache = new Map<string, { badges: SiteBadge[]; isTarget: boolean }>();
  const langSources = (code: string) => {
    const hit = sourcesCache.get(code);
    if (hit) return hit;
    const ts = avail.filter((t) => t.code === code);
    const isTarget = targets.includes(code);
    const name = languageLabel(code);
    const exWanted = isTarget && st.policy !== "generate";
    const exBadges = ts.map((t) => exBadge(t, isTarget ? exState(t, exWanted) : "off", !sp));
    exBadges.forEach((b) => { codeOf[b.key!] = code; });
    codeOf["mt:" + code] = code;
    const used = exBadges.some((b) => b.state === "active");
    const mtState: BadgeState = !isTarget ? "off" : st.policy === "prefer" && used ? "idle" : "active";
    const mtTitle = !isTarget
      ? `Click to translate into ${name}`
      : mtState === "idle"
        ? `Not needed: existing subtitles cover ${name} — click to machine-translate anyway`
        : `Click to stop translating into ${name}`;
    const mtB = mk({ key: "mt:" + code, kind: "mt", text: MT_WORD, title: mtTitle }, mtState);
    if (custom && !isTarget && mtB.state === "active") setMt(mtB, code, false);
    // A wanted language never ends up without a source: machine translation fills in.
    if (isTarget && mtB.state !== "active" && !used) setMt(mtB, code, true);
    const out = { badges: [mtB, ...exBadges], isTarget };
    sourcesCache.set(code, out);
    return out;
  };

  // Original language — known or not, it always has a row.
  const origTracks = sp ? avail.filter((t) => t.code === sp) : [];
  const anyOrigUsed = origTracks.some(use);
  const genText = multi ? `${WHISPER_WORD} · each part in its language` : WHISPER_WORD;
  const origBadges: SiteBadge[] = [];
  let genOn = true;
  let transcriptTrackId: string | null = null;
  if (sp) {
    const genIdle = st.policy === "prefer" && anyOrigUsed;
    const exO = origTracks.map((t) => exBadge(t, exState(t, st.policy !== "generate"), false));
    const anyEx = exO.some((b) => b.state === "active");
    // Something must be the transcript: without an existing one, transcription is fixed on.
    const genB = anyEx
      ? mk({ key: "gen", kind: "transcribe", text: genText, title: genIdle ? "Not needed: an existing subtitle is the transcript" : "Whisper transcribes the audio" }, genIdle ? "idle" : "active")
      : mk({ kind: "transcribe", text: genText, title: "Whisper transcribes the audio" }, "active");
    origBadges.push(genB, ...exO);
    genOn = genB.state === "active";
    if (!genOn) {
      // The transcript is a plain human track when there is one, else what is left.
      const rank = (t: T) => (t.kind === "auto" ? 2 : t.hoh ? 1 : 0);
      const on = origTracks.filter((_, i) => exO[i].state === "active").sort((a, b) => rank(a) - rank(b));
      transcriptTrackId = on[0]?.id ?? null;
    }
  } else {
    // Unknown spoken language: every plain human subtitle is a candidate. Nothing replaces the
    // transcript then — Prefer behaves like Side by side, the candidates ride along.
    // A candidate whose language you switched off is off, as its twin on that language's row:
    // lit, it would keep downloading the track while its own row showed it struck.
    const cands = avail.filter((t) => t.kind === "manual" && use(t) && !t.hoh);
    const candState = (t: T): BadgeState =>
      ownProp(tmap, t.code) === false ? "off" : st.policy === "generate" ? "idle" : "active";
    origBadges.push(
      mk({ kind: "transcribe", text: genText, title: "Whisper transcribes the audio" }, "active"),
      ...(st.subs ? cands.map((t) => exBadge(t, candState(t), true, `if ${languageLabel(t.code)}: `)) : []),
    );
  }
  const rows: SiteRow[] = [{
    code: null,
    label: "Original language",
    sub: multi ? `${spokenLabel(MULTI_LANGUAGE)} · main: ${sp ? languageLabel(sp) : "unknown"}` : sp ? languageLabel(sp) : "Unknown",
    badges: origBadges,
    deletable: false,
  }];
  // Every other language: rows never vanish, badges grey out; a switched-off language keeps its
  // row, only a language the site doesn't have can be deleted. A deleted language that is
  // a translation target again (re-added through the chips' picker while the panel was off) is
  // back: hidden, it would still be machine-translated with no row or chip to stop it.
  const codes = order.filter((c) => c !== sp && (!st.removed.includes(c) || tmap[c] === true));
  for (const code of codes) {
    const src = langSources(code);
    rows.push({
      code,
      label: languageLabel(code),
      // A language the run still downloads a track for is no "off": without machine translation
      // the panel's targets stay empty, so a Custom row would read "off" beside a lit site badge.
      sub: !src.isTarget
        ? src.badges.some((b) => b.kind !== "mt" && b.state === "active") ? "from the site" : "off"
        : tmap[code] === true ? "translation target" : "from the site",
      badges: src.badges,
      deletable: !siteCodes.includes(code),
    });
  }
  // Build badges for wanted languages without a row too, so `shown` is complete before the cap.
  for (const c of targets) langSources(c);
  // A run downloads at most 8 tracks — the transcript's own track always (cut off, the run would
  // transcribe after all), then the original language's and those of the languages you translate
  // into, then what the site brings besides, each in the site's order: by site order alone, a
  // site with many languages would fill the cap with unasked ones and machine-translate yours.
  const ids = avail.filter((t) => shown.has(t.id)).map((t) => t.id);
  const asked = new Set(avail.filter((t) => t.code === sp || tmap[t.code] === true).map((t) => t.id));
  const kept = new Set(uniq([
    ...ids.filter((id) => id === transcriptTrackId), ...ids.filter((id) => asked.has(id)), ...ids,
  ]).slice(0, 8));
  const fetch = ids.filter((id) => kept.has(id));
  // A lit badge over the cap would claim a track the run never downloads: it greys out. A
  // language you translate into that it leaves without a source gets machine translation (as in
  // langSources); a language wanted only because the site brings it drops out of the wanted
  // set instead — Prefer means existing subtitles, not machine translation nobody asked for.
  // Rows share these badge objects; the chips, the counter and mtTargets are built after this.
  const capped = new Set(ids.filter((id) => !kept.has(id)));
  for (const id of capped) shown.delete(id);
  const overCap = (b: SiteBadge) => {
    const tid = keyTrack(b.key);
    return b.state === "active" && !!tid && !kept.has(tid);
  };
  // What the caps overwrote in `snap` (this one and the translation limit's below): under
  // Custom a click restores it (flipWith), so a cap's grey and its machine-translation fill-in
  // stay what they are on screen — temporary — instead of becoming the pick, and freeing a slot
  // (or a higher limit) brings the cut pick back.
  const preCap: Record<string, boolean> = {};
  const capOff = (b: SiteBadge, fills: boolean) => {
    b.state = "idle";
    b.title = `Over the 8-subtitle download limit — ${fills ? "machine translation fills in" : "not downloaded"}`;
    preCap[b.key!] = snap[b.key!];
    snap[b.key!] = false;
  };
  const cutOut = new Set<string>();
  for (const b of origBadges) if (overCap(b)) capOff(b, false);
  for (const [code, src] of sourcesCache) {
    const [mtB, ...exBs] = src.badges;
    const cut = exBs.filter(overCap);
    if (!cut.length) continue;
    const left = exBs.some((b) => b.state === "active" && !cut.includes(b));
    const bare = src.isTarget && !left;
    // Side by side already translates a site language: that stays its source.
    const fills = bare && (tmap[code] === true || mtB.state === "active");
    for (const b of cut) capOff(b, fills);
    if (fills && mtB.state !== "active") {
      preCap[mtB.key!] = snap[mtB.key!];
      setMt(mtB, code, true);
    }
    else if (bare && !fills) {
      cutOut.add(code);
      setMt(mtB, code, false);
    }
    // A row that read "from the site" for tracks the cap now greys is cut out too: under
    // Custom without machine translation no row is a target, so it would keep claiming the site.
    else if (!src.isTarget && !left) cutOut.add(code);
  }
  for (const r of rows) if (r.code && cutOut.has(r.code)) r.sub = "over the download limit";
  // The server machine-translates into at most `maxTargets` languages per run and drops the rest,
  // but a preset lights machine translation for every language the site brings (Side by side,
  // Generate). Past the limit it greys out: the languages you translate into keep it first —
  // those with no other source ahead of those a site track already covers, whose translation is
  // only extra — then the site's in row order. A site language left without a source drops out,
  // as above.
  const mtCapped = new Set<string>();
  const maxMt = input.maxTargets;
  if (maxMt !== undefined) {
    const live = targets.filter((c) => !cutOut.has(c));
    const bare = (c: string) => !langSources(c).badges.slice(1).some((b) => b.state === "active");
    const explicit = input.targets.filter((c) => live.includes(c));
    const prio = uniq([
      ...explicit.filter(bare),
      ...explicit,
      ...codes.filter((c) => live.includes(c)),
      ...live,
    ]);
    let n = 0;
    for (const code of prio) {
      const [mtB, ...exBs] = langSources(code).badges;
      if (mtB.state !== "active") continue;
      if (++n <= maxMt) continue;
      mtB.state = "idle";
      mtB.title = `Over the ${maxMt}-language translation limit`;
      // The pick before any cap: the download cap's fill-in may have lit this badge first.
      if (!(mtB.key! in preCap)) preCap[mtB.key!] = snap[mtB.key!];
      snap[mtB.key!] = false;
      mtCapped.add(code);
      if (tmap[code] !== true && !exBs.some((b) => b.state === "active")) cutOut.add(code);
    }
    for (const r of rows) if (r.code && mtCapped.has(r.code) && cutOut.has(r.code)) r.sub = "over the translation limit";
  }
  const wanted = targets.filter((c) => !cutOut.has(c));
  const chips = codes.filter((c) => wanted.includes(c)).map((code) => {
    const name = languageLabel(code);
    const [mtB, ...exBs] = langSources(code).badges;
    // The part shows the track the run uses: two tracks fold into one language (en, en-GB), and
    // with the first left out the second still serves it.
    const exB = exBs.find((b) => b.state === "active" && !b.hoh) ?? exBs.find((b) => b.state === "active")
      ?? exBs.find((b) => !b.hoh) ?? exBs[0];
    const mtOn = mtB.state === "active";
    // Fixed order — machine translation, the site's — so nothing jumps; off parts only go faint (no "+", which resized the chip).
    const parts: ChipPart[] = [{
      kind: "mt", on: mtOn, key: mtB.key!,
      text: MT_WORD,
      // Over the translation limit its click does nothing (flip): say why.
      title: mtCapped.has(code)
        ? mtB.title
        : mtOn ? `Stop machine-translating into ${name}` : `Machine-translate into ${name} as well`,
    }];
    if (exB) {
      const exOn = exB.state === "active";
      const word = exB.text;
      parts.push({
        kind: exB.kind, hoh: exB.hoh, on: exOn, key: exB.key!,
        text: word,
        // A capped track's click does nothing (flip): say why rather than offer to add it.
        title: capped.has(keyTrack(exB.key) ?? "")
          ? exB.title
          : exOn ? `Leave out the ${word} ${name} subtitles` : `Add the ${word} ${name} subtitles`,
      });
    }
    return { code, parts };
  });
  const mtTargets = wanted.filter((c) => langSources(c).badges[0].state === "active");
  const runOn = st.subs && input.tracks.length > 0;
  return {
    view: {
      rows,
      chips,
      // What the run actually downloads, not every track the badges light.
      counter: { used: runOn ? fetch.length : shown.size, of: avail.length, existing: tracks.filter((t) => t.kind === "manual").length },
      run: runOn ? { fetch, transcriptTrackId, mtTargets } : null,
    } satisfies SiteSubsView,
    snap,
    codeOf,
    // Without the languages the caps dropped: entering Custom must not write them into the targets.
    targets: wanted,
    tmap,
    codes,
    capped,
    preCap,
    mtCapped,
  };
}

export function derive(input: SiteSubsInput, st: SiteSubsState): SiteSubsView {
  const m = model(input, st);
  // At a full translation limit flip refuses to switch machine translation on where it would
  // be greyed or strand another language (strands) — a dead click: its badge and chip part say
  // why instead of offering it. flip returns the very same state only when it refuses; it
  // calls model, not derive. Below the limit nothing is refused, so only a full limit is probed —
  // through flipWith on this very model, so a probe costs one trial model, not two (a link with
  // ~100 auto tracks snapshotted into Custom probes ~90 rows on every render).
  const maxMt = input.maxTargets;
  if (maxMt !== undefined && mtUsed(m.view) >= maxMt) {
    const title = `At the ${maxMt}-language translation limit — switch another translation off first`;
    for (const r of m.view.rows) {
      const mtB = r.badges[0];
      if (!r.code || mtB?.kind !== "mt" || mtB.state === "active" || m.mtCapped.has(r.code)) continue;
      if (flipWith(input, st, m, "mt:" + r.code).state !== st) continue;
      mtB.title = title;
      const part = m.view.chips.find((c) => c.code === r.code)?.parts[0];
      if (part?.kind === "mt") part.title = title;
    }
  }
  // The same at a full download: flip refuses switching on a site track the run doesn't
  // already fetch (through its twin) — the same O(1) test, not a flip (two model passes) per
  // badge, which a link listing ~100 auto tracks would pay on every render.
  const run = m.view.run;
  if (run && run.fetch.length >= 8) {
    const title = "At the 8-subtitle download limit — switch another subtitle off first";
    for (const r of m.view.rows) {
      for (const b of r.badges) {
        const mm = b.key ? /^(ex|cand):(.+)$/.exec(b.key) : null;
        if (!mm || b.state === "active" || m.capped.has(mm[2])) continue;
        if (run.fetch.includes(mm[2])) continue;
        b.title = title;
        for (const c of m.view.chips) for (const part of c.parts) if (part.key === b.key) part.title = title;
      }
    }
  }
  return m.view;
}

/** The machine translations the chips light — what counts against the translation limit. */
export function mtUsed(v: SiteSubsView): number {
  return v.chips.filter((c) => c.parts[0]?.kind === "mt" && c.parts[0].on).length;
}

/** Every wanted language written into the targets — what entering Custom does. */
function allTargets(m: ReturnType<typeof model>): Record<string, boolean> {
  const tg = { ...m.tmap };
  for (const c of m.targets) tg[c] = true;
  return tg;
}

/** A change that enters Custom from a preset, with the languages it promoted remembered: those
 *  the preset wanted that were no target — not one a click itself made wanted again. */
function promote(input: SiteSubsInput, m: ReturnType<typeof model>, ch: SiteChange): SiteChange {
  const promoted = m.targets.filter((c) => !input.targets.includes(c) && ch.targets.includes(c));
  return { ...ch, state: { ...ch.state, promoted } };
}

/** Would this click strand a language under the translation limit? Asks the limit with the
 *  change in place: `c`'s machine translation greyed, or another language newly greyed while it
 *  stays wanted with no source at all (every badge off — a dead MT click). A language the limit
 *  greys that keeps a site track is fine: its translation was only extra. */
function strands(
  input: SiteSubsInput, st: SiteSubsState, m: ReturnType<typeof model>,
  next: Record<string, boolean>, tg: Record<string, boolean>, c: string,
): boolean {
  if (input.maxTargets === undefined) return false;
  const trial = fromMap(input, { ...st, policy: "custom", sel: next }, tg);
  const a = model({ ...input, targets: trial.targets }, trial.state);
  if (a.mtCapped.has(c)) return true;
  return [...a.mtCapped].some((x) =>
    !m.mtCapped.has(x)
    && a.view.chips.some((ch) => ch.code === x)
    && !a.view.rows.find((r) => r.code === x)?.badges.some((b) => b.state === "active"));
}

/** A badge click: flip used ↔ not used, snapshot into Custom. A language you
 *  translate into always keeps a source: switching off its last one lets machine translation
 *  take over (an existing subtitle went, unless the translation limit greys it) or drops the
 *  language (machine translation went, or cannot take over). */
export function flip(input: SiteSubsInput, st: SiteSubsState, key: string): SiteChange {
  return flipWith(input, st, model(input, st), key);
}

/** A translation chip's part click. The chip's site part stands for the language, not one
 *  track: two tracks fold into one language (en, en-GB) and both serve it under Prefer, so
 *  leaving it out switches off every one the run uses — flipping only the shown one would
 *  bring up the other and the click looks dead. The panel's own badges stay one track each. */
export function flipChipPart(input: SiteSubsInput, st: SiteSubsState, key: string): SiteChange {
  const m = model(input, st);
  const code = m.codeOf[key];
  const on = key.startsWith("ex:") && code
    ? (m.view.rows.find((r) => r.code === code)?.badges ?? [])
        .filter((b) => b.key?.startsWith("ex:") && b.state === "active")
        .map((b) => b.key!)
    : [];
  if (!on.includes(key)) return flipWith(input, st, m, key);
  // One at a time, each on the state the last wrote: the last one off is where machine
  // translation takes over (or the language drops), exactly as for a single track.
  let ch: SiteChange = { state: st, targets: [...input.targets] };
  for (const k of on) ch = flip({ ...input, targets: ch.targets }, ch.state, k);
  return ch;
}

/** flip on an already-built `model(input, st)`. Only READS `m` (snap, preCap, codeOf, capped,
 *  mtCapped, tmap, targets, view.run) — derive's limit pass, which only retitles badges and chip
 *  parts, hands it its own model. */
function flipWith(input: SiteSubsInput, st: SiteSubsState, m: ReturnType<typeof model>, key: string): SiteChange {
  // A greyed over-cap badge (the download or the translation limit): switching it on would be
  // greyed again by the same cap, so the click would only flip a preset to Custom with nothing
  // visible changed. Free a slot first.
  const mm = /^(ex|cand):(.+)$/.exec(key);
  if ((mm && m.capped.has(mm[2])) || (key.startsWith("mt:") && m.mtCapped.has(key.slice(3)))) {
    return { state: st, targets: [...input.targets] };
  }
  // Already Custom: the pick under the 8-track cap or the translation limit is the one before
  // it (preCap) — a click elsewhere, such as switching a track off to free a slot, must not save
  // a cap's grey and fill-in. Entering Custom from a preset (pickPolicy) snapshots what is on screen instead.
  const base = st.policy === "custom" ? { ...m.snap, ...m.preCap } : m.snap;
  const next = { ...base, [key]: !m.snap[key] };
  // One site track can show twice — as the original row's candidate (cand:) and on its own
  // language's row (ex:) — and either lit badge downloads it: both flip together, or a
  // click shows it struck while the run still fetches it. The candidate has no language
  // of its own, so it takes its twin's — but only for the switch-off fallbacks below: a
  // candidate rides along on the Original row, and switching it back on must not make its
  // language a translation target the user removed (off → on stays a round trip).
  const sib = mm ? (mm[1] === "ex" ? "cand:" : "ex:") + mm[2] : null;
  if (sib && sib in m.snap) next[sib] = next[key];
  const tg = allTargets(m);
  const own = m.codeOf[key];
  const c = own ?? (sib ? m.codeOf[sib] : undefined);
  if (own && next[key]) tg[own] = true; // switching any source on makes the language wanted
  // A site track switched on while the download is full would land past the 8-track cap and
  // grey again — and the language it made wanted would get machine translation instead of the
  // subtitle asked for. At a full download any track not already fetched (a twin already
  // fetched stays allowed) caps one: itself or a fetched track the cap ranks below it,
  // whose language silently falls back to machine translation. Refuse it; free a slot first.
  const run = m.view.run;
  if (mm && next[key] && run && run.fetch.length >= 8 && !run.fetch.includes(mm[2])) {
    return { state: st, targets: [...input.targets] };
  }
  // Below a full download, ask the cap with the change (and the twin) in place.
  if (mm && next[key]) {
    const trial = fromMap(input, { ...st, policy: "custom", sel: next }, tg);
    if (model({ ...input, targets: trial.targets }, trial.state).capped.has(mm[2])) {
      return { state: st, targets: [...input.targets] };
    }
  }
  // Machine translation switched on past a full translation limit would be greyed by it (or
  // grey another language's only source): the click would only flip to Custom and leave the
  // language wanted with nothing translating it. Free a slot first, as above.
  if (own && next[key] && key.startsWith("mt:") && strands(input, st, m, next, tg, own)) {
    return { state: st, targets: [...input.targets] };
  }
  if (c && ownProp(tg, c) && !next[key]) {
    // A capped track, or machine translation over the limit, kept on in the pick is no source
    // this run: its cap greys it again.
    const leftIn = (x: ReturnType<typeof model>, mt = true) => Object.keys(x.codeOf).some((k) => x.codeOf[k] === c
      && next[k] && (mt || !k.startsWith("mt:"))
      && !x.capped.has(keyTrack(k) ?? "") && !(k.startsWith("mt:") && x.mtCapped.has(k.slice(3))));
    // Unless the switch-off frees the slot that cap held (Custom restores its pick, preCap):
    // ask the caps with the change in place before machine translation takes over. A site
    // track the freed download slot brings in serves the language outright (its own MT may
    // stay greyed); a slot the translation limit hands back by taking it from another
    // language's only source is not freed (strands).
    let left = leftIn(m);
    if (!left) {
      const trial = fromMap(input, { ...st, policy: "custom", sel: next }, tg);
      const a = model({ ...input, targets: trial.targets }, trial.state);
      left = leftIn(a, false) || (leftIn(a) && !strands(input, st, m, next, tg, c));
    }
    if (!left) {
      if (key.startsWith("mt:")) tg[c] = false;
      else {
        next["mt:" + c] = true;
        // Machine translation takes over only if the translation limit leaves it a slot — an
        // MT badge that was idle (Prefer) or off never counted, so ask the limit with the
        // takeover in place. Greyed — or greying another language's only source — a language
        // would stay wanted with no source at all (both chip parts off, a dead MT click): drop
        // it, as switching MT off does.
        if (strands(input, st, m, next, tg, c)) {
          tg[c] = false;
          next["mt:" + c] = false;
        }
      }
    }
  }
  // A dropped language a click makes wanted again is picked yourself, as through toggleTarget:
  // no longer one Custom only promoted — a preset keeps it.
  const promoted = own && next[key] && !m.targets.includes(own) ? st.promoted.filter((x) => x !== own) : st.promoted;
  const ch = fromMap(input, { ...st, policy: "custom", sel: next, promoted }, tg);
  return st.policy === "custom" ? ch : promote(input, m, ch);
}

/** A preset resets every pick — and takes out the targets entering Custom only promoted, so it
 *  ranks those like any other site language; Custom starts from a snapshot of what is on screen. */
export function pickPolicy(input: SiteSubsInput, st: SiteSubsState, policy: SitePolicy): SiteChange {
  if (policy !== "custom") {
    return {
      state: { ...st, policy, sel: null, promoted: [] },
      targets: input.targets.filter((c) => !st.promoted.includes(c)),
    };
  }
  // Custom clicked again: a re-snapshot would bake the caps' grey and fill-in into the pick
  // (flipWith keeps them temporary through preCap) and drop picks of badges not shown now.
  if (st.policy === "custom") return { state: st, targets: [...input.targets] };
  const m = model(input, st);
  return promote(input, m, fromMap(input, { ...st, policy, sel: { ...m.snap } }, allTargets(m)));
}

/** The "Download existing subtitles" switch. Off, the panel hands the chips to the plain picker,
 *  whose targets are yours from then on: none stays one Custom only promoted, for a later preset
 *  to take out of the saved list. */
export function setSubs(input: SiteSubsInput, st: SiteSubsState, subs: boolean): SiteChange {
  return { state: { ...st, subs, ...(subs ? {} : { promoted: [] }) }, targets: [...input.targets] };
}

/** The Processing card wrote the targets itself (its Translation switch, Whisper's translate, the
 *  plain picker): every one is yours from then on, none one Custom only promoted — kept as such,
 *  a target the switch seeded again would be cut by a later preset, turning the switch off. */
export function writeTargets(st: SiteSubsState, targets: readonly string[]): SiteChange {
  return { state: st.promoted.length ? { ...st, promoted: [] } : st, targets: [...targets] };
}

/** The targets a new preview's panel starts from: without the ones the old panel's Custom only
 *  promoted — the panel starts over, and kept they would count as your own picks, so a later
 *  preset would no longer take them out (a refetch of the same link starts over too). */
export function resetSiteTargets(st: SiteSubsState | null, targets: readonly string[]): string[] {
  return st?.promoted.length ? targets.filter((c) => !st.promoted.includes(c)) : [...targets];
}

/** "Translate into" for one language: picking it means machine-translating into it. */
export function toggleTarget(input: SiteSubsInput, st: SiteSubsState, code: string, on?: boolean): SiteChange {
  // Switching on reads only the target map: the model (a whole render) is built only to tell
  // whether the language is on now or to find its site tracks to drop — Add language and
  // freeAdds' trial per row switch on.
  const m = on === true ? null : model(input, st);
  const want = m ? (on ?? !m.targets.includes(code)) : true;
  // Picked (or dropped) yourself: no longer a language Custom only promoted — a preset keeps it.
  let next = st.promoted.includes(code) ? { ...st, promoted: st.promoted.filter((x) => x !== code) } : st;
  if (st.sel) {
    const sel = { ...st.sel, ["mt:" + code]: want };
    // Dropping a language drops its site tracks too: under Custom a stale pick of one
    // would otherwise keep it downloading (the pick outranks the off language) — and so does
    // a track's candidate twin on the Original row, which has no language in codeOf. Also
    // when no candidate badge shows now: a pick taken while the spoken language was unknown
    // would light it again once it is unknown again.
    if (m && !want) {
      for (const k of Object.keys(m.codeOf)) {
        if (m.codeOf[k] !== code) continue;
        sel[k] = false;
        const tid = keyTrack(k);
        if (tid) sel["cand:" + tid] = false;
      }
    }
    next = { ...next, sel };
  }
  return fromMap(input, next, { ...(m ? m.tmap : targetMap(input, st)), [code]: want });
}

/** "Add language": a machine-translated language, its row at the bottom. */
export function addLanguage(input: SiteSubsInput, st: SiteSubsState, code: string): SiteChange {
  const next = { ...st, added: [...st.added.filter((x) => x !== code), code], removed: st.removed.filter((x) => x !== code) };
  return toggleTarget(input, next, code, true);
}

/** The trash button: the row goes (re-add through Add language) and the language is off. */
export function removeLanguage(input: SiteSubsInput, st: SiteSubsState, code: string): SiteChange {
  const m = model(input, st);
  return fromMap(
    input,
    { ...st, removed: [...st.removed, code], added: st.added.filter((x) => x !== code) },
    { ...m.tmap, [code]: false },
  );
}

/** The translation chips' own picker while the panel is in charge: chips no longer in
 *  `next` switch their language off, new codes are added as languages (rows at the bottom) —
 *  but never the link's spoken language, which is no row or chip: saved as a target, it would
 *  hide in translateTo and surface once the panel lets go of the chips. */
export function setTargets(input: SiteSubsInput, st: SiteSubsState, next: readonly string[]): SiteChange {
  const chips = model(input, st).view.chips.map((c) => c.code);
  let ch: SiteChange = { state: st, targets: [...input.targets] };
  const step = (c: SiteChange) => {
    ch = c;
    input = { ...input, targets: c.targets };
  };
  for (const code of chips) if (!next.includes(code)) step(toggleTarget(input, ch.state, code, false));
  for (const code of next) if (!chips.includes(code) && code !== input.spoken) step(addLanguage(input, ch.state, code));
  return ch;
}

/** The site languages the translation chips' picker may add although machine translation is
 *  at the server's limit: trialled as the picker adds it (setTargets), a language qualifies
 *  only when it then keeps an active site source and no extra machine translation runs. Under
 *  Generate (site tracks idle) or past the download limit it would be a chip with nothing behind
 *  it. Costs one model pass per candidate, so ask only at the limit; `view` = derive(input, st)
 *  when the caller already has it. */
export function freeAdds(input: SiteSubsInput, st: SiteSubsState, view: SiteSubsView = derive(input, st)): string[] {
  const chips = view.chips.map((c) => c.code);
  const before = mtUsed(view);
  const out: string[] = [];
  for (const r of view.rows) {
    if (!r.code || chips.includes(r.code)) continue;
    if (!r.badges.some((b) => b.kind === "existing" || b.kind === "auto")) continue;
    // setTargets(input, st, [...chips, r.code]) as the picker calls it: with every chip kept and
    // r.code no spoken language (no row), that is this one addLanguage, minus setTargets' model pass.
    const ch = addLanguage(input, st, r.code);
    // The trial's titles do not matter: model, not derive, spares derive's limit pass.
    const v = model({ ...input, targets: ch.targets }, ch.state).view;
    const chip = v.chips.find((c) => c.code === r.code);
    if (chip?.parts.some((p) => p.on && p.kind !== "mt") && mtUsed(v) <= before) out.push(r.code);
  }
  return out;
}

/** What a link run freezes into its metadata at Add link: the view's run, its machine
 *  translation only where the server can translate (`mt`), and the preview's facts about
 *  the tracks it fetches. */
export function frozenSiteRun(run: SiteSubsRun, tracks: readonly SiteTrackInfo[], mt: boolean): SiteSubsRun {
  return { ...run, mtTargets: mt ? run.mtTargets : [], tracks: tracks.filter((t) => run.fetch.includes(t.id)) };
}

/** The languages already in the table — what "Add language" leaves out. */
export function listedLanguages(input: SiteSubsInput, st: SiteSubsState): string[] {
  const m = model(input, st);
  return input.spoken ? [input.spoken, ...m.codes] : m.codes;
}

/** One downloaded site track after parsing. */
export interface ParsedSiteTrack {
  id: string;
  lang: string;
  kind: "manual" | "auto";
  parsed: ImportedText;
}

/** Downloaded site tracks → timed tracks with their own timing. Ids are `<lang>-x-site` (a
 *  BCP-47 private use tag, never an MT code), `-auto` / `-hoh` / a number added only when two
 *  tracks of a language would collide. `site` = the site's display name (siteDisplayName). */
export function siteTimedTracks(
  fetched: readonly ParsedSiteTrack[],
  infos: readonly SiteTrackInfo[] = [],
  site = "",
): TimedTrack[] {
  const out: TimedTrack[] = [];
  for (const f of fetched) {
    const info = infos.find((t) => t.id === f.id);
    const hoh = info?.hoh ?? false;
    const base = `${f.lang}-x-site`;
    const taken = (id: string) => out.some((t) => t.id === id);
    let id = base;
    if (taken(id)) id = `${base}${f.kind === "auto" ? "-auto" : hoh ? "-hoh" : ""}`;
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    const cues = f.parsed.segments.flatMap((s) =>
      // A timed cue has no speaker field: the import moved a leading "Name:" (or a VTT <v> voice)
      // into `speaker`, so put it back into the text rather than drop it.
      s.start !== undefined && s.end !== undefined
        ? [{ start: s.start, end: s.end, text: s.speaker ? `${s.speaker}: ${s.text}` : s.text }]
        : [],
    );
    if (!cues.length) continue;
    out.push({
      id, lang: f.lang, source: "site", kind: f.kind, cues,
      ...(hoh ? { hoh } : {}),
      ...(info?.name ? { label: info.name } : {}),
      ...(site ? { site } : {}),
    });
  }
  return out;
}

/** Add site tracks (and the warnings their download produced) to a result. */
export function attachSiteTracks(res: BatchResult, timed: readonly TimedTrack[], warnings: readonly string[]): BatchResult {
  if (!timed.length && !warnings.length) return res;
  return {
    ...res,
    ...(timed.length ? { timedTracks: [...(res.timedTracks ?? []), ...timed] } : {}),
    ...(warnings.length ? { warnings: [...(res.warnings ?? []), ...warnings] } : {}),
  };
}

/** The language check of one link, as the row shows it. */
export interface LinkLanguageCheck {
  state: "idle" | "running" | "done" | "failed";
  result?: UrlLanguageCheck;
  error?: string;
}

export interface LinkSpoken {
  /** The picker's value: a code, "auto" or MULTI_LANGUAGE. */
  value: string;
  /** What the link speaks without your pick (detected > the site's > the screen's), or null. */
  base: string | null;
  /** The language the run uses (Multiple languages: the main one); null = unknown. */
  spoken: string | null;
  multi: boolean;
  source: "edited" | "detected" | "site" | "screen" | null;
}

/** Resolve a link's spoken language: your pick wins, then the check's vote (it listened), then
 *  the language the site names, then the screen's own pick. */
export function linkSpoken(args: {
  siteLanguage?: string | null;
  check: LinkLanguageCheck;
  /** The screen's spoken-picker value. */
  screen: string;
  edited: string | null;
}): LinkSpoken {
  const r = args.check.state === "done" ? args.check.result : undefined;
  const detected = r && r.verdict !== "unknown" && r.language ? r.language : null;
  const site = args.siteLanguage ? primarySubtag(args.siteLanguage) : null;
  const screen = namedLanguage(args.screen) ? args.screen : null;
  const base = detected ?? site ?? screen;
  const source = args.edited ? "edited" : detected ? "detected" : site ? "site" : screen ? "screen" : null;
  const value = args.edited ?? (args.screen === MULTI_LANGUAGE ? MULTI_LANGUAGE : base ?? "auto");
  const multi = value === MULTI_LANGUAGE;
  return { value, base, spoken: multi ? base : value === "auto" ? null : value, multi, source };
}

/** The pill beside the picker: "edited", "detected in 3 of 3 pieces", "detected · also English",
 *  "from YouTube", "unknown" — or nothing (while checking, or the screen's own language). */
export function spokenPill(
  sp: LinkSpoken,
  check: LinkLanguageCheck,
  /** The site's display name (siteDisplayName). */
  site?: string,
): { text: string; tone: "edited" | "mixed" | "plain"; title?: string } | null {
  if (sp.source === "edited") return { text: "edited", tone: "edited" };
  if (check.state === "running") return null;
  const r = check.result;
  if (sp.source === "detected" && r) {
    const also = r.also.filter((c) => c !== r.language);
    if (also.length) return { text: `detected · also ${also.map(languageLabel).join(", ")}`, tone: "mixed" };
    const n = r.pieces.filter((p) => p.language === r.language).length;
    return { text: r.pieces.length ? `detected in ${n} of ${r.pieces.length} pieces` : "detected", tone: "plain" };
  }
  if (sp.source === "site") return { text: `from ${safeDisplayText(site ?? "", 40) || "the site"}`, tone: "plain" };
  if (sp.source === "screen") return null;
  return { text: "unknown", tone: "plain", ...(check.error ? { title: check.error } : {}) };
}
