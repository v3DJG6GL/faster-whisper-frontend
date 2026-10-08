// Word-level timing alignment for edited transcript segments.
//
// A text correction used to drop the whole segment's word timings (karaoke and
// word-level exports lost the line). Instead, the edited text is aligned to the
// original words: matched words keep their timings untouched, a replaced word
// inherits the replaced span's start/end, and inserted words split the
// surrounding gap weighted by character count — the same pragmatic model
// Descript's "Correct text" and Hyperaudio use. Timings are DERIVED from the
// stored text edits wherever they're needed, so nothing new is persisted.

import type { BatchResult, TranscriptSegment, TranscriptWord } from "../types";

/** Word index ranges per segment. One pass: words arrive time-ordered; each
 *  word belongs to the first segment whose window (±0.05 s slack) it falls
 *  into — but never past the NEXT segment's start: adjacent segments share an
 *  exact boundary (seg[i].end === seg[i+1].start), and the slack alone used to
 *  pull the next line's first word into the previous line's range (it then
 *  rendered on the wrong row and vanished from its own). Ranges are
 *  consecutive and non-overlapping by construction. */
export function segmentWordRanges(
  segments: TranscriptSegment[],
  words: TranscriptWord[],
): (readonly [number, number])[] {
  let wi = 0;
  return segments.map((seg, i) => {
    const next = segments[i + 1];
    while (wi < words.length && words[wi].start < seg.start - 0.05) wi++;
    const from = wi;
    while (
      wi < words.length &&
      words[wi].start < seg.end + 0.05 &&
      (!next || words[wi].start < next.start)
    )
      wi++;
    return [from, wi] as const;
  });
}

/** Comparison key for matching: letters/digits/apostrophes only, case-folded —
 *  so "Velonavitest," still matches "Velonavitest" and punctuation-only edits
 *  keep every timing. */
function norm(s: string): string {
  const t = s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  return t || s.trim().toLowerCase();
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Scripts written without spaces (kept local: cueSplit imports this module). Must list
 *  the same scripts as cueSplit's BREAKS_ANYWHERE: a Thai, Lao, Khmer or Burmese line is
 *  unspaced too, and one changed character used to collapse its timing into one word. */
const UNSPACED_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Tokens of an edited text that holds an unspaced script (CJK, Thai…), cut where the
 *  original words were: splitting on whitespace yields one token per unspaced run, which
 *  matches no old word, so one changed character used to collapse the whole run's timing
 *  into one word. One code-point LCS of the whole text (whitespace aside) against the old
 *  words' characters tags each new character with the word it came from (or none); a
 *  token ends at whitespace and, inside a run holding an unspaced script, wherever that
 *  owner changes. One LCS over the line, not one per whitespace piece: a piece aligned on
 *  its own may borrow a character from another piece's word ("ค่ะ"'s tone mark from a
 *  later "ชื่อ") and cut a syllable. `opens[k]` marks a token that follows whitespace or
 *  starts the text. */
