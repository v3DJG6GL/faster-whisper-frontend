// Shared dictation controller. Resolves a Profile → its Backend and starts/stops the
// session through streaming.ts (which applies the Profile's overrides). Driven by global
// triggers (CLI / hotkeys) and in-app affordances.

import { useApp } from "../store";
import {
  startLive, stopLive, cancelLive, requestStopIfStarting, cancelStopIfStarting, isStarting,
  queuePendingHoldStart, voidPendingHoldStart, registerPendingStartRunner, reclassifyLive, abortDictationTranslate,
  isCapturing, setSettleTargetPicker, setRouteHint, restartLiveAs, liveActivation,
} from "./streaming";
import type { TargetPick } from "./streaming";
import { abortLangPick, getFocusedApp, isTauri, showLangPick, showQuickAdd } from "../api";
import { ownProp } from "../own";
import { profileDisplayName } from "../sanitize";
import { authoredChipTag } from "../profileTag";
import { effectiveLanguage, effectiveTranslationModel } from "../backends";
import { sessionShape } from "./sessionShape";
import { isActiveDictation, isGracefulStop, isProcessing } from "./dictationVisual";
import { configuredRouteTargets } from "./chipController";
import { wireCodes } from "../translationTargets";
import { rememberRecent } from "../recent";
import { backendTargetCap, translationTargetInfo } from "../capabilities";
import type { Backend, DictationStatus, Profile } from "../types";

