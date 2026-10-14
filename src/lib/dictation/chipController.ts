// Dictation chip controller (runs in the main window). The chip is a separate
// webview with its own JS context, so it can't read this window's store; instead
// we broadcast the assembled `{status, level, partial}` as a `dictation://update`
// event (the overlay listens for it) and drive the window's show/hide via Rust.
//
// Show/hide is gated by the Recording → indicator-position setting ("top" |
// "bottom" | "off"). The chip lingers briefly after a session so the final
// transcript (or an error) stays readable before it disappears.

import { useApp } from "../store";
import { isTauri, showOverlay, setOverlayScale, hideOverlay, setTrayState, playCue } from "../api";
import { chipTagFor } from "../profileTag";
import { backendForProfile, homeTargetProfile, pickerOffHint, startOffHint } from "./dictation";
import { activeStatsBackend } from "../usage";
import { fmtCompact, fmtDuration } from "../format";
import { ownProp } from "../own";
import { effectiveLanguage } from "../backends";
import { routeSourceCode } from "../languages";
import { isActiveDictation, sessionNoteHoldMs } from "./dictationVisual";
import { isCapturing } from "./streaming";
import type { OverlayStatsMetric, ServerWork, UsageStats } from "../types";
import { DEFAULT_SETTINGS } from "../defaults";
import { sendableTargets } from "../capabilities";

const REC_DEFAULTS = DEFAULT_SETTINGS.recording;

/** How many translation targets the chip spells out before the rest become "+N". Two, not
 *  `routeParts`' three: the chip's identity row shares one line with the live transcript,
 *  which is the surface the user actually reads to supervise what is about to be typed. */
const CHIP_ROUTE_TARGETS = 2;

/** The translation targets the chip should show, resolved and bounded.
 *
 *  A RUNNING session wins: it publishes what it actually resolved, which is the only
 *  authority once anything can change the targets for one session. The Profile's own
 *  config is the fallback, and it is what the idle standby dock previews — "what happens
 *  if I press the chord" (`chipRoute` passes it only while idle) — so `null` (no session) and `[]` (a session that doesn't
 *  translate) must stay distinguishable, and they are: `??` only takes the fallback for
 *  the former.
 *
 *  Both inputs are peer-authored — a synced Backend's or Profile's `translateTo`, which
 *  `sanitizeProfiles` type-checks but does not bound — and the result rides the ~30Hz
 *  level payload into a `shrink-0` row beside the live transcript. Bounded on both axes:
 *  how many, and how long each. */
export function chipRouteTargets(
  sessionTargets: string[] | null,
  profileTargets: string[] | undefined,
  max = CHIP_ROUTE_TARGETS,
): string[] {
  return validRouteTargets(sessionTargets, profileTargets)
    .slice(0, max)
    .map((t) => t.trim().slice(0, 12));
}

/** The CONFIGURED route targets for a profile: the Backend's translation defaults with the
 *  Profile's overrides spread on top — the same per-field merge the session freezes
 *  (streaming.ts trOv). Every readout of the route (chip, Home, the Profiles row) goes
 *  through this, or an inheriting profile reads as "no translation" while it translates.
 *  Only what the session sends (capabilities.ts sendableTargets, as streaming.ts): the
 *  wire-valid codes within the server's per-request cap. A synced "de_CH" must not preview a
 *  route the session drops, a list of only refused codes reads as none, and ten saved targets
 *  on a server that takes three must not promise ten. A backend without an id caps at the app's
 *  own ceiling, which the session never exceeds either. */
export function configuredRouteTargets(
  profile?: { translationOverrides?: { translateTo?: string[] } } | null,
  backend?: { id?: string; translationOverrides?: { translateTo?: string[] } } | null,
): string[] | undefined {
  const list = { ...backend?.translationOverrides, ...profile?.translationOverrides }.translateTo;
  return list === undefined ? undefined : sendableTargets(list, backend?.id);
}

