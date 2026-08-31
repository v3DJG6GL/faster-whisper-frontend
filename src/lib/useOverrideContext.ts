import { useEffect, useState } from "react";
import { getOverrideProfile } from "@/lib/api";
import { refreshCaps } from "@/lib/capabilities";
import { useApp } from "@/lib/store";
import { hasOwn, ownProp } from "@/lib/own";
import { NO_OVERRIDE_PROFILE, type Capabilities, type InheritedValues } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";

/**
 * Shared by the Backend and Profile editors: fetch (a) the caller's override
 * capabilities and (b) the resolved decode values of the selected server
 * override-profile, so the decode editor can capability-gate and ghost the
 * inherited values into its controls.
 *
 * Best-effort throughout (mirrors OverrideProfilePicker's name fetch): a standard
 * server / missing endpoint / unreachable backend yields null caps — which the UI
 * treats as "unknown ⇒ permitted" — and no inherited values. Skipped entirely on
 * a known-standard server.
 */
export function useOverrideContext(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  profileName?: string; // the effective override-profile name to preview
  serverKind: ServerKind;
}): {
  caps: Capabilities | null;
  resolved: InheritedValues | undefined;
  /** The selected override-profile's own DEFAULT_PROMPT (ghosted as the inherited
   *  "Vocabulary / prompt"); undefined when none/standard/unreachable. */
  resolvedPrompt: string | undefined;
} {
  const { serverUrl, backendId, apiKey, profileName, serverKind } = args;
  // Read-through of the store cache instead of a per-mount fetch: streaming.ts and
  // preload.ts need the same answer with no hook to fetch from, so the fetch moved
  // to lib/capabilities.ts and this hook became one of its readers. Absent key ⇒
  // trigger a refresh; present-null ⇒ fetched and unsupported, don't refetch.
  const caps = useApp((s) => (backendId ? (ownProp(s.caps, backendId) ?? null) : null));
  const capsFetched = useApp((s) => (backendId ? hasOwn(s.caps, backendId) : false));
  const [resolved, setResolved] = useState<InheritedValues | undefined>(undefined);
  const [resolvedPrompt, setResolvedPrompt] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (serverKind === "standard" || !backendId || capsFetched) return;
    // Absent ⇒ never fetched for this backend; the store is invalidated at the four
    // sites that repoint or drop a backend, so a stale entry can't survive an edit
    // and there is nothing to clear here. refreshCaps is best-effort and coalesces.
    const backend = useApp.getState().backends.find((b) => b.id === backendId);
    if (backend) void refreshCaps(backend);
  }, [backendId, serverKind, capsFetched]);

  useEffect(() => {
    const name = profileName?.trim();
    if (!name || name === NO_OVERRIDE_PROFILE || serverKind === "standard") {
      setResolved(undefined);
      setResolvedPrompt(undefined);
      return;
    }
    // Clear before refetching so switching profile/backend doesn't briefly ghost the PREVIOUS
    // override-profile's decode baseline + prompt into the editor while the new fetch is in flight.
    setResolved(undefined);
    setResolvedPrompt(undefined);
    let cancelled = false;
    void getOverrideProfile({ serverUrl, backendId, apiKey, name })
      .then((r) => {
        if (!cancelled) {
          setResolved(r?.values);
          setResolvedPrompt(r?.prompt);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(undefined);
          setResolvedPrompt(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, backendId, apiKey, profileName, serverKind]);

  return { caps, resolved, resolvedPrompt };
}
