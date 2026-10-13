import { describe, expect, it } from "vitest";
import { navKey, pickerKeyActsOnce } from "./listNav";
// Raw sources (vite `?raw`): the other keyboard lists that must consult the same predicate.
import listPickerSrc from "../components/ListPicker.tsx?raw";
import buttonsSrc from "../components/ui/buttons.tsx?raw";

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

/** The source from `start` to the end of that component-level arrow function (its `  };` line). */
function bodyOf(src: string, start: string): string {
  const at = src.indexOf(start);
  expect(at).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf("\n  };", at));
}

describe("held keys in the other picker lists act once", () => {
  it("ListPicker's list keys swallow a held Space / Enter, and so does its trigger", () => {
    expect(bodyOf(listPickerSrc, "const onListKey")).toMatch(/e\.repeat && pickerKeyActsOnce\(/);
    expect(listPickerSrc.slice(listPickerSrc.indexOf("renderTrigger({"))).toMatch(
      /onKeyDown: \(e\) => \{\s*(\/\/[^\n]*\s*)*if \(e\.repeat && pickerKeyActsOnce\(/,
    );
  });

  it("SplitButton's menu keys swallow a held Space / Enter, and so does its chevron", () => {
    expect(bodyOf(buttonsSrc, "const onMenuKey")).toMatch(/e\.repeat && pickerKeyActsOnce\(/);
    expect(buttonsSrc.slice(buttonsSrc.indexOf("ref={chevronRef}"))).toMatch(
      /onKeyDown=\{\(e\) => \{\s*if \(e\.repeat && pickerKeyActsOnce\(/,
    );
  });
});
