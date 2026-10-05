// Pure transcript-export generators (TXT / SRT / VTT / LRC / JSON) for the
// Transcribe screen. No Tauri imports — runs (and is unit-tested) in plain
// node. Every string that reaches an output file passes stripControlChars:
// segment/word text is server-controlled and speaker names are user-typed,
// and both end up in files that get opened elsewhere.

import {
  TRANSCRIBED_CPS, buildCues, cueResult, timedTrack, trText, trackCues, trackLimits, wrapLines, type CueOptions,
} from "./cueSplit";
import { planTracks, trackFileSuffixes } from "./exportTracks";
import { codeSlug, stripControlChars } from "./sanitize";
import { segmentWordRanges } from "./wordAlign";
import type { BatchResult, TimedTrack, TranscriptSegment } from "./types";

export type ExportFormat = "txt" | "srt" | "vtt" | "lrc" | "json";
/** The two text formats a video player loads beside (or inside) a video —
 *  the formats with subtitle cues. TXT, LRC and JSON are not subtitles: with
 *  Video on, the format row narrows to these two (D69 A). */
export type SubtitleFormat = "srt" | "vtt";
export function isSubtitleFormat(format: string): format is SubtitleFormat {
  return format === "srt" || format === "vtt";
}
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
  /** Language tracks to include: "orig" + target codes, IN ORDER — the order
   *  of the files, and of the lines inside a subtitle that stacks several
   *  (D92). Undefined = original only, exactly the pre-translation output
   *  (golden-stable). For LRC with more than one track use generateExports —
   *  one FILE per track. */
  tracks?: string[];
  /** SRT/VTT subtitle cues (D83/D84): split long segments and wrap lines.
   *  Undefined = one cue per segment, unwrapped — the pre-cue output. */
  cues?: CueOptions;
}

/** Default per-speaker colors, cycled by first-appearance order. Eight
 *  hue-separated tones at matched brightness so neighbours stay tellable
 *  apart on the dark theme (the old 5-tone cycle put two near-identical
 *  ambers next to each other and repeated from speaker 6 on). Coral stays
 *  reserved for the live-recording pulse. Shared with the speaker chips on
 *  the Transcribe screen.
 *
 *  The same hexes app.css fixes for --spk-1…8: the Signal colour tints chrome
 *  only and never the speaker palette, so screen and export agree. */
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

/** THE speaker-color resolver — viewer chips (via --spk-N tokens) and export
 *  hexes both resolve through this: an explicit user pick wins, else the
 *  label's first-appearance index, cycled through the palette. Keeping one
 *  implementation is the point — the viewer and the exports drifted apart
 *  once (picks read under a different overlay key) and disagreed on colors. */
export function speakerColorIndex(
  order: string[],
  picks: Record<string, number> | undefined,
  label: string,
): number {
  const n = DEFAULT_SPEAKER_COLORS.length;
  const picked = picks?.[label];
  if (typeof picked === "number" && Number.isFinite(picked)) {
    return ((Math.trunc(picked) % n) + n) % n;
  }
  return Math.max(0, order.indexOf(label)) % n;
}

/** The resolved palette hex for a label (export wire format / JSON export). */
export function speakerHex(
  order: string[],
  picks: Record<string, number> | undefined,
  label: string,
): string {
  return DEFAULT_SPEAKER_COLORS[speakerColorIndex(order, picks, label)];
}

/** The export's options from the transcript's display toggles (the view is the export) — one
 *  builder for the export panel and History's quick export. Colors on → "line" mode;
 *  names/timestamps gate their prefixes; the palette picks become the wire's hexes through
 *  the shared resolver. `tracks` in track order (D92); none = the original only. */
