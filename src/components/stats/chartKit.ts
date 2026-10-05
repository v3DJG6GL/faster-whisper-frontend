// The usage charts' shared non-component helpers: date and measure formatters, the line
// path, the width hook, the kind fills. Their shared components live in primitives.tsx.
import { useLayoutEffect, useRef, useState } from "react";
import { fmtFull, fmtCompact, fmtDuration, fmtDurationAxis } from "@/lib/format";
import { KIND_VAR, METRIC_UNIT, isDurationMetric, type BucketMode, type ChartMetric } from "@/lib/usageDerive";
import type { UsageKind } from "@/lib/types";

const _spanDate = new Intl.DateTimeFormat("de-CH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const _monthYear = new Intl.DateTimeFormat("de-CH", { month: "long", year: "numeric", timeZone: "UTC" });
/** `1. Aug. 2026`, for the range pill and the custom-span popover. */
export const fmtSpanDate = (day: number) => _spanDate.format(new Date(day * 86_400_000));
export const fmtMonthYear = (day: number) => _monthYear.format(new Date(day * 86_400_000));
export const fmtDateRange = (from: number, to: number) => `${fmtSpanDate(from)} – ${fmtSpanDate(to)}`;

/* ── the measure's formatters: the two `_s` measures are durations, the rest counts ── */
export const metricTick = (m: ChartMetric, v: number) => (isDurationMetric(m) ? fmtDurationAxis(v) : fmtCompact(v));
/** A value with its unit: `1,240 words` · `31h 12m` · `1 session`. */
export function metricText(m: ChartMetric, v: number, compact = false): string {
  if (isDurationMetric(m)) return fmtDuration(v);
  const u = METRIC_UNIT[m] ?? ["", ""];
  return `${compact ? fmtCompact(v) : fmtFull(v)} ${Math.round(v) === 1 ? u[0] : u[1]}`;
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

/** Area+line path over `vals` in a w×h box, scaled to `max`. */
export function linePath(vals: number[], w: number, h: number, pad: { l: number; r: number; t: number; b: number }, max: number) {
  const n = vals.length;
  const m = Math.max(1, max);
  const X = (i: number) => pad.l + (w - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
  const Y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / m);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const area = n ? `${d} L ${X(n - 1).toFixed(1)} ${(h - pad.b).toFixed(1)} L ${X(0).toFixed(1)} ${(h - pad.b).toFixed(1)} Z` : "";
  return { d, area, X, Y, n };
}
export function useWidth(initial = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
export const kindFill = (k: UsageKind, hatchId: string) => (k === "text" ? `url(#${hatchId})` : KIND_VAR[k]);
export const BUCKET_WORD: Record<BucketMode, string> = { day: "day", week: "week", month: "month" };
