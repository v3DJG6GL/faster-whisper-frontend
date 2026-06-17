// Home "Usage" section: four stat tiles (Words / Minutes / Dictations / Errors,
// today + all-time) plus a trend — either one shared chart (layout "chart") or a
// sparkline baked into each tile (layout "sparklines"), switched in the header
// and persisted via settings.homeStatsLayout. Reads the active backend's stats
// from the store (fed by lib/usage.ts); renders nothing when unsupported.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Clock, Mic, Type, TriangleAlert } from "lucide-react";
import { useApp } from "@/lib/store";
import { Card, SectionLabel, Segmented } from "@/components/ui";
import { fmtFull, fmtCompact, fmtDuration, fmtDurationAxis } from "@/lib/format";
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

const tick = (m: MetricKey, v: number) => (m === "audio" ? fmtDurationAxis(v) : fmtCompact(v));
const seriesVals = (series: UsageSeriesPoint[], m: MetricKey, last?: number) => {
  const v = series.map((p) => Number(p[FIELD[m]] ?? 0));
  return last ? v.slice(-last) : v;
};

/** Build an area+line path over `vals` in a w×h box (with padding). */
function linePath(vals: number[], w: number, h: number, pad: { l: number; r: number; t: number; b: number }) {
  const max = Math.max(1, ...vals);
  const n = vals.length;
  const X = (i: number) => pad.l + (w - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
  const Y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const area = n ? `${d} L ${X(n - 1).toFixed(1)} ${(h - pad.b).toFixed(1)} L ${X(0).toFixed(1)} ${(h - pad.b).toFixed(1)} Z` : "";
  return { d, area, X, Y, max, n };
}

function Sparkline({ vals, color }: { vals: number[]; color: string }) {
  const W = 132;
  const H = 30;
  const { d, area, X, Y, n } = linePath(vals, W, H, { l: 1, r: 1, t: 4, b: 2 });
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

function TrendChart({ series }: { series: UsageSeriesPoint[] }) {
  const [metric, setMetric] = useState<MetricKey>("words");
  const [range, setRange] = useState(30);
  const [ref, w] = useWidth();
  const H = 200;
  const pad = { l: 46, r: 10, t: 12, b: 22 };

  const vals = useMemo(() => seriesVals(series, metric, range), [series, metric, range]);
  const { d, area, X, Y, max, n } = linePath(vals, w, H, pad);
  const gridY = [0, 1, 2, 3].map((g) => pad.t + (H - pad.t - pad.b) * (1 - g / 3));
  const peak = vals.length ? Math.max(...vals) : 0;
  const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;

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
      <div ref={ref} className="px-3 pb-3 pt-1">
        <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} className="block">
          <defs>
            <linearGradient id="usageGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--c-accent)" stopOpacity={0.26} />
              <stop offset="1" stopColor="var(--c-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {gridY.map((y, g) => (
            <g key={g}>
              <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="var(--c-line)" strokeWidth={1} />
              <text x={pad.l - 8} y={y + 3} textAnchor="end" className="font-mono" fontSize={10} fill="var(--c-faint)">
                {tick(metric, (max * (3 - g)) / 3)}
              </text>
            </g>
          ))}
          {n > 0 && (
            <>
              <path d={area} fill="url(#usageGrad)" />
              <path d={d} fill="none" stroke="var(--c-accent)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={X(n - 1)} cy={Y(vals[n - 1])} r={4} fill="var(--c-accent)" stroke="var(--c-bg)" strokeWidth={2} />
            </>
          )}
          {[0, Math.floor((n - 1) / 2), n - 1].filter((i, k, a) => n > 0 && a.indexOf(i) === k).map((i, k, arr) => (
            <text
              key={i}
              x={X(i)}
              y={H - 6}
              textAnchor={k === 0 ? "start" : k === arr.length - 1 ? "end" : "middle"}
              className="font-mono"
              fontSize={10}
              fill="var(--c-faint)"
            >
              {k === arr.length - 1 ? "today" : `${range - Math.round((i / Math.max(1, n - 1)) * range)}d`}
            </text>
          ))}
        </svg>
      </div>
      <div className="flex items-center gap-5 px-4 pb-3.5 text-[12px] text-dim">
        <span className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-4 rounded bg-accent" />
          {metric === "audio" ? "minutes" : metric} / day
        </span>
        <span>peak <b className="font-num font-semibold text-text">{tick(metric, peak)}</b></span>
        <span>avg <b className="font-num font-semibold text-text">{tick(metric, avg)}</b></span>
      </div>
    </Card>
  );
}

function StatTile({ tile, stats, spark }: { tile: (typeof TILES)[number]; stats: UsageStats; spark: boolean }) {
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
          vals={seriesVals(stats.series, tile.key, 30)}
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
          <StatTile key={t.key} tile={t} stats={stats} spark={spark} />
        ))}
      </div>
      {!spark && <TrendChart series={stats.series} />}
    </section>
  );
}
