// Parsers for text/subtitle sources (SRT / VTT / LRC / plain text / our own
// JSON export) — the inverse of transcriptFormats, reduced to what a
// translate-only run and a link's site subtitles need: ordered segments with
// optional timing/speaker. Pure, no Tauri imports; unit-tested round-trip
// against generateExport.

import { languageCodeOf } from "../languages";
import { safeDisplayText, stripControlChars } from "../sanitize";
import { cjkWrapsLines, edgeChar, joinLineBreaks, unspacedChar, wrapSeamUnspaced } from "./cueSplit";

export interface ImportedText {
  segments: { start?: number; end?: number; text: string; speaker?: string }[];
  /** Source language when the file declares one (our JSON export does). */
  language?: string;
}

export const TEXT_SOURCE_EXTS = ["srt", "vtt", "lrc", "txt", "json"] as const;
/** The audio/video containers the file picker accepts — ONE list for the picker's dialog
 *  filter and the drag-and-drop accept test. */
export const AUDIO_SOURCE_EXTS = ["wav", "mp3", "m4a", "mp4", "aac", "ogg", "opus", "webm", "flac", "mkv", "mov", "m4v"] as const;
export const ACCEPTED_EXTS: readonly string[] = [...AUDIO_SOURCE_EXTS, ...TEXT_SOURCE_EXTS];

/** A native dialog filter's extensions in both spellings: the Linux GTK3 dialog matches
 *  `*.mp4` case-sensitively, so a camera's `MVI_0042.MOV` would be hidden from the picker
 *  while a drop of the same file is accepted. Windows and the portal ignore case anyway. */
export function dialogFilterExts(exts: readonly string[]): string[] {
  return exts.flatMap((e) => [e, e.toUpperCase()]);
}

/** Is this something the Transcribe screen accepts (dropped or picked)? */
export function isAcceptedSourcePath(path: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return !!m && ACCEPTED_EXTS.includes(m[1].toLowerCase());
}

/** Is this path a text/subtitle source (vs audio/video)? Extension test only. */
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

/** Character references a cue may carry (WebVTT allows all HTML ones; sites send
 *  `&nbsp;`, `&amp;`, `&#39;`). Unknown names stay as written. */
const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", lrm: "\u200E", rlm: "\u200F",
};

