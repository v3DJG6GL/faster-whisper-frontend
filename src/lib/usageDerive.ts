// Pure derivations for the usage surfaces (Statistics page, Home strip): the
// per-kind densified series, scope filtering, tile values, the page query (range presets,
// custom span, stage filter) and its URL form, chart bucketing, the quantile calendar and
// hour-grid levels, streaks and the stage-row vocabulary. No React, no store — every function takes its inputs so
// vitest covers it without a webview. The charts in components/UsageStats.tsx only
// lay these numbers out.

import type {
  UsageHourCell,
  UsageKind,
  UsageKinds,
  UsageKindTotals,
  UsageQuery,
  UsageSeriesPoint,
  UsageStage,
  UsageStageKey,
  UsageStreak,
  UsageStreaks,
} from "./types";

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

/** The page-wide measure (D35/D38): the six counters every kind carries, keyed exactly as
 *  the backend's own measure bar keys them (`?metric=`), so a link carries across. The two
 *  `_s` measures are SECONDS; the formatters render them as durations. Client-side like the
 *  kind filter — it never changes the fetch. */
export type ChartMetric = "audio_s" | "words" | "sessions" | "requests" | "proc_s" | "errors";
export const CHART_METRICS: readonly ChartMetric[] = ["audio_s", "words", "sessions", "requests", "proc_s", "errors"];
export const METRIC_LABEL: Record<ChartMetric, string> = {
  audio_s: "Duration",
  words: "Words",
  sessions: "Sessions",
  requests: "Requests",
  proc_s: "Processing Time",
  errors: "Errors",
};
/** Singular/plural unit for the count measures; null for the two durations. */
export const METRIC_UNIT: Record<ChartMetric, [string, string] | null> = {
  audio_s: null,
  words: ["word", "words"],
  sessions: ["session", "sessions"],
  requests: ["request", "requests"],
  proc_s: null,
  errors: ["error", "errors"],
};
export const isDurationMetric = (m: ChartMetric): boolean => m === "audio_s" || m === "proc_s";
/** `?metric=` → a measure; anything else is Words. */
export function parseMetric(v: string | null | undefined): ChartMetric {
  return (CHART_METRICS as readonly string[]).includes(v ?? "") ? (v as ChartMetric) : "words";
}

