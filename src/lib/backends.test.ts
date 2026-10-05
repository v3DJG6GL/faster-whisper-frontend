import { describe, expect, it } from "vitest";
import { backendPrompt, backendPromptFields, effectiveLanguage, newBackendDraft } from "./backends";
import type { Backend } from "./types";

describe("newBackendDraft", () => {
  it("a new backend starts on the server's language (W6)", () => {
    expect(newBackendDraft().language).toBe("");
  });
});

describe("effectiveLanguage", () => {
  it("a set profile language wins, trimmed", () => {
    expect(effectiveLanguage(" en ", "de")).toBe("en");
  });
  it("blank or absent profile language inherits the backend's", () => {
    expect(effectiveLanguage("   ", "de")).toBe("de");
    expect(effectiveLanguage(undefined, "de")).toBe("de");
    expect(effectiveLanguage("", "de")).toBe("de");
  });
  it("no backend language either → undefined", () => {
    expect(effectiveLanguage(undefined, undefined)).toBeUndefined();
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
// These pin the three states for each field the client can now express.

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
