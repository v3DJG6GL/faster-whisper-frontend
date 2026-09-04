// The Signal-colour engine. The test environment is node (no jsdom), so the DOM side
// of `applyTheme` runs against a minimal stand-in document; the derivations and the
// drift arithmetic are pure.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HUE,
  DEFAULT_ARC_HUE,
  MOTION_MAX_PERIOD,
  MOTION_MIN_PERIOD,
  _resetThemeEngineForTests,
  applyTheme,
  currentAccentHue,
  deriveAccent,
  driftHue,
  driftTickMs,
  effectiveMotion,
  fmtPer,
  isValidAccentMotion,
  lum,
  motionPhase,
  secToSlider,
  setAccentHue,
  setAccentMotion,
  sliderToSec,
  startAccentDrift,
  subscribeAccentHue,
} from "./theme";

describe("deriveAccent", () => {
  it("ink is constant per theme (dark ink on the bright dark-theme accent, light ink on the dim light-theme accent)", () => {
    expect(deriveAccent(120, true).ink).toBe("#1a1207");
    expect(deriveAccent(275, false).ink).toBe("#fff8ec");
  });

  it("ink never changes within a theme across the full hue wheel", () => {
    for (let h = 0; h < 360; h++) {
      expect(deriveAccent(h, true).ink).toBe("#1a1207");
      expect(deriveAccent(h, false).ink).toBe("#fff8ec");
    }
  });

  it("the six presets are six distinct accents in both themes", () => {
    for (const dark of [true, false]) {
      const hexes = ACCENT_PRESETS.map(([, h]) => deriveAccent(h, dark).accent);
      expect(new Set(hexes).size).toBe(6);
      for (const hex of hexes) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("wraps hues past 360 and below 0", () => {
    expect(deriveAccent(425, true).accent).toBe(deriveAccent(65, true).accent);
    expect(deriveAccent(-10, true).accent).toBe(deriveAccent(350, true).accent);
  });

  it("the light theme is darker than the dark theme's accent (ink contrast)", () => {
    expect(lum(deriveAccent(65, false).accent)).toBeLessThan(lum(deriveAccent(65, true).accent));
  });

  it("derives chrome only — no state or stage colour comes out of the engine", () => {
    // D13′: the translating stage, the speaker palette and the armed amber are fixed
    // app.css tokens; the accent must not be able to move them.
    expect(Object.keys(deriveAccent(185, true)).sort()).toEqual(
      ["accent", "cal", "glow0", "glowA", "glowB", "ink", "soft"],
    );
  });

  it("the calendar steps are a single-hue ramp ordered by lightness, near the amber hexes at 65°", () => {
    // Dark: darker → brighter; light: lighter → deeper (the deepest step is the busiest day).
    const dark = deriveAccent(65, true).cal;
    const light = deriveAccent(65, false).cal;
    for (let i = 1; i < 4; i++) {
      expect(lum(dark[i])).toBeGreaterThan(lum(dark[i - 1]));
      expect(lum(light[i])).toBeLessThan(lum(light[i - 1]));
    }
    // The un-stamped defaults in app.css are the same recipe at Amber: within a few
    // percent of luminance, so the default look does not move when the engine stamps.
    const near = (a: string, b: string) => Math.abs(lum(a) - lum(b)) < 0.03;
    expect(["#4a3418", "#7a4f14", "#ad6b0c", "#e0900e"].every((hex, i) => near(hex, dark[i]))).toBe(true);
    expect(["#e9c7a0", "#d9a061", "#c37a2a", "#9a4f00"].every((hex, i) => near(hex, light[i]))).toBe(true);
    // Another hue keeps the same lightness order with different hexes.
    expect(deriveAccent(185, true).cal).not.toEqual(dark);
  });
});

describe("motion arithmetic", () => {
  it("phase is the wall clock modulo the period, in [0, 1)", () => {
    expect(motionPhase(0, 300)).toBe(0);
    expect(motionPhase(150_000, 300)).toBeCloseTo(0.5);
    expect(motionPhase(300_000, 300)).toBe(0);
    expect(motionPhase(375_000, 300)).toBeCloseTo(0.25);
    expect(motionPhase(1234, 0)).toBe(0);
  });

  it("the wheel sweeps the full circle from the base, and Still returns the base", () => {
    const wheel = { period: 300, range: "wheel" as const };
    expect(driftHue(65, wheel, 0)).toBe(65);
    expect(driftHue(65, wheel, 75_000)).toBeCloseTo(155);
    expect(driftHue(65, wheel, 150_000)).toBeCloseTo(245);
    expect(driftHue(65, wheel, 225_000)).toBeCloseTo(335);
    expect(driftHue(65, wheel, 270_000)).toBeCloseTo(29); // wrapped past 360
    expect(driftHue(65, { period: 0, range: "wheel" }, 999_999)).toBe(65);
  });

  it("every window agrees: the hue depends on the clock, not on when the window opened", () => {
    const m = { period: 180, range: "wheel" as const };
    // A chip opened 47 s after the main window computes the same hue for the same instant.
    expect(driftHue(65, m, 1_700_000_047_000)).toBe(driftHue(65, m, 1_700_000_047_000));
    expect(driftHue(65, m, 1_700_000_047_000)).not.toBe(driftHue(65, m, 1_700_000_000_000));
  });

  it("an arc breathes along the SHORT way round, in both directions", () => {
    // Amber (65) → Rose (350): the short arc goes backwards through red (−75°), not
    // forwards through green/blue (+285°).
    const down = { period: 100, range: "arc" as const, arcHue: 350 };
    expect(driftHue(65, down, 0)).toBe(65);
    expect(driftHue(65, down, 50_000)).toBeCloseTo(350); // the far end at half a breath
    expect(driftHue(65, down, 25_000)).toBeCloseTo(65 - 37.5); // halfway, eased
    expect(driftHue(65, down, 100_000)).toBeCloseTo(65);
    // Rose (350) → Amber (65): the same arc walked the other way (+75°).
    const up = { period: 100, range: "arc" as const, arcHue: 65 };
    expect(driftHue(350, up, 50_000)).toBeCloseTo(65);
    expect(driftHue(350, up, 25_000)).toBeCloseTo((350 + 37.5) % 360);
  });

  it("an arc with its own near end ignores the Signal colour", () => {
    // Motion greys the Signal colour out, so the arc's two ends are the arc's own.
    const m = { period: 100, range: "arc" as const, arcFrom: 185, arcHue: 235 };
    expect(driftHue(65, m, 0)).toBe(185);
    expect(driftHue(65, m, 50_000)).toBeCloseTo(235);
    expect(driftHue(65, m, 100_000)).toBeCloseTo(185);
  });

  it("an arc eases in and out: it lingers at both ends", () => {
    const m = { period: 100, range: "arc" as const, arcHue: 185 }; // 65 → 185, +120
    const at = (s: number) => driftHue(65, m, s * 1000) - 65;
    // The first tenth of the breath moves far less than the middle tenth.
    expect(at(10)).toBeLessThan(at(30) - at(20));
    expect(at(50)).toBeCloseTo(120);
  });

  it("an arc with no second colour goes to the Rose preset", () => {
    const m = { period: 100, range: "arc" as const };
    expect(driftHue(65, m, 50_000)).toBeCloseTo(DEFAULT_ARC_HUE);
  });

  it("ticks once per degree, clamped to 250 ms … 30 s", () => {
    expect(driftTickMs(300)).toBe(833); // 5 min: one degree every 0.83 s
    expect(driftTickMs(90)).toBe(250); // 90 s would be 4 fps — the floor
    expect(driftTickMs(30)).toBe(250);
    expect(driftTickMs(604_800)).toBe(30_000); // 7 d would be 28 min — the ceiling
    expect(driftTickMs(3600)).toBe(10_000);
  });

  it("reduced motion forces Still without touching the rest of the setting", () => {
    const m = { period: 300, range: "arc" as const, arcHue: 350 };
    expect(effectiveMotion(m, true)).toEqual({ period: 0, range: "arc", arcHue: 350 });
    expect(effectiveMotion(m, false)).toBe(m);
    expect(effectiveMotion({ period: 0, range: "wheel" }, false).period).toBe(0);
  });

  it("validates the shape a peer's blob may carry", () => {
    expect(isValidAccentMotion({ period: 0, range: "wheel" })).toBe(true);
    expect(isValidAccentMotion({ period: 300, range: "arc", arcHue: 350 })).toBe(true);
    expect(isValidAccentMotion({ period: 10, range: "wheel" })).toBe(false); // under 30 s
    expect(isValidAccentMotion({ period: 604_801, range: "wheel" })).toBe(false); // over 7 d
    expect(isValidAccentMotion({ period: Number.NaN, range: "wheel" })).toBe(false);
    expect(isValidAccentMotion({ period: 300, range: "spiral" })).toBe(false);
    expect(isValidAccentMotion({ period: 300, range: "arc", arcHue: 361 })).toBe(false);
    expect(isValidAccentMotion({ period: 300, range: "arc", arcFrom: 185, arcHue: 235 })).toBe(true);
    expect(isValidAccentMotion({ period: 300, range: "arc", arcFrom: -1, arcHue: 235 })).toBe(false);
    expect(isValidAccentMotion({ period: 300, range: "arc", arcHue: "350" })).toBe(false);
    expect(isValidAccentMotion(null)).toBe(false);
    expect(isValidAccentMotion("300")).toBe(false);
  });
});

describe("the custom-speed slider", () => {
  it("maps 0…1000 onto 30 s … 7 d on a log scale", () => {
    expect(sliderToSec(0)).toBe(MOTION_MIN_PERIOD);
    expect(sliderToSec(1000)).toBe(MOTION_MAX_PERIOD);
    // The geometric midpoint, not the arithmetic one: sqrt(30 · 604800) ≈ 4260 s.
    expect(sliderToSec(500)).toBe(Math.round(Math.sqrt(30 * 604_800)));
  });

  it("round-trips through secToSlider", () => {
    for (const v of [0, 137, 500, 812, 1000]) expect(secToSlider(sliderToSec(v))).toBe(v);
    expect(secToSlider(1)).toBe(0); // clamped into the span
    expect(secToSlider(10_000_000)).toBe(1000);
  });

  it("reads the period out in the largest sensible unit", () => {
    expect(fmtPer(30)).toBe("one turn every 30 s");
    expect(fmtPer(90)).toBe("one turn every 1.5 min");
    expect(fmtPer(300)).toBe("one turn every 5 min");
    expect(fmtPer(8280)).toBe("one turn every 2.3 h");
    expect(fmtPer(86_400)).toBe("one turn every 1 d");
    expect(fmtPer(604_800)).toBe("one turn every 7 d");
  });
});

describe("applyTheme + setAccentHue", () => {
  const props = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const fakeDocument = {
    documentElement: {
      dataset,
      style: {
        setProperty: (k: string, v: string) => void props.set(k, v),
        removeProperty: (k: string) => void props.delete(k),
      },
    },
  };
  afterEach(() => {
    _resetThemeEngineForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    props.clear();
  });

  it("a custom hue stamps the chrome tokens for the resolved theme; the default clears them", () => {
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    setAccentHue(275);
    applyTheme("auto");
    expect(dataset.theme).toBe("light");
    expect(props.get("--c-accent")).toBe(deriveAccent(275, false).accent);
    expect(props.get("--c-cal-4")).toBe(deriveAccent(275, false).cal[3]);
    // Fixed state and kind tokens are never stamped, whatever the hue.
    expect(props.has("--c-chart-dict")).toBe(false);
    expect(props.has("--c-translate")).toBe(false);
    expect(props.has("--spk-1")).toBe(false);
    expect(props.has("--c-armed")).toBe(false);

    applyTheme("dark");
    expect(props.get("--c-accent")).toBe(deriveAccent(275, true).accent);

    setAccentHue(DEFAULT_ACCENT_HUE);
    applyTheme("dark");
    expect(props.size).toBe(0);
  });

  it("a non-finite hue falls back to the default", () => {
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    setAccentHue(Number.NaN);
    applyTheme("light");
    expect(props.size).toBe(0);
  });

  it("the driver restamps from the clock and leaves the base hue alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }); // dark, motion allowed
    const seen: number[] = [];
    subscribeAccentHue((h) => seen.push(h));
    setAccentHue(65);
    setAccentMotion({ period: 360, range: "wheel" }); // one degree per second
    applyTheme("dark");
    expect(currentAccentHue()).toBe(65);
    const stop = startAccentDrift();
    vi.advanceTimersByTime(10_000);
    expect(currentAccentHue()).toBe(75);
    expect(props.get("--c-accent")).toBe(deriveAccent(75, true).accent);
    // A theme flip mid-drift re-derives the DRIFTED hue for the new theme.
    applyTheme("light");
    expect(props.get("--c-accent")).toBe(deriveAccent(75, false).accent);
    // Stopping puts the base back — the window never freezes on an arbitrary hue.
    stop();
    expect(currentAccentHue()).toBe(65);
    expect(seen.length).toBeGreaterThan(10);
  });

  it("reduced motion keeps the driver Still", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", {
      matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") }),
    });
    setAccentHue(65);
    setAccentMotion({ period: 360, range: "wheel" });
    applyTheme("dark");
    startAccentDrift();
    vi.advanceTimersByTime(10_000);
    expect(currentAccentHue()).toBe(65);
    expect(props.size).toBe(0); // the default hue, untouched
  });

  it("starting twice runs one clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    let ticks = 0;
    subscribeAccentHue(() => ticks++);
    setAccentMotion({ period: 360, range: "wheel" });
    applyTheme("dark");
    startAccentDrift();
    startAccentDrift();
    ticks = 0;
    vi.advanceTimersByTime(5_000);
    expect(ticks).toBe(5);
  });
});
