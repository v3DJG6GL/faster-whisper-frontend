// The usage surfaces: the Home "Usage" strip (four sparkline tiles + small multiples
// by kind) and the Statistics page (scope + range, five tiles, the stacked columns by
// kind, the Stages / Dictation / Rhythm panels). Both read the active backend's usage
// document from the store (fed by lib/usage.ts) and render nothing when unsupported.
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
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowRight, Clock, Mic, Timer, Type, TriangleAlert } from "lucide-react";
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
import { TREND_DAYS } from "@/lib/usage";
import {
  CHART_METRICS,
  KINDS,
  KIND_LABEL,
  KIND_VAR,
  SCOPE_LABEL,
  STAGE_ROWS,
  calendarCells,
  densifyKinds,
  facetRows,
  findStage,
  fmtTimeSaved,
  metricValue,
  niceMax,
  pct,
  runsBreakdown,
  safeTotals,
  scopeTotals,
  targetShares,
  timeSavedS,
  zeroKinds,
  type ChartMetric,
  type FacetRow,
  type UsageScope,
} from "@/lib/usageDerive";
import { homeTargetProfile } from "@/lib/dictation";
import { ownProp } from "@/lib/own";
import { safeDisplayText } from "@/lib/sanitize";
import { BackendChips } from "@/components/BackendChips";
import type { UsageKind, UsageKinds, UsageSeriesPoint, UsageStats } from "@/lib/types";

const RANGES = ["7", "30", "90"] as const;
type RangeKey = (typeof RANGES)[number];

const METRIC_LABEL: Record<ChartMetric, string> = { words: "words", minutes: "minutes", runs: "runs" };
const metricTick = (m: ChartMetric, v: number) => (m === "minutes" ? fmtDurationAxis(v) : fmtCompact(v));
const metricFull = (m: ChartMetric, v: number) => (m === "minutes" ? fmtDuration(v) : fmtFull(v));

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
  tone: "dict" | "ok" | "warn" | "text";
  sub: ReactNode;
  spark: number[];
  sparkColor: string;
}

const Num = ({ children }: { children: ReactNode }) => <span className="font-num text-text">{children}</span>;
/** The tile sub-line's "today" eyebrow (the only uppercased token on the line). */
const Today = () => <span className="text-[10px] uppercase tracking-label text-faint">today</span>;

/** The tile row for a scope: Words / Audio / Runs / (Time saved) / Errors. Time saved is
 *  dictation-only by definition (the server's figure is too), whatever the scope. */
function tileSpecs(stats: UsageStats, dense: UsageSeriesPoint[], scope: UsageScope, withSaved: boolean): TileSpec[] {
  const today = scopeTotals(stats.today, scope);
  const total = scopeTotals(stats.total, scope);
  const last30 = dense.slice(-30);
  const spark = (f: (p: UsageSeriesPoint) => number) => last30.map(f);
  const wpm = Math.round(stats.dictation?.wpm ?? 0);
  const tiles: TileSpec[] = [
    {
      key: "words", label: "Words", icon: Type, value: fmtFull(today.words), tone: "dict",
      sub: <><Today /> · <Num>{fmtCompact(total.words)}</Num> total</>,
      spark: spark((p) => scopeTotals(p, scope).words), sparkColor: "var(--c-chart-dict)",
    },
    {
      key: "audio", label: "Audio", icon: Clock, value: fmtDurationExact(today.audio_s), tone: "text",
      sub: <><Today /> · <Num>{fmtDuration(total.audio_s)}</Num> all-time</>,
      spark: spark((p) => scopeTotals(p, scope).audio_s), sparkColor: "var(--c-dim)",
    },
    {
      key: "runs", label: "Runs", icon: Mic, value: fmtFull(today.sessions), tone: "text",
      sub: scope === "all" ? <><Today /> · <Num>{runsBreakdown(stats.today)}</Num></> : <><Today /> · <Num>{fmtCompact(total.sessions)}</Num> total</>,
      spark: spark((p) => scopeTotals(p, scope).sessions), sparkColor: "var(--c-dim)",
    },
  ];
  if (withSaved) {
    const d = safeTotals(stats.today?.dictation);
    tiles.push({
      key: "saved", label: "Time saved", icon: Timer, value: fmtTimeSaved(timeSavedS(d.words, d.audio_s)), tone: "ok",
      sub: <><Today /> · vs typing at 40 wpm{wpm > 0 && <> · <Num>{wpm} wpm</Num> spoken</>}</>,
      spark: spark((p) => timeSavedS(safeTotals(p.dictation).words, safeTotals(p.dictation).audio_s)), sparkColor: "var(--c-ok)",
    });
  }
  tiles.push({
    key: "errors", label: "Errors", icon: TriangleAlert, value: fmtFull(today.errors), tone: today.errors > 0 ? "warn" : "ok",
    sub: <><Today /> · <Num>{fmtFull(total.errors)}</Num> total</>,
    spark: spark((p) => scopeTotals(p, scope).errors), sparkColor: "var(--c-faint)",
  });
  return tiles;
}

