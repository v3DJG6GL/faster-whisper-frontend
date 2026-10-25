// Keyboard mapping for hotkey capture + display.
//
// Bindings are stored as `KeyboardEvent.code` lists; Rust's `codes_to_accelerator` turns them
// into the accelerator strings ("Ctrl+Shift+Numpad0") the global-shortcut plugin parses
// (global-hotkey's `parse_hotkey`). That parser
// accepts the uppercased W3C `KeyboardEvent.code` for the key part (KEYH, DIGIT1,
// BACKSPACE, ARROWUP, NUMPAD0, F1–F24, numpad operators, …) plus friendly aliases,
// and logical modifiers (Ctrl/Alt/Shift/Super) — it can NOT distinguish left/right
// modifiers (that needs a low-level backend: evdev or the Windows hook).
// Punctuation/symbol codes (Minus, BracketLeft, Backquote, IntlBackslash, …) and
// ContextMenu aren't supported and are rejected here; Rust's `validate_codes` is the
// final gate.

import { keycapLabel } from "./keyboardLayout";
// A hotkey CODE is untrusted: `isCodeList`/`isStringList` check each code's type (isCodeList also
// caps its length), never its content, and Rust's `de_hotkey` only sorts and dedups, so a sync
// blob or imported file can put "__proto__" in a chord. A bare index into the literal maps below
// would then return an `Object.prototype` member — a React child that throws (no error boundary)
// or a non-string that breaks `canonicalizeCodes` and stalls sync — hence every lookup goes
// through `ownProp`.
import { ownProp } from "./own";
import { IS_WINDOWS } from "./platform";

