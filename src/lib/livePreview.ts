// The live-dictation block's "What you'd get" preview, as data: a sample dictation whose pauses
// are run through the four live knobs the way the server's endpointer does —
//
//   under the inner silence   nothing happens
//   from the inner silence    the live preview refreshes (no period)
//   from the outer silence    the utterance is final: a period, the next word capitalised
//   from the hard break       a fresh document: the separator is typed (nothing = glued on)
//
// The component only paints these tokens; every rule lives here so it is tested. The app never
// applies these values itself — the server does; this only shows what they mean.

/** The four knobs as the preview reads them (all resolved: own value, else inherited). */
export interface LiveTimings {
  innerMs: number;
  outerMs: number;
  /** 0 = never. */
  hardMs: number;
  separator: string;
}

/** The server's defaults (settings-batch contract), for a preview the server hasn't answered. */
export const LIVE_FALLBACK: LiveTimings = { innerMs: 700, outerMs: 1200, hardMs: 5000, separator: "" };

export type PauseKind = "go" | "ref" | "end" | "par";

export type PreviewToken =
  | { kind: "words"; text: string; /** Glued to the previous sentence: no separator. */ glued: boolean }
  | { kind: "period" }
  | { kind: "pause"; pause: PauseKind; seconds: number }
  | { kind: "space" }
  | { kind: "separator"; text: string };

/** A sample dictation: each phrase with the pause before it, in seconds. */
export const LIVE_SAMPLE: readonly (readonly [string, number])[] = [
  ["so the history", 0],
  ["is only saved", 0.4],
  ["for a whole session", 0.9],
  ["when I use it in live mode", 1.6],
  ["I don't think that's a good practice", 6.5],
  ["the backend logs each part on its own", 0.6],
];

/** What a pause of `seconds` does under `t`. */
export function pauseKind(seconds: number, t: LiveTimings): PauseKind {
  const ms = seconds * 1000;
  if (t.hardMs > 0 && ms >= t.hardMs) return "par";
  if (ms >= t.outerMs) return "end";
  if (ms >= t.innerMs) return "ref";
  return "go";
}

/** Seconds as the preview writes them: "0.7 s", "5 s". */
export function secText(seconds: number): string {
  return `${String(Math.round(seconds * 10) / 10)} s`;
}

/** The legend line: what each range of pause does, with the current values. */
export function previewRule(t: LiveTimings): Record<PauseKind, string> {
  const inner = secText(t.innerMs / 1000);
  return {
    go: `under ${inner} nothing`,
    ref: `from ${inner} preview refreshes`,
    end: `from ${secText(t.outerMs / 1000)} period`,
    par: t.hardMs > 0 ? `from ${secText(t.hardMs / 1000)} new paragraph` : "no paragraph breaks",
  };
}

/** The sample as it would be typed, with each pause shown where it happens. */
export function livePreview(t: LiveTimings, sample: readonly (readonly [string, number])[] = LIVE_SAMPLE): PreviewToken[] {
  const out: PreviewToken[] = [];
  let cap = true;
  let glued = false;
  sample.forEach(([words, pause], i) => {
    if (i > 0) {
      const kind = pauseKind(pause, t);
      const end = kind === "end" || kind === "par";
      if (end) out.push({ kind: "period" });
      out.push({ kind: "pause", pause: kind, seconds: pause });
      if (kind === "par") {
        // The separator exactly as typed; nothing at all glues the next sentence on.
        if (t.separator === "") glued = true;
        else out.push({ kind: "separator", text: t.separator });
      } else out.push({ kind: "space" });
      cap = end;
    }
    out.push({ kind: "words", text: cap ? words[0].toUpperCase() + words.slice(1) : words, glued });
    glued = false;
  });
  out.push({ kind: "period" });
  return out;
}

/** A separator as the preview shows it: a line break as ↵, a tab as ⇥ (the break itself is
 *  drawn after it). */
export function separatorGlyphs(s: string): string {
  return s.replace(/\n/g, "↵").replace(/\t/g, "⇥");
}

/** The inner pause stays below the outer one (the server would otherwise wait ~20 s to commit):
 *  moving one pushes the other along by a step, the inner never below `floor`. Returns the pair
 *  to store; only the values that changed need writing. */
export function keepInnerBelowOuter(
  changed: "inner" | "outer",
  innerMs: number,
  outerMs: number,
  stepMs = 100,
  floorMs = 200,
): { innerMs: number; outerMs: number } {
  if (innerMs < outerMs) return { innerMs, outerMs };
  return changed === "inner"
    ? { innerMs, outerMs: innerMs + stepMs }
    : { innerMs: Math.max(floorMs, outerMs - stepMs), outerMs };
}
