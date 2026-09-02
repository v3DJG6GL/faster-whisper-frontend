// Theme resolution: the persisted setting is "dark" | "light" | "auto", the DOM only
// ever sees the two concrete tokens (app.css [data-theme="…"]). "auto" follows the OS
// via prefers-color-scheme — WebView2 reflects the Windows app mode, WebKitGTK the
// desktop color-scheme — so a light-mode machine gets a light app out of the box.
// Every webview (main, chip, quick-add, picker) resolves independently: same OS, same answer.
//
// Signal colour: the accent is hue-only. `settings.accentHue` (0–360) picks the hue;
// lightness and chroma are fixed per theme and the concrete tokens are derived here in
// OKLCH and stamped inline on <html> by `applyTheme` — which is why every caller sets
// the hue (`setAccentHue`) and the motion (`setAccentMotion`) BEFORE stamping the theme,
// and why an OS scheme flip under "auto" re-derives the light/dark variant for free. The
// default hue (65 = the amber app.css hand-tunes) removes the inline overrides instead of
// recomputing them, so the stock look stays byte-identical to the stylesheet.
//
// The accent tints CHROME ONLY: buttons, selection, focus, chosen chips, route text, the
// ambient glow. Everything that carries state OR identity is a fixed app.css token the
// accent never touches — armed amber (--c-armed), live green, thinking blue, translating
// teal, recording red, off grey, the stage hues, the speaker palette and the chart kind
// colours (--c-chart-dict/-file/-link/-text: a rose accent must not make Dictation and
// Links the same series).
// That is what makes the next part safe.
//
// Motion: `settings.accentMotion` lets the Signal colour travel around the wheel (or
// breathe along the short arc to a second hue) on a chosen period. Every window derives
// hue(t) from the WALL CLOCK — hue = base + 360 · ((t mod period) / period) — so the main
// window, chip, quick-add and picker agree by construction without any message between
// them, even when opened minutes apart. `startAccentDrift` runs one timer per window that
// ticks once per degree of hue (clamped 250 ms … 30 s) and restamps the tokens through the
// same engine; the persisted `accentHue` is never touched — it is the base the drift
// starts from. `prefers-reduced-motion` forces Still (period 0) and Settings says so.

import type { ThemeName } from "./types";

const LIGHT_MQ = "(prefers-color-scheme: light)";
const REDUCED_MOTION_MQ = "(prefers-reduced-motion: reduce)";

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

