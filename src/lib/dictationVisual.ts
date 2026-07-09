import type { DictationStatus } from "./types";

/**
 * THE single source of truth mapping dictation state → colour / shape / label,
 * shared by every surface (overlay chip, sidebar status dot, Home hero button, the
 * waveforms). Before this, each surface hard-coded its own map and they disagreed
 * (the sidebar even inverted it — idle=green, active=red).
 *
 * It mirrors the overlay chip's long-standing palette, which is the design intent:
 *   • green  (live)   — actively speaking
 *   • amber  (accent) — armed but silent ("ready to speak"; the OS mic-in-use cue)
 *   • blue   (think)  — finalizing / inserting / mic warm-up (machine working). Was
 *                       neutral-grey (dim), but grey-working was indistinguishable
 *                       from grey-off — literally identical on the tucked edge-dot,
 *                       whose colour is its ONLY channel (no shape/motion legibility
 *                       at half-dot size). A cool hue can't be confused with any of
 *                       the warm states, and deliberately is NOT amber: the mic is
 *                       closed while finalizing, so "ready to speak" would lie.
 *   • red    (rec)    — error
 *   • grey   (faint)  — off / idle, rendered HOLLOW
 *
 * `speaking` comes from stepSpeaking() (see ./speaking) and only matters while the
 * status is "listening". State is also conveyed by SHAPE (filled vs hollow) and
 * MOTION (pulse), never by hue alone — red/green is the most colour-blind-confused
 * pair (WCAG 1.4.1).
 *
 * NOTE: keep this in sync with the chip's own dot logic in Overlay.tsx — the chip
 * derives its resting colours from `state` below, layering only its edge-tuck /
 * standby-dock presentation on top.
 */
export type DictationVisualState = "off" | "armed" | "speaking" | "processing" | "error";

/** Colour-token key — maps 1:1 to an `app.css` --c-* token / Tailwind `bg-*`/`text-*` utility. */
export type DictationTone = "faint" | "accent" | "live" | "dim" | "rec" | "think";

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
): DictationVisual {
  // Mic opening but not yet delivering audio (e.g. a Bluetooth headset switching into
  // its mic profile). Read as blue "working" — NOT the amber "ready to speak" — so
  // the user doesn't start talking before the mic is actually capturing.
  if (warming && status === "listening") {
    return { state: "processing", tone: "think", label: "warming up…", pulse: true, filled: true };
  }
  switch (status) {
    case "error":
      return { state: "error", tone: "rec", label: "error", pulse: true, filled: true };
    case "transcribing":
      return { state: "processing", tone: "think", label: "finalizing…", pulse: true, filled: true };
    case "injecting":
      return { state: "processing", tone: "think", label: "inserting…", pulse: true, filled: true };
    case "listening":
      return speaking
        ? { state: "speaking", tone: "live", label: "listening", pulse: true, filled: true }
        : { state: "armed", tone: "accent", label: "listening", pulse: true, filled: true };
    case "idle":
    default:
      return { state: "off", tone: "faint", label: "off", pulse: false, filled: false };
  }
}

/**
 * THE single membership test for the "active session" set {listening, transcribing, injecting}
 * — armed/capturing → finalizing → inserting. Excludes idle (no session) and error. Centralizes
 * what the chip visibility, Home stop/cancel button, hotkey busy-gate, and stream epoch-gating
 * each used to hand-roll, so a future status can't be silently omitted at one of them.
 */
export function isActiveDictation(status: DictationStatus): boolean {
  return status === "listening" || status === "transcribing" || status === "injecting";
}

/**
 * The post-capture "processing" subset {transcribing, injecting} — finalizing → inserting,
 * the states with no audio to react to that drive the self-animated chip/waveform motion AND
 * the hotkey/button stop-vs-cancel branch. Centralized for the same reason as isActiveDictation:
 * so a future post-capture status can't be silently omitted at one of the ~6 sites that hand-roll it.
 */
export function isProcessing(status: DictationStatus): boolean {
  return status === "transcribing" || status === "injecting";
}
