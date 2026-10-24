import { describe, expect, it } from "vitest";
import { conflicts, quickAddPeer } from "./hotkeyConflicts";
import { starterProfiles, startersClearOf } from "./starters";

// The "Suggested starters" card commits fixed chords; if the user rebound the
// global quick-add chord to one of them, an unguarded commit would freeze all
// saving on the persistence gate. This pins the collision the guard defends
// against — and that clean chords commit conflict-free.
describe("starter profiles vs quick-add chord", () => {
  it("a quick-add chord equal to a starter chord collides", () => {
    const starters = starterProfiles(null);
    const qa = quickAddPeer(starters[0]!.hotkey);
    expect(conflicts([qa, ...starters]).length).toBeGreaterThan(0);
  });
  it("an unrelated quick-add chord does not", () => {
    const qa = quickAddPeer(["AltLeft", "MetaLeft"]);
    expect(conflicts([qa, ...starterProfiles(null)]).length).toBe(0);
  });
});

// Both starter commit sites (Profiles' card, Onboarding's starter step) take the starters
// through startersClearOf.
describe("startersClearOf", () => {
  it("unbinds only the starter whose chord is the quick-add chord", () => {
    const [hold, handsfree] = starterProfiles("b1");
    const out = startersClearOf("b1", hold!.hotkey, true);
    expect(out[0]!.hotkey).toEqual([]);
    expect(out[1]!.hotkey).toEqual(handsfree!.hotkey);
    expect(out.every((p) => p.backendId === "b1")).toBe(true);
  });
  it("leaves both bound for an unrelated or empty quick-add chord", () => {
    const bound = starterProfiles(null).map((p) => p.hotkey);
    expect(startersClearOf(null, ["AltLeft", "MetaLeft"], true).map((p) => p.hotkey)).toEqual(bound);
    expect(startersClearOf(null, [], true).map((p) => p.hotkey)).toEqual(bound);
  });
});
