// A source's colour: transcribe = the fixed Whisper amber (identity, so never the drifting
// accent), existing = ok, auto-generated = warn,
// hearing-impaired = the diarize lilac, machine translation = think blue. One table so a
// source reads the same in the link card's subtitles table, the compound translation chips
// and the export's tracks.

import { sourceKind, type TrackInfo } from "./transcript/exportTracks";
import type { SiteBadge } from "./transcript/siteSubtitles";

/** `soft` = a tinted badge (fill + text), `dot` = a solid dot. */
export type ToneVariant = "soft" | "dot";

const SOURCE_TONE: Record<SiteBadge["kind"] | "hoh", Record<ToneVariant, string>> = {
  transcribe: { soft: "bg-whisper/15 text-whisper", dot: "bg-whisper" },
  mt: { soft: "bg-think/10 text-think", dot: "bg-think" },
  auto: { soft: "bg-warn/10 text-warn", dot: "bg-warn" },
  existing: { soft: "bg-ok/10 text-ok", dot: "bg-ok" },
  hoh: { soft: "bg-[var(--c-diarize)]/10 text-[var(--c-diarize)]", dot: "bg-[var(--c-diarize)]" },
};

export function sourceTone(kind: SiteBadge["kind"], hoh?: boolean, variant: ToneVariant = "soft"): string {
  return SOURCE_TONE[kind === "existing" && hoh ? "hoh" : kind][variant];
}

/** An export track's source colour. */
export const trackTone = (t: Pick<TrackInfo, "source" | "hoh">, variant: ToneVariant = "soft") =>
  sourceTone(sourceKind(t), t.hoh, variant);
