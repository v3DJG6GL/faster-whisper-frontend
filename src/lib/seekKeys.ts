/** Keyboard contract of the transcript seek slider: arrows step (Shift = coarse),
 *  Page keys jump, Home/End clamp, Space toggles playback. Pure so it is testable
 *  without a DOM; returns the clamped target time, "toggle", or null (not ours). */
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
  else if (key === "End") next = audioLen;
  else if (key === " ") return "toggle";
  if (next === null) return null;
  return Math.min(audioLen, Math.max(0, next));
}
