import { describe, expect, it } from "vitest";
import { effectiveLanguage, newBackendDraft } from "./backends";

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
