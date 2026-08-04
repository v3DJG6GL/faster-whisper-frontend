// TS mirror of the Rust `sanitize_injected` (src-tauri/src/inject.rs). Strips C0/C1 control
// characters (except Tab and LF) and normalizes CR/CRLF -> LF, so a malicious / compromised /
// garbled transcription server can't smuggle terminal-escape or other control sequences onto
// the clipboard. Tab and newline are kept (legitimate text); CR is normalized to LF first.
//
// Used by the manual "Copy" surfaces (which write a raw server response to the clipboard) to match
// the same posture every automatic injection path already has via inject_text -> sanitize_injected.
/** Mirror of `is_deceptive_format_char` in src-tauri/src/inject.rs: Unicode FORMAT characters
 *  (category Cf) that change how text READS without being visible. `char::is_control()` — and the
 *  Cc test below — cover none of them, so a bidi override lets the server make the text that lands
 *  on the clipboard differ from the text the user watched appear. Trojan-Source, via dictation.
 *  The automatic injection paths have dropped these since B13; the manual Copy surfaces did not. */
function isDeceptiveFormatChar(code: number): boolean {
  return (
    code === 0x00ad || // SOFT HYPHEN
    code === 0x061c || // ARABIC LETTER MARK
    code === 0x180e || // MONGOLIAN VOWEL SEPARATOR
    code === 0x115f || // HANGUL CHOSEONG FILLER — zero-width, and category Lo, so no
    code === 0x1160 || // HANGUL JUNGSEONG FILLER — category-based rule reaches these
    code === 0x3164 || // HANGUL FILLER
    code === 0xffa0 || // HALFWIDTH HANGUL FILLER
    (code >= 0x200b && code <= 0x200f) || // ZWSP/ZWNJ/ZWJ/LRM/RLM
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings + overrides
    (code >= 0x2060 && code <= 0x2064) || // word joiner + invisible operators
    (code >= 0x2066 && code <= 0x2069) || // directional isolates
    (code >= 0x206a && code <= 0x206f) || // deprecated format controls
    code === 0xfeff || // BOM / ZWNBSP
    (code >= 0xfff9 && code <= 0xfffb) || // interlinear annotation
    (code >= 0x1bca0 && code <= 0x1bca3) || // Duployan shorthand controls
    (code >= 0x1d173 && code <= 0x1d17a) || // musical beam/slur/phrase controls
    (code >= 0xe0000 && code <= 0xe007f) // TAG block
  );
  // Deliberately absent, and must stay absent: U+0600-0605, U+06DD, U+070F, U+0890-0891 and
  // U+08E2 are also category Cf but all of them RENDER — they span the digits that follow, draw
  // the circle around a verse number, or overline an abbreviation. Filtering by category would
  // corrupt ordinary Arabic and Syriac text.
}

/** A server- or peer-authored string on its way into the UI: control characters and the
 *  deceptive-format set removed, length bounded.
 *
 *  The security-review dialog has done this since B17, on the reasoning that a string shown next
 *  to a trust decision must not be able to reorder the text around it or push it off screen. Every
 *  sibling surface that renders remote-authored identity — device names, usernames, server
 *  versions, imported backend names — needs the same treatment, so it lives here rather than in
 *  one screen. Unlike `stripControlChars` this also drops Tab and newline: these are single-line
 *  labels, and a newline in one is a layout break, not content. */
export function safeDisplayText(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  const out: string[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // U+2028/U+2029 are Zl/Zp, so neither the range above nor the format-char denylist reaches
    // them — but both are mandatory line breaks under UAX#14, produced by the line-breaking
    // algorithm itself rather than by whitespace handling, so no CSS collapses them. In a label
    // capped at 60 code points that is up to 60 forced breaks, which is exactly the "push the
    // buttons off screen" failure the cap exists to prevent.
    if (code === 0x2028 || code === 0x2029) continue;
    if (isDeceptiveFormatChar(code)) continue;
    out.push(ch);
    if (out.length >= max) break;
  }
  return out.join("");
}

export function stripControlChars(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop the Unicode Cc set (matches Rust char::is_control): C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F.
    // Keep Tab (0x09) and LF (0x0A) — legitimate text/keystrokes.
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl && code !== 0x09 && code !== 0x0a) continue;
    if (isDeceptiveFormatChar(code)) continue;
    out += ch;
  }
  return out;
}
