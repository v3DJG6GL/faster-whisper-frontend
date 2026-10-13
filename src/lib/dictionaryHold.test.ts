// A synced change to the selected backend (new address, kind flipped to standard, deleted) must not
// replace the Dictionary's unsaved edits in silence — every manual path already refuses to.
import { describe, expect, it } from "vitest";
import {
  dictionaryHeldResolution,
  dictionaryLoadAction,
  dictionaryReloadStep,
  dictionarySavedText,
  dictionarySelection,
} from "./dictionaryHold";
// Raw source (vite `?raw`): the screen wiring the pure decisions above stand for.
import dictionarySrc from "../screens/Dictionary.tsx?raw";

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

describe("dictionaryReloadStep", () => {
  it("commits rules fetched from the address the backend still has", () => {
    expect(dictionaryReloadStep("http://a", "http://a", false)).toBe("commit");
    expect(dictionaryReloadStep("http://a", "http://a", true)).toBe("commit");
  });

  it("a plain reload of a moved address leaves the move to the hold", () => {
    expect(dictionaryReloadStep("http://a", "http://b", false)).toBe("bail");
  });

  it("the reload after a landed save fetches the backend's new address instead of keeping the saved edits", () => {
    expect(dictionaryReloadStep("http://a", "http://b", true)).toBe("refetch");
  });

  it("a backend that is gone is never refetched", () => {
    expect(dictionaryReloadStep("http://a", null, true)).toBe("bail");
    expect(dictionaryReloadStep("http://a", null, false)).toBe("bail");
  });
});

describe("dictionarySavedText", () => {
  it("is a bare count when the backend did not move", () => {
    expect(dictionarySavedText(2, "http://a", "http://a")).toBe("Saved 2 rules.");
    expect(dictionarySavedText(1, "http://a", null)).toBe("Saved 1 rule.");
    expect(dictionarySavedText(1, null, "http://b")).toBe("Saved 1 rule.");
  });

  it("names where the rules went and where the backend points now when a sync moved it", () => {
    const text = dictionarySavedText(3, "http://a:8000", "http://b:8000");
    expect(text).toContain("Saved 3 rules to http://a:8000");
    expect(text).toContain("now points at http://b:8000");
  });
});

describe("Dictionary save wiring", () => {
  it("reloads after a landed save with the post-save flag and shows where the rules went", () => {
    expect(dictionarySrc).toMatch(/await load\(backend, true\)/);
    expect(dictionarySrc).toMatch(/dictionaryReloadStep\(serverUrl, live, afterSave/);
    expect(dictionarySrc).toMatch(/setResult\(\{ \.\.\.res, savedTo, shownFrom \}\)/);
  });
});
