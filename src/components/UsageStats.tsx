// Home "Usage" section: four stat tiles (Words / Minutes / Dictations / Errors,
// today + all-time) plus a trend — either one shared chart (layout "chart") or a
// sparkline baked into each tile (layout "sparklines"), switched in the header
// and persisted via settings.homeStatsLayout. Reads the active backend's stats
// from the store (fed by lib/usage.ts); renders nothing when unsupported.
//
// The backend series is SPARSE (only days that had usage). We densify it on the
// client into one point per calendar day across the window, so the chart plots
// against real dates (each point carries `day` = days-since-epoch) and the
// 7/30/90 ranges genuinely differ. Zero-dependency SVG; Intl for de-CH dates.

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Clock, Mic, Type, TriangleAlert } from "lucide-react";
import { useApp } from "@/lib/store";
import { Card, SectionLabel, Segmented } from "@/components/ui";
import {
  fmtFull,
  fmtCompact,
  fmtDuration,
  fmtDurationAxis,
  fmtDateTick,
  fmtDateFull,
  localTodayDay,
} from "@/lib/format";
import { TREND_DAYS } from "@/lib/usage";
import type {
  Backend,
  HomeStatsLayout,
  UsageSeriesPoint,
  UsageStats,
  UsageTotals,
} from "@/lib/types";

type MetricKey = "words" | "audio" | "requests" | "errors";

const FIELD: Record<MetricKey, keyof UsageTotals> = {
  words: "words",
  audio: "audio_s",
  requests: "requests",
  errors: "errors",
};

/** Per-metric label + value formatter (for the tooltip + legend). */
const METRIC: Record<MetricKey, { label: string; fmt: (v: number) => string }> = {
  words: { label: "words", fmt: fmtFull },
  audio: { label: "minutes", fmt: fmtDuration },
  requests: { label: "dictations", fmt: fmtFull },
  errors: { label: "errors", fmt: fmtFull },
};

const METRIC_KEYS: MetricKey[] = ["words", "audio", "requests", "errors"];

const TILES: {
  key: MetricKey;
  label: string;
  icon: typeof Type;
  today: (t: UsageTotals) => string;
  total: (t: UsageTotals) => string;
  totalWord: string;
}[] = [
  { key: "words", label: "Words", icon: Type, today: (t) => fmtFull(t.words), total: (t) => fmtCompact(t.words), totalWord: "total" },
  { key: "audio", label: "Minutes", icon: Clock, today: (t) => fmtDuration(t.audio_s), total: (t) => fmtDuration(t.audio_s), totalWord: "all-time" },
  { key: "requests", label: "Dictations", icon: Mic, today: (t) => fmtFull(t.requests), total: (t) => fmtCompact(t.requests), totalWord: "total" },
  { key: "errors", label: "Errors", icon: TriangleAlert, today: (t) => fmtFull(t.errors), total: (t) => fmtFull(t.errors), totalWord: "total" },
];

const valOf = (p: UsageSeriesPoint, m: MetricKey) => Number(p[FIELD[m]] ?? 0);
const tick = (m: MetricKey, v: number) => (m === "audio" ? fmtDurationAxis(v) : fmtCompact(v));

/** Round a max up to a clean 1/2/5 × 10ⁿ so gridline labels read nicely. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const u = v / p;
  return (u <= 1 ? 1 : u <= 2 ? 2 : u <= 5 ? 5 : 10) * p;
}

/** Densify the sparse series into one point per calendar day across the trend
 *  window, zero-filling gaps. Anchored on the client's local "today" (matches
 *  the backend's server-local day numbering for whole-hour offsets), extended to
 *  the latest data day so nothing is ever cut off. */
function densify(series: UsageSeriesPoint[]): UsageSeriesPoint[] {
  const byDay = new Map<number, UsageSeriesPoint>();
  let maxDay = -Infinity;
  for (const p of series) {
    byDay.set(p.day, p);
    if (p.day > maxDay) maxDay = p.day;
  }
  const today = localTodayDay();
  const end = Number.isFinite(maxDay) ? Math.max(today, maxDay) : today;
  const start = end - (TREND_DAYS - 1);
  const out: UsageSeriesPoint[] = [];
  for (let day = start; day <= end; day++) {
    out.push(byDay.get(day) ?? { day, requests: 0, errors: 0, words: 0, audio_s: 0 });
  }
  return out;
}

/** Area+line path over `vals` in a w×h box, scaled to `max`. */
function linePath(
  vals: number[],
  w: number,
  h: number,
  pad: { l: number; r: number; t: number; b: number },
  max: number,
) {
  const n = vals.length;
  const m = Math.max(1, max);
  const X = (i: number) => pad.l + (w - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
  const Y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / m);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const area = n ? `${d} L ${X(n - 1).toFixed(1)} ${(h - pad.b).toFixed(1)} L ${X(0).toFixed(1)} ${(h - pad.b).toFixed(1)} Z` : "";
  return { d, area, X, Y, n };
}

