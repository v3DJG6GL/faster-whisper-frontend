// The viewer's Subtitles view (D84 V3): the transcript as the subtitle cues an
// SRT/VTT export writes. Same timing = one table, a column per visible
// language; own timing (or a site track with its own timing) = one
// time-synced lane per language. Display only — corrections stay keyed to
// segments, so "Edit its segment" hands over to the Segments view.
// Rows are virtualized (@tanstack/react-virtual) against the viewer's
// transcript box: a long video's ~2000 cue rows cost WebKitGTK its frame rate
// in style/layout/paint alone, even with React idle.

import {
  memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pencil } from "lucide-react";
import { LangTag } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtTimestamp, plural } from "@/lib/format";
import { trackChipLabel } from "@/lib/transcript/exportTracks";
import { hasOwn, ownProp } from "@/lib/own";
import { stripControlChars } from "@/lib/sanitize";
import { lastStartedAt } from "@/lib/seekKeys";
import { rowsToRender } from "@/lib/virtualRows";
import {
  TRANSCRIBED_CPS, timedTrack, trackLang, trackLimits, wrapLines,
  type CueGrid, type CueLimits, type CueOptions, type QuoteCtx,
} from "@/lib/transcript/cueSplit";
import { trackCode } from "@/lib/transcript/exportTracks";
import { clean, writesCue, writtenTrackCues } from "@/lib/transcript/transcriptFormats";
import type { BatchResult } from "@/lib/types";
import { useResizeObserver } from "@/lib/useResizeObserver";

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
  /** Placeholder clocks (a clock-less text source): no duration bar. */
  synth: boolean;
}

/** One cue row, memoized: during playback only the rows entering and leaving
 *  the playhead re-render (the SegmentRow idiom). */
