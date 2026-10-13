import { describe, expect, it } from "vitest";
import { keyWriteOutcome } from "./backendKeyWrite";

describe("keyWriteOutcome", () => {
  it("saves when the editor is still open and the key unchanged", () => {
    expect(keyWriteOutcome({ left: false, retyped: false, inStore: false })).toEqual({ kind: "save" });
    expect(keyWriteOutcome({ left: false, retyped: false, inStore: true })).toEqual({ kind: "save" });
  });

  it("a discarded new backend is not saved and its fresh keyring entry is rolled back", () => {
    // Add backend → Save (wallet prompt parks the write) → sidebar / back arrow → Discard → unlock.
    expect(keyWriteOutcome({ left: true, retyped: false, inStore: false })).toEqual({ kind: "abandoned", rollBack: true });
  });

  it("a discarded edit of a saved backend is not saved, and its key stays (it already routes with it)", () => {
    expect(keyWriteOutcome({ left: true, retyped: false, inStore: true })).toEqual({ kind: "abandoned", rollBack: false });
  });

  it("leaving wins over a retype", () => {
    expect(keyWriteOutcome({ left: true, retyped: true, inStore: false })).toEqual({ kind: "abandoned", rollBack: true });
    expect(keyWriteOutcome({ left: true, retyped: true, inStore: true })).toEqual({ kind: "abandoned", rollBack: false });
  });

  it("a retype keeps the editor open, rolling back only a backend not in the store", () => {
    expect(keyWriteOutcome({ left: false, retyped: true, inStore: false })).toEqual({ kind: "retyped", rollBack: true });
    expect(keyWriteOutcome({ left: false, retyped: true, inStore: true })).toEqual({ kind: "retyped", rollBack: false });
  });
});
