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

import { plural } from "../format";
import { langText, primarySubtag } from "../languages";
import { ownProp } from "../own";
import { segmentWordRanges } from "./wordAlign";
import type { BatchResult, TimedTrack, TranscriptSegment } from "../types";

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

const MIN_CUE_DUR = 0.83;

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

/** Scripts written without spaces between words: a run of them can break anywhere. */
export const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** CJK punctuation and fullwidth forms, and the kana marks ・ ー (Script=Common, so
 *  UNSPACED misses them): like the unspaced scripts, no space around them. */
const UNSPACED_PUNCT = /[\u3000-\u303f\u30fb\u30fc\uff00-\uffef]/u;
/** An unspaced-script character or CJK/fullwidth punctuation — the one predicate the LRC
 *  export and import (and joinSegmentTexts) decide a seam's space with, so they agree. */
export const unspacedChar = (c: string): boolean => UNSPACED.test(c) || UNSPACED_PUNCT.test(c);
/** Scripts (and CJK punctuation) a line may break between any two characters of. Text
 *  without spaces and without any of these is one word ("Ja.", "Привет!"): it stays whole
 *  rather than being cut into letters. */
const BREAKS_ANYWHERE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;
/** The first (`end` false) or last code point of `s` — "" when empty. Seam tests go
 *  through it: a lone surrogate half is never unspaced, so a per-UTF-16-unit look
 *  misreads an astral (CJK Ext-B) character at the edge. At the end, trailing combining
 *  marks and variation selectors (a decomposed "が", a "葛" + selector) are skipped so the
 *  base character judges the seam. */
export function edgeChar(s: string, end: boolean): string {
  if (!end) return s ? String.fromCodePoint(s.codePointAt(0)!) : "";
  const t = s.replace(/\p{M}+$/u, "");
  const lo = t.charCodeAt(t.length - 1);
  return t.slice(lo >= 0xdc00 && lo <= 0xdfff ? -2 : -1);
}
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
  // Own keys only: an imported language "constructor" otherwise reads Object.prototype.
  const cjk = ownProp(CJK_CPL, b);
  return cjk ? { ...base, cpl: Math.min(base.cpl, cjk) } : base;
}

/** The reading speed flagged when the subtitles stay as transcribed (no cue options). */
export const TRANSCRIBED_CPS = 20;

/** One track's limits — its language's under the cue options; null = as transcribed. */
export function trackLimits(
  result: Pick<BatchResult, "language" | "timedTracks">, o: CueOptions | undefined, track: string,
): CueLimits | null {
  return o ? limitsFor(o, trackLang(result, track)) : null;
}

/** One track's reading-speed threshold: its limits', else the as-transcribed one. */
export function trackCps(
  result: Pick<BatchResult, "language" | "timedTracks">, o: CueOptions | undefined, track: string,
): number {
  return trackLimits(result, o, track)?.cps ?? TRANSCRIBED_CPS;
}

/** Limits as a tooltip: "2 lines × 42 characters · up to 7 s · 17 chars/s". */
export function limitsTitle(l: CueLimits): string {
  return `${plural(l.lines, "line")} × ${l.cpl} characters · up to ${l.maxDur} s · ${l.cps} chars/s`;
}

// ── break scoring ───────────────────────────────────────────────────────────

const CONJ = new Set([
  "and", "but", "so", "because", "or", "which", "who", "that", "when", "while", "if",
  "und", "aber", "dass", "weil", "denn", "oder", "wenn", "als", "sondern", "doch", "ob",
  "et", "mais", "car", "donc", "si", "que", "qui", "quand",
  "y", "pero", "porque", "cuando", "e", "ma", "perché", "quando", "che",
  "en", "maar", "omdat", "dat", "mas", "porque", "quando",
]);
// Every entry is shorter than 9 characters — cutByShare's bounded look-back relies on it.
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
  /** Cached breakScore of the gap before this token — it depends only on the two
   *  adjacent tokens, which every recursion level of splitTokens shares. */
  bs?: number;
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

/** CJK and fullwidth opening brackets: they stick to the character after them. */
const OPEN_PUNCT = "〈《「『【〔〖〘〚〝（［｛｟｢";
/** CJK and fullwidth closing brackets and stops: they stick to the character before them.
 *  Listed, not the whole fullwidth block — fullwidth letters and digits stay breakable. */
const CLOSE_PUNCT = "、。〉》」』】〕〗〙〛〞〟）］｝｠｣！，．：；？";
/** The prolonged sound mark ー (and its halfwidth ｰ): ONE sticks to the character before it (no line starts
 *  with the ー of コー), each further ー of a run is a character of its own — a whole
 *  えーーーー… or a hallucinated すごーーー…い glued into one unit could not wrap or cut
 *  and ran over the cap. A line may then start with ー inside a long run only. */
const CHOON = "(?:(?<![ーｰ])[ーｰ])?";
/** Thai/Lao leading vowels (เ แ โ ใ ไ): written before the consonant they follow in
 *  speech, so they stick to the character after them. */
const LEADS = "\\u0e40-\\u0e44\\u0ec0-\\u0ec4";
/** Thai/Lao following vowels that are letters, not marks (ะ า ำ ๅ): they stick to the
 *  character before them. */
