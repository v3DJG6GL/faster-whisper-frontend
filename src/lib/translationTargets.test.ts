import { describe, expect, it } from "vitest";
import { chipCodes, pruneTargets, pruneTranslationOverrides, seedTargets, translationRunOptions } from "./translationTargets";

// `translationOverrides.translateTo` is peer-synced and never element-clamped by the
// sanitizers; the chip renderer is the last line of defence (mirrors dictation/chipController.test.ts).
describe("chipCodes", () => {
  it("keeps only trimmed non-empty strings", () => {
    expect(chipCodes([123, null, {}, "", "  ", "fr", " de "])).toEqual(["fr", "de"]);
  });
  it("bounds each code and the count, and de-duplicates", () => {
    expect(chipCodes(["x".repeat(40)])[0].length).toBeLessThanOrEqual(13);
    expect(chipCodes(Array.from({ length: 100 }, (_, i) => `l${i}`), 5)).toHaveLength(5);
    expect(chipCodes(["fr", "fr", "de"])).toEqual(["fr", "de"]);
  });
  it("returns nothing for a non-array", () => {
    expect(chipCodes("fr")).toEqual([]);
  });
});

describe("seedTargets", () => {
  it("prefers the Backend defaults, then the server's, then English", () => {
    expect(seedTargets({ backendTargets: ["fr", "it"], serverDefault: ["es"], max: 8 })).toEqual(["fr", "it"]);
    expect(seedTargets({ backendTargets: [], serverDefault: ["es"], max: 8 })).toEqual(["es"]);
    expect(seedTargets({ max: 8 })).toEqual(["en"]);
  });
  it("never seeds the known source, falling back to German for an English source", () => {
    expect(seedTargets({ backendTargets: ["de", "fr"], source: "de", max: 8 })).toEqual(["fr"]);
    expect(seedTargets({ source: "en", max: 8 })).toEqual(["de"]);
    expect(seedTargets({ backendTargets: ["fr"], source: "fr", max: 8 })).toEqual(["en"]);
  });
  it("stays within the server's target cap", () => {
    expect(seedTargets({ backendTargets: ["fr", "it", "es", "pt"], max: 2 })).toEqual(["fr", "it"]);
  });
  it("drops non-string entries a peer synced in", () => {
    expect(seedTargets({ backendTargets: [123, null], serverDefault: ["es"], max: 8 })).toEqual(["es"]);
  });
  it("keeps a long language tag whole and skips one the wire would refuse", () => {
    expect(seedTargets({ serverDefault: ["ca-ES-valencia"], max: 8 })).toEqual(["ca-ES-valencia"]);
    expect(seedTargets({ backendTargets: ["x".repeat(20)], serverDefault: ["es"], max: 8 })).toEqual(["es"]);
  });
});

describe("pruneTargets", () => {
  it("drops the known source, keeps everything under auto", () => {
    expect(pruneTargets(["de", "fr"], "de")).toEqual(["fr"]);
    expect(pruneTargets(["de"], "auto")).toEqual(["de"]);
    expect(pruneTargets(["de"], "")).toEqual(["de"]);
  });
});

// The "cleared vs inherited" wire shape.
//
// The server now reads a PRESENT-but-empty override as "cleared — ignore what you would
// have inherited", and an ABSENT one as "inherit". Everywhere the client used to collapse
// the two (`|| undefined`, `!value.trim()`, "prune the empty list") it lost the user's
// ability to say *no* — the cleared prompt / glossary / target list came back from the
// server override-profile, silently, with the field still showing empty in the editor.
//
// These pin the three states for each field the client can now express. The `language`
// and `translate_to` form values themselves are pinned on the Rust side
// (`transport::wire_language`, `transport::batch::translate_to_field`).

describe("pruneTranslationOverrides — what an editor stores", () => {
  it("keeps an explicitly emptied target list and glossary", () => {
    // Pruning these was the bug: the stored object went back to "inherit", so the
    // server's own TRANSLATE_TO / TRANSLATION_GLOSSARY applied to a field the user
    // had visibly cleared.
    expect(pruneTranslationOverrides({ translateTo: [] })).toEqual({ translateTo: [] });
    expect(pruneTranslationOverrides({ glossary: "" })).toEqual({ glossary: "" });
  });

  it("still stores an all-inherit object as undefined", () => {
    expect(pruneTranslationOverrides({})).toBeUndefined();
    expect(
      pruneTranslationOverrides({ translateTo: undefined, glossary: undefined, model: "" }),
    ).toBeUndefined();
  });

  it("leaves real values alone", () => {
    expect(pruneTranslationOverrides({ translateTo: ["de"], glossary: "a = b" })).toEqual({
      translateTo: ["de"],
      glossary: "a = b",
    });
  });

  it("keeps includeOriginal:false, which is an explicit OFF", () => {
    expect(pruneTranslationOverrides({ includeOriginal: false })).toEqual({
      includeOriginal: false,
    });
  });
});

describe("translationRunOptions — what a batch run puts on the wire", () => {
  const base = { available: true, mode: "fluent" as const };

  it("sends an EMPTY target list rather than omitting it", () => {
    // Absent = "inherit the server profile's TRANSLATE_TO"; the screen's chips are
    // authoritative, so an empty list has to be said out loud.
    expect(translationRunOptions({ ...base, targets: [] })).toEqual({ translateTo: [], translationMode: "fluent" });
  });

  it("omits everything for a backend with no translating stage", () => {
    // A standard Whisper server has no such field; its translate runs take the
    // /v1/audio/translations route instead.
    expect(translationRunOptions({ ...base, available: false, targets: ["de"] })).toEqual({});
    expect(translationRunOptions({ ...base, available: false, targets: [] })).toEqual({});
  });

  it("forwards the context depth (0 included) and omits an unset one", () => {
    expect(translationRunOptions({ ...base, targets: ["de"], contextSegments: 0 }).translationContextSegments).toBe(0);
    expect(translationRunOptions({ ...base, targets: ["de"], contextSegments: 5 }).translationContextSegments).toBe(5);
    expect(translationRunOptions({ ...base, targets: ["de"] })).not.toHaveProperty("translationContextSegments");
    // No targets still carries the regime: a link's frozen site targets can translate, and
    // the Rust form drops translation_* when there are no targets.
    expect(translationRunOptions({ ...base, targets: [], contextSegments: 5 })).toEqual({
      translateTo: [],
      translationMode: "fluent",
      translationContextSegments: 5,
    });
  });

  it("forwards an explicitly cleared glossary and omits an unset one", () => {
    expect(
      translationRunOptions({ ...base, targets: ["de"], glossary: "" }).translationGlossary,
    ).toBe("");
    expect(
      translationRunOptions({ ...base, targets: ["de"] }),
    ).not.toHaveProperty("translationGlossary");
    expect(
      translationRunOptions({ ...base, targets: ["de"], glossary: "a = b" }).translationGlossary,
    ).toBe("a = b");
  });

  it("carries the mode and an explicit model, with or without targets", () => {
    expect(translationRunOptions({ ...base, targets: ["de", "fr"], model: "m" })).toEqual({
      translateTo: ["de", "fr"],
      translationMode: "fluent",
      translationModel: "m",
    });
    // An empty list keeps the regime for a link's frozen site targets.
    expect(
      translationRunOptions({ ...base, mode: "faithful", targets: [], model: "m", glossary: "" }),
    ).toEqual({ translateTo: [], translationMode: "faithful", translationModel: "m", translationGlossary: "" });
  });
});
