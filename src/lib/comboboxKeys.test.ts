// A Combobox with no visible suggestions must let Escape reach the window and ArrowUp move the caret.
import { describe, expect, it } from "vitest";
import { listOwnsKey } from "./comboboxKeys";

describe("listOwnsKey", () => {
  it("leaves Escape and ArrowUp alone when no suggestions are drawn", () => {
    expect(listOwnsKey("Escape", false)).toBe(false);
    expect(listOwnsKey("ArrowUp", false)).toBe(false);
  });

  it("takes them while the list is drawn", () => {
    expect(listOwnsKey("Escape", true)).toBe(true);
    expect(listOwnsKey("ArrowUp", true)).toBe(true);
  });

  it("never takes other keys", () => {
    expect(listOwnsKey("a", true)).toBe(false);
  });
});