export function metricValue(t: UsageKindTotals, m: ChartMetric): number {
  const v = t[m];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
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

/* ── the page query: range · with-stages ────────────────────────────────── */

/** Range presets in display order; `custom` carries `from`/`to`. */
export const RANGE_PRESETS = ["7", "30", "90", "180", "365", "all", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_LABEL: Record<RangePreset, string> = {
  "7": "7 d",
  "30": "30 d",
  "90": "90 d",
  "180": "180 d",
  "365": "1 y",
  all: "All",
  custom: "Custom…",
};

/** The stage keys a run can be narrowed to, in the filter bar's order. */
export const STAGE_KEYS: readonly UsageStageKey[] = ["translating", "diarizing", "separating", "vad"];
export const STAGE_CHIP_LABEL: Record<UsageStageKey, string> = {
  translating: "Translated",
  diarizing: "Diarized",
  separating: "Music separated",
  vad: "Silence skipped",
};

/** What the Statistics page has asked for. The kind filter is client-side and lives
 *  beside it (`UsageScope`); everything here changes the fetch. */
export interface UsagePageQuery {
  range: RangePreset;
  /** Custom span, days-since-epoch (local), inclusive. Only read when `range` is custom. */
  from?: number;
  to?: number;
  /** Stages every counted run must have had (AND), in `STAGE_KEYS` order. */
  with: UsageStageKey[];
}

export const DEFAULT_PAGE_QUERY: Readonly<UsagePageQuery> = Object.freeze({ range: "30", with: [] });

/** Longest span the server accepts (10 years). */
export const MAX_SPAN_DAYS = 3650;

function isDay(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 1e7;
}

function parseStageList(v: string | null | undefined): UsageStageKey[] {
  if (!v) return [];
  const set = new Set(v.split(",").map((x) => x.trim()));
  return STAGE_KEYS.filter((k) => set.has(k));
}

/** `?kind=&with=&range=&from=&to=&metric=` (plus the older `?scope=`) → page state. Anything
 *  unrecognised falls back to the default; a custom range without a usable span too. */
export function parsePageQuery(get: (key: string) => string | null): { scope: UsageScope; query: UsagePageQuery; metric: ChartMetric; rhythm: Rhythm } {
  const scope = parseScope(get("kind") ?? get("scope"));
  const metric = parseMetric(get("metric"));
  const rhythm = parseRhythm(get("rhythm"));
  const r = get("range");
  const withS = parseStageList(get("with"));
  let range: RangePreset = (RANGE_PRESETS as readonly string[]).includes(r ?? "") ? (r as RangePreset) : "30";
  let from: number | undefined;
  let to: number | undefined;
  if (range === "custom") {
    const rawF = get("from"), rawT = get("to");
    const f = rawF ? Number(rawF) : NaN;
    const t = rawT ? Number(rawT) : NaN;
    if (isDay(f) && isDay(t) && f <= t && t - f < MAX_SPAN_DAYS) {
      from = f;
      to = t;
    } else {
      range = "30";
    }
  }
  return { scope, query: { range, ...(range === "custom" ? { from, to } : {}), with: withS }, metric, rhythm };
}

/** The URL params for a page state — only what differs from the default, so a plain
 *  `/statistics` stays clean. */
export function pageQueryParams(scope: UsageScope, q: UsagePageQuery, metric: ChartMetric = "words", rhythm: Rhythm = "hours"): Record<string, string> {
  const out: Record<string, string> = {};
  if (scope !== "all") out.kind = scope;
  if (metric !== "words") out.metric = metric;
  if (rhythm !== "hours") out.rhythm = rhythm;
  if (q.range !== "30") out.range = q.range;
  if (q.range === "custom" && q.from !== undefined && q.to !== undefined) {
    out.from = String(q.from);
    out.to = String(q.to);
  }
  if (q.with.length) out.with = q.with.join(",");
  return out;
}

/** The wire query (`GET /v1/usage`) for a page state. */
export function toUsageQuery(q: UsagePageQuery, tz?: string): UsageQuery {
  const base: UsageQuery = { ...(tz ? { tz } : {}), ...(q.with.length ? { with: [...q.with] } : {}) };
  if (q.range === "all") return { ...base, all: true };
  if (q.range === "custom" && q.from !== undefined && q.to !== undefined) return { ...base, from: q.from, to: q.to };
  return { ...base, days: q.range === "custom" ? 30 : Number(q.range) };
}

/** The window a page state resolves to, for the summary pill and the calendar span,
 *  before the server answers (`firstDay` = the server's `range.first_day` once known). */
export function resolveWindow(q: UsagePageQuery, today: number, firstDay?: number | null): { from: number; to: number; days: number } {
  if (q.range === "custom" && q.from !== undefined && q.to !== undefined) {
    return { from: q.from, to: q.to, days: q.to - q.from + 1 };
  }
  if (q.range === "all") {
    const from = isDay(firstDay) && firstDay <= today ? firstDay : today;
    return { from, to: today, days: today - from + 1 };
  }
  const days = q.range === "custom" ? 30 : Number(q.range);
  return { from: today - days + 1, to: today, days };
}

/** True when a kind or a stage filter is set — the RANGE is deliberately not
 *  counted; callers that want it add `q.range !== "30"`. */
export function isFiltered(scope: UsageScope, q: UsagePageQuery): boolean {
  return scope !== "all" || q.with.length > 0;
}

/* ── days ───────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
/** Day-since-epoch → weekday with Monday = 0 (1970-01-01 was a Thursday). */
export function dowOf(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}
/** UTC-midnight Date for a day-since-epoch (the day numbers are local calendar days). */
export function dayDate(day: number): Date {
  return new Date(day * DAY_MS);
}
/** `YYYY-MM-DD` ↔ day-since-epoch, for the custom-span date inputs. */
export function dayToIso(day: number): string {
  return dayDate(day).toISOString().slice(0, 10);
}
export function isoToDay(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return undefined;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return undefined;
  const day = Math.floor(t / DAY_MS);
  return isDay(day) ? day : undefined;
}
/** The first day of the month `months` back from `day`'s month (0 = this month). */
export function monthStart(day: number, months = 0): number {
  const d = dayDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1) / DAY_MS);
}
export function yearStart(day: number, years = 0): number {
  return Math.floor(Date.UTC(dayDate(day).getUTCFullYear() - years, 0, 1) / DAY_MS);
}
export function quarterStart(day: number): number {
  const d = dayDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1) / DAY_MS);
}

/** The custom-span presets: This month · Last month · This quarter · This year · Last year. */
export function spanPresets(today: number): { label: string; from: number; to: number }[] {
  return [
    { label: "This month", from: monthStart(today), to: today },
    { label: "Last month", from: monthStart(today, 1), to: monthStart(today) - 1 },
    { label: "This quarter", from: quarterStart(today), to: today },
    { label: "This year", from: yearStart(today), to: today },
    { label: "Last year", from: yearStart(today, 1), to: yearStart(today) - 1 },
  ];
}

/* ── chart bucketing ────────────────────────────────────────────────────── */

