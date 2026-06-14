// Shared dictation controller. Resolves a Profile → its Backend (applying the
// Profile's language/prompt overrides) and starts/stops the session, reusing the
// streaming/batch path. Driven by global triggers (CLI / hotkeys) and in-app
// affordances.

import { useApp } from "./store";
import { startLive, stopLive, cancelLive } from "./streaming";

export type TriggerAction = "start" | "stop" | "toggle";

// "Busy" = any non-idle state. A new session must not start over one; a stop/toggle
// while busy ends it.
function isBusy(): boolean {
  const s = useApp.getState().status;
  return s === "listening" || s === "transcribing" || s === "injecting";
}

// Graceful stop while still capturing ("listening"); a hard reset for the wedge-prone
// post-speech states ("finalizing…"/"inserting…"), so a hotkey can recover a stuck
// session the same way the in-app button does.
function stopOrCancel(): void {
  const s = useApp.getState().status;
  if (s === "listening") void stopLive();
  else if (s === "transcribing" || s === "injecting") void cancelLive();
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
    stopOrCancel();
  } else if (action === "start") {
    if (!isBusy()) start();
  } else {
    if (isBusy()) stopOrCancel();
    else start();
  }
}
