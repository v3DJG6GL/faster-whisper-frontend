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
    code === 0x2028 || code === 0x2029 || // LINE/PARAGRAPH SEPARATOR — Zl/Zp, so the Cc test in
                                          // the callers misses them, yet both are UAX#14 mandatory
                                          // breaks. Rust's twin has had them since H12; here they
                                          // were added only to safeDisplayText's own inline test,
                                          // so the manual Copy surface still let them onto the
                                          // clipboard while every injection path dropped them.
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
    // U+2028/U+2029 now live in the shared denylist above (they belong to both callers, not
    // just this one): Zl/Zp, so the Cc range test misses them, yet both are UAX#14 mandatory
    // breaks that no CSS collapses. In a label capped at 60 code points that is up to 60
    // forced breaks — the "push the buttons off screen" failure the cap exists to prevent.
    if (isDeceptiveFormatChar(code)) continue;
    out.push(ch);
    if (out.length >= max) break;
  }
  return out.join("");
}

/** The stored key of an `AppRule` — the string the injection-target matcher compares against a
 *  live window's app id.
 *
 *  It has to go through the SAME filter the audit screen renders it with. `safeDisplayText`
 *  DELETES zero-width and bidi characters, so a rule whose `appId` is `"konsole​"` displayed
 *  as exactly `konsole`, still read "Blocked — never typed here", and never matched: the display
 *  sanitizer erased the one character that broke the comparison. The editor is no help either —
 *  the mark is invisible in a text input, and `trim()` does not remove it, so opening the rule and
 *  re-saving it did not repair it. App rules have no consent gate and raise no security-review
 *  prompt, so such a rule arrives on an unattended pull.
 *
 *  The producer side is normalized to match: `atspi_guard` already ran the AT-SPI application name
 *  through the same class, and `win_focus::exe_basename` now does too — normalizing only the rule
 *  would invert the bug on Windows, where a filename legitimately may carry those characters. */
export function normalizeAppId(s: unknown): string {
  let out = "";
  for (const ch of safeDisplayText(s, 200)) {
    if (!isInvisibleKeyChar(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim();
}

/** Characters that render as NOTHING but are neither in the deceptive-format denylist above nor
 *  `WhiteSpace` (so `trim()` misses them too).
 *
 *  This is the same bug `normalizeAppId` exists for, through a class the display filter does not
 *  reach. The zero-width fix made `"konsole​"` normalize to `konsole`; `"konsole️"` still
 *  stores whole, still draws as exactly `konsole` beside "Blocked — never typed here", and still
 *  matches nothing. Verified: U+034F, U+17B4-B5, U+2800 and the variation selectors all survive
 *  `safeDisplayText` and all render empty.
 *
 *  The union of this list and `isDeceptiveFormatChar`'s is `Default_Ignorable_Code_Point` minus the
 *  Arabic/Syriac format characters that one deliberately excludes — state that when extending
 *  either, so the next omission is visible.
 *
 *  Deliberately NOT added to `isDeceptiveFormatChar`: that list is the declared mirror of Rust's
 *  `sanitize_injected`, and deleting U+FE0F there would strip emoji-presentation selectors out of
 *  every transcript the app types. This belongs to the KEY, not to the display. */
function isInvisibleKeyChar(code: number): boolean {
  return (
    code === 0x034f || // COMBINING GRAPHEME JOINER — "no visible glyph"
    (code >= 0x17b4 && code <= 0x17b5) || // Khmer inherent vowels, rendered invisible
    (code >= 0x180b && code <= 0x180f) || // Mongolian free variation selectors (+ FVS4)
    code === 0x2065 || // the one hole in the 2060-206F run the deceptive list splits around
    code === 0x2800 || // BRAILLE PATTERN BLANK
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfff0 && code <= 0xfff8) || // unassigned-but-ignorable specials
    (code >= 0xe0000 && code <= 0xe0fff) // tags + variation selectors supplement
  );
}

/** An identity string rendered NEXT TO a trust decision — an app-rule key, a parsed host.
 *
 *  `safeDisplayText` truncates at `max` with no marker at all, unlike its Rust twin
 *  `bounded_server_text`, which appends an ellipsis. That is fine for a label and wrong for an
 *  identity: an app-rule key of `"konsole" + 80 spaces + "evil"` is stored whole (the matcher is
 *  exact equality on the full 200-char key) while the audit row renders the first 80 code points —
 *  and CSS collapses the run, so the row reads exactly `konsole`, claims "Blocked — never typed
 *  here", and matches nothing. Same shape for a hostname padded to push its real suffix past the
 *  cut in a consent dialog.
 *
 *  So: collapse interior whitespace runs and mark truncation, making it impossible for a longer or
 *  padded value to render as a strict prefix of itself. Display only — the stored key stays
 *  `normalizeAppId`'s output, which is what keeps it agreeing with the producer side. */
export function safeIdentityText(s: unknown, max = 80): string {
  // Collapse BEFORE bounding. The other order is inert for exactly the case above: a padding run
  // longer than `max` is cut inside the padding, the collapse then shrinks the remainder back under
  // the cap, and the marker never gets appended — leaving the render byte-identical to the
  // unguarded one. Collapsing first makes the example render "konsole evil".
  //
  // "Whitespace" here is NOT just JS `\s`. That misses the invisible class this file already
  // enumerates in `isInvisibleKeyChar` — U+2800 BRAILLE PATTERN BLANK, U+034F, the Mongolian and
  // standard variation selectors, the tags block — every one of which renders as nothing and pads
  // exactly like a space. `"kate" + 200×U+2800` reproduced the padding attack this function was
  // written for, one character class over. Fold those to spaces first, then collapse, so the run
  // shrinks and the real suffix survives the cut.
  const raw = typeof s === "string" ? s : "";
  const defanged = [...raw]
    .map((ch) => (isInvisibleKeyChar(ch.codePointAt(0) ?? 0) ? " " : ch))
    .join("");
  const collapsed = defanged.replace(/\s+/g, " ");
  const t = safeDisplayText(collapsed, max + 1).trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : t;
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
