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
});
