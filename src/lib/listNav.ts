// Keyboard movement through a flat option list (the language pickers, D87). Focus stays in the
// search field; these keys only move the highlighted row, and the field carries the combobox
// ARIA that points at it.

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

/** The DOM id of option `i` in the listbox `listId` (the target of aria-activedescendant). */
export const optionId = (listId: string, i: number) => `${listId}-opt-${i}`;

/** The search field's half of the listbox: it owns focus, the list follows `active`. */
export const comboboxInputProps = (listId: string, active: number, hasRow: boolean) => ({
  role: "combobox" as const,
  "aria-expanded": true,
  "aria-controls": listId,
  "aria-autocomplete": "list" as const,
  "aria-activedescendant": hasRow ? optionId(listId, active) : undefined,
});