const TRAILS = "\\u0e30\\u0e32\\u0e33\\u0e45\\u0eb0\\u0eb2\\u0eb3";
/** Burmese/Khmer stacking viramas: the consonant after one is stacked under the one before. */
const STACKERS = "\\u1039\\u17d2";
const LEAD_OR_STACKER = new RegExp(`[${LEADS}${STACKERS}]`);
const TRAIL = new RegExp(`[${TRAILS}]`);
/** What rides after a base character: combining marks, emoji skin tones, Thai/Lao following
 *  vowels, a halfwidth voicing mark (ﾞ ﾟ — a letter, not a mark, so it rides before a
 *  following ｰ: ﾃﾞｰ, never ﾃﾞ / ｰ), ZWJ + next, a stacking virama + the consonant it stacks. */
const UNIT_TAIL = `(?:[\\p{M}\\p{Emoji_Modifier}\\u200d\\uff9e\\uff9f${TRAILS}]|(?<=[\\u200d${STACKERS}])\\S)*`;
/** Scripts written without spaces between words that are no CJK (unspacedChar keeps
 *  only Han/Kana, as the LRC seams need): inside spaced text a run of them still breaks
 *  between its syllables, like a CJK run — a space-joined multi-sentence Thai translation
 *  used to be a handful of unsplittable tokens. */
const SYLLABIC = "\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const BRK_SYL = new RegExp(`[${SYLLABIC}]`, "u");
/** A token of spaced text: a word (with any opening brackets before it), or one unspaced
 *  (CJK, Thai…) character with the opening brackets before it and its other punctuation
 *  after it (a Thai/Lao leading vowel rides with the consonant after it) —
 *  so a CJK translation holding one Latin word still splits between its characters, and
 *  never right after a 「 or （ (a Latin word or number before 「 used to swallow it). A
 *  bracket with nothing after it is its own token, so no character falls out of the spans.
 *  The character keeps its combining marks (a decomposed が's U+3099, an ideographic
 *  variation selector) — they are Script=Inherited and would otherwise split off.
 *  A fullwidth letter or digit, a halfwidth kana (with its voicing mark), a 〜 and the
 *  ideographic space are such characters too, as CJK_UNIT has them: swallowed into the
 *  token before them, "〜〜〜…" could neither wrap nor cut. A run of fullwidth letters and
 *  digits (with ，．： only between two digits) is one word, as its halfwidth spelling is:
 *  "２０２６", "１２３，４５６" and "１２：３０" never break in the middle, while the ， of
 *  "ＣＰＵ，ＧＰＵ" or the ： of "ＵＲＬ：" stays a clause seam; a run longer than a line still wraps per
 *  character through `tokenUnits`. Glued to ASCII letters or digits ("ＰＳ5", "ＮＨＫnews")
 *  it stays one word too (mixedTokens joins them): the seam between the two widths is no
 *  word break. */
const FULLWIDTH = "\\u3000-\\u303f\\uff00-\\uffef";
const FW_ALNUM = "０-９Ａ-Ｚａ-ｚ";
const MIXED_TOKEN = new RegExp(
  `[${OPEN_PUNCT}]*[${FW_ALNUM}]${UNIT_TAIL}(?:[${FW_ALNUM}]${UNIT_TAIL}|(?<=[０-９])[，．：](?=[０-９]))*[${CLOSE_PUNCT}]*`
    + `|[${OPEN_PUNCT}]*[${LEADS}]*(?:[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー${SYLLABIC}]|(?![\\s${OPEN_PUNCT}])[${FULLWIDTH}])${UNIT_TAIL}${CHOON}[${CLOSE_PUNCT}]*`
    + `|[${OPEN_PUNCT}]*[^\\s${OPEN_PUNCT}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー${SYLLABIC}${FULLWIDTH}]+`
    + `|[${OPEN_PUNCT}]+`,
  "gu",
);
const OPENER = new RegExp(`[${OPEN_PUNCT}]`, "u");
/** One code point of whitespace-free text with the opening brackets before it and the
 *  closing brackets/stops after it — the unit unspaced text splits and wraps by, so no
 *  piece or line ends on 「 or starts with 」 or 。. Combining marks, variation selectors,
 *  skin tones and ZWJ sequences ride with their base (a Thai tone mark never opens a line),
 *  a flag's two regional indicators stay one unit, a Thai/Lao leading vowel rides with the
 *  consonant after it and a following vowel with the one before, and a Burmese/Khmer
 *  stacked consonant stays with the virama above it. At most three closers ride along,
 *  as one ー does: a hallucinated "え？？？？…" glued into one unit could not wrap. */
const CJK_UNIT = new RegExp(`[${OPEN_PUNCT}${LEADS}]*(?:\\p{RI}\\p{RI}|\\S)${UNIT_TAIL}${CHOON}[${CLOSE_PUNCT}]{0,3}`, "gu");
const units = (s: string): string[] => s.match(CJK_UNIT) ?? [];
/** The units a token longer than a line wraps by (a URL, an e-mail address, a German
 *  compound, a run of ・): units() with ASCII punctuation kept on its character, as
 *  mixedTokens keeps it — a closer or stop joins the unit before it (up to three of them),
 *  an opener the unit after it, a closing quote or bracket in the token's trailing
 *  punctuation, or a quote glued to a letter or digit, closes it („Hallo“ / „Hallo“, /
 *  „…...“, / „…“-Verband / “…...” / (…...)), and an ASCII quote or a » ” that starts the
 *  token opens it (»…« / ”…”), so no line starts with “ ” ) or ends on „ » or ". */
