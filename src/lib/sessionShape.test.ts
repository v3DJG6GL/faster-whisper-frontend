import { describe, expect, it } from "vitest";
import { sessionShape } from "./sessionShape";
import type { Backend, Profile } from "./types";

const backend = (over: Partial<Backend> = {}): Backend =>
  ({ id: "b1", name: "b1", serverUrl: "http://x", hasApiKey: false, model: "", endpoint: "stream", language: "auto", prompt: "", responseFormat: "verbose_json", ...over }) as Backend;
const profile = (over: Partial<Profile> = {}): Profile =>
  ({ id: "p", name: "p", activation: "hold", enabled: true, hotkey: [], backendId: "b1", ...over }) as Profile;

describe("sessionShape", () => {
  it("matches for the designed family: same session, different activation/typing/label", () => {
    const hold = profile({ id: "ptt", name: "PTT", activation: "hold", typeAsISpeak: false });
    const free = profile({ id: "hf", name: "Latch", activation: "handsfree", typeAsISpeak: true, tag: "L", insertionOverrides: {} });
    expect(sessionShape(hold, backend())).toBe(sessionShape(free, backend()));
  });

  it("differs on another backend (the unreachable-server case)", () => {
    expect(sessionShape(profile(), backend())).not.toBe(sessionShape(profile(), backend({ id: "b2" })));
  });

  it("differs on language, resolved against the backend", () => {
    const b = backend({ language: "de" });
    expect(sessionShape(profile({ language: "en" }), b)).not.toBe(sessionShape(profile(), b));
    // an override equal to the inherited value is the same session
    expect(sessionShape(profile({ language: "de" }), b)).toBe(sessionShape(profile(), b));
  });

  it("differs on endpoint, prompt, decode and translation overrides, and the target picker", () => {
    const base = sessionShape(profile(), backend());
    for (const over of [
      { endpoint: "batch" },
      { prompt: "Hi" },
      { decodeOverrides: { hotwords: "x" } },
      { translationOverrides: { translateTo: ["fr"] } },
      { askTranslationTargets: true },
      { overrideProfile: "x" },
      { model: "large-v3" },
    ] as Partial<Profile>[]) {
      expect(sessionShape(profile(over), backend()), JSON.stringify(over)).not.toBe(base);
    }
  });

  it("ignores override key order", () => {
    const a = profile({ decodeOverrides: { hotwords: "x", condition_on_previous_text: true } });
    const b = profile({ decodeOverrides: { condition_on_previous_text: true, hotwords: "x" } });
    expect(sessionShape(a, backend())).toBe(sessionShape(b, backend()));
  });

  it("is null without a backend", () => {
    expect(sessionShape(profile(), undefined)).toBeNull();
  });
});