export function exportOptionsFor(a: {
  format: ExportFormat;
  /** speakerOrder of the result. */
  speakers: string[];
  renames: Record<string, string>;
  /** Speaker label → palette index (the user's picks). */
  colorPicks: Record<string, number>;
  toggles: { showTs: boolean; showNames: boolean; colorize: boolean; wordTs: boolean };
  cues: CueOptions | undefined;
  tracks?: string[];
}): ExportOptions {
  return {
    format: a.format,
    renames: a.renames,
    speakerColors: a.speakers.length && a.toggles.colorize ? "line" : "off",
    speakerNames: a.toggles.showNames,
    timestamps: a.toggles.showTs,
    colors: Object.fromEntries(
      Object.keys(a.colorPicks).map((l) => [l, speakerHex(a.speakers, a.colorPicks, l)]),
    ),
    wordTimestamps: a.toggles.wordTs,
    cues: a.cues,
    ...(a.tracks?.length ? { tracks: a.tracks } : {}),
  };
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
  // Round to the emitted resolution FIRST, so a carry increments the unit
  // above instead of overflowing the sub-unit field (1.9996 → "01,1000").
  const total = Math.round(Math.max(0, seconds) * 1000);
  const ms = total % 1000;
  const t = Math.floor(total / 1000);
  return `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor((t % 3600) / 60))}:${pad2(t % 60)}${sep}${pad3(ms)}`;
}

/** 61.24 → "01:01.24" (LRC line/word tags use minutes + centiseconds). */
function lrcTime(seconds: number): string {
  const total = Math.round(Math.max(0, seconds) * 100);
  const m = Math.floor(total / 6000);
  const rest = total % 6000;
  return `${pad2(m)}:${pad2(Math.floor(rest / 100))}.${pad2(rest % 100)}`;
}

interface Ctx {
  opts: ExportOptions;
  order: string[];
  hasSpeakers: boolean;
  /** hasSpeakers AND the speakerNames option — name prefixes wanted. */
  names: boolean;
  /** Translated tracks to include (empty = original-only output). */
  visLangs: string[];
  origIncluded: boolean;
  /** The included tracks in line order ("orig" among them). */
  lineTracks: string[];
  /** Line-wrap one cue line of `track` (identity without cue options);
   *  `reserve` = chars a prefix takes on the first line. */
  wrap: (text: string, track: string, reserve: number) => string;
}

/** A segment's translation for one track (trText), cleaned; null when there is none. */
function trOf(seg: TranscriptSegment, lang: string): string | null {
  const t = trText(seg, lang);
  return t === null ? null : clean(t) || null;
}

/** Is this export carrying more than one translated track?
 *
 *  The tag rule for every format: label a translated line ONLY when the file
 *  contains more than one translated language. With a single target the
 *  language is unambiguous and the output stays byte-identical to what it has
 *  always been; with two or more, an untagged line is genuinely unreadable —
 *  nothing in the file says which of them it is. */
function ambiguous(ctx: Ctx): boolean {
  return ctx.visLangs.length > 1;
}

/** A language code reduced to something safe inside a WebVTT cue class.
 *
 *  Target codes come from user-editable settings and a synced backend, so they
 *  are not guaranteed to be well-formed BCP-47 — and a class name lands inside
 *  `<c.…>` markup and a STYLE block, where a stray `.`, `>` or space would
 *  break the cue rather than merely look wrong. Lowercased alphanumerics and
 *  hyphens only, bounded; an unusable code degrades to a positional `x`
 *  instead of emitting broken markup. */
function vttClass(lang: string): string {
  return codeSlug(lang.toLowerCase(), 12, "x");
}

/** Cue text lines for one segment across the included tracks, in track order.
 *  `mt` renders a translated line; the speaker is language-independent, so the
 *  color modes style it exactly as they style the original.
 *
 *  `lang` reaches `mt` because it used to be dropped between two maps here:
 *  the language was known, iterated over, and then thrown away before the
 *  line was built, which is why every format emitted untagged translated
 *  lines no matter how many targets were included. */
