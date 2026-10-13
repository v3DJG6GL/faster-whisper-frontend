// Text bookkeeping for per-utterance History records (live hands-free sessions write one
// record per finished utterance — streaming.ts). Pure, so the seams are testable.

/** What one `final` adds to the document: everything past where the previous final ended.
 *  The server keeps a document append-only, so this is the utterance's own text — or, for a
 *  release final (no ordinal), the held-back words it hands to the utterance before it. A
 *  document that shrank (never expected) adds nothing rather than re-slicing text an earlier
 *  record already holds. */
export function finalDelta(doc: string, prevEnd: number): string {
  return doc.length > prevEnd ? doc.slice(prevEnd) : "";
}

/** Append a delta to a record's text. The delta carries its own seam — a leading space before
 *  a word (" Komma"), none before punctuation (",") — so a plain join is right. */
export function appendDelta(text: string, delta: string): string {
  return (text + delta).trim();
}

/** Append one insert's translation to what the record already holds (a release final's
 *  chunk joins its utterance's with a space). */
export function appendChunk(prev: string | undefined, chunk: string): string {
  const t = chunk.trim();
  return prev ? `${prev} ${t}` : t;
}

/** `appendChunk` per language. Null-prototype for the same reason as streaming.ts's
 *  `sessionByLang`: the keys are server-echoed language codes. */
export function mergeTracks(
  prev: Record<string, string> | undefined,
  add: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!add) return prev;
  const out = Object.create(null) as Record<string, string>;
  for (const [lang, text] of Object.entries(prev ?? {})) out[lang] = text;
  for (const [lang, text] of Object.entries(add)) {
    if (text.trim()) out[lang] = appendChunk(out[lang], text);
  }
  return Object.keys(out).length ? out : prev;
}

/** A per-utterance clip: its .wav and measured length (null = unmeasured). */
export type UtteranceClip = { path: string; durationMs: number | null };
/** One finished utterance: its History record once written, and its clip while that record
 *  does not exist yet. */
export type UtteranceEntry = { ordinal: number; id: string | null; openedAt: number; clip?: UtteranceClip };

/** Hand a clip to the utterance it belongs to, found by ordinal. Rust writes each clip on its
 *  own thread, so it lands whenever the write finishes — after later utterances' finals or a
 *  break just as well — and pairing it with "the last utterance" lost it. A record that exists
 *  takes the clip now (and the entry is done); one that does not yet keeps it on the entry for
 *  the final that writes the record. False when the ordinal names no utterance of this session. */
export function routeUtteranceClip(
  byOrdinal: Map<number, UtteranceEntry>,
  ordinal: number,
  clip: UtteranceClip,
  attach: (id: string, clip: UtteranceClip) => void,
): boolean {
  const utt = byOrdinal.get(ordinal);
  if (!utt) return false;
  if (utt.id) {
    attach(utt.id, clip);
    byOrdinal.delete(ordinal);
  } else utt.clip = clip;
  return true;
}
