import { useEffect, useRef, useState } from "react";
import { getDecodeDefaults } from "@/lib/api";
import type { DecodeDefaults } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";
import { useDebounced } from "@/lib/useDebounced";

/**
 * The decode values a request inherits from the server (GET /v1/request-default-settings) for one
 * model and override profile — feed it to serverInherited() for the editor's "Inherit · X".
 *
 * Fetched when an editor opens and again whenever the backend, typed address/key, model or
 * profile changes; never polled. Values are withheld at render time for any request other than
 * the one they were fetched for, so a switch never ghosts the previous server's values — not even
 * in the render that commits the switch, before any effect has run. Skipped on a standard server
 * or without a backend; any failure leaves undefined (the editor shows the bare word).
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
  // keystroke, and each one cleared the inherited values and fired a credentialed fetch. Only the
  // TYPING is debounced: when the backend / address changes, the name changes with it in the same
  // render (a backend's own override profile), and the settled one belongs to the previous server.
  const rawProfile = args.profileName?.trim() || null;
  const target = `${backendId ?? ""}\u0000${serverUrl}`;
  const settled = useDebounced(JSON.stringify([target, rawProfile]), 400);
  const [settledTarget, settledProfile] = JSON.parse(settled) as [string, string | null];
  const profileName = settledTarget === target ? settledProfile : rawProfile;
  const [st, setSt] = useState<{ key: string; dd?: DecodeDefaults }>();

  // Keyed on "standard" (skip) and on each rise to "full": a successful connection test after an
  // outage (unknown → full) must refetch, or labels that failed at mount stay bare until a
  // remount. Only the rise — the kind also drops to unknown on every address keystroke.
  const standard = serverKind === "standard";
  const full = useRisesToFull(serverKind);
  // The request the values belong to. `full` stays out: a reconnect refetch for the same request
  // may keep showing that same server's values meanwhile.
  const key = JSON.stringify([serverUrl, backendId ?? null, apiKey ?? null, model, profileName, standard]);
  useEffect(() => {
    if (standard || !backendId) return;
    let cancelled = false;
    void getDecodeDefaults({ serverUrl, backendId, apiKey, model, overrideProfile: profileName })
      .catch(() => null)
      .then((r) => {
        if (!cancelled) setSt({ key, dd: r ?? undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [key, serverUrl, backendId, apiKey, model, profileName, standard, full]);

  return st?.key === key ? st.dd : undefined;
}

/** Counts the times `kind` became "full" after mount: an effect keyed on it re-runs when a
 *  server comes back (unknown → full) but not when it drops away (full → unknown). */
export function useRisesToFull(kind: ServerKind): number {
  const prev = useRef(kind);
  const rises = useRef(0);
  if (kind !== prev.current) {
    if (kind === "full") rises.current += 1;
    prev.current = kind;
  }
  return rises.current;
}
