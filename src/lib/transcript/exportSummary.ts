// The export panel's Content toggles and Summary rows: what the chosen
// format can carry, and what the file will contain. Pure, no Tauri imports —
// the panel maps these onto its controls.

import { plural } from "../format";
import { isSubtitleFormat, writtenCues, type ExportFormat } from "./transcriptFormats";
import { timedTrack, type CueGrid, type CueOptions } from "./cueSplit";
import { LINK_AUDIO_EXT } from "./mediaExport";
import type { BatchResult } from "../types";

/** on/off = a toggle; fixed = always in this format; na = the format can't
 *  carry it (or the transcript has nothing to carry). `why` is the tooltip. */
export type ContentState = "on" | "off" | "fixed" | "na";

export interface ContentItem {
  key: "ts" | "names" | "colors" | "words";
  label: string;
  state: ContentState;
  why: string;
  /** Speaker names in an uncolored VTT: a voice tag on original lines (players may hide it),
   *  "Name: " before machine-translated ones (vttExport) — which the export carries. */
  vttNames?: "voice" | "prefix" | "mixed";
}

/** The Content box: Timestamps · Speaker names · Speaker colors · Word timing,
 *  format-aware — the same values Read's toggles show. */
export function contentStates(a: {
  format: ExportFormat;
  showTs: boolean;
  showNames: boolean;
  colorize: boolean;
  wordTs: boolean;
  hasSpeakers: boolean;
  hasWords: boolean;
  /** The original track is in the export (LRC word tags are original-only). */
  origIncluded: boolean;
  /** A machine-translated track is in the export. */
  mtIncluded?: boolean;
}): ContentItem[] {
  const { format: f } = a;
  // A site track never carries a voice tag: it is filed on its own, cued without speakers.
  // So an export of site tracks alone has no names or colors to write (JSON keeps them as data).
  const siteOnly = f !== "json" && !a.origIncluded && !a.mtIncluded;
  const voice = a.origIncluded;
  const vttNames = f === "vtt" && !a.colorize && !siteOnly
    ? (voice && a.mtIncluded ? "mixed" as const : voice ? "voice" as const : "prefix" as const)
    : undefined;
  const toggle = (on: boolean, why: string): Pick<ContentItem, "state" | "why"> => ({ state: on ? "on" : "off", why });
  const noSpeakers = { state: "na" as const, why: "no speakers in this transcript" };
  const siteNoSpeakers = { state: "na" as const, why: "the site's own subtitles carry no speakers" };
  return [
    {
      key: "ts", label: "Timestamps",
      ...(f === "txt"
        ? toggle(a.showTs, "a [mm:ss] time before each line")
        : { state: "fixed" as const, why: f === "json" ? "always in JSON" : "always — the timing is the format" }),
    },
    {
      key: "names", label: "Speaker names",
      ...(!a.hasSpeakers ? noSpeakers
        : siteOnly ? siteNoSpeakers
          : f === "json" ? { state: "fixed" as const, why: "always in JSON, with your renames" }
            : { ...toggle(a.showNames, f === "txt" && !a.showTs ? "the speaker's name before each turn"
              : vttNames === "mixed"
                ? "the speaker's name as a voice tag on original lines (players may hide it), “Name:” before translated lines"
                : vttNames === "voice"
                  ? "the speaker's name as a voice tag on each line (players may hide it)"
                  : "the speaker's name before each line"), vttNames }),
    },
    {
      key: "colors", label: "Speaker colors",
      ...(!a.hasSpeakers ? noSpeakers
        : siteOnly ? siteNoSpeakers
          : f === "json" ? { state: "fixed" as const, why: "always in JSON, as data" }
            : isSubtitleFormat(f) ? toggle(a.colorize, f === "srt" ? "<font> tags — VLC and mpv show them" : "styled cues — browsers show them, some players don't")
              : { state: "na" as const, why: "plain text has no colors" }),
    },
    {
      key: "words", label: "Word timing",
      ...(!a.hasWords ? { state: "na" as const, why: "this run captured no word timing" }
        : f === "json" ? { state: "fixed" as const, why: "always in JSON — the words array" }
          : f !== "lrc" ? { state: "na" as const, why: "only LRC and JSON keep word timing" }
            : !a.origIncluded ? { state: "na" as const, why: "word timing is original-track only" }
              : toggle(a.wordTs, "enhanced-LRC word tags for karaoke players")),
    },
  ];
}

