// The starter chords are modifier-only: on Linux without an active evdev backend the plugin skips
// them with only a log line, so "Keep these" / "Confirm & continue" committed shortcuts that never
// fire. Both starter surfaces now say so.
import { describe, expect, it } from "vitest";
import { needsLowLevel } from "./keys";
import { STARTERS_LOW_LEVEL_NOTE, starterProfiles, startersNeedLowLevelNote } from "./starters";
// Raw source (vite `?raw`).
import profilesSrc from "../screens/Profiles.tsx?raw";
import onboardingSrc from "../screens/Onboarding.tsx?raw";

describe("needsLowLevel mirrors codes_to_accelerator's None rule", () => {
  it.each([
    [["ControlLeft", "ShiftLeft"], true], // modifier-only
    [["ControlLeft", "MetaLeft"], true],
    [["AltRight", "KeyA"], true], // AltGr
    [["ControlLeft", "KeyA", "KeyB"], true], // multi-key
    [["ControlLeft", "KeyA"], false],
    [["F9"], false],
    [[], false], // unbound
  ] as const)("%j → %s", (codes, want) => {
    expect(needsLowLevel([...codes])).toBe(want);
  });
});

describe("starters low-level note", () => {
  it("every starter chord needs a low-level backend", () => {
    for (const p of starterProfiles(null)) expect(needsLowLevel(p.hotkey)).toBe(true);
  });

  it("shows on Linux once evdevStatus says no low-level backend is live", () => {
    expect(startersNeedLowLevelNote(true, false)).toBe(true);
    expect(startersNeedLowLevelNote(true, true)).toBe(false);
    expect(startersNeedLowLevelNote(true, null)).toBe(false); // not answered yet
    expect(startersNeedLowLevelNote(false, false)).toBe(false);
    expect(STARTERS_LOW_LEVEL_NOTE).toMatch(/evdev/);
  });

  it("the Profiles starters card and the onboarding starters step both render it", () => {
    expect(profilesSrc).toMatch(
      /startersNeedLowLevelNote\(IS_LINUX, evdev === null \? null : lowLevelActive\)[\s\S]{0,120}STARTERS_LOW_LEVEL_NOTE/,
    );
    expect(onboardingSrc).toMatch(
      /startersNeedLowLevelNote\(IS_LINUX, lowLevelKnown \? lowLevel : null\)[\s\S]{0,160}STARTERS_LOW_LEVEL_NOTE/,
    );
  });
});
