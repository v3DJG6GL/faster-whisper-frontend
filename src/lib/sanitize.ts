// TS mirror of the Rust `sanitize_injected` (src-tauri/src/inject.rs). Strips C0/C1 control
// characters (except Tab and LF) and normalizes CR/CRLF -> LF, so a malicious / compromised /
// garbled transcription server can't smuggle terminal-escape or other control sequences onto
// the clipboard. Tab and newline are kept (legitimate text); CR is normalized to LF first.
//
// Used by the manual "Copy" surfaces (which write a raw server response to the clipboard) to match
// the same posture every automatic injection path already has via inject_text -> sanitize_injected.
export function stripControlChars(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop the Unicode Cc set (matches Rust char::is_control): C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F.
    // Keep Tab (0x09) and LF (0x0A) — legitimate text/keystrokes.
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl || code === 0x09 || code === 0x0a) out += ch;
  }
  return out;
}
