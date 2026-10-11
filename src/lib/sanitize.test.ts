import { describe, expect, it } from "vitest";
import {
  wellFormedAppRules,
  appRuleKey,
  backendDisplayName,
  capCodePoints,
  dropJoiners,
  codeSlug,
  deviceDisplayName,
  peerDeviceName,
  profileDisplayName,
  ruleListLabel,
  safeIdentityText,
  stripControlChars,
  trimLeadingInvisible,
} from "./sanitize";

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

describe("capCodePoints", () => {
  it("keeps whole code points and returns a short string as is", () => {
    expect(capCodePoints("\u{1F3AC}\u{1F3AC}\u{1F3AC}", 2)).toBe("\u{1F3AC}\u{1F3AC}");
    expect(capCodePoints("ab\u{1F3AC}", 3)).toBe("ab\u{1F3AC}");
    expect(capCodePoints("abc", 3)).toBe("abc");
    expect(capCodePoints("abcd", 2)).toBe("ab");
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

  it("drops an invisible joiner head but keeps interior joiners", () => {
    expect(safeIdentityText("\u200d")).toBe("");
    expect(safeIdentityText("\u200c".repeat(100) + "Work")).toBe("Work");
    expect(safeIdentityText("a\u200db")).toBe("a\u200db");
  });

  it("folds joiner runs that join nothing, so they cannot pad the name past the cut", () => {
    expect(safeIdentityText("Work" + " \u200d".repeat(100) + " Evil")).toBe("Work Evil");
    expect(safeIdentityText("Work" + "\u200d".repeat(100) + "Evil")).toBe("Work\u200dEvil");
    expect(safeIdentityText("Work\u200c \u200d Evil")).toBe("Work Evil");
    // A ZWJ emoji sequence (one joiner between two visible characters) is untouched.
    expect(safeIdentityText("\u{1F468}\u200d\u{1F4BB}")).toBe("\u{1F468}\u200d\u{1F4BB}");
    // A joiner run after a space an earlier run already took still touches whitespace.
    expect(safeIdentityText("a\u200c \u200c\u200d")).toBe("a");
  });

  it("folds a long blank run before a joiner in linear time", () => {
    expect(safeIdentityText(" ".repeat(20000) + "a\u200d")).toBe("a\u200d");
    expect(safeIdentityText("\u2800".repeat(20000) + "a\u200d")).toBe("a\u200d");
    const t0 = performance.now();
    // Interior blanks (and U+2800, which the defang turns into spaces) before a later joiner:
    // the old `\s*` form restarted at every blank offset and backtracked, seconds on this input.
    expect(safeIdentityText("a" + " ".repeat(100000) + "b\u200dc")).toBe("a b\u200dc");
    expect(safeIdentityText("a" + "\u2800".repeat(100000) + "b\u200dc")).toBe("a b\u200dc");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("profileDisplayName / backendDisplayName", () => {
  it("names a blank or invisible-only name like a local save would", () => {
    for (const blank of ["", "   ", "\u2800\u2800", "\u200b", "\u200d", "\u200c\u200d", "\u200d\u2800", undefined]) {
      expect(profileDisplayName(blank)).toBe("Untitled profile");
      expect(backendDisplayName(blank)).toBe("Untitled backend");
    }
    expect(profileDisplayName(" Work ")).toBe("Work");
    // An emoji keeps its presentation selector and keycap (the identity fold would space them).
    expect(profileDisplayName("☕️Café")).toBe("☕️Café");
    expect(profileDisplayName("1️⃣ Work")).toBe("1️⃣ Work");
    // Leading padding longer than the cut neither blanks the name nor shows as empty cells.
    for (const pad of [" ", "\u2800", "\u200b"]) {
      expect(profileDisplayName(pad.repeat(80) + "Work")).toBe("Work");
      expect(profileDisplayName(pad.repeat(60) + "Work", 60)).toBe("Work");
    }
    expect(backendDisplayName("Work" + " ".repeat(100) + "Evil")).toBe("Work Evil");
    // A leading joiner joins nothing and goes; an interior one (an emoji sequence) stays.
    expect(profileDisplayName("\u{1F469}\u200d\u{1F4BB} Dev")).toBe("\u{1F469}\u200d\u{1F4BB} Dev");
    expect(profileDisplayName("\u200dWork")).toBe("Work");
    expect(backendDisplayName("\u200d Work")).toBe("Work");
  });
});

describe("trimLeadingInvisible", () => {
  it("drops only the invisible head, astral characters included", () => {
    expect(trimLeadingInvisible("\u{E0001}\u200b \u2800a\u200b b ")).toBe("a\u200b b ");
    expect(trimLeadingInvisible("\u{1F600}\uFE0F")).toBe("\u{1F600}\uFE0F");
    expect(trimLeadingInvisible("\u2800\u200d")).toBe("");
  });
});

describe("deviceDisplayName", () => {
  it("reads a blank or invisible-only device name as empty and trims a padded one", () => {
    expect(deviceDisplayName("  \u200b ")).toBe("");
    expect(deviceDisplayName(" box ")).toBe("box");
    expect(deviceDisplayName(undefined)).toBe("");
    // U+2800 / a joiner survive trim; a padded head must not fill the cap with blanks.
    expect(deviceDisplayName("\u2800\u2800")).toBe("");
    expect(deviceDisplayName("\u200d")).toBe("");
    expect(deviceDisplayName("\u2800".repeat(60) + "box")).toBe("box");
  });
});

describe("peerDeviceName", () => {
  it("blanks a peer name that reads as this device's own label", () => {
    expect(peerDeviceName("This\u2800device")).toBe("");
    expect(peerDeviceName("this \u200ddevice")).toBe("");
    expect(peerDeviceName(" THIS DEVICE\uFE0F ")).toBe("");
    expect(peerDeviceName("laptop")).toBe("laptop");
    expect(peerDeviceName("  ")).toBe("");
    expect(peerDeviceName("Here", "here")).toBe("");
  });
});

describe("ruleListLabel", () => {
  it("names a list by its label, else its rule name, each defanged and trimmed", () => {
    expect(ruleListLabel("\u2800 ", "my-list")).toBe("my-list");
    expect(ruleListLabel("   ", "my-list")).toBe("my-list");
    expect(ruleListLabel("  Foo ", "my-list")).toBe("Foo");
    expect(ruleListLabel("\u200dFoo", "my-list")).toBe("Foo");
    expect(ruleListLabel(undefined, " \u200b ")).toBe("");
    expect(ruleListLabel("x".repeat(100), "n", 60)).toBe("x".repeat(60));
  });
});

describe("appRuleKey", () => {
  it("keys an app id the way the matcher compares it", () => {
    expect(appRuleKey(" Konsole​ ")).toBe("konsole");
    expect(appRuleKey("Konsole️")).toBe(appRuleKey("konsole"));
    // Joiners stay in the stored key but leave the comparison key.
    expect(appRuleKey("kon\u200dsole")).toBe("konsole");
    expect(appRuleKey("\u200d konsole\u200c")).toBe("konsole");
  });
  it("a joiner-only app id keys to nothing, so the well-formed filter drops it", () => {
    // Its stored id keeps the joiner, but a rule keyed "" would match every invisible-named app.
    const rule = { id: "r", appId: "\u200d", insertMethod: "direct" };
    expect(wellFormedAppRules([rule, { id: "k", appId: "konsole" }]).map((r) => r.id)).toEqual(["k"]);
  });
});

describe("dropJoiners", () => {
  it("drops ZWNJ/ZWJ only", () => {
    expect(dropJoiners("a\u200cb\u200d c\u200b")).toBe("ab c\u200b");
    expect(dropJoiners("\u200d\u200c")).toBe("");
  });
});
