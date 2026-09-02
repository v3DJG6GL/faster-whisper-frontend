// Pure transcript-export generators (TXT / SRT / VTT / LRC / JSON) for the
// Transcribe screen. No Tauri imports — runs (and is unit-tested) in plain
// node. Every string that reaches an output file passes stripControlChars:
// segment/word text is server-controlled and speaker names are user-typed,
// and both end up in files that get opened elsewhere.

import { stripControlChars } from "./sanitize";
import { segmentWordRanges } from "./wordAlign";
import type { BatchResult, TranscriptSegment } from "./types";

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
  /** Language tracks to include: "orig" + target codes. Undefined = original
   *  only, exactly the pre-translation output (golden-stable). For LRC with
   *  more than one track use generateExports — one FILE per track. */
  tracks?: string[];
  /** Multi-track cue layout: which line comes first (default orig-first). */
  lineOrder?: "orig-first" | "trans-first";
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
}

/** A segment's translation for one track, cleaned; null when absent — or when
 *  the server's quality guard KEPT the source text for this target (emitting
 *  it as a translated line would duplicate the original). */
function trOf(seg: TranscriptSegment, lang: string): string | null {
  if (seg.translationsKept?.includes(lang)) return null;
  const t = seg.translations?.[lang];
  return t?.trim() ? clean(t) : null;
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
  const safe = lang.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12);
  return safe || "x";
}

/** Cue text lines for one segment across the included tracks, in lineOrder.
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
  const trLines: string[] = [];
  for (const lang of ctx.visLangs) {
    const t = trOf(seg, lang);
    if (t !== null) trLines.push(mt(t, seg, lang));
  }
  const origLines = ctx.origIncluded ? [orig] : [];
  return ctx.opts.lineOrder === "trans-first"
    ? [...trLines, ...origLines]
    : [...origLines, ...trLines];
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
    // indented line per included translated track).
    return (
      result.segments
        .flatMap((seg) => {
          const prefix = seg.speaker && ctx.names ? `${nameOf(ctx, seg.speaker)}: ` : "";
          return cueLines(
            ctx,
            seg,
            `[${txtTime(seg.start)}] ${prefix}${clean(seg.text)}`,
            // The time moves onto the translated line when the original is hidden — a
            // translations-only TXT with Timestamps on otherwise had no time at all.
            (t, s, lang) =>
              `${ctx.origIncluded ? "        " : `[${txtTime(s.start)}] `}${ambiguous(ctx) ? `[${lang.toUpperCase()}] ` : ""}${prefix}${t}`,
          );
        })
        .join("\n") + "\n"
    );
  }
  if (ctx.visLangs.length && result.segments?.length) {
    // Interleaved paragraphs per speaker turn, included tracks in order.
    const paras: string[] = [];
    let who: string | null = null;
    let bufs: string[][] = [];
    const trackCount = (ctx.origIncluded ? 1 : 0) + ctx.visLangs.length;
    // Which language each buffer slot holds, so a paragraph can say what it
    // is. Without this every track produced an identically-prefixed paragraph
    // and a reader had only paragraph ORDER to go on.
    const slotLangs: (string | null)[] = [
      ...(ctx.opts.lineOrder !== "trans-first" && ctx.origIncluded ? [null] : []),
      ...ctx.visLangs,
      ...(ctx.opts.lineOrder === "trans-first" && ctx.origIncluded ? [null] : []),
    ];
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
      let slot = 0;
      if (ctx.opts.lineOrder !== "trans-first" && ctx.origIncluded) {
        bufs[slot++].push(clean(seg.text));
      }
      for (const lang of ctx.visLangs) {
        const t = trOf(seg, lang);
        if (t) bufs[slot].push(t);
        slot++;
      }
      if (ctx.opts.lineOrder === "trans-first" && ctx.origIncluded) {
        bufs[slot].push(clean(seg.text));
      }
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

function srtLine(ctx: Ctx, seg: TranscriptSegment): string {
  return srtStyled(ctx, seg, clean(seg.text));
}

function srtMtLine(ctx: Ctx, text: string, seg: TranscriptSegment, lang: string): string {
  // SRT has no class mechanism, so an ambiguous file tags in the text itself.
  // Prefixed rather than appended: a player truncating a long cue must not be
  // able to cut off the only thing identifying the language.
  const tagged = ambiguous(ctx) ? `[${lang.toUpperCase()}] ${text}` : text;
  return srtStyled(ctx, seg, tagged);
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
    const text = vttEscape(clean(seg.text));
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
      const escaped = vttEscape(t);
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
      language: result.language ?? null,
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
              model: result.translation.model ?? null,
              targets: result.translation.targets,
              source: result.translation.source ?? null,
              ...(result.translation.mode ? { mode: result.translation.mode } : {}),
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
    },
    null,
    2,
  ) + "\n";
}

/** Render `result` in the requested format. Pure — safe to golden-test. */
export function generateExport(result: BatchResult, opts: ExportOptions): string {
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
  const visLangs =
    opts.format === "json" ? [] : (opts.tracks?.filter((t) => t !== "orig") ?? []);
  return {
    opts,
    order,
    hasSpeakers: order.length > 0,
    names: order.length > 0 && opts.speakerNames !== false,
    visLangs,
    origIncluded: !opts.tracks || opts.tracks.includes("orig"),
  };
}