export type BucketMode = "day" | "week" | "month";

/** One column per day up to 120 days, ISO weeks (Mon-first) up to two years, months beyond. */
export function bucketMode(days: number): BucketMode {
  return days <= 120 ? "day" : days <= 730 ? "week" : "month";
}

export interface UsageBucket extends UsageKinds {
  /** First and last day (inclusive) the column covers — trimmed to the window. */
  from: number;
  to: number;
}

function addTotals(a: UsageKindTotals, b: UsageKindTotals): void {
  a.sessions += b.sessions;
  a.requests += b.requests;
  a.errors += b.errors;
  a.words += b.words;
  a.audio_s += b.audio_s;
  a.proc_s += b.proc_s;
}

/** Sum a dense day series into columns for the mode. Day mode returns the days as they are. */
export function bucketize(dense: readonly UsageSeriesPoint[], mode: BucketMode): UsageBucket[] {
  const out: UsageBucket[] = [];
  let cur: UsageBucket | null = null;
  let curKey = "";
  for (const p of dense) {
    const key =
      mode === "day"
        ? String(p.day)
        : mode === "week"
          ? String(p.day - dowOf(p.day))
          : `${dayDate(p.day).getUTCFullYear()}-${dayDate(p.day).getUTCMonth()}`;
    if (!cur || key !== curKey) {
      cur = { from: p.day, to: p.day, ...zeroKinds() };
      curKey = key;
      out.push(cur);
    }
    cur.to = p.day;
    for (const k of ["all", ...KINDS] as const) addTotals(cur[k], safeTotals(p[k]));
  }
  return out;
}

/* ── quantile levels (calendar + hour grid) ──────────────────────────────── */

export type Level = 0 | 1 | 2 | 3 | 4;
/** The three breaks between the four active quarters (inclusive upper bounds). */
export type Breaks = [number, number, number];
export const QUARTER_NAME = ["", "lower quarter", "second quarter", "third quarter", "top quarter"] as const;

/** S1: the four shades are the four quarters of the ACTIVE values (> 0) by rank, so the
 *  busiest value is always the darkest step and a handful of active days still spread
 *  (one day → top; two → second + top; four → one per step). Equal values share the lower
 *  of their steps. Returned as the inclusive upper bound of steps 1–3; empty → [0, 0, 0]. */
export function quantileBreaks(values: readonly number[]): Breaks {
  const a = values.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  const n = a.length;
  const b: Breaks = [0, 0, 0];
  if (!n) return b;
  for (let i = 0; i < n; i++) {
    const level = 4 - Math.floor(((n - 1 - i) * 4) / n);
    if (level <= 3) b[level - 1] = a[i]; // ascending, so the last write is the step's max
  }
  for (let k = 1; k < 3; k++) if (b[k] < b[k - 1]) b[k] = b[k - 1];
  return b;
}

export function levelOf(v: number, b: Breaks): Level {
  return !(v > 0) ? 0 : v <= b[0] ? 1 : v <= b[1] ? 2 : v <= b[2] ? 3 : 4;
}

/** Legend copy for the five steps: `0 · 1–b1 · b1–b2 · b2–b3 · b3+` (`fmt(1)` opens the
 *  first active step, so a duration legend reads `1s–33m`). */
export function legendRanges(b: Breaks, fmt: (n: number) => string, lo = 1): string[] {
  return ["0", `${fmt(lo)}–${fmt(b[0])}`, `${fmt(b[0])}–${fmt(b[1])}`, `${fmt(b[1])}–${fmt(b[2])}`, `${fmt(b[2])}+`];
}

/* ── per-kind cells (D31/D33): what a grid cell's tooltip lists ──────────── */

/** A cell's per-kind totals plus the scoped measure it is levelled on. */
export interface KindSplit {
  kinds: UsageKinds;
  /** The scoped value of the page's measure (levelling + peak). */
  value: number;
}

/** The kinds with a non-zero value of `m` in a split, in kind order — the tooltip's rows. */
export function presentKinds(kinds: UsageKinds, m: ChartMetric, scope: UsageScope): { kind: UsageKind; value: number }[] {
  return KINDS.filter((k) => scope === "all" || k === scope)
    .map((kind) => ({ kind, value: metricValue(safeTotals(kinds[kind]), m) }))
    .filter((r) => r.value > 0);
}

/** How many times each weekday (Mon=0) occurs in `[from, to]` — the hour tooltip's
 *  "≈ N per Tuesday · 78 Tuesdays in range" line (D32). */
