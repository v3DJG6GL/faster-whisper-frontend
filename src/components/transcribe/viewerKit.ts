// The transcript viewer's shared non-component bits (the viewer and SegmentRow both use them).

import { capCodePoints, stripControlChars } from "@/lib/sanitize";

/** Chip styling from a speaker's CSS color (a --spk-N token, so it follows
 *  the light/dark theme): readable text on a soft fill. */
export function chipStyle(color: string) {
  return { color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` };
}

/** The DOM id of segment `i`'s row (a Segments row, or its first Subtitles cue): follow, the
 *  Export→Read re-centre and "Edit its segment" look rows up by it. */
export const segRowId = (i: number) => `seg-row-${i}`;

export type EffSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  edited: boolean;
};

const SPEAKER_NAME_MAX = 40;

/** A speaker rename as stored: 40 code points, the longest name a subtitle re-import reads back
 *  as the speaker (subtitleImport's "Name: " prefix and voice-tag display bound), and no colon —
 *  SRT/LRC write "Name: text", and the importer ends the name at its first colon. */
export function speakerRenameValue(draft: string): string {
  const name = stripControlChars(draft).replace(/\s*:\s*/g, " ").trim();
  return capCodePoints(name, SPEAKER_NAME_MAX).trim();
}

/** The rename field's next draft: maxLength's behaviour counted in code points (an input's
 *  maxLength counts UTF-16 units, halving the cap for an emoji or CJK Ext-B name). An edit that
 *  grows the draft past the cap keeps only as much of the inserted run as fits — a paste fills
 *  the field to the cap, a keystroke at the cap inserts nothing — rather than cutting the tail,
 *  which would delete the name's end on a mid-string typo fix. `insertEnd` is the caret after the
 *  input (UTF-16 index into `typed`): the text after it was already there, which a prefix/suffix
 *  diff alone cannot tell for a paste that starts with the characters after the caret. Without a
 *  usable caret the run is what lies between the common prefix and suffix of `prev` and `typed`.
 *  Returned `caret` = where the kept insertion ends (UTF-16), null when the draft is `typed` as
 *  is. A shorter or equal value and an open IME composition (cutting it mid-composition ends or
 *  duplicates it) pass as typed: the commit caps (speakerRenameValue). */
export function speakerRenameEdit(
  prev: string,
  typed: string,
  composing = false,
  insertEnd: number | null = null,
): { draft: string; caret: number | null } {
  const asTyped = { draft: typed, caret: null };
  if (composing || typed.length <= SPEAKER_NAME_MAX) return asTyped;
  const t = Array.from(typed);
  const p = Array.from(prev);
  if (t.length <= SPEAKER_NAME_MAX || t.length <= p.length) return asTyped;
  const after = insertEnd === null ? null : typed.slice(insertEnd);
  const anchored = after !== null && prev.endsWith(after);
  let suf = anchored ? Array.from(after).length : 0;
  // Bounded by the anchored suffix: a prefix running on into the paste only claims the paste's
  // own head, which the cut keeps anyway.
  let pre = 0;
  while (pre < p.length - suf && p[pre] === t[pre]) pre++;
  if (!anchored) {
    while (suf < p.length - pre && suf < t.length - pre && p[p.length - 1 - suf] === t[t.length - 1 - suf]) suf++;
  }
  // A name stored before the cap leaves no room at all: pre + suf is already past it.
  const room = Math.max(0, SPEAKER_NAME_MAX - pre - suf);
  const head = t.slice(0, pre).join("") + t.slice(pre, t.length - suf).slice(0, room).join("");
  return { draft: head + t.slice(t.length - suf).join(""), caret: head.length };
}

/** The rename input's onChange: the next draft, with a cut edit written back to the field here.
 *  React's controlled-value restore assigns `.value` when the DOM differs from state, and that
 *  moves the caret to the end in WebKitGTK and WebView2; once the field already holds the draft
 *  React writes nothing, so the caret set here stays where the edit happened. */
export function applySpeakerRenameInput(
  el: Pick<HTMLInputElement, "value" | "selectionEnd" | "setSelectionRange">,
  prev: string,
  composing: boolean,
): string {
  const { draft, caret } = speakerRenameEdit(prev, el.value, composing, el.selectionEnd);
  if (caret !== null) {
    el.value = draft;
    el.setSelectionRange(caret, caret);
  }
  return draft;
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
