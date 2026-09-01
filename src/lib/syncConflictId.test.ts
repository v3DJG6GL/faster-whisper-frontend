import { describe, expect, it } from "vitest";
import { getPendingConflict, raiseConflictForTests } from "./sync";

// The conflict dialog's body is keyed on this id: a second conflict must get a
// NEW id so React remounts it with fresh picks — a retained "remote" pick from
// the previous conflict would silently hand the peer a category, no prompt.
describe("pending-conflict identity", () => {
  it("each raised conflict gets a distinct id", () => {
    raiseConflictForTests();
    const first = getPendingConflict();
    raiseConflictForTests();
    const second = getPendingConflict();
    expect(first?.id).toBeTypeOf("number");
    expect(second?.id).not.toBe(first?.id);
  });
});
