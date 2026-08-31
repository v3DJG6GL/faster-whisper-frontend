// The Logs screen: live tail of the Rust log ring with follow/scroll-lock,
// level threshold + subsystem chips + text filter, and the support utilities
// (Copy for bug report / Open log folder / Clear view).
//
// Layout follows the TranscriptViewer focus-mode shape: fixed header+toolbar,
// the list is the one scrolling box (<main> scrolling stays unused here).
// Lines are virtualized (@tanstack/react-virtual) — the DOM never holds the
// full 10k-line buffer — and live OUTSIDE the store (see lib/logs.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Check, Copy, Eraser, FolderOpen } from "lucide-react";
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
  visibleLines,
} from "@/lib/logs";
import {
  buildBugReport,
  collectTags,
  foldLines,
  followReduce,
  matchesFilters,
  type FollowState,
  type LevelThreshold,
} from "@/lib/logFilter";
import { useTranscriptHistory } from "@/lib/transcriptHistory";
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

export default function Logs() {
  const version = useLogs((s) => s.version);
  const [threshold, setThreshold] = useState<LevelThreshold>(() => takePrefilter() ?? "all");
  const [tags, setTags] = useState<ReadonlySet<string>>(new Set());
  const [text, setText] = useState("");
  const [wrap, setWrap] = useState(true);
  const [merge, setMerge] = useState(true);
  const [copied, setCopied] = useState(false);
  const [follow, setFollow] = useState<FollowState>({ follow: true, pendingNew: 0 });

  // Attach the stream for the screen's lifetime; badge clears on open & close.
  useEffect(() => {
    markLogsViewed();
    let detach: (() => void) | undefined;
    let cancelled = false;
    void attachLogStream().then((d) => {
      if (cancelled) d();
      else detach = d;
    });
    return () => {
      cancelled = true;
      detach?.();
      markLogsViewed();
    };
  }, []);

  const all = visibleLines();
  const chips = useMemo(() => collectTags(all), [all]);
  const lines = useMemo(
    () => all.filter((l) => matchesFilters(l, threshold, tags, text)),
    [all, threshold, tags, text],
  );
  const rows = useMemo(
    () =>
      merge
        ? foldLines(lines)
        : lines.map((l) => ({ line: l, count: 1, firstTs: l.ts })),
    [lines, merge],
  );
  // What the bug report header records about the copied subset (null = the
  // view is unfiltered, so the paste IS the session tail).
  const filterSummary = useMemo(() => {
    const parts = [
      threshold !== "all" ? `${threshold}+` : null,
      tags.size ? `tags: ${[...tags].join(", ")}` : null,
      text.trim() ? `text: ${text.trim()}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }, [threshold, tags, text]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 10,
    // Height measurements must follow the LINE, not the list position —
    // filters/clear shift which line sits at an index, and a stale by-index
    // height makes wrapped rows overlap their neighbors.
    getItemKey: (index) => rows[index].line.seq,
  });

  // Follow: on new content, keep the tail pinned (after paint — wrapped rows
  // re-measure); when unlatched, count what arrived for the pill.
  const prevCount = useRef(0);
  useEffect(() => {
    const added = Math.max(0, lines.length - prevCount.current);
    prevCount.current = lines.length;
    if (follow.follow) {
      if (rows.length > 0) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
        });
      }
    } else if (added > 0) {
      setFollow((f) => followReduce(f, { kind: "appended", count: added }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, lines.length, follow.follow]);

  // Wrap toggles every row's height at once — drop all cached measurements.
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap]);

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
        source: last ? (last.kind ?? "file") : null,
        backend: backendOf(last?.backendId ?? t?.backendId) ?? null,
        model: last?.model ?? t?.model ?? null,
        profile:
          last?.profileName ??
          s.profiles.find((p) => p.id === s.settings.homeProfileId)?.name ??
          s.profiles.find((p) => p.enabled)?.name ??
          null,
        route: last?.translationTargets?.length
          ? `${last.language || "auto"} → ${last.translationTargets.join(",")}`
          : null,
        // Name the stages that ran. "The French came out wrong" is
        // unactionable without knowing translation happened at all.
        stages:
          [
            last?.translationTargets?.length ? "translate" : null,
            last?.insertMethod && last.insertMethod !== "none"
              ? `insert:${last.insertMethod}`
              : null,
            last?.translationFailure ? `translate-failed:${last.translationFailure}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        filters: filterSummary,
      },
      // Exactly what the view shows: copying a filtered log must not silently
      // paste the whole session (the header records the filters, so a reader
      // knows the paste is a subset).
      lines,
    );
    await navigator.clipboard.writeText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="flex h-full flex-col px-10 pt-10">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-[24px] font-bold text-text">Logs</h1>
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-live">
          <StatusDot tone="live" pulse title="Streaming" /> Streaming
        </span>
        <span className="ml-auto font-mono text-[12px] tabular-nums text-faint">
          {all.length.toLocaleString()} lines this session
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
        <label className="flex items-center gap-2 text-[12px] text-dim">
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
                const l = r.line;
                return (
                  <div
                    key={l.seq}
                    ref={virtualizer.measureElement}
                    data-index={v.index}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
                    className={cn(
                      "flex select-text gap-3 px-2 py-[2px] font-mono text-[12px] leading-[1.55] hover:bg-accent-soft/50",
                      l.level === "error" && "border-l-2 border-rec bg-rec/5 pl-[6px]",
                    )}
                  >
                    <span className="w-[86px] shrink-0 tabular-nums text-faint">{rowTime(l.ts)}</span>
                    <span className={cn("w-[44px] shrink-0 font-semibold uppercase", levelClasses(l.level))}>
                      {l.level}
                    </span>
                    {l.tag && (
                      <span className="shrink-0 text-accent/85">[{safeDisplayText(l.tag, 24)}]</span>
                    )}
                    {r.count > 1 && (
                      <span
                        title={`Repeated ${r.count}× since ${rowTime(r.firstTs)}`}
                        className="shrink-0 self-start rounded-pill bg-accent-soft px-1.5 font-semibold tabular-nums text-accent"
                      >
                        ×{r.count}
                      </span>
                    )}
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
          {copied ? "Copied" : "Copy for bug report"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openLogFolder()}>
          <FolderOpen className="h-3.5 w-3.5" /> Open log folder
        </Button>
        <Button variant="ghost" size="sm" onClick={clearView}>
          <Eraser className="h-3.5 w-3.5" /> Clear view
        </Button>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
          buffer {all.length.toLocaleString()} / {LOG_BUFFER_CAP.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
