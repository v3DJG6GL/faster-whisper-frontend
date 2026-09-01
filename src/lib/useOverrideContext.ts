import { useEffect, useState } from "react";
import { getCapabilities, getOverrideProfile } from "@/lib/api";
import { effectiveServerUrl, normalizeUrl } from "@/lib/backends";
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
  // The store cache is keyed on the SAVED backend. A draft (not in the store yet) or a
  // target being typed into the Backends editor is not that backend: fetch the typed
  // target directly, into local state, so the capability gate and the translation
  // model/language lists describe the server being configured, not the one saved.
  const [liveCaps, setLiveCaps] = useState<Capabilities | null>(null);
  const [live, setLive] = useState(false);
  const [resolved, setResolved] = useState<InheritedValues | undefined>(undefined);
  const [resolvedPrompt, setResolvedPrompt] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (serverKind === "standard" || !backendId) {
      // A backend that turns out to be a plain OpenAI server (or is gone) must not keep
      // returning the last probed server's caps.
      setLive(false);
      setLiveCaps(null);
      return;
    }
    const st = useApp.getState();
    const backend = st.backends.find((b) => b.id === backendId);
    const savedTarget = backend ? effectiveServerUrl(backend, st.settings) : null;
    const typedTarget = serverUrl.trim();
    const editing =
      !backend ||
      (!!typedTarget && normalizeUrl(typedTarget) !== normalizeUrl(savedTarget ?? "")) ||
      (!!apiKey && !backend.hasApiKey);
    if (!editing) {
      setLive(false);
      // Absent ⇒ never fetched; the store is invalidated at the sites that repoint or
      // drop a backend. A cached NULL is NOT terminal: refreshCaps cannot tell "server
      // said no" from "the probe failed" (both arrive as null), so one blip pinned the
      // panels to empty lists for the session — retry on mount; refreshCaps coalesces.
      // Read fresh, not from the effect's closure: `caps` is deliberately NOT a dependency,
      // or every unrelated refreshCaps write re-ran the EDITING branch below and re-probed
      // the typed target (and, with the clear below, blanked the gate for a round trip).
      const cur = useApp.getState();
      if (!hasOwn(cur.caps, backendId) || !ownProp(cur.caps, backendId)) void refreshCaps(backend);
      return;
    }
    setLive(true);
    // Clear before refetching so a backend switch / retyped address shows the neutral
    // "unknown ⇒ permitted" gate during the in-flight window instead of ghosting the
    // PREVIOUS server's caps.
    setLiveCaps(null);
    let cancelled = false;
    void getCapabilities({ serverUrl: typedTarget, backendId, apiKey })
      .catch(() => null)
      .then((c) => {
        if (!cancelled) setLiveCaps(c);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, apiKey, backendId, serverKind]);

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

  return { caps: live ? liveCaps : caps, resolved, resolvedPrompt };
}