/** A file-authored speaker name's cap in code points — the viewer's rename cap (viewerKit's SPEAKER_NAME_MAX). */
const SPEAKER_NAME_MAX = 40;
/** A leading "Name: " — see speakerPrefix. */
const SPEAKER_PREFIX = new RegExp(String.raw`^([^:\n]{1,${SPEAKER_NAME_MAX}}):\s+`, "u");

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, ref: string) => {
    if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? m;
    const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** Cue text without markup: tags (`<font>`, `<c.x>`, `<i>`, inline word tags) and ASS
 *  override blocks go, then character references decode (after, so `&lt;i&gt;` stays text),
 *  whitespace collapses. The decode runs after parseImportedText's control-char pass, so
 *  `&#x202E;` / `&#27;` would mint the very characters that pass dropped — strip again. */
function stripMarkup(s: string): string {
  return stripControlChars(decodeEntities(bareLine(s)))
    .replace(/\s+/g, " ")
    .trim();
}

/** A `<v Name>` voice tag's name: references decoded, then bounded and sanitized like any
 *  file-authored label (the decode can produce control/bidi characters). */
function voiceName(raw: string): string {
  return safeDisplayText(decodeEntities(raw), SPEAKER_NAME_MAX).replace(/\s+/g, " ").trim();
}

/** A cue's (or paragraph's) lines as one: one space between two lines, or none at an unspaced
 *  seam (`wrapSeamUnspaced`) when the file wraps its CJK lines (`cjkWrapsLines`). Joined before the
 *  markup goes, so a tag split over two lines still strips; its edges are judged without tags. */
function joinLines(lines: string[], wraps: boolean): string {
  if (!wraps) return lines.join(" ");
  // Each seam judged from the previous line's own end (its last line with text, tags aside),
  // never by re-scanning what is joined so far: a paragraph of every line in a file stays linear.
  const parts: string[] = [];
  let prev = "";
  for (const l of lines) {
    const b = bareLine(l);
    if (parts.length === 0) parts.push(l);
    else if (!b.trim()) {
      // A tag-only line ("<i>" alone) is no seam: the next line with text decides it.
      parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
      parts.push(l.trim());
      continue;
    } else if (wrapSeamUnspaced(prev, b.trimStart())) {
      parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
      parts.push(l.trimStart());
    } else parts.push(" ", l);
    const t = b.trimEnd();
    if (t) prev = t;
  }
  return parts.join("");
}

/** A subtitle tag: a known name, then what that name can carry. Only `<v Name>` (as long as
 *  the voice regexes read it), `<lang en>`, `<font color=…>` and `<span class=…>` take a
 *  space-separated annotation; the rest take a `.class` list (`<c.mt>`), `name=value`
 *  attributes (an HTML/TTML conversion's `<i class="x">`) and a self-close (`<br />`) — never a
 *  bare word, so "if a<b and c>d" or "x <i and y> z" is text, not a tag. */
const MARKUP_TAG = new RegExp(
  [
    String.raw`<\/?v(?=[\s.>/])[^<>\n]{0,200}>`,
    String.raw`<\/?(?:lang|font|span)(?=[\s.>/])[^<>\n]{0,64}>`,
    String.raw`<\/?(?:b|i|u|s|c|ruby|rt|rb|rp|br|em|strong|sub|sup)(?:\.[^\s<>]{1,64})?` +
      String.raw`(?:[^\S\n]+[a-z][\w:-]{0,31}=(?:"[^"<>\n]{0,64}"|'[^'<>\n]{0,64}'|[^\s<>"']{1,64})){0,8}[^\S\n]*\/?>`,
  ].join("|"),
  "gi",
);

/** A cue line without its tags and ASS override blocks — what a seam or the file's wrap
 *  decision (`cjkWrapsLines`) judges. Only real subtitle markup goes (the known tag names,
 *  with attributes or classes, and inline timestamps): our SRT/LRC export writes the text
 *  raw, so "x<5 and y>3" or "<Enter>" is the line's own text and must survive a re-import. */
function bareLine(s: string): string {
  return s
    .replace(MARKUP_TAG, "")
    .replace(/<\d+:\d+(?::\d+)?(?:\.\d+)?>/g, "")
    .replace(/\{\\[^}]{0,64}\}/g, "");
}

/** Raw cues → segments, deciding once for the file whether its CJK line breaks are wraps
 *  (judged on the cue text only: no cue numbers, times, NOTE or STYLE blocks), on the text the
 *  segments keep: each voice span is a line of its own (the blank between two spans is no
 *  phrase space), and a cue's first line goes without the "Name: " prefix cueText splits off as
 *  the speaker (our export writes one on every cue; its colon would hide the line's marks) —
 *  when that name opens at least two cues saying different things. A speaker recurs; a credit
 *  field ("翻译: 小明。", "校对: 小刚") is written once, or repeated verbatim at the start and the
 *  end, so it is judged whole and its colon keeps discounting its marks — with the blanks inside
 *  its name squeezed out, so a one-off "山田 太郎: " is no phrase space. Colons inside the text (a
 *  quotation, a time) do not decide it. */
function cuesOf(cues: RawCue[]): ImportedText {
  const seen = new Map<string, Set<string>>();
  for (const c of cues) {
    const first = c.lines[0];
    if (first === undefined || /^\s*<v[\s.]/.test(first)) continue;
    const b = bareLine(first).trimStart();
    const m = speakerPrefix(b);
    if (!m) continue;
    const name = m[1].trim();
    const says = seen.get(name) ?? new Set<string>();
    // Two distinct lines are all the rule needs: stop collecting there.
    if (says.size < 2) says.add(b.slice(m[0].length) + "\n" + c.lines.slice(1).join("\n"));
    seen.set(name, says);
  }
  const judged = cues.flatMap((c) =>
    c.lines.flatMap((l, i) =>
      // Split at a blank run's first character only, so a long run is scanned once.
      l.split(/(?<!\s)\s*(?=<v[\s.])/).map((part, k) => {
        const b = bareLine(part);
        if (i > 0 || k > 0 || /^\s*<v[\s.]/.test(part)) return b;
        const s = b.trimStart();
        const m = speakerPrefix(s);
        if (!m) return b;
        const rest = s.slice(m[0].length);
        return (seen.get(m[1].trim())?.size ?? 0) >= 2 ? rest : `${m[1].replace(/\s+/g, "")}: ${rest}`;
      }),
    ),
  );
  return cuesToSegments(cues, cjkWrapsLines(judged));
}