function tokenUnits(w: string): string[] {
  const out: string[] = [];
  let open = "";
  const u = units(w);
  // Where the token's trailing run of punctuation units begins: a quote or bracket from there on closes.
  let tail = u.length;
  while (tail > 0 && /^[\p{Pe}\p{Pf}\p{Po}\p{Pi}]+$/u.test(u[tail - 1])) tail--;
  // An ASCII quote opens only a word that follows it, and only from a short leading run of
  // openers and quotes ("(word, """"word): a longer run (a hallucinated wall of quotes) opens
  // nothing and wraps three to a piece like other punctuation, so it cannot tear the word.
  const firstWord = u.findIndex((x) => /[\p{L}\p{N}]/u.test(x));
  const lead = u.findIndex((x) => !/^[\p{Ps}\p{Pi}\p{Pf}"']+$/u.test(x));
  const quoteOpens = lead !== -1 && lead <= 6;
  u.forEach((x, k) => {
    const prev = out[out.length - 1];
    const last = prev === undefined ? "" : edgeChar(prev, true);
    // A closing quote or bracket in the trailing run rides even past the three-closer cap
    // („…...“, / “…...” / (…...)): left behind, it would start a line (a “ would even open
    // the next unit). A “ or « glued to a letter or digit closes too, mid-token as well
    // („…“-Verband) — after a CJK character it opens (“你好”). Each class keeps its cap among
    // itself: a stop counts only the stops before it (え？？？？), so the "," after "…...”" still
    // rides, and a quote or bracket only the quotes and brackets (a hallucinated run of ")" or
    // "」" still wraps); six marks in all bound an alternating wall (.".".".").
    if (prev !== undefined && !open
      && ((k >= tail && /^(?:[\p{Pi}\p{Pf}\p{Pe}]|["'])+$/u.test(x)
          && !/(?:[\p{Pi}\p{Pf}\p{Pe}]|["']){3}$/u.test(prev))
        || (/^\p{Pi}+$/u.test(x) && /[\p{L}\p{N}]/u.test(last) && !BREAKS_ANYWHERE.test(last))
        || (/^[\p{Pe}\p{Pf}\p{Po}]/u.test(x) && !/\p{P}{6}$/u.test(prev)
          && !(/^(?:[\p{Pe}\p{Pf}]|["'])/u.test(x) ? /(?:[\p{Pi}\p{Pf}\p{Pe}]|["']){3}$/u : /(?:(?!["'])\p{Po}){3}$/u)
            .test(prev)))) out[out.length - 1] += x;
    // An ASCII quote (or a » ” — German »…«, Swedish ”…”) that starts the token or follows its
    // openers opens it: as a closer of nothing it ended a line on a bare " or ». One inside a
    // word (don't, 5'10") rides above.
    else if (
      (/^[\p{Ps}\p{Pi}]+$/u.test(x) || ((k === 0 || open) && quoteOpens && k < firstWord && /^(?:["']|\p{Pf})$/u.test(x)))
      && k < u.length - 1
    ) open += x;
    else {
      out.push(open + x);
      open = "";
    }
  });
  if (open) out.push(open);
  return out;
}
/** A regional indicator (half of a flag emoji). */
const isRI = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;
/** Length of the whitespace-free run around index `i` of `t`, counted only up to 7 — a
 *  long run is all cutByShare needs to know, and it must not cost a scan per candidate. */
function runAt(t: string, i: number): number {
  let a = i;
  while (a > 0 && i - a < 7 && !/\s/.test(t[a - 1])) a--;
  let b = i;
  while (b < t.length && b - a < 7 && !/\s/.test(t[b])) b++;
  return b - a;
}

/** Evenly spread token times over [a, b] by character share — for text that
 *  has no word timing of its own (a translation under own timing). Text
 *  without spaces splits per code point when it is CJK/Thai-like (a Latin word or
 *  number glued into it — "iPhone", "2026年" — stays one token, as wrapLines keeps
 *  it); otherwise it is one word and one token. */
function spreadTokens(text: string, a: number, b: number): Tok[] {
  const spans: [number, number][] = [];
  if (!/\s/.test(text.trim()) && !BREAKS_ANYWHERE.test(text)) {
    spans.push([0, text.length]);
  } else {
    // The tokens wrapLines and cutByShare use (mixedTokens), spaced or not: an opening
    // bracket rides with the code point it opens, a closer with the one it closes, a glued
    // Latin word stays whole, and so does a word mixing both widths ("ＰＳ5") — matched
    // per MIXED_TOKEN here, an own-timed cue could end on ＰＳ.
    const m = mixedTokens(text);
    m.toks.forEach((w, k) => spans.push([m.at[k], m.at[k] + w.length]));
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
    const gap = ts[i].s - ts[i - 1].e;
    let s = (ts[i].bs ??= breakScore(
      text.slice(ts[i - 1].from, ts[i - 1].to).trim(),
      text.slice(ts[i].from, ts[i].to).trim(),
    ));
    s += gap >= 0.5 ? 150 : 120 * Math.max(gap, 0);
    // Between two syllables of a Thai/Lao/Khmer/Burmese run (no space): a fallback seam, so
    // a spaced line still breaks at its phrase spaces first (cutByShare does the same).
    const at = ts[i].from;
    if (BRK_SYL.test(text[at - 1] ?? "") && BRK_SYL.test(text[at] ?? "")) s -= 40;
    // Both sides read by index: slicing the token array per candidate made every level O(n²).
    const leftLen = text.slice(ts[0].from, ts[i - 1].to).trim().length;
    const rightLen = text.slice(ts[i].from, ts[ts.length - 1].to).trim().length;
    s -= (30 * Math.abs(leftLen - rightLen)) / total;
    if (ts[i - 1].e - ts[0].s < 1 || ts[ts.length - 1].e - ts[i].s < 1) s -= 60;
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

/** Runs of pieces with no gap between them, each with its span and text length. */
function stretchesOf(pieces: { start: number; end: number; text: string }[]): { start: number; end: number; len: number }[] {
  const out: { start: number; end: number; len: number }[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && p.start <= last.end) {
      last.end = p.end;
      last.len += p.text.length + 1;
    } else out.push({ start: p.start, end: p.end, len: Math.max(1, p.text.length) });
  }
  return out;
}

// ── translation cutting (same timing) ───────────────────────────────────────

/** Cut `text` into `shares.length` parts proportional to `shares`, preferring
 *  cuts after sentence/clause punctuation and never right after an article. */
export function cutByShare(text: string, shares: number[]): string[] {
  if (shares.length < 2) return [text.trim()];
  const spaced = /\s/.test(text.trim());
  // One word of a spaced script ("Ja."): nothing to cut — it goes to the first part.
  if (!spaced && !BREAKS_ANYWHERE.test(text)) return [text.trim(), ...shares.slice(1).map(() => "")];
  // Unspaced text cuts only between the tokens wrapLines wraps by (mixedTokens), so a
  // glued number, version, e-mail or URL ("3.14159", "1,234,567", "foo@bar.com") stays
  // whole here as it does on a line — its "." or "," used to draw the cut into it.
  let seams: Set<number> | null = null;
  if (!spaced) {
    const m = mixedTokens(text);
    seams = new Set(m.toks.map((w, k) => m.at[k] + w.length));
  }
  // Candidate cut positions: a space (dropped) or, for CJK, any code-point
  // boundary (never inside a surrogate pair, e.g. an emoji). Spaced text may
  // still hold a CJK run (one Latin word in a Japanese line): it cuts between
  // its characters too — a lone surrogate is never UNSPACED, so no pair splits.
  // Never right after an opening bracket (the cut goes before it instead), nor right
  // before a closing bracket or stop (the cut goes after it).
  const cand: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (seams && !seams.has(i)) continue;
    if (OPENER.test(text[i - 1]) || CLOSE_PUNCT.includes(text[i])) continue;
    // Nor before the first ー (or ｰ) after a character (the second ー of a run is a seam again).
    if (/[ーｰ]/.test(text[i]) && !/[ーｰ]/.test(text[i - 1])) continue;
    // Never between a base and its combining mark (tested on the code point: an
    // astral mark such as the variation selector U+E0100 is a surrogate pair), nor
    // inside a ZWJ sequence, nor before a skin tone, nor between a flag's two
    // regional indicators (an odd run of indicators right before i means i is the
    // second half of a pair).
    const cp = text.codePointAt(i)!;
    if (/[\p{M}\p{Emoji_Modifier}\u200d]/u.test(String.fromCodePoint(cp)) || text[i - 1] === "\u200d") continue;
    // Nor inside a Thai/Lao syllable (after a leading vowel, before a following vowel)
    // or a Burmese/Khmer consonant stack (right after the virama).
    if (LEAD_OR_STACKER.test(text[i - 1]) || TRAIL.test(text[i])) continue;
    if (isRI(cp)) {
      let n = 0;
      for (let j = i - 2; j >= 0 && isRI(text.codePointAt(j)!); j -= 2) n++;
      if (n % 2) continue;
    }
    if (
      spaced
        ? /\s/.test(text[i])
          // Seam judged by code point (edgeChar): an Ext-B character or a decomposed "が"
          // before i is unspaced too, as at every other seam.
          || (unspacedChar(edgeChar(text.slice(Math.max(0, i - 8), i), true))
            && (UNSPACED.test(edgeChar(text.slice(i, i + 2), false)) || OPENER.test(text[i])))
          // A Thai/Lao/Khmer/Burmese run cuts between its syllables (the guards above keep
          // each one whole), as the whitespace-free branch does.
          || (BRK_SYL.test(edgeChar(text.slice(Math.max(0, i - 8), i), true))
            && BRK_SYL.test(edgeChar(text.slice(i, i + 2), false)))
        : c < 0xdc00 || c > 0xdfff
    ) cand.push(i);
  }
  // In spaced Thai/Lao/Khmer/Burmese the spaces are the phrase breaks: a cut between two
  // syllables is the fallback when no space lies near the target, not an equal choice.
  const sylSpaced = spaced && BRK_SYL.test(text);
  const tot = shares.reduce((a, b) => a + b, 0) || 1;
  const cuts: number[] = [];
  // Every cut after this one still needs a seam of its own: a greedy pick near its target
  // used to spend the last seam before a glued word and leave the trailing parts empty
  // ("これは|iPhoneProMax|"). A part stays empty only when the text has fewer seams than cuts.
  const nCuts = Math.min(shares.length - 1, cand.length);
  let done = 0;
  let prev = 0;
  /** text[a..b) trimmed holds fewer than two code points — counted in place: slicing and
   *  spreading the part per candidate made a long text with many shares quadratic per cut. */
  const oneCp = (a: number, b: number): boolean => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    const n = b - a;
    return n < 2 || (n === 2 && text.codePointAt(a)! > 0xffff);
  };
  for (let k = 0; k < nCuts; k++) {
    done += shares[k];
    const target = (text.length * done) / tot;
    let best = -Infinity;
    let bi = -1;
    for (let j = 0; j < cand.length - (nCuts - 1 - k); j++) {
      const i = cand[j];
      if (i <= prev) continue;
      const ch = text[i - 1];
      // Bounded look-back (NOBREAK words are under 9 chars): unspaced CJK text
      // used to slice and fold the whole prefix per candidate.
      const back = text.slice(Math.max(0, i - 9), i);
      const sp = back.lastIndexOf(" ");
      const prevWord = sp >= 0 || i <= 9 ? back.slice(sp + 1).toLowerCase() : "";
      const s =
        -Math.abs(i - target) +
        (/[.?!。？！]/.test(ch) ? 16 : /[,;:，；、]/.test(ch) ? 9 : 0) +
        (sylSpaced && /\s/.test(text[i]) ? 9 : 0) -
        // A seam inside a short CJK word of spaced text ("東京") is a fallback, as in wrapTokens.
        (spaced && !sylSpaced && !/\s/.test(text[i]) && runAt(text, i) <= 6 ? 9 : 0) -
        // A space right before a lone closing mark or after a lone opening one (French
        // « bonjour », "Ça va ?"): the mark stays with its word.
        (/\s/.test(text[i])
          && (/^[\p{Pe}\p{Pf}\p{Po}]+(?:\s|$)/u.test(text.slice(i + 1, i + 9)) || /(?:^|\s)[\p{Ps}\p{Pi}]+$/u.test(back))
          ? 20
          : 0) -
        (NOBREAK.has(prevWord) ? 12 : 0) -
        // A part of one character (the ま of また, a lone 京) is a fallback, not a balance.
        (oneCp(prev, i) || (k === nCuts - 1 && oneCp(i, text.length)) ? 9 : 0);
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

/** Wrap one cue's text onto as few lines of `cpl` chars as it needs (the cue
 *  splitter keeps a cue within its line cap, so `_lines` only documents the
 *  caller's limit), bottom-heavy (the second line may be longer), preferring
 *  breaks after punctuation and never after an article. Text that cannot fit
 *  gets extra lines rather than losing words. `firstReserve` = chars a prefix
 *  ("Name: ", "[DE] ") takes on the first line. */
export function wrapLines(text: string, cpl: number, _lines: number, firstReserve = 0): string[] {
  const t = text.trim();
  const len = t.length + firstReserve;
  if (len <= cpl) return [t];
  const spaced = /\s/.test(t);
  // One word of a spaced script ("Okay.", "감사합니다.") pushed over only by the prefix
  // stays whole, as in wrapTokens; a word longer than cpl by itself still wraps per character.
  if (!spaced && t.length <= cpl && !BREAKS_ANYWHERE.test(t)) return [t];
  // Spaced text holding a CJK/Thai-like run (one Latin word in a Japanese line) wraps
  // between that run's characters too: as one token the run used to take whole lines of
  // its own, a three-line cue under a two-line cap that fits() had judged to fit.
  // Unspaced text wraps by the same tokens, so a Latin word or number glued into it
  // ("明日はMicrosoftの", "333メートル") stays whole and ASCII punctuation stays on its
  // character; no gaps, so every seam is a plain character seam. A token longer than
  // cpl (a Latin word, URL or e-mail in a Japanese line, a lone compound, or one in plain
  // spaced Latin text) wraps per unit (tokenUnits): kept whole it took a line of its own,
  // or ran over the cap — a URL in an English line left three or four lines.
  const toks: string[] = [];
  const gaps: boolean[] = [];
  if (spaced && !BREAKS_ANYWHERE.test(t)) {
    const words = t.split(/\s+/);
    words.forEach((w, k) => {
      const parts = w.length > cpl ? tokenUnits(w) : [w];
      toks.push(...parts);
      parts.forEach((_, j) => gaps.push(j === 0 && k > 0));
    });
    if (toks.length > words.length) {
      // A balanced break inside the split word can cost a line at a small cpl (a URL after
      // "wonderful" at 14, two e-mails at 20) that the word kept whole — on lines of its
      // own, wrapped per character — did not: the fewer lines win, the shared ones on a tie.
      const split = wrapTokens(toks, gaps, cpl, len, firstReserve);
      const whole = wrapTokens(words, words.map((_, i) => i > 0), cpl, len, firstReserve);
      return whole.length < split.length ? whole : split;
    }
  } else {
    const m = mixedTokens(t);
    m.toks.forEach((w, k) => {
      const parts = w.length > cpl ? tokenUnits(w) : [w];
      toks.push(...parts);
      if (spaced) parts.forEach((_, j) => gaps.push(j === 0 && m.gaps[k]));
    });
  }
  if (toks.length < 2) {
    // One token: a spaced-script word pushed over only by the prefix stays whole, as in
    // wrapTokens; an unspaced run wraps per unit.
    const u = tokenUnits(t);
    return u.length < 2 || (t.length <= cpl && !UNSPACED.test(t) && !BRK_SYL.test(t))
      ? [t]
      : wrapTokens(u, [], cpl, len, firstReserve);
  }
  return wrapTokens(toks, gaps, cpl, len, firstReserve);
}

/** Tokens of text with a CJK/Thai-like run (MIXED_TOKEN; spaced or not — spreadTokens and
 *  wrapLines tokenize unspaced text by them too), per token whether whitespace stood
 *  before it, and where in `t` it starts. Punctuation glued to its neighbour (an ASCII
 *  "." or ")" after a CJK character, a "(" before one) joins it, so no line starts with a
 *  stop or ends on an opener. An opener glued to the end of a word moves onto the character
 *  it opens, so a line may break before the "(" but never right after it. An ASCII " or '
 *  is a stop by class, but one that opens a quotation (他说"你好") rides forward too: it
 *  opens when a space or the text start stands before it, or when it is an odd-numbered
 *  one of its kind so far (an apostrophe between two letters, it's, is no quote), and a
 *  letter, digit or opener follows. */
function mixedTokens(t: string): { toks: string[]; gaps: boolean[]; at: number[] } {
  const toks: string[] = [];
  const gaps: boolean[] = [];
  const at: number[] = [];
  let end = 0;
  /** ASCII quotes of each kind before the current match — kept running, so the pass stays linear. */
  const quotes: Record<string, number> = { '"': 0, "'": 0 };
  /** ASCII quotes of each kind in the whole text (an apostrophe between ASCII letters is none). */
  const isQuote = (j: number) =>
    t[j] in quotes && !(/[A-Za-z0-9]/.test(t[j - 1] ?? "") && /[A-Za-z0-9]/.test(t[j + 1] ?? ""));
  const total: Record<string, number> = { '"': 0, "'": 0 };
  for (let j = 0; j < t.length; j++) if (isQuote(j)) total[t[j]]++;
  /** The token that ends on an opening ASCII quote: the next one joins it. */
  let quoted = -1;
  for (const m of t.matchAll(MIXED_TOKEN)) {
    let w = m[0];
    const gap = m.index! > end;
    end = m.index! + w.length;
    const k = toks.length - 1;
    // Its quote run (after any brackets, as in （"): at most six open, as in tokenUnits.
    const q = /^\p{Ps}*(["']{1,6})(?!["'])/u.exec(w);
    const after = m.index! + (q?.[0].length ?? 0);
    // Glued to the text before it, a quote opens only on positive evidence: an even count of its
    // kind so far AND a later one of its kind to close it. The last unpaired one — a closer whose
    // opener was in the previous segment, or the one after a stray inch mark — joins the text it
    // closes.
    const c = q?.[1][0] ?? '"';
    const opens = !!q && /[\p{L}\p{N}\p{Ps}\p{Pi}]/u.test(edgeChar(t.slice(after, after + 2), false))
      && (gap || k < 0 || q[0] !== q[1]
        || (quotes[c] % 2 === 0 && total[c] > quotes[c] + q[1].split(c).length - 1));
    for (let j = m.index!; j < end; j++) if (isQuote(j)) quotes[t[j]]++;
    // An opener glued to the end of a Latin word ("Python(") moves onto what it opens, with
    // the ASCII quotes after it (print("). Brackets only: an initial quote at the end of a word
    // is a closer in German/Danish usage („Hallo“, »Hallo«), and peeling it off left „Hallo /
    // “東京… on two lines.
    const open = k >= 0 && !gap ? /\p{Ps}+["']*$/u.exec(toks[k]) : null;
    let from = m.index!;
    if (open && open.index > 0) {
      toks[k] = toks[k].slice(0, open.index);
      w = open[0] + w;
      from -= open[0].length;
    }
    const opened = quoted === k;
    // A word mixing fullwidth and ASCII letters or digits ("ＰＳ5", "ＮＨＫnews") is one word.
    if (
      k >= 0 && !gap
      && ((!opens && /^[\p{Pe}\p{Pf}\p{Po}]/u.test(w)) || /^[\p{Ps}\p{Pi}]+$/u.test(toks[k]) || opened
        || (/[０-９Ａ-Ｚａ-ｚ]$/u.test(toks[k]) && /^[A-Za-z0-9]/.test(w))
        || (/[A-Za-z0-9]$/.test(toks[k]) && /^[０-９Ａ-Ｚａ-ｚ]/u.test(w)))
    ) toks[k] += w;
    else {
      toks.push(w);
      gaps.push(gap && k >= 0);
      at.push(from);
    }
    quoted = opens && end === after ? toks.length - 1 : -1;
  }
  return { toks, gaps, at };
}

/** wrapLines past its early returns: `len` (> cpl) is the text's length incl.
 *  `reserve`, toks.length >= 2; `gaps[i]` = a space stands before toks[i] (only
 *  there does a seam score as a word break). Line widths come from prefix sums, so
 *  a long unsplit paragraph costs one pass per line, not one rejoin per candidate. */
function wrapTokens(toks: string[], gaps: boolean[], cpl: number, len: number, reserve: number): string[] {
  const cum = [0];
  toks.forEach((w, i) => cum.push(cum[i] + (gaps[i] ? 1 : 0) + w.length));
  const T = toks.length;
  /** Length of the space-free run toks[i] belongs to (mixed tokenization only). */
  const runLen: number[] = [];
  for (let i = 0, start = 0; i <= T; i++) {
    if (i === T || (i > 0 && gaps[i])) {
      for (let k = start; k < i; k++) runLen[k] = cum[i] - cum[start] - (gaps[start] ? 1 : 0);
      start = i;
    }
  }
  /** Some seam has no space: a CJK/Thai-like run of spaced text breaks inside. */
  const mixed = gaps.some((g, i) => i > 0 && !g);
  /** Joined length of toks[a..b), b > a. */
  const width = (a: number, b: number) => cum[b] - cum[a] - (gaps[a] ? 1 : 0);
  const join = (a: number, b: number) => {
    let s = toks[a];
    for (let k = a + 1; k < b; k++) s += (gaps[k] ? " " : "") + toks[k];
    return s;
  };
  const out: string[] = [];
  let lo = 0;
  for (;;) {
    // As many lines as the text needs (a segment that could not be split gets more than two).
    const n = Math.max(2, Math.ceil(len / cpl));
    const target = len / n;
    let best = -Infinity;
    let bi = lo + 1;
    let past = -1;
    for (let i = lo + 1; i < T; i++) {
      const a = width(lo, i) + reserve;
      // Past the first over-cpl candidate every later one carries the -2000 and a larger
      // overflow term (its b is then under cpl*(n-1) by construction), breakScore*0.3 +
      // bottom-heavy can add at most 64, and |a - target| (target <= cpl < a) grows with a at
      // 0.6/char too — so a candidate more than 107 chars further cannot win (a loose bound).
      // Stops a long paragraph costing O(lines x T).
      if (a > cpl) {
        if (past < 0) past = a;
        else if (a - past > 107) break;
      }
      const b = width(i, T);
      let s = 0;
      // An over-cap line is final, an over-full remainder can still wrap: when no candidate
      // keeps both within their caps, the line itself must fit. A line that cannot (one word
      // over the cap) ends as early as it can, so that word then wraps per character —
      // a better break further on used to win and leave a longer over-cap line.
      if (a > cpl) s -= 2000 + 50 * (a - cpl);
      if (b > cpl * (n - 1)) s -= 1000;
      if (gaps[i]) {
        s += breakScore(toks[i - 1], toks[i]) * 0.3;
        // Never beside a lone mark of spaced punctuation (French « bonjour », "Ça va ?"): it
        // stays with its word — below the over-cap penalties, so a forced cut still happens,
        // and not on a line over the cap, which only its overflow may decide.
        if (a <= cpl && (/^[\p{Pe}\p{Pf}\p{Po}]+$/u.test(toks[i]) || /^[\p{Ps}\p{Pi}]+$/u.test(toks[i - 1]))) s -= 500;
        // A phrase space between two longer runs ("…行った 楽しかった…") that keeps both lines
        // within the cap beats a balanced cut inside a CJK word. Not beside a short word or
        // number ("Tokyo", "2024 年"): that one stays balanced into its sentence.
        if (mixed && a <= cpl && b <= cpl * (n - 1) && Math.min(runLen[i - 1], width(lo, i)) > 6 && runLen[i] > 6) {
          s += 5;
        }
      }
      // Inside a Thai-like phrase or a short CJK word of spaced text ("東京 tower"): a fallback
      // seam only — it loses to every space that keeps both lines within the cap (more than any
      // balance or break score); when no space fits, every space seam already carries -1000.
      // A longer CJK run is a sentence, and its seams balance against the spaces (only a
      // phrase space between two longer runs gets the small bonus above).
      else if (gaps.length && (runLen[i] <= 6 || BRK_SYL.test(edgeChar(toks[i], false)))) s -= 100;
      s -= Math.abs(a - target) * 0.6;
      if (a <= b / (n - 1)) s += 4; // bottom-heavy
      if (s > best) {
        best = s;
        bi = i;
      }
    }
    if (
      bi === lo + 1 &&
      (UNSPACED.test(toks[lo]) || BRK_SYL.test(toks[lo]) ? width(lo, bi) + reserve : width(lo, bi)) > cpl &&
      units(toks[lo]).length >= 2
    ) {
      // One over-long token on its own line (a CJK run before a Latin word): it
      // wraps per character too, not just a trailing one. A spaced-script word
      // pushed over only by the name prefix stays whole; an unspaced run has no
      // word to protect (CJK or Thai-like), so it still wraps to fit the prefixed line.
      out.push(...wrapTokens(units(toks[lo]), [], cpl, toks[lo].length + reserve, reserve));
    } else out.push(join(lo, bi));
    lo = bi;
    reserve = 0;
    len = width(lo, T);
    if (len <= cpl) return [...out, join(lo, T)];
    if (T - lo < 2) {
      // One over-long word left: it wraps per character (brackets kept with theirs).
      const chars = units(toks[lo]);
      return chars.length < 2 ? [...out, toks[lo]] : [...out, ...wrapTokens(chars, [], cpl, len, 0)];
    }
  }
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
  const L = trackLimits(result, o, "orig");
  const timedIds = new Set((result.timedTracks ?? []).map((t) => t.id));
  const mtLangs = tracks.filter((t) => t !== "orig" && !timedIds.has(t));
  const own: Record<string, Cue[]> = {};
  const ownMt = !!o && o.timing === "own";
  if (ownMt) for (const l of mtLangs) own[l] = [];
  // The original itself and same-timed translations show its split; own-timed ones
  // only read where it pauses.
  const needMine = tracks.includes("orig") || (!ownMt && mtLangs.length > 0);
  const needSplit = needMine || (ownMt && mtLangs.length > 0);
  const cues: Cue[] = [];
  // Each own-timed language's limits, worked out once rather than per segment
  // (a Map, so a language code like "constructor" stays an ordinary key).
  const mtLim = new Map<string, CueLimits>();
  if (ownMt) for (const l of mtLangs) mtLim.set(l, trackLimits(result, o, l)!);

  segs.forEach((seg, si) => {
    const toks = ranges && L ? tokensOf(seg.text, words.slice(ranges[si][0], ranges[si][1])) : null;
    const split = toks && L && needSplit
      ? timedPieces(seg.text, toks, seg.start, seg.end, { ...L, reserve: reserve(seg) })
      : null;
    const pieces = split && needMine ? split : [{ start: seg.start, end: seg.end, text: seg.text.trim() }];
    const mine: Cue[] = pieces.map((p) => ({ seg: si, ...p, speaker: seg.speaker, tr: {} }));
    // Spoken stretches: the original's cues joined until it shows a gap (a pause
    // timedPieces left open), so an own-timed translation never runs over silence.
    const spans = split && ownMt ? stretchesOf(split) : [];
    for (const lang of mtLangs) {
      const t = trText(seg, lang);
      if (t === null) continue;
      if (ownMt) {
        const LL = { ...mtLim.get(lang)!, reserve: reserve(seg) };
        if (!spans.length) {
          own[lang].push({ seg: si, start: seg.start, end: seg.end, text: t, speaker: seg.speaker, tr: {} });
          continue;
        }
        const texts = cutByShare(t, spans.map((sp) => sp.len));
        spans.forEach((sp, k) => {
          if (!texts[k]) return;
          const parts = timedPieces(texts[k], spreadTokens(texts[k], sp.start, sp.end), sp.start, sp.end, LL);
          own[lang].push(...parts.map((p) => ({ seg: si, ...p, speaker: seg.speaker, tr: {} })));
        });
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
  const t = ownProp(seg.translations, lang)?.trim();
  return t ? t : null;
}

/** The timed lines one track will show: its own cues when own-timed, else the
 *  shared cues (original text, or that language's cut). */
export function trackCues(
  grid: CueGrid, track: string,
): { start: number; end: number; text: string; seg: number; speaker?: string }[] {
  const own = ownProp(grid.own, track);
  if (own) return own;
  // Speaker kept like own-timed cues keep it, so a shared-cue lane still prefixes "Name: ".
  return grid.cues
    .map((c) => ({
      start: c.start,
      end: c.end,
      seg: c.seg,
      ...(c.speaker ? { speaker: c.speaker } : {}),
      text: track === "orig" ? c.text : (ownProp(c.tr, track) ?? ""),
    }))
    .filter((c) => c.text);
}

/** A result's site track by id (undefined for the original and machine translations). */
export function timedTrack(result: Pick<BatchResult, "timedTracks">, id: string): TimedTrack | undefined {
  return result.timedTracks?.find((t) => t.id === id);
}

/** The language code a track is filed under: the transcript's for the original, a site
 *  track's own, the target code otherwise — "und" when unknown. "Unknown" is judged on the
 *  SANITIZED code (langText, as the viewer's row tag does): a code of only format marks or
 *  joiners would otherwise survive here, then draw blank in every chip, summary and track title. */
export function trackLang(result: Pick<BatchResult, "language" | "timedTracks">, track: string): string {
  const tt = timedTrack(result, track);
  const raw = ((tt ? tt.lang : track === "orig" ? result.language : track) ?? "").trim();
  return langText(raw, 16).trim() ? raw : "und";
}

/** Cues as a BatchResult, so the existing generators render them unchanged:
 *  one segment per cue, translations from the cut (or one own-timed track). */
export function cueResult(result: BatchResult, grid: CueGrid, ownTrack?: string): BatchResult {
  const segs = result.segments ?? [];
  if (ownTrack) {
    return {
      ...result,
      segments: (ownProp(grid.own, ownTrack) ?? []).map((c) => ({
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
