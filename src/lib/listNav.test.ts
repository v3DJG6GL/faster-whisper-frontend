import { describe, expect, it } from "vitest";
import { navKey } from "./listNav";

describe("navKey", () => {
  it("moves by one, by a page, and to either end, clamped", () => {
    expect(navKey("ArrowDown", 0, 20)).toBe(1);
    expect(navKey("ArrowUp", 0, 20)).toBe(0);
    expect(navKey("PageDown", 3, 20)).toBe(11);
    expect(navKey("PageDown", 15, 20)).toBe(19);
    expect(navKey("PageUp", 5, 20)).toBe(0);
    expect(navKey("Home", 9, 20)).toBe(0);
    expect(navKey("End", 0, 20)).toBe(19);
  });
  it("ignores other keys", () => {
    expect(navKey("a", 0, 20)).toBe(null);
    expect(navKey("Enter", 0, 20)).toBe(null);
  });
});
