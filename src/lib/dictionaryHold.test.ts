// A synced change to the selected backend (new address, kind flipped to standard, deleted) must not
// replace the Dictionary's unsaved edits in silence — every manual path already refuses to.
import { describe, expect, it } from "vitest";
import {
  dictionaryConflictText,
  dictionaryHeldResolution,
  dictionaryLandedText,
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

describe("dictionaryLandedText", () => {
  it("keeps the reload wording when the backend did not move", () => {
    expect(dictionaryLandedText("http://a", "http://a", false, false)).toBe(
      " The rules were reloaded from the server — check that your changes are there: a rule changed elsewhere may not have been saved.",
    );
    expect(dictionaryLandedText("http://a", null, true, true)).toBe(
      " Reloading the rules failed — use Retry below, then check that your changes are there.",
    );
    expect(dictionaryLandedText(null, "http://b", true, false)).toBe(
      " Reloading the rules failed — use Refresh above, then check that your changes are there.",
    );
  });

  it("sends the user to the address the changes went to when a sync moved the backend", () => {
    for (const failed of [false, true]) {
      const text = dictionaryLandedText("http://a:8000", "http://b:8000", failed, true);
      expect(text).toContain("went to http://a:8000");
      expect(text).toContain("now points at http://b:8000");
      expect(text).toContain("check http://a:8000 for them");
      expect(text).not.toContain("reloaded from the server");
    }
  });
});

describe("dictionaryConflictText", () => {
  it("keeps the reload wording when the backend did not move", () => {
    expect(dictionaryConflictText("http://a", "http://a", false, false)).toBe(" The latest version has been reloaded.");
    expect(dictionaryConflictText("http://a", null, true, true)).toBe(" Reloading the rules failed — use Retry below to load the latest version.");
    expect(dictionaryConflictText(null, "http://b", true, false)).toBe(" Reloading the rules failed — use Refresh above to load the latest version.");
  });

  it("names the server that reported the conflicts and the one whose rules are shown when a sync moved the backend", () => {
    const text = dictionaryConflictText("http://a:8000", "http://b:8000", false, false);
    expect(text).toContain("http://a:8000");
    expect(text).toContain("now points at http://b:8000, whose rules are shown");
    expect(text).not.toContain("latest version");
    const failed = dictionaryConflictText("http://a:8000", "http://b:8000", true, true);
    expect(failed).toContain("now points at http://b:8000");
    expect(failed).toContain("Retry below");
  });
});

describe("Dictionary save wiring", () => {
  it("reloads after a landed save with the post-save flag and shows where the rules went", () => {
    expect(dictionarySrc).toMatch(/await load\(backend, true\)/);
    expect(dictionarySrc).toMatch(/dictionaryReloadStep\(serverUrl, live, afterSave/);
    expect(dictionarySrc).toMatch(/setResult\(\{ \.\.\.res, savedTo, shownFrom \}\)/);
    // Every post-save banner line reads the move, not only "Saved N rules".
    expect(dictionarySrc).toMatch(/dictionaryLandedText\(result\.savedTo \?\? null, result\.shownFrom \?\? null, reloadFailed, retryBelow\)/);
    expect(dictionarySrc).toMatch(/dictionaryConflictText\(result\.savedTo \?\? null, result\.shownFrom \?\? null, reloadFailed, retryBelow\)/);
  });
});
