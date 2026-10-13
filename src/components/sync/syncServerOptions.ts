import { backendOptions } from "@/lib/backends";
import type { Backend } from "@/lib/types";

export const NO_SYNC_SERVER_LABEL = "Choose a server…";

/** The Sync server picker's options. While sync is on but its server id resolves to no backend
 *  (none existed when it was switched on, or the picked one was deleted), a leading placeholder
 *  keeps the closed field from showing the first backend: `Select` falls back to `options[0]`,
 *  and the engine has no target in that state, so Pull now / Push now would silently do nothing
 *  under a server name that looks chosen. */
export function syncServerOptions(
  backends: Backend[],
  backendId: string | null,
  enabled: boolean,
): { value: string; label: string }[] {
  // This control picks which server receives EVERY backend's plaintext key, and a backend rename
  // arrives with no prompt — so the labels get the same defanging as the device name on the
  // conflict dialog, plus a host suffix when two of them collide.
  const opts = backendOptions(backends).map((o, i) =>
    backends[i].hasApiKey ? o : { ...o, label: `${o.label} (no API key)` },
  );
  const unresolved = enabled && backends.length > 0 && !backends.some((b) => b.id === backendId);
  return unresolved ? [{ value: "", label: NO_SYNC_SERVER_LABEL }, ...opts] : opts;
}
