// The usage surfaces: the Home "Usage" strip (four sparkline tiles + small multiples
// by kind, off the fixed 30-day document) and the Statistics page (one filter bar —
// range · kind · with-stages — five tiles, the stacked columns by kind bucketed to the
// window, the Stages / Dictation / Rhythm / When-you-dictate panels, off the page's own
// document). Both read from the store (fed by lib/usage.ts) and render nothing when
// unsupported.
//
// Numbers come from lib/usageDerive.ts (pure, tested); this file only lays them out.
// The backend series is SPARSE (only days that had usage) — densified client-side into
// one point per calendar day so the charts plot against real dates and the 7/30/90
// ranges genuinely differ. Zero-dependency SVG; Intl for de-CH dates.
//
// Chart conventions (validated palette, see app.css): one colour per job kind, text
// imports hatched neutral; a 2 px surface gap between stacked segments; thin marks; all
// text in the text tokens, never a series colour; the legend is always present.

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Activity, ArrowRight, ChevronDown, ChevronUp, Clock, Cpu, Mic, Timer, Type, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "@/lib/store";
import { Card, SectionLabel, Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  fmtFull,
  fmtCompact,
  fmtDuration,
  fmtDurationAxis,
  fmtDurationExact,
  fmtDateTick,
  fmtDateFull,
  localTodayDay,
} from "@/lib/format";
import { TREND_DAYS, viewSignature, viewerTimeZone, yearPageQuery } from "@/lib/usage";
import { effectiveServerUrl } from "@/lib/backends";
import {
  CHART_METRICS,
  DOW_SHORT,
  KINDS,
  KIND_LABEL,
  KIND_VAR,
  METRIC_LABEL,
  METRIC_UNIT,
  QUARTER_NAME,
  RANGE_LABEL,
  RANGE_PRESETS,
  SCOPE_LABEL,
  STAGE_CHIP_LABEL,
  STAGE_KEYS,
  bucketMode,
  bucketize,
  calendarModel,
  dayToIso,
  densifyKinds,
  facetRows,
  translationRows,
  findStage,
  fmtTimeSaved,
  isDurationMetric,
  isFiltered,
  isoToDay,
  legendRanges,
  metricValue,
  niceMax,
  orderedStageRows,
  pct,
  presentKinds,
  rhythmModel,
  sumKinds,
  companionMetric,
  RHYTHMS,
  DOW_LONG,
  type Rhythm,
  resolveWindow,
  runsBreakdown,
  safeTotals,
  scopeTotals,
  spanPresets,
  stageAppliesToScope,
  streakFor,
  targetShares,
  timeSavedS,
  TYPING_WPM,
  weekColumns,
  zeroKinds,
  MAX_SPAN_DAYS,
  type BucketMode,
  type ChartMetric,
  type FacetRow,
  type RangePreset,
  type UsageBucket,
  type UsagePageQuery,
  type UsageScope,
} from "@/lib/usageDerive";
import { homeTargetProfile } from "@/lib/dictation";
import { ownProp } from "@/lib/own";
import { safeDisplayText } from "@/lib/sanitize";
import { BackendChips } from "@/components/BackendChips";
import type { UsageKind, UsageKinds, UsageSeriesPoint, UsageStageKey, UsageStats, UsageStreaks } from "@/lib/types";