export function weekdayCounts(from: number, to: number): [number, number, number, number, number, number, number] {
  const out: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0];
  if (!isDay(from) || !isDay(to) || from > to) return out;
  const end = Math.min(to, from + MAX_SPAN_DAYS + 7);
  for (let d = from; d <= end; d++) out[dowOf(d)]++;
  return out;
}

/* ── calendar ───────────────────────────────────────────────────────────── */

export interface CalendarCell extends KindSplit {
  day: number;
  level: Level;
}

export interface CalendarModel {
  cells: CalendarCell[];
  breaks: Breaks;
  /** Days per level, index = level. */
  counts: [number, number, number, number, number];
}

/** One cell per day of the window for the scoped kind and the page's measure, levelled by
 *  the quartiles of the window's active days. Reads the per-day SERIES (every measure per
 *  kind) rather than the words-only calendar array. Points outside `[from, to]` and
 *  malformed rows are ignored. */
export function calendarModel(series: readonly UsageSeriesPoint[] | undefined, scope: UsageScope, from: number, to: number, metric: ChartMetric = "words"): CalendarModel {
  const byDay = new Map<number, UsageKinds>();
  for (const p of series ?? []) {
    if (!p || !isDay(p.day) || p.day < from || p.day > to) continue;
    const cur = byDay.get(p.day) ?? zeroKinds();
    for (const k of ["all", ...KINDS] as const) addTotals(cur[k], safeTotals(p[k]));
    byDay.set(p.day, cur);
  }
  const valueOf = (k: UsageKinds | undefined) => (k ? metricValue(k[scope], metric) : 0);
  const breaks = quantileBreaks([...byDay.values()].map(valueOf));
  const cells: CalendarCell[] = [];
  const counts: CalendarModel["counts"] = [0, 0, 0, 0, 0];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  for (let d = start; d <= end && d - start < MAX_SPAN_DAYS + 7; d++) {
    const kinds = byDay.get(d) ?? zeroKinds();
    const value = valueOf(kinds);
    const level = levelOf(value, breaks);
    counts[level]++;
    cells.push({ day: d, kinds, value, level });
  }
  return { cells, breaks, counts };
}

