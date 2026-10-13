import { describe, expect, it, vi } from "vitest";
import { adoptWrittenKey, keyWriteOutcome } from "./backendKeyWrite";
import type { Backend } from "./types";

describe("keyWriteOutcome", () => {
  it("saves when the editor is still open and the key unchanged", () => {
    expect(keyWriteOutcome({ left: false, retyped: false, inStore: false })).toEqual({ kind: "save" });
    expect(keyWriteOutcome({ left: false, retyped: false, inStore: true })).toEqual({ kind: "save" });
  });

  it("a discarded new backend is not saved and its fresh keyring entry is rolled back", () => {
    // Add backend → Save (wallet prompt parks the write) → sidebar / back arrow → Discard → unlock.
    expect(keyWriteOutcome({ left: true, retyped: false, inStore: false })).toEqual({ kind: "abandoned", rollBack: true, keptInStore: false });
  });

  it("a discarded edit of a saved backend is not saved, and its key stays (it already routes with it)", () => {
    expect(keyWriteOutcome({ left: true, retyped: false, inStore: true })).toEqual({ kind: "abandoned", rollBack: false, keptInStore: true });
  });

  it("leaving wins over a retype", () => {
    expect(keyWriteOutcome({ left: true, retyped: true, inStore: false })).toEqual({ kind: "abandoned", rollBack: true, keptInStore: false });
    expect(keyWriteOutcome({ left: true, retyped: true, inStore: true })).toEqual({ kind: "abandoned", rollBack: false, keptInStore: true });
  });

  it("a retype keeps the editor open, rolling back only a backend not in the store", () => {
    expect(keyWriteOutcome({ left: false, retyped: true, inStore: false })).toEqual({ kind: "retyped", rollBack: true, keptInStore: false });
    expect(keyWriteOutcome({ left: false, retyped: true, inStore: true })).toEqual({ kind: "retyped", rollBack: false, keptInStore: true });
  });
});

describe("adoptWrittenKey (a kept key on a saved backend whose draft was not saved)", () => {
  const backend = (hasApiKey: boolean) => ({ id: "b1", name: "GPU", serverUrl: "https://gpu.lan", model: "", hasApiKey }) as Backend;

  it("a keyless backend now claims its key, and the old caller's connection data goes", () => {
    const upsertBackend = vi.fn();
    const forget = vi.fn();
    adoptWrittenKey("b1", { backends: [backend(false)], upsertBackend }, forget);
    expect(upsertBackend).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", hasApiKey: true }));
    expect(forget).toHaveBeenCalledWith("b1");
  });

  it("a keyed backend (a rotation) keeps its record and drops the old caller's data", () => {
    const upsertBackend = vi.fn();
    const forget = vi.fn();
    adoptWrittenKey("b1", { backends: [backend(true)], upsertBackend }, forget);
    expect(upsertBackend).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith("b1");
  });

  it("a backend no longer in the store is left alone", () => {
    const upsertBackend = vi.fn();
    const forget = vi.fn();
    adoptWrittenKey("b2", { backends: [backend(false)], upsertBackend }, forget);
    expect(upsertBackend).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });
});
