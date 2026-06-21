// "Dictionary" — view + edit the backend's post-processing (pipeline) rules the
// caller is permitted to (GET/PATCH /v1/pipeline-rules). This is LIVE server
// state, not local config: pick a Backend, fetch its rules, edit the bodies your
// account may change, push the diff back. Mirrors the server's /quick-config
// gating — the client only exposes `enabled` + the per-type body (editable_fields);
// name/label/tags/colour/lock are read-only context (admin-only on the web).
//
// Rendering note: per-rule fields are plain controlled inputs inside the stable,
// module-scope <RuleCard> (keyed by slug) — never a component redefined per
// render — so editing never remounts an input (cf. DecodeFields focus-loss caveat).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookA, Loader2, RefreshCw, Plus, Trash2, Lock, RotateCcw, ChevronRight,
  ArrowUp, ArrowDown, AlertTriangle, Check, Crosshair,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, Notice, Stack, Toggle, TextInput } from "@/components/ui";
import { Combobox } from "@/components/Combobox";
import { type MapRow, nextRowId, mapRowsFromRule, mapBodyFromRows, ruleListOf } from "@/lib/pipelineMap";
import { ruleDotColor } from "@/lib/ruleColor";
import { effectiveServerKind } from "@/lib/serverKind";
import { getPipelineRules, getRecentWords, savePipelineRules } from "@/lib/api";
import type {
  Backend, PipelineFetch, PipelineRule, PipelineSaveResult, RuleType,
} from "@/lib/types";
import { cn } from "@/lib/cn";

/* ── friendly, on-voice labels for the wire rule types ─────────────────── */
const TYPE_LABEL: Record<RuleType, string> = {
  "regex-list": "Find & replace",
  "callback:map": "Word mappings",
  "callback:lowercase-wordlist": "Lowercase words",
  "callback:dedup": "De-duplicate",
  "callback:upper": "Capitalize",
  terminal: "Trim",
};

/* ── editor-friendly working copy of a rule's editable body ────────────── */
const mkId = nextRowId;

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

/** Build the minimal patch (changed allow-listed fields only) for one rule.
 *  Empty object ⇒ unchanged. Locked rules pass `editable = []` ⇒ never dirty. */
function buildPatch(type: RuleType, edit: EditState, base: EditState, editable: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (editable.includes("enabled") && edit.enabled !== base.enabled) patch.enabled = edit.enabled;
  const bodyFields = editable.filter((f) => f !== "enabled");
  if (bodyFields.length) {
    const cur = emitBody(type, edit);
    const old = emitBody(type, base);
    if (JSON.stringify(cur) !== JSON.stringify(old)) {
      for (const f of bodyFields) if (f in cur) patch[f] = cur[f];
    }
  }
  return patch;
}


function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="mb-1.5 block text-[11.5px] font-medium text-dim">{children}</label>;
}

const monoInput = "font-mono text-[12.5px]";

