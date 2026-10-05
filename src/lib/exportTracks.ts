// The export's tracks (D88–D92): what each track is (its language and source), how it
// reads in chips, tabs and lane labels, and — from the track order — which track is a
// language's plain one, its title in a video and its file name. Pure; unit-tested.

import { trackLang } from "./cueSplit";
import { langCode, primarySubtag, trackLanguageName } from "./languages";
import { safeDisplayText, stripControlChars } from "./sanitize";
import { MT_WORD, WHISPER_WORD, siteWord, type SiteBadge } from "./siteSubtitles";
import type { BatchResult } from "./types";

type TrackResult = Pick<BatchResult, "language" | "timedTracks">;

/** Where a track's text comes from: our transcript, a machine translation, or the site's
 *  own subtitles (auto-generated or not). */
export type TrackSource = "whisper" | "mt" | "site" | "auto";

export interface TrackInfo {
  id: string;
  /** The code the track is filed under ("und" when unknown). */
  lang: string;
  source: TrackSource;
  /** A hearing-impaired (SDH) site track. */
  hoh: boolean;
  /** The site's display name (site tracks only). */
  site?: string;
}

export function trackInfo(result: TrackResult, track: string): TrackInfo {
  const lang = trackLang(result, track);
  const tt = result.timedTracks?.find((t) => t.id === track);
  if (tt) return { id: track, lang, source: tt.kind === "auto" ? "auto" : "site", hoh: !!tt.hoh, site: tt.site };
  return { id: track, lang, source: track === "orig" ? "whisper" : "mt", hoh: false };
}

/** The source word (D88): Whisper, Machine translation, YouTube, YouTube auto, YouTube SDH. */
export function sourceWord(t: TrackInfo): string {
  if (t.source === "whisper") return WHISPER_WORD;
  if (t.source === "mt") return MT_WORD;
  return siteWord({ kind: t.source === "auto" ? "auto" : "manual", hoh: t.hoh, site: t.site });
}

/** The badge kind a source is coloured as (sourceTone). */
export function sourceKind(t: TrackInfo): SiteBadge["kind"] {
  return t.source === "whisper" ? "transcribe" : t.source === "site" ? "existing" : t.source;
}

/** A track as chips, tabs and lanes read it: "DE · Whisper", "EN · Machine translation",
 *  "DE · YouTube auto". */
export function trackChipLabel(result: TrackResult, track: string): string {
  const t = trackInfo(result, track);
  return `${langCode(t.lang)} · ${sourceWord(t)}`;
}

/** A track's language code as chips, lane cues and the Summary show it: "DE", "UND". */
export function trackCode(result: TrackResult, track: string): string {
  return langCode(trackLang(result, track));
}

/** The machine-translated tracks a result carries: its targets, then any other language its
 *  segments hold. */
export function translationTracks(result: Pick<BatchResult, "translation" | "segments">): string[] {
  const seen = new Set(result.translation?.targets ?? []);
  for (const seg of result.segments ?? []) for (const k of Object.keys(seg.translations ?? {})) seen.add(k);
  return [...seen];
}

/** Every track of a transcript: the original, its machine translations, the site's own
 *  tracks — the viewer's and History's quick export's one list. */
export function transcriptTracks(result: Pick<BatchResult, "translation" | "segments" | "timedTracks">): string[] {
  return ["orig", ...translationTracks(result), ...(result.timedTracks ?? []).map((t) => t.id)];
}

// ── Track order (D92) ───────────────────────────────────────────────────────────────────────

/** Within a language: Whisper, the site's, the site's auto-generated, machine translation. */
const SOURCE_RANK: Record<TrackSource, number> = { whisper: 0, site: 1, auto: 2, mt: 3 };

/** The language a track counts for — its primary subtag ("de-CH" and "de" are one language). */
const langOf = (result: TrackResult, track: string) => primarySubtag(trackInfo(result, track).lang);

/** The order nothing was dragged into: the spoken language first, then the other languages in
 *  the order `tracks` brings them; within a language by source (SOURCE_RANK). */
export function defaultTrackOrder(result: TrackResult, tracks: readonly string[]): string[] {
  const spoken = primarySubtag(result.language ?? "");
  const langs = [...new Set(tracks.map((t) => langOf(result, t)))];
  const rank = (t: string) => {
    const l = langOf(result, t);
    return [l === spoken ? -1 : langs.indexOf(l), SOURCE_RANK[trackInfo(result, t).source]];
  };
  return [...tracks].sort((a, b) => {
    const [la, sa] = rank(a);
    const [lb, sb] = rank(b);
    return la - lb || sa - sb;
  });
}

/** The export's tracks in their order: a saved (dragged) order puts its languages and tracks
 *  first, in its order; tracks it does not name join their language — or, as a new language,
 *  the end — in the default order. Always grouped by language. */