/** Tooltip on Subtitle length's warning mark (cueSplit splits a cue only at word timings). */
export const NO_WORDS_SPLIT_WHY =
  "This run captured no word timing, so subtitles are not split: each segment stays one subtitle, only its lines are wrapped.";

/** Mark Subtitle length while it asks for a split the transcript cannot get. */
export function lengthNeedsWords(hasWords: boolean, length: string): boolean {
  return !hasWords && length !== "transcribed";
}

/** ✓ on · ○ off · – does not apply (not part of this format, or nothing to write or check) · ! needs a look. */
export type SummaryState = "on" | "off" | "na" | "warn";

export interface SummaryRow {
  label: string;
  state: SummaryState;
  why: string;
}

/** The Summary's subtitle count (exportSummary's `written` / `ownOnly` / `site`). It describes
 *  the file the shared cues go into: the original's when it is exported, else the one the
 *  same-timed translations share — counted as that file writes them (writtenCues). A single
 *  track without the original is that one file's count, its own cues when it keeps them
 *  (`site` for a site track, whose cues are never split). When two or more exported tracks all
 *  keep their own cues (site tracks, own-timed translations), or each goes to a file or stream
 *  of its own (`perTrack`: sidecars, a video's subtitle streams) without the original, there is
 *  no one count to show: `ownOnly`, never a sum across files. `tracks` = the exported tracks
 *  (empty = the original only); `grid` = a subtitle cueGrid over at least them. */
export function summaryCount(
  result: Pick<BatchResult, "timedTracks">,
  grid: CueGrid | null,
  tracks: string[],
  cues: CueOptions | undefined,
  perTrack = false,
): { written: number; ownOnly: boolean; site?: boolean } {
  const orig = !tracks.length || tracks.includes("orig");
  if (!orig && tracks.length === 1) {
    return { written: grid ? writtenCues(grid, tracks).length : 0, ownOnly: false, ...(timedTrack(result, tracks[0]) ? { site: true } : {}) };
  }
  if (perTrack && !orig && tracks.length > 1) return { written: 0, ownOnly: true };
  const shared = orig ? ["orig"]
    : tracks.filter((t) => !timedTrack(result, t) && cues?.timing !== "own");
  if (!shared.length) return { written: 0, ownOnly: true };
  return { written: grid ? writtenCues(grid, shared).length : 0, ownOnly: false };
}