function Sparkline({ vals, color }: { vals: number[]; color: string }) {
  const W = 132;
  const H = 30;
  const { d, area, X, Y, n } = linePath(vals, W, H, { l: 1, r: 1, t: 4, b: 2 }, Math.max(1, ...vals));
  if (!n) return null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2.5 h-[30px] w-full">
      <path d={area} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(n - 1)} cy={Y(vals[n - 1])} r={2} fill={color} />
    </svg>
  );
}

function useWidth(initial = 600) {
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

// Estimated tooltip box (for edge clamp/flip); the card is small + fixed-ish.
const TIP_W = 168;
const TIP_H = 122;
const NICE_STEPS = [1, 2, 7, 14, 30, 60, 90];

function TrendChart({ dense }: { dense: UsageSeriesPoint[] }) {
  const [metric, setMetric] = useState<MetricKey>("words");
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const [ref, w] = useWidth();
  const H = 200;
  const pad = { l: 46, r: 12, t: 14, b: 24 };
  const plotW = w - pad.l - pad.r;

  const pts = useMemo(() => dense.slice(-range), [dense, range]);
  const vals = useMemo(() => pts.map((p) => valOf(p, metric)), [pts, metric]);
  const n = pts.length;
  const niceTop = useMemo(() => niceMax(Math.max(0, ...vals)), [vals]);
  const { d, area, X, Y } = useMemo(() => linePath(vals, w, H, pad, niceTop), [vals, w, niceTop]);

  const allZero = vals.every((v) => v === 0);
  const peak = vals.length ? Math.max(...vals) : 0;
  const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const gridY = [0, 1, 2, 3].map((g) => ({ y: pad.t + (H - pad.t - pad.b) * (1 - g / 3), v: (niceTop * g) / 3 }));

  // X ticks: a "nice" day stride anchored on today (always a tick), real dates.
  const { idx: xIdx, step: xStep } = useMemo(() => {
    if (n === 0) return { idx: [] as number[], step: 1 };
    const target = Math.max(3, Math.min(6, Math.floor(plotW / 76)));
    const span = n - 1;
    const step = NICE_STEPS.find((s) => span / s <= target) ?? 90;
    const idx: number[] = [];
    for (let i = n - 1; i >= 0; i -= step) idx.unshift(i);
    if (idx.length && idx[0] > step * 0.5) idx.unshift(0);
    return { idx, step };
  }, [n, plotW]);
  const useMonth = xStep >= 30;

  // The capture rect spans exactly the plot area, so the pointer's fraction
  // across it maps straight to a data index.
  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    setHover(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))));
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
  // Tooltip position within the plot wrapper (svg is inset by its px-3 / pt-1 padding).
  const OFFX = 12;
  const OFFY = 4;
  let tipLeft = OFFX + (hp ? X(hover!) : 0) - TIP_W / 2;
  tipLeft = Math.max(4, Math.min(w + OFFX * 2 - TIP_W - 4, tipLeft));
  let tipTop = OFFY + (hp ? Y(vals[hover!]) : 0) - TIP_H - 12;
  if (tipTop < 2) tipTop = OFFY + (hp ? Y(vals[hover!]) : 0) + 16;

  return (
    <Card className="mt-3.5">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3.5">
        <span className="font-mono text-[11px] uppercase tracking-label text-faint">Usage over time</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Segmented
            value={metric}
            onChange={(v) => setMetric(v as MetricKey)}
            options={[
              { value: "words", label: "words" },
              { value: "audio", label: "minutes" },
              { value: "requests", label: "dictations" },
              { value: "errors", label: "errors" },
            ]}
          />
          <Segmented
            value={String(range)}
            onChange={(v) => setRange(Number(v))}
            options={[
              { value: "7", label: "7d" },
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
            ]}
          />
        </div>
      </div>

      <div ref={ref} className="relative px-3 pb-3 pt-1">
        {allZero ? (
          <div className="grid h-[200px] place-items-center text-[13px] text-faint">
            No usage in the last {range} days
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${w} ${H}`}
              width="100%"
              height={H}
              className="block focus:outline-none"
              tabIndex={0}
              role="img"
              aria-label={`Usage over time — ${METRIC[metric].label} per day, last ${range} days. Peak ${tick(metric, peak)}, average ${tick(metric, avg)}.`}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              <defs>
                <linearGradient id="usageGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--c-accent)" stopOpacity={0.26} />
                  <stop offset="1" stopColor="var(--c-accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              {gridY.map((g, i) => (
                <g key={i}>
                  <line x1={pad.l} y1={g.y} x2={w - pad.r} y2={g.y} stroke="var(--c-line)" strokeWidth={1} />
                  <text x={pad.l - 8} y={g.y + 3} textAnchor="end" className="font-mono" fontSize={10} fill="var(--c-faint)">
                    {tick(metric, g.v)}
                  </text>
                </g>
              ))}
              <path d={area} fill="url(#usageGrad)" />
              <path d={d} fill="none" stroke="var(--c-accent)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              {/* today / end dot — hollow when there's no usage today yet */}
              <circle
                cx={X(n - 1)}
                cy={Y(vals[n - 1])}
                r={4}
                fill={vals[n - 1] === 0 ? "var(--c-bg)" : "var(--c-accent)"}
                stroke="var(--c-accent)"
                strokeWidth={2}
              />
              {xIdx.map((i, k) => (
                <text
                  key={i}
                  x={X(i)}
                  y={H - 7}
                  textAnchor={k === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                  className="font-mono"
                  fontSize={10}
                  fill="var(--c-faint)"
                >
                  {i === n - 1 ? "today" : fmtDateTick(pts[i].day, useMonth)}
                </text>
              ))}
              {hp && (
                <g style={{ pointerEvents: "none" }}>
                  <line x1={X(hover!)} x2={X(hover!)} y1={pad.t} y2={H - pad.b} stroke="var(--c-line-strong)" strokeWidth={1} />
                  <circle cx={X(hover!)} cy={Y(vals[hover!])} r={4.5} fill="var(--c-accent)" stroke="var(--c-bg)" strokeWidth={2} />
                </g>
              )}
              {/* capture overlay — last child so it's on top */}
              <rect
                x={pad.l}
                y={pad.t}
                width={Math.max(0, plotW)}
                height={H - pad.t - pad.b}
                fill="transparent"
                style={{ cursor: "crosshair", touchAction: "none" }}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
              />
            </svg>

            {hp && (
              <div
                className="pointer-events-none absolute z-20 min-w-[120px] rounded-[10px] border border-line-strong bg-surface/95 px-3 py-2 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)] backdrop-blur-sm"
                style={{ left: tipLeft, top: tipTop }}
              >
                <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-label text-faint">{fmtDateFull(hp.day)}</div>
                {METRIC_KEYS.map((k) => (
                  <div key={k} className="flex items-baseline justify-between gap-6 text-[12px] leading-relaxed">
                    <span className={k === metric ? "text-text" : "text-dim"}>{METRIC[k].label}</span>
                    <span className={"font-num " + (k === metric ? "font-semibold text-accent" : "text-text")}>
                      {METRIC[k].fmt(valOf(hp, k))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="sr-only" aria-live="polite">
              {hp ? `${fmtDateFull(hp.day)}: ${METRIC[metric].fmt(vals[hover!])} ${METRIC[metric].label}` : ""}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-5 px-4 pb-3.5 text-[12px] text-dim">
        <span className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-4 rounded bg-accent" />
          {METRIC[metric].label} / day
        </span>
        {!allZero && (
          <>
            <span>peak <b className="font-num font-semibold text-text">{tick(metric, peak)}</b></span>
            <span>avg <b className="font-num font-semibold text-text">{tick(metric, avg)}</b></span>
          </>
        )}
      </div>
    </Card>
  );
}

function StatTile({ tile, stats, dense, spark }: { tile: (typeof TILES)[number]; stats: UsageStats; dense: UsageSeriesPoint[]; spark: boolean }) {
  const Icon = tile.icon;
  const todayVal = tile.today(stats.today);
  const isErr = tile.key === "errors";
  const todayColor =
    isErr
      ? stats.today.errors > 0
        ? "text-warn"
        : "text-ok"
      : tile.key === "words"
        ? "text-accent"
        : "text-text";
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-label text-faint">
        <Icon className="size-3.5 opacity-80" />
        {tile.label}
      </div>
      <div className={"mt-2.5 font-num text-[26px] font-semibold leading-none " + todayColor}>{todayVal}</div>
      <div className="mt-2 text-[12px] text-dim">
        <span className="text-[10px] uppercase tracking-label text-faint">today</span>
        {" · "}
        <span className="font-num text-text">{tile.total(stats.total)}</span> {tile.totalWord}
      </div>
      {spark && (
        <Sparkline
          vals={dense.slice(-30).map((p) => valOf(p, tile.key))}
          color={tile.key === "words" ? "var(--c-accent)" : isErr ? "var(--c-faint)" : "var(--c-dim)"}
        />
      )}
    </Card>
  );
}

export function UsageStatsSection({ backend }: { backend: Backend | undefined }) {
  const stats = useApp((s) => (backend ? s.usage[backend.id] : null));
  const layout = useApp((s) => s.settings.homeStatsLayout) ?? "chart";
  const updateSettings = useApp((s) => s.updateSettings);

  // Hidden until we have stats: a standard/old server (no /v1/usage) or not yet
  // fetched leaves this null/undefined — no empty box, no error.
  if (!stats) return null;
  const spark = layout === "sparklines";
  // Densify the sparse server series once (cheap, ≤90 days) for both surfaces.
  const dense = densify(stats.series);

  return (
    <section>
      <div className="mb-3 mt-10 flex items-center justify-between gap-3">
        <SectionLabel className="!m-0">Usage</SectionLabel>
        <Segmented
          value={layout}
          onChange={(v) => updateSettings({ homeStatsLayout: v as HomeStatsLayout })}
          options={[
            { value: "chart", label: "Chart" },
            { value: "sparklines", label: "Sparklines" },
          ]}
        />
      </div>
      <div className="grid grid-cols-4 gap-4">
        {TILES.map((t) => (
          <StatTile key={t.key} tile={t} stats={stats} dense={dense} spark={spark} />
        ))}
      </div>
      {!spark && <TrendChart dense={dense} />}
    </section>
  );
}
