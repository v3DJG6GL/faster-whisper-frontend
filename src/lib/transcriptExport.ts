// Pure transcript-export generators (TXT / SRT / VTT / LRC / JSON) for the
// Transcribe screen. No Tauri imports — runs (and is unit-tested) in plain
// node. Every string that reaches an output file passes stripControlChars:
// segment/word text is server-controlled and speaker names are user-typed,
// and both end up in files that get opened elsewhere.

import { stripControlChars } from "./sanitize";
import type { BatchResult, TranscriptSegment, TranscriptWord } from "./types";

export type ExportFormat = "txt" | "srt" | "vtt" | "lrc" | "json";
/** How speaker identity is styled in subtitle formats:
 *  off = plain "Name:" prefix · name = only the name colored ·
 *  line = name + sentence colored · line-only = sentence colored, name hidden. */
export type SpeakerColorMode = "off" | "name" | "line" | "line-only";

export interface ExportOptions {
  format: ExportFormat;
  /** Speaker label → user-chosen display name (falls back to prettified label). */
  renames?: Record<string, string>;
  speakerColors?: SpeakerColorMode;
  /** Speaker label → #rrggbb. Defaults cycle the app palette by speaker order. */
  colors?: Record<string, string>;
  /** LRC only: emit enhanced-LRC inline word tags from `words`. */
  wordTimestamps?: boolean;
  /** Emit speaker-name prefixes / voice tags at all (default true). Off +
   *  a color mode = the colored line carries no name (the old "line-only"
   *  is exactly names:false + colors:on in the screen's toggle model). */
  speakerNames?: boolean;
  /** TXT only: per-segment "[mm:ss]" line prefixes instead of speaker-turn
   *  paragraphs (the screen's Timestamps toggle; cue formats always carry
   *  times — that is the format). */
  timestamps?: boolean;
}

/** Default per-speaker colors, cycled by first-appearance order. Eight
 *  hue-separated tones at matched brightness so neighbours stay tellable
 *  apart on the dark theme (the old 5-tone cycle put two near-identical
 *  ambers next to each other and repeated from speaker 6 on). Coral stays
 *  reserved for the live-recording pulse. Shared with the speaker chips on
 *  the Transcribe screen. */
export const DEFAULT_SPEAKER_COLORS = [
  "#ff9e2c", // amber (accent)
  "#6faed9", // sky (think)
  "#36d07a", // green (live)
  "#c792ea", // lilac
  "#e8d44d", // lemon
  "#4dd0c4", // teal
  "#f286b6", // rose
  "#9aa7ff", // periwinkle
] as const;

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  txt: "txt",
  srt: "srt",
  vtt: "vtt",
  lrc: "lrc",
  json: "json",
};

/** "SPEAKER_00" → "Speaker 1"; anything else verbatim. Mirrors the screen. */
export function prettySpeaker(label: string): string {
  const m = /^SPEAKER_(\d+)$/.exec(label);
  return m ? `Speaker ${parseInt(m[1], 10) + 1}` : label;
}

