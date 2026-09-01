import { describe, expect, it } from "vitest";
import { eventToCode } from "./keys";

// The literal maps are indexed as OWN properties: a synthetic event whose `key` is an
// Object.prototype member name must not read a prototype function as a "modifier side".
describe("eventToCode own-property hygiene", () => {
  it("a prototype-named key never resolves through the maps", () => {
    expect(eventToCode({ code: "", key: "toString", location: 0 })).toBe("");
    expect(eventToCode({ code: "constructor", key: "a", location: 0 })).toBe("constructor");
  });
  it("real keys still resolve", () => {
    expect(eventToCode({ code: "", key: "Control", location: 2 })).toBe("ControlRight");
    expect(eventToCode({ code: "", key: "Enter", location: 3 })).toBe("NumpadEnter");
  });
});
