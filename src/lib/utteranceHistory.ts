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
