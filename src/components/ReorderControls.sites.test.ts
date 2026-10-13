// The reorder arrows outside Profiles and Backends: a row keyed by id with native `disabled` arrows
// dropped keyboard focus to <body> on every move and at the top/bottom. ReorderControls' own
// aria-disabled + refocus pattern is what keeps it (see its header).
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`).
import dictionarySrc from "../screens/Dictionary.tsx?raw";
import quickLaunchSrc from "./settings/QuickLaunchEditor.tsx?raw";

describe("reorder arrows keep keyboard focus", () => {
  it("the Dictionary regex list moves its entries with ReorderControls, not native-disabled buttons", () => {
    expect(dictionarySrc).toMatch(/<ReorderControls[\s\S]*?canUp=\{!saving && i > 0\}/);
    expect(dictionarySrc).not.toMatch(/title="Move (up|down)"[^>]*disabled=/);
  });

  it("the quick-launch editor moves its buttons with ReorderControls, not native-disabled buttons", () => {
    expect(quickLaunchSrc).toMatch(/<ReorderControls[\s\S]*?canUp=\{!disabled && i > 0\}/);
    expect(quickLaunchSrc).not.toMatch(/title="Move (up|down)"/);
  });
});
