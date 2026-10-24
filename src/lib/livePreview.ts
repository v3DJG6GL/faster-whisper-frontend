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

/** The server's defaults, for a preview the server hasn't answered. */
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

/** Who supplies each pause, for serverTimings: the server rewrites a pair only when a client
 *  value takes part, and never moves a locked one. */
export interface PairFacts {
  /** Sent by the client (the profile's or backend's own value, not locked by the server). */
  client: { inner: boolean; outer: boolean; hard: boolean };
  innerLocked: boolean;
  hardLocked: boolean;
  /** The server's own outer pause: what runs when it drops a client outer. */
  serverOuterMs: number;
}

/** `t` as the server will run it: it keeps the inner pause below the outer one (else outer − 50 ms)
 *  and a hard break above it (else outer + 1 s), as streaming/routes.py _client_stream_values does.
 *  With `facts` it mirrors the rest of that rule: only a pair a client value takes part in is
 *  rewritten, and a client outer that conflicts with a LOCKED inner or hard break is dropped (the
 *  server's outer runs, the locked value stays). The preview reads this so it never shows a pair
 *  the server would rewrite; the editor keeps the raw values. */
export function serverTimings(t: LiveTimings, facts?: PairFacts): LiveTimings {
  const client = facts?.client ?? { inner: true, outer: true, hard: true };
  let outerMs = t.outerMs;
  let outerClient = client.outer;
  if (
    facts &&
    outerClient &&
    ((facts.innerLocked && t.innerMs >= outerMs) || (facts.hardLocked && t.hardMs > 0 && t.hardMs <= outerMs))
  ) {
    outerMs = facts.serverOuterMs;
    outerClient = false;
  }
  return {
    ...t,
    outerMs,
    innerMs: (client.inner || outerClient) && t.innerMs >= outerMs ? Math.max(0, outerMs - 50) : t.innerMs,
    hardMs: (client.hard || outerClient) && t.hardMs > 0 && t.hardMs <= outerMs ? outerMs + 1000 : t.hardMs,
  };
}

/** Seconds as the preview writes them: "0.7 s", "5 s". */
export function secText(seconds: number): string {
  return `${String(Math.round(seconds * 10) / 10)} s`;
}

/** A threshold as the legend writes it: to the hundredth, because serverTimings' outer − 50 ms
 *  rounds back to the outer pause in tenths ("from 1.2 s preview refreshes" over "from 1.2 s
 *  period" hid which comes first). Values on 100 ms steps read as secText does. */
function thrText(ms: number): string {
  return `${String(Math.round(ms / 10) / 100)} s`;
}

/** The legend line: what each range of pause does, with the current values. */
export function previewRule(t: LiveTimings): Record<PauseKind, string> {
  const inner = thrText(t.innerMs);
  return {
    go: `under ${inner} nothing`,
    ref: `from ${inner} preview refreshes`,
    end: `from ${thrText(t.outerMs)} period`,
    par: t.hardMs > 0 ? `from ${thrText(t.hardMs)} new paragraph` : "no paragraph breaks",
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

/** The inner pause stays below the outer one (the server would otherwise hold the commit until its
 *  forced-commit cap, 25 s by default): moving one pushes the other along by a step, the inner
 *  never below `floor`. Returns the pair to store; only the values that changed need writing. */
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
