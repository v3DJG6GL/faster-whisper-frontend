// A collapsed cb:map list makes two separate promises: `hidden` is what the
// "show all" toggle can still reveal, `unshown` is what the render cap keeps
// off screen forever. Conflating them told users the toggle would reveal rows
// the screen never renders.
import { describe, expect, it } from "vitest";
import { collapseCounts } from "./Dictionary";

describe("collapseCounts", () => {
  it("splits the toggle-revealable rows from the ones past the render cap", () => {
    expect(collapseCounts(5000, 15, 500)).toEqual({ hidden: 485, unshown: 4500 });
  });

  it("promises nothing when the whole list already fits under the collapse point", () => {
    expect(collapseCounts(10, 15, 500)).toEqual({ hidden: 0, unshown: 0 });
  });

  it("hides nothing when collapsing is switched off", () => {
    expect(collapseCounts(5000, 0, 500).hidden).toBe(0);
    expect(collapseCounts(5000, 0, 500).unshown).toBe(4500);
  });

  it("between the collapse point and the cap, every hidden row is revealable", () => {
    expect(collapseCounts(200, 15, 500)).toEqual({ hidden: 185, unshown: 0 });
  });
});