/** Like generateExport, but multi-file where the format demands it: LRC with
 *  several tracks = one FILE per track (duplicate-timestamp bilingual LRC
 *  renders unreliably across players). `name(stem)` appends the track suffix. */
export function generateExports(
  result: BatchResult,
  opts: ExportOptions,
): { name: (stem: string) => string; content: string }[] {
  const ctx = ctxOf(result, opts);
  const tracks = exportTrackList(opts);
  const names = exportFileNames(opts);
  if (opts.format === "lrc" && tracks.length > 1) {
    return tracks.map((track, i) => ({ name: names[i], content: lrcExport(result, ctx, track) }));
  }
  return [{ name: names[0], content: generateExport(result, opts) }];
}

/** The tracks an export writes, in file order — the same list `generateExports` walks. */
function exportTrackList(opts: ExportOptions): string[] {
  const visLangs = opts.format === "json" ? [] : (opts.tracks?.filter((t) => t !== "orig") ?? []);
  return [...(!opts.tracks || opts.tracks.includes("orig") ? ["orig"] : []), ...visLangs];
}

/** The file names an export would write — NO content serialized, so the export panel can
 *  show them in a render path (generateExports rendered the whole document per repaint).
 *  Names depend only on format + tracks. */
export function exportFileNames(opts: ExportOptions): ((stem: string) => string)[] {
  const tracks = exportTrackList(opts);
  if (opts.format === "lrc" && tracks.length > 1) {
    return tracks.map(
      (track, i) => (stem: string) =>
        // Positional fallback for a code whose slug is empty ("!!"): an empty suffix collided
        // with the "orig" file and every such track overwrote the one before it.
        track === "orig" ? `${stem}.lrc` : `${stem}.${trackSlug(track) || `t${i}`}.lrc`,
    );
  }
  return [(stem: string) => `${stem}${exportStemSuffix(opts.tracks)}.${EXPORT_EXTENSIONS[opts.format]}`];
}

/** ".de" when exactly one translated track (and not the original) is picked —
 *  so single-language exports name themselves; "" otherwise. */
/** Track codes reach a filename (the stem suffix and the per-track LRC name); they come
 *  from server-advertised / peer-synced settings, so keep them to path-safe characters. */
const trackSlug = (c: string) => c.replace(/[^A-Za-z0-9-]/g, "");

export function exportStemSuffix(tracks?: string[]): string {
  if (!tracks || tracks.includes("orig")) return "";
  const langs = tracks.filter((t) => t !== "orig");
  if (!langs.length) return "";
  // A multi-target export used to return "" here, so the file name carried no
  // language at all -- the one case where naming matters MOST, since the file
  // holds several. Bounded: these codes are user-authored and land in a path.
  const slugs = langs.map(trackSlug).filter(Boolean).slice(0, 4);
  return slugs.length ? "." + slugs.join("+") : "";
}

/** Translated cue lines that exceed the 20 chars/sec subtitle reading-speed
 *  norm (DE/FR expand 10–30% over EN — flag, never auto-reflow). */
export function cpsWarnings(
  result: BatchResult,
  tracks?: string[],
): { lang: string; index: number; cps: number }[] {
  const langs = (tracks ?? []).filter((t) => t !== "orig");
  const out: { lang: string; index: number; cps: number }[] = [];
  (result.segments ?? []).forEach((seg, index) => {
    const dur = seg.end - seg.start;
    if (dur <= 0) return;
    for (const lang of langs) {
      // Kept-original lines are never exported — don't warn about them.
      if (seg.translationsKept?.includes(lang)) continue;
      const t = seg.translations?.[lang];
      if (!t?.trim()) continue;
      const cps = t.trim().length / dur;
      if (cps > 20) out.push({ lang, index, cps: Math.round(cps * 10) / 10 });
    }
  });
  return out;
}
