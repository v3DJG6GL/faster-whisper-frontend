// Backend-resolution helpers shared by transport call sites.

import type { AppSettings, Backend } from "./types";

/**
 * The server address to actually CONNECT to for a backend: the per-device
 * override (settings.sync.urlOverrides — "use this address on this device",
 * never synced) when set, else the canonical serverUrl. Keeps synced configs
 * working when machines reach the same server differently (localhost on the
 * box that runs it, a LAN IP elsewhere) without the two URLs ping-ponging
 * through sync. Display contexts keep showing backend.serverUrl.
 */
export function effectiveServerUrl(backend: Backend, settings: AppSettings): string {
  const override = settings.sync?.urlOverrides?.[backend.id]?.trim();
  return override ? override : backend.serverUrl;
}
