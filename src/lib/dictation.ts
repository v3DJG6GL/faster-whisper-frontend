// Shared dictation controller. Resolves a mode's profile and starts/stops the
// session, reusing the streaming/batch path. Driven by global triggers (CLI /
// hotkeys) and by in-app affordances.

import { useApp } from "./store";
import { startLive, stopLive } from "./streaming";
import type { DictationModeId } from "./types";

export type TriggerAction = "start" | "stop" | "toggle";

function isActive(): boolean {
  const s = useApp.getState().status;
  return s === "listening" || s === "transcribing";
}

export function dictate(modeId: DictationModeId, action: TriggerAction): void {
  const s = useApp.getState();
  const mode = s.modes.find((m) => m.mode === modeId);
  if (!mode || !mode.enabled) return;
  const profile = s.profiles.find((p) => p.id === mode.profileId) ?? s.profiles[0];
  if (!profile) return;
  const micId = s.settings.microphoneId;

  const start = () => {
    s.setDictation({ activeMode: modeId });
    void startLive(profile, micId, modeId);
  };

  if (action === "stop") {
    if (isActive()) void stopLive();
  } else if (action === "start") {
    if (!isActive()) start();
  } else {
    if (isActive()) void stopLive();
    else start();
  }
}
