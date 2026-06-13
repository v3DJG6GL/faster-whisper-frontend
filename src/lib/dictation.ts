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
  // Per-Profile override wins when set; empty/undefined inherits the Backend default.
  const language = profile.language?.trim() ? profile.language : backend.language;
  const prompt = profile.prompt?.trim() ? profile.prompt : backend.prompt;

  const start = () => {
    s.setDictation({ activeProfile: profileId });
    void startLive(backend, micId, profile.activation, { language, prompt });
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
