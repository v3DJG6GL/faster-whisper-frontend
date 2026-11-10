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
  safeDisplayText,
  safeHostText,
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
    // a `\s*` pattern restarts at every blank offset and backtracks, seconds on this input.
    // A cap above the run, so the scan budget leaves the whole run to the passes.
    expect(safeIdentityText("a" + " ".repeat(100000) + "b\u200dc", 200_000)).toBe("a b\u200dc");
    expect(safeIdentityText("a" + "\u2800".repeat(100000) + "b\u200dc", 200_000)).toBe("a b\u200dc");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

// The implementation before the pre-cut, as the reference: the same passes over the whole string.
// Its private predicates are read through the public ones (no character is in two of the classes).
function identityReference(s: unknown, max = 80): string {
  const dropped = (ch: string) => safeDisplayText(ch, 2) === "";
  const invisible = (ch: string) => ch !== "\u200c" && ch !== "\u200d" && trimLeadingInvisible(ch) === "";
  const raw = typeof s === "string" ? trimLeadingInvisible(s) : "";
  const defanged = [...raw]
    .map((ch) => (/\s/.test(ch) ? " " : dropped(ch) ? "" : invisible(ch) ? " " : ch))
    .join("");
  const collapsed = defanged
    .replace(/[\u200c\u200d]+/g, (m, off: number, str: string) =>
      /\s/.test(str[off - 1] ?? "") || /\s/.test(str[off + m.length] ?? "") ? " " : m[0],
    )
    .replace(/\s+/g, " ");
  const t = safeDisplayText(collapsed.trim(), max + 1);
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() + "…" : t;
}

describe("safeIdentityText's pre-cut", () => {
  it("renders exactly what the whole-string passes rendered", () => {
    const alphabet = ["a", "é", "😀", " ", "\t", "\u2800", "\u200d", "\u200c", "\u200b", "\u0001", "\ufe0f", "\ud800", "."];
    let seed = 5;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let round = 0; round < 5000; round++) {
      const s = Array.from({ length: rand(24) }, () => alphabet[rand(alphabet.length)]).join("");
      const max = 1 + rand(8);
      expect(safeIdentityText(s, max), JSON.stringify([s, max])).toBe(identityReference(s, max));
      // The reference itself agrees with the uncut path (a max no 24-character input reaches).
      expect(identityReference(s, 1000)).toBe(safeIdentityText(s, 1000));
    }
    for (const s of ["konsole" + " \u200b".repeat(100) + "evil", "a".repeat(80) + " evil", "Work" + " \u200d".repeat(100) + " Evil"]) {
      expect(safeIdentityText(s)).toBe(identityReference(s));
    }
  });

  it("returns fast for a 4 MiB name, and padding longer than the window still collapses", () => {
    const t0 = performance.now();
    expect(safeIdentityText("x".repeat(4 * 1024 * 1024))).toBe("x".repeat(80) + "…");
    expect(safeIdentityText("a b ".repeat(1_000_000))).toBe(identityReference("a b ".repeat(100)));
    expect(performance.now() - t0).toBeLessThan(200);
    // Within the scan budget (8 × 80 + 1024 code points) the run collapses as before.
    expect(safeIdentityText("konsole" + " ".repeat(1500) + "evil")).toBe("konsole evil");
    // Past it the cut is marked: never the bare "konsole" the padding was built to show.
    expect(safeIdentityText("konsole" + " ".repeat(100_000) + "evil")).toBe("konsole…");
  });

  it("stays fast on a name made of non-ordinary padding, and marks the cut", () => {
    for (const pad of ["\u2800", "\u200b", " \u200d", "\u00a0", "\u2800 \u200b\u00a0\u200d\ufe0f"]) {
      const run = pad.repeat(Math.ceil(1_000_000 / pad.length));
      const name = "Work" + run + " Evil";
      const t0 = performance.now();
      const shown = safeIdentityText(name);
      const host = safeHostText("sync.example.com" + run + ".evil.tld");
      const hostHead = safeHostText("evil.tld" + run);
      expect(performance.now() - t0, JSON.stringify(pad)).toBeLessThan(50);
      expect(shown).toBe("Work…");
      // The tail scan ran out inside the padding: the host's end shows, its head is marked cut.
      expect(host).toBe("….evil.tld");
      expect(hostHead).toBe("…");
      // Under the budget the output is the reference's.
      const short = "Work" + pad.repeat(Math.floor(1500 / pad.length)) + " Evil";
      expect(safeIdentityText(short)).toBe(identityReference(short));
    }
  });
});

