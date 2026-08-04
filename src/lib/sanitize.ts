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
    (code >= 0x200b && code <= 0x200f) || // ZWSP/ZWNJ/ZWJ/LRM/RLM
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings + overrides
    (code >= 0x2060 && code <= 0x2064) || // word joiner + invisible operators
    (code >= 0x2066 && code <= 0x2069) || // directional isolates
    code === 0xfeff || // BOM / ZWNBSP
    (code >= 0xfff9 && code <= 0xfffb) || // interlinear annotation
    (code >= 0xe0000 && code <= 0xe007f) // TAG block
  );
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
