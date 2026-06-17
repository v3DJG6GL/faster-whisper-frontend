// The quick-add word-mapping window (Tauri window label `quickadd`) — a minimal,
// focusable, always-on-top view for adding spoken→symbol mappings to ONE pinned
// "Word mappings" (callback:map) rule with the fewest clicks. Summoned by the
// chip quick-launch button or a global shortcut; the "When you say" field is
// auto-focused with a recent-transcribed-words dropdown (arrow-key pick).
//
// Like Overlay.tsx this is a STANDALONE root (its own JS context): it loads
// config itself and talks to the backend directly — it never mounts <App/> or
// touches the main window's store. Layout "A": an accent-bordered capture row on
// top, the existing (inline-editable) list below.
//
// Saving is debounced last-writer-wins: we PATCH the whole map WITHOUT a
// fingerprint, so the backend applies unconditionally (quick_config_routes.py).
// Re-fetching on each summon re-syncs any out-of-band edits — adequate for a
// single-user quick-capture surface (the Dictionary screen keeps explicit-save).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, X, Trash2, Loader2, Check, AlertTriangle, RefreshCw, BookA } from "lucide-react";
import { Button, TextInput } from "@/components/ui";
import { Combobox } from "@/components/Combobox";
import { type MapRow, nextRowId, mapRowsFromRule, mapBodyFromRows } from "@/lib/pipelineMap";
import {
  loadConfig, getPipelineRules, getRecentWords, savePipelineRules, hideQuickAdd, showMainAtScreen,
} from "@/lib/api";
import type { PipelineFetch } from "@/lib/types";
import { cn } from "@/lib/cn";

type Target = { serverUrl: string; backendId: string; slug: string };
type Phase = "loading" | "nopin" | "error" | "ok";
type SaveState = "idle" | "saving" | "saved" | "error";

// Admin rule-card colours → nearest Signal token (cosmetic dot). Mirrors Dictionary.
const COLOR_DOT: Record<string, string> = {
  red: "bg-rec", amber: "bg-warn", green: "bg-ok", teal: "bg-live",
  blue: "bg-accent", purple: "bg-accent", pink: "bg-accent",
};

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-none text-dim">
      {children}
    </kbd>
  );
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === "saving")
    return <span className="flex items-center gap-1.5 text-[11.5px] text-faint"><Loader2 className="size-3.5 animate-spin" /> saving…</span>;
  if (state === "saved")
    return <span className="flex items-center gap-1.5 text-[11.5px] text-ok"><Check className="size-3.5" /> saved</span>;
  if (state === "error")
    return (
      <button type="button" onClick={onRetry} className="ring-signal flex items-center gap-1.5 text-[11.5px] text-warn hover:underline" title="Retry save">
        <AlertTriangle className="size-3.5" /> retry
      </button>
    );
  return null;
}

