import {
  useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtFull, fmtDateFull } from "@/lib/format";
import {
  KIND_LABEL, METRIC_LABEL, QUARTER_NAME, rhythmModel, sumKinds, companionMetric, RHYTHMS, DOW_LONG,
  type Rhythm, type ChartMetric, type UsageScope, ordinal,
} from "@/lib/usageDerive";
import type { UsageSeriesPoint, UsageStats } from "@/lib/types";
import { KindTip } from "@/components/stats/StackedChart";
import { metricText } from "@/components/stats/chartKit";
import { CellTip, LevelLegend } from "@/components/stats/heatGrid";
import { CELL_HOT, CELL_HOVER, LEVEL_BG, cellOf, useCellTip, useRovingGrid } from "@/components/stats/heatGridKit";
import { Panel } from "@/components/stats/primitives";

/** The rule behind the busy phrase, per rhythm, as lib/usageDerive.ts rhythmPhrase applies it. */
function phraseRule(rhythm: Rhythm, measure: string): string {
  if (rhythm === "months") return `the top month holding 40 %+, else the top two holding 50 %+ of the ${measure}`;
  if (rhythm === "hours") return `one slot holding 50 %+, else the smallest group holding 60 %+ of the ${measure}`;
  return `the smallest group holding 60 %+ of the ${measure}`;
}

/** The busy panel: one grid, three rhythms — weekday × hour, day of month × hour (the
 *  backend's geometry), year × month — for the page's measure, with side bars against a flat
 *  distribution, a peak line and per-kind tooltips that pair the measure with its companion
 *  (sessions, or processing time when sessions is the measure). The rhythm is the panel's own
 *  state (`?rhythm=`): it changes this panel, the measure changes every panel. */
