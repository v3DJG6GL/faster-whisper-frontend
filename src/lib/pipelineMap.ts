// Shared helpers for reading and editing pipeline rules (above all the `callback:map`
// "Word mappings" rule) — one copy for every screen that touches them, so the
// newest-first ordering and the canonical (key-sorted) PATCH body stay identical.

import type { PipelineFetch, PipelineRule, PipelineRulesState, PipelineSaveResult } from "./types";
import { fmtFull } from "./format";
import { ownProp } from "./own";

/** The setting names the server's environment pinned, so the save did not change them. `env_pinned_ignored`
 *  is opaque server JSON: coerce it like `errors`/`conflicts`. In practice it is only ever `PIPELINE_RULES`
 *  (the WHOLE rule list), never a rule name. */
export function envPinnedOf(result: PipelineSaveResult): string[] {
  return (Array.isArray(result.env_pinned_ignored) ? result.env_pinned_ignored : [])
    .filter((s): s is string => typeof s === "string")
    .slice(0, 16);
}

/** The PATCH reached the server: `ok`, or a 2xx whose reply couldn't be read or parsed. That save
 *  LANDED (see PipelineSaveResult in types.ts): reload, never treat it as unsaved. */
export function saveLanded(r: PipelineSaveResult): boolean {
  return r.ok || (r.status >= 200 && r.status < 300);
}

/** The setting that holds every rule: pinned, nothing in the save takes effect. */
export const RULE_LIST_SETTING = "PIPELINE_RULES";

/** The pipeline `rules` as PipelineRule[]. Rust forwards the server's payload opaque
 *  (#[serde(default)] serde_json::Value), so a buggy/old/proxied server can deliver a non-array
 *  `rules` (or omit it) with ok:true — coerce at the boundary so the `.map`/`.find` consumers can't
 *  throw and white-screen the route. Returns [] unless ok AND rules is an array. */
export function ruleListOf(res: PipelineFetch): PipelineRule[] {
  const r = res.ok ? res.state?.rules : undefined;
  if (!Array.isArray(r)) return [];
  // The coercion has to reach the ELEMENTS, not just the container. Rust forwards `rules` as an
  // opaque Value, so every field is server-shaped, and both screens deref them at RENDER time:
  // `(rule.tags ?? []).slice()` throws on a string, and a non-string `label`/`type`/`note` throws
  // "Objects are not valid as a React child". With no error boundary in the tree either throw
  // unmounts the window — the main one for Dictionary, the hotkey-summoned one for QuickAdd.
  return r
    .filter((x): x is PipelineRule => !!x && typeof x === "object")
    .slice(0, MAX_RULES)
    .map((rule) => ({
      ...rule,
      name: str(rule.name),
      label: str(rule.label),
      type: str(rule.type) as PipelineRule["type"],
      note: rule.note === undefined ? undefined : str(rule.note),
      color: rule.color === undefined ? undefined : str(rule.color),
      tags: Array.isArray(rule.tags) ? rule.tags.filter((t) => typeof t === "string") : undefined,
      entries: Array.isArray(rule.entries)
        ? rule.entries.filter((e) => !!e && typeof e === "object")
        : undefined,
      wordlist: Array.isArray(rule.wordlist)
        ? rule.wordlist.filter((w) => typeof w === "string")
        : undefined,
      // The leaves that drive the editor. `mapRowsFromRule` runs `Object.entries` over `map`,
      // which on a STRING expands per code point — a row object each plus a sort on the UI
      // thread, before any render cap (those bound the DOM, not this array): tens of millions
      // for a 32 MiB field. QuickAdd reaches it from a mount effect at startup with no user gesture.
      map: plainMap(rule.map, (x): x is string => typeof x === "string"),
      map_meta: plainMap(rule.map_meta, (x): x is number => typeof x === "number" && Number.isFinite(x)),
    }));
}

const MAX_RULES = 500;

/** How many rules the server sent, before `ruleListOf`'s cap — the same object filter, no slice
 *  (the "first N of M" note's M). 0 unless ok AND rules is an array. */
export function ruleCountOf(res: PipelineFetch): number {
  const r = res.ok ? res.state?.rules : undefined;
  return Array.isArray(r) ? r.filter((x) => !!x && typeof x === "object").length : 0;
}

