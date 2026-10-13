import { describe, expect, it } from "vitest";
import { navKey, pickerKeyActsOnce } from "./listNav";

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

describe("pickerKeyActsOnce", () => {
  // A held key's auto-repeat: true = swallow it (the action already ran on the press).
  it("acts once for Enter, Space, the digits, and Backspace past the emptied filter", () => {
    expect(pickerKeyActsOnce("Enter", false, true)).toBe(true);
    expect(pickerKeyActsOnce("Enter", true, false)).toBe(true); // picks the row, then would commit
    expect(pickerKeyActsOnce(" ", false, true)).toBe(true);
    expect(pickerKeyActsOnce("3", false, true)).toBe(true);
    expect(pickerKeyActsOnce("0", false, true)).toBe(true);
    expect(pickerKeyActsOnce("Backspace", false, true)).toBe(true); // would drop preselected targets
  });
  it("lets the filter's own editing and the navigation keys repeat", () => {
    expect(pickerKeyActsOnce("Backspace", true, false)).toBe(false);
    expect(pickerKeyActsOnce(" ", true, false)).toBe(false);
    expect(pickerKeyActsOnce("3", true, false)).toBe(false);
    expect(pickerKeyActsOnce("a", false, true)).toBe(false);
    for (const k of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]) {
      expect(pickerKeyActsOnce(k, false, true)).toBe(false);
    }
  });
});