/** A leading "Name: " prefix — the speaker cueText splits off — but never a clock-like token
 *  ("12: 30 lunch") or a URL scheme. Its 40 counts code points, as the rename cap does, so a
 *  name with emoji or rare CJK characters still re-imports. */
function speakerPrefix(s: string): RegExpExecArray | null {
  const m = SPEAKER_PREFIX.exec(s);
  return m && !/^\d+$/.test(m[1].trim()) && !/^(https?|file)$/i.test(m[1].trim()) ? m : null;
}

/** Strip markup a cue's (already joined) text may carry and split a leading "Name:" speaker. */
function cueText(text: string): { text: string; speaker?: string } {
  const joined = stripMarkup(text);
  const m = speakerPrefix(joined);
  return m ? { text: joined.slice(m[0].length), speaker: m[1].trim() } : { text: joined };
}

/** One subtitle cue before cleanup: its clock and its raw text lines (markup intact). */
export interface RawCue {
  start?: number;
  end?: number;
  lines: string[];
}

/** YouTube's auto captions "roll": every cue repeats the previous cue's last line above its
 *  new one, and a 10 ms cue freezes the text between them — imported raw that is every line
 *  two or three times. In a file where such a freeze cue bridges a roll: drop each ≤100 ms
 *  cue that only repeats a neighbour, strip the leading lines a contiguous cue repeats from
 *  the cue before, and extend that cue when nothing new is left. Broadcast roll-up captions
 *  have no freeze cue but open most multi-line cues with the line(s) before; such a file gets
 *  the leading-line strip only. Ordinary files keep their repeats — "Thank you." twice back to
 *  back, a word said at the end of one cue and the start of the next, and a short cue with
 *  text of its own (our own exports keep a zero-length segment, even one repeating its
 *  neighbour); only an empty cue goes, in every file. */
