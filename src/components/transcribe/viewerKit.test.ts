import { describe, expect, it } from "vitest";
import { renameToCommit, speakerRenameValue } from "./viewerKit";

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

describe("renameToCommit", () => {
  const long = "Moderatorin der Podiumsdiskussion am Nachmittag"; // 47 code points, stored before the cap

  it("leaving the editor unchanged writes nothing, so a longer stored name survives", () => {
    expect(renameToCommit(long, long)).toBeNull();
    expect(renameToCommit(` ${long} `, long)).toBeNull();
    expect(renameToCommit("", undefined)).toBeNull();
  });

  it("an edited name is cleaned and capped as before", () => {
    expect(renameToCommit(long + "!", long)).toBe(long.slice(0, 40).trim());
    expect(renameToCommit("Host: Anna", undefined)).toBe("Host Anna");
    expect(renameToCommit("", "Anna")).toBe("");
  });
});
