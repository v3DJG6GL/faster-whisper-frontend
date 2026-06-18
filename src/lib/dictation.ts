// Shared dictation controller. Resolves a Profile → its Backend (applying the
// Profile's language/prompt overrides) and starts/stops the session, reusing the
// streaming/batch path. Driven by global triggers (CLI / hotkeys) and in-app
// affordances.

import { useApp } from "./store";
import { startLive, stopLive, cancelLive } from "./streaming";
import { showQuickAdd } from "./api";
import type { Backend, Profile } from "./types";

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
  const backend = backendForProfile(profile, s.backends);
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

/** The Backend a Profile dictates through: its configured `backendId`, falling back to
 *  the first Backend (undefined only when there are no Backends at all). The single home
 *  for this resolution + its silent first-Backend fallback. */
export function backendForProfile(
  profile: Profile | null | undefined,
  backends: Backend[],
): Backend | undefined {
  return backends.find((b) => b.id === profile?.backendId) ?? backends[0];
}

/** The Profile the Home button + the overlay quick-launch target: the configured
 *  home Profile, else the first enabled latch Profile, else any enabled one. */
export function homeTargetProfile(
  profiles: Profile[],
  homeProfileId?: string | null,
): Profile | undefined {
  const enabled = profiles.filter((p) => p.enabled);
  return (
    enabled.find((p) => p.id === homeProfileId) ??
    enabled.find((p) => p.activation === "latch") ??
    enabled[0]
  );
}

/** Run a dictation action requested from the overlay chip. The chip is a separate
 *  window, so the request arrives via the `overlay://action` event (see api.ts /
 *  App.tsx). Mirrors the Home hero button's latch-toggle semantics. */
export function runOverlayAction(kind: string): void {
  if (kind === "cancel-dictation") {
    void cancelLive();
    return;
  }
  if (kind === "open-quick-add") {
    void showQuickAdd();
    return;
  }
  const s = useApp.getState();
  if (kind === "toggle-dictation") {
    if (s.status === "listening") {
      void stopLive();
      return;
    }
    if (s.status === "transcribing" || s.status === "injecting") {
      void cancelLive(); // force a clean idle (recover a wedged session)
      return;
    }
    const target = homeTargetProfile(s.profiles, s.settings.homeProfileId);
    const backend = backendForProfile(target, s.backends);
    if (!backend) return;
    s.setDictation({ activeProfile: target?.id ?? null });
    void startLive(backend, s.settings.microphoneId, "latch", target);
    return;
  }
  if (kind === "cycle-active-profile") {
    // Only meaningful when idle/standby — never reshuffle a running session.
    if (s.status !== "idle") return;
    const enabled = s.profiles.filter((p) => p.enabled);
    if (enabled.length === 0) return;
    const cur = homeTargetProfile(s.profiles, s.settings.homeProfileId);
    const i = enabled.findIndex((p) => p.id === cur?.id);
    const next = enabled[(i + 1) % enabled.length];
    s.updateSettings({ homeProfileId: next.id }); // persists; standby tag + next toggle follow
    s.setDictation({ activeProfile: next.id });
    return;
  }
}
