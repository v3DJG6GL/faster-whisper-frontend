// Transcribe-from-URL helpers: identity, validation and display for queue
// items whose "path" slot holds a media link instead of a filesystem path.
//
// Identity model: a URL item's key IS its normalized URL string, living in
// the same `path` slot files use everywhere (queue, overlays, history,
// viewer). Nothing else changes — only display and transport dispatch branch
// on kind, via isSourceUrl().

import { stripUrlNoise } from "./backends";
import { safeDisplayText } from "./sanitize";
import { fmtDuration, fmtDurationExact } from "./format";
import { languageCodeOf, MULTI_LANGUAGE, namedLanguage } from "./languages";
import type { LinkSpoken } from "./transcript/siteSubtitles";

/** Is this queue key a media link rather than a filesystem path?
 *
 *  Cannot collide with real paths: absolute paths start with `/` (Linux) or
 *  a drive letter + `\` (Windows), never with an http(s) scheme. */
export function isSourceUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** A pasted MEDIA link's edges, cleared of whitespace and of the invisible format characters
 *  web pages and chat clients add to copied text (U+200B, U+FEFF, U+2060, U+00AD — Unicode Cf),
 *  then stripUrlNoise. Only the edges: inside the link nothing changes. A SERVER address keeps
 *  stripUrlNoise alone (exactly the Rust transport's trim, which keeps U+FEFF). */
export function stripMediaUrlNoise(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return stripUrlNoise(raw.replace(/^[\x00-\x20\s\u0085\p{Cf}]+|[\x00-\x20\s\u0085\p{Cf}]+$/gu, ""));
}

/** Does this pasted text hold more than one link — a link, then whitespace or an invisible
 *  separator and a second scheme, as a pasted "linkA linkB" chat line or two tab-separated
 *  spreadsheet cells read? `new URL` would percent-encode the space and quietly merge the two
 *  into one queue key. A second scheme WITHOUT a separator before it stays a link: archive and
 *  redirect links embed one (https://web.archive.org/web/2020/https://host/v.mp4, ?url=https://…).
 *  Judged on the RAW text: stripUrlNoise deletes inner tabs, which would glue the two cells into
 *  one link. Line breaks (CR, LF) go first, as the parsers drop them (a soft-wrapped single link
 *  stays one); the separators the parsers keep — U+2028/U+2029/U+0085, VT, FF, and a format
 *  character such as U+200B — part two links. The edges are trimmed as stripMediaUrlNoise trims
 *  them (a rich-text copy's U+00A0, an IME's U+3000, a BOM, a zero-width space). Text that does
 *  not start with a link is not "several links" — it is text before a link. */
export function pastesSeveralLinks(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\n\r]/g, "").replace(/^[\x00-\x20\s\u0085\p{Cf}]+|[\x00-\x20\s\u0085\p{Cf}]+$/gu, "");
  return (
    /^https?:\/\//i.test(t) &&
    /[\t\v\f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\p{Cf}]https?:\/\//iu.test(t)
  );
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
  const t = stripMediaUrlNoise(raw);
  if (t.length === 0 || t.length > 2048) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  // One link per Add: a single space inside a path ("https://host/My File.mp3") stays accepted.
  // Judged on the raw text — the tab between two pasted cells is gone from `t`.
  if (pastesSeveralLinks(raw)) return null;
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

/** The source pill for a link's extractor: yt-dlp's "Generic" reads as
 *  "direct link"; anything else is sanitized and trimmed, so a name made
 *  only of control/format characters yields "" (callers draw no pill). */
export function extractorPill(extractor: unknown): string {
  return extractor === "Generic" ? "direct link" : safeDisplayText(extractor, 24).trim();
}

/** Hostname of a URL key, for secondary lines in queue rows and history. */
export function urlHost(key: string): string {
  try {
    return new URL(key).hostname;
  } catch {
    return "";
  }
}