function alpha(hex: string, a: number): string {
  const [r, g, b] = hexChannels(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface DerivedAccent {
  accent: string;
  /** The Rhythm calendar's four steps (`--c-cal-1..4`): one hue, fixed L/C per theme, so
   *  the ramp stays a single-hue sequential scale whatever the Signal colour (D27–D29). */
  cal: [string, string, string, string];
  /** Text on accent fills — flips with the accent's luminance (a lime needs dark ink). */
  ink: string;
  soft: string;
  glowA: string;
  glowB: string;
  glow0: string;
}

/** Calendar steps, [L, C] per step; at Amber (65°) they land on the app.css hexes. */
const CAL_STEPS_DARK: ReadonlyArray<readonly [number, number]> = [[0.33, 0.07], [0.46, 0.1], [0.6, 0.14], [0.72, 0.16]];
const CAL_STEPS_LIGHT: ReadonlyArray<readonly [number, number]> = [[0.84, 0.07], [0.74, 0.11], [0.62, 0.14], [0.47, 0.13]];

/** The concrete tokens for a hue in one theme. Pure; the Settings swatches call it too. */
export function deriveAccent(hue: number, dark: boolean): DerivedAccent {
  const h = ((hue % 360) + 360) % 360;
  const accent = dark ? oklchHex(0.78, 0.17, h) : oklchHex(0.58, 0.15, h);
  const cal = (dark ? CAL_STEPS_DARK : CAL_STEPS_LIGHT).map(([L, C]) => oklchHex(L, C, h)) as DerivedAccent["cal"];
  return {
    accent,
    cal,
    ink: lum(accent) > 0.4 ? "#1a1207" : "#fff8ec",
    soft: alpha(accent, dark ? 0.14 : 0.12),
    glowA: alpha(accent, dark ? 0.09 : 0.05),
    glowB: alpha(accent, dark ? 0.05 : 0.03),
    glow0: alpha(accent, 0),
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
  "--c-cal-1",
  "--c-cal-2",
  "--c-cal-3",
  "--c-cal-4",
] as const;

/* ── Motion (the pure arithmetic every window runs) ───────────────────── */

export interface AccentMotion {
  /** Seconds per full turn of the wheel (or per breath, for an arc). 0 = Still. */
  period: number;
  range: "wheel" | "arc";
  /** The near end of the arc, when `range` is "arc". Absent = the Signal colour (older
   *  blobs, where the arc started from `accentHue`). */
  arcFrom?: number;
  /** The far end of the arc, when `range` is "arc". Absent = the Rose preset. */
  arcHue?: number;
}

export const DEFAULT_ACCENT_MOTION: AccentMotion = { period: 0, range: "wheel" };
/** The custom slider's span: 30 s … 7 d. Presets sit inside it. */
export const MOTION_MIN_PERIOD = 30;
export const MOTION_MAX_PERIOD = 604800;
/** Where an arc goes when no second colour was chosen (Rose, the last preset). */
export const DEFAULT_ARC_HUE = 350;

/** Is this a motion the engine will actually run? Period 0 is Still; anything else must
 *  be a finite number of seconds inside the slider's span, the range one of the two. */
export function isValidAccentMotion(m: unknown): m is AccentMotion {
  if (!m || typeof m !== "object") return false;
  const { period, range, arcHue, arcFrom } = m as Record<string, unknown>;
  if (typeof period !== "number" || !Number.isFinite(period)) return false;
  if (period !== 0 && (period < MOTION_MIN_PERIOD || period > MOTION_MAX_PERIOD)) return false;
  if (range !== "wheel" && range !== "arc") return false;
  const okHue = (h: unknown) =>
    h === undefined || (typeof h === "number" && Number.isFinite(h) && h >= 0 && h <= 360);
  return okHue(arcHue) && okHue(arcFrom);
}

/** Where in the turn the wall clock says we are: 0 ≤ phase < 1. Every window computes
 *  this from `Date.now()`, which is the whole synchronisation story. */
export function motionPhase(nowMs: number, period: number): number {
  if (!(period > 0)) return 0;
  const sec = nowMs / 1000;
  return (((sec % period) + period) % period) / period;
}

/** The hue at `nowMs` for a base hue and a motion. Pure — the driver and the tests share
 *  it. "wheel" sweeps the full circle from the base; "arc" breathes along the SHORT arc
 *  between `arcFrom` (the base when absent) and `arcHue` with an ease-in-out ((1 − cos)/2),
 *  so it lingers at both ends the way a lamp does. Period 0 returns the base untouched. */
export function driftHue(base: number, motion: AccentMotion, nowMs: number): number {
  const { period } = motion;
  if (!(period > 0)) return base;
  const ph = motionPhase(nowMs, period);
  if (motion.range === "wheel") return (base + 360 * ph) % 360;
  const near = motion.arcFrom ?? base;
  const far = motion.arcHue ?? DEFAULT_ARC_HUE;
  // Signed shortest angular distance, in (−180, 180].
  const d = ((((far - near) % 360) + 540) % 360) - 180;
  const e = (1 - Math.cos(2 * Math.PI * ph)) / 2;
  return ((((near + d * e) % 360) + 360) % 360);
}

/** How often the driver restamps the tokens: once per degree of hue, but never faster
 *  than 250 ms (a 90-second turn is already 4 fps) nor slower than 30 s (so a 7-day turn
 *  still visibly moves within a sitting and a theme flip is never seconds stale). */
export function driftTickMs(period: number): number {
  return Math.max(250, Math.min(30000, Math.round((period * 1000) / 360)));
}

/** Does the OS ask for reduced motion? Safe to call without a DOM (tests, SSR-ish). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_MQ)?.matches ?? false;
}

/** The motion the engine will run: Still under reduced motion, the setting otherwise. */
export function effectiveMotion(m: AccentMotion, reduced: boolean): AccentMotion {
  return reduced || !(m.period > 0) ? { ...m, period: 0 } : m;
}

/* ── The custom-speed slider (Settings) ───────────────────────────────── */

const LOG_MIN = Math.log(MOTION_MIN_PERIOD);
const LOG_MAX = Math.log(MOTION_MAX_PERIOD);
/** Slider position 0…1000 → seconds per turn, log scale: 0 = 30 s, 1000 = 7 d. */
export function sliderToSec(v: number): number {
  return Math.round(Math.exp(LOG_MIN + ((LOG_MAX - LOG_MIN) * v) / 1000));
}
/** The inverse, so a stored period puts the thumb where it was. */
export function secToSlider(s: number): number {
  const c = Math.max(MOTION_MIN_PERIOD, Math.min(MOTION_MAX_PERIOD, s));
  return Math.round(((Math.log(c) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000);
}
/** "one turn every 2.3 h" — the Settings readout and the "Right now" note. */
export function fmtPer(s: number): string {
  if (s < 60) return `one turn every ${s} s`;
  if (s < 3600) return `one turn every ${Math.round((s / 60) * 10) / 10} min`;
  if (s < 86400) return `one turn every ${Math.round((s / 3600) * 10) / 10} h`;
  return `one turn every ${Math.round((s / 86400) * 10) / 10} d`;
}

/* ── Per-window engine state ──────────────────────────────────────────── */

let accentHue = DEFAULT_ACCENT_HUE;
let accentMotion: AccentMotion = DEFAULT_ACCENT_MOTION;
/** The theme the last `applyTheme` resolved to, so a drift tick derives the right cut. */
let currentDark = true;
/** The hue the tokens currently show (integer degrees; the base while Still). */
let shownHue = DEFAULT_ACCENT_HUE;
const listeners = new Set<(hue: number) => void>();

/** Set the Signal colour for the next `applyTheme` (module state: every webview owns
 *  one document, and the hue arrives with the same settings load as the theme). */
export function setAccentHue(hue: number): void {
  accentHue = Number.isFinite(hue) ? hue : DEFAULT_ACCENT_HUE;
}

/** Set the motion for the next `applyTheme`; reschedules a running driver. */
export function setAccentMotion(m: AccentMotion | undefined): void {
  accentMotion = isValidAccentMotion(m) ? m : DEFAULT_ACCENT_MOTION;
  if (driverRunning) schedule();
}

/** The hue the tokens show right now (the base while Still; the drifted one otherwise). */
export function currentAccentHue(): number {
  return shownHue;
}

/** Be told on every restamp (each drift tick, each theme apply) what hue is showing.
 *  Settings' "Right now" row is the one subscriber. Returns the unsubscribe. */
export function subscribeAccentHue(fn: (hue: number) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The hue for this instant: the base, drifted by the effective motion and rounded to a
 *  whole degree — one degree is below the just-noticeable difference, and rounding keeps
 *  the "default hue stamps nothing" shortcut alive as a wheel sweeps past 65. */
function hueNow(): number {
  const m = effectiveMotion(accentMotion, prefersReducedMotion());
  return Math.round(driftHue(accentHue, m, Date.now())) % 360;
}

/** Stamp the derived accent tokens for the resolved theme, or clear them for the default
 *  hue so app.css's hand-tuned amber applies untouched. */
function applyAccent(dark: boolean): void {
  stampHue(hueNow(), dark);
}

function stampHue(hue: number, dark: boolean): void {
  shownHue = hue;
  const style = document.documentElement.style;
  if (hue === DEFAULT_ACCENT_HUE) {
    for (const v of ACCENT_VARS) style.removeProperty(v);
  } else {
    const d = deriveAccent(hue, dark);
    style.setProperty("--c-accent", d.accent);
    style.setProperty("--c-accent-ink", d.ink);
    style.setProperty("--c-accent-soft", d.soft);
    style.setProperty("--c-glow-a", d.glowA);
    style.setProperty("--c-glow-b", d.glowB);
    style.setProperty("--c-glow-0", d.glow0);
    d.cal.forEach((hex, i) => style.setProperty(`--c-cal-${i + 1}`, hex));
  }
  for (const fn of listeners) fn(hue);
}

/** Stamp the resolved theme on the document root (the only place data-theme is set),
 *  then the Signal colour derived for that theme at this instant. */
export function applyAccentAndTheme(hue: number | undefined, motion: AccentMotion | undefined, theme: ThemeName): void {
  setAccentHue(hue ?? DEFAULT_ACCENT_HUE);
  setAccentMotion(motion);
  applyTheme(theme);
}

export function applyTheme(t: ThemeName): void {
  const resolved = resolvedTheme(t);
  document.documentElement.dataset.theme = resolved;
  currentDark = resolved === "dark";
  applyAccent(currentDark);
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

/* ── The drift driver (one per window) ────────────────────────────────── */

let driverRunning = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** (Re)arm the tick for the effective motion: Still stamps the base once and idles;
 *  anything else restamps every `driftTickMs`. Called whenever the motion, the reduced-
 *  motion preference or the driver's own lifetime changes. */
function schedule(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  const m = effectiveMotion(accentMotion, prefersReducedMotion());
  applyAccent(currentDark);
  if (m.period > 0) timer = setInterval(() => applyAccent(currentDark), driftTickMs(m.period));
}

/** Start this window's drift clock. Idempotent — a second call while running is a no-op
 *  that still returns a working stop. The driver honours `prefers-reduced-motion` live
 *  (a change forces Still or resumes the setting) and needs no message from any other
 *  window: each one runs the same clock arithmetic on the same `accentMotion`. */
export function startAccentDrift(): () => void {
  if (driverRunning) return stopAccentDrift;
  driverRunning = true;
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_MQ)
    : null;
  const onReduced = () => schedule();
  mq?.addEventListener?.("change", onReduced);
  reducedCleanup = () => mq?.removeEventListener?.("change", onReduced);
  schedule();
  return stopAccentDrift;
}

let reducedCleanup: (() => void) | null = null;

/** Stop the timer and put the base hue back (so a window that unmounts the driver does
 *  not freeze mid-drift on some arbitrary hue). */
function stopAccentDrift(): void {
  if (!driverRunning) return;
  driverRunning = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  reducedCleanup?.();
  reducedCleanup = null;
  // The setting itself is untouched: a later start resumes it from the clock.
  stampHue(((Math.round(accentHue) % 360) + 360) % 360, currentDark);
}

/** Test seam: reset module state between cases. */
export function _resetThemeEngineForTests(): void {
  stopAccentDrift();
  accentHue = DEFAULT_ACCENT_HUE;
  accentMotion = DEFAULT_ACCENT_MOTION;
  currentDark = true;
  shownHue = DEFAULT_ACCENT_HUE;
  listeners.clear();
}
