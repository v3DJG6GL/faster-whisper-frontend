import type { AppRule } from "./types";

// `stripControlChars` (below) is the TS mirror of the Rust `sanitize_injected`
// (src-tauri/src/inject/mod.rs), so a malicious or garbled server can't smuggle terminal-escape or
// other control sequences onto the clipboard through the manual "Copy" surfaces, which write a raw
// server response there — the same posture every automatic injection path has.
/** Mirror of `is_deceptive_format_char` in src-tauri/src/inject/mod.rs: Unicode FORMAT characters
 *  (category Cf) that change how text READS without being visible. `char::is_control()` — and the
 *  Cc test below — cover none of them, so a bidi override lets the server make the text that lands
 *  on the clipboard differ from the text the user watched appear. Trojan-Source, via dictation. */
function isDeceptiveFormatChar(code: number): boolean {
  return (
    code === 0x00ad || // SOFT HYPHEN
    code === 0x061c || // ARABIC LETTER MARK
    code === 0x180e || // MONGOLIAN VOWEL SEPARATOR
    code === 0x115f || // HANGUL CHOSEONG FILLER — zero-width, and category Lo, so no
    code === 0x1160 || // HANGUL JUNGSEONG FILLER — category-based rule reaches these
    code === 0x3164 || // HANGUL FILLER
    code === 0xffa0 || // HALFWIDTH HANGUL FILLER
    code === 0x200b || code === 0x200e || code === 0x200f || // ZWSP/LRM/RLM (NOT ZWNJ/ZWJ — see Rust twin)
    code === 0x2028 || code === 0x2029 || // LINE/PARAGRAPH SEPARATOR — Zl/Zp, so the Cc test in
                                          // the callers misses them, yet both are UAX#14 mandatory
                                          // breaks.
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

/** The Unicode Cc set, matching Rust `char::is_control`: C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F.
 *  One predicate for every caller so the text views never disagree on what they strip. */
function isCc(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** A server- or peer-authored string on its way into the UI: control characters and the
 *  deceptive-format set removed, length bounded.
 *
 *  A string shown next to a trust decision must not be able to reorder the text around it or push
 *  it off screen. Every surface that renders remote-authored identity — device names, usernames,
 *  server versions, imported backend names — needs that, so it lives here rather than in one
 *  screen. Unlike `stripControlChars` this also drops Tab and newline: these are single-line
 *  labels, and a newline in one is a layout break, not content. */
export function safeDisplayText(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  const out: string[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCc(code)) continue;
    // isDeceptiveFormatChar also drops U+2028/U+2029: UAX#14 mandatory breaks no CSS collapses,
    // so a 60-code-point label could carry 60 forced breaks and push the buttons off screen.
    if (isDeceptiveFormatChar(code)) continue;
    out.push(ch);
    if (out.length >= max) break;
  }
  return out.join("");
}

/** The stored key of an `AppRule` — the string the injection-target matcher compares against a
 *  live window's app id.
 *
 *  It has to go through the SAME filter the audit screen renders it with: `safeDisplayText`
 *  DELETES zero-width and bidi characters, so a rule whose `appId` is `"konsole​"` displayed
 *  as exactly `konsole`, read "Blocked — never typed here", and never matched. The mark is
 *  invisible in a text input and `trim()` keeps it, so re-saving the rule did not repair it, and
 *  app rules have no consent gate, so such a rule arrives on an unattended pull.
 *
 *  The producer side is normalized to match (`focus::atspi` and `focus::exe_name` run the app id
 *  through `bounded_server_text`); normalizing only the rule would invert the bug on Windows,
 *  where a filename legitimately may carry those characters. */
export function normalizeAppId(s: unknown): string {
  let out = "";
  for (const ch of safeDisplayText(s, 200)) {
    if (!isInvisibleKeyChar(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim();
}

/** The appRules floor every path into the store shares (hydration, and the quick-add window that
 *  has no store) — lives here, store-free, so quick-add can apply it without instantiating the
 *  store in its webview. Shape only, like the store's other floors (store.ts wellFormedProfiles):
 *  it drops only what Rust's typed load would have rejected anyway. */
export function wellFormedAppRules(v: unknown): AppRule[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (r): r is AppRule =>
        !!r && typeof r === "object" &&
        typeof (r as AppRule).id === "string" &&
        typeof (r as AppRule).appId === "string",
    )
    // The one normalization this floor applies (the exception to shape-only): `appId` is the
    // matching key and the audit screen renders it through a filter that deletes invisible
    // characters, so an un-normalized key displays as armed and matches nothing. A no-op on a
    // legitimate rule. Rules whose key is entirely invisible are dropped: they could never match
    // and could never be read.
    .map((r) => ({ ...r, appId: normalizeAppId(r.appId) }))
    // On the COMPARISON key: a joiner-only appId keeps its stored joiner but keys to "".
    .filter((r) => appRuleKey(r.appId).length > 0);
}

/** ZWNJ/ZWJ out of a string. They stay in stored names and interior text (scripts need them),
 *  but leave every comparison key and a language code's display text. */
export const dropJoiners = (s: string): string => s.replace(/[\u200c\u200d]/g, "");

/** Characters that render as NOTHING but are neither in the deceptive-format denylist above nor
 *  `WhiteSpace` (so `trim()` misses them too).
 *
 *  The same bug `normalizeAppId` exists for, through a class the display filter does not reach:
 *  U+034F, U+17B4-B5, U+2800 and the variation selectors all survive `safeDisplayText` and render
 *  empty, so `"konsole️"` stores whole, draws as exactly `konsole`, and matches nothing.
 *
 *  Together with `isDeceptiveFormatChar`'s list this covers every `Default_Ignorable_Code_Point`
 *  except ZWNJ/ZWJ (U+200C/D), which shape scripts and emoji sequences, so they stay in the stored
 *  key and interior text and are dropped only where they join nothing (a display head via
 *  `trimLeadingInvisible`, a run `safeIdentityText` folds), from a language code's display text,
 *  and from the COMPARISON key (`appRuleKey` / Rust `rule_key`) — state that when extending either,
 *  so the next omission is visible.
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
 *  identity: an app-rule key of `"konsole" + 80 spaces + "evil"` is stored whole (the matcher
 *  compares the full 200-char key) while the audit row renders the first 80 code points —
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
  //
  // The characters `safeDisplayText` DELETES (Cc, the deceptive-format set) are deleted here too,
  // before the collapse: left in place they split the run — `" \u200b"` × 100 is a hundred
  // one-space runs that collapse to nothing, then lose their separators to the display filter, and
  // the padded name renders as exactly `konsole` again.
  //
  // The invisible HEAD goes first (`trimLeadingInvisible`): a leading ZWNJ/ZWJ renders as nothing,
  // but the fold keeps joiners (interior ones shape scripts and emoji), so a joiner-only name would
  // read as content and a leading joiner run would pad the name past the cut.
  //
  // Interior joiners pad too: `"Work" + " \u200d"×100 + " Evil"` is a hundred one-space runs the
  // collapse cannot merge, so the cut lands in the padding exactly as the U+2800 case did. A joiner
  // next to whitespace, or a second one in a row, joins nothing, so such a run is folded first: one
  // touching whitespace becomes a space, a bare run keeps only its first joiner. Emoji and script
  // sequences (a single joiner between two visible characters) are untouched.
  const raw = typeof s === "string" ? trimLeadingInvisible(s) : "";
  const defanged = [...raw]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (/\s/.test(ch) || isInvisibleKeyChar(code)) return " ";
      if (isCc(code) || isDeceptiveFormatChar(code)) return "";
      return ch;
    })
    .join("");
  // No lookbehind (older WebKitGTK builds lack it), and no `\s*` around the run: that form
  // restarts at every blank offset and backtracks when no joiner follows, quadratic on a long
  // blank run. The run's neighbours are read by offset instead, so the pass is linear, and any run
  // touching whitespace folds — also one right after a space the previous run already took.
  const collapsed = defanged
    .replace(/[\u200c\u200d]+/g, (m, off: number, str: string) =>
      /\s/.test(str[off - 1] ?? "") || /\s/.test(str[off + m.length] ?? "") ? " " : m[0],
    )
    .replace(/\s+/g, " ");
  // Trim BEFORE the cut, and trim what precedes the marker: trimming after the cut would drop a
  // collapsed space landing at `max + 1` before the length test, so `"a"×80 + " evil"` would
  // render as its own 80-char prefix with no ellipsis.
  const t = safeDisplayText(collapsed.trim(), max + 1);
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() + "…" : t;
}

/** `s` without the leading characters that render as nothing — whitespace, the invisible class
 *  `.trim()` keeps (U+2800, variation selectors, …), ZWNJ/ZWJ and the characters the display filter
 *  deletes — so a display cut that follows starts at the first visible one. Only the head: a
 *  trailing variation selector belongs to the emoji before it. */
export function trimLeadingInvisible(s: string): string {
  // Walk the head only and cut by UTF-16 offset: spreading the whole name would copy an unbounded
  // synced string twice per render before the display cap applied.
  let off = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // A leading ZWNJ/ZWJ joins nothing, so it is dropped here; interior ones (emoji sequences) stay.
    const joiner = code === 0x200c || code === 0x200d;
    if (!(/\s/.test(ch) || isInvisibleKeyChar(code) || isCc(code) || isDeceptiveFormatChar(code) || joiner)) break;
    off += ch.length;
  }
  return s.slice(off);
}

/** The name a profile or backend is shown under. A synced name that is blank, only spaces or only
 *  invisible characters renders as nothing, so it reads as the label a local save would have stored
 *  instead ("Untitled profile" / "Untitled backend") — one rule for every list, notice and chip.
 *  A profile name RENDERS through the display filter, because the identity fold turns the emoji
 *  variation selector into a space ("☕️Café" would read "☕ Café"); its invisible head is dropped
 *  first, so leading padding can neither push the name past the cut nor leave a blank render. A
 *  backend name renders as an identity, as the Backends audit card always has (`safeIdentityText`
 *  drops the invisible head itself). */
export const profileDisplayName = (name: unknown, max = 80): string =>
  (typeof name === "string" && safeDisplayText(trimLeadingInvisible(name), max).trim()) || "Untitled profile";
export const backendDisplayName = (name: unknown, max = 80): string =>
  safeIdentityText(name, max) || "Untitled backend";
/** A server-supplied device name as shown ("… from <device>"): its invisible head dropped (as a
 *  profile name's), display-filtered and trimmed. A blank result (spaces, invisible characters
 *  only) means "render the fallback or omit it". */
export const deviceDisplayName = (name: unknown, max = 60): string =>
  typeof name === "string" ? safeDisplayText(trimLeadingInvisible(name), max).trim() : "";

/** A PEER device's name as a sync surface shows it ("… from <device>", a conflict arm), or "" when
 *  it would read as this device's own label (`localLabel`) — the caller then renders its neutral
 *  fallback or omits the clause. The name is server-supplied, so it must never be able to read as
 *  this device: one calling itself "This device" would produce two identical buttons on the control
 *  that decides whose settings win, and every sync sentence would credit this device with the
 *  peer's copy. Compared as the name renders — case-insensitively, with ALL whitespace, the
 *  invisible class (U+2800, variation selectors, …) and ZWNJ/ZWJ removed, since `"This\u2800device"`,
 *  `"This device\uFE0F"`, `"This \u200Ddevice"` and `"Th\u034Fis device"` all draw as "This
 *  device" (the invisible class becomes a space here, but its zero-width members draw nothing, so
 *  a space inside a word cannot be told from none). "Thisdevice" then falls back too — acceptable. */
export function peerDeviceName(device: unknown, localLabel = "This device"): string {
  const name = deviceDisplayName(device);
  const norm = (s: string) =>
    dropJoiners(safeIdentityText(s, 200)).replace(/\s+/g, "").toLowerCase();
  return name && norm(name) !== norm(localLabel) ? name : "";
}

/** The name a dictionary rule list is shown under — the one render rule for every site that names
 *  a list: its label, else its rule name, each through `deviceDisplayName`, so a label of only
 *  spaces or invisible characters falls through to the name instead of rendering blank. "" when
 *  both are blank; the caller picks its own last fallback. */
export const ruleListLabel = (label: unknown, name: unknown, max = 80): string =>
  deviceDisplayName(label, max) || deviceDisplayName(name, max);

/** The comparison key of an app rule — how two `appId`s are judged to name the same app, for
 *  both the dedupe on save/merge and the injection-target matcher. One function so they cannot
 *  drift: a dedupe looser or stricter than the matcher saves two rules where one silently
 *  shadows the other. */
export function appRuleKey(appId: unknown): string {
  // ZWNJ/ZWJ leave the COMPARISON key only (the stored key keeps them, see isInvisibleKeyChar):
  // `"kon\u200dsole"` renders as exactly `konsole` in the audit row, so it must match that id.
  // Trimmed again: `"\u200d konsole"` leaves a leading space once the joiner goes. Whitespace
  // runs fold to one ASCII space, as `safeIdentityText` draws them: `"Google\u00a0Chrome"` or a
  // double space shows as exactly `Google Chrome` in the audit row, so it must match it.
  return dropJoiners(normalizeAppId(appId)).replace(/\s+/g, " ").trim().toLowerCase();
}

/** A user/server-authored code (a language, an extractor key) cut to what is safe in a file
 *  name or a WebVTT class: ASCII letters, digits and hyphens, bounded; `fallback` when
 *  nothing is left. Lowercase it first where the caller wants it lowercase. */
export function codeSlug(code: string, max = 12, fallback = ""): string {
  return code.replace(/[^A-Za-z0-9-]/g, "").slice(0, max) || fallback;
}

/** The first `max` code points of `s` — the server's char cap, and never half a surrogate
 *  pair (a lone surrogate fails the invoke's JSON parse). */
export function capCodePoints(s: string, max: number): string {
  // At most `max` UTF-16 units is at most `max` code points: nothing to cut.
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join("");
}

/** An edit `prev` → `next` held to `max` code points the way a native maxLength holds it: only
 *  the inserted run is cut, so typing or pasting into a full field keeps the existing text
 *  (capCodePoints on the whole string would drop the field's TAIL instead). An edit that doesn't
 *  grow lands as-is, so a value stored over the cap can still shorten. */
export function capEdit(prev: string, next: string, max: number): string {
  if (next.length <= max) return next;
  const n = Array.from(next);
  const p = Array.from(prev);
  if (n.length <= max || n.length <= p.length) return next;
  let pre = 0;
  while (pre < p.length && p[pre] === n[pre]) pre++;
  let suf = 0;
  while (suf < p.length - pre && suf < n.length - pre && p[p.length - 1 - suf] === n[n.length - 1 - suf]) suf++;
  const inserted = n.slice(pre, n.length - suf).slice(0, Math.max(0, max - pre - suf));
  return [...n.slice(0, pre), ...inserted, ...n.slice(n.length - suf)].join("");
}

/** `max` bounds the OUTPUT: the result is the unbounded result's first `max` chars, so a
 *  160-char snippet never walks a whole transcript (History renders one per row per
 *  keystroke). Bounding the input instead would not be equivalent — this only ever drops
 *  characters, and an input slice can split a surrogate pair. */
export function stripControlChars(text: string, max = Infinity): string {
  let out = "";
  if (max <= 0) return out;
  // CR normalisation lives in the bounded loop: two whole-string `replace` passes up front
  // would copy a full transcript twice per row per keystroke before the bound applied.
  let prevCR = false;
  for (const raw of text) {
    let ch = raw;
    if (ch === "\r") {
      prevCR = true;
      ch = "\n";
    } else if (ch === "\n" && prevCR) {
      prevCR = false;
      continue; // the CRLF's LF — its CR already became "\n"
    } else {
      prevCR = false;
    }
    const code = ch.codePointAt(0) ?? 0;
    // Drop the Unicode Cc set. Keep Tab (0x09) and LF (0x0A) — legitimate text/keystrokes.
    const isControl = isCc(code);
    if (isControl && code !== 0x09 && code !== 0x0a) continue;
    if (isDeceptiveFormatChar(code)) continue;
    // Never split a surrogate pair to hit the bound exactly.
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
