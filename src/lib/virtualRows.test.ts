import { describe, expect, it } from "vitest";
import { rowsToRender } from "./virtualRows";

describe("rowsToRender", () => {
  it("adds the pinned row outside the window, in index order", () => {
    expect(rowsToRender([10, 11, 12], 500, 702)).toEqual([10, 11, 12, 500]);
    expect(rowsToRender([10, 11, 12], 3, 702)).toEqual([3, 10, 11, 12]);
  });
  it("leaves the window alone when the pin is inside it, absent or out of range", () => {
    expect(rowsToRender([10, 11, 12], 11, 702)).toEqual([10, 11, 12]);
    expect(rowsToRender([10, 11, 12], -1, 702)).toEqual([10, 11, 12]);
    expect(rowsToRender([10, 11, 12], 702, 702)).toEqual([10, 11, 12]);
  });
  it("without a window: a screenful around the pin, or from the top", () => {
    expect(rowsToRender([], 100, 702, 2)).toEqual([98, 99, 100, 101, 102]);
    expect(rowsToRender([], -1, 702, 2)).toEqual([0, 1, 2]);
    expect(rowsToRender([], 701, 702, 2)).toEqual([699, 700, 701]);
    expect(rowsToRender([], -1, 0, 2)).toEqual([]);
  });
});
