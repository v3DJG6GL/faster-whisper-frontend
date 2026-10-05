// Media export (audio / video / video + embedded subtitle tracks): the pure
// half of the export panel's Media section. No Tauri imports — unit-tested
// in plain node. The React side (TranscriptViewer) wires these to the
// dialogs, the Tauri commands and the record.

import { trackLang } from "./cueSplit";
import { planTracks, trackFileSuffixes } from "./exportTracks";
import { generateExports, type ExportOptions, type SubtitleFormat } from "./transcriptExport";
import { codeSlug } from "./sanitize";
import type { BatchResult, Capabilities } from "./types";
import { isSourceUrl } from "./urlSource";

export type MediaChoice = "none" | "audio" | "video";
export type MediaContainer = "mkv" | "mp4";
export type SubtitleMode = "embedded" | "sidecar" | "both";

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** A path's file name without its extension ("/a/talk.de.srt" → "talk.de"). */
export function fileStem(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
}

/** Video containers the picker accepts and the packaging route can read. */
const VIDEO_SOURCE_EXTS = ["mp4", "mkv", "webm", "mov", "m4v"] as const;

export function isVideoSourcePath(path: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return !!m && (VIDEO_SOURCE_EXTS as readonly string[]).includes(m[1].toLowerCase());
}

/** Codec facts the panel greys out MP4 on (the server's `streams`). */
export interface MediaStreams {
  videoCodec?: string | null;
  audioCodec?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  mp4Ok: boolean;
  mp4Reason?: string | null;
}

/** Why MP4 is not on offer, or null when it is. The server's own verdict
 *  (no mp4 muxer) wins over the file's streams; unknown streams allow. */
export function mp4Disabled(
  streams: MediaStreams | null | undefined,
  caps: Capabilities | null | undefined,
): string | null {
  const containers = caps?.media_package?.containers;
  if (containers && !containers.includes("mp4")) {
    return "This server's ffmpeg can't write MP4 — MKV only.";
  }
  if (streams && !streams.mp4Ok) {
    return streams.mp4Reason || "MP4 can't carry these streams — choose MKV.";
  }
  return null;
}

/** One subtitle stream of the packaged video — the wire's `subtitles[i]`. */
export interface EmbeddedTrack {
  lang: string;
  /** The track title (planTracks): "German", or "German [YouTube]" when the
   *  language has several tracks, or the user's name. The original is marked
   *  by the container's original-language flag, never by the name. */
  label: string;
  srt: string;
  /** Written in the spoken language (Matroska FlagOriginal). */
  original: boolean;
  /** Its language's plain track (FlagDefault). */
  default: boolean;
  hearingImpaired: boolean;
}

/** One sidecar subtitle file, single-language, named `stem.<code>.<ext>` —
 *  the dot + ISO 639-1 form every player parses (VLC, mpv, Plex, Jellyfin,
 *  Kodi, Emby, Infuse, MPC-HC) — or, for a language's further tracks,
 *  `stem.<Label>.<code>.<ext>` (trackFileSuffixes). */
export interface SidecarFile {
  track: string;
  lang: string;
  name: (stem: string) => string;
  content: string;
}

/** One track's subtitle file in `format`, generated exactly as the panel's own export would
 *  (edits, renames and speaker colouring included). */
function trackSubtitle(result: BatchResult, opts: ExportOptions, track: string, format: SubtitleFormat): string {
  return generateExports(result, { ...opts, format, tracks: [track] })[0]?.content ?? "";
}

/** One single-language SRT per chosen track (in track order), generated
 *  exactly as the panel's own SRT export would (edits, renames and speaker
 *  colouring included), so the embedded tracks match the sidecars byte for
 *  byte. `names` = the user's track titles by track id. */
export function embeddedSubtitleTracks(
  result: BatchResult,
  opts: ExportOptions,
  tracks: string[],
  names?: Record<string, string>,
): EmbeddedTrack[] {
  return planTracks(result, tracks, names).flatMap((t) => {
    const srt = trackSubtitle(result, opts, t.id, "srt");
    return srt.trim()
      ? [{ lang: t.lang, label: t.title, srt, original: t.original, default: t.plain, hearingImpaired: t.hoh }]
      : [];
  });
}

