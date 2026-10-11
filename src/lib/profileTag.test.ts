import { describe, expect, it } from "vitest";
import { chipTagFor, deriveChipTag } from "./profileTag";

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
