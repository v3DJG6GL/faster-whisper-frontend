/**
 * Speaking detector (silence ⇄ speech) over a smoothed RMS level — shared by the
 * dictation chip (Overlay.tsx) and the main-window store so EVERY surface agrees on
 * when you're "actively speaking" (green) vs merely armed and silent (amber).
 *
 * Hysteresis + an asymmetric hold: enter "speaking" fast, leave only after a short
 * silence, so the natural pauses between words don't flicker the indicator. The
 * thresholds are the first thing to tune if it feels too eager/sluggish.
 */
const SPEAK_HIGH = 0.08; // enter "speaking" above this (smoothed)
const SPEAK_LOW = 0.04; // candidate for "silent" below this …
const SILENCE_HOLD_MS = 900; // … but only after staying low this long

export interface SpeakMemo {
  smooth: number;
  belowSince: number | null;
  speaking: boolean;
}

export function newSpeakMemo(): SpeakMemo {
  return { smooth: 0, belowSince: null, speaking: false };
}

/**
 * Advance `memo` with one RMS `level` sample at time `now` (`performance.now()`),
 * given whether dictation is currently listening. Mutates `memo` and returns the
 * updated speaking flag. When not listening, resets to silent.
 *
 * Each consumer keeps its own `SpeakMemo` (the chip in a ref, the store in a
 * module-level singleton); the logic is identical so they converge on the same
 * level stream.
 */
export function stepSpeaking(memo: SpeakMemo, level: number, listening: boolean, now: number): boolean {
  if (!listening) {
    memo.smooth = 0;
    memo.belowSince = null;
    memo.speaking = false;
    return false;
  }
  memo.smooth = memo.smooth * 0.8 + level * 0.2;
  const s = memo.smooth;
  if (s > SPEAK_HIGH) {
    memo.belowSince = null;
    memo.speaking = true;
  } else if (s < SPEAK_LOW) {
    if (memo.belowSince == null) memo.belowSince = now;
    if (memo.speaking && now - memo.belowSince >= SILENCE_HOLD_MS) memo.speaking = false;
  } else {
    memo.belowSince = null; // between thresholds → hold current state
  }
  return memo.speaking;
}
