import { describe, expect, it } from "vitest";
import { appRuleKey, codeSlug, safeIdentityText, stripControlChars } from "./sanitize";

describe("stripControlChars with an output bound", () => {
  it("normalises a lone CR and a CRLF without touching the text past the bound", () => {
    expect(stripControlChars("a\rb")).toBe("a\nb");
    expect(stripControlChars("a\r\nb")).toBe("a\nb");
    expect(stripControlChars("a\r\nb", 2)).toBe("a\n");
    expect(stripControlChars("a\r", 2)).toBe("a\n");
  });

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

describe("codeSlug", () => {
  it("keeps ASCII letters, digits and hyphens, bounded, with a fallback", () => {
    expect(codeSlug("pt-BR")).toBe("pt-BR");
    expect(codeSlug("de/../x y.z")).toBe("dexyz");
    expect(codeSlug("a".repeat(20))).toHaveLength(12);
    expect(codeSlug("Youtube:tab".split(":")[0].toLowerCase(), 40)).toBe("youtube");
    expect(codeSlug("..", 12, "und")).toBe("und");
    expect(codeSlug("ü")).toBe("");
  });
});

describe("safeIdentityText", () => {
  it("collapses padding even when deleted characters are interleaved with it", () => {
    for (const hidden of ["​", "­", "\u0001"]) {
      expect(safeIdentityText("konsole" + ` ${hidden}`.repeat(100) + "evil")).toBe("konsole evil");
    }
  });

  it("marks a cut that lands on a space, with no space before the marker", () => {
    expect(safeIdentityText("a".repeat(80) + " evil").endsWith("…")).toBe(true);
    expect(safeIdentityText("a".repeat(79) + " evil")).toBe("a".repeat(79) + "…");
    expect(safeIdentityText("  short  ")).toBe("short");
  });
});

describe("appRuleKey", () => {
  it("keys an app id the way the matcher compares it", () => {
    expect(appRuleKey(" Konsole​ ")).toBe("konsole");
    expect(appRuleKey("Konsole️")).toBe(appRuleKey("konsole"));
  });
});
