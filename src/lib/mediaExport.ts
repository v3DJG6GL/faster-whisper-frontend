// Media export (audio / video / video + embedded subtitle tracks): the pure
// half of the export panel's Media section. No Tauri imports — unit-tested
// in plain node. The React side (TranscriptViewer) wires these to the
// dialogs, the Tauri commands and the record.

import { generateExports, type ExportOptions } from "./transcriptExport";
import type { BatchResult, Capabilities } from "./types";

export type MediaChoice = "none" | "audio" | "video";
export type MediaContainer = "mkv" | "mp4";
export type SubtitleMode = "embedded" | "sidecar" | "both";
/** The two text formats a video player loads beside (or inside) a video.
 *  TXT, LRC and JSON are not subtitles: with Video on, the format row
 *  narrows to these two (D69 A). */
export type SubtitleFormat = "srt" | "vtt";
export const SUBTITLE_FORMATS: readonly SubtitleFormat[] = ["srt", "vtt"];
export function isSubtitleFormat(format: string): format is SubtitleFormat {
  return (SUBTITLE_FORMATS as readonly string[]).includes(format);
}

/** Video containers the picker accepts and the packaging route can read. */
export const VIDEO_SOURCE_EXTS = ["mp4", "mkv", "webm", "mov", "m4v"] as const;

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

export interface EmbeddedTrack {
  lang: string;
  /** The plain language name — "German". The original is marked by the
   *  container's original-language flag, never by the name. */
  label: string;
  srt: string;
  original: boolean;
}

/** One sidecar subtitle file, single-language, named `stem.<code>.<ext>` —
 *  the dot + ISO 639-1 form every player parses (VLC, mpv, Plex, Jellyfin,
 *  Kodi, Emby, Infuse, MPC-HC). The original file carries the result's
 *  language code; there is no player convention for "original", so the
 *  panel says it instead. */
export interface SidecarFile {
  track: string;
  lang: string;
  name: (stem: string) => string;
  content: string;
}

/** English names for the track titles — the same short table the viewer's
 *  chips use; anything else is the code in caps. */
const LANG_LABELS: Record<string, string> = {
  en: "English", de: "German", fr: "French", it: "Italian", es: "Spanish",
  pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  cs: "Czech", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish",
  tr: "Turkish", ar: "Arabic", zh: "Chinese", ja: "Japanese", ko: "Korean",
  hu: "Hungarian", ro: "Romanian", el: "Greek", hi: "Hindi", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", et: "Estonian",
};

export function languageLabel(code: string): string {
  const base = code.split("-")[0].toLowerCase();
  const region = code.includes("-") ? ` (${code.split("-")[1].toUpperCase()})` : "";
  return (LANG_LABELS[base] ?? base.toUpperCase()) + region;
}

/** The language code a track is filed under: the result's language for
 *  the original ("und" when unknown), the target code otherwise. */
export function trackLang(result: BatchResult, track: string): string {
  return track === "orig" ? (result.language ?? "").trim() || "und" : track;
}

/** One single-language SRT per chosen track, generated exactly as the
 *  panel's own SRT export would (edits, renames and speaker colouring
 *  included), so the embedded tracks match the sidecars byte for byte. */
export function embeddedSubtitleTracks(
  result: BatchResult,
  opts: ExportOptions,
  tracks: string[],
): EmbeddedTrack[] {
  const out: EmbeddedTrack[] = [];
  for (const t of tracks) {
    const files = generateExports(result, { ...opts, format: "srt", tracks: [t] });
    const srt = files[0]?.content ?? "";
    if (!srt.trim()) continue;
    const lang = trackLang(result, t);
    out.push({ lang, label: languageLabel(lang), srt, original: t === "orig" });
  }
  return out;
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
  const out: SidecarFile[] = [];
  for (const t of tracks) {
    const files = generateExports(result, { ...opts, format, tracks: [t] });
    const content = files[0]?.content ?? "";
    if (!content.trim()) continue;
    const lang = trackLang(result, t);
    out.push({ track: t, lang, name: sidecarName(lang, format), content });
  }
  return out;
}

/** `stem.de.srt` — codes are user/server-authored, so keep them path-safe. */
export function sidecarName(lang: string, format: SubtitleFormat): (stem: string) => string {
  const code = lang.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "und";
  return (stem) => `${stem}.${code}.${format}`;
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
  /** The original track's language code (names its sidecar). */
  origLang: string;
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
      ? a.tracks.map((t) => ({ name: sidecarName(t === "orig" ? a.origLang : t, format), kind: "text" }))
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

/** Where the siblings of a multi-file save go: the picked path names the
 *  FIRST file; strip that exact suffix (e.g. ".de.lrc") from what the user
 *  confirmed so siblings never double-suffix and the first file lands on
 *  the picked path. Extracted from the viewer's and History's exports. */
/** The save dialog's default file stem: the record's title, cleaned for
 *  every file system, else the source file's own name. A link's basename is
 *  its URL tail ("watch?v=…"), which is why the title leads. */
export function exportStem(title: string | null | undefined, path: string): string {
  const clean = (title ?? "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  if (clean) return clean;
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "") || "transcript";
}

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
