// The Logs screen: live tail of the Rust log ring with follow/scroll-lock,
// level threshold + subsystem chips + text filter, and the support utilities
// (Copy for bug report / Open log folder / Clear view).
//
// Layout follows the TranscriptViewer focus-mode shape: fixed header+toolbar,
// the list is the one scrolling box (<main> scrolling stays unused here).
// Lines are virtualized (@tanstack/react-virtual) — the DOM never holds the
// full 10k-line buffer — and live OUTSIDE the store (see lib/logs.ts).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Check, ChevronRight, Copy, Eraser, FolderOpen } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn";
import { useApp } from "@/lib/store";
import { appVersion, openLogFolder, type LogLine } from "@/lib/api";
import {
  LOG_BUFFER_CAP,
  attachLogStream,
  clearView,
  markLogsViewed,
  takePrefilter,
  useLogs,
  visibleLines, clearedCount } from "@/lib/logs";
import {
  buildBugReport,
  collectTags,
  foldDropped,
  foldLines,
  followReduce,
  makeLogFilter,
  type FoldedLine,
  type FollowState,
  type LevelThreshold, bugReportRunFields, countNewer } from "@/lib/logFilter";
import { loadHistory, useTranscriptHistory } from "@/lib/transcriptHistory";
import { safeDisplayText, stripControlChars } from "@/lib/sanitize";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { Button, Segmented, StatusDot, TextInput, Toggle } from "@/components/ui";

const LEVEL_OPTIONS: { value: LevelThreshold; label: string }[] = [
  { value: "all", label: "All" },
  { value: "info", label: "Info+" },
  { value: "warn", label: "Warn+" },
  { value: "error", label: "Errors" },
];

function levelClasses(level: LogLine["level"]): string {
  switch (level) {
    case "error":
      return "text-rec";
    case "warn":
      return "text-warn";
    case "debug":
    case "trace":
      return "text-faint";
    default:
      return "text-dim";
  }
}

function rowTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** "1.70 s" / "480 ms" — how long a merged run took, which is the burst rate
 *  the fold otherwise hides. */
function spanText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** The cells of one log line. Shared by the row itself and, when a merged row
 *  is expanded, by each earlier occurrence underneath it. */
function LineCells({ l, wrap, chip }: { l: LogLine; wrap: boolean; chip?: ReactNode }) {
  return (
    <>
      <span className="w-[86px] shrink-0 tabular-nums text-faint">{rowTime(l.ts)}</span>
      <span className={cn("w-[44px] shrink-0 font-semibold uppercase", levelClasses(l.level))}>
        {l.level}
      </span>
      {l.tag && <span className="shrink-0 text-accent/85">[{safeDisplayText(l.tag, 24)}]</span>}
      {chip}
      <span
        className={cn(
          "min-w-0",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          l.level === "error" ? "text-rec" : l.level === "warn" ? "text-warn" : "text-text/85",
          (l.level === "debug" || l.level === "trace") && "text-faint",
        )}
      >
        {stripControlChars(l.msg)}
      </span>
    </>
  );
}

const LINE_ROW = "flex select-text gap-3 px-2 py-[2px] font-mono text-[12px] leading-[1.55]";

/** One virtualized row: the (possibly merged) line, plus — when its ×N chip is
 *  expanded — the run's earlier occurrences. The expansion renders INSIDE the
 *  measured row element, so the virtualizer picks up the height change itself
 *  and the row count never moves. */
