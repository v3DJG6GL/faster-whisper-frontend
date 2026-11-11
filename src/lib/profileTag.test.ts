import { describe, expect, it } from "vitest";
import { authoredChipTag, chipTagFor, deriveChipTag, shownChipTag } from "./profileTag";

describe("chipTagFor", () => {
  it("derives a normal name as before, emoji presentation included", () => {
    expect(chipTagFor({ name: "Work notes" })).toBe(deriveChipTag("Work notes"));
    expect(chipTagFor({ name: "☕️Café" })).toBe("☕️CAFÉ");
  });

  it("reads a blank name as the saved 'Untitled profile' does, never an empty tag", () => {
    for (const name of ["", "   ", "⠀⠀", "​"]) {
      expect(chipTagFor({ name })).toBe(deriveChipTag("Untitled profile"));
    }
    expect(chipTagFor({ name: "​".repeat(10) + "Work" })).toBe("WORK");
  });

  it("keeps an authored tag, dropping only an invisible head", () => {
    expect(chipTagFor({ name: "Work", tag: " de-ch " })).toBe("de-ch");
    expect(chipTagFor({ name: "Work", tag: "⠀".repeat(20) + "DE" })).toBe("DE");
    expect(chipTagFor({ name: "Work", tag: "⠀⠀" })).toBe("WORK");
  });
});

describe("authoredChipTag", () => {
  it("reads a blank-rendering or non-string tag as unset", () => {
    for (const tag of [undefined, 42, "", "   ", "⠀⠀", "​⠀ "]) {
      expect(authoredChipTag(tag)).toBe("");
    }
  });

  it("keeps a padded tag's visible part and caps it at 16 code points", () => {
    expect(authoredChipTag("⠀".repeat(40) + "WORK")).toBe("WORK");
    expect(authoredChipTag("x".repeat(30))).toBe("x".repeat(16));
    expect(authoredChipTag(" de-ch ")).toBe("de-ch");
  });

  it("matches trim-then-cap for whitespace around and inside the cap", () => {
    const old = (tag: string) => {
      const t = tag.trim();
      return t ? Array.from(t).slice(0, 16).join("").trimEnd() : "";
    };
    for (const tag of ["", " ", "a", " a ", "x".repeat(15) + " y", "x".repeat(16) + "   ", "x".repeat(15) + "   z",
      " \u{1F3AC}".repeat(10), "ab" + " ".repeat(20) + "c", "\u3000a\u3000", "a".repeat(17)]) {
      expect(authoredChipTag(tag)).toBe(old(tag));
    }
  });
});

describe("shownChipTag", () => {
  it("reads a real tag as authoredChipTag does", () => {
    for (const tag of [" de-ch ", "⠀".repeat(40) + "WORK", "\u200b".repeat(32000) + "WORK", "x".repeat(30), "⠀⠀", 42]) {
      expect(shownChipTag(tag)).toBe(authoredChipTag(tag));
    }
  });

  it("bounds the walk over a synced tag's MBs of invisible head on every chip render", () => {
    const padded = "\u00a0\u200b\ufe0f".repeat(1_400_000) + "EVIL";
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      expect(shownChipTag(padded).startsWith("…")).toBe(true);
      expect(chipTagFor({ name: "Work", tag: padded }).startsWith("…")).toBe(true);
    }
    // Unbudgeted, these 20 walks take seconds; budgeted, tens of ms. The bound leaves room for a
    // loaded full-suite run without losing the regression signal.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
