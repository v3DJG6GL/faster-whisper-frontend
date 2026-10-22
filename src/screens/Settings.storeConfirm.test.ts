// The Recording & history "Delete…" confirms name the exact count they remove. Saving a dictation
// or finishing a run sends no event the tab listens to, so arming must re-read the store stats or
// the confirm promises the count from the last read ("Delete 5 dictations" for a wipe of 50).
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`).
import settingsSrc from "./Settings.tsx?raw";

const KINDS = ["dict", "files", "links", "video", "clear"] as const;

describe("store delete confirms re-read their counts on arm", () => {
  it("the arm helper re-reads the store stats before showing the confirm", () => {
    const body = settingsSrc.match(/const armStoreAction = \(kind: StoreKind\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
    expect(body).toMatch(/refreshStoreStats\(\);[\s\S]*setConfirming\(kind\)/);
  });

  it.each(KINDS)("the %s row arms through the helper, never setConfirming directly", (kind) => {
    expect(settingsSrc).toContain(`onClick={() => armStoreAction("${kind}")}`);
    expect(settingsSrc).not.toContain(`setConfirming("${kind}")`);
  });
});