/** The wire's legacy indices (servers before the per-track flags): the
 *  first original track, and the default = that one, else the first. */
export function legacyTrackIndices(tracks: readonly EmbeddedTrack[]): { defaultTrack: number | null; originalTrack: number | null } {
  const orig = tracks.findIndex((t) => t.original && t.default);
  const originalTrack = orig >= 0 ? orig : null;
  return { defaultTrack: tracks.length ? (originalTrack ?? 0) : null, originalTrack };
}

/** Each chosen track's sidecar name (trackFileSuffixes): `stem.de.srt`,
 *  `stem.YouTube.de.srt`. */
export function sidecarNames(
  result: Pick<BatchResult, "language" | "timedTracks">,
  tracks: string[],
  format: SubtitleFormat,
): ((stem: string) => string)[] {
  return trackFileSuffixes(planTracks(result, tracks), format).map((suffix) => (stem) => stem + suffix);
}

/** One sidecar file per chosen track, in track order, in the panel's
 *  subtitle format — the same per-language content the embedded tracks
 *  carry, so "both" writes the same subtitles twice, once inside and once
 *  beside the video. */
export function sidecarFiles(
  result: BatchResult,
  opts: ExportOptions,
  tracks: string[],
  format: SubtitleFormat,
): SidecarFile[] {
  const names = sidecarNames(result, tracks, format);
  return tracks.flatMap((t, i) => {
    const content = trackSubtitle(result, opts, t, format);
    return content.trim() ? [{ track: t, lang: trackLang(result, t), name: names[i], content }] : [];
  });
}

export interface PlannedFile {
  name: (stem: string) => string;
  kind: "text" | "audio" | "video";
}

export interface MediaExportPlan {
  files: PlannedFile[];
  /** The file the save dialog names; its siblings are derived from it. */
  primary: PlannedFile;
  primaryExt: string;
  /** Tracks that go INTO the video as subtitle streams ([] = none). */
  embedded: string[];
  /** Per-language sidecar files beside the video, or null when the text
   *  files come from the plain text export (Media = None / Audio). */
  sidecars: { tracks: string[]; format: SubtitleFormat } | null;
  saveLabel: string;
  /** Whether the container choice matters for this plan. */
  containerRelevant: boolean;
}

/** What one Save writes, in order: the media file first (it names the
 *  dialog), then the text files — unless subtitles ride inside the video
 *  only, in which case the video is the only file. */
export function mediaExportPlan(a: {
  choice: MediaChoice;
  container: MediaContainer;
  subtitleMode: SubtitleMode;
  format: string;
  textFileNames: ((stem: string) => string)[];
  audioExt: string | null;
  tracks: string[];
  /** The result the tracks belong to (names their sidecars). */
  result: Pick<BatchResult, "language" | "timedTracks">;
  hasVideoSource: boolean;
}): MediaExportPlan {
  const text: PlannedFile[] = a.textFileNames.map((name) => ({ name, kind: "text" }));
  const label = (n: number, one: string) => (n === 1 ? one : `Save ${n} files`);
  if (a.choice === "audio" && a.audioExt) {
    const audio: PlannedFile = { name: (stem) => `${stem}.${a.audioExt}`, kind: "audio" };
    const files = [audio, ...text];
    return {
      files, primary: audio, primaryExt: a.audioExt, embedded: [], sidecars: null,
      saveLabel: label(files.length, "Save audio"), containerRelevant: false,
    };
  }
  if (a.choice === "video" && a.hasVideoSource) {
    const video: PlannedFile = { name: (stem) => `${stem}.${a.container}`, kind: "video" };
    const embedded = a.subtitleMode === "sidecar" ? [] : a.tracks;
    // Sidecars are one file per language (a player lists each as a track);
    // the format row is narrowed to SRT/VTT while Video is on, and a stale
    // non-subtitle format still yields SRT rather than a file nobody loads.
    const format: SubtitleFormat = a.format === "vtt" ? "vtt" : "srt";
    const sidecars = a.subtitleMode === "embedded" ? null : { tracks: a.tracks, format };
    const side: PlannedFile[] = sidecars
      ? sidecarNames(a.result, a.tracks, format).map((name) => ({ name, kind: "text" }))
      : [];
    const files = [video, ...side];
    return {
      files, primary: video, primaryExt: a.container, embedded, sidecars,
      saveLabel: label(files.length, "Save video"), containerRelevant: a.subtitleMode !== "sidecar",
    };
  }
  const primary = text[0] ?? { name: (stem) => `${stem}.${a.format}`, kind: "text" as const };
  return {
    files: text.length ? text : [primary], primary, primaryExt: a.format, embedded: [], sidecars: null,
    saveLabel: label(Math.max(text.length, 1), `Save ${a.format.toUpperCase()}`),
    containerRelevant: false,
  };
}