export function trackOrder(result: TrackResult, tracks: readonly string[], saved?: readonly string[]): string[] {
  const d = defaultTrackOrder(result, tracks);
  const known = (saved ?? []).filter((t) => tracks.includes(t));
  if (!known.length) return d;
  const knownLangs = [...new Set(known.map((t) => langOf(result, t)))];
  const defLangs = [...new Set(d.map((t) => langOf(result, t)))];
  const langRank = (l: string) => (knownLangs.includes(l) ? knownLangs.indexOf(l) : knownLangs.length + defLangs.indexOf(l));
  const trackRank = (t: string) => (known.includes(t) ? known.indexOf(t) : known.length + d.indexOf(t));
  return [...d].sort((a, b) => langRank(langOf(result, a)) - langRank(langOf(result, b)) || trackRank(a) - trackRank(b));
}

export interface LanguageGroup {
  /** The primary subtag the tracks count for. */
  lang: string;
  tracks: string[];
}

/** An ordered track list as its languages, each with its tracks in order. */
export function languageGroups(result: TrackResult, order: readonly string[]): LanguageGroup[] {
  const out: LanguageGroup[] = [];
  for (const t of order) {
    const lang = langOf(result, t);
    const g = out.find((x) => x.lang === lang);
    if (g) g.tracks.push(t);
    else out.push({ lang, tracks: [t] });
  }
  return out;
}

/** `xs` with the item at `from` moved into `slot` — the gap before the item now at `slot`
 *  (`xs.length` = the end), the way a drop indicator shows it. */
export function moveItem<T>(xs: readonly T[], from: number, slot: number): T[] {
  const s = Math.max(0, Math.min(xs.length, slot));
  if (from < 0 || s === from || s === from + 1) return [...xs];
  const out = xs.filter((_, i) => i !== from);
  out.splice(s > from ? s - 1 : s, 0, xs[from]);
  return out;
}

/** The slot one step left (-1) or right (+1) of the item at `from` — Alt+←/→. */
export const stepSlot = (from: number, dir: -1 | 1) => (dir < 0 ? from - 1 : from + 2);

/** Move a whole language (all its tracks) into a slot among the languages. */
export function moveLanguage(result: TrackResult, order: readonly string[], lang: string, slot: number): string[] {
  const groups = languageGroups(result, order);
  return moveItem(groups, groups.findIndex((g) => g.lang === lang), slot).flatMap((g) => g.tracks);
}

/** Move a track into a slot among its own language's tracks. */
export function moveTrack(result: TrackResult, order: readonly string[], track: string, slot: number): string[] {
  return languageGroups(result, order).flatMap((g) =>
    g.tracks.includes(track) ? moveItem(g.tracks, g.tracks.indexOf(track), slot) : g.tracks);
}

/** `xs` with the items of `sub` back in the slots they held, in `sub`'s new order. */
const refill = <T,>(xs: readonly T[], sub: readonly T[]): T[] => {
  let k = 0;
  return xs.map((x) => (sub.includes(x) ? sub[k++] : x));
};

/** A reorder of some of the tracks (the chips of a view that hides some, Read's Segments)
 *  merged into the whole order: its languages and tracks take the slots they held, the
 *  hidden ones keep theirs. */
export function mergeOrder(result: TrackResult, order: readonly string[], sub: readonly string[]): string[] {
  const groups = languageGroups(result, order);
  const subGroups = languageGroups(result, sub);
  return refill(groups.map((g) => g.lang), subGroups.map((g) => g.lang)).flatMap((lang) => {
    const g = groups.find((x) => x.lang === lang)!;
    const s = subGroups.find((x) => x.lang === lang);
    return s ? refill(g.tracks, s.tracks) : g.tracks;
  });
}

// ── Picking tracks (D88) ────────────────────────────────────────────────────────────────────

/** A language's code segment: on (any track chosen) → all its tracks off; off → all but its
 *  auto-generated ones on (all of them when that is all it has). Null = nothing would be left. */
export function toggleLanguage(
  result: TrackResult, order: readonly string[], chosen: readonly string[], lang: string,
): string[] | null {
  const mine = order.filter((t) => langOf(result, t) === lang);
  const on = mine.some((t) => chosen.includes(t));
  const human = mine.filter((t) => trackInfo(result, t).source !== "auto");
  const add = on ? [] : human.length ? human : mine;
  const next = order.filter((t) => (chosen.includes(t) && !(on && mine.includes(t))) || add.includes(t));
  return next.length ? next : null;
}

/** What Read shows before anything is picked: the original, then the first track of each
 *  other language, in track order — at most `max`, so lanes stay readable. */
export function defaultViewTracks(result: TrackResult, order: readonly string[], max = 3): string[] {
  const firsts = languageGroups(result, order).map((g) => (g.tracks.includes("orig") ? "orig" : g.tracks[0]));
  const picks = [...firsts.filter((t) => t === "orig"), ...firsts.filter((t) => t !== "orig")].slice(0, max);
  return order.filter((t) => picks.includes(t));
}

/** One track's part: flip it. Null = nothing would be left. */
export function toggleTrack(order: readonly string[], chosen: readonly string[], track: string): string[] | null {
  const next = order.filter((t) => (t === track ? !chosen.includes(t) : chosen.includes(t)));
  return next.length ? next : null;
}

