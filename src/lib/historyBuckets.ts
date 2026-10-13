// History's day groups: "Today" / "Yesterday" / a local date, and one "Earlier" group for
// stamps that do not parse. Pure, so the grouping is testable without mounting the screen.

// Hoisted: toLocale*String with options builds a fresh Intl.DateTimeFormat per call, and this
// runs per record on every keystroke.
const DAY_FMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" });

export const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** "Today" / "Yesterday" / a local date — the bucket a record sorts under; null when the stamp
 *  does not parse. `todayStart` is `startOfDay(new Date())`, refreshed at local midnight. */
function dayBucket(iso: string, todayStart: number): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diffDays = Math.round((todayStart - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return DAY_FMT.format(d);
}

/** Group newest-first records by day, in their order. A label is one group even when its
 *  records are not adjacent: the list is sorted on the raw stamp strings, so a damaged or
 *  foreign stamp ('garbage' sorts above ISO, '' below; a non-Z offset among Z stamps) splits
 *  a day — two groups of one label drew twice and shared a React key. Unparseable stamps form
 *  one "Earlier" group, last. */
export function dayBuckets<T extends { createdAt: string }>(
  records: readonly T[],
  todayStart: number,
): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  const byLabel = new Map<string, { label: string; items: T[] }>();
  const earlier: T[] = [];
  for (const rec of records) {
    const label = dayBucket(rec.createdAt, todayStart);
    if (label === null) {
      earlier.push(rec);
      continue;
    }
    let bucket = byLabel.get(label);
    if (!bucket) {
      bucket = { label, items: [] };
      byLabel.set(label, bucket);
      out.push(bucket);
    }
    bucket.items.push(rec);
  }
  if (earlier.length > 0) out.push({ label: "Earlier", items: earlier });
  return out;
}
