import { describe, expect, it } from "vitest";
import { effectiveLanguage } from "./backends";

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
