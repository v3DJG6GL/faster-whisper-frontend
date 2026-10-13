import { describe, expect, it } from "vitest";
import { copyPathsBeforeWipe, goneVideoRetryRefusal, isGoneSourceError, packageSource, stampCopyPath, stripWipedCopyPath, withoutCopyPath, withoutVideoPath } from "./mediaExport";

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

describe("stripWipedCopyPath after the Delete-videos wipe", () => {
  // The mirror as the wipe begins: r1 and r2 have a copy, r3 has none yet (its link download
  // is still writing the `.tmp` the wipe skips).
  const before = copyPathsBeforeWipe([
    { id: "r1", videoPath: "/base/video/r1.mkv" },
    { id: "r2", videoPath: "/base/video/r2.mp4" },
    { id: "r3" },
  ], "videoPath");

  it("snapshots only the records that had a copy", () => {
    expect([...before]).toEqual([
      ["r1", { path: "/base/video/r1.mkv", stamp: 0 }],
      ["r2", { path: "/base/video/r2.mp4", stamp: 0 }],
    ]);
  });

  it("drops a path the wipe deleted", () => {
    const out = stripWipedCopyPath({ id: "r1", videoPath: "/base/video/r1.mkv" }, "videoPath", before.get("r1"));
    expect("videoPath" in out).toBe(false);
  });

  it("keeps a path re-stamped during the wipe (a download renamed into place)", () => {
    const rec = { id: "r2", videoPath: "/base/video/r2.webm" };
    expect(stripWipedCopyPath(rec, "videoPath", before.get("r2"))).toBe(rec);
  });

  it("leaves a record that had no copy when the wipe began untouched", () => {
    const rec = { id: "r3", videoPath: "/base/video/r3.mp4" };
    expect(before.get("r3")).toBeUndefined();
    expect(stripWipedCopyPath(rec, "videoPath", before.get("r3"))).toBe(rec);
  });
});

describe("stripWipedCopyPath after the Delete-audio-from-links wipe", () => {
  // Link records as the wipe begins: r1 kept its audio, r2 kept audio AND video, r3 has none.
  const records = [
    { id: "r1", mediaPath: "/base/links/r1.m4a" },
    { id: "r2", mediaPath: "/base/links/r2.webm", videoPath: "/base/video/r2.mkv" },
    { id: "r3" },
  ];
  const before = copyPathsBeforeWipe(records, "mediaPath");

  it("snapshots each record's audio copy, not its video", () => {
    expect([...before].map(([id, w]) => [id, w.path])).toEqual([
      ["r1", "/base/links/r1.m4a"],
      ["r2", "/base/links/r2.webm"],
    ]);
  });

  it("drops the deleted audio path and keeps the video copy", () => {
    const out = stripWipedCopyPath(records[1], "mediaPath", before.get("r2"));
    expect(out).toEqual({ id: "r2", videoPath: "/base/video/r2.mkv" });
  });

  it("keeps an audio path re-stamped during the wipe (a Save's fetch landing meanwhile)", () => {
    const rec = { id: "r1", mediaPath: "/base/links/r1.opus" };
    expect(stripWipedCopyPath(rec, "mediaPath", before.get("r1"))).toBe(rec);
  });

  it("leaves a record that had no audio copy when the wipe began untouched", () => {
    const rec = { id: "r3", mediaPath: "/base/links/r3.m4a" };
    expect(stripWipedCopyPath(rec, "mediaPath", before.get("r3"))).toBe(rec);
  });

  it("withoutCopyPath forgets only the named copy", () => {
    expect(withoutCopyPath(records[1], "mediaPath")).toEqual({ id: "r2", videoPath: "/base/video/r2.mkv" });
    expect(withoutCopyPath(records[2], "mediaPath")).toBe(records[2]);
  });
});

describe("goneVideoRetryRefusal", () => {
  const can = { urlVideoOnDemand: true, packageOn: true, embeds: true, destExt: "mkv", container: "mkv" };

  it("retries through the packager when the server can fetch and package", () => {
    expect(goneVideoRetryRefusal(can)).toBeNull();
    // A plain copy (nothing embedded) retries while the confirmed name is the packager's container.
    expect(goneVideoRetryRefusal({ ...can, embeds: false })).toBeNull();
  });

  it("refuses at once on a server that can't package, before fetching the whole video", () => {
    expect(goneVideoRetryRefusal({ ...can, packageOn: false })).toMatch(/can't package/);
    expect(goneVideoRetryRefusal({ ...can, packageOn: false, embeds: false })).toMatch(/can't package/);
  });

  it("refuses on a server that can't fetch from the link, and a plain copy whose name has another container", () => {
    expect(goneVideoRetryRefusal({ ...can, urlVideoOnDemand: false })).toMatch(/can't fetch it again/);
    expect(goneVideoRetryRefusal({ ...can, embeds: false, destExt: "webm" })).toMatch(/save again/);
  });
});

describe("a copy downloaded again to the same path during the wipe", () => {
  // A link's copy is always <folder>/<record id>.<ext>: the re-download carries the wiped path.
  it("survives the wipe: the stamp moved since the snapshot", () => {
    const rec = { id: "s1", videoPath: "/base/video/s1.mkv" };
    const before = copyPathsBeforeWipe([rec], "videoPath");
    // The export's gone-copy retry fetched the video again while the wipe ran.
    const restamped = stampCopyPath("s1", "videoPath", "/base/video/s1.mkv")(rec);
    expect(restamped).toBe(rec);
    expect(stripWipedCopyPath(restamped, "videoPath", before.get("s1"))).toBe(rec);
  });

  it("a record not stamped meanwhile is stripped, as before", () => {
    stampCopyPath("s2", "videoPath", "/base/video/s2.mkv");
    const rec = { id: "s2", videoPath: "/base/video/s2.mkv" };
    const before = copyPathsBeforeWipe([rec], "videoPath");
    expect("videoPath" in stripWipedCopyPath(rec, "videoPath", before.get("s2"))).toBe(false);
  });

  it("counts each field apart: a fresh audio copy does not shield the wiped video", () => {
    const rec = { id: "s3", mediaPath: "/base/links/s3.m4a", videoPath: "/base/video/s3.mkv" };
    const before = copyPathsBeforeWipe([rec], "videoPath");
    stampCopyPath("s3", "mediaPath", "/base/links/s3.m4a");
    expect(stripWipedCopyPath(rec, "videoPath", before.get("s3"))).toEqual({ id: "s3", mediaPath: "/base/links/s3.m4a" });
  });

  it("stamps a new path onto the record", () => {
    const rec: { id: string; mediaPath?: string } = { id: "s4" };
    expect(stampCopyPath("s4", "mediaPath", "/base/links/s4.opus")(rec)).toEqual({ id: "s4", mediaPath: "/base/links/s4.opus" });
  });
});

describe("packageSource", () => {
  it("packages a stored server id and still names the local copy, so Rust can refuse saving over it", () => {
    expect(packageSource("m1", "/v/talk.mkv")).toEqual({ sourceMediaId: "m1", localSource: "/v/talk.mkv" });
    expect(packageSource("m1", null)).toEqual({ sourceMediaId: "m1", localSource: null });
  });

  it("uploads the local file when no stored id is usable, and has nothing without either", () => {
    expect(packageSource(null, "/v/talk.mkv")).toEqual({ sourcePath: "/v/talk.mkv" });
    expect(packageSource(null, null)).toBeNull();
  });
});
