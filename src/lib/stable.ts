// Canonical JSON stringify, extracted from sync.ts so modules can compare
// values without importing the sync engine (which pulls in store/api).
// Consumers: useUnsavedGuard.ts, sync.ts (which re-exports this one).

/** JSON.stringify with recursively sorted object keys, so semantically-equal
 *  values hash equal regardless of construction order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
