import { describe, expect, it } from "vitest";
import { sessionShape } from "./sessionShape";
import type { Backend, Profile } from "../types";

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

  it("a language named as a word is the same session as its code (the code is what is sent)", () => {
    const b = backend();
    expect(sessionShape(profile({ language: "english" }), b)).toBe(sessionShape(profile({ language: "en" }), b));
    expect(sessionShape(profile(), backend({ language: "English" }))).toBe(sessionShape(profile({ language: "en" }), b));
    // "auto" is not renamed: it stays apart from any code
    expect(sessionShape(profile({ language: "auto" }), b)).not.toBe(sessionShape(profile({ language: "en" }), b));
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

  it("a padded or blank Profile translation model is the Backend's model as sent", () => {
    const b = backend({ translationOverrides: { model: "gemma" } } as Partial<Backend>);
    const base = sessionShape(profile(), b);
    expect(sessionShape(profile({ translationOverrides: { model: " gemma " } } as Partial<Profile>), b)).toBe(base);
    expect(sessionShape(profile({ translationOverrides: { model: "  " } } as Partial<Profile>), b)).toBe(base);
    expect(sessionShape(profile({ translationOverrides: { model: "other" } } as Partial<Profile>), b)).not.toBe(base);
  });

  it("a padded synced Backend Whisper model is the trimmed model as sent", () => {
    expect(sessionShape(profile(), backend({ model: " large-v3 " }))).toBe(sessionShape(profile(), backend({ model: "large-v3" })));
    expect(sessionShape(profile(), backend({ model: "  " }))).toBe(sessionShape(profile(), backend({ model: "" })));
    expect(sessionShape(profile({ model: "large-v3" }), backend())).toBe(sessionShape(profile(), backend({ model: " large-v3 " })));
  });

  it("differs when both ask for targets but at different moments (hold at release, hands-free before start)", () => {
    const hold = profile({ id: "ptt", activation: "hold", askTranslationTargets: true });
    const free = profile({ id: "hf", activation: "handsfree", askTranslationTargets: true });
    expect(sessionShape(hold, backend())).not.toBe(sessionShape(free, backend()));
    // two Profiles that ask at the same moment are still one session
    expect(sessionShape(free, backend())).toBe(sessionShape(profile({ id: "hf2", activation: "handsfree", askTranslationTargets: true }), backend()));
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
