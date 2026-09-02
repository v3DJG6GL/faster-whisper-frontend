// Pure derivations for the usage surfaces (Statistics page, Home strip): the
// per-kind densified series, scope filtering, tile values, the page query (range presets,
// custom span, stage filter) and its URL form, chart bucketing, the quantile calendar and
// hour-grid levels, streaks and the stage-row vocabulary. No React, no store — every function takes its inputs so
// vitest covers it without a webview. The charts in components/UsageStats.tsx only
// lay these numbers out.

import type {
  UsageCalendarDay,
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

/** `?kind=&with=&range=&from=&to=` (plus the older `?scope=`) → page state. Anything
 *  unrecognised falls back to the default; a custom range without a usable span too. */
export function parsePageQuery(get: (key: string) => string | null): { scope: UsageScope; query: UsagePageQuery } {
  const scope = parseScope(get("kind") ?? get("scope"));
  const r = get("range");
  const withS = parseStageList(get("with"));
  let range: RangePreset = (RANGE_PRESETS as readonly string[]).includes(r ?? "") ? (r as RangePreset) : "30";
  let from: number | undefined;
  let to: number | undefined;
  if (range === "custom") {
    const f = Number(get("from"));
    const t = Number(get("to"));
    if (isDay(f) && isDay(t) && f <= t && t - f < MAX_SPAN_DAYS) {
      from = f;
      to = t;
    } else {
      range = "30";
    }
  }
  return { scope, query: { range, ...(range === "custom" ? { from, to } : {}), with: withS } };
}

/** The URL params for a page state — only what differs from the default, so a plain
 *  `/statistics` stays clean. */
export function pageQueryParams(scope: UsageScope, q: UsagePageQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (scope !== "all") out.kind = scope;
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

/** True when anything but the default range / no stages / every kind is set. */
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

/** Legend copy for the five steps: `0 · 1–b1 · b1–b2 · b2–b3 · b3+`. */
export function legendRanges(b: Breaks, fmt: (n: number) => string): string[] {
  return ["0", `1–${fmt(b[0])}`, `${fmt(b[0])}–${fmt(b[1])}`, `${fmt(b[1])}–${fmt(b[2])}`, `${fmt(b[2])}+`];
}

/* ── calendar ───────────────────────────────────────────────────────────── */

export interface CalendarCell {
  day: number;
  words: number;
  level: Level;
}

export interface CalendarModel {
  cells: CalendarCell[];
  breaks: Breaks;
  /** Days per level, index = level. */
  counts: [number, number, number, number, number];
}

/** One cell per day of the window for the scoped kind, levelled by the quartiles of the
 *  window's active days. Cells outside `[from, to]` and malformed rows are ignored. */
export function calendarModel(calendar: readonly UsageCalendarDay[] | undefined, scope: UsageScope, from: number, to: number): CalendarModel {
  const byDay = new Map<number, number>();
  for (const c of calendar ?? []) {
    if (!c || !isDay(c.day) || c.day < from || c.day > to) continue;
    const w = c[scope];
    byDay.set(c.day, (byDay.get(c.day) ?? 0) + (typeof w === "number" && Number.isFinite(w) ? Math.max(0, w) : 0));
  }
  const breaks = quantileBreaks([...byDay.values()]);
  const cells: CalendarCell[] = [];
  const counts: CalendarModel["counts"] = [0, 0, 0, 0, 0];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  for (let d = start; d <= end && d - start < MAX_SPAN_DAYS + 7; d++) {
    const words = byDay.get(d) ?? 0;
    const level = levelOf(words, breaks);
    counts[level]++;
    cells.push({ day: d, words, level });
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

/* ── hour grid ──────────────────────────────────────────────────────────── */

export interface HourCell {
  dow: number;
  hour: number;
  words: number;
  level: Level;
}

export interface HourModel {
  /** 7 rows (Mon..Sun) × 24. */
  rows: HourCell[][];
  breaks: Breaks;
  counts: [number, number, number, number, number];
  peak: HourCell | null;
}

/** The weekday × hour grid for the scoped kind, levelled by the quartiles of the active slots. */
export function hourModel(hours: readonly UsageHourCell[] | undefined, scope: UsageScope): HourModel {
  const grid = new Map<string, number>();
  for (const h of hours ?? []) {
    if (!h || !Number.isInteger(h.dow) || h.dow < 0 || h.dow > 6 || !Number.isInteger(h.hour) || h.hour < 0 || h.hour > 23) continue;
    const w = h[scope];
    const k = `${h.dow}:${h.hour}`;
    grid.set(k, (grid.get(k) ?? 0) + (typeof w === "number" && Number.isFinite(w) ? Math.max(0, w) : 0));
  }
  const breaks = quantileBreaks([...grid.values()]);
  const counts: HourModel["counts"] = [0, 0, 0, 0, 0];
  let peak: HourCell | null = null;
  const rows: HourCell[][] = [];
  for (let d = 0; d < 7; d++) {
    const row: HourCell[] = [];
    for (let h = 0; h < 24; h++) {
      const words = grid.get(`${d}:${h}`) ?? 0;
      const cell: HourCell = { dow: d, hour: h, words, level: levelOf(words, breaks) };
      counts[cell.level]++;
      if (words > 0 && (!peak || words > peak.words)) peak = cell;
      row.push(cell);
    }
    rows.push(row);
  }
  return { rows, breaks, counts, peak };
}

export const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/* ── streaks ────────────────────────────────────────────────────────────── */

export function streakFor(streaks: Partial<UsageStreaks> | null | undefined, scope: UsageScope): UsageStreak {
  const s = streaks?.[scope];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  return { current: n(s?.current), best: n(s?.best) };
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

/** The rows in display order for the active filters: chosen stages pinned on top (in
 *  chip order), then the rest in the panel's usual order. */
export function orderedStageRows(withS: readonly UsageStageKey[]): StageRowMeta[] {
  const pinned = withS.map((k) => STAGE_ROWS.find((r) => r.key === k)).filter((r): r is StageRowMeta => !!r);
  return [...pinned, ...STAGE_ROWS.filter((r) => !withS.includes(r.key))];
}

/** The audio stages only ever run on files and links; under a Dictation or Text kind
 *  their rows say so instead of showing an empty meter. */
export function stageAppliesToScope(key: StageKey, scope: UsageScope): boolean {
  return key === "translating" || scope === "all" || scope === "file" || scope === "url";
}

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
  const max = clean.reduce((m, r) => (scaleTo === "lit" && r.dim ? m : Math.max(m, r.value)), 0);
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