const TONE: Record<TileSpec["tone"], string> = { dict: "text-chart-dict", ok: "text-ok", warn: "text-warn", text: "text-text" };

function StatTile({ tile, spark }: { tile: TileSpec; spark: boolean }) {
  const Icon = tile.icon;
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-label text-faint">
        <Icon className="size-3.5 opacity-80" />
        {tile.label}
      </div>
      <div className={cn("mt-2.5 font-num text-[26px] font-semibold leading-none", TONE[tile.tone])}>{tile.value}</div>
      <div className="mt-2 text-[12px] text-dim">{tile.sub}</div>
      {spark && <Sparkline vals={tile.spark} color={tile.sparkColor} />}
    </Card>
  );
}

/* ── stacked columns by kind ─────────────────────────────────────────────── */

const TIP_W = 176;

function StackedChart({ dense, range, scope }: { dense: UsageSeriesPoint[]; range: number; scope: UsageScope }) {
  const [metric, setMetric] = useState<ChartMetric>("words");
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

  // hover is an index into the sliced window — a different day after the range changes.
  useEffect(() => setHover(null), [range]);

  const pts = useMemo(() => dense.slice(-range), [dense, range]);
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

  // X ticks: a weekly stride anchored on today (always a tick), fortnightly on the 90-day view.
  const step = n > 60 ? 14 : 7;
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

  return (
    <Panel
      title={`${METRIC_LABEL[metric]} per day, by kind`}
      right={
        <>
          <div className="flex flex-wrap gap-3.5" role="group" aria-label="Kinds (click to solo)">
            {KINDS.map(legendButton)}
          </div>
          <Segmented
            value={metric}
            onChange={setMetric}
            ariaLabel="Chart metric"
            options={CHART_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
          />
        </>
      }
    >
      <div ref={ref} className="relative px-3 pb-1 pt-1">
        {allZero ? (
          <div className="grid h-[220px] place-items-center text-[13px] text-faint">
            No {METRIC_LABEL[metric]} in the last {range} days
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
              aria-label={`${METRIC_LABEL[metric]} per day by kind, last ${range} days. Use the arrow keys to step through days.`}
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
                  <g key={pts[i].day} opacity={hover != null && hover !== i ? 0.55 : 1}>
                    {KINDS.map((k, ki) => {
                      const v = c[ki];
                      if (!(v > 0)) return null;
                      const h = yOf(v);
                      y -= h;
                      // 2 px surface gap between stacked segments (the mockup's `h-2`).
                      return (
                        <rect key={k} x={x.toFixed(1)} y={y.toFixed(1)} width={barW.toFixed(1)} height={Math.max(0.5, h - 2).toFixed(1)} rx={2} fill={kindFill(k, hatchId)} />
                      );
                    })}
                  </g>
                );
              })}
              {pts.map((p, i) =>
                isTick(i) ? (
                  <text
                    key={p.day}
                    x={barX(i) + barW / 2}
                    y={H - 7}
                    textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
                    className="font-mono"
                    fontSize={10}
                    fill="var(--c-faint)"
                  >
                    {i === n - 1 ? "today" : fmtDateTick(p.day)}
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
                <div className="mb-1 font-mono text-[10.5px] uppercase tracking-label text-faint">{fmtDateFull(hp.day)}</div>
                {KINDS.map((k) => (
                  <div key={k} className={cn("flex items-baseline justify-between gap-4 leading-relaxed", shown(k) ? "text-dim" : "text-faint")}>
                    <span className="flex items-center gap-1.5"><Swatch kind={k} />{KIND_LABEL[k]}</span>
                    <span className="font-num text-text">{metricFull(metric, metricValue(safeTotals(hp[k]), metric))}</span>
                  </div>
                ))}
                <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-line pt-1 leading-relaxed text-dim">
                  <span>total</span>
                  <span className="font-num font-semibold text-text">{metricFull(metric, totals[hover!])}</span>
                </div>
              </div>
            )}
            <div className="sr-only" aria-live="polite">
              {hp ? `${fmtDateFull(hp.day)}: ${metricFull(metric, totals[hover!])} ${METRIC_LABEL[metric]}` : ""}
            </div>
          </>
        )}
      </div>
      <div className="mt-1.5 text-[11.5px] text-faint">
        {scope === "all" ? "Click a legend entry to solo that kind. " : ""}Hover for the day’s split. Text imports are hatched neutral: they are rare and never a volume story.
      </div>
    </Panel>
  );
}

