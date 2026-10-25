// The quick-add word-mapping window (Tauri window label `quickadd`) — a minimal,
// focusable, always-on-top view for adding spoken→symbol mappings to ONE pinned
// "Word mappings" (callback:map) rule with the fewest clicks. Summoned by the
// chip quick-launch button or a global shortcut; the "When you say" field is
// auto-focused with a recent-transcribed-words dropdown (arrow-key pick).
//
// Like Overlay.tsx this is a STANDALONE root (its own JS context): it loads
// config itself and talks to the backend directly — it never mounts <App/> or
// touches the main window's store. Layout: an accent-bordered capture row on
// top, the existing (inline-editable) list below.
//
// Saving is debounced last-writer-wins: we PATCH the whole map WITHOUT a
// fingerprint, so the backend applies unconditionally (quick_config/routes.py).
// Re-fetching on each summon re-syncs any out-of-band edits — adequate for a
// single-user quick-capture surface (the Dictionary screen keeps explicit-save).

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Trash2, Loader2, Check, AlertTriangle, RefreshCw, BookA } from "lucide-react";
import { Button, Kbd, TextInput } from "@/components/ui";
import { Combobox } from "@/components/Combobox";
import {
  type MapRow, nextRowId, mapRowsFromRule, mapBodyFromRows, applyMap, mapEntryProblem, mapKeyTwinProblem, mapRowEditProblem,
  mapRowTwinProblems, ruleListOf, ruleLockedFor, ruleMapWritable,
} from "@/lib/pipelineMap";
import {
  type QuickAddSaveTarget, quickAddRejectReason, quickAddSaveOutcome, quickAddTargetOnLoad, quickAddTargetOnSummon,
  selectionEdges,
} from "@/lib/quickAddSave";
import { ruleDotColor } from "@/lib/ruleColor";
import { ruleListLabel, wellFormedAppRules } from "@/lib/sanitize";
import {
  readConfig, getPipelineRules, getRecentWords, savePipelineRules, hideQuickAdd, showMainAtScreen,
  getQuickAddSeed, getFocusedSelection, getFocusedApp, injectText, subscribe, isTauri,
} from "@/lib/api";
import { resolveInjectionTarget } from "@/lib/dictation/streaming";
import { IS_WINDOWS } from "@/lib/platform";
import { applyAccentAndTheme, startAccentDrift, watchSystemTheme } from "@/lib/theme";
import type { AppRule, GeneralSettings, PipelineFetch, PipelineSaveResult, ThemeName } from "@/lib/types";
import { imeComposing } from "@/lib/keys";
import { useTauriListener } from "@/lib/useTauriListener";

// Client-side ceilings on the two server-supplied lists this window renders (defence in depth:
// Rust caps the recent-words count but bounds the rules only by body bytes). This webview is
// summoned by a global hotkey — a huge list would wedge it (and, on Linux, the renderer it
// shares with the chip).
const MAX_SHOWN_ROWS = 500;
const MAX_RECENT_WORDS = 500;

type Target = QuickAddSaveTarget;
type Phase = "loading" | "nopin" | "error" | "ok";
/** "pinned": the PATCH answered 2xx but the server's environment pins the rule list, so nothing
 *  changed — terminal, not a failure: a retry can never land, so it is neither auto-retried nor
 *  allowed to hold off the summon's re-sync (the rows the server really serves). */
type SaveState = "idle" | "saving" | "saved" | "error" | "pinned" | "rejected";

