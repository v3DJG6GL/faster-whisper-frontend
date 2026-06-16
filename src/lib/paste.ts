// Paste-shortcut presets, shared by Settings (global default) and the per-app rules
// editor. Stored as KeyboardEvent.code chords; the Rust paste paths map them to evdev
// keycodes (Wayland) / enigo keys (X11). Terminals (Konsole, kitty…) need Ctrl+Shift+V.

export const DEFAULT_PASTE_SHORTCUT = ["ControlLeft", "KeyV"];

export const PASTE_PRESETS: { value: string; label: string; codes: string[] }[] = [
  { value: "ctrl-v", label: "Ctrl + V", codes: ["ControlLeft", "KeyV"] },
  { value: "ctrl-shift-v", label: "Ctrl + Shift + V (terminals)", codes: ["ControlLeft", "ShiftLeft", "KeyV"] },
  { value: "shift-insert", label: "Shift + Insert", codes: ["ShiftLeft", "Insert"] },
];

/** The preset key for a chord (falls back to ctrl-v if unrecognized). */
export function pasteKey(codes: string[] | null | undefined): string {
  return PASTE_PRESETS.find((p) => p.codes.join("+") === (codes ?? []).join("+"))?.value ?? "ctrl-v";
}

/** The codes for a preset key (falls back to Ctrl+V). */
export function pasteCodes(key: string): string[] {
  return PASTE_PRESETS.find((p) => p.value === key)?.codes ?? DEFAULT_PASTE_SHORTCUT;
}

/** A human label for a chord (for read-only display). */
export function pasteLabel(codes: string[] | null | undefined): string {
  return PASTE_PRESETS.find((p) => p.value === pasteKey(codes))?.label ?? "Ctrl + V";
}
