import { describe, expect, it } from "vitest";
import { translationWarm } from "./capabilities";
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
