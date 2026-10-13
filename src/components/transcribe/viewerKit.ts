// The transcript viewer's shared non-component bits (the viewer and SegmentRow both use them).

import { capCodePoints, stripControlChars } from "@/lib/sanitize";

/** Chip styling from a speaker's CSS color (a --spk-N token, so it follows
 *  the light/dark theme): readable text, a soft fill, and a solid dot. */
export function chipStyle(color: string) {
  return { color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` };
}

export type EffSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  edited: boolean;
};

/** A speaker rename as stored: 40 code points, the longest name a subtitle re-import reads back
 *  as the speaker (subtitleImport's "Name: " prefix and voice-tag display bound), and no colon —
 *  SRT/LRC write "Name: text", and the importer ends the name at its first colon. */
export function speakerRenameValue(draft: string): string {
  const name = stripControlChars(draft).replace(/\s*:\s*/g, " ").trim();
  return capCodePoints(name, 40).trim();
}

/** What committing the speaker rename editor writes: null = nothing, when the draft is the
 *  stored name it was seeded with (opening the editor and leaving it must not re-cap a name
 *  stored before the cap, or by another device); otherwise the cleaned name. */
export function renameToCommit(draft: string, stored: string | undefined): string | null {
  return draft.trim() === (stored ?? "").trim() ? null : speakerRenameValue(draft);
}

/** Whether a rejected play() means playback is broken. The error-event fallback chain (buffer →
 *  blob → decoded WAV) decides that, not a Play press: WebKitGTK rejects play() at once with
 *  NotSupportedError on an element whose source just failed, and any press while a buffer read
 *  or a decode is in flight hits the element being replaced. AbortError = a pause or a new
 *  source cut the play short. */
export function playRejectionBreaks(name: string, fallbackPending: boolean): boolean {
  return !fallbackPending && name !== "AbortError" && name !== "NotSupportedError";
}
