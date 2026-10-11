import { describe, expect, it } from "vitest";
import { authoredChipTag, chipTagFor, deriveChipTag } from "./profileTag";

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
});