export function dedupeRollingCues(cues: RawCue[]): RawCue[] {
  const out: RawCue[] = [];
  // Compared against the neighbours' RAW lines: `out` may already have lost the repeat.
  const repeatsNeighbour = (i: number): boolean => {
    const have = new Set([...(cues[i - 1]?.lines ?? []), ...(cues[i + 1]?.lines ?? [])].map(stripMarkup));
    return cues[i].lines.map(stripMarkup).every((l) => !l || have.has(l));
  };
  // The 1e-6 slack: a cue of exactly 100 ms parses to a float difference a hair either side
  // of 0.1 (1.1 − 1 > 0.1, 3723.5 − 3723.4 < 0.1), so it would count only by its position.
  const isFreeze = (c: RawCue, i: number): boolean =>
    c.start !== undefined && c.end !== undefined && c.end - c.start <= 0.1 + 1e-6 && repeatsNeighbour(i);
  /** How many leading lines of `lines` repeat the last lines of `before` (markup-free and
   *  whitespace-collapsed): 1 for a two-line roll-up, 2 for a three-line one. */
  const leadOverlap = (before: string[], lines: string[]): number => {
    const mine = lines.map(stripMarkup);
    const theirs = before.map(stripMarkup);
    let k = Math.min(mine.length, theirs.length);
    while (k > 0 && theirs.slice(-k).join("\n") !== mine.slice(0, k).join("\n")) k--;
    return k;
  };
  const hasText = (c: RawCue): boolean => c.lines.some((l) => stripMarkup(l));
  const textLines = (c: RawCue): string[] => c.lines.filter((l) => stripMarkup(l));
  const contiguousAfter = (prev: RawCue, cue: RawCue): boolean =>
    prev.start !== undefined && prev.end !== undefined && cue.start !== undefined
    && cue.start >= prev.start && cue.start <= prev.end + 0.25;
  // The rolling signature: without a freeze cue, a cue that only repeats the one before
  // is a line said twice, not a roll.
  // Only a freeze cue with text and a length counts: an empty cue (our export writes one for
  // an empty segment) "repeats" its neighbours vacuously, and a zero-length repeat is our
  // own export's segment, not a 10 ms freeze — either would make any file look rolling.
  // And only one that bridges a roll: a real freeze repeats the last line(s) of the cue with
  // text before it AND the next cue with text, right after it, opens with them and adds a
  // line. A Whisper repeat (a doubled or tripled 50 ms "Thank you.") adds nothing, a short
  // fragment that only opens the next cue repeats nothing before it, and a cue far later is
  // no roll — counting any of them would strip every line the file repeats across a cue
  // boundary. One bridge is enough: a short auto-caption file may roll only once.
  const bridgesRoll = (i: number): boolean => {
    // Index scans, not slices: a Whisper tail of thousands of short repeats asks for each.
    let b = i - 1;
    while (b >= 0 && !hasText(cues[b])) b--;
    let n = i + 1;
    while (n < cues.length && !hasText(cues[n])) n++;
    if (b < 0 || n >= cues.length || !contiguousAfter(cues[i], cues[n])) return false;
    const [before, mine, after] = [textLines(cues[b]), textLines(cues[i]), textLines(cues[n])];
    return leadOverlap(before, mine) === mine.length
      && after.length > mine.length && leadOverlap(mine, after) === mine.length;
  };
  const rolling = cues.some((c, i) => isFreeze(c, i) && c.end! > c.start! && hasText(c) && bridgesRoll(i));
  // The roll-up signature, judged on the whole file: one cue cannot tell a roll from a word
  // said twice across a cue boundary, but in a roll-up file MOST contiguous multi-line cues
  // open with the line(s) before, and in an ordinary file only the odd one does. A three-
  // line roll-up repeats the cue's last TWO lines, so its first line is never the last one.
  let multi = 0;
  let opensWithPrev = 0;
  const texted = cues.filter(hasText);
  for (let i = 1; i < texted.length; i++) {
    const [prev, cue] = [texted[i - 1], texted[i]];
    if (cue.lines.length < 2 || !contiguousAfter(prev, cue)) continue;
    multi++;
    // A roll adds a line: a cue that repeats the one before WHOLE (a sung chorus, a held
    // caption) is no roll evidence — the strip below never removes it in an ordinary file.
    const k = leadOverlap(prev.lines, cue.lines);
    if (k > 0 && k < cue.lines.length) opensWithPrev++;
  }
  // At least three such cues: one or two cannot tell a short roll-up from a short ordinary
  // file whose line is repeated across a cue boundary ("Wait." / "Wait. Did you hear that?"),
  // and stripping that line loses words the file really holds.
  const rollUp = rolling || (opensWithPrev >= 3 && opensWithPrev * 2 > multi);
  // The RAW lines of the last cue kept: its stripped `out` entry has lost the lines it
  // repeated, and a three-line roll repeats those too ([1,2,3] → [2,3,4]).
  let prevRaw: string[] = [];
  for (const [i, cue] of cues.entries()) {
    // A text-less cue goes in every file: it yields no segment, and kept it would stretch
    // the line before it through its silence (or, in a rolling file, become the baseline the
    // next cue's repeat is checked against).
    if (!hasText(cue) || (rolling && isFreeze(cue, i))) continue;
    const prev = out[out.length - 1];
    let lines = cue.lines;
    if (prev && rollUp && contiguousAfter(prev, cue)) {
      let k = leadOverlap(prevRaw, lines);
      if (k === lines.length && !rolling) k = 0;
      if (k === lines.length) {
        if (cue.end !== undefined) prev.end = Math.max(prev.end ?? cue.end, cue.end);
        continue;
      }
      lines = lines.slice(k);
    }
    prevRaw = cue.lines;
    out.push({ ...cue, lines });
  }
  return out;
}

