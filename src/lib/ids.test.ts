import { describe, expect, it } from "vitest";
import { newProgressId } from "./ids";

describe("newProgressId", () => {
  it("32 lowercase hex — the server's progress-id shape — and fresh each time", () => {
    const a = newProgressId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newProgressId()).not.toBe(a);
  });
});
