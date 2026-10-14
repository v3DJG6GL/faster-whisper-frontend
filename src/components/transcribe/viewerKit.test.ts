import { describe, expect, it } from "vitest";
import { playRejectionBreaks, renameToCommit, speakerRenameDraft, speakerRenameValue } from "./viewerKit";
import viewerSrc from "./TranscriptViewer.tsx?raw";

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

describe("speakerRenameDraft", () => {
  it("takes 40 emoji or CJK Ext-B characters and refuses the 41st, as the stored name allows", () => {
    const emoji = "🎤".repeat(40);
    expect(speakerRenameDraft("🎤".repeat(39), emoji)).toBe(emoji);
    expect(speakerRenameDraft(emoji, emoji + "🎤")).toBe(emoji);
    expect(speakerRenameDraft("", "𠀀".repeat(41))).toBe("");
    // The colon stays in the draft: the commit drops it (speakerRenameValue).
    expect(speakerRenameDraft("Host:", "Host: A")).toBe("Host: A");
  });
  it("a keystroke mid-name at the cap is refused, not paid for with the name's last character", () => {
    const full = "A".repeat(20) + "B".repeat(20);
    const typoFix = "A".repeat(20) + "x" + "B".repeat(20);
    expect(speakerRenameDraft(full, typoFix)).toBe(full);
  });
  it("a name stored before the cap can be shortened and edited down without losing its end", () => {
    const long = "Moderatorin der Podiumsdiskussion am Nachmittag"; // 47 code points
    const deleted = long.slice(0, 5) + long.slice(6);
    expect(speakerRenameDraft(long, deleted)).toBe(deleted);
    const replaced = long.slice(0, 5) + "X" + long.slice(6); // a selection replaced: same length
    expect(speakerRenameDraft(long, replaced)).toBe(replaced);
  });
  it("an open IME composition passes uncut; the commit caps it", () => {
    const near = "中".repeat(39);
    expect(speakerRenameDraft(near, near + "zhong", true)).toBe(near + "zhong");
  });
  it("the rename field caps in code points, not with a UTF-16 maxLength", () => {
    expect(viewerSrc).not.toMatch(/maxLength=\{40\}/);
    expect(viewerSrc).toMatch(/setRenameDraft\(speakerRenameDraft\(renameDraft, e\.target\.value, \(e\.nativeEvent as InputEvent\)\.isComposing\)\)/);
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

describe("playRejectionBreaks", () => {
  it("a failed source's NotSupportedError leaves the verdict to the fallback chain", () => {
    expect(playRejectionBreaks("NotSupportedError", false)).toBe(false);
    expect(playRejectionBreaks("AbortError", false)).toBe(false);
  });
  it("no rejection counts while a buffer read or a decode is still in flight", () => {
    expect(playRejectionBreaks("NotSupportedError", true)).toBe(false);
    expect(playRejectionBreaks("NotAllowedError", true)).toBe(false);
  });
  it("another rejection with nothing pending still marks playback broken", () => {
    expect(playRejectionBreaks("NotAllowedError", false)).toBe(true);
    expect(playRejectionBreaks("Error", false)).toBe(true);
  });
});
