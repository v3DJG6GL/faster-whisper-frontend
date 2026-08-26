// Backend-resolution helpers shared by transport call sites.

import type { AppSettings, Backend, ConnectionInfo } from "./types";
import { classifyConnection } from "./serverKind";
import { safeIdentityText } from "./sanitize";

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

/** THE fresh-Backend factory — every surface that mints one (Backends manual
 *  add, Backends connect-first add, Onboarding) goes through here, so the
 *  defaults can't diverge. With a connection: name from the host, the server's
 *  loaded (else first) model, batch endpoint for standard servers. */
export function newBackendDraft(conn?: {
  serverUrl: string;
  hasApiKey: boolean;
  info: ConnectionInfo;
}): Backend {
  const base: Backend = {
    id: crypto.randomUUID(),
    name: "New backend",
    serverUrl: "http://localhost:8000",
    hasApiKey: false,
    model: "whisper-1",
    endpoint: "stream",
    language: "auto",
    prompt: "",
    responseFormat: "verbose_json",
  };
  if (!conn) return base;
  return {
    ...base,
    name: nameFromUrl(conn.serverUrl),
    serverUrl: conn.serverUrl,
    hasApiKey: conn.hasApiKey,
    model: conn.info.models.find((m) => m.loaded)?.id ?? conn.info.models[0]?.id ?? "whisper-1",
    endpoint: classifyConnection(conn.info) === "standard" ? "batch" : "stream",
  };
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

/** Display labels for a backend list, disambiguated when two of them collide.
 *
 *  The labels are defanged before rendering, which DELETES zero-width and bidi characters — so two
 *  distinct backends named `"Work"` and `"Work\u200b"` draw identically, while the option value
 *  stays the distinct id. A backend RENAME raises no security-review prompt, so a sync server can
 *  relabel an already-approved second backend to collide with the user's real one on an unattended
 *  pull; the affected controls are the ones that decide which server receives a profile's audio and
 *  bearer key, and none of them shows the address. This is the two-arm conflict Segmented's
 *  collision fallback, generalized to an N-option list: on a collision, name the thing the option
 *  actually selects. Legitimate duplicates ("Local" on two machines) simply gain a host suffix.
 *
 *  List-level by design. The per-item form was O(n^2) with an 80-codepoint scan per comparison,
 *  called from three unmemoized render bodies over a list `MAX_SYNCED_ENTRIES` bounds at 500 —
 *  measured at 233ms per render pass. One pass builds the collision counts, then labels. */
/** The disambiguating separator. Defined once so the label builder and the forgery test below can
 *  never drift apart — the whole guard rests on the two meaning the same string. */
const SEP = " \u00b7 ";

export function backendOptions(all: Backend[], max = 80): { value: string; label: string }[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  // `safeIdentityText`, not `safeDisplayText`: G4 moved the three identity renders beside a trust
  // decision onto it and this fourth site was missed. `safeDisplayText` passes the invisible class
  // `isInvisibleKeyChar` enumerates — U+2800, U+034F, the variation selectors, the tags block —
  // and `norm`'s `\s+` does not match any of them either, so `"Work" + 90×U+2800` and `"Work"`
  // both draw as exactly `Work` while counting as two distinct labels: neither collides, neither
  // is suffixed, and the Q14 guard is inert for the whole class. A rename raises no
  // SecurityChange, so it arrives on the unattended pull. The pickers this feeds choose which
  // server receives a profile's audio and bearer key, which receives an uploaded file, and which
  // receives the whole synced blob — and none of them shows an address.
  const labels = all.map((b) => safeIdentityText(b.name, max));
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(norm(l), (counts.get(norm(l)) ?? 0) + 1);
  // A name that already CONTAINS the separator is forced into the suffix branch whatever the
  // counts say. That, and not a second counting pass, is what makes the suffix unforgeable: the
  // collision test compares WHOLE labels, so an impostor renamed to `"Work · good.tld"` is
  // distinct from the real `"Work"` and neither collides — leaving the real one bare while the
  // impostor alone renders in the form that now MEANS "disambiguated, at good.tld". Suffixing it
  // appends its REAL host, so the forgery reads `Work · good.tld · evil.tld` and gives itself away.
  const forgesSuffix = (l: string) => l.includes(SEP);
  const out = all.map((b, i) => {
    const label = labels[i];
    if (label && (counts.get(norm(label)) ?? 0) < 2 && !forgesSuffix(label)) {
      return { value: b.id, label };
    }
    // The stored address, not the effective one: a per-device URL override is machine-local and
    // rarely set, and this only has to tell two same-named entries apart. A blanked serverUrl (one
    // `isStorableServerUrl` refused) has no host, so fall back to an id fragment.
    const host = authorityOf(b.serverUrl)?.host;
    const suffix = host || `#${b.id.slice(0, 8)}`;
    return { value: b.id, label: label ? `${label}${SEP}${suffix}` : suffix };
  });
  // A final pass for labels that are STILL identical — same name AND same host, or two names that
  // both forged their way into the suffix branch. The id fragment is the only term left that a
  // remote name cannot usefully reproduce: it can print some `#aaaaaaaa`, but not one matching the
  // id of the option it wants to be mistaken for, and a wrong fragment beside the right one is
  // itself the tell. Callers append their own suffixes (` (no API key)`) AFTER this function, so
  // the collision test can never be the last word on its own.
  const finalCounts = new Map<string, number>();
  for (const o of out) finalCounts.set(norm(o.label), (finalCounts.get(norm(o.label)) ?? 0) + 1);
  return out.map((o) =>
    (finalCounts.get(norm(o.label)) ?? 0) < 2
      ? o
      : { value: o.value, label: `${o.label}${SEP}#${o.value.slice(0, 8)}` },
  );
}