function SaveStatus({ state, reason, onRetry }: { state: SaveState; reason: string; onRetry: () => void }) {
  if (state === "saving")
    return <span className="flex items-center gap-1.5 text-[11.5px] text-faint"><Loader2 className="size-3.5 animate-spin" /> saving…</span>;
  if (state === "saved")
    return <span className="flex items-center gap-1.5 text-[11.5px] text-ok"><Check className="size-3.5" /> saved</span>;
  if (state === "pinned")
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-warn" title="The server's environment pins the rule list, so this change does not take effect">
        <AlertTriangle className="size-3.5" /> not applied
      </span>
    );
  if (state === "rejected")
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-warn" title={`This list was not saved: ${reason}`}>
        <AlertTriangle className="size-3.5" /> not saved
      </span>
    );
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
  // Why the rows were not saved (a 422 or dictionary cap, or a case twin held back) — the "not saved" badge's reason.
  const [rejectReason, setRejectReason] = useState("");
  // A list edit refused because the server's word-list schema would reject it (mapEntryProblem),
  // and why — shown under that row until its next accepted edit.
  const [rowProblem, setRowProblem] = useState<{ id: number; msg: string } | null>(null);
  // Bumped on each summon (and after each add) to remount the Combobox so its
  // `autoFocus` re-fires — focusing the find field for the next entry.
  const [showSeq, setShowSeq] = useState(0);
  // Should the refocused field auto-open its recent-words dropdown? Yes on a fresh
  // summon (the first add), no right after "add another" (it stays out of the way
  // until you type / ArrowDown / click).
  const [openOnSummon, setOpenOnSummon] = useState(true);
  // When summoned with text selected, we seed "When you say" and then move the cursor to
  // "Insert" (the word's captured). Gates the focus-Insert layout effect below, which overrides
  // the Combobox's autoFocus once the capture row has (re)mounted; reset on "add another".
  const [focusInsert, setFocusInsert] = useState(false);

  const target = useRef<Target | null>(null);
  const rowsRef = useRef<MapRow[]>([]);
  rowsRef.current = rows;
  // Live mirror of `phase` for closeNow: correct-on-close only runs the list while it is on
  // screen ("ok") — not on nopin, while loading, or after an error, when the capture row is
  // replaced and a hidden paste on close would surprise (deliberate).
  const phaseRef = useRef<Phase>("loading");
  phaseRef.current = phase;
  // Live mirror of `find` so the once-built summon listener can tell whether the user has begun
  // typing since the reset — the seed read is awaited (AT-SPI up to ~1s; the Windows clipboard
  // rendezvous up to ~6.5s under RDP) AFTER the field is made interactive, so a slow seed must not
  // clobber input the user already entered.
  const findRef = useRef("");
  findRef.current = find;
  const saveTimer = useRef<number | null>(null);
  // flushSave's newest-attempt counter and its one-at-a-time PATCH chain.
  const saveSeq = useRef(0);
  const saveFlight = useRef<Promise<unknown>>(Promise.resolve());
  // Mirror saveState into a ref so the summon listener (a stale-closure-prone callback) reads the
  // latest value. A fired-but-failed save leaves saveTimer null yet the local rows are still unsaved.
  const saveStateRef = useRef<SaveState>("idle");
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);
  const insertRef = useRef<HTMLInputElement>(null);
  // The word seeded from the source app's selection this summon (null if none). On close we run
  // the current list over it and, if it changed AND it's still selected, paste the result back —
  // correcting the word in place.
  const originalSelectionRef = useRef<string | null>(null);
  // General settings + per-app rules, so correct-on-close resolves the SOURCE app's injection target
  // through the SAME shared resolver the main injection path uses (resolveInjectionTarget) — per-app
  // method/paste-shortcut, "never type here", AND the deep-detection non-editable→clipboard coercion.
  const generalRef = useRef<GeneralSettings | null>(null);
  const appRulesRef = useRef<AppRule[]>([]);
  // The loaded theme setting, kept for the OS-scheme watcher ("auto" must re-resolve live).
  const themeRef = useRef<ThemeName>("auto");
  // Track live OS scheme flips while on "auto" — this window is prewarmed/long-lived;
  // refreshLocalConfig() re-applies the setting itself on every summon.
  useEffect(() => startAccentDrift(), []);
  useEffect(() => watchSystemTheme(() => themeRef.current), []);
  // Generation guards so an out-of-order async resolution can't apply stale state. `loadGen`
  // covers refresh()'s fetches (a re-pin between rapid summons); `summonGen` covers the
  // per-summon selection seed.
  const loadGen = useRef(0);
  const summonGen = useRef(0);
  // `recentGen` covers the recent-words pool, which refreshes on EVERY summon — including the
  // ones that skip refresh() to protect an unsaved edit. Its own counter (latest-wins), NOT
  // loadGen: bumping loadGen here would abort an in-flight refresh()'s rows application, and
  // merely capturing it wouldn't order two standalone fetches between refreshes.
  const recentGen = useRef(0);
  // One log per run of failed local config reads: refreshLocalConfig runs on every summon.
  const localReadFailed = useRef(false);

  // Recent-words fetch, shared by refresh() and the summon path. Read-only (can never clobber
  // an edit), so unlike the rows re-sync it is safe to run unconditionally. Best-effort: Rust
  // answers a server failure with an empty list; only an IPC rejection keeps the previous pool.
  // Null target = no successful config load yet (a summon racing the initial load) or no pinned
  // list — nothing to fetch from.
  const fetchRecent = useCallback(async () => {
    const t = target.current;
    if (!t) return;
    const rg = ++recentGen.current;
    try {
      const rw = await getRecentWords({ serverUrl: t.serverUrl, backendId: t.backendId });
      if (rg !== recentGen.current) return; // a newer fetch won
      setRecent((rw.words ?? []).slice(0, MAX_RECENT_WORDS));
      setRecentMax(rw.max ?? undefined);
    } catch {
      /* best-effort pool — a fetch failure must not surface as an unhandled rejection */
    }
  }, []);

  // Render cap only — `rows` stays whole because mapBodyFromRows sends it back as the ENTIRE map,
  // so trimming the state itself would delete the server's other entries on the next save.
  // The memos below keep a keystroke in the insert field or a list row from rebuilding the Set +
  // filtered pool (and handing a fresh array into Combobox, re-running its rank).
  const shownRows = useMemo(() => rows.slice(0, MAX_SHOWN_ROWS), [rows]);
  const usedKeys = useMemo(() => new Set(rows.map((r) => r.k.trim().toLowerCase()).filter(Boolean)), [rows]);
  const suggestions = useMemo(() => recent.filter((w) => !usedKeys.has(w.toLowerCase())), [recent, usedKeys]);

  /** The LOCAL half of `refresh`: theme plus the injection policy this window types under.
   *
   *  Split out because `refresh` is skipped on a summon while a save is pending, in flight,
   *  failed or rejected — with a persistently failing backend, for the window's whole life — and the
   *  correction path resolves against these refs (a later `block` rule must still apply). It
   *  touches no server and never replaces `rows`, so it cannot clobber an unsaved edit.
   *
   *  Resolves true when the pin has moved off the list this window targets (quickAddTargetMoved):
   *  the summon then re-syncs even over unsaved rows, which belong to the old list. Otherwise the
   *  target follows the file's current address (quickAddTargetOnSummon), rows kept, so the
   *  pending save retries there. */
  const refreshLocalConfig = useCallback(async (): Promise<boolean> => {
    try {
      // readConfig, not loadConfig: a mid-session read must never recover (rename the file to
      // .bak and adopt defaults) — an unreadable file rejects, and the refs keep their last read.
      const cfg = await readConfig();
      localReadFailed.current = false;
      if (!cfg) return false;
      themeRef.current = cfg.settings.theme;
      applyAccentAndTheme(cfg.settings.accentHue, cfg.settings.accentMotion, cfg.settings.theme);
      generalRef.current = cfg.settings.general;
      // No store in this window: apply the same appRules floor as hydration (wellFormedAppRules)
      // so both injecting windows agree on which rules match.
      appRulesRef.current = wellFormedAppRules(cfg.appRules);
      const { moved, target: next } = quickAddTargetOnSummon(target.current, cfg);
      if (!moved) target.current = next;
      return moved;
    } catch (e) {
      // An unreadable file or an IPC failure must not be an unhandled rejection on a
      // hotkey-summoned window; the refs keep their last good read (no reset), logged once.
      if (!localReadFailed.current) console.error("quick-add local config refresh failed:", e);
      localReadFailed.current = true;
      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    const gen = ++loadGen.current;
    try {
      // Never recovers: the launch recovery already ran in Rust setup, and the main window owns
      // its banner. An unreadable file rejects into the catch below (an error, not "nopin").
      const cfg = await readConfig();
      if (gen !== loadGen.current) return; // superseded by a newer refresh/summon
      if (cfg) {
        themeRef.current = cfg.settings.theme;
        applyAccentAndTheme(cfg.settings.accentHue, cfg.settings.accentMotion, cfg.settings.theme);
        generalRef.current = cfg.settings.general;
        appRulesRef.current = wellFormedAppRules(cfg.appRules);
      }
      const t = quickAddTargetOnLoad(target.current, cfg);
      target.current = t;
      if (!t) {
        setPhase("nopin");
        return;
      }
      setPhase("loading");
      const res = await getPipelineRules({ serverUrl: t.serverUrl, backendId: t.backendId });
      if (gen !== loadGen.current) return; // a newer refresh won — don't clobber its rows/target
      if (!res.ok) {
        setFetchErr(res);
        setPhase("error");
        return;
      }
      const rules = ruleListOf(res);
      const rule = rules.find((r) => r.name === t.slug && r.type === "callback:map") ?? null;
      if (!rule) {
        // status -2: a LOCAL sentinel (like -1) — a real server 404 means the rules endpoint itself is missing.
        setFetchErr({ ok: false, status: -2, error: "The pinned list no longer exists on this server — re-pin one in the Dictionary." });
        setPhase("error");
        return;
      }
      // The Dictionary's write gate: a list an admin locked (or whose map this caller may not
      // edit) refuses every PATCH with a 403. Offering it would show added rows that never reach
      // the server, and the failed save then re-PATCHes on every summon. status -3/-4: LOCAL too.
      if (!ruleMapWritable(rule, res.state)) {
        setFetchErr(
          ruleLockedFor(rule, res.state?.role)
            ? {
                ok: false,
                status: -3,
                error: "An admin locked this list on the server — ask them to unlock it, or pin another list in the Dictionary.",
              }
            : {
                ok: false,
                status: -4,
                error: "This server doesn't let your account edit this list's mappings — pin another list in the Dictionary.",
              },
        );
        setPhase("error");
        return;
      }
      // The server-authored label goes through the same rule as the Dictionary and Onboarding
      // (`ruleListLabel`); "Word mappings" only when label and name are both blank.
      setLabel(ruleListLabel(rule.label, rule.name, 80) || "Word mappings");
      setColor(rule.color);
      setRows(mapRowsFromRule(rule));
      setSaveState("idle");
      setPhase("ok");
      void fetchRecent();
    } catch (e) {
      // readConfig() rejects on an unreadable file or a plumbing failure; without this the
      // standalone window would hang on "Loading…" forever (phase never advances) and Retry would
      // re-throw.
      if (gen !== loadGen.current) return;
      console.error("quick-add refresh failed:", e);
      // status -1: a LOCAL failure, not a network one — 0 would title it "Couldn't reach the server".
      setFetchErr({ ok: false, status: -1, error: "Couldn’t load the quick-add configuration — try again." });
      setPhase("error");
    }
  }, [fetchRecent]);

  // Initial load (the static window mounts hidden at startup).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Returns whether the PATCH landed, so the summon auto-retry can chain a re-sync on success.
  const flushSave = useCallback(async (): Promise<boolean> => {
    // A retry (badge click / summon auto-retry) can run while the 600ms debounce is still
    // armed — CANCEL it, don't just null the handle: an orphaned timeout would fire a second,
    // concurrent PATCH of the same rows (and closeNow flushes only while a timer is armed, so it
    // would never notice an orphaned one). Ahead of the no-target return: a fired timer whose
    // handle stayed set reads as "save pending" to the summon gate, which then never re-syncs.
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!target.current) return false;
    // Mark in flight: the badge shows progress, and the summon auto-retry / a badge
    // double-click are suppressed by the "saving" guards instead of double-PATCHing.
    setSaveState("saving");
    // The newest attempt decides the badge, as persistence.ts does (saveSeq). Flights run one at
    // a time: two concurrent whole-map PATCHes could land on the server out of order, and an
    // older one landing late would repaint "saved" over the newer one's "error" — the next summon
    // would then re-sync over the refused rows. A flight superseded while it queued sends nothing:
    // the newer one sends the newest rows (both read when the flight starts, as one pair).
    const mySeq = ++saveSeq.current;
    const run = saveFlight.current.then<PipelineSaveResult | string | null>(() => {
      const t = target.current;
      if (!t || mySeq !== saveSeq.current) return null;
      // Held, not sent, while a case twin remains: the server would 422 the whole map. Read with
      // the rows it guards, at the flight's start — an edit made while this queued counts.
      const twin = mapRowTwinProblems(rowsRef.current).values().next().value;
      if (twin !== undefined) return twin;
      return savePipelineRules({
        serverUrl: t.serverUrl,
        backendId: t.backendId,
        patch: { rules_patch: { [t.slug]: mapBodyFromRows(rowsRef.current) } },
      });
    });
    saveFlight.current = run.catch(() => {});
    try {
      const res = await run;
      if (res === null) {
        // Superseded: the newer flight owns the badge. Still the newest: the pin went away while
        // this queued (refresh → "nopin"), so nothing is unsaved — don't leave "saving" stuck.
        if (mySeq === saveSeq.current && saveTimer.current === null) setSaveState("idle");
        return false;
      }
      if (typeof res === "string") {
        // A held twin reads as a 422 would: the rows are kept, never auto-retried, and the edit
        // that resolves the twin sends them.
        if (saveTimer.current === null && mySeq === saveSeq.current) {
          setRejectReason(res);
          setSaveState("rejected");
        }
        return false;
      }
      const newest = mySeq === saveSeq.current;
      // quickAddSaveOutcome keeps four cases out of "error" (which skips the summon re-sync and
      // auto-retries): a 2xx the server's environment pins ("pinned", like Dictionary's notice), a
      // 2xx whose reply couldn't be read (it LANDED), and a refusal the server names, of the list
      // ("refused") or of the rows ("rejected"). Retrying them would PATCH on every summon, never
      // re-sync, and once a pin is lifted push these stale rows over the stored rule unasked.
      const outcome = quickAddSaveOutcome(res);
      // An edit landed DURING the PATCH (scheduleSave re-armed the timer): this flight's rows
      // are stale — its own flush will report the newer outcome, so don't repaint the badge
      // (a stale "saved" over a pending edit is how "error"+armed-timer states arise).
      // A newer flight queued behind this one likewise reports its own, newer outcome; and only
      // the newest may tell the summon auto-retry to re-sync (refresh) over the local rows.
      if (saveTimer.current === null && newest) {
        if (outcome === "refused") {
          // Re-sync now rather than leave "error" (a re-PATCH of a refused list on every summon):
          // refresh's write gate then replaces the list with "List locked" / read-only, or the
          // "re-pin one" page for a list that is gone.
          setSaveState("idle");
          void refresh();
        } else {
          if (outcome === "rejected") setRejectReason(quickAddRejectReason(res));
          setSaveState(outcome);
        }
      }
      return outcome === "saved" && newest;
    } catch (e) {
      // savePipelineRules is a bare invoke that can reject on an IPC failure — without this saveState
      // stays stuck at "saving" (no retry button + unhandled rejection), and every summon then skips
      // the re-sync without auto-retrying. Treat a reject as a save error.
      console.error("quick-add save failed:", e);
      if (saveTimer.current === null && mySeq === saveSeq.current) setSaveState("error");
      return false;
    }
  }, [refresh]);

  // Each summon: re-sync + reset the add row instantly, then seed "When you say" from the
  // source app's current selection. The reset doesn't wait on the (off-thread, time-bounded)
  // selection read, so the window is responsive at once; the seed then swoops in if there is one.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    const onSummon = async () => {
      const sgen = ++summonGen.current;
      // Instant empty-capture reset — focus the find field quietly (no dropdown yet).
      setFind("");
      setInsert("");
      setOpenOnSummon(false);
      setFocusInsert(false);
      setShowSeq((s) => s + 1);
      // Don't re-fetch over unsaved rows: refresh() replaces `rows` with the server map (and resets
      // saveState to "idle", dropping the only retry signal), and a still-armed 600ms saveTimer
      // would then re-save the stale server rows. Unsaved = timer armed, PATCH in flight
      // ("saving"), failed ("error"), or "rejected" (the rows themselves refused: the user's to fix, never
      // auto-retried — the same rows would be rejected again). A "pinned" save is not: the server
      // will never take those rows, so re-sync to what it serves.
      // refreshLocalConfig runs unconditionally, ahead of the branch: the policy this window types
      // under must never be older than the last summon.
      const targetMoved = refreshLocalConfig();
      const unsaved = saveStateRef.current === "error" || saveStateRef.current === "rejected" || saveStateRef.current === "saving";
      if (saveTimer.current === null && !unsaved) {
        void refresh();
      } else {
        void targetMoved.then((moved) => {
          if (sgen !== summonGen.current) return;
          if (moved) {
            // The unsaved rows belong to the list the pin moved off (quickAddTargetMoved): drop them
            // and load the new one. Disarm the debounce and supersede any queued flight first — either
            // would otherwise send these rows to the new target once refresh() has switched to it.
            if (saveTimer.current) window.clearTimeout(saveTimer.current);
            saveTimer.current = null;
            ++saveSeq.current;
            setSaveState("idle");
            void refresh();
            return;
          }
          // The rows re-sync is skipped to protect the unsaved edit — but the recent-words pool
          // is read-only, so keep it fresh regardless. Only once the read above has adopted a new
          // device address: fetched before it, the pool came from the old, unreachable one.
          void fetchRecent();
          // Failed save: retry it now instead of waiting for a click on the tiny badge. Only when
          // no timer is armed — an armed timer flushes the newest rows itself, and a parallel
          // retry would double-PATCH. On success, re-sync fully — unless an edit arrived during
          // the retry (timer re-armed), whose own flush now owns the state.
          if (saveStateRef.current === "error") {
            void flushSave().then((ok) => {
              if (ok && saveTimer.current === null && sgen === summonGen.current) void refresh();
            });
          }
        });
      }
      // Seed from whatever the user highlighted in the source app. Got a word → fill it and
      // drop the cursor straight in "Insert" (it's captured). Nothing usable → open the
      // recent-words dropdown on the (already-focused) find field.
      const seed = await getQuickAddSeed();
      if (sgen !== summonGen.current) return; // a newer summon superseded this one
      originalSelectionRef.current = seed; // remember the selected word for correct-on-close (always)
      // The user began typing while the seed was still being read → keep their input + focus;
      // don't overwrite the field or yank focus to Insert.
      if (findRef.current !== "") return;
      if (seed) {
        setFind(seed);
        setOpenOnSummon(false);
        setFocusInsert(true);
        setShowSeq((s) => s + 1);
      } else {
        setOpenOnSummon(true);
        setShowSeq((s) => s + 1);
      }
    };
    subscribe("quickadd://shown", () => void onSummon())
      .then(async (f) => {
        // If the effect was torn down before listen() resolved (StrictMode dev mount→unmount→
        // remount), drop the subscription now instead of leaking a duplicate listener.
        if (cancelled) {
          f();
          return;
        }
        un = f;
        // Recovery for a summon whose `quickadd://shown` emit outran this listener's
        // registration (first summon right after app start: page load → this lazy event-chunk
        // import → the listen() IPC round trip — an emit with no registered JS listener is
        // dropped, never queued). If the window is already visible and no summon has run,
        // run one now. Safe to race a real event: the sgen guard supersedes the older run,
        // and the backend seed read is generation-stamped and non-destructive, so this can
        // never surface another summon's text.
        if (isTauri && summonGen.current === 0) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const visible = await getCurrentWindow().isVisible().catch(() => false);
          if (!cancelled && visible && summonGen.current === 0) void onSummon();
        }
      })
      .catch(() => {}); // a rejected dynamic import / listen() must not surface as an unhandled rejection
    return () => {
      cancelled = true;
      un?.();
    };
  }, [refresh, refreshLocalConfig, fetchRecent, flushSave]);

  // After a summon, land the cursor in "Insert" when we seeded a selection (the word's already
  // captured). This overrides the Combobox's autoFocus, running AFTER it in the same commit
  // (a child mounts before the parent layout effect), so there's no focus flicker. Crucially it
  // also re-runs on the phase→"ok" transition: refresh() flips the capture row to "loading" and
  // back on every summon, which unmounts/remounts the fields and would otherwise strand focus.
  useLayoutEffect(() => {
    if (phase === "ok" && focusInsert) insertRef.current?.focus();
  }, [showSeq, focusInsert, phase]);

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

  // A pair the server's word-list schema would reject is refused here, with the reason under
  // the capture row: sent, its 422 would fail the whole-map PATCH — and every later save with it.
  // A selection seed ("don't", "C++", a long phrase, a capitalised "Komma" beside "komma") is the
  // usual way one arrives.
  const addProblem = find.trim() ? (mapEntryProblem(find, insert) ?? mapKeyTwinProblem(find, rows)) : null;
  const addMapping = useCallback(() => {
    if (!find.trim()) return;
    // Its reason is already on screen (addProblem).
    if (mapEntryProblem(find, insert) ?? mapKeyTwinProblem(find, rowsRef.current)) return;
    const k = find; // keep the key VERBATIM — leading/trailing spaces are meaningful (see pipelineMap)
    const v = insert;
    mutate((rs) => [{ id: nextRowId(), k, v }, ...rs]);
    setFind("");
    setInsert("");
    setOpenOnSummon(false); // refocus the find field, but keep its dropdown out of the way
    setFocusInsert(false); // after "add another" the find field gets focus (capture the next word)
    setShowSeq((s) => s + 1);
  }, [find, insert, mutate]);

  // Rows whose phrase is a case twin of another row — the reason shows under each, and flushSave
  // holds the PATCH while any remains.
  const twinProblems = useMemo(() => mapRowTwinProblems(rows), [rows]);

  // An inline list edit, refused (with its reason under the row) when it would turn a row the
  // server takes into one it rejects (see mapRowEditProblem — a case twin is not refused here).
  const editRow = useCallback(
    (row: MapRow, field: "k" | "v", value: string) => {
      const problem = mapRowEditProblem(row, { ...row, [field]: value });
      if (problem) {
        setRowProblem({ id: row.id, msg: problem });
        return;
      }
      setRowProblem((p) => (p?.id === row.id ? null : p));
      mutate((rs) => rs.map((r) => (r.id === row.id ? { ...r, [field]: value } : r)));
    },
    [mutate],
  );

  const closeNow = useCallback(() => {
    if (saveTimer.current !== null) void flushSave(); // persist a debounced edit before hiding (flushSave cancels the timer itself)
    // Correct-on-close: run the current list over the word we seeded from the selection; if it
    // changed, replace the still-selected word in the source app with the result (see helper).
    const original = originalSelectionRef.current;
    const corrected = original && phaseRef.current === "ok" ? applyMap(original, rowsRef.current) : null;
    originalSelectionRef.current = null; // one-shot — don't re-correct on a later close
    void hideQuickAdd().catch((e) => console.error("quick-add hide failed:", e));
    if (original && corrected && corrected !== original && generalRef.current) {
      void replaceSelectionAfterClose(original, corrected, generalRef.current, appRulesRef.current).catch((e) =>
        console.error("correct-on-close paste failed:", e),
      );
    }
  }, [flushSave]);

  // An OS/WM close (Alt+F4 / compositor close) hides the window in Rust but bypasses the in-app
  // Esc/X path, so Rust emits quickadd://closing — run the same closeNow (flush a pending save +
  // correct-on-close). closeNow's own hideQuickAdd is a no-op since Rust already hid it.
  useTauriListener(() => subscribe("quickadd://closing", () => closeNow()), [closeNow]);

  // Esc closes the window from anywhere in it — not only when a text field is focused.
  // (Clicking empty space moves focus to <body>, an ancestor of the React root, so a
  // keydown there would never bubble through a root-div handler.) The Combobox stops
  // Esc only while its suggestions are showing, so the first Esc there only closes them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Mid-composition the IME owns Esc (cancel the half-typed text).
      if (imeComposing(e)) return;
      if (e.key === "Escape") closeNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeNow]);

  const dotHex = ruleDotColor(color);

  return (
    // The window is a transparent rectangle and CLIPS whatever is painted past its edge, so
    // the margin here must be at least the shadow's reach (offset + blur + spread) on each
    // side — otherwise the shadow ends in a hard, square-cornered cut instead of fading out.
    // Drop shadow 0/12/32/-12 reaches 32px down, 20px sideways, 8px up; the glow 0/0/32/-12
    // reaches 20px all round → 24px sides and top, 36px bottom. Change one and the other must
    // follow, plus the window size (quickadd.rs QA_W/QA_H + tauri.conf.json), which is the
    // 576×456 panel + this margin.
    <div className="flex h-screen w-screen bg-transparent px-6 pb-9 pt-6">
      <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_12px_32px_-12px_rgba(0,0,0,0.75),0_0_32px_-12px_color-mix(in_srgb,var(--c-accent)_20%,transparent)]">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Plus className="size-4 text-accent" />
          {dotHex && (
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotHex }} aria-hidden />
          )}
          <span className="truncate font-display text-[15px] font-semibold text-text">{label}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">quick add</span>
          <span className="ml-auto flex items-center gap-2">
            <SaveStatus state={saveState} reason={rejectReason} onRetry={() => void flushSave()} />
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
                void showMainAtScreen("dictionary").catch((e) =>
                  console.error("quick-add open dictionary failed:", e),
                );
                void hideQuickAdd().catch((e) => console.error("quick-add hide failed:", e));
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
            <div
              onKeyDown={(e) => {
                // Enter in the find field with no dropdown selection (not yet handled
                // by the Combobox) advances to the Insert field. Not mid-composition: the
                // IME's Enter commits the candidate.
                if (imeComposing(e)) return;
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
                  {/* The captions are sibling <label>s with no htmlFor, so they name nothing: each field
                      carries its own name, or a screen reader reads its placeholder ("comma, edit"). */}
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-faint">When you say</label>
                  <Combobox
                    key={showSeq}
                    value={find}
                    autoFocus
                    openOnFocus={openOnSummon}
                    suggestions={suggestions}
                    footerMax={recentMax}
                    placeholder="say a word…"
                    ariaLabel="When you say"
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
                    aria-label="Insert"
                    className="font-mono"
                    onChange={(e) => setInsert(e.target.value)}
                    onKeyDown={(e) => {
                      // The IME's Enter commits a candidate, not the mapping.
                      if (imeComposing(e)) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addMapping();
                      }
                    }}
                  />
                </div>
              </div>
              {addProblem && (
                <div role="status" className="mt-2 flex items-center gap-1.5 text-[11.5px] text-warn">
                  <AlertTriangle className="size-3.5 shrink-0" /> {addProblem}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-4 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-faint">
              <span>in this list</span>
              <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-dim">{rows.length}</span>
            </div>

            {/* mappings — inline-editable, newest-first */}
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
              {rows.length === 0 ? (
                <div className="px-2 py-8 text-center text-[13px] text-faint">No mappings yet — add your first above.</div>
              ) : (
                shownRows.map((row) => (
                  <Fragment key={row.id}>
                    <div className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-2/40">
                      <input
                        value={row.k}
                        aria-label="spoken phrase"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => editRow(row, "k", e.target.value)}
                        className="ring-signal min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[14px] text-text hover:bg-surface-2"
                      />
                      <span className="shrink-0 text-faint" aria-hidden>→</span>
                      <input
                        value={row.v}
                        aria-label="inserted text"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => editRow(row, "v", e.target.value)}
                        className="ring-signal w-[110px] shrink-0 rounded-md bg-transparent px-2 py-1 text-center font-mono text-[13px] text-text hover:bg-surface-2"
                      />
                      <button
                        type="button"
                        title="Remove mapping"
                        onClick={() => mutate((rs) => rs.filter((r) => r.id !== row.id))}
                        className="ring-signal grid size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 transition-opacity hover:text-warn group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    {(rowProblem?.id === row.id || twinProblems.has(row.id)) && (
                      <div role="status" className="flex items-center gap-1.5 px-4 pb-1 text-[11.5px] text-warn">
                        <AlertTriangle className="size-3.5 shrink-0" />{" "}
                        {rowProblem?.id === row.id ? rowProblem.msg : twinProblems.get(row.id)}
                      </div>
                    )}
                  </Fragment>
                ))
              )}
              {rows.length > shownRows.length && (
                <div className="px-2 py-3 text-center text-[12px] text-faint">
                  Showing the newest {MAX_SHOWN_ROWS} of {rows.length} — edit the rest in the Dictionary.
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-[12px] text-faint">
              <span className="flex items-center gap-1.5">
                <Kbd size="sm">↵</Kbd> save &amp; add another
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd size="sm">Esc</Kbd> done
              </span>
              <span className="ml-auto flex items-center gap-1.5 opacity-80">
                <Kbd size="sm">↑</Kbd>
                <Kbd size="sm">↓</Kbd> recent
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** After Quick-Add hides, wait for focus to return to the source app, confirm (via accessibility)
 *  that the SAME word is still selected, then paste the list-corrected version over it — correcting
 *  the word in place. Skips if the selection is gone or changed (the "check first" guard), or — on
 *  the typing method only — if its edges carry a line break that typing would turn into Enter.
 *  Paste replaces the active selection; the prior clipboard is restored afterwards when the
 *  resolved restore-clipboard setting says so — unless Rust diverts to the clipboard (focus moved,
 *  or untypeable text on Wayland), in which case the correction stays on the clipboard and the
 *  selection is left as it was. */
async function replaceSelectionAfterClose(
  original: string,
  corrected: string,
  general: GeneralSettings,
  appRules: AppRule[],
) {
  // Let the WM hand focus back to the source app. Windows gets extra headroom: there the
  // selection re-read TYPES a copy-chord into whatever is focused, so firing early doesn't
  // just miss — it silently drops the correction (unchanged clipboard reads as "gone").
  await new Promise((r) => setTimeout(r, IS_WINDOWS ? 400 : 250));
  // Focus is back on the source app now; read its selection AND identity together. A live selection
  // can sit in a NON-editable view (a read-only doc/web page) where a synthetic paste/type would
  // misfire; the resolver coerces those to clipboard-only.
  const [current, app] = await Promise.all([getFocusedSelection(), getFocusedApp()]);
  if (current == null) return;
  // No profile layer, deliberately: the correction is a Quick-Add action, not a dictation,
  // so it resolves app-rule ← global. Passing `undefined` states that rather than leaving
  // it to argument order.
  const { rule, method, pasteShortcut, restoreClipboard, remoteDesktop } = resolveInjectionTarget(app ?? null, appRules, general, undefined);
  if (rule?.block) return; // the user marked this app "never type into" — don't correct into it at all (not even clipboard)
  // The seed was trimmed Rust-side (sanitize_seed) but this live re-read is not, and the paste
  // replaces the WHOLE selection — so put back the edge whitespace it carries: the space a
  // double-click grabs (Word / browsers) and the line break a triple-click grabs. A paste /
  // clipboard route puts that back verbatim; only the typing method would turn an edge newline
  // into a real Enter, so there the edges are spaces/tabs only and anything else is a skip.
  const { lead, trail } = selectionEdges(current, method === "direct");
  if (current.slice(lead.length, Math.max(lead.length, current.length - trail.length)) !== original) {
    console.info("[quick-add] correct-on-close skipped: selection changed or edge line break on a typed route");
    return;
  }
  // The replacement text comes from the server's mapping list, and every typing path turns a
  // newline into a real Enter — which would SUBMIT whatever the corrected word landed in. A
  // word mapping is a single line by construction, so fold controls to spaces.
  const safe = corrected.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  // Same re-check as the dictation path: this one deliberately waits for the WM to hand focus
  // back before resolving, so focus can move again between that resolve and the keystrokes.
  const out = await injectText({
    text: lead + safe + trail,
    method,
    autoEnter: false,
    restoreClipboard,
    pasteShortcut,
    expectAppId: app?.appId ?? null,
    remoteDesktop,
  });
  // Neither outcome throws, so closeNow's catch never sees them — log them like the skips above.
  if (!out.landed) console.info("[quick-add] correct-on-close wrote nothing (our own window had focus, or the insert could not run — see the inject log)");
  else if (out.diverted) console.info("[quick-add] correct-on-close diverted: the correction is on the clipboard, the selection was not replaced");
}

function errTitle(f: PipelineFetch | null): string {
  switch (f?.status) {
    case -1:
      return "Couldn't load the configuration";
    case 0:
      return "Couldn't reach the server";
    case 401:
      return "This server needs a valid API key";
    case 403:
      return "Your account can't edit this list";
    case -2:
      return "List unavailable";
    case -3:
      return "List locked";
    case -4:
      return "List is read-only";
    case 404:
      return "This server doesn't support editable rules";
    default:
      return `Server error (HTTP ${f?.status ?? "?"})`;
  }
}
function errBody(f: PipelineFetch | null): string {
  // Mirrors Dictionary's describeFetchError: fixed 401/403/404 hints (the Rust side always fills `error` on a
  // non-2xx, so checking it first would hide them), otherwise the trimmed server text — a whitespace-only
  // proxy body falls through to the generic hint.
  switch (f?.status) {
    case 401:
      return "Set or fix the API key for this Backend on the Backends screen.";
    case 403:
      return "Ask an admin to grant your key access to the rules editor.";
    case 404:
      return "It's a standard Whisper server or an older faster-whisper-backend — update the server to use Quick-Add.";
    default:
      return f?.error?.trim() || "Check the server and the pinned list, then retry.";
  }
}
