import { useEffect, useState } from "react";

/**
 * `value`, settled: it follows `value` only once `value` has stopped changing for `ms`. Seeded
 * with the value at mount, so a fetch keyed on it fires immediately on open and only typing is
 * held back.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
