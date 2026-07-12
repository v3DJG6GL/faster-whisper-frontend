// Shared dictation controller. Resolves a Profile → its Backend (applying the
// Profile's language/prompt overrides) and starts/stops the session, reusing the
// streaming/batch path. Driven by global triggers (CLI / hotkeys) and in-app
// affordances.

import { useApp } from "./store";
import {
  startLive, stopLive, cancelLive, requestStopIfStarting, isStarting,
  queuePendingHoldStart, registerPendingStartRunner, reclassifyLive,
} from "./streaming";
import { showQuickAdd } from "./api";
import { isActiveDictation, isProcessing } from "./dictationVisual";
import type { Backend, Profile } from "./types";

export type TriggerAction = "start" | "stop" | "toggle" | "reclassify" | "cancel";

// "Busy" = any non-idle state. A new session must not start over one; a stop/toggle
// while busy ends it.
function isBusy(): boolean {
  return isActiveDictation(useApp.getState().status);
}

// Graceful stop while still capturing ("listening"). During the post-speech states
// ("finalizing…"/"inserting…") the transcript is pending but not yet delivered, so what
// happens there depends on the gesture:
//   • `hard` (a deliberate latch TOGGLE — a re-press saying "kill it"): cancel, the
//     explicit recovery for a wedged session, same as the in-app button.
//   • not `hard` (a HOLD chord release): do NOTHING. A release lands here only in the
//     fast re-press flow — its matching press was swallowed by the busy gate (and
//     queued, see dictate) — so it pairs with NO session; cancelling would discard the
//     previous dictation's still-draining transcript (the "re-press eats my last
//     sentence" bug found in on-Windows testing over a slow VPN link).
function stopOrCancel(hard: boolean): void {
  const s = useApp.getState().status;
  if (s === "listening") void stopLive();
  else if (isProcessing(s)) {
    if (hard) void cancelLive();
  }
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
    stopOrCancel(false);
    return;
  }
  if (action === "toggle") {
    if (isBusy()) {
      stopOrCancel(true);
      return;
    }
    // A toggle-off that lands during the start prologue (status still "idle", session mid-start)
    // would otherwise fall through to the start branch and be swallowed by startLive's
    // startingSession guard, wedging the just-started latch. Honor it like the explicit "stop".
    if (requestStopIfStarting()) return;
  }
  // Chord family: the quick-add superset completed inside the grace window — the
  // matcher already opened the quick-add window; discard the nascent blip so no
  // transcript of the half-second of chord noise ever lands. Safe on a mid-start
  // session too (cancelLive hard-resets); a stray cancel while idle is a no-op.
  if (action === "cancel") {
    if (isBusy() || isStarting()) void cancelLive();
    return;
  }
  // Chord family: the latch superset completed over the hold root. Three meanings:
  //   • session running under ANOTHER profile → upgrade it in place (hold → hands-free);
  //   • session running under THIS latch profile → the user pressed the family again:
  //     toggle off (the root's own "start" was the busy-gate no-op just before this);
  //   • idle → the keys arrived (near-)simultaneously and the root never started, or
  //     the session already ended — behave like a plain latch toggle-on (fall through).
  if (action === "reclassify") {
    if (isBusy() || isStarting()) {
      const latch = s.profiles.find((p) => p.id === profileId);
      if (s.activeProfile === profileId) stopOrCancel(true);
      else if (latch && latch.enabled) reclassifyLive(latch);
      return;
    }
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
  if (isBusy() || isStarting()) {
    // …except a hold PRESS during "finalizing…"/"inserting…" — the fast re-press. Don't
    // drop it: queue it, and streaming fires it on settle IF the chord is still held
    // (checked against Rust's HeldKeys), so the next sentence starts the moment the
    // previous text lands, without another press. Its release is a no-op (stopOrCancel).
    if (action === "start" && isProcessing(s.status)) queuePendingHoldStart(profileId);
    return;
  }

  s.setDictation({ activeProfile: profileId });
  // startLive resolves the effective language / prompt / decode overrides
  // (the Profile's set fields win over the Backend's defaults).
  void startLive(backend, s.settings.microphoneId, profile.activation, profile);
}

// Wire the queued-start consumer: streaming.ts owns settleIdle but can't import us
// (module cycle), so it calls back into dictate here. A queued press re-enters through
// the full gate chain — profile still enabled, status now idle — like a fresh press.
registerPendingStartRunner((profileId) => dictate(profileId, "start"));

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
    if (isProcessing(s.status)) {
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
