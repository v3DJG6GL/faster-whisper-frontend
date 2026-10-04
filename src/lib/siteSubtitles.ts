// The link card's "Download existing subtitles" model (D86): which of a link's own subtitle
// tracks a run uses, which languages it transcribes or machine-translates, and how the
// Subtitles table and the compound translation chips show it. A pure port of the approved
// mockup's state model (LinkSubs.dc.html `renderVals`), so every rule is tested without a DOM.
//
// Words: a language is WANTED when it is a translation target, or — under a preset — a
// language the site brings that you did not remove. A wanted language gets its SOURCES from
// the preset: Prefer = existing subtitles, else machine translation; Side by side = both;
// Generate = machine translation only (nothing existing is used, v31). Every badge shows one of
// three states: active (used), idle (chosen but not needed — greyed), off (not chosen — struck).
// Any badge click flips used ↔ not used and snapshots everything into Custom (v25, v27).

import { languageLabel } from "./languages";
import type { SiteTrackInfo } from "./urlSource";

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
   *  row never moves or vanishes while you work (v25). */
  initial: string[];
}

export function initialSiteState(targets: readonly string[]): SiteSubsState {
  return { subs: true, auto: false, policy: "prefer", sel: null, off: [], added: [], removed: [], initial: [...targets] };
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
  /** Only languages the site has no subtitles for can be deleted (v37). */
  deletable: boolean;
}

/** One part of a compound translation chip, in fixed order: machine translation, existing. */
export interface ChipPart {
  kind: "mt" | "existing";
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
}

export interface SiteSubsView {
  rows: SiteRow[];
  /** The wanted languages in row order — the Processing card's chips. */
  chips: { code: string; parts: ChipPart[] }[];
  counter: { used: number; of: number; existing: number };
  /** null = the switch is off: the run ignores the site's subtitles. */
  run: SiteSubsRun | null;
}

/** The language a track counts for: its primary subtag ("de-CH" → "de", "de-orig" → "de"). */
export function trackLanguage(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** The targets as the mockup's map: true = wanted, false = explicitly not wanted. */
function targetMap(input: SiteSubsInput, st: SiteSubsState): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const c of input.targets) m[c] = true;
  for (const c of st.off) if (!(c in m)) m[c] = false;
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
  const tracks = input.tracks.map((t) => ({ ...t, code: trackLanguage(t.lang) }));
  type T = (typeof tracks)[number];
  const avail = tracks.filter((t) => t.kind === "manual" || st.auto);
  const use = (t: T) => st.subs && (t.kind === "manual" || st.auto);
  const sp = input.spoken;
  const multi = input.multi;
  const custom = st.policy === "custom";
  const tmap = targetMap(input, st);
  const shown = new Set<string>();
  const siteCodes = uniq(avail.map((t) => t.code)).filter((c) => c !== sp);
  const targets = uniq([...Object.keys(tmap), ...siteCodes]).filter(
    (c) => c !== sp && (tmap[c] === true || (!custom && siteCodes.includes(c) && tmap[c] !== false)),
  );
  // Display order: the starting languages, then what the site brings, then what you added —
  // newest last; a target added elsewhere (the chips' own picker) joins at the bottom.
  const order = uniq([...st.initial, ...siteCodes, ...st.added, ...input.targets]);
  const snap: Record<string, boolean> = {};
  const codeOf: Record<string, string> = {};
  const decide = (key: string | undefined, preset: BadgeState): BadgeState => {
    if (!custom || !key) return preset;
    if (st.sel && key in st.sel) return st.sel[key] ? "active" : "off";
    return preset === "active" ? "active" : "off";
  };
  const mk = (b: Omit<SiteBadge, "state">, state0: BadgeState): SiteBadge => {
    const state = decide(b.key, state0);
    if (b.key) snap[b.key] = state === "active";
    if (b.key && state === "active" && /^(ex|cand):/.test(b.key)) shown.add(b.key.split(":")[1]);
    const title = custom && b.key ? (state === "active" ? "Click to switch it off" : "Click to switch it on") : b.title;
    return { ...b, state, title };
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
      text: prefix + (t.kind === "auto" ? "auto-generated" : "existing") + (t.hoh ? " · hearing-impaired" : ""),
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
    const mtB = mk({ key: "mt:" + code, kind: "mt", text: "machine translation", title: mtTitle }, mtState);
    if (custom && !isTarget && mtB.state === "active") { mtB.state = "off"; snap["mt:" + code] = false; }
    // A wanted language never ends up without a source: machine translation fills in (v28/v30).
    if (isTarget && mtB.state !== "active" && !used) { mtB.state = "active"; snap["mt:" + code] = true; }
    const out = { badges: [mtB, ...exBadges], isTarget };
    sourcesCache.set(code, out);
    return out;
  };

  // Original language — known or not, it always has a row.
  const origTracks = sp ? avail.filter((t) => t.code === sp) : [];
  const anyOrigUsed = origTracks.some(use);
  const genText = multi ? "transcribe · each part in its language" : "transcribe";
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
    // transcript then — Prefer behaves like Side by side (decision), the candidates ride along.
    const cands = avail.filter((t) => t.kind === "manual" && use(t) && !t.hoh);
    origBadges.push(
      mk({ kind: "transcribe", text: genText, title: "Whisper transcribes the audio" }, "active"),
      ...(st.subs
        ? cands.map((t) => exBadge(t, st.policy === "generate" ? "idle" : "active", true, `if ${languageLabel(t.code)}: `))
        : []),
    );
  }
  const rows: SiteRow[] = [{
    code: null,
    label: "Original language",
    sub: multi ? `Multiple languages · main: ${sp ? languageLabel(sp) : "unknown"}` : sp ? languageLabel(sp) : "Unknown",
    badges: origBadges,
    deletable: false,
  }];
  // Every other language: rows never vanish, badges grey out; a switched-off language keeps its
  // row, only a language the site doesn't have can be deleted (v37).
  const codes = order.filter((c) => c !== sp && !st.removed.includes(c));
  for (const code of codes) {
    const src = langSources(code);
    rows.push({
      code,
      label: languageLabel(code),
      sub: !src.isTarget ? "off" : tmap[code] === true ? "translation target" : "from the site",
      badges: src.badges,
      deletable: !siteCodes.includes(code),
    });
  }
  const chips = codes.filter((c) => targets.includes(c)).map((code) => {
    const name = languageLabel(code);
    const [mtB, ...exBs] = langSources(code).badges;
    const exB = exBs.find((b) => !b.hoh) ?? exBs[0];
    const mtOn = mtB.state === "active";
    // Fixed order — machine translation, existing — so nothing jumps; off parts read "+ …" (v30).
    const parts: ChipPart[] = [{
      kind: "mt", on: mtOn, key: mtB.key!,
      text: mtOn ? "machine translation" : "+ machine translation",
      title: mtOn ? `Stop machine-translating into ${name}` : `Machine-translate into ${name} as well`,
    }];
    if (exB) {
      const exOn = exB.state === "active";
      parts.push({
        kind: "existing", on: exOn, key: exB.key!,
        text: exOn ? "existing" : "+ existing",
        title: exOn ? `Leave out the site's ${name} subtitles` : `Add the site's ${name} subtitles`,
      });
    }
    return { code, parts };
  });
  const mtTargets = targets.filter((c) => langSources(c).badges[0].state === "active");
  return {
    view: {
      rows,
      chips,
      counter: { used: shown.size, of: avail.length, existing: tracks.filter((t) => t.kind === "manual").length },
      run: st.subs && input.tracks.length
        ? { fetch: avail.filter((t) => shown.has(t.id)).map((t) => t.id).slice(0, 8), transcriptTrackId, mtTargets }
        : null,
    } satisfies SiteSubsView,
    snap,
    codeOf,
    targets,
    tmap,
    codes,
  };
}

