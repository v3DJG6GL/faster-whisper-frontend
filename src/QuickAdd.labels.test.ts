// The Quick-Add capture row's captions are sibling <label>s with no htmlFor, so they tie to
// nothing: without a name of their own the find field was announced as its placeholder
// "say a word…" and the Insert field as "comma, edit".
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`).
import quickAddSrc from "./QuickAdd.tsx?raw";

describe("Quick-Add capture row field names", () => {
  it("the find combobox is named after its caption", () => {
    expect(quickAddSrc).toMatch(/<Combobox[^>]*?placeholder="say a word…"[^>]*?ariaLabel="When you say"/);
  });

  it("the Insert field is named after its caption", () => {
    expect(quickAddSrc).toMatch(/<TextInput\s+ref=\{insertRef\}[^>]*?aria-label="Insert"/);
  });
});
