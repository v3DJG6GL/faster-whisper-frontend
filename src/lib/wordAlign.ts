// Word-level timing alignment for edited transcript segments.
//
// A text correction used to drop the whole segment's word timings (karaoke and
// word-level exports lost the line). Instead, the edited text is aligned to the
// original words: matched words keep their timings untouched, a replaced word
// inherits the replaced span's start/end, and inserted words split the
// surrounding gap weighted by character count — the same pragmatic model
// Descript's "Correct text" and Hyperaudio use. Timings are DERIVED from the
// stored text edits wherever they're needed, so nothing new is persisted.

import type { BatchResult, TranscriptSegment, TranscriptWord } from "./types";

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

/** Align one edited segment's text to its original word timings.
 *  Matched words (longest common subsequence) keep word AND timing verbatim;
 *  each unmatched run of new tokens shares the time span of the old run it
 *  replaces (or the gap it was inserted into), split by character count. */
export function alignSegmentWords(
  oldWords: TranscriptWord[],
  newText: string,
): TranscriptWord[] {
  if (!oldWords.length) return [];
  const newToks = tokenize(newText);
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
        word: (spacey ? " " : "") + newToks[j],
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
          : { ...oldWords[i], word: (spacey ? " " : "") + newToks[j] },
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
    if (edited.has(i)) out.push(...alignSegmentWords(words.slice(from, to), edits[i]));
    else out.push(...words.slice(from, to));
  });
  out.push(...words.slice(wi));
  return out;
}
