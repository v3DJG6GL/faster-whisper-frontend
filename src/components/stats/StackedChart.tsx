import {
  useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/cn";
import { fmtDateTick, fmtDateFull } from "@/lib/format";
import {
  KINDS, KIND_LABEL, KIND_VAR, METRIC_LABEL, metricValue, niceMax, presentKinds, safeTotals, type BucketMode,
  type ChartMetric, type UsageBucket, type UsageScope,
} from "@/lib/usageDerive";
import type { UsageKind, UsageKinds } from "@/lib/types";
import { BUCKET_WORD, fmtMonthYear, kindFill, metricText, metricTick, useWidth } from "@/components/stats/chartKit";
import { HatchDef, Panel, Swatch } from "@/components/stats/primitives";

/* ── stacked columns by kind ─────────────────────────────────────────────── */

const TIP_W = 176;

/** Column label for a bucket's start: `12.06.` per day/week, `Juni` per month. */
function bucketTick(b: UsageBucket, mode: BucketMode, last: boolean): string {
  if (last && mode === "day") return "today";
  return fmtDateTick(b.from, mode === "month");
}
/** Tooltip header: the day, `Woche ab 6.7.`-style for a week, month + year for a month. */
function bucketTitle(b: UsageBucket, mode: BucketMode): string {
  if (mode === "day") return fmtDateFull(b.from);
  if (mode === "week") return `${fmtDateTick(b.from)} – ${fmtDateTick(b.to)}`;
  return fmtMonthYear(b.from);
}

export function StackedChart({ buckets, mode, scope, metric }: { buckets: UsageBucket[]; mode: BucketMode; scope: UsageScope; metric: ChartMetric }) {
  const [solo, setSolo] = useState<UsageKind | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [ref, w] = useWidth();
  const hatchId = useId();
  const H = 220;
  const pad = { l: 44, r: 10, t: 12, b: 24 };
  const pw = Math.max(0, w - pad.l - pad.r);
  const ph = H - pad.t - pad.b;

  // A scoped page shows that kind only; the legend then reads as a key, not a switch.
  const effSolo: UsageKind | null = scope === "all" ? solo : scope;
  const shown = (k: UsageKind) => !effSolo || effSolo === k;

  // hover is an index into the bucket list — a different column after the window changes.
  useEffect(() => setHover(null), [buckets]);

  const pts = buckets;
  const n = pts.length;
  const cols = useMemo(
    () => pts.map((p) => KINDS.map((k) => (shown(k) ? metricValue(safeTotals(p[k]), metric) : 0))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pts, metric, effSolo],
  );
  const totals = useMemo(() => cols.map((c) => c.reduce((s, v) => s + v, 0)), [cols]);
  const top = useMemo(() => niceMax(Math.max(0, ...totals)), [totals]);
  const allZero = totals.every((t) => t === 0);
  const bw = n ? pw / n : 0;
  const barX = (i: number) => pad.l + i * bw + bw * 0.18;
  const barW = bw * 0.64;
  const yOf = (v: number) => ph * (v / top);

  // X ticks: about one per 60 px, always the last column, from the right so "today" anchors.
  const step = Math.max(1, Math.round(60 / Math.max(1, bw)));
  const isTick = (i: number) => i === n - 1 || (n - 1 - i) % step === 0;

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (n === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = r.width ? (e.clientX - r.left) / r.width : 0;
    setHover(Math.max(0, Math.min(n - 1, Math.floor(frac * n))));
  };
  const onKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (n === 0) return;
    if (e.key === "ArrowLeft") { setHover((h) => Math.max(0, (h ?? n - 1) - 1)); e.preventDefault(); }
    else if (e.key === "ArrowRight") { setHover((h) => Math.min(n - 1, (h ?? n - 1) + 1)); e.preventDefault(); }
    else if (e.key === "Home") { setHover(0); e.preventDefault(); }
    else if (e.key === "End") { setHover(n - 1); e.preventDefault(); }
    else if (e.key === "Escape") setHover(null);
  };

  const hp = hover != null && hover < n ? pts[hover] : null;
  // Tooltip within the plot wrapper (the svg is inset by the wrapper's padding).
  const OFFX = 12;
  let tipLeft = OFFX + (hp ? barX(hover!) + barW / 2 : 0) + 14;
  if (tipLeft + TIP_W > w + OFFX * 2 - 4) tipLeft = OFFX + (hp ? barX(hover!) : 0) - TIP_W - 6;
  tipLeft = Math.max(4, tipLeft);
  const tipTop = Math.max(2, 4 + (hp ? pad.t + ph - yOf(totals[hover!]) - 60 : 0));

  const legendButton = (k: UsageKind) => {
    const muted = !!effSolo && effSolo !== k;
    const inert = scope !== "all";
    return (
      <button
        key={k}
        type="button"
        aria-pressed={effSolo === k}
        disabled={inert}
        onClick={() => setSolo((s) => (s === k ? null : k))}
        className={cn(
          "ring-signal inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-dim transition-opacity",
          muted && "opacity-40",
          inert ? "cursor-default" : "hover:text-text",
        )}
        title={inert ? undefined : effSolo === k ? "Show every kind" : `Solo ${KIND_LABEL[k]}`}
      >
        <Swatch kind={k} />
        {KIND_LABEL[k]}
      </button>
    );
  };

  const unit = BUCKET_WORD[mode];
  return (
    <Panel
      title={`${METRIC_LABEL[metric]} per ${unit}, by kind`}
      right={
        <div className="flex flex-wrap gap-3.5" role="group" aria-label="Kinds (click to solo)">
          {KINDS.map(legendButton)}
        </div>
      }
    >
      <div ref={ref} className="relative px-3 pb-1 pt-1">
        {allZero ? (
          <div className="grid h-[220px] place-items-center text-[13px] text-faint">
            No {METRIC_LABEL[metric].toLowerCase()} in this range
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${w} ${H}`}
              width="100%"
              height={H}
              className="ring-signal block"
              tabIndex={0}
              role="img"
              aria-label={`${METRIC_LABEL[metric]} per ${unit} by kind, ${n} ${unit}s. Use the arrow keys to step through them.`}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              <defs>
                <HatchDef id={hatchId} />
              </defs>
              {[0, 1, 2, 3, 4].map((g) => {
                const y = pad.t + ph * (1 - g / 4);
                return (
                  <g key={g}>
                    <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke="var(--c-line)" strokeWidth={1} />
                    <text x={pad.l - 8} y={y + 3} textAnchor="end" className="font-mono" fontSize={10} fill="var(--c-faint)">
                      {metricTick(metric, (top * g) / 4)}
                    </text>
                  </g>
                );
              })}
              {cols.map((c, i) => {
                let y = pad.t + ph;
                const x = barX(i);
                return (
                  <g key={pts[i].from} opacity={hover != null && hover !== i ? 0.55 : 1}>
                    {KINDS.map((k, ki) => {
                      const v = c[ki];
                      if (!(v > 0)) return null;
                      const h = yOf(v);
                      y -= h;
                      // 2 px surface gap between stacked segments (the mockup's `h-2`).
                      return (
                        <rect key={k} x={x.toFixed(1)} y={y.toFixed(1)} width={barW.toFixed(1)} height={Math.max(0.5, h - 2).toFixed(1)} rx={Math.min(2, barW / 2)} fill={kindFill(k, hatchId)} />
                      );
                    })}
                  </g>
                );
              })}
              {pts.map((p, i) =>
                isTick(i) ? (
                  <text
                    key={p.from}
                    x={barX(i) + barW / 2}
                    y={H - 7}
                    textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
                    className="font-mono"
                    fontSize={10}
                    fill="var(--c-faint)"
                  >
                    {bucketTick(p, mode, i === n - 1)}
                  </text>
                ) : null,
              )}
              <rect
                x={pad.l}
                y={pad.t}
                width={pw}
                height={ph}
                fill="transparent"
                style={{ cursor: "crosshair", touchAction: "none" }}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
              />
            </svg>
            {hp && (
              <div
                className="pointer-events-none absolute z-20 min-w-[150px] rounded-[10px] border border-line-strong bg-surface/95 px-3 py-2 text-[12px] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)] backdrop-blur-sm"
                style={{ left: tipLeft, top: tipTop, width: TIP_W }}
              >
                <KindTip title={bucketTitle(hp, mode)} kinds={hp} metric={metric} scope={effSolo ?? "all"} total={totals[hover!]} />
              </div>
            )}
            <div className="sr-only" aria-live="polite">
              {hp ? `${bucketTitle(hp, mode)}: ${metricText(metric, totals[hover!])}` : ""}
            </div>
          </>
        )}
      </div>
      <div className="mt-1.5 text-[11.5px] text-faint">
        {scope === "all" ? "Click a legend entry to solo that kind. " : ""}Hover for the {unit}’s split; the Measure switch in the filter bar (or a tile) changes what every chart counts.
        {mode !== "day" && ` One column per ${unit} at this range.`} Text imports are hatched neutral: they are rare and never a volume story.
      </div>
    </Panel>
  );
}

/* ── the per-kind tooltip (D31 T3 / D33): present kinds, a split bar, the total ── */

export function KindTip({ title, kinds, metric, scope, total, quarter, extra, companion }: {
  title: string;
  kinds: UsageKinds;
  metric: ChartMetric;
  scope: UsageScope;
  total: number;
  /** The cell's quarter name, on the total line (or the single row). */
  quarter?: string;
  /** Faint lines after the total: `[["≈ 40 words per Tuesday", "78 Tuesdays in range"]]` (D32). */
  extra?: ReadonlyArray<[string, string]> | null;
  /** D45 C1: a second measure beside the first on every row ("1h 12m · 4 sessions"). */
  companion?: ChartMetric;
}) {
  const rows = presentKinds(kinds, metric, scope);
  const single = rows.length === 1;
  const withComp = (kindValue: number, v: string) => (companion ? <>{v} <span className="text-faint">· {metricText(companion, kindValue)}</span></> : v);
  const compOf = (k: UsageKind) => metricValue(safeTotals(kinds[k]), companion ?? metric);
  const compTotal = metricValue(safeTotals(kinds[scope]), companion ?? metric);
  return (
    <>
      <div className="mb-1 font-mono text-[10.5px] uppercase tracking-label text-faint">{title}</div>
      {!(total > 0) ? (
        <div className="leading-relaxed text-faint">no {METRIC_LABEL[metric].toLowerCase()}</div>
      ) : (
        <>
          {scope === "all" && rows.length > 1 && (
            <div className="mb-1.5 mt-1 flex h-[5px] overflow-hidden rounded-[3px] bg-surface-2" aria-hidden>
              {rows.map((r) => (
                <i key={r.kind} className="block h-full" style={{ width: `${(r.value / total) * 100}%`, background: KIND_VAR[r.kind] }} />
              ))}
            </div>
          )}
          {rows.map((r) => (
            <div key={r.kind} className="flex items-baseline justify-between gap-4 leading-relaxed text-dim">
              <span className="flex items-center gap-1.5"><Swatch kind={r.kind} />{KIND_LABEL[r.kind]}</span>
              <span className="font-num text-text">{withComp(compOf(r.kind), metricText(metric, r.value))}{single && quarter ? ` · ${quarter}` : ""}</span>
            </div>
          ))}
          {!single && (
            <div className={cn("flex items-baseline justify-between gap-4 leading-relaxed text-dim", rows.length > 0 && "mt-1 border-t border-line pt-1")}>
              <span>total{quarter ? ` · ${quarter}` : ""}</span>
              <span className="font-num font-semibold text-text">{withComp(compTotal, metricText(metric, total))}</span>
            </div>
          )}
          {extra?.map((line, i) => (
            <div key={i} className={cn("flex items-baseline justify-between gap-4 text-[11.5px] leading-relaxed text-faint", i === 0 && "mt-0.5")}>
              <span>{line[0]}</span>
              <span>{line[1]}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
