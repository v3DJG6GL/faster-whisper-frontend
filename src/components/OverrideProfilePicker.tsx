import { useEffect, useState } from "react";
import { Select, TextInput } from "@/components/ui";
import { listOverrideProfiles } from "@/lib/api";
import type { ServerKind } from "@/lib/serverKind";

// Picks a server-side override-profile name to reference per request. Only the
// full faster-whisper-backend exposes profiles, so it self-gates to "full" and
// shows a hint otherwise. When the server returns names we render a dropdown
// (with an inherit/none option + the current value if the server doesn't list
// it); when it returns none (endpoint absent / gated off / unreachable) we fall
// back to a free-text input so a name can still be entered.
export function OverrideProfilePicker({
  serverUrl,
  backendId,
  apiKey = null,
  serverKind,
  value,
  inheritLabel,
  onChange,
}: {
  serverUrl: string;
  backendId: string;
  apiKey?: string | null;
  serverKind: ServerKind;
  value: string; // "" = none / inherit
  inheritLabel: string;
  onChange: (v: string) => void;
}) {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (serverKind !== "full") return;
    let cancelled = false;
    void listOverrideProfiles({ serverUrl, backendId, apiKey }).then((n) => {
      if (!cancelled) setNames(n);
    });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, backendId, apiKey, serverKind]);

  if (serverKind !== "full") {
    return (
      <p className="text-[12px] leading-snug text-faint">
        References a server-side override-profile (full faster-whisper backend only). Test the
        connection to detect.
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
