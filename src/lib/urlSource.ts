// Transcribe-from-URL helpers: identity, validation and display for queue
// items whose "path" slot holds a media link instead of a filesystem path.
//
// Identity model: a URL item's key IS its normalized URL string, living in
// the same `path` slot files use everywhere (queue, overlays, history,
// viewer). Nothing else changes — only display and transport dispatch branch
// on kind, via isSourceUrl().

import { stripUrlNoise } from "./backends";
import { safeDisplayText } from "./sanitize";

/** Is this queue key a media link rather than a filesystem path?
 *
 *  Cannot collide with real paths: absolute paths start with `/` (Linux) or
 *  a drive letter + `\` (Windows), never with an http(s) scheme. */
export function isSourceUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Loose pasted text → a normalized media URL, or null when it isn't one.
 *
 *  Deliberately NOT backends.ts `normalizeUrl`: that helper defaults a
 *  schemeless "host:8000" to http:// because LAN servers are its common
 *  case. A pasted media link must carry its scheme explicitly — silently
 *  prepending http:// to arbitrary pasted text would turn typos into
 *  server-side fetches. Two real slashes required for the same reason
 *  isSchemelessAddress documents: WHATWG honours `https:/one-slash`, so a
 *  looser test here would disagree with what the server actually fetches.
 *
 *  The query survives normalization (YouTube's ?v= IS the identity); the
 *  fragment does not reach the server but is kept verbatim — the URL string
 *  doubles as the queue key, and rewriting it would split history identity
 *  from what the user pasted. */
export function normalizeMediaUrl(raw: string): string | null {
  const t = stripUrlNoise(raw);
  if (t.length === 0 || t.length > 2048) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  return url.toString();
}

/** Human label for a queue key: files show their basename, links show the
 *  (sanitized) media title when known, else host + a shortened path. */
export function displayLabel(key: string, title?: string | null): string {
  if (!isSourceUrl(key)) {
    const parts = key.split(/[\\/]/);
    return parts[parts.length - 1] || key;
  }
  const t = safeDisplayText(title, 120);
  if (t) return t;
  try {
    const u = new URL(key);
    const path = u.pathname === "/" && !u.search ? "" : u.pathname + u.search;
    const short = path.length > 40 ? `${path.slice(0, 37)}…` : path;
    return `${u.hostname}${short}`;
  } catch {
    return safeDisplayText(key, 120) || key;
  }
}

/** Hostname of a URL key, for secondary lines in queue rows and history. */
export function urlHost(key: string): string {
  try {
    return new URL(key).hostname;
  } catch {
    return "";
  }
}

/** Server preview of a pasted link (POST /v1/audio/url-preview). All string
 *  fields are server-bounded in Rust (bounded_server_text) AND sanitized
 *  again at render time — a media title is untrusted remote text. */
export interface UrlPreview {
  title?: string | null;
  duration?: number | null;
  uploader?: string | null;
  extractor?: string | null;
  estimated_bytes?: number | null;
  /** data:image/… URI proxied through the backend, or null. */
  thumbnail?: string | null;
}
