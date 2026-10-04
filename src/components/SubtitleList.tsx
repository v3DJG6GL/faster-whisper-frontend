// The viewer's Subtitles view (D84 V3): the transcript as the subtitle cues an
// SRT/VTT export writes. Same timing = one table, a column per visible
// language; own timing (or a site track with its own timing) = one
// time-synced lane per language. Display only — corrections stay keyed to
// segments, so "Edit its segment" hands over to the Segments view.

import { memo, useMemo } from "react";
import { Pencil } from "lucide-react";
import { LangTag } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtTimestamp } from "@/lib/format";
import { safeDisplayText, stripControlChars } from "@/lib/sanitize";
import { lastStartedAt } from "@/lib/seekKeys";
import { cueTrackLang, limitsFor, trackCues, wrapLines, type CueGrid, type CueOptions } from "@/lib/cueSplit";
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

export function SubtitleList({
  result, grid, tracks, cues, curTime, canSeek, seekTo, onEditSegment, showNames, colorize, displayName, colorOf, maxRows,
}: {
  result: BatchResult;
  /** Memoized by the viewer on edits, options and tracks — never on curTime. */
  grid: CueGrid;
  /** Visible tracks: "orig" + translation codes + site track ids. */
  tracks: string[];
  /** Undefined = as transcribed (one cue per segment, unwrapped). */
  cues: CueOptions | undefined;
  curTime: number;
  canSeek: boolean;
  seekTo: (t: number) => void;
  onEditSegment: (seg: number) => void;
  showNames: boolean;
  colorize: boolean;
  displayName: (label: string) => string;
  colorOf: (label: string) => string;
  maxRows: number;
}) {
  const lanes = tracks.some((t) => grid.own[t]);
  const layout = useMemo(() => {
    const limitOf = (track: string) => (cues ? limitsFor(cues, cueTrackLang(result, track)) : null);
    const code = (track: string) => safeDisplayText(cueTrackLang(result, track) ?? "??", 16).toUpperCase();
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
      const rates = cols.map(([t, text]) => ({ t, rate: text.length / d, limit: limitOf(t)?.cps ?? 20 }));
      const worst = rates.reduce((a, b) => (b.rate - b.limit > a.rate - a.limit ? b : a));
      const fast = worst.rate > worst.limit;
      return {
        key, n, seg: c.seg, start: c.start, end: c.end, first,
        lines: cols.map(([t, text]) => lineOf(t, text, c.speaker, t === "orig")),
        cps: `${d.toFixed(1)} s · ${fast && cols.length > 1 ? `${code(worst.t)} ` : ""}${worst.rate.toFixed(fast ? 1 : 0)} chars/s`,
        fast,
        bar: Math.min(100, (d / maxDur) * 100),
      };
    };
    if (!lanes) {
      return {
        heads: tracks.map((t) => (t === "orig" ? `${code(t)} · original` : code(t))),
        rows: grid.cues.slice(0, maxRows).map((c, i) =>
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
          code: code(t),
          rows: list.slice(0, maxRows).map((c, i) =>
            rowOf(`${t}-${i}`, i + 1, c, li === 0 && (i === 0 || list[i - 1].seg !== c.seg), [[t, c.text]])),
        };
      }),
    };
  }, [result, grid, tracks, cues, lanes, maxRows, showNames, colorize, displayName, colorOf]);

  /** The cue under the playhead (binary search; a short grace after its end). */
  const activeIn = (rows: Row[]) => {
    const i = lastStartedAt(rows, curTime);
    return i >= 0 && curTime < rows[i].end + 0.3 ? i : -1;
  };

  if (!lanes) {
    const columns = `2.25rem 7.5rem ${layout.heads.map(() => "minmax(0,1fr)").join(" ")}`;
    const active = activeIn(layout.rows);
    return (
      <div className="flex flex-col gap-0.5">
        <div
          className="grid gap-3.5 px-2 pb-1 font-mono text-[10px] uppercase tracking-label text-faint"
          style={{ gridTemplateColumns: columns }}
        >
          <span>#</span>
          <span>time</span>
          {layout.heads.map((h) => <span key={h}>{h}</span>)}
        </div>
        {layout.rows.map((r, i) => (
          <CueRow key={r.key} row={r} active={i === active} columns={columns}
            canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-4">
      {layout.lanes.map((ln) => {
        const active = activeIn(ln.rows);
        return (
          <div key={ln.track} className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="mb-1 flex items-center gap-2 border-b border-line px-2 pb-1.5">
              <LangTag code={ln.code} orig={ln.track === "orig"} />
              <span className="text-[11.5px] text-faint">
                {ln.rows.length.toLocaleString()} subtitle{ln.rows.length === 1 ? "" : "s"}
              </span>
            </div>
            {ln.rows.map((r, i) => (
              <CueRow key={r.key} row={r} active={i === active} lane
                canSeek={canSeek} seekTo={seekTo} onEditSegment={onEditSegment} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