function cueLines(
  ctx: Ctx,
  seg: TranscriptSegment,
  orig: string,
  mt: (text: string, seg: TranscriptSegment, lang: string) => string,
): string[] {
  return ctx.lineTracks.flatMap((lang) => {
    if (lang === "orig") return [orig];
    const t = trOf(seg, lang);
    return t === null ? [] : [mt(t, seg, lang)];
  });
}

function nameOf(ctx: Ctx, label: string): string {
  // Sanitize BEFORE choosing: a rename made only of bidi/format characters is
  // truthy but cleans to "", which would blank the name for the whole export.
  const renamed = clean(ctx.opts.renames?.[label] ?? "");
  return renamed || clean(prettySpeaker(label));
}

function colorOf(ctx: Ctx, label: string): string {
  // `opts.colors` is the wire format: explicit hexes, built FROM the user's
  // palette picks by callers (the viewer maps its pick indexes through
  // DEFAULT_SPEAKER_COLORS — i.e. speakerHex). Absent/invalid entries fall
  // through to the shared first-appearance resolver.
  const explicit = ctx.opts.colors?.[label];
  if (explicit && /^#[0-9a-fA-F]{6}$/.test(explicit)) return explicit;
  return speakerHex(ctx.order, undefined, label);
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
    // Timestamps on: one "[mm:ss] Name: text" line per segment (+ one
    // indented line per included translated track). With the original
    // included the segment's FIRST emitted line carries the time and the rest
    // indent under it (a kept-original or absent translation emits nothing,
    // so the time never vanishes); translations alone each carry it.
    return (
      result.segments
        .flatMap((seg) => {
          const prefix = seg.speaker && ctx.names ? `${nameOf(ctx, seg.speaker)}: ` : "";
          const time = `[${txtTime(seg.start)}] `;
          return cueLines(
            ctx,
            seg,
            `${prefix}${clean(seg.text)}`,
            (t, _s, lang) => `${ambiguous(ctx) ? `[${lang.toUpperCase()}] ` : ""}${prefix}${t}`,
          ).map((line, i) => (i && ctx.origIncluded ? "        " : time) + line);
        })
        .join("\n") + "\n"
    );
  }
  if (ctx.visLangs.length && result.segments?.length) {
    // Interleaved paragraphs per speaker turn, included tracks in order.
    const paras: string[] = [];
    let who: string | null = null;
    let bufs: string[][] = [];
    const trackCount = ctx.lineTracks.length;
    // Which language each buffer slot holds, so a paragraph can say what it
    // is. Without this every track produced an identically-prefixed paragraph
    // and a reader had only paragraph ORDER to go on.
    const slotLangs = ctx.lineTracks.map((t) => (t === "orig" ? null : t));
    const flush = () => {
      if (bufs.some((b) => b.length)) {
        const prefix = who && ctx.names ? `${nameOf(ctx, who)}: ` : "";
        bufs.forEach((b, i) => {
          if (!b.length) return;
          const lang = slotLangs[i];
          const tag = lang && ambiguous(ctx) ? `[${lang.toUpperCase()}] ` : "";
          paras.push(tag + prefix + b.join(" "));
        });
      }
      bufs = Array.from({ length: trackCount }, () => []);
    };
    bufs = Array.from({ length: trackCount }, () => []);
    for (const seg of result.segments) {
      const label = seg.speaker ?? null;
      if (label !== who) {
        flush();
        who = label;
      }
      slotLangs.forEach((lang, slot) => {
        const t = lang === null ? clean(seg.text) : trOf(seg, lang);
        if (t) bufs[slot].push(t);
      });
    }
    flush();
    return paras.join("\n\n") + "\n";
  }
  if (!ctx.origIncluded && result.segments?.length) {
    // Only an EMPTY selection reaches here (any translated track was served by the
    // speaker-turn branch above): nothing was picked, so nothing is written — falling
    // through would emit the original text the user deselected.
    return "\n";
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

/** Speaker-styled SRT line — shared by original AND translated lines: the
 *  speaker (and their color) is language-independent, so a translations-only
 *  export keeps the same names/colors the original would carry. */
function srtStyled(ctx: Ctx, seg: TranscriptSegment, text: string): string {
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

/** Chars a "Name: " prefix takes on a cue's first line (0 without one). */
function nameReserve(ctx: Ctx, seg: TranscriptSegment): number {
  return seg.speaker && ctx.names ? nameOf(ctx, seg.speaker).length + 2 : 0;
}

function srtLine(ctx: Ctx, seg: TranscriptSegment): string {
  return srtStyled(ctx, seg, ctx.wrap(clean(seg.text), "orig", nameReserve(ctx, seg)));
}

function srtMtLine(ctx: Ctx, text: string, seg: TranscriptSegment, lang: string): string {
  // SRT has no class mechanism, so an ambiguous file tags in the text itself.
  // Prefixed rather than appended: a player truncating a long cue must not be
  // able to cut off the only thing identifying the language.
  const tag = ambiguous(ctx) ? `[${lang.toUpperCase()}] ` : "";
  return srtStyled(ctx, seg, tag + ctx.wrap(text, lang, tag.length + nameReserve(ctx, seg)));
}

function srtExport(result: BatchResult, ctx: Ctx): string {
  const out: string[] = [];
  // Cue numbers count EMITTED cues (a translations-only export skips
  // untranslated segments; strict parsers require monotonic 1..N).
  let cueNo = 0;
  (result.segments ?? []).forEach((seg) => {
    const lines = cueLines(ctx, seg, srtLine(ctx, seg),
      (t, _s, lang) => srtMtLine(ctx, t, seg, lang));
    if (!lines.length) return;
    out.push(String(++cueNo));
    out.push(`${clockTime(seg.start, ",")} --> ${clockTime(seg.end, ",")}`);
    out.push(...lines);
    out.push("");
  });
  return out.join("\n");
}

function vttExport(result: BatchResult, ctx: Ctx): string {
  const mode = ctx.opts.speakerColors ?? "off";
  const out: string[] = ["WEBVTT", ""];
  if (ctx.visLangs.length) {
    // Translated lines carry a generated .mt class so players that honor
    // STYLE can tone them; others degrade to plain text.
    out.push("STYLE");
    out.push("::cue(.mt) { color: #4dd0c4; }");
    // ...plus a PER-LANGUAGE class when more than one target is present.
    // .mt alone was emitted for every target, so an EN line and an FR line
    // were literally indistinguishable to any player or downstream tool —
    // the file said "this is a translation" and never which one. The classes
    // are generated from the language code, which is a code, never user text.
    if (ambiguous(ctx)) {
      for (const lang of ctx.visLangs) {
        out.push(`::cue(.mt-${vttClass(lang)}) { color: #4dd0c4; }`);
      }
    }
    out.push("");
  }
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
    const text = vttEscape(ctx.wrap(clean(seg.text), "orig", nameReserve(ctx, seg)));
    let orig: string;
    if (!seg.speaker || !ctx.hasSpeakers) {
      orig = text;
    } else {
      const cls = `spk${Math.max(0, ctx.order.indexOf(seg.speaker)) + 1}`;
      if (!ctx.names) {
        orig = mode === "off" ? text : `<c.${cls}>${text}</c>`;
      } else {
        const name = vttEscape(nameOf(ctx, seg.speaker));
        if (mode === "off") orig = `<v ${name}>${text}</v>`;
        else if (mode === "name") orig = `<c.${cls}>${name}:</c> ${text}`;
        else if (mode === "line") orig = `<c.${cls}>${name}: ${text}</c>`;
        else orig = `<c.${cls}>${text}</c>`;
      }
    }
    const lines = cueLines(ctx, seg, orig, (t, _s, lang) => {
      const mt = ambiguous(ctx) ? `mt.mt-${vttClass(lang)}` : "mt";
      // Translated lines carry the SAME speaker classes as the original (the
      // speaker is language-independent) stacked with .mt — the spk STYLE
      // block is emitted after .mt's, so the speaker color wins when on.
      const escaped = vttEscape(ctx.wrap(t, lang, nameReserve(ctx, seg)));
      if (!seg.speaker || !ctx.hasSpeakers) return `<c.${mt}>${escaped}</c>`;
      const name = vttEscape(nameOf(ctx, seg.speaker));
      if (mode === "off") {
        return `<c.${mt}>${ctx.names ? `${name}: ` : ""}${escaped}</c>`;
      }
      const cls = `spk${Math.max(0, ctx.order.indexOf(seg.speaker)) + 1}`;
      if (!ctx.names) return `<c.${mt}.${cls}>${escaped}</c>`;
      if (mode === "name") return `<c.${cls}>${name}:</c> <c.${mt}>${escaped}</c>`;
      if (mode === "line") return `<c.${mt}.${cls}>${name}: ${escaped}</c>`;
      return `<c.${mt}.${cls}>${escaped}</c>`;
    });
    if (!lines.length) return;
    out.push(`${clockTime(seg.start, ".")} --> ${clockTime(seg.end, ".")}`);
    out.push(...lines);
    out.push("");
  });
  return out.join("\n");
}

function lrcExport(result: BatchResult, ctx: Ctx, track: string = "orig"): string {
  const words = result.words ?? [];
  // Word timing never survives translation — enhanced tags are original-only.
  const useWords = track === "orig" && !!ctx.opts.wordTimestamps && words.length > 0;
  const segs = result.segments ?? [];
  // One linear pass over `words` for the whole document (both arrays are time-ordered)
  // instead of a full scan per segment; the same cursor merge the viewer uses, so a word
  // on an exact segment boundary lands in one line, not two.
  const ranges = useWords ? segmentWordRanges(segs, words) : null;
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const prefix = seg.speaker && ctx.names ? `${nameOf(ctx, seg.speaker)}: ` : "";
    if (track !== "orig") {
      const t = trOf(seg, track);
      if (t) out.push(`[${lrcTime(seg.start)}]${prefix}${t}`);
      continue;
    }
    if (ranges) {
      const [from, to] = ranges[i];
      const ws = words.slice(from, to);
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
      language: stripControlChars(result.language ?? "") || null,
      duration: result.duration ?? null,
      speakers: ctx.order.map((label) => ({
        // The raw label is the lookup key; the EMITTED value is defanged like every other
        // string in this file (the header's promise).
        label: stripControlChars(label),
        name: nameOf(ctx, label),
        // The user-chosen (or default) chip color — data for downstream
        // renderers, so recoloring in the app survives into the export.
        color: colorOf(ctx, label),
      })),
      ...(result.translation
        ? {
            translation: {
              model: stripControlChars(result.translation.model ?? "") || null,
              targets: result.translation.targets.map((t) => stripControlChars(t)),
              source: stripControlChars(result.translation.source ?? "") || null,
              ...(result.translation.mode ? { mode: stripControlChars(result.translation.mode) } : {}),
            },
          }
        : {}),
      segments: (result.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: stripControlChars(s.text),
        ...(s.speaker ? { speaker: stripControlChars(s.speaker), speakerName: nameOf(ctx, s.speaker) } : {}),
        ...(s.translations && Object.keys(s.translations).length
          ? {
              translations: Object.fromEntries(
                Object.entries(s.translations).map(([k, v]) => [k, stripControlChars(v)]),
              ),
            }
          : {}),
        // JSON is the full-data format: carry the quality-guard marker so a
        // downstream consumer can tell a kept-original from a translation.
        ...(s.translationsKept?.length
          ? { translationsKept: s.translationsKept.map((k) => stripControlChars(k)) }
          : {}),
      })),
      ...(result.words?.length
        ? { words: result.words.map((w) => ({ ...w, word: stripControlChars(w.word) })) }
        : {}),
      ...(result.timedTracks?.length ? { timedTracks: result.timedTracks.map(jsonTimedTrack) } : {}),
    },
    null,
    2,
  ) + "\n";
}