// ── Names, files and flags (D89) ────────────────────────────────────────────────────────────

export interface PlannedTrack extends TrackInfo {
  /** The first chosen track of its language: the plain name (`German`, `stem.de.srt`) and
   *  the player's Default flag. */
  plain: boolean;
  /** Written in the spoken language (Matroska FlagOriginal). */
  original: boolean;
  /** "German" alone; "German [Whisper]", "German [YouTube, auto-generated]" when the
   *  language has several tracks. */
  defaultTitle: string;
  /** The video track's title: the user's name, else the default. */
  title: string;
}

/** The longest track title the server keeps. */
export const TRACK_TITLE_MAX = 64;

/** A typed track name as a title: no control characters, bounded; "" = use the default. */
export function cleanTrackTitle(s: string | undefined): string {
  return stripControlChars(s ?? "").replace(/\s+/g, " ").trim().slice(0, TRACK_TITLE_MAX).trim();
}

/** The bracketed source of a title: Whisper, Machine translation, YouTube, "YouTube, SDH". */
function titleSource(t: TrackInfo): string {
  if (t.source === "whisper" || t.source === "mt") return sourceWord(t);
  const site = safeDisplayText(t.site ?? "", 40) || "Site";
  return t.source === "auto" ? `${site}, auto-generated` : t.hoh ? `${site}, SDH` : site;
}

/** The chosen tracks, in order, with their names and flags. `names` = the user's titles by
 *  track id. */
export function planTracks(
  result: TrackResult, chosen: readonly string[], names: Readonly<Record<string, string>> = {},
): PlannedTrack[] {
  const spoken = primarySubtag(result.language ?? "");
  const groups = languageGroups(result, chosen);
  return chosen.map((id) => {
    const info = trackInfo(result, id);
    const g = groups.find((x) => x.tracks.includes(id))!;
    const name = trackLanguageName(info.lang);
    const defaultTitle = g.tracks.length > 1 ? `${name} [${titleSource(info)}]` : name;
    return {
      ...info,
      plain: g.tracks[0] === id,
      original: !!spoken && g.lang === spoken,
      defaultTitle,
      title: cleanTrackTitle(names[id]) || defaultTitle,
    };
  });
}

/** Codes are user/server-authored, so keep them path-safe. */
const langSlug = (code: string) => code.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "und";

/** A non-plain track's file label — before the language code, where Jellyfin, Emby and Kodi
 *  read a title: Whisper, YouTube, YouTube-auto, Machine-translation. */
export function trackFileLabel(t: TrackInfo): string {
  if (t.source === "whisper") return WHISPER_WORD;
  if (t.source === "mt") return MT_WORD.replace(/ /g, "-");
  const site = (t.site ?? "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "Site";
  return t.source === "auto" ? `${site}-auto` : site;
}

/** Each track's file suffix (the name after the stem), D89: a language's plain track
 *  `.de.srt` (`origBare`: the original's plain track `.srt`, the text export's own name), the
 *  others `.YouTube.de.srt`; a hearing-impaired track adds `.sdh` after the language (anything
 *  else there breaks mpv). Never two alike, nor one in `taken`: a clash falls back to the
 *  labelled form, then to a numbered label. */
export function trackFileSuffixes(
  tracks: readonly PlannedTrack[], ext: string, opts: { origBare?: boolean; taken?: readonly string[] } = {},
): string[] {
  const used = new Set(opts.taken ?? []);
  return tracks.map((t) => {
    const code = langSlug(t.lang) + (t.hoh ? ".sdh" : "");
    const label = trackFileLabel(t);
    const tries = [
      ...(t.plain ? [opts.origBare && t.source === "whisper" && !t.hoh ? `.${ext}` : `.${code}.${ext}`] : []),
      `.${label}.${code}.${ext}`,
    ];
    let name = tries.find((n) => !used.has(n));
    for (let n = 2; !name; n++) if (!used.has(`.${label}-${n}.${code}.${ext}`)) name = `.${label}-${n}.${code}.${ext}`;
    used.add(name);
    return name;
  });
}

// ── Per-transcript prefs ────────────────────────────────────────────────────────────────────

/** A transcript's dragged track order and typed track names (TranscriptRecord.exportTracks). */
export interface TrackPrefs {
  order?: string[];
  names?: Record<string, string>;
}

/** The prefs as read back from a record on disk — anything malformed dropped, bounded. */
export function readTrackPrefs(v: unknown): TrackPrefs {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const order = Array.isArray(p.order)
    ? p.order.filter((t): t is string => typeof t === "string" && t.length <= 64).slice(0, 64)
    : undefined;
  const names = p.names && typeof p.names === "object" && !Array.isArray(p.names)
    ? Object.fromEntries(Object.entries(p.names as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .slice(0, 64)
      .map(([k, n]) => [k, n.slice(0, TRACK_TITLE_MAX)]))
    : undefined;
  return { ...(order ? { order } : {}), ...(names ? { names } : {}) };
}