/** A locked rule is read-only for a non-admin: the server refuses their PATCH of it with a 403
 *  (an admin owns the flag and may patch it, as the web /quick-config editor does). The ONE
 *  lock test the Dictionary and quick-add share. */
export function ruleLockedFor(rule: PipelineRule, role: PipelineRulesState["role"] | undefined): boolean {
  return !!rule.locked && role !== "admin";
}

/** May this caller PATCH the rule's `map`? Not when it is locked for them (`ruleLockedFor`), nor
 *  when the server's `editable_fields` for its type omits "map". `editable_fields` is forwarded
 *  as an opaque server value, so it is coerced like the Dictionary does (a plain object, an
 *  array per type) before anything is read from it. */
export function ruleMapWritable(rule: PipelineRule, state: PipelineRulesState | undefined): boolean {
  if (ruleLockedFor(rule, state?.role)) return false;
  const ef = state?.editable_fields as unknown;
  if (!ef || typeof ef !== "object" || Array.isArray(ef)) return false;
  const f = ownProp(ef as Record<string, unknown>, rule.type);
  return Array.isArray(f) && f.includes("map");
}

/** A server-supplied field that the editors treat as a plain string→value record.
 *  Anything else (a string, an array, a scalar) becomes undefined rather than being
 *  enumerated. The entry ceiling is deliberately generous — this map is the user's own
 *  word list and the editor PATCHes it back whole, so a tight cap would delete their
 *  entries on the next save; it only has to keep the enumeration finite. Values that are
 *  not the declared leaf type are dropped, not coerced (a dropped map entry means the
 *  server's value was unusable anyway). */
function plainMap<T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter((e): e is [string, T] => ok(e[1]))
    .slice(0, MAX_MAP_ENTRIES);
  return Object.fromEntries(entries);
}

const MAX_MAP_ENTRIES = 20_000;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One editor row for a spoken→symbol mapping. `id` is a client-only stable React
 *  key (never persisted); `k` = spoken phrase, `v` = inserted symbol. */
export type MapRow = { id: number; k: string; v: string };

// Module-global so React keys stay unique and stable across every editor's rows (map pairs,
// regex entries).
let _rowId = 1;
export const nextRowId = (): number => _rowId++;

/** A `callback:map` rule's pairs as editor rows, NEWEST FIRST (desc by the
 *  server-stamped `map_meta`; unstamped → treated as oldest). */
export function mapRowsFromRule(rule: PipelineRule): MapRow[] {
  return Object.entries(rule.map ?? {})
    .map(([k, v]) => ({ id: nextRowId(), k, v }))
    .sort((a, b) => {
      const tb = ownProp(rule.map_meta, b.k) ?? 0;
      const ta = ownProp(rule.map_meta, a.k) ?? 0;
      return tb - ta;
    });
}

/** Editor rows → the canonical `{ map }` body sent on PATCH. Keeps each key
 *  VERBATIM, drops only unfilled rows, and key-sorts the result so reordering
 *  rows for display (newest-first) is never mistaken for an edit in a dirty diff.
 *
 *  Leading/trailing whitespace in a key is MEANINGFUL — the backend accepts it (the
 *  cb:map key pattern includes a space) and matches it literally at dictation time
 *  (`\b(re.escape(key))\b`), so " quote" and "quote " are distinct mappings; trimming
 *  would merge them and hide a whitespace-only edit from the dirty diff. */
export function mapBodyFromRows(rows: MapRow[]): { map: Record<string, string> } {
  // Rows are newest-first; keep the FIRST occurrence of a duplicate key so the newest-shown mapping
  // wins over an older entry further down. A Map (not a plain object) so a key like "toString"
  // isn't falsely treated as already-present and "__proto__" isn't swallowed by the inherited
  // setter; Object.fromEntries then defines every key as an own property.
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.k.trim() && !m.has(r.k)) m.set(r.k, r.v);
  }
  return { map: Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

/** The server's bound on both sides of a mapping (MapRule in settings/schema.py), in code points. */
export const MAP_FIELD_MAX = 64;

/** One character the server's MapRule key pattern `^[\w \-.,!?ßẞÄÖÜäöü]{1,64}$` takes. Pydantic
 *  runs it on the Rust regex engine, whose Unicode `\w` is Alphabetic + marks + decimal digits +
 *  connector punctuation + join controls — mirrored property for property, so nothing the server
 *  takes is refused here (the listed umlauts are Alphabetic already). */
const MAP_KEY_CHAR = /^[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} \-.,!?]$/u;

