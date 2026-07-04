import { useEffect, useState } from "react";
import { Select, TextInput } from "@/components/ui";
import { listOverrideProfiles } from "@/lib/api";
import { NO_OVERRIDE_PROFILE } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";

// Local-only sentinel for the "type a name by hand" row — never stored; the
// stored value comes from the text field it reveals.
const CUSTOM = "__custom__";

// Picks a server-side override-profile name to reference per request. Only the
// full faster-whisper-backend exposes profiles, so on a server KNOWN to be
// conventional ("standard") we show a hint and no input. Otherwise — "full" OR
// "unknown" (untested, or detection unavailable) — we honour the serverKind
// contract ("unknown ⇒ assume full; never gate a knob we can't prove is
// unsupported") and try a best-effort names fetch: a dropdown when the server
// returns names (the Rust command backfills the API key from the keychain via
// backendId), else a free-text input so a name can always be entered. This is
// what keeps the picker usable in the Profiles editor, which has no connection
// test of its own (the in-memory connection map is empty on a fresh launch).
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
}) {
  const [names, setNames] = useState<string[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const blocked = canRequest === false;

  useEffect(() => {
    if (serverKind === "standard" || blocked) return; // no endpoint / not permitted
    let cancelled = false;
    // Clear the prior connection's names up front so switching backends never shows a stale
    // dropdown while the refetch is in flight (or if it fails/returns empty).
    setNames([]);
    void listOverrideProfiles({ serverUrl, backendId, apiKey })
      .then((n) => {
        if (!cancelled) setNames(n);
      })
      .catch(() => {
        // Best-effort, per the doc above: on failure degrade to the free-text input.
        if (!cancelled) setNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, backendId, apiKey, serverKind, blocked]);

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

  if (names.length > 0) {
    const options = [{ value: "", label: inheritLabel }, noneOpt, ...names.map((n) => ({ value: n, label: n }))];
    if (value && value !== NO_OVERRIDE_PROFILE && !names.includes(value))
      options.push({ value, label: `${value} · not on server` });
    return <Select value={value} onChange={onChange} options={options} ariaLabel={ariaLabel} />;
  }

  // Server enumerated no names (not a full backend yet, or empty list): still
  // offer inherit + None, plus a "custom name…" escape hatch with a text field.
  const isCustomValue = value !== "" && value !== NO_OVERRIDE_PROFILE;
  const custom = showCustom || isCustomValue;
  return (
    <div className="space-y-2">
      <Select
        ariaLabel={ariaLabel}
        value={custom ? CUSTOM : value}
        onChange={(v) => {
          if (v === CUSTOM) {
            setShowCustom(true);
            if (value === NO_OVERRIDE_PROFILE) onChange(""); // leave the None sentinel behind
          } else {
            setShowCustom(false);
            onChange(v);
          }
        }}
        options={[{ value: "", label: inheritLabel }, noneOpt, { value: CUSTOM, label: "Custom name…" }]}
      />
      {custom && (
        <TextInput
          aria-label={ariaLabel}
          value={isCustomValue ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="profile name (e.g. clinic-de)"
        />
      )}
    </div>
  );
}
