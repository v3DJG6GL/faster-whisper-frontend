// The models a backend's server advertised on its last connection test. The
// connections map is session memory fed only by explicit tests — so this hook
// probes in the background whenever that cache is empty (an answered probe fills
// it for the session), letting model pickers fill without a manual "Test connection".

import { useEffect } from "react";
import { useApp } from "@/lib/store";
import { isTauri, testConnection } from "@/lib/api";
import { effectiveServerUrl, storedKeyPresent } from "@/lib/backends";
import { ownProp } from "@/lib/own";
import { credentialGeneration } from "@/lib/capabilities";
import type { Backend, ServerModel } from "@/lib/types";

/** Re-probes after a mid-probe key rotation dropped the verdict (see the effect below). */
const MAX_ROTATION_REPROBES = 3;

export function useBackendModels(backend: Backend | undefined): ServerModel[] {
  const conn = useApp((s) => (backend ? ownProp(s.connections, backend.id) : undefined));
  const id = backend?.id;
  // Reactive, through the store: a corrected address (or per-device URL override) evicts `conn`,
  // which re-runs the probe — but mid-probe `conn` is already undefined, so only `url` in the
  // deps re-aims it at the new address.
  const url = useApp((s) => (backend ? effectiveServerUrl(backend, s.settings) : ""));
  // Key presence too: a sync pull that adds a key to a keyless backend (or removes one) moves no
  // credential generation, and `conn` is already undefined — keyed on it, the probe re-runs as
  // the current caller and the keyless probe's verdict is dropped.
  const hasKey = backend?.hasApiKey ?? false;
  useEffect(() => {
    if (!backend || !isTauri || conn) return;
    let stale = false;
    // A key rotated mid-probe leaves `conn` undefined, so the deps don't change and nothing re-runs
    // this effect: instead of landing the old key's verdict, re-probe with the current credential,
    // capped so a credential that keeps rotating can't loop for the life of the mount. A key added
    // or removed does re-run it (`hasKey`) but is also checked against the store, since the cleanup
    // may not have run yet when the old probe answers.
    let retries = 0;
    const probe = () => {
      const gen = credentialGeneration(backend.id);
      testConnection({
        serverUrl: url,
        backendId: backend.id,
      })
        .then((info) => {
          if (stale) return;
          if (credentialGeneration(backend.id) !== gen) {
            if (retries++ < MAX_ROTATION_REPROBES) probe();
            return;
          }
          if (storedKeyPresent(useApp.getState().backends, backend.id) !== hasKey) return;
          useApp.getState().setConnection(backend.id, info);
        })
        .catch(() => {});
    };
    probe();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, conn, url, hasKey]);
  return conn?.models ?? [];
}
