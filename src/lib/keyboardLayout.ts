// Layout-aware key LABELS (display only).
//
// `event.code` is the physical, US-QWERTY position of a key. A Swiss-German /
// QWERTZ user pressing the key labelled "Z" sends code "KeyY" — so a naive
// code→label map ("KeyY" → "Y") prints the wrong letter on their keycap. Global
// shortcuts bind by physical position (evdev scancodes / the global-hotkey parser),
// which is correct and layout-stable; it's only the *display* that must match the
// keycaps the user actually sees.
//
// WebKitGTK (the Tauri webview on Linux) doesn't implement the Keyboard Map API, so
// we can't ask the OS for the active layout. Instead we LEARN it: every letter key
// pressed reveals code→keycap, because `event.key` is the layout character. We
// persist the learned map (localStorage) and consult it when rendering chips.
//
// Why this is safe even mid-chord: `event.key` for a letter is that letter
// regardless of held Ctrl/Shift/Alt; AltGr-produced symbols aren't A–Z and so are
// filtered out. We only ever learn single A–Z letters (the keys QWERTZ actually
// swaps) — digits and punctuation are left to their physical labels.

const STORE_KEY = "fwf.keyLabels.v1";

let learned: Record<string, string> = load();

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* localStorage unavailable or malformed — start empty */
  }
  return {};
}

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(learned));
  } catch {
    /* ignore */
  }
}

/** Record code→keycap from a keypress, when it's an unambiguous letter key. */
export function learnLetter(code: string, key: string): void {
  if (!/^Key[A-Z]$/.test(code) || !/^[a-zA-Z]$/.test(key)) return;
  const label = key.toUpperCase();
  if (learned[code] === label) return;
  learned = { ...learned, [code]: label };
  persist();
}

/** The user's keycap label for a physical code, or null if not yet learned. */
export function keycapLabel(code: string): string | null {
  return learned[code] ?? null;
}

/** Prefill from the Keyboard Map API when present (Chromium webviews — a no-op on
 *  WebKitGTK), and attach a passive learner so even pre-existing bindings start
 *  showing the right keycaps once the user types a few letters anywhere. Idempotent
 *  and cheap; call once per window at startup. */
export function initKeyboardLayout(): void {
  if (typeof window === "undefined") return;
  const kb = (navigator as unknown as {
    keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> };
  }).keyboard;
  kb?.getLayoutMap?.()
    .then((map) => map.forEach((value, code) => learnLetter(code, value)))
    .catch(() => {
      /* API unsupported (WebKitGTK) — the passive learner covers it */
    });
  // Unmodified / Shift-only letter presses reveal the layout during normal typing.
  // (Mid-chord presses hold Ctrl/Alt and are caught directly in useHotkeyCapture.)
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.getModifierState?.("AltGraph")) return;
      learnLetter(e.code, e.key);
    },
    true,
  );
}
