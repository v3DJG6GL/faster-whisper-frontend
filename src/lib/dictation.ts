// Shared dictation controller. Resolves a Profile → its Backend (applying the
// Profile's language/prompt overrides) and starts/stops the session, reusing the
// streaming/batch path. Driven by global triggers (CLI / hotkeys) and in-app
// affordances.

import { useApp } from "./store";
import { startLive, stopLive } from "./streaming";

export type TriggerAction = "start" | "stop" | "toggle";

function isActive(): boolean {
  const s = useApp.getState().status;
  return s === "listening" || s === "transcribing";
}

export function dictate(profileId: string, action: TriggerAction): void {
  const s = useApp.getState();
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile || !profile.enabled) return;
  const backend = s.backends.find((b) => b.id === profile.backendId) ?? s.backends[0];
  if (!backend) return;
  const micId = s.settings.microphoneId;

  const start = () => {
    s.setDictation({ activeProfile: profileId });
    // startLive resolves the effective language / prompt / decode overrides
    // (the Profile's set fields win over the Backend's defaults).
    void startLive(backend, micId, profile.activation, profile);
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
