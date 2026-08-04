// Backend-resolution helpers shared by transport call sites.

import type { AppSettings, Backend } from "./types";

/** Loose user input → a connectable URL: trim, strip trailing slashes, default
 *  the scheme to http (LAN servers are the common case). Shared by the
 *  first-run gate and the Backends connect step so both accept "host:8000". */
export function normalizeUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

/** True for addresses that never leave the user's own machine or LAN, where plain http is the
 *  normal, expected setup: loopback, an mDNS/`.local` name, a bare hostname with no dot, and the
 *  private + link-local IPv4 ranges. Everything else is a route across networks the user does
 *  not control. */
function isLocalAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".home.arpa") || h.endsWith(".internal")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare LAN hostname
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:"); // ULA / link-local
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

/** A warning to show next to a server address that is BOTH unencrypted and outside the user's
 *  own network, or `null` when there is nothing to warn about. Over such a link the API key, the
 *  microphone audio, the transcripts and the whole synced settings blob travel readable — and an
 *  attacker on the path can also rewrite what comes back. Deliberately silent for LAN and
 *  loopback addresses: a self-hosted server without a certificate is the common, intended case,
 *  and a warning that fires there is one the user learns to ignore. */
export function insecureUrlWarning(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(normalizeUrl(url));
  } catch {
    return null; // not a parseable address yet — the connect attempt reports that on its own
  }
  if (parsed.protocol !== "http:") return null;
  if (isLocalAddress(parsed.hostname)) return null;
  return `This address is not encrypted and is outside your own network. Your API key, your microphone audio and everything you dictate would travel readable by anyone on the route. Use https:// if the server supports it.`;
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
