import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// No DOM in this suite: OverrideText runs as a plain function (its one useState keeps its initial
// value) and the returned field's onChange is called directly.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (init: unknown) => [init, () => {}] };
});

import { OverrideText } from "./OverrideField";
import { capEdit } from "@/lib/sanitize";

// A full SUPPRESS_CHARS-style field (64 characters, cap 64).
const stored = "abcdefghij".repeat(6) + "wxyz";

function edit(value: string | undefined, typed: string, maxLength = 64): string[] {
  const got: string[] = [];
  const el = OverrideText({ value, onChange: (v) => got.push(v), maxLength, ariaLabel: "SUPPRESS_CHARS" }) as ReactElement<{
    onChange: (e: { target: { value: string } }) => void;
  }>;
  el.props.onChange({ target: { value: typed } });
  return got;
}

describe("OverrideText keeps a full field's text on an insert", () => {
  it("typing at the start of a full field drops the typed character, not the field's last one", () => {
    expect(edit(stored, "X" + stored)).toEqual([stored]);
  });

  it("a paste into the middle keeps only what fits", () => {
    const prev = "abcdef";
    expect(edit(prev, "abc1234567def", 8)).toEqual(["abc12def"]);
  });

  it("a paste into an empty field is cut to the cap", () => {
    expect(edit(undefined, "x".repeat(70))).toEqual(["x".repeat(64)]);
  });

  it("a value stored over the cap can still shorten", () => {
    const over = stored + "!!";
    expect(edit(over, over.slice(1))).toEqual([over.slice(1)]);
  });
});

describe("capEdit", () => {
  it("never cuts half a surrogate pair from the inserted run", () => {
    expect(capEdit("ab", "a\u{1F3AC}\u{1F3AC}b", 3)).toBe("a\u{1F3AC}b");
  });
});
