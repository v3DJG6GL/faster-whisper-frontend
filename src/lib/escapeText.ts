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
