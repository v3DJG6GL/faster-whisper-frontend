/**
 * The live-typing baseline's arithmetic, kept PURE so it can be tested — `streaming.ts`, the
 * only caller, has no harness (nothing in this repo mocks Tauri; the same reason
 * `utterancePending.ts` and `captureIds.ts` live on their own).
 *
 * Live dictation is append-only: the server re-sends the WHOLE document on every `final`, and
 * the client types only what lies beyond `injectedText`, the part it has already delivered. Three
 * questions come up around that baseline, and each used to be open-coded or not asked at all:
 *
 *  • how much of a document is already typed (`commonPrefixLen`) — the diff itself;
 *  • what of a document was NEVER typed when the server throws it away at a hard break
 *    (`untypedRemainder`) — a phrase the own-window guard skipped, or a paste Rust refused to
 *    attempt, used to vanish with the document; it is now carried into the next one;
 *  • where, if anywhere, the document stopped EXTENDING what was typed (`baselineDivergence`) —
 *    a seam rewrite the server should no longer produce, logged by position and character
 *    class only, never by text (the log ends up in bug reports).
 */

/** Length of the longest common prefix of `a` and `b`, in UTF-16 code units. The split never
 *  lands inside a surrogate pair: two astral characters (emoji, CJK Ext-B) can share a high
 *  surrogate, and splitting there would type a lone low surrogate. Backing off one unit only
 *  re-types that character (duplication over loss). */
export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i > 0 && i < n) {
    const c = a.charCodeAt(i - 1);
    if (c >= 0xd800 && c <= 0xdbff) i--;
  }
  return i;
}

/** The part of `doc` beyond what was typed — exactly what the live diff would type next, so a
 *  carried remainder and a typed phrase agree on where "already typed" ends. When the document
 *  rewrote typed text this is everything from the divergence on (duplication over loss, the
 *  same trade the live diff makes); `baselineDivergence` is how that case gets noticed. */
export function untypedRemainder(typed: string, doc: string): string {
  return doc.slice(commonPrefixLen(typed, doc));
}

/** Join a carried-over remainder to the next text across a hard break. Both seams are trimmed
 *  (the carry's end, the next text's start) and `sep` — the boundary's separator — goes
 *  between; an empty separator still needs a space, or the last word of one document runs into
 *  the first of the next. An empty side returns the other one untouched (trimmed at the seam). */
export function joinCarry(carry: string, sep: string, next: string): string {
  const a = carry.trimEnd();
  const b = next.trimStart();
  if (!a) return b;
  if (!b) return a;
  return a + (sep === "" ? " " : sep) + b;
}

/** What the typed branch sends when a carry is pending: the carry joined to the new text — or,
 *  when there is no new text yet, the carry followed by its separator, so the seam to the
 *  document that comes next isn't lost (the boundary's own separator task stood down for the
 *  carry, and `joinCarry` alone would drop `sep` against an empty side). No carry → `next`. */
export function withCarry(carry: string, sep: string, next: string): string {
  if (!carry) return next;
  if (!next.trim()) return carry.trimEnd() + (sep === "" ? " " : sep);
  return joinCarry(carry, sep, next);
}

/** A character's CLASS, for logs that must not contain the text. "end" = past the string. */
export type CharClass = "end" | "space" | "newline" | "letter" | "digit" | "quote" | "punct" | "other";

export function charClass(c: string | undefined): CharClass {
  if (c === undefined || c === "") return "end";
  if (c === "\n" || c === "\r") return "newline";
  if (/\s/u.test(c)) return "space";
  if (/\p{L}/u.test(c)) return "letter";
  if (/\p{N}/u.test(c)) return "digit";
  // Quotes get their own class: the quote-spacing rule was the most common seam rewrite.
  if (/["'«»‹›“”„‟‘’‚‛`]/u.test(c)) return "quote";
  if (/\p{P}|\p{S}/u.test(c)) return "punct";
  return "other";
}

/** Where `doc` stops extending `typed`, or null when it does extend it (the normal, append-only
 *  case — including an empty `typed`). Indices and lengths in UTF-16 code units; the two
 *  characters at the divergence are reported as CLASSES only. A `doc` that is a strict prefix of
 *  `typed` (the document SHRANK) diverges at its end, with `docCh` "end". */
export function baselineDivergence(
  typed: string,
  doc: string,
): { at: number; typedLen: number; docLen: number; typedCh: CharClass; docCh: CharClass } | null {
  const at = commonPrefixLen(typed, doc);
  if (at === typed.length) return null;
  return {
    at,
    typedLen: typed.length,
    docLen: doc.length,
    typedCh: charClass(typed[at]),
    docCh: charClass(doc[at]),
  };
}
