// "Address on this device" routes every request for its backend (dictation, and the editor probes
// that carry the stored key), so a half-typed value must never become that address: the field
// edits a draft and commits it on blur, Enter or the editor closing — never per keystroke.
import { describe, expect, it } from "vitest";
import src from "./Backends.tsx?raw";

const field = (() => {
  const start = src.indexOf('aria-label="Address on this device"');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("/>", start));
})();

describe("Address on this device commits on blur / Enter only", () => {
  it("edits a local draft, not the store, on each keystroke", () => {
    expect(field).toContain("value={overrideDraft}");
    expect(field).toContain("onChange={(e) => editOverride(e.target.value)}");
    expect(field).not.toMatch(/onChange=\{[^}]*setUrlOverride/);
  });

  it("commits on blur and on Enter", () => {
    expect(field).toContain("onBlur={commitOverride}");
    expect(field).toMatch(/e\.key === "Enter"\) commitOverride\(\)/);
  });

  it("writes the store only from the commit and the close-mid-edit cleanup", () => {
    const writes = src.match(/setUrlOverride\(/g) ?? [];
    expect(writes).toHaveLength(2);
    expect(src).toMatch(/const commitOverride = \(\) => \{[\s\S]*?setUrlOverride\(initial\.id, v\);/);
    expect(src).toMatch(/if \(overrideEditing\.current\) setUrlOverride\(initial\.id, overrideDraftRef\.current\);/);
  });

  it("takes a store change made elsewhere unless the user is mid-edit", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!overrideEditing\.current\) \{[\s\S]*?setOverrideDraft\(urlOverride\);[\s\S]*?\}, \[urlOverride\]\);/);
  });

  it("routes requests by the committed value, not the draft", () => {
    expect(src).toContain("const effUrl = urlOverride.trim() || b.serverUrl;");
  });
});
