import { useEffect, useState } from "react";
import { Select, TextInput } from "@/components/ui";
import { listOverrideProfiles } from "@/lib/api";
import type { ServerKind } from "@/lib/serverKind";

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
}: {
  serverUrl: string;
  backendId: string;
  apiKey?: string | null;
  serverKind: ServerKind;
  /** Per-identity capability: when false, this caller may not request override-
   *  profiles — show a disabled hint. undefined ("unknown") = permitted. */
  canRequest?: boolean;
  value: string; // "" = none / inherit
  inheritLabel: string;
  onChange: (v: string) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const blocked = canRequest === false;

  useEffect(() => {
    if (serverKind === "standard" || blocked) return; // no endpoint / not permitted
    let cancelled = false;
    void listOverrideProfiles({ serverUrl, backendId, apiKey }).then((n) => {
      if (!cancelled) setNames(n);
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

  if (names.length > 0) {
    const options = [
      { value: "", label: inheritLabel },
      ...names.map((n) => ({ value: n, label: n })),
    ];
    if (value && !names.includes(value)) options.push({ value, label: `${value} · not on server` });
    return <Select value={value} onChange={onChange} options={options} />;
  }

  return (
    <TextInput
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="profile name (e.g. clinic-de)"
    />
  );
}