/** How many targets `chipRouteTargets` left out. A route is a promise about what will be
 *  typed, so a three-target session must not read as a two-target one: the chip shows
 *  "→ FR IT +1", as the tray tooltip and the Profile card already do. */
export function chipRouteMore(
  sessionTargets: string[] | null,
  profileTargets: string[] | undefined,
  max = CHIP_ROUTE_TARGETS,
): number {
  return Math.max(0, validRouteTargets(sessionTargets, profileTargets).length - max);
}

/** What the chip shows in the route slot INSTEAD of a promise, when there is none to make.
 *
 *  A running session's own `routePending` wins ("undecided" / "choosing" / "original" — see
 *  the store docs). With no session and no pending value, a standby dock previewing a
 *  Profile that ASKS for its targets says "ask": the configured targets are only the picker's
 *  preselection, and previewing them as the route promised what the user had not decided
 *  yet. Everything else is "" — the route (session or configured preview) is the truth.
 *  Pure, so it is unit-tested without the store or the cross-window payload. */
export function chipRoutePending(
  routePending: "undecided" | "choosing" | "original" | null,
  status: string,
  profileAsks: boolean | undefined,
): "" | "ask" | "undecided" | "choosing" | "original" {
  if (routePending) return routePending;
  if (status === "idle" && profileAsks) return "ask";
  return "";
}

/** The chip's whole route slot: the pending stand-in (`chipRoutePending`) plus the targets
 *  and overflow count. An "ask" preview sends NO targets — the configured list is only the
 *  picker's preselection, so showing it would promise a route the user has not chosen yet.
 *  The configured fallback is the IDLE standby preview only: a non-idle status with no
 *  session targets is a failed start's error linger (or the prologue that follows it), where
 *  there is no session and so no route — the same no-fallback rule `trayRoute` keeps.
 *  Pure, so that pairing is unit-tested rather than living only inside `chipPayload`. */
export function chipRoute(
  sessionTargets: string[] | null,
  configured: string[] | undefined,
  routePending: "undecided" | "choosing" | "original" | null,
  status: string,
  profileAsks: boolean | undefined,
): { routePending: "" | "ask" | "undecided" | "choosing" | "original"; translateTo: string[]; translateMore: number } {
  const rp = chipRoutePending(routePending, status, profileAsks);
  if (rp === "ask") return { routePending: rp, translateTo: [], translateMore: 0 };
  const preview = status === "idle" ? configured : undefined;
  return {
    routePending: rp,
    translateTo: chipRouteTargets(sessionTargets, preview),
    translateMore: chipRouteMore(sessionTargets, preview),
  };
}

function validRouteTargets(sessionTargets: string[] | null, profileTargets: string[] | undefined): string[] {
  return (sessionTargets ?? profileTargets ?? []).filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
}

/** The running session's route as one string ("DE → FR IT") for the tray tooltip, or "" when
 *  this session doesn't translate. Reads the SAME resolved `sessionTargets` the chip does, so
 *  the two surfaces can't disagree — and the spoken language from the active Profile, which is
 *  the only piece the session state doesn't already carry. Unlike the chip there is no Profile
 *  fallback: the tray has no standby preview, and a `null` `sessionTargets` under a non-idle
 *  status only happens in a failed start's error linger — no session, so no route to show. */
export function trayRoute(state: ReturnType<typeof useApp.getState>): string {
  const profile = state.activeProfile ? state.profiles.find((p) => p.id === state.activeProfile) : undefined;
  const targets = validRouteTargets(state.sessionTargets, undefined);
  // A push-to-talk session that asks at release has no targets yet, but it does have a
  // route — an undecided one, "DE → ?" — and the tray is the only surface on a chip-less
  // desktop. Ask-standby (no session) stays empty, like every other idle tooltip.
  const undecided = state.routePending === "undecided";
  if (targets.length === 0 && !undecided) return "";
  const backend = backendForProfile(profile, state.backends);
  // The same source rule as the chip's LangPick (routeSourceCode), capped so a long synced
  // language can't push the targets past the tray's 64-character route cap.
  const src = routeSourceCode(effectiveLanguage(profile?.language, backend?.language));
  if (targets.length === 0) return `${src} → ?`;
  const shown = targets.slice(0, CHIP_ROUTE_TARGETS).map((t) => t.trim().toUpperCase());
  const more = targets.length - shown.length;
  return `${src} → ${shown.join(" ")}${more > 0 ? ` +${more}` : ""}`;
}

