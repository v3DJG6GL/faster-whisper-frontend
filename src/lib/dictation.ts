// Shared dictation controller. Resolves a Profile → its Backend (applying the
// Profile's language/prompt overrides) and starts/stops the session, reusing the
// streaming/batch path. Driven by global triggers (CLI / hotkeys) and in-app
// affordances.

import { useApp } from "./store";
import { startLive, stopLive, cancelLive, requestStopIfStarting, isStarting } from "./streaming";
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
  // idle/error but a session may be mid-START (its status not yet "listening", e.g. a fast PTT tap
  // whose chord-release "stop" landed during the start prologue) → mark it to tear down on go-live,
  // else it would wedge "listening" with the chord already released. No-op when nothing is starting.
  else requestStopIfStarting();
}

export function dictate(profileId: string, action: TriggerAction): void {
  const s = useApp.getState();

  // A stop/cancel must never be gated on the Profile — only `status` matters. If a
  // hold-to-talk Profile is disabled or deleted mid-session (the UI toggle is live even
  // while dictating), the hold-release `stop` (and the evdev device-disconnect `stop`,
  // emitted precisely to avoid a stranded session) would otherwise be dropped, wedging
  // the session listening forever. Handle it before resolving the Profile.
  if (action === "stop") {
    stopOrCancel();
    return;
  }
  if (action === "toggle") {
    if (isBusy()) {
      stopOrCancel();
      return;
    }
    // A toggle-off that lands during the start prologue (status still "idle", session mid-start)
    // would otherwise fall through to the start branch and be swallowed by startLive's
    // startingSession guard, wedging the just-started latch. Honor it like the explicit "stop".
    if (requestStopIfStarting()) return;
  }

  // Starting a session DOES require an enabled Profile with a resolvable Backend.
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile || !profile.enabled) return;
  const backend = backendForProfile(profile, s.backends);
  if (!backend) return;
  // start over a running session is a no-op (toggle-busy handled above). Also no-op while a session
  // is mid-START: isBusy() only reads `status`, still "idle" through the ~1s prologue (AT-SPI focus
  // read), so a second cross-profile start (PTT re-fire / two keyboards) would otherwise overwrite
  // the in-flight session's activeProfile — mislabeling its chip identity + usage attribution — and
  // then silently no-op on startLive's startingSession guard. The toggle entry-points already guard
  // the prologue via requestStopIfStarting; this is the START path's equivalent.
  if (isBusy() || isStarting()) return;

  s.setDictation({ activeProfile: profileId });
  // startLive resolves the effective language / prompt / decode overrides
  // (the Profile's set fields win over the Backend's defaults).
  void startLive(backend, s.settings.microphoneId, profile.activation, profile);
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
    // A chip toggle landing during the start prologue (status still "idle", session
    // mid-start) must tear it down like the hero/hotkey toggle do — else it falls
    // through to startLive and is swallowed by the startingSession guard, wedging the
    // just-started latch with the user's intended OFF lost. Mirrors dictate()'s toggle.
    if (requestStopIfStarting()) return;
    const target = homeTargetProfile(s.profiles, s.settings.homeProfileId);
    const backend = backendForProfile(target, s.backends);
    if (!backend) return;
    s.setDictation({ activeProfile: target?.id ?? null });
    void startLive(backend, s.settings.microphoneId, "latch", target);
    return;
  }
  if (kind === "cycle-active-profile") {
    // Only meaningful when idle/standby — never reshuffle a running session, INCLUDING one
    // mid-start: status is still "idle" through the ~1s prologue, so without isStarting() a chip
    // cycle in that window would overwrite the starting session's activeProfile + persist a new
    // homeProfileId (the same mislabel the START path guards). Mirrors dictate()'s start gate.
    if (s.status !== "idle" || isStarting()) return;
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
