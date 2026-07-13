// Backend-resolution helpers shared by transport call sites.

import type { AppSettings, Backend } from "./types";

/** Loose user input → a connectable URL: trim, strip trailing slashes, default
 *  the scheme to http (LAN servers are the common case). Shared by the
 *  first-run gate and the Backends connect step so both accept "host:8000". */
export function normalizeUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

/** A human default name for a backend at `url` — its host, or a fallback. */
export function nameFromUrl(url: string): string {
  try {
    return new URL(url).host || "My server";
  } catch {
    return "My server";
  }
}

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