/** The status word for the tray tooltip — the ONLY status surface on a chip-less desktop.
 *
 *  Mirrors dictationVisual's precedence for a "listening" status: warm-up, then a cold model
 *  load, then the server decoding. `open` is deliberately absent: it only means "working"
 *  while the user is silent, and the tray cannot see `speaking` — "recording…" is the truthful
 *  word for it. `decoding` borrows the existing "transcribing…" string. */
export function trayStatus(status: string, warming: boolean, serverWork: ServerWork): string {
  if (status !== "listening") return status;
  if (warming) return "warming";
  if (serverWork === "loading") return "loading";
  if (serverWork === "decoding") return "transcribing";
  return status;
}

/** Build the chip's tiny usage readout (today's value) for the chosen metric. */
export function chipStatsLine(u: UsageStats, metric: OverlayStatsMetric): string {
  // `today.all` — every kind, like the Words tile; the per-kind split is a Statistics matter.
  const t = u.today.all;
  if (metric === "audio") return `${fmtDuration(t.audio_s)} today`;
  if (metric === "both") return `${fmtCompact(t.words)}w · ${fmtDuration(t.audio_s)}`;
  // Singular on the compact string, like chartKit's metricText: "1 word", "1.2k words".
  const n = fmtCompact(t.words);
  return `${n} ${n === "1" ? "word" : "words"}`;
}

let started = false;
let visible = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
// The edge the window was last placed at, so we only re-place (move the OS window) when it
// actually changes — the edge-peek itself is a pure CSS transform inside the chip.
let shownPos: "top" | "bottom" | undefined;
// …and the "Chip size" factor it was last shown at: a change is pushed to Rust, which tweens
// the webview zoom (the window itself never resizes or moves for it).
let shownScale: number | undefined;

/** The last `n` UTF-16 units of `s`, minus a lone low surrogate the unit cut may leave at the
 *  front (one code point fewer, so the result is still well-formed UTF-16 — and >= n/2 - 1
 *  code points). The cut lands in the `dictation://update` payload, which Tauri carries as
 *  JSON through serde_json: a lone surrogate there fails the whole emit, not one character. */
export function tailUnits(s: string, n: number): string {
  const t = s.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t;
}

/** Assemble the full `dictation://update` payload from a store snapshot. Everything the
 *  chip renders is resolved HERE (main window) because the overlay webview can't read
 *  this store — it only ever sees these payloads. */