function LogRow({ r, wrap, open, onToggle }: {
  r: FoldedLine;
  wrap: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const l = r.line;
  const err = l.level === "error";
  const dropped = foldDropped(r);
  return (
    <>
      <div className={cn(LINE_ROW, "hover:bg-accent-soft/50", err && "border-l-2 border-rec bg-rec/5 pl-[6px]")}>
        <LineCells
          l={l}
          wrap={wrap}
          chip={
            r.count > 1 ? (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                title={`Repeated ${r.count}× over ${spanText(l.ts - r.firstTs)} — ${open ? "hide" : "show"} each one`}
                className="ring-signal flex shrink-0 select-none items-center gap-0.5 self-start rounded-pill bg-accent-soft py-px pl-0.5 pr-1.5 font-semibold tabular-nums text-accent transition-colors hover:bg-accent/25"
              >
                <ChevronRight
                  className={cn("size-3 transition-transform", open && "rotate-90")}
                  aria-hidden
                />
                ×{r.count}
              </button>
            ) : undefined
          }
        />
      </div>
      {open && r.count > 1 && (
        <div className="border-l-2 border-accent-soft bg-accent/[0.04] pl-1">
          {r.earlier.map((e) => (
            <div key={e.seq} className={cn(LINE_ROW, "opacity-80")}>
              <LineCells l={e} wrap={wrap} />
            </div>
          ))}
          <div className="px-2 pb-1 pl-[98px] font-mono text-[10.5px] text-faint">
            {r.count} in {spanText(l.ts - r.firstTs)} · first {rowTime(r.firstTs)}
            {dropped > 0 && ` · ${dropped.toLocaleString()} more not kept — turn off Merge repeats to see every line`}
          </div>
        </div>
      )}
    </>
  );
}

export default function Logs() {
  const version = useLogs((s) => s.version);
  const [threshold, setThreshold] = useState<LevelThreshold>("all");
  // The doorway's "View logs" pre-filter, consumed in an effect keyed on the store value:
  // reading it in the useState initializer only worked on MOUNT, so a click while already
  // on /logs (the banner is app-wide) changed nothing and left the flag armed for the next
  // unrelated visit — and StrictMode's double-invoked initializer consumed it in dev.
  const prefilter = useLogs((s) => s.prefilter);
  useEffect(() => {
    if (!prefilter) return;
    setThreshold(prefilter);
    takePrefilter();
  }, [prefilter]);
  const [tags, setTags] = useState<ReadonlySet<string>>(new Set());
  const [text, setText] = useState("");
  const [wrap, setWrap] = useState(true);
  const [merge, setMerge] = useState(true);
  // Which merged runs are unfolded, keyed by the run's FIRST seq — stable while
  // the run keeps growing (the row's own `line.seq` is not).
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Clear a still-pending "Copied" timer if the screen unmounts mid-window.
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);
  const [follow, setFollow] = useState<FollowState>({ follow: true, pendingNew: 0 });

  // Attach the stream for the screen's lifetime; badge clears on open & close.
  useEffect(() => {
    markLogsViewed();
    // The bug-report header names the last recorded run; a launch straight into Logs (a
    // failure doorway's own destination) has not loaded history yet. Idempotent.
    void loadHistory();
    let detach: (() => void) | undefined;
    let cancelled = false;
    void attachLogStream()
      .then((d) => {
        if (cancelled) d();
        else detach = d;
      })
      .catch(() => {}); // attach rolled itself back; nothing to detach
    return () => {
      cancelled = true;
      detach?.();
      markLogsViewed();
    };
  }, []);

  const all = visibleLines();
  // `version` is bumped by every append and by Clear view — the only writes to
  // the ring or the clear floor — so the full-buffer scan need not repeat per keystroke.
  const cleared = useMemo(() => clearedCount(), [version]);
  // Union with the SELECTED tags: a tag whose lines have left the buffer (Clear view,
  // roll-over) still filters, so its chip must stay on-screen to be switchable off.
  const chips = useMemo(() => [...new Set([...collectTags(all), ...tags])], [all, tags]);
  const lines = useMemo(
    () => all.filter(makeLogFilter(threshold, tags, text)),
    [all, threshold, tags, text],
  );
  const rows = useMemo(
    () =>
      merge
        ? foldLines(lines)
        : lines.map((l) => ({ line: l, count: 1, firstTs: l.ts, firstSeq: l.seq, earlier: [] })),
    [lines, merge],
  );
  // What the bug report header records about the copied subset (null = the
  // view is unfiltered, so the paste IS the session tail).
  const filterSummary = useMemo(() => {
    const parts = [
      threshold !== "all" ? `${threshold}+` : null,
      tags.size ? `tags: ${[...tags].join(", ")}` : null,
      text.trim() ? `text: ${text.trim()}` : null,
      // "Clear view" hides earlier lines from the report too; without this line the
      // header claimed the paste WAS the session tail.
      cleared > 0 ? `${cleared.toLocaleString()} earlier lines cleared from view` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }, [threshold, tags, text, cleared]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 10,
    // Height measurements must follow the LINE, not the list position —
    // filters/clear shift which line sits at an index, and a stale by-index
    // height makes wrapped rows overlap their neighbors.
    // Keyed on the run's FIRST seq, not `line.seq`: a merged row's `line` is its newest
    // occurrence and changes on every repeat, which remounted the row (dropping focus from
    // its ×N button) and invalidated its measured height on every live duplicate.
    getItemKey: (index) => rows[index].firstSeq,
  });

  // Follow: on new content, keep the tail pinned (after paint — wrapped rows
  // re-measure); when unlatched, count what arrived for the pill.
  // Counted by seq watermark, not by length: a loosened filter grew the array without
  // anything arriving, and at buffer cap each batch evicted as many lines as it added.
  const prevSeq = useRef(-1);
  useEffect(() => {
    const last = lines.length ? lines[lines.length - 1].seq : -1;
    const added = prevSeq.current < 0 ? 0 : countNewer(lines, prevSeq.current);
    prevSeq.current = Math.max(prevSeq.current, last);
    if (follow.follow) {
      if (rows.length > 0) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
        });
      }
    } else if (added > 0) {
      setFollow((f) => followReduce(f, { kind: "appended", count: added }));
    }
    // `rows` and not just `lines`: the merge toggle changes the row count (and
    // so where the tail is) without changing `lines`, and the tail must re-pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, lines, rows, follow.follow]);

  // Wrap toggles every row's height at once — drop all cached measurements.
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap]);

  // Turning merging off dissolves the runs the expansions belong to; keeping
  // the set would silently re-open rows on the way back.
  useEffect(() => {
    setExpanded((s) => (s.size === 0 ? s : new Set()));
  }, [merge]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    setFollow((f) =>
      f.follow === atBottom ? f : followReduce(f, { kind: "scrolled", atBottom }),
    );
  }

  function relatch() {
    setFollow((f) => followReduce(f, { kind: "relatch" }));
    virtualizer.scrollToIndex(Math.max(0, rows.length - 1), { align: "end" });
  }

  async function copyBugReport() {
    const ver = (await appVersion().catch(() => "")) || "?";
    const platform = IS_LINUX ? "linux" : IS_WINDOWS ? "windows" : "unknown";
    // Read once at click time — a subscribing selector returning a fresh
    // object each render trips useSyncExternalStore's infinite-loop guard.
    const s = useApp.getState();
    const t = s.settings.transcribe;
    // The most recent run, which is what a bug report is almost always about.
    // The header used to read the TRANSCRIBE SCREEN's configured backend and
    // model even for a dictation bug — so it confidently named a model that
    // never ran, and a reader had no way to tell. A history record is the
    // only durable account of what actually executed.
    const last = useTranscriptHistory.getState().records[0] ?? null;
    const backendOf = (id?: string) => s.backends.find((b) => b.id === id)?.name ?? null;
    const report = buildBugReport(
      {
        appVersion: ver,
        platform,
        // One block, one source: the run's own fields, or the settings labelled as such.
        ...bugReportRunFields(last, t, backendOf),
        filters: filterSummary,
      },
      // Exactly what the view shows: copying a filtered log must not silently
      // paste the whole session (the header records the filters, so a reader
      // knows the paste is a subset).
      lines,
    );
    // The clipboard is the only thing this report has: a rejected write (denied
    // permission, unfocused webview) must not leave the button saying nothing,
    // or the user pastes whatever was on the clipboard before into a bug report.
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(report);
    } catch (e) {
      console.error("bug report copy failed:", e);
      setCopyError(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyError(false), 1600);
      return;
    }
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] pt-10">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-[24px] font-bold text-text">Logs</h1>
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-live">
          <StatusDot tone="live" pulse title="Streaming" /> Streaming
        </span>
        <span className="ml-auto font-mono text-[12px] tabular-nums text-faint">
          {(all.length + cleared).toLocaleString()} lines this session
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-line pb-3">
        <Segmented value={threshold} onChange={setThreshold} options={LEVEL_OPTIONS} ariaLabel="Log level filter" />
        {chips.map((tag) => {
          const on = tags.has(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setTags((prev) => {
                  const next = new Set(prev);
                  if (on) next.delete(tag);
                  else next.add(tag);
                  return next;
                })
              }
              className={cn(
                "ring-signal rounded-pill border px-2.5 py-1 font-mono text-[11px] transition-colors",
                on
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line-strong text-dim hover:text-text",
              )}
            >
              {safeDisplayText(tag, 24)}
            </button>
          );
        })}
        <TextInput
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter lines…"
          aria-label="Filter lines"
          className="h-8 w-auto min-w-[140px] flex-1 text-[12px]"
        />
        <label
          className="flex items-center gap-2 text-[12px] text-dim"
          title="Collapse runs of identical lines into one row wearing the NEWEST timestamp. Click a ×N chip to see each occurrence."
        >
          Merge repeats
          <Toggle checked={merge} onChange={setMerge} ariaLabel="Merge repeated lines" />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-dim">
          Wrap
          <Toggle checked={wrap} onChange={setWrap} ariaLabel="Wrap long lines" />
        </label>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn("h-full overflow-y-auto py-2", !wrap && "overflow-x-auto")}
        >
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
              <span className="text-[13.5px] font-medium text-dim">
                {all.length === 0 ? "Nothing logged yet this session" : "No lines match the filters"}
              </span>
              <span className="max-w-[380px] text-[12.5px] text-faint">
                {all.length === 0
                  ? "Lines appear here as you dictate or transcribe. Earlier sessions live in the log folder."
                  : "Loosen the level, tags, or text filter to see more."}
              </span>
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((v) => {
                const r = rows[v.index];
                return (
                  <div
                    key={r.firstSeq}
                    ref={virtualizer.measureElement}
                    data-index={v.index}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
                  >
                    <LogRow
                      r={r}
                      wrap={wrap}
                      open={expanded.has(r.firstSeq)}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (!next.delete(r.firstSeq)) next.add(r.firstSeq);
                          return next;
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!follow.follow && follow.pendingNew > 0 && (
          <button
            type="button"
            onClick={relatch}
            className="ring-signal absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-pill bg-accent px-4 py-1.5 text-[12px] font-bold text-accent-ink shadow-lg"
          >
            {follow.pendingNew.toLocaleString()} new {follow.pendingNew === 1 ? "line" : "lines"}
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line py-3">
        <Button variant="accent" size="sm" onClick={() => void copyBugReport()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copyError ? "Copy failed" : copied ? "Copied" : "Copy for bug report"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void openLogFolder(useApp.getState().settings.logging?.logDir ?? null).catch(() => {})
          }
        >
          <FolderOpen className="h-3.5 w-3.5" /> Open log folder
        </Button>
        <Button variant="ghost" size="sm" onClick={clearView}>
          <Eraser className="h-3.5 w-3.5" /> Clear view
        </Button>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
          buffer {(all.length + cleared).toLocaleString()} / {LOG_BUFFER_CAP.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
