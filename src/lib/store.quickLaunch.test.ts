// Quick-launch entries from a loaded or pulled settings blob: the editor keys rows and removes by
// id, so duplicate ids from a foreign blob collapse to the first entry at the choke point.

import { describe, expect, it } from "vitest";
import { withSettingsDefaults } from "./store";

describe("quick-launch entries on load", () => {
  it("keeps only the first entry per id", () => {
    const s = withSettingsDefaults({
      recording: {
        quickLaunch: [
          { id: "a", kind: "page", target: "dashboard" },
          { id: "b", kind: "page", target: "history" },
          { id: "a", kind: "page", target: "settings" },
        ],
      },
    });
    expect(s.recording.quickLaunch).toEqual([
      { id: "a", kind: "page", target: "dashboard" },
      { id: "b", kind: "page", target: "history" },
    ]);
  });

  it("dedupes only among valid entries", () => {
    const s = withSettingsDefaults({
      recording: { quickLaunch: [{ id: "a", kind: 1, target: "x" }, { id: "a", kind: "page", target: "history" }] },
    });
    expect(s.recording.quickLaunch).toEqual([{ id: "a", kind: "page", target: "history" }]);
  });

  it("drops entries with an oversized field, before the dedupe, and keeps real ones", () => {
    const big = "x".repeat(40_000);
    const hostile = Array.from({ length: 100 }, (_, i) => ({ id: `${i}${big}`, kind: "screen", target: big }));
    const real = { id: "123e4567-e89b-12d3-a456-426614174000", kind: "action", target: "cycle-active-profile" };
    const s = withSettingsDefaults({
      recording: { quickLaunch: [{ id: real.id, kind: big, target: "history" }, ...hostile, real] },
    });
    expect(s.recording.quickLaunch).toEqual([real]);
  });
});