/** "Ein- und Ausgang" keeps its hyphen: the next line opens with a conjunction. Not "to",
 *  "nor", "et" or "wie": those are also a word's last syllable ("toma-" / "to", "mi-" / "nor",
 *  "qui-" / "et", "so-" / "wie"). */
const KEEPS_HYPHEN = /^(?:und|oder|bis|bzw\.|sowie|and|or|ou|vs\.?)(?![\p{L}\p{N}])/iu;
/** A line that is never a hyphenated word's second half, whatever its markup-free text: a
 *  `<v Name>` voice tag opens a new turn ("I was going to-" / "<v Bob>what?" is an interruption),
 *  and our VTT export's `.mt` class marks a translation line under its original. */
const NEW_TURN_LINE = /^<v[\s.]|<c\.mt[\s.>]/;
/** Our VTT export's `.mt` translation span opening. */
const MT_OPEN = /<c\.mt[\s.>]/;
/** One piece of bareLine's markup: a tag, an inline timestamp, an ASS override block. */
const MARKUP_PIECE = String.raw`${MARKUP_TAG.source}|<\d+:\d+(?::\d+)?(?:\.\d+)?>|\{\\[^}]{0,64}\}`;
/** A line's last hyphen and the markup after it: a line wrapped in its own tag (`<i>journa-</i>`)
 *  ends on the tag, not on the hyphen. Each piece is matched atomically (a lookahead, then its
 *  backreference — MARKUP_PIECE has no groups of its own, so it is `\2`): a tag like
 *  `<br class=x/>` parses two ways (the `/` in the value or the self-close), and a line of N such
 *  tags whose tail then fails `$` (" b-" after them) backtracked through all 2^N parses. Every
 *  parse of a piece ends on the same `>` or `}`, so the atomic match takes the same text. */
const HYPHEN_THEN_MARKUP = new RegExp(String.raw`-((?:(?=(${MARKUP_PIECE}))\2|\s)*)$`, "iu");
/** The markup of that tail, or a blank between its pieces ("$1" drops the blank). */
const MARKUP_OR_BLANK = new RegExp(String.raw`(${MARKUP_PIECE})|\s+`, "giu");
/** Three or more single cased letters spaced apart ("m i t") — broadcaster emphasis. */
const LETTER_SPACED = /(?<![\p{L}\p{N}])(?:[\p{Lu}\p{Ll}] ){2,}[\p{Lu}\p{Ll}](?![\p{L}\p{N}])/gu;
/** A tag or a letter-spaced run: the cue lines still hold their markup, and a tag's name is
 *  not a letter — `<v A J Smith>` read as "v A J" glued to `<vAJ Smith>`, a tag nothing
 *  downstream recognises (the speaker lost, the tag left in the text). */
const TAG_OR_LETTER_SPACED = new RegExp(`${MARKUP_TAG.source}|${LETTER_SPACED.source}`, "giu");
/** One-letter words per language ("Il y a à boire", Polish "a w z", Russian "А я в"): a
 *  run whose letters are ALL words of ONE language is ordinary text, not emphasis, and must
 *  not be glued — Slavic speech strings them three in a row all the time, the particles
 *  б (бы) and ж (же) included ("Я б в лётчики пошёл"). Pooling the sets would let letters
 *  from different languages pass as words and leave German "w i e" / "z w e i" spaced. */
const ONE_LETTER_WORDS = [
  /^[aàáeéèioóuy]$/iu, // Romance
  /^[aiouwz]$/iu, // Polish
  /^[aikosuvz]$/iu, // Czech / Slovak
  /^[абвжикосуя]$/iu, // Russian
  /^[абвжзійоуїяє]$/iu, // Ukrainian
  /^[абвжзіуўя]$/iu, // Belarusian
  /^[οηή]$/iu, // Greek ("ο", "η", "ή")
];

/** Broadcaster subtitles (SRF and friends) hyphenate words across lines ("journa-" /
 *  "listische") and letter-space emphasis ("m i t"). Rejoin both so the text reads — and
 *  translates — as words. Sound tags ("[Musik]") stay. */
