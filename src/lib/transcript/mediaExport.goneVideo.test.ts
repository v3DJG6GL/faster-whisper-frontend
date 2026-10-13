import { describe, expect, it } from "vitest";
import { isGoneSourceError, withoutVideoPath } from "./mediaExport";

describe("withoutVideoPath", () => {
  it("drops the deleted local video copy and keeps every other field", () => {
    const rec = { id: "r1", videoPath: "/base/video/r1.mkv", mediaPath: "/base/url/r1.m4a", title: "Talk" };
    const out = withoutVideoPath(rec);
    expect(out).toEqual({ id: "r1", mediaPath: "/base/url/r1.m4a", title: "Talk" });
    expect("videoPath" in out).toBe(false);
    // The input record (a mirror snapshot) is not mutated.
    expect(rec.videoPath).toBe("/base/video/r1.mkv");
  });

  it("hands a record without a copy back unchanged, so patchRecord writes nothing", () => {
    const rec: { id: string; videoPath?: string } = { id: "r2" };
    expect(withoutVideoPath(rec)).toBe(rec);
  });
});

describe("isGoneSourceError", () => {
  it("matches the source read's not-found on every platform", () => {
    expect(isGoneSourceError("reading the media file: No such file or directory (os error 2)")).toBe(true);
    expect(isGoneSourceError("reading the video file: No such file or directory (os error 2)")).toBe(true);
    expect(isGoneSourceError("reading the video file: The system cannot find the file specified. (os error 2)")).toBe(true);
    expect(isGoneSourceError("reading the media file: The system cannot find the path specified. (os error 3)")).toBe(true);
    expect(isGoneSourceError(new Error("reading the video file: No such file or directory (os error 2)"))).toBe(true);
  });

  it("never matches another failure — a missing export folder, a denied read, a network error", () => {
    expect(isGoneSourceError("No such file or directory (os error 2)")).toBe(false);
    expect(isGoneSourceError("the export folder does not exist")).toBe(false);
    expect(isGoneSourceError("reading the media file: Permission denied (os error 13)")).toBe(false);
    expect(isGoneSourceError("reading the video file: No such file or directory (os error 21)")).toBe(false);
    expect(isGoneSourceError("Could not connect to the server")).toBe(false);
  });
});
