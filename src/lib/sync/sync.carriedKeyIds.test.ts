// A restore that fails to store the key the user typed cleans up after itself, and must tell a
// key the blob carried (the apply has just written it) from one a removed backend left behind:
// the carried ids are read with the rule the apply writes by.
import { describe, expect, it } from "vitest";
import { carriedKeyIds } from "./sync";
import { MAX_SECRET_LEN } from "../backendKeyWrite";
import { backend } from "./syncTestFixtures";

describe("carriedKeyIds: the keys an apply writes", () => {
  const list = [backend({ id: "b1" }), backend({ id: "b2" }), backend({ id: "constructor" })];

  it("holds the installed ids the blob carries a key for", () => {
    expect([...carriedKeyIds(list, { b1: "peer-key", b9: "not installed" })]).toEqual(["b1"]);
    expect([...carriedKeyIds(list, { b2: "x".repeat(MAX_SECRET_LEN), b1: "peer-key" })]).toEqual(["b1", "b2"]);
  });

  it("leaves out a key the apply would not write", () => {
    // Empty, not a string, over the stored bound, or only inherited (the `constructor` id).
    expect(carriedKeyIds(list, { b1: "", b2: "x".repeat(MAX_SECRET_LEN + 1) }).size).toBe(0);
    expect(carriedKeyIds(list, { b1: 7, b2: null }).size).toBe(0);
    for (const container of [undefined, null, "b1", ["b1"]]) {
      expect(carriedKeyIds(list, container).size).toBe(0);
    }
  });

  it("is empty when the apply installs no backends", () => {
    expect(carriedKeyIds([], { b1: "peer-key" }).size).toBe(0);
  });
});
