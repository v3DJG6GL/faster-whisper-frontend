// "Dictionary" — view + edit the backend's post-processing (pipeline) rules the
// caller is permitted to (GET/PATCH /v1/pipeline-rules). This is LIVE server
// state, not local config: pick a Backend, fetch its rules, edit the bodies your
// account may change, push the diff back. Mirrors the server's /quick-config
// gating — the client only exposes `enabled` + the per-type body (editable_fields);
// a locked rule is read-only for a non-admin caller (an admin owns the lock and may
// still patch it, as the server enforces); name/label/tags/colour/lock are read-only
// context (admin-only on the web).
//
// Rendering note: per-rule fields are plain controlled inputs inside the stable,
// module-scope <RuleCard> (keyed by slug) — never a component redefined per
// render — so editing never remounts an input (cf. DecodeFields focus-loss caveat).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { screenEyebrow, screenTitle } from "@/lib/screenRegistry";
import { ruleListLabel, safeDisplayText } from "@/lib/sanitize";
import { ownProp } from "@/lib/own";
import { backendLabel, backendLabelById, effectiveServerUrl } from "@/lib/backends";
import {
  BookA, Loader2, RefreshCw, Plus, Trash2, Lock, RotateCcw, ChevronRight,
  AlertTriangle, Check, Crosshair, Info,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { Badge, Button, Card, ConfirmLeave, Labeled, Notice, SectionLabel, Stack, Toggle, TextInput } from "@/components/ui";
import { plural } from "@/lib/format";
import { Combobox } from "@/components/Combobox";
import { QuickAddShortcutField } from "@/components/QuickAddShortcutField";
import { ReorderControls } from "@/components/ReorderControls";
import { IS_LINUX } from "@/lib/platform";
import {
  type MapRow, collapseCounts, nextRowId, mapRowsFromRule, mapBodyFromRows, mapEntryProblem, mapRowEditProblem, mapRowTwinProblems,
  mapRowsProblem, rulePatchProblem, ruleListOf, ruleCountOf, ruleLockedFor, envPinnedOf, saveLanded, RULE_LIST_SETTING,
} from "@/lib/pipelineMap";
import { ruleDotColor } from "@/lib/ruleColor";
import { swap } from "@/lib/arr";
import { effectiveServerKind } from "@/lib/serverKind";
import {
  dictionaryConflictText,
  dictionaryHeldResolution,
  dictionaryLandedText,
  dictionaryLoadAction,
  dictionaryReloadStep,
  dictionarySavedText,
  dictionarySelection,
} from "@/lib/dictionaryHold";
import { getPipelineRules, getRecentWords, savePipelineRules } from "@/lib/api";
import type {
  Backend, PipelineFetch, PipelineRule, PipelineSaveResult, RuleType,
} from "@/lib/types";
import { cn } from "@/lib/cn";

const TYPE_LABEL: Record<RuleType, string> = {
  "regex-list": "Find & replace",
  "callback:map": "Word mappings",
  "callback:lowercase-wordlist": "Lowercase words",
  "callback:dedup": "De-duplicate",
  "callback:upper": "Capitalize",
  terminal: "Trim",
};

const mkId = nextRowId;

// Deep-clone an edit snapshot (plain JSON); the round-trip intentionally drops undefined fields.
const cloneEdits = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

type EntryRow = { id: number; pattern: string; replacement: string; label?: string; note?: string };
interface EditState {
  enabled: boolean;
  entries?: EntryRow[]; // regex-list
  pairs?: MapRow[]; // callback:map
  pattern?: string; // dedup / upper / lowercase-wordlist
  words?: string; // lowercase-wordlist (textarea, one per line)
}

function toEdit(rule: PipelineRule): EditState {
  const e: EditState = { enabled: rule.enabled };
  switch (rule.type) {
    case "regex-list":
      e.entries = (rule.entries ?? []).map((en) => ({
        id: mkId(), pattern: en.pattern ?? "", replacement: en.replacement ?? "",
        label: en.label, note: en.note,
      }));
      break;
    case "callback:map":
      e.pairs = mapRowsFromRule(rule);
      break;
    case "callback:lowercase-wordlist":
      e.pattern = rule.pattern ?? "";
      e.words = (rule.wordlist ?? []).join("\n");
      break;
    case "callback:dedup":
    case "callback:upper":
      e.pattern = rule.pattern ?? "";
      break;
  }
  return e;
}

/** The body fields a patch would carry for this rule type, in canonical form
 *  (used both for the save payload and for dirty-comparison via JSON equality). */
function emitBody(type: RuleType, e: EditState): Record<string, unknown> {
  switch (type) {
    case "regex-list":
      return {
        entries: (e.entries ?? []).map((r) => {
          const o: Record<string, unknown> = { pattern: r.pattern, replacement: r.replacement };
          if (r.label) o.label = r.label;
          if (r.note) o.note = r.note;
          return o;
        }),
      };
    case "callback:map":
      return mapBodyFromRows(e.pairs ?? []);
    case "callback:lowercase-wordlist":
      return {
        pattern: e.pattern ?? "",
        wordlist: (e.words ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      };
    case "callback:dedup":
    case "callback:upper":
      return { pattern: e.pattern ?? "" };
    default:
      return {};
  }
}

// The base side's canonical body, memoized by the base EditState reference: base only changes on
// a load (patchEdit/resetRule clone, never mutate it), so a keystroke re-emits just the edit side —
// on a large word-mapping list each side is a whole-map sort + stringify. A base object belongs to
// one rule, so it has one type.
const baseJsonCache = new WeakMap<EditState, string>();
function canonJson(type: RuleType, e: EditState): string {
  let s = baseJsonCache.get(e);
  if (s === undefined) {
    s = JSON.stringify(emitBody(type, e));
    baseJsonCache.set(e, s);
  }
  return s;
}

/** Build the minimal patch (changed allow-listed fields only) for one rule.
 *  Empty object ⇒ unchanged. A rule locked for a non-admin caller passes `editable = []` ⇒
 *  never dirty. */
function buildPatch(type: RuleType, edit: EditState, base: EditState, editable: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (editable.includes("enabled") && edit.enabled !== base.enabled) patch.enabled = edit.enabled;
  const bodyFields = editable.filter((f) => f !== "enabled");
  if (bodyFields.length) {
    const cur = emitBody(type, edit);
    if (JSON.stringify(cur) !== canonJson(type, base)) {
      for (const f of bodyFields) if (f in cur) patch[f] = cur[f];
    }
  }
  return patch;
}


function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="mb-1.5 block text-[11.5px] font-medium text-dim">{children}</label>;
}

// Render ceilings on the server-authored pipeline-rules payload (QuickAdd caps the same lists:
// `MAX_SHOWN_ROWS` / `MAX_RECENT_WORDS`). The server's `map_collapse_after` can't be the bound —
// the payload would choose its own limit.
// RENDER-ONLY, never applied to `edit.pairs` / `edit.entries`: the save PATCHes those back whole,
// so capping the state would delete every server entry past the cap.
// The rule list needs none here: `ruleListOf` already caps it (ruleCountOf counts before the cap).
const MAX_SHOWN_MAP_ROWS = 500;
// A regex list's entries: the server's own cap (RegexListRule.entries max_length in settings/schema.py),
// so Add stops where a Save would 422. Also the render bound for a payload that ignores it.
const MAX_REGEX_ENTRIES = 200;
const MAX_RECENT_WORDS = 500;

function RuleCard({
  rule, edit, editable, dirty, expanded, mapCollapseAfter, recentWords, recentMax,
  pinned, saving, readOnlyLock, onTogglePin, onToggleExpand, onPatch, onReset,
}: {
  rule: PipelineRule;
  edit: EditState;
  editable: string[];
  /** Locked AND the caller is not an admin: the server refuses every patch to it. An admin owns
   *  the lock and keeps the rule editable (the Lock icon still shows). */
  readOnlyLock: boolean;
  dirty: boolean;
  expanded: boolean;
  mapCollapseAfter: number;
  recentWords: string[];
  recentMax?: number;
  pinned: boolean;
  saving: boolean;
  onTogglePin?: () => void;
  onToggleExpand: () => void;
  onPatch: (updater: (e: EditState) => EditState) => void;
  onReset: () => void;
}) {
  const locked = !!rule.locked;
  const canEnable = editable.includes("enabled");
  const bodyEditable = editable.some((f) => f !== "enabled");
  // Freeze the body inputs while a save is in flight: on success the save re-syncs from server
  // truth (load → setEdits), which would silently discard — with no unsaved-changes warning — any
  // keystroke typed during the network round-trip. The show/hide below keeps using bodyEditable so
  // controls gray in place rather than vanishing for the brief save.
  const inputsDisabled = !bodyEditable || saving;
  // Memoized: RuleCard is unmemoized with inline arrow props, so every card re-renders on every
  // keystroke anywhere on the screen, and the count splits the whole server-supplied wordlist.
  // Do NOT cap the list instead — `emitBody` PATCHes the whole `wordlist` back from `e.words`,
  // so a cap would delete the user's server-side words.
  const wordsCount = useMemo(() => wordCount(edit.words), [edit.words]);
  // `dirty` comes from the parent's cache: buildPatch here would re-sort + stringify the whole map
  // in every card on every keystroke.
  const dotHex = ruleDotColor(rule.color);
  // Per-entry note show/hide override. Default is open iff the entry already has
  // a note; a single toggle both reveals AND hides it (content is preserved).
  const [noteShow, setNoteShow] = useState<Map<number, boolean>>(() => new Map());
  const [mapShowAll, setMapShowAll] = useState(false);
  // The just-added cb:map row — auto-focus its key so suggestions open at once.
  const [justAddedId, setJustAddedId] = useState<number | null>(null);
  // One-shot: the new row takes focus on its mount; a later remount (collapse + re-expand) must not.
  // Effects run after the row's mount-time autoFocus, so clearing here keeps that first focus.
  useEffect(() => {
    if (justAddedId !== null) setJustAddedId(null);
  }, [justAddedId]);
  // Same one-shot for a just-opened empty note: focus it once, not on every re-expand of the rule.
  const [noteFocusId, setNoteFocusId] = useState<number | null>(null);
  useEffect(() => {
    if (noteFocusId !== null) setNoteFocusId(null);
  }, [noteFocusId]);

  const setEntries = (fn: (rows: EntryRow[]) => EntryRow[]) =>
    onPatch((e) => ({ ...e, entries: fn(e.entries ?? []) }));
  const setPairs = (fn: (rows: MapRow[]) => MapRow[]) =>
    onPatch((e) => ({ ...e, pairs: fn(e.pairs ?? []) }));
  // A mapping edit the server's word-list schema would reject, refused with its reason under the row
  // (as Quick-Add does): the map is PATCHed whole, so its 422 would fail the whole Save.
  const [pairProblem, setPairProblem] = useState<{ id: number; msg: string } | null>(null);
  const editPair = (row: MapRow, field: "k" | "v", value: string): boolean => {
    const problem = mapRowEditProblem(row, { ...row, [field]: value });
    if (problem) {
      setPairProblem({ id: row.id, msg: problem });
      return false;
    }
    setPairProblem((p) => (p?.id === row.id ? null : p));
    setPairs((rows) => rows.map((r) => (r.id === row.id ? { ...r, [field]: value } : r)));
    return true;
  };

  // cb:map recent-word suggestions: the fetched pool minus keys already mapped
  // in THIS rule (case-insensitive), so we never re-suggest an existing mapping.
  // Picking a suggestion fills the key, then jumps focus to its value field.
  const valueRefs = useRef<Map<number, HTMLInputElement | null>>(new Map());
  const usedKeys = useMemo(
    () => new Set((edit.pairs ?? []).map((p) => p.k.trim().toLowerCase()).filter(Boolean)),
    [edit.pairs],
  );
  const keySuggestions = useMemo(
    () => recentWords.filter((w) => !usedKeys.has(w.toLowerCase())),
    [recentWords, usedKeys],
  );

  const entriesTotal = edit.entries?.length ?? 0;
  const shownEntries = (edit.entries ?? []).slice(0, MAX_REGEX_ENTRIES);
  const mapPairs = edit.pairs ?? [];
  // Over every row, not just the shown ones: a twin can sit past the render cap. The parent holds
  // the Save while any remains (mapRowsProblem).
  const mapTwins = useMemo(() => mapRowTwinProblems(edit.pairs ?? []), [edit.pairs]);
  // Clamped to what expanding actually reveals (MAX_SHOWN_MAP_ROWS), so "Show N older" never
  // promises rows past the render cap.
  const { hidden: mapHidden, unshown: mapUnshown } = collapseCounts(
    rule.type === "callback:map" ? mapPairs.length : 0,
    mapCollapseAfter,
    MAX_SHOWN_MAP_ROWS,
  );
  // Even "show all" stays bounded: `mapCollapseAfter` is server-chosen, so it cannot be the only
  // ceiling. Expanding shows at most MAX_SHOWN_MAP_ROWS regardless of what the payload asked for.
  const mapShown =
    mapHidden > 0 && !mapShowAll
      ? mapPairs.slice(0, Math.min(mapCollapseAfter, MAX_SHOWN_MAP_ROWS))
      : mapPairs.slice(0, MAX_SHOWN_MAP_ROWS);

  return (
    <Card edge={dirty ? "strong" : undefined} className="overflow-hidden transition-colors">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="ring-signal flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ChevronRight className={cn("size-4 shrink-0 text-faint transition-transform", expanded && "rotate-90")} />
          {dotHex && (
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotHex }} aria-hidden />
          )}
          <span className="truncate text-[14px] font-medium text-text">{ruleListLabel(rule.label, rule.name, 120)}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes" aria-hidden />}
          <Badge>{ownProp(TYPE_LABEL, rule.type) ?? safeDisplayText(rule.type, 40)}</Badge>
          {pinned && <Badge tone="accent">quick-add</Badge>}
          {locked && (
            <span
              className="inline-flex items-center gap-1 text-faint"
              title={readOnlyLock ? "Locked by the server admin — read-only" : "Locked: only admins can edit it"}
            >
              <Lock className="size-3" />
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* ruleListOf does not de-duplicate tags (an admin rule can repeat one): key by position. */}
          {(rule.tags ?? []).slice(0, 3).map((t, i) => (
            <Badge key={`${i}-${t}`} tone="dim">{safeDisplayText(t, 40)}</Badge>
          ))}
        </div>
        {rule.type === "callback:map" && onTogglePin && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={
              (pinned ? "Pinned as the quick-add list — click to unpin" : "Set as the quick-add list") +
              (readOnlyLock ? " (locked — quick-add can't add to it)" : "")
            }
            className={cn(
              "ring-signal grid size-7 shrink-0 place-items-center rounded-md transition-colors",
              pinned ? "bg-accent-soft text-accent" : "text-faint hover:text-text",
            )}
          >
            <Crosshair className="size-4" />
          </button>
        )}
        <Toggle
          ariaLabel="Enable rule"
          checked={edit.enabled}
          disabled={!canEnable || saving}
          onChange={(v) => onPatch((e) => ({ ...e, enabled: v }))}
        />
      </div>

      {expanded && (
        <Stack gap={4} className="border-t border-line bg-surface-2/20 px-5 py-5">
          {readOnlyLock && (
            <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-dim">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <span>Locked by the server admin — read-only. Ask an admin to change it on the server.</span>
            </div>
          )}

          {rule.type === "regex-list" && (
            <Stack gap={3}>
              <p className="text-[12px] leading-snug text-faint">
                Ordered find→replace list — entries run top to bottom. An empty replacement deletes the match.
              </p>
              {shownEntries.map((row, i) => {
                const hasNote = !!(row.note && row.note.length);
                const noteShown = noteShow.has(row.id) ? !!noteShow.get(row.id) : hasNote;
                // Against the SHOWN slice: the down-arrow on the last visible row would otherwise
                // swap it into the hidden tail, where it vanishes with no undo.
                const last = i === shownEntries.length - 1;
                const setRow = (patch: Partial<EntryRow>) =>
                  setEntries((rows) => rows.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
                return (
                  <div key={row.id} className="flex overflow-hidden rounded-xl border border-line-strong bg-surface/50">
                    <div className="flex shrink-0 flex-col items-center gap-2 border-r border-line bg-surface-2/50 px-2 py-3">
                      <span className="grid size-5 place-items-center rounded-full bg-accent-soft font-mono text-[10.5px] font-semibold text-accent">
                        {i + 1}
                      </span>
                      {/* ReorderControls keeps keyboard focus on the arrow across the re-keyed move
                          and at the top/bottom, where a native `disabled` would drop it to <body>. */}
                      {bodyEditable && (
                        <ReorderControls
                          canUp={!saving && i > 0}
                          canDown={!saving && !last}
                          onUp={() => setEntries((rows) => swap(rows, i, i - 1))}
                          onDown={() => setEntries((rows) => swap(rows, i, i + 1))}
                          className="gap-2"
                        />
                      )}
                    </div>
                    <Stack gap={3} className="min-w-0 flex-1 p-4">
                      <div className="flex items-center gap-2">
                        <input
                          value={row.label ?? ""}
                          disabled={inputsDisabled}
                          placeholder="label (optional)"
                          spellCheck={false}
                          onChange={(ev) => setRow({ label: ev.target.value })}
                          className="ring-signal min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[12.5px] font-medium text-text placeholder:font-normal placeholder:italic placeholder:text-faint focus:bg-surface-2 disabled:opacity-50"
                        />
                        {bodyEditable && (
                          <>
                            <button type="button" aria-expanded={noteShown} title={noteShown ? "Hide note" : hasNote ? "Show note" : "Add a note"}
                              onClick={() => {
                                if (!noteShown && !hasNote) setNoteFocusId(row.id);
                                setNoteShow((m) => new Map(m).set(row.id, !noteShown));
                              }}
                              className={cn(
                                "ring-signal inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] transition-colors",
                                hasNote ? "text-accent" : "text-faint hover:text-dim",
                              )}>
                              <ChevronRight className={cn("size-3 transition-transform", noteShown && "rotate-90")} />
                              note
                              {hasNote && <span className="size-1 rounded-full bg-current" aria-hidden />}
                            </button>
                            <button type="button" title="Remove entry" disabled={saving}
                              onClick={() => setEntries((rows) => rows.filter((r) => r.id !== row.id))}
                              className="ring-signal grid size-7 shrink-0 place-items-center rounded-md text-faint hover:text-rec disabled:opacity-40">
                              <Trash2 className="size-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                      <Stack gap={2}>
                        <div className="flex items-center gap-3">
                          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-faint">find</span>
                          <TextInput value={row.pattern} disabled={inputsDisabled} spellCheck={false}
                            placeholder="regex pattern (required)" mono className="min-w-0 flex-1"
                            onChange={(ev) => setRow({ pattern: ev.target.value })} />
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-faint">→ repl</span>
                          <TextInput value={row.replacement} disabled={inputsDisabled} spellCheck={false}
                            placeholder="(empty = delete match)" mono className="min-w-0 flex-1"
                            onChange={(ev) => setRow({ replacement: ev.target.value })} />
                        </div>
                      </Stack>
                      {noteShown && (
                        <div className="flex items-start gap-3">
                          <span className="w-12 shrink-0 pt-2 text-right font-mono text-[11px] text-faint">note</span>
                          <textarea value={row.note ?? ""} disabled={inputsDisabled} rows={2} autoFocus={row.id === noteFocusId}
                            placeholder="note (optional)"
                            onChange={(ev) => {
                              // Pin the open state first: a note shown only because it has text
                              // (no explicit toggle) would otherwise unmount the moment it is cleared.
                              if (!noteShow.has(row.id)) setNoteShow((m) => new Map(m).set(row.id, true));
                              setRow({ note: ev.target.value });
                            }}
                            className="ring-signal min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text placeholder:italic placeholder:text-faint disabled:opacity-50" />
                        </div>
                      )}
                    </Stack>
                  </div>
                );
              })}
              {entriesTotal > MAX_REGEX_ENTRIES && (
                <div className="font-mono text-[11px] text-faint">
                  Showing the first {MAX_REGEX_ENTRIES} of {entriesTotal} entries — the rest are kept and saved unchanged.
                </div>
              )}
              {bodyEditable && (
                // Disabled at the server's cap: one more entry and every Save of this list is a 422.
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving || entriesTotal >= MAX_REGEX_ENTRIES}
                  title={entriesTotal >= MAX_REGEX_ENTRIES ? `A list holds at most ${MAX_REGEX_ENTRIES} entries` : undefined}
                  onClick={() => setEntries((rows) => [...rows, { id: mkId(), pattern: "", replacement: "" }])}
                >
                  <Plus className="size-3.5" /> Add entry
                </Button>
              )}
              {(edit.entries?.length ?? 0) === 0 && !bodyEditable && (
                <div className="text-[12.5px] text-faint">No entries.</div>
              )}
            </Stack>
          )}

          {rule.type === "callback:map" && (
            <Stack gap={2}>
              <p className="text-[12px] leading-snug text-faint">
                Say the phrase on the left; the symbol on the right is inserted in its place.
              </p>
              <div className="flex items-center gap-3 px-2.5 font-mono text-[10.5px] uppercase tracking-wider text-faint">
                <span className="min-w-0 flex-1">When you say</span>
                <span className="w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">Insert</span>
                <span className="w-44 shrink-0 text-right">Added</span>
                {bodyEditable && <span className="w-7 shrink-0" aria-hidden />}
              </div>
              {/* Add is at the TOP — new mappings prepend (newest-first). */}
              {bodyEditable && (
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => {
                  const id = mkId();
                  setPairs((rows) => [{ id, k: "", v: "" }, ...rows]);
                  setJustAddedId(id);
                }}>
                  <Plus className="size-3.5" /> Add mapping
                </Button>
              )}
              {mapShown.map((row) => {
                // Own-property read: `map_meta` is a plain (prototyped) object and `row.k` is
                // server-authored, so a key like `constructor`/`toString` would resolve to an inherited
                // function — truthy, so the formatters' falsy guard passes and "Added" prints a
                // fabricated date.
                const ts = ownProp(rule.map_meta ?? {}, row.k);
                const problem =
                  pairProblem?.id === row.id
                    ? pairProblem.msg
                    : ((row.k.trim() ? mapEntryProblem(row.k, row.v) : null) ?? mapTwins.get(row.id));
                return (
                  <Fragment key={row.id}>
                    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-2.5 py-2">
                      <Combobox
                        value={row.k}
                        disabled={inputsDisabled}
                        placeholder="comma"
                        className="min-w-0 flex-1"
                        autoFocus={row.id === justAddedId}
                        suggestions={keySuggestions}
                        footerMax={recentMax}
                        onChange={(v) => editPair(row, "k", v)}
                        onSelect={(word) => {
                          if (editPair(row, "k", word)) valueRefs.current.get(row.id)?.focus();
                        }}
                      />
                      <span className="w-4 shrink-0 text-center text-faint" aria-hidden>→</span>
                      <TextInput ref={(el) => { if (el) valueRefs.current.set(row.id, el); else valueRefs.current.delete(row.id); }}
                        value={row.v} disabled={inputsDisabled} spellCheck={false} placeholder="," mono className="min-w-0 flex-1"
                        onChange={(ev) => editPair(row, "v", ev.target.value)} />
                      <span className="w-44 shrink-0 whitespace-nowrap text-right font-mono text-[10.5px] text-faint"
                        title={ts ? absWhen(ts) : undefined}>
                        {fmtWhen(ts)}
                      </span>
                      {bodyEditable && (
                        <button type="button" title="Remove mapping" disabled={saving}
                          onClick={() => setPairs((rows) => rows.filter((r) => r.id !== row.id))}
                          className="ring-signal grid size-7 shrink-0 place-items-center rounded-md text-faint hover:text-rec disabled:opacity-40">
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {problem && (
                      <div role="status" className="flex items-center gap-1.5 px-2.5 text-[11.5px] text-warn">
                        <AlertTriangle className="size-3.5 shrink-0" /> {problem}
                      </div>
                    )}
                  </Fragment>
                );
              })}
              {mapUnshown > 0 && (
                <div className="font-mono text-[11px] text-faint">
                  Only the first {MAX_SHOWN_MAP_ROWS} of {mapPairs.length} mappings can be shown here — the rest are kept and saved unchanged.
                </div>
              )}
              {mapHidden > 0 && (
                <button type="button" onClick={() => setMapShowAll((v) => !v)}
                  className="ring-signal self-start rounded-md font-mono text-[11.5px] text-dim hover:text-text">
                  {mapShowAll
                    ? `▾ Hide ${mapHidden} older`
                    : `▸ Show ${plural(mapHidden, "older mapping")}`}
                </button>
              )}
            </Stack>
          )}

          {rule.type === "callback:lowercase-wordlist" && (
            <Stack gap={3}>
              <div>
                <FieldLabel>Match (regex)</FieldLabel>
                <TextInput
                  aria-label="Match (regex)"
                  value={edit.pattern ?? ""}
                  disabled={inputsDisabled}
                  spellCheck={false}
                  mono
                  onChange={(ev) => onPatch((e) => ({ ...e, pattern: ev.target.value }))}
                />
              </div>
              <div>
                <FieldLabel>Word list — one per line ({wordsCount})</FieldLabel>
                <textarea
                  aria-label="Word list — one per line"
                  value={edit.words ?? ""}
                  disabled={inputsDisabled}
                  spellCheck={false}
                  rows={6}
                  onChange={(ev) => onPatch((e) => ({ ...e, words: ev.target.value }))}
                  className="ring-signal w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-text placeholder:text-faint disabled:opacity-50"
                />
              </div>
            </Stack>
          )}

          {(rule.type === "callback:dedup" || rule.type === "callback:upper") && (
            <div>
              <FieldLabel>Match (regex)</FieldLabel>
              <TextInput
                aria-label="Match (regex)"
                value={edit.pattern ?? ""}
                disabled={inputsDisabled}
                spellCheck={false}
                mono
                onChange={(ev) => onPatch((e) => ({ ...e, pattern: ev.target.value }))}
              />
            </div>
          )}

          <div className="flex items-end justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0 space-y-1">
              {/* Both are server-authored and unbounded on the wire (the rules payload is an
                  opaque Value, capped only by the 32 MiB body limit), and unlike `rule.label`
                  above neither sits in a `truncate` — they WRAP, so a huge one is millions of
                  line boxes laid out synchronously in the window that owns the debounced
                  config save. Bounded at the RENDER only: `rule.name` is the rule IDENTITY
                  (`rules_patch[r.name]`, `fingerprints[r.name]`, the edits/base record key),
                  so truncating it at the coercion boundary would PATCH under a slug the
                  server does not have. */}
              <div className="font-mono text-[10.5px] text-faint">{safeDisplayText(rule.name, 200)}</div>
              {rule.note && (
                <div className="text-[12px] italic leading-snug text-dim">{safeDisplayText(rule.note, 500)}</div>
              )}
            </div>
            {dirty && (
              <Button variant="ghost" size="sm" disabled={saving} onClick={onReset} title="Discard this rule's changes">
                <RotateCcw className="size-3.5" /> Reset
              </Button>
            )}
          </div>
        </Stack>
      )}
    </Card>
  );
}

// Timestamp formatting — mirrors the backend's TIME_HELPERS_JS so the map
// "Added" column reads identically: "YYYY.MM.DD | HH:MM:SS | <relative>".
function relWhen(ts?: number): string {
  if (!ts) return "";
  const sec = Math.max(0, Date.now() / 1000 - ts);
  if (sec < 5) return "just now";
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return "";
}
function absWhen(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} | ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtWhen(ts?: number): string {
  if (!ts) return "—";
  const r = relWhen(ts);
  return r ? `${absWhen(ts)} | ${r}` : absWhen(ts);
}

function wordCount(words?: string): number {
  return (words ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
}

export default function Dictionary() {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const quickAddList = useApp((s) => s.settings.quickAddList);
  const updateSettings = useApp((s) => s.updateSettings);
  // Subscribe to this device's URL overrides so editing one re-runs the load
  // effect (the effect deps key on the CONNECTED address, not just serverUrl).
  const urlOverrides = useApp((s) => s.settings.sync?.urlOverrides);

  // Candidate Backends: full faster-whisper servers, and untested ones — we can't
  // prove "standard", so we let the fetch decide.
  const candidates = useMemo(
    () => backends.filter((b) => effectiveServerKind(b, ownProp(connections, b.id)) !== "standard"),
    [backends, connections],
  );

  // The fallback-selection effect sits below `dirty`: a vanished selection is held while edits are unsaved.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const backend = candidates.find((b) => b.id === selectedId) ?? null;
  // Mirror of selectedId for the imperative load() ([]-deps): after its await it drops a
  // stale result if the user switched Backend mid-fetch (else it clobbers the new backend's
  // rules + the user's edits). The load-on-change effect below uses its own `cancelled` flag.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  // Monotonic load-generation: the backend-identity guard alone can't disambiguate two overlapping
  // load() calls for the SAME backend (e.g. Refresh during the post-save reload, or rapid Refresh) —
  // an out-of-order network resolution would let the older fetch win. Bump per call, ignore stale.
  const loadGen = useRef(0);
  // The backend whose rules are on screen (set by the loads), and whether they carry unsaved edits
  // (set each render, below `dirty`). The load-on-change effect also re-runs when a sync changes the
  // selected backend's address or drops it from the candidates; with unsaved edits it keeps the
  // document and sets `held` instead of replacing it in silence (dictionaryLoadAction).
  const loadedIdRef = useRef<string | null>(null);
  /** The address the rules on screen were fetched from. */
  const loadedUrlRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const [held, setHeld] = useState<"keep-moved" | "keep-gone" | null>(null);

  // Start in the loading state so first paint shows the spinner, not the "No rules to manage" empty
  // card (the load effect only flips loading true post-paint; candidates.length===0 is still checked
  // first, so a no-compatible-server boot still shows that).
  const [loading, setLoading] = useState(true);
  const [fetchRes, setFetchRes] = useState<PipelineFetch | null>(null);
  const [rules, setRules] = useState<PipelineRule[]>([]);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [base, setBase] = useState<Record<string, EditState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ShownSave | null>(null);
  // Recent-word suggestion pool for cb:map keys (best-effort; [] on old servers).
  const [recentWords, setRecentWords] = useState<string[]>([]);
  const [recentMax, setRecentMax] = useState<number | undefined>(undefined);

  // Human-readable "backend · list" readout for the Quick add card's pin. The list's display
  // label is only known when the pinned backend is the one whose rules are loaded; otherwise
  // the slug identifies it well enough (it IS the stored value).
  const pinnedLabel = useMemo(() => {
    if (!quickAddList) return null;
    const backendName = backendLabelById(backends, quickAddList.backendId);
    const rule =
      quickAddList.backendId === selectedId
        ? rules.find((r) => r.name === quickAddList.slug)
        : undefined;
    const listName = rule
      ? ruleListLabel(rule.label, rule.name, 60)
      : safeDisplayText(quickAddList.slug, 60);
    return backendName ? `${backendName} · ${listName}` : listName;
  }, [quickAddList, backends, selectedId, rules]);

  // editable_fields is also forwarded as an opaque server value — coerce to a plain object,
  // and to an array per type, so a malformed shape can't make `.includes`/`.filter` throw.
  const efRaw = fetchRes?.state?.editable_fields as unknown;
  const editableFields: Record<string, string[]> =
    efRaw && typeof efRaw === "object" && !Array.isArray(efRaw) ? (efRaw as Record<string, string[]>) : {};
  const role = fetchRes?.state?.role;
  // A locked rule is read-only only for a non-admin: the server lets an admin patch it (they own
  // the flag), and so does the web /quick-config editor. Quick-add shares the test (ruleLockedFor).
  const editableFor = useCallback(
    (r: PipelineRule) => {
      if (ruleLockedFor(r, role)) return [];
      const f = editableFields[r.type];
      return Array.isArray(f) ? f : [];
    },
    [editableFields, role],
  );

  /** Fetch the backend's rules and replace the document. Resolves to the address the document now
   *  belongs to, or null when this load did not commit (a backend switch, a newer load, a move).
   *  `afterSave`: the follow-up reload of a save that landed — an address a sync moved during the
   *  round trip is fetched again instead of left to the hold (dictionaryReloadStep). */
  const load = useCallback(async (b: Backend, afterSave = false): Promise<string | null> => {
    const myGen = ++loadGen.current;
    setLoading(true);
    setResult(null);
    // The backend's address NOW, not the caller's copy: a save that lands after a sync moved the
    // backend reloads with the object it was clicked with, which still names the old host.
    const liveUrl = () => {
      const st = useApp.getState();
      const live = st.backends.find((x) => x.id === b.id);
      return live ? effectiveServerUrl(live, st.settings) : null;
    };
    let serverUrl = liveUrl() ?? effectiveServerUrl(b, useApp.getState().settings);
    // Bounded: an address that moves again on every fetch ends in the plain bail, not a loop.
    for (let refetches = 0; ; refetches++) {
      let res: Awaited<ReturnType<typeof getPipelineRules>>;
      try {
        res = await getPipelineRules({ serverUrl, backendId: b.id });
      } catch (err) {
        // get_pipeline_rules is a non-Result command: a transport-level reject must not strand the
        // spinner or surface as an unhandled rejection (Refresh / FetchError Retry / SaveBanner reload
        // call load() without a .catch). Reset the document like the load-on-change effect does — keeping
        // the pre-save edits/base/_fp would show saved rules as unsaved and send stale fingerprints.
        if (myGen !== loadGen.current) return null;
        if (b.id === selectedIdRef.current) {
          const live = liveUrl();
          const step = dictionaryReloadStep(serverUrl, live, afterSave && refetches < 3);
          if (step === "refetch" && live !== null) {
            serverUrl = live;
            continue;
          }
          if (step === "commit") {
            setFetchRes({ ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
            setRules([]);
            setEdits({});
            setBase({});
            setExpanded(new Set());
            setHeld(null);
            loadedUrlRef.current = serverUrl;
            setLoading(false);
            return serverUrl;
          }
        }
        setLoading(false);
        return null;
      }
      if (b.id !== selectedIdRef.current || myGen !== loadGen.current) return null;
      // The address moved during the fetch: these are the old host's rules. A plain reload does not
      // commit them, and the hold notice (set by the load-on-change effect under unsaved edits) stays
      // truthful; without edits that effect is already loading the new address. A post-save reload
      // fetches the new address instead.
      const live = liveUrl();
      const step = dictionaryReloadStep(serverUrl, live, afterSave && refetches < 3);
      if (step === "refetch" && live !== null) {
        serverUrl = live;
        continue;
      }
      if (step !== "commit") {
        setLoading(false);
        return null;
      }
      setHeld(null); // the document is back in line with the backend's current address
      loadedUrlRef.current = serverUrl;
      setFetchRes(res);
      const list = ruleListOf(res);
      setRules(list);
      const fresh = Object.fromEntries(list.map((r) => [r.name, toEdit(r)]));
      setEdits(fresh);
      setBase(cloneEdits(fresh));
      getRecentWords({ serverUrl, backendId: b.id })
        .then((rw) => {
          if (b.id !== selectedIdRef.current || myGen !== loadGen.current) return;
          setRecentWords((rw.words ?? []).slice(0, MAX_RECENT_WORDS));
          setRecentMax(rw.max ?? undefined);
        })
        .catch(() => {}); // best-effort pool — a fetch failure must not surface as an unhandled rejection
      // Keep whichever rule cards are open across a save-triggered reload (and the conflict
      // auto-reload) — both go through load(). A rule that vanished server-side drops out.
      // Switching Backend resets expansion separately (the load-on-change effect below).
      setExpanded((prev) => new Set([...prev].filter((name) => list.some((r) => r.name === name))));
      setLoading(false);
      return serverUrl;
    }
  }, []);

  useEffect(() => {
    const sameAddress = !!backend && effectiveServerUrl(backend, useApp.getState().settings) === loadedUrlRef.current;
    const action = dictionaryLoadAction(backend?.id ?? null, loadedIdRef.current, dirtyRef.current, sameAddress);
    if (action === "keep-moved" || action === "keep-gone") {
      setHeld(action);
      return;
    }
    if (action === "keep") {
      setHeld(null);
      return;
    }
    setHeld(null);
    loadedIdRef.current = backend?.id ?? null;
    loadedUrlRef.current = backend ? effectiveServerUrl(backend, useApp.getState().settings) : null;
    if (!backend) {
      setFetchRes(null);
      setRules([]);
      setRecentWords([]);
      setRecentMax(undefined);
      return;
    }
    let cancelled = false;
    // Join the SAME generation counter `load()` uses: a `cancelled` flag alone is inert against a
    // `load()` already in flight. Repointing the selected backend mid-Refresh would otherwise let the
    // older `load()` overwrite the new server's rules, and save() would PATCH the new host with the old
    // host's slugs and `_fp` under the other server's write gate.
    loadGen.current += 1;
    const myGen = loadGen.current;
    const stale = () => cancelled || myGen !== loadGen.current;
    setLoading(true);
    setResult(null);
    // Reset the recent-word pool before refetching so a backend switch can't strand backend A's
    // suggestions in B's editor if B's getRecentWords is slow or fails (it's best-effort/.catch).
    setRecentWords([]);
    setRecentMax(undefined);
    getPipelineRules({
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      backendId: backend.id,
    })
      .then((res) => {
        if (stale()) return;
        setFetchRes(res);
        const list = ruleListOf(res);
        setRules(list);
        const fresh = Object.fromEntries(list.map((r) => [r.name, toEdit(r)]));
        setEdits(fresh);
        setBase(cloneEdits(fresh));
        setExpanded(new Set());
        setLoading(false);
      })
      // A transport-level reject (get_pipeline_rules is a non-Result command) must not strand the
      // spinner, and the previous backend's document must not survive a failed switch (save() would
      // PATCH the new backend with it): reset it and surface a status-0 error so FetchError (with a
      // working Retry) renders instead of "No rules to manage".
      .catch((err) => {
        if (stale()) return;
        setFetchRes({ ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
        setRules([]);
        setEdits({});
        setBase({});
        setExpanded(new Set());
        setLoading(false);
      });
    getRecentWords({
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      backendId: backend.id,
    })
      .then((rw) => {
        if (stale()) return;
        setRecentWords((rw.words ?? []).slice(0, MAX_RECENT_WORDS));
        setRecentMax(rw.max ?? undefined);
      })
      .catch(() => {}); // best-effort pool — a fetch failure must not surface as an unhandled rejection
    return () => {
      cancelled = true;
    };
  }, [backend?.id, backend?.serverUrl, backend && urlOverrides?.[backend.id]]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cache buildPatch by the (edit, base, editable) references so a keystroke re-diffs only the rule
  // that changed (setEdits keeps the others referentially stable) — each cb:map diff is a whole-map
  // sort + JSON.stringify, which matters on large word-mapping lists.
  const patchCache = useRef(new Map<string, { e: EditState; b: EditState; ed: string[]; patch: Record<string, unknown> }>());
  const patchFor = useCallback(
    (r: PipelineRule): Record<string, unknown> => {
      const e = edits[r.name];
      const b = base[r.name];
      if (!e || !b) return {};
      const ed = editableFor(r);
      const hit = patchCache.current.get(r.name);
      if (hit && hit.e === e && hit.b === b && hit.ed === ed) return hit.patch;
      const patch = buildPatch(r.type, e, b, ed);
      patchCache.current.set(r.name, { e, b, ed, patch });
      return patch;
    },
    [edits, base, editableFor],
  );
  const dirty = useMemo(() => rules.filter((r) => Object.keys(patchFor(r)).length > 0), [rules, patchFor]);
  const hasDirty = dirty.length > 0;
  dirtyRef.current = hasDirty;
  useEffect(() => {
    const next = dictionarySelection(selectedId, candidates.map((c) => c.id), hasDirty);
    if (next !== selectedId) setSelectedId(next);
  }, [candidates, selectedId, hasDirty]);
  // A hold ends with its edits, however they went (Discard, a rule's own reset, typing a value
  // back): otherwise the notice keeps asking for a Save or Discard that no longer shows, and the
  // old address's rules stay on screen for the next Save to send to the new one.
  useEffect(() => {
    const next = dictionaryHeldResolution(held, hasDirty, backend !== null);
    if (next === "reload" && backend) void load(backend);
    else if (next === "release") setHeld(null);
  }, [held, hasDirty, backend?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The same unsaved-work guard the three list editors register: the sticky bar and the
  // backend pills already refuse to lose edits, but a sidebar click or the chip's
  // app://navigate would unmount this screen and drop them in silence.
  const guard = useUnsavedGuard(dirty.length > 0);
  const dirtyNames = useMemo(() => new Set(dirty.map((r) => r.name)), [dirty]);
  // Why the Save is held: a dirty rule whose body the server would refuse — a word-mapping list
  // with a pair its schema rejects, a case twin or too many keys; a lowercase word outside its
  // pattern; an over-long pattern, replacement, label or note. The PATCH carries every dirty rule,
  // so one such rule would fail them all.
  const saveBlocked = useMemo(() => {
    for (const r of dirty) {
      const patch = patchFor(r);
      const problem =
        r.type === "callback:map"
          ? "map" in patch
            ? mapRowsProblem(edits[r.name]?.pairs ?? [])
            : null
          : rulePatchProblem(patch);
      if (problem) return `${ruleListLabel(r.label, r.name, 120)}: ${problem}`;
    }
    return null;
  }, [dirty, patchFor, edits]);

  const totalRules = useMemo(() => (fetchRes ? ruleCountOf(fetchRes) : rules.length), [fetchRes, rules.length]);

  // The save in flight, if any. The sticky Save is disabled while saving, but `dirty` stays true until
  // the reload lands, so "Save and leave" from the leave dialog could start a second PATCH with the
  // same (now stale) fingerprints — and the first one's finally would unfreeze the editor under it.
  const saveInFlight = useRef<Promise<boolean> | null>(null);

  /** Save; `false` when something was not saved (an error, rules that conflicted on the server, or a
   *  setting the server's environment pins), so the leave guard keeps the user on-screen. A call while a
   *  save is already running joins that one instead of sending another. */
  function save(): Promise<boolean> {
    if (saveInFlight.current) return saveInFlight.current;
    const p = runSave().finally(() => {
      saveInFlight.current = null;
    });
    saveInFlight.current = p;
    return p;
  }

  async function runSave(): Promise<boolean> {
    if (!backend || dirty.length === 0 || saveBlocked) return false;
    const rules_patch: Record<string, Record<string, unknown>> = {};
    const fingerprints: Record<string, string> = {};
    for (const r of dirty) {
      rules_patch[r.name] = patchFor(r);
      if (r._fp) fingerprints[r.name] = r._fp;
    }
    setSaving(true);
    // savePipelineRules is a bare invoke that can reject on an IPC failure; without the finally,
    // `saving` stays true and freezes every control gated on it until the screen is left.
    try {
      const savedTo = effectiveServerUrl(backend, useApp.getState().settings);
      const res = await savePipelineRules({
        serverUrl: savedTo,
        backendId: backend.id,
        patch: { rules_patch, fingerprints },
      });
      // Backend switched while the save was in flight → this result belongs to the
      // old backend; don't reload or flash its banner over the now-selected one.
      if (backend.id !== selectedIdRef.current) return false;
      // On success, re-sync to server truth (fresh fingerprints; conflicted edits
      // are replaced by the server's version) BEFORE showing the banner — load()
      // clears `result`, so set it afterwards. On 422 keep edits so the user can fix.
      // A 2xx whose reply couldn't be read (ok:false) still LANDED: reload too, or the stale
      // fingerprints turn the obvious re-save into bogus conflicts. The banner shows its detail.
      // The reload goes to the backend's LIVE address even when a sync moved it during the round trip
      // (afterSave): the saved edits are no longer unsaved, so they must not stay on screen under the
      // hold. The banner then says where the rules went and whose are shown.
      const landed = saveLanded(res);
      const shownFrom = landed ? await load(backend, true) : null;
      // load() awaited above — re-check the selection (mirrors the guard before it): a backend switch
      // during that reload makes load() bail on its own guard (leaving result null), so setting the old
      // backend's banner here would strand a stale "Saved N rules" over the now-selected backend.
      if (backend.id !== selectedIdRef.current) return false;
      setResult({ ...res, savedTo, shownFrom });
      // A 2xx with conflicts still dropped those rules' edits (load() replaced them with server truth):
      // report not-saved so "Save and leave" stays on-screen and the banner's conflict notice is seen.
      const conflicted = Array.isArray(res.conflicts) && res.conflicts.length > 0;
      // Same for a 2xx the server's environment overrode: load() swapped the edit back, and leaving
      // now would unmount the screen before the pinned notice is ever seen.
      return res.ok && !conflicted && envPinnedOf(res).length === 0;
    } catch (e) {
      console.error("save pipeline rules failed:", e);
      if (backend.id === selectedIdRef.current) {
        setResult({ ok: false, status: 0, saved: [], conflicts: [], requires_restart: false, detail: e instanceof Error ? e.message : String(e) });
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  function patchEdit(slug: string, updater: (e: EditState) => EditState) {
    setEdits((prev) => ({ ...prev, [slug]: updater(prev[slug]) }));
  }
  function resetRule(slug: string) {
    setEdits((prev) => ({ ...prev, [slug]: cloneEdits(base[slug]) }));
  }
  function discardAll() {
    setEdits(cloneEdits(base));
    // A full discard is a fresh slate — clear any lingering save banner (esp. a 422 rejection whose
    // edits no longer exist; the banner persists independent of `dirty` until the next load).
    setResult(null);
    // A hold (address changed, backend gone) ends in the held-resolution effect once nothing is unsaved.
  }

  return (
    <Stack gap={6} className="page page-prose">
      <header className="pb-2">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">{screenEyebrow("dictionary")}</div>
          <h1 className="mt-2 flex items-center gap-2.5 font-display text-[30px] font-bold tracking-tight text-text">
            <BookA className="size-7 text-accent" aria-hidden /> {screenTitle("dictionary")}
          </h1>
          <p className="mt-2 text-[13.5px] text-dim">
            Dictation rules a <strong className="font-semibold text-text">faster-whisper-backend</strong> server applies to every transcription,
            including replacements, word mappings, punctuation, and tidying up.
          </p>
        </div>
      </header>

      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {candidates.length > 1 &&
            candidates.map((b) => {
              const active = b.id === selectedId;
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={active}
                  // Gray out an INACTIVE backend while there are unsaved edits (disable-not-hide):
                  // switching reloads that backend's rules and wholesale-replaces the edits map, silently
                  // discarding pending edits despite the "N unsaved changes" bar. Discard/Save first.
                  disabled={saving || (dirty.length > 0 && !active)}
                  title={dirty.length > 0 && !active ? "Save or discard your changes before switching backend" : undefined}
                  onClick={() => {
                    // Clicking the ACTIVE pill changes no selection, so the load-on-change effect never
                    // re-runs to clear `loading` — setting it here would strand the "Loading rules…"
                    // spinner forever (Refresh is disabled while loading, so there's no recovery).
                    if (b.id === selectedId) return;
                    setSelectedId(b.id);
                    setLoading(true); // show the spinner on switch, not the prior backend's rules
                  }}
                  className={cn(
                    "ring-signal rounded-pill border px-3.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40",
                    active
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-surface-2 text-dim hover:text-text",
                  )}
                >
                  {/* This chip row SELECTS which server's mapping list is edited, so it is a decision
                      surface like the three pickers, not a readout: two backends whose defanged names
                      collide must not draw identically here either — every backend name on this
                      screen goes through `backendLabel`. */}
                  <span className="block max-w-[16rem] truncate">{backendLabel(backends, b)}</span>
                </button>
              );
            })}
          <span className="ml-auto flex items-center gap-3">
            {backend && fetchRes?.ok && role && (
              <span className="text-[12px] text-faint">
                Editing as <span className="text-dim">{role}</span>
              </span>
            )}
        {backend && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => load(backend)}
            disabled={loading || saving || dirty.length > 0}
            title={dirty.length > 0 ? "Discard your changes first (Refresh reloads from the server)" : "Reload from server"}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
          </Button>
        )}
          </span>
        </div>
      )}

      {/* Quick add lives here, not in Settings → General: the setup checklist and the quick-add
          window's empty state both route here. Above the server-gated states so the shortcut stays
          configurable when no compatible backend is reachable. */}
      <Card className="px-6 py-4">
        <SectionLabel>Quick add</SectionLabel>
        {/* Same split as the Profiles editor: the short setting takes a third, the trigger tile two. */}
        <div className="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div className="flex flex-col gap-3">
            <Labeled label="Pinned list">
              {pinnedLabel ? (
                <div className="flex min-h-[34px] items-center gap-2 text-[13.5px] text-text">
                  <Crosshair className="size-4 shrink-0 text-accent" />
                  <span className="truncate">{pinnedLabel}</span>
                </div>
              ) : (
                <div className="flex min-h-[34px] items-center text-[12.5px] leading-snug text-faint">
                  No list pinned — use the crosshair on a word-mapping list below.
                </div>
              )}
            </Labeled>
            {/* Platform notes about the shortcut sit at the foot of the short column, not under the tile. */}
            {IS_LINUX && (
              <div className="mt-auto flex items-start gap-2 text-[12px] text-faint">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  On Wayland this needs the evdev backend (Settings → Permissions); otherwise bind a desktop
                  shortcut to <span className="font-mono text-[11px]">app --quick-add</span>.
                </span>
              </div>
            )}
          </div>
          <div className="self-start sm:col-span-2">
            <QuickAddShortcutField allowClear />
          </div>
        </div>
      </Card>

      {guard.asking && (
        <ConfirmLeave
          what="dictionary"
          onSaveAndLeave={() => guard.saveAndLeave(save)}
          onDiscard={() => {
            discardAll();
            guard.leave();
          }}
          onStay={guard.stay}
        />
      )}
      {/* Also with no compatible server left: the rule list and its Discard bar are hidden then, but
          the edits are still unsaved — the leave guard would ask about changes nobody can see. */}
      {held && (
        <Notice>
          {held === "keep-moved"
            ? "This backend's address changed — your unsaved changes are kept. Save or discard them to load its rules again."
            : candidates.length > 0
              ? "The backend these rules came from is no longer available — discard your changes to continue."
              : (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  The server these unsaved changes belong to is gone — discard them to leave.
                  <Button variant="ghost" size="sm" onClick={discardAll} disabled={saving}>Discard</Button>
                </span>
              )}
        </Notice>
      )}
      {candidates.length === 0 ? (
        <EmptyCard
          title="No compatible server"
          body="The Dictionary needs a full faster-whisper-backend server (detected by a connection test). Add or test a server on the Backends screen."
        />
      ) : loading ? (
        <div className="flex items-center gap-2 py-16 text-[13px] text-dim">
          <Loader2 className="size-4 animate-spin" /> Loading rules…
        </div>
      ) : fetchRes && !fetchRes.ok ? (
        <Stack gap={4}>
          {/* A save that went through, then lost its follow-up reload: keep its notice above the error
              (runSave sets `result` after load(); Retry's load() clears it). */}
          {result && <SaveBanner result={result} reloadFailed retryBelow={fetchRetryable(fetchRes)} reloadDisabled={dirty.length > 0} onReload={() => backend && load(backend)} />}
          <FetchError fetch={fetchRes} backendName={backend ? backendLabel(backends, backend) : "the server"} onRetry={() => backend && load(backend)} />
        </Stack>
      ) : rules.length === 0 ? (
        <EmptyCard
          title="No rules to manage"
          body="An admin hasn't shared any editable rules with your account yet. Ask them to expose rules (and tag them for you) on the server."
        />
      ) : (
        <Stack gap={4}>
          {result && <SaveBanner result={result} reloadDisabled={dirty.length > 0} onReload={() => backend && load(backend)} />}

          {dirty.length > 0 && (
            <div className="sticky top-0 z-10 -mx-2 flex items-center gap-3 rounded-xl border border-line-strong bg-panel/95 px-4 py-2.5 backdrop-blur-sm">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              <span className="text-[13px] text-text">
                {dirty.length} unsaved {dirty.length === 1 ? "change" : "changes"}
              </span>
              {saveBlocked && (
                <span role="status" className="flex min-w-0 items-center gap-1.5 text-[12px] text-warn">
                  <AlertTriangle className="size-3.5 shrink-0" /> <span className="truncate" title={saveBlocked}>{saveBlocked}</span>
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={discardAll} disabled={saving}>Discard</Button>
                <Button variant="accent" size="sm" onClick={save} disabled={saving || !backend || !!saveBlocked}>
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save changes
                </Button>
              </div>
            </div>
          )}

          {rules.map((r) => (
            <RuleCard
              key={r.name}
              rule={r}
              edit={edits[r.name]}
              editable={editableFor(r)}
              readOnlyLock={ruleLockedFor(r, role)}
              dirty={dirtyNames.has(r.name)}
              expanded={expanded.has(r.name)}
              mapCollapseAfter={fetchRes?.state?.map_collapse_after ?? 15}
              recentWords={recentWords}
              recentMax={recentMax}
              saving={saving}
              pinned={!!backend && quickAddList?.backendId === backend.id && quickAddList?.slug === r.name}
              onTogglePin={
                r.type === "callback:map" && backend
                  ? () =>
                      updateSettings({
                        quickAddList:
                          quickAddList?.backendId === backend.id && quickAddList?.slug === r.name
                            ? null
                            : { backendId: backend.id, slug: r.name },
                      })
                  : undefined
              }
              onToggleExpand={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  next.has(r.name) ? next.delete(r.name) : next.add(r.name);
                  return next;
                })
              }
              onPatch={(updater) => patchEdit(r.name, updater)}
              onReset={() => resetRule(r.name)}
            />
          ))}
          {totalRules > rules.length && (
            <p className="py-2 text-center text-[12px] text-faint">
              Showing the first {rules.length} of {totalRules} rules.
            </p>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <Card className="px-6 py-10 text-center">
      <BookA className="mx-auto mb-3 size-7 text-faint" />
      <div className="text-[15px] font-medium text-text">{title}</div>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-dim">{body}</p>
    </Card>
  );
}

/** FetchError offers Retry only for these (unreachable / server error); SaveBanner's reload-failed
 *  clause points at it only when it is there. */
const fetchRetryable = (f: PipelineFetch) => f.status === 0 || f.status >= 500;

function FetchError({ fetch, backendName, onRetry }: { fetch: PipelineFetch; backendName: string; onRetry: () => void }) {
  const { title, body } = describeFetchError(fetch, backendName);
  return (
    <Card className="px-6 py-9 text-center">
      <AlertTriangle className="mx-auto mb-3 size-6 text-warn" />
      <div className="text-[15px] font-medium text-text">{title}</div>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-dim">{body}</p>
      {fetchRetryable(fetch) && (
        <Button variant="default" size="sm" className="mx-auto mt-4" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      )}
    </Card>
  );
}

// `error` can be whitespace only (a bare proxy body like "\r\n" folds to spaces on the Rust side),
// so trim before falling back or the card body comes out blank.
function describeFetchError(fetch: PipelineFetch, name: string): { title: string; body: string } {
  switch (fetch.status) {
    case 0:
      return { title: `Couldn't reach ${name}`, body: fetch.error?.trim() || "The server is unreachable. Check it's running and the URL is correct on the Backends screen." };
    case 401:
      return { title: "This server needs a valid API key", body: "Set or fix the API key for this Backend on the Backends screen, then refresh." };
    case 403:
      return { title: "Your account can't manage this dictionary", body: "An admin hasn't granted your key access to the rules editor. Ask them to enable it for your account." };
    case 404:
      return { title: "This server doesn't support editable rules", body: "It's either a standard Whisper server or an older faster-whisper-backend. Update the server to manage its dictionary here." };
    default:
      return { title: `Server error (HTTP ${fetch.status})`, body: fetch.error?.trim() || "The server returned an unexpected error." };
  }
}

/** A save's result as the banner shows it: `savedTo` is the address the save went to, `shownFrom`
 *  the one its follow-up reload committed (they differ when a sync moved the backend in between;
 *  null when that reload committed nothing, and the banner must not claim it). */
type ShownSave = PipelineSaveResult & { savedTo?: string; shownFrom?: string | null };

function SaveBanner({
  result,
  reloadFailed = false,
  retryBelow = false,
  reloadDisabled,
  onReload,
}: {
  result: ShownSave;
  /** The save's follow-up reload is what failed (the fetch-error view): never claim it landed. */
  reloadFailed?: boolean;
  /** With reloadFailed: the FetchError below offers Retry (fetchRetryable); else point at Refresh. */
  retryBelow?: boolean;
  reloadDisabled: boolean;
  onReload: () => void;
}) {
  // `errors` is opaque server JSON: coerce to an array (a bare string passes `.length` and crashes
  // `.slice().map()`), then its elements (a null member throws on `e.loc`; an object `msg` is not a
  // valid React child) — a throw here white-screens the window with the unsaved edits. A 422 without
  // errors falls through to the generic !ok banner.
  const errors = (Array.isArray(result.errors) ? result.errors : [])
    // Head-slice before the walk: this banner stays up and re-renders on every keystroke while the
    // user edits.
    .slice(0, 50)
    .filter((e) => !!e && typeof e === "object")
    .map((e) => ({
      // `errors` is forwarded from the server as an opaque Value — unlike its `detail` sibling,
      // which `transport/pipeline.rs` runs through `bounded_server_text`. A length slice alone
      // still lets C1/bidi/U+2028 through into a banner that persists while the user edits, so
      // these two get the same defanging every other server string on this screen has.
      loc: safeDisplayText(e.loc, 300),
      msg: safeDisplayText(e.msg, 300),
    }));
  if (result.status === 422 && errors.length) {
    return (
      <Notice>
        <div className="font-medium">The server rejected the changes</div>
        <ul className="mt-1 space-y-0.5 text-warn/90">
          {errors.slice(0, 6).map((e, i) => (
            <li key={i}>
              {e.loc ? <span className="font-mono text-[11px] opacity-80">{e.loc}: </span> : null}
              {e.msg}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-warn/80">A rule the admin set may already be invalid — only the listed issues block saving.</p>
      </Notice>
    );
  }
  if (!result.ok) {
    // A 2xx here LANDED but its reply was unreadable (runSave reloaded on it). Only this side knows
    // whether that reload worked, so the clause is added here, never baked into the detail: in the
    // fetch-error view it failed. And with the reply lost, its conflicts are unknown too.
    const landed = saveLanded(result);
    return (
      <Notice>
        {result.detail?.trim() || "Couldn't save the changes."}
        {landed && dictionaryLandedText(result.savedTo ?? null, result.shownFrom ?? null, reloadFailed, retryBelow)}
      </Notice>
    );
  }
  // `conflicts` is opaque server JSON; a non-array would give `.length` a bogus count.
  const conflicts = (Array.isArray(result.conflicts) ? result.conflicts : []).length;
  // Settings an environment variable pins on the server were skipped. The rule list pinned means the
  // server ignored the whole save, so there is nothing "Saved" to report.
  const pinned = envPinnedOf(result);
  const listPinned = pinned.includes(RULE_LIST_SETTING);
  const otherPinned = pinned.filter((n) => n !== RULE_LIST_SETTING);
  const savedShown = result.saved.length > 0 && !listPinned;
  return (
    <div className="space-y-2">
      {savedShown && (
        <Notice tone="ok">
          {dictionarySavedText(result.saved.length, result.savedTo ?? null, result.shownFrom ?? null, reloadFailed)}
          {result.requires_restart ? " Some changes need a server restart to take effect." : ""}
        </Notice>
      )}
      {listPinned && (
        <Notice>The server's environment pins the rule list — none of these changes take effect.</Notice>
      )}
      {otherPinned.length > 0 && (
        <Notice>
          The server's environment pins {otherPinned.map((n) => safeDisplayText(n, 64)).join(", ")} — the change
          was not applied and won't take effect until the operator unsets{" "}
          {otherPinned.length === 1 ? "that variable" : "those variables"}.
        </Notice>
      )}
      {conflicts > 0 && (
        <Notice>
          {conflicts} {conflicts === 1 ? "rule" : "rules"} changed on the server and {conflicts === 1 ? "was" : "were"} not saved.
          {/* In the fetch-error view the reload is what failed, so "Reload again" is not offered.
              FetchError draws its own Retry only for a retryable failure (fetchRetryable); for any
              other the clause points at the header's Refresh instead (retryBelow says which). */}
          {dictionaryConflictText(result.savedTo ?? null, result.shownFrom ?? null, reloadFailed, retryBelow, savedShown)}
          {!reloadFailed && (
            <>
              {" "}
              <button
                type="button"
                disabled={reloadDisabled}
                title={reloadDisabled ? "Discard or save your changes first — Reload replaces them with the server's version" : undefined}
                className="ring-signal underline hover:text-text disabled:no-underline disabled:opacity-40"
                onClick={onReload}
              >
                Reload again
              </button>
            </>
          )}
        </Notice>
      )}
    </div>
  );
}
