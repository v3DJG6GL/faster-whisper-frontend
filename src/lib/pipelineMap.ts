// Shared helpers for editing a `callback:map` ("Word mappings") pipeline rule —
// used by both the full Dictionary screen and the minimal QuickAdd window so the
// newest-first ordering and the canonical (key-sorted) PATCH body stay identical.

import type { PipelineRule } from "./types";

/** One editor row for a spoken→symbol mapping. `id` is a client-only stable React
 *  key (never persisted); `k` = spoken phrase, `v` = inserted symbol. */
export type MapRow = { id: number; k: string; v: string };

// Module-global row-id counter — unique, stable React keys for editor rows (map
// pairs, regex entries). Shared across editors that import it.
let _rowId = 1;
export const nextRowId = (): number => _rowId++;

/** A `callback:map` rule's pairs as editor rows, NEWEST FIRST (desc by the
 *  server-stamped `map_meta`; unstamped → treated as oldest). */
export function mapRowsFromRule(rule: PipelineRule): MapRow[] {
  return Object.entries(rule.map ?? {})
    .map(([k, v]) => ({ id: nextRowId(), k, v }))
    .sort((a, b) => (rule.map_meta?.[b.k] ?? 0) - (rule.map_meta?.[a.k] ?? 0));
}

/** Editor rows → the canonical `{ map }` body sent on PATCH. Keeps each key
 *  VERBATIM, drops only unfilled rows, and key-sorts the result so reordering
 *  rows for display (newest-first) is never mistaken for an edit in a dirty diff.
 *
 *  Leading/trailing whitespace in a key is MEANINGFUL and must be preserved — the
 *  backend accepts it (the cb:map key pattern includes a space) and matches it
 *  literally at dictation time (`\b(re.escape(key))\b`), so " quote" and "quote "
 *  are distinct mappings. Trimming here collapsed them to one entry AND made a
 *  whitespace-only edit invisible to the dirty diff (no Save offered). We only
 *  skip rows the user never filled in (blank/whitespace-only key). */
export function mapBodyFromRows(rows: MapRow[]): { map: Record<string, string> } {
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (r.k.trim()) map[r.k] = r.v;
  }
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  return { map: sorted };
}