export function fixBroadcasterText(lines: string[]): string[] {
  const out: string[] = [];
  // Inside a `.mt` span opened on an earlier line (a wrapped translation), and whether the line
  // before closed one or a `<v Name>` voice span: a translation that ends on a cut-off ("I was
  // going to-") with the original under it (translation-first track order), or a voice turn
  // that breaks off, is a whole line, not a word's first half.
  let inMt = false;
  let prevEndsSpan = false;
  for (const raw of lines) {
    const line = raw.trim();
    const prev = out[out.length - 1];
    const mt: boolean = inMt || MT_OPEN.test(line);
    const endsMt: boolean = mt && /<\/c>$/.test(line);
    inMt = mt && !endsMt;
    // Judged on the lines without their markup: broadcaster files often wrap each line in its
    // own colour or italic tag, and the raw line then ends on "</font>", the next opens with "<font".
    const bare = bareLine(line).trimStart();
    if (prev !== undefined && !prevEndsSpan && /\p{Ll}-$/u.test(bareLine(prev).trimEnd()) && /^\p{Ll}/u.test(bare) && !KEEPS_HYPHEN.test(bare) && !NEW_TURN_LINE.test(line)) {
      out[out.length - 1] = prev.replace(HYPHEN_THEN_MARKUP, (_, tail: string) => tail.replace(MARKUP_OR_BLANK, "$1")) + line;
    } else {
      out.push(line);
    }
    prevEndsSpan = endsMt || /<\/v>$/.test(line);
  }
  return out.map((l) =>
    l.replace(TAG_OR_LETTER_SPACED, (m) =>
      m[0] === "<" || ONE_LETTER_WORDS.some((w) => m.split(" ").every((c) => w.test(c))) ? m : m.replace(/ /g, ""),
    ),
  );
}

/** The "start --> end [settings]" line of an SRT/VTT cue. The start ends only where a blank
 *  run starts (`\s` alone covers a line that opens with one): a lazy `.+?` could stop inside
 *  the run at every character, and a long run of spaces took quadratic time. */
const CUE_TIMES = /^(\s|.*?\S)\s+--&?>\s+(.+?)(?:\s+.*)?$/;

/** Raw cues → segments, after the rolling-caption and broadcaster cleanup every SRT/VTT
 *  import gets. `<v Name>` voice tags (VTT) carry the speaker; cueText handles the rest. */
function cuesToSegments(cues: RawCue[], wraps: boolean): ImportedText {
  const segments: ImportedText["segments"] = [];
  for (const { start, end, lines: raw } of dedupeRollingCues(cues)) {
    const lines = fixBroadcasterText(raw);
    const joined = joinLines(lines, wraps).trim();
    // One cue may carry a two-person exchange ("<v Alice>Hi</v> <v Bob>Hello</v>"): one
    // segment per voice span, all on the cue's clock — the single-span regex below would
    // run the lazy group to the end and credit both lines to the first voice.
    const tags = (joined.match(/<v[\s.]/g) ?? []).length;
    if (tags > 1) {
      // A dialogue dash before a voice tag ("- <v Alice>Hi</v> - <v Bob>Hello</v>") marks the
      // turn the tag already marks: dropped, or it imports as a "-" line and a trailing dash.
      // Only a dash right before a tag goes — an interrupted "I was going to—" keeps its own.
      const dj = joined.replace(/(^|\s)[-–—]\s*(?=<v[\s.])/g, "$1");
      const first = dj.search(/<v[\s.]/);
      const spans = [...dj.slice(first).matchAll(/<v(?:\.[^\s>]*)?\s+([^>]{1,200})>([\s\S]*?)(?=<v[\s.]|$)/g)];
      // A tag the span regex rejects (a name over 200 characters) would drop its text: take
      // the whole cue as plain text instead, as the single-voice path does.
      if (spans.length === tags) {
        const lead = cueText(dj.slice(0, first));
        if (lead.text) segments.push({ start, end, text: lead.text, speaker: lead.speaker });
        for (const m of spans) {
          const text = stripMarkup(m[2]);
          if (text) segments.push({ start, end, text, speaker: voiceName(m[1]) || undefined });
        }
        continue;
      }
    }
    const v = tags > 1 ? null : /^<v(?:\.[^\s>]*)?\s+([^>]{1,200})>([\s\S]*?)(?:<\/v>)?$/.exec(joined);
    if (v) {
      const text = stripMarkup(v[2]);
      if (text) segments.push({ start, end, text, speaker: voiceName(v[1]) });
    } else {
      const { text, speaker } = cueText(joined);
      if (text) segments.push({ start, end, text, speaker });
    }
  }
  return { segments };
}

