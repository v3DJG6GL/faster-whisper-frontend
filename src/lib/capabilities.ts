// Per-Backend capability cache (GET /v1/me) — the on-demand sibling of usage.ts.
//
// Modelled on lib/usage.ts, with one deliberate difference: there is NO polling
// loop. Capabilities move only when the server is restarted or reconfigured, and
// the values we care about (translation_models[].loaded) are read at the moment a
// job starts, so every refresh here is triggered by a caller that is about to act.
//
// It exists because the non-React consumers — streaming.ts, preload.ts — have no
// hook to hang a fetch off, and because the only previous consumer
// (useOverrideContext) refetched on every mount and cached nothing.

import { useApp } from "./store";
import { getCapabilities } from "./api";
import { effectiveServerKind } from "./serverKind";
import { effectiveServerUrl } from "./backends";
import { hasOwn, ownProp } from "./own";
import type { Backend, Capabilities } from "./types";

/** Floor between two fetches for the same Backend. A queue edit, a profile
 *  switch and a panel opening can all ask within the same frame; without this
 *  each one would be its own request to /v1/me. */
const MIN_INTERVAL_MS = 2_000;

const lastFetchAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

/** Refresh a Backend's cached capabilities. Best-effort and never throws: a
 *  standard/old server or any error stores null ("fetched and unsupported").
 *  `force` bypasses the min-interval coalescing (used when a job is starting and
 *  the freshness of `loaded` is the whole point). */
export async function refreshCaps(backend: Backend, opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  const prev = lastFetchAt.get(backend.id);
  if (!opts?.force && prev !== undefined && now - prev < MIN_INTERVAL_MS) return;
  // Share one in-flight request rather than starting a second: `force` should skip
  // the interval, not multiply the requests when several triggers land together.
  const running = inFlight.get(backend.id);
  if (running) return running;

  const { connections, caps, setCaps } = useApp.getState();
  // Skip a server we KNOW is standard (no /v1/me); "unknown" ⇒ try anyway — the
  // same gate useOverrideContext applies before its own fetch.
  if (effectiveServerKind(backend, ownProp(connections, backend.id)) === "standard") {
    // Key-presence, not truthiness: `!caps[id]` is true for the null we just
    // wrote, so a truthiness test would re-set null (and spread a fresh object)
    // on every trigger. Own-property test so an id like `constructor` isn't
    // read as already-present via the prototype.
    if (!hasOwn(caps, backend.id)) setCaps(backend.id, null);
    return;
  }

  const target = effectiveServerUrl(backend, useApp.getState().settings);
  lastFetchAt.set(backend.id, now);
  const run = (async () => {
    const fetched = await getCapabilities({ serverUrl: target, backendId: backend.id }).catch(
      () => null,
    );
    // Verbatim from usage.ts: a slow fetch against the OLD server can resolve AFTER
    // the user edited this backend's URL/key (the store dropped the stale caps) or
    // removed it. Bail unless the backend still exists with the same target — else
    // we'd re-install the previous server's capabilities under a backend that now
    // points somewhere else, undoing the invalidation that just ran.
    const st = useApp.getState();
    const cur = st.backends.find((x) => x.id === backend.id);
    if (!cur || cur.serverUrl !== backend.serverUrl || cur.hasApiKey !== backend.hasApiKey) return;
    // …and the URL OVERRIDE, which is where this request actually went — the third
    // trigger `setUrlOverride` invalidates on.
    if (effectiveServerUrl(cur, st.settings) !== target) return;
    st.setCaps(backend.id, fetched);
  })();
  inFlight.set(backend.id, run);
  try {
    await run;
  } finally {
    inFlight.delete(backend.id);
  }
}

/** Whether a translation model is already resident on the server.
 *
 *  `null` means UNKNOWN — no caps fetched yet, or an older backend that sends no
 *  `translation_models` at all. Callers must not read null as "cold": this
 *  codebase's rule is that an absent capability is never treated as a denial.
 *  With `model` given, answers for that model specifically; without one, "is ANY
 *  translation model loaded". */
export function translationWarm(caps: Capabilities | null, model?: string): boolean | null {
  const list = caps?.translation_models;
  if (!list) return null;
  const want = model?.trim();
  if (!want) return list.some((m) => m.loaded);
  const hit = list.find((m) => m.id === want);
  // A model the server doesn't list is not "unknown" — the inventory IS the
  // answer, and a model outside it is certainly not resident.
  return hit ? hit.loaded : false;
}
