// Number + duration formatting for usage stats (and any figures elsewhere).
// Pair these with the `.font-num` class so digits align (tabular numerals).

/** Full integer with thousands separators, e.g. `1,240`. */
export function fmtFull(n: number): string {
  return Math.round(n || 0).toLocaleString("en-US");
}

/** Compact for large totals: `1,240` · `84.2k` · `1.2M`. */
export function fmtCompact(n: number): string {
  const v = Math.round(n || 0);
  const a = Math.abs(v);
  if (a < 1000) return v.toLocaleString("en-US");
  if (a < 1_000_000) {
    const k = v / 1000;
    return `${(a < 10_000 ? k.toFixed(1) : String(Math.round(k))).replace(/\.0$/, "")}k`;
  }
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Seconds → readable duration for tiles: `0s` · `47s` · `17m` · `3h` · `3h 12m`. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Seconds → terse duration for chart axis ticks: `47s` · `33m` · `1.7h`. */
export function fmtDurationAxis(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1).replace(/\.0$/, "")}h`;
}
