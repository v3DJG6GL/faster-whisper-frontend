// Own-property reads for maps keyed by an UNTRUSTED string.
//
// Backend ids are used verbatim as keys in several plain-object maps (`usage`, `connections`,
// `settings.sync.urlOverrides`, the keyring read-back), and an inbound id is whatever a sync blob
// or an imported file chose. `isReservedBackendId` only rejects the `__…__` keyring namespace, so
// `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`… all survive
// sanitization — and for every one of them `map[id]` returns a FUNCTION off `Object.prototype` and
// `id in map` returns true. `?.` does not help: an inherited value is non-nullish.
//
// The consequences are not theoretical. `db69e08` fixed three sites where the inherited value
// reached a `.trim()` inside a render body — and the tree has no error boundary anywhere
// (`grep componentDidCatch src/` is empty), so the throw unmounts the window, including the only
// UI that could delete the offending backend. The same shape reaches a `for…of` in a chart's
// densifier and a deref inside a zustand subscriber, where the throw propagates out of `set()` and
// aborts every listener registered after it.
//
// These two helpers are the fix for the whole class: they answer the question `[]` and `in` were
// being asked to answer — "did WE put something here?" — and are exactly equivalent for the
// `crypto.randomUUID()` ids every legitimate path produces.

/** `map[key]`, but only when `key` is an OWN property — inherited `Object.prototype` members read
 *  as absent rather than as a function. */
export function ownProp<T>(map: Record<string, T> | undefined | null, key: string): T | undefined {
  if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  return map[key];
}

/** `key in map`, but own-properties only. */
export function hasOwn(map: Record<string, unknown> | undefined | null, key: string): boolean {
  return !!map && Object.prototype.hasOwnProperty.call(map, key);
}