/* ── one rule (stable, module-scope component) ─────────────────────────── */
function RuleCard({
  rule, edit, editable, dirty, expanded, mapCollapseAfter, recentWords, recentMax,
  pinned, saving, onTogglePin, onToggleExpand, onPatch, onReset,
}: {
  rule: PipelineRule;
  edit: EditState;
  editable: string[];
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
  // `dirty` is passed in (computed once, cached, in the parent) — recomputing buildPatch here
  // re-ran a whole-map sort + JSON.stringify in every card on every keystroke.
  const dotHex = ruleDotColor(rule.color);
  // Per-entry note show/hide override. Default is open iff the entry already has
  // a note; a single toggle both reveals AND hides it (content is preserved).
  const [noteShow, setNoteShow] = useState<Map<number, boolean>>(() => new Map());
  const [mapShowAll, setMapShowAll] = useState(false);
  // The just-added cb:map row — auto-focus its key so suggestions open at once.
  const [justAddedId, setJustAddedId] = useState<number | null>(null);

  const setEntries = (fn: (rows: EntryRow[]) => EntryRow[]) =>
    onPatch((e) => ({ ...e, entries: fn(e.entries ?? []) }));
  const setPairs = (fn: (rows: MapRow[]) => MapRow[]) =>
    onPatch((e) => ({ ...e, pairs: fn(e.pairs ?? []) }));

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

  // cb:map: show the newest N (mapCollapseAfter); collapse the rest behind a toggle.
  const mapPairs = edit.pairs ?? [];
  const mapHidden =
    rule.type === "callback:map" && mapCollapseAfter > 0 && mapPairs.length > mapCollapseAfter
      ? mapPairs.length - mapCollapseAfter
      : 0;
  const mapShown = mapHidden > 0 && !mapShowAll ? mapPairs.slice(0, mapCollapseAfter) : mapPairs;

  return (
    <Card className={cn("overflow-hidden transition-colors", dirty && "border-line-strong")}>
      {/* header row */}
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
          <span className="truncate text-[14px] font-medium text-text">{rule.label}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes" aria-hidden />}
          <Badge>{TYPE_LABEL[rule.type] ?? rule.type}</Badge>
          {pinned && <Badge tone="accent">quick-add</Badge>}
          {locked && (
            <span className="inline-flex items-center gap-1 text-faint" title="Locked by the server admin — read-only">
              <Lock className="size-3" />
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {(rule.tags ?? []).slice(0, 3).map((t) => (
            <Badge key={t} tone="dim">{t}</Badge>
          ))}
        </div>
        {rule.type === "callback:map" && onTogglePin && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={pinned ? "Pinned as the quick-add list — click to unpin" : "Set as the quick-add list"}
            className={cn(
              "ring-signal grid size-7 shrink-0 place-items-center rounded-md transition-colors",
              pinned ? "bg-accent-soft text-accent" : "text-faint hover:text-text",
            )}
          >
            <Crosshair className="size-4" />
          </button>
        )}
        <Toggle
          checked={edit.enabled}
          disabled={!canEnable}
          onChange={(v) => onPatch((e) => ({ ...e, enabled: v }))}
        />
      </div>

      {/* expandable body */}
      {expanded && (
        <Stack gap={4} className="border-t border-line bg-surface-2/20 px-5 py-5">
          {locked && (
            <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-dim">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <span>Locked by the server admin — read-only. Ask an admin to change it on the server.</span>
            </div>
          )}

          {/* regex-list: ordered find→replace entries — numbered card-rows with a left rail */}
          {rule.type === "regex-list" && (
            <Stack gap={3}>
              <p className="text-[12px] leading-snug text-faint">
                Ordered find→replace list — entries run top to bottom. An empty replacement deletes the match.
              </p>
              {(edit.entries ?? []).map((row, i) => {
                const hasNote = !!(row.note && row.note.length);
                const noteShown = noteShow.has(row.id) ? !!noteShow.get(row.id) : hasNote;
                const last = i === (edit.entries?.length ?? 0) - 1;
                const setRow = (patch: Partial<EntryRow>) =>
                  setEntries((rows) => rows.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
                return (
                  <div key={row.id} className="flex overflow-hidden rounded-xl border border-line-strong bg-surface/50">
                    {/* rail: order badge + reorder (far-left; arrows are keyboard-accessible) */}
                    <div className="flex shrink-0 flex-col items-center gap-2 border-r border-line bg-surface-2/50 px-2 py-3">
                      <span className="grid size-5 place-items-center rounded-full bg-accent-soft font-mono text-[10.5px] font-semibold text-accent">
                        {i + 1}
                      </span>
                      {bodyEditable && (
                        <>
                          <button type="button" title="Move up" disabled={i === 0}
                            onClick={() => setEntries((rows) => swap(rows, i, i - 1))}
                            className="ring-signal grid size-6 place-items-center rounded-md text-faint hover:text-text disabled:opacity-30">
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button type="button" title="Move down" disabled={last}
                            onClick={() => setEntries((rows) => swap(rows, i, i + 1))}
                            className="ring-signal grid size-6 place-items-center rounded-md text-faint hover:text-text disabled:opacity-30">
                            <ArrowDown className="size-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                    {/* body */}
                    <Stack gap={3} className="min-w-0 flex-1 p-4">
                      {/* row 1: label · note toggle · delete */}
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
                            <button type="button" aria-expanded={noteShown} title={noteShown ? "Hide note" : "Add a note"}
                              onClick={() => setNoteShow((m) => new Map(m).set(row.id, !noteShown))}
                              className={cn(
                                "ring-signal inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] transition-colors",
                                hasNote ? "text-accent" : "text-faint hover:text-dim",
                              )}>
                              <ChevronRight className={cn("size-3 transition-transform", noteShown && "rotate-90")} />
                              note
                              {hasNote && <span className="size-1 rounded-full bg-current" aria-hidden />}
                            </button>
                            <button type="button" title="Remove entry"
                              onClick={() => setEntries((rows) => rows.filter((r) => r.id !== row.id))}
                              className="ring-signal grid size-7 shrink-0 place-items-center rounded-md text-faint hover:text-rec">
                              <Trash2 className="size-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                      {/* find / → repl rows (inline mono gutter labels) */}
                      <Stack gap={2}>
                        <div className="flex items-center gap-3">
                          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-faint">find</span>
                          <TextInput value={row.pattern} disabled={inputsDisabled} spellCheck={false}
                            placeholder="regex pattern (required)" className={cn(monoInput, "min-w-0 flex-1")}
                            onChange={(ev) => setRow({ pattern: ev.target.value })} />
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-faint">→ repl</span>
                          <TextInput value={row.replacement} disabled={inputsDisabled} spellCheck={false}
                            placeholder="(empty = delete match)" className={cn(monoInput, "min-w-0 flex-1")}
                            onChange={(ev) => setRow({ replacement: ev.target.value })} />
                        </div>
                      </Stack>
                      {/* note — collapsible, toggled by the row-1 button */}
                      {noteShown && (
                        <div className="flex items-start gap-3">
                          <span className="w-12 shrink-0 pt-2 text-right font-mono text-[11px] text-faint">note</span>
                          <textarea value={row.note ?? ""} disabled={inputsDisabled} rows={2} autoFocus={!hasNote}
                            placeholder="note (optional)"
                            onChange={(ev) => setRow({ note: ev.target.value })}
                            className="ring-signal min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text placeholder:italic placeholder:text-faint disabled:opacity-50" />
                        </div>
                      )}
                    </Stack>
                  </div>
                );
              })}
              {bodyEditable && (
                <Button variant="ghost" size="sm" onClick={() => setEntries((rows) => [...rows, { id: mkId(), pattern: "", replacement: "" }])}>
                  <Plus className="size-3.5" /> Add entry
                </Button>
              )}
              {(edit.entries?.length ?? 0) === 0 && !bodyEditable && (
                <div className="text-[12.5px] text-faint">No entries.</div>
              )}
            </Stack>
          )}

          {/* callback:map: spoken phrase → symbol — HORIZONTAL rows (key beside value) */}
          {rule.type === "callback:map" && (
            <Stack gap={2}>
              <p className="text-[12px] leading-snug text-faint">
                Say the phrase on the left; the symbol on the right is inserted in its place.
              </p>
              {/* column header */}
              <div className="flex items-center gap-3 px-2.5 font-mono text-[10.5px] uppercase tracking-wider text-faint">
                <span className="min-w-0 flex-1">When you say</span>
                <span className="w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">Insert</span>
                <span className="w-44 shrink-0 text-right">Added</span>
                {bodyEditable && <span className="w-7 shrink-0" aria-hidden />}
              </div>
              {/* Add is at the TOP — new mappings prepend (newest-first). */}
              {bodyEditable && (
                <Button variant="ghost" size="sm" onClick={() => {
                  const id = mkId();
                  setPairs((rows) => [{ id, k: "", v: "" }, ...rows]);
                  setJustAddedId(id);
                }}>
                  <Plus className="size-3.5" /> Add mapping
                </Button>
              )}
              {mapShown.map((row) => {
                const ts = rule.map_meta?.[row.k];
                return (
                  <div key={row.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-2.5 py-2">
                    <Combobox
                      value={row.k}
                      disabled={inputsDisabled}
                      placeholder="comma"
                      className="min-w-0 flex-1"
                      autoFocus={row.id === justAddedId}
                      suggestions={keySuggestions}
                      footerMax={recentMax}
                      onChange={(v) => setPairs((rows) => rows.map((r) => (r.id === row.id ? { ...r, k: v } : r)))}
                      onSelect={(word) => {
                        setPairs((rows) => rows.map((r) => (r.id === row.id ? { ...r, k: word } : r)));
                        valueRefs.current.get(row.id)?.focus();
                      }}
                    />
                    <span className="w-4 shrink-0 text-center text-faint" aria-hidden>→</span>
                    <TextInput ref={(el) => { valueRefs.current.set(row.id, el); }}
                      value={row.v} disabled={inputsDisabled} spellCheck={false} placeholder="," className={cn(monoInput, "min-w-0 flex-1")}
                      onChange={(ev) => setPairs((rows) => rows.map((r) => (r.id === row.id ? { ...r, v: ev.target.value } : r)))} />
                    <span className="w-44 shrink-0 whitespace-nowrap text-right font-mono text-[10.5px] text-faint"
                      title={ts ? absWhen(ts) : undefined}>
                      {fmtWhen(ts)}
                    </span>
                    {bodyEditable && (
                      <button type="button" title="Remove mapping"
                        onClick={() => setPairs((rows) => rows.filter((r) => r.id !== row.id))}
                        className="ring-signal grid size-7 shrink-0 place-items-center rounded-md text-faint hover:text-rec">
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
              {mapHidden > 0 && (
                <button type="button" onClick={() => setMapShowAll((v) => !v)}
                  className="ring-signal self-start rounded-md font-mono text-[11.5px] text-dim hover:text-text">
                  {mapShowAll
                    ? `▾ Hide ${mapHidden} older`
                    : `▸ Show ${mapHidden} older mapping${mapHidden === 1 ? "" : "s"}`}
                </button>
              )}
            </Stack>
          )}

          {/* lowercase-wordlist: a regex + a word list */}
          {rule.type === "callback:lowercase-wordlist" && (
            <Stack gap={3}>
              <div>
                <FieldLabel>Match (regex)</FieldLabel>
                <TextInput
                  value={edit.pattern ?? ""}
                  disabled={inputsDisabled}
                  spellCheck={false}
                  className={monoInput}
                  onChange={(ev) => onPatch((e) => ({ ...e, pattern: ev.target.value }))}
                />
              </div>
              <div>
                <FieldLabel>Word list — one per line ({wordCount(edit.words)})</FieldLabel>
                <textarea
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

          {/* dedup / upper: a single regex */}
          {(rule.type === "callback:dedup" || rule.type === "callback:upper") && (
            <div>
              <FieldLabel>Match (regex)</FieldLabel>
              <TextInput
                value={edit.pattern ?? ""}
                disabled={inputsDisabled}
                spellCheck={false}
                className={monoInput}
                onChange={(ev) => onPatch((e) => ({ ...e, pattern: ev.target.value }))}
              />
            </div>
          )}

          {/* read-only context + per-rule reset */}
          <div className="flex items-end justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0 space-y-1">
              <div className="font-mono text-[10.5px] text-faint">{rule.name}</div>
              {rule.note && <div className="text-[12px] italic leading-snug text-dim">{rule.note}</div>}
            </div>
            {dirty && (
              <Button variant="ghost" size="sm" onClick={onReset} title="Discard this rule's changes">
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

function swap<T>(arr: T[], i: number, j: number): T[] {
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
function wordCount(words?: string): number {
  return (words ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
}

/* ── screen ────────────────────────────────────────────────────────────── */
export default function Dictionary() {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const quickAddList = useApp((s) => s.settings.quickAddList);
  const updateSettings = useApp((s) => s.updateSettings);

  // Candidate Backends: full faster-whisper servers (and untested ones — we can't
  // prove "standard", so we let the fetch decide). Standard servers are excluded.
  const candidates = useMemo(
    () => backends.filter((b) => effectiveServerKind(b, connections[b.id]) !== "standard"),
    [backends, connections],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId && candidates.some((c) => c.id === selectedId)) return;
    setSelectedId(candidates[0]?.id ?? null);
  }, [candidates, selectedId]);
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

  const [loading, setLoading] = useState(false);
  const [fetchRes, setFetchRes] = useState<PipelineFetch | null>(null);
  const [rules, setRules] = useState<PipelineRule[]>([]);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [base, setBase] = useState<Record<string, EditState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PipelineSaveResult | null>(null);
  // Recent-word suggestion pool for cb:map keys (best-effort; [] on old servers).
  const [recentWords, setRecentWords] = useState<string[]>([]);
  const [recentMax, setRecentMax] = useState<number | undefined>(undefined);

  // editable_fields is also forwarded as an opaque server value — coerce to a plain object,
  // and to an array per type, so a malformed shape can't make `.includes`/`.filter` throw.
  const efRaw = fetchRes?.state?.editable_fields as unknown;
  const editableFields: Record<string, string[]> =
    efRaw && typeof efRaw === "object" && !Array.isArray(efRaw) ? (efRaw as Record<string, string[]>) : {};
  const editableFor = useCallback(
    (r: PipelineRule) => {
      if (r.locked) return [];
      const f = editableFields[r.type];
      return Array.isArray(f) ? f : [];
    },
    [editableFields],
  );

  const load = useCallback(async (b: Backend) => {
    const myGen = ++loadGen.current;
    setLoading(true);
    setResult(null);
    let res: Awaited<ReturnType<typeof getPipelineRules>>;
    try {
      res = await getPipelineRules({ serverUrl: b.serverUrl, backendId: b.id });
    } catch {
      // get_pipeline_rules is a non-Result command; a transport-level reject would otherwise leave
      // the screen stuck on the loading spinner (and surface as an unhandled rejection from the
      // Refresh / FetchError-retry / SaveBanner-reload callers, which call load() without a .catch).
      // Clear loading unless a newer load() superseded us — mirrors the load-on-change effect's .catch.
      if (myGen === loadGen.current) setLoading(false);
      return;
    }
    if (b.id !== selectedIdRef.current || myGen !== loadGen.current) return; // backend switched OR a newer load() won
    setFetchRes(res);
    const list = ruleListOf(res);
    setRules(list);
    const fresh = Object.fromEntries(list.map((r) => [r.name, toEdit(r)]));
    setEdits(fresh);
    setBase(JSON.parse(JSON.stringify(fresh)));
    getRecentWords({ serverUrl: b.serverUrl, backendId: b.id })
      .then((rw) => {
        if (b.id !== selectedIdRef.current || myGen !== loadGen.current) return;
        setRecentWords(rw.words ?? []);
        setRecentMax(rw.max ?? undefined);
      })
      .catch(() => {}); // best-effort pool — a fetch failure must not surface as an unhandled rejection
    // Keep whichever rule cards are open across a save-triggered reload (and the conflict
    // auto-reload) — both go through load(). A rule that vanished server-side drops out.
    // Switching Backend resets expansion separately (the load-on-change effect below).
    setExpanded((prev) => new Set([...prev].filter((name) => list.some((r) => r.name === name))));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!backend) {
      setFetchRes(null);
      setRules([]);
      setRecentWords([]);
      setRecentMax(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setResult(null);
    getPipelineRules({ serverUrl: backend.serverUrl, backendId: backend.id })
      .then((res) => {
        if (cancelled) return;
        setFetchRes(res);
        const list = ruleListOf(res);
        setRules(list);
        const fresh = Object.fromEntries(list.map((r) => [r.name, toEdit(r)]));
        setEdits(fresh);
        setBase(JSON.parse(JSON.stringify(fresh)));
        setExpanded(new Set());
        setLoading(false);
      })
      // A transport-level reject (rare; get_pipeline_rules is a non-Result command) would otherwise
      // leave the screen stuck on `loading` + an unhandled rejection. Mirror the getRecentWords
      // sibling's .catch and clear loading so the empty/error state can render.
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    getRecentWords({ serverUrl: backend.serverUrl, backendId: backend.id })
      .then((rw) => {
        if (cancelled) return;
        setRecentWords(rw.words ?? []);
        setRecentMax(rw.max ?? undefined);
      })
      .catch(() => {}); // best-effort pool — a fetch failure must not surface as an unhandled rejection
    return () => {
      cancelled = true;
    };
  }, [backend?.id, backend?.serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cache buildPatch by the (edit, base, editable) references so a keystroke only re-diffs the
  // ONE rule that changed — not every rule. setEdits keeps other rules' edit values referentially
  // stable, so they hit the cache; each cb:map diff is a whole-map sort + JSON.stringify, so this
  // matters on large word-mapping lists. buildPatch is pure in (type, e, b, ed), so reference-equal
  // inputs always yield the same patch.
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
  const dirtyNames = useMemo(() => new Set(dirty.map((r) => r.name)), [dirty]);

  const role = fetchRes?.state?.role;

  async function save() {
    if (!backend || dirty.length === 0) return;
    const rules_patch: Record<string, Record<string, unknown>> = {};
    const fingerprints: Record<string, string> = {};
    for (const r of dirty) {
      rules_patch[r.name] = patchFor(r);
      if (r._fp) fingerprints[r.name] = r._fp;
    }
    setSaving(true);
    const res = await savePipelineRules({
      serverUrl: backend.serverUrl,
      backendId: backend.id,
      patch: { rules_patch, fingerprints },
    });
    setSaving(false);
    // Backend switched while the save was in flight → this result belongs to the
    // old backend; don't reload or flash its banner over the now-selected one.
    if (backend.id !== selectedIdRef.current) return;
    // On success, re-sync to server truth (fresh fingerprints; conflicted edits
    // are replaced by the server's version) BEFORE showing the banner — load()
    // clears `result`, so set it afterwards. On 422 keep edits so the user can fix.
    if (res.ok) await load(backend);
    setResult(res);
  }

  function patchEdit(slug: string, updater: (e: EditState) => EditState) {
    setEdits((prev) => ({ ...prev, [slug]: updater(prev[slug]) }));
  }
  function resetRule(slug: string) {
    setEdits((prev) => ({ ...prev, [slug]: JSON.parse(JSON.stringify(base[slug])) }));
  }
  function discardAll() {
    setEdits(JSON.parse(JSON.stringify(base)));
  }

  return (
    <Stack gap={6} className="mx-auto max-w-[820px] px-10 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">Server rules</div>
          <h1 className="mt-2 flex items-center gap-2.5 font-display text-[30px] font-bold tracking-tight text-text">
            <BookA className="size-7 text-accent" /> Dictionary
          </h1>
          <p className="mt-2 max-w-md text-[13.5px] text-dim">
            Text rules your server applies to every transcription — replacements, word mappings,
            punctuation tidy-up. Edit the ones your account is allowed to change.
          </p>
        </div>
        {backend && (
          <Button variant="ghost" size="sm" onClick={() => load(backend)} disabled={loading} title="Reload from server">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
          </Button>
        )}
      </header>

      {/* Backend picker (only when there's a choice) + role readout */}
      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {candidates.length > 1 &&
            candidates.map((b) => {
              const active = b.id === selectedId;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedId(b.id)}
                  className={cn(
                    "ring-signal rounded-pill border px-3.5 py-1.5 text-[12.5px] font-medium transition-colors",
                    active
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-surface-2 text-dim hover:text-text",
                  )}
                >
                  {b.name}
                </button>
              );
            })}
          {backend && fetchRes?.ok && role && (
            <span className="ml-auto text-[12px] text-faint">
              Editing as <span className="text-dim">{role}</span>
            </span>
          )}
        </div>
      )}

      {/* States */}
      {candidates.length === 0 ? (
        <EmptyCard
          title="No compatible server"
          body="The Dictionary needs a faster-whisper backend (one that reports a boot id). Add or test a server on the Backends screen."
        />
      ) : loading ? (
        <div className="flex items-center gap-2 py-16 text-[13px] text-dim">
          <Loader2 className="size-4 animate-spin" /> Loading rules…
        </div>
      ) : fetchRes && !fetchRes.ok ? (
        <FetchError fetch={fetchRes} backendName={backend?.name ?? "the server"} onRetry={() => backend && load(backend)} />
      ) : rules.length === 0 ? (
        <EmptyCard
          title="No rules to manage"
          body="An admin hasn't shared any editable rules with your account yet. Ask them to expose rules (and tag them for you) on the server."
        />
      ) : (
        <Stack gap={4}>
          {/* result banner */}
          {result && <SaveBanner result={result} onReload={() => backend && load(backend)} />}

          {/* unsaved-changes bar */}
          {dirty.length > 0 && (
            <div className="sticky top-0 z-10 -mx-2 flex items-center gap-3 rounded-xl border border-line-strong bg-panel/95 px-4 py-2.5 backdrop-blur-sm">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              <span className="text-[13px] text-text">
                {dirty.length} unsaved {dirty.length === 1 ? "change" : "changes"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={discardAll} disabled={saving}>Discard</Button>
                <Button variant="accent" size="sm" onClick={save} disabled={saving}>
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
        </Stack>
      )}
    </Stack>
  );
}

/* ── state cards ───────────────────────────────────────────────────────── */
function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <Card className="px-6 py-10 text-center">
      <BookA className="mx-auto mb-3 size-7 text-faint" />
      <div className="text-[15px] font-medium text-text">{title}</div>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-dim">{body}</p>
    </Card>
  );
}

function FetchError({ fetch, backendName, onRetry }: { fetch: PipelineFetch; backendName: string; onRetry: () => void }) {
  const { title, body } = describeFetchError(fetch, backendName);
  return (
    <Card className="px-6 py-9 text-center">
      <AlertTriangle className="mx-auto mb-3 size-6 text-warn" />
      <div className="text-[15px] font-medium text-text">{title}</div>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-dim">{body}</p>
      {(fetch.status === 0 || fetch.status >= 500) && (
        <Button variant="default" size="sm" className="mx-auto mt-4" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      )}
    </Card>
  );
}

function describeFetchError(fetch: PipelineFetch, name: string): { title: string; body: string } {
  switch (fetch.status) {
    case 0:
      return { title: `Couldn't reach ${name}`, body: fetch.error ?? "The server is unreachable. Check it's running and the URL is correct on the Backends screen." };
    case 401:
      return { title: "This server needs a valid API key", body: "Set or fix the API key for this Backend on the Backends screen, then refresh." };
    case 403:
      return { title: "Your account can't manage this dictionary", body: "An admin hasn't granted your key access to the rules editor. Ask them to enable it for your account." };
    case 404:
      return { title: "This server doesn't support editable rules", body: "It's either a standard Whisper server or an older faster-whisper-backend. Update the server to manage its dictionary here." };
    default:
      return { title: `Server error (HTTP ${fetch.status})`, body: fetch.error ?? "The server returned an unexpected error." };
  }
}

function SaveBanner({ result, onReload }: { result: PipelineSaveResult; onReload: () => void }) {
  // Validation failure — keep the user's edits so they can fix them. `errors` is opaque server JSON:
  // a non-array value (e.g. a bare string from a buggy/old/proxied server) passes a plain `.length`
  // truthy check and then crashes `.slice().map()`, white-screening the route. Coerce to an array
  // first — mirrors the GET-path rule coercion (ruleListOf). 422-without-errors falls through to the
  // generic !ok banner below.
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.status === 422 && errors.length) {
    return (
      <div className="rounded-xl border border-warn/30 bg-warn/5 px-3.5 py-2.5 text-[12.5px] text-warn">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
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
          </div>
        </div>
      </div>
    );
  }
  if (!result.ok) {
    return (
      <Notice>{result.detail || "Couldn't save the changes."}</Notice>
    );
  }
  // `conflicts` is opaque server JSON (passed through verbatim, only null-coerced); a non-array
  // value would make a plain `.length` produce a bogus count. Coerce to an array first — mirrors
  // the `errors` sibling above and the GET-path rule coercion (ruleListOf).
  const conflicts = (Array.isArray(result.conflicts) ? result.conflicts : []).length;
  return (
    <div className="space-y-2">
      {result.saved.length > 0 && (
        <Notice tone="ok">
          Saved {result.saved.length} {result.saved.length === 1 ? "rule" : "rules"}.
          {result.requires_restart ? " Some changes need a server restart to take effect." : ""}
        </Notice>
      )}
      {conflicts > 0 && (
        <Notice>
          {conflicts} {conflicts === 1 ? "rule" : "rules"} changed on the server and {conflicts === 1 ? "was" : "were"} not saved.
          The latest version has been reloaded.{" "}
          <button type="button" className="ring-signal underline hover:text-text" onClick={onReload}>Reload again</button>
        </Notice>
      )}
    </div>
  );
}