/* ── stages ──────────────────────────────────────────────────────────────── */

/** Window runs per kind: the densified series summed (the fetched window = `range.days`). */
function windowKinds(dense: UsageSeriesPoint[]): UsageKinds {
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

function StagesPanel({ stats, dense }: { stats: UsageStats; dense: UsageSeriesPoint[] }) {
  const days = stats.range?.days || TREND_DAYS;
  const win = windowKinds(dense);
  const media = win.file.sessions + win.url.sessions;
  return (
    <Panel
      title={`Stages · share of runs that used them, ${days} days`}
      right={<Pill>{fmtFull(media)} file &amp; link runs · {fmtFull(win.dictation.sessions)} dictations</Pill>}
    >
      <div>
        {STAGE_ROWS.map((row) => {
          const st = findStage(stats.stages, row.key);
          if (!st) {
            return (
              <div key={row.key} className="grid grid-cols-[160px_1fr] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px]">
                <div className="flex items-center gap-2 text-dim">
                  <i className="inline-block size-2 rounded-full" style={{ background: "var(--c-line-strong)" }} />
                  {row.label}
                </div>
                <div className="text-faint">Not used in the last {days} days. {row.emptyCopy}</div>
              </div>
            );
          }
          const share = pct(st.runs, st.of_runs);
          const runsWord = row.key === "translating" ? "runs" : "file runs";
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
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-line">
                  <i className="block h-full rounded-pill" style={{ width: `${share}%`, background: row.colorVar }} />
                </div>
                <span className="w-[120px] font-num text-[12px] text-text">{share} % · {fmtFull(st.runs)} {runsWord}</span>
              </div>
              <div className="text-dim"><Num>{fmtDuration(st.audio_s)}</Num> audio</div>
              <div className="text-dim">{detail}</div>
              {(targets.length > 0 || kept > 0) && (
                <div className="col-start-2 col-end-[-1] -mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
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
            <span className="truncate" title={r.label}>{r.label}</span>
            <div className="h-2 overflow-hidden rounded-pill bg-line">
              <i className="block h-full rounded-pill" style={{ width: `${r.pct}%`, background: r.dim ? "var(--c-faint)" : (r.colorVar ?? "var(--c-chart-dict)") }} />
            </div>
            <span className="text-right font-num text-text">{fmtCompact(r.value)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function DictationPanel({ stats }: { stats: UsageStats }) {
  const d = stats.dictation;
  const reportApp = useApp((s) => s.settings.recording.reportTargetApp !== false);
  const act = d?.activation ?? { hold: 0, handsfree: 0 };
  const del = d?.delivery ?? { typed: 0, clipboard: 0, none: 0, unreported: 0 };
  const tr = d?.translation ?? { translated: 0, kept_original: 0, not_asked: 0, aborted: 0, unreported: 0 };
  const apps = (stats.apps ?? [])
    .filter((a) => a && typeof a.app_id === "string")
    .slice(0, 4)
    .map((a) => ({ label: safeDisplayText(a.app_id) || "unknown", value: a.sessions }));
  return (
    <Panel title="Dictation" right={<Pill>{fmtFull(d?.sessions ?? 0)} sessions</Pill>}>
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
        <HBars
          title="Translation outcome"
          rows={facetRows([
            { label: "Translated", value: tr.translated, colorVar: "var(--c-translate)" },
            { label: "Kept original", value: tr.kept_original, dim: true },
            { label: "Not asked", value: tr.not_asked, dim: true },
            ...(tr.aborted > 0 ? [{ label: "Aborted", value: tr.aborted, dim: true }] : []),
            ...(tr.unreported > 0 ? [{ label: "Unreported", value: tr.unreported, dim: true }] : []),
          ])}
        />
      </div>
    </Panel>
  );
}

/* ── rhythm ──────────────────────────────────────────────────────────────── */

const LEVEL_BG = [
  "var(--c-surface-2)",
  "color-mix(in srgb, var(--c-chart-dict) 30%, var(--c-surface-2))",
  "color-mix(in srgb, var(--c-chart-dict) 55%, var(--c-surface-2))",
  "color-mix(in srgb, var(--c-chart-dict) 80%, var(--c-surface-2))",
  "var(--c-chart-dict)",
];

function RhythmPanel({ stats }: { stats: UsageStats }) {
  const days = stats.range?.calendar_days || 90;
  const cells = useMemo(() => calendarCells(stats.calendar ?? [], days, localTodayDay()), [stats.calendar, days]);
  const streak = stats.streak ?? { current: 0, best: 0 };
  return (
    <Panel
      title={`Rhythm · ${days} days`}
      right={<Pill>streak {fmtFull(streak.current)} {streak.current === 1 ? "day" : "days"} · best {fmtFull(streak.best)}</Pill>}
    >
      <div
        className="grid justify-start gap-[3px] overflow-x-auto pb-1"
        style={{ gridAutoFlow: "column", gridTemplateRows: "repeat(7, 10px)", gridAutoColumns: "10px" }}
        role="img"
        aria-label={`Daily activity, ${days} days`}
      >
        {cells.map((c) => (
          <i
            key={c.day}
            className="size-2.5 rounded-[2px]"
            style={{ background: LEVEL_BG[c.level] }}
            title={`${fmtDateFull(c.day)} · ${fmtFull(c.words)} words`}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11.5px] text-faint">
        Words per day
        <span className="ml-auto flex items-center gap-1">
          less
          {LEVEL_BG.map((bg, i) => <i key={i} className="size-2.5 rounded-[2px]" style={{ background: bg }} />)}
          more
        </span>
      </div>
    </Panel>
  );
}

/* ── view resolution ─────────────────────────────────────────────────────── */

/** Resolve which backends have usage stats, the currently-VIEWED one (the user's pick,
 *  defaulting to the dictation/home-target backend), the densified series, and a setter.
 *  Shared by the Home strip + the Statistics page so they stay in sync. The chip readout
 *  is independent — it always follows the dictation backend (see lib/usage.ts). */
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

/** One kind's 30-day bars on the shared scale — a link into Statistics with that scope. */
function KindMultiple({ kind, dense, max, hatchId }: { kind: UsageKind; dense: UsageSeriesPoint[]; max: number; hatchId: string }) {
  const W = 200;
  const H = 70;
  const n = dense.length;
  const bw = n ? W / n : 0;
  const sum = dense.reduce((s, p) => s + safeTotals(p[kind]).words, 0);
  return (
    <Link
      to={`/statistics?scope=${kind}`}
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

/** Home: four sparkline stat tiles + the "By kind · 30 days" small multiples, with the
 *  backend selector + "View statistics" link on the header row. Hidden entirely (no empty
 *  box) until some backend has usage stats. */
export function HomeUsageStrip() {
  const { statsBackends, viewBackend, setView, stats, dense } = useUsageView();
  const hatchId = useId();
  if (!viewBackend || !stats) return null;
  const tiles = tileSpecs(stats, dense, "all", false);
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

/** Statistics page body: backend chips + scope + range, the five tiles, the stacked
 *  columns and the three panels. Friendly empty state when no backend has usage. */
export function StatisticsView({ scope, onScope }: { scope: UsageScope; onScope: (s: UsageScope) => void }) {
  const { statsBackends, viewBackend, setView, stats, dense } = useUsageView();
  const [range, setRange] = useState<RangeKey>("30");
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
  const tiles = tileSpecs(stats, dense, scope, true);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <BackendChips backends={statsBackends} selectedId={viewBackend.id} onSelect={setView} />
        <Segmented
          value={scope}
          onChange={onScope}
          ariaLabel="Scope"
          options={(["all", ...KINDS] as UsageScope[]).map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
        />
        <span className="flex-1" />
        <Segmented
          value={range}
          onChange={setRange}
          ariaLabel="Range"
          options={RANGES.map((r) => ({ value: r, label: `${r}d` }))}
        />
      </div>
      <div className="grid grid-cols-5 gap-3 max-[860px]:grid-cols-2">
        {tiles.map((t) => (
          <StatTile key={t.key} tile={t} spark />
        ))}
      </div>
      <StackedChart dense={dense} range={Number(range)} scope={scope} />
      <StagesPanel stats={stats} dense={dense} />
      <DictationPanel stats={stats} />
      <RhythmPanel stats={stats} />
    </>
  );
}
