// Theme resolution: the persisted setting is "dark" | "light" | "auto", the DOM only
// ever sees the two concrete tokens (app.css [data-theme="…"]). "auto" follows the OS
// via prefers-color-scheme — WebView2 reflects the Windows app mode, WebKitGTK the
// desktop color-scheme — so a light-mode machine gets a light app out of the box.
// Every webview (main, chip, quick-add) resolves independently: same OS, same answer.
//
// Signal colour: the accent is hue-only. `settings.accentHue` (0–360) picks the hue;
// lightness and chroma are fixed per theme and the concrete tokens are derived here in
// OKLCH and stamped inline on <html> by `applyTheme` — which is why every caller sets
// the hue (`setAccentHue`) BEFORE stamping the theme, and why an OS scheme flip under
// "auto" re-derives the light/dark variant for free. The default hue (65 = the amber
// app.css hand-tunes) removes the inline overrides instead of recomputing them, so the
// stock look stays byte-identical to the stylesheet.
//
// Only the accent moves. Recording red, live green and the working hues are fixed; the
// translating stage keeps its own hue (185, teal) unless the accent sits on it, in which
// case that stage rotates to violet (275) so the chip's dot stays unambiguous. The
// thinking blue (240) never rotates — an accent near it is merely disclosed in Settings.

import type { ThemeName } from "./types";

const LIGHT_MQ = "(prefers-color-scheme: light)";

export function resolvedTheme(t: ThemeName): "dark" | "light" {
  if (t !== "auto") return t;
  return window.matchMedia(LIGHT_MQ).matches ? "light" : "dark";
}

/* ── Signal colour (accent hue) ───────────────────────────────────────── */

/** The amber app.css defines by hand; `applyTheme` stamps nothing for it. */
export const DEFAULT_ACCENT_HUE = 65;

/** Preset swatches, in Settings order: [name, hue]. */
export const ACCENT_PRESETS: ReadonlyArray<readonly [name: string, hue: number]> = [
  ["Amber", 65],
  ["Teal", 185],
  ["Sky", 235],
  ["Indigo", 275],
  ["Lilac", 305],
  ["Rose", 350],
];

/** Hue of the translating stage (teal), and where it goes when the accent sits on it. */
const TRANSLATE_HUE = 185;
const TRANSLATE_ALT_HUE = 275;
/** Hue of the thinking blue — disclosed only, never rotated. */
const THINK_HUE = 240;
/** Angular distance within which two hues stop reading as different colours. */
const COLLISION_DEG = 35;

/** OKLCH → sRGB hex, gamut-clipped per channel (a pastel-enough L/C never clips much). */
export function oklchHex(L: number, C: number, h: number): string {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const f = (x: number) => {
    x = Math.max(0, Math.min(1, x));
    x = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + f(r) + f(g) + f(bb);
}

function hexChannels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a #rrggbb colour. */
export function lum(hex: string): number {
  const [r, g, b] = hexChannels(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function alpha(hex: string, a: number): string {
  const [r, g, b] = hexChannels(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Which fixed stage hue a Signal colour sits on, if any. "translate" also means
 *  the translating stage has rotated to violet; "think" is disclosure only. */
export function accentCollision(hue: number): "translate" | "think" | null {
  if (hueDist(hue, TRANSLATE_HUE) < COLLISION_DEG) return "translate";
  if (hueDist(hue, THINK_HUE) < COLLISION_DEG) return "think";
  return null;
}

export interface DerivedAccent {
  accent: string;
  /** Text on accent fills — flips with the accent's luminance (a lime needs dark ink). */
  ink: string;
  soft: string;
  glowA: string;
  glowB: string;
  glow0: string;
  /** The translating stage's colour for this accent (rotated away on a collision). */
  translate: string;
  /** A slightly deeper cut of the accent for chart marks: the dictation series and the
   *  activity calendar (`--c-chart-dict`), so they retint with the Signal colour. */
  chart: string;
}

/** The concrete tokens for a hue in one theme. Pure; the Settings swatches call it too. */
export function deriveAccent(hue: number, dark: boolean): DerivedAccent {
  const h = ((hue % 360) + 360) % 360;
  const accent = dark ? oklchHex(0.78, 0.17, h) : oklchHex(0.58, 0.15, h);
  const trH = accentCollision(h) === "translate" ? TRANSLATE_ALT_HUE : TRANSLATE_HUE;
  return {
    accent,
    ink: lum(accent) > 0.4 ? "#1a1207" : "#fff8ec",
    soft: alpha(accent, dark ? 0.14 : 0.12),
    glowA: alpha(accent, dark ? 0.09 : 0.05),
    glowB: alpha(accent, dark ? 0.05 : 0.03),
    glow0: alpha(accent, 0),
    translate: dark ? oklchHex(0.78, 0.12, trH) : oklchHex(0.55, 0.12, trH),
    chart: dark ? oklchHex(0.66, 0.15, h) : oklchHex(0.55, 0.15, h),
  };
}

/** The inline custom properties a non-default hue stamps; cleared for the default. */
const ACCENT_VARS = [
  "--c-accent",
  "--c-accent-ink",
  "--c-accent-soft",
  "--c-glow-a",
  "--c-glow-b",
  "--c-glow-0",
  "--c-translate",
  "--c-chart-dict",
  "--spk-1",
  "--spk-6",
] as const;

let accentHue = DEFAULT_ACCENT_HUE;

/** Set the Signal colour for the next `applyTheme` (module state: every webview owns
 *  one document, and the hue arrives with the same settings load as the theme). */
export function setAccentHue(hue: number): void {
  accentHue = Number.isFinite(hue) ? hue : DEFAULT_ACCENT_HUE;
}

/** Stamp the derived accent tokens for the resolved theme, or clear them for the default
 *  hue so app.css's hand-tuned amber applies untouched. */
function applyAccent(dark: boolean): void {
  const style = document.documentElement.style;
  if (accentHue === DEFAULT_ACCENT_HUE) {
    for (const v of ACCENT_VARS) style.removeProperty(v);
    return;
  }
  const d = deriveAccent(accentHue, dark);
  style.setProperty("--c-accent", d.accent);
  style.setProperty("--c-accent-ink", d.ink);
  style.setProperty("--c-accent-soft", d.soft);
  style.setProperty("--c-glow-a", d.glowA);
  style.setProperty("--c-glow-b", d.glowB);
  style.setProperty("--c-glow-0", d.glow0);
  style.setProperty("--c-translate", d.translate);
  style.setProperty("--c-chart-dict", d.chart);
  style.setProperty("--spk-1", d.accent); // speaker 1 IS the accent
  style.setProperty("--spk-6", d.translate); // speaker 6 IS the translate hue
}

/** Stamp the resolved theme on the document root (the only place data-theme is set),
 *  then the Signal colour derived for that theme. */
export function applyTheme(t: ThemeName): void {
  const resolved = resolvedTheme(t);
  document.documentElement.dataset.theme = resolved;
  applyAccent(resolved === "dark");
}

/** Re-apply on live OS scheme changes while `get()` says "auto". Returns the cleanup. */
export function watchSystemTheme(get: () => ThemeName): () => void {
  const mq = window.matchMedia(LIGHT_MQ);
  const onChange = () => {
    if (get() === "auto") applyTheme("auto");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
