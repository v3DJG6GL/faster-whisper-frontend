// Backend-resolution helpers shared by transport call sites.

import type { AppSettings, Backend } from "./types";

/** The preprocessing WHATWG performs BEFORE it looks for a scheme, reproduced so the tests below
 *  judge the same string the parsers do.
 *
 *  Both the browser's `URL` and Rust's `url` crate (behind reqwest) delete every ASCII tab, LF and
 *  CR from ANYWHERE in the input, and strip leading/trailing C0 controls and spaces. Testing the
 *  raw string instead let `"h<TAB>ttp://evil.tld"` read as SCHEMELESS here — so it was stored, and
 *  `http://` was prepended for display, making every helper below see host `"http"` (dotless, so
 *  `isLocalAddress` returned true and the not-encrypted warning was suppressed) while reqwest
 *  resolved evil.tld and sent it the bearer key, the uploaded audio and the sync blob — which
 *  carries every backend's plaintext key. A leading NUL was the same bug via the other rule: JS
 *  `trim()` does not strip C0, but both parsers do.
 *
 *  Note `\s` would be wrong here: it matches Unicode whitespace the parsers do NOT strip
 *  (U+00A0, U+2028…), which would make this helper disagree with them in the other direction. */
export function stripUrlNoise(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
}

/** Loose user input → a connectable URL: trim, strip trailing slashes, default
 *  the scheme to http (LAN servers are the common case). Shared by the
 *  first-run gate and the Backends connect step so both accept "host:8000". */
export function normalizeUrl(raw: string): string {
  const t = stripUrlNoise(raw).replace(/\/+$/, "");
  if (/^https?:\/\//i.test(t)) return t;
  return isSchemelessAddress(t) ? `http://${t}` : "";
}

/** Does this string carry NO scheme, so that prefixing `http://` is honest?
 *
 *  The two-slash test above is not the same rule the parsers use. WHATWG (the browser's `URL`,
 *  and Rust's `url` crate behind reqwest) also honours a scheme written with ONE slash, a
 *  backslash, or none at all — so `https:/evil.tld` fails the test above, gets `http://`
 *  PREPENDED, and then reads as host `https` to every helper here while reqwest connects to
 *  evil.tld. That made the address shown on the backends card and in the sync consent dialog
 *  disagree with where the audio and the bearer key actually went, and (host `http`, no dot)
 *  it also read as a bare LAN name, which suppressed the not-encrypted warning.
 *
 *  A colon alone cannot be the test: `host:8000` is the LAN form this function exists to
 *  accept. A scheme is a colon whose remainder is not a port, so require digits after it. */
function isSchemelessAddress(t: string): boolean {
  const m = t.match(/^[a-z][a-z0-9+.-]*:(.*)$/is);
  return !m || /^\d+(\/|$)/.test(m[1]);
}

/** May this address be STORED as a backend's `serverUrl`? Applied where an address arrives from
 *  somewhere other than the user's own keyboard (a sync pull, an imported file), because those
 *  paths keep the string verbatim and hand it straight to the transport. */
export function isStorableServerUrl(raw: string): boolean {
  const t = stripUrlNoise(raw);
  return t === "" || /^https?:\/\//i.test(t) || isSchemelessAddress(t);
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
  // ULA / link-local, but ONLY for an IPv6 LITERAL — an IPv6 address always contains ":".
  // Testing the prefix on any non-dotted-quad host classified every public DNS name beginning
  // "fc" or "fd" (fcc.gov, fdic.gov, fc2.com …) as LAN and silently suppressed the warning.
  if (!v4) return h.includes(":") && (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:"));
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
  // Read the value out FIRST and type-check it. `?.` guards nullish but NOT prototype-inherited:
  // a backend whose id is "constructor" / "toString" / "valueOf" makes this lookup return a
  // function off Object.prototype, which is non-nullish, so `.trim()` threw — inside a render
  // body, in a tree with no error boundary, so the window unmounted. The `__..__` filter that
  // polices ids only rejects the keyring namespace, so those ids survive sanitization.
  const raw = settings.sync?.urlOverrides?.[backend.id];
  const override = typeof raw === "string" ? raw.trim() : "";
  return override ? override : backend.serverUrl;
}

/** What the app will ACTUALLY connect to, plus a flag when the address hides it behind userinfo.
 *
 *  A URL's real authority is whatever follows the LAST `@`, so `http://localhost:8000@evil.tld/v1`
 *  has host `evil.tld` while reading as loopback. Every surface that shows the user an address to
 *  judge — the security-review dialog, the restore/import previews, the backend cards — parses it
 *  through here rather than printing the raw string. */
export function authorityOf(raw: string): { host: string; hasUserinfo: boolean } | null {
  try {
    const u = new URL(normalizeUrl(raw));
    return { host: u.host, hasUserinfo: !!u.username || !!u.password };
  } catch {
    return null;
  }
}
