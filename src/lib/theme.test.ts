// The Signal-colour engine. The test environment is node (no jsdom), so the DOM side
// of `applyTheme` runs against a minimal stand-in document; the derivations are pure.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HUE,
  accentCollision,
  applyTheme,
  deriveAccent,
  lum,
  oklchHex,
  setAccentHue,
} from "./theme";

describe("deriveAccent", () => {
  it("ink flips with the accent's luminance", () => {
    // A light lime reads dark ink; a deep indigo on the light theme reads light ink.
    expect(deriveAccent(120, true).ink).toBe("#1a1207");
    expect(deriveAccent(275, false).ink).toBe("#fff8ec");
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
});

describe("accentCollision", () => {
  it("flags the translating teal within 35° and rotates that stage to violet", () => {
    const teal = deriveAccent(65, true).translate;
    for (const h of [185, 151, 219]) {
      expect(accentCollision(h)).toBe("translate");
      expect(deriveAccent(h, true).translate).not.toBe(teal);
      expect(deriveAccent(h, true).translate).toBe(oklchHex(0.78, 0.12, 275));
    }
  });

  it("220 is the thinking blue's neighbourhood, not the teal's", () => {
    expect(accentCollision(220)).toBe("think");
    expect(deriveAccent(220, true).translate).toBe(deriveAccent(65, true).translate);
  });

  it("the amber default and the rose preset collide with nothing", () => {
    expect(accentCollision(65)).toBeNull();
    expect(accentCollision(350)).toBeNull();
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
    vi.unstubAllGlobals();
    props.clear();
    setAccentHue(DEFAULT_ACCENT_HUE);
  });

  it("a custom hue stamps the tokens for the resolved theme; the default clears them", () => {
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    setAccentHue(275);
    applyTheme("auto");
    expect(dataset.theme).toBe("light");
    expect(props.get("--c-accent")).toBe(deriveAccent(275, false).accent);
    expect(props.get("--spk-1")).toBe(props.get("--c-accent"));
    expect(props.get("--spk-6")).toBe(props.get("--c-translate"));
    expect(props.get("--c-translate")).toBe(deriveAccent(275, false).translate);

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
});
