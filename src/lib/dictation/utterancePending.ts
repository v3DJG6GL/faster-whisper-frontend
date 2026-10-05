/**
 * What the SERVER says about the utterance it is holding, and what of that is worth acting on.
 *
 * A streaming session never leaves "listening" on the client, so the stretch between "you
 * stopped talking" and the server's `final` used to read as amber "ready" while the backend was
 * decoding. The server now announces the lifecycle (`stream://utterance`: open → decoding →
 * final | dropped) and guarantees one terminal frame per announced utterance. This module is the
 * client's copy of that state, kept PURE (the clock is passed in) because `streaming.ts` — the
 * only caller — has no test harness: nothing in this repo mocks Tauri, the same reason
 * `captureIds.ts` lives on its own.
 *
 * The server is the only source. Nothing here INFERS work from local audio; the two limits below
 * only decide how long a server statement stays believable:
 *
 *  • `open` means "I am holding speech", not "I am working". VAD flicker (a fan, music, a TV)
 *    can keep a server utterance open up to its buffer ceiling — minutes. Shown and acted on
 *    as-is, the chip would sit blue and the per-phrase Enter would be withheld for just as long.
 *    So `open` counts while the user is speaking, and for OPEN_STALE_MS after the later of
 *    "speech stopped" and "the frame arrived". The normal flow never gets near it: `decoding`
 *    follows the pause by the server's commit silence (~1.2 s).
 *  • `decoding` is work by definition, and is believed until its terminal frame — capped at
 *    DECODING_MAX_MS so a lost frame (a dropped socket mid-decode that somehow skipped the
 *    teardown) cannot latch the UI. Every real exit clears it long before.
 */

export type UtteranceFrameState = "open" | "decoding" | "dropped";

export const OPEN_STALE_MS = 3000;
export const DECODING_MAX_MS = 30_000;
/** Once the working state has been painted, keep it this long. A decode can finish in well
 *  under 100 ms (a short phrase on a warm GPU), and a status that flips for a few frames reads
 *  as a glitch, not as information. Applies to the RENDERED state only — the protocol state
 *  below is never delayed, and green (speaking) is never held back by it. */
export const MIN_SHOW_MS = 400;

export interface UtterancePending {
  /** The announced, not-yet-terminated utterance — null when the server holds none. */
  state: "open" | "decoding" | null;
  ordinal: number | null;
  /** When the current `state` was entered. */
  since: number;
  /** When this utterance was first announced (its `open`, or a `decoding` with no `open`). */
  announcedAt: number;
  speaking: boolean;
  /** When speech last stopped; meaningful only while `speaking` is false. */
  quietSince: number;
}

export function newUtterancePending(): UtterancePending {
  return { state: null, ordinal: null, since: 0, announcedAt: 0, speaking: false, quietSince: 0 };
}

/** A lifecycle frame arrived. Returns true when it was a terminal (`dropped`). Unknown states
 *  are ignored — must-ignore covers the value as much as the frame type, and the Rust parser
 *  already drops them; this is the second fence, for the value crossing the IPC as a string. */
export function onFrame(p: UtterancePending, state: string, ordinal: number | null, now: number): boolean {
  if (state === "dropped") {
    onTerminal(p);
    return true;
  }
  if (state !== "open" && state !== "decoding") return false;
  // `open` after `decoding` for the SAME utterance cannot happen (the server sends each once,
  // in order); for a new ordinal it is a new utterance whose predecessor's terminal we missed.
  if (p.state === null || (ordinal !== null && ordinal !== p.ordinal)) p.announcedAt = now;
  if (p.state !== state || ordinal !== p.ordinal) p.since = now;
  p.state = state;
  p.ordinal = ordinal;
  return false;
}

/** The utterance ended: its `final` arrived, or it was dropped. Any `final` is a terminal —
 *  the socket is totally ordered and a final only ever comes from the finalize of the utterance
 *  in flight (or from the closing document, when none is), so matching ordinals would buy
 *  nothing and would mis-handle the closing final, whose ordinal belongs to no utterance. */
export function onTerminal(p: UtterancePending): void {
  p.state = null;
  p.ordinal = null;
}

export function onSpeaking(p: UtterancePending, speaking: boolean, now: number): void {
  if (speaking === p.speaking) return;
  p.speaking = speaking;
  if (!speaking) p.quietSince = now;
}

/** Is the server's statement still worth acting on (paint it / hold the per-phrase Enter)? */
export function isLive(p: UtterancePending, now: number): boolean {
  if (p.state === "decoding") return now - p.since < DECODING_MAX_MS;
  if (p.state === "open") return p.speaking || now - Math.max(p.quietSince, p.since) < OPEN_STALE_MS;
  return false;
}

/** The value for the store: the live state, or null. */
export function display(p: UtterancePending, now: number): "open" | "decoding" | null {
  return isLive(p, now) ? p.state : null;
}

/** ms until `display()` changes by the mere passage of time, or null when it won't — so the
 *  caller can arm ONE timer instead of polling. (While speaking an `open` never goes stale; the
 *  speech-stopped edge re-arms.) */
export function msUntilStale(p: UtterancePending, now: number): number | null {
  if (!isLive(p, now)) return null;
  if (p.state === "decoding") return Math.max(0, DECODING_MAX_MS - (now - p.since));
  if (p.speaking) return null;
  return Math.max(0, OPEN_STALE_MS - (now - Math.max(p.quietSince, p.since)));
}

/** How much longer the working state must stay PAINTED if the utterance ended right now. Zero
 *  when it isn't on screen at all: nothing announced, already stale, or the user is speaking
 *  (green is showing, and green is never delayed). Call BEFORE onTerminal. */
export function holdRemainingMs(p: UtterancePending, now: number): number {
  if (p.speaking || !isLive(p, now)) return 0;
  const paintedSince = Math.max(p.announcedAt, p.quietSince);
  return Math.max(0, MIN_SHOW_MS - (now - paintedSince));
}

export function reset(p: UtterancePending): void {
  p.state = null;
  p.ordinal = null;
  p.since = 0;
  p.announcedAt = 0;
  p.speaking = false;
  p.quietSince = 0;
}
