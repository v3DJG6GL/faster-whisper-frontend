// Shared dictation controller. Resolves a Profile → its Backend (applying the
// Profile's language/prompt overrides) and starts/stops the session, reusing the
// streaming/batch path. Driven by global triggers (CLI / hotkeys) and in-app
// affordances.

import { useApp } from "./store";
import {
  startLive, stopLive, cancelLive, requestStopIfStarting, cancelStopIfStarting, isStarting,
  queuePendingHoldStart, registerPendingStartRunner, reclassifyLive, abortDictationTranslate,
  isCapturing, setSettleTargetPicker,
} from "./streaming";
import { getFocusedApp, isTauri, showLangPick, showQuickAdd } from "./api";
import { ownProp } from "./own";
import { isActiveDictation, isGracefulStop, isProcessing } from "./dictationVisual";
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
//   • `hard` (a deliberate hands-free TOGGLE — a re-press saying "kill it"): cancel, the
//     explicit recovery for a wedged session, same as the in-app button.
//   • not `hard` (a HOLD chord release): do NOTHING. A release lands here only in the
//     fast re-press flow — its matching press was swallowed by the busy gate (and
//     queued, see dictate) — so it pairs with NO session; cancelling would discard the
//     previous dictation's still-draining transcript (the "re-press eats my last
//     sentence" bug found in on-Windows testing over a slow VPN link).
function stopOrCancel(hard: boolean): void {
  const s = useApp.getState().status;
  // "listening" OR a processing status with the mic still open (a per-phrase translate) —
  // see isGracefulStop. Getting this wrong drops a PTT chord release on the floor.
  if (isGracefulStop(s, isCapturing())) void stopLive();
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
  //   • session running under THIS hands-free profile → the user pressed the family again:
  //     toggle off (the root's own "start" was the busy-gate no-op just before this);
  //   • idle → the keys arrived (near-)simultaneously and the root never started, or
  //     the session already ended — behave like a plain hands-free toggle-on (fall through).
  if (action === "reclassify") {
    if (isBusy() || isStarting()) {
      const handsFree = s.profiles.find((p) => p.id === profileId);
      if (s.activeProfile === profileId) stopOrCancel(true);
      else if (handsFree && handsFree.enabled) reclassifyLive(handsFree);
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
  // A picker being open counts as busy: the await that precedes startLive sits IN FRONT
  // of `startingSession`, so without this a second chord press would open a second picker
  // and then start a second session behind it.
  if (isBusy() || isStarting() || pickerOpen) {
    // Key chatter: a re-press of the SAME chord during its own start prologue supersedes the
    // phantom release recorded milliseconds earlier — the chord is still physically held, so
    // honoring the stale stop would kill the just-started session with 0 audio (the sub-30ms
    // instant-stop bug). Same-profile only: another profile's press must never erase a real
    // pending stop (activeProfile is stamped synchronously below before startLive, so during
    // a prologue it identifies the starting profile).
    if (action === "start" && isStarting() && s.activeProfile === profileId) {
      cancelStopIfStarting();
      return;
    }
    // …except a hold PRESS during "finalizing…"/"inserting…" — the fast re-press. Don't
    // drop it: queue it, and streaming fires it on settle IF the chord is still held
    // (checked against Rust's HeldKeys), so the next sentence starts the moment the
    // previous text lands, without another press. Its release is a no-op (stopOrCancel).
    // …and only when capture is actually OVER: a per-phrase translate reports a processing
    // status with the mic still open, and queueing there would fire a whole new session the
    // moment that phrase settled — on top of the one still running.
    if (action === "start" && isProcessing(s.status) && !isCapturing()) queuePendingHoldStart(profileId);
    return;
  }

  // "Ask for target languages", hands-free: the picker has to resolve BEFORE startLive.
  // Session start makes four commitments the answer could not amend afterwards — the
  // preload plan, the warm lease, the forced capability probe, and the `translateExpect`
  // sent inside the startStream invoke. Push-to-talk asks later instead (at the one-shot
  // translate), because a prompt during a held chord would swallow the keystrokes.
  //
  // Every start path begins with the settle picker DISARMED: only the hold+ask arming below
  // may set it, and only for the session it starts. (Before this, the hands-free return
  // skipped the arming call and a previous push-to-talk session's picker stayed armed —
  // its wrongly-seeded prompt then popped at the NEXT session's one-shot translate.)
  setSettleTargetPicker(null);
  if (profile.askTranslationTargets && profile.activation !== "hold") {
    void startWithPickedTargets(profile, backend, s.settings.microphoneId, profile.activation);
    return;
  }

  // Push-to-talk with "ask": arm the settle-time picker instead. The chord is held for the
  // whole dictation, so the prompt has to wait for release — streaming.ts calls this back at
  // the one-shot translate, the last moment the answer can still change what is inserted.
  setSettleTargetPicker(
    profile.askTranslationTargets && profile.activation === "hold"
      ? () =>
          askTranslationTargets({
            source: profile.language?.trim() ? profile.language : backend.language,
            preset: profile.translationOverrides?.translateTo ?? [],
            recent: useApp.getState().settings.recentTranslationTargets ?? [],
            tag: profile.tag?.trim() || profile.name,
            when: "after",
            theme: useApp.getState().settings.theme,
            allowed: ownProp(useApp.getState().caps, backend.id)?.translation_languages ?? undefined,
          }).then((picked) => {
            if (picked) rememberTranslationTargets(picked);
            return picked;
          })
      : null,
  );

  s.setDictation({ activeProfile: profileId });
  // startLive resolves the effective language / prompt / decode overrides
  // (the Profile's set fields win over the Backend's defaults).
  void startLive(backend, s.settings.microphoneId, profile.activation, profile);
}

/** True while the picker is open, so a second chord press can't open a second one (and
 *  then start a second session behind it). The START path's equivalent of
 *  `startingSession` — which can't cover this, because the await sits IN FRONT of it. */
let pickerOpen = false;

/** Ask for this session's translation targets, then start with them merged in.
 *
 *  Two things the picker must not break, both handled here rather than in the window:
 *   • FOCUS. `startLive` resolves the injection target from the focused app, and a focused
 *     picker makes that OUR OWN window — dictation would refuse to type. The target is
 *     captured before the picker shows and handed to the session as its own app.
 *   • DISMISSAL. Esc and a closed window fall back to the Profile's configured targets, so
 *     ignoring the prompt reproduces exactly today's behaviour. An empty COMMIT is
 *     different — that means "insert the original only" — which is why the two arrive on
 *     separate events. */
async function startWithPickedTargets(
  profile: Profile,
  backend: Backend,
  micId: string | null,
  activation: Profile["activation"],
): Promise<void> {
  if (pickerOpen) return;
  pickerOpen = true;
  const s = useApp.getState();
  const preset = profile.translationOverrides?.translateTo ?? [];
  const backendLang = backend.language;
  try {
    // Resolve the injection target BEFORE taking focus — see the docblock.
    const targetApp = await getFocusedApp();
    const picked = await askTranslationTargets({
      source: profile.language?.trim() ? profile.language : backendLang,
      preset,
      recent: s.settings.recentTranslationTargets ?? [],
      tag: profile.tag?.trim() || profile.name,
      when: "before",
      theme: s.settings.theme,
      allowed: ownProp(s.caps, backend.id)?.translation_languages ?? undefined,
    });
    // `null` = dismissed → the Profile's own targets, i.e. unchanged behaviour.
    const targets = picked ?? preset;
    if (picked) rememberTranslationTargets(picked);
    useApp.getState().setDictation({ activeProfile: profile.id });
    void startLive(
      backend,
      micId,
      activation,
      {
        ...profile,
        translationOverrides: { ...profile.translationOverrides, translateTo: targets },
      },
      targetApp,
    );
  } finally {
    pickerOpen = false;
  }
}

/** Start a hands-free session from a surface that is not the Profile's own hotkey — the
 *  Home button and the chip's toggle. Honours the Profile's "Ask for target languages" the
 *  way `dictate()` does (the toggle's own help text promises a prompt before the mic opens),
 *  and begins with the settle picker disarmed like every other start path. `profile` may be
 *  undefined when only a Backend is targeted. */
export function startHandsFree(backend: Backend, micId: string | null, profile: Profile | undefined): void {
  setSettleTargetPicker(null);
  useApp.getState().setDictation({ activeProfile: profile?.id ?? null });
  if (profile?.askTranslationTargets) {
    void startWithPickedTargets(profile, backend, micId, "handsfree");
    return;
  }
  void startLive(backend, micId, "handsfree", profile);
}

/** Show the picker and resolve with the chosen targets, or `null` if dismissed. */
function askTranslationTargets(seed: Record<string, unknown>): Promise<string[] | null> {
  if (!isTauri) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string[] | null) => {
      if (done) return;
      done = true;
      unlisten.forEach((un) => un());
      resolve(v);
    };
    const unlisten: (() => void)[] = [];
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        unlisten.push(await listen<string[]>("langpick://commit", (e) => finish(e.payload ?? [])));
        unlisten.push(await listen("langpick://cancel", () => finish(null)));
        await showLangPick(seed);
      })
      // A failed import/listen/show must read as "dismissed", never as a pending answer:
      // the hands-free caller holds `pickerOpen` across this await and push-to-talk holds
      // the inject queue, so a promise that never settles wedges dictation for the process.
      .catch(() => finish(null));
  });
}

