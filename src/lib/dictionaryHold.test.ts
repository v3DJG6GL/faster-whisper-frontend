// A synced change to the selected backend (new address, kind flipped to standard, deleted) must not
// replace the Dictionary's unsaved edits in silence — every manual path already refuses to.
import { describe, expect, it } from "vitest";
import { dictionaryHeldResolution, dictionaryLoadAction, dictionarySelection } from "./dictionaryHold";

describe("dictionaryLoadAction", () => {
  it("keeps unsaved edits when the same backend's address changes", () => {
    expect(dictionaryLoadAction("a", "a", true, false)).toBe("keep-moved");
  });

  it("ends the hold, without a reload, when the same backend is back at the same address", () => {
    expect(dictionaryLoadAction("a", "a", true, true)).toBe("keep");
  });

  it("only a reload for the loaded backend at a NEW address while dirty is a move", () => {
    expect(dictionaryLoadAction("a", "a", true, false)).toBe("keep-moved");
    expect(dictionaryLoadAction("a", "a", false, true)).toBe("reload");
    expect(dictionaryLoadAction("b", "a", true, true)).toBe("reload");
  });

  it("keeps unsaved edits when the loaded backend is no longer a candidate", () => {
    expect(dictionaryLoadAction(null, "a", true, false)).toBe("keep-gone");
  });

  it("reloads when nothing is unsaved", () => {
    expect(dictionaryLoadAction("a", "a", false, false)).toBe("reload");
    expect(dictionaryLoadAction("b", "a", false, false)).toBe("reload");
    expect(dictionaryLoadAction("a", null, false, false)).toBe("reload");
  });

  it("reloads a different backend (only a re-run for the loaded one keeps the document)", () => {
    expect(dictionaryLoadAction("b", "a", true, false)).toBe("reload");
  });

  it("clears when no backend is selected and nothing is held", () => {
    expect(dictionaryLoadAction(null, "a", false, false)).toBe("clear");
    expect(dictionaryLoadAction(null, null, false, false)).toBe("clear");
    expect(dictionaryLoadAction(null, null, true, false)).toBe("clear");
  });
});

describe("dictionarySelection", () => {
  it("holds a vanished selection while there are unsaved edits", () => {
    expect(dictionarySelection("a", ["b", "c"], true)).toBe("a");
  });

  it("falls back to the first candidate once nothing is unsaved", () => {
    expect(dictionarySelection("a", ["b", "c"], false)).toBe("b");
    expect(dictionarySelection(null, ["b", "c"], false)).toBe("b");
    expect(dictionarySelection(null, ["b", "c"], true)).toBe("b");
    expect(dictionarySelection("a", [], false)).toBeNull();
  });

  it("keeps a selection that is still a candidate", () => {
    expect(dictionarySelection("c", ["b", "c"], false)).toBe("c");
    expect(dictionarySelection("c", ["b", "c"], true)).toBe("c");
  });
});

describe("dictionaryHeldResolution", () => {
  it("reloads a moved backend once its kept edits are gone (a rule reset, typed back, Discard)", () => {
    expect(dictionaryHeldResolution("keep-moved", false, true)).toBe("reload");
  });

  it("releases a vanished backend's hold once its kept edits are gone", () => {
    expect(dictionaryHeldResolution("keep-gone", false, false)).toBe("release");
    expect(dictionaryHeldResolution("keep-moved", false, false)).toBe("release");
  });

  it("keeps the hold while edits are unsaved, and does nothing with no hold", () => {
    expect(dictionaryHeldResolution("keep-moved", true, true)).toBeNull();
    expect(dictionaryHeldResolution("keep-gone", true, false)).toBeNull();
    expect(dictionaryHeldResolution(null, false, true)).toBeNull();
  });
});