export default function QuickAdd() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [fetchErr, setFetchErr] = useState<PipelineFetch | null>(null);
  const [label, setLabel] = useState("Word mappings");
  const [color, setColor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [recentMax, setRecentMax] = useState<number | undefined>(undefined);
  const [find, setFind] = useState("");
  const [insert, setInsert] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Bumped on each summon (and after each add) to remount the Combobox so its
  // `autoFocus` re-fires — focusing the find field for the next entry.
  const [showSeq, setShowSeq] = useState(0);
  // Should the refocused field auto-open its recent-words dropdown? Yes on a fresh
  // summon (the first add), no right after "add another" (it stays out of the way
  // until you type / ArrowDown / click).
  const [openOnSummon, setOpenOnSummon] = useState(true);

  const target = useRef<Target | null>(null);
  const rowsRef = useRef<MapRow[]>([]);
  rowsRef.current = rows;
  const saveTimer = useRef<number | null>(null);
  const insertRef = useRef<HTMLInputElement>(null);

  const usedKeys = new Set(rows.map((r) => r.k.trim().toLowerCase()).filter(Boolean));
  const suggestions = recent.filter((w) => !usedKeys.has(w.toLowerCase()));

  const refresh = useCallback(async () => {
    const cfg = await loadConfig();
    if (cfg) document.documentElement.dataset.theme = cfg.settings.theme;
    const pin = cfg?.settings.quickAddList ?? null;
    const backend = pin ? cfg!.backends.find((b) => b.id === pin.backendId) ?? null : null;
    if (!pin || !backend) {
      target.current = null;
      setPhase("nopin");
      return;
    }
    target.current = { serverUrl: backend.serverUrl, backendId: backend.id, slug: pin.slug };
    setPhase("loading");
    const res = await getPipelineRules({ serverUrl: backend.serverUrl, backendId: backend.id });
    if (!res.ok) {
      setFetchErr(res);
      setPhase("error");
      return;
    }
    const rule = res.state?.rules.find((r) => r.name === pin.slug && r.type === "callback:map") ?? null;
    if (!rule) {
      setFetchErr({ ok: false, status: 404, error: "The pinned list no longer exists on this server — re-pin one in the Dictionary." });
      setPhase("error");
      return;
    }
    setLabel(rule.label || "Word mappings");
    setColor(rule.color);
    setRows(mapRowsFromRule(rule));
    setSaveState("idle");
    setPhase("ok");
    getRecentWords({ serverUrl: backend.serverUrl, backendId: backend.id }).then((rw) => {
      setRecent(rw.words ?? []);
      setRecentMax(rw.max ?? undefined);
    });
  }, []);

  // Initial load (the static window mounts hidden at startup).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Each summon: re-sync, clear the add row, and re-focus the find field.
  useEffect(() => {
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("quickadd://shown", () => {
          setFind("");
          setInsert("");
          setOpenOnSummon(true);
          setShowSeq((s) => s + 1);
          void refresh();
        }),
      )
      .then((f) => {
        un = f;
      });
    return () => un?.();
  }, [refresh]);

  // ── autosave: whole-map PATCH, no fingerprint (backend = last-writer-wins) ──
  const flushSave = useCallback(async () => {
    const t = target.current;
    if (!t) return;
    saveTimer.current = null;
    const res = await savePipelineRules({
      serverUrl: t.serverUrl,
      backendId: t.backendId,
      patch: { rules_patch: { [t.slug]: mapBodyFromRows(rowsRef.current) } },
    });
    setSaveState(res.ok ? "saved" : "error");
  }, []);

  const scheduleSave = useCallback(() => {
    if (!target.current) return;
    setSaveState("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void flushSave();
    }, 600);
  }, [flushSave]);

  const mutate = useCallback(
    (updater: (rows: MapRow[]) => MapRow[]) => {
      setRows((prev) => updater(prev));
      scheduleSave();
    },
    [scheduleSave],
  );

  const addMapping = useCallback(() => {
    const k = find.trim();
    if (!k) return;
    const v = insert;
    mutate((rs) => [{ id: nextRowId(), k, v }, ...rs]);
    setFind("");
    setInsert("");
    setOpenOnSummon(false); // refocus the find field, but keep its dropdown out of the way
    setShowSeq((s) => s + 1); // remount Combobox → re-focus find for the next add
  }, [find, insert, mutate]);

  const closeNow = useCallback(() => {
    const pending = saveTimer.current !== null;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pending) void flushSave(); // persist a debounced edit before hiding
    void hideQuickAdd();
  }, [flushSave]);

  // Esc closes the window from anywhere in it — not only when a text field is focused.
  // (Clicking empty space moves focus to <body>, an ancestor of the React root, so a
  // keydown there never bubbled through the root div's handler.) The Combobox stops
  // Esc while its dropdown is open, so the first Esc there only closes the dropdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeNow]);

  const dot = color ? COLOR_DOT[color] ?? "bg-live" : "bg-live";

  return (
    <div className="flex h-screen w-screen bg-transparent p-3">
      <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8),0_0_60px_-26px_rgba(255,158,44,0.22)]">
        {/* header */}
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Plus className="size-4 text-accent" />
          <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
          <span className="truncate font-display text-[15px] font-semibold text-text">{label}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">quick add</span>
          <span className="ml-auto flex items-center gap-2">
            <SaveStatus state={saveState} onRetry={() => void flushSave()} />
            <button
              type="button"
              onClick={closeNow}
              title="Close (Esc)"
              aria-label="Close"
              className="ring-signal grid size-7 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-text"
            >
              <X className="size-4" />
            </button>
          </span>
        </div>

        {phase === "loading" ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-dim">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : phase === "nopin" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <BookA className="size-7 text-faint" />
            <div className="text-[14px] font-medium text-text">No quick-add list chosen</div>
            <p className="max-w-xs text-[12.5px] text-dim">
              Open the Dictionary and pin a word-mapping list as your quick-add target.
            </p>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void showMainAtScreen("dictionary");
                void hideQuickAdd();
              }}
            >
              <BookA className="size-3.5" /> Open Dictionary
            </Button>
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <AlertTriangle className="size-7 text-warn" />
            <div className="text-[14px] font-medium text-text">{errTitle(fetchErr)}</div>
            <p className="max-w-xs text-[12.5px] text-dim">{errBody(fetchErr)}</p>
            <Button variant="default" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : (
          <>
            {/* capture zone (Layout A: hero add row, accent-bordered) */}
            <div
              onKeyDown={(e) => {
                // Enter in the find field with no dropdown selection (not yet handled
                // by the Combobox) advances to the Insert field.
                if (e.key !== "Enter" || e.defaultPrevented) return;
                if ((e.target as HTMLElement).getAttribute("role") === "combobox") {
                  e.preventDefault();
                  insertRef.current?.focus();
                }
              }}
              className="mx-3 mt-3 rounded-xl border border-line border-l-2 border-l-accent bg-surface-2/40 p-3.5"
            >
              <div className="mb-2.5 font-mono text-[10px] uppercase tracking-wider text-accent">add a mapping</div>
              <div className="grid grid-cols-[1fr_150px] items-end gap-2.5">
                <div className="min-w-0">
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-faint">When you say</label>
                  <Combobox
                    key={showSeq}
                    value={find}
                    autoFocus
                    openOnFocus={openOnSummon}
                    suggestions={suggestions}
                    footerMax={recentMax}
                    placeholder="say a word…"
                    onChange={setFind}
                    onSelect={(w) => {
                      setFind(w);
                      insertRef.current?.focus();
                    }}
                  />
                </div>
                <div className="min-w-0">
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-faint">Insert</label>
                  <TextInput
                    ref={insertRef}
                    value={insert}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder=","
                    className="font-mono text-[13px]"
                    onChange={(e) => setInsert(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addMapping();
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            {/* list head */}
            <div className="flex items-center justify-between px-4 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-faint">
              <span>in this list</span>
              <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-dim">{rows.length}</span>
            </div>

            {/* mappings — inline-editable, newest-first */}
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
              {rows.length === 0 ? (
                <div className="px-2 py-8 text-center text-[13px] text-faint">No mappings yet — add your first above.</div>
              ) : (
                rows.map((row) => (
                  <div key={row.id} className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-2/40">
                    <input
                      value={row.k}
                      aria-label="spoken phrase"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => mutate((rs) => rs.map((r) => (r.id === row.id ? { ...r, k: e.target.value } : r)))}
                      className="ring-signal min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[14px] text-text hover:bg-surface-2"
                    />
                    <span className="shrink-0 text-faint" aria-hidden>→</span>
                    <input
                      value={row.v}
                      aria-label="inserted text"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => mutate((rs) => rs.map((r) => (r.id === row.id ? { ...r, v: e.target.value } : r)))}
                      className="ring-signal w-[110px] shrink-0 rounded-md bg-transparent px-2 py-1 text-center font-mono text-[13px] text-text hover:bg-surface-2"
                    />
                    <button
                      type="button"
                      title="Remove mapping"
                      onClick={() => mutate((rs) => rs.filter((r) => r.id !== row.id))}
                      className="ring-signal grid size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 transition-opacity hover:text-warn group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* footer hints */}
            <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-[12px] text-faint">
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd> save &amp; add another
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd> done
              </span>
              <span className="ml-auto flex items-center gap-1.5 opacity-80">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> recent
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function errTitle(f: PipelineFetch | null): string {
  switch (f?.status) {
    case 0:
      return "Couldn't reach the server";
    case 401:
      return "This server needs a valid API key";
    case 403:
      return "Your account can't edit this list";
    case 404:
      return "List unavailable";
    default:
      return `Server error (HTTP ${f?.status ?? "?"})`;
  }
}
function errBody(f: PipelineFetch | null): string {
  if (f?.error) return f.error;
  switch (f?.status) {
    case 401:
      return "Set or fix the API key for this Backend on the Backends screen.";
    case 403:
      return "Ask an admin to grant your key access to the rules editor.";
    default:
      return "Check the server and the pinned list, then retry.";
  }
}
