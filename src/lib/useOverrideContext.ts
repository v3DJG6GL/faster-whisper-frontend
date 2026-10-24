import { useEffect, useRef, useState } from "react";
import { getCapabilities } from "@/lib/api";
import { effectiveServerUrl, normalizeUrl } from "@/lib/backends";
import { refreshCaps, requestCredentialGen } from "@/lib/capabilities";
import { useApp } from "@/lib/store";
import { useRisesToFull } from "@/lib/useDecodeDefaults";
import { hasOwn, ownProp } from "@/lib/own";
import type { Capabilities } from "@/lib/types";
import { effectiveServerKind, type ServerKind } from "@/lib/serverKind";

/**
 * Shared by the Backend and Profile editors (and Transcribe / the transcript viewer): the
 * caller's override capabilities, so the decode editor can capability-gate. The values it
 * inherits come from useDecodeDefaults.
 *
 * Best-effort throughout (mirrors OverrideProfilePicker's name fetch): a standard
 * server / missing endpoint / unreachable backend yields null caps — which the UI
 * treats as "unknown ⇒ permitted". Skipped entirely on a known-standard server.
 *
 * `refresh` is bumped by a fresh successful connection test of the same target: the caps are
 * re-probed (a typed target) or re-read through the store cache (the saved one).
 */
export function useOverrideContext(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  serverKind: ServerKind;
  /** Bumped by a fresh successful connection test of the same target: re-probe. */
  refresh?: number;
}): {
  caps: Capabilities | null;
} {
  const { serverUrl, backendId, apiKey, serverKind, refresh } = args;
  // Bumped when the backend's stored key is replaced elsewhere (a sync pull): a live probe ran as
  // the old caller and a cached entry was evicted, so the effect below must re-run. Derived here
  // for every caller, as useDecodeDefaults does. Read on every render: the eviction that bumps it
  // (forgetBackendCaches) also replaces the store's `connections` / `caps`, which re-renders the readers.
  const credentialGen = requestCredentialGen(backendId, apiKey);
  // Read-through of the store cache (lib/capabilities.ts) instead of a per-mount fetch:
  // streaming.ts and preload.ts need the same answer and have no hook to fetch from.
  const caps = useApp((s) => (backendId ? (ownProp(s.caps, backendId) ?? null) : null));
  // The store cache is keyed on the SAVED backend. A draft (not in the store yet) or a
  // target being typed into the Backends editor is not that backend: fetch the typed
  // target directly, into local state, so the capability gate and the translation
  // model/language lists describe the server being configured, not the one saved.
  const [liveCaps, setLiveCaps] = useState<Capabilities | null>(null);
  // The typed target the live caps were last probed for (null = none / not live).
  const probedRef = useRef<string | null>(null);
  const [live, setLive] = useState(false);

  // Keyed on "standard" (skip) and on each rise to "full": a successful connection test after an
  // outage (unknown → full) must re-probe, or caps that failed at mount stay empty until a
  // remount. Only the rise — the kind also drops to unknown on every address keystroke.
  const standard = serverKind === "standard";
  const full = useRisesToFull(serverKind);
  useEffect(() => {
    if (standard || !backendId) {
      // A backend that turns out to be a plain OpenAI server (or is gone) must not keep
      // returning the last probed server's caps.
      setLive(false);
      setLiveCaps(null);
      probedRef.current = null;
      return;
    }
    const st = useApp.getState();
    const backend = st.backends.find((b) => b.id === backendId);
    const savedTarget = backend ? effectiveServerUrl(backend, st.settings) : null;
    const typedTarget = serverUrl.trim();
    // A typed key is always an edit: the Backends editor leaves the field blank to keep the
    // stored key, and /v1/me is per-caller, so a rotated key must be probed live rather than
    // read from the cache filled with the old credential.
    // …and so is a saved backend the store knows as standard while this caller does not (the
    // editor's draft switched Server type away from Standard): refreshCaps would pin that saved
    // kind's null, and the gate / info panel would stay empty after the switch is tested.
    const editing =
      !backend ||
      (!!typedTarget && normalizeUrl(typedTarget) !== normalizeUrl(savedTarget ?? "")) ||
      !!apiKey ||
      effectiveServerKind(backend, ownProp(st.connections, backendId)) === "standard";
    if (!editing) {
      setLive(false);
      probedRef.current = null;
      // Absent ⇒ never fetched; the store is invalidated at the sites that repoint or
      // drop a backend. A cached NULL is NOT terminal: refreshCaps cannot tell "server
      // said no" from "the probe failed" (both arrive as null), and one blip must not pin
      // the panels to empty lists for the session — retry on mount; refreshCaps coalesces.
      // Read fresh, not from the effect's closure: `caps` is deliberately NOT a dependency,
      // or every unrelated refreshCaps write would re-run the EDITING branch below and
      // re-probe the typed target.
      const cur = useApp.getState();
      if (!hasOwn(cur.caps, backendId) || !ownProp(cur.caps, backendId)) void refreshCaps(backend);
      return;
    }
    setLive(true);
    // Clear before refetching so a backend switch / retyped address shows the neutral
    // "unknown ⇒ permitted" gate during the in-flight window instead of ghosting the
    // PREVIOUS server's caps. A re-probe of the SAME target (a re-test, a rise to full) is no
    // switch: it keeps the caps it has while in flight, then takes the answer as it comes (a
    // null can be the server saying no, which a re-test must show).
    const target = JSON.stringify([typedTarget, apiKey ?? null, backendId, credentialGen]);
    const same = probedRef.current === target;
    probedRef.current = target;
    if (!same) setLiveCaps(null);
    let cancelled = false;
    void getCapabilities({ serverUrl: typedTarget, backendId, apiKey })
      .catch(() => null)
      .then((c) => {
        if (!cancelled) setLiveCaps(c);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, apiKey, backendId, standard, full, credentialGen, refresh]);

  // A known-standard target has no /v1/me: the store entry belongs to whatever the SAVED
  // backend last pointed at (the Backends editor may have retyped it to a plain server), so it
  // must not lend that server's limits or privacy panel to this one.
  return { caps: standard ? null : live ? liveCaps : caps };
}
