// The models a backend's server advertised on its last connection test. The
// connections map is session memory fed only by explicit tests — so this hook
// probes once per backend per session when the cache is empty, in the
// background, letting model pickers fill without a manual "Test connection"
// (the pattern the Transcribe screen introduced, now shared with Profiles).

import { useEffect } from "react";
import { useApp } from "@/lib/store";
import { isTauri, testConnection } from "@/lib/api";
import { effectiveServerUrl } from "@/lib/backends";
import { ownProp } from "@/lib/own";
import { credentialGeneration } from "@/lib/capabilities";
import type { Backend, ServerModel } from "@/lib/types";

/** Re-probes after a mid-probe key rotation dropped the verdict (see the effect below). */
const MAX_ROTATION_REPROBES = 3;

export function useBackendModels(backend: Backend | undefined): ServerModel[] {
  const conn = useApp((s) => (backend ? ownProp(s.connections, backend.id) : undefined));
  const id = backend?.id;
  // Reactive, through the store: a corrected address (or a per-device URL override) must
  // re-run the probe — keyed on `[id, conn]` alone, a failed probe (conn stays undefined)
  // left the model picker empty for the rest of the mount after the user fixed the URL.
  const url = useApp((s) => (backend ? effectiveServerUrl(backend, s.settings) : ""));
  // Key presence too: a sync pull that adds a key to a keyless backend (or removes one) moves no
  // credential generation, and `conn` is already undefined — keyed on it, the probe re-runs as
  // the current caller and the keyless probe's verdict is dropped.
  const hasKey = backend?.hasApiKey ?? false;
  useEffect(() => {
    if (!backend || !isTauri || conn) return;
    let stale = false;
    // A key rotated and saved mid-probe empties `conn` again (already undefined here, so the deps
    // don't change and this run isn't cancelled): the old key's verdict must not land. A key
    // added or removed re-runs the effect (`hasKey`) and is checked against the store as well,
    // since the cleanup may not have run yet when the old probe answers. Nothing
    // else re-runs this effect then, so re-probe with the current credential instead of dropping
    // the answer — once per generation move, capped so a credential that keeps rotating can't
    // keep the probe looping for the life of the mount.
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
          if ((useApp.getState().backends.find((x) => x.id === backend.id)?.hasApiKey ?? false) !== hasKey) return;
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
