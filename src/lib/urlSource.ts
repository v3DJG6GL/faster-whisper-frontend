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
  // The cap belongs on the value we hand out, not just the input: WHATWG
  // serialization percent-encodes non-ASCII 1→6 chars, so a passing input
  // could return a queue key ~6× over the bound (and one this very function
  // then rejected when addFiles re-normalized it).
  const out = url.toString();
  return out.length > 2048 ? null : out;
}

/** Human label for a queue key: files show their basename, links show the
 *  (sanitized) media title when known, else host + a shortened path. */
export function displayLabel(key: string, title?: string | null): string {
  if (!isSourceUrl(key)) {
    const parts = key.split(/[\\/]/);
    return parts[parts.length - 1] || key;
  }
  // Neither sanitizer trims (Rust maps control chars to spaces), so an
  // all-whitespace remote title is truthy and would render a blank row.
  const t = safeDisplayText(title, 120).trim();
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
  /** Container ext of the audio format the download would fetch ("m4a"). */
  ext?: string | null;
  /** Audio bitrate of that format, kbps. */
  abr?: number | null;
  /** The video heights the site offers (highest first) plus a trailing
   *  "audio only" entry; [] when video is off or the link has none. */
  video_ladder?: VideoRung[] | null;
  /** The server's one media ceiling, for labelling over-cap rungs. */
  media_max_bytes?: number | null;
}

/** One rung of a link's video ladder (server-built from yt-dlp's formats). */
export interface VideoRung {
  kind: "video" | "audio";
  height: number | null;
  width?: number | null;
  fps?: number | null;
  hdr?: boolean | null;
  vcodec?: string | null;
  acodec?: string | null;
  /** The container a merge would produce ("mp4" | "mkv"). */
  container?: string | null;
  ext?: string | null;
  abr?: number | null;
  approx_bytes?: number | null;
  /** True when approx_bytes is an estimate (a fragmented stream lists no
   *  size); false when both legs carry exact sizes. */
  bytes_approx?: boolean | null;
  /** Video + audio bitrate in kbit/s; `bitrate_approx` marks a manifest
   *  peak rather than an average. */
  tbr_kbps?: number | null;
  bitrate_approx?: boolean | null;
  /** The site's own name for a rung that is more than its height:
   *  "Premium", "Source", "Original". */
  note?: string | null;
  /** yt-dlp format ids the download fetches — exactly what was priced. Null
   *  on the single "Best available" rung of a site that names no formats. */
  format_id?: string | null;
  audio_format_id?: string | null;
  protocol?: string | null;
  over_cap?: boolean | null;
  label?: string | null;
}

/** The seven-word quality scale, collapsed from the middle so no two rungs
 *  ever share a word: 7 → all seven, 5 → Highest/High/Medium/Low/Lowest,
 *  3 → Highest/Medium/Lowest, 1 → "Best available". Past seven the tail
 *  shows facts only. Returned in ladder order (best first). */
export function tierWords(n: number): (string | null)[] {
  const scale = ["Highest", "Very high", "High", "Medium", "Low", "Very low", "Lowest"];
  if (n <= 0) return [];
  if (n === 1) return ["Best available"];
  if (n >= scale.length) return scale.concat(Array(n - scale.length).fill(null));
  // Which of the seven survive at each count: ends always, the middle word
  // only at odd counts, the "Very" pair only at six.
  const keep: Record<number, number[]> = {
    2: [0, 6], 3: [0, 3, 6], 4: [0, 2, 4, 6], 5: [0, 2, 3, 4, 6], 6: [0, 1, 2, 4, 5, 6],
  };
  return keep[n].map((i) => scale[i]);
}

/** The mono facts line of a rung: "1080p · ≈2.0 Mbit/s · ≈340 MB · mkv". */
export function rungFacts(
  r: VideoRung,
  fmt: { bytes: (n: number) => string; bitrate: (kbps: number) => string },
): string {
  const parts: string[] = [];
  const spec = r.label ?? (r.height ? `${r.height}p` : "");
  if (spec) parts.push(spec);
  if (r.tbr_kbps) parts.push(`${r.bitrate_approx ? "≈" : ""}${fmt.bitrate(r.tbr_kbps)}`);
  if (r.approx_bytes) parts.push(`${r.bytes_approx === false ? "" : "≈"}${fmt.bytes(r.approx_bytes)}`);
  if (r.container) parts.push(r.container);
  return parts.join(" · ");
}

/** The rung a height cap selects: the highest video rung at or under it
 *  (null = best available); the smallest one when nothing fits; null when
 *  the ladder has no video at all. Mirrors the server's pick_rung. */
export function pickRung(
  ladder: VideoRung[] | null | undefined,
  maxHeight: number | null,
  formatId?: string | null,
): VideoRung | null {
  // Mirrors the server's pick_rung: the ladder is rank-ordered (best
  // first), an explicit format id wins while it is on the ladder, a height
  // cap takes the best-ranked rung under it, else the smallest.
  const rungs = (ladder ?? []).filter((r) => r.kind === "video");
  if (!rungs.length) return null;
  if (formatId) {
    const exact = rungs.find((r) => r.format_id === formatId);
    if (exact) return exact;
  }
  if (maxHeight != null) {
    const withH = rungs.filter((r) => typeof r.height === "number");
    const fitting = withH.filter((r) => (r.height as number) <= maxHeight);
    if (fitting.length) return fitting[0];
    if (withH.length) return withH.reduce((a, b) => ((b.height as number) < (a.height as number) ? b : a));
  }
  return rungs[0];
}

/** "m4a · 128 kbps" — the download row's format chip, from preview fields. */
export function formatLabel(ext?: string | null, abr?: number | null): string | null {
  if (!ext) return null;
  return abr ? `${ext} · ${Math.round(abr)} kbps` : ext;
}
