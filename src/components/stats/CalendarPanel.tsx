import { useMemo, useRef } from "react";
import { cn } from "@/lib/cn";
import { fmtFull, fmtDateFull, localTodayDay } from "@/lib/format";
import {
  DOW_SHORT, KIND_LABEL, METRIC_LABEL, QUARTER_NAME, STAGE_CHIP_LABEL, calendarModel, streakFor, weekColumns,
  type ChartMetric, type UsageScope,
} from "@/lib/usageDerive";
import type { UsageSeriesPoint, UsageStageKey, UsageStreaks } from "@/lib/types";
import { KindTip } from "@/components/stats/StackedChart";
import { metricText } from "@/components/stats/chartKit";
import { CellTip, LevelLegend } from "@/components/stats/heatGrid";
import { CELL_HOT, CELL_HOVER, LEVEL_BG, useCellTip, useRovingGrid } from "@/components/stats/heatGridKit";
import { Panel, Pill } from "@/components/stats/primitives";

/** The calendar is always the last 12 months (its own year document, or the page's when
 *  that already spans a year), whatever range the page shows: a week of squares says
 *  nothing and its quartiles less. The page's range is MARKED on it instead — days outside
 *  it are dimmed — so the strip also shows where the filter sits. */
export function CalendarPanel({ dense, streaks, scope, withS, from, to, mark, filtered, metric, stale }: {
  dense: readonly UsageSeriesPoint[];
  streaks: UsageStreaks | undefined;
  scope: UsageScope;
  withS: readonly UsageStageKey[];
  from: number;
  to: number;
  /** The page's range, when it is narrower than the year; null = the whole year. */
  mark: { from: number; to: number; word: string } | null;
  filtered: boolean;
  metric: ChartMetric;
  stale: boolean;
}) {
  const model = useMemo(() => calendarModel(dense, scope, from, to, metric), [dense, scope, from, to, metric]);
  const cols = useMemo(() => weekColumns(model.cells), [model.cells]);
  const streak = streakFor(streaks, scope);
  const ref = useRef<HTMLDivElement | null>(null);
  // Cells are sized by CSS: one 1fr track per week column, square cells — they fill the
  // panel's width exactly and shrink to 12 px before the strip scrolls sideways.
  const today = localTodayDay();
  const withWord = withS.length ? ` · with ${withS.map((k) => STAGE_CHIP_LABEL[k].toLowerCase()).join(" + ")}` : "";
  const { tip, onMove, onLeave, onFocus, onBlur } = useCellTip();
  // Index = position in the day list; a column is a week, so left/right step seven days.
  const { focusIdx, onKeyDown } = useRovingGrid(model.cells.length, 7, 1);
  const first = model.cells[0]?.day ?? 0;
  const hovered = tip ? model.cells[tip.i] : undefined;
  const label = METRIC_LABEL[metric];
  return (
    <Panel
      title={`Calendar · last 12 months · ${scope === "all" ? "all kinds" : KIND_LABEL[scope]}${withWord}`}
      right={
        <>
          {mark && <Pill>{mark.word} marked</Pill>}
          {stale && <Pill>loading…</Pill>}
          <Pill>
            streak {fmtFull(streak.current)} {streak.current === 1 ? "day" : "days"} · best {fmtFull(streak.best)}
            {filtered ? " · filtered" : ""}
          </Pill>
        </>
      }
    >
      <div ref={ref} className={cn("relative overflow-x-auto pb-1", stale && "opacity-70")} onMouseMove={onMove} onMouseLeave={onLeave} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
        <CellTip tip={tip} boundsRef={ref}>
          {hovered && <KindTip title={fmtDateFull(hovered.day)} kinds={hovered.kinds} metric={metric} scope={scope} total={hovered.value} quarter={hovered.level ? QUARTER_NAME[hovered.level] : undefined} />}
        </CellTip>
        <div
          className="grid w-full gap-[3px]"
          style={{ gridTemplateColumns: `max-content repeat(${cols.length}, minmax(12px, 1fr))` }}
          role="grid"
          aria-label={`${label} per day, ${model.cells.length} days, levelled by quartiles of the active days. Use the arrow keys to move between days.`}
        >
          <div />
          {/* Each month label spans the columns up to the next label, so a label is never
              wider than its cell (a 12 px track holding "Sep" would spill past the grid and
              hand the strip a scrollbar). */}
          {cols.map((c, i) => {
            if (!c.month) return null;
            let span = 1;
            while (i + span < cols.length && !cols[i + span].month) span++;
            // The year's last month may own one or two week columns — too narrow for its
            // name — so it borrows columns to its LEFT (they hold no text at their right
            // end) and aligns to the right edge instead of being clipped.
            const short = span < 3;
            const start = short ? Math.max(0, i + span - 3) : i;
            return (
              <div key={`m${c.monday}`} className={cn("h-[14px] overflow-hidden whitespace-nowrap font-mono text-[10.5px] text-faint", short && "text-right")} style={{ gridColumn: `${start + 2} / span ${i + span - start}`, gridRow: 1 }}>
                {c.month}
              </div>
            );
          })}
          <div role="row" className="grid h-full grid-rows-[repeat(7,1fr)] gap-[3px]" style={{ gridRow: 2, gridColumn: 1 }}>
            {DOW_SHORT.map((d, i) => (
              <div key={d} role="presentation" className="flex items-center justify-end pr-1.5 font-mono text-[10.5px] text-faint">
                {i % 2 === 0 ? d : ""}
              </div>
            ))}
          </div>
          {cols.map((c) => (
            <div key={c.monday} role="row" className="grid gap-[3px]" style={{ gridRow: 2 }}>
              {c.cells.map((cellData, r) => {
                if (!cellData) return <i key={`e${c.monday}-${r}`} className="block aspect-square w-full" />;
                const i = cellData.day - first;
                return (
                  <i
                    key={cellData.day}
                    data-i={i}
                    tabIndex={i === focusIdx ? 0 : -1}
                    role="gridcell"
                    aria-label={`${fmtDateFull(cellData.day)}: ${cellData.value > 0 ? metricText(metric, cellData.value) : `no ${label.toLowerCase()}`}${cellData.level ? `, ${QUARTER_NAME[cellData.level]}` : ""}`}
                    className={cn("block aspect-square w-full rounded-[3px] outline-none", CELL_HOVER, cellData.day === today && "ring-[1.5px] ring-inset ring-text", mark && (cellData.day < mark.from || cellData.day > mark.to) && "opacity-30", tip?.i === i && CELL_HOT)}
                    style={{ background: LEVEL_BG[cellData.level] }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <LevelLegend lead={`${label} per day · quarters of your active days in the year${mark ? " · dimmed days are outside the range" : ""}`} breaks={model.breaks} counts={model.counts} unit={["day", "days"]} metric={metric} />
    </Panel>
  );
}