/** A timed track as JSON data, every string defanged. */
function jsonTimedTrack(t: TimedTrack) {
  return {
    id: stripControlChars(t.id),
    lang: stripControlChars(t.lang),
    ...(t.label ? { label: stripControlChars(t.label) } : {}),
    source: t.source,
    kind: t.kind,
    ...(t.hoh ? { hoh: true } : {}),
    ...(t.site ? { site: stripControlChars(t.site) } : {}),
    cues: t.cues.map((c) => ({ start: c.start, end: c.end, text: stripControlChars(c.text) })),
  };
}

/** The tracks an export (or one of its files) carries, in order — the original only
 *  without a pick. */
export const tracksOf = (opts: { tracks?: string[] }): string[] => opts.tracks ?? ["orig"];

/** Machine translations get cues of their own: SRT/VTT whose cue options ask for own timing. */
const ownTimingOn = (opts: Pick<ExportOptions, "format" | "cues">) =>
  isSubtitleFormat(opts.format) && opts.cues?.timing === "own";

/** Does `track` carry its own cue timing in this export? Site tracks always;
 *  a machine translation under own timing. */
function ownTimed(result: BatchResult, opts: ExportOptions, track: string): boolean {
  return !!timedTrack(result, track) || (track !== "orig" && ownTimingOn(opts));
}

