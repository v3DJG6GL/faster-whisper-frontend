// The starter chords are modifier-only: on Linux without an active evdev backend the plugin skips
// them with only a log line, so "Keep these" / "Confirm & continue" would commit shortcuts that
// never fire — both starter surfaces say so.
import { describe, expect, it } from "vitest";
import { needsLowLevel } from "./keys";
import { STARTERS_LOW_LEVEL_NOTE, starterProfiles, startersClearOf, startersNeedLowLevelNote } from "./starters";
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
    const suggested = starterProfiles(null).map((p) => p.hotkey);
    expect(startersNeedLowLevelNote(true, false, suggested)).toBe(true);
    expect(startersNeedLowLevelNote(true, true, suggested)).toBe(false);
    expect(startersNeedLowLevelNote(true, null, suggested)).toBe(false); // not answered yet
    expect(startersNeedLowLevelNote(false, false, suggested)).toBe(false);
    expect(STARTERS_LOW_LEVEL_NOTE).toMatch(/evdev/);
  });

  it("judges the chords being committed, not the fixed suggestion", () => {
    // Onboarding's drafts rebound to plugin-registrable chords (the capture refuses modifier-only
    // ones without evdev), or left unbound: nothing needs evdev, so no note.
    expect(startersNeedLowLevelNote(true, false, [["ControlLeft", "F9"], ["ControlLeft", "F10"]])).toBe(false);
    expect(startersNeedLowLevelNote(true, false, [[], ["ControlLeft", "KeyJ"]])).toBe(false);
    expect(startersNeedLowLevelNote(true, false, [[], []])).toBe(false);
    // One draft still modifier-only: the note stays.
    expect(startersNeedLowLevelNote(true, false, [["ControlLeft", "F9"], ["ControlLeft", "MetaLeft"]])).toBe(true);
  });

  // A quick-add chord that collides with both starters (Ctrl alone, or a modifier superset such as
  // Ctrl+Shift+Super, left by sync or an earlier evdev session) makes "Keep these" commit both
  // UNBOUND: the card warned about modifier-only shortcuts it never created.
  it("judges the starters the Profiles card's Keep commits, cleared of the quick-add chord", () => {
    for (const qa of [["ControlLeft"], ["ControlLeft", "ShiftLeft", "MetaLeft"]]) {
      const kept = startersClearOf("b1", qa, true).map((p) => p.hotkey);
      expect(kept).toEqual([[], []]);
      expect(startersNeedLowLevelNote(true, false, kept)).toBe(false);
    }
    // One cleared, the other still modifier-only: the note stays.
    expect(startersNeedLowLevelNote(true, false, startersClearOf("b1", ["ControlLeft", "ShiftLeft"], true).map((p) => p.hotkey))).toBe(true);
  });

  it("the Profiles starters card and the onboarding starters step both render it", () => {
    // The card computes the starters once and both the note and "Keep these" use them.
    expect(profilesSrc).toContain(
      "const keptStarters = startersClearOf(backends[0]?.id ?? null, quickAddHotkey, !lowLevelActive);",
    );
    expect(profilesSrc).toMatch(
      /startersNeedLowLevelNote\(\s*IS_LINUX,\s*evdev === null \? null : lowLevelActive,\s*keptStarters\.map\(\(p\) => p\.hotkey\),?\s*\)[\s\S]{0,120}STARTERS_LOW_LEVEL_NOTE/,
    );
    expect(profilesSrc).toMatch(/for \(const p of keptStarters\) upsertProfile\(p\);/);
    expect(onboardingSrc).toMatch(
      /startersNeedLowLevelNote\(IS_LINUX, lowLevelKnown \? lowLevel : null, drafts\.map\(\(d\) => d\.hotkey\)\)[\s\S]{0,160}STARTERS_LOW_LEVEL_NOTE/,
    );
  });
});
