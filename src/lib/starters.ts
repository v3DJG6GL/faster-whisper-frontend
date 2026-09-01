// The suggested starter Profiles a fresh install confirms during onboarding (or
// on the Profiles screen via the checklist path). These replaced the old silent
// seeds: nothing is created until the user confirms. Ids keep the familiar
// legacy strings so docs/muscle memory stay valid. Default chords (user-set
// 2026-07-13, replacing the nested Ctrl+Shift family): hold Ctrl+Shift =
// push-to-talk, Ctrl+Super = hands-free, Super+Alt = quick add — three independent
// chords, so chord_engine.rs's designed nesting (hold ⊂ hands-free = in-place
// upgrade) does not apply between the DEFAULTS; the engine still supports it for
// a user-configured hands-free superset.

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
      name: "Hands-free",
      activation: "handsfree",
      enabled: true,
      hotkey: ["ControlLeft", "MetaLeft"],
      backendId,
    },
  ];
}