/** Cleans a title (or a file name) into one path-safe stem segment: control
 *  and reserved characters become spaces, whitespace collapses, trailing
 *  dots/spaces go (Windows strips them), and the result is bounded. Letters
 *  of any script — é, ü, ñ — are kept. */
function cleanStemPart(s: string | null | undefined, max = 120): string {
  return (s ?? "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, max)
    .replace(/[. ]+$/, "");
}

/** Two-part public suffixes under which the site's name is the THIRD label
 *  from the right (bbc.co.uk → bbc). Deliberately tiny — not the PSL. */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "or.jp", "ne.jp",
  "co.kr", "com.br", "com.ar", "com.mx", "com.tr", "com.cn", "com.tw", "com.hk",
  "co.in", "co.za", "com.sg", "co.il",
]);

/** Short-link domains whose name is not the site's own. */
const SITE_ALIASES: Record<string, string> = { youtu: "youtube" };

/** The site a link came from, reduced to its name for a file name: the label
 *  just left of the public suffix (www.rtve.es → "rtve", m.youtube.com and
 *  youtu.be → "youtube", play.srf.ch → "srf", bbc.co.uk → "bbc"). An IP
 *  literal or single-label host falls back to the yt-dlp extractor key
 *  lowercased ("Youtube" → "youtube"; "Generic" says nothing → none), else "". */
export function linkSiteName(url: string, extractor?: string | null): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    host = "";
  }
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
  const labels = isIp ? [] : host.split(".").filter(Boolean);
  if (labels.length >= 2) {
    const lastTwo = labels.slice(-2).join(".");
    const name = labels.length >= 3 && TWO_PART_SUFFIXES.has(lastTwo)
      ? labels[labels.length - 3]
      : labels[labels.length - 2];
    if (/^[a-z0-9-]{1,40}$/.test(name) && !/^-|-$/.test(name)) return SITE_ALIASES[name] ?? name;
  }
  const ex = codeSlug((extractor ?? "").split(":")[0].toLowerCase(), 40);
  return ex && ex !== "generic" ? ex : "";
}

/** Sites whose name is not just capitalised. */
const SITE_DISPLAY: Record<string, string> = {
  youtube: "YouTube", srf: "SRF", rtve: "RTVE", arte: "arte", bbc: "BBC", ard: "ARD", zdf: "ZDF",
  orf: "ORF", rts: "RTS", rsi: "RSI", rai: "RAI", ndr: "NDR", wdr: "WDR", br: "BR", swr: "SWR",
  mdr: "MDR", hr: "HR", rbb: "RBB", sr: "SR", nhk: "NHK", cbc: "CBC", abc: "ABC", nbc: "NBC",
  cbs: "CBS", cnn: "CNN", pbs: "PBS", npr: "NPR", ted: "TED", tiktok: "TikTok", soundcloud: "SoundCloud",
  ardmediathek: "ARD Mediathek", zdfmediathek: "ZDF Mediathek", "3sat": "3sat", tv5monde: "TV5Monde",
  francetv: "France TV", dailymotion: "Dailymotion", vimeo: "Vimeo", twitch: "Twitch",
};

