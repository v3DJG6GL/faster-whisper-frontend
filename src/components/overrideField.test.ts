import { describe, expect, it } from "vitest";
import { overrideTextPlaceholder } from "./OverrideField";

describe("overrideTextPlaceholder", () => {
  it("names what an untouched field inherits", () => {
    expect(overrideTextPlaceholder({ value: undefined, inherited: "none" })).toBe("Inherit · none");
    expect(overrideTextPlaceholder({ value: undefined, inherited: "x", inheritWord: "Default" })).toBe("Default · x");
    expect(overrideTextPlaceholder({ value: undefined })).toBe("Inherit");
  });
  it("says an explicit empty override is empty on purpose", () => {
    expect(overrideTextPlaceholder({ value: "", inherited: "none" })).toBe("Empty · overrides the inherited value");
  });
  it("shows an inherited line break as its escape", () => {
    expect(overrideTextPlaceholder({ value: undefined, inherited: "\n", escape: true })).toBe("Inherit · \\n");
  });
  it("shows a locked field's server value instead", () => {
    expect(overrideTextPlaceholder({ value: "mine", fixedLabel: "Set by server · x" })).toBe("Set by server · x");
  });
});