export function BusyPanel({ stats, dense, scope, title, metric, rhythm, onRhythm, from, to, bounded = true }: {
  stats: UsageStats;
  dense: readonly UsageSeriesPoint[];
  scope: UsageScope;
  title: string;
  metric: ChartMetric;
  rhythm: Rhythm;
  onRhythm: (r: Rhythm) => void;
  from: number;
  to: number;
  /** `from`..`to` is the real window, not the all-time stand-in (see rhythmModel). */
  bounded?: boolean;
}) {
  const model = useMemo(
    () => rhythmModel(rhythm, { hours: stats.hours, dom_hours: stats.dom_hours, series: dense }, scope, metric, from, to, bounded),
    [rhythm, stats.hours, stats.dom_hours, dense, scope, metric, from, to, bounded],
  );
  const L = model.layout;
  const N = L.rows * L.cols;
  const comp = companionMetric(metric);
  const label = METRIC_LABEL[metric];
  const kindWord = scope === "all" ? "" : ` · ${KIND_LABEL[scope]}`;
  const { tip, onMove, onLeave, onFocus, onBlur } = useCellTip();
  const { focusIdx, onKeyDown } = useRovingGrid(N, 1, L.cols);
  const boundsRef = useRef<HTMLDivElement | null>(null);
  const peak = model.peak;
  const share = (v: number) => (model.sum > 0 ? `${Math.round((v / model.sum) * 100)} % of the range` : "—");
  // What the tooltip describes: a cell (i < N), a top bar (a column) or a side bar (a row).
  const hov = useMemo(() => {
    if (!tip) return null;
    const i = tip.i;
    // "≈ 40 words per Tuesday" · "78 Tuesdays in range": the average over each occurrence.
    const perOcc = (v: number, occ: number, one: string, many: string): [string, string] => [`≈ ${metricText(metric, v / occ, true)} per ${one}`, `${fmtFull(occ)} ${many} in range`];
    if (i < N) {
      const c = model.cells[i];
      if (!c) return null;
      if (!c.inWindow) return { title: L.cellName(i), kinds: c.kinds, total: 0, quarter: undefined, extra: [], out: rhythm === "months" ? `${L.cellName(i)} is outside ${fmtDateFull(from)} – ${fmtDateFull(to)}` : rhythm === "hours" ? `no ${DOW_LONG[c.row]} falls between ${fmtDateFull(from)} and ${fmtDateFull(to)}` : `the ${ordinal(c.col + 1)} does not occur between ${fmtDateFull(from)} and ${fmtDateFull(to)}` };
      const occ = model.occOf(c);
      const extra: [string, string][] = [];
      if (c.value > 0 && occ > 1) extra.push(perOcc(c.value, occ, model.occWord(c), rhythm === "hours" ? `${model.occWord(c)}s` : "months"));
      return { title: L.cellName(i), kinds: c.kinds, total: c.value, quarter: c.level ? QUARTER_NAME[c.level] : undefined, extra };
    }
    if (i < N + L.cols) {
      const col = i - N;
      const v = model.colTotals[col];
      const extra: [string, string][] = [["share", share(v)], ["vs average", `${model.colIndex[col].toFixed(1)}× an average ${L.colUnit}`]];
      const days = to - from + 1;
      if (rhythm === "hours" && v > 0 && days > 1) extra.push(perOcc(v, days, "day", "days"));
      const occ = L.colOcc?.[col] ?? 1;
      if (rhythm === "days" && v > 0 && occ > 1) extra.push(perOcc(v, occ, "month", "months"));
      return { title: `${L.colLong(col)} · every ${L.rowUnit}`, kinds: sumKinds(model.cells.filter((c) => c.col === col)), total: v, quarter: undefined, extra };
    }
    const row = i - N - L.cols;
    // A poll can shrink the grid under a resting pointer (a year or a month-day row drops).
    if (row < 0 || row >= L.rows) return null;
    const v = model.rowTotals[row];
    const extra: [string, string][] = [["share", share(v)], ["vs average", `${model.rowIndex[row].toFixed(1)}× an average ${L.rowUnit}`]];
    const first = model.cells[row * L.cols];
    const occ = first ? model.occOf(first) : 1;
    if (rhythm === "hours" && v > 0 && occ > 1) extra.push(perOcc(v, occ, DOW_LONG[row], `${DOW_LONG[row]}s`));
    return { title: `${L.rowLong(row)} · all ${L.colUnits}`, kinds: sumKinds(model.cells.slice(row * L.cols, row * L.cols + L.cols)), total: v, quarter: undefined, extra };
  }, [tip, model, L, N, metric, rhythm, from, to]);
  // Arrow keys move between cells only; the bars are plain tab stops.
  const keys = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = cellOf(e.target);
    if (el && Number(el.dataset.i) >= N) return;
    onKeyDown(e);
  }, [N, onKeyDown]);
  const cMax = Math.max(1, ...model.colIndex);
  const rMax = Math.max(1, ...model.rowIndex);
  const barLen = (idx: number, max: number) => (idx > 0 ? Math.max(6, (idx / max) * 100) : 0).toFixed(1);
  const barBg = (idx: number) => (idx > 1 ? "var(--c-accent)" : "var(--c-line-strong)");
  const cellClass = rhythm === "hours" ? "aspect-square max-h-[20px]" : rhythm === "days" ? "h-[12px]" : "h-[22px]";
  const tz = stats.tz === "local" ? "server time" : stats.tz;
  const peakOcc = peak ? model.occOf(peak) : 0;
  // The two average ticks are drawn once across each track (a per-cell dash would break
  // at every grid gap): measured from the first and last bar of each track after layout —
  // the top one per contiguous run of live columns (a months window wrapping the year end
  // leaves a hidden stretch between its runs).
  const [ticks, setTicks] = useState<{ top: { runs: { x1: number; x2: number }[]; y: number }; side: { x: number; y1: number; y2: number } } | null>(null);
  useLayoutEffect(() => {
    const host = boundsRef.current;
    if (!host) { setTicks(null); return; }
    const measure = () => {
      const box = host.getBoundingClientRect();
      // Only the columns the window reaches: an out-of-window top bar keeps its layout box.
      const all = [...host.querySelectorAll<HTMLElement>('[data-track="top"]')];
      const anyLive = all.some((el) => el.dataset.live);
      const sides = host.querySelectorAll<HTMLElement>('[data-track="side"]');
      if (!all.length || !sides.length) { setTicks(null); return; }
      // Runs of consecutive live columns (every column when none is live).
      const spans: [HTMLElement, HTMLElement][] = [];
      let open = false;
      for (const el of all) {
        const live = !anyLive || !!el.dataset.live;
        if (live && open) spans[spans.length - 1][1] = el;
        else if (live) spans.push([el, el]);
        open = live;
      }
      const t0 = spans[0][0].getBoundingClientRect();
      const s0 = sides[0].getBoundingClientRect();
      const s1 = sides[sides.length - 1].getBoundingClientRect();
      const next = {
        top: {
          runs: spans.map(([a, b]) => ({ x1: a.getBoundingClientRect().left - box.left, x2: b.getBoundingClientRect().right - box.left })),
          y: t0.bottom - box.top - t0.height / cMax,
        },
        side: { x: s0.left - box.left + s0.width / rMax, y1: s0.top - box.top, y2: s1.bottom - box.top },
      };
      setTicks((p) => (p && JSON.stringify(p) === JSON.stringify(next) ? p : next));
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    return () => ro?.disconnect();
  }, [model, cMax, rMax]);
  return (
    <Panel
      title={`Busy ${rhythm} · ${title}${kindWord}`}
      right={<Segmented value={rhythm} onChange={onRhythm} ariaLabel="Rhythm — weekday × hour, day of month × hour, or year × month" options={RHYTHMS.map((r) => ({ value: r, label: r }))} />}
    >
      {/* Only when the server sends this breakdown: otherwise every cell is 0, and "No … in
          this range" would contradict the tiles and chart above; the notice below explains. */}
      {model.sent === "yes" && <div className="mb-2.5 truncate font-mono text-[11.5px] text-dim" title={peak ? `${metricText(metric, peak.value)} in the busiest ${rhythm === "months" ? "month" : "slot"}, ${L.cellName(peak.row * L.cols + peak.col)}${peakOcc > 1 ? `, summed over ${fmtFull(peakOcc)} ${rhythm === "hours" ? `${model.occWord(peak)}s` : "months"} in the range` : ""}` : undefined}>
        {peak ? (
          <>
            Peak {L.cellName(peak.row * L.cols + peak.col)} · <b className="font-semibold text-text">{metricText(metric, peak.value)}</b>
            {peakOcc > 1 && ` · ≈ ${metricText(metric, peak.value / peakOcc, true)} per ${model.occWord(peak)}`}
            {` · ${metricText(comp, peak.companion)}`}
            {model.phrase && <> · <span className="text-accent" title={phraseRule(rhythm, label.toLowerCase())}>{model.phrase}</span></>}
          </>
        ) : (
          `No ${label.toLowerCase()} in this range`
        )}
      </div>}
      {model.sent !== "yes" ? (
        <div className="rounded-[10px] border border-dashed border-line-strong px-3 py-2.5 text-[12.5px] text-dim">
          {model.sent === "no-grid" ? (
            <><b className="font-semibold text-text">This server does not send the day-of-month grid.</b> Update the server to see busy days. Hours and months still work.</>
          ) : (
            <><b className="font-semibold text-text">This server sends words per hour only.</b> Update the server to see {label.toLowerCase()} per {L.slotWord}. The rest of the page still follows the measure.</>
          )}
        </div>
      ) : (
        <div ref={boundsRef} className="relative" onMouseMove={onMove} onMouseLeave={onLeave} onFocus={onFocus} onBlur={onBlur} onKeyDown={keys}>
          <CellTip tip={tip} boundsRef={boundsRef}>
            {hov && "out" in hov && hov.out ? (
              <>
                <div className="mb-1 font-mono text-[10.5px] uppercase tracking-label text-faint">{hov.title}</div>
                <div className="leading-relaxed text-dim">not in this window</div>
                <div className="text-[11.5px] leading-relaxed text-faint">{hov.out}</div>
              </>
            ) : (
              hov && <KindTip title={hov.title} kinds={hov.kinds} metric={metric} scope={scope} total={hov.total} quarter={hov.quarter} extra={hov.extra} companion={comp} />
            )}
          </CellTip>
          <div
            className={cn("grid", rhythm === "days" ? "gap-[2px]" : "gap-[3px]")}
            style={{ gridTemplateColumns: `34px repeat(${L.cols}, minmax(0, 1fr)) 10px 30px` }}
            role="grid"
            aria-label={`${label} per ${L.slotWord}, levelled by quartiles of the active slots, with each ${L.colUnit} and ${L.rowUnit} against a flat ${L.flatWord}. Use the arrow keys to move between slots.`}
          >
            <div role="presentation" />
            {model.colIndex.map((idx, c) => (
              <div
                key={`t${c}`}
                data-i={N + c}
                tabIndex={model.colLive[c] ? 0 : -1}
                role="img"
                aria-label={`${L.colLong(c)}: ${metricText(metric, model.colTotals[c])}, ${idx.toFixed(1)} times an average ${L.colUnit}`}
                data-track="top"
                data-live={model.colLive[c] ? "1" : undefined}
                className={cn("relative flex h-[24px] items-end rounded-[2px] outline-none", CELL_HOVER, !model.colLive[c] && "invisible", tip?.i === N + c && CELL_HOT)}
              >
                <i className="block w-full rounded-t-[2px]" style={{ height: `${barLen(idx, cMax)}%`, background: barBg(idx) }} />
              </div>
            ))}
            <div role="presentation" />
            <div role="presentation" />
            <div role="presentation" />
            {Array.from({ length: L.cols }, (_, c) => (
              <div key={`l${c}`} role="presentation" className="text-center font-mono text-[10px] text-faint">{L.colLabel(c)}</div>
            ))}
            <div role="presentation" />
            <div role="presentation" />
            {Array.from({ length: L.rows }, (_, r) => {
              // A row the window never reaches (a weekday a short span skips) hides its side
              // bar, like an out-of-window top bar; the box stays so the tick still spans the track.
              const rowLive = model.cells.slice(r * L.cols, r * L.cols + L.cols).some((c) => c.inWindow);
              return (
                <div key={r} role="row" className="contents">
                  <div className="flex items-center font-mono text-[10.5px] leading-none text-faint">{L.rowLabel(r)}</div>
                  {model.cells.slice(r * L.cols, r * L.cols + L.cols).map((c) => {
                    const i = r * L.cols + c.col;
                    return (
                      <i
                        key={c.col}
                        data-i={i}
                        tabIndex={i === focusIdx ? 0 : -1}
                        role="gridcell"
                        aria-label={`${L.cellName(i)}: ${!c.inWindow ? "not in this window" : c.value > 0 ? `${metricText(metric, c.value)} · ${metricText(comp, c.companion)}` : `no ${label.toLowerCase()}`}${c.level ? `, ${QUARTER_NAME[c.level]}` : ""}`}
                        className={cn("block w-full rounded-[3px] outline-none", cellClass, CELL_HOVER, tip?.i === i ? CELL_HOT : peak === c && "ring-[1.5px] ring-inset ring-text")}
                        style={{ background: c.inWindow ? LEVEL_BG[c.level] : "repeating-linear-gradient(135deg, var(--c-line-strong) 0 2px, var(--c-surface-2) 2px 5px)" }}
                      />
                    );
                  })}
                  <div role="presentation" />
                  <div
                    data-i={N + L.cols + r}
                    tabIndex={rowLive ? 0 : -1}
                    role="img"
                    aria-label={`${L.rowLong(r)}: ${metricText(metric, model.rowTotals[r])}, ${model.rowIndex[r].toFixed(1)} times an average ${L.rowUnit}`}
                    data-track="side"
                    className={cn("relative flex items-center rounded-[2px] outline-none", CELL_HOVER, !rowLive && "invisible", tip?.i === N + L.cols + r && CELL_HOT)}
                  >
                    <i className="block h-[calc(100%-4px)] rounded-r-[2px]" style={{ width: `${barLen(model.rowIndex[r], rMax)}%`, background: barBg(model.rowIndex[r]) }} />
                  </div>
                </div>
              );
            })}
          </div>
          {ticks && (
            <>
              {ticks.top.runs.map((t) => (
                <i key={t.x1} className="pointer-events-none absolute border-t border-dashed border-line-strong" style={{ left: t.x1, width: t.x2 - t.x1, top: ticks.top.y }} aria-hidden />
              ))}
              <i className="pointer-events-none absolute border-l border-dashed border-line-strong" style={{ left: ticks.side.x, top: ticks.side.y1, height: ticks.side.y2 - ticks.side.y1 }} aria-hidden />
            </>
          )}
        </div>
      )}
      {model.sent === "yes" && (
        <>
          <LevelLegend lead={`${label} per ${L.slotWord} · quarters of your active slots`} breaks={model.breaks} floor={model.floor} counts={model.counts} unit={["slot", "slots"]} metric={metric} />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            <span><i className="mr-1.5 inline-block h-2 w-3 rounded-[1px] bg-line-strong align-[-1px]" aria-hidden />side bars: each {L.colUnit} (top) and {L.rowUnit} (right) against a flat {L.flatWord} · dashed tick = average</span>
            <span className="ml-auto">{tz}</span>
          </div>
        </>
      )}
    </Panel>
  );
}
