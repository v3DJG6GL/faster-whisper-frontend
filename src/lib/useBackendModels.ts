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
  useEffect(() => {
    if (!backend || !isTauri || conn) return;
    let stale = false;
    testConnection({
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
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
  }, [id, conn]);
  return conn?.models ?? [];
}