function chipPayload(state: ReturnType<typeof useApp.getState>) {
  const rec = state.settings.recording;
  // Which Profile is dictating, for the chip's identity tag (+ its language /
  // stream-vs-batch mode). Omitted entirely when the feature is off or no Profile is active.
  let chip: {
    profileTag?: string;
    language?: string;
    mode?: "stream" | "batch";
    translateTo?: string[];
    translateMore?: number;
    routePending?: "" | "ask" | "undecided" | "choosing" | "original";
  } = {};
  // The Profile to label the chip with: the one dictating, or — for a persistent
  // idle dock — the home target it would launch (so standby previews that Profile).
  const chipProfile = state.activeProfile
    ? state.profiles.find((p) => p.id === state.activeProfile)
    : rec.persistentDock
      ? homeTargetProfile(state.profiles, state.settings.homeProfileId)
      : undefined;
  const chipBackend = chipProfile ? backendForProfile(chipProfile, state.backends) : undefined;
  if (chipProfile && rec.showProfileOnOverlay) {
    chip = {
      profileTag: chipTagFor(chipProfile),
      // Effective language: a set per-Profile override wins; else the Backend's.
      language: effectiveLanguage(chipProfile.language, chipBackend?.language),
      // Effective endpoint likewise (a Profile may override stream/batch).
      mode: chipProfile.endpoint ?? chipBackend?.endpoint,
    };
  }
  // The translation ROUTE has its own switch: it is a promise about what will be typed,
  // so it must not disappear with the tag — nor with the Profile: a session whose Profile is
  // deleted or disabled mid-session still translates with the targets it started with
  // (sessionTargets), and the tray showed that route while the chip did not. See
  // chipRouteTargets for the resolution order and why both inputs need bounding.
  if (rec.showRouteOnOverlay) {
    const configured = configuredRouteTargets(chipProfile, chipBackend);
    // What stands in for the route while there is none to promise (see chipRoutePending).
    // An ask-Profile's standby preview sends NO targets: its configured list is only the
    // picker's preselection, and "→ FR IT" on the dock promised a route the next chord press
    // would first ask about — the false promise this field replaces.
    Object.assign(
      chip,
      chipRoute(state.sessionTargets, configured, state.routePending, state.status, chipProfile?.askTranslationTargets),
    );
  }
  // P28: a tiny usage readout (today's words/minutes) for the chip, gated by the
  // setting. Scoped to the same backend the stats controller tracks; omitted when
  // off or the backend has no usage yet (standard/old server, not fetched).
  let statsLine: string | undefined;
  if (rec.showStatsOnOverlay) {
    const sb = activeStatsBackend(state);
    // Own-property read: an inherited `Object.prototype` member is non-nullish, so it would
    // pass `if (u)` and then throw on `u.today.words` — inside a store subscriber, where the
    // throw propagates out of `set()` and aborts every listener after this one.
    const u = sb ? ownProp(state.usage, sb.id) : null;
    if (u) statsLine = chipStatsLine(u, rec.overlayStatsMetric);
  }
  // P16/D: the app being injected into (+ why, if it's coerced to clipboard), gated by the
  // setting and sent only while a session is active so the standby dock shows no stale target.
  const tgt = rec.showTargetOnOverlay && isActiveDictation(state.status) ? state.targetApp : null;
  // Whether the chip's dictate / cycle-profile quick-launch can do anything while idle: the
  // same predicates runOverlayAction refuses on, so an idle chip can say why instead of a dead
  // click. Two flags, not one: the toggle needs a home target AND a Backend for it, while the
  // cycle only needs an enabled Profile (it persists homeProfileId, it starts nothing).
  // startOffHint is the Home button's gate + wording too, so the two never disagree.
  // An open target picker refuses both too (pickerOffHint), so the chip says why instead of
  // offering two dead buttons.
  const pickerHint = pickerOffHint(state.routePending, state.status);
  const homeTarget = homeTargetProfile(state.profiles, state.settings.homeProfileId);
  const startHint = pickerHint || startOffHint(state.profiles, homeTarget, state.backends);
  const canStart = startHint === "";
  const canCycle = !pickerHint && state.profiles.some((p) => p.enabled);
  return {
    status: state.status,
    warming: state.warming, // mic opening but not yet capturing → chip shows "warming up…"
    // The mic is still open → a processing status is a live per-phrase stage, where the chip
    // must not offer the session-discarding ✕ (chipRules.chipCancelVisible). Read at emit time:
    // every capture end lands with a store write (stopLive's status, a teardown's), which re-emits.
    capturing: isCapturing(),
    // What the SERVER is doing behind a "listening" status (cold model load / an utterance it
    // holds or is decoding) → the chip reads blue "working", not amber "ready".
    serverWork: state.serverWork,
    level: state.level,
    // "Live transcript in overlay" off → show the status label, not words. In "on hover"
    // mode the words are still sent but the chip only surfaces them while hovered.
    // Tail only: `state.partial` is the whole document since the last hard break and this
    // payload crosses IPC on every ~30 Hz level tick, while the chip shows just the last 400
    // code points. 800 UTF-16 units is the Overlay's own first cut (>=400 code points). The
    // cut must be well-formed HERE: `emit` JSON-encodes the payload and serde_json rejects a
    // lone surrogate on the IPC hop, which drops the whole chip update — see tailUnits.
    partial: rec.realtimePreview ? tailUnits(state.partial, 800) : "",
    previewOnHover: rec.realtimePreview && rec.realtimePreviewOnHover,
    dictationError: state.dictationError ?? "",
    // The current stage, when the machine has more to say than the one-word status
    // (a cold translate's download/load/translate + its start time). Written by the
    // store only on transitions, so forwarding it adds no churn to this ~30Hz path.
    phase: state.dictationPhase,
    // So the chip can pin itself to the correct edge of its window.
    position: rec.indicatorPosition,
    // So the chip can follow the app's dark/light theme.
    theme: state.settings.theme,
    // …and the Signal colour, derived per window (theme.ts) — the chip cannot read the store.
    accentHue: state.settings.accentHue,
    accentMotion: state.settings.accentMotion,
    // Overlay-chip behaviour (persistent dock / edge-peek / quick-launch). The ?? fallbacks
    // read the store defaults (hydrate fills missing fields, so they're belt-and-braces).
    persistentDock: rec.persistentDock ?? REC_DEFAULTS.persistentDock,
    overlayPeek: rec.overlayPeek ?? REC_DEFAULTS.overlayPeek,
    peekTimeoutSec: rec.peekTimeoutSec ?? REC_DEFAULTS.peekTimeoutSec,
    peekWhileActive: rec.peekWhileActive ?? REC_DEFAULTS.peekWhileActive,
    dimAfterSec: rec.dimAfterSec ?? REC_DEFAULTS.dimAfterSec,
    hoverRevealMs: rec.hoverRevealMs ?? REC_DEFAULTS.hoverRevealMs,
    // Sizes. chipScale is applied by Rust (webview zoom); the chip only needs it to notice a
    // change and come out of hiding. dotScale is the chip's own CSS (minimized dot only).
    chipScale: rec.chipScale ?? REC_DEFAULTS.chipScale,
    dotScale: rec.dotScale ?? REC_DEFAULTS.dotScale,
    // Whether these settings are the loaded config or still the store defaults: the chip keeps
    // re-seeding its size refs until a loaded payload arrives, so hydration is not read as a
    // Settings adjustment (tuck / nudge at launch).
    configLoaded: state.configLoaded,
    // The shared default array is only serialized here, never mutated.
    quickLaunch: rec.quickLaunch ?? REC_DEFAULTS.quickLaunch,
    // …and why its dictate / cycle-profile buttons are off while idle, worded like Home's.
    canStart,
    startHint,
    canCycle,
    // No target passed: cycling needs no Backend, so this only ever says add / enable a profile
    // (or, while the target picker is open, to answer it first).
    cycleHint: canCycle ? "" : pickerHint || startOffHint(state.profiles, undefined, state.backends),
    // The injection target app title + a skip reason ("blocked" / "notEditable") for the
    // warn-tinted hint. Empty when the feature's off, no app is known, or the session's idle.
    targetTitle: tgt?.title ?? "",
    targetSkip: tgt ? (state.targetSkip ?? "") : "",
    // AND with the parent like the other hover flags below: in "On hover" mode the
    // "Only while speaking" control is disabled, but a `true` set earlier in "Always" mode
    // persists and would gate the target on `expanded` (never true while armed-but-silent),
    // so hovering could never reveal it — defeating the user's "On hover" choice.
    targetOnlySpeaking: !rec.showTargetOnHover && rec.showTargetOnlySpeaking,
    // When on, the chip reveals the target only while hovered (vs. always shown).
    targetOnHover: rec.showTargetOnOverlay && rec.showTargetOnHover,
    // P19: per-phrase "inserted" pulse + truthful end-of-session done marker. Sent
    // UNGATED by ACTIVE — the done marker must reach the chip on the idle transition.
    lastInsert: state.lastInsert,
    sessionOutcome: state.sessionOutcome,
    // "none" that was NOT a cancel: the picker was aborted after release, so the transcript
    // was kept (and, "-saved", recorded) but nothing was inserted. Ungated like the outcome
    // it qualifies — it lands on the same idle transition.
    sessionNote: state.sessionNote,
    // Why the translation didn't land, so the done marker can qualify itself instead of
    // showing an unearned "typed" over text that was inserted in the ORIGINAL language.
    // Sent ungated by ACTIVE for the same reason as sessionOutcome — it must reach the
    // chip on the idle transition, which is exactly when the marker is drawn.
    translateFailure: state.translateFailure ?? "",
    statsLine: statsLine ?? "",
    // When on, the chip reveals the readout only while hovered (vs. always shown).
    statsOnHover: rec.showStatsOnOverlay && rec.overlayStatsOnHover,
    // When on, the chip reveals the Profile tag only while hovered (vs. always shown).
    profileOnHover: rec.showProfileOnOverlay && rec.showProfileOnHover,
    // Likewise for the route.
    routeOnHover: rec.showRouteOnOverlay && rec.showRouteOnHover,
    ...chip,
  };
}

