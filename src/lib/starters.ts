// The suggested starter Profiles a fresh install confirms during onboarding (or
// on the Profiles screen via the checklist path). These replaced the old silent
// seeds: nothing is created until the user confirms. Ids keep the familiar
// legacy strings so docs/muscle memory stay valid. Default chords (user-set
// 2026-07-13, replacing the nested Ctrl+Shift family): hold Ctrl+Shift =
// push-to-talk, Ctrl+Super = hands-free, Super+Alt = quick add — three independent
// chords, so chord_engine.rs's designed nesting (hold ⊂ hands-free = in-place
// upgrade) does not apply between the DEFAULTS; the engine still supports it for
// a user-configured hands-free superset.

import { conflicts, quickAddPeer } from "./hotkeyConflicts";
import { needsLowLevel } from "./keys";
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

/** The starters as they may be COMMITTED: the suggestion's chords are fixed but the global
 *  quick-add chord is not, so a starter that collides with it comes back unbound (the card then
 *  asks for a shortcut) instead of writing a conflict that holds every later save on the
 *  persistence gate. One rule for the onboarding step and the Profiles checklist card.
 *  `collapseSides` as `conflicts` takes it — pass true while the registrar is still unknown. */
export function startersClearOf(backendId: string | null, quickAddHotkey: string[], collapseSides: boolean): Profile[] {
  const qa = quickAddHotkey.length > 0 ? [quickAddPeer(quickAddHotkey)] : [];
  return starterProfiles(backendId).map((p) =>
    conflicts([...qa, p], collapseSides).length > 0 ? { ...p, hotkey: [] } : p,
  );
}

/** The starter chords are modifier-only, so on Linux without an active evdev backend the plugin
 *  skips them with only a log line (the capture path refuses the same chord by hand). Both places
 *  that offer the starters say so instead of committing shortcuts that silently never fire. */
export const STARTERS_LOW_LEVEL_NOTE =
  "These shortcuts are modifier-only: on Linux they need the evdev backend (Settings → Permissions), or bind them in your desktop’s shortcut settings.";

/** Show STARTERS_LOW_LEVEL_NOTE? `lowLevelActive` null = evdevStatus hasn't answered yet (no flash).
 *  `hotkeys` = the chords the surface will commit: the onboarding step passes its editable drafts, so
 *  once each is rebound to a chord the plugin can register (or left unbound) the note goes away; the
 *  Profiles card passes its startersClearOf output, which unbinds a starter the quick-add chord
 *  collides with. No default: the fixed suggestion is not what either surface commits. */
export function startersNeedLowLevelNote(
  isLinux: boolean,
  lowLevelActive: boolean | null,
  hotkeys: string[][],
): boolean {
  return isLinux && lowLevelActive === false && hotkeys.some(needsLowLevel);
}
