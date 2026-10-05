// What the stat tiles say, per measure; StatTiles.tsx draws them.
import { type ReactNode } from "react";
import { Activity, Clock, Cpu, Mic, Timer, Type, TriangleAlert } from "lucide-react";
import { fmtFull, fmtCompact, fmtDuration } from "@/lib/format";
import {
  CHART_METRICS, KINDS, METRIC_LABEL, fmtTimeSaved, isDurationMetric, metricValue, safeTotals, scopeTotals,
  timeSavedS, TYPING_WPM, type ChartMetric, type UsageScope,
} from "@/lib/usageDerive";
import type { UsageKind, UsageKinds, UsageStats } from "@/lib/types";
import { Num } from "@/components/stats/primitives";

/* ── tiles ───────────────────────────────────────────────────────────────── */

export interface TileSpec {
  key: string;
  label: string;
  icon: typeof Type;
  tone: "dict" | "ok" | "warn";
  /** The ledger's three rows (D53 C): today, the page's range, and the per-day average. */
  today: string;
  range: string;
  rangeLabel: string;
  perDay: string;
  /** Sessions only (D56 K1): the range's sessions per kind, a stacked bar + legend. */
  split?: { kind: UsageKind; value: number }[];
  /** One quiet line under the rows (Time saved: the spoken-vs-typed rate). */
  note?: ReactNode;
  spark: number[];
  sparkColor: string;
  /** The measure this tile mirrors (D35 A): clicking it measures the page in it. */
  metric?: ChartMetric;
  /** Time saved: a conclusion drawn from two measures, not a switch — spans two columns (D39 L1). */
  wide?: boolean;
}

/** A per-day average: durations as durations, small counts with one decimal ("0.3"),
 *  larger ones compact ("1.8k"). */
function fmtPerDay(m: ChartMetric | "saved", v: number): string {
  if (m === "audio_s" || m === "processing_s" || m === "saved") return fmtDuration(v);
  return v > 0 && v < 10 ? (Math.round(v * 10) / 10).toLocaleString("en-US") : fmtCompact(v);
}


const TILE_ICON: Record<ChartMetric, typeof Type> = { audio_s: Clock, words: Type, sessions: Mic, requests: Activity, processing_s: Cpu, errors: TriangleAlert };

/** The tile row for a scope: one tile per measure in measure order (Duration · Words ·
 *  Sessions · Requests · Processing Time · Errors), then Time saved, which is dictation-only
 *  by definition (the server's figure is too), whatever the scope. Each tile is a ledger
 *  (D53 C): today, the range (`rangeLabel`, `days` calendar days) and the per-day average;
 *  `dense` feeds the sparkline. */
export function tileSpecs(stats: UsageStats, dense: readonly UsageKinds[], scope: UsageScope, withSaved: boolean, rangeLabel: string, days: number): TileSpec[] {
  const today = scopeTotals(stats.today, scope);
  const total = scopeTotals(stats.total, scope);
  const last30 = dense.slice(-30);
  const spark = (f: (p: UsageKinds) => number) => last30.map(f);
  const wpm = Math.round(stats.dictation?.wpm ?? 0);
  const per = (m: ChartMetric | "saved", v: number) => (days > 0 ? `≈ ${fmtPerDay(m, v / days)} per day` : "—");
  const tiles: TileSpec[] = CHART_METRICS.map((m) => {
    const dur = isDurationMetric(m);
    // Durations round to the tile ("5h 59m", "47s"): the exact form ("5h 59m 03s") needs a
    // wider column than the ledger has, and the seconds are noise at that scale.
    const fmt = (v: number) => (dur ? fmtDuration(v) : fmtFull(v));
    const split =
      m === "sessions" && scope === "all"
        ? KINDS.map((kind) => ({ kind, value: safeTotals(stats.total?.[kind]).sessions })).filter((r) => r.value > 0)
        : undefined;
    return {
      key: m,
      metric: m,
      label: METRIC_LABEL[m],
      icon: TILE_ICON[m],
      tone: m === "errors" ? (today.errors > 0 ? "warn" : "ok") : "dict",
      today: fmt(metricValue(today, m)),
      range: fmt(metricValue(total, m)),
      rangeLabel,
      perDay: per(m, metricValue(total, m)),
      split,
      spark: spark((p) => metricValue(scopeTotals(p, scope), m)),
      sparkColor: m === "errors" ? "var(--c-faint)" : "var(--c-accent)",
    };
  });
  if (withSaved) {
    const d = safeTotals(stats.today?.dictation);
    const saved = stats.time_saved_s ?? 0;
    tiles.push({
      key: "saved", label: "Time saved", icon: Timer, tone: "dict", wide: true,
      today: fmtTimeSaved(timeSavedS(d.words, d.audio_s)),
      range: fmtTimeSaved(saved),
      rangeLabel,
      perDay: `${per("saved", saved)} · dictation only`,
      note: wpm > 0 ? <><Num>{wpm} wpm</Num> spoken instead of <Num>{TYPING_WPM} wpm</Num> typed</> : <>vs typing at <Num>{TYPING_WPM} wpm</Num></>,
      spark: spark((p) => timeSavedS(safeTotals(p.dictation).words, safeTotals(p.dictation).audio_s)), sparkColor: "var(--c-accent)",
    });
  }
  return tiles;
}
