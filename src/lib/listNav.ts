// Keyboard movement through a flat option list (the language pickers, D87). Focus stays in the
// search field; these keys only move the highlighted row.

/** Rows PageUp/PageDown jump. */
export const PAGE_ROWS = 8;

/** The highlighted index after a navigation key, clamped to the list; null for any other key
 *  (the caller lets it through to the field). */
export function navKey(key: string, active: number, count: number): number | null {
  let next: number;
  switch (key) {
    case "ArrowDown": next = active + 1; break;
    case "ArrowUp": next = active - 1; break;
    case "PageDown": next = active + PAGE_ROWS; break;
    case "PageUp": next = active - PAGE_ROWS; break;
    case "Home": next = 0; break;
    case "End": next = count - 1; break;
    default: return null;
  }
  return Math.max(0, Math.min(count - 1, next));
}