export type TriggerAction = "start" | "stop" | "toggle" | "reclassify";

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
//     previous dictation's still-draining transcript.
function stopOrCancel(hard: boolean): void {
  const s = useApp.getState().status;
  // "listening" OR a processing status with the mic still open (a per-phrase translate) —
  // see isGracefulStop. Getting this wrong drops a PTT chord release on the floor.
  if (isGracefulStop(s, isCapturing())) void stopLive();
  else if (isProcessing(s)) {
    if (hard) void cancelLive();
    // Void any queued hold start too: on a staggered modifier-chord release Rust already
    // considers the chord broken, but `shortcutModsHeld` would still answer true and
    // `consumePendingHoldStart` would start a hold session with nothing left to release.
    voidPendingHoldStart();
  }
  // idle/error but a session may be mid-START (e.g. a fast PTT tap whose release landed during the
  // start prologue) → mark it to tear down on go-live, else it would wedge "listening" with the chord
  // already released. Also void any queued fast re-press start, including one whose held-check IPC
  // is mid-flight: it would resume a hold session for a chord already up (stuck listening).
  else {
    requestStopIfStarting();
    voidPendingHoldStart();
  }
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
    // startingSession guard, wedging the just-started hands-free session. Honor it like the explicit "stop".
    if (requestStopIfStarting()) return;
  }
  // Chord family: the hands-free superset completed over the hold root. Three meanings:
  //   • a HOLD session running under ANOTHER profile → upgrade it in place (hold → hands-free) when
  //     both Profiles resolve to the same session (sessionShape); otherwise the upgrade would
  //     keep the hold's backend/language under the hands-free label, so discard the hold
  //     session and start the hands-free Profile for real (restartLiveAs);
  //   • session running under THIS hands-free profile, or any session already running
  //     hands-free → the user pressed the family again: toggle off (the root's own "start" was
  //     the busy-gate no-op just before this);
  //   • idle → the keys arrived (near-)simultaneously and the root never started, or
  //     the session already ended — behave like a plain hands-free toggle-on (fall through).
  if (action === "reclassify") {
    if (isBusy() || isStarting()) {
      const handsFree = s.profiles.find((p) => p.id === profileId);
      if (s.activeProfile === profileId) stopOrCancel(true);
      else if (!isCapturing() && !isStarting()) {
        // The mic is already closed and the session is finalizing: there is no audio left to
        // upgrade, and restarting would discard the transcript. Leave it alone — and drop the
        // root's queued fast re-press: the engine has handed that hold off (ReleaseHold), so the
        // hold session it would start on settle gets no Stop on release and keeps listening.
        voidPendingHoldStart();
      } else if (liveActivation() !== "hold") {
        // The running session is already hands-free (started from Home, the chip or another
        // hands-free Profile — the root's start was the busy no-op): there is no hold to upgrade,
        // so this is a hands-free hotkey pressed over a busy session — stop it gracefully, as a
        // toggle does, instead of discarding it (restart) or relabelling it (upgrade).
        stopOrCancel(true);
      } else if (handsFree && handsFree.enabled) {
        const running = s.profiles.find((p) => p.id === s.activeProfile);
        const shape = (p: Profile) => sessionShape(p, backendForProfile(p, s.backends));
        if (running && shape(running) !== shape(handsFree)) {
          restartLiveAs(() => dictate(profileId, "toggle"));
        } else reclassifyLive(handsFree);
      }
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
  if (isBusy() || isStarting() || pickerOpen) {
    // Key chatter: a re-press of the SAME chord during its own start prologue supersedes the
    // phantom release recorded milliseconds earlier — the chord is still physically held, so
    // honoring the stale stop would kill the just-started session with 0 audio. Same-profile
    // only: another profile's press must never erase a real pending stop (activeProfile is
    // stamped synchronously below before startLive, so during a prologue it identifies the
    // starting profile).
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
  // may set it, and only for the session it starts — else a previous push-to-talk session's
  // picker stays armed and its wrongly-seeded prompt pops at the NEXT session's one-shot translate.
  // The route hint likewise: only an explicit hands-free "0" sets it (startWithPickedTargets).
  setSettleTargetPicker(null);
  setRouteHint(null);
  if (profile.askTranslationTargets && profile.activation !== "hold") {
    void startWithPickedTargets(profile, backend, s.settings.microphoneId, profile.activation);
    return;
  }

  // Push-to-talk with "ask": arm the settle-time picker instead. The chord is held for the
  // whole dictation, so the prompt has to wait for release — streaming.ts calls this back at
  // the one-shot translate, the last moment the answer can still change what is inserted.
  setSettleTargetPicker(
    profile.askTranslationTargets && profile.activation === "hold"
      ? (stillWanted) =>
          askTranslationTargets(targetPickerSeed(profile, backend, "after"), stillWanted).then((pick) => {
            if (pick.kind === "picked") rememberRecent("recentTranslationTargets", pick.targets);
            return pick;
          })
      : null,
  );

  s.setDictation({ activeProfile: profileId });
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
 *   • ABORT. Esc, the Cancel button and a closed window abort the whole action: no session
 *     starts, and the chip returns to standby. An empty COMMIT is different — that means
 *     "start, and insert the original only" — which is why the two arrive on separate
 *     events. Only a picker that could not be shown at all ("unavailable") falls back to
 *     the Profile's configured targets: that is not a user gesture, so it must not cancel.
 *
 *  While the picker is up the chip says "choosing targets…" (`routePending: "choosing"`)
 *  under the Profile's tag, instead of previewing a route the user has not chosen yet. */
async function startWithPickedTargets(
  profile: Profile,
  backend: Backend,
  micId: string | null,
  activation: Profile["activation"],
): Promise<void> {
  if (pickerOpen) return;
  pickerOpen = true;
  const preset = configuredRouteTargets(profile, backend) ?? [];
  try {
    // Stamp "choosing" in the same tick `pickerOpen` goes up, BEFORE the focus read below (an
    // AT-SPI round trip on Linux): it is pickerOpen's store-visible twin (pickerOffHint), and a
    // late stamp would leave the chip and Home offering starts / cycles that bail on pickerOpen.
    // Store writes take no focus (the chip is non-focusable), so the captured target is unchanged.
    // The stamp also ends a lingering error: `error` isn't busy, so this start can open inside
    // flashError's linger, whose timer would otherwise null activeProfile mid-pick (wrong chip
    // tag beside the stale error). Its body is guarded by status === "error", so it no-ops.
    useApp.getState().setDictation({
      activeProfile: profile.id,
      routePending: "choosing",
      ...(useApp.getState().status === "error" ? { status: "idle" as const, dictationError: null } : {}),
    });
    // Resolve the injection target BEFORE taking focus — see the docblock. Non-fatal: an
    // AT-SPI/IPC reject would otherwise escape the bare `void` caller unhandled and silently
    // drop the whole start; null = no known target, the session still runs.
    const targetApp = await getFocusedApp().catch(() => null);
    const pick = await askTranslationTargets(targetPickerSeed(profile, backend, "before"));
    if (pick.kind === "aborted") {
      // The user backed out: nothing starts, and the chip returns to standby (no Profile
      // claimed, no route pending). `pickerOpen` is released in `finally`.
      useApp.getState().setDictation({ activeProfile: null, routePending: null });
      return;
    }
    // "unavailable" (no picker could be shown) → the Profile's own targets, unchanged behaviour.
    const targets = pick.kind === "picked" ? pick.targets : preset;
    if (pick.kind === "picked") rememberRecent("recentTranslationTargets", pick.targets);
    // An explicit "0" (original only) is a decision the chip should acknowledge ("· original")
    // rather than render as a session that merely has no route. The hint is consumed once by
    // startLiveInner, so a Profile that simply configures no targets never picks it up. It has
    // to ride a seam rather than the store: `sessionTargets` is republished by startLiveInner
    // itself, a tick later than anything set here.
    setRouteHint(pick.kind === "picked" && targets.length === 0 ? "original" : null);
    useApp.getState().setDictation({ activeProfile: profile.id, routePending: null });
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
    // The twin never outlives pickerOpen: every normal exit above has already cleared it (a
    // no-op then), but a throw (e.g. in targetPickerSeed) would otherwise latch "choosing".
    if (useApp.getState().routePending === "choosing") useApp.getState().setDictation({ routePending: null });
    pickerOpen = false;
  }
}

/** Start a hands-free session from a surface that is not the Profile's own hotkey — the
 *  Home button and the chip's toggle. Honours the Profile's "Ask for target languages" the
 *  way `dictate()` does (the toggle's own help text promises a prompt before the mic opens),
 *  and begins with the settle picker disarmed like every other start path. Requires an
 *  enabled Profile: both callers refuse to start without one, as the hotkeys do. */
export function startHandsFree(backend: Backend, micId: string | null, profile: Profile): void {
  if (pickerOpen) return;
  setSettleTargetPicker(null);
  setRouteHint(null);
  if (profile.askTranslationTargets) {
    // The picker stamps activeProfile itself, together with "choosing" (and the error clear), in
    // one write: stamping it here first would publish an in-between state — the plain Profile,
    // maybe beside a stale error — to the chip for one update. Same split as `dictate()`.
    void startWithPickedTargets(profile, backend, micId, "handsfree");
    return;
  }
  useApp.getState().setDictation({ activeProfile: profile.id });
  void startLive(backend, micId, "handsfree", profile);
}

/** Show the picker and resolve with its answer:
 *   • `picked`      — the chosen targets (`[]` = insert the original only);
 *   • `aborted`     — Esc / Cancel / a closed window: the caller abandons the action;
 *   • `unavailable` — no picker could be shown (no window, IPC failure): not a gesture, so
 *                     the caller proceeds with the Profile's configured targets.
 *  A picker always answers, one way or another — see the catch below. */
function askTranslationTargets(seed: Record<string, unknown>, stillWanted?: () => boolean): Promise<TargetPick> {
  if (!isTauri) return Promise.resolve({ kind: "unavailable" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: TargetPick) => {
      if (done) return;
      done = true;
      unlisten.forEach((un) => un());
      resolve(v);
    };
    const unlisten: (() => void)[] = [];
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        // Only the codes the wire takes: the picker's recent/supported rows are not checked
        // against the wire alphabet, and a pick of only refused codes is "original", not a
        // silent no-translation that is remembered as a recent pick.
        unlisten.push(await listen<string[]>("langpick://commit", (e) => finish({ kind: "picked", targets: wireCodes(e.payload) })));
        unlisten.push(await listen("langpick://abort", () => finish({ kind: "aborted" })));
        unlisten.push(await listen("langpick://unavailable", () => finish({ kind: "unavailable" })));
        // Cancelled during the import/listen awaits: never show (and focus) a picker nobody
        // wants — the abort that cancel sent may have preceded the listeners, so check here.
        if (stillWanted && !stillWanted()) {
          finish({ kind: "aborted" });
          return;
        }
        await showLangPick(seed);
        // Cancelled while the window was coming up: that abort hid nothing (and its event may
        // have beaten the listeners above), so take the late-shown window down here.
        if (stillWanted && !stillWanted()) {
          finish({ kind: "aborted" });
          void abortLangPick().catch((e) => console.error("lang pick abort failed:", e));
        }
      })
      // A failed import/listen/show must read as "unavailable", never as a pending answer:
      // the hands-free caller holds `pickerOpen` across this await and push-to-talk holds
      // the inject queue, so a promise that never settles wedges dictation for the process.
      // "unavailable" rather than "aborted" because no user gesture happened — the
      // dictation goes on with the Profile's preset instead of being thrown away.
      .catch(() => finish({ kind: "unavailable" }));
  });
}

