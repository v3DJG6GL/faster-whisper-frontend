import type { DictationStatus, ServerWork } from "../types";

/**
 * THE single source of truth mapping dictation state → colour / shape / label,
 * shared by every surface (overlay chip, sidebar status dot, Home hero button, the
 * waveforms).
 *
 * The palette:
 *   • green  (live)   — actively speaking
 *   • amber  (armed)  — armed but silent ("ready to speak"; the OS mic-in-use cue). Its
 *                       own fixed token (--c-armed), not the accent: the Signal colour is
 *                       any hue the user picks and may drift with the clock, and a state
 *                       colour must not.
 *   • teal   (translate) — the T2T translating stage: the one machine-working state that can
 *                       take tens of seconds (a cold GGUF load), so it gets its own hue rather
 *                       than the generic blue — a wait you can't tell from "finalizing…" reads
 *                       as a hang. It reuses `--c-translate`, the T2T hue of the viewer's MT
 *                       lines and the translate run chrome.
 *   • blue   (think)  — finalizing / inserting / mic warm-up, and — in a streaming session, whose
 *                       status never leaves "listening" — whatever the SERVER reports it is
 *                       doing: loading its model, or holding / decoding your last phrase.
 *                       Not grey: grey-working would be identical to grey-off on the tucked
 *                       edge-dot, whose colour is its ONLY channel (no shape/motion legibility
 *                       at half-dot size). Not amber: the mic is closed while finalizing, so
 *                       "ready to speak" would lie.
 *   • red    (rec)    — error
 *   • grey   (faint)  — off / idle, rendered HOLLOW
 *
 * `speaking` comes from stepSpeaking() (see ./speaking) and only matters while the
 * status is "listening". State is also conveyed by SHAPE (filled vs hollow) and
 * MOTION (pulse), never by hue alone — red/green is the most colour-blind-confused
 * pair (WCAG 1.4.1).
 *
 * The chip's dot (Overlay.tsx) takes its colours from `state` and `tone` below, layering
 * only its edge-tuck / standby-dock presentation on top.
 */
export type DictationVisualState = "off" | "armed" | "speaking" | "processing" | "error";

/** Colour-token key — maps 1:1 to an `app.css` --c-* token / Tailwind `bg-*`/`text-*` utility. */
export type DictationTone = "faint" | "armed" | "live" | "dim" | "rec" | "think" | "translate";

export interface DictationVisual {
  state: DictationVisualState;
  tone: DictationTone;
  /** Short status word for a label / tooltip. */
  label: string;
  /** Should the indicator animate (pulse/breathe)? True for every live state, false when off. */
  pulse: boolean;
  /** Filled (solid) vs hollow (outline). Off is the only hollow state — the hue-independent cue. */
  filled: boolean;
}

export function dictationVisual(
  status: DictationStatus,
  speaking: boolean,
  warming = false,
  serverWork: ServerWork = null,
): DictationVisual {
  // Mic opening but not yet delivering audio (e.g. a Bluetooth headset switching into
  // its mic profile). Read as blue "working" — NOT the amber "ready to speak" — so
  // the user doesn't start talking before the mic is actually capturing.
  if (warming && status === "listening") {
    return { state: "processing", tone: "think", label: "warming up…", pulse: true, filled: true };
  }
  // The server is cold-loading its model: the handshake is not done, so nothing said now is
  // being transcribed yet. Outranks `speaking` for the same reason warm-up does — green would
  // promise that the words are landing.
  if (serverWork === "loading" && status === "listening") {
    return { state: "processing", tone: "think", label: "loading model…", pulse: true, filled: true };
  }
  switch (status) {
    case "error":
      return { state: "error", tone: "rec", label: "error", pulse: true, filled: true };
    case "transcribing":
      return { state: "processing", tone: "think", label: "finalizing…", pulse: true, filled: true };
    case "translating":
      return { state: "processing", tone: "translate", label: "translating…", pulse: true, filled: true };
    case "injecting":
      return { state: "processing", tone: "think", label: "inserting…", pulse: true, filled: true };
    case "listening":
      if (speaking) return { state: "speaking", tone: "live", label: "listening", pulse: true, filled: true };
      // A streaming session never leaves "listening" between phrases: while the server holds,
      // then decodes, the phrase (`utterance` frames → serverWork, never guessed from silence),
      // this shows the blue a batch session shows for the same work, not amber "ready". The mic
      // IS still open (unlike the other blue states), which is why speech wins above.
      return serverWork === "open" || serverWork === "decoding"
        ? { state: "processing", tone: "think", label: "transcribing…", pulse: true, filled: true }
        : { state: "armed", tone: "armed", label: "listening", pulse: true, filled: true };
    case "idle":
    default:
      return { state: "off", tone: "faint", label: "off", pulse: false, filled: false };
  }
}