/** The spoken language Add link freezes on a link, or undefined to keep following the screen's
 *  pick at run time. A language the card took from your pick, a check or the site stays with the
 *  link even when it equals the screen's now — the screen picker stays editable after Add.
 *  Anything else only mirrors the screen's pick (its named language, or an "auto"/Multiple
 *  placeholder when the screen is Default, Auto-detect or Multiple), so it follows the screen:
 *  freezing "auto" under Default would send an explicit auto-detect that overrides the server's
 *  DEFAULT_LANGUAGE. */
export function frozenLinkSpoken(sp: Pick<LinkSpoken, "value" | "source">): string | undefined {
  if (sp.source === "edited") return sp.value;
  if ((sp.source === "detected" || sp.source === "site") && sp.value !== MULTI_LANGUAGE) return sp.value;
  return undefined;
}

/** The screen language a link card starts from. Under Default ("") a link sends no language
 *  (frozenLinkSpoken), so its run takes the server's DEFAULT_LANGUAGE: the card, the site-subtitle
 *  plan and the automatic language check start from that language too, not from auto-detect.
 *  It stays a screen value, so Add still lets the link follow the screen. */
export function linkScreenSpoken(screenValue: string, serverLanguage: unknown): string {
  if (screenValue !== "") return screenValue;
  const s = languageCodeOf(typeof serverLanguage === "string" ? serverLanguage.trim() : "");
  return namedLanguage(s) ? s : "";
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
  /** URL_MAX_DURATION_S — the longest link the server downloads (newer backends). */
  url_max_duration_s?: number | null;
  /** The spoken language the site names (YouTube does, most sites don't). */
  language?: string | null;
  /** The site's own subtitle tracks (ids only; the server keeps the URLs). */
  subtitle_tracks?: SiteTrackInfo[] | null;
}

/** Why the server will refuse this link before downloading it — longer than its
 *  URL_MAX_DURATION_S — or null when it fits (or either number is unknown). */
export function linkTooLong(p: Pick<UrlPreview, "duration" | "url_max_duration_s"> | null | undefined): string | null {
  const d = p?.duration;
  const max = p?.url_max_duration_s;
  if (typeof d !== "number" || typeof max !== "number" || !(d > 0) || !(max > 0) || d <= max) return null;
  // fmtDuration rounds to whole minutes, so a 90 s limit would read "2m" — longer than a
  // 100 s link it refuses. Whole-minute limits keep the short form ("4h"); others go exact.
  const limit = Math.round(max) % 60 === 0 ? fmtDuration(max) : fmtDurationExact(max);
  return `Longer than this server's ${limit} limit.`;
}

/** The server's reason, as a sentence, when a link preview failed with a policy refusal
 *  (too long, over the size limit, a playlist, a site it doesn't allow) — the
 *  run's own probe refuses it again, so it is final. Read from the fixed
 *  `link_refused:<reason>` shape Rust marks it with; null for any other (advisory) failure. */
export function linkRefusal(e: unknown): string | null {
  const m = /^link_refused:([\s\S]+)$/.exec(String(e ?? ""));
  const reason = m?.[1].trim();
  if (!reason) return null;
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** One subtitle track a link offers. `hoh` = hearing-impaired, from its name. */
export interface SiteTrackInfo {
  id: string;
  lang: string;
  name?: string | null;
  kind: "manual" | "auto";
  ext: "vtt" | "srt";
  hoh: boolean;
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
 *  3 → Highest/Medium/Lowest, 1 → "Best available". Past seven the rungs
 *  between "Very low" and the last ("Lowest") show facts only. Returned in
 *  ladder order (best first). */
export function tierWords(n: number): (string | null)[] {
  const scale = ["Highest", "Very high", "High", "Medium", "Low", "Very low", "Lowest"];
  if (n <= 0) return [];
  if (n === 1) return ["Best available"];
  if (n >= scale.length) return [...scale.slice(0, -1), ...Array(n - scale.length).fill(null), "Lowest"];
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