describe("safeHostText", () => {
  it("renders a host within the cap exactly as safeIdentityText does", () => {
    for (const h of ["sync.example.com", "10.0.0.2:8000", "[::1]:9000", "a".repeat(80)]) {
      expect(safeHostText(h, 80)).toBe(safeIdentityText(h, 80));
    }
  });

  it("keeps the END of a long host, from a label boundary, port included", () => {
    const host = "sync.internal.corp.example.com." + "pad.".repeat(40) + "evil.tld";
    const shown = safeHostText(host, 80);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith(".evil.tld")).toBe(true);
    expect(shown).not.toContain("example.com");
    expect([...shown].length).toBeLessThanOrEqual(80);
    expect(shown.slice(1).startsWith("pad.")).toBe(true);
    expect(safeHostText(host + ":8443", 80).endsWith("evil.tld:8443")).toBe(true);
  });

  // The implementation before the tail pre-cut, as the reference: the passes over the whole host.
  const hostReference = (s: unknown, max = 80): string => {
    const full = safeIdentityText(s, Number.MAX_SAFE_INTEGER);
    const chars = [...full];
    if (chars.length <= max) return full;
    let tail = chars.slice(chars.length - Math.max(1, max - 1));
    const dot = tail.indexOf(".");
    if (dot >= 0 && dot < tail.length - 1) tail = tail.slice(dot + 1);
    return "…" + tail.join("").trimStart();
  };

  it("renders exactly what the whole-host passes rendered", () => {
    const alphabet = ["a", "é", "😀", " ", "\t", "\u2800", "\u200d", "\u200c", "\u200b", "\u0001", "\ufe0f", "\ud800", "\udc00", ".", ":"];
    let seed = 11;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let round = 0; round < 20000; round++) {
      const s = Array.from({ length: rand(32) }, () => alphabet[rand(alphabet.length)]).join("");
      const max = 1 + rand(10);
      expect(safeHostText(s, max), JSON.stringify([s, max])).toBe(hostReference(s, max));
    }
    for (const s of [
      "a" + " ".repeat(500) + "b",
      "sync.example.com" + "\u2800".repeat(300) + ".evil.tld",
      "x".repeat(200) + " \u200d".repeat(100) + "y",
      "\ud83d\ude00".repeat(100),
    ]) {
      expect(safeHostText(s)).toBe(hostReference(s));
    }
  });

  it("returns fast for a multi-MB host", () => {
    const host = "sync.example.com." + "pad.".repeat(1_000_000) + "evil.tld";
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) expect(safeHostText(host).endsWith("pad.evil.tld")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(safeHostText(host)).toBe(hostReference("pad.".repeat(100) + "evil.tld"));
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

  it("stops at a render caller's budget and marks the cut head", () => {
    expect(trimLeadingInvisible("   a", 3)).toBe("a");
    expect(trimLeadingInvisible("    a", 3)).toBe("… a");
    // Value callers pass none: a long head still goes whole.
    expect(trimLeadingInvisible(" ".repeat(10_000) + "a")).toBe("a");
  });

  it("keeps every render of a name with MBs of leading padding fast", () => {
    const big = 4 * 1024 * 1024;
    for (const pad of ["\u00a0", "\u200b", "\ufe0f"]) {
      const name = pad.repeat(big) + "evil";
      const t0 = performance.now();
      const shown = [safeIdentityText(name), backendDisplayName(name), profileDisplayName(name), deviceDisplayName(name)];
      // Unbudgeted these four renders take ~0.4 s; the bound leaves room for a loaded suite.
      expect(performance.now() - t0, JSON.stringify(pad)).toBeLessThan(200);
      // Marked as cut, never blank and never "Untitled": a name follows the padding.
      for (const t of shown) expect(t.startsWith("…"), JSON.stringify([pad, t])).toBe(true);
    }
    // One visible character then MBs of characters the display filter deletes.
    const name = "a" + "\u200b".repeat(big);
    const t0 = performance.now();
    expect(safeDisplayText(name)).toBe("a");
    expect(profileDisplayName(name)).toBe("a");
    expect(deviceDisplayName(name)).toBe("a");
    // Unbudgeted ~0.2 s; budgeted well under a millisecond.
    expect(performance.now() - t0).toBeLessThan(150);
    // What only the budget produces (the timing alone is a weak signal on a fast machine): a
    // visible character past the budget's run of deleted ones is never reached.
    const tail = "a" + "\u200b".repeat(big) + "b";
    expect(safeDisplayText(tail)).toBe("a");
    expect(profileDisplayName(tail)).toBe("a");
    expect(deviceDisplayName(tail)).toBe("a");
    // Under the budget the output is unchanged.
    expect(safeDisplayText("a" + "\u200b".repeat(2000) + "b")).toBe("ab");
    expect(profileDisplayName("\u200b".repeat(1500) + "Work")).toBe("Work");
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

  it("blanks a peer name padded mid-word with a zero-width character", () => {
    expect(peerDeviceName("Th\u034Fis device", "This device")).toBe("");
    expect(peerDeviceName("Th\uFE0Fis device", "This device")).toBe("");
    expect(peerDeviceName("This dev\u{E0100}ice", "This device")).toBe("");
    expect(peerDeviceName("This laptop", "This device")).toBe("This laptop");
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
  it("folds whitespace the way the audit row draws it, so a rule shown as the live id matches it", () => {
    for (const id of ["Google  Chrome", "Google\u00a0Chrome", "Google\u3000Chrome", "Google\u2009\u2009Chrome"]) {
      expect(safeIdentityText(id)).toBe("Google Chrome");
      expect(appRuleKey(id)).toBe(appRuleKey("Google Chrome"));
    }
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
