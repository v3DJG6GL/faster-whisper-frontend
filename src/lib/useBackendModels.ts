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
import type { Backend, ServerModel } from "@/lib/types";

export function useBackendModels(backend: Backend | undefined): ServerModel[] {
  const conn = useApp((s) => (backend ? ownProp(s.connections, backend.id) : undefined));
  const id = backend?.id;
  // Reactive, through the store: a corrected address (or a per-device URL override) must
  // re-run the probe — keyed on `[id, conn]` alone, a failed probe (conn stays undefined)
  // left the model picker empty for the rest of the mount after the user fixed the URL.
  const url = useApp((s) => (backend ? effectiveServerUrl(backend, s.settings) : ""));
  useEffect(() => {
    if (!backend || !isTauri || conn) return;
    let stale = false;
    testConnection({
      serverUrl: url,
      backendId: backend.id,
    })
      .then((info) => {
        if (!stale) useApp.getState().setConnection(backend.id, info);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, conn, url]);
  return conn?.models ?? [];
}
