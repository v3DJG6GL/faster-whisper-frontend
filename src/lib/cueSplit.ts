// Subtitle cues from transcript segments (D83/D84). Whisper segments run up to
// ~30 s and several sentences; a subtitle must stay short enough to read. This
// derives CUES from the stored segments — a projection, never a rewrite: edits,
// speaker edits and stale marks stay keyed by segment index, and every cue
// remembers the segment it came from.
//
// Limits follow the common broadcast/streaming norm (≤ 2 lines × 42 chars,
// 0.83–7 s, 17 chars/s; 20 for English; CJK 13–16 chars per line). Break points
// are chosen by score: a pause beats a sentence end beats a comma beats "before
// a conjunction"; a break right after an article or preposition is penalised.
// Segments without word timing (imports, models without word timestamps,
// synthesized clocks) are never split — only their lines are wrapped.
// Pure, no Tauri imports.

import { primarySubtag } from "./languages";
import { segmentWordRanges } from "./wordAlign";
import type { BatchResult, TranscriptSegment } from "./types";

export type SubtitleLength = "transcribed" | "standard" | "short" | "custom";
export type TranslationTiming = "same" | "own";

export interface CueLimits {
  /** Characters per line. */
  cpl: number;
  lines: number;
  /** Longest subtitle, seconds. */
  maxDur: number;
  /** Reading speed, characters per second (warning threshold). */
  cps: number;
}

export interface CueOptions {
  length: Exclude<SubtitleLength, "transcribed">;
  custom?: CueLimits;
  /** Machine translations: share the original's cues, or get their own. */
  timing: TranslationTiming;
}

export interface Cue {
  /** Source segment index; -1 for a cue of an own-timed site track. */
  seg: number;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** Translations cut onto this cue (same timing only). */
  tr: Record<string, string>;
}

export interface CueGrid {
  /** Original-language cues (with same-timed translations in `tr`). */
  cues: Cue[];
  /** Own-timed tracks: machine translations under own timing, site tracks always. */
  own: Record<string, Cue[]>;
}

export const MIN_CUE_DUR = 0.83;

export const CUE_PRESETS: Record<"standard" | "short", CueLimits> = {
  standard: { cpl: 42, lines: 2, maxDur: 7, cps: 17 },
  short: { cpl: 42, lines: 1, maxDur: 4, cps: 17 },
};

export const CUE_RANGES: Record<keyof CueLimits, { min: number; max: number; step: number }> = {
  cpl: { min: 28, max: 60, step: 1 },
  lines: { min: 1, max: 3, step: 1 },
  maxDur: { min: 2, max: 12, step: 0.5 },
  cps: { min: 10, max: 25, step: 1 },
};

const CJK_CPL: Record<string, number> = { ja: 13, zh: 16, yue: 16, ko: 16 };

/** Clamp an untrusted (synced / stored) limits object; undefined when unusable. */
export function sanitizeCueLimits(v: unknown): CueLimits | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out = {} as CueLimits;
  for (const k of Object.keys(CUE_RANGES) as (keyof CueLimits)[]) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
    const r = CUE_RANGES[k];
    out[k] = Math.min(r.max, Math.max(r.min, Math.round(n / r.step) * r.step));
  }
  return out;
}

/** The export's cue options from the saved settings; undefined = as transcribed. */
export function cueOptionsOf(t?: {
  subtitleLength?: SubtitleLength;
  subtitleCustom?: CueLimits;
  translationTiming?: TranslationTiming;
}): CueOptions | undefined {
  const length = t?.subtitleLength ?? "standard";
  if (length === "transcribed") return undefined;
  return {
    length,
    custom: sanitizeCueLimits(t?.subtitleCustom),
    timing: t?.translationTiming === "own" ? "own" : "same",
  };
}

/** Limits for one language: presets adapt reading speed (English reads faster)
 *  and line length (CJK glyphs are wide); Custom applies as set, except the
 *  CJK line length. */
export function limitsFor(o: CueOptions, lang?: string): CueLimits {
  const b = primarySubtag(lang);
  const base =
    o.length === "custom" ? (o.custom ?? CUE_PRESETS.standard) : { ...CUE_PRESETS[o.length], cps: b === "en" ? 20 : 17 };
  const cjk = CJK_CPL[b];
  return cjk ? { ...base, cpl: Math.min(base.cpl, cjk) } : base;
}