export async function initOverlayController(): Promise<void> {
  if (!isTauri || started) return;
  started = true;

  const { emit, listen } = await import("@tauri-apps/api/event");

  /** Push the CURRENT store state to the chip, outside the subscriber's change gate. */
  const pushNow = () => {
    const state = useApp.getState();
    if (state.settings.recording.indicatorPosition === "off") return;
    void emit("dictation://update", chipPayload(state)).catch((e) => console.error("overlay emit failed:", e));
  };

  // Startup handshake. A Tauri emit with no registered listener is DROPPED, never queued,
  // and the two webviews boot in parallel — so the chip's first update was a race it often
  // lost: it then sat on its built-in placeholder (a fake "armed" dot, auto-hide off) until
  // the next incidental re-broadcast (the 30s usage poll on a full server; on Windows with a
  // standard/idle backend, nothing until the first dictation). Cover both orders:
  //  - the chip's listener came up AFTER our first emits → it sends `overlay://ready`
  //    once registered and we answer with a fresh push;
  //  - the chip was up BEFORE this controller → the unconditional push below reaches it
  //    (and if config hydrates later, the settings-identity change re-emits through the
  //    subscriber's gate as usual).
  // Await the registration before the first push: an un-awaited listen leaves a window in
  // which the chip's ready emit is dropped AND our push predates the chip's listener.
  await listen("overlay://ready", pushNow);
  pushNow();

  useApp.subscribe((state, prev) => {
    const pos = state.settings.recording.indicatorPosition;
    const scale = state.settings.recording.chipScale ?? 1;
    // Forward the live chip state whenever the relevant fields change — but only when the chip is
    // actually enabled. With it "off" (tray-only / GNOME) the overlay webview is never shown, so this
    // ~30Hz level-driven payload rebuild + cross-window broadcast to a hidden window is pure waste
    // (the churn that bloats the shared WebKitGTK renderer). A position toggle flows through the
    // `state.settings` change below, so flipping back to an edge re-emits a fresh payload in the same
    // tick that reveals the chip — no staleness.
    if (
      pos !== "off" &&
      (state.status !== prev.status ||
      state.warming !== prev.warming || // mic warm-up gate (chip "warming up…")
      state.serverWork !== prev.serverWork || // server-side work behind "listening" (blue, not amber)
      state.level !== prev.level ||
      state.partial !== prev.partial ||
      state.dictationError !== prev.dictationError ||
      state.dictationPhase !== prev.dictationPhase || // stage label / progress / elapsed clock
      state.activeProfile !== prev.activeProfile || // switching Profiles mid-session
      state.profiles !== prev.profiles || // a rename/tag/language edit changes the chip identity tag
      state.backends !== prev.backends || // a bound-backend language/endpoint edit changes language/mode
      state.caps !== prev.caps || // a server's target cap bounds the configured route preview
      state.targetApp !== prev.targetApp || // injection target (chip "→ app" readout)
      state.targetSkip !== prev.targetSkip ||
      state.lastInsert !== prev.lastInsert || // per-phrase "inserted" pulse trigger
      state.sessionOutcome !== prev.sessionOutcome || // end-of-session done marker
      state.sessionTargets !== prev.sessionTargets || // the session's resolved translation route
      state.routePending !== prev.routePending || // undecided / choosing / original stand-ins for it
      state.sessionNote !== prev.sessionNote || // end-of-session qualifier (not inserted / incomplete)
      state.translateFailure !== prev.translateFailure || // qualifies the done marker
      state.usage !== prev.usage || // P28: refreshed usage stats → update the chip readout
      state.configLoaded !== prev.configLoaded || // the chip latches its size seed on the loaded config
      state.settings !== prev.settings) // theme / position / preview / show-profile toggles
    ) {
      void emit("dictation://update", chipPayload(state)).catch((e) => console.error("overlay emit failed:", e));
    }

    // Reflect status in the tray tooltip — the reliable status cue on chip-less platforms
    // (GNOME / non-KDE Wayland). Fire on a warming change too so the cold-mic warm-up reads
    // "warming up…" there like every other surface, instead of falsely claiming "recording…".
    // Also re-fires on a route change, so a session that resolved its targets after the
    // status settled still reaches the tray — on a chip-less desktop this tooltip is the
    // ONLY place the route can appear.
    // …and on the identity inputs `trayRoute` reads for the SOURCE language: `activeProfile`
    // is published AFTER status/targets at session start, so without these the tooltip
    // rendered "AUTO → …" and only self-corrected on the next status flip.
    if (
      state.status !== prev.status ||
      state.warming !== prev.warming ||
      state.serverWork !== prev.serverWork || // "loading model…" / "transcribing…" behind a listening status
      state.sessionTargets !== prev.sessionTargets ||
      state.routePending !== prev.routePending || // "DE → ?" while a push-to-talk session is undecided
      state.activeProfile !== prev.activeProfile ||
      state.profiles !== prev.profiles ||
      state.backends !== prev.backends // the inherited source language lives on the Backend
    ) {
      void setTrayState(trayStatus(state.status, state.warming, state.serverWork), trayRoute(state)).catch((e) => console.error("setTrayState failed:", e));
    }
    // Cues stay keyed on status TRANSITIONS only (not warming), so a warm-up flip can't re-fire them.
    if (state.status !== prev.status) {
      if (state.settings.general.soundEffects) {
        // Only chime "stop" if the mic actually went live this session — a session ENDED during
        // warm-up (stopLive sets {transcribing, warming:false} in one update, mic never live) would
        // otherwise play a "stop" with no preceding "start".
        // "translating" IS included, but only on the micLive:false edge that stopLive stamps:
        // a stop landing DURING a per-phrase translate is a real session end. translatePhrase's
        // finally restores the displaced status after a stop (translating->transcribing with
        // micLive already false) and must stay silent — including that would fire a second
        // "stop" chime inside one session. A capture-death `closed` (listening->transcribing,
        // micLive untouched) still chimes via prev.micLive.
        if (
          state.status === "transcribing" &&
          prev.micLive &&
          (prev.status === "listening" || (prev.status === "translating" && !state.micLive))
        )
          void playCue("stop").catch((e) => console.error("playCue failed:", e));
        else if (state.status === "error") void playCue("error").catch((e) => console.error("playCue failed:", e));
      }
    }
    // The "start" cue fires when the mic actually goes LIVE — gated on the micLive edge (real audio
    // flowed, or the warm-up safety timeout fired), NOT merely on warming clearing: a session that
    // DIES during warm-up (a teardown clears warming with the mic never live) must not chime "start".
    // On a cold Bluetooth mic this is ~1–2s after arming, so the "go" lines up with real capture.
    if (state.settings.general.soundEffects && state.micLive && !prev.micLive) {
      void playCue("start").catch((e) => console.error("playCue failed:", e));
    }

    const persistent = state.settings.recording.persistentDock && pos !== "off";
    const active = isActiveDictation(state.status);
    const prevActive = isActiveDictation(prev.status);

    // Shown while a session is active, OR always (as a standby dot) when the dock is on.
    if (pos !== "off" && (active || persistent)) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
      // (Re)place the window on first show, on session start, or when the edge changes. The
      // window is anchored flush against that edge and never moves again for the peek — the
      // edge-peek tuck is a pure CSS transform in the chip (Overlay.tsx), so it animates
      // reliably and can't desync with an OS window-move (which Wayland applies instantly).
      if (!visible || (active && !prevActive) || pos !== shownPos) {
        void showOverlay(pos, scale).catch((e) => console.error("showOverlay failed:", e));
        shownPos = pos;
        shownScale = scale;
      } else if (scale !== shownScale) {
        void setOverlayScale(scale).catch((e) => console.error("setOverlayScale failed:", e));
        shownScale = scale;
      }
      visible = true;
      return;
    }

    // Inactive (and no persistent dock), or the overlay is disabled — hide it (with a
    // linger so the final transcript / error stays readable; immediately if turned off).
    // An error can also arrive while the chip is HIDDEN (a start-failure in the prologue before
    // status reaches "listening", or a late drain error after the chip already hid) — neither active
    // nor persistent, so the show gate above skipped it. Show it here first so the error linger below
    // actually displays it, then let it tear down as usual (the 2400ms error linger is preserved).
    // Only an error EDGE (a new error status or message) does that: the store keeps "error" for
    // ERROR_LINGER_MS, longer than the linger, so any unrelated write in that gap would re-show the
    // error the chip had just hidden.
    const errorEdge =
      state.status === "error" && (prev.status !== "error" || state.dictationError !== prev.dictationError);
    if (visible || (pos !== "off" && errorEdge)) {
      // The linger is already armed with the right delay: an unrelated write (a document
      // translation's 1 s progress tick, the level meter) must not re-arm it, or the chip
      // never hides while that runs. Re-arm only on a status, error or position change.
      if (
        hideTimer !== undefined &&
        state.status === prev.status &&
        state.dictationError === prev.dictationError &&
        state.sessionNote === prev.sessionNote &&
        state.translateFailure === prev.translateFailure &&
        state.sessionOutcome === prev.sessionOutcome &&
        pos === prev.settings.recording.indicatorPosition
      )
        return;
      clearTimeout(hideTimer);
      if (!visible && pos !== "off") {
        void showOverlay(pos, scale).catch((e) => console.error("showOverlay failed:", e));
        shownPos = pos;
        shownScale = scale;
        visible = true;
      }
      // A session note ("incomplete" / "not inserted") or an untranslated outcome rides the idle
      // write, and the chip holds it for sessionNoteHoldMs (the same rule as Overlay.tsx's note /
      // pulse timers and collapse linger): the plain 1800 ms linger would hide the window before
      // it can be read. 200 ms of margin so the window outlasts the chip's own timer.
      const hold = sessionNoteHoldMs(state);
      const delay =
        pos === "off" ? 0
        : state.status === "error" ? 2400
        : hold > 0 ? hold + 200
        : 1800;
      hideTimer = setTimeout(() => {
        hideTimer = undefined;
        visible = false;
        shownPos = undefined; // force a re-place (and re-anchor) on the next show
        void hideOverlay().catch((e) => console.error("hideOverlay failed:", e));
      }, delay);
    }
  });
}
