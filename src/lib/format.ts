// Number + duration formatting for usage stats (and any figures elsewhere).
// Pair these with the `.font-num` class so digits align (tabular numerals).

/** Full integer with thousands separators, e.g. `1,240`. */
export function fmtFull(n: number): string {
  return Math.round(n || 0).toLocaleString("en-US");
}

/** Compact for large totals: `840` · `1.2k` · `84k` · `1.2M`. */
export function fmtCompact(n: number): string {
  const v = Math.round(n || 0);
  const a = Math.abs(v);
  if (a < 1000) return v.toLocaleString("en-US");
  if (a < 10_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  // Use M once the rounded kilo saturates to 1000 (e.g. 999,999 → "1M", not "1000k").
  if (a < 1_000_000 && Math.abs(Math.round(v / 1000)) < 1000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Seconds → readable duration for tiles: `0s` · `47s` · `17m` · `3h` · `3h 12m`. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  // Round to whole minutes ONCE, then split — otherwise a remainder that rounds to 60
  // renders as "60m" / "1h 60m" (e.g. 3599→"60m", 7170→"1h 60m") instead of "1h" / "2h".
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Seconds → terse duration for chart axis ticks: `47s` · `33m` · `1.7h`. */
export function fmtDurationAxis(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  // Once the minutes round up to 60, show hours (3599 → "1h", not "60m").
  if (Math.round(s / 60) < 60) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1).replace(/\.0$/, "")}h`;
}

// ── usage-chart dates ──────────────────────────────────────────────────────
// The series carries `day` = days-since-epoch (server-local calendar day). We
// format with timeZone:"UTC" so the rendered date matches that integer exactly,
// independent of the viewer's offset (avoids an off-by-one near midnight).
const DAY_MS = 86_400_000;
const _tickDay = new Intl.DateTimeFormat("de-CH", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const _tickMonth = new Intl.DateTimeFormat("de-CH", { month: "short", timeZone: "UTC" });
const _full = new Intl.DateTimeFormat("de-CH", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });

/** days-since-epoch → a Date at UTC midnight of that calendar day. */
export function dayToDate(day: number): Date {
  return new Date(day * DAY_MS);
}

/** Axis tick label: `12.06.` (day+month), or a short month name (`Juni`) when
 *  `month` is set — used on wide windows so labels don't crowd. */
export function fmtDateTick(day: number, month = false): string {
  return (month ? _tickMonth : _tickDay).format(dayToDate(day));
}

/** Tooltip header: `Fr., 12. Juni`. */
export function fmtDateFull(day: number): string {
  return _full.format(dayToDate(day));
}

/** The client's LOCAL day-since-epoch — matches the backend's server-local
 *  `epoch_day_for` for whole-hour timezone offsets (e.g. CET), so it anchors the
 *  chart's right edge ("today") to the same day numbering the series uses. */
export function localTodayDay(): number {
  return Math.floor((Date.now() - new Date().getTimezoneOffset() * 60_000) / DAY_MS);
}