// ── break scoring ───────────────────────────────────────────────────────────

const CONJ = new Set([
  "and", "but", "so", "because", "or", "which", "who", "that", "when", "while", "if",
  "und", "aber", "dass", "weil", "denn", "oder", "wenn", "als", "sondern", "doch", "ob",
  "et", "mais", "car", "donc", "si", "que", "qui", "quand",
  "y", "pero", "porque", "cuando", "e", "ma", "perché", "quando", "che",
  "en", "maar", "omdat", "dat", "mas", "porque", "quando",
]);
const NOBREAK = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "with", "from", "by", "my", "your", "its",
  "his", "her", "our", "their", "this", "these", "that's", "every", "each", "some", "no", "mr.", "mrs.", "dr.",
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einen", "einem", "im", "am", "zum", "zur",
  "vom", "beim", "mit", "von", "bei", "nach", "seit", "aus", "für", "über", "unter", "hinter", "vor", "auf",
  "jeden", "jede", "jedes", "sein", "seine", "ihr", "ihre", "mein", "meine",
  "le", "la", "les", "un", "une", "de", "du", "des", "au", "aux", "en", "son", "sa", "ses", "mon", "ma",
  "el", "los", "las", "del", "al", "il", "lo", "gli", "nel", "della", "het", "een", "van", "o", "os", "do", "da",
]);
const ABBREV = new Set([
  "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "vs.", "etc.", "e.g.", "i.e.", "no.", "nr.",
  "z.b.", "usw.", "bzw.", "ca.", "d.h.", "u.a.", "evtl.", "ggf.", "inkl.", "mme.", "m.",
]);

