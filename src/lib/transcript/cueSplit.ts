// Subtitle cues from transcript segments. Whisper segments run up to
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
  /** The quote context of its segment around `text` (absent when nothing there bears on a quote
   *  at its edge — quotesIn): wrapLines needs it to pair a quote whose partner lies in the next
   *  cue of the same segment. */
  q?: QuoteCtx;
  /** The same per translation in `tr`. */
  trq?: Record<string, QuoteCtx>;
}

/** Counted ASCII quotes of each kind (quoteFlags). */
export type QuoteCount = Record<'"' | "'", number>;
/** The counted ASCII quotes of a segment's text before and after one cue's (or part's) text.
 *  mixedTokens judges a glued quote by the quotes around it, and a cue's text is a substring:
 *  counted over the cue alone, an opening quote whose partner fell into the next cue of the
 *  segment had none, and the cue or line ended on it. */
export interface QuoteCtx {
  before: QuoteCount;
  after: QuoteCount;
  /** The segment's characters right before and after the text, when an ASCII letter or digit:
   *  quoteFlags judges a quote at its edge by them (an inch mark after the 6 of the cue before),
   *  as the segment's own count does. */
  prev?: string;
  next?: string;
  /** Whether, in the segment after the text, a ” closes a “ (no “ or „ first) and a ’ closes a
   *  ‘ (singleCloses): quoteSeams moves a “ or ‘ glued to a word onto the quotation it opens only
   *  when its closer comes, and a cue cut inside the quotation holds none. */
  closes?: { double?: true; single?: true };
  /** Whether a German „ or ‚ before the text is still open: its “ or ‘ closes it, opening nothing. */
  lowOpen?: { double?: true; single?: true };
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
  // Anchored to a run's first mark: unanchored, every mark of a long run would restart the scan.
  const t = s.replace(/(?<!\p{M})\p{M}+$/u, "");
  const lo = t.charCodeAt(t.length - 1);
  return t.slice(lo >= 0xdc00 && lo <= 0xdfff ? -2 : -1);
}
/** A blank (not a line break) between two unspaced characters: a phrase space. */
const PHRASE_SPACE = new RegExp(
  `(?:${UNSPACED.source}|${UNSPACED_PUNCT.source})[^\\S\\n]+(?:${UNSPACED.source}|${UNSPACED_PUNCT.source})`,
  "u",
);
/** The phrase punctuation a punctuated CJK text carries and the unpunctuated convention drops:
 *  。 and ， (halfwidth ｡ too) anywhere in a line. */
const CJK_PHRASE_MARK = /[。，｡]/u;
/** 、 is zh's enumeration mark (kept by the unpunctuated convention) but ja's phrase comma: it
 *  counts in a line with kana, or ending a line. */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Whether a line holds a mark of `marks` with more CJK text after it. Only the first mark is
 *  looked at — if any has CJK text after it, so does the first — so a long line stays linear. */
function markInside(l: string, marks: RegExp): boolean {
  const i = evidenceMark(l, marks);
  return i >= 0 && UNSPACED.test(l.slice(i + 1));
}

/** The closing quote of each opener a speech quotation after a colon may start with. */
const QUOTE_CLOSE: Record<string, string> = { "“": "”", "「": "」", "『": "』", '"': '"', "‘": "’", "«": "»", "„": "“" };

/** Where a line's first mark of `marks` sits, or -1 when there is none or it is no evidence: the
 *  credit, note and title shapes an unpunctuated file still writes ("翻译：小明。字幕：小红",
 *  "（注：……。）", "《三体。黑暗森林》") — a mark after a colon or inside brackets. A colon that
 *  opens a quotation (他问：“你好，…”) is no credit field: its marks count. */
function evidenceMark(l: string, marks: RegExp): number {
  const i = l.search(marks);
  if (i < 0) return -1;
  const before = l.slice(0, i);
  // A quote closed before the mark (字幕：「XX字幕组」。) is a credit's name, but only when every
  // colon's quote is closed: one still open holds the mark, whether a second speaker's
  // (甲问：“好吗” 乙答：“好的，…”) or an outer one around a closed inner quote (他说：“她说：‘好’，…”).
  // One lastIndexOf per closer: a line of many colons stays linear.
  const lastClose = new Map<string, number>();
  let quoted = false;
  let inside = false;
  for (const m of before.matchAll(/[：:]\s*(.)?/gsu)) {
    const close = m[1] === undefined ? undefined : QUOTE_CLOSE[m[1]];
    if (close === undefined) return -1;
    let at = lastClose.get(close);
    if (at === undefined) lastClose.set(close, (at = before.lastIndexOf(close)));
    quoted = true;
    if (at < m.index + m[0].length) inside = true;
  }
  if (quoted && !inside) return -1;
  const open = (o: string, c: string) => before.lastIndexOf(o) > before.lastIndexOf(c);
  return open("（", "）") || open("(", ")") || open("《", "》") || open("〈", "〉") ? -1 : i;
}
/** Whether a text's line breaks between two CJK characters are wraps, not phrase separators,
 *  judged on its lines: at least one in eight of the lines holding CJK text carry a phrase mark
 *  (。， or a ja 、) with more CJK text after it, or at least a quarter carry one anywhere (、
 *  ending a line too) — sentences may end on ？！」, and a wrap rarely lands right after a
 *  mark — and no line holds a phrase space (unpunctuated subtitles drop 。，、 and separate
 *  phrases with the break; Whisper's phrase-spaced text and our exports of it wrap at a space
 *  and drop it). ？！：； do not count: the unpunctuated convention keeps them. A credit, note
 *  or title line ("翻译：小明。字幕：小红", "（注：……。）") is no evidence at all, and one other
 *  stray mark does not flip a file of more than a few cues. Judged on the whole file (import)
 *  or the whole edited segment — a rule per line would read one file both ways. */
export function cjkWrapsLines(lines: Iterable<string>): boolean {
  let cjk = 0;
  let marked = 0;
  let inside = 0;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l || !UNSPACED.test(l)) continue;
    if (PHRASE_SPACE.test(l)) return false;
    cjk++;
    // The unpunctuated convention never writes a mark with CJK text after it, so one line in
    // eight suffices.
    if (markInside(l, CJK_PHRASE_MARK) || (KANA.test(l) && markInside(l, /[、､]/u))) inside++;
    if (
      evidenceMark(l, CJK_PHRASE_MARK) >= 0 ||
      evidenceMark(l, /[、､]$/u) >= 0 ||
      (KANA.test(l) && evidenceMark(l, /[、､]/u) >= 0)
    )
      marked++;
  }
  return (inside > 0 && inside * 8 >= cjk) || (marked > 0 && marked * 4 >= cjk);
}
/** `cjkWrapsLines` for one text (an edited segment). */
export function cjkWraps(s: string): boolean {
  return cjkWrapsLines(s.split("\n"));
}
/** Opening and closing quotation marks (“ ” ‘ ’ « », and ASCII " ' — Po, which Whisper and
 *  our exports write too): not unspaced themselves, but Chinese text sets them with no space
 *  around. */
