import { useEffect, useState } from "react";
import { getCapabilities, getOverrideProfile } from "@/lib/api";
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
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [resolved, setResolved] = useState<InheritedValues | undefined>(undefined);
  const [resolvedPrompt, setResolvedPrompt] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (serverKind === "standard") {
      setCaps(null);
      return;
    }
    let cancelled = false;
    void getCapabilities({ serverUrl, backendId, apiKey })
      .then((c) => {
        if (!cancelled) setCaps(c);
      })
      .catch(() => {
        // Best-effort (mirrors OverrideProfilePicker): a rare IPC reject degrades to null,
        // never an unhandled rejection.
        if (!cancelled) setCaps(null);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, backendId, apiKey, serverKind]);

  useEffect(() => {
    const name = profileName?.trim();
    if (!name || name === NO_OVERRIDE_PROFILE || serverKind === "standard") {
      setResolved(undefined);
      setResolvedPrompt(undefined);
      return;
    }
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