const _spanDate = new Intl.DateTimeFormat("de-CH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const _monthYear = new Intl.DateTimeFormat("de-CH", { month: "long", year: "numeric", timeZone: "UTC" });
/** `1. Aug. 2026`, for the range pill and the custom-span popover. */
const fmtSpanDate = (day: number) => _spanDate.format(new Date(day * 86_400_000));
const fmtMonthYear = (day: number) => _monthYear.format(new Date(day * 86_400_000));

/* ── the measure's formatters: the two `_s` measures are durations, the rest counts ── */
const metricTick = (m: ChartMetric, v: number) => (isDurationMetric(m) ? fmtDurationAxis(v) : fmtCompact(v));
/** A value with its unit: `1,240 words` · `31h 12m` · `1 session`. */
function metricText(m: ChartMetric, v: number, compact = false): string {
  if (isDurationMetric(m)) return fmtDuration(v);
  const u = METRIC_UNIT[m] ?? ["", ""];
  return `${compact ? fmtCompact(v) : fmtFull(v)} ${Math.round(v) === 1 ? u[0] : u[1]}`;
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

/** Area+line path over `vals` in a w×h box, scaled to `max`. */
function linePath(vals: number[], w: number, h: number, pad: { l: number; r: number; t: number; b: number }, max: number) {
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
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2.5 h-[30px] w-full" aria-hidden="true">
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

/** The diagonal hatch the Text series is drawn in (neutral, never a volume story). */
function HatchDef({ id }: { id: string }) {
  return (
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4" height="4" fill="var(--c-surface-2)" />
      <rect width="1.6" height="4" fill="var(--c-chart-text)" />
    </pattern>
  );
}
const kindFill = (k: UsageKind, hatchId: string) => (k === "text" ? `url(#${hatchId})` : KIND_VAR[k]);

/** Legend swatch: a solid square, or the hatch for Text. */
function Swatch({ kind }: { kind: UsageKind }) {
  return (
    <i
      className="inline-block size-2.5 rounded-[3px]"
      style={
        kind === "text"
          ? { background: "repeating-linear-gradient(45deg, var(--c-chart-text) 0 2px, transparent 2px 4px)" }
          : { background: KIND_VAR[kind] }
      }
    />
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] uppercase tracking-label text-faint", className)}>{children}</span>;
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-pill border border-line px-2.5 py-0.5 font-mono text-[11px] text-dim">{children}</span>
  );
}

/** A panel card with the mockup's header row: eyebrow · spacer · right slot. */
function Panel({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("mt-3.5 px-4 pb-3 pt-3.5", className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <Eyebrow>{title}</Eyebrow>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </Card>
  );
}

/* ── tiles ───────────────────────────────────────────────────────────────── */

interface TileSpec {
  key: string;
  label: string;
  icon: typeof Type;
  value: string;
  tone: "dict" | "ok" | "warn";
  sub: ReactNode;
  spark: number[];
  sparkColor: string;
  /** The measure this tile mirrors (D35 A): clicking it measures the page in it. */
  metric?: ChartMetric;
  /** Time saved: a conclusion drawn from two measures, not a switch — spans two columns (D39 L1). */
  wide?: boolean;
}

const Num = ({ children }: { children: ReactNode }) => <span className="font-num text-text">{children}</span>;
/** The tile sub-line's "today" eyebrow (the only uppercased token on the line). */
const Today = () => <span className="text-[10px] uppercase tracking-label text-faint">today</span>;

const TILE_ICON: Record<ChartMetric, typeof Type> = { audio_s: Clock, words: Type, sessions: Mic, requests: Activity, proc_s: Cpu, errors: TriangleAlert };

/** The tile row for a scope: one tile per measure in measure order (Duration · Words ·
 *  Sessions · Requests · Processing Time · Errors), then Time saved, which is dictation-only
 *  by definition (the server's figure is too), whatever the scope. */
function tileSpecs(stats: UsageStats, dense: readonly UsageKinds[], scope: UsageScope, withSaved: boolean, windowWord = "total"): TileSpec[] {
  const today = scopeTotals(stats.today, scope);
  const total = scopeTotals(stats.total, scope);
  const last30 = dense.slice(-30);
  const spark = (f: (p: UsageKinds) => number) => last30.map(f);
  const wpm = Math.round(stats.dictation?.wpm ?? 0);
  const tiles: TileSpec[] = CHART_METRICS.map((m) => {
    const dur = isDurationMetric(m);
    const sub =
      m === "sessions" && scope === "all" ? (
        <><Today /> · <Num>{runsBreakdown(stats.today)}</Num></>
      ) : m === "errors" ? (
        <><Today /> · <Num>{fmtFull(total.errors)}</Num> {windowWord}</>
      ) : (
        <><Today /> · <Num>{dur ? fmtDuration(metricValue(total, m)) : fmtCompact(metricValue(total, m))}</Num> {windowWord}</>
      );
    return {
      key: m,
      metric: m,
      label: METRIC_LABEL[m],
      icon: TILE_ICON[m],
      value: dur ? fmtDurationExact(metricValue(today, m)) : fmtFull(metricValue(today, m)),
      tone: m === "errors" ? (today.errors > 0 ? "warn" : "ok") : "dict",
      sub,
      spark: spark((p) => metricValue(scopeTotals(p, scope), m)),
      sparkColor: m === "errors" ? "var(--c-faint)" : "var(--c-accent)",
    };
  });
  if (withSaved) {
    const d = safeTotals(stats.today?.dictation);
    tiles.push({
      key: "saved", label: "Time saved", icon: Timer, value: fmtTimeSaved(timeSavedS(d.words, d.audio_s)), tone: "dict", wide: true,
      sub: (
        <>
          <Today /> · <Num>{fmtTimeSaved(stats.time_saved_s ?? 0)}</Num> {windowWord} · dictation only
          {wpm > 0 ? <> · <Num>{wpm} wpm</Num> spoken instead of <Num>{TYPING_WPM} wpm</Num> typed</> : <> · vs typing at <Num>{TYPING_WPM} wpm</Num></>}
        </>
      ),
      spark: spark((p) => timeSavedS(safeTotals(p.dictation).words, safeTotals(p.dictation).audio_s)), sparkColor: "var(--c-accent)",
    });
  }
  return tiles;
}

// "dict" is the Words tile: a figure about you, not about the Dictation kind, so it wears the
// Signal colour like the chip's readout (D27). Kind series keep --c-chart-* (kindFill).
const TONE: Record<TileSpec["tone"], string> = { dict: "text-accent", ok: "text-ok", warn: "text-warn" };

/** A stat tile. With `onPick` it is a button that sets the page's measure; the active one
 *  wears the accent border and says "shown" (D35 A). */
function StatTile({ tile, spark, active, onPick }: { tile: TileSpec; spark: boolean; active?: boolean; onPick?: () => void }) {
  const Icon = tile.icon;
  const body = (
    <>
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-label text-faint">
        <Icon className="size-3.5 shrink-0 opacity-80" />
        <span className="truncate">{tile.label}</span>
        {active && <span className="ml-auto shrink-0 text-[9.5px] text-accent">shown</span>}
      </div>
      <div className={cn("mt-2.5 truncate font-num text-[26px] font-semibold leading-none", TONE[tile.tone])}>{tile.value}</div>
      <div className="mt-2 text-[12px] text-dim">{tile.sub}</div>
      {spark && <Sparkline vals={tile.spark} color={tile.sparkColor} />}
    </>
  );
  const base = "relative min-w-0 rounded-card border bg-surface/80 p-4 text-left backdrop-blur-sm";
  if (onPick) {
    return (
      <button
        type="button"
        onClick={onPick}
        aria-pressed={!!active}
        title={active ? `Every chart measures ${tile.label}` : `Measure ${tile.label} on every chart`}
        className={cn(base, "ring-signal w-full transition-colors", active ? "border-accent" : "border-line hover:border-line-strong")}
      >
        {body}
      </button>
    );
  }
  return <div className={cn(base, "border-line", tile.wide && "col-span-2")}>{body}</div>;
}

/* ── stacked columns by kind ─────────────────────────────────────────────── */

const TIP_W = 176;

const BUCKET_WORD: Record<BucketMode, string> = { day: "day", week: "week", month: "month" };

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

function StackedChart({ buckets, mode, scope, metric }: { buckets: UsageBucket[]; mode: BucketMode; scope: UsageScope; metric: ChartMetric }) {
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

/* ── stages ──────────────────────────────────────────────────────────────── */

/** Window runs per kind: the densified series summed. */
function windowKinds(dense: readonly UsageKinds[]): UsageKinds {
  const out = zeroKinds();
  for (const p of dense) {
    for (const k of ["all", ...KINDS] as const) {
      const t = safeTotals(p[k]);
      out[k].sessions += t.sessions;
      out[k].words += t.words;
      out[k].audio_s += t.audio_s;
      out[k].errors += t.errors;
      out[k].requests += t.requests;
      out[k].proc_s += t.proc_s;
    }
  }
  return out;
}

function StagesPanel({ stats, dense, scope, withS, rangeWord }: { stats: UsageStats; dense: readonly UsageKinds[]; scope: UsageScope; withS: readonly UsageStageKey[]; rangeWord: string }) {
  const win = windowKinds(dense);
  const media = win.file.sessions + win.url.sessions;
  const narrowed = withS.length > 0;
  return (
    <Panel
      title={`Stages · share of sessions that used them, ${rangeWord}`}
      right={<><Pill>{fmtFull(media)} file &amp; link sessions · {fmtFull(win.dictation.sessions)} dictations</Pill><Pill>counts sessions</Pill></>}
    >
      <div>
        {orderedStageRows(withS).map((row) => {
          const pinned = withS.includes(row.key);
          if (!stageAppliesToScope(row.key, scope)) {
            return (
              <div key={row.key} className="grid grid-cols-[160px_1fr] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px]">
                <div className="flex items-center gap-2 text-dim">
                  <i className="inline-block size-2 rounded-full" style={{ background: "var(--c-line-strong)" }} />
                  {row.label}
                </div>
                <div className="text-faint">Files and links only — {SCOPE_LABEL[scope].toLowerCase()} sessions never use it.</div>
              </div>
            );
          }
          const st = findStage(stats.stages, row.key);
          if (!st) {
            return (
              <div key={row.key} className="grid grid-cols-[160px_1fr] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px]">
                <div className="flex items-center gap-2 text-dim">
                  <i className="inline-block size-2 rounded-full" style={{ background: "var(--c-line-strong)" }} />
                  {row.label}
                </div>
                <div className="text-faint">Not used in {rangeWord}. {row.emptyCopy}</div>
              </div>
            );
          }
          const share = pct(st.runs, st.of_runs);
          const runsWord = row.key === "translating" ? "sessions" : "file sessions";
          let detail: ReactNode;
          if (row.key === "translating") {
            detail = <>avg <Num>+{(st.secs / st.runs).toFixed(1)} s</Num> / run</>;
          } else if (row.key === "diarizing") {
            detail = (
              <>
                RTF <Num>{st.audio_s > 0 ? (st.secs / st.audio_s).toFixed(2) : "–"}</Num>
                {st.speakers_avg != null && <> · avg <Num>{st.speakers_avg.toFixed(1)}</Num> speakers</>}
              </>
            );
          } else if (row.key === "vad") {
            detail = st.retained_avg != null ? <><Num>{Math.round((1 - st.retained_avg) * 100)} %</Num> of audio skipped</> : <>RTF <Num>{st.audio_s > 0 ? (st.secs / st.audio_s).toFixed(2) : "–"}</Num></>;
          } else {
            detail = <>RTF <Num>{st.audio_s > 0 ? (st.secs / st.audio_s).toFixed(2) : "–"}</Num></>;
          }
          const targets = row.key === "translating" ? targetShares(st) : [];
          const kept = row.key === "translating" ? (st.kept_original ?? 0) : 0;
          return (
            <div key={row.key} className="grid grid-cols-[160px_1fr_110px_150px] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px] max-[820px]:grid-cols-2">
              <div className="flex items-center gap-2 font-semibold text-text">
                <i className="inline-block size-2 rounded-full" style={{ background: row.colorVar }} />
                {row.label}
                {pinned && <span className="rounded-pill border border-line px-1.5 font-mono text-[9.5px] font-normal uppercase tracking-label text-faint">filter</span>}
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-line">
                  <i className="block h-full rounded-pill" style={{ width: `${share}%`, background: row.colorVar }} />
                </div>
                <span className="w-[120px] font-num text-[12px] text-text">
                  {share} % · {fmtFull(st.runs)} {runsWord}
                </span>
              </div>
              <div className="text-dim"><Num>{fmtDuration(st.audio_s)}</Num> audio</div>
              <div className="text-dim">{detail}</div>
              {(targets.length > 0 || kept > 0 || (narrowed && !pinned)) && (
                <div className="col-start-2 col-end-[-1] -mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
                  {narrowed && !pinned && <span>of the filtered sessions, {share} % were also {STAGE_CHIP_LABEL[row.key].toLowerCase()} ·</span>}
                  {targets.map((t) => (
                    <span key={t.code} className="rounded-pill border border-line px-2 py-px font-mono text-[11px] text-dim">
                      {safeDisplayText(t.code)} {t.pct} %
                    </span>
                  ))}
                  {kept > 0 && <span>· {fmtFull(kept)} kept original (timeout)</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ── dictation facets ────────────────────────────────────────────────────── */

function HBars({ title, rows, empty }: { title: string; rows: FacetRow[]; empty?: ReactNode }) {
  return (
    <div>
      <Eyebrow className="mb-2 block">{title}</Eyebrow>
      {rows.length === 0 && empty ? (
        <div className="text-[12px] text-faint">{empty}</div>
      ) : (
        rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[96px_1fr_44px] items-center gap-2 py-[3px] text-[12px] text-dim">
            <span className="truncate" title={r.title ?? r.label}>{r.label}</span>
            <div className="h-2 overflow-hidden rounded-pill bg-line">
              <i className="block h-full rounded-pill" style={{ width: `${r.pct}%`, background: r.dim ? "var(--c-faint)" : (r.colorVar ?? "var(--c-accent)") }} />
            </div>
            <span className="text-right font-num text-text">{fmtCompact(r.value)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function DictationPanel({ stats, scope }: { stats: UsageStats; scope: UsageScope }) {
  const d = stats.dictation;
  const reportApp = useApp((s) => s.settings.recording.reportTargetApp !== false);
  // Files / Links / Text: the facets do not apply; one line, expandable, so the page's
  // shape stays put while the filter says what it says.
  const collapsible = scope !== "all" && scope !== "dictation";
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope]);
  if (collapsible && !open) {
    return (
      <Card className="mt-3.5 flex flex-wrap items-center gap-2.5 px-4 py-3">
        <Eyebrow>Dictation</Eyebrow>
        <span className="text-[12.5px] text-faint">Dictation details apply to dictation sessions.</span>
        <button type="button" onClick={() => setOpen(true)} className="ring-signal rounded-md px-1 text-[12.5px] text-dim underline underline-offset-4 hover:text-text">
          show
        </button>
      </Card>
    );
  }
  const act = d?.activation ?? { hold: 0, handsfree: 0 };
  const del = d?.delivery ?? { typed: 0, clipboard: 0, none: 0, unreported: 0 };
  const apps = (stats.apps ?? [])
    .filter((a) => a && typeof a.app_id === "string")
    .slice(0, 4)
    .map((a) => ({ label: safeDisplayText(a.app_id) || "unknown", value: a.sessions }));
  return (
    <Panel
      title="Dictation"
      right={
        <>
          <Pill>{fmtFull(d?.sessions ?? 0)} sessions</Pill>
          <Pill>counts sessions</Pill>
          {collapsible && (
            <button type="button" onClick={() => setOpen(false)} className="ring-signal rounded-md px-1 text-[12px] text-faint underline underline-offset-4 hover:text-text">
              hide
            </button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <HBars
          title="Activation"
          rows={facetRows([
            { label: "Push-to-talk", value: act.hold },
            { label: "Hands-free", value: act.handsfree },
          ])}
        />
        <HBars
          title="Landed as"
          rows={facetRows([
            { label: "Typed", value: del.typed },
            { label: "Clipboard", value: del.clipboard },
            { label: "Nothing", value: del.none, dim: true },
            ...(del.unreported > 0 ? [{ label: "Unreported", value: del.unreported, dim: true }] : []),
          ])}
        />
        <HBars
          title="Typed into"
          rows={facetRows(apps, true)}
          empty={reportApp ? "No app names yet — they appear once a dictation lands." : "Off — “Report the app I dictate into” is turned off in Settings."}
        />
        <HBars title="Translated into" rows={translationRows(d ?? {})} />
      </div>
    </Panel>
  );
}

/* ── the calendar + the busy panel ────────────────────────────────── */

/* ── the per-kind tooltip (D31 T3 / D33): present kinds, a split bar, the total ── */

function KindTip({ title, kinds, metric, scope, total, quarter, extra, companion }: {
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
                <i key={r.kind} className="block h-full" style={{ width: `${(r.value / total) * 100}%`, background: r.kind === "text" ? "var(--c-chart-text)" : KIND_VAR[r.kind] }} />
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

/* ── cell tooltip: instant, follows the cursor or the focused cell ───────── */

interface CellTipState { i: number; x: number; y: number }

/** Delegated hover + focus for a grid of level cells. Cells carry `data-i`; the wrapper is
 *  `relative`. The panel resolves `i` against its model and renders the content. */
function useCellTip() {
  const [tip, setTip] = useState<CellTipState | null>(null);
  const at = (host: HTMLDivElement, el: HTMLElement, cx: number, cy: number) => {
    const box = host.getBoundingClientRect();
    setTip({ i: Number(el.dataset.i), x: cx - box.left + host.scrollLeft, y: cy - box.top + host.scrollTop });
  };
  const onMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (!el?.dataset.i) { setTip(null); return; }
    at(e.currentTarget, el, e.clientX, e.clientY);
  }, []);
  const onLeave = useCallback(() => setTip(null), []);
  // Keyboard (D34): the tooltip sits over the focused cell's centre.
  const onFocus = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (!el?.dataset.i) return;
    const r = el.getBoundingClientRect();
    at(e.currentTarget, el, r.left + r.width / 2, r.top + r.height / 2);
  }, []);
  const onBlur = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTip(null);
  }, []);
  return { tip, onMove, onLeave, onFocus, onBlur };
}

/** The floating shell: measured after render so a multi-line tip flips and clamps by its
 *  real size; above the anchor, or below it near the top so a scrolling wrapper does not clip. */
function CellTip({ tip, boundsRef, children }: { tip: CellTipState | null; boundsRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
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

/** Roving tabindex for a grid of `data-i` cells (D34): one tab stop, the arrow keys move by
 *  `dx` (left/right) and `dy` (up/down) indexes, Home/End jump. */
function useRovingGrid(count: number, dx: number, dy: number) {
  const [focusIdx, setFocusIdx] = useState(0);
  useEffect(() => { if (focusIdx >= count) setFocusIdx(0); }, [count, focusIdx]);
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (!el?.dataset.i || count === 0) return;
    const i = Number(el.dataset.i);
    const step = e.key === "ArrowLeft" ? -dx : e.key === "ArrowRight" ? dx : e.key === "ArrowUp" ? -dy : e.key === "ArrowDown" ? dy : e.key === "Home" ? -i : e.key === "End" ? count - 1 - i : null;
    if (step === null) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(count - 1, i + step));
    const target = e.currentTarget.querySelector<HTMLElement>(`[data-i="${next}"]`);
    if (target) { setFocusIdx(next); target.focus(); }
  }, [count, dx, dy]);
  return { focusIdx, onKeyDown };
}

/** The hovered / focused cell's highlight, driven from the tooltip's index rather than
 *  `:hover`: Tailwind v4 wraps every hover utility in `@media (hover: hover)`, which
 *  WebKitGTK does not always report, and a ring (box-shadow) cannot be undone by the
 *  cells' `outline-none`. */
const CELL_HOT = "z-10 ring-2 ring-text ring-offset-1 ring-offset-panel";

const CELL_HOVER = "hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-text relative hover:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text focus-visible:z-10";

const LEVEL_BG = ["var(--c-surface-2)", "var(--c-cal-1)", "var(--c-cal-2)", "var(--c-cal-3)", "var(--c-cal-4)"] as const;

/** The five labelled steps: swatch, value range, count. Shared by both grids. */
function LevelLegend({ lead, breaks, counts, unit, metric }: { lead: string; breaks: [number, number, number]; counts: readonly number[]; unit: [string, string]; metric: ChartMetric }) {
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

/** The calendar is always the last 12 months (its own year document, or the page's when
 *  that already spans a year), whatever range the page shows: a week of squares says
 *  nothing and its quartiles less. The page's range is MARKED on it instead — days outside
 *  it are dimmed — so the strip also shows where the filter sits. */
function CalendarPanel({ dense, streaks, scope, withS, from, to, mark, filtered, metric, stale }: {
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
          <div className="grid h-full grid-rows-[repeat(7,1fr)] gap-[3px]" style={{ gridRow: 2, gridColumn: 1 }}>
            {DOW_SHORT.map((d, i) => (
              <div key={d} className="flex items-center justify-end pr-1.5 font-mono text-[10.5px] text-faint">
                {i % 2 === 0 ? d : ""}
              </div>
            ))}
          </div>
          {cols.map((c) => (
            <div key={c.monday} className="grid gap-[3px]" style={{ gridRow: 2 }}>
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

/** The busy panel (D40 R1 / D41 N1): one grid, three rhythms — weekday × hour, day of month ×
 *  hour (the backend's geometry, D42 A2), year × month — for the page's measure, with side
 *  bars against a flat distribution (D43 M1), a peak line (D44 P1) and per-kind tooltips
 *  that pair the measure with sessions (D45 C1). The rhythm is the panel's own state
 *  (`?rhythm=`): it changes this panel, the measure changes every panel. */
function BusyPanel({ stats, dense, scope, title, metric, rhythm, onRhythm, from, to }: {
  stats: UsageStats;
  dense: readonly UsageSeriesPoint[];
  scope: UsageScope;
  title: string;
  metric: ChartMetric;
  rhythm: Rhythm;
  onRhythm: (r: Rhythm) => void;
  from: number;
  to: number;
}) {
  const model = useMemo(
    () => rhythmModel(rhythm, { hours: stats.hours, dom_hours: stats.dom_hours, series: dense }, scope, metric, from, to),
    [rhythm, stats.hours, stats.dom_hours, dense, scope, metric, from, to],
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
    if (i < N) {
      const c = model.cells[i];
      if (!c) return null;
      const occ = model.occOf(c);
      const extra: [string, string][] = [];
      if (c.value > 0 && occ > 1) extra.push([`≈ ${metricText(metric, c.value / occ, true)} per ${model.occWord(c)}`, `${fmtFull(occ)} ${rhythm === "hours" ? `${model.occWord(c)}s` : "months"} in range`]);
      return { title: L.cellName(i), kinds: c.kinds, total: c.value, quarter: c.level ? QUARTER_NAME[c.level] : undefined, extra };
    }
    if (i < N + L.cols) {
      const col = i - N;
      const v = model.colTotals[col];
      const extra: [string, string][] = [["share", share(v)], ["vs average", `${model.colIndex[col].toFixed(1)}× an average ${L.colUnit}`]];
      const days = to - from + 1;
      if (rhythm === "hours" && v > 0 && days > 1) extra.push([`≈ ${metricText(metric, v / days, true)} per day`, `${fmtFull(days)} days in range`]);
      const occ = L.colOcc?.[col] ?? 1;
      if (rhythm === "days" && v > 0 && occ > 1) extra.push([`≈ ${metricText(metric, v / occ, true)} per month`, `${fmtFull(occ)} months in range`]);
      return { title: `${L.colLong(col)} · every ${L.rowUnit}`, kinds: sumKinds(model.cells.filter((c) => c.col === col)), total: v, quarter: undefined, extra };
    }
    const row = i - N - L.cols;
    const v = model.rowTotals[row];
    const extra: [string, string][] = [["share", share(v)], ["vs average", `${model.rowIndex[row].toFixed(1)}× an average ${L.rowUnit}`]];
    const first = model.cells[row * L.cols];
    const occ = first ? model.occOf(first) : 1;
    if (rhythm === "hours" && v > 0 && occ > 1) extra.push([`≈ ${metricText(metric, v / occ, true)} per ${DOW_LONG[row]}`, `${fmtFull(occ)} ${DOW_LONG[row]}s in range`]);
    return { title: `${L.rowLong(row)} · all ${L.colUnit}s`, kinds: sumKinds(model.cells.slice(row * L.cols, row * L.cols + L.cols)), total: v, quarter: undefined, extra };
  }, [tip, model, L, N, metric, rhythm, from, to]);
  // Arrow keys move between cells only; the bars are plain tab stops.
  const keys = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (el && Number(el.dataset.i) >= N) return;
    onKeyDown(e);
  }, [N, onKeyDown]);
  const cMax = Math.max(1, ...model.colIndex);
  const rMax = Math.max(1, ...model.rowIndex);
  const barLen = (idx: number, max: number) => (idx > 0 ? Math.max(6, (idx / max) * 100) : 0).toFixed(1);
  const barBg = (idx: number) => (idx > 1 ? "var(--c-accent)" : "var(--c-line-strong)");
  const cellClass = rhythm === "hours" ? "aspect-square max-h-[20px]" : rhythm === "days" ? "h-[11px]" : "h-[22px]";
  const tz = stats.tz === "local" ? "server time" : stats.tz;
  const peakOcc = peak ? model.occOf(peak) : 0;
  // The two average ticks are drawn once across each track (a per-cell dash would break
  // at every grid gap): measured from the first and last bar of each track after layout.
  const [ticks, setTicks] = useState<{ top: { x1: number; x2: number; y: number }; side: { x: number; y1: number; y2: number } } | null>(null);
  useLayoutEffect(() => {
    const host = boundsRef.current;
    if (!host) { setTicks(null); return; }
    const measure = () => {
      const box = host.getBoundingClientRect();
      const tops = host.querySelectorAll<HTMLElement>('[data-track="top"]');
      const sides = host.querySelectorAll<HTMLElement>('[data-track="side"]');
      if (!tops.length || !sides.length) { setTicks(null); return; }
      const t0 = tops[0].getBoundingClientRect();
      const t1 = tops[tops.length - 1].getBoundingClientRect();
      const s0 = sides[0].getBoundingClientRect();
      const s1 = sides[sides.length - 1].getBoundingClientRect();
      const next = {
        top: { x1: t0.left - box.left, x2: t1.right - box.left, y: t0.bottom - box.top - t0.height / cMax },
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
      <div className="mb-2.5 truncate font-mono text-[11.5px] text-dim" title={peak ? `${metricText(metric, peak.value)} in the busiest ${rhythm === "hours" ? "slot" : rhythm.slice(0, -1)}, ${L.cellName(peak.row * L.cols + peak.col)}${peakOcc > 1 ? `, summed over ${fmtFull(peakOcc)} ${rhythm === "hours" ? `${model.occWord(peak)}s` : "months"} in the range` : ""}` : undefined}>
        {peak ? (
          <>
            Peak {L.cellName(peak.row * L.cols + peak.col)} · <b className="font-semibold text-text">{metricText(metric, peak.value)}</b>
            {peakOcc > 1 && ` · ≈ ${metricText(metric, peak.value / peakOcc, true)} per ${model.occWord(peak)}`}
            {` · ${metricText(comp, peak.companion)}`}
            {model.phrase && <> · <span className="text-accent" title={`the smallest group holding 60 %+ of the ${label.toLowerCase()}`}>{model.phrase}</span></>}
          </>
        ) : (
          `No ${label.toLowerCase()} in this range`
        )}
      </div>
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
            {hov && <KindTip title={hov.title} kinds={hov.kinds} metric={metric} scope={scope} total={hov.total} quarter={hov.quarter} extra={hov.extra} companion={comp} />}
          </CellTip>
          <div
            className={cn("grid", rhythm === "days" ? "gap-[2px]" : "gap-[3px]")}
            style={{ gridTemplateColumns: `34px repeat(${L.cols}, minmax(0, 1fr)) 10px 30px` }}
            role="grid"
            aria-label={`${label} per ${L.slotWord}, levelled by quartiles of the active slots, with each ${L.colUnit} and ${L.rowUnit} against a flat ${L.flatWord}. Use the arrow keys to move between slots.`}
          >
            <div />
            {model.colIndex.map((idx, c) => (
              <div
                key={`t${c}`}
                data-i={N + c}
                tabIndex={0}
                role="img"
                aria-label={`${L.colLong(c)}: ${metricText(metric, model.colTotals[c])}, ${idx.toFixed(1)} times an average ${L.colUnit}`}
                data-track="top"
                className={cn("relative flex h-[24px] items-end rounded-[2px] outline-none", CELL_HOVER, !(L.colOcc ? L.colOcc[c] > 0 : true) && "invisible", tip?.i === N + c && CELL_HOT)}
              >
                <i className="block w-full rounded-t-[2px]" style={{ height: `${barLen(idx, cMax)}%`, background: barBg(idx) }} />
              </div>
            ))}
            <div />
            <div />
            <div />
            {Array.from({ length: L.cols }, (_, c) => (
              <div key={`l${c}`} className="font-mono text-[10px] text-faint">{L.colLabel(c)}</div>
            ))}
            <div />
            <div />
            {Array.from({ length: L.rows }, (_, r) => (
              <Fragment key={r}>
                <div className="flex items-center font-mono text-[10.5px] text-faint">{L.rowLabel(r)}</div>
                {model.cells.slice(r * L.cols, r * L.cols + L.cols).map((c) => {
                  const i = r * L.cols + c.col;
                  return (
                    <i
                      key={c.col}
                      data-i={i}
                      tabIndex={i === focusIdx ? 0 : -1}
                      role="gridcell"
                      aria-label={`${L.cellName(i)}: ${c.value > 0 ? `${metricText(metric, c.value)} · ${metricText(comp, c.companion)}` : `no ${label.toLowerCase()}`}${c.level ? `, ${QUARTER_NAME[c.level]}` : ""}`}
                      className={cn("block w-full rounded-[3px] outline-none", cellClass, CELL_HOVER, peak === c && "ring-[1.5px] ring-inset ring-text", !c.inWindow && "invisible", tip?.i === i && CELL_HOT)}
                      style={{ background: LEVEL_BG[c.level] }}
                    />
                  );
                })}
                <div />
                <div
                  data-i={N + L.cols + r}
                  tabIndex={0}
                  role="img"
                  aria-label={`${L.rowLong(r)}: ${metricText(metric, model.rowTotals[r])}, ${model.rowIndex[r].toFixed(1)} times an average ${L.rowUnit}`}
                  data-track="side"
                  className={cn("relative flex items-center rounded-[2px] outline-none", CELL_HOVER, tip?.i === N + L.cols + r && CELL_HOT)}
                >
                  <i className="block h-[calc(100%-4px)] rounded-r-[2px]" style={{ width: `${barLen(model.rowIndex[r], rMax)}%`, background: barBg(model.rowIndex[r]) }} />
                </div>
              </Fragment>
            ))}
          </div>
          {ticks && (
            <>
              <i className="pointer-events-none absolute border-t border-dashed border-line-strong" style={{ left: ticks.top.x1, width: ticks.top.x2 - ticks.top.x1, top: ticks.top.y }} aria-hidden />
              <i className="pointer-events-none absolute border-l border-dashed border-line-strong" style={{ left: ticks.side.x, top: ticks.side.y1, height: ticks.side.y2 - ticks.side.y1 }} aria-hidden />
            </>
          )}
        </div>
      )}
      {model.sent === "yes" && (
        <>
          <LevelLegend lead={`${label} per ${L.slotWord} · quarters of your active slots`} breaks={model.breaks} counts={model.counts} unit={["slot", "slots"]} metric={metric} />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            <span><i className="mr-1.5 inline-block h-2 w-3 rounded-[1px] bg-line-strong align-[-1px]" aria-hidden />side bars: each {L.colUnit} (top) and {L.rowUnit} (right) against a flat {L.flatWord} · dashed tick = average</span>
            <span className="ml-auto">{tz}</span>
          </div>
        </>
      )}
    </Panel>
  );
}

/* ── the filter bar ──────────────────────────────────────────────────────── */

const STAGE_DOT: Record<UsageStageKey, string> = {
  translating: "var(--c-translate)",
  diarizing: "var(--c-diarize)",
  separating: "var(--c-separate)",
  vad: "var(--c-think)",
};

function CustomSpanPopover({ from, to, today, onApply, onCancel }: { from: number; to: number; today: number; onApply: (from: number, to: number) => void; onCancel: () => void }) {
  const [f, setF] = useState(dayToIso(from));
  const [t, setT] = useState(dayToIso(to));
  const fd = isoToDay(f);
  const td = isoToDay(t);
  const ok = fd !== undefined && td !== undefined && fd <= td && td - fd < MAX_SPAN_DAYS;
  const days = ok ? td - fd + 1 : 0;
  const mode = ok ? bucketMode(days) : "day";
  return (
    <div className="mt-2.5 w-max max-w-full rounded-[12px] border border-line-strong bg-surface p-3.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)]" role="dialog" aria-label="Custom range">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 font-mono text-[10.5px] uppercase tracking-label text-faint">
          From
          <input type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} className="ring-signal rounded-[8px] border border-line-strong bg-panel px-2 py-1 font-mono text-[12.5px] normal-case tracking-normal text-text" />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10.5px] uppercase tracking-label text-faint">
          To
          <input type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} className="ring-signal rounded-[8px] border border-line-strong bg-panel px-2 py-1 font-mono text-[12.5px] normal-case tracking-normal text-text" />
        </label>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {spanPresets(today).map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setF(dayToIso(p.from));
              setT(dayToIso(p.to));
            }}
            className="ring-signal rounded-pill border border-line-strong px-2.5 py-0.5 text-[12px] text-dim hover:text-text"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-[11.5px] text-faint">
        <span>{ok ? `${days} ${days === 1 ? "day" : "days"} · shown by ${BUCKET_WORD[mode]}` : "Pick a start on or before the end, at most 10 years apart."}</span>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="ring-signal rounded-pill border border-line-strong px-3 py-1 text-[12px] text-dim hover:text-text">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ok}
          onClick={() => ok && onApply(fd, td)}
          className="ring-signal rounded-pill bg-accent px-3 py-1 text-[12px] font-semibold text-accent-ink disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** True while the sentinel above the bar has scrolled out of the nearest scroll ancestor —
 *  i.e. the sticky bar is pinned. (`scroll-state()` container queries would do this in CSS,
 *  but WebKitGTK does not ship them.) */
function useStuck(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let root: HTMLElement | null = el.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { root, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, stuck];
}

/** One value on the condensed rail: eyebrow + value, a button that reopens the full bar. */
function RailChip({ label, accent, onClick, children }: { label: string; accent?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "ring-signal inline-flex items-center gap-1.5 rounded-pill border bg-surface-2 px-2.5 py-0.5 text-[12px] text-text transition-colors hover:border-line-strong",
        accent ? "border-accent" : "border-line",
      )}
    >
      <span className="font-mono text-[9.5px] uppercase tracking-label text-faint">{label}</span>
      {children}
    </button>
  );
}

/** The page's one filter bar: Range · Kind + With · Measure on three rows, pinned to the
 *  top of the scroll container. Once pinned it condenses to a one-line rail of the current
 *  values (D30 B); Edit or any chip reopens the full bar as an overlay beneath the rail, so
 *  the page does not reflow; Escape or a click outside closes it. */
function FilterBar({
  scope,
  onScope,
  query,
  onQuery,
  metric,
  onMetric,
  today,
  firstDay,
  retentionDays,
  stale,
}: {
  scope: UsageScope;
  onScope: (s: UsageScope) => void;
  query: UsagePageQuery;
  onQuery: (q: UsagePageQuery) => void;
  metric: ChartMetric;
  onMetric: (m: ChartMetric) => void;
  today: number;
  firstDay: number | null | undefined;
  retentionDays: number | undefined;
  stale: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [sentinelRef, stuck] = useStuck();
  const barRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Un-pinning shows the full bar inline again; the overlay has nothing left to do.
  useEffect(() => { if (!stuck) setOpen(false); }, [stuck]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!barRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const win = resolveWindow(query, today, firstDay);
  const pickRange = (r: RangePreset) => {
    if (r === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    onQuery({ range: r, with: query.with });
  };
  const toggleStage = (k: UsageStageKey) => {
    const set = new Set(query.with);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    onQuery({ ...query, with: STAGE_KEYS.filter((x) => set.has(x)) });
  };
  const anySet = isFiltered(scope, query) || query.range !== "30";
  const clearAll = () => {
    setCustom(false);
    onScope("all");
    onQuery({ range: "30", with: [] });
  };
  const spanText =
    query.range === "all"
      ? `${fmtSpanDate(win.from)} – ${fmtSpanDate(win.to)} · ${fmtFull(win.days)} days · since the first ${firstDay == null ? "run" : "dictation"}`
      : `${fmtSpanDate(win.from)} – ${fmtSpanDate(win.to)} · ${fmtFull(win.days)} ${win.days === 1 ? "day" : "days"}${query.range === "custom" ? " · custom" : ""}`;
  const rangeChip = query.range === "all" ? "All time" : query.range === "custom" ? `${fmtSpanDate(win.from)} – ${fmtSpanDate(win.to)}` : RANGE_LABEL[query.range];
  const clearButton = (
    <button type="button" onClick={clearAll} className="ring-signal rounded-md px-1 text-[12px] text-faint underline underline-offset-4 hover:text-text">
      Clear
    </button>
  );
  const row = "flex flex-wrap items-center gap-x-3.5 gap-y-2.5";
  const full = (
    <>
      <div className={row}>
        <Eyebrow>Range</Eyebrow>
        <Segmented
          value={custom ? "custom" : query.range}
          onChange={pickRange}
          ariaLabel="Range"
          options={RANGE_PRESETS.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
        />
        {/* While pinned, the rail's top line carries the span and Clear. */}
        {!stuck && (
          <span className="ml-auto flex items-center gap-2">
            {anySet && clearButton}
            <Pill>{spanText}</Pill>
          </span>
        )}
      </div>
      <div className={cn(row, "mt-2.5")}>
        <Eyebrow>Kind</Eyebrow>
        <Segmented
          value={scope}
          onChange={onScope}
          ariaLabel="Kind"
          options={(["all", ...KINDS] as UsageScope[]).map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
        />
        <Eyebrow>With</Eyebrow>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Stages every session must have used">
          {STAGE_KEYS.map((k) => {
            const on = query.with.includes(k);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStage(k)}
                className={cn(
                  "ring-signal inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-[12px] transition-colors",
                  on ? "border-solid border-line-strong bg-surface-2 text-text" : "border-dashed border-line-strong text-dim hover:text-text",
                )}
              >
                <i className="inline-block size-2 rounded-full" style={{ background: STAGE_DOT[k] }} />
                {STAGE_CHIP_LABEL[k]}
              </button>
            );
          })}
        </div>
      </div>
      <div className={cn(row, "mt-2.5")}>
        <Eyebrow>Measure</Eyebrow>
        <Segmented
          value={metric}
          onChange={onMetric}
          ariaLabel="Measure — what every chart counts"
          options={CHART_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
        />
      </div>
      {custom && (
        <CustomSpanPopover
          from={query.range === "custom" && query.from !== undefined ? query.from : win.from}
          to={query.range === "custom" && query.to !== undefined ? query.to : win.to}
          today={today}
          onApply={(from, to) => {
            setCustom(false);
            onQuery({ range: "custom", from, to, with: query.with });
          }}
          onCancel={() => setCustom(false)}
        />
      )}
      {query.with.length > 0 && (
        <div className="mt-2 text-[11.5px] text-faint">
          Stage filters cover the last {fmtFull(retentionDays || 365)} days: every number on this page now counts only sessions that were{" "}
          {query.with.map((k) => STAGE_CHIP_LABEL[k].toLowerCase()).join(" and ")}.
        </div>
      )}
    </>
  );
  // The whole top line toggles the full bar. Its buttons handle their own clicks — the
  // chips and Show / Hide toggle too, Clear clears — so the line ignores a click that
  // started on a button rather than toggling twice (or undoing a Clear's intent).
  const toggleBar = () => setOpen((o) => !o);
  const rail = (
    <div
      className="flex cursor-pointer flex-wrap items-center gap-2"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        toggleBar();
      }}
    >
      <RailChip label="Range" onClick={toggleBar}>{rangeChip}</RailChip>
      <RailChip label="Kind" onClick={toggleBar}>{SCOPE_LABEL[scope]}</RailChip>
      {query.with.length > 0 && (
        <RailChip label="With" onClick={toggleBar}>
          {query.with.map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <i className="inline-block size-2 rounded-full" style={{ background: STAGE_DOT[k] }} />
              {STAGE_CHIP_LABEL[k]}
            </span>
          ))}
        </RailChip>
      )}
      <RailChip label="Measure" accent onClick={toggleBar}>{METRIC_LABEL[metric]}</RailChip>
      {stale && <Pill>updating…</Pill>}
      {/* Top-right: the resolved span (the full bar's Range row shows it while open, so the
          rail drops it then) and the one button that opens / closes the full bar. Clear
          lives in the full bar only. */}
      <span className="ml-auto flex items-center gap-2">
        {/* Clear only while the full bar is open under the rail (its own Clear steps aside
            then), left of Hide: the collapsed rail is a readout, not a place to reset from. */}
        {open && anySet && clearButton}
        <Pill>{spanText}</Pill>
        <button
          type="button"
          onClick={toggleBar}
          aria-expanded={open}
          className="ring-signal inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface py-0.5 pl-2.5 pr-1.5 text-[12px] text-text transition-colors hover:bg-surface-2"
        >
          {/* "Show" and "Hide" differ by a pixel or two; a fixed label width keeps the
              button (and Clear beside it) from shifting on every toggle. */}
          <span className="inline-block w-[2.6em] text-left">{open ? "Hide" : "Show"}</span>
          {open ? <ChevronUp className="size-3.5 text-dim" aria-hidden /> : <ChevronDown className="size-3.5 text-dim" aria-hidden />}
        </button>
      </span>
    </div>
  );
  return (
    <>
      <div ref={sentinelRef} className="h-px" aria-hidden />
      <div
        ref={barRef}
        className="sticky top-0 z-30 mb-4"
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <div
          className={cn(
            "relative rounded-[12px] border border-line bg-surface/95 px-3 backdrop-blur-sm transition-shadow motion-reduce:transition-none",
            stuck ? "rounded-t-none border-t-transparent py-1.5 shadow-[0_14px_34px_-20px_rgba(0,0,0,0.7)]" : "py-2.5",
            // Open: the full bar hangs off this line's bottom edge, so its bottom corners
            // square off and its own bottom border goes — otherwise the rail's rounded
            // corners peek out above the panel underneath.
            stuck && open && "rounded-b-none border-b-transparent shadow-none",
          )}
        >
          {stuck ? rail : full}
          {stuck && open && (
            <div className="absolute inset-x-[-1px] top-full rounded-b-[12px] border border-t-0 border-line-strong bg-surface px-3 py-2.5 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.7)]">
              {full}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── view resolution ─────────────────────────────────────────────────────── */

/** Resolve which backends have usage stats, the currently-VIEWED one (the user's pick,
 *  defaulting to the dictation/home-target backend), the fixed 30-day series, and a
 *  setter. Shared by the Home strip + the Statistics page so they stay in sync. The chip
 *  readout is independent — it always follows the dictation backend (see lib/usage.ts). */
function useUsageView() {
  const backends = useApp((s) => s.backends);
  const usage = useApp((s) => s.usage);
  const profiles = useApp((s) => s.profiles);
  const homeProfileId = useApp((s) => s.settings.homeProfileId);
  const viewId = useApp((s) => s.usageViewBackendId);
  const setView = useApp((s) => s.setUsageViewBackend);

  // Own-property reads throughout: a backend id of `constructor`/`toString`/… reads a function
  // off `Object.prototype`, which is truthy here and then hits `stats.series` undefined — a
  // throw in a render body, in a tree with no error boundary.
  const statsBackends = backends.filter((b) => !!ownProp(usage, b.id));
  const defaultId = homeTargetProfile(profiles, homeProfileId)?.backendId ?? backends[0]?.id;
  const viewBackend =
    statsBackends.find((b) => b.id === viewId) ??
    statsBackends.find((b) => b.id === defaultId) ??
    statsBackends[0];
  const stats = viewBackend ? (ownProp(usage, viewBackend.id) ?? null) : null;
  const dense = useMemo(
    () => (stats ? densifyKinds(Array.isArray(stats.series) ? stats.series : [], TREND_DAYS, localTodayDay()) : []),
    [stats],
  );
  return { statsBackends, viewBackend, setView, stats, dense };
}

/* ── Home strip ──────────────────────────────────────────────────────────── */

/** One kind's 30-day bars on the shared scale — a link into Statistics with that kind. */
function KindMultiple({ kind, dense, max, hatchId }: { kind: UsageKind; dense: UsageSeriesPoint[]; max: number; hatchId: string }) {
  const W = 200;
  const H = 70;
  const n = dense.length;
  const bw = n ? W / n : 0;
  const sum = dense.reduce((s, p) => s + safeTotals(p[kind]).words, 0);
  return (
    <Link
      to={`/statistics?kind=${kind}`}
      className="ring-signal block rounded-[10px] px-1.5 py-1 transition-colors hover:bg-surface-2"
      title={`${KIND_LABEL[kind]} — open in Statistics`}
    >
      <div className="mb-1.5 flex items-center justify-between font-mono text-[10.5px] uppercase tracking-label text-faint">
        <span className="flex items-center gap-1.5"><Swatch kind={kind} />{KIND_LABEL[kind]}</span>
        <span className="font-num normal-case tracking-normal text-text">{fmtCompact(sum)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[70px] w-full" aria-label={`${KIND_LABEL[kind]}: ${fmtFull(sum)} words in 30 days`} role="img">
        <line x1={0} x2={W} y1={H - 6} y2={H - 6} stroke="var(--c-line)" />
        {dense.map((p, i) => {
          const v = safeTotals(p[kind]).words;
          if (!(v > 0) || !(max > 0)) return null;
          const h = ((H - 10) * v) / max;
          return <rect key={p.day} x={(i * bw + bw * 0.2).toFixed(1)} y={(H - 6 - h).toFixed(1)} width={(bw * 0.6).toFixed(1)} height={h.toFixed(1)} rx={1.5} fill={kindFill(kind, hatchId)} />;
        })}
      </svg>
    </Link>
  );
}

const HOME_TILES = new Set(["words", "audio_s", "sessions", "errors"]);

/** Home: four sparkline stat tiles + the "By kind · 30 days" small multiples, with the
 *  backend selector + "View statistics" link on the header row. Hidden entirely (no empty
 *  box) until some backend has usage stats. */
export function HomeUsageStrip() {
  const { statsBackends, viewBackend, setView, stats, dense } = useUsageView();
  const hatchId = useId();
  if (!viewBackend || !stats) return null;
  // Home keeps the four headline figures; the Statistics page shows every measure.
  const tiles = tileSpecs(stats, dense, "all", false, "in 30 days").filter((t) => HOME_TILES.has(t.key));
  const last30 = dense.slice(-30);
  const max = Math.max(0, ...last30.flatMap((p) => KINDS.map((k) => safeTotals(p[k]).words)));
  const saved = last30.reduce((s, p) => s + timeSavedS(safeTotals(p.dictation).words, safeTotals(p.dictation).audio_s), 0);
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionLabel className="!m-0">Usage</SectionLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <BackendChips backends={statsBackends} selectedId={viewBackend.id} onSelect={setView} />
          <Link
            to="/statistics"
            className="ring-signal flex items-center gap-1.5 rounded-pill border border-line px-3 py-1 font-mono text-[11px] text-dim transition-colors hover:border-line-strong hover:bg-surface hover:text-text"
          >
            View statistics
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {tiles.map((t) => (
          <StatTile key={t.key} tile={t} spark />
        ))}
      </div>
      <Panel title="By kind · 30 days" right={<Pill>time saved {fmtTimeSaved(saved)}</Pill>} className="mt-3 px-4 pb-2.5 pt-3">
        <svg width="0" height="0" className="absolute" aria-hidden="true">
          <defs><HatchDef id={hatchId} /></defs>
        </svg>
        <div className="grid grid-cols-4 gap-3">
          {KINDS.map((k) => (
            <KindMultiple key={k} kind={k} dense={last30} max={max} hatchId={hatchId} />
          ))}
        </div>
      </Panel>
    </section>
  );
}

/* ── Statistics page ─────────────────────────────────────────────────────── */

/** The range as the panels name it: `30 days` · `1 year` · `since 14 Feb 2025` · a span. */
function rangeWord(q: UsagePageQuery, win: { from: number; to: number; days: number }): string {
  if (q.range === "all") return `since ${fmtSpanDate(win.from)}`;
  if (q.range === "custom") return `${fmtSpanDate(win.from)} – ${fmtSpanDate(win.to)}`;
  if (q.range === "365") return "1 year";
  return `${q.range} days`;
}

/** Statistics page body: backend chips + the filter bar, the five tiles, the stacked
 *  columns and the four panels. Friendly empty state when no backend has usage. */
export function StatisticsView({
  scope,
  onScope,
  query,
  onQuery,
  metric,
  onMetric,
  rhythm,
  onRhythm,
}: {
  scope: UsageScope;
  onScope: (s: UsageScope) => void;
  query: UsagePageQuery;
  onQuery: (q: UsagePageQuery) => void;
  metric: ChartMetric;
  onMetric: (m: ChartMetric) => void;
  rhythm: Rhythm;
  onRhythm: (r: Rhythm) => void;
}) {
  const { statsBackends, viewBackend, setView, stats: base } = useUsageView();
  const view = useApp((s) => s.usageView);
  const settings = useApp((s) => s.settings);
  const today = localTodayDay();
  // The page's own document, only when it answers THIS query against THIS backend; until
  // then the last one it had (or the fixed 30-day one on first visit) stays up, marked stale.
  const sig = viewBackend ? viewSignature(viewBackend, effectiveServerUrl(viewBackend, settings), query, viewerTimeZone()) : null;
  const fresh = !!sig && view?.sig === sig;
  const stats = fresh ? view!.stats : (view?.stats ?? base);
  const win = useMemo(
    () => (fresh && stats ? { from: stats.range.from, to: stats.range.to, days: stats.range.days } : resolveWindow(query, today, stats?.range?.first_day)),
    [fresh, stats, query, today, view],
  );
  const dense = useMemo(
    () => (stats ? densifyKinds(Array.isArray(stats.series) ? stats.series : [], win.days, win.to).filter((p) => p.day >= win.from && p.day <= win.to) : []),
    [stats, win],
  );
  const mode = bucketMode(win.days);
  const buckets = useMemo(() => bucketize(dense, mode), [dense, mode]);
  // The calendar's year: the page's own document when its range spans one, else the
  // separate 365-day document (lib/usage.ts refreshYear), which may still be on its way.
  const year = useApp((s) => s.usageYear);
  const yearQ = yearPageQuery(query);
  const yearSig = yearQ && viewBackend ? viewSignature(viewBackend, effectiveServerUrl(viewBackend, settings), yearQ, viewerTimeZone()) : null;
  const yearFresh = !yearQ ? fresh : !!yearSig && year?.sig === yearSig;
  const yearStats = !yearQ ? stats : (year?.stats ?? null);
  const yearWin = { from: today - 364, to: today };
  const yearDense = useMemo(
    () => (yearStats ? densifyKinds(Array.isArray(yearStats.series) ? yearStats.series : [], 365, today).filter((p) => p.day >= yearWin.from && p.day <= yearWin.to) : []),
    [yearStats, today, yearWin.from, yearWin.to],
  );
  if (!viewBackend || !stats) {
    return (
      <Card className="grid place-items-center p-12 text-center">
        <div className="text-[14px] text-dim">No usage data yet.</div>
        <div className="mt-1.5 max-w-sm text-[12.5px] text-faint">
          Usage statistics appear here once you’ve dictated or transcribed against a backend that records them.
        </div>
      </Card>
    );
  }
  const word = rangeWord(query, win);
  const tiles = tileSpecs(stats, buckets, scope, true, query.range === "all" ? "all-time" : `in ${word}`);
  const filtered = isFiltered(scope, query);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <BackendChips backends={statsBackends} selectedId={viewBackend.id} onSelect={setView} />
        {!fresh && <Pill>updating…</Pill>}
      </div>
      <FilterBar
        scope={scope}
        onScope={onScope}
        query={query}
        onQuery={onQuery}
        metric={metric}
        onMetric={onMetric}
        today={today}
        firstDay={stats.range?.first_day}
        retentionDays={stats.range?.jobs_retention_days}
        stale={!fresh}
      />
      <div className={cn("grid grid-cols-4 gap-3 max-[860px]:grid-cols-2", !fresh && "opacity-70")}>
        {tiles.map((t) => (
          <StatTile key={t.key} tile={t} spark active={t.metric === metric} onPick={t.metric ? () => onMetric(t.metric!) : undefined} />
        ))}
      </div>
      <div className={cn(!fresh && "opacity-70")}>
        <StackedChart buckets={buckets} mode={mode} scope={scope} metric={metric} />
        <StagesPanel stats={stats} dense={dense} scope={scope} withS={query.with} rangeWord={word} />
        <DictationPanel stats={stats} scope={scope} />
        <CalendarPanel
          dense={yearDense}
          streaks={(yearStats ?? stats).streak}
          scope={scope}
          withS={query.with}
          from={yearWin.from}
          to={yearWin.to}
          mark={win.from <= yearWin.from && win.to >= yearWin.to ? null : { from: win.from, to: win.to, word }}
          filtered={filtered}
          metric={metric}
          stale={!yearFresh}
        />
        <BusyPanel stats={stats} dense={dense} scope={scope} title={word} metric={metric} rhythm={rhythm} onRhythm={onRhythm} from={win.from} to={win.to} />
      </div>
    </>
  );
}
