// Per-Backend capability cache (GET /v1/me) — the on-demand sibling of usage.ts.
//
// Unlike usage.ts there is NO polling loop: capabilities move only when the server
// is restarted or reconfigured, and the one value that must be fresh
// (translation_models[].loaded) is read at the moment a job starts, so a refresh is
// triggered by a caller about to act (or by a fresh connection verdict). It is a module,
// not a hook, because streaming.ts and transcribeRun.ts have no hook to hang a fetch off.

import { useApp } from "./store";
import { getCapabilities } from "./api";
import { effectiveServerKind } from "./serverKind";
import { effectiveServerUrl } from "./backends";
import { hasOwn, ownProp } from "./own";
import { shortModelName } from "./inherit";
import { targetCap } from "./languages";
import { wireCodes } from "./translationTargets";
import type { Backend, Capabilities } from "./types";

/** Floor between two fetches for the same Backend. A queue edit, a profile
 *  switch and a panel opening can all ask within the same frame; without this
 *  each one would be its own request to /v1/me. */
const MIN_INTERVAL_MS = 2_000;

/** Both keyed by Backend id and stamped with the address the request went to: the floor and
 *  the coalescing below apply only to a request for the SAME target. Keyed by id alone, the
 *  forced refresh after fixing an unreachable address would join the run still hanging on the
 *  OLD host (up to the client timeout), whose answer the guards then discard — leaving the
 *  corrected server's caps absent until some later dictation. */
const lastFetchAt = new Map<string, { at: number; target: string }>();
const inFlight = new Map<
  string,
  { run: Promise<void>; target: string; hasKey: boolean; gen: number }
>();
/** Bumped by `forgetCaps`: a fetch that started under an older generation was sent with a
 *  credential that is no longer this Backend's, so its answer must not land in the store. */
const generation = new Map<string, number>();

/** Drop this module's bookkeeping for a Backend whose credential changed without its address or
 *  key presence changing (a rotated API key). /v1/me is per-caller, so an in-flight fetch made
 *  with the OLD key must not re-install that caller's caps, and neither the min-interval floor
 *  nor in-flight coalescing may hand the next reader that stale request. The store side
 *  (dropping the cached caps) is the caller's job. */
export function forgetCaps(id: string): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
  inFlight.delete(id);
  lastFetchAt.delete(id);
}

/** A Backend's credential changed (key rotation): bump its caps generation and drop every cache
 *  measured as the old caller — the one pair every rotation path runs. */
export function forgetCredential(id: string): void {
  forgetCaps(id);
  useApp.getState().forgetBackendCaches(id);
}

/** The credential generation `forgetCaps` bumps: a caller that awaits a request made with this
 *  Backend's credential (a connection test) snapshots it first and drops the answer if it moved —
 *  a saved key rotation keeps the address and key presence its other guards compare. */
export function credentialGeneration(id: string): number {
  return generation.get(id) ?? 0;
}

/** The credential generation a request is made under: the stored key's when the request uses it
 *  (no typed `apiKey`), else 0 — a typed key is the request's credential itself. One rule for
 *  every hook that refetches per caller, so they can't drift apart. */
export function requestCredentialGen(backendId: string | null | undefined, apiKey: string | null | undefined): number {
  return backendId && !apiKey ? credentialGeneration(backendId) : 0;
}

/** Refresh a Backend's cached capabilities. Best-effort and never throws: a server
 *  known to be standard stores null ("fetched and unsupported"); any other null answer
 *  (an older server without /v1/me, a transient error) leaves the cache entry absent so
 *  the next trigger re-probes instead of latching a stale negative. `force` skips the
 *  min-interval floor (used when a job is starting and the freshness of `loaded` is the
 *  whole point); a matching in-flight request is still shared. */
