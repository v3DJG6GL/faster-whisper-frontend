// Pure derivations for the usage surfaces (Statistics page, Home strip): the
// per-kind densified series, scope filtering, tile values, calendar levels and the
// stage-row vocabulary. No React, no store — every function takes its inputs so
// vitest covers it without a webview. The charts in components/UsageStats.tsx only
// lay these numbers out.

import type { UsageKind, UsageKinds, UsageKindTotals, UsageSeriesPoint, UsageStage } from "./types";

/** What the Statistics page is filtered to: every kind, or one. */
export type UsageScope = "all" | UsageKind;

export const KINDS: readonly UsageKind[] = ["dictation", "file", "url", "text"];
export const KIND_LABEL: Record<UsageKind, string> = {
  dictation: "Dictation",
  file: "Files",
  url: "Links",
  text: "Text",
};
export const SCOPE_LABEL: Record<UsageScope, string> = { all: "All", ...KIND_LABEL };
/** The CSS token each kind's series is drawn in (text is hatched in that colour). */
export const KIND_VAR: Record<UsageKind, string> = {
  dictation: "var(--c-chart-dict)",
  file: "var(--c-chart-file)",
  url: "var(--c-chart-link)",
  text: "var(--c-chart-text)",
};

/** `?scope=` off the URL (or anything untrusted) → a scope, "all" when unrecognised. */
export function parseScope(v: string | null | undefined): UsageScope {
  return v === "dictation" || v === "file" || v === "url" || v === "text" ? v : "all";
}

export const ZERO_TOTALS: Readonly<UsageKindTotals> = Object.freeze({
  sessions: 0,
  requests: 0,
  errors: 0,
  words: 0,
  audio_s: 0,
  proc_s: 0,
});

export function zeroKinds(): UsageKinds {
  return { all: { ...ZERO_TOTALS }, dictation: { ...ZERO_TOTALS }, file: { ...ZERO_TOTALS }, url: { ...ZERO_TOTALS }, text: { ...ZERO_TOTALS } };
}

/** A totals block off the wire with every counter coerced to a finite number — the
 *  server's shape is trusted for keys, not for values (a missing block reads as zero). */
export function safeTotals(t: Partial<UsageKindTotals> | null | undefined): UsageKindTotals {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    sessions: n(t?.sessions),
    requests: n(t?.requests),
    errors: n(t?.errors),
    words: n(t?.words),
    audio_s: n(t?.audio_s),
    proc_s: n(t?.proc_s),
  };
}

export function safeKinds(k: Partial<UsageKinds> | null | undefined): UsageKinds {
  return {
    all: safeTotals(k?.all),
    dictation: safeTotals(k?.dictation),
    file: safeTotals(k?.file),
    url: safeTotals(k?.url),
    text: safeTotals(k?.text),
  };
}

/** The totals the scope selects: `all` as the server summed it, else one kind. */
export function scopeTotals(k: UsageKinds, scope: UsageScope): UsageKindTotals {
  return safeTotals(k[scope]);
}

/** The chart's y metric. `minutes` carries SECONDS (the axis formatter renders them). */
export type ChartMetric = "words" | "minutes" | "runs";
export const CHART_METRICS: readonly ChartMetric[] = ["words", "minutes", "runs"];

export function metricValue(t: UsageKindTotals, m: ChartMetric): number {
  return m === "words" ? t.words : m === "minutes" ? t.audio_s : t.sessions;
}

/** Densify the sparse per-kind series into one point per calendar day across the last
 *  `days` days, zero-filling gaps. Anchored on the caller's `today` (days-since-epoch,
 *  local), extended to the latest data day so nothing is ever cut off. */