/** What the generators render: the segments themselves, or — for SRT/VTT
 *  with cue options, and for a single own-timed track — the cues projected
 *  as segments (cueResult), so every generator below stays cue-agnostic. */
function projected(result: BatchResult, opts: ExportOptions): BatchResult {
  if (opts.format === "json") return result;
  const tracks = tracksOf(opts);
  if (tracks.length === 1 && ownTimed(result, opts, tracks[0])) {
    return cueResult(result, cueGrid(result, opts, tracks), tracks[0]);
  }
  return opts.cues && isSubtitleFormat(opts.format) ? cueResult(result, cueGrid(result, opts, tracks)) : result;
}

/** The cues of `tracks`, leaving room for the "Name: " prefix their first
 *  line will carry — shared by the export, its reading-speed check and the
 *  panel's preview and summary. Only subtitle formats split: any other gets
 *  one cue per segment. */
export function cueGrid(result: BatchResult, opts: ExportOptions, tracks: string[]) {
  const pre = ctxOf(result, opts);
  return buildCues(result, isSubtitleFormat(opts.format) ? opts.cues : undefined, tracks, (seg) => nameReserve(pre, seg));
}

/** Render `result` in the requested format. Pure — safe to golden-test. */
export function generateExport(source: BatchResult, opts: ExportOptions): string {
  const result = projected(source, opts);
  const ctx = ctxOf(result, opts);
  switch (opts.format) {
    case "txt":
      return txtExport(result, ctx);
    case "srt":
      return srtExport(result, ctx);
    case "vtt":
      return vttExport(result, ctx);
    case "lrc":
      // LRC is single-track per file: exactly one selected translated track
      // renders that track; anything else renders the original (multi-track
      // LRC goes through generateExports — one file per track).
      return lrcExport(
        result,
        ctx,
        !ctx.origIncluded && ctx.visLangs.length === 1 ? ctx.visLangs[0] : "orig",
      );
    case "json":
      return jsonExport(result, ctx);
  }
}

