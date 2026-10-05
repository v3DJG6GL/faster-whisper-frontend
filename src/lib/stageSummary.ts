// The one-line summaries a folded stage row shows under its description (Transcribe's
// processing card: music separation, diarization) — what the stage will run with, so its
// settings panel can stay closed. Pure, for the tests.

/** A stage model as the summary names it: the run's pick, else the server's default
 *  ("Default · speaker-diarization-community-1"). Both already short. */
export function stageModelText(picked: string | undefined, defaultName: string): string {
  const p = picked?.trim();
  return p ? (p.split("/").pop() || p) : `Default · ${defaultName}`;
}

/** The speaker count as words: "Auto speakers", "3 speakers", "2–5 speakers". */
export function speakersText(mode: "auto" | "count" | "range", count: number, min: number, max: number): string {
  if (mode === "count") return count === 1 ? "1 speaker" : `${count} speakers`;
  if (mode === "range") return min === max ? `${min} ${min === 1 ? "speaker" : "speakers"}` : `${min}–${max} speakers`;
  return "Auto speakers";
}

/** Music source separation: "Model · UVR-MDX-NET-Inst_HQ_3". */
export function separationSummary(model: string): string {
  return `Model · ${model}`;
}

/** Diarization: "Auto speakers · speaker-diarization-community-1". */
export function diarizationSummary(speakers: string, model: string): string {
  return `${speakers} · ${model}`;
}