/** The site's name as people write it — the source word of its subtitles (D88): YouTube,
 *  SRF, RTVE, arte, Vimeo; any other site capitalised ("Example"); "" when the link names
 *  none. */
export function siteDisplayName(url: string, extractor?: string | null): string {
  const name = linkSiteName(url, extractor);
  return SITE_DISPLAY[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** The result with every site track's `site` filled in from the link (and its extractor,
 *  when known — the run's own derivation) — records made before tracks carried it. The
 *  same object when nothing is missing. */
export function withTrackSites(result: BatchResult, url: string, extractor?: string | null): BatchResult {
  if (!result.timedTracks?.some((t) => !t.site)) return result;
  const site = isSourceUrl(url) ? siteDisplayName(url, extractor) : "";
  if (!site) return result;
  return { ...result, timedTracks: result.timedTracks.map((t) => (t.site ? t : { ...t, site })) };
}

/** "YYYY.MM.DD_HH.MM" in LOCAL time (what the viewer shows as "04 OCT,
 *  19:34"); "" for a missing or unparsable timestamp. */
export function stemTimestamp(when: string | number | Date | null | undefined): string {
  if (when == null || when === "") return "";
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** What a LINK's export stem carries besides its title: when the transcript
 *  was made (the record's createdAt) and the yt-dlp extractor key, the
 *  site-name fallback for hosts that do not name one. */
export interface LinkStemInfo {
  createdAt?: string | number | Date | null;
  extractor?: string | null;
}

/** The save dialog's default file stem — the ONE builder every export (text
 *  formats, subtitle sidecars, audio, video) and History's quick export use.
 *
 *  A local file: the record's title, cleaned for every file system, else the
 *  file's own name (unchanged from before links existed).
 *
 *  A link (`path` is its URL): `<YYYY.MM.DD>_<HH.MM>_<site>___<title>` — the
 *  fetch date/time and the site lead so a folder of saved links sorts by
 *  when and groups by where (2026.10.04_19.34_rtve___El_declive_de_un_régimen).
 *  Title spaces become underscores; parts that are unknown (no record yet,
 *  no site name) are left out rather than guessed. A link's URL tail
 *  ("watch?v=…") is only the title's last resort, cleaned like any title. */
export function exportStem(title: string | null | undefined, path: string, link?: LinkStemInfo): string {
  if (!isSourceUrl(path)) {
    const clean = cleanStemPart(title);
    if (clean) return clean;
    return fileStem(path) || "transcript";
  }
  let tail = "";
  try {
    const u = new URL(path);
    tail = (u.pathname.split("/").filter(Boolean).pop() ?? "") + u.search;
  } catch {
    tail = "";
  }
  const name = (cleanStemPart(title) || cleanStemPart(tail) || "transcript").replace(/ /g, "_");
  const prefix = [stemTimestamp(link?.createdAt), linkSiteName(path, link?.extractor)].filter(Boolean).join("_");
  return prefix ? `${prefix}___${name}` : name;
}

/** Where the siblings of a multi-file save go: the picked path names the
 *  FIRST file; strip that exact suffix (e.g. ".de.lrc") from what the user
 *  confirmed so siblings never double-suffix and the first file lands on
 *  the picked path. Extracted from the viewer's and History's exports. */
export function derivePickedStem(
  target: string,
  firstSuffix: string,
  fallbackExt: string,
): { dir: string; stem: string } {
  const sep = target.includes("\\") ? "\\" : "/";
  const dir = target.slice(0, target.lastIndexOf(sep) + 1);
  const base = target.slice(dir.length);
  const stem = base.endsWith(firstSuffix)
    ? base.slice(0, -firstSuffix.length)
    : base.replace(new RegExp(`\\.${fallbackExt}$`, "i"), "");
  return { dir, stem };
}

export type MediaExportPhase = "fetching" | "uploading" | "packaging" | "downloading" | "copying" | "writing";

export interface MediaExportProgress {
  jobId: string;
  phase: MediaExportPhase;
  done: number;
  total: number | null;
}