const QUOTE_MARK = /[\p{Pi}\p{Pf}"']/u;
/** Whether a wrapped line's end (`end`) or the next line's start is unspaced at a seam: its edge
 *  character, or — past a run of quotation marks there — the character beyond the run, so
 *  "他说：" / "“我们走吧。”" and "…。”" / "然后…" join like any CJK seam while "“hi”" / "然后"
 *  keeps its space. A line of quotes only is not. */
export function seamUnspaced(s: string, end: boolean): boolean {
  const c = edgeChar(s, end);
  if (!QUOTE_MARK.test(c)) return unspacedChar(c);
  // Anchored to the run's first quote at the end, so a long run is scanned once.
  const rest = end ? s.replace(/(?<![\p{Pi}\p{Pf}"'])[\p{Pi}\p{Pf}"']+$/u, "") : s.replace(/^[\p{Pi}\p{Pf}"']+/u, "");
  const n = edgeChar(rest, end);
  return !QUOTE_MARK.test(n) && unspacedChar(n);
}
/** Whether the word at the edge of `s` (its end with `end`) — the run of characters that are
 *  neither blank nor unspaced — is glued to an unspaced character on its far side: "是100" and
 *  "17日" are, "有 25" and "300 个" (Whisper's spaced numbers) and a word at the text's edge are not.
 *  Nor is a word that fills a wrapped line of its own: our wrap of the glued "达到了1234567890元"
 *  and of Whisper's spaced "达到了 1234567890 元" both read "达到了" / "1234567890" / "元", and the
 *  spaced style keeps its spaces (the glued one regains two). */
function wordGlued(s: string, end: boolean): boolean {
  const cs = Array.from(s);
  if (!end) cs.reverse();
  let i = cs.length;
  while (i > 0 && !/\s/.test(cs[i - 1]) && !unspacedChar(cs[i - 1])) i--;
  return i > 0 && !/\s/.test(cs[i - 1]);
}
/** Whether the break between a wrapped line ending in `before` and the next one starting with
 *  `after` takes no space back in a text that wraps its CJK lines (`cjkWraps`): both edges are
 *  unspaced (`seamUnspaced`), or one is and the other is a letter or digit of a word glued into
 *  the CJK text on its far side too — wrapLines wraps such a word at that seam ("2025年10月" /
 *  "17日", "今日はMicrosoft" / "の会議"), and CJK text sets no space there. A word spaced on its far
 *  side ("有 25" / "个人", "有" / "300 个", "讨论 AI" / "的") is Whisper's spaced style, whose wrap
 *  dropped a space: it keeps one, as a word on a wrapped line of its own does (`wordGlued`). */
export function wrapSeamUnspaced(before: string, after: string): boolean {
  const a = seamUnspaced(before, true);
  const b = seamUnspaced(after, false);
  return (a && b) || (a && /^[\p{L}\p{N}]/u.test(after) && wordGlued(after, false))
    || (b && /[\p{L}\p{N}]$/u.test(before) && wordGlued(before, true));
}
/** Text with every line break (and the blanks around it) folded into one space — the
 *  subtitle import, the edit commit and every export flatten alike — or, with `wraps` (see
 *  `cjkWraps`), into nothing at an unspaced seam (`wrapSeamUnspaced`). A match starts only at a
 *  blank run's first character, so a long run is scanned once. Each side is seen 24 characters
 *  deep: enough to see past a number at the seam to what it is glued to. */
export function joinLineBreaks(s: string, wraps = false): string {
  if (!s.includes("\n")) return s;
  return s.replace(/(?<![^\S\n])[^\S\n]*\n\s*/g, (m: string, off: number, str: string) =>
    wraps && wrapSeamUnspaced(str.slice(Math.max(0, off - 24), off), str.slice(off + m.length, off + m.length + 24))
      ? ""
      : " ",
  );
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
  // Thai "His Excellency": a title, like "dr.", goes with the name after it.
  "ฯพณฯ",
]);
const ABBREV = new Set([
  "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "vs.", "etc.", "e.g.", "i.e.", "no.", "nr.",
  "z.b.", "usw.", "bzw.", "ca.", "d.h.", "u.a.", "evtl.", "ggf.", "inkl.", "mme.", "m.",
]);
/** The titles and number abbreviations of ABBREV: each goes with the name or number after it
 *  ("Prof. Johnson", "Nr. 5"). Not "etc." or "z.B.", after which a piece may end. */
const TITLE_ABBREV = new Set(["dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "no.", "nr.", "mme.", "m."]);

/** A sentence or clause end, for the original's splitter (breakScore) and the cut of a translation
 *  onto its cues (cutByShare) alike: the mark may sit inside closing quotes or brackets
 *  ('now." Then', '。」然后'). Arabic/Urdu (؟ ۔ ، ؛), Devanagari (। ॥), Armenian (։), Ethiopic
 *  (። ፧ ፣ ፤), Khmer (។ ៕ ៖), Burmese (။ ၊) and Tibetan (། ༎) write their own marks. */
const SENT_END = /[.?!…。？！؟۔।॥։።፧។៕။།༎](["'»”’)\]」』）】〉》]*)$/;
const CLAUSE = /[,;:–—、，；：،؛፣፤၊៖]["'»”’)\]」』）】〉》]*$/;
/** A Japanese quote the sentence goes on from (「帰ろう。」と言った): the mark inside the
 *  bracket ends the quote, not the sentence — no seam bonus there. */
const quoteGoesOn = (before: string, after: string): boolean =>
  /[」』）】〉》]$/u.test(before) && /^(?:と|って)/u.test(after);

interface SentenceCut { next: string; lang?: string; prev?: string }
/** A capital and its stop: an initial ("F."), or a letter that ends a sentence ("plan B."). Not
 *  the Roman numerals I, V and X: "World War I. After that" ends one. */
const INITIAL = /^(?![IVX])\p{Lu}\.$/u;
/** Capitals each with its stop, written together: a name's initials ("J.K.") or an initialism ("U.S."). */
const CAP_INITIALS = /^(?:\p{Lu}\.){2,}$/u;
/** Place and country initialisms, which follow a capitalised place name or a comma as a name's
 *  initials follow a first name ("Washington D.C.", "Los Angeles, L.A.") but are never a name's
 *  initials: before a capital they end a sentence whatever the word before them ("Washington D.C.
 *  Today", "the U.K. Government"). */
const PLACE_INITIALS = new Set(["U.S.", "U.S.A.", "U.K.", "D.C.", "N.Y.", "N.Y.C.", "L.A.", "E.U.", "U.N.", "U.A.E.", "U.S.S.R."]);
/** A name's initial ("F.") or compact initials ("J.K.", "R.R."), as written: not a place initialism. */
const nameInitials = (raw: string): boolean => INITIAL.test(raw) || (CAP_INITIALS.test(raw) && !PLACE_INITIALS.has(raw));
/** `w` past the opening brackets and quotes glued to its front: "(Dr." is judged as "Dr.", "“3." as "3.". */
const unopened = (w: string): string => w.replace(/^[^\p{L}\p{N}]+/u, "");
/** An I, V or X and its stop right after another initial is a name's ("J. V. Stalin", "Lisa M. I.
 *  Brown"): a Roman numeral follows a word ("World War I.", "Henry V."). `prev` = the word before. */
const initialAfter = (raw: string, prev?: string): boolean =>
  /^[IVX]\.$/.test(raw) && INITIAL.test(unopened(prev ?? ""));
/** The word before text[..at), within a bounded look-back. */
const wordBefore = (text: string, at: number): string =>
  text.slice(Math.max(0, at - 24), at).trimEnd().split(/\s/).pop() ?? "";
/** The word after text[at..), within a bounded look-ahead. */
const wordAfter = (text: string, at: number): string => text.slice(at, at + 24).trimStart().split(/\s/)[0];

/** Languages that capitalise every noun: the capitalised word before a capital and its stop
 *  ("Plan B. Dann") says nothing of a name there. */
const NOUN_CAPS = new Set(["de", "lb"]);
/** Closed-class words that open a sentence but hardly ever a surname, by base language ("Option
 *  B. Then", "Gate A. The plane", "Plan B. What", "Gate B. Your flight" end one): articles,
 *  pronouns, conjunctions, question words, possessives, quantifiers, common prepositions and
 *  answers. A word that is also a common surname stays out (Son, Su, Sim, Im, Como, Dove,
 *  Haar), so the name's initial before it is still held. A language not listed checks against
 *  them all. */
const SENT_OPENER = new Map(Object.entries({
  en: "the a an then after but so and or we i it it's this that that's there there's he she they you if when now next later " +
    "what what's how why where who which my your our his her their its many some all " +
    "yes no okay ok please let's well in for on at with",
  de: "der die das dann danach aber und wir ich es er sie du wenn jetzt ein eine man " +
    "was wie warum wo wer welche welcher welches wann mein meine dein deine unser unsere ihre " +
    "ja nein bitte in mit für auf nach",
  fr: "le la les puis mais et nous je il elle on ensuite alors un une ce ne se si me te " +
    "que quoi comment pourquoi où qui quel quelle quand mon mes sa ses notre nos votre vos leur leurs " +
    "oui non dans pour sur avec chez sans",
  es: "el la los las luego pero y nosotros yo él ella ellos entonces después un una si " +
    "qué cómo por dónde quién cuál cuándo cuando mi mis tus sus nuestro nuestra " +
    "sí no en para con sobre",
  it: "il lo la le gli poi ma e noi io lui lei loro allora dopo un una se ci " +
    "che cosa come perché quale quando mio mia miei tuo tua suo sua nostro nostra " +
    "sì no in per con",
  nl: "de het een dan daarna maar en wij we ik hij zij ze je als nu " +
    "wat waarom waar wie welke wanneer mijn jouw ons onze zijn " +
    "ja nee in op met voor",
  pt: "o a os as então depois mas e nós eu ele ela eles um uma se " +
    "que quê porque onde quem qual quando meu minha meus minhas seu sua nosso nossa " +
    "não em para com sem",
}).map(([l, ws]) => [l, new Set(ws.split(" "))]));
const ANY_OPENER = new Set([...SENT_OPENER.values()].flatMap((ws) => [...ws]));
/** The words a Romance elision stands for ("c'" = "ce" or "ci", "l'" = "le"/"la"), by its letters.
 *  Each is an opener of a language that elides it (SENT_OPENER), or the elision matched nothing:
 *  "N'oublie", "S'il", "T'as", "M'a-t-il" and Italian "C'è" read as a surname. Not "d'" or "o'": a
 *  surname's prefix (D'Angelo, O'Brien), so the initial before it is held. */
const ELIDED: Record<string, string[]> = {
  j: ["je"], c: ["ce", "ci"], l: ["le", "la", "lo"], qu: ["que"], n: ["ne"], s: ["se", "si"], m: ["me"], t: ["te"],
};

/** The word `before` a capital and its stop makes it a name's initial: another initial ("J. K.
 *  Rowling") in every language, a capitalised word ("John F. Kennedy") not in a language that
 *  capitalises its nouns ("Plan B. Dann") nor when `after` (the text after the stop) opens with a
 *  sentence opener ("Option B. Then"), a contraction or elision of one too ("Plan B. I'm", "Plan
 *  B. C'est"). With no word before it, or one ending on a clause or sentence mark, the opener
 *  alone decides, in every language: "In 1924, J. Edgar Hoover", "Er sagte es. J. Edgar" and a
 *  text-initial "F. Scott" hold, "Answer: A. How" and a text-initial "B. Then" or "B. Dann" end
 *  one. */
function nameBefore(before: string, after: string, lang?: string): boolean {
  const b = unopened(before);
  if (INITIAL.test(b)) return true;
  if (b !== "" && !CLAUSE.test(b) && !SENT_END.test(b) && !/^\p{Lu}/u.test(b)) return false;
  const base = primarySubtag(lang);
  if (NOUN_CAPS.has(base) && b !== "" && !CLAUSE.test(b) && !SENT_END.test(b)) return false;
  // Another initial after it makes a name, as in isSentenceEnd: stripped of its stop below, the
  // "A." of "Mary | J. A. Smith" would read as the article opening a sentence.
  if (/^\p{Lu}\.$/u.test(after.split(/\s/)[0])) return true;
  const w = after.split(/\s/)[0].replace(/’/g, "'").replace(/^[^\p{L}]+|[^\p{L}']+$/gu, "").toLowerCase();
  const opener = SENT_OPENER.get(base) ?? ANY_OPENER;
  if (opener.has(w)) return false;
  // A contraction opens one as its pronoun does ("Plan B. I'm", "Gate B. You'll", "Option B.
  // We're"), an elision as its article or pronoun does ("Plan B. C'est", "J'ai", "L'idée").
  const head = w.replace(/'(?:m|ll|ve|d|re|s)$/, "");
  const el = /^(j|c|l|qu|n|s|m|t)'\p{L}/u.exec(w)?.[1];
  return !((head !== "" && opener.has(head)) || (el !== undefined && ELIDED[el].some((x) => opener.has(x))));
}

/** Languages that write an ordinal with a dot ("am 3. Mai"), by base subtag. */
const DOTTED_ORDINAL = new Set([
  "de", "da", "nb", "nn", "no", "fi", "is", "fo", "cs", "sk", "pl", "hu", "tr", "sl", "hr", "sr", "bs", "et", "lv",
]);
/** A dotted ordinal of up to three digits ("am 3. Mai", "den 100. Geburtstag"); a four-digit
 *  year ("seit 1980.") still ends a sentence. A sentence ending on a number of up to three digits
 *  ("Er wurde 100. Dann") reads as an ordinal too: the words alone cannot tell the two apart. */
const ORDINAL = /^\d{1,3}\.$/;

/** A lowercase "m." or "ms.": the unit ("300 m.", "5 ms."), not the title "M." or "Ms.". */
const isUnit = (raw: string): boolean => raw === "m." || raw === "ms.";
/** A number running on into its unit ("1995 | m. birželio", "5 | ms."): the seam dangles as one
 *  after an article does — the unit itself no longer holds the word after it. */
const beforeUnit = (prev: string, next: string): boolean =>
  /\d$/.test(prev) && /^ms?\.(?![\p{L}\p{N}])/u.test(next);

/** `cut` = the text after the stop, the track's language and the word before `word`, as the cue
 *  split, the line wrap and the translation cut all know them. "no."/"nr." abbreviate only
 *  before a number ("No. 5") — "I said no." and "Yo creo que no." end a sentence — and "12." is an ordinal
 *  only in a language that dots them ("He was 12." ends one; an unknown language or "und":
 *  an ordinal). A dotted initialism ("U.S.", "a.m.") and a unit ("300 m.", "5 ms.") end one
 *  only before a capital: "the U.S. government", "9 a.m. in the office", "300 m. away" go on.
 *  Before a capital, a name's initial or initials ("John F. Kennedy", "J. K. Rowling", "George
 *  R.R. Martin") go on when another initial is next to it or nameBefore holds; a place
 *  initialism (PLACE_INITIALS: "Washington D.C. Today", "The U.S. Army") and initials after a
 *  lowercase word ("by J.K. Rowling") end one. */
function isSentenceEnd(word: string, cut?: SentenceCut): boolean {
  if (!SENT_END.test(word)) return false;
  // Judged past the opening brackets and quotes glued to its front: "(Dr." and "“Mr." are
  // abbreviations, "(3." an ordinal, as their bare spellings are.
  const raw = unopened(word);
  const w = raw.toLowerCase();
  // Only the capitalised "M." and "Ms." are titles: "300 m." and "5 ms." are units, which end
  // one only before a capital or the end of the text, as a dotted initialism does below.
  const unit = isUnit(raw);
  if (unit && cut && /^\p{Ll}/u.test(cut.next)) return false;
  if (ABBREV.has(w) && !unit && !(cut && (w === "no." || w === "nr.") && !/^\d/.test(cut.next))) return false;
  if (cut && /^(?:\p{L}\.){2,}$/u.test(w) && /^\p{Ll}/u.test(cut.next)) return false;
  if (
    cut && (nameInitials(raw) || initialAfter(raw, cut.prev)) && /^\p{Lu}/u.test(cut.next) &&
    (/^\p{Lu}\.(?:\s|$)/u.test(cut.next) || nameBefore(cut.prev ?? "", cut.next, cut.lang))
  ) return false;
  const base = primarySubtag(cut?.lang);
  if (base && base !== "und" && !DOTTED_ORDINAL.has(base)) return true;
  return !ORDINAL.test(w);
}

/** Whether `word` is a title or number abbreviation, a dotted ordinal or a name's initial or
 *  initials, that isSentenceEnd holds no sentence end here ("Ms. Johnson", "Nr. 5", "am 3. Mai",
 *  "John F. Kennedy", "J.K. Rowling"): it dangles as an article does. Judged by isSentenceEnd,
 *  not listed in NOBREAK: "I said no. Then" ends one. A place initialism ("D.C.", "U.S.") is
 *  never held: before a lowercase word it ends no sentence but holds nothing either, as "a.m."
 *  does ("the U.S. government"). */
function heldAbbrev(word: string, cut: SentenceCut): boolean {
  if (!SENT_END.test(word) || isSentenceEnd(word, cut)) return false;
  const raw = unopened(word);
  const w = raw.toLowerCase();
  // A unit running on ("300 m. away") is no title either: held, it came back as "300 | m. away".
  return (TITLE_ABBREV.has(w) && !isUnit(raw)) || ORDINAL.test(w) || INITIAL.test(raw) ||
    ((nameInitials(raw) || initialAfter(raw, cut.prev)) && /^\p{Lu}/u.test(cut.next));
}

/** A capitalised word running on into a name's initial or compact initials ("John | F. Kennedy",
 *  "George | R.R. Martin"): the seam inside the name dangles as the one after the initials does.
 *  "a plan | B.", "the | U.S. Army", "Option | B. Then" and "Plan | B. Dann" do not (nameBefore),
 *  nor a place initialism, which is no name's ("Washington | D.C. Today").
 *  `after` = the text after the initials, `lang` the track's. */
const beforeInitial = (prev: string, next: string, after: string, lang?: string): boolean => {
  const x = unopened(next.split(/\s/)[0]);
  return !SENT_END.test(prev) && !CLAUSE.test(prev) && nameInitials(x) && nameBefore(prev, after, lang);
};

const bare = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'.]+$/gu, "");

/** Score of breaking between `prev` and `next` (words as written) in a text of `lang`; `before` =
 *  the word before `prev`, `after` the one after `next`. */
function breakScore(prev: string, next: string, lang?: string, before?: string, after = ""): number {
  let s = 0;
  const quoted = quoteGoesOn(prev, next);
  const cut = { next, lang, prev: before };
  if (!quoted && isSentenceEnd(prev, cut)) s += 100;
  else if (!quoted && CLAUSE.test(prev)) s += 40;
  // Only a word running on into the next one dangles ("Mr." still does), hence the else: bare()
  // drops a clause comma, so "turn the lights on," would otherwise count as a dangling "on".
  else if (NOBREAK.has(prev.toLowerCase()) || NOBREAK.has(bare(prev)) || heldAbbrev(prev, cut) || beforeInitial(prev, next, after, lang) || beforeUnit(prev, next)) s -= 80;
  // A spaced "&" is an "and" (Procter & Gamble): the seam goes before it, as before "and".
  if (CONJ.has(bare(next)) || next === "&") s += 20;
  return s;
}

interface Tok {
  /** Char span in the segment text. */
  from: number;
  to: number;
  s: number;
  e: number;
  /** Cached breakScore of the gap before this token — it depends only on the two
   *  adjacent tokens and the words either side, read from the text, which every recursion level
   *  of splitTokens shares. */
  bs?: number;
  /** An opening quote split off the word it was glued to (tokensOf): no cue ends on it. */
  opens?: boolean;
}

/** Word timings mapped onto char spans of `text`; null when the words don't
 *  line up with the text (the segment then stays whole). Each span runs to the
 *  next word, so punctuation between words never falls out of a cue. */
function tokensOf(text: string, words: { word: string; start: number; end: number }[]): Tok[] | null {
  if (!words.length) return null;
  const out: Tok[] = [];
  let cur = 0;
  let flags: boolean[] | undefined;
  for (const w of words) {
    const tw = w.word.trim();
    if (!tw) continue;
    const at = text.indexOf(tw, cur);
    if (at < 0 || !/^[\s\p{P}]*$/u.test(text.slice(cur, at))) return null;
    if (out.length) {
      const pv = out[out.length - 1];
      pv.to = at;
      // A split-off opener starts with the word it opens: a pause before that word then
      // falls on the seam before the opener, the one a cut may take.
      if (pv.opens) pv.s = pv.e = Math.max(pv.s, w.start);
    }
    const tok: Tok = { from: at, to: at + tw.length, s: w.start, e: Math.max(w.start, w.end) };
    out.push(tok);
    cur = at + tw.length;
    // Whisper glues a quote to the word before it (」" ”", after a colon or comma: 说：" 说，"
    // me:", or a Latin word or number: AI", unless it may close an uncounted one: skippedOpener;
    // or an ASCII quote that closes the quotation before it: "你好"", as quoteSeams cuts there):
    // when it opens the next quotation (an even count of its kind so far, a later
    // partner, a letter, digit or opener right after it), it is a token of its own, so the cut never lands right
    // after it. Its clock is a zero-length one at the next word's start (the word's end until
    // that word arrives): a cue starting with it starts once that word is spoken.
    const qm = /(?:[\p{Pe}\p{Pf}\p{L}\p{N}]|(?!["'])\p{Po}|(["']))(["'])$/u.exec(tw);
    if (qm && /[\p{L}\p{N}\p{Ps}\p{Pi}]/u.test(edgeChar(text.slice(cur, cur + 2), false))) {
      flags ??= quoteFlags(text);
      const j = cur - 1;
      let n = 0;
      /** Counted quotes of the glued ASCII quote's kind (qm[1]) through it: even when it closes one. */
      let np = 0;
      let later = false;
      for (let x = 0; x < text.length; x++) {
        if (!flags[x]) continue;
        if (text[x] === qm[2]) { if (x < j) n++; else if (x > j) later = true; }
        if (x < j && text[x] === qm[1]) np++;
      }
      if (flags[j] && n % 2 === 0 && later && (!qm[1] || (flags[j - 1] && np % 2 === 0))
        && !(/[\p{L}\p{N}]/u.test(text[j - 1]) && skippedOpener(text, flags, j))) {
        tok.to = j;
        out.push({ from: j, to: cur, s: tok.e, e: tok.e, opens: true });
      }
    }
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
const VOWEL_TRAILS = "\\u0e30\\u0e32\\u0e33\\u0e45\\u0eb0\\u0eb2\\u0eb3";
/** The Thai/Lao/Khmer repetition marks and the Thai abbreviation mark (ๆ ໆ ៗ ฯ — letters too,
 *  not punctuation): ONE sticks to the character before it, as one ー does — a whole
 *  มากๆๆๆ… (emphasis, or a Whisper repetition loop) glued into one unit could not wrap or cut
 *  and ran over the cap. A ฯ after a space opens a word (ฯพณฯ, ฯลฯ) and is no tail at all. */
const REPEATS = "\\u0e2f\\u0e46\\u0ec6\\u17d7";
const REPEAT = `(?:(?<![${REPEATS}])[${REPEATS}])?`;
const TRAILS = VOWEL_TRAILS + REPEATS;
/** Burmese/Khmer stacking viramas: the consonant after one is stacked under the one before. */
const STACKERS = "\\u1039\\u17d2";
const LEAD_OR_STACKER = new RegExp(`[${LEADS}${STACKERS}]`);
const VOWEL_TRAIL = new RegExp(`[${VOWEL_TRAILS}]`);
const REPEAT_AT = new RegExp(`[${REPEATS}]`);
/** A word of spaced text that is only closers, stops or TRAILS ("»", "?", Thai "บ่อย ๆ"):
 *  it stays with the word before it. Not the symbol-like \p{Po} (& @ # * / \ § ¶): the "&" of
 *  "Procter & Gamble" is a conjunction, and glued back it tore the name at "Procter & / Gamble". */
const NOT_SYMBOL = "(?![&@#*/\\\\§¶])";
const LONE_CLOSER = new RegExp(`^(?:${NOT_SYMBOL}[\\p{Pe}\\p{Pf}\\p{Po}${TRAILS}])+$`, "u");
const LONE_CLOSER_AHEAD = new RegExp(`^(?:${NOT_SYMBOL}[\\p{Pe}\\p{Pf}\\p{Po}${TRAILS}])+(?:\\s|$)`, "u");
/** A Burmese consonant killed by asat (န် ယ် င့်) or a Khmer one by bantoc (ប់): the final
 *  consonant of the syllable before it, so it sticks to that one — ရန်ကုန် wrapped as ရ / န်ကုန်. */
const KILLED = "[\\u1000-\\u1021](?=\\u1037?\\u103a)|[\\u1780-\\u17a2](?=\\u17cb)";
const KILLED_AT = new RegExp(`^(?:${KILLED})`);
/** What rides after a base character: combining marks, emoji skin tones, Thai/Lao following
 *  vowels, a halfwidth voicing mark (ﾞ ﾟ — a letter, not a mark, so it rides before a
 *  following ｰ: ﾃﾞｰ, never ﾃﾞ / ｰ), ZWJ + next, a stacking virama + the consonant it stacks,
 *  a killed Burmese/Khmer consonant, then an optional repetition mark (REPEAT). */
const UNIT_TAIL = `(?:[\\p{M}\\p{Emoji_Modifier}\\u200d\\uff9e\\uff9f${VOWEL_TRAILS}]|(?<=[\\u200d${STACKERS}])\\S|${KILLED})*${REPEAT}`;
/** Scripts written without spaces between words that are no CJK (unspacedChar holds
 *  only Han/Kana and CJK punctuation, as the LRC seams need): inside spaced text a run of
 *  them still breaks between its syllables, like a CJK run — else a space-joined
 *  multi-sentence Thai translation is a handful of unsplittable tokens. */
const SYLLABIC = "\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const BRK_SYL = new RegExp(`[${SYLLABIC}]`, "u");
/** A token of spaced text: a word (with any opening brackets before it), or one unspaced
 *  (CJK, Thai…) character with the opening brackets before it and its other punctuation
 *  after it (a Thai/Lao leading vowel rides with the consonant after it) —
 *  so a CJK translation holding one Latin word still splits between its characters, and
 *  never right after a 「 or （ (a Latin word or number before 「 does not swallow it). A
 *  bracket with nothing after it is its own token, so no character falls out of the spans.
 *  The character keeps its combining marks (a decomposed が's U+3099, an ideographic
 *  variation selector) — they are Script=Inherited and would otherwise split off.
 *  A fullwidth letter or digit, a halfwidth kana (with its voicing mark) and a 〜 are such
 *  characters too, as CJK_UNIT has them: swallowed into the token before them, "〜〜〜…" could
 *  neither wrap nor cut. A run of fullwidth letters and digits (with ，．： only between two
 *  digits) is one word, as its halfwidth spelling is:
 *  "２０２６", "１２３，４５６" and "１２：３０" never break in the middle, while the ， of
 *  "ＣＰＵ，ＧＰＵ" or the ： of "ＵＲＬ：" stays a clause seam; a run longer than a line still wraps per
 *  character through `tokenUnits`. Glued to ASCII letters or digits ("ＰＳ5", "ＮＨＫnews")
 *  it stays one word too (mixedTokens joins them): the seam between the two widths is no
 *  word break. A no-break space (one BREAK_SPACE excludes) between two characters of a word is
 *  part of it: "25 000" and "viens ?" are one token, so no own-timed cue or line breaks there. */
const FULLWIDTH = "\\u3000-\\u303f\\uff00-\\uffef";
const FW_ALNUM = "０-９Ａ-Ｚａ-ｚ";
const WORD_CHAR = `[^\\s${OPEN_PUNCT}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー${SYLLABIC}${FULLWIDTH}]`;
const MIXED_TOKEN = new RegExp(
  `[${OPEN_PUNCT}]*[${FW_ALNUM}]${UNIT_TAIL}(?:[${FW_ALNUM}]${UNIT_TAIL}|(?<=[０-９])[，．：](?=[０-９]))*[${CLOSE_PUNCT}]*`
    + `|[${OPEN_PUNCT}]*[${LEADS}]*(?:[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー${SYLLABIC}]|(?![\\s${OPEN_PUNCT}])[${FULLWIDTH}])${UNIT_TAIL}${CHOON}[${CLOSE_PUNCT}]*`
    + `|[${OPEN_PUNCT}]*${WORD_CHAR}+(?:[\\u00a0\\u202f\\u2007]+${WORD_CHAR}+)*`
    + `|[${OPEN_PUNCT}]+`,
  "gu",
);
const OPENER = new RegExp(`[${OPEN_PUNCT}]`, "u");
/** A word break: whitespace but the no-break spaces (U+00A0, U+202F, U+2007) — French sets
 *  them inside "25 000" and before ? ! : ; », and a cut or line break there would split the
 *  number or open a line with the mark. */
const BREAK_SPACE = /[^\S\u00a0\u202f\u2007]/;
const NO_BREAK_RUN = /^[\u00a0\u202f\u2007]+$/;
const BREAK_SPACES = /[^\S\u00a0\u202f\u2007]+/;
/** One code point of whitespace-free text with the opening brackets before it and the
 *  closing brackets/stops after it — the unit unspaced text splits and wraps by, so no
 *  piece or line ends on 「 or starts with 」 or 。. Combining marks, variation selectors,
 *  skin tones and ZWJ sequences ride with their base (a Thai tone mark never opens a line),
 *  a flag's two regional indicators stay one unit, a Thai/Lao leading vowel rides with the
 *  consonant after it and a following vowel with the one before, and a Burmese/Khmer
 *  stacked consonant stays with the virama above it. At most three closers ride along,
 *  as one ー does: a hallucinated "え？？？？…" glued into one unit could not wrap. At most
 *  three openers ride along, as three closers do: uncapped, a hallucinated wall of 「
 *  before a character would be one unit running a line far over the cap. */
const CJK_UNIT = new RegExp(`[${OPEN_PUNCT}]{0,3}[${LEADS}]*(?:\\p{RI}\\p{RI}|\\S)${UNIT_TAIL}${CHOON}[${CLOSE_PUNCT}]{0,3}`, "gu");
const units = (s: string): string[] => s.match(CJK_UNIT) ?? [];
/** The units a token longer than a line wraps by (a URL, an e-mail address, a German
 *  compound, a run of ・): units() with ASCII punctuation kept on its character, as
 *  mixedTokens keeps it — a closer or stop joins the unit before it (up to three of them),
 *  an opener the unit after it, a closing quote or bracket in the token's trailing
 *  punctuation, or a quote glued to a letter or digit, closes it („Hallo“ / „Hallo“, /
 *  „…...“, / „…“-Verband / “…...” / (…...)), and an ASCII quote or a » ” that starts the
 *  token opens it (»…« / ”…”), as Spanish ¿ ¡ do (¿…? / ¡¡…!!), so no line starts with “ ” ) or
 *  ends on „ » " or ¿. `hyphen` false leaves a compound's hyphen a unit of its own (wrapLines,
 *  when ending the line costs one). */
function tokenUnits(w: string, hyphen = true): string[] {
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
  const lead = u.findIndex((x) => !/^[\p{Ps}\p{Pi}\p{Pf}"'¿¡]+$/u.test(x));
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
        // A hyphen inside a compound ends its line: a line opened with "-" reads as a dialogue
        // dash. Not the non-breaking U+2011 nor a dash.
        || (hyphen && /^[-\u2010]$/.test(x) && /[\p{L}\p{N}]/u.test(last) && /^[\p{L}\p{N}]/u.test(u[k + 1] ?? ""))
        // Spanish ¿ ¡ are Po but open what follows them (below), unless they end the token.
        || (/^[\p{Pe}\p{Pf}\p{Po}]/u.test(x) && (k === u.length - 1 || !/^[¿¡]/u.test(x)) && !/\p{P}{6}$/u.test(prev)
          && !(/^(?:[\p{Pe}\p{Pf}]|["'])/u.test(x) ? /(?:[\p{Pi}\p{Pf}\p{Pe}]|["']){3}$/u : /(?:(?!["'])\p{Po}){3}$/u)
            .test(prev)))) out[out.length - 1] += x;
    // An ASCII quote (or a » ” — German »…«, Swedish ”…”) that starts the token or follows its
    // openers opens it: as a closer of nothing it ended a line on a bare " or ». One inside a
    // word (don't, 5'10") rides above.
    else if (
      (/^[\p{Ps}\p{Pi}¿¡]+$/u.test(x) || ((k === 0 || open) && quoteOpens && k < firstWord && /^(?:["']|\p{Pf})$/u.test(x)))
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
/** A cut right before `text[i]` splits a unit: between a base and its combining mark (tested
 *  on the code point: an astral mark such as the variation selector U+E0100 is a surrogate
 *  pair), inside a ZWJ sequence, before a skin tone, inside a Thai/Lao syllable (after a
 *  leading vowel, before a following vowel), inside a Burmese/Khmer consonant stack (right
 *  after the virama), before a killed Burmese/Khmer consonant, or between a flag's two
 *  regional indicators (an odd run of indicators right before i means i is the second half
 *  of a pair). */
function splitsUnit(text: string, i: number): boolean {
  const cp = text.codePointAt(i)!;
  if (/[\p{M}\p{Emoji_Modifier}\u200d]/u.test(String.fromCodePoint(cp)) || text[i - 1] === "\u200d") return true;
  if (LEAD_OR_STACKER.test(text[i - 1]) || VOWEL_TRAIL.test(text[i]) || KILLED_AT.test(text.slice(i, i + 3))) return true;
  // One repetition mark rides (the second of a run is a seam again); a ฯ after a space opens a word.
  if (REPEAT_AT.test(text[i]) && !REPEAT_AT.test(text[i - 1] ?? "")
    && !(text[i] === "\u0e2f" && /^\s?$/.test(text[i - 1] ?? ""))) return true;
  if (!isRI(cp)) return false;
  let n = 0;
  for (let j = i - 2; j >= 0 && isRI(text.codePointAt(j)!); j -= 2) n++;
  return n % 2 === 1;
}
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
 *  it); otherwise it is one word and one token. `q` = the quotes of the segment around
 *  `text` (QuoteCtx). */
function spreadTokens(text: string, a: number, b: number, q?: QuoteCtx): Tok[] {
  const spans: [number, number][] = [];
  if (!/\s/.test(text.trim()) && !BREAKS_ANYWHERE.test(text)) {
    spans.push([0, text.length]);
  } else {
    // The tokens wrapLines and cutByShare use (mixedTokens), spaced or not: an opening
    // bracket rides with the code point it opens, a closer with the one it closes, a glued
    // Latin word stays whole, and so does a word mixing both widths ("ＰＳ5") — matched
    // per MIXED_TOKEN here, an own-timed cue could end on ＰＳ.
    const m = mixedTokens(text, q);
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

/** Limits of one segment's text: `reserve` = chars a "Name: " prefix takes; `q(at, e)` = the
 *  quotes around the piece `text[at, e)` that its cue will carry (Cue.q), absent when the
 *  piece is the whole text the cue's quotes are counted over; `lang` = the text's language,
 *  for where a sentence ends (breakScore). */
type Budget = CueLimits & { reserve: number; q?: (at: number, e: number) => QuoteCtx | undefined; lang?: string };

function fits(text: string, ts: Tok[], L: Budget): boolean {
  const s = sliceOf(text, ts);
  if (s.length + L.reserve > L.cpl * L.lines || ts[ts.length - 1].e - ts[0].s > L.maxDur) return false;
  if (s.length + L.reserve <= L.cpl) return true;
  // Lines break at words, so a slice under lines × cpl characters can still need another
  // line: ask the wrapper itself (only past one line — the cheap test above runs first), with
  // the quotes the export and the Subtitles view wrap the cue with — a glued quote whose
  // partner lies in the next cue tokenises differently without them, and the cue's real
  // wrap took a line more than the one judged here.
  const at = text.indexOf(s, ts[0].from);
  return wrapLines(s, L.cpl, L.lines, L.reserve, L.q?.(at, at + s.length), L.lang).length <= L.lines;
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
      L.lang,
      wordBefore(text, ts[i - 1].from),
      wordAfter(text, ts[i].to),
    ));
    s += gap >= 0.5 ? 150 : 120 * Math.max(gap, 0);
    // Between two syllables of a Thai/Lao/Khmer/Burmese run (no space): a fallback seam, so
    // a spaced line still breaks at its phrase spaces first (cutByShare does the same).
    const at = ts[i].from;
    if (BRK_SYL.test(text[at - 1] ?? "") && BRK_SYL.test(text[at] ?? "")) s -= 40;
    // Never right after an opening bracket or right before a closing one or a stop, as cutByShare
    // and wrapLines: a 「 or 」 Whisper times as a word of its own ended or started a cue. Below
    // every other seam's score (a pause included), so it is taken only when there is no other.
    // Western marks too: a lone opening mark after a space or a closer (" «", " „", ”“), a quote
    // tokensOf split off as an opener, a word of closers and stops alone (" »", " !", ’'), and
    // an English clitic after a closing quote (‘Tokyo’' | s).
    const left = text.slice(ts[i - 1].from, ts[i - 1].to).trimEnd();
    const right = text.slice(at, ts[i].to).trim();
    if (ts[i - 1].opens || OPENER.test(edgeChar(left, true)) || /(?:^|[\s\p{Pe}\p{Pf}])[\p{Ps}\p{Pi}]+$/u.test(left)
      || CLOSE_PUNCT.includes(text[at] || "\0") || /^(?:(?!["'&@#*/\\§¶])[\p{Pe}\p{Pf}\p{Po}])+["']*$/u.test(right)
      || (/[\p{Pe}\p{Pf}]'$/u.test(left) && /^(?:s|t|d|m|ll|re|ve)(?![\p{L}\p{N}])/iu.test(right))) s -= 1000;
    // Nor inside a unit, as wraps and cutByShare: Whisper times Thai/Lao/Burmese per decoded
    // token, so a "word" can be a lone tone mark, following vowel or killed consonant, and a
    // cue opened on a bare mark (a dotted circle) or ended on a leading vowel.
    if (splitsUnit(text, at)) s -= 1000;
    // Both sides read by index: slicing the token array per candidate would make every level O(n²).
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

/** Cut `text` into `shares.length` parts proportional to `shares`, preferring
 *  cuts after sentence/clause punctuation and avoiding one right after an article.
 *  `lang` is the text's language code, for whether "12." can be an ordinal. */
export function cutByShare(text: string, shares: number[], lang?: string): string[] {
  if (shares.length < 2) return [text.trim()];
  const spaced = /\s/.test(text.trim());
  // One word of a spaced script ("Ja."): nothing to cut — it goes to the first part.
  if (!spaced && !BREAKS_ANYWHERE.test(text)) return [text.trim(), ...shares.slice(1).map(() => "")];
  // Unspaced text cuts only between the tokens wrapLines wraps by (mixedTokens), so a
  // glued number, version, e-mail or URL ("3.14159", "1,234,567", "foo@bar.com") stays
  // whole here as it does on a line — its "." or "," would otherwise draw the cut into it.
  let seams: Set<number> | null = null;
  if (!spaced) {
    const m = mixedTokens(text);
    seams = new Set(m.toks.map((w, k) => m.at[k] + w.length));
  }
  // Candidate cut positions: a space (dropped) or, for unspaced text, any of those seams
  // that is a code-point boundary (never inside a surrogate pair, e.g. an emoji). Spaced text
  // may still hold a CJK run (one Latin word in a Japanese line): it cuts between its
  // characters too — a lone surrogate is never UNSPACED, so no pair splits.
  // Never right after an opening bracket (the cut goes before it instead), nor right
  // before a closing bracket or stop (the cut goes after it).
  const cand: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (seams && !seams.has(i)) continue;
    if (OPENER.test(text[i - 1]) || CLOSE_PUNCT.includes(text[i])) continue;
    // Nor before the first ー (or ｰ) after a character (the second ー of a run is a seam again).
    if (/[ーｰ]/.test(text[i]) && !/[ーｰ]/.test(text[i - 1])) continue;
    // Never inside a grapheme or a Thai/Lao/Burmese/Khmer syllable unit.
    if (splitsUnit(text, i)) continue;
    if (
      spaced
        ? BREAK_SPACE.test(text[i])
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
  // could spend the last seam before a glued word and leave the trailing parts empty
  // ("これは|iPhoneProMax|"). A part stays empty only when the text has fewer seams than cuts.
  const nCuts = Math.min(shares.length - 1, cand.length);
  let done = 0;
  let prev = 0;
  /** text[a..b) trimmed holds fewer than two code points — counted in place: slicing and
   *  spreading the part per candidate would make a long text with many shares quadratic per cut. */
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
      // Bounded look-back (NOBREAK words are under 9 chars): slicing and folding the whole
      // prefix per candidate would make unspaced CJK text quadratic.
      const back = text.slice(Math.max(0, i - 9), i);
      const sp = back.lastIndexOf(" ");
      // Past any opening brackets and quotes, so "(Dr." dangles as "Dr." does. Its case kept for
      // isSentenceEnd, which tells the title "M." from the unit "m.".
      const prevCased = sp >= 0 || i <= 9 ? unopened(back.slice(sp + 1)) : "";
      const prevWord = prevCased.toLowerCase();
      // A first name or a number may outrun that window ("Christopher | F. Kennedy", "1,000,000 |
      // m."): the name and unit tests read the whole word, from the wider look-back, as the cue
      // split and the wrap do — an empty word held nothing there.
      const prevWhole = prevCased || (i <= 9 ? "" : unopened(wordBefore(text, i)));
      // The next 24 chars: the initial of beforeInitial and the word after it ("B. Danach").
      const cut = { next: text.slice(i, i + 24).trimStart(), lang, prev: prevWord ? wordBefore(text, i - back.length + sp + 1) : undefined };
      const s =
        -Math.abs(i - target) +
        // A stop after an abbreviation or an ordinal ("z.B.", "3.") ends no sentence, as in
        // breakScore — judged on the word before the cut when there is one. The quote's particle
        // is read past the space of a spaced seam ("。」 と言って"), as breakScore reads its next word.
        (quoteGoesOn(back, cut.next)
          ? 0
          : SENT_END.test(back) && (!prevWord || isSentenceEnd(prevCased, cut))
            ? 16
            : CLAUSE.test(back) ? 9 : 0) +
        (sylSpaced && BREAK_SPACE.test(text[i]) ? 9 : 0) -
        // A seam inside a short CJK word of spaced text ("東京") is a fallback, as in wrapTokens.
        (spaced && !sylSpaced && !BREAK_SPACE.test(text[i]) && runAt(text, i) <= 6 ? 9 : 0) -
        // A space right before a lone closing mark or after a lone opening one (French
        // « bonjour », "Ça va ?", Thai "บ่อย ๆ"): the mark stays with its word.
        (BREAK_SPACE.test(text[i])
          && (LONE_CLOSER_AHEAD.test(text.slice(i + 1, i + 9)) || /(?:^|\s)[\p{Ps}\p{Pi}]+$/u.test(back))
          ? 20
          : 0) -
        (NOBREAK.has(prevWord) || heldAbbrev(prevCased, cut) || beforeInitial(prevWhole, cut.next, cut.next.split(/\s+/)[1] ?? "", lang) || beforeUnit(prevWhole, cut.next) ? 12 : 0) -
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

/** Wrap one cue's text onto as few lines of `cpl` chars as it needs (the cue
 *  splitter keeps a cue within its line cap, so `_lines` only documents the
 *  caller's limit), bottom-heavy (the second line may be longer), preferring
 *  breaks after punctuation and avoiding one after an article. Text that cannot fit
 *  gets extra lines rather than losing words. `firstReserve` = chars a prefix
 *  ("Name: ", "[DE] ") takes on the first line. `q` = the quotes of the cue's segment
 *  around `text` (Cue.q), so a quote pairs with its partner in the next cue. `lang` = the
 *  track's language, so a line ends where the cue split sees a sentence end ("He was 12."). */
export function wrapLines(
  text: string, cpl: number, _lines: number, firstReserve = 0, q?: QuoteCtx, lang?: string,
): string[] {
  const lines = wrapWith(text, cpl, firstReserve, q, lang, true);
  // A compound's hyphen ends its line (tokenUnits), so a line opened with "-" never reads as a
  // dialogue dash — unless the hyphen then misses the line by a character and its stub ("s-")
  // costs a line of its own: the fewer lines win, the hyphen-final ones on a tie.
  if (lines.length < 3 || !/[\p{L}\p{N}][-\u2010][\p{L}\p{N}]/u.test(text)) return lines;
  const plain = wrapWith(text, cpl, firstReserve, q, lang, false);
  return plain.length < lines.length ? plain : lines;
}

/** wrapLines with tokenUnits' `hyphen`. */
function wrapWith(text: string, cpl: number, firstReserve: number, q: QuoteCtx | undefined, lang: string | undefined, hyphen: boolean): string[] {
  const t = text.trim();
  const len = t.length + firstReserve;
  if (len <= cpl) return [t];
  const spaced = /\s/.test(t);
  // One word of a spaced script ("Okay.", "감사합니다.") pushed over only by the prefix
  // stays whole, as in wrapTokens; a word longer than cpl by itself still wraps per character.
  if (!spaced && t.length <= cpl && !BREAKS_ANYWHERE.test(t)) return [t];
  // Spaced text holding a CJK/Thai-like run (one Latin word in a Japanese line) wraps
  // between that run's characters too; as one token the run would take whole lines of its
  // own, past the line cap fits() had judged. Unspaced text wraps by the same tokens, so a Latin
  // word or number glued into it ("明日はMicrosoftの", "333メートル") stays whole and ASCII
  // punctuation stays on its character; no gaps, so every seam is a plain character seam.
  // A token longer than cpl (a URL, e-mail or compound) wraps per unit (tokenUnits); kept
  // whole it would take a line of its own or run over the cap.
  const toks: string[] = [];
  const gaps: boolean[] = [];
  if (spaced && !BREAKS_ANYWHERE.test(t)) {
    // Split at word breaks only, so a no-break space stays inside its word as written (a split
    // at every space would rejoin it as a plain space); a no-break run longer than a line still
    // splits at its spaces, since tokenUnits would drop them.
    const words = t.split(BREAK_SPACES)
      .flatMap((w) => (w.length > cpl && /\s/.test(w) ? w.split(/\s+/) : [w]));
    words.forEach((w, k) => {
      const parts = w.length > cpl ? tokenUnits(w, hyphen) : [w];
      toks.push(...parts);
      parts.forEach((_, j) => gaps.push(j === 0 && k > 0));
    });
    if (toks.length > words.length) {
      // A balanced break inside the split word can cost a line at a small cpl (a URL after
      // "wonderful" at 14, two e-mails at 20) that the word kept whole — on lines of its
      // own, wrapped per character — did not: the fewer lines win, the shared ones on a tie.
      const split = wrapTokens(toks, gaps, cpl, len, firstReserve, lang);
      const whole = wrapTokens(words, words.map((_, i) => i > 0), cpl, len, firstReserve, lang);
      return whole.length < split.length ? whole : split;
    }
  } else {
    const m = mixedTokens(t, q);
    m.toks.forEach((w, k) => {
      // A no-break run longer than a line splits at its spaces, as above: tokenUnits would drop them.
      (w.length > cpl && /\s/.test(w) ? w.split(/\s+/) : [w]).forEach((x, i) => {
        const parts = x.length > cpl ? tokenUnits(x, hyphen) : [x];
        toks.push(...parts);
        if (spaced) parts.forEach((_, j) => gaps.push(j === 0 && (i > 0 || m.gaps[k])));
      });
    });
  }
  if (toks.length < 2) {
    // One token: a spaced-script word pushed over only by the prefix, or one holding a no-break
    // space ("京 avait" — units drop whitespace, so a per-unit wrap would delete it and cut where
    // it holds), stays whole as in wrapTokens; an unspaced run wraps per unit.
    const u = tokenUnits(t, hyphen);
    return u.length < 2 || (t.length <= cpl && (/\s/.test(t) || (!UNSPACED.test(t) && !BRK_SYL.test(t))))
      ? [t]
      : wrapTokens(u, [], cpl, len, firstReserve);
  }
  return wrapTokens(toks, gaps, cpl, len, firstReserve, lang);
}

/** Which characters of `t` are counted ASCII quotes, `q` = its segment's quotes and characters
 *  around it when `t` is a cue of it (QuoteCtx), so a cue counts its quotes as its segment does.
 *  A " or ' between two ASCII letters or digits is none (it's, rock'n'roll), and neither is an
 *  inch or foot mark: one glued right after an ASCII digit while the count of its kind so far
 *  is even (6.1", 27") — counted, it would flip the pairing of every quote after it. At an odd
 *  count the same quote closes (他说"是2024"). */
function quoteFlags(t: string, q?: QuoteCtx): boolean[] {
  const n: QuoteCount = { '"': q?.before['"'] ?? 0, "'": q?.before["'"] ?? 0 };
  const out: boolean[] = [];
  for (let j = 0; j < t.length; j++) {
    const c = t[j];
    const prev = t[j - 1] ?? q?.prev ?? "";
    const is = (c === '"' || c === "'")
      && !(/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(t[j + 1] ?? q?.next ?? ""))
      && !(/[0-9]/.test(prev) && n[c] % 2 === 0);
    if (is) n[c as keyof QuoteCount]++;
    out.push(is);
  }
  return out;
}

/** Whether the counted quote at `j` of `t` may close a quotation whose opener quoteFlags did not
 *  count as one between two ASCII letters or digits: one of its kind stands so in the Latin run
 *  right before it — its letters and digits, and spaces for a " (RTX"Super", Apple"Vision Pro"; a
 *  ' a word back is an apostrophe: I'm Mike'). Its count's parity is then off by one, so the
 *  letter-or-digit branch that splits an opener off the word before it (quoteSeams, tokensOf)
 *  leaves it joined backward. `q` as quoteFlags: a cue's first character is judged by its
 *  segment's character before it ("Super"和 cut after RTX). */
function skippedOpener(t: string, flags: boolean[], j: number, q?: QuoteCtx): boolean {
  const c = t[j];
  for (let k = j - 1; k >= 0; k--) {
    const x = t[k];
    if (x === c) return !flags[k] && /[A-Za-z0-9]/.test(t[k - 1] ?? q?.prev ?? "") && /[A-Za-z0-9]/.test(t[k + 1]);
    if (unspacedChar(x) || BRK_SYL.test(x) || !(/[\p{L}\p{N}]/u.test(x) || (c === '"' && x === " "))) return false;
  }
  return false;
}

/** Where each of `parts` — trimmed substrings of `whole`, in order (cues, cut parts) — starts
 *  in `whole`; -1 for an empty or unfound part. */
function partsAt(whole: string, parts: string[]): number[] {
  let from = 0;
  return parts.map((p) => {
    const at = p ? whole.indexOf(p, from) : -1;
    if (at >= 0) from = at + p.length;
    return at;
  });
}

/** The QuoteCtx of `whole[at, e)`, counted over `whole` once (on the first ask); undefined
 *  when no quote stands outside it, no ASCII letter or digit borders it, no ” / ’ closes after
 *  it and no „ / ‚ is open at it (only those change how a quote at its edge is judged). */
function quotesIn(whole: string): (at: number, e: number) => QuoteCtx | undefined {
  /** Counted quotes of each kind before index i. */
  let dq: number[] | null = null;
  const sq = [0];
  /** From index i on: whether a ” / a closing ’ comes first (QuoteCtx.closes); before i:
   *  whether a „ / ‚ is open (QuoteCtx.lowOpen). */
  const dc: boolean[] = [];
  const sc: boolean[] = [];
  const ld = [false];
  const ls = [false];
  const L = whole.length;
  return (at, e) => {
    if (!dq) {
      const f = quoteFlags(whole);
      dq = [0];
      for (let j = 0; j < L; j++) {
        dq.push(dq[j] + (f[j] && whole[j] === '"' ? 1 : 0));
        sq.push(sq[j] + (f[j] && whole[j] === "'" ? 1 : 0));
        ld.push(whole[j] === "\u201e" || (ld[j] && whole[j] !== "\u201c"));
        ls.push(whole[j] === "\u201a" || (ls[j] && whole[j] !== "\u2018"));
      }
      dc[L] = sc[L] = false;
      for (let j = L - 1; j >= 0; j--) {
        const c = whole[j];
        dc[j] = c === "\u201d" || (c !== "\u201c" && c !== "\u201e" && dc[j + 1]);
        sc[j] = c === "\u2018" || c === "\u201a" ? false : closingSingle(whole, j) || sc[j + 1];
      }
    }
    const q: QuoteCtx = { before: { '"': dq[at], "'": sq[at] }, after: { '"': dq[L] - dq[e], "'": sq[L] - sq[e] } };
    if (/[A-Za-z0-9]/.test(whole[at - 1] ?? "")) q.prev = whole[at - 1];
    if (/[A-Za-z0-9]/.test(whole[e] ?? "")) q.next = whole[e];
    if (dc[e] || sc[e]) q.closes = { ...(dc[e] ? { double: true } : {}), ...(sc[e] ? { single: true } : {}) };
    if (ld[at] || ls[at]) q.lowOpen = { ...(ld[at] ? { double: true } : {}), ...(ls[at] ? { single: true } : {}) };
    return q.before['"'] + q.before["'"] + q.after['"'] + q.after["'"] || q.prev || q.next || q.closes || q.lowOpen ? q : undefined;
  };
}

/** The QuoteCtx of each of `parts` — trimmed substrings of `whole`, in order (cues, cut parts)
 *  — counted over `whole` in one pass; undefined for an empty or unfound part (quotesIn). */
function quoteCtxs(whole: string, parts: string[]): (QuoteCtx | undefined)[] {
  const qa = quotesIn(whole);
  return partsAt(whole, parts).map((at, k) => (at < 0 ? undefined : qa(at, at + parts[k].length)));
}

/** Whether `t[k]` is a ’ that may close a ‘: an apostrophe between two Latin letters (it’s,
 *  don’t) closes nothing. `next` = the character after `t` (a cue's QuoteCtx.next). */
function closingSingle(t: string, k: number, next?: string): boolean {
  return t[k] === "\u2019" && !(/\p{Script=Latin}/u.test(t[k - 1] ?? "") && /\p{Script=Latin}/u.test(t[k + 1] ?? next ?? ""));
}

/** Whether a ’ from `t[from]` on closes a ‘ before it: none of ‘ or ‚ comes first
 *  (closingSingle); undefined when `t` ends first. */
function singleCloses(t: string, from: number, next?: string): boolean | undefined {
  for (let k = from; k < t.length; k++) {
    if (t[k] === "\u2018" || t[k] === "\u201a") return false;
    if (closingSingle(t, k, next)) return true;
  }
  return undefined;
}

/** Whether a German low opener `low` („ or ‚) is open at `t[j]`, a “ or ‘: it comes after the
 *  last of `t[j]`'s kind before j; with neither before j, the segment's (`open`, QuoteCtx.lowOpen). */
function lowOpenAt(t: string, j: number, low: string, open: true | undefined): boolean {
  const l = t.lastIndexOf(low, j);
  const h = t.lastIndexOf(t[j], j - 1);
  return l < 0 && h < 0 ? !!open : l > h;
}

/** MIXED_TOKEN matches, each cut where a closing quote is glued to the opener of the next
 *  quotation: a typographic opener (”“ ’‘ »«, also after a closing ASCII quote) anywhere in
 *  the match, an ASCII quote only as the match's last character ("Hello""再见, “OK”"再见, also
 *  after a letter or digit: iPhone"新機能", unless it may close an uncounted one: skippedOpener;
 *  a typographic “ or ‘ there too when a ” or ’ closes it later: iPhone“灵动岛”, iPhone‘灵动岛’)
 *  and only when it opens (an even count of its kind so far and a later partner). Either
 *  needs a letter, digit or opener glued after it. Uncut, the opener would ride on the text
 *  before it and a line or part could end on it. */
function* quoteSeams(t: string, flags: boolean[], q: QuoteCtx | undefined, total: Record<string, number>): Generator<[string, number]> {
  const n: Record<string, number> = { '"': q?.before['"'] ?? 0, "'": q?.before["'"] ?? 0 };
  let pos = 0;
  for (const m of t.matchAll(MIXED_TOKEN)) {
    const idx = m.index!;
    const end = idx + m[0].length;
    for (; pos < idx; pos++) if (flags[pos]) n[t[pos]]++;
    let s = idx;
    for (let j = idx; j < end; j++) {
      if (j > idx) {
        const p = t[j - 1];
        const closer = /[\p{Pe}\p{Pf}]/u.test(p) || (flags[j - 1] && n[p] % 2 === 0);
        let e = -1;
        if (closer && /\p{Pi}/u.test(t[j])) for (e = j; e < end && /\p{Pi}/u.test(t[e]); ) e++;
        else if (j === end - 1 && flags[j] && n[t[j]] % 2 === 0 && total[t[j]] > n[t[j]] + 1
          && (closer || (/[\p{L}\p{N}]/u.test(p) && !skippedOpener(t, flags, j, q)))) e = end;
        // A typographic “ glued to a word or number ("2024“春晚”", iPhone“灵动岛”) opens when a ”
        // closes it: German and Czech close with “ („Hallo“東京) and never write ”, nor when it
        // closes an open „ (a ” comes later: „Hallo“東京 … ”ok”).
        // A cue cut inside the quotation holds neither: its segment decides (QuoteCtx).
        else if (j === end - 1 && t[j] === "\u201c" && /[\p{L}\p{N}]/u.test(p)
          && (/[\u201c\u201e\u201d]/u.exec(t.slice(end))?.[0] === "\u201d"
            || (!/[\u201c\u201e\u201d]/u.test(t.slice(end)) && !!q?.closes?.double))
          && !lowOpenAt(t, j, "\u201e", q?.lowOpen?.double)) e = end;
        // So does a ‘ (Chinese nests a quotation in one: iPhone‘灵动岛’) when a ’ closes it — not
        // one closing a German ‚ (‚Hallo‘東京), nor an apostrophe between Latin letters (it’s).
        else if (j === end - 1 && t[j] === "\u2018" && /[\p{L}\p{N}]/u.test(p)
          && (singleCloses(t, end, q?.next) ?? !!q?.closes?.single)
          && !lowOpenAt(t, j, "\u201a", q?.lowOpen?.single)) e = end;
        if (e >= 0 && /[\p{L}\p{N}\p{Ps}\p{Pi}]/u.test(edgeChar(t.slice(e, e + 2), false))) {
          yield [t.slice(s, j), s];
          s = j;
        }
      }
      if (flags[j]) n[t[j]]++;
    }
    pos = end;
    yield [t.slice(s, end), s];
  }
}

/** Tokens of text with a CJK/Thai-like run (MIXED_TOKEN; spaced or not — spreadTokens,
 *  wrapLines and cutByShare tokenize unspaced text by them too), per token whether whitespace stood
 *  before it, and where in `t` it starts. Punctuation glued to its neighbour (an ASCII
 *  "." or ")" after a CJK character, a "(" before one) joins it, so no line starts with a
 *  stop or ends on an opener. An opener glued to the end of a word moves onto the character
 *  it opens, so a line may break before the "(" but never right after it. An ASCII " or '
 *  is a stop by class, but one that opens a quotation (他说"你好") rides forward too: it
 *  opens when a space, the text start or an opening bracket stands before it, or when it
 *  would be an odd-numbered one of its kind AND a later one of its kind follows to close it
 *  — both counted over the whole segment (`q`, the quotes around `t` when it is one cue of
 *  it) — and in every case a letter, digit or opener must follow. A quote between two ASCII
 *  letters or digits (it's) and an inch or foot mark after a digit at an even count (6.1") are
 *  no quotes (quoteFlags). The last unpaired one — a single quote, or a closer whose opener
 *  was in the previous segment — is ambiguous and joins the text before it. A match where a
 *  closing quote is glued to the next quotation's opener
 *  (他说：“你好。”“我很好。”, "Hello""再见) is first cut between the two (quoteSeams), so the
 *  closer stays with what it closes and the opener rides forward with what it opens. */
function mixedTokens(t: string, q?: QuoteCtx): { toks: string[]; gaps: boolean[]; at: number[] } {
  const toks: string[] = [];
  const gaps: boolean[] = [];
  const at: number[] = [];
  let end = 0;
  const flags = quoteFlags(t, q);
  /** Counted quotes of each kind before the current match (from the segment start) — kept
   *  running, so the pass stays linear. */
  const quotes: Record<string, number> = { '"': q?.before['"'] ?? 0, "'": q?.before["'"] ?? 0 };
  /** Counted quotes of each kind in the whole segment. */
  const total: Record<string, number> = { '"': quotes['"'] + (q?.after['"'] ?? 0), "'": quotes["'"] + (q?.after["'"] ?? 0) };
  for (let j = 0; j < t.length; j++) if (flags[j]) total[t[j]]++;
  /** The token that ends on an opening ASCII quote: the next one joins it. */
  let quoted = -1;
  for (const [w0, idx0] of quoteSeams(t, flags, q, total)) {
    let w = w0;
    let idx = idx0;
    const gap = idx > end;
    // Only no-break spaces before it (« さようなら », 東京 avait): no word break, as in a spaced
    // line — it joins the token before it with them as written, never a break rejoined as " ".
    const nb = gap && toks.length > 0 && NO_BREAK_RUN.test(t.slice(end, idx)) ? t.slice(end, idx) : "";
    end = idx + w.length;
    const k = toks.length - 1;
    // Its quote run (after any brackets, as in （"): at most six open, as in tokenUnits.
    let qr = /^\p{Ps}*(["']{1,6})(?!["'])/u.exec(w);
    let c = qr?.[1][0] ?? '"';
    // A glued run whose first quote closes the quotation before it (他说"你好""再见", or of the
    // other kind: 他说'你好'"再见"): that quote joins the text it closes and the rest of the run
    // is judged on its own. Judged as one, the quote opening the next quotation would join
    // backward too, and a line or part would end on it. A closer followed by an English clitic
    // stays whole: "東京"'s and '東京''s are possessives, not a second quotation ('你好'"OK",
    // "你好"'S' and "你好"'T恤' still are: the "clitic" there is quoted on its own or glued to more letters).
    const runEnd = idx + (qr?.[0].length ?? 0);
    if (qr && !gap && k >= 0 && qr[0] === qr[1] && qr[1].length > 1 && flags[idx] && quotes[c] % 2 === 1
      && !(qr[1].slice(1) === "'" && /^(?:s|t|d|m|ll|re|ve)(?![\p{L}\p{N}])(?!'(?![A-Za-z]))/iu.test(t.slice(runEnd)))) {
      toks[k] += c;
      quotes[c]++;
      idx++;
      w = w.slice(1);
      qr = /^\p{Ps}*(["']{1,6})(?!["'])/u.exec(w);
      c = qr?.[1][0] ?? '"';
    }
    const after = idx + (qr?.[0].length ?? 0);
    // Glued to the text before it, a quote opens only on positive evidence: an even count of its
    // kind so far in the segment AND a later one of its kind to close it. The last unpaired one —
    // a closer whose opener was in the previous segment — joins the text it closes.
    const opens = !!qr && /[\p{L}\p{N}\p{Ps}\p{Pi}]/u.test(edgeChar(t.slice(after, after + 2), false))
      && (gap || k < 0 || qr[0] !== qr[1]
        || (quotes[c] % 2 === 0 && total[c] > quotes[c] + qr[1].split(c).length - 1));
    for (let j = idx; j < end; j++) if (flags[j]) quotes[t[j]]++;
    // An opener glued to the end of a Latin word ("Python(") moves onto what it opens, with
    // the ASCII quotes after it (print("). Brackets only: an initial quote at the end of a word
    // is a closer in German/Danish usage („Hallo“, »Hallo«), and peeling it off would leave
    // „Hallo / “東京… on two lines.
    const open = k >= 0 && !gap ? /\p{Ps}+["']*$/u.exec(toks[k]) : null;
    // Behind a no-break space (x (東京) the opener stays, and what it opens joins it: peeled
    // off, the line would end on the no-break space.
    const held = !!open && /[\u00a0\u202f\u2007]$/u.test(toks[k].slice(0, open.index));
    let from = idx;
    if (open && open.index > 0 && !held) {
      toks[k] = toks[k].slice(0, open.index);
      w = open[0] + w;
      from -= open[0].length;
    }
    const opened = quoted === k;
    if (nb || held) toks[k] += nb + w;
    // Joins the token before it: a closer or stop, what an opener or opening quote opens, and a
    // word mixing fullwidth and ASCII letters or digits ("ＰＳ5", "ＮＨＫnews"), which is one word.
    else if (
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
function wrapTokens(
  toks: string[], gaps: boolean[], cpl: number, len: number, reserve: number, lang?: string,
): string[] {
  const cum = [0];
  toks.forEach((w, i) => cum.push(cum[i] + (gaps[i] ? 1 : 0) + w.length));
  const T = toks.length;
  /** Length of the space-free run at toks[i]'s first (runL) and last (runR) character.
   *  A no-break space inside a token ends a run too: the word of « 東京 » is
   *  東京, a short one, as with a plain space. */
  const runL: number[] = [];
  const runR: number[] = [];
  {
    let line = "";
    toks.forEach((w, i) => { line += (gaps[i] ? " " : "") + w; });
    const from: number[] = [];
    for (let p = 0, st = 0; p < line.length; p++) {
      if (/\s/.test(line[p])) st = p + 1;
      from.push(st);
    }
    const to: number[] = [];
    for (let p = line.length - 1, e = line.length; p >= 0; p--) {
      if (/\s/.test(line[p])) e = p;
      to[p] = e;
    }
    toks.forEach((w, i) => {
      const a = cum[i + 1] - w.length;
      const z = cum[i + 1] - 1;
      runL.push(to[a] - from[a]);
      runR.push(to[z] - from[z]);
    });
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
      // Past the first over-cpl candidate every later one carries the -2000 and loses 50.6 per
      // char further (overflow term + |a - target|, target <= cpl < a); its b is under
      // cpl*(n-1) by construction, and the seam-dependent terms (breakScore*0.3, the -100
      // fallback, the hyphen and bottom-heavy bonuses) differ by at most 140 — so a candidate
      // more than 107 chars further cannot win (a loose bound). Stops a long paragraph costing
      // O(lines x T).
      if (a > cpl) {
        if (past < 0) past = a;
        else if (a - past > 107) break;
      }
      const b = width(i, T);
      let s = 0;
      // An over-cap line is final, an over-full remainder can still wrap: when no candidate
      // keeps both within their caps, the line itself must fit. A line that cannot (one word
      // over the cap) ends as early as it can, so that word then wraps per character rather
      // than a better break further on leaving a longer over-cap line.
      if (a > cpl) s -= 2000 + 50 * (a - cpl);
      if (b > cpl * (n - 1)) s -= 1000;
      if (gaps[i]) {
        s += breakScore(toks[i - 1], toks[i], lang, i >= 2 && gaps[i - 1] ? toks[i - 2] : undefined, toks[i + 1]) * 0.3;
        // Never beside a lone mark of spaced punctuation (French « bonjour », "Ça va ?", Thai
        // "บ่อย ๆ"): it stays with its word — below the over-cap penalties, so a forced cut still
        // happens, and not on a line over the cap, which only its overflow may decide.
        // A whole word only: the " ฯ" of " ฯลฯ" is a token of its own but opens the abbreviation.
        if (a <= cpl && ((LONE_CLOSER.test(toks[i]) && (i + 1 >= T || gaps[i + 1])) || /^[\p{Ps}\p{Pi}]+$/u.test(toks[i - 1]))) {
          s -= 500;
        }
        // A phrase space between two longer runs ("…行った 楽しかった…") that keeps both lines
        // within the cap beats a balanced cut inside a CJK word. Not beside a short word or
        // number ("Tokyo", "2024 年"): that one stays balanced into its sentence.
        if (mixed && a <= cpl && b <= cpl * (n - 1) && Math.min(runR[i - 1], width(lo, i)) > 6 && runL[i] > 6) {
          s += 5;
        }
      }
      // Inside a Thai-like phrase or a short CJK word of spaced text ("東京 tower"): a fallback
      // seam only — it loses to every space that keeps both lines within the cap (more than any
      // balance or break score); when no space fits, every space seam already carries -1000.
      // A longer CJK run is a sentence, and its seams balance against the spaces (only a
      // phrase space between two longer runs gets the small bonus above).
      else if (gaps.length && (runL[i] <= 6 || BRK_SYL.test(edgeChar(toks[i], false)))) s -= 100;
      // Right after a compound's hyphen (tokenUnits keeps it on the line it ends): the seam a
      // compound longer than a line wraps at, rather than one inside its parts. Not on a line
      // under a third of the target: the bonus would leave a stub ("s-") alone on one.
      if (!gaps[i] && a >= target / 3 && /[\p{L}\p{N}][-\u2010]$/u.test(toks[i - 1]) && /^[\p{L}\p{N}]/u.test(toks[i])) s += 10;
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
      units(toks[lo]).length >= 2 &&
      !/\s/.test(toks[lo])
    ) {
      // One over-long token on its own line (a CJK run before a Latin word): it
      // wraps per character too, not just a trailing one. A spaced-script word
      // pushed over only by the name prefix stays whole; an unspaced run has no
      // word to protect (CJK or Thai-like), so it still wraps to fit the prefixed line.
      // A token holding a no-break space ("東京 avait", "さ !") is at most cpl long and
      // stays whole too: units() drops whitespace, so the per-character wrap would delete
      // it and cut where the no-break space holds.
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
  // Filed as trackLang, as the export and the Subtitles view wrap the track's lines with it.
  const origLang = trackLang(result, "orig");
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
    // A piece's quotes as its cue will carry them (Cue.q), so fits() wraps it as the export does.
    const split = toks && L && needSplit
      ? timedPieces(seg.text, toks, seg.start, seg.end, { ...L, reserve: reserve(seg), q: quotesIn(seg.text), lang: origLang })
      : null;
    const pieces = split && needMine ? split : [{ start: seg.start, end: seg.end, text: seg.text.trim() }];
    // Each cue's quotes around it in the segment, so its lines pair a quote across cues.
    const mq = pieces.length > 1 ? quoteCtxs(seg.text, pieces.map((p) => p.text)) : [];
    const mine: Cue[] = pieces.map((p, k) => ({ seg: si, ...p, speaker: seg.speaker, tr: {}, ...(mq[k] ? { q: mq[k] } : {}) }));
    // Spoken stretches: the original's cues joined until it shows a gap (a pause
    // timedPieces left open), so an own-timed translation never runs over silence.
    const spans = split && ownMt ? stretchesOf(split) : [];
    for (const lang of mtLangs) {
      const t = trText(seg, lang);
      if (t === null) continue;
      if (ownMt) {
        const LL = { ...mtLim.get(lang)!, reserve: reserve(seg), lang: trackLang(result, lang) };
        if (!spans.length) {
          own[lang].push({ seg: si, start: seg.start, end: seg.end, text: t, speaker: seg.speaker, tr: {} });
          continue;
        }
        const texts = cutByShare(t, spans.map((sp) => sp.len), lang);
        // Each stretch's text is a part of the translation: its tokens pair a quote with the
        // partner the next stretch holds, and so do the lines of its cues — counted over the
        // whole translation, as each cue's own (pq below) is.
        const qa = quotesIn(t);
        const tAt = partsAt(t, texts);
        const parts: { start: number; end: number; text: string }[] = [];
        spans.forEach((sp, k) => {
          if (!texts[k]) return;
          const o = tAt[k];
          const tq = o < 0 ? undefined : qa(o, o + texts[k].length);
          const q = o < 0 ? undefined : (a: number, e: number) => qa(o + a, o + e);
          parts.push(...timedPieces(texts[k], spreadTokens(texts[k], sp.start, sp.end, tq), sp.start, sp.end, { ...LL, q }));
        });
        const pq = quoteCtxs(t, parts.map((p) => p.text));
        own[lang].push(...parts.map((p, k) => ({ seg: si, ...p, speaker: seg.speaker, tr: {}, ...(pq[k] ? { q: pq[k] } : {}) })));
      } else {
        const parts = cutByShare(t, mine.map((c) => Math.max(1, c.text.length)), lang);
        const pq = quoteCtxs(t, parts);
        mine.forEach((c, k) => {
          if (parts[k]) c.tr[lang] = parts[k];
          if (pq[k]) (c.trq ??= {})[lang] = pq[k];
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
): { start: number; end: number; text: string; seg: number; speaker?: string; q?: QuoteCtx }[] {
  const own = ownProp(grid.own, track);
  if (own) return own;
  // Speaker kept like own-timed cues keep it, so a shared-cue lane still prefixes "Name: ".
  return grid.cues
    .map((c) => {
      const q = track === "orig" ? c.q : ownProp(c.trq, track);
      return {
        start: c.start,
        end: c.end,
        seg: c.seg,
        ...(c.speaker ? { speaker: c.speaker } : {}),
        text: track === "orig" ? c.text : (ownProp(c.tr, track) ?? ""),
        ...(q ? { q } : {}),
      };
    })
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

/** Each projected cue segment's quote contexts by track (cueResult) — beside the segment
 *  rather than on it, so no export or file ever carries them. */
const projectedQuotes = new WeakMap<TranscriptSegment, Record<string, QuoteCtx>>();

/** The quotes around a cueResult segment's text of `track` in its source segment (Cue.q), for
 *  wrapLines; undefined for any other segment. */
export function cueQuoteCtx(seg: TranscriptSegment, track: string): QuoteCtx | undefined {
  return ownProp(projectedQuotes.get(seg), track);
}

/** Cues as a BatchResult, so the existing generators render them unchanged:
 *  one segment per cue, translations from the cut (or one own-timed track). */
export function cueResult(result: BatchResult, grid: CueGrid, ownTrack?: string): BatchResult {
  const segs = result.segments ?? [];
  if (ownTrack) {
    return {
      ...result,
      segments: (ownProp(grid.own, ownTrack) ?? []).map((c) => {
        const out: TranscriptSegment = {
          start: c.start,
          end: c.end,
          text: "",
          ...(c.speaker ? { speaker: c.speaker } : {}),
          translations: { [ownTrack]: c.text },
        };
        if (c.q) projectedQuotes.set(out, { [ownTrack]: c.q });
        return out;
      }),
    };
  }
  return {
    ...result,
    segments: grid.cues.map((c) => {
      const kept = segs[c.seg]?.translationsKept;
      const out: TranscriptSegment = {
        start: c.start,
        end: c.end,
        text: c.text,
        ...(c.speaker ? { speaker: c.speaker } : {}),
        ...(Object.keys(c.tr).length ? { translations: c.tr } : {}),
        ...(kept?.length ? { translationsKept: kept } : {}),
      };
      if (c.q || c.trq) projectedQuotes.set(out, { ...c.trq, ...(c.q ? { orig: c.q } : {}) });
      return out;
    }),
  };
}