export function derive(input: SiteSubsInput, st: SiteSubsState): SiteSubsView {
  return model(input, st).view;
}

/** Every wanted language written into the targets — what entering Custom does (v32). */
function allTargets(m: ReturnType<typeof model>): Record<string, boolean> {
  const tg = { ...m.tmap };
  for (const c of m.targets) tg[c] = true;
  return tg;
}

/** A badge click: flip used ↔ not used, snapshot into Custom (v25/v27). A language you
 *  translate into always keeps a source: switching off its last one lets machine translation
 *  take over (an existing subtitle went) or drops the language (machine translation went, v28). */
export function flip(input: SiteSubsInput, st: SiteSubsState, key: string): SiteChange {
  const m = model(input, st);
  const next = { ...m.snap, [key]: !m.snap[key] };
  const tg = allTargets(m);
  const c = m.codeOf[key];
  if (c && next[key]) tg[c] = true; // switching any source on makes the language wanted
  if (c && tg[c] && !next[key]) {
    const left = Object.keys(m.codeOf).filter((k) => m.codeOf[k] === c && next[k]);
    if (!left.length) {
      if (key.startsWith("mt:")) tg[c] = false;
      else next["mt:" + c] = true;
    }
  }
  return fromMap(input, { ...st, policy: "custom", sel: next }, tg);
}

/** A preset resets every pick; Custom starts from a snapshot of what is on screen (v27). */
export function pickPolicy(input: SiteSubsInput, st: SiteSubsState, policy: SitePolicy): SiteChange {
  if (policy !== "custom") return { state: { ...st, policy, sel: null }, targets: [...input.targets] };
  const m = model(input, st);
  return fromMap(input, { ...st, policy, sel: { ...m.snap } }, allTargets(m));
}

/** "Translate into" for one language: picking it means machine-translating into it. */
export function toggleTarget(input: SiteSubsInput, st: SiteSubsState, code: string, on?: boolean): SiteChange {
  const m = model(input, st);
  const want = on ?? !m.targets.includes(code);
  return fromMap(
    input,
    st.sel ? { ...st, sel: { ...st.sel, ["mt:" + code]: want } } : st,
    { ...m.tmap, [code]: want },
  );
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

/** The languages already in the table — what "Add language" leaves out. */
export function listedLanguages(input: SiteSubsInput, st: SiteSubsState): string[] {
  const m = model(input, st);
  return input.spoken ? [input.spoken, ...m.codes] : m.codes;
}