function ctxOf(result: BatchResult, opts: ExportOptions): Ctx {
  const order = speakerOrder(result);
  const lineTracks = exportTrackList(opts);
  const cues = isSubtitleFormat(opts.format) ? opts.cues : undefined;
  return {
    opts,
    order,
    hasSpeakers: order.length > 0,
    names: order.length > 0 && opts.speakerNames !== false,
    visLangs: lineTracks.filter((t) => t !== "orig"),
    origIncluded: lineTracks.includes("orig"),
    lineTracks,
    wrap: (text, track, reserve) => {
      const L = trackLimits(result, cues, track);
      if (!L) return text;
      return wrapLines(text, L.cpl, L.lines, reserve).join("\n");
    },
  };
}

/** One file an export writes: the tracks it carries (undefined = the
 *  original only, the pre-translation shape) and its name from the stem. */
export interface ExportFileGroup {
  tracks?: string[];
  name: (stem: string) => string;
}

/** The files an export writes, in track order — shared by generateExports
 *  and the panel's file names (no content serialized). JSON is one file
 *  carrying every track. A track goes to a file of its own when the format
 *  can't stack it with the others: LRC (duplicate-timestamp bilingual LRC
 *  renders unreliably across players), SRT/VTT under own translation timing
 *  (cues no longer line up), and site tracks with their own timing; the rest
 *  share one file. A file of its own is named by trackFileSuffixes (D89): its
 *  language's plain track `stem.de.srt` (the original `stem.srt`), the others
 *  `stem.YouTube.de.srt`. Names depend only on format, tracks and cue timing. */
