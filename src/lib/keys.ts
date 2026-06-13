// Keyboard mapping for hotkey capture + display.
//
// Bindings are stored as accelerator strings ("Ctrl+Shift+Numpad0") that the Rust
// global-shortcut plugin parses (global-hotkey's `parse_hotkey`). That parser
// accepts the uppercased W3C `KeyboardEvent.code` for the key part (KEYH, DIGIT1,
// BACKSPACE, ARROWUP, NUMPAD0, F1–F24, numpad operators, …) plus friendly aliases,
// and logical modifiers (Ctrl/Alt/Shift/Super) — it can NOT distinguish left/right
// modifiers (that needs the evdev backend, P5). Punctuation/symbol codes (Minus,
// BracketLeft, Backquote, IntlBackslash, …) and ContextMenu aren't supported and
// are rejected here; `validateShortcut` is the final gate in the Rust layer.

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

/** Is this `event.key` a bare modifier (no real key pressed yet)? */
export function isModifierKey(key: string): boolean {
  return key === "Control" || key === "Shift" || key === "Alt" ||
    key === "Meta" || key === "AltGraph";
}

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

/** Split an accelerator ("Ctrl+Numpad0") into prettified display tokens. */
export function accelToLabels(accel: string): string[] {
  return accel.split("+").map(prettyToken);
}
