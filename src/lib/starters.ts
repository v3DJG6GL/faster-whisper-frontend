// The suggested starter Profiles a fresh install confirms during onboarding (or
// on the Profiles screen via the checklist path). These replaced the old silent
// seeds: nothing is created until the user confirms. Ids keep the familiar
// legacy strings so docs/muscle memory stay valid; the hotkeys are the chord
// family (see src-tauri/src/chord_engine.rs): hold Ctrl+Shift = push-to-talk,
// +Space upgrades to hands-free in place.

import type { Profile } from "./types";

/** Fresh draft objects each call — callers edit them before committing. */
export function starterProfiles(backendId: string | null): Profile[] {
  return [
    {
      id: "hold",
      name: "Push-to-talk",
      activation: "hold",
      enabled: true,
      hotkey: ["ControlLeft", "ShiftLeft"],
      backendId,
    },
    {
      id: "handsfree",
      name: "Latch",
      activation: "latch",
      enabled: true,
      hotkey: ["ControlLeft", "ShiftLeft", "Space"],
      backendId,
    },
  ];
}