export function exportFileGroups(
  opts: ExportOptions,
  result: Pick<BatchResult, "language" | "timedTracks"> = {},
): ExportFileGroup[] {
  const ext = EXPORT_EXTENSIONS[opts.format];
  // JSON carries every track regardless of the picker (see ctxOf), so the stem
  // suffix must be empty — a language-suffixed name for a full-data file is
  // misleading and wrong when the track picker state survives a format switch.
  if (opts.format === "json") return [{ tracks: opts.tracks, name: (stem) => `${stem}.${ext}` }];
  const tracks = exportTrackList(opts);
  const perTrack = opts.format === "lrc" || ownTimingOn(opts);
  const alone = tracks.filter((t) => perTrack || timedTrack(result, t));
  if (!alone.length) {
    const suffix = exportStemSuffix(opts.tracks);
    return [{ tracks: opts.tracks, name: (stem) => `${stem}${suffix}.${ext}` }];
  }
  const shared = tracks.filter((t) => !alone.includes(t));
  const sharedSuffix = `${exportStemSuffix(shared)}.${ext}`;
  // Planned over every track, so a language's plain track is its first in the
  // order whichever file it lands in.
  const plan = planTracks(result, tracks);
  const suffixes = trackFileSuffixes(plan.filter((t) => alone.includes(t.id)), ext, {
    origBare: true,
    taken: shared.length ? [sharedSuffix] : [],
  });
  const groups: ExportFileGroup[] = [
    ...(shared.length ? [{ tracks: shared, name: (stem: string) => stem + sharedSuffix }] : []),
    ...alone.map((track, i) => ({ tracks: [track], name: (stem: string) => stem + suffixes[i] })),
  ];
  // Files follow the track order (the shared file sits where its first track does).
  return groups.sort((a, b) => tracks.indexOf(a.tracks![0]) - tracks.indexOf(b.tracks![0]));
}

/** The start of one file (`opts.tracks` = the tracks it carries): its first
 *  `n` subtitles — or segments, for a format without them — as the file
 *  would write them, `count` of its `total`. The export panel's preview. */
