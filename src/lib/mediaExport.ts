// Media export (audio / video / video + embedded subtitle tracks): the pure
// half of the export panel's Media section. No Tauri imports — unit-tested
// in plain node. The React side (TranscriptViewer) wires these to the
// dialogs, the Tauri commands and the record.

import { generateExports, type ExportOptions } from "./transcriptExport";
import type { BatchResult, Capabilities } from "./types";

export type MediaChoice = "none" | "audio" | "video";
export type MediaContainer = "mkv" | "mp4";
export type SubtitleMode = "embedded" | "sidecar" | "both";

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
  label: string;
  srt: string;
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
    if (t === "orig") {
      const lang = (result.language ?? "").trim() || "und";
      out.push({ lang, label: `${languageLabel(lang)} · original`, srt });
    } else {
      out.push({ lang: t, label: languageLabel(t), srt });
    }
  }
  return out;
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
  hasVideoSource: boolean;
}): MediaExportPlan {
  const text: PlannedFile[] = a.textFileNames.map((name) => ({ name, kind: "text" }));
  const label = (n: number, one: string) => (n === 1 ? one : `Save ${n} files`);
  if (a.choice === "audio" && a.audioExt) {
    const audio: PlannedFile = { name: (stem) => `${stem}.${a.audioExt}`, kind: "audio" };
    const files = [audio, ...text];
    return {
      files, primary: audio, primaryExt: a.audioExt, embedded: [],
      saveLabel: label(files.length, "Save audio"), containerRelevant: false,
    };
  }
  if (a.choice === "video" && a.hasVideoSource) {
    const video: PlannedFile = { name: (stem) => `${stem}.${a.container}`, kind: "video" };
    const embedded = a.subtitleMode === "sidecar" ? [] : a.tracks;
    const files = a.subtitleMode === "embedded" ? [video] : [video, ...text];
    return {
      files, primary: video, primaryExt: a.container, embedded,
      saveLabel: label(files.length, "Save video"), containerRelevant: a.subtitleMode !== "sidecar",
    };
  }
  const primary = text[0] ?? { name: (stem) => `${stem}.${a.format}`, kind: "text" as const };
  return {
    files: text.length ? text : [primary], primary, primaryExt: a.format, embedded: [],
    saveLabel: label(Math.max(text.length, 1), `Save ${a.format.toUpperCase()}`),
    containerRelevant: false,
  };
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
