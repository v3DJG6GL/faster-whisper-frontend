import { describe, expect, it } from "vitest";
import { exportOutcomeShowsHere } from "./mediaExport";

describe("exportOutcomeShowsHere", () => {
  it("lands on the panel only while it is mounted and shows the Save's own record", () => {
    expect(exportOutcomeShowsHere(true, "rec-1", "rec-1")).toBe(true);
    // Another record on screen: the banner reports it.
    expect(exportOutcomeShowsHere(true, "rec-2", "rec-1")).toBe(false);
  });

  it("a panel unmounted mid-export (History opened, record closed) reports on the banner", () => {
    // The owner ref keeps the last record after unmount; that alone must not claim the outcome.
    expect(exportOutcomeShowsHere(false, "rec-1", "rec-1")).toBe(false);
  });
});