/** The Summary box: what one Save writes, row by row. */
export function exportSummary(a: {
  format: ExportFormat;
  /** Track codes in file/line order, for display ("EN", "DE"). */
  trackCodes: string[];
  /** Tracks stacked inside each subtitle (one shared file). */
  stacked: boolean;
  /** One file per track (LRC, own timing, a video's sidecars). */
  filePerTrack: boolean;
  /** Text files the export writes: a site track with its own timing gets one of its own
   *  while the rest share one, so two files can hold three tracks. */
  fileCount?: number;
  /** Subtitles are split to a length (false = as transcribed, one per segment). */
  split: boolean;
  /** Subtitles the shared file writes (the original's file when it is exported; else the file
   *  the same-timed translations share) — writtenCues, so blank and untranslated cues count
   *  exactly as the file writes them. */
  written: number;
  /** No shared file: two or more exported tracks each keep their own cues (site tracks,
   *  own-timed translations) or their own file or stream, so there is no one count to show —
   *  never a sum across files. */
  ownOnly?: boolean;
  /** `written` counts a single site track's own cues, which are never split. */
  site?: boolean;
  segCount: number;
  showTs: boolean;
  content: ContentItem[];
  hasSpeakers: boolean;
  /** First speaker's display name, for the names row. */
  firstName: string | null;
  cpsCount: number;
  /** The source was plain text: its clocks are 1 s placeholders, so the reading speed
   *  was not checked (cpsWarnings skips it) and must not read as fine. */
  timingSynthesized?: boolean;
  /** "17 chars/s", or a phrase when the languages' limits differ. */
  cpsLimit: string;
  editCount: number;
  media: { choice: "none" | "audio" | "video"; container: string; subtitleMode: string; audioExt: string | null } | null;
}): SummaryRow[] {
  const sub = isSubtitleFormat(a.format);
  const item = (k: ContentItem["key"]) => a.content.find((c) => c.key === k)!;
  const rows: SummaryRow[] = [];
  /** A row whose state branches share one label (the row's identity and React key). */
  const row = (label: string, body: Omit<SummaryRow, "label">): SummaryRow => ({ label, ...body });
  const timing: SummaryRow =
    sub ? { label: "Cue timings", state: "on", why: "start and end of every subtitle" }
      : a.format === "lrc" ? { label: "Line timings", state: "on", why: "a time tag on every line" }
        : a.format === "json" ? { label: "Timestamps", state: "on", why: "every segment and word" }
          : { label: "Timestamps", state: a.showTs ? "on" : "off", why: a.showTs ? "a time before each line" : "off" };
  rows.push(
    a.timingSynthesized && timing.state === "on"
      ? { label: timing.label, state: "warn", why: "placeholders, 1 s per line — the source has no timing" }
      : timing,
  );
  rows.push({
    label: "Tracks",
    state: "on",
    why: a.format === "json" ? "every track, as data"
      : a.trackCodes.join(" · ") + (a.trackCodes.length > 1
        ? a.filePerTrack ? " — one file each"
          : a.stacked ? (sub ? " — in that order inside each subtitle" : " — in that order, interleaved")
            : (a.fileCount ?? 0) > 1 ? ` — in ${a.fileCount} files, each site track on its own` : ""
        : ""),
  });
  rows.push(row("Subtitle length",
    !sub ? { state: "na", why: "not part of this format" }
      : a.ownOnly ? { state: a.split ? "on" : "off", why: "each track has its own count" }
        : a.site ? { state: "na", why: `${plural(a.written, "subtitle")} — the site's own cues, never split` }
        : !a.split ? { state: "off", why: `as transcribed — ${plural(a.written, "subtitle")}` }
          : { state: "on", why: `${plural(a.written, "subtitle")} from ${plural(a.segCount, "segment")}` },
  ));
  if (a.hasSpeakers) {
    const names = item("names");
    rows.push({
      label: "Speaker names",
      state: names.state === "fixed" ? "on" : names.state,
      why: names.state === "off" ? "off" : names.state === "na" ? names.why
        : names.state === "fixed" ? "with your renames, as data"
        : !a.firstName ? "on"
          : names.vttNames === "mixed"
            ? `as a voice tag (<v ${a.firstName}>) on original lines, “${a.firstName}:” before translated lines`
            : names.vttNames === "voice"
              ? `as a voice tag (<v ${a.firstName}>) on each line`
              : `“${a.firstName}:” ${a.format === "txt" && !a.showTs ? "before each turn" : "before each line"}`,
    });
    const colors = item("colors");
    rows.push({
      label: "Speaker colors",
      state: colors.state === "fixed" ? "on" : colors.state,
      why: colors.state === "off" ? "off" : colors.why,
    });
  }
  rows.push(row("Reading speed",
    !sub ? { state: "na", why: "not part of this format" }
      : a.timingSynthesized ? { state: "na", why: "not checked — the source has no timing" }
        : a.cpsCount ? { state: "warn", why: `${plural(a.cpsCount, "subtitle")} faster than ${a.cpsLimit}` }
          : { state: "on", why: `every subtitle at or under ${a.cpsLimit}` },
  ));
  rows.push({ label: "Corrections", state: a.editCount ? "on" : "off", why: a.editCount ? `${a.editCount} included` : "none" });
  if (a.media) {
    const m = a.media;
    rows.push(row("Media",
      m.choice === "video"
        ? {
            state: "on",
            why: `video in ${m.container.toUpperCase()}, subtitles ${
              m.subtitleMode === "embedded" ? "embedded" : m.subtitleMode === "sidecar" ? "as separate files" : "embedded and as files"}`,
          }
        : m.choice === "audio" ? { state: "on", why: `audio copy as ${m.audioExt ?? LINK_AUDIO_EXT}` }
          : { state: "off", why: "text file only" },
    ));
  }
  return rows;
}
