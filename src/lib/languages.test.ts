import { describe, expect, it } from "vitest";
import { languageLabel } from "./languages";

describe("languageLabel", () => {
  it("names curated codes", () => {
    expect(languageLabel("de")).toBe("German");
  });
  it("names codes outside the curated set", () => {
    expect(languageLabel("el")).toBe("Greek");
    expect(languageLabel("vi")).toBe("Vietnamese");
    expect(languageLabel("hu")).toBe("Hungarian");
  });
  it("returns an unknown or malformed code unchanged", () => {
    expect(languageLabel("xx")).toBe("xx");
    expect(languageLabel("not a tag")).toBe("not a tag");
  });
});
