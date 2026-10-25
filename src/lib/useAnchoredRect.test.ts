import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { popoverBox } from "./useAnchoredRect";

// `grow` sizes a Select's list to its content, so a short trigger ("Ctrl + V") does not cut every
// longer option to "Ctrl …": never under the trigger, growing toward the side with room and capped
// 8 px inside the viewport.
describe("popoverBox grow", () => {
  beforeEach(() => vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 }));
  afterEach(() => vi.unstubAllGlobals());

  it("grows leftward from a right-aligned trigger, pinned at its right edge", () => {
    const { style } = popoverBox({ left: 800, width: 150, top: 100, bottom: 132 }, { minWidth: 0, grow: true });
    expect(style).toMatchObject({ position: "fixed", right: 50, width: "max-content", minWidth: 150, maxWidth: 942, top: 136 });
    expect(style).not.toHaveProperty("left");
  });

  it("grows rightward from a trigger in the left half, pinned at its left edge", () => {
    const { style } = popoverBox({ left: 40, width: 150, top: 100, bottom: 132 }, { minWidth: 0, grow: true });
    expect(style).toMatchObject({ left: 40, width: "max-content", minWidth: 150, maxWidth: 952 });
    expect(style).not.toHaveProperty("right");
  });

  it("keeps a trigger poking past the window's edge 8 px inside it", () => {
    const { style } = popoverBox({ left: 900, width: 200, top: 100, bottom: 132 }, { minWidth: 0, grow: true });
    expect(style).toMatchObject({ right: 8, minWidth: 200, maxWidth: 984 });
  });

  it("without grow is still the anchor's width from its left edge", () => {
    const { style } = popoverBox({ left: 800, width: 150, top: 100, bottom: 132 }, { minWidth: 0 });
    expect(style).toMatchObject({ left: 800, width: 150 });
  });
});
