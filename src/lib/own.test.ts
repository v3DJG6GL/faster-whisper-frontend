import { describe, expect, it } from "vitest";
import { hasOwn, ownProp } from "./own";

// Untrusted ids that collide with Object.prototype members must read as ABSENT: `map[id]`
// and `id in map` both see the inherited function, which is the bug class own.ts exists for.
const PROTO_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];

describe("ownProp", () => {
  it("reads own keys normally", () => {
    const map: Record<string, number> = { a: 1, zero: 0 };
    expect(ownProp(map, "a")).toBe(1);
    expect(ownProp(map, "zero")).toBe(0);
  });

  it("reads missing keys as undefined", () => {
    expect(ownProp({ a: 1 }, "b")).toBeUndefined();
  });

  it("reads inherited prototype keys as absent", () => {
    const map: Record<string, number> = { a: 1 };
    for (const k of PROTO_KEYS) {
      expect(k in map, k).toBe(true); // the trap: `in` and `[]` see the prototype
      expect(ownProp(map, k), k).toBeUndefined();
    }
  });

  it("reads a prototype-named key the map really owns", () => {
    const map: Record<string, string> = { constructor: "mine", toString: "also mine" };
    expect(ownProp(map, "constructor")).toBe("mine");
    expect(ownProp(map, "toString")).toBe("also mine");
  });

  it("treats null and undefined maps as empty", () => {
    expect(ownProp(null, "a")).toBeUndefined();
    expect(ownProp(undefined, "constructor")).toBeUndefined();
  });
});

describe("hasOwn", () => {
  it("is true for own keys, including falsy values", () => {
    const map: Record<string, unknown> = { a: 1, zero: 0, empty: "", nil: null, undef: undefined };
    for (const k of Object.keys(map)) expect(hasOwn(map, k), k).toBe(true);
  });

  it("is false for missing and inherited prototype keys", () => {
    const map: Record<string, unknown> = { a: 1 };
    expect(hasOwn(map, "b")).toBe(false);
    for (const k of PROTO_KEYS) expect(hasOwn(map, k), k).toBe(false);
  });

  it("is true for a prototype-named key the map really owns", () => {
    expect(hasOwn({ toString: 1 }, "toString")).toBe(true);
    // A JSON-parsed `__proto__` is an own data property, not the prototype setter.
    expect(hasOwn(JSON.parse('{"__proto__": 1}') as Record<string, unknown>, "__proto__")).toBe(true);
  });

  it("is false for null and undefined maps", () => {
    expect(hasOwn(null, "a")).toBe(false);
    expect(hasOwn(undefined, "a")).toBe(false);
  });
});