export function densifyKinds(series: readonly UsageSeriesPoint[], days: number, today: number): UsageSeriesPoint[] {
  const byDay = new Map<number, UsageSeriesPoint>();
  let maxDay = -Infinity;
  for (const p of series) {
    // `day` comes off the wire as an unvalidated i64. Past ~1e8 it overflows the Date
    // constructor and the tick formatter throws mid-render; past 2^53 `day++` stops
    // advancing. Reject anything that isn't a plausible calendar day.
    if (!p || !Number.isSafeInteger(p.day) || p.day < 0 || p.day > today + 1) continue;
    byDay.set(p.day, p);
    if (p.day > maxDay) maxDay = p.day;
  }
  const end = Number.isFinite(maxDay) ? Math.max(today, maxDay) : today;
  const span = Math.max(1, Math.floor(days));
  const start = end - (span - 1);
  const out: UsageSeriesPoint[] = [];
  for (let day = start; day <= end; day++) {
    const p = byDay.get(day);
    out.push(p ? { day, ...safeKinds(p) } : { day, ...zeroKinds() });
  }
  return out;
}

/** Round a max up to a clean step so gridline labels read nicely (4 intervals). */
export function niceMax(v: number): number {
  if (!(v > 0)) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const u = v / p;
  // Floor at 4: the axis draws 4 equal intervals, so a smaller top yields fractional
  // quarters that round to DUPLICATE tick labels.
  return Math.max(4, (u <= 1 ? 1 : u <= 2 ? 2 : u <= 4 ? 4 : u <= 8 ? 8 : 10) * p);
}

/* ── tiles ──────────────────────────────────────────────────────────────── */

/** Typing baseline the "time saved" figure is measured against (the Aalto 136M-keystroke
 *  study's mean is 52 wpm; 40 is the conservative baseline the server uses too). */
export const TYPING_WPM = 40;

/** Seconds saved versus typing `words` at the baseline, given `audio_s` spoken. Never
 *  negative — a slow, corrected dictation saved nothing rather than owing time. */
export function timeSavedS(words: number, audio_s: number): number {
  return Math.max(0, (words / TYPING_WPM) * 60 - audio_s);
}