/**
 * THE single membership test for the "active session" set {listening, transcribing, translating, injecting}
 * (idle and error excluded), shared by every "is a session running" gate so a future status can't be
 * silently omitted at one of them.
 */
export function isActiveDictation(status: DictationStatus): boolean {
  return (
    status === "listening" || status === "transcribing" ||
    status === "translating" || status === "injecting"
  );
}

/**
 * The post-capture "processing" subset {transcribing, translating, injecting} — finalizing → translating → inserting,
 * the states with no audio to react to that drive the self-animated chip/waveform motion AND
 * the hotkey/button stop-vs-cancel branch. Centralized for the same reason as isActiveDictation.
 */
export function isProcessing(status: DictationStatus): boolean {
  return status === "transcribing" || status === "translating" || status === "injecting";
}

/**
 * Does a stop gesture mean "end this session gracefully" (stopLive) rather than "kill it"
 * (cancelLive)? Shared by the hotkey/PTT path, the Home hero button and the chip's toggle.
 *
 * `status === "listening"` alone is not enough: a live per-phrase translate reports
 * "translating" (a PROCESSING status) WHILE THE MIC IS STILL OPEN, so a push-to-talk chord
 * release in that window would be silently dropped (stopOrCancel ignores a processing status
 * on a soft stop), wedging the session, and the hero and chip would offer a cancel that
 * discards a live session. The real question is "is there a live mic behind this status" —
 * `capturing` (streaming.isCapturing). For post-capture processing a soft stop stays a no-op
 * and a deliberate toggle is the cancel that recovers a wedged finalize.
 */
export function isGracefulStop(status: DictationStatus, capturing: boolean): boolean {
  return status === "listening" || (capturing && isProcessing(status));
}

/** How long the chip holds an end-of-session note that carries a reason to read: the
 *  "incomplete" note and the untranslated pulse. */
export const SESSION_WARN_HOLD_MS = 2600;
/** How long the chip holds a plain end-of-session note ("not inserted"). */
export const SESSION_NOTE_HOLD_MS = 2000;

/**
 * THE one rule for how long an end-of-session note stays readable: the "incomplete" note or a
 * failed translate on a typed/clipboard outcome (the untranslated pulse) → SESSION_WARN_HOLD_MS;
 * any other note → SESSION_NOTE_HOLD_MS; nothing to read → 0. Both surfaces call this: the
 * window's hide linger (chipController.ts, dock off) and the chip's own pulse and note timers
 * (Overlay.tsx, dock on — the collapse linger follows those via collapseLingerMs), so the two
 * can't cut each other's note short.
 */
export function sessionNoteHoldMs(s: {
  sessionNote?: string | null;
  translateFailure?: unknown;
  sessionOutcome?: string | null;
}): number {
  const untranslated = !!s.translateFailure && (s.sessionOutcome === "typed" || s.sessionOutcome === "clipboard");
  if (s.sessionNote === "incomplete" || untranslated) return SESSION_WARN_HOLD_MS;
  return s.sessionNote ? SESSION_NOTE_HOLD_MS : 0;
}

/**
 * How long the docked chip waits before collapsing once nothing wants it expanded: until the
 * end-of-session note / untranslated pulse that is still SHOWING expires (`holdUntil`, the
 * deadline the chip's own note/pulse timers were armed with on their edge — 0 or past when
 * none is up), or the words linger, whichever is longer. Keyed on the live deadline rather
 * than on sessionNoteHoldMs of the payload: those fields persist until the next session's
 * reset, so a collapse that happens long after the settle (an error flash clearing to idle)
 * would otherwise hold an EMPTY expanded pill for the full note hold.
 */
export function collapseLingerMs(holdUntil: number, wordsLingerMs: number, now: number): number {
  return Math.max(0, holdUntil - now, wordsLingerMs);
}
