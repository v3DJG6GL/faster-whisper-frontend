// Shared helpers for editing a `callback:map` ("Spoken symbols") pipeline rule —
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

/** Editor rows → the canonical `{ map }` body sent on PATCH. Trims keys, drops
 *  empties, and key-sorts the result so reordering rows for display (newest-first)
 *  is never mistaken for an edit in a dirty diff. */
export function mapBodyFromRows(rows: MapRow[]): { map: Record<string, string> } {
  const map: Record<string, string> = {};
  for (const r of rows) {
    const k = r.k.trim();
    if (k) map[k] = r.v;
  }
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  return { map: sorted };
}
