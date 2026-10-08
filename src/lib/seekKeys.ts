/** Keyboard contract of the transcript seek slider: arrows step (Shift = coarse),
 *  Page keys jump, Home/End clamp, Space toggles playback. Pure so it is testable
 *  without a DOM; returns the clamped target time, "toggle", or null (not ours).
 *  A non-positive audioLen means the length is unknown (e.g. a WebM whose
 *  duration is still Infinity): forward steps are not clamped and End is a no-op.
 *  Space is a once-per-press toggle: callers still preventDefault on a key
 *  auto-repeat (so a held Space never scrolls) but only toggle when !e.repeat. */
export function seekKeyTarget(
  key: string,
  curTime: number,
  audioLen: number,
  shift: boolean,
): number | "toggle" | null {
  const step = shift ? 30 : 5;
  let next: number | null = null;
  if (key === "ArrowLeft" || key === "ArrowDown") next = curTime - step;
  else if (key === "ArrowRight" || key === "ArrowUp") next = curTime + step;
  else if (key === "PageDown") next = curTime - 30;
  else if (key === "PageUp") next = curTime + 30;
  else if (key === "Home") next = 0;
  else if (key === "End") {
    if (!(audioLen > 0)) return null;
    next = audioLen;
  }
  else if (key === " ") return "toggle";
  if (next === null) return null;
  return Math.max(0, audioLen > 0 ? Math.min(audioLen, next) : next);
}

/** Index of the last item whose `start` is <= t, or -1 when none has started.
 *  Binary search — items must be time-ordered (segments and words both are).
 *  Shared by the playhead sync (per animation frame) and line stepping. */
export function lastStartedAt(items: readonly { start: number }[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
