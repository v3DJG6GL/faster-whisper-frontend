import { describe, expect, it } from "vitest";
import { conflicts, findChordConflict, quickAddPeer, QUICK_ADD_PEER_ID } from "./conflicts";
import type { Profile } from "./types";

// These rules gate three surfaces at once — the per-card banner, the capture-time
// warn, and the persistence save-gate that freezes ALL config saving — and their
// header demands lockstep with the chord engine. Nothing pinned them until now:
// a flipped exemption direction or a collapsed-sides regression passed every test.

let n = 0;
function prof(hotkey: string[], activation: "hold" | "handsfree" = "hold", extra: Partial<Profile> = {}): Profile {
  n += 1;
  return {
    id: `p${n}`,
    name: `P${n}`,
    activation,
    enabled: true,
    hotkey,
    backendId: null,
    ...extra,
  } as Profile;
}

describe("conflicts — designed nesting exemption", () => {
  it("a hold nested inside a hands-free chord is the designed family, not a shadow", () => {
    expect(conflicts([prof(["ControlLeft", "ShiftLeft"]), prof(["ControlLeft", "ShiftLeft", "Space"], "handsfree")])).toEqual([]);
  });
  it("a hold nested inside the quick-add chord is a shadow (the abort-and-open nesting is gone)", () => {
    const found = conflicts([prof(["ControlLeft", "ShiftLeft"]), quickAddPeer(["ControlLeft", "ShiftLeft", "KeyQ"])]);
    expect(found.some((c) => c.kind === "shadow" && c.otherId === QUICK_ADD_PEER_ID)).toBe(true);
  });
  it("the exemption is DIRECTIONAL: a hands-free chord inside a hold superset is a real shadow", () => {
    const found = conflicts([prof(["ControlLeft", "ShiftLeft"], "handsfree"), prof(["ControlLeft", "ShiftLeft", "Space"])]);
    expect(found.some((c) => c.kind === "shadow")).toBe(true);
  });
  it("hold inside hold stays a shadow", () => {
    const found = conflicts([prof(["ControlLeft"]), prof(["ControlLeft", "ShiftLeft"])]);
    expect(found.some((c) => c.kind === "shadow")).toBe(true);
  });
  it("identical chords are duplicates regardless of kind", () => {
    const found = conflicts([prof(["ControlLeft", "ShiftLeft"]), prof(["ControlLeft", "ShiftLeft"], "handsfree")]);
    expect(found.every((c) => c.kind === "duplicate")).toBe(true);
    expect(found).toHaveLength(2);
  });
  it("disabled or chord-less profiles never conflict", () => {
    expect(
      conflicts([prof(["ControlLeft", "ShiftLeft"]), prof(["ControlLeft", "ShiftLeft"], "hold", { enabled: false }), prof([])]),
    ).toEqual([]);
  });
});

describe("conflicts — collapseSides", () => {
  const sides = [prof(["ControlLeft", "ShiftLeft"]), prof(["ControlRight", "ShiftLeft"])];
  it("side-only differences are duplicates when a plugin backend owns the chords", () => {
    expect(conflicts(sides, true).length).toBeGreaterThan(0);
  });
  it("and distinct when a low-level backend can tell sides apart", () => {
    expect(conflicts(sides, false)).toEqual([]);
  });

  // The inbound-blob sanitizer calls `conflicts(peers, !IS_WINDOWS)` and turns the later
  // member of every collision OFF. Both flag values are pinned here so the Windows side
  // (side-distinct chords the low-level hook really registers) cannot regress into a
  // silent mass-disable on every pull.
  it("LCtrl+Space vs RCtrl+Space: a duplicate only where sides collapse", () => {
    const pair = [prof(["ControlLeft", "Space"]), prof(["ControlRight", "Space"])];
    expect(conflicts(pair, true).every((c) => c.kind === "duplicate")).toBe(true);
    expect(conflicts(pair, true)).toHaveLength(2);
    expect(conflicts(pair, false)).toEqual([]);
  });
});

describe("findChordConflict — capture-time twin", () => {
  const others = [prof(["ControlLeft", "ShiftLeft", "Space"], "handsfree")];
  it("binding a hold under an existing hands-free superset is allowed", () => {
    expect(findChordConflict(["ControlLeft", "ShiftLeft"], others, false, "hold")).toBeNull();
  });
  it("binding a hands-free chord under a hands-free superset is a shadow", () => {
    const hit = findChordConflict(["ControlLeft", "ShiftLeft"], others, false, "handsfree");
    expect(hit?.kind).toBe("shadow");
  });
  it("the quick-add peer reports its reserved id on a duplicate", () => {
    const hit = findChordConflict(["AltLeft", "MetaLeft"], [quickAddPeer(["AltLeft", "MetaLeft"])]);
    expect(hit).toMatchObject({ id: QUICK_ADD_PEER_ID, kind: "duplicate" });
  });
});
