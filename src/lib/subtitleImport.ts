// Parsers for text/subtitle sources (SRT / VTT / LRC / plain text / our own
// JSON export) — the inverse of transcriptExport, reduced to what a
// translate-only run needs: ordered segments with optional timing/speaker.
// Pure, no Tauri imports; unit-tested round-trip against generateExport.

import { safeDisplayText, stripControlChars } from "./sanitize";

export interface ImportedText {
  segments: { start?: number; end?: number; text: string; speaker?: string }[];
  /** Source language when the file declares one (our JSON export does). */
  language?: string;
}

export const TEXT_SOURCE_EXTS = ["srt", "vtt", "lrc", "txt", "json"] as const;
/** The audio/video containers the file picker accepts — ONE list for the picker's dialog
 *  filter and the drag-and-drop accept test, which used to carry separate copies. */
export const AUDIO_SOURCE_EXTS = ["wav", "mp3", "m4a", "mp4", "aac", "ogg", "opus", "webm", "flac"] as const;
export const ACCEPTED_EXTS: readonly string[] = [...AUDIO_SOURCE_EXTS, ...TEXT_SOURCE_EXTS];

/** Is this something the Transcribe screen accepts (dropped or picked)? */
export function isAcceptedSourcePath(path: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return !!m && ACCEPTED_EXTS.includes(m[1].toLowerCase());
}

/** Is this path a text/subtitle source (vs audio/video)? Extension test only —
 *  the pickers filter, this guards drops and retries. */
export function isTextSourcePath(path: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return !!m && (TEXT_SOURCE_EXTS as readonly string[]).includes(m[1].toLowerCase());
}

/** Parse `content` by extension. Throws with a user-facing message when the
 *  file yields no segments. */
export function parseImportedText(ext: string, content: string): ImportedText {
  const body = stripControlChars(content); // drops a BOM too (isDeceptiveFormatChar)
  let out: ImportedText;
  switch (ext.toLowerCase()) {
    case "srt":
      out = parseSrt(body);
      break;
    case "vtt":
      out = parseVtt(body);
      break;
    case "lrc":
      out = parseLrc(body);
      break;
    case "json":
      out = parseJsonExport(body);
      break;
    default:
      out = parsePlainText(body);
  }
  if (!out.segments.length) {
    throw new Error("No text found in this file — is it empty or a different format?");
  }
  return out;
}

/** "01:02:03,450" / "01:02:03.450" / "02:03.450" / "02:03" → seconds. */
function parseClock(s: string): number | undefined {
  const m = /^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return undefined;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const frac = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) / 1000 : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac;
}

/** Strip markup a cue line may carry and split a leading "Name:" speaker. */
function cueText(lines: string[]): { text: string; speaker?: string } {
  const joined = lines
    .join(" ")
    .replace(/<[^>\n]{0,64}>/g, "") // <font>/<c.x>/<i>/inline word tags
    .replace(/\{\\[^}]{0,64}\}/g, "") // ASS-style override blocks
    .replace(/\s+/g, " ")
    .trim();
  const m = /^([^:\n]{1,40}):\s+(.*)$/.exec(joined);
  // A leading "Name: " prefix becomes the speaker — but never a clock-like
  // token ("12:30 lunch") or a URL scheme.
  if (m && !/^\d+$/.test(m[1].trim()) && !/^(https?|file)$/i.test(m[1].trim())) {
    return { text: m[2], speaker: m[1].trim() };
  }
  return { text: joined };
}

function parseSrt(body: string): ImportedText {
  const segments: ImportedText["segments"] = [];
  for (const block of body.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim().length);
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1; // cue number
    const times = /^(.+?)\s+--&?>\s+(.+?)(?:\s+.*)?$/.exec(lines[i] ?? "");
    if (!times) continue;
    const start = parseClock(times[1]);
    const end = parseClock(times[2]);
    const { text, speaker } = cueText(lines.slice(i + 1));
    if (text) segments.push({ start, end, text, speaker });
  }
  return { segments };
}

