// The export's tracks (D88–D92): what each track is (its language and source), how it
// reads in chips, tabs and lane labels, and — from the track order — which track is a
// language's plain one, its title in a video and its file name. Pure; unit-tested.

import { cueTrackLang } from "./cueSplit";
import { safeDisplayText } from "./sanitize";
import { MT_WORD, WHISPER_WORD, siteWord, type SiteBadge } from "./siteSubtitles";
import type { BatchResult } from "./types";

type TrackResult = Pick<BatchResult, "language" | "timedTracks">;

/** Where a track's text comes from: our transcript, a machine translation, or the site's
 *  own subtitles (auto-generated or not). */
export type TrackSource = "whisper" | "mt" | "site" | "auto";

export interface TrackInfo {
  id: string;
  /** The code the track is filed under ("und" when unknown). */
  lang: string;
  source: TrackSource;
  /** A hearing-impaired (SDH) site track. */
  hoh: boolean;
  /** The site's display name (site tracks only). */
  site?: string;
}

export function trackInfo(result: TrackResult, track: string): TrackInfo {
  const lang = (cueTrackLang(result as BatchResult, track) ?? "").trim() || "und";
  const tt = result.timedTracks?.find((t) => t.id === track);
  if (tt) return { id: track, lang, source: tt.kind === "auto" ? "auto" : "site", hoh: !!tt.hoh, site: tt.site };
  return { id: track, lang, source: track === "orig" ? "whisper" : "mt", hoh: false };
}

/** The source word (D88): Whisper, Machine translation, YouTube, YouTube auto, YouTube SDH. */
export function sourceWord(t: TrackInfo): string {
  if (t.source === "whisper") return WHISPER_WORD;
  if (t.source === "mt") return MT_WORD;
  return siteWord({ kind: t.source === "auto" ? "auto" : "manual", hoh: t.hoh, site: t.site });
}

/** The badge kind a source is coloured as (sourceTone). */
export function sourceKind(t: TrackInfo): SiteBadge["kind"] {
  return t.source === "whisper" ? "transcribe" : t.source === "site" ? "existing" : t.source;
}

/** A track as chips, tabs and lanes read it: "DE · Whisper", "EN · Machine translation",
 *  "DE · YouTube auto". */
export function trackChipLabel(result: TrackResult, track: string): string {
  const t = trackInfo(result, track);
  return `${safeDisplayText(t.lang, 16).toUpperCase()} · ${sourceWord(t)}`;
}