export async function refreshCaps(backend: Backend, opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  const target = effectiveServerUrl(backend, useApp.getState().settings);
  const gen = generation.get(backend.id) ?? 0;
  const prev = lastFetchAt.get(backend.id);
  if (!opts?.force && prev?.target === target && now - prev.at < MIN_INTERVAL_MS) return;
  // Share one in-flight request rather than starting a second: `force` should skip
  // the interval, not multiply the requests when several triggers land together.
  // Only a request for the same target, key presence and generation is shareable; any
  // other one is superseded below (its answer is discarded by the guards in `run`).
  const running = inFlight.get(backend.id);
  if (
    running &&
    running.target === target &&
    running.hasKey === backend.hasApiKey &&
    running.gen === gen
  ) {
    return running.run;
  }

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

  lastFetchAt.set(backend.id, { at: now, target });
  const run = (async () => {
    const fetched = await getCapabilities({ serverUrl: target, backendId: backend.id }).catch(
      () => null,
    );
    // Asked with a key that has since been rotated (forgetCaps): same address, same key
    // presence, so the guards below cannot tell — the generation can.
    if ((generation.get(backend.id) ?? 0) !== gen) return;
    // A slow fetch against the OLD server can resolve AFTER the user edited this
    // backend's URL/key (the store dropped the stale caps) or removed it. Bail unless
    // the backend still exists with the same target — else we'd re-install the previous
    // server's capabilities under a backend that now points somewhere else.
    const st = useApp.getState();
    const cur = st.backends.find((x) => x.id === backend.id);
    if (!cur || cur.serverUrl !== backend.serverUrl || cur.hasApiKey !== backend.hasApiKey) return;
    // …and the URL OVERRIDE, which is where this request actually went — the third
    // trigger `setUrlOverride` invalidates on.
    if (effectiveServerUrl(cur, st.settings) !== target) return;
    if (fetched !== null) st.setCaps(backend.id, fetched);
  })();
  inFlight.set(backend.id, { run, target, hasKey: backend.hasApiKey, gen });
  try {
    await run;
  } finally {
    // Only our own entry: after forgetCaps or a target change a newer run may own the slot.
    if (inFlight.get(backend.id)?.run === run) inFlight.delete(backend.id);
  }
}

/** A fresh connection verdict (Test connection, a save, onboarding) re-reads that Backend's
 *  capabilities: the test is the moment a user checks a server they just upgraded or
 *  reconfigured, and without it the cache would keep the previous server's /v1/me until the
 *  next dictation. Called once from App. */
export function initCapsController(): void {
  useApp.subscribe((state, prev) => {
    if (state.connections === prev.connections) return;
    for (const b of state.backends) {
      const now = ownProp(state.connections, b.id);
      if (now?.ok && now !== ownProp(prev.connections, b.id)) void refreshCaps(b, { force: true });
    }
  });
}

/** Whether a translation model is already resident on the server.
 *
 *  `null` means UNKNOWN — no caps fetched yet, or an older backend that sends no
 *  `translation_models` at all. Callers must not read null as "cold": this
 *  codebase's rule is that an absent capability is never treated as a denial.
 *  With `model` given, answers for that model specifically; without one, whether
 *  the server's default — which it lists first — is resident (another loaded model
 *  says nothing about the one a session on the default will run). */
export function translationWarm(caps: Capabilities | null, model?: string): boolean | null {
  const list = caps?.translation_models;
  if (!list) return null;
  if (!list.length) return false;
  const want = model?.trim();
  const hit = want ? list.find((m) => m.id === want) : list[0];
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
 *  not a number ≥ 1) = the app's ceiling — an absent capability never narrows a choice. */
export function maxTranslationTargets(caps: Capabilities | null | undefined): number {
  return targetCap(caps?.server_info?.limits?.translation_max_targets);
}

/** `maxTranslationTargets` for a Backend, read live from the caps store: the ONE cap lookup
 *  every sender and every route preview shares, so the chip never promises more targets than a
 *  session sends. The text route answers a request over TRANSLATION_MAX_TARGETS with a 422,
 *  which would fail every phrase of a dictation. No id (or caps never fetched) = the app's
 *  ceiling. */
export function backendTargetCap(backendId: string | undefined | null): number {
  return maxTranslationTargets(backendId ? ownProp(useApp.getState().caps, backendId) : null);
}

/** A target list as a run on this Backend sends it: the wire-valid codes (`wireCodes`, so a
 *  refused code never takes a capped slot), then the first `backendTargetCap` of them, in the
 *  order the user put them. */
export function sendableTargets(list: unknown, backendId: string | undefined | null): string[] {
  return wireCodes(list).slice(0, backendTargetCap(backendId));
}

/** A translation model id as the "Supported by …" group names it: its last path part. */
export function modelShortName(id: string | undefined): string | undefined {
  return shortModelName(id, 40);
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