/** Why the server would refuse this spoken-phrase → insert pair, or null when it takes it. The map
 *  is PATCHed whole, so ONE pair the schema rejects (a 422) blocks every later save of the list —
 *  an editor must refuse it up front, with this reason, rather than send it. */
export function mapEntryProblem(k: string, v: string): string | null {
  const key = [...k];
  if (key.length === 0) return "Say a phrase first";
  if (key.length > MAP_FIELD_MAX) return `The phrase is too long (at most ${MAP_FIELD_MAX} characters)`;
  const bad = key.find((c) => !MAP_KEY_CHAR.test(c));
  if (bad !== undefined) return `${shownChar(bad)} can’t be in a spoken phrase (letters, digits, spaces and - . , ! ? only)`;
  if ([...v].length > MAP_FIELD_MAX) return `The insert is too long (at most ${MAP_FIELD_MAX} characters)`;
  return null;
}

/** One refused character as a reason names it. An invisible one is named by its code point —
 *  quoting it would show nothing. */
function shownChar(c: string): string {
  const hex = (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return c === "\t" ? "A tab" : /[\p{C}\p{Z}]/u.test(c) ? `U+${hex}` : `“${c}”`;
}

/** Why key `k` can't join the list beside `rows` (the row `selfId` it replaces excluded), or null.
 *  The server lower-cases a map's keys and rejects the whole PATCH (422) when two collide, so a
 *  case twin ("Komma" beside "komma") would block every later save. An exact duplicate is not a
 *  twin: mapBodyFromRows sends one key for it (the newest row wins). */
export function mapKeyTwinProblem(k: string, rows: MapRow[], selfId?: number): string | null {
  const lower = k.toLowerCase();
  const twin = rows.find((r) => r.id !== selfId && r.k !== k && r.k.trim() && r.k.toLowerCase() === lower);
  return twin ? twinReason(twin.k) : null;
}

const twinReason = (other: string) => `“${other}” is already in this list — edit that row`;

/** Why an inline edit turning `row` into `next` is refused, or null to take it. Only the per-pair
 *  rules (mapEntryProblem) refuse a keystroke: they are prefix-closed — every prefix of a phrase
 *  they take is taken too — so typing a character at a time always reaches a valid phrase. A case
 *  twin is not ("Komma" lies on the way to "Kommandozeile" beside "komma"): it is a list-level
 *  problem (mapRowTwinProblems), shown under the row and holding the save, never a refused key.
 *  A row already out of bounds takes any edit, so it can be fixed a keystroke at a time; a blank
 *  phrase is never sent (mapBodyFromRows drops it). */
export function mapRowEditProblem(row: MapRow, next: MapRow): string | null {
  const problemOf = (r: MapRow) => (r.k.trim() ? mapEntryProblem(r.k, r.v) : null);
  const problem = problemOf(next);
  return problem && !problemOf(row) ? problem : null;
}

/** Each row whose phrase has a case twin elsewhere in `rows`, by row id, with the reason naming the
 *  other spelling. The server would 422 the whole-map PATCH while any remains, so an editor holds
 *  the save until this is empty. One pass — the list can run to thousands of rows. */
export function mapRowTwinProblems(rows: MapRow[]): Map<number, string> {
  const spellings = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.k.trim()) continue;
    const lower = r.k.toLowerCase();
    const seen = spellings.get(lower);
    if (!seen) spellings.set(lower, [r.k]);
    else if (!seen.includes(r.k)) seen.push(r.k);
  }
  const out = new Map<number, string>();
  for (const r of rows) {
    if (!r.k.trim()) continue;
    const other = spellings.get(r.k.toLowerCase())?.find((s) => s !== r.k);
    if (other !== undefined) out.set(r.id, twinReason(other));
  }
  return out;
}

/** The server's cap on one map's entries (MapRule.map's max_length in settings/schema.py; the
 *  quick-config PATCH refuses a map over it with a 400 before validating anything). plainMap's read
 *  ceiling is deliberately looser: it only bounds enumeration and must never trim a list. */
