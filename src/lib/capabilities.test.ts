import { describe, expect, it } from "vitest";
import { translationLanguages, translationTargetInfo, translationWarm } from "./capabilities";
import type { Capabilities } from "./types";

function caps(patch: Partial<Capabilities>): Capabilities {
  return {
    can_request_override_profile: false,
    can_request_decode_overrides: false,
    allowed_override_profiles: [],
    ...patch,
  };
}

describe("translationWarm", () => {
  it("is null when there are no caps at all", () => {
    expect(translationWarm(null)).toBe(null);
  });

  it("is null on a backend that sends no translation_models field", () => {
    // An older server: absent is UNKNOWN, never "cold" — callers must not gate on it.
    expect(translationWarm(caps({ translation_enabled: true }))).toBe(null);
  });

  it("is false when nothing is loaded", () => {
    expect(
      translationWarm(caps({ translation_models: [{ id: "a", loaded: false }] })),
    ).toBe(false);
  });

  it("is true when any model is loaded and no model is named", () => {
    expect(
      translationWarm(
        caps({
          translation_models: [
            { id: "a", loaded: false },
            { id: "b", loaded: true },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("answers for the named model, not the set", () => {
    const c = caps({
      translation_models: [
        { id: "a", loaded: false },
        { id: "b", loaded: true },
      ],
    });
    expect(translationWarm(c, "b")).toBe(true);
    expect(translationWarm(c, "a")).toBe(false);
  });

  it("is false for a model the server does not list", () => {
    expect(
      translationWarm(caps({ translation_models: [{ id: "a", loaded: true }] }), "gone"),
    ).toBe(false);
  });

  it("falls back to the any-loaded answer for a blank model name", () => {
    expect(
      translationWarm(caps({ translation_models: [{ id: "a", loaded: true }] }), "  "),
    ).toBe(true);
  });

  it("is empty-list false, not null", () => {
    expect(translationWarm(caps({ translation_models: [] }))).toBe(false);
  });
});

describe("translationLanguages", () => {
  const models = [
    { id: "hy-mt", loaded: true, languages: ["de", "fr"] },
    { id: "custom", loaded: false, languages: null },
  ];
  it("reads the named model's list, and the default (first) model's when none is named", () => {
    expect(translationLanguages(caps({ translation_models: models }), "hy-mt")).toEqual(["de", "fr"]);
    expect(translationLanguages(caps({ translation_models: models }), "")).toEqual(["de", "fr"]);
  });
  it("is null (unknown) for a model without a list, an unlisted model, or no caps", () => {
    expect(translationLanguages(caps({ translation_models: models }), "custom")).toBe(null);
    expect(translationLanguages(caps({ translation_models: models }), "other")).toBe(null);
    expect(translationLanguages(caps({}))).toBe(null);
    expect(translationLanguages(null)).toBe(null);
  });
});

describe("translationTargetInfo", () => {
  const models = [
    { id: "org/hy-mt", loaded: true, languages: ["de", "fr"] },
    { id: "custom", loaded: false, languages: null },
  ];
  it("the named model's languages and short name; the server default's without one", () => {
    expect(translationTargetInfo(caps({ translation_models: models }), "custom")).toEqual({ supported: null, modelName: "custom" });
    expect(translationTargetInfo(caps({ translation_models: models }))).toEqual({ supported: ["de", "fr"], modelName: "hy-mt" });
    expect(translationTargetInfo(null, "")).toEqual({ supported: null, modelName: undefined });
  });
});
