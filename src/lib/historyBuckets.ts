// History's day groups: "Today" / "Yesterday" / a local date, and one "Earlier" group for
// stamps that do not parse. Pure, so the grouping is testable without mounting the screen.

// Hoisted: toLocale*String with options builds a fresh Intl.DateTimeFormat per call, and this
// runs per record on every keystroke.
const DAY_FMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" });

export const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** "Today" / "Yesterday" / a local date — the bucket a record sorts under, with the local day
 *  start it orders by (future stamps count as today); null when the stamp does not parse.
 *  `todayStart` is `startOfDay(new Date())`, refreshed at local midnight. */
function dayBucket(d: Date, todayStart: number): { label: string; day: number } | null {
  if (Number.isNaN(d.getTime())) return null;
  const day = Math.min(startOfDay(d), todayStart);
  const diffDays = Math.round((todayStart - day) / 86_400_000);
  if (diffDays <= 0) return { label: "Today", day };
  if (diffDays === 1) return { label: "Yesterday", day };
  return { label: DAY_FMT.format(d), day };
}

/** Group records by day, newest day first and newest record first inside a day. A label is
 *  one group even when its records are not adjacent, and both orders go by the parsed instant:
 *  a list sorted on the raw stamp strings would let a damaged or foreign stamp ('garbage' sorts
 *  above ISO, '' below; a non-Z offset among Z stamps) split a day or lift an older day
 *  above today — two groups of one label drew twice and shared a React key. Unparseable stamps
 *  form one "Earlier" group, last, in their given order. */
export function dayBuckets<T extends { createdAt: string }>(
  records: readonly T[],
  todayStart: number,
): { label: string; items: T[] }[] {
  type Group = { label: string; day: number; items: { rec: T; at: number }[] };
  const byLabel = new Map<string, Group>();
  const earlier: T[] = [];
  for (const rec of records) {
    const d = new Date(rec.createdAt);
    const bucket = dayBucket(d, todayStart);
    if (bucket === null) {
      earlier.push(rec);
      continue;
    }
    let group = byLabel.get(bucket.label);
    if (!group) {
      group = { ...bucket, items: [] };
      byLabel.set(bucket.label, group);
    }
    group.items.push({ rec, at: d.getTime() });
  }
  // Both sorts are stable, so equal days / instants keep their given order.
  const out = [...byLabel.values()]
    .sort((a, b) => b.day - a.day)
    .map((g) => ({ label: g.label, items: g.items.sort((a, b) => b.at - a.at).map((x) => x.rec) }));
  if (earlier.length > 0) out.push({ label: "Earlier", items: earlier });
  return out;
}
