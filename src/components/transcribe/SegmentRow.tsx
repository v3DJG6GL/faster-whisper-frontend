import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { LangTag } from "@/components/ui";
import { fmtTimestamp } from "@/lib/format";
import { stripControlChars } from "@/lib/sanitize";
import { langText } from "@/lib/languages";
import { cn } from "@/lib/cn";
import { ownProp } from "@/lib/own";
import type { TranscriptWord } from "@/lib/types";
import { chipStyle, segRowId, type EffSegment } from "@/components/transcribe/viewerKit";
import { imeComposing } from "@/lib/keys";

/** One transcript row, memoized: during playback only the row entering and the
 *  row leaving the playhead re-render — the other (up to 5000) rows bail on a
 *  shallow prop compare, which is what makes the frame-rate clock affordable. */
export const SegmentRow = memo(function SegmentRow({
  seg, i, isActive, passed, activeWordIdx, passedWordIdx, range, words, showTs,
  showNames, colorize, editMode, reassignOpen, speakers, canSeek,
  translations, translationsKept, visLangsKey, origVisible, origLang, stale,
  isFrontier, recordKey,
  colorOf, displayName, seekTo, onToggleReassign, onReassign, onCommitEdit,
}: {
  seg: EffSegment;
  i: number;
  isActive: boolean;
  /** Fully behind the playhead — renders dimmed as already spoken. */
  passed: boolean;
  /** Index into `words` of the last word already finished; -1 unless this row is active. */
  passedWordIdx: number;
  /** Index into `words` of the word under the playhead; -1 unless this row is active. */
  activeWordIdx: number;
  range: readonly [number, number] | undefined;
  words: TranscriptWord[];
  showTs: boolean;
  showNames: boolean;
  colorize: boolean;
  editMode: boolean;
  reassignOpen: boolean;
  speakers: string[];
  canSeek: boolean;
  /** This segment's translations (server result — corrections don't touch them). */
  translations: Record<string, string> | undefined;
  /** Targets whose translation KEPT the source text (server quality guard) —
   *  rendered flagged/neutral, not as a translation. */
  translationsKept: string[] | undefined;
  /** Visible translated tracks as a joined CSV — a STRING so the memo's
   *  shallow compare holds during playback re-renders. */
  visLangsKey: string;
  origVisible: boolean;
  origLang: string;
  /** The original was edited after MT ran — the translated lines are stale. */
  stale: boolean;
  /** The "translation frontier": first row of the retro-translate run's
   *  in-flight chunk — teal-tinted with a "translating…" pending line. */
  isFrontier: boolean;
  /** The transcript on screen: a switch to another one remounts the editable span, so the
   *  correction typed into it is committed (see editableRef) instead of overwritten. */
  recordKey: string;
  colorOf: (label: string) => string;
  displayName: (label: string) => string;
  seekTo: (t: number) => void;
  onToggleReassign: (i: number) => void;
  onReassign: (i: number, label: string) => void;
  /** Stores the correction; returns the text the row shows from now on. */
  onCommitEdit: (i: number, text: string) => string;
}) {
  // Bumped when an edit commit changes the text on screen, to remount the editable span (see its onBlur).
  const [editRev, setEditRev] = useState(0);
  // A correction typed since the last blur commit. A record switch the user did not click
  // into (a batch run following its next finished file) unmounts the span without a blur —
  // React suppresses events during commit — so the unmount commits it instead, through the
  // PREVIOUS render's onCommitEdit: that one still stores under the old record. The ref is
  // updated after commit, so the switching render's deletion still reads the old one.
  const dirtyRef = useRef(false);
  const commitRef = useRef({ i, onCommitEdit });
  useLayoutEffect(() => {
    commitRef.current = { i, onCommitEdit };
  });
  const editableRef = useCallback((el: HTMLSpanElement | null) => {
    if (!el) return;
    return () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      commitRef.current.onCommitEdit(commitRef.current.i, el.innerText ?? el.textContent ?? "");
    };
  }, []);
  // Word spans only on the ACTIVE segment — keeps the DOM light. Edited
  // segments stay karaoke too: their words are re-aligned to the corrected
  // text (wordAlign), so the timings still match what's on screen.
  const karaoke = isActive && origVisible && range && range[0] < range[1];
  const lineColor = colorize && seg.speaker ? { color: colorOf(seg.speaker) } : undefined;
  // Translated lines carry the segment's SPEAKER color, heavily dimmed (30%
  // toward --c-faint, NOT transparent — WebKitGTK's unpremultiplied transparent
  // mix muddies text, see app.css) and set one step smaller, so a translation
  // never reads as a transcribed line. The language TAG keeps the full accent,
  // which is what tells stacked targets apart. With colors off / no speaker the
  // line takes the app accent (mixed toward faint, as LangTag does); teal stays
  // reserved for the translating STAGE itself (progress card, frontier, pulse).
  const mtAccent =
    colorize && seg.speaker ? colorOf(seg.speaker) : "color-mix(in srgb, var(--c-accent) 65%, var(--c-faint))";
  const mtColor = `color-mix(in srgb, ${mtAccent} 30%, var(--c-faint))`;
  const visLangs = visLangsKey ? visLangsKey.split(",") : [];
  return (
    <div
      id={segRowId(i)}
      className={cn(
        // No opacity transition here on purpose: when a finished line flips
        // from karaoke (words already dimmed one by one) to the plain passed
        // branch, an animated 1 → 0.6 fade reads as a bright flash.
        "relative -mx-1.5 flex gap-3 rounded-lg px-1.5 py-0.5",
        isActive && "bg-accent-soft/40",
        isFrontier && "bg-[color:var(--c-translate)]/10",
        passed && "opacity-60",
        editMode && seg.edited && "border-l-2 border-ok/60 pl-2",
      )}
    >
      {showTs && (
        <button
          type="button"
          // No playable audio: the timestamp stays as a label, like the
          // line's own seek affordances below.
          title={canSeek ? "Jump here" : undefined}
          disabled={!canSeek}
          onClick={canSeek ? () => seekTo(seg.start) : undefined}
          className={cn(
            "ring-signal shrink-0 self-start pt-0.5 font-mono text-[12px] tabular-nums",
            canSeek && "cursor-pointer",
            isActive ? "text-accent" : cn("text-faint", canSeek && "hover:text-dim"),
          )}
        >
          {fmtTimestamp(seg.start)}
        </button>
      )}
      {showNames && seg.speaker && (
        <button
          type="button"
          title={editMode ? "Reassign this segment's speaker" : undefined}
          disabled={!editMode}
          onClick={() => onToggleReassign(i)}
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center gap-1.5 self-start rounded-pill py-0.5 pl-2 pr-2.5 text-[12px] font-medium",
            editMode && "ring-signal cursor-pointer",
          )}
          style={chipStyle(colorOf(seg.speaker))}
        >
          <span
            className="size-[7px] rounded-full"
            style={{ backgroundColor: colorOf(seg.speaker) }}
          />
          {displayName(seg.speaker)}
        </button>
      )}
      {editMode && reassignOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => onToggleReassign(i)} />
          <div className="absolute left-16 top-7 z-20 flex w-44 flex-col gap-0.5 rounded-xl border border-line-strong bg-surface p-1.5 shadow-xl">
            {speakers.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => onReassign(i, label)}
                className={cn(
                  "ring-signal flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px]",
                  label === seg.speaker && "bg-surface-2",
                )}
                style={{ color: colorOf(label) }}
              >
                <span
                  className="size-[7px] rounded-full"
                  style={{ backgroundColor: colorOf(label) }}
                />
                {displayName(label)}
                {label === seg.speaker ? " ✓" : ""}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="min-w-0 flex-1">
      {editMode ? (
        <span
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label={`Correct segment ${i + 1}`}
          key={`${recordKey}:${editRev}`}
          ref={editableRef}
          onInput={() => {
            dirtyRef.current = true;
          }}
          onBlur={(e) => {
            dirtyRef.current = false;
            const el = e.currentTarget;
            // innerText, not textContent: a pasted line break lands as <br> or a
            // <div>, which textContent drops — gluing the words on either side.
            const typed = el.innerText ?? el.textContent ?? "";
            const shown = onCommitEdit(i, typed);
            // Remount from props when the screen and the stored text disagree: React
            // never rewrites a contentEditable the user typed into, so an emptied line
            // (committed as "no edit") would stay blank while Copy and the exports keep
            // its text, and pasted markup would stay though only plain text is stored.
            // A bare blur (Alt-Tab mid-correction) keeps the span so the caret comes
            // back on refocus. The stored text is trimmed: a trailing space just typed
            // is no reason to remount.
            if (shown !== typed.trim() || el.childNodes.length > 1 || el.firstElementChild) setEditRev((r) => r + 1);
          }}
          onKeyDown={(e) => {
            // Mid-composition the IME owns Esc and Enter.
            if (imeComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              // Revert to the last SAVED text (seg.text = fileEdits[i] ?? server
              // text), not the raw server text: the blur commit compares to the
              // original and would delete an earlier saved correction. Cleaned
              // like the span's children below.
              e.currentTarget.textContent = stripControlChars(seg.text).trim();
              e.currentTarget.blur();
            }
          }}
          className="-mx-1 min-w-0 flex-1 whitespace-pre-wrap rounded px-1 outline-none focus:bg-surface-2/70"
          style={lineColor}
        >
          {/* Same cleaning (and order) as onCommitEdit's original, so a bare blur
              compares equal and keeps the span; raw bidi marks here would show the
              line in a different visual order than Read and the stored text. */}
          {stripControlChars(seg.text).trim()}
        </span>
      ) : karaoke ? (
        <span className="block min-w-0 whitespace-pre-wrap" style={lineColor}>
          {visLangs.length > 0 && <LangTag code={origLang} orig />}
          {words.slice(range[0], range[1]).map((w, k) => {
            const wi = range[0] + k;
            const current = wi === activeWordIdx;
            // Words behind the playhead dim to "spoken" — the line reads as a
            // continuous progress edge even if a very short word slips a frame.
            // Keyed off passedWordIdx (last FINISHED word), not activeWordIdx,
            // which drops to -1 in gaps and would flash the line bright.
            const passed = !current && wi <= passedWordIdx;
            return (
              <span
                key={wi}
                onClick={canSeek ? () => seekTo(w.start) : undefined}
                className={cn(
                  canSeek && "cursor-pointer",
                  current && "rounded bg-accent px-0.5 font-medium text-accent-ink",
                  passed && "opacity-60",
                )}
              >
                {stripControlChars(w.word)}
              </span>
            );
          })}
          {seg.edited && (
            <span className="ml-2 align-middle font-mono text-[10.5px] text-ok">· edited</span>
          )}
        </span>
      ) : origVisible ? (
        <span
          className="block min-w-0 whitespace-pre-wrap"
          style={lineColor}
          onClick={canSeek ? () => seekTo(seg.start) : undefined}
        >
          {visLangs.length > 0 && <LangTag code={origLang} orig />}
          {stripControlChars(seg.text).trim()}
          {seg.edited && (
            <span className="ml-2 align-middle font-mono text-[10.5px] text-ok">· edited</span>
          )}
        </span>
      ) : null}
      {visLangs.map((lang) => {
        // Own-property read: a language code like `valueOf` would otherwise
        // return an inherited function and `.trim()` would throw mid-render.
        const tr = ownProp(translations, lang);
        // Stripped BEFORE trimming (like the Edit span): whitespace inside a
        // leading/trailing bidi mark would otherwise survive as an indent and
        // an empty first word that shifts the follow-along highlight.
        const trText = stripControlChars(tr ?? "").trim();
        if (!trText) return null;
        // Tagged on the SANITIZED code, falling back like the original line's tag
        // (origLang): a code that strips to blank would draw an empty tag.
        const tag = langText(lang, 16).trim() || "??";
        // The quality guard kept the SOURCE text for this target: don't
        // present it as a translation — neutral faint line, flagged inline,
        // no follow-along (its "translation" is the original's words).
        if (translationsKept?.includes(lang)) {
          return (
            <span
              key={lang}
              className="block min-w-0 whitespace-pre-wrap text-faint"
              onClick={!origVisible && canSeek ? () => seekTo(seg.start) : undefined}
            >
              <LangTag code={tag} color="var(--c-faint)" />
              {trText}
              <span className="ml-2 align-middle font-mono text-[10.5px]">
                · kept original — re-translate in Edit
              </span>
            </span>
          );
        }
        // Follow-along on translated lines: MT text has no word timing, so
        // the original words' progress through the segment is mapped onto
        // the translated words proportionally — an honest approximation.
        const followable = isActive && !stale && range && range[1] > range[0];
        const trWords = followable ? trText.split(/\s+/) : null;
        let trCur = -1;
        let trPassed = -1;
        if (trWords && range) {
          const n = range[1] - range[0];
          // The playhead can make this row active while the active word is still
          // the previous segment's last (its end grace): that is not ours to follow.
          const cur = activeWordIdx >= range[0] && activeWordIdx < range[1];
          const pos = cur ? activeWordIdx - range[0] : passedWordIdx + 1 - range[0];
          const frac = Math.min(1, Math.max(0, pos / n));
          trCur = cur
            ? Math.min(trWords.length - 1, Math.floor(frac * trWords.length))
            : -1;
          // `frac * len` is a COUNT of translated words passed; the last passed index is
          // one less in both branches (at a segment's start that is -1, not word 0).
          trPassed = Math.min(trWords.length - 1, Math.floor(frac * trWords.length) - 1);
        }
        return (
          <span
            key={lang}
            className={cn(
              "block min-w-0 whitespace-pre-wrap text-[13px]",
              stale && "opacity-50",
            )}
            style={{ color: mtColor }}
            onClick={!origVisible && canSeek ? () => seekTo(seg.start) : undefined}
          >
            <LangTag code={tag} color={mtAccent} />
            {stale ? (
              <s>{trText}</s>
            ) : trWords ? (
              trWords.map((w, k) => (
                <span
                  key={k}
                  className={cn(
                    k === trCur && "rounded px-0.5 font-medium",
                    k !== trCur && k <= trPassed && "opacity-60",
                  )}
                  // Soft fill of the line's accent (chipStyle idiom): reads as the
                  // follow-along highlight in both themes.
                  style={
                    k === trCur
                      ? {
                          backgroundColor: `color-mix(in srgb, ${mtAccent} 22%, transparent)`,
                          color: mtAccent,
                        }
                      : undefined
                  }
                >
                  {w}
                  {k < trWords.length - 1 ? " " : ""}
                </span>
              ))
            ) : (
              trText
            )}
            {stale && (
              <span className="ml-2 align-middle font-mono text-[10.5px] not-italic text-warn">
                · stale — re-translate in Edit
              </span>
            )}
          </span>
        );
      })}
      {isFrontier && (
        <span className="block animate-pulse font-mono text-[10.5px] text-[color:var(--c-translate)]/80">
          translating…
        </span>
      )}
      </div>
    </div>
  );
});