export const MAP_ENTRIES_MAX = 10_000;

/** The first reason the server would refuse a whole-map PATCH of `rows`, or null when it takes them:
 *  a pair the schema rejects (a row already out of bounds — the editors refuse only the keystroke
 *  that would make one), more keys than the map may hold, or a case twin. Blank rows are never sent,
 *  and an exact duplicate is one key on the wire (mapBodyFromRows). */
export function mapRowsProblem(rows: MapRow[]): string | null {
  const keys = new Set<string>();
  for (const r of rows) {
    if (!r.k.trim()) continue;
    const p = mapEntryProblem(r.k, r.v);
    if (p) return p;
    keys.add(r.k);
  }
  if (keys.size > MAP_ENTRIES_MAX) {
    return `The list is too long (at most ${fmtFull(MAP_ENTRIES_MAX)} mappings) — delete ${keys.size - MAP_ENTRIES_MAX} to save`;
  }
  return mapRowTwinProblems(rows).values().next().value ?? null;
}

/** The server's bounds on the other rule bodies the Dictionary edits (settings/schema.py), in code
 *  points: the `pattern` of a lowercase-wordlist / dedup / upper rule and a regex-list entry's
 *  pattern and replacement (RULE_PATTERN_MAX), an entry's label and note, and the lowercase word
 *  list (LowercaseWordlistRule.wordlist: 1–32 letters each, at most 2000 words). */
export const RULE_PATTERN_MAX = 512;
export const ENTRY_LABEL_MAX = 80;
export const ENTRY_NOTE_MAX = 4000;
export const LOWERCASE_WORD_MAX = 32;
export const LOWERCASE_WORDS_MAX = 2000;
/** One character the server's lowercase-word pattern `^[A-Za-zÄÖÜäöüß]+$` takes. */
const LOWERCASE_WORD_CHAR = /^[A-Za-zÄÖÜäöüß]$/;

/** The first reason the server would 422 a rule PATCH carrying these body fields (`wordlist`,
 *  `pattern`, `entries` — the map has mapRowsProblem), or null when it takes them. The PATCH carries
 *  every dirty rule and the server re-validates the whole list, so ONE such field fails the whole
 *  save: the Dictionary holds it with this reason, as it does for a map. */
export function rulePatchProblem(patch: Record<string, unknown>): string | null {
  const tooLong = (what: string, v: unknown, max: number) =>
    typeof v === "string" && [...v].length > max ? `${what} is too long (at most ${fmtFull(max)} characters)` : null;
  const p = tooLong("The pattern", patch.pattern, RULE_PATTERN_MAX);
  if (p) return p;
  if (Array.isArray(patch.entries)) {
    for (const [i, raw] of patch.entries.entries()) {
      const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const n = `Entry ${i + 1}’s`;
      const ep =
        tooLong(`${n} pattern`, e.pattern, RULE_PATTERN_MAX) ??
        tooLong(`${n} replacement`, e.replacement, RULE_PATTERN_MAX) ??
        tooLong(`${n} label`, e.label, ENTRY_LABEL_MAX) ??
        tooLong(`${n} note`, e.note, ENTRY_NOTE_MAX);
      if (ep) return ep;
    }
  }
  if (Array.isArray(patch.wordlist)) {
    if (patch.wordlist.length > LOWERCASE_WORDS_MAX) {
      return `Too many lowercase words (at most ${fmtFull(LOWERCASE_WORDS_MAX)})`;
    }
    for (const w of patch.wordlist) {
      if (typeof w !== "string") continue;
      const chars = [...w];
      if (chars.length > LOWERCASE_WORD_MAX) {
        return `“${chars.slice(0, 16).join("")}…” is too long for a lowercase word (at most ${LOWERCASE_WORD_MAX} letters)`;
      }
      const bad = chars.find((c) => !LOWERCASE_WORD_CHAR.test(c));
      if (bad !== undefined) return `${shownChar(bad)} can’t be in a lowercase word (letters A–Z, ÄÖÜ, äöü and ß only)`;
    }
  }
  return null;
}

