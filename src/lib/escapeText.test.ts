import { describe, expect, it } from "vitest";
import { escapeText, unescapeText } from "./escapeText";

describe("escapeText / unescapeText", () => {
  it("shows a line break and a tab as escapes", () => {
    expect(escapeText("\n")).toBe("\\n");
    expect(escapeText("a\tb\n\n")).toBe("a\\tb\\n\\n");
  });
  it("stores the escapes as the real characters", () => {
    expect(unescapeText("\\n")).toBe("\n");
    expect(unescapeText(" \\t— ")).toBe(" \t— ");
  });
  it("round-trips a literal backslash", () => {
    for (const s of ["\\", "\\n", "C:\\new", "a\\\nb", "", " ", "¶\n"]) {
      expect(unescapeText(escapeText(s))).toBe(s);
    }
  });
  it("keeps an unknown or half-typed escape as typed", () => {
    expect(unescapeText("\\")).toBe("\\");
    expect(unescapeText("\\x")).toBe("\\x");
  });
});
