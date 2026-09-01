import { describe, expect, it } from "vitest";
import { seekKeyTarget } from "./seekKeys";

describe("seekKeyTarget", () => {
  it("steps by 5 s, 30 s with Shift, and clamps to the media length", () => {
    expect(seekKeyTarget("ArrowRight", 10, 100, false)).toBe(15);
    expect(seekKeyTarget("ArrowLeft", 10, 100, true)).toBe(0);
    expect(seekKeyTarget("ArrowUp", 98, 100, false)).toBe(100);
  });
  it("Home/End/Page keys", () => {
    expect(seekKeyTarget("Home", 50, 100, false)).toBe(0);
    expect(seekKeyTarget("End", 50, 100, false)).toBe(100);
    expect(seekKeyTarget("PageUp", 50, 100, false)).toBe(80);
    expect(seekKeyTarget("PageDown", 10, 100, false)).toBe(0);
  });
  it("Space toggles playback; other keys are not the slider's", () => {
    expect(seekKeyTarget(" ", 0, 100, false)).toBe("toggle");
    expect(seekKeyTarget("Tab", 0, 100, false)).toBeNull();
  });
});