/** What the picker opens with for a Profile's session (`when`: before it starts, or at the
 *  push-to-talk settle): the spoken language, the configured targets, the recent picks, the
 *  Profile's tag and the theme — and its grouping by the session's translation model (the
 *  Profile's, else the Backend's, else the server default — effectiveTranslationModel, the rule
 *  startLiveInner sends). */
function targetPickerSeed(profile: Profile, backend: Backend, when: "before" | "after"): Record<string, unknown> {
  const st = useApp.getState();
  const model = effectiveTranslationModel(profile.translationOverrides?.model, backend.translationOverrides?.model);
  return {
    source: effectiveLanguage(profile.language, backend.language),
    preset: configuredRouteTargets(profile, backend) ?? [],
    recent: st.settings.recentTranslationTargets ?? [],
    // The authored tag as the chip shows it (authoredChipTag: invisible head dropped, capped like
    // the chip, so a long synced tag reads the same here as on the chip and in History) unless it
    // renders blank, else the name as the lists show it ("Untitled profile" for a blank synced
    // one) — never an empty picker header.
    tag: authoredChipTag(profile.tag) || profileDisplayName(profile.name),
    when,
    theme: st.settings.theme,
    accentHue: st.settings.accentHue,
    accentMotion: st.settings.accentMotion,
    ...translationTargetInfo(ownProp(st.caps, backend.id), model),
    // The server's target cap: the picker never lets you choose more than it takes.
    max: backendTargetCap(backend.id),
  };
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

/** Why the Home button / the chip's dictate button cannot start, "" when it can: no Profile
 *  at all, none enabled (no `target`), or an enabled target with no Backend to send it to.
 *  The one gate + wording both surfaces share, so neither promises a start the other (or the
 *  click itself) refuses. `target` is the caller's homeTargetProfile result. */
export function startOffHint(
  profiles: Profile[],
  target: Profile | undefined,
  backends: Backend[],
): string {
  if (target && backendForProfile(target, backends)) return "";
  if (profiles.length === 0) return "Add a profile to begin";
  if (!target) return "Enable a profile to begin";
  return "Add a backend to begin";
}

/** Why a start / profile cycle is off while the hands-free target picker is open, "" when it
 *  is not. startHandsFree and the cycle bail on `pickerOpen` while status stays "idle"; its
 *  store-visible twin is routePending "choosing", which only the picker writes — in the same
 *  tick pickerOpen goes up, and cleared no later than it drops. The chip and the Home button
 *  both read it ahead of startOffHint, so neither offers a dead click. */
export function pickerOffHint(
  routePending: "undecided" | "choosing" | "original" | null,
  status: DictationStatus,
): string {
  return routePending === "choosing" && status === "idle" ? "Answer the target picker first" : "";
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
    // No enabled profile → no start, as on the Home button: backendForProfile falls back to
    // the first Backend even without a profile.
    if (!target || !backend) return;
    startHandsFree(backend, s.settings.microphoneId, target);
    return;
  }
  if (kind === "cycle-active-profile") {
    // Only meaningful when idle/standby — never reshuffle a running session, INCLUDING one
    // mid-start: status is still "idle" through the ~1s prologue, so without isStarting() a chip
    // cycle in that window would persist a new homeProfileId under the starting session (the
    // same mislabel the START path guards). Same for the target picker: it has already stamped
    // activeProfile, so a cycle while it is open would mislabel the pick. Mirrors dictate()'s
    // start gate. The cycle persists ONLY the home target (which the standby dock previews);
    // it never stamps activeProfile, which nothing clears while idle and which would then
    // outrank a later header pick on the chip, the stats and Home's readouts.
    if (s.status !== "idle" || isStarting() || pickerOpen) return;
    const enabled = s.profiles.filter((p) => p.enabled);
    if (enabled.length === 0) return;
    const cur = homeTargetProfile(s.profiles, s.settings.homeProfileId);
    const i = enabled.findIndex((p) => p.id === cur?.id);
    const next = enabled[(i + 1) % enabled.length];
    s.updateSettings({ homeProfileId: next.id });
    return;
  }
}
