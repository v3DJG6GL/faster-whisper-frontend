import { useEffect, useState } from "react";
import { getDecodeDefaults } from "@/lib/api";
import type { DecodeDefaults } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";
import { useDebounced } from "@/lib/useDebounced";

/**
 * The decode values a request inherits from the server (GET /v1/request-default-settings) for one
 * model and override profile — feed it to serverInherited() for the editor's "Inherit · X".
 *
 * Fetched when an editor opens and again whenever the backend, typed address/key, model or
 * profile changes; never polled. Cleared while a new fetch is in flight so a switch never ghosts
 * the previous server's values. Skipped on a standard server or without a backend; any failure
 * leaves undefined (the editor shows the bare word).
 */
export function useDecodeDefaults(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  /** The model the run will use; "" = the server's default model. */
  model?: string | null;
  /** The override profile the request will name (NO_OVERRIDE_PROFILE included). */
  profileName?: string | null;
  serverKind: ServerKind;
}): DecodeDefaults | undefined {
  const { serverUrl, backendId, apiKey, serverKind } = args;
  const model = args.model?.trim() ?? "";
  // Debounced here, once for every caller: the override-profile picker's custom name reports each
  // keystroke, and each one cleared the inherited values and fired a credentialed fetch.
  const profileName = useDebounced(args.profileName?.trim() || null, 400);
  const [dd, setDd] = useState<DecodeDefaults | undefined>(undefined);

  useEffect(() => {
    setDd(undefined);
    if (serverKind === "standard" || !backendId) return;
    let cancelled = false;
    void getDecodeDefaults({ serverUrl, backendId, apiKey, model, overrideProfile: profileName })
      .catch(() => null)
      .then((r) => {
        if (!cancelled) setDd(r ?? undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, backendId, apiKey, model, profileName, serverKind]);

  return dd;
}