function charTokens(oldWords: TranscriptWord[], text: string): { toks: string[]; opens: boolean[] } {
  const oldChars: string[] = [];
  const owner: number[] = [];
  oldWords.forEach((w, k) => {
    for (const c of Array.from(w.word)) {
      if (/\s/.test(c)) continue;
      oldChars.push(c);
      owner.push(k);
    }
  });
  const pieces = tokenize(text);
  const newChars = pieces.flatMap((p) => Array.from(p));
  const m = oldChars.length;
  const n = newChars.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldChars[i] === newChars[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const own = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (oldChars[i] === newChars[j]) own[j++] = owner[i++];
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const toks: string[] = [];
  const opens: boolean[] = [];
  let j = 0;
  for (const p of pieces) {
    const chars = Array.from(p);
    const cut = UNSPACED_RE.test(p);
    chars.forEach((c, k) => {
      // Clinging joins only across an INSERTED character: two characters matched to different old
      // words keep their boundary (the model may have split a syllable), or a punctuation-only
      // edit would merge two timed words into one that matches neither.
      const joins =
        !cut || own[j] === own[j - 1] || ((own[j] === -1 || own[j - 1] === -1) && clings(newChars[j - 1], c));
      if (k && joins) toks[toks.length - 1] += c;
      else {
        toks.push(c);
        opens.push(k === 0);
      }
      j++;
    });
  }
  return { toks, opens };
}

/** A text of spaced scripts only: its whitespace pieces, each opening a token. */
function spacedTokens(text: string): { toks: string[]; opens: boolean[] } {
  const toks = tokenize(text);
  return { toks, opens: toks.map(() => true) };
}

/** `c` never starts a token after `prev`: a combining mark (a Thai tone mark, a decomposed
 *  "が"'s U+3099), a ZWJ or what follows one, a Thai/Lao following vowel (ะ า ำ ๅ), or
 *  anything after a Thai/Lao leading vowel (เ-ไ) or a Burmese/Khmer stacking virama —
 *  an inserted "ค่ะ" stays one word, not "ค" + "่ะ". */
const clings = (prev: string, c: string): boolean =>
  /[\p{M}\u200d\u0e30\u0e32\u0e33\u0e45\u0eb0\u0eb2\u0eb3]/u.test(c)
  || /[\u200d\u0e40-\u0e44\u0ec0-\u0ec4\u1039\u17d2]/.test(prev);

/** Align one edited segment's text to its original word timings.
 *  Matched words (longest common subsequence) keep word AND timing verbatim;
 *  each unmatched run of new tokens shares the time span of the old run it
 *  replaces (or the gap it was inserted into), split by character count. */
export function alignSegmentWords(
  oldWords: TranscriptWord[],
  newText: string,
): TranscriptWord[] {
  if (!oldWords.length) return [];
  // Any unspaced run is cut per old word, also inside a spaced line: a Japanese line with
  // a spaced " AI", or a Thai line with phrase spaces, used to keep each run as one token
  // that matched nothing. A line of spaced scripts only stays a plain whitespace split.
  const { toks: newToks, opens } = UNSPACED_RE.test(newText)
    ? charTokens(oldWords, newText)
    : spacedTokens(newText);
  if (!newToks.length) return [];
  const a = oldWords.map((w) => norm(w.word));
  const b = newToks.map(norm);
  const m = a.length;
  const n = b.length;
  // LCS lengths of suffixes — segments are short, the quadratic table is fine.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Whisper's verbose_json words usually carry their separating space (" Wort");
  // rebuilt words follow whatever convention the original list uses.
  const spacey = oldWords.some((w) => /^\s/.test(w.word));
  /** A rebuilt token's leading space. Tokens cut out of one unspaced (CJK, Thai) run are
   *  pieces of that run, so only a token that opens a whitespace piece of the edit or one
   *  standing where an old word carried a space (a Latin " AI" inside the line) gets one —
   *  never one mid-run. */
  const lead = (j: number, old?: TranscriptWord) =>
    !spacey ? "" : opens[j] || (old && /^\s/.test(old.word)) ? " " : "";
  const out: TranscriptWord[] = [];
  /** Emit new tokens [nj0,nj1) over the span of old words [oi0,oi1). */
  const flush = (oi0: number, oi1: number, nj0: number, nj1: number) => {
    if (nj0 >= nj1) return; // pure deletion — nothing to emit
    const start =
      oi0 < oi1
        ? oldWords[oi0].start
        : out.length
          ? out[out.length - 1].end
          : oldWords[0].start;
    const end =
      oi0 < oi1
        ? oldWords[oi1 - 1].end
        : oi0 < oldWords.length
          ? oldWords[oi0].start
          : oldWords[oldWords.length - 1].end;
    const span = Math.max(0, end - start);
    let chars = 0;
    for (let j = nj0; j < nj1; j++) chars += newToks[j].length;
    let t = start;
    for (let j = nj0; j < nj1; j++) {
      const w = span * (newToks[j].length / (chars || 1));
      out.push({
        word: lead(j, j === nj0 && oi0 < oi1 ? oldWords[oi0] : undefined) + newToks[j],
        start: t,
        end: Math.min(end, t + w) || t,
      });
      t += w;
    }
  };
  let i = 0;
  let j = 0;
  let oi = 0;
  let nj = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      // Taking an equal pair is always LCS-optimal.
      flush(oi, i, nj, j);
      // Matched: timing kept. The key comparison ignores punctuation/case, so
      // a correction like "Velonavitest" → "Velo-Navi-Test" still lands here —
      // adopt the corrected spelling whenever the raw strings differ.
      out.push(
        oldWords[i].word.trim() === newToks[j]
          ? oldWords[i]
          : { ...oldWords[i], word: lead(j, oldWords[i]) + newToks[j] },
      );
      i++;
      j++;
      oi = i;
      nj = j;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  flush(oi, m, nj, n);
  return out;
}

/** The result's flat word list with every text-edited segment's words replaced
 *  by their aligned equivalents — what karaoke renders and exports carry.
 *  Returns the original array untouched when no edit applies. */
export function applyTextEdits(
  result: BatchResult,
  edits: Record<number, string> | undefined,
): TranscriptWord[] {
  const words = result.words ?? [];
  const segs = result.segments ?? [];
  if (!words.length || !segs.length || !edits) return words;
  const edited = new Set(
    Object.keys(edits)
      .map(Number)
      .filter((i) => i >= 0 && i < segs.length),
  );
  if (!edited.size) return words;
  const ranges = segmentWordRanges(segs, words);
  const out: TranscriptWord[] = [];
  let wi = 0;
  segs.forEach((_seg, i) => {
    const [from, to] = ranges[i];
    if (from > wi) out.push(...words.slice(wi, from)); // words between segments
    wi = Math.max(wi, to);
    if (edited.has(i)) {
      // A word appended at the tail starts at the last word's end — at or past
      // the next segment's start when they share a boundary, so segmentWordRanges
      // would hand it to the next line. Clamp such a word just inside this one.
      const next = segs[i + 1];
      const s = next ? Math.max(segs[i].start, next.start - 0.001) : 0;
      out.push(
        ...alignSegmentWords(words.slice(from, to), edits[i]).map((w) =>
          next && w.start >= next.start
            ? { ...w, start: s, end: Math.max(s, Math.min(w.end, next.start)) }
            : w,
        ),
      );
    } else out.push(...words.slice(from, to));
  });
  out.push(...words.slice(wi));
  return out;
}
