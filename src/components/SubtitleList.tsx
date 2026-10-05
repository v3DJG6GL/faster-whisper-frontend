// The viewer's Subtitles view (D84 V3): the transcript as the subtitle cues an
// SRT/VTT export writes. Same timing = one table, a column per visible
// language; own timing (or a site track with its own timing) = one
// time-synced lane per language. Display only — corrections stay keyed to
// segments, so "Edit its segment" hands over to the Segments view.
// Rows are virtualized (@tanstack/react-virtual) against the viewer's
// transcript box: a long video's ~2000 cue rows cost WebKitGTK its frame rate
// in style/layout/paint alone, even with React idle.

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pencil } from "lucide-react";
import { LangTag } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtTimestamp, plural } from "@/lib/format";
import { trackChipLabel } from "@/lib/exportTracks";
import { stripControlChars } from "@/lib/sanitize";
import { lastStartedAt } from "@/lib/seekKeys";
import { rowsToRender } from "@/lib/virtualRows";
import {
  TRANSCRIBED_CPS, trackCues, trackLimits, wrapLines, type CueGrid, type CueOptions,
} from "@/lib/cueSplit";
import { trackCode } from "@/lib/exportTracks";
import type { BatchResult } from "@/lib/types";

interface Line {
  text: string;
  /** The original's line (full size); translations render dimmed. */
  main: boolean;
  color?: string;
}

interface Row {
  key: string;
  n: number;
  /** Source segment; -1 for a site track's own cue. */
  seg: number;
  start: number;
  end: number;
  /** First cue of its segment — carries the row id follow scrolls to. */
  first: boolean;
  lines: Line[];
  cps: string;
  fast: boolean;
  /** Duration as a share of the longest allowed subtitle (0–100). */
  bar: number;
}

/** One cue row, memoized: during playback only the rows entering and leaving
 *  the playhead re-render (the SegmentRow idiom). */
const CueRow = memo(function CueRow({
  row, active, columns, lane, canSeek, seekTo, onEditSegment,
}: {
  row: Row;
  active: boolean;
  /** Table mode: the grid template; lanes render a compact two-part row. */
  columns?: string;
  lane?: boolean;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
}) {
  const time = (
    <div className={cn("font-mono text-[10.5px] leading-relaxed tabular-nums", active ? "text-accent" : "text-faint")}>
      {fmtTimestamp(row.start)} → {fmtTimestamp(row.end)}
      {!lane && (
        <div className="mt-1 h-[3px] rounded-pill bg-line">
          <div className="h-full rounded-pill bg-accent" style={{ width: `${row.bar}%` }} />
        </div>
      )}
      <div className={cn("mt-0.5 text-[10px]", row.fast ? "text-warn" : "text-faint")}>{row.cps}</div>
    </div>
  );
  return (
    <div
      id={row.first ? `seg-row-${row.seg}` : undefined}
      onClick={canSeek ? () => seekTo(row.start) : undefined}
      className={cn(
        "group relative gap-3.5 rounded-lg px-2 py-2",
        lane ? "flex" : "grid",
        canSeek && "cursor-pointer hover:bg-surface-2/50",
        active && (lane ? "bg-surface-2 shadow-[inset_2px_0_0_var(--c-accent)]" : "bg-surface-2"),
      )}
      style={columns ? { gridTemplateColumns: columns } : undefined}
    >
      {!lane && (
        <span className={cn("pt-0.5 font-mono text-[11px] tabular-nums", active ? "text-accent" : "text-faint")}>{row.n}</span>
      )}
      <div className={lane ? "w-[7.5rem] shrink-0" : undefined}>{time}</div>
      {row.lines.map((l, k) => (
        <div
          key={k}
          className={cn("min-w-0 whitespace-pre-line", l.main ? "text-[14px] leading-snug text-text" : "text-[13px] leading-snug text-dim")}
          style={l.color ? { color: l.color } : undefined}
        >
          {l.text}
        </div>
      ))}
      {row.seg >= 0 && (
        <button
          type="button"
          title="Edit its segment"
          aria-label="Edit its segment"
          onClick={(e) => {
            e.stopPropagation();
            onEditSegment(row.seg);
          }}
          className="ring-signal absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md text-faint opacity-0 hover:bg-surface-2 hover:text-text focus:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
      )}
    </div>
  );
});

