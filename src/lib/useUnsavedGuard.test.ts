// "Save and leave" must only leave when the save actually persisted: both the App Rules
// editor (a rule with no app id) and the Backends editor (a failed keyring write) can abort
// their save, and leaving anyway discarded the draft the button promised to keep.
import { describe, expect, it, vi } from "vitest";
import { afterSave, isDirty } from "./useUnsavedGuard";

describe("afterSave", () => {
  it("leaves after a save that returns nothing or true", () => {
    const go = vi.fn();
    afterSave(undefined, go);
    afterSave(true, go);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it("stays after a save that reports it did not persist", () => {
    const go = vi.fn();
    afterSave(false, go);
    expect(go).not.toHaveBeenCalled();
  });

  it("awaits an async save and honours its answer", async () => {
    const go = vi.fn();
    afterSave(Promise.resolve(false), go);
    afterSave(Promise.resolve(undefined), go);
    afterSave(Promise.resolve(true), go);
    await Promise.resolve();
    await Promise.resolve();
    expect(go).toHaveBeenCalledTimes(2);
  });
});

describe("isDirty", () => {
  it("treats a cleared field (undefined) as unchanged", () => {
    expect(isDirty({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });

  it("an empty override object is a change unless the editor normalizes it away", () => {
    // Documents why Profiles normalizes `{}` → undefined on change, not only on save.
    expect(isDirty({ insertionOverrides: {} }, {})).toBe(true);
  });
});
