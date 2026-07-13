// Keyboard mapping for hotkey capture + display.
//
// Bindings are stored as accelerator strings ("Ctrl+Shift+Numpad0") that the Rust
// global-shortcut plugin parses (global-hotkey's `parse_hotkey`). That parser
// accepts the uppercased W3C `KeyboardEvent.code` for the key part (KEYH, DIGIT1,
// BACKSPACE, ARROWUP, NUMPAD0, F1–F24, numpad operators, …) plus friendly aliases,
// and logical modifiers (Ctrl/Alt/Shift/Super) — it can NOT distinguish left/right
// modifiers (that needs the evdev backend, P5). Punctuation/symbol codes (Minus,
// BracketLeft, Backquote, IntlBackslash, …) and ContextMenu aren't supported and
// are rejected here; `validateCodes` is the final gate in the Rust layer.

import { keycapLabel } from "./keyboardLayout";

/** Named keys (by `event.code`) the plugin accepts as a shortcut's key part. */
const NAMED_CODES = new Set<string>([
  "Backspace", "Delete", "Enter", "Space", "Tab",
  "Home", "End", "Insert", "PageUp", "PageDown", "PrintScreen",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4",
  "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
  "NumpadDecimal", "NumpadEnter", "NumpadEqual",
  // F1–F24
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

/** Modifier `event.code`s — used to drive the live preview while a chord is held. */
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
 * downstream `codeToToken` then rejects it exactly as before.
 */
export function eventToCode(e: Pick<KeyboardEvent, "code" | "key" | "location">): string {
  if (e.code && e.code !== "Unidentified") return LEGACY_CODES[e.code] ?? e.code;
  const sides = KEY_MODIFIER_SIDES[e.key];
  if (sides) return e.location === 2 ? sides[1] : sides[0];
  if (/^[a-zA-Z]$/.test(e.key)) return `Key${e.key.toUpperCase()}`;
  if (/^[0-9]$/.test(e.key)) return e.location === 3 ? `Numpad${e.key}` : `Digit${e.key}`;
  if (e.key === " ") return "Space";
  if (e.location === 3 && NUMPAD_KEY_CODES[e.key]) return NUMPAD_KEY_CODES[e.key];
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
  if (PRETTY[token]) return PRETTY[token];
  const numpad = /^Numpad([0-9])$/.exec(token);
  if (numpad) return `Num ${numpad[1]}`;
  return token; // letters, digits, F-keys
}

// Modifier `event.code` → display label. Right-side modifiers and AltGr are shown
// distinctly (they're only honoured by the evdev backend; the plugin collapses them).
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
  if (MOD_LABELS[code]) return MOD_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return keycapLabel(code) ?? code.slice(3); // KeyH → H
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 → 1
  return prettyToken(code); // Numpad0 → Num 0, ArrowUp → ↑, Backspace → ⌫, F1 …
}

/** Display labels for a chord's code list (for `<kbd>` chips). */
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
  // AltRight (AltGr) is deliberately NOT collapsed: the plugin's accelerator parser REJECTS it outright
  // (codes_to_accelerator returns None — "AltGr — evdev-only"), it does NOT fold it to Alt. Collapsing it
  // would make AltGr+X read as a duplicate of Alt+X and FREEZE saving, when really AltGr+X just can't
  // register under the plugin — a non-blocking condition already surfaced by the "needs evdev" hint.
};

/** Collapse right-side modifiers to their left equivalent — matching what the global-shortcut PLUGIN
 *  backend does (its accelerator parser can't distinguish Ctrl/Shift/Super sides; see codes_to_accelerator).
 *  Use this for conflict detection when the plugin is the registrar (evdev off), so two chords that
 *  differ ONLY by modifier side (Ctrl-left+H vs Ctrl-right+H) are correctly seen as the same chord —
 *  otherwise both pass conflict detection yet collide at registration and one silently never fires.
 *  AltGr (AltRight) is excluded: the plugin rejects it rather than folding it, so it must stay a distinct
 *  token (see SIDE_COLLAPSE). Under evdev (which DOES honour sides) callers skip this entirely. */
export function collapseModifierSides(codes: string[]): string[] {
  return codes.map((c) => SIDE_COLLAPSE[c] ?? c);
}

/** Canonical order (modifiers by type+side, key last) + de-duped, so a stored
 *  chord is independent of press order and comparable by value. */
export function canonicalizeCodes(codes: string[]): string[] {
  return Array.from(new Set(codes)).sort(
    // Rank orders modifiers first (by type+side); equal-rank codes — e.g. two non-modifier
    // keys in an evdev N-chord, both rank 100 — fall back to a stable lexical tie-break so the
    // same chord canonicalizes identically regardless of press order (keeps `sameCodes` correct).
    (a, b) => (CODE_RANK[a] ?? 100) - (CODE_RANK[b] ?? 100) || a.localeCompare(b),
  );
}

/** Value-equality for two canonical code lists. */
export function sameCodes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