/** First guess at a row's height before it is measured: its padding plus the
 *  taller of the time block and its tallest explicitly wrapped text. */
const estimate = (r: Row, lane?: boolean) =>
  16 + Math.max(lane ? 36 : 43, 19 * Math.max(...r.lines.map((l) => l.text.split("\n").length)));

/** One virtualized column of cue rows (the table, or one lane) scrolling in
 *  the viewer's transcript box. `pin` = the row carrying the active segment's
 *  id — always rendered, at its virtual position. */
function VirtualCues({
  rows, active, pin, columns, lane, scrollRef, canSeek, seekTo, onEditSegment,
}: {
  rows: Row[];
  active: number;
  pin: number;
  columns?: string;
  lane?: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Where the rows start inside the box's scroll content (heads and focus
  // padding sit above them) — the virtualizer's scrollMargin. Re-measured
  // whenever the list's box changes (width, total height).
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const box = scrollRef.current;
      if (box) setMargin(Math.round(el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);
  // Keyed on the rows: a new layout (options, tracks, edits) re-runs the
  // positions with fresh estimates for the rows not measured yet.
  const getItemKey = useCallback((i: number) => rows[i].key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(rows[i], lane),
    overscan: 8,
    gap: 2,
    scrollMargin: margin,
  });
  // Lanes share one scroll box: a lane nudging scrollTop for its own
  // re-measured rows would shift its neighbours — let each lane settle alone.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = lane ? () => false : undefined;
  const range = virtualizer.getVirtualItems().map((v) => v.index);
  const items = rowsToRender(range, pin, rows.length).map((i) => virtualizer.measurementsCache[i]);
  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {items.map((v) => {
        const r = rows[v.index];
        return (
          <div
            key={r.key}
            ref={virtualizer.measureElement}
            data-index={v.index}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start - margin}px)` }}
          >
            <CueRow row={r} active={v.index === active} columns={columns} lane={lane}
              canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} />
          </div>
        );
      })}
    </div>
  );
}

/** Each column or lane readable (20rem) but no wider than a subtitle line wants (60ch),
 *  centred; when they don't fit, the transcript box scrolls sideways. `fixed` = the rest. */
const widths = (n: number, fixed: string) => ({
  minWidth: `calc(${fixed} + ${n} * 20rem)`,
  maxWidth: `calc(${fixed} + ${n} * 60ch)`,
});

export function SubtitleList({
  result, grid, tracks, cues, curTime, activeSeg, scrollRef, canSeek, seekTo, onEditSegment, showNames, colorize, displayName, colorOf,
}: {
  result: BatchResult;
  /** Memoized by the viewer on edits, options and tracks — never on curTime. */
  grid: CueGrid;
  /** Visible tracks: "orig" + translation codes + site track ids. */
  tracks: string[];
  /** Undefined = as transcribed (one cue per segment, unwrapped). */
  cues: CueOptions | undefined;
  curTime: number;
  /** The viewer's active segment: its first cue's row stays in the page. */
  activeSeg: number;
  /** The viewer's transcript box — the rows' scroll container. */
  scrollRef: RefObject<HTMLElement | null>;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
  showNames: boolean;
  colorize: boolean;
  displayName: (label: string) => string;
  colorOf: (label: string) => string;
}) {
  const lanes = tracks.some((t) => grid.own[t]);
  const layout = useMemo(() => {
    const limitOf = (track: string) => trackLimits(result, cues, track);
    const maxDur = limitOf("orig")?.maxDur ?? 7;
    /** One track's text of a cue: name prefix, wrapped to its limits. */
    const lineOf = (track: string, text: string, speaker: string | undefined, main: boolean): Line => {
      const prefix = showNames && speaker ? `${displayName(speaker)}: ` : "";
      const L = limitOf(track);
      const body = stripControlChars(text);
      return {
        text: prefix + (L ? wrapLines(body, L.cpl, L.lines, prefix.length).join("\n") : body),
        main,
        color: main && colorize && speaker ? colorOf(speaker) : undefined,
      };
    };
    const rowOf = (
      key: string, n: number, c: { seg: number; start: number; end: number; speaker?: string },
      first: boolean, cols: [track: string, text: string][],
    ): Row => {
      const d = Math.max(0.001, c.end - c.start);
      // The column reading fastest against its own language's limit.
      const rates = cols.map(([t, text]) => ({ t, rate: text.length / d, limit: limitOf(t)?.cps ?? TRANSCRIBED_CPS }));
      const worst = rates.reduce((a, b) => (b.rate - b.limit > a.rate - a.limit ? b : a));
      const fast = worst.rate > worst.limit;
      return {
        key, n, seg: c.seg, start: c.start, end: c.end, first,
        lines: cols.map(([t, text]) => lineOf(t, text, c.speaker, t === "orig")),
        cps: `${d.toFixed(1)} s · ${fast && cols.length > 1 ? `${trackCode(result, worst.t)} ` : ""}${worst.rate.toFixed(fast ? 1 : 0)} chars/s`,
        fast,
        bar: Math.min(100, (d / maxDur) * 100),
      };
    };
    if (!lanes) {
      return {
        heads: tracks.map((t) => trackChipLabel(result, t)),
        rows: grid.cues.map((c, i) =>
          rowOf(`${i}`, i + 1, c, i === 0 || grid.cues[i - 1].seg !== c.seg,
            tracks.map((t) => [t, t === "orig" ? c.text : (c.tr[t] ?? "")])),
        ),
        lanes: [],
      };
    }
    return {
      heads: [],
      rows: [],
      lanes: tracks.map((t, li) => {
        const list = t === "orig" ? grid.cues : trackCues(grid, t);
        return {
          track: t,
          code: trackChipLabel(result, t),
          rows: list.map((c, i) =>
            rowOf(`${t}-${i}`, i + 1, c, li === 0 && (i === 0 || list[i - 1].seg !== c.seg), [[t, c.text]])),
        };
      }),
    };
  }, [result, grid, tracks, cues, lanes, showNames, colorize, displayName, colorOf]);
  /** Segment → the row carrying its id (the table, or the first lane). */
  const firstOf = useMemo(() => {
    const m = new Map<number, number>();
    (lanes ? (layout.lanes[0]?.rows ?? []) : layout.rows).forEach((r, i) => r.first && m.set(r.seg, i));
    return m;
  }, [layout, lanes]);
  const pin = firstOf.get(activeSeg) ?? -1;

  /** The cue under the playhead (binary search; a short grace after its end). */
  const activeIn = (rows: Row[]) => {
    const i = lastStartedAt(rows, curTime);
    return i >= 0 && curTime < rows[i].end + 0.3 ? i : -1;
  };

  const columns = `2.25rem 7.5rem ${layout.heads.map(() => "minmax(0,1fr)").join(" ")}`;
  const n = lanes ? layout.lanes.length : layout.heads.length;
  return (
    // width 0 + min-width 100%: the box's width, with no say in the page's —
    // lanes wider than the box overflow it (it scrolls sideways) instead of
    // widening the card.
    <div className="w-0 min-w-full">
      {!lanes ? (
        <div className="mx-auto flex flex-col gap-0.5" style={widths(n, `${10.75 + 0.875 * (n + 1)}rem`)}>
          <div
            className="grid gap-3.5 px-2 pb-1 font-mono text-[10px] uppercase tracking-label text-faint"
            style={{ gridTemplateColumns: columns }}
          >
            <span>#</span>
            <span>time</span>
            {layout.heads.map((h, i) => <span key={i}>{h}</span>)}
          </div>
          <VirtualCues rows={layout.rows} active={activeIn(layout.rows)} pin={pin} columns={columns} scrollRef={scrollRef}
            canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} />
        </div>
      ) : (
        <div className="mx-auto flex gap-4" style={widths(n, `${n - 1}rem`)}>
          {layout.lanes.map((ln, li) => (
            <div key={ln.track} className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="mb-1 flex items-center gap-2 border-b border-line px-2 pb-1.5">
                <LangTag code={ln.code} orig={ln.track === "orig"} />
                <span className="text-[11.5px] text-faint">
                  {plural(ln.rows.length, "subtitle")}
                </span>
              </div>
              <VirtualCues rows={ln.rows} active={activeIn(ln.rows)} pin={li === 0 ? pin : -1} lane scrollRef={scrollRef}
                canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