export interface CalendarColumn {
  /** The Monday this column starts on (may precede the window). */
  monday: number;
  /** Seven slots Mon..Sun; null where the window does not reach. */
  cells: (CalendarCell | null)[];
  /** Month label when this column holds the first days of a month (or opens the grid). */
  month: string | null;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Week columns, Monday-first, for the grid. A month label goes on the first column whose
 *  Monday..Sunday span holds that month's 1st–7th (and on the first column). */
export function weekColumns(cells: readonly CalendarCell[]): CalendarColumn[] {
  if (!cells.length) return [];
  const first = cells[0].day;
  const monday0 = first - dowOf(first);
  const cols: CalendarColumn[] = [];
  let lastMonth = -1;
  for (let m = monday0, i = 0; i < cells.length; m += 7) {
    const slots: (CalendarCell | null)[] = [];
    for (let r = 0; r < 7; r++) {
      const c = i < cells.length && cells[i].day === m + r ? cells[i++] : null;
      slots.push(c);
    }
    let label: string | null = null;
    for (const c of slots) {
      if (!c) continue;
      const d = dayDate(c.day);
      const mo = d.getUTCMonth();
      if (mo !== lastMonth && (cols.length === 0 || d.getUTCDate() <= 7)) {
        label = MONTH[mo];
        lastMonth = mo;
        break;
      }
    }
    cols.push({ monday: m, cells: slots, month: label });
  }
  return cols;
}

/* ── the busy panel's rhythms (D40 R1): weekday × hour, day of month × hour, year × month ── */

export type Rhythm = "hours" | "days" | "months";
export const RHYTHMS: readonly Rhythm[] = ["hours", "days", "months"];

export function parseRhythm(v: string | null | undefined): Rhythm {
  return (RHYTHMS as readonly string[]).includes(v ?? "") ? (v as Rhythm) : "hours";
}

/** The count beside the measure in the busy tooltip and peak line (D45 C1): sessions, or
 *  processing time when the measure IS sessions — the backend's pairing. */
export function companionMetric(m: ChartMetric): ChartMetric {
  return m === "sessions" ? "proc_s" : "sessions";
}

export const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
export const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const ymdOf = (day: number): [number, number, number] => {
  const d = dayDate(day);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
};

export interface RhythmCell extends KindSplit {
  row: number;
  col: number;
  level: Level;
  /** The scoped companion measure (companionMetric). */
  companion: number;
  /** False for a day-of-month column a one-month window does not reach (never rendered). */
  inWindow: boolean;
}

/** How one rhythm is laid out and named. Hours: weekday rows × hour columns. Days (D42 A2,
 *  the backend's geometry): hour rows × day-of-month columns. Months: year rows × month columns. */
export interface RhythmLayout {
  rows: number;
  cols: number;
  rowLabel: (r: number) => string;
  rowLong: (r: number) => string;
  colLabel: (c: number) => string;
  colLong: (c: number) => string;
  cellName: (i: number) => string;
  colUnit: string;
  colUnits: string;
  rowUnit: string;
  /** The legend's slot word: "weekday hour" / "day-of-month hour" / "month". */
  slotWord: string;
  /** What the side bars compare against: a flat "week" / "month" / "year". */
  flatWord: string;
  /** Days only: how often each day of month occurs in the window (0 = outside a one-month window). */
  colOcc: number[] | null;
}

/** Whether this server sent what the rhythm needs: the measure's nested split on the slots
 *  (`no-measure`: a server from before 2 Sep 2026 sends words only) or the day-of-month grid
 *  at all (`no-grid`). Words and months never depend on either. */
export type RhythmSent = "yes" | "no-measure" | "no-grid";

export interface RhythmModel {
  layout: RhythmLayout;
  /** rows × cols, row-major (index = row * cols + col). */
  cells: RhythmCell[];
  breaks: Breaks;
  counts: [number, number, number, number, number];
  peak: RhythmCell | null;
  colTotals: number[];
  rowTotals: number[];
  /** Each column's / row's total relative to a flat distribution (1 = average). */
  colIndex: number[];
  rowIndex: number[];
  sum: number;
  /** How many times a cell's period occurs in the window: that weekday (hours), that day of
   *  month (days), once (months) — "≈ N per Tuesday · 78 Tuesdays in range". */
  occOf: (cell: RhythmCell) => number;
  /** The period's name for that line: "Tuesday" / "month" / "". */
  occWord: (cell: RhythmCell) => string;
  sent: RhythmSent;
  /** The pattern phrase: "mostly Mon–Fri 06–12", "mostly 21st–31st", "mostly Aug + Sep"; null
   *  when nothing holds enough of the measure. */
  phrase: string | null;
}

export interface RhythmSource {
  hours?: readonly UsageHourCell[] | null;
  dom_hours?: readonly UsageHourCell[] | null;
  /** The window's per-day series (months). */
  series?: readonly UsageSeriesPoint[] | null;
}

/** A slot's per-kind totals: words sit flat on the slot (the original shape), the other
 *  five measures are nested per-kind splits the backend added for its own busy-hours card. */
function slotKinds(h: UsageHourCell): UsageKinds {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
  const out = zeroKinds();
  for (const k of ["all", ...KINDS] as const) {
    out[k].words = num(h[k]);
    out[k].audio_s = num(h.audio_s?.[k]);
    out[k].proc_s = num(h.proc_s?.[k]);
    out[k].sessions = num(h.sessions?.[k]);
    out[k].requests = num(h.requests?.[k]);
    out[k].errors = num(h.errors?.[k]);
  }
  return out;
}

/** The per-kind sum of several cells — a side bar's tooltip. */
export function sumKinds(cells: readonly KindSplit[]): UsageKinds {
  const out = zeroKinds();
  for (const c of cells) for (const k of ["all", ...KINDS] as const) addTotals(out[k], safeTotals(c.kinds[k]));
  return out;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function rhythmLayout(rhythm: Rhythm, from: number, to: number): RhythmLayout & { y0: number } {
  const [fy, fm] = ymdOf(from);
  const [ty, tm] = ymdOf(to);
  if (rhythm === "days") {
    const oneMonth = fy === ty && fm === tm;
    const cols = oneMonth ? daysInMonth(fy, fm) : 31;
    const colOcc = new Array<number>(cols).fill(0);
    const end = Math.min(to, from + MAX_SPAN_DAYS + 31);
    for (let d = from; d <= end; d++) colOcc[ymdOf(d)[2] - 1]++;
    const dayName = (c: number) => (oneMonth ? `${c + 1} ${MONTH[fm]}` : `the ${ordinal(c + 1)}`);
    return {
      rows: 24, cols, y0: fy, colOcc,
      rowLabel: (r) => (r % 2 === 0 ? String(r).padStart(2, "0") : ""),
      rowLong: (r) => `${hh(r)}–${hh(r + 1)}`,
      colLabel: (c) => String(c + 1),
      colLong: (c) => (oneMonth ? `${c + 1} ${MONTH_LONG[fm]}` : `the ${ordinal(c + 1)} of each month`),
      cellName: (i) => `${dayName(i % cols)} ${hh(Math.floor(i / cols))}–${hh(Math.floor(i / cols) + 1)}`,
      colUnit: "day of month", colUnits: "days of the month", rowUnit: "hour of day", slotWord: "day-of-month hour", flatWord: "month",
    };
  }
  if (rhythm === "months") {
    const years = Math.max(1, ty - fy + 1);
    return {
      rows: years, cols: 12, y0: fy, colOcc: null,
      rowLabel: (r) => String(fy + r),
      rowLong: (r) => String(fy + r),
      colLabel: (c) => MONTH[c],
      colLong: (c) => MONTH_LONG[c],
      cellName: (i) => `${MONTH[i % 12]} ${fy + Math.floor(i / 12)}`,
      colUnit: "month", colUnits: "months", rowUnit: "year", slotWord: "month", flatWord: "year",
    };
  }
  return {
    rows: 7, cols: 24, y0: fy, colOcc: null,
    rowLabel: (r) => DOW_SHORT[r],
    rowLong: (r) => `${DOW_LONG[r]}s`,
    colLabel: (c) => String(c).padStart(2, "0"),
    colLong: (c) => `${hh(c)}–${hh(c + 1)}`,
    cellName: (i) => `${DOW_SHORT[Math.floor(i / 24)]} ${hh(i % 24)}–${hh(i % 24 + 1)}`,
    colUnit: "hour of day", colUnits: "hours of the day", rowUnit: "weekday", slotWord: "weekday hour", flatWord: "week",
  };
}

const DAY_PARTS: [string, number, number][] = [["06–12", 6, 12], ["12–18", 12, 18], ["18–24", 18, 24], ["00–06", 0, 6]];

/** Hours: the smallest weekday / part-of-day group holding 60 %+ of the measure (one slot
 *  holding half is named as the slot); days: the third of the month or the part of the day;
 *  months: the top month at 40 %+, else the top two at 50 %+. Ported from the backend. */
function rhythmPhrase(rhythm: Rhythm, values: readonly number[], colTot: readonly number[], rowTot: readonly number[], cols: number): string | null {
  const total = values.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return null;
  if (rhythm === "hours") {
    const sum = (days: readonly number[], a: number, b: number) => days.reduce((s, d) => { for (let h = a; h < b; h++) s += values[d * 24 + h]; return s; }, 0);
    let peak = 0;
    values.forEach((v, i) => { if (v > values[peak]) peak = i; });
    if (values[peak] / total >= 0.5) return `${DOW_SHORT[Math.floor(peak / 24)]} ${String(peak % 24).padStart(2, "0")}–${String(peak % 24 + 1).padStart(2, "0")}`;
    const groups: [string, number[], number, number][] = [];
    const wk = [0, 1, 2, 3, 4], we = [5, 6], all = [0, 1, 2, 3, 4, 5, 6];
    for (let d = 0; d < 7; d++) for (const [p, a, b] of DAY_PARTS) groups.push([`${DOW_SHORT[d]} ${p}`, [d], a, b]);
    for (let d = 0; d < 7; d++) groups.push([DOW_SHORT[d], [d], 0, 24]);
    for (const [p, a, b] of DAY_PARTS) { groups.push([`Mon–Fri ${p}`, wk, a, b]); groups.push([`Sat–Sun ${p}`, we, a, b]); }
    for (const [p, a, b] of DAY_PARTS) groups.push([p, all, a, b]);
    groups.push(["Mon–Fri", wk, 0, 24], ["Sat–Sun", we, 0, 24]);
    for (const [label, days, a, b] of groups) if (sum(days, a, b) / total >= 0.6) return `mostly ${label}`;
    return null;
  }
  if (rhythm === "days") {
    const third = (n: number) => colTot.slice(n * 10, n === 2 ? cols : n * 10 + 10).reduce((a, v) => a + v, 0);
    const thirds: [string, number][] = [["1st–10th", third(0)], ["11th–20th", third(1)], ["21st–31st", third(2)]];
    for (const [label, v] of thirds) if (v / total >= 0.6) return `mostly ${label}`;
    for (const [label, a, b] of DAY_PARTS) if (rowTot.slice(a, b).reduce((x, v) => x + v, 0) / total >= 0.6) return `mostly ${label}`;
    return null;
  }
  const order = colTot.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  if (order[0][0] / total >= 0.4) return `mostly ${MONTH[order[0][1]]}`;
  if ((order[0][0] + order[1][0]) / total >= 0.5) return `mostly ${MONTH[order[0][1]]} + ${MONTH[order[1][1]]}`;
  return null;
}

/** One rhythm of the busy panel for the scoped kind and the page's measure: the cells,
 *  levelled by quartiles of the active ones, the peak, the side-bar totals relative to a
 *  flat distribution, occurrences, the phrase, and whether this server sent what it needs. */
export function rhythmModel(rhythm: Rhythm, src: RhythmSource, scope: UsageScope, metric: ChartMetric, from: number, to: number): RhythmModel {
  const ok = isDay(from) && isDay(to) && from <= to;
  const f = ok ? from : 0;
  const t = ok ? to : 0;
  const L = rhythmLayout(rhythm, f, t);
  const N = L.rows * L.cols;
  const comp = companionMetric(metric);
  const grid: (UsageKinds | undefined)[] = new Array(N);
  const put = (i: number, add: UsageKinds) => {
    if (i < 0 || i >= N) return;
    const cur = grid[i] ?? zeroKinds();
    for (const k of ["all", ...KINDS] as const) addTotals(cur[k], add[k]);
    grid[i] = cur;
  };
  const hourOk = (h: UsageHourCell) => Number.isInteger(h.hour) && h.hour >= 0 && h.hour <= 23;
  let sent: RhythmSent = "yes";
  if (rhythm === "hours") {
    for (const h of src.hours ?? []) {
      if (!h || !hourOk(h) || !Number.isInteger(h.dow) || (h.dow as number) < 0 || (h.dow as number) > 6) continue;
      put((h.dow as number) * 24 + h.hour, slotKinds(h));
    }
  } else if (rhythm === "days") {
    if (!src.dom_hours) sent = "no-grid";
    for (const h of src.dom_hours ?? []) {
      if (!h || !hourOk(h) || !Number.isInteger(h.dom) || (h.dom as number) < 1 || (h.dom as number) > L.cols) continue;
      put(h.hour * L.cols + ((h.dom as number) - 1), slotKinds(h));
    }
  } else {
    for (const p of src.series ?? []) {
      if (!p || !isDay(p.day) || p.day < f || p.day > t) continue;
      const [y, m] = ymdOf(p.day);
      const add = zeroKinds();
      for (const k of ["all", ...KINDS] as const) addTotals(add[k], safeTotals(p[k]));
      put((y - L.y0) * 12 + m, add);
    }
  }
  // A words-only server: the slots exist but carry no nested split for this measure.
  if (sent === "yes" && metric !== "words" && rhythm !== "months") {
    const slots = (rhythm === "hours" ? src.hours : src.dom_hours) ?? [];
    if (slots.length > 0 && !slots.some((h) => h && typeof h[metric] === "object" && h[metric] !== null)) sent = "no-measure";
  }
  const cells: RhythmCell[] = [];
  for (let i = 0; i < N; i++) {
    const kinds = grid[i] ?? zeroKinds();
    const col = i % L.cols;
    cells.push({
      row: Math.floor(i / L.cols), col, kinds, level: 0,
      value: metricValue(kinds[scope], metric),
      companion: metricValue(kinds[scope], comp),
      inWindow: L.colOcc ? L.colOcc[col] > 0 : true,
    });
  }
  const active = cells.filter((c) => c.inWindow);
  const breaks = quantileBreaks(active.map((c) => c.value));
  const counts: RhythmModel["counts"] = [0, 0, 0, 0, 0];
  let peak: RhythmCell | null = null;
  for (const c of cells) {
    c.level = levelOf(c.value, breaks);
    if (!c.inWindow) continue;
    counts[c.level]++;
    if (c.value > 0 && (!peak || c.value > peak.value)) peak = c;
  }
  const colTotals = new Array<number>(L.cols).fill(0);
  const rowTotals = new Array<number>(L.rows).fill(0);
  for (const c of cells) { colTotals[c.col] += c.value; rowTotals[c.row] += c.value; }
  const sum = colTotals.reduce((a, v) => a + v, 0);
  const liveCols = L.colOcc ? L.colOcc.filter((n) => n > 0).length || L.cols : L.cols;
  const colIndex = colTotals.map((v) => (sum > 0 ? v / (sum / liveCols) : 0));
  const rowIndex = rowTotals.map((v) => (sum > 0 ? v / (sum / L.rows) : 0));
  const wd = rhythm === "hours" ? weekdayCounts(f, t) : null;
  const { y0: _y0, ...layout } = L;
  return {
    layout, cells, breaks, counts, peak, colTotals, rowTotals, colIndex, rowIndex, sum, sent,
    occOf: (c) => (wd ? wd[c.row] : L.colOcc ? L.colOcc[c.col] : 1),
    occWord: (c) => (rhythm === "hours" ? DOW_LONG[c.row] : rhythm === "days" ? "month" : ""),
    phrase: rhythmPhrase(rhythm, cells.map((c) => c.value), colTotals, rowTotals, L.cols),
  };
}

export const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/* ── streaks ────────────────────────────────────────────────────────────── */

export function streakFor(streaks: Partial<UsageStreaks> | null | undefined, scope: UsageScope): UsageStreak {
  const s = streaks?.[scope];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  return { current: n(s?.current), best: n(s?.best) };
}

/* ── stages ─────────────────────────────────────────────────────────────── */

export interface StageRowMeta {
  key: UsageStageKey;
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

/** The rows in display order for the active filters: chosen stages pinned on top (in
 *  chip order), then the rest in the panel's usual order. */
export function orderedStageRows(withS: readonly UsageStageKey[]): StageRowMeta[] {
  const pinned = withS.map((k) => STAGE_ROWS.find((r) => r.key === k)).filter((r): r is StageRowMeta => !!r);
  return [...pinned, ...STAGE_ROWS.filter((r) => !withS.includes(r.key))];
}

/** The audio stages only ever run on files and links; under a Dictation or Text kind
 *  their rows say so instead of showing an empty meter. */
export function stageAppliesToScope(key: UsageStageKey, scope: UsageScope): boolean {
  return key === "translating" || scope === "all" || scope === "file" || scope === "url";
}

/** The server's row for a stage, if it reported one with any runs. */
export function findStage(stages: readonly UsageStage[] | undefined, key: UsageStageKey): UsageStage | undefined {
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
  /** Hover text when the label alone does not say it all (a language row's kept count). */
  title?: string;
  value: number;
  /** Width as a share of the facet's largest row (the mockup scales bars to the max). */
  pct: number;
  /** Rendered in the faint tone (an outcome that is not a success story). */
  dim?: boolean;
  /** Overrides the accent chart colour (the translated row uses the stage hue). */
  colorVar?: string;
}

/** Rows scaled to the largest value; zero rows kept (they read as "none") unless `dropZero`.
 *  `scaleTo` = "lit" scales to the largest NON-dim row instead, so the "Translated into"
 *  facet keeps its languages readable next to a much larger dim "Not asked" (a dim row
 *  wider than the scale is clamped to full width). */
export function facetRows(
  rows: readonly { label: string; title?: string; value: number; dim?: boolean; colorVar?: string }[],
  dropZero = false,
  scaleTo: "all" | "lit" = "all",
): FacetRow[] {
  const clean = rows
    .map((r) => ({ ...r, value: typeof r.value === "number" && Number.isFinite(r.value) ? Math.max(0, r.value) : 0 }))
    .filter((r) => !dropZero || r.value > 0);
  let max = clean.reduce((m, r) => (scaleTo === "lit" && r.dim ? m : Math.max(m, r.value)), 0);
  // When every lit row has value 0, fall back to the all-rows max so dim rows
  // still render their bars — "Not asked: 87" next to a zero-width bar reads
  // as "no data" when there IS data.
  if (max === 0 && scaleTo === "lit") max = clean.reduce((m, r) => Math.max(m, r.value), 0);
  return clean.map((r) => ({ ...r, pct: max > 0 ? Math.min(100, Math.round((r.value / max) * 100)) : 0 }));
}

/** The "Translated into" facet: one row per target code (upper-case, the picker's codes),
 *  then the outcomes that were not a translation, dim. Codes come from the server and are
 *  shown as-is (D26: code only), so a stray value is clipped to 8 chars. */
export function translationRows(d: {
  targets?: readonly { code: string; runs: number; kept_original: number }[];
  translation?: { kept_original: number; not_asked: number; aborted: number; unreported: number };
}): FacetRow[] {
  const langs = (d.targets ?? [])
    .filter((t) => t && typeof t.code === "string" && t.code.trim() !== "")
    .slice(0, 6)
    .map((t) => {
      const code = t.code.trim().slice(0, 8).toUpperCase();
      const kept = typeof t.kept_original === "number" && t.kept_original > 0 ? t.kept_original : 0;
      const runs = typeof t.runs === "number" ? t.runs : 0;
      return {
        label: code,
        title: `${code} · ${runs} ${runs === 1 ? "dictation" : "dictations"}${kept > 0 ? ` · ${kept} kept the original` : ""}`,
        value: runs,
        colorVar: "var(--c-translate)",
      };
    });
  const tr = d.translation ?? { kept_original: 0, not_asked: 0, aborted: 0, unreported: 0 };
  return facetRows(
    [
      ...langs,
      { label: "Kept original", value: tr.kept_original, dim: true },
      { label: "Not asked", value: tr.not_asked, dim: true },
      ...(tr.aborted > 0 ? [{ label: "Aborted", value: tr.aborted, dim: true }] : []),
      ...(tr.unreported > 0 ? [{ label: "Unreported", value: tr.unreported, dim: true }] : []),
    ],
    false,
    "lit",
  );
}
