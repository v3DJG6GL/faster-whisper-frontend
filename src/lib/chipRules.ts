// The overlay chip's expand / tuck / cancel-affordance decisions, as pure
// functions.
//
// WHY they live here and not in Overlay.tsx: the chip is a webview component in a
// repo with no jsdom and no component test, so anything left inline is untestable —
// and these three rules are exactly the kind that regress silently (each is a
// several-term boolean whose terms were added months apart for different bugs).
// Overlay.tsx keeps the effects/timers; the DECISIONS are here.
//
// Every rule re-checks `phase.kind === status` before trusting the phase. The two
// travel to the chip in ONE payload but are written by different store transitions,
// so they can disagree for a frame — and a stale phase is precisely what would pop
// the pill open (or hold the ✕ up) after the stage it described has ended.

import { isProcessing } from "./dictationVisual";
import type { DictationPhase, DictationStatus } from "./types";

/** How long a processing stage must persist before it earns the pill. Below this a
 *  state is over before the eye resolves it, and the expand+collapse reads as a
 *  glitch (a tucked dot sliding out, an empty pill falling back to "listening") —
 *  the anti-glitch rule the chip has always had, now with an escape hatch for the
 *  stages that DON'T end in a blink. */
export const PHASE_PERSIST_MS = 1000;

/** The cancel affordance (the ✕) is a RECOVERY control for a slow/stuck stage, not
 *  something to flash on every normal end — a quarter-second blink you can't click
 *  and that reads as noise. */
export const CANCEL_AFFORDANCE_DELAY_MS = 700;

/** The phase ONLY when it still describes the current status (see the header). */
export function currentPhase(
  status: DictationStatus,
  phase: DictationPhase | null | undefined,
): DictationPhase | null {
  return phase && phase.kind === status ? phase : null;
}

/** True once this phase is known to be a long one: the caller told us the model is
 *  cold, or it has simply outlasted the anti-glitch window. */
function persists(phase: DictationPhase, now: number): boolean {
  return phase.cold === true || now - phase.startedAt > PHASE_PERSIST_MS;
}

/** Elapsed wall time in the current phase (0 when there is none). Derived from the
 *  phase's epoch on the READER's clock — see DictationPhase, which deliberately
 *  broadcasts a start time rather than a per-second counter. */
export function phaseElapsedMs(phase: DictationPhase | null | undefined, now: number): number {
  if (!phase) return 0;
  return Math.max(0, now - phase.startedAt);
}

/** ms → the phase row's `m:ss` clock. Minutes are NOT dropped under a minute: a
 *  readout that changes shape mid-wait ("47s" → "1:02") reads as a different value,
 *  and this one is watched continuously. */
export function phaseClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Should the chip be a full pill rather than a dot?
 *
 *  Error / warm-up / speech expand outright. A processing state normally only KEEPS
 *  an already-open pill open — it never pops a minimized chip just to flash a
 *  sub-second stage. The one addition: a stage that is KNOWN to be long (a cold
 *  translate) or has already outlasted PHASE_PERSIST_MS does earn the pill, because
 *  the alternative is a silent dot for tens of seconds, which reads as a hang. */
export function chipExpansion(a: {
  status: DictationStatus;
  warming?: boolean;
  speaking: boolean;
  /** Is the pill open right now? (Processing sustains, never initiates.) */
  expanded: boolean;
  phase?: DictationPhase | null;
  now: number;
}): boolean {
  if (a.status === "error" || a.warming) return true;
  if (a.status === "listening") return a.speaking;
  if (!isProcessing(a.status)) return false;
  if (a.expanded) return true;
  const phase = currentPhase(a.status, a.phase);
  return phase != null && persists(phase, a.now);
}

/** Should an ALREADY-TUCKED chip stay tucked through this state?
 *
 *  The hold exists so a minimized chip hides from the edge instead of sliding out to
 *  flash a quarter-second finalize. A stage that will visibly last, though, is worth
 *  the slide — the user is about to wait, and the pill is where the elapsed readout
 *  and the ✕ live.
 *
 *  NOTE this does NOT override "stay hidden while dictating" (peekWhileActive): that
 *  is an explicit user instruction, and the caller's keep-minimized branch keeps the
 *  dot tucked whatever this returns. In that mode the cancel is reachable from Home
 *  and the hotkey instead. */
export function chipTuckHold(a: {
  peeked: boolean;
  status: DictationStatus;
  phase?: DictationPhase | null;
  now: number;
}): boolean {
  if (!a.peeked || !isProcessing(a.status)) return false;
  const phase = currentPhase(a.status, a.phase);
  return !(phase != null && persists(phase, a.now));
}

/** Should the ✕ be on screen?
 *
 *  `processingSince` is when the current processing run began (null when not
 *  processing). Normally the ✕ waits out CANCEL_AFFORDANCE_DELAY_MS so a fast finalize
 *  never blinks one up. A phase that declares itself cold AND cancellable shows it at
 *  once: the wait is known to be long, and an escape hatch that appears late is one
 *  the user has already spent the wait looking for. */
export function chipCancelVisible(a: {
  phase?: DictationPhase | null;
  processingSince: number | null;
  status: DictationStatus;
  now: number;
}): boolean {
  if (a.processingSince == null) return false;
  const phase = currentPhase(a.status, a.phase);
  if (phase?.cancellable && phase.cold) return true;
  return a.now - a.processingSince >= CANCEL_AFFORDANCE_DELAY_MS;
}