/** Keep the most recent picks for the picker's "Recent" group, newest first. */
function rememberTranslationTargets(picked: string[]): void {
  if (picked.length === 0) return;
  const st = useApp.getState();
  const prev = st.settings.recentTranslationTargets ?? [];
  st.updateSettings({
    recentTranslationTargets: [...picked, ...prev.filter((c) => !picked.includes(c))].slice(0, 12),
  });
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
 *  home Profile, else the first enabled hands-free Profile, else any enabled one. */
export function homeTargetProfile(
  profiles: Profile[],
  homeProfileId?: string | null,
): Profile | undefined {
  const enabled = profiles.filter((p) => p.enabled);
  return (
    enabled.find((p) => p.id === homeProfileId) ??
    enabled.find((p) => p.activation === "handsfree") ??
    enabled[0]
  );
}

/** Run a dictation action requested from the overlay chip. The chip is a separate
 *  window, so the request arrives via the `overlay://action` event (see api.ts /
 *  App.tsx). Mirrors the Home hero button's hands-free-toggle semantics. */
export function runOverlayAction(kind: string): void {
  if (kind === "cancel-dictation") {
    void cancelLive();
    return;
  }
  // Give up on the TRANSLATION only — the session survives and the user's words still
  // land, as the original. Deliberately NOT cancelLive: the transcript is finished and
  // waiting on the GPU, so discarding the session here would throw away the very text the
  // user spoke, to escape a wait that has a cheaper exit.
  if (kind === "cancel-translate") {
    abortDictationTranslate();
    return;
  }
  if (kind === "open-quick-add") {
    void showQuickAdd();
    return;
  }
  const s = useApp.getState();
  if (kind === "toggle-dictation") {
    if (isGracefulStop(s.status, isCapturing())) {
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
    // just-started hands-free session with the user's intended OFF lost. Mirrors dictate()'s toggle.
    if (requestStopIfStarting()) return;
    const target = homeTargetProfile(s.profiles, s.settings.homeProfileId);
    const backend = backendForProfile(target, s.backends);
    if (!backend) return;
    startHandsFree(backend, s.settings.microphoneId, target);
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