function parseVtt(body: string): ImportedText {
  const segments: ImportedText["segments"] = [];
  const blocks = body.split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim().length);
    if (!lines.length) continue;
    const first = lines[0].trim();
    if (first === "STYLE" || first === "NOTE" || first === "REGION") continue;
    if (/^WEBVTT/.test(first)) {
      lines.shift();
      if (!lines.length) continue;
    }
    let i = lines.findIndex((l) => l.includes("-->"));
    if (i === -1) continue;
    const times = /^(.+?)\s+--&?>\s+(.+?)(?:\s+.*)?$/.exec(lines[i]);
    if (!times) continue;
    const start = parseClock(times[1]);
    const end = parseClock(times[2]);
    // <v Name>text</v> carries the speaker; cueText handles the rest.
    const raw = lines.slice(i + 1).join(" ");
    const v = /^<v\s+([^>]{1,40})>([\s\S]*?)(?:<\/v>)?$/.exec(raw.trim());
    if (v) {
      const text = v[2].replace(/<[^>\n]{0,64}>/g, "").replace(/\{\\[^}]{0,64}\}/g, "").replace(/\s+/g, " ").trim();
      if (text) segments.push({ start, end, text, speaker: v[1].trim() });
    } else {
      const { text, speaker } = cueText(lines.slice(i + 1));
      if (text) segments.push({ start, end, text, speaker });
    }
  }
  return { segments };
}

function parseLrc(body: string): ImportedText {
  const segments: ImportedText["segments"] = [];
  const tagRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Match all leading [mm:ss.xx] timestamp tags. LRC's most common compression
    // repeats a chorus line under several timestamps: [00:12.00][00:45.00]text.
    // Each tag produces its own segment sharing the same text.
    tagRe.lastIndex = 0;
    const starts: number[] = [];
    let lastTagEnd = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(trimmed)) !== null) {
      if (tm.index !== lastTagEnd) break; // non-tag text interrupted
      starts.push(parseInt(tm[1], 10) * 60 + parseFloat(tm[2]));
      lastTagEnd = tagRe.lastIndex;
    }
    if (starts.length === 0) continue; // metadata tags ([ti:…]) and blanks
    // Enhanced-LRC inline <mm:ss.xx> word tags reduce to plain text.
    const { text, speaker } = cueText([trimmed.slice(lastTagEnd).replace(/<\d+:\d+(?:\.\d+)?>/g, " ")]);
    if (text) {
      for (const start of starts) segments.push({ start, text, speaker });
    }
  }
  // Multi-tag lines scatter segments out of source order — sort by time.
  segments.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  // Ends: next segment's start (open-ended last line stays end-less).
  for (let i = 0; i < segments.length - 1; i++) segments[i].end = segments[i + 1].start;
  return { segments };
}

function parsePlainText(body: string): ImportedText {
  // Paragraphs (blank-line separated) become segments; single-paragraph
  // files fall back to one segment per line.
  const paras = body
    .split(/\r?\n\r?\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const parts =
    paras.length > 1
      ? paras
      : body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
  return { segments: parts.map((text) => ({ text })) };
}

/** Our own JSON export (and near shapes): {segments:[{start,end,text,…}]}. */
function parseJsonExport(body: string): ImportedText {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Not valid JSON — export files from this app parse; other JSON may not.");
  }
  const obj = parsed as {
    language?: unknown;
    segments?: unknown;
    text?: unknown;
  };
  const segments: ImportedText["segments"] = [];
  if (Array.isArray(obj.segments)) {
    for (const s of obj.segments) {
      if (typeof s !== "object" || s === null) continue;
      const seg = s as Record<string, unknown>;
      const text = typeof seg.text === "string" ? seg.text.trim() : "";
      if (!text) continue;
      segments.push({
        text,
        start: typeof seg.start === "number" ? seg.start : undefined,
        end: typeof seg.end === "number" ? seg.end : undefined,
        speaker:
          typeof seg.speakerName === "string"
            ? seg.speakerName
            : typeof seg.speaker === "string"
              ? seg.speaker
              : undefined,
      });
    }
  }
  if (segments.length === 0 && typeof obj.text === "string" && obj.text.trim()) {
    const plain = parsePlainText(obj.text);
    if (typeof obj.language === "string" && obj.language.trim()) {
      (plain as { language?: string }).language = safeDisplayText(obj.language, 64) || undefined;
    }
    return plain;
  }
  return {
    segments,
    // Bounded like Rust bounds a server's `language` (LANGUAGE_MAX = 64): this one comes
    // from a locally parsed file and otherwise reached the meta line and track chips raw.
    language: typeof obj.language === "string" ? safeDisplayText(obj.language, 64) || undefined : undefined,
  };
}
