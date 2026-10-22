import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { isDurationMetric, legendRanges, type ChartMetric } from "@/lib/usageDerive";
import { metricTick } from "@/components/stats/chartKit";
import { plural } from "@/lib/format";
import { type CellTipState, LEVEL_BG } from "@/components/stats/heatGridKit";

/** The floating shell: measured after render so a multi-line tip flips and clamps by its
 *  real size; above the anchor, or below it near the top so a scrolling wrapper does not clip. */
export function CellTip({ tip, boundsRef, children }: { tip: CellTipState | null; boundsRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) { setPos(null); return; }
    const width = boundsRef.current?.scrollWidth ?? 0;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let left = tip.x + 14;
    if (width > 0 && left + tw > width - 4) left = tip.x - tw - 10;
    let top = tip.y - th - 12;
    if (top < 0) top = tip.y + 18;
    const next = { left: Math.max(0, left), top };
    // Same box → keep the object: a fresh one every render would re-run this effect forever.
    setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
  }, [tip, children, boundsRef]);
  if (!tip) return null;
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-20 min-w-[180px] whitespace-nowrap rounded-[10px] border border-line-strong bg-surface/95 px-3 py-2 text-[12px] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)] backdrop-blur-sm"
      style={{ left: pos?.left ?? tip.x, top: pos?.top ?? tip.y, visibility: pos ? "visible" : "hidden" }}
      role="status"
    >
      {children}
    </div>
  );
}
/** The legend's five labels for a grid's breaks, step counts and measure. `floor` is the smallest
 *  active value (the model's activeFloor); without it the first non-zero break stands in. */
export function levelLegendLabels(breaks: [number, number, number], counts: readonly number[], metric: ChartMetric, floor?: number): string[] {
  // Duration quartiles can sit under ten seconds (processing time per day); the axis
  // formatter rounds those to "0s", which read as "1s–0s". Sub-ten-second bounds keep a
  // decimal, and the first active step opens at 0.1 s instead of 1 s when its break is below it
  // (an empty step's 0 break says nothing: legendRanges draws it as "—"). Below 0.1 s a bound
  // keeps one significant digit and the floor drops to the break's own decade (0.03 s opens at
  // 0.01 s): one decimal would print 0.03 s as "0s", so a later step would open below the one
  // before it, and the top step would claim "0.1s+" for values the floor lifted it past. The
  // floor follows the smallest VALUE, not the first break: that break is step 1's max, so a
  // 0.3 s day under a 2 s break read "1s–2s", and a lone 0.03 s day (breaks 0,0,0) "0.1s+".
  const dur = isDurationMetric(metric);
  const fmt = (v: number) =>
    dur && v > 0 && v < 10 ? `${v < 0.1 ? Number(v.toPrecision(1)) : Math.round(v * 10) / 10}s` : metricTick(metric, v);
  const least = floor !== undefined && floor > 0 ? floor : (breaks.find((v) => v > 0) ?? 0);
  const lo = !dur || least >= 1 ? 1 : least >= 0.1 || least === 0 ? 0.1 : 10 ** Math.floor(Math.log10(least));
  return legendRanges(breaks, fmt, lo, counts[4]);
}

/** The five labelled steps: swatch, value range, count. Shared by both grids. */
export function LevelLegend({ lead, breaks, floor, counts, unit, metric }: { lead: string; breaks: [number, number, number]; floor: number; counts: readonly number[]; unit: [string, string]; metric: ChartMetric }) {
  const ranges = levelLegendLabels(breaks, counts, metric, floor);
  return (
    <div className="mt-2.5 flex flex-wrap items-end gap-3.5 text-[11.5px] text-faint">
      <span>{lead}</span>
      <span className="ml-auto flex">
        {ranges.map((r, i) => (
          <span key={i} className="flex min-w-[58px] flex-col gap-1">
            <i className="block h-2.5 w-full rounded-[2px]" style={{ background: LEVEL_BG[i] }} />
            <span className="font-mono text-[10.5px] text-dim">{r}</span>
            <span className="font-mono text-[10px] text-faint">{plural(counts[i], unit[0], unit[1])}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
