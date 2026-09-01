import { describe, expect, it } from "vitest";
import { lastStartedAt, seekKeyTarget } from "./seekKeys";

describe("seekKeyTarget", () => {
  it("steps by 5 s, 30 s with Shift, and clamps to the media length", () => {
    expect(seekKeyTarget("ArrowRight", 10, 100, false)).toBe(15);
    expect(seekKeyTarget("ArrowLeft", 10, 100, true)).toBe(0);
    expect(seekKeyTarget("ArrowUp", 98, 100, false)).toBe(100);
  });
  it("Home/End/Page keys", () => {
    expect(seekKeyTarget("Home", 50, 100, false)).toBe(0);
    expect(seekKeyTarget("End", 50, 100, false)).toBe(100);
    expect(seekKeyTarget("PageUp", 50, 100, false)).toBe(80);
    expect(seekKeyTarget("PageDown", 10, 100, false)).toBe(0);
  });
  it("Space toggles playback; other keys are not the slider's", () => {
    expect(seekKeyTarget(" ", 0, 100, false)).toBe("toggle");
    expect(seekKeyTarget("Tab", 0, 100, false)).toBeNull();
  });
});

describe("lastStartedAt", () => {
  const items = [{ start: 0 }, { start: 1.5 }, { start: 4 }, { start: 9 }];
  it("is -1 for an empty list or a time before the first start", () => {
    expect(lastStartedAt([], 3)).toBe(-1);
    expect(lastStartedAt([{ start: 2 }], 1)).toBe(-1);
  });
  it("picks the index exactly on a boundary and the last one past the end", () => {
    expect(lastStartedAt(items, 1.5)).toBe(1);
    expect(lastStartedAt(items, 4.7)).toBe(2);
    expect(lastStartedAt(items, 100)).toBe(3);
  });
  it("agrees with a reverse linear scan on every sample", () => {
    for (let t = -1; t < 11; t += 0.25) {
      let li = -1;
      for (let i = items.length - 1; i >= 0; i--) if (t >= items[i].start) { li = i; break; }
      expect(lastStartedAt(items, t)).toBe(li);
    }
  });
});
