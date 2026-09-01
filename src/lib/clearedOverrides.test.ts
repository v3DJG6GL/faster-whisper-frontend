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

import { describe, expect, it } from "vitest";
import { backendPrompt, backendPromptFields } from "./backends";
import { pruneTranslationOverrides, translationRunOptions } from "@/components/TranslationFields";
import type { Backend } from "./types";

const backend = (over: Partial<Backend> = {}): Backend => ({
  id: "b1",
  name: "Local",
  serverUrl: "http://localhost:8000",
  hasApiKey: false,
  model: "large-v3",
  endpoint: "stream",
  language: "auto",
  prompt: "",
  responseFormat: "verbose_json",
  ...over,
});

describe("backendPrompt — the Backend default's tri-state", () => {
  it("reads unset as inherit and cleared as an explicit empty", () => {
    // The pair that used to be one value: both store `prompt: ""`, and only the flag
    // says whether the server's DEFAULT_PROMPT applies.
    expect(backendPrompt(backend())).toBeUndefined();
    expect(backendPrompt(backend({ promptCleared: true }))).toBe("");
  });

  it("reads a set prompt verbatim, flag or no flag", () => {
    expect(backendPrompt(backend({ prompt: "ACME, Kubernetes" }))).toBe("ACME, Kubernetes");
    // A stale flag under a re-typed prompt must not turn a real value into a clear.
    expect(backendPrompt(backend({ prompt: "ACME", promptCleared: true }))).toBe("ACME");
  });

  it("round-trips every state through the editor's writer", () => {
    for (const v of [undefined, "", "bias terms"]) {
      expect(backendPrompt({ ...backend(), ...backendPromptFields(v) })).toBe(v);
    }
  });

  it("drops the flag on reset, so the stale one cannot survive a spread", () => {
    // `set()` spreads a partial onto the draft — writing only `prompt` would leave a
    // previous clear's flag behind and re-cleared a field the user had just reset.
    expect(backendPromptFields(undefined).promptCleared).toBeUndefined();
    expect(backendPromptFields("x").promptCleared).toBeUndefined();
    expect(backendPromptFields("").promptCleared).toBe(true);
  });

  it("keeps an UNSET prompt storable as a plain empty string", () => {
    // Deliberate: `Backend.prompt` stays a required string on disk so a config written
    // here still parses in an older build (which would otherwise back the whole config
    // up to .bak and load defaults — a downgrade wiping every backend and hotkey).
    expect(backendPromptFields(undefined).prompt).toBe("");
    expect(backendPromptFields("").prompt).toBe("");
  });
});

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
    expect(translationRunOptions({ ...base, targets: [] })).toEqual({ translateTo: [] });
  });

  it("omits everything for a backend with no translating stage", () => {
    // A standard Whisper server has no such field; its translate runs take the
    // /v1/audio/translations route instead.
    expect(translationRunOptions({ ...base, available: false, targets: ["de"] })).toEqual({});
    expect(translationRunOptions({ ...base, available: false, targets: [] })).toEqual({});
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

  it("carries the mode and an explicit model only alongside real targets", () => {
    expect(translationRunOptions({ ...base, targets: ["de", "fr"], model: "m" })).toEqual({
      translateTo: ["de", "fr"],
      translationMode: "fluent",
      translationModel: "m",
    });
    // Nothing to configure when the stage is off — just the "off" itself.
    expect(
      translationRunOptions({ ...base, targets: [], model: "m", glossary: "a = b" }),
    ).toEqual({ translateTo: [] });
  });
});