/** Distinct speaker labels in first-appearance order. */
export function speakerOrder(result: BatchResult): string[] {
  if (result.speakers?.length) return result.speakers;
  const seen: string[] = [];
  for (const s of result.segments ?? []) {
    if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return seen;
}

function clean(s: string): string {
  // Exports are single-logical-line records; a newline inside segment text
  // would corrupt SRT/LRC framing, so collapse it.
  return stripControlChars(s).replace(/\n/g, " ").trim();
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

/** 3661.24 → "01:01:01,240" (SRT) / "01:01:01.240" (VTT). */
function clockTime(seconds: number, sep: "," | "."): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}${sep}${pad3(ms)}`;
}

/** 61.24 → "01:01.24" (LRC line/word tags use minutes + centiseconds). */
function lrcTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const cs = Math.round((s - m * 60) * 100);
  return `${pad2(m)}:${(cs / 100).toFixed(2).padStart(5, "0")}`;
}

interface Ctx {
  opts: ExportOptions;
  order: string[];
  hasSpeakers: boolean;
  /** hasSpeakers AND the speakerNames option — name prefixes wanted. */
  names: boolean;
}

function nameOf(ctx: Ctx, label: string): string {
  const renamed = ctx.opts.renames?.[label]?.trim();
  return clean(renamed || prettySpeaker(label));
}

function colorOf(ctx: Ctx, label: string): string {
  const explicit = ctx.opts.colors?.[label];
  if (explicit && /^#[0-9a-fA-F]{6}$/.test(explicit)) return explicit;
  const i = Math.max(0, ctx.order.indexOf(label));
  return DEFAULT_SPEAKER_COLORS[i % DEFAULT_SPEAKER_COLORS.length];
}

/** VTT cue payloads use an HTML-ish syntax — escape text so a transcript that
 *  legitimately contains "<" can't open a rogue tag. */
function vttEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 61.2 → "01:01" / 3661 → "1:01:01" — human timestamps for TXT lines. */
function txtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

function txtExport(result: BatchResult, ctx: Ctx): string {
  if (ctx.opts.timestamps && result.segments?.length) {
    // Timestamps on: one "[mm:ss] Name: text" line per segment.
    return (
      result.segments
        .map((seg) => {
          const prefix = seg.speaker && ctx.names ? `${nameOf(ctx, seg.speaker)}: ` : "";
          return `[${txtTime(seg.start)}] ${prefix}${clean(seg.text)}`;
        })
        .join("\n") + "\n"
    );
  }
  if (!ctx.names || !result.segments?.length) {
    return stripControlChars(result.text).trim() + "\n";
  }
  // One paragraph per speaking TURN (consecutive same-speaker segments merge).
  const paras: string[] = [];
  let who: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      const prefix = who ? `${nameOf(ctx, who)}: ` : "";
      paras.push(prefix + buf.join(" "));
    }
    buf = [];
  };
  for (const seg of result.segments) {
    const label = seg.speaker ?? null;
    if (label !== who) {
      flush();
      who = label;
    }
    buf.push(clean(seg.text));
  }
  flush();
  return paras.join("\n\n") + "\n";
}

function srtLine(ctx: Ctx, seg: TranscriptSegment): string {
  const text = clean(seg.text);
  if (!seg.speaker || !ctx.hasSpeakers) return text;
  const mode = ctx.opts.speakerColors ?? "off";
  if (mode === "off") {
    return ctx.names ? `${nameOf(ctx, seg.speaker)}: ${text}` : text;
  }
  const color = colorOf(ctx, seg.speaker);
  if (!ctx.names) return `<font color="${color}">${text}</font>`;
  const name = nameOf(ctx, seg.speaker);
  // <font color> is the de-facto SRT styling convention (VLC/mpv honor it).
  if (mode === "name") return `<font color="${color}">${name}:</font> ${text}`;
  if (mode === "line") return `<font color="${color}">${name}: ${text}</font>`;
  return `<font color="${color}">${text}</font>`; // line-only, name hidden
}

function srtExport(result: BatchResult, ctx: Ctx): string {
  const out: string[] = [];
  (result.segments ?? []).forEach((seg, i) => {
    out.push(String(i + 1));
    out.push(`${clockTime(seg.start, ",")} --> ${clockTime(seg.end, ",")}`);
    out.push(srtLine(ctx, seg));
    out.push("");
  });
  return out.join("\n");
}

function vttExport(result: BatchResult, ctx: Ctx): string {
  const mode = ctx.opts.speakerColors ?? "off";
  const out: string[] = ["WEBVTT", ""];
  if (ctx.hasSpeakers && mode !== "off") {
    // Generated class names (spk1, spk2, …) — NEVER derived from user text;
    // the display name appears only as cue text. Class styling renders in
    // browsers; players like mpv/VLC degrade to plain text.
    out.push("STYLE");
    ctx.order.forEach((label, i) => {
      out.push(`::cue(.spk${i + 1}) { color: ${colorOf(ctx, label)}; }`);
    });
    out.push("");
  }
  (result.segments ?? []).forEach((seg) => {
    out.push(`${clockTime(seg.start, ".")} --> ${clockTime(seg.end, ".")}`);
    const text = vttEscape(clean(seg.text));
    if (!seg.speaker || !ctx.hasSpeakers) {
      out.push(text);
    } else {
      const cls = `spk${Math.max(0, ctx.order.indexOf(seg.speaker)) + 1}`;
      if (!ctx.names) {
        out.push(mode === "off" ? text : `<c.${cls}>${text}</c>`);
      } else {
        const name = vttEscape(nameOf(ctx, seg.speaker));
        if (mode === "off") out.push(`<v ${name}>${text}</v>`);
        else if (mode === "name") out.push(`<c.${cls}>${name}:</c> ${text}`);
        else if (mode === "line") out.push(`<c.${cls}>${name}: ${text}</c>`);
        else out.push(`<c.${cls}>${text}</c>`);
      }
    }
    out.push("");
  });
  return out.join("\n");
}

/** Words inside a segment's time window (tolerant to boundary rounding). */
function wordsFor(words: TranscriptWord[], seg: TranscriptSegment): TranscriptWord[] {
  return words.filter((w) => w.start >= seg.start - 0.05 && w.start < seg.end + 0.05);
}

function lrcExport(result: BatchResult, ctx: Ctx): string {
  const words = result.words ?? [];
  const useWords = !!ctx.opts.wordTimestamps && words.length > 0;
  const out: string[] = [];
  for (const seg of result.segments ?? []) {
    const prefix = seg.speaker && ctx.names ? `${nameOf(ctx, seg.speaker)}: ` : "";
    if (useWords) {
      const ws = wordsFor(words, seg);
      if (ws.length) {
        // Enhanced LRC (A2): inline <mm:ss.xx> tags, each marking the start
        // of the following word — the karaoke convention.
        const body = ws.map((w) => `<${lrcTime(w.start)}>${clean(w.word)}`).join(" ");
        out.push(`[${lrcTime(seg.start)}]${prefix}${body}`);
        continue;
      }
    }
    out.push(`[${lrcTime(seg.start)}]${prefix}${clean(seg.text)}`);
  }
  return out.join("\n") + "\n";
}

function jsonExport(result: BatchResult, ctx: Ctx): string {
  return JSON.stringify(
    {
      text: stripControlChars(result.text),
      language: result.language ?? null,
      duration: result.duration ?? null,
      speakers: ctx.order.map((label) => ({
        label,
        name: nameOf(ctx, label),
      })),
      segments: (result.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: stripControlChars(s.text),
        ...(s.speaker ? { speaker: s.speaker, speakerName: nameOf(ctx, s.speaker) } : {}),
      })),
      ...(result.words?.length
        ? { words: result.words.map((w) => ({ ...w, word: stripControlChars(w.word) })) }
        : {}),
    },
    null,
    2,
  ) + "\n";
}

/** Render `result` in the requested format. Pure — safe to golden-test. */
export function generateExport(result: BatchResult, opts: ExportOptions): string {
  const order = speakerOrder(result);
  const ctx: Ctx = {
    opts,
    order,
    hasSpeakers: order.length > 0,
    names: order.length > 0 && opts.speakerNames !== false,
  };
  switch (opts.format) {
    case "txt":
      return txtExport(result, ctx);
    case "srt":
      return srtExport(result, ctx);
    case "vtt":
      return vttExport(result, ctx);
    case "lrc":
      return lrcExport(result, ctx);
    case "json":
      return jsonExport(result, ctx);
  }
}