/** Named keys (by `event.code`) the plugin accepts as a shortcut's key part. */
const NAMED_CODES = new Set<string>([
  "Backspace", "Delete", "Enter", "Space", "Tab",
  "Home", "End", "Insert", "PageUp", "PageDown", "PrintScreen",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4",
  "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
  "NumpadDecimal", "NumpadEnter", "NumpadEqual",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

export const MODIFIER_CODES = new Set<string>([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

/**
 * Map a `KeyboardEvent.code` to the plugin's accelerator key token, or null if it
 * can't be a global-shortcut key. Letters → "H", digits → "1", everything else is
 * the `event.code` itself (the parser uppercases it).
 */
export function codeToToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyH → H
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 → 1
  if (NAMED_CODES.has(code)) return code; // Backspace, Numpad0, ArrowUp, F1…
  return null;
}

// e.key → left/right code pairs for the modifier fallback below.
const KEY_MODIFIER_SIDES: Record<string, [string, string]> = {
  Control: ["ControlLeft", "ControlRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Alt: ["AltLeft", "AltRight"],
  Meta: ["MetaLeft", "MetaRight"],
  // WebKitGTK reports the Super/Windows key's `key` as "Super" (X11 Hyper as
  // "Hyper"; pre-2017 engines said "OS") — all are the Meta pair in code space.
  Super: ["MetaLeft", "MetaRight"],
  Hyper: ["MetaLeft", "MetaRight"],
  OS: ["MetaLeft", "MetaRight"],
};

// WebKitGTK never adopted the 2016 UI-Events rename of the Windows/Super key
// CODES — its GTK port still emits the old draft names OSLeft/OSRight (see
// WebKit Source/WebKit/Shared/gtk/WebKeyboardEventGtk.cpp), so without this
// normalization the Linux webview's Super key is rejected as unmappable during
// capture. WebView2 (Windows) emits MetaLeft/MetaRight already.
const LEGACY_CODES: Record<string, string> = {
  OSLeft: "MetaLeft",
  OSRight: "MetaRight",
};

// Numpad-located (`e.location === 3`) keys whose `e.key` is a character/name, not a
// Numpad* code: operators, decimal, equal, and Enter.
const NUMPAD_KEY_CODES: Record<string, string> = {
  "+": "NumpadAdd", "-": "NumpadSubtract", "*": "NumpadMultiply",
  "/": "NumpadDivide", ".": "NumpadDecimal", "=": "NumpadEqual",
  Enter: "NumpadEnter",
};

/**
 * The event's `code` — normalized from legacy names (WebKitGTK's OSLeft/OSRight
 * for the Super key), and derived from `key` + `location` when `code` is unusable.
 * Software-injected shortcuts (dictation hardware companion apps like Philips
 * SpeechControl, AutoHotkey remaps — anything sending VK-only `SendInput` with no
 * scancode) reach the webview with `code` ""/"Unidentified" but a valid `key`, so
 * without the fallback such chords can't be captured at all. VK→key→VK round-trips
 * for letters/digits/named keys, so the binding fires on the same virtual key the
 * injector sends. Returns the raw (unusable) `code` when no fallback applies —
 * downstream `codeToToken` then rejects it.
 */
export function eventToCode(e: Pick<KeyboardEvent, "code" | "key" | "location">): string {
  if (e.code && e.code !== "Unidentified") return ownProp(LEGACY_CODES, e.code) ?? e.code;
  const sides = ownProp(KEY_MODIFIER_SIDES, e.key);
  if (sides) return e.location === 2 ? sides[1] : sides[0];
  if (/^[a-zA-Z]$/.test(e.key)) return `Key${e.key.toUpperCase()}`;
  if (/^[0-9]$/.test(e.key)) return e.location === 3 ? `Numpad${e.key}` : `Digit${e.key}`;
  if (e.key === " ") return "Space";
  const numpad = ownProp(NUMPAD_KEY_CODES, e.key);
  if (e.location === 3 && numpad) return numpad;
  if (NAMED_CODES.has(e.key)) return e.key; // Enter, Tab, ArrowUp, PageDown, F1…
  return e.code;
}

const PRETTY: Record<string, string> = {
  Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Super",
  Space: "Space", Enter: "↵", Tab: "Tab", Backspace: "⌫",
  Delete: "Del", Insert: "Ins", Home: "Home", End: "End",
  PageUp: "PgUp", PageDown: "PgDn", PrintScreen: "PrtSc",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  NumpadAdd: "Num +", NumpadSubtract: "Num −", NumpadMultiply: "Num ×",
  NumpadDivide: "Num ÷", NumpadDecimal: "Num .", NumpadEnter: "Num ↵",
  NumpadEqual: "Num =",
};

/** Human-friendly label for one accelerator token (for `<kbd>` chips). */
export function prettyToken(token: string): string {
  const pretty = ownProp(PRETTY, token);
  if (pretty) return pretty;
  const numpad = /^Numpad([0-9])$/.exec(token);
  if (numpad) return `Num ${numpad[1]}`;
  return token; // letters, digits, F-keys
}

// Modifier `event.code` → display label. Right-side modifiers and AltGr are shown
// distinctly (only a low-level backend — evdev, the Windows hook — honours them).
const MOD_LABELS: Record<string, string> = {
  ControlLeft: "Ctrl", ControlRight: "R-Ctrl",
  ShiftLeft: "Shift", ShiftRight: "R-Shift",
  AltLeft: "Alt", AltRight: "AltGr",
  MetaLeft: "Super", MetaRight: "R-Super",
};

/** Display label for one binding `event.code` (modifier or key). Letters use the
 *  user's learned keyboard layout (so a QWERTZ "Z"-keycap on physical KeyY shows
 *  "Z", not "Y") — see keyboardLayout.ts — falling back to the physical letter. */
export function codeToLabel(code: string): string {
  const mod = ownProp(MOD_LABELS, code);
  if (mod) return mod;
  if (/^Key[A-Z]$/.test(code)) return keycapLabel(code) ?? code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 → 1
  return prettyToken(code); // Numpad0 → Num 0, ArrowUp → ↑, Backspace → ⌫, F1 …
}

export function codesToLabels(codes: string[]): string[] {
  return codes.map(codeToLabel);
}

const CODE_RANK: Record<string, number> = {
  ControlLeft: 0, ControlRight: 1, AltLeft: 2, AltRight: 3,
  ShiftLeft: 4, ShiftRight: 5, MetaLeft: 6, MetaRight: 7,
};

const SIDE_COLLAPSE: Record<string, string> = {
  ControlRight: "ControlLeft",
  ShiftRight: "ShiftLeft",
  MetaRight: "MetaLeft",
  // AltRight (AltGr) is deliberately NOT collapsed: the plugin's parser rejects it outright
  // (codes_to_accelerator → None), it does not fold it to Alt. Collapsing it would make AltGr+X a
  // duplicate of Alt+X and freeze saving, when AltGr+X merely can't register under the plugin — a
  // non-blocking condition the capture warning already surfaces.
};

/** Collapse right-side modifiers to their left equivalent, as the global-shortcut PLUGIN's
 *  accelerator parser does (codes_to_accelerator). For conflict detection when the plugin is the
 *  registrar: chords differing only by modifier side would otherwise pass yet collide at registration,
 *  one silently never firing. AltGr stays distinct (see SIDE_COLLAPSE). Callers skip this when a
 *  low-level backend (evdev, the Windows hook), which honours sides, is live. */
export function collapseModifierSides(codes: string[]): string[] {
  return codes.map((c) => ownProp(SIDE_COLLAPSE, c) ?? c);
}

/** A chord the global-shortcut plugin can't register (Rust's codes_to_accelerator → None):
 *  modifier-only, AltGr, or more than one non-modifier key. Only a low-level backend (evdev,
 *  the Windows hook) fires it. An empty (unbound) chord needs nothing. */
export function needsLowLevel(codes: string[]): boolean {
  if (codes.length === 0) return false;
  if (codes.includes("AltRight")) return true;
  return codes.filter((c) => !MODIFIER_CODES.has(c)).length !== 1;
}

/** Windows/WebView2 synthesizes a phantom `ControlLeft` keydown just before
 *  `AltRight` on AltGr layouts (German/Swiss). The Windows backend drops that
 *  phantom in both feeds (scan 0x21D / injected raw input), so a captured
 *  "Ctrl + AltGr" chord could never match at runtime — drop it whenever AltGr
 *  is the modifier actually in play. WINDOWS-ONLY: X11/Wayland deliver AltGr as a
 *  lone AltRight and evdev binds ControlLeft and AltRight as two independent keys,
 *  so callers gate on `altGrPhantomActive`, not on the raw AltGraph modifier state —
 *  or a Linux Ctrl+AltGr+X capture silently commits the broader AltGr+X. */
export function dropAltGrPhantom(codes: string[], altGraph: boolean): string[] {
  if (!altGraph || !codes.includes("AltRight")) return codes;
  return codes.filter((c) => c !== "ControlLeft");
}

/** Is the phantom-ControlLeft strip in play for this key event? True only on
 *  Windows (the platform that synthesizes the phantom) with AltGraph active. */
export function altGrPhantomActive(e: { getModifierState?: (k: string) => boolean }): boolean {
  return IS_WINDOWS && e.getModifierState?.("AltGraph") === true;
}

/** Canonical order (modifiers by type+side, key last) + de-duped, so a stored
 *  chord is independent of press order and comparable by value. */
export function canonicalizeCodes(codes: string[]): string[] {
  return Array.from(new Set(codes)).sort(
    // Equal-rank codes (two non-modifier keys of a low-level N-key chord, both rank 100) need
    // the lexical tie-break, or press order would leak into the result and break `sameCodes`.
    (a, b) => (ownProp(CODE_RANK, a) ?? 100) - (ownProp(CODE_RANK, b) ?? 100) || a.localeCompare(b),
  );
}

/** Value-equality for two canonical code lists. */
export function sameCodes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * True while an input method is composing: the IME owns Enter (commit the candidate), Esc (cancel
 * the half-typed text) and the arrows (candidate list), so a key handler must leave them alone.
 * WebKit still reports their `key`, with keyCode 229, so both that and `isComposing` are checked.
 * Takes a DOM or a React keyboard event.
 */
export function imeComposing(e: KeyboardEvent | { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  const n = "nativeEvent" in e ? e.nativeEvent : e;
  return n.isComposing || e.keyCode === 229;
}