const CueRow = memo(function CueRow({
  row, active, anchorId, columns, lane, canSeek, seekTo, onEditSegment, maxEditSeg,
}: {
  row: Row;
  active: boolean;
  /** Site-track-only lanes: the follow target id this row carries instead of
   *  its own (it has no segment). */
  anchorId?: string;
  /** Table mode: the grid template; lanes render a compact two-part row. */
  columns?: string;
  lane?: boolean;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
  /** Segments at or past this index aren't rendered by the Segments view's
   *  Edit list — no pencil there, it would land on a row that doesn't exist. */
  maxEditSeg?: number;
}) {
  const time = (
    <div className={cn("font-mono text-[10.5px] leading-relaxed tabular-nums", active ? "text-accent" : "text-faint")}>
      {fmtTimestamp(row.start)} → {fmtTimestamp(row.end)}
      {!lane && !row.synth && (
        <div className="mt-1 h-[3px] rounded-pill bg-line">
          <div className="h-full rounded-pill bg-accent" style={{ width: `${row.bar}%` }} />
        </div>
      )}
      <div className={cn("mt-0.5 text-[10px]", row.fast ? "text-warn" : "text-faint")}>{row.cps}</div>
    </div>
  );
  return (
    <div
      id={anchorId ?? (row.first && row.seg >= 0 ? `seg-row-${row.seg}` : undefined)}
      onClick={canSeek ? () => seekTo(row.start) : undefined}
      className={cn(
        "group relative gap-3.5 rounded-lg px-2 py-2",
        lane ? "flex" : "grid",
        // One background per state (cn is plain clsx): the hover wash would beat the active one.
        canSeek && (active ? "cursor-pointer" : "cursor-pointer hover:bg-surface-2/50"),
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
      {row.seg >= 0 && (maxEditSeg === undefined || row.seg < maxEditSeg) && (
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
 *  the viewer's transcript box. `pin` = the row follow looks up: the active
 *  segment's first cue, or (only site tracks shown) the cue under the
 *  playhead. Always rendered, at its virtual position. `anchorId` =
 *  TIME_ANCHOR_ID when the pin is chosen by time rather than by its own
 *  segment id. */
function VirtualCues({
  rows, active, pin, anchorId, columns, lane, scrollRef, canSeek, seekTo, onEditSegment, maxEditSeg,
}: {
  rows: Row[];
  active: number;
  pin: number;
  anchorId?: string;
  columns?: string;
  lane?: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
  maxEditSeg?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Where the rows start inside the box's scroll content (heads and focus
  // padding sit above them) — the virtualizer's scrollMargin. Re-measured
  // whenever the list's box changes (width, total height).
  const [margin, setMargin] = useState(0);
  useResizeObserver(listRef, (el) => {
    const box = scrollRef.current;
    if (box) setMargin(Math.round(el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop));
  });
  // Keyed on the rows, and a row's key carries its text: a new layout (options, tracks, edits)
  // re-estimates only the rows whose content changed — the same index never reuses another
  // row's measured height, and an unchanged row keeps its own.
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
            <CueRow row={r} active={v.index === active} anchorId={v.index === pin ? anchorId : undefined} columns={columns} lane={lane}
              canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} maxEditSeg={maxEditSeg} />
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

/** The cue under the playhead at `t` (binary search; a short grace after its end). */
const activeIn = (rows: Row[], t: number) => {
  const i = lastStartedAt(rows, t);
  return i >= 0 && t < rows[i].end + 0.3 ? i : -1;
};

/** The id the time-pinned cue carries when only site tracks show (see `onTimeAnchor`). */
export const TIME_ANCHOR_ID = "sub-time-anchor";

export const SubtitleList = memo(function SubtitleList({
  result, grid, tracks, cues, subscribePlayhead, getPlayhead, activeSeg, scrollRef, canSeek, seekTo, onEditSegment, maxEditSeg, showNames, colorize, displayName, colorOf,
  onTimeAnchor,
}: {
  result: BatchResult;
  /** Memoized by the viewer on edits, options and tracks — never on curTime. */
  grid: CueGrid;
  /** Visible tracks: "orig" + translation codes + site track ids. */
  tracks: string[];
  /** Undefined = as transcribed (one cue per segment, unwrapped). */
  cues: CueOptions | undefined;
  /** The viewer's per-frame playhead (not its ~4 Hz curTime): a listener per
   *  sample, and the current media time. */
  subscribePlayhead: (cb: () => void) => () => void;
  getPlayhead: () => number;
  /** The viewer's active segment: its first cue's row stays in the page. */
  activeSeg: number;
  /** The viewer's transcript box — the rows' scroll container. */
  scrollRef: RefObject<HTMLElement | null>;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
  /** The Edit view's row cap: segments from here on get no "Edit its segment". */
  maxEditSeg?: number;
  showNames: boolean;
  colorize: boolean;
  displayName: (label: string) => string;
  colorOf: (label: string) => string;
  /** Only site tracks shown: the index of the cue under the playhead (it carries
   *  TIME_ANCHOR_ID), so follow can track cues rather than segments; null otherwise. */
  onTimeAnchor?: (pin: number | null) => void;
}) {
  const lanes = tracks.some((t) => hasOwn(grid.own, t));
  const layout = useMemo(() => {
    // Per track, once per layout: every cue column asks for the same limits.
    const limCache = new Map<string, CueLimits | null>();
    const limitOf = (track: string) => {
      if (!limCache.has(track)) limCache.set(track, trackLimits(result, cues, track));
      return limCache.get(track)!;
    };
    const maxDur = limitOf("orig")?.maxDur ?? 7;
    /** One track's text of a cue: name prefix, wrapped to its limits (`q` = the quotes of its
     *  segment around it, as the export wraps it). */
    const lineOf = (track: string, text: string, speaker: string | undefined, main: boolean, q?: QuoteCtx): Line => {
      // Cleaned as the export cleans it: a line break inside the text is one line there too.
      const body = clean(text);
      // No name on an empty cell: the export writes none there either.
      const prefix = showNames && speaker && body.trim() ? `${displayName(speaker)}: ` : "";
      const L = limitOf(track);
      return {
        text: prefix + (L ? wrapLines(body, L.cpl, L.lines, prefix.length, q, trackLang(result, track)).join("\n") : body),
        main,
        color: main && colorize && speaker ? colorOf(speaker) : undefined,
      };
    };
    const rowOf = (
      key: string, n: number, c: { seg: number; start: number; end: number; speaker?: string },
      first: boolean, cols: [track: string, text: string, q?: QuoteCtx][],
    ): Row => {
      const span = c.end - c.start;
      const d = Math.max(0.001, span);
      // The column reading fastest against its own language's limit. A cell that cleans to nothing
      // is never written, and a cue with no duration has nothing to read in: neither has a reading
      // speed (both skipped by cpsWarnings in the export Summary).
      const rates = cols.map(([t, text]) => ({
        t, rate: span > 0 && stripControlChars(text).trim() ? text.length / d : 0, limit: limitOf(t)?.cps ?? TRANSCRIBED_CPS,
      }));
      const worst = rates.reduce((a, b) => (b.rate - b.limit > a.rate - a.limit ? b : a));
      // Synthesized clocks (a clock-less text source) are placeholders, not
      // timing — no reading speed to judge, as the export panel says too.
      const synth = !!result.timingSynthesized;
      const fast = !synth && worst.rate > worst.limit;
      const lines = cols.map(([t, text, q]) => lineOf(t, text, c.speaker, t === "orig", q));
      const cps = synth ? "no timing" : span <= 0 ? "0.0 s · no duration" : `${d.toFixed(1)} s · ${fast && cols.length > 1 ? `${trackCode(result, worst.t)} ` : ""}${worst.rate.toFixed(fast ? 1 : 0)} chars/s`;
      return {
        // The key carries what sets the row's height (its lines, the bar, the rate line), so a
        // measured height is reused only while it still describes this content.
        key: `${key}|${synth ? 1 : 0}|${cps}|${lines.map((l) => l.text).join("\u241E")}`,
        n, seg: c.seg, start: c.start, end: c.end, first,
        lines,
        cps,
        fast,
        bar: synth ? 0 : Math.min(100, (d / maxDur) * 100),
        synth,
      };
    };
    if (!lanes) {
      // The cues the export writes (writesCue): translations alone skip a cue no picked
      // translation cleans to a line (untranslated, or format characters only) — an original
      // line, even blank, keeps it.
      const kept = grid.cues.flatMap((c, i) => {
        if (!writesCue(c, tracks)) return [];
        const cols = tracks.map((t): [string, string, QuoteCtx?] =>
          [t, t === "orig" ? c.text : (ownProp(c.tr, t) ?? ""), t === "orig" ? c.q : ownProp(c.trq, t)]);
        return [{ c, i, cols }];
      });
      return {
        heads: tracks.map((t) => trackChipLabel(result, t)),
        rows: kept.map(({ c, i, cols }, k) =>
          rowOf(`${i}`, k + 1, c, k === 0 || kept[k - 1].c.seg !== c.seg, cols)),
        lanes: [],
        idLane: 0,
      };
    }
    // The lane carrying the segments' row ids. The original lane covers every
    // segment; a translation lane can have gaps (untranslated or kept-original
    // segments) and a site track has none (seg -1), and a dragged order can put
    // either first — so prefer the original, else the first segment-keyed lane.
    const oi = tracks.indexOf("orig");
    const idLane = oi >= 0 ? oi : Math.max(0, tracks.findIndex((t) => !timedTrack(result, t)));
    return {
      heads: [],
      rows: [],
      idLane,
      lanes: tracks.map((t, li) => {
        // A translation or site lane lists what its file writes: a cue that cleans to nothing
        // (blank, or format characters only) is dropped there, so it is no row here either.
        const list = t === "orig" ? grid.cues : writtenTrackCues(grid, t);
        return {
          track: t,
          code: trackChipLabel(result, t),
          rows: list.map((c, i) =>
            rowOf(`${t}-${i}`, i + 1, c, li === idLane && (i === 0 || list[i - 1].seg !== c.seg), [[t, c.text, c.q]])),
        };
      }),
    };
  }, [result, grid, tracks, cues, lanes, showNames, colorize, displayName, colorOf]);
  /** Segment → the row carrying its id (the table, or the segment-keyed lane). */
  const firstOf = useMemo(() => {
    const m = new Map<number, number>();
    (lanes ? (layout.lanes[layout.idLane]?.rows ?? []) : layout.rows).forEach((r, i) => r.first && m.set(r.seg, i));
    return m;
  }, [layout, lanes]);
  // Only site tracks shown: no lane is keyed to segments, so no row carries a
  // segment id for follow to find. The idLane cue under the playhead carries
  // TIME_ANCHOR_ID instead (no end grace: a gap between site cues still anchors
  // the one before it), and the viewer follows it cue by cue — a segment can
  // span several site cues, and the playhead can sit between segments.
  const segKeyed = !lanes || tracks.some((t) => t === "orig" || !timedTrack(result, t));
  // The playhead's cue state — the time pin and each list's active row — read from
  // the per-frame clock as a key that changes only when a cue boundary is crossed,
  // so this list re-renders at cue changes, not every frame.
  const lists = useMemo(() => (lanes ? layout.lanes.map((ln) => ln.rows) : [layout.rows]), [layout, lanes]);
  const playKey = useCallback(() => {
    const t = getPlayhead();
    const timeRow = segKeyed ? -1 : lastStartedAt(layout.lanes[layout.idLane]?.rows ?? [], t);
    return `${timeRow}:${lists.map((rows) => activeIn(rows, t)).join(",")}`;
  }, [getPlayhead, segKeyed, layout, lists]);
  const [timeRow, ...actives] = useSyncExternalStore(subscribePlayhead, playKey).split(/[:,]/).map(Number);
  const pin = segKeyed ? (firstOf.get(activeSeg) ?? -1) : timeRow;
  const anchorId = segKeyed ? undefined : TIME_ANCHOR_ID;
  const timePin = segKeyed || pin < 0 ? null : pin;
  useEffect(() => { onTimeAnchor?.(timePin); }, [onTimeAnchor, timePin]);
  useEffect(() => () => onTimeAnchor?.(null), [onTimeAnchor]);

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
          <VirtualCues rows={layout.rows} active={actives[0]} pin={pin} columns={columns} scrollRef={scrollRef}
            canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} maxEditSeg={maxEditSeg} />
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
              <VirtualCues rows={ln.rows} active={actives[li]} pin={li === layout.idLane ? pin : -1}
                anchorId={li === layout.idLane ? anchorId : undefined} lane scrollRef={scrollRef}
                canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} maxEditSeg={maxEditSeg} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