/** `0 min` · `38 min` · `14h 02m`. */
export function fmtTimeSaved(seconds: number): string {
  const min = Math.max(0, Math.round((seconds || 0) / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** `14 dictations · 2 files · 1 link` (kinds with runs, in kind order), or `no runs`. */
export function runsBreakdown(k: UsageKinds): string {
  const parts: string[] = [];
  const one: Record<UsageKind, [string, string]> = {
    dictation: ["dictation", "dictations"],
    file: ["file", "files"],
    url: ["link", "links"],
    text: ["text", "texts"],
  };
  for (const kind of KINDS) {
    const n = safeTotals(k[kind]).sessions;
    if (n > 0) parts.push(`${n.toLocaleString("en-US")} ${one[kind][n === 1 ? 0 : 1]}`);
  }
  return parts.length ? parts.join(" · ") : "no runs";
}

/* ── calendar ───────────────────────────────────────────────────────────── */

export interface CalendarCell {
  day: number;
  words: number;
  /** 0 = nothing, 1–4 = quartile of the window's busiest day (5 sequential steps). */
  level: 0 | 1 | 2 | 3 | 4;
}

/** One cell per day over the last `days` days ending today, levelled against the window's
 *  maximum: >0 → 1, >25 % → 2, >50 % → 3, >75 % → 4. A single busy day still reads as the
 *  darkest step, so the scale is relative and the grid is never all-pale. */
export function calendarCells(calendar: readonly { day: number; words: number }[], days: number, today: number): CalendarCell[] {
  const byDay = new Map<number, number>();
  for (const c of calendar) {
    if (!c || !Number.isSafeInteger(c.day) || c.day < 0 || c.day > today + 1) continue;
    const w = typeof c.words === "number" && Number.isFinite(c.words) ? Math.max(0, c.words) : 0;
    byDay.set(c.day, (byDay.get(c.day) ?? 0) + w);
  }
  const span = Math.max(1, Math.floor(days));
  const start = today - (span - 1);
  let max = 0;
  for (let d = start; d <= today; d++) max = Math.max(max, byDay.get(d) ?? 0);
  const out: CalendarCell[] = [];
  for (let d = start; d <= today; d++) {
    const words = byDay.get(d) ?? 0;
    const f = max > 0 ? words / max : 0;
    const level: CalendarCell["level"] = words <= 0 ? 0 : f > 0.75 ? 4 : f > 0.5 ? 3 : f > 0.25 ? 2 : 1;
    out.push({ day: d, words, level });
  }
  return out;
}

/* ── stages ─────────────────────────────────────────────────────────────── */

export type StageKey = "translating" | "diarizing" | "vad" | "separating";

export interface StageRowMeta {
  key: StageKey;
  label: string;
  /** CSS token for the stage's dot + meter (the existing pipeline-stage hues). */
  colorVar: string;
  /** The empty-state row's second sentence, after "Not used in the last N days." */
  emptyCopy: string;
}

/** The four optional stages the panel always lists, in the mockup's order. Other stages
 *  the server may report (transcribing, downloading) are not "optional processing" and
 *  are not rows. */
export const STAGE_ROWS: readonly StageRowMeta[] = [
  {
    key: "translating",
    label: "Translation",
    colorVar: "var(--c-translate)",
    emptyCopy: "Set targets on a Profile, or turn it on per run under Transcribe › Processing.",
  },
  {
    key: "diarizing",
    label: "Speaker diarization",
    colorVar: "var(--c-diarize)",
    emptyCopy: "Turn it on per run under Transcribe › Processing when a file has more than one voice.",
  },
  {
    key: "vad",
    label: "Silence skipping",
    colorVar: "var(--c-think)",
    emptyCopy: "Turn it on per run under Transcribe › Processing for recordings with long pauses.",
  },
  {
    key: "separating",
    label: "Music separation",
    colorVar: "var(--c-separate)",
    emptyCopy: "Turn it on per run under Transcribe › Processing when a file has background music.",
  },
];

/** The server's row for a stage, if it reported one with any runs. */
export function findStage(stages: readonly UsageStage[] | undefined, key: StageKey): UsageStage | undefined {
  const s = stages?.find((x) => x && x.stage === key);
  return s && typeof s.runs === "number" && s.runs > 0 ? s : undefined;
}

/** Integer percent, 0 when `of` is 0. */
export function pct(n: number, of: number): number {
  if (!(of > 0) || !(n > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((n / of) * 100)));
}

/** Targets as `DE→EN 61 %`-style shares of the stage's runs, top `max`. */
export function targetShares(stage: UsageStage, max = 4): { code: string; pct: number }[] {
  const list = (stage.targets ?? []).filter((t) => t && typeof t.code === "string" && t.runs > 0);
  list.sort((a, b) => b.runs - a.runs);
  return list.slice(0, max).map((t) => ({ code: t.code.toUpperCase(), pct: pct(t.runs, stage.runs) }));
}

/* ── horizontal-bar facets ──────────────────────────────────────────────── */

export interface FacetRow {
  label: string;
  value: number;
  /** Width as a share of the facet's largest row (the mockup scales bars to the max). */
  pct: number;
  /** Rendered in the faint tone (an outcome that is not a success story). */
  dim?: boolean;
  /** Overrides the accent chart colour (the translated row uses the stage hue). */
  colorVar?: string;
}

/** Rows scaled to the largest value; zero rows kept (they read as "none") unless `dropZero`. */
export function facetRows(
  rows: readonly { label: string; value: number; dim?: boolean; colorVar?: string }[],
  dropZero = false,
): FacetRow[] {
  const clean = rows
    .map((r) => ({ ...r, value: typeof r.value === "number" && Number.isFinite(r.value) ? Math.max(0, r.value) : 0 }))
    .filter((r) => !dropZero || r.value > 0);
  const max = clean.reduce((m, r) => Math.max(m, r.value), 0);
  return clean.map((r) => ({ ...r, pct: max > 0 ? Math.round((r.value / max) * 100) : 0 }));
}
