import { describe, expect, it } from "vitest";
import { conflicts, quickAddPeer } from "./conflicts";
import { starterProfiles } from "./starters";

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