/** Apply a `callback:map` rule (the editor rows) to `text`, mirroring the backend's matcher
 *  (`compile_map`): longest-key-first, whole-word, case-insensitive, values inserted verbatim, ONE
 *  pass (no cascade), and every ß key also matches its derived ss spelling (ß→ss, ẞ→SS; a key
 *  written with ss explicitly wins) because the Swiss cleanup rewrites ß before the map runs. Not
 *  mirrored: the dictated-punctuation prefix, which a selection never carries. Used to correct a
 *  selected word against the current list on close.
 *
 *  Word boundaries are computed manually (not via regex `\b`, which is ASCII-only in JS, nor
 *  lookbehind, which older WebKitGTK lacks) so they're Unicode-aware AND depend on each key's edge
 *  char — reproducing Python's `\b(key)\b` for keys whose edge is a space/punct (e.g. " Prozent").
 *  Returns the transformed string, terminal-trimmed of spaces/tabs/CR like the backend's last step. */
export function applyMap(text: string, rows: MapRow[]): string {
  // Built over the SAVED body, as compile_map builds over the stored map: an exact duplicate key
  // goes to the newest row (mapBodyFromRows keeps it), and keys differing only in case are ONE
  // mapping on the server — its lookup is keyed by the lower-cased key, filled in the saved map's
  // (code-point sorted) key order, so the code-point-last twin's value wins for every spelling.
  const entries = Object.entries(mapBodyFromRows(rows).map);
  if (entries.length === 0) return text;
  const lookup = new Map<string, string>();
  for (const [k, v] of entries) lookup.set(k.toLowerCase(), v);
  const keys = entries.map(([k]) => k);
  // The backend's derived ss variants: added only when no key (any case) already spells it, in
  // the saved map's key order, so two ß keys differing only in case give their shared variant
  // the same value as on the server.
  for (const [k, v] of entries) {
    const derived = k.replace(/ß/g, "ss").replace(/ẞ/g, "SS");
    if (derived !== k && !lookup.has(derived.toLowerCase())) {
      lookup.set(derived.toLowerCase(), v);
      keys.push(derived);
    }
  }
  keys.sort((a, b) => b.length - a.length); // longest first → phrases win
  const lowered = keys.map((k) => [k, k.toLowerCase()] as const);

  let out = "";
  let i = 0;
  while (i < text.length) {
    let hit = "";
    for (const [key, kl] of lowered) {
      // Compare the slice at the CURRENT position rather than a once-lowercased whole string:
      // a char whose lowercase changes length (e.g. Turkish "İ" → "i̇") would otherwise desync the
      // original-case index `i` from a precomputed lowercased string and silently miss every later key.
      if (text.slice(i, i + key.length).toLowerCase() !== kl) continue;
      // Whole code points on each edge (Python's \b is code-point based): a lone surrogate half of
      // an astral letter (CJK Ext-B, math alphanumerics) would not test as a word char.
      const before = cpBefore(text, i);
      const after = cpAt(text, i + key.length);
      if (isBoundary(before, cpAt(key, 0)) && isBoundary(cpBefore(key, key.length), after)) {
        hit = key;
        break;
      }
    }
    if (hit) {
      out += lookup.get(hit.toLowerCase()) ?? hit; // hit is always a key → the server's value for it
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
/** The code point starting at UTF-16 index `i` ("" past either end). */
function cpAt(s: string, i: number): string {
  return i >= 0 && i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : "";
}
/** The code point ending just before UTF-16 index `i` ("" at the start): both halves of a
 *  surrogate pair, else the single unit. */
function cpBefore(s: string, i: number): string {
  if (i <= 0) return "";
  const lo = s.charCodeAt(i - 1);
  if (i >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function isWordChar(ch: string): boolean {
  return ch !== "" && /[\p{L}\p{N}_]/u.test(ch);
}

/** What a collapsed cb:map list can honestly promise: `hidden` = rows the toggle reveals,
 *  `unshown` = rows past the render cap that nothing on screen can show. */
export function collapseCounts(total: number, collapseAfter: number, max: number): { hidden: number; unshown: number } {
  const ceil = Math.min(total, max);
  const collapsed = Math.min(collapseAfter, max);
  const hidden = collapseAfter > 0 && ceil > collapsed ? ceil - collapsed : 0;
  return { hidden, unshown: Math.max(0, total - max) };
}
