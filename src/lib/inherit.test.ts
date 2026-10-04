import { describe, expect, it } from "vitest";
import { inheritLabel, onOff } from "./inherit";

describe("inheritLabel", () => {
  it("names the inherited value after the word", () => {
    expect(inheritLabel("on")).toBe("Inherit · on");
    expect(inheritLabel("large-v3", "Default")).toBe("Default · large-v3");
  });
  it("falls back to the bare word when the value is unknown", () => {
    expect(inheritLabel(undefined)).toBe("Inherit");
    expect(inheritLabel("  ", "Default")).toBe("Default");
    expect(inheritLabel(null)).toBe("Inherit");
  });
  it("maps booleans to on/off", () => {
    expect(onOff(true)).toBe("on");
    expect(onOff(false)).toBe("off");
    expect(onOff(undefined)).toBeUndefined();
  });
});