/** A blank or whitespace-only line (CR is gone after stripControlChars). */
const BLANK_LINE = /\n[^\S\n]*\n\s*/;

/** An SRT/VTT body as raw cues: blank-line separated blocks, each with its
 *  "start --> end" line at `timesAt(lines)` (-1 = not a cue) and its text below.
 *  A whitespace-only line ends a cue too, but only where its own times line follows: a
 *  stray space on the separator must not merge every later cue into one, while YouTube's
 *  auto captions put " " lines inside a cue. */
function blocksToCues(body: string, timesAt: (lines: string[]) => number): RawCue[] {
  const timesOf = (lines: string[]) => {
    const i = lines.length ? timesAt(lines) : -1;
    const times = i >= 0 ? CUE_TIMES.exec(lines[i] ?? "") : null;
    return times ? { i, times } : null;
  };
  const blocks: string[][] = [];
  for (const block of body.split(/\r?\n\r?\n+/)) {
    let prev: string[] | undefined;
    for (const part of block.split(BLANK_LINE)) {
      const lines = part.split(/\r?\n/).filter((l) => l.trim().length);
      // Only a times line with real clocks starts a cue: cue text holding " --> " after a
      // " " line is text, not a cue of its own (which would lose it).
      const t = timesOf(lines);
      const real = !!t && parseClock(t.times[1]) !== undefined && parseClock(t.times[2]) !== undefined;
      if (prev && !real) prev.push(...lines);
      else blocks.push((prev = lines));
    }
  }
  const cues: RawCue[] = [];
  for (const lines of blocks) {
    const t = timesOf(lines);
    if (!t) continue;
    cues.push({ start: parseClock(t.times[1]), end: parseClock(t.times[2]), lines: lines.slice(t.i + 1) });
  }
  return cues;
}

function parseSrt(body: string): ImportedText {
  // The times follow an optional cue number.
  return cuesOf(blocksToCues(body, (lines) => (/^\d+$/.test(lines[0].trim()) ? 1 : 0)));
}

function parseVtt(body: string): ImportedText {
  // STYLE, NOTE and REGION blocks are not cues; the WEBVTT header block has no times.
  return cuesOf(blocksToCues(body, (lines) => {
    const first = lines[0].trim();
    if (first === "STYLE" || first === "NOTE" || first === "REGION") return -1;
    return lines.findIndex((l) => l.includes("-->"));
  }));
}

function parseLrc(body: string): ImportedText {
  const segments: ImportedText["segments"] = [];
  const tagRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  /** Text-less timestamp lines: LRC's end-of-line marks (an instrumental break). */
  const stops: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    // LRC's most common compression repeats a chorus line under several leading stamps
    // ([00:12.00][00:45.00]text): each stamp gets its own segment.
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
    // Enhanced-LRC inline <mm:ss.xx> word tags reduce to plain text. A line whose text
    // already holds whitespace before a tag carries its own spaces (our export writes a
    // seam's space only where the segment text has one, e.g. a spaced Thai line): every
    // tag is dropped. A tag-only line becomes a space per tag, except between two unspaced
    // (CJK) characters or CJK punctuation, so "<t>word<t>word" files elsewhere still get
    // theirs. (The export also joins every word of a whitespace-free segment, e.g. Thai or
    // CJK with digits; a tag-only line can't tell that apart from a foreign file, so those
    // gain spaces.)
    // Judged after the first word tag: a space after the line stamp or a "Name: " prefix is
    // not a seam space.
    const body = trimmed.slice(lastTagEnd);
    const firstTag = body.search(/<\d+:\d+(?:\.\d+)?>/);
    const ownSpaces = firstTag >= 0 && /\s<\d+:\d+(?:\.\d+)?>/.test(body.slice(firstTag + 1));
    const { text, speaker } = cueText(
      body.replace(/<\d+:\d+(?:\.\d+)?>/g, (m: string, off: number, s: string) =>
        ownSpaces || (unspacedChar(edgeChar(s.slice(Math.max(0, off - 8), off), true)) &&
        unspacedChar(edgeChar(s.slice(off + m.length, off + m.length + 2), false))) ? "" : " "),
    );
    if (text) {
      for (const start of starts) segments.push({ start, text, speaker });
    } else stops.push(...starts);
  }
  // Multi-tag lines scatter segments out of source order — sort by time.
  segments.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  stops.sort((a, b) => a - b);
  // Ends: the next segment's start or an earlier stop mark, whichever comes first
  // (a last line with neither stays end-less).
  for (let i = 0, k = 0; i < segments.length; i++) {
    const start = segments[i].start ?? 0;
    while (k < stops.length && stops[k] <= start) k++; // both sorted: one pass
    const stop = stops[k];
    const next = segments[i + 1]?.start;
    const end = stop === undefined ? next : next === undefined ? stop : Math.min(stop, next);
    if (end !== undefined) segments[i].end = end;
  }
  return { segments };
}

