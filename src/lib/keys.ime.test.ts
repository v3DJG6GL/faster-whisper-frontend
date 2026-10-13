import { describe, expect, it } from "vitest";
import { imeComposing } from "./keys";

const dom = (isComposing: boolean, keyCode: number) => ({ isComposing, keyCode }) as KeyboardEvent;

describe("imeComposing", () => {
  it("reads a DOM event's composition flag or WebKit's keyCode 229", () => {
    expect(imeComposing(dom(true, 13))).toBe(true);
    expect(imeComposing(dom(false, 229))).toBe(true);
    expect(imeComposing(dom(false, 13))).toBe(false);
  });

  it("reads a React event through its native event", () => {
    expect(imeComposing({ nativeEvent: dom(true, 13), keyCode: 13 })).toBe(true);
    expect(imeComposing({ nativeEvent: dom(false, 229), keyCode: 229 })).toBe(true);
    expect(imeComposing({ nativeEvent: dom(false, 27), keyCode: 27 })).toBe(false);
  });
});
