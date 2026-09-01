import { describe, expect, it } from "vitest";
import { stripControlChars } from "./sanitize";

describe("stripControlChars with an output bound", () => {
  it("equals the unbounded result's prefix — control chars, CRLF and astral chars included", () => {
    const s = "ab\u0007c\r\nd\u200be😀f".repeat(60);
    expect(stripControlChars(s, 162)).toBe(stripControlChars(s).slice(0, 162));
    expect(stripControlChars(s, 6)).toBe(stripControlChars(s).slice(0, 6));
    // A bound that would land inside the emoji stops BEFORE it — never a lone surrogate.
    expect(stripControlChars(s, 7)).toBe(stripControlChars(s).slice(0, 6));
  });
  it("is unchanged when no bound is given", () => {
    expect(stripControlChars("a\u0000b")).toBe("ab");
  });
});