function parsePlainText(body: string): ImportedText {
  // Paragraphs (blank-line separated) become segments; single-paragraph
  // files fall back to one segment per line.
  const wraps = cjkWrapsLines(body.split("\n"));
  const paras = body
    .split(BLANK_LINE)
    .map((p) => joinLines(p.split("\n"), wraps).replace(/\s+/g, " ").trim())
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
  const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    language?: unknown;
    segments?: unknown;
    text?: unknown;
    timingSynthesized?: unknown;
  };
  // Our export of a plain-text source: its clocks are placeholders, so it has no timing.
  const synth = obj.timingSynthesized === true;
  const segments: ImportedText["segments"] = [];
  if (Array.isArray(obj.segments)) {
    for (const s of obj.segments) {
      if (typeof s !== "object" || s === null) continue;
      const seg = s as Record<string, unknown>;
      // JSON.parse decodes `\u202e` escapes after parseImportedText's control-char pass,
      // so text and speaker are sanitized again here (language already is, below).
      const text = typeof seg.text === "string" ? stripControlChars(seg.text).trim() : "";
      if (!text) continue;
      const name =
        typeof seg.speakerName === "string"
          ? seg.speakerName
          : typeof seg.speaker === "string"
            ? seg.speaker
            : undefined;
      segments.push({
        text,
        // JSON.parse turns `1e999` into Infinity: a non-finite or negative clock is none.
        start: !synth && typeof seg.start === "number" && Number.isFinite(seg.start) && seg.start >= 0 ? seg.start : undefined,
        end: !synth && typeof seg.end === "number" && Number.isFinite(seg.end) && seg.end >= 0 ? seg.end : undefined,
        speaker: name === undefined ? undefined : safeDisplayText(name, SPEAKER_NAME_MAX).trim() || undefined,
      });
    }
  }
  // Bounded like Rust bounds a server's `language` (LANGUAGE_MAX = 64): this one comes
  // from a locally parsed file and otherwise reached the meta line and track chips raw.
  // A language word ("english", what OpenAI's verbose_json writes) becomes its code, so the
  // original groups, limits and titles like that code and goes out as the translation source.
  const shown = safeDisplayText(obj.language, 64).trim() || undefined;
  const language = shown ? languageCodeOf(shown) : undefined;
  if (segments.length === 0 && typeof obj.text === "string" && obj.text.trim()) {
    // Decoded by JSON.parse after the control-char pass, like the segment text above.
    return { ...parsePlainText(stripControlChars(obj.text)), language };
  }
  // A line break inside a segment's text folds like the subtitle import folds a cue's (one
  // decision for the file), so the stored text holds none: the exports, the Subtitles view and
  // a later edit commit then agree on it.
  if (segments.some((g) => g.text.includes("\n"))) {
    const wraps = cjkWrapsLines(segments.flatMap((g) => g.text.split("\n")));
    for (const g of segments) g.text = joinLineBreaks(g.text, wraps);
  }
  return { segments, language };
}
