import { useEffect, useRef, useState } from "react";
import { Select, TextInput } from "@/components/ui";
import { listOverrideProfiles } from "@/lib/api";
import { requestCredentialGen } from "@/lib/capabilities";
import { NO_OVERRIDE_PROFILE } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";

// Local-only sentinel for the "type a name by hand" row — never stored; the
// stored value comes from the text field it reveals.
const CUSTOM = "__custom__";
const MAX_SHOWN_PROFILES = 500;

// Picks a server-side override-profile name to reference per request. Only a server
// KNOWN to be "standard" gets a hint and no input; "unknown" is treated as full (the
// serverKind contract) and gets a best-effort names fetch (the Rust command backfills
// the API key from the keychain via backendId), falling back to free text so a name can
// always be entered. The fetch keeps the picker usable in the Profiles editor, which has
// no connection test of its own (the connection map is empty on a fresh launch).
export function OverrideProfilePicker({
  serverUrl,
  backendId,
  apiKey = null,
  serverKind,
  canRequest,
  value,
  inheritLabel,
  onChange,
  ariaLabel = "Server override profile",
  refresh,
}: {
  serverUrl: string;
  backendId: string;
  apiKey?: string | null;
  serverKind: ServerKind;
  /** Per-identity capability: when false, this caller may not request override-
   *  profiles — show a disabled hint. undefined ("unknown") = permitted. */
  canRequest?: boolean;
  value: string; // "" = inherit / server default · NO_OVERRIDE_PROFILE = no profile · else a name
  inheritLabel: string;
  onChange: (v: string) => void;
  /** Accessible name for the rendered control(s). Both call sites label this "Server override
   *  profile"; a bare <select> has no placeholder fallback, and this composite component slips past
   *  Labeled's auto-aria-label (which only clones onto a direct Select/TextInput child). */
  ariaLabel?: string;
  /** Bumped by a fresh successful connection test of the same target: refetch the names (an
   *  admin may have added or removed a profile since). Callers without a test omit it. */
  refresh?: number;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const blocked = canRequest === false;
  // Bumped when the backend's stored key is replaced elsewhere (a sync pull): the names are per
  // caller, so they are refetched as the new one (as in useDecodeDefaults).
  const gen = requestCredentialGen(backendId, apiKey);
  // The target the shown names were fetched for: a refetch of the SAME target (a `refresh`
  // bump, or a first test reclassifying its kind "unknown" → "full") keeps them until the answer
  // lands — blanking them made a listed stored value flash into the "Custom name" text field for
  // the round trip. The kind is not part of the target (the listing does not take it); a kind
  // change still refetches through the deps.
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (serverKind === "standard" || blocked) return; // no endpoint / not permitted
    let cancelled = false;
    // Clear the prior connection's names up front on a target switch so switching backends
    // never shows a stale dropdown while the refetch is in flight (or if it fails/returns empty).
    const key = JSON.stringify([serverUrl, backendId, apiKey, gen]);
    if (fetchedFor.current !== key) setNames([]);
    fetchedFor.current = key;
    void listOverrideProfiles({ serverUrl, backendId, apiKey })
      .then((n) => {
        // Render cap, matching the MAX_SHOWN_* ceilings the Dictionary/QuickAdd siblings use: the
        // list is server-authored and every entry becomes an <option>. De-duplicated first
        // (options are keyed on the value). A name past the cap stays reachable through the
        // "Custom name…" row, which the dropdown branch offers too.
        if (!cancelled) setNames([...new Set(n)].slice(0, MAX_SHOWN_PROFILES));
      })
      .catch(() => {
        // Best-effort, per the doc above: on failure degrade to the free-text input.
        if (!cancelled) setNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, backendId, apiKey, serverKind, blocked, gen, refresh]);

  if (serverKind === "standard") {
    return (
      <p className="text-[12px] leading-snug text-faint">
        A conventional Whisper server doesn’t support override-profiles — this is a
        faster-whisper-backend feature.
      </p>
    );
  }

  if (blocked) {
    return (
      <p className="text-[12px] leading-snug text-faint">
        Requesting override-profiles is disabled for this connection by the server admin.
      </p>
    );
  }

  // "None" forces the server to apply no profile (plain defaults) — distinct
  // from inherit/server-default (""), which lets a server-bound profile apply.
  const noneOpt = { value: NO_OVERRIDE_PROFILE, label: "None — no profile" };

  // One code path for both shapes: with names, the custom row is the escape hatch for a
  // name past the render cap; without, it is the only way to type one at all.
  const isCustomValue = value !== "" && value !== NO_OVERRIDE_PROFILE && !names.includes(value);
  const custom = showCustom || isCustomValue;
  const options = [
    { value: "", label: inheritLabel },
    noneOpt,
    ...names.map((n) => ({ value: n, label: n })),
    { value: CUSTOM, label: "Custom name…" },
  ];
  return (
    <div className="space-y-2">
      <Select
        ariaLabel={ariaLabel}
        value={custom ? CUSTOM : value}
        onChange={(v) => {
          if (v === CUSTOM) {
            setShowCustom(true);
            // Clear the parent value so it does not silently keep (and save/send) the
            // previous server-listed name while the text field shows empty.
            onChange("");
          } else {
            setShowCustom(false);
            onChange(v);
          }
        }}
        options={options}
      />
      {custom && (
        <TextInput
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="profile name (e.g. clinic-de)"
        />
      )}
      {/* A stored name the server did not list falls back server-side. Only when a list was
          fetched — an empty/failed fetch proves nothing. */}
      {isCustomValue && names.length > 0 && (
        <p className="text-[12px] text-faint">Not among the profiles this server listed.</p>
      )}
    </div>
  );
}
