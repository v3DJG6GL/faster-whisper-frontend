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
