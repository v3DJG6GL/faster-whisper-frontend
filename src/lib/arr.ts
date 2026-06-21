// Tiny array helpers shared across the store and the reorder UIs.

/** Return a copy of `arr` with indices `i` and `j` swapped. If `j` is out of bounds, return `arr`
 *  unchanged (the SAME reference) so a caller can treat an at-edge move as a no-op (e.g. an
 *  onChange with the same ref makes React bail, and a store setter can detect it to return {}). */
export function swap<T>(arr: T[], i: number, j: number): T[] {
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
