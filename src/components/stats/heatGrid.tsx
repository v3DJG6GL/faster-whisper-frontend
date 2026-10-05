import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { isDurationMetric, legendRanges, type ChartMetric } from "@/lib/usageDerive";
import { metricTick } from "@/components/stats/chartKit";
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
/** The five labelled steps: swatch, value range, count. Shared by both grids. */
export function LevelLegend({ lead, breaks, counts, unit, metric }: { lead: string; breaks: [number, number, number]; counts: readonly number[]; unit: [string, string]; metric: ChartMetric }) {
  // Duration quartiles can sit under ten seconds (processing time per day); the axis
  // formatter rounds those to "0s", which read as "1s–0s". Sub-ten-second bounds keep a
  // decimal, and the first step opens at 0.1 s instead of 1 s when the break is below it.
  const dur = isDurationMetric(metric);
  const fmt = (v: number) => (dur && v > 0 && v < 10 ? `${Math.round(v * 10) / 10}s` : metricTick(metric, v));
  const ranges = legendRanges(breaks, fmt, dur && breaks[0] < 1 ? 0.1 : 1);
  return (
    <div className="mt-2.5 flex flex-wrap items-end gap-3.5 text-[11.5px] text-faint">
      <span>{lead}</span>
      <span className="ml-auto flex">
        {ranges.map((r, i) => (
          <span key={i} className="flex min-w-[58px] flex-col gap-1">
            <i className="block h-2.5 w-full rounded-[2px]" style={{ background: LEVEL_BG[i] }} />
            <span className="font-mono text-[10.5px] text-dim">{r}</span>
            <span className="font-mono text-[10px] text-faint">{counts[i]} {counts[i] === 1 ? unit[0] : unit[1]}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
