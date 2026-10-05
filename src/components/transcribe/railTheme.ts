// The Transcribe processing rail's stage vocabulary and clocks: names, descriptions, unit
// words, the timeline hues, and the elapsed / time-left formatters.

import { type RailStage } from "@/lib/transcribeRun";

/** m:ss-style elapsed time for the rail's stage rows. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Display names + one-line explanations for the rail rows (the stage order
 *  itself lives in transcribeRun.railStages). */
export const RAIL_NAMES: Record<RailStage, string> = {
  downloading: "Audio",
  separating: "Music source separation",
  transcribing: "Transcribe",
  diarizing: "Speaker diarization",
  translating: "Translation",
};
export const RAIL_DESCRIPTIONS: Record<RailStage, string> = {
  downloading: "The server fetches the link's audio before the pipeline runs.",
  separating: "Vocals kept, music removed — the transcript decodes from the clean stem.",
  transcribing: "",
  diarizing: "Labels each segment with who is speaking.",
  translating: "Translates the finished segments into your target languages.",
};

/** Plain names for the diarizing stage's units — pyannote's step names
 *  ride as `target`; the technical name stays beside the plain one so a
 *  server log line and a ledger line can be matched. */
export const UNIT_LABELS: Record<string, string> = {
  segmentation: "Finding speech turns",
  embeddings: "Voice fingerprints",
  clustering: "Grouping speakers",
};
export const UNIT_NOUN: Partial<Record<RailStage, string>> = {
  translating: "languages",
  diarizing: "steps",
};
/** Timeline-strip identity: a muted hue and a compact lowercase axis name
 *  per stage. Identity is carried by position + name — hue is redundant
 *  reinforcement, never the only channel. */
export const STAGE_COLORS: Record<RailStage, string> = {
  downloading: "var(--c-download)",
  separating: "var(--c-separate)",
  transcribing: "var(--c-ok)",
  diarizing: "var(--c-diarize)",
  translating: "var(--c-translate)",
};
export const AXIS_NAMES: Record<RailStage, string> = {
  downloading: "audio",
  separating: "music source separation (MSS)",
  transcribing: "transcribe",
  diarizing: "speaker diarization",
  translating: "translate",
};
/** "about X left", rounded coarsely (5 s under ten minutes, whole minutes
 *  above) so consecutive polls never make the estimate jitter. */
export function aboutLeft(ms: number): string {
  const s = Math.max(5, Math.round(ms / 1000 / 5) * 5);
  if (s < 600) {
    const m = Math.floor(s / 60);
    return m > 0
      ? `about ${m}m ${String(s % 60).padStart(2, "0")}s left`
      : `about ${s}s left`;
  }
  return `about ${Math.round(s / 60)}m left`;
}
