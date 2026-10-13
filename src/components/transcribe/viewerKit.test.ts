import { describe, expect, it } from "vitest";
import { speakerRenameValue } from "./viewerKit";

describe("speakerRenameValue", () => {
  it("drops the colon a subtitle re-import would end the name at", () => {
    expect(speakerRenameValue("Dr. Who: The Doctor")).toBe("Dr. Who The Doctor");
    expect(speakerRenameValue("Host:")).toBe("Host");
    expect(speakerRenameValue(" a : b ")).toBe("a b");
  });
  it("keeps the 40-code-point cap and a fullwidth colon the importer does not split at", () => {
    expect(speakerRenameValue("🎤" + "A".repeat(45))).toBe("🎤" + "A".repeat(39));
    expect(speakerRenameValue("司会：田中")).toBe("司会：田中");
  });
});
