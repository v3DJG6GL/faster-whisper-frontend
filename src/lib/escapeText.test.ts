import { describe, expect, it } from "vitest";
import { escapedFieldText, escapeText, unescapeText } from "./escapeText";

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

describe("escapedFieldText", () => {
  it("keeps a half-typed escape as typed so \\n can be typed key by key", () => {
    // Keystroke 1: a lone backslash is stored as "\" and must not re-render doubled.
    let draft = "\\";
    let value = unescapeText(draft);
    let shown = escapedFieldText(draft, value);
    expect(shown).toBe("\\");
    // Keystroke 2: the "n" completes the escape: a real line break is stored.
    draft = shown + "n";
    value = unescapeText(draft);
    shown = escapedFieldText(draft, value);
    expect(value).toBe("\n");
    expect(shown).toBe("\\n");
  });
  it("shows the escaped value without a draft", () => {
    expect(escapedFieldText(null, "a\nb")).toBe(escapeText("a\nb"));
  });
  it("falls back to the escaped value when the value changed from outside", () => {
    expect(escapedFieldText("x\\n", "\t")).toBe("\\t");
  });
});
