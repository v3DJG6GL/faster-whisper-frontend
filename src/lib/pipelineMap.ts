// Shared helpers for editing a `callback:map` ("Word mappings") pipeline rule —
// used by both the full Dictionary screen and the minimal QuickAdd window so the
// newest-first ordering and the canonical (key-sorted) PATCH body stay identical.

import type { PipelineFetch, PipelineRule } from "./types";

/** The pipeline `rules` as PipelineRule[]. Rust forwards the server's payload opaque
 *  (#[serde(default)] serde_json::Value), so a buggy/old/proxied server can deliver a non-array
 *  `rules` (or omit it) with ok:true — coerce at the boundary so the `.map`/`.find` consumers can't
 *  throw and white-screen the route. Returns [] unless ok AND rules is an array. */
export function ruleListOf(res: PipelineFetch): PipelineRule[] {
  const r = res.ok ? res.state?.rules : undefined;
  return Array.isArray(r) ? r : [];
}

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
  // Rows are newest-first; keep the FIRST occurrence of a duplicate key so the newest-shown mapping
  // wins — adding a new mapping for a phrase that already has one now takes effect, instead of being
  // silently overridden by the older (further-down) entry. hasOwnProperty (not `in`) so a key like
  // "toString" isn't falsely treated as already-present.
  for (const r of rows) {
    if (r.k.trim() && !Object.prototype.hasOwnProperty.call(map, r.k)) map[r.k] = r.v;
  }
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  return { map: sorted };
}

/** Apply a `callback:map` rule (the editor rows) to `text`, mirroring the backend's matcher
 *  exactly: longest-key-first, whole-word, case-insensitive, values inserted verbatim, ONE pass
 *  (no cascade). Used to correct a selected word against the current list on close.
 *
 *  Word boundaries are computed manually (not via regex `\b`, which is ASCII-only in JS, nor
 *  lookbehind, which older WebKitGTK lacks) so they're Unicode-aware AND depend on each key's edge
 *  char — reproducing Python's `\b(key)\b` for keys whose edge is a space/punct (e.g. " Prozent").
 *  Returns the transformed string, terminal-trimmed of spaces/tabs/CR like the backend's last step. */
export function applyMap(text: string, rows: MapRow[]): string {
  const map = new Map<string, string>();
  for (const r of rows) if (r.k.trim() && !map.has(r.k)) map.set(r.k, r.v); // newest-shown row wins on a dup
  if (map.size === 0) return text;
  // case-insensitive: lower-cased key → value (matches the backend's lowercased lookup dict)
  const lookup = new Map<string, string>();
  for (const [k, v] of map) lookup.set(k.toLowerCase(), v);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length); // longest first → phrases win

  let out = "";
  let i = 0;
  while (i < text.length) {
    let hit = "";
    for (const key of keys) {
      const kl = key.toLowerCase();
      // Compare the slice at the CURRENT position rather than a once-lowercased whole string:
      // a char whose lowercase changes length (e.g. Turkish "İ" → "i̇") would otherwise desync the
      // original-case index `i` from a precomputed lowercased string and silently miss every later key.
      if (text.slice(i, i + key.length).toLowerCase() !== kl) continue;
      const before = i > 0 ? text[i - 1] : "";
      const after = i + key.length < text.length ? text[i + key.length] : "";
      // \b on each side: a boundary sits where one neighbour is a word char and the other isn't.
      if (isBoundary(before, key[0]) && isBoundary(text[i + key.length - 1], after)) {
        hit = key;
        break; // first (longest) key that matches with boundaries wins
      }
    }
    if (hit) {
      out += lookup.get(hit.toLowerCase()) ?? hit;
      i += hit.length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out.replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "");
}

/** A `\b`-equivalent boundary: true when exactly one side is a word char (string edge = ""
 *  counts as a non-word char). Unicode-aware. */
function isBoundary(left: string, right: string): boolean {
  return isWordChar(left) !== isWordChar(right);
}
function isWordChar(ch: string): boolean {
  return ch !== "" && /[\p{L}\p{N}_]/u.test(ch);
}
