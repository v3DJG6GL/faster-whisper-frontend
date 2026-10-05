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
import { safeDisplayText } from "./sanitize";
import { TRANSLATION_MAX_TARGETS } from "./languages";
import type { Backend, Capabilities } from "./types";

/** Floor between two fetches for the same Backend. A queue edit, a profile
 *  switch and a panel opening can all ask within the same frame; without this
 *  each one would be its own request to /v1/me. */
const MIN_INTERVAL_MS = 2_000;

const lastFetchAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

/** Refresh a Backend's cached capabilities. Best-effort and never throws: a
 *  standard/old server stores null ("fetched and unsupported"); a transient error
 *  leaves the cache entry absent so the next trigger re-probes instead of latching
 *  a stale negative. `force` bypasses the min-interval coalescing (used when a job
 *  is starting and the freshness of `loaded` is the whole point). */
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
    if (fetched !== null) st.setCaps(backend.id, fetched);
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

/** The target codes a translation model supports — `model` empty = the server's default model
 *  (it lists that one first). `null` means UNKNOWN (no caps, an older server, a model the
 *  server has no list for, or one it doesn't offer): the picker then offers every language
 *  without a "not tested" tag. */
export function translationLanguages(caps: Capabilities | null | undefined, model?: string): string[] | null {
  const list = caps?.translation_models;
  if (!list?.length) return null;
  const want = model?.trim();
  const hit = want ? list.find((m) => m.id === want) : list[0];
  return Array.isArray(hit?.languages) ? hit.languages.filter((c) => typeof c === "string") : null;
}

/** How many translation targets one run may carry on this server: the app's own ceiling
 *  (TRANSLATION_MAX_TARGETS), lowered to the server's TRANSLATION_MAX_TARGETS for this caller
 *  when it says one (`server_info.limits`). Unknown (no caps, an older server, a value that is
 *  not a number ≥ 1) = the app's ceiling — an absent capability never narrows a choice. The
 *  text route refuses a request over the server's cap, so dictation clamps to this too. */
export function maxTranslationTargets(caps: Capabilities | null | undefined): number {
  const limit = caps?.server_info?.limits?.translation_max_targets;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return TRANSLATION_MAX_TARGETS;
  return Math.min(TRANSLATION_MAX_TARGETS, Math.floor(limit));
}

/** A translation model id as the "Supported by …" group names it: its last path part. */
export function modelShortName(id: string | undefined): string | undefined {
  return id ? safeDisplayText(id.split("/").pop() || id, 40) : undefined;
}

/** A translation-target picker's grouping for a model (empty = the server's default): its
 *  languages (translationLanguages) and the short name "Supported by …" shows. */
export function translationTargetInfo(
  caps: Capabilities | null | undefined, model?: string,
): { supported: string[] | null; modelName?: string } {
  return {
    supported: translationLanguages(caps, model),
    modelName: modelShortName(model || caps?.translation_models?.[0]?.id),
  };
}