const SENT_END = /[.?!…。？！](["'»”’)\]]*)$/;
const CLAUSE = /[,;:–—、，；：]["'»”’)\]]*$/;

function isSentenceEnd(word: string): boolean {
  const w = word.toLowerCase();
  if (!SENT_END.test(w)) return false;
  if (ABBREV.has(w)) return false;
  return !/^\d{1,2}\.$/.test(w); // German ordinal "3." (a year "1980." still ends a sentence)
}

const bare = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'.]+$/gu, "");

/** Score of breaking between `prev` and `next` (words as written). */
function breakScore(prev: string, next: string): number {
  let s = 0;
  if (isSentenceEnd(prev)) s += 100;
  else if (CLAUSE.test(prev)) s += 40;
  if (CONJ.has(bare(next))) s += 20;
  if (NOBREAK.has(prev.toLowerCase()) || NOBREAK.has(bare(prev))) s -= 80;
  return s;
}

// ── tokens ──────────────────────────────────────────────────────────────────

interface Tok {
  /** Char span in the segment text. */
  from: number;
  to: number;
  s: number;
  e: number;
}

/** Word timings mapped onto char spans of `text`; null when the words don't
 *  line up with the text (the segment then stays whole). Each span runs to the
 *  next word, so punctuation between words never falls out of a cue. */
function tokensOf(text: string, words: { word: string; start: number; end: number }[]): Tok[] | null {
  if (!words.length) return null;
  const out: Tok[] = [];
  let cur = 0;
  for (const w of words) {
    const tw = w.word.trim();
    if (!tw) continue;
    const at = text.indexOf(tw, cur);
    // Only whitespace/punctuation may sit between consecutive words.
    if (at < 0 || !/^[\s\p{P}]*$/u.test(text.slice(cur, at))) return null;
    if (out.length) out[out.length - 1].to = at;
    out.push({ from: at, to: at + tw.length, s: w.start, e: Math.max(w.start, w.end) });
    cur = at + tw.length;
  }
  // Text the words don't reach (a word timed past the segment) = mismatch.
  if (!out.length || !/^[\s\p{P}]*$/u.test(text.slice(cur))) return null;
  out[out.length - 1].to = text.length;
  return out;
}

/** Evenly spread token times over [a, b] by character share — for text that
 *  has no word timing of its own (a translation under own timing). Text
 *  without spaces (CJK) splits per character. */
function spreadTokens(text: string, a: number, b: number): Tok[] {
  const spans: [number, number][] = [];
  if (/\s/.test(text.trim())) {
    for (const m of text.matchAll(/\S+/g)) spans.push([m.index!, m.index! + m[0].length]);
  } else {
    for (let i = 0; i < text.length; i++) if (text[i].trim()) spans.push([i, i + 1]);
  }
  const tot = spans.reduce((n, [f, t]) => n + t - f + 1, 0) || 1;
  let c = a;
  return spans.map(([from, to]) => {
    const d = ((b - a) * (to - from + 1)) / tot;
    const tok = { from, to, s: c, e: c + d };
    c += d;
    return tok;
  });
}

const sliceOf = (text: string, ts: Tok[]) => text.slice(ts[0].from, ts[ts.length - 1].to).trim();

/** Limits of one segment's text: `reserve` = chars a "Name: " prefix takes. */
type Budget = CueLimits & { reserve: number };

function fits(text: string, ts: Tok[], L: Budget): boolean {
  return sliceOf(text, ts).length + L.reserve <= L.cpl * L.lines && ts[ts.length - 1].e - ts[0].s <= L.maxDur;
}

/** Recursive best-gap split until every piece fits. */
function splitTokens(text: string, ts: Tok[], L: Budget): Tok[][] {
  if (ts.length < 2 || fits(text, ts, L)) return [ts];
  const total = sliceOf(text, ts).length || 1;
  let best = -Infinity;
  let bi = -1;
  for (let i = 1; i < ts.length; i++) {
    if (ts.length >= 4 && (i < 2 || ts.length - i < 2)) continue; // no one-word side
    const left = ts.slice(0, i);
    const right = ts.slice(i);
    const gap = ts[i].s - ts[i - 1].e;
    let s = breakScore(text.slice(ts[i - 1].from, ts[i - 1].to).trim(), text.slice(ts[i].from, ts[i].to).trim());
    s += gap >= 0.5 ? 150 : 120 * Math.max(gap, 0);
    s -= (30 * Math.abs(sliceOf(text, left).length - sliceOf(text, right).length)) / total;
    if (left[left.length - 1].e - left[0].s < 1 || right[right.length - 1].e - right[0].s < 1) s -= 60;
    if (s > best) {
      best = s;
      bi = i;
    }
  }
  if (bi < 0) bi = Math.floor(ts.length / 2);
  return [...splitTokens(text, ts.slice(0, bi), L), ...splitTokens(text, ts.slice(bi), L)];
}

/** A one-word or too-short piece joins its shorter neighbour when the merge still fits. */
function mergeOrphans(text: string, groups: Tok[][], L: Budget): Tok[][] {
  const out = groups.slice();
  for (let i = 0; i < out.length && out.length > 1; i++) {
    const g = out[i];
    const dur = g[g.length - 1].e - g[0].s;
    if (g.length > 1 && dur >= MIN_CUE_DUR) continue;
    const prev = i > 0 ? [...out[i - 1], ...g] : null;
    const next = i < out.length - 1 ? [...g, ...out[i + 1]] : null;
    const candidates = [prev, next].filter((m): m is Tok[] => !!m && fits(text, m, L));
    if (!candidates.length) continue;
    const m = candidates.reduce((a, b) => (sliceOf(text, a).length <= sliceOf(text, b).length ? a : b));
    if (m === prev) out.splice(i - 1, 2, m);
    else out.splice(i, 2, m);
    i = -1; // restart: a merge can change a neighbour's fate
  }
  return out;
}

/** Timed pieces of one text inside [start, end]: the first and last piece keep
 *  the segment's own bounds, inner bounds come from the tokens; small gaps are
 *  closed (no flicker) and short cues padded without overlapping the next. */
function timedPieces(
  text: string,
  ts: Tok[],
  start: number,
  end: number,
  L: Budget,
): { start: number; end: number; text: string }[] {
  const groups = mergeOrphans(text, splitTokens(text, ts, L), L);
  const out = groups.map((g, k) => ({
    start: k === 0 ? start : g[0].s,
    end: k === groups.length - 1 ? end : g[g.length - 1].e,
    text: sliceOf(text, g),
  }));
  for (let k = 0; k < out.length - 1; k++) {
    const next = out[k + 1].start;
    if (next - out[k].end < 0.5) out[k].end = next;
    else if (out[k].end - out[k].start < MIN_CUE_DUR) out[k].end = Math.min(next, out[k].start + MIN_CUE_DUR);
  }
  return out;
}

// ── translation cutting (same timing) ───────────────────────────────────────

/** Cut `text` into `shares.length` parts proportional to `shares`, preferring
 *  cuts after sentence/clause punctuation and never right after an article. */
export function cutByShare(text: string, shares: number[]): string[] {
  if (shares.length < 2) return [text.trim()];
  const spaced = /\s/.test(text.trim());
  // Candidate cut positions: a space (dropped) or, for CJK, any char boundary.
  const cand: number[] = [];
  for (let i = 1; i < text.length; i++) if (spaced ? /\s/.test(text[i]) : true) cand.push(i);
  const tot = shares.reduce((a, b) => a + b, 0) || 1;
  const cuts: number[] = [];
  let done = 0;
  let prev = 0;
  for (let k = 0; k < shares.length - 1; k++) {
    done += shares[k];
    const target = (text.length * done) / tot;
    let best = -Infinity;
    let bi = -1;
    for (const i of cand) {
      if (i <= prev) continue;
      const ch = text[i - 1];
      const prevWord = text.slice(text.lastIndexOf(" ", i - 1) + 1, i).toLowerCase();
      const s =
        -Math.abs(i - target) +
        (/[.?!。？！]/.test(ch) ? 16 : /[,;:，；、]/.test(ch) ? 9 : 0) -
        (NOBREAK.has(prevWord) ? 12 : 0);
      if (s > best) {
        best = s;
        bi = i;
      }
    }
    if (bi < 0) break;
    cuts.push(bi);
    prev = bi;
  }
  const out: string[] = [];
  let a = 0;
  for (const c of cuts) {
    out.push(text.slice(a, c).trim());
    a = c;
  }
  out.push(text.slice(a).trim());
  while (out.length < shares.length) out.push("");
  return out;
}

// ── line wrapping ───────────────────────────────────────────────────────────

/** Wrap one cue's text onto at most `lines` lines of `cpl` chars, bottom-heavy
 *  (the second line may be longer), preferring breaks after punctuation and
 *  never after an article. Text that cannot fit gets extra lines rather than
 *  losing words. `firstReserve` = chars a prefix ("Name: ", "[DE] ") takes on
 *  the first line. */
export function wrapLines(text: string, cpl: number, lines: number, firstReserve = 0): string[] {
  const t = text.trim();
  const len = t.length + firstReserve;
  if (len <= cpl) return [t];
  const spaced = /\s/.test(t);
  const toks = spaced ? t.split(/\s+/) : Array.from(t);
  const join = (ws: string[]) => ws.join(spaced ? " " : "");
  if (toks.length < 2) return [t];
  // More text than the lines hold (a segment that could not be split): add lines.
  const n = Math.max(2, lines, Math.ceil(len / cpl));
  const target = len / n;
  let best = -Infinity;
  let bi = 1;
  for (let i = 1; i < toks.length; i++) {
    const a = join(toks.slice(0, i)).length + firstReserve;
    const b = join(toks.slice(i)).length;
    let s = 0;
    if (a > cpl) s -= 1000;
    if (b > cpl * (n - 1)) s -= 1000;
    if (spaced) s += breakScore(toks[i - 1], toks[i]) * 0.3;
    s -= Math.abs(a - target) * 0.6;
    if (a <= b / (n - 1)) s += 4; // bottom-heavy
    if (s > best) {
      best = s;
      bi = i;
    }
  }
  return [join(toks.slice(0, bi)), ...wrapLines(join(toks.slice(bi)), cpl, n - 1)];
}

// ── the grid ────────────────────────────────────────────────────────────────

/** Cues for the export/viewer. `tracks` = "orig" + translation codes + timed-track
 *  ids; `o` undefined = one cue per segment (as transcribed). `reserve(seg)` =
 *  chars a speaker-name prefix will take on that segment's cues. */
export function buildCues(
  result: BatchResult,
  o: CueOptions | undefined,
  tracks: string[],
  reserve: (seg: TranscriptSegment) => number = () => 0,
): CueGrid {
  const segs = result.segments ?? [];
  const words = result.words ?? [];
  const ranges = o && words.length && !result.timingSynthesized ? segmentWordRanges(segs, words) : null;
  const L = o ? limitsFor(o, result.language) : null;
  const timedIds = new Set((result.timedTracks ?? []).map((t) => t.id));
  const mtLangs = tracks.filter((t) => t !== "orig" && !timedIds.has(t));
  const own: Record<string, Cue[]> = {};
  const ownMt = !!o && o.timing === "own";
  if (ownMt) for (const l of mtLangs) own[l] = [];
  const cues: Cue[] = [];

  segs.forEach((seg, si) => {
    const toks = ranges && L ? tokensOf(seg.text, words.slice(ranges[si][0], ranges[si][1])) : null;
    const pieces = toks && L
      ? timedPieces(seg.text, toks, seg.start, seg.end, { ...L, reserve: reserve(seg) })
      : [{ start: seg.start, end: seg.end, text: seg.text.trim() }];
    const mine: Cue[] = pieces.map((p) => ({ seg: si, ...p, speaker: seg.speaker, tr: {} }));
    for (const lang of mtLangs) {
      const t = trText(seg, lang);
      if (t === null) continue;
      if (ownMt) {
        const LL = { ...limitsFor(o!, lang), reserve: reserve(seg) };
        const parts = toks ? timedPieces(t, spreadTokens(t, seg.start, seg.end), seg.start, seg.end, LL) : [
          { start: seg.start, end: seg.end, text: t },
        ];
        own[lang].push(...parts.map((p) => ({ seg: si, ...p, speaker: seg.speaker, tr: {} })));
      } else {
        const parts = cutByShare(t, mine.map((c) => Math.max(1, c.text.length)));
        mine.forEach((c, k) => {
          if (parts[k]) c.tr[lang] = parts[k];
        });
      }
    }
    cues.push(...mine);
  });

  for (const tt of result.timedTracks ?? []) {
    if (!tracks.includes(tt.id)) continue;
    own[tt.id] = tt.cues.map((c) => ({ seg: -1, start: c.start, end: c.end, text: c.text.trim(), tr: {} }));
  }
  return { cues, own };
}

/** A segment's usable translation, trimmed: null when absent or empty — or when the server's
 *  quality guard KEPT the source text for this target (it would duplicate the original). */
export function trText(seg: TranscriptSegment, lang: string): string | null {
  if (seg.translationsKept?.includes(lang)) return null;
  const t = seg.translations?.[lang]?.trim();
  return t ? t : null;
}

/** The timed lines one track will show: its own cues when own-timed, else the
 *  shared cues (original text, or that language's cut). */
export function trackCues(grid: CueGrid, track: string): { start: number; end: number; text: string; seg: number }[] {
  if (grid.own[track]) return grid.own[track];
  return grid.cues
    .map((c) => ({ start: c.start, end: c.end, seg: c.seg, text: track === "orig" ? c.text : (c.tr[track] ?? "") }))
    .filter((c) => c.text);
}

/** The language code a track is filed under: the transcript's for the original, a site
 *  track's own, the target code otherwise — "und" when unknown. */
export function trackLang(result: Pick<BatchResult, "language" | "timedTracks">, track: string): string {
  const tt = result.timedTracks?.find((t) => t.id === track);
  return ((tt ? tt.lang : track === "orig" ? result.language : track) ?? "").trim() || "und";
}

/** Cues as a BatchResult, so the existing generators render them unchanged:
 *  one segment per cue, translations from the cut (or one own-timed track). */
export function cueResult(result: BatchResult, grid: CueGrid, ownTrack?: string): BatchResult {
  const segs = result.segments ?? [];
  if (ownTrack) {
    return {
      ...result,
      segments: (grid.own[ownTrack] ?? []).map((c) => ({
        start: c.start,
        end: c.end,
        text: "",
        ...(c.speaker ? { speaker: c.speaker } : {}),
        translations: { [ownTrack]: c.text },
      })),
    };
  }
  return {
    ...result,
    segments: grid.cues.map((c) => {
      const kept = segs[c.seg]?.translationsKept;
      return {
        start: c.start,
        end: c.end,
        text: c.text,
        ...(c.speaker ? { speaker: c.speaker } : {}),
        ...(Object.keys(c.tr).length ? { translations: c.tr } : {}),
        ...(kept?.length ? { translationsKept: kept } : {}),
      };
    }),
  };
}
