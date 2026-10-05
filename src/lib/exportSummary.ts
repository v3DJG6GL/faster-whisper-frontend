// The export panel's Content toggles and Summary rows (D85): what the chosen
// format can carry, and what the file will contain. Pure, no Tauri imports —
// the panel maps these onto its controls.

import { isSubtitleFormat, type ExportFormat } from "./transcriptExport";

/** on/off = a toggle; fixed = always in this format; na = the format can't
 *  carry it (or the transcript has nothing to carry). `why` is the tooltip. */
export type ContentState = "on" | "off" | "fixed" | "na";

export interface ContentItem {
  key: "ts" | "names" | "colors" | "words";
  label: string;
  state: ContentState;
  why: string;
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
}): ContentItem[] {
  const { format: f } = a;
  const toggle = (on: boolean, why: string): Pick<ContentItem, "state" | "why"> => ({ state: on ? "on" : "off", why });
  const noSpeakers = { state: "na" as const, why: "no speakers in this transcript" };
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
        : f === "json" ? { state: "fixed" as const, why: "always in JSON, with your renames" }
          : toggle(a.showNames, "the speaker's name before each line")),
    },
    {
      key: "colors", label: "Speaker colors",
      ...(!a.hasSpeakers ? noSpeakers
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

/** ✓ on · ○ off · – not part of this format · ! needs a look. */
export type SummaryState = "on" | "off" | "na" | "warn";

export interface SummaryRow {
  label: string;
  state: SummaryState;
  why: string;
}

/** The Summary box: what one Save writes, row by row. */
export function exportSummary(a: {
  format: ExportFormat;
  /** Track codes in file/line order, for display ("EN", "DE"). */
  trackCodes: string[];
  /** Tracks stacked inside each subtitle (one shared file). */
  stacked: boolean;
  /** One file per track (LRC, own timing). */
  filePerTrack: boolean;
  /** Subtitles the original track gets; null = as transcribed. */
  cueCount: number | null;
  segCount: number;
  showTs: boolean;
  content: ContentItem[];
  hasSpeakers: boolean;
  /** First speaker's display name, for the names row. */
  firstName: string | null;
  cpsCount: number;
  /** "17 chars/s", or a phrase when the languages' limits differ. */
  cpsLimit: string;
  editCount: number;
  media: { choice: "none" | "audio" | "video"; container: string; subtitleMode: string; audioExt: string | null } | null;
}): SummaryRow[] {
  const sub = isSubtitleFormat(a.format);
  const item = (k: ContentItem["key"]) => a.content.find((c) => c.key === k)!;
  const plural = (n: number, one: string) => `${n.toLocaleString("en")} ${one}${n === 1 ? "" : "s"}`;
  const rows: SummaryRow[] = [];
  rows.push(
    sub ? { label: "Cue timings", state: "on", why: "start and end of every subtitle" }
      : a.format === "lrc" ? { label: "Line timings", state: "on", why: "a time tag on every line" }
        : a.format === "json" ? { label: "Timestamps", state: "on", why: "every segment and word" }
          : { label: "Timestamps", state: a.showTs ? "on" : "off", why: a.showTs ? "a time before each line" : "off" },
  );
  rows.push({
    label: "Tracks",
    state: "on",
    why: a.format === "json" ? "every track, as data"
      : a.trackCodes.join(" · ") + (a.trackCodes.length > 1
        ? a.filePerTrack ? " — one file each" : a.stacked ? " — in that order inside each subtitle" : ""
        : ""),
  });
  rows.push(
    !sub ? { label: "Subtitle length", state: "na", why: "not part of this format" }
      : a.cueCount === null ? { label: "Subtitle length", state: "off", why: `as transcribed — ${plural(a.segCount, "subtitle")}` }
        : { label: "Subtitle length", state: "on", why: `${plural(a.cueCount, "subtitle")} from ${plural(a.segCount, "segment")}` },
  );
  if (a.hasSpeakers) {
    const names = item("names");
    rows.push({
      label: "Speaker names",
      state: names.state === "fixed" ? "on" : names.state,
      why: names.state === "off" ? "off" : names.state === "fixed" ? "with your renames, as data"
        : a.firstName ? `“${a.firstName}:” before each line` : "on",
    });
    const colors = item("colors");
    rows.push({
      label: "Speaker colors",
      state: colors.state === "fixed" ? "on" : colors.state,
      why: colors.state === "off" ? "off" : colors.why,
    });
  }
  rows.push(
    !sub ? { label: "Reading speed", state: "na", why: "not part of this format" }
      : a.cpsCount ? { label: "Reading speed", state: "warn", why: `${plural(a.cpsCount, "subtitle")} faster than ${a.cpsLimit}` }
        : { label: "Reading speed", state: "on", why: `every subtitle at or under ${a.cpsLimit}` },
  );
  rows.push({ label: "Corrections", state: a.editCount ? "on" : "off", why: a.editCount ? `${a.editCount} included` : "none" });
  if (a.media) {
    const m = a.media;
    rows.push(
      m.choice === "video"
        ? {
            label: "Media", state: "on",
            why: `video in ${m.container.toUpperCase()}, subtitles ${
              m.subtitleMode === "embedded" ? "embedded" : m.subtitleMode === "sidecar" ? "as separate files" : "embedded and as files"}`,
          }
        : m.choice === "audio" ? { label: "Media", state: "on", why: `audio copy as ${m.audioExt ?? "m4a"}` }
          : { label: "Media", state: "off", why: "text file only" },
    );
  }
  return rows;
}
