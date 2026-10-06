// A one-line text field that edits a value which may hold a line break or a tab (the hard-break
// separator): the field shows `\n` / `\t`, the stored value holds the real characters. A literal
// backslash is shown doubled so every value round-trips: unescapeText(escapeText(s)) === s.

/** The stored value as the field shows it. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** What the user typed, as the value to store: `\n` → line break, `\t` → tab, `\\` → `\`.
 *  Any other backslash stays as typed, so a half-typed escape never loses a character. */
export function unescapeText(s: string): string {
  return s.replace(/\\([\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));
}

/** What a controlled escaped field shows: the text as typed (`draft`) while it still means the
 *  stored `value`, so a half-typed escape such as a lone `\` isn't re-rendered doubled before the
 *  `n` that completes it; otherwise (no draft, or the value changed from outside: a reset, a
 *  maxLength cut) the escaped value. */
export function escapedFieldText(draft: string | null, value: string): string {
  return draft !== null && unescapeText(draft) === value ? draft : escapeText(value);
}