export function previewExport(
  result: BatchResult,
  opts: ExportOptions,
  n: number,
): { text: string; count: number; total: number } {
  const tracks = tracksOf(opts);
  const segs = result.segments ?? [];
  const grid = cueGrid(result, opts, tracks);
  const list = tracks.length === 1
    ? trackCues(grid, tracks[0])
    : grid.cues.filter((c) => tracks.some((t) => (t === "orig" ? c.text : c.tr[t])));
  const last = list[Math.min(n, list.length) - 1];
  // The segments behind the first n cues — or, for a track with its own
  // timing, everything before the n-th cue ends.
  const until = !last ? Math.min(n, segs.length) : last.seg >= 0 ? last.seg + 1 : segs.filter((s) => s.start < last.end).length;
  const end = (last && last.seg < 0 ? last.end : segs[until - 1]?.end ?? 0) + 0.05;
  const sample: BatchResult = {
    ...result,
    segments: segs.slice(0, until),
    words: result.words?.filter((w) => w.start < end),
    text: segs.slice(0, until).map((s) => s.text.trim()).join(" "),
    timedTracks: result.timedTracks?.map((t) => ({ ...t, cues: t.cues.filter((c) => c.start < end) })),
  };
  return {
    text: generateExport(sample, opts),
    count: list.filter((c) => (c.seg >= 0 ? c.seg < until : c.start < end)).length,
    total: list.length,
  };
}

/** Like generateExport, but one entry per file the export writes (see
 *  exportFileGroups). `name(stem)` appends the track suffix; `tracks` = the
 *  tracks the file carries (undefined = the original only). */
export function generateExports(
  result: BatchResult,
  opts: ExportOptions,
): { name: (stem: string) => string; content: string; tracks?: string[] }[] {
  return exportFileGroups(opts, result).map((g) => ({
    name: g.name,
    tracks: g.tracks,
    content: generateExport(result, { ...opts, tracks: g.tracks }),
  }));
}

/** The tracks an export writes, in order (the original only without a pick). */
function exportTrackList(opts: ExportOptions): string[] {
  if (opts.format === "json") return opts.tracks?.includes("orig") === false ? [] : ["orig"];
  return tracksOf(opts);
}

/** The file names an export would write — NO content serialized, so the export panel can
 *  show them in a render path (generateExports rendered the whole document per repaint). */
export function exportFileNames(
  opts: ExportOptions,
  result?: Pick<BatchResult, "language" | "timedTracks">,
): ((stem: string) => string)[] {
  return exportFileGroups(opts, result).map((g) => g.name);
}

export function exportStemSuffix(tracks?: string[]): string {
  if (!tracks || tracks.includes("orig")) return "";
  const langs = tracks.filter((t) => t !== "orig");
  if (!langs.length) return "";
  // A multi-target export used to return "" here, so the file name carried no
  // language at all -- the one case where naming matters MOST, since the file
  // holds several. Bounded: these codes are user-authored and land in a path.
  const slugs = langs.map((c) => codeSlug(c)).filter(Boolean).slice(0, 4);
  return slugs.length ? "." + slugs.join("+") : "";
}

/** Subtitles that read faster than their language's limit (limitsFor; 20
 *  chars/sec without cue options), over the cues the export writes — the
 *  original included. Flagged, never reflowed. `index` = source segment. */
export function cpsWarnings(
  result: BatchResult,
  opts: Omit<ExportOptions, "format">,
): { lang: string; index: number; cps: number }[] {
  // Synthesized 1 s clocks (plain-text source) would flag every line over 20 chars.
  if (result.timingSynthesized) return [];
  const tracks = opts.tracks?.length ? opts.tracks : ["orig"];
  const grid = cueGrid(result, { ...opts, format: "srt" }, tracks);
  const out: { lang: string; index: number; cps: number }[] = [];
  for (const track of tracks) {
    const limit = trackLimits(result, opts.cues, track)?.cps ?? TRANSCRIBED_CPS;
    // Kept-original lines are never exported — trackCues never yields them.
    for (const c of trackCues(grid, track)) {
      const dur = c.end - c.start;
      if (dur <= 0) continue;
      const cps = c.text.length / dur;
      if (cps > limit) out.push({ lang: track, index: c.seg, cps: Math.round(cps * 10) / 10 });
    }
  }
  return out;
}
