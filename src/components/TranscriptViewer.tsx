// The transcript workbench: player + karaoke follow, display toggles, speaker
// legend, corrections, export panel. Extracted from the Transcribe screen so
// (a) playback-time updates re-render only this subtree (the playhead ticks at
// display rate now, not at the webview's timeupdate cadence), (b) the same
// viewer renders in three shells — stacked card, studio pane, and the
// full-viewport focus mode (F / Esc) — without remounting, so audio, scroll
// and edit state survive every layout switch.

import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import {
  ArrowDownToLine, BookOpen, Check, Copy, Download, ExternalLink, Maximize2,
  Minimize2, Pause, Pencil, Play, X as XIcon,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApp } from "@/lib/store";
import { effectiveServerUrl } from "@/lib/backends";
import { acquireWarm, preloadPlanFor } from "@/lib/preload";
import { effectiveServerKind } from "@/lib/serverKind";
import { Button, LangTag, Segmented } from "@/components/ui";
import { fmtBytes, fmtDurationExact, fmtTimestamp, plural } from "@/lib/format";
import { lastStartedAt, seekKeyTarget } from "@/lib/seekKeys";
import {
  cancelTextTranslation, decodeMediaFile, getTranscribeProgress, openSourceUrl, readMediaFile, isTauri, translateText,
} from "@/lib/api";
import {
  beginChunk, foldPollFailure, foldTranslatePoll, newTranslateRun,
  runChunkedTranslate, translateOptsFrom, untranslatedIndexes, type TranslateRunUi,
} from "@/lib/retroTranslate";
import { transportErrorDoorway } from "@/lib/errors";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { TranslationOptionsFields } from "@/components/TranslationFields";
import {
  clearEdits, mergeSegmentTranslations, setRename, setSegmentEdit, setSegmentSpeaker,
  setSpeakerColor as setSpeakerColorAction, useTranscribeRun,
} from "@/lib/transcribeRun";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import {
  cueGrid, DEFAULT_SPEAKER_COLORS, prettySpeaker, speakerColorIndex, speakerName, speakerOrder,
} from "@/lib/transcriptExport";
import { applyTextEdits, segmentWordRanges } from "@/lib/wordAlign";
import { cn } from "@/lib/cn";
import { isSourceUrl } from "@/lib/urlSource";
import { isTextSourcePath } from "@/lib/subtitleImport";
import { basename, withTrackSites, type MediaChoice } from "@/lib/mediaExport";
import { releaseMedia } from "@/lib/media";
import { patchRecord, useRecord } from "@/lib/transcriptHistory";
import {
  defaultViewTracks, mergeOrder, readTrackPrefs, trackOrder, transcriptTracks, translationTracks, type TrackPrefs,
} from "@/lib/exportTracks";
import { ExportTrackChips } from "@/components/ExportTrackChips";
import { patchTranscribe, useDisplayToggles } from "@/lib/useDisplayToggles";
import { TranscriptExport } from "@/components/TranscriptExport";
import { SubtitleList } from "@/components/SubtitleList";
import { cueOptionsOf, limitsFor, limitsTitle, trText } from "@/lib/cueSplit";
import type { BatchResult, TranscriptWord } from "@/lib/types";
import { newProgressId } from "@/lib/ids";

/** Live retro-translate controls, keyed by record. MODULE scope on purpose:
 *  the chunk loop + its 1 s poller must keep running (and keep the store's
 *  card state fresh) while the viewer is unmounted, and a remounted viewer
 *  must find the same ctl to gate re-entry and serve Cancel. */
const trCtls = new Map<
  string,
  { pid: string; cancelled: boolean; serverUrl: string; backendId: string }
>();
const trDoneTimers = new Map<string, number>();

/** Best-effort MIME for the playback blob (helps WebKitGTK pick a decoder). */
function mediaMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg",
    oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
    wma: "audio/x-ms-wma", mp4: "video/mp4", mkv: "video/x-matroska",
    webm: "video/webm", mov: "video/quicktime",
  };
  return Object.prototype.hasOwnProperty.call(map, ext) ? map[ext] : "application/octet-stream";
}

/** How much of a returned transcript to lay out before the user asks for the rest.
 *
 *  The user picks the FILE; the server picks the RESPONSE — a small upload can be answered with a
 *  body up to the 32 MiB transport cap, and this card renders it wrapping, in one synchronous
 *  pass, with no error boundary to recover from a stalled renderer. A long transcript is also
 *  exactly what this screen is for, so this is a preview with an explicit "show the rest", not a
 *  truncation: `result.text` is untouched, and Copy still writes the FULL text. */
const TRANSCRIPT_PREVIEW_CHARS = 50_000;

/** Segment cap for the Timestamps/Speakers views — a HARD cap (each segment is a DOM row;
 *  an hour of speech is ~1-2k rows, fine; a hostile response could carry far more),
 *  disclosed in a footer line. Unlike the character preview it cannot be lifted: the
 *  un-capped render is exactly the stall it guards. Copy and exports carry everything. */
const MAX_SEGMENT_ROWS = 5_000;

/** The nearest ancestor that actually scrolls — the page scroller (`<main>`)
 *  around the stacked card; null where nothing above scrolls (studio, focus). */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll") return p;
    }
  }
  return null;
}

/** Chip styling from a speaker's CSS color (a --spk-N token, so it follows
 *  the light/dark theme): readable text, a soft fill, and a solid dot. */
function chipStyle(color: string) {
  return { color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` };
}

type EffSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  edited: boolean;
};

/** One transcript row, memoized: during playback only the row entering and the
 *  row leaving the playhead re-render — the other (up to 5000) rows bail on a
 *  shallow prop compare, which is what makes the frame-rate clock affordable. */
const SegmentRow = memo(function SegmentRow({
  seg, i, isActive, passed, activeWordIdx, passedWordIdx, range, words, showTs,
  showNames, colorize, editMode, reassignOpen, speakers, canSeek,
  translations, translationsKept, visLangsKey, origVisible, origLang, stale,
  isFrontier,
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
  colorOf: (label: string) => string;
  displayName: (label: string) => string;
  seekTo: (t: number) => void;
  onToggleReassign: (i: number) => void;
  onReassign: (i: number, label: string) => void;
  onCommitEdit: (i: number, text: string) => void;
}) {
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
      id={`seg-row-${i}`}
      className={cn(
        // No opacity transition here on purpose: when a finished line flips
        // from karaoke (words already dimmed one by one) to the plain passed
        // branch, an animated 1 → 0.6 fade reads as a bright flash.
        "relative -mx-1.5 flex gap-3 rounded-lg px-1.5 py-0.5",
        isActive && "bg-accent-soft/40",
        // Karaoke's frontier idiom in the translate accent: the first row the
        // in-flight chunk will fill next carries a soft teal wash.
        isFrontier && "bg-[color:var(--c-translate)]/10",
        passed && "opacity-60",
        editMode && seg.edited && "border-l-2 border-ok/60 pl-2",
      )}
    >
      {showTs && (
        <button
          type="button"
          title="Jump here"
          onClick={() => seekTo(seg.start)}
          className={cn(
            "ring-signal shrink-0 cursor-pointer self-start pt-0.5 font-mono text-[12px] tabular-nums",
            isActive ? "text-accent" : "text-faint hover:text-dim",
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
          onBlur={(e) => onCommitEdit(i, e.currentTarget.textContent ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              // Revert to the last SAVED text (seg.text = fileEdits[i] ?? server
              // text), not the raw server text: the blur commit compares to the
              // original and would delete an earlier saved correction.
              e.currentTarget.textContent = seg.text.trim();
              e.currentTarget.blur();
            }
          }}
          className="-mx-1 min-w-0 flex-1 whitespace-pre-wrap rounded px-1 outline-none focus:bg-surface-2/70"
          style={lineColor}
        >
          {seg.text.trim()}
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
                onClick={() => seekTo(w.start)}
                className={cn(
                  "cursor-pointer",
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
          {stripControlChars(seg.text.trim())}
          {seg.edited && (
            <span className="ml-2 align-middle font-mono text-[10.5px] text-ok">· edited</span>
          )}
        </span>
      ) : null}
      {visLangs.map((lang) => {
        const tr = translations?.[lang];
        if (!tr?.trim()) return null;
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
              <LangTag code={safeDisplayText(lang, 16)} color="var(--c-faint)" />
              {stripControlChars(tr.trim())}
              <span className="ml-2 align-middle font-mono text-[10.5px]">
                · kept original — re-translate in Edit
              </span>
            </span>
          );
        }
        // Follow-along on translated lines: MT text has no word timing, so
        // the original words' progress through the segment is mapped onto
        // the translated words proportionally — an honest approximation
        // (the same char-share philosophy the fluent redistributor uses).
        const followable = isActive && !stale && range && range[1] > range[0];
        const trWords = followable ? stripControlChars(tr.trim()).split(/\s+/) : null;
        let trCur = -1;
        let trPassed = -1;
        if (trWords && range) {
          const n = range[1] - range[0];
          const pos = activeWordIdx >= 0 ? activeWordIdx - range[0] : passedWordIdx + 1 - range[0];
          const frac = Math.min(1, Math.max(0, pos / n));
          trCur = activeWordIdx >= 0
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
            <LangTag code={safeDisplayText(lang, 16)} color={mtAccent} />
            {stale ? (
              <s>{stripControlChars(tr.trim())}</s>
            ) : trWords ? (
              trWords.map((w, k) => (
                <span
                  key={k}
                  className={cn(
                    k === trCur && "rounded px-0.5 font-medium",
                    k !== trCur && k <= trPassed && "opacity-60",
                  )}
                  // Soft speaker-accent fill (chipStyle idiom) — reads as the
                  // follow-along highlight in both themes without the shared
                  // teal block the MT lines used to carry.
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
              stripControlChars(tr.trim())
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

/** m:ss (h:mm:ss beyond an hour) for the progress card's running clock. */
function fmtRunClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  if (mm < 60) return `${mm}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Width of the amber model-phase lane in the stage bar, as a fraction —
 *  fixed so the teal translate segment always grows from the same origin. */
const MODEL_LANE = 0.15;

/** The retro-translate mini progress card ("Job Signals") — Processing-box
 *  design language: mono uppercase title, big amber %, Cancel pill, segmented
 *  stage bar (amber model phase → growing teal translate → hatched remainder),
 *  detail chips, and the live last-line readout. */
function TranslateProgressCard({
  run,
  modeLabel,
  onCancel,
}: {
  run: TranslateRunUi;
  /** The run's requested mode ("fluent"/"faithful") — a detail chip. */
  modeLabel?: string;
  onCancel: () => void;
}) {
  // Self-ticking clock: polls drive most re-renders, but between chunks (or
  // against a backend without the progress entry) nothing else updates.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const reconnecting = run.phase === "reconnecting";
  const done = run.phase === "done";
  const lane = run.modelPhaseSeen ? MODEL_LANE : 0;
  const amberW = lane * run.modelPct;
  const tealW = (1 - lane) * (done ? 1 : run.pct);
  const stageText =
    run.phase === "starting"
      ? "Starting…"
      : run.phase === "downloading"
        ? "Downloading model…"
        : run.phase === "loading"
          ? "Loading model…"
          : run.phase === "reconnecting"
            ? "Connection lost — the server may still be working; retrying…"
            : done
              ? "Done"
              : "Translating…";
  // Download receipt chips: fraction, size, and average transfer speed.
  const dlChips: string[] = [];
  if (run.phase === "downloading" && run.totalBytes) {
    const got = run.totalBytes * run.modelPct;
    dlChips.push(`${Math.round(run.modelPct * 100)}% of ${fmtBytes(run.totalBytes)}`);
    const secs = run.dlStartedAt ? (now - run.dlStartedAt) / 1000 : 0;
    if (secs >= 2 && got > 0) dlChips.push(`${fmtBytes(got / secs)}/s`);
  }
  const chips: string[] = [
    ...(run.model ? [safeDisplayText(run.model.split("/").pop() ?? "", 40)] : []),
    ...(run.device ? [safeDisplayText(run.device, 16)] : []),
    ...(modeLabel ? [modeLabel] : []),
    ...dlChips,
  ];
  return (
    <div
      role="status"
      className={cn(
        "mb-2.5 rounded-xl border p-3.5",
        reconnecting ? "border-warn/40 bg-warn/5" : "border-line bg-surface-2/60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">
          translate · {run.targets.join(", ")}
        </span>
        {!done && (
          <button
            type="button"
            onClick={onCancel}
            className="ring-signal inline-flex h-6 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11.5px] font-medium text-dim hover:text-text"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {reconnecting ? (
          <span className="font-mono text-[20px] font-medium text-warn">reconnecting…</span>
        ) : done ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[20px] font-medium text-ok">
            <Check className="size-5" /> done
          </span>
        ) : (
          <span className="font-mono text-[20px] font-medium tabular-nums text-warn">
            {Math.round(run.pct * 100)}%
          </span>
        )}
        <span className="text-[12px] text-dim">{stageText}</span>
        {run.target && !done && (
          <span className="rounded-pill border border-[color:var(--c-translate)]/40 px-1.5 font-mono text-[10px] uppercase text-[color:var(--c-translate)]">
            {safeDisplayText(run.target, 8)}
            {typeof run.targetProgress === "number" ? ` ${Math.round(run.targetProgress * 100)}%` : ""}
          </span>
        )}
        {run.step && !done && (
          <span className="font-mono text-[11px] text-faint">{safeDisplayText(run.step, 48)}</span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[11px] tabular-nums text-faint">
          {done ? "took" : "running"} {fmtRunClock(now - run.startedAt)}
        </span>
      </div>
      <div className={cn("mt-2.5 flex h-1.5 overflow-hidden rounded-pill", reconnecting && "opacity-50")}>
        {amberW > 0 && (
          <div className="bg-warn transition-all" style={{ width: `${amberW * 100}%` }} />
        )}
        <div
          className="bg-[color:var(--c-translate)] transition-all"
          style={{ width: `${tealW * 100}%` }}
        />
        {/* Hatched remainder — "known extent, not yet earned". */}
        <div
          className="flex-1 bg-surface-2 text-faint"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, currentColor 25%, transparent) 5px 7px)",
          }}
        />
      </div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c, i) => (
            <span
              key={i}
              className="rounded-pill border border-line bg-surface px-2 py-0.5 font-mono text-[10.5px] text-dim"
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {/* Server warnings (quality guard "kept original" etc.) — compact amber
          line; the flagged transcript lines carry the per-segment detail. */}
      {(run.warnings?.length ?? 0) > 0 && (
        <div className="mt-2 font-mono text-[11px] text-warn">
          {run.warnings!.length === 1
            ? safeDisplayText(run.warnings![0], 160)
            : `${run.warnings!.length} warnings — some segments kept the original`}
        </div>
      )}
      {run.lastText && !done && (
        <div className="mt-2 truncate font-mono text-[11px] text-[color:var(--c-translate)]/90">
          {safeDisplayText(run.lastText, 200)}
        </div>
      )}
    </div>
  );
}

export function TranscriptViewer({
  result: rawResult,
  path,
  mediaPath,
  fileLabel,
  createdAt,
  onClose,
  overlayKey,
  initialExport,
  fill,
  className,
}: {
  result: BatchResult;
  /** The transcribed file's path — keys the per-file overlays and playback. */
  path: string;
  /** App-managed audio copy, playback fallback when `path` is gone. */
  mediaPath?: string;
  /** Shown in the meta line when several files are on the workbench. */
  fileLabel?: string;
  /** When this transcript was made (ISO) — shown in the meta line so
   *  same-source records (the same URL run six times) are tellable apart. */
  createdAt?: string;
  /** Close the workbench (absent while a batch is running — the viewer is
   *  the run's live output then, not something to dismiss). */
  onClose?: () => void;
  /** Key for the per-transcript overlays (renames/colors/edits) — the
   *  record id when one exists. Falls back to `path`, but two same-URL
   *  records share their path, so id-keying keeps their edits apart. */
  overlayKey?: string;
  /** Open straight onto the export panel with this Media choice (History's
   *  "Save audio…/Save video…" hand-off). Consumed when it changes. */
  initialExport?: { media: MediaChoice };
  /** Studio pane: fill the available height instead of capping at 65vh. */
  fill?: boolean;
  className?: string;
}) {
  const settings = useApp((s) => s.settings);
  const renames = useTranscribeRun((s) => s.renames);
  const speakerColors = useTranscribeRun((s) => s.speakerColors);
  const edits = useTranscribeRun((s) => s.edits);
  const speakerEdits = useTranscribeRun((s) => s.speakerEdits);
  const translationsStaleAll = useTranscribeRun((s) => s.translationsStale);

  const [copied, setCopied] = useState(false);
  // Reset per file, so a new (possibly huge) transcript starts collapsed again.
  const [showFullText, setShowFullText] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Read · Edit · Export (D85): Edit corrects the transcript in place,
  // Export replaces the player and the list with the export panel.
  const [mode, setMode] = useState<"read" | "edit" | "export">("read");
  const editMode = mode === "edit";
  const reading = mode !== "export";
  useEffect(() => {
    if (initialExport) setMode("export");
  }, [initialExport]);
  // Display toggles — the view IS the export (shared with its Content box).
  const { showTs, showNames, colorize, setShowTs, setShowNames, setColorize } = useDisplayToggles();
  /** Subtitle length + translation timing: read from the saved settings
   *  (Standard unless changed), like History's quick export. */
  const cueOpts = useMemo(() => cueOptionsOf(settings.transcribe), [settings.transcribe]);
  // Read shows the transcript as Whisper's segments or as the subtitles an
  // SRT/VTT export writes; Edit always works on segments.
  const [view, setView] = useState<"segments" | "subtitles">("segments");
  // "Edit its segment": the segment row to scroll to once Edit has rendered.
  const [jumpSeg, setJumpSeg] = useState<number | null>(null);
  // Visible tracks ("orig", target codes, site track ids). Empty/absent =
  // the default pick (defaultViewTracks). LOCAL view state (like layout) —
  // persisted but never synced.
  const [viewTracks, setViewTracks] = useState<string[]>(
    () => settings.transcribe?.viewTracks ?? [],
  );
  const [reassignRow, setReassignRow] = useState<number | null>(null);
  // Full-viewport reading mode (F toggles, Esc exits). The component doesn't
  // remount on the way in or out, so playback, scroll and edits carry over.
  const [focus, setFocus] = useState(false);
  // Entering focus lifts the card out of the page flow (fixed inset-0): the
  // page scroller collapses and the browser CLAMPS its scrollTop toward 0,
  // so exiting used to land on the config instead of back on the transcript.
  // Capture the position at toggle time (before React commits the fixed
  // class — afterwards it's already clamped) and restore it on the way out.
  const preFocusScroll = useRef<{ el: HTMLElement; top: number } | null>(null);
  const toggleFocus = useCallback(() => {
    setFocus((v) => {
      if (!v) {
        const p = scrollParentOf(toolbarRef.current);
        preFocusScroll.current = p ? { el: p, top: p.scrollTop } : null;
      }
      return !v;
    });
  }, []);
  useEffect(() => {
    if (focus) return;
    const saved = preFocusScroll.current;
    if (!saved) return;
    preFocusScroll.current = null;
    // After the exit render the card is back in flow — restore next frame,
    // once the scroller has its full height again.
    const raf = requestAnimationFrame(() => {
      saved.el.scrollTop = saved.top;
    });
    return () => cancelAnimationFrame(raf);
  }, [focus]);
  // Built-in playback with karaoke follow.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The <audio>'s ref: keeps audioRef (playhead loop, watchdog, seek) and
  // empties the element when React lets go of it — the key change (blob →
  // WAV → path), audioBroken and unmount all detach it, and a detached
  // element otherwise keeps its decoded source alive. Stable on purpose: an
  // inline arrow would detach and re-attach (and so release) every render.
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    if (!el) return;
    return () => {
      if (audioRef.current === el) audioRef.current = null;
      releaseMedia(el);
    };
  }, []);
  const [playing, setPlaying] = useState(false);
  // Coarse playhead for the readout + scrubber (~4 Hz is plenty for a time
  // label); the word/segment highlight advances at frame rate via the rAF
  // loop below, so they are separate state.
  const [curTime, setCurTime] = useState(0);
  const [activeSegIdx, setActiveSegIdx] = useState(-1);
  const [activeWordIdx, setActiveWordIdx] = useState(-1);
  /** Last word whose END is behind the playhead. Separate from activeWordIdx
   *  on purpose: the active word goes to -1 in gaps (end-of-line, pauses), and
   *  if dimming keyed off it the just-spoken words would flash back to full
   *  brightness before the row-level dim catches up. */
  const [passedWordIdx, setPassedWordIdx] = useState(-1);
  /** Last segment fully behind the playhead — everything up to it reads as
   *  already spoken (dimmed), so the reading position survives across lines. */
  const [passedSegIdx, setPassedSegIdx] = useState(-1);
  const [audioLen, setAudioLen] = useState(0);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  /** The segment list's own scroll container — follow scrolls THIS, not the
   *  page, so the toolbar/player above stay put while the karaoke advances. */
  const transcriptBoxRef = useRef<HTMLDivElement | null>(null);
  /** The toolbar above the list — sticky in the stacked card, where it can
   *  overlap the box's top once the page scrolls. Measured by the padding
   *  compensation (keeps the rows reachable under the overlap) and by
   *  follow's visible-strip math. */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [audioBroken, setAudioBroken] = useState(false);
  // Why playback is unavailable — a missing file and an undecodable codec are
  // different failures and get different sentences.
  const [brokenWhy, setBrokenWhy] = useState<"gone" | "codec">("codec");
  // The technical reason playback broke — shown small under the notice so a
  // failure is diagnosable instead of blamed on a guessed cause.
  const [brokenDetail, setBrokenDetail] = useState<string | null>(null);
  // Set when playback fell back to the app's stored audio copy.
  const [audioNote, setAudioNote] = useState<"copy" | null>(null);
  // Blob-URL fallback when the asset protocol can't feed the media stack
  // (Linux WebKitGTK). Revoked on file change/unmount.
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const blobTriedRef = useRef(false);
  const wavTriedRef = useRef(false);
  // A symphonia decode is in flight — the stall watchdog must not advance
  // the chain past it (a long file legitimately takes seconds to decode).
  const decodePendingRef = useRef(false);
  // Mirrors decodePendingRef for the readMediaFile buffer stage — same hazard:
  // the watchdog must not re-enter onAudioError while a buffer read is in flight.
  const bufferPendingRef = useRef(false);
  // Generation counter for the audio fallback chain: bumped on every record switch
  // (path/mediaPath change) so an in-flight readMediaFile/decodeMediaFile from the
  // OLD record does not land its result on the NEW record's player.
  const audioGenRef = useRef(0);
  // The "Copied" confirmation timer. Held in a ref so a rapid second Copy click clears the first
  // timer before re-arming — otherwise the stale timer fires mid-window and flips the label off
  // early (every other transient timer in the app is cleared the same way).
  const copyTimer = useRef<number | undefined>(undefined);

  const persistOptions = patchTranscribe;

  // ── selected-result derivations ──────────────────────────────────────────
  // Site tracks of older records name their site from the link.
  const extractor = useTranscribeRun((s) => s.urlMeta[path]?.extractor);
  const result = useMemo(() => withTrackSites(rawResult, path, extractor), [rawResult, path, extractor]);
  const speakers = useMemo(() => speakerOrder(result), [result]);
  const hasSegments = !!result.segments?.length;
  const hasSpeakers = speakers.length > 0;
  // Overlay slot: the record id when known, else the path (see overlayKey).
  const okey = overlayKey ?? path;
  const fileRenames = useMemo(() => renames[okey] ?? {}, [renames, okey]);
  const fileColors = useMemo(() => speakerColors[okey] ?? {}, [speakerColors, okey]);
  const displayName = useCallback(
    (label: string) => safeDisplayText(speakerName(fileRenames, label)),
    [fileRenames],
  );
  // User-picked palette index first, else first-appearance order — the chips
  // (via theme tokens) and the exported SRT/VTT (via hexes) resolve through
  // the SAME shared resolver, so they can't disagree again.
  const colorIdxOf = useCallback(
    (label: string) => speakerColorIndex(speakers, fileColors, label),
    [fileColors, speakers],
  );
  const colorOf = useCallback(
    (label: string) => `var(--spk-${colorIdxOf(label) + 1})`,
    [colorIdxOf],
  );

  const setSpeakerColor = (label: string, idx: number) => {
    setSpeakerColorAction(okey, label, idx);
  };

  const commitRename = () => {
    if (editingSpeaker) {
      setRename(okey, editingSpeaker, stripControlChars(renameDraft).trim());
    }
    setEditingSpeaker(null);
  };

  // Corrections layered over the server transcript — the segments every
  // surface renders, copies and exports.
  const fileEdits = useMemo(() => edits[okey] ?? {}, [edits, okey]);
  const fileSpkEdits = useMemo(() => speakerEdits[okey] ?? {}, [speakerEdits, okey]);
  const fileStale = useMemo(() => translationsStaleAll[okey] ?? {}, [translationsStaleAll, okey]);
  // Kept-original segments (server quality guard) join the stale ones in the
  // Edit banner's re-translate set — `translationsStale` itself is untouched.
  const keptIdxs = useMemo(
    () => (result.segments ?? []).flatMap((s, i) => (s.translationsKept?.length ? [i] : [])),
    [result],
  );
  const flaggedIdxs = useMemo(
    () =>
      Array.from(new Set([...Object.keys(fileStale).map(Number), ...keptIdxs])).sort(
        (a, b) => a - b,
      ),
    [fileStale, keptIdxs],
  );
  const editCount = Object.keys(fileEdits).length + Object.keys(fileSpkEdits).length;
  // Translated tracks present on this result, in target order.
  const langs = useMemo(() => translationTracks(result), [result]);
  const untranslatedIdxs = useMemo(() => untranslatedIndexes(result.segments, langs), [result, langs]);
  const effSegments = useMemo(
    (): EffSegment[] =>
      (result.segments ?? []).map((seg, i) => ({
        ...seg,
        text: fileEdits[i] ?? seg.text,
        speaker: fileSpkEdits[i] ?? seg.speaker,
        // Drives the "edited" row markers — a speaker reassignment counts too.
        // (Karaoke is unaffected by either kind: SegmentRow reads `effWords`,
        // which is re-aligned for text edits, so no separate text-edit flag.)
        edited: fileEdits[i] !== undefined || fileSpkEdits[i] !== undefined,
      })),
    [result, fileEdits, fileSpkEdits],
  );

  // The flat word list with text-edited segments re-aligned (matched words
  // keep their timings; corrections inherit the replaced span) — karaoke and
  // word-level exports both read THIS, so they always agree with the text.
  const effWords = useMemo(() => applyTextEdits(result, fileEdits), [result, fileEdits]);
  // Word index ranges per segment (karaoke + word-level exports).
  const segWordRanges = useMemo(
    () => segmentWordRanges(result.segments ?? [], effWords),
    [result, effWords],
  );

  /** The result with corrections applied — what Save writes. An edited
   *  segment's words are substituted with their aligned equivalents, so
   *  JSON/LRC keep word timing through corrections. */
  const editedResult = useMemo((): BatchResult => {
    if (!editCount) return result;
    const segs = effSegments.map(({ edited: _e, ...seg }) => seg);
    return {
      ...result,
      text: segs.map((seg) => seg.text.trim()).join(" "),
      segments: segs,
      words: effWords,
    };
    // Memoized: the export panel's contract + preview read it from JSX, and
    // the component re-renders at playhead cadence while audio plays.
  }, [editCount, result, effSegments, effWords]);

  // ── tracks (the Subtitles view's lanes; the lines each segment row renders) ──
  // The dragged track order and typed track names (D92/D89) live on the
  // transcript's record — without one (not saved yet) here. Read's chips and
  // the export share them, so lanes, chips and files keep one order.
  const [localTrackPrefs, setLocalTrackPrefs] = useState<TrackPrefs>({});
  // The overlay slot's record (okey is the record id whenever there is one).
  const record = useRecord(okey);
  const recId = overlayKey && record ? overlayKey : null;
  const savedTrackPrefs = recId ? record?.exportTracks : undefined;
  const trackPrefs = useMemo(
    () => (recId ? readTrackPrefs(savedTrackPrefs) : localTrackPrefs),
    [recId, savedTrackPrefs, localTrackPrefs],
  );
  const setTrackPrefs = useCallback((patch: TrackPrefs) => {
    if (recId) patchRecord(recId, (r) => ({ ...r, exportTracks: { ...readTrackPrefs(r.exportTracks), ...patch } }));
    else setLocalTrackPrefs((p) => ({ ...p, ...patch }));
  }, [recId]);
  useEffect(() => setLocalTrackPrefs((p) => (Object.keys(p).length ? {} : p)), [overlayKey, path]);
  const timedIds = useMemo(() => (result.timedTracks ?? []).map((t) => t.id), [result.timedTracks]);
  const allTracks = useMemo(() => transcriptTracks(result), [result]);
  const trackOrd = useMemo(() => trackOrder(result, allTracks, trackPrefs.order), [result, allTracks, trackPrefs.order]);
  const visibleTracks = useMemo(() => {
    const pick = trackOrd.filter((t) => viewTracks.includes(t));
    return pick.length ? pick : defaultViewTracks(result, trackOrd); // never zero tracks
  }, [result, trackOrd, viewTracks]);
  // The Segments view has no lane for a site track's own cues: its chips and
  // rows leave them out (the original stands in when only those are picked).
  const segOrder = useMemo(() => trackOrd.filter((t) => !timedIds.includes(t)), [trackOrd, timedIds]);
  const segVisible = useMemo(() => {
    const v = visibleTracks.filter((t) => !timedIds.includes(t));
    return v.length ? v : ["orig"];
  }, [visibleTracks, timedIds]);
  // Editing needs the original on screen — Edit mode forces it visible.
  const origVisible = segVisible.includes("orig") || editMode;
  const visLangs = useMemo(() => segVisible.filter((t) => t !== "orig"), [segVisible]);
  const visLangsKey = visLangs.join(","); // stable string for the row memo

  // ── Subtitles view ───────────────────────────────────────────────────────
  const subtitlesView = view === "subtitles" && !editMode && hasSegments;
  /** The export's cues — memoized on edits, options and tracks, never on the
   *  playhead (the list picks its active cue by binary search). */
  const subGrid = useMemo(
    () => (subtitlesView
      ? cueGrid(editedResult, { format: "srt", cues: cueOpts, renames: fileRenames, speakerNames: showNames }, visibleTracks)
      : null),
    [subtitlesView, editedResult, cueOpts, fileRenames, showNames, visibleTracks],
  );
  const onEditSegment = useCallback((seg: number) => {
    setMode("edit");
    setJumpSeg(seg);
  }, []);
  useEffect(() => {
    if (jumpSeg === null || !editMode) return;
    const row = transcriptBoxRef.current?.querySelector<HTMLElement>(`#seg-row-${jumpSeg}`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLElement>("[contenteditable]")?.focus();
    setJumpSeg(null);
  }, [jumpSeg, editMode]);
  /** A pick from Read's chips (they never offer an empty one). The Segments
   *  view's chips don't show the site tracks — those stay as they were. */
  const pickTracks = (next: string[]) => {
    const all = subtitlesView ? next : [...next, ...visibleTracks.filter((t) => timedIds.includes(t))];
    const picked = trackOrd.filter((t) => all.includes(t));
    setViewTracks(picked);
    persistOptions({ viewTracks: picked });
  };

  // ── re-translate / retro-translate ───────────────────────────────────────
  const backends = useApp((s) => s.backends);
  const historyBackendId = record?.backendId;
  // Retro-translate needs a full backend — a PROVEN-standard server has no
  // /v1/text/translations, so don't offer a button that can only fail.
  const connections = useApp((s) => s.connections);
  const trBackend = useMemo(
    () => backends.find((b) => b.id === historyBackendId) ?? backends[0],
    [backends, historyBackendId],
  );
  const trServerKind = trBackend
    ? effectiveServerKind(trBackend, connections[trBackend.id])
    : "unknown";
  // The record's backend's capabilities gate the panel's model/language
  // lists (and, when known, translation availability itself). Best-effort:
  // null caps = unknown ⇒ the defaults chain still works.
  const { caps: trCaps } = useOverrideContext({
    serverUrl: trBackend ? effectiveServerUrl(trBackend, settings) : "",
    backendId: trBackend?.id,
    serverKind: trServerKind,
  });
  const retroTranslateAvailable =
    !!trBackend &&
    trServerKind !== "standard" &&
    // Only an explicit false hides it once caps are known — absent field
    // (older backend) keeps the old kind-only behavior.
    trCaps?.translation_enabled !== false;
  // ── translate options panel (Export-panel idiom) ─────────────────────────
  const [showTranslate, setShowTranslate] = useState(false);
  // null = not touched yet → prefill from the defaults chain below.
  const [trTargets, setTrTargets] = useState<string[] | null>(null);
  const [trMode, setTrMode] = useState<"fluent" | "faithful">(
    () => trBackend?.translationOverrides?.mode ?? "fluent",
  );
  const [trModel, setTrModel] = useState(() => trBackend?.translationOverrides?.model ?? "");
  // Prefill: Backend Translation defaults → the caller's server-side default
  // → English; never the known source (a source→source track is a no-op).
  const seededTargets = useMemo(() => {
    const src = result.language;
    const seed = (
      trBackend?.translationOverrides?.translateTo?.length
        ? trBackend.translationOverrides.translateTo
        : trCaps?.translate_to_default?.length
          ? trCaps.translate_to_default
          : ["en"]
    ).filter((c) => c !== src);
    return seed.length ? seed : [src === "en" ? "de" : "en"];
  }, [trBackend, trCaps, result.language]);
  const effTargets = trTargets ?? seededTargets;

  // Warm the translation model while the panel is open, so the run doesn't start
  // with a cold load. Released on close and on unmount — the panel also closes
  // itself on a successful start, which drops the lease exactly when the run
  // takes over keeping the model hot.
  useEffect(() => {
    if (!showTranslate || !trBackend || !retroTranslateAvailable) return;
    const plan = preloadPlanFor({
      stages: ["translating"],
      translationModel: trModel || trBackend.translationOverrides?.model,
    });
    if (!plan.length) return;
    const lease = acquireWarm("viewer-translate", {
      serverUrl: effectiveServerUrl(trBackend, settings),
      backendId: trBackend.id,
      models: plan,
    });
    return () => lease.release();
  }, [showTranslate, trBackend, retroTranslateAvailable, trModel, settings]);

  // ── chunked run + mini progress card state ──────────────────────────────
  // Held in the app store keyed by record: the run loop, its poller, and the
  // card state all outlive this component, so navigating away and back
  // re-attaches to the live card instead of losing it (the run itself was
  // never lost — only its UI was).
  // The key a LIVE run is found under. Runs start under okey, but okey moves
  // when openRecordId swaps/nulls while the same transcript stays on screen
  // (same-URL records) — a run started under the path key (no record id yet)
  // must stay visible after the id lands, so fall back to the path slot.
  const trRunsAll = useApp((s) => s.trRuns);
  const trKey = trRunsAll[okey] ? okey : path && trRunsAll[path] ? path : okey;
  const trEntry = trRunsAll[trKey];
  const trRun = trEntry?.run ?? null;
  const trRunMode = trEntry?.mode;
  const setTrRun = useCallback(
    (
      v:
        | TranslateRunUi
        | null
        | ((s: TranslateRunUi | null) => TranslateRunUi | null),
      mode?: "fluent" | "faithful",
    ) => {
      const st = useApp.getState();
      st.setTrRun(
        okey,
        typeof v === "function" ? v(st.trRuns[okey]?.run ?? null) : v,
        mode,
      );
    },
    [okey],
  );
  // Re-entry gate that survives remounts: a ctl exists ⇔ the loop is live.
  const translating = trCtls.has(trKey) && trRun != null;

  /** Translate the given segment indexes into `targets` in `TRANSLATE_CHUNK`-segment
   *  chunks, merging each chunk back into the record as it lands (track
   *  chips appear on the first merge). Uses the record's backend (else the
   *  first); explicit `opts` (the panel's picks) override its stored
   *  translation defaults. */
  const runTranslate = async (
    indexes: number[],
    targets: string[],
    opts?: { mode?: "fluent" | "faithful"; model?: string },
  ) => {
    // Guard BOTH keys: a live run may sit under the path fallback slot.
    if (!indexes.length || !targets.length || trCtls.has(okey) || trCtls.has(trKey)) return;
    const backend = trBackend;
    if (!backend) return;
    const serverUrl = effectiveServerUrl(backend, useApp.getState().settings);
    const trOv = backend.translationOverrides;
    const mode = opts?.mode ?? trOv?.mode;
    const pid = newProgressId();
    const ctl = { pid, cancelled: false, serverUrl, backendId: backend.id };
    trCtls.set(okey, ctl);
    window.clearTimeout(trDoneTimers.get(okey));
    trDoneTimers.delete(okey);
    setTrRun(
      // Name the run so global surfaces (sidebar badge, other-runs strip)
      // can identify it while its transcript is off screen.
      { ...newTranslateRun(indexes.length, targets), title: fileLabel ?? basename(path) },
      mode,
    );
    // 1 s poll drives the card. Best-effort split: an HTTP error (older
    // backend without the shared progress entry) leaves the card in its
    // current state; a NETWORK failure flips it to "reconnecting" — the
    // chunk request itself is still in flight on its own long timeout.
    const pollTimer = window.setInterval(() => {
      getTranscribeProgress({ serverUrl, backendId: backend.id, progressId: pid })
        .then((p) => {
          if (trCtls.get(okey) === ctl) setTrRun((s) => (s ? foldTranslatePoll(s, p) : s));
        })
        .catch((e) => {
          if (trCtls.get(okey) !== ctl) return;
          if (!String(e).startsWith("HTTP")) setTrRun((s) => (s ? foldPollFailure(s) : s));
        });
    }, 1000);
    try {
      await runChunkedTranslate({
        indexes,
        // Read the store, not the render closure: the chunk loop outlives this render and a
        // correction made mid-run must be translated as it is NOW (the merge clears its stale mark).
        textOf: (i) => (useTranscribeRun.getState().edits[okey]?.[i] ?? result.segments?.[i]?.text ?? "").trim(),
        translate: (texts) =>
          translateText({
            serverUrl,
            backendId: backend.id,
            texts,
            targets,
            source: result.language ?? null,
            model: (opts?.model ?? trOv?.model) || null,
            mode: mode ?? null,
            glossary: trOv?.glossary ?? null,
            contextSegments: trOv?.contextSegments ?? null,
            progressId: pid,
          }),
        onChunkStart: (chunkIdxs, done) =>
          setTrRun((s) => (s ? beginChunk(s, chunkIdxs, done) : s)),
        onMerge: (patch, prov, _first, kept) => {
          mergeSegmentTranslations(
            okey,
            patch,
            {
              model: prov.model,
              targets,
              source: prov.source ?? result.language,
              mode,
            },
            kept,
          );
        },
        // Quality-guard notices accumulate on the card ("N kept original").
        onWarnings: (all) => setTrRun((s) => (s ? { ...s, warnings: all } : s)),
        isCancelled: () => ctl.cancelled,
      });
      if (!ctl.cancelled) {
        setShowTranslate(false);
        setTrRun((s) =>
          s ? { ...s, phase: "done", pct: 1, done: s.total, frontierIdx: -1 } : s,
        );
        // Brief success receipt, then the card folds away — module timer, so
        // the store entry is cleaned even if the viewer is unmounted by then.
        trDoneTimers.set(
          okey,
          window.setTimeout(() => {
            trDoneTimers.delete(okey);
            useApp.getState().setTrRun(okey, null);
          }, 4000),
        );
      } else {
        setTrRun(null);
      }
    } catch (e) {
      // The transport already tracing::warn!s the classified cause; keep the
      // full message in the webview console too before the toast condenses it.
      console.error("re-translate failed:", e);
      setTrRun(null);
      if (!ctl.cancelled) {
        useApp.getState().setLogsDoorway(transportErrorDoorway("translate", e, backend.name));
      }
    } finally {
      window.clearInterval(pollTimer);
      if (trCtls.get(okey) === ctl) trCtls.delete(okey);
    }
  };

  /** Cancel = server-side abort by progress id + stop the chunk loop. The
   *  in-flight chunk's results are lost; completed chunks stay merged.
   *
   *  This is the ONLY thing that cancels a retro-translate run, and that is
   *  deliberate: unmounting this component must NOT. The run, its poller and
   *  its card state all live in the app store keyed by record (see the chunked
   *  run block above) precisely so navigating away and back re-attaches to the
   *  live card — cancelling on unmount would kill a long translate every time
   *  the user looked at another screen. A future "cancel everything on
   *  teardown" audit must leave this one alone. */
  const cancelTranslate = () => {
    const ctl = trCtls.get(trKey);
    if (!ctl || ctl.cancelled) return;
    ctl.cancelled = true;
    void cancelTextTranslation({
      serverUrl: ctl.serverUrl,
      backendId: ctl.backendId,
      progressId: ctl.pid,
    }).catch(() => {});
  };

  const copyText = (): string => {
    if (!effSegments.length) return result.text;
    return effSegments
      .map((seg, i) => {
        const ts = showTs ? `[${fmtTimestamp(seg.start)}] ` : "";
        const who = showNames && seg.speaker ? `${displayName(seg.speaker)}: ` : "";
        const lines: string[] = [];
        if (origVisible) lines.push(`${ts}${who}${seg.text.trim()}`);
        for (const lang of visLangs) {
          const src = result.segments?.[i];
          // trText skips a track the server's quality guard kept as the
          // ORIGINAL — pasting the source language under a translation's
          // label is worse than omitting it.
          const tr = src && trText(src, lang);
          if (!tr) continue;
          // Tag only when the clipboard would otherwise be ambiguous: with
          // two targets an untagged line says nothing about which language it
          // is, and `lang` was in scope here all along and simply unused.
          const tag = visLangs.length > 1 ? `[${lang.toUpperCase()}] ` : "";
          lines.push(`${origVisible ? "  " : ts}${tag}${who}${tr}`);
        }
        return lines.join("\n");
      })
      .filter(Boolean)
      .join("\n");
  };

  // ── playback + karaoke follow ────────────────────────────────────────────
  // The picked file plays straight from disk via the asset protocol. A URL
  // run has no local original — `path` IS the link — so playback comes from
  // the app's fetched copy (mediaPath), and with no copy there is simply no
  // <audio> (never convertFileSrc on a URL: that mints a guaranteed-broken
  // asset URL and a guaranteed error event).
  const urlSource = isSourceUrl(path);
  // Subtitle/text sources have no audio, ever — no player, no karaoke, and
  // none of the "audio missing" notices (nothing is missing).
  const textSource = isTextSourcePath(path);
  // "29 Aug 18:03" — the viewer's identity stamp (same-URL records are
  // otherwise indistinguishable).
  const stamp = useMemo(() => {
    if (!createdAt) return "";
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [createdAt]);
  const audioSrc = useMemo(() => {
    if (!isTauri || textSource) return undefined;
    if (urlSource) return mediaPath ? convertFileSrc(mediaPath) : undefined;
    return convertFileSrc(path);
  }, [path, mediaPath, urlSource, textSource]);

  // What the playhead loop reads each frame — a ref, so the loop never
  // re-subscribes and never closes over stale data.
  const dataRef = useRef<{ segs: BatchResult["segments"]; words: TranscriptWord[] }>({
    segs: [],
    words: [],
  });
  dataRef.current = { segs: result.segments ?? [], words: effWords };
  const shownTimeRef = useRef(0);

  /** Fold one playhead sample into state. Word/segment indices update whenever
   *  they change (React bails out on same-value sets); the visible clock only
   *  moves in ~quarter-second steps so the readout doesn't churn at 60 Hz. */
  const syncPlayhead = useCallback((t: number, force = false) => {
    const segs = dataRef.current.segs ?? [];
    const words = dataRef.current.words;
    // Last segment already started; from it, the active one (inside its window
    // + grace) and the read position (last segment fully behind the playhead —
    // rows up to it render dimmed as "spoken").
    const li = lastStartedAt(segs, t);
    setActiveSegIdx(li >= 0 && t < segs[li].end + 0.3 ? li : -1);
    setPassedSegIdx(li >= 0 ? (t >= segs[li].end ? li : li - 1) : -1);
    const best = lastStartedAt(words, t);
    setActiveWordIdx(best >= 0 && t < (words[best].end ?? 0) + 0.4 ? best : -1);
    setPassedWordIdx(best >= 0 && t >= (words[best].end ?? 0) ? best : best - 1);
    if (force || Math.abs(t - shownTimeRef.current) >= 0.24) {
      shownTimeRef.current = t;
      setCurTime(t);
    }
  }, []);

  // The highlight clock: while playing, sample audio.currentTime every frame.
  // The <audio> timeupdate event alone ticks every 250-500 ms on WebKitGTK —
  // words shorter than a tick were never highlighted at all (the search picks
  // the LAST word started before the sample, so anything between two ticks was
  // structurally unreachable, twice as often at 2×). timeupdate stays wired
  // below purely as the paused/seek fallback.
  useEffect(() => {
    if (!playing) return;
    let id = requestAnimationFrame(function step() {
      const a = audioRef.current;
      if (a) syncPlayhead(a.currentTime);
      id = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(id);
  }, [playing, syncPlayhead]);

  useEffect(() => {
    // New file: stop playback, forget position/errors, re-arm follow.
    setPlaying(false);
    shownTimeRef.current = 0;
    setCurTime(0);
    setActiveSegIdx(-1);
    setActiveWordIdx(-1);
    setPassedWordIdx(-1);
    setPassedSegIdx(-1);
    setAudioLen(0);
    setAudioBroken(false);
    setBrokenWhy("codec");
    setBrokenDetail(null);
    setAudioNote(null);
    setFollow(true);
    setMode((m) => (m === "edit" ? "read" : m));
    setReassignRow(null);
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = null;
    blobTriedRef.current = false;
    wavTriedRef.current = false;
    decodePendingRef.current = false;
    bufferPendingRef.current = false;
    audioGenRef.current += 1;
    setBlobSrc(null);
    // mediaPath, not just path: two same-URL records share a path but each holds its OWN
    // copy (keyed on the record id), so a record switch that changes only mediaPath must
    // still clear the previous record's broken/blob/fallback state.
  }, [path, mediaPath]);
  useEffect(
    () => () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    },
    [],
  );

  // A newly selected (possibly huge) transcript starts collapsed again.
  // Keyed on record identity, not `result`: every retro-translate chunk merge
  // hands in a fresh result object.
  useEffect(() => {
    setShowFullText(false);
    // An open rename editor belongs to the previous record: its blur would commit A's draft onto B's speaker.
    setEditingSpeaker(null);
    setRenameDraft("");
  }, [path, okey]);

  // Translate-panel state belongs to the PREVIOUS record's backend — a record
  // switch must re-seed it from the new record's backend defaults, or B's
  // panel sends A's mode/model/targets (including B's own source language,
  // which the seed exists to exclude).
  useEffect(() => {
    setShowTranslate(false);
    setTrTargets(null);
    setTrMode(trBackend?.translationOverrides?.mode ?? "fluent");
    setTrModel(trBackend?.translationOverrides?.model ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on record/backend switch only
  }, [path, okey, trBackend?.id]);

  /** The <audio> errored on the asset URL — resolve through the fallback
   *  chain ONCE per step: (1) buffer the original bytes through Rust (asset
   *  protocol quirks); if the original is gone, the app's stored copy; (2) a
   *  second error with the blob already loaded means the webview can't
   *  decode this CODEC (Linux WebKitGTK has no AAC/MP4 without proprietary
   *  GStreamer plugins — every retained YouTube audio) — decode to WAV in
   *  Rust and play that; (3) only when the WAV blob errors too is playback
   *  declared broken. */
  /** `read_media_file`'s over-cap refusal (its exact wording is `MEDIA_TOO_LARGE` in Rust). */
  const isTooLargeToBuffer = (e: unknown) => String(e).includes("too large to buffer");
  const onAudioError = (reason?: string) => {
    // Capture the current generation so async callbacks from a previous record
    // (still in flight after a record switch) are silently discarded.
    const gen = audioGenRef.current;
    const stale = () => gen !== audioGenRef.current;

    if (blobTriedRef.current) {
      if (wavTriedRef.current) {
        setAudioBroken(true);
        setBrokenWhy("codec");
        setBrokenDetail(`decoded WAV failed too — ${reason || "media element error"}`);
        return;
      }
      wavTriedRef.current = true;
      const fail = (why: "gone" | "codec" = "codec", detail?: string) => {
        if (stale()) return;
        setAudioBroken(true);
        setBrokenWhy(why);
        if (detail) setBrokenDetail(detail);
      };
      // Decode lands in a cached WAV file played through the asset
      // protocol — streaming from disk like every dictation, instead of a
      // ~240 MB in-memory blob (which freezes the WebKitGTK web process).
      const tryDecode = (
        p: string | null | undefined,
        next?: (why: "gone" | "codec", detail: string) => void,
        prior?: { why: "gone" | "codec"; detail: string },
      ) => {
        if (!p) {
          decodePendingRef.current = false;
          return next
            ? next(prior?.why ?? "codec", prior?.detail ?? "no media path to decode")
            : fail(prior?.why ?? "codec", prior?.detail);
        }
        decodePendingRef.current = true;
        decodeMediaFile(p)
          .then((wavPath) => {
            decodePendingRef.current = false;
            if (stale()) return;
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
            setBlobSrc(convertFileSrc(wavPath));
          })
          .catch((e) => {
            if (stale()) { decodePendingRef.current = false; return; }
            decodePendingRef.current = false;
            const why = String(e).includes("gone") ? "gone" : "codec";
            const detail = `decode failed: ${String(e)}`;
            if (next) return next(why, detail);
            fail(why, detail);
          });
      };
      if (urlSource) tryDecode(mediaPath);
      // Stage 1 already learned the original is unreadable when it fell through to the
      // stored copy — don't pay a second round trip into a path known to be gone (and
      // let ITS failure decide the "gone"-vs-"codec" wording).
      else if (audioNote === "copy" && mediaPath) tryDecode(mediaPath);
      else tryDecode(path, (why, detail) => tryDecode(mediaPath, undefined, { why, detail }));
      return;
    }
    blobTriedRef.current = true;
    const asBlob = (buf: ArrayBuffer, p: string) => {
      if (stale()) return;
      const url = URL.createObjectURL(new Blob([buf], { type: mediaMime(p) }));
      blobUrlRef.current = url;
      setBlobSrc(url);
    };
    if (urlSource) {
      // No local original to buffer — the fetched copy is the only source.
      if (!mediaPath) {
        setAudioBroken(true);
        setBrokenWhy("gone");
        return;
      }
      bufferPendingRef.current = true;
      readMediaFile(mediaPath)
        .then((buf) => asBlob(buf, mediaPath))
        .catch((e) => {
          if (stale()) return;
          // Rust refuses to buffer a file past its IPC cap — that is not a missing
          // copy: re-enter with the blob stage marked tried so it plays from the
          // decoded WAV through the asset protocol instead.
          if (isTooLargeToBuffer(e)) return onAudioError(String(e));
          setAudioBroken(true);
          setBrokenWhy("gone");
          setBrokenDetail(`could not read the stored copy: ${String(e)}`);
        })
        .finally(() => { bufferPendingRef.current = false; });
      return;
    }
    bufferPendingRef.current = true;
    readMediaFile(path)
      .then((buf) => asBlob(buf, path))
      .catch((e) => {
        if (stale()) return;
        if (isTooLargeToBuffer(e)) return onAudioError(String(e));
        // Original unreadable (moved/deleted) — fall back to the app's copy.
        if (!mediaPath) {
          setAudioBroken(true);
          setBrokenWhy("gone");
          return;
        }
        return readMediaFile(mediaPath)
          .then((buf) => {
            if (stale()) return;
            asBlob(buf, mediaPath);
            setAudioNote("copy");
          })
          .catch((e2) => {
            if (stale()) return;
            if (isTooLargeToBuffer(e2)) return onAudioError(String(e2));
            setAudioBroken(true);
            setBrokenWhy("gone");
          });
      })
      .finally(() => { bufferPendingRef.current = false; });
  };

  // WebKitGTK doesn't reliably fire `error` for an unsupported container —
  // observed with yt-dlp's fragmented m4a it just stalls with readyState 0
  // forever, so an error-event-driven fallback chain never advances. Treat
  // a source that produces no metadata within 6 s as errored (unless a
  // decode or buffer read is already in flight — both legitimately take seconds).
  const activeAudioSrc = blobSrc ?? audioSrc;
  useEffect(() => {
    if (!activeAudioSrc || audioBroken) return;
    const t = window.setTimeout(() => {
      const a = audioRef.current;
      if (a && a.readyState === 0 && !decodePendingRef.current && !bufferPendingRef.current)
        onAudioError("stalled — no media events within 6 s");
    }, 6000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onAudioError is stable-by-refs
  }, [activeAudioSrc, audioBroken]);

  const seekTo = useCallback(
    (t: number) => {
      const a = audioRef.current;
      if (!a || !Number.isFinite(t)) return;
      a.currentTime = Math.max(0, Math.min(audioLen || t, t));
      syncPlayhead(a.currentTime, true);
    },
    [audioLen, syncPlayhead],
  );

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch((e) => { if (e.name !== "AbortError") setAudioBroken(true); });
    else a.pause();
  };

  const cycleRate = () => {
    const next = rate >= 2 ? 1 : rate === 1 ? 1.5 : 2;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  // Sticky toolbar over a nested scroller: once the page scrolls past the
  // card top, the pinned toolbar overlaps the box's top edge — and a box
  // cannot scroll "above its own content", so the rows under that overlap
  // were unreachable by any scroll. Compensate by SHRINKING the box in step:
  // translateY moves its top edge down to the toolbar's bottom while the
  // height gives up the same amount (margin-bottom takes it over, so the
  // flow below — hint, Recent — never shifts and the page scroll can't
  // feedback-loop). The box, its content, and crucially its scrollbar then
  // exactly span what is visible; earlier padding-based compensation left
  // the element itself 65vh tall with the scrollbar running off-screen.
  // The sticky toolbar's height as `--viewer-bar` on the card: the export panel's sticky
  // Summary column sits below it instead of under it. 0 where the toolbar isn't sticky.
  useEffect(() => {
    const bar = toolbarRef.current;
    const card = bar?.parentElement;
    if (!bar || !card) return;
    if (fill || focus) {
      card.style.removeProperty("--viewer-bar");
      return;
    }
    const ro = new ResizeObserver(() => card.style.setProperty("--viewer-bar", `${bar.offsetHeight}px`));
    ro.observe(bar);
    return () => {
      ro.disconnect();
      card.style.removeProperty("--viewer-bar");
    };
  }, [fill, focus]);
  const stickyShiftRef = useRef(0); // current translateY, read by follow
  useEffect(() => {
    if (fill || focus) return; // toolbar isn't sticky there — no overlap
    const box = transcriptBoxRef.current;
    const bar = toolbarRef.current;
    if (!box || !bar) return;
    let raf = 0;
    let shift = 0;
    let baseH = 0; // natural height, measured unshifted
    const clear = () => {
      box.style.transform = "";
      box.style.height = "";
      box.style.marginBottom = "";
    };
    const apply = () => {
      raf = 0;
      const rect = box.getBoundingClientRect();
      if (!baseH) baseH = rect.height + shift;
      const flowTop = rect.top - shift; // untransformed position
      // Keep a readable sliver (~4 rows) even at the page's very bottom.
      const next = Math.round(
        Math.max(
          0,
          Math.min(bar.getBoundingClientRect().bottom - flowTop, baseH - 140),
        ),
      );
      if (next === shift) return;
      // Height changes anchor asymmetrically: shrinking keeps scrollTop
      // (top-anchored), growing clamps it down (bottom-anchored). A grow →
      // shrink round-trip therefore quietly loses the bottom position — if
      // the box sat at its end before the change, re-pin it there after.
      const atBottom = box.scrollTop >= box.scrollHeight - box.clientHeight - 2;
      shift = next;
      stickyShiftRef.current = next;
      if (!next) clear();
      else {
        box.style.transform = `translateY(${next}px)`;
        box.style.height = `${baseH - next}px`;
        box.style.marginBottom = `${next}px`;
      }
      if (atBottom) box.scrollTop = box.scrollHeight - box.clientHeight;
    };
    // Capture-phase: the page scroller is an inner div (`<main>`), whose
    // scroll events don't bubble — capture on window sees them anyway.
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onResize = () => {
      // Viewport change invalidates the measured natural height (65vh cap).
      shift = 0;
      stickyShiftRef.current = 0;
      baseH = 0;
      clear();
      onScroll();
    };
    apply();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      stickyShiftRef.current = 0;
      clear();
    };
    // The mode and showFullText remount the box node, result changes its natural
    // height, the translate panel above the box moves its flow position
    // and the row-content toggles change its natural height — re-grab and
    // re-measure on each.
  }, [fill, focus, mode, view, showFullText, hasSegments, result, showTranslate, visLangsKey, showTs, showNames, colorize]);

  // A mode switch swaps what sits under the toolbar (the list ↔ the export
  // panel) while the page keeps its scrollTop. With the page scrolled into
  // the card the toolbar is stuck, so the new content's top landed hidden
  // under it (Export opened mid-panel; Read came back mid-list). When the
  // content's top isn't in view, bring the card's top to the scroller's top —
  // the toolbar, then as much of the content as fits. Coming back from
  // Export the list is a fresh node at scrollTop 0: re-centre the active row
  // in it, box only. Layout effect + instant: the content swaps in one frame,
  // so the position lands in that same frame (nothing to ease, nothing for
  // follow to fight — follow is idle in Export and re-checks after this).
  const prevModeRef = useRef(mode);
  useLayoutEffect(() => {
    const was = prevModeRef.current;
    prevModeRef.current = mode;
    if (was === mode) return;
    const bar = toolbarRef.current;
    const card = bar?.parentElement;
    if (!bar || !card) return;
    const box = transcriptBoxRef.current;
    if (was === "export" && box && activeSegIdx >= 0) {
      const row = box.querySelector<HTMLElement>(`#seg-row-${activeSegIdx}`);
      if (row) {
        box.scrollTop +=
          row.getBoundingClientRect().top -
          box.getBoundingClientRect().top -
          (box.clientHeight - row.offsetHeight) / 2;
      }
    }
    if (fill || focus) return; // only the box/panel scrolls there
    // The toolbar's next sibling IS the mode's content: the export panel in
    // Export (TranscriptExport renders nothing while closed), else the list.
    const content = bar.nextElementSibling;
    const page = scrollParentOf(card);
    if (!content || !page) return;
    const pageRect = page.getBoundingClientRect();
    const top = content.getBoundingClientRect().top;
    const visBottom = Math.min(pageRect.bottom, window.innerHeight);
    // Hidden under the stuck toolbar, or under ~a box title from the bottom.
    if (top >= bar.getBoundingClientRect().bottom - 1 && top <= visBottom - 120) return;
    page.scrollTop = Math.max(
      0,
      Math.min(
        page.scrollTop + card.getBoundingClientRect().top - pageRect.top,
        page.scrollHeight - page.clientHeight,
      ),
    );
    // activeSegIdx is read at switch time only — the row to land on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Follow: keep the active row centred while playing. Primarily by scrolling
  // the transcript BOX (its own scroll container); only when the box alone
  // cannot reach the row — a box edge scrolled out of the page viewport — a
  // bounded page nudge reveals that edge. scrollIntoView is still avoided:
  // it re-centres the page on EVERY line even when the box could handle it.
  // The animation is a hand-rolled rAF ease-out: WebKitGTK ignores
  // scrollTo({behavior:"smooth"}) and jumps instantly.
  const followAnimRef = useRef<number | null>(null);
  useEffect(() => {
    // Not while editing: the highlight is not drawn in Edit mode, and a scroll on every
    // segment boundary would pull the transcript out from under the caret. Not in
    // Export either: the list isn't there, and playback (Space) keeps running.
    if (!follow || !playing || editMode || !reading || activeSegIdx < 0) return;
    const box = transcriptBoxRef.current;
    const row = document.getElementById(`seg-row-${activeSegIdx}`);
    if (!box || !row) return;
    const boxRect = box.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // Centre inside the VISIBLE strip of the box, not its full height: in the
    // stacked card the page can be scrolled so part of the 65vh box sits
    // off-screen — centring on the box's midpoint would park the active row
    // outside the viewport.
    const toolbarBottom = toolbarRef.current?.getBoundingClientRect().bottom ?? 0;
    const visTop = Math.max(boxRect.top, toolbarBottom, 0);
    const visBottom = Math.min(boxRect.bottom, window.innerHeight);
    const visCenter =
      visBottom > visTop
        ? (visTop + visBottom) / 2
        : boxRect.top + box.clientHeight / 2; // box fully off-screen — old math
    const rowCenter = rowRect.top + row.clientHeight / 2;
    const target = Math.max(
      0,
      Math.min(
        box.scrollTop + rowCenter - visCenter,
        box.scrollHeight - box.clientHeight,
      ),
    );
    const from = box.scrollTop;
    const dist = target - from;
    // Whatever the clamped box scroll could NOT cover (first lines with the
    // box top above the viewport, or the tail below the fold) falls to the
    // page scroller — but the page's job is ONLY to reveal the box's hidden
    // edge, never to centre a row. Centring the first line would demand the
    // box top at mid-screen, so an unbounded shift walked the page up past
    // the whole card, one line at a time. Bounded by how far the box edge
    // actually sits outside the viewport, the shift is zero once the box is
    // fully visible — the common case — and can never overshoot.
    const shortfall = visCenter - (rowCenter - dist);
    // Measure against the box's untransformed flow position: the sticky-shift
    // compensation pins the visual top at the toolbar's bottom, but the page
    // can still scroll up to melt the shift away and grow the strip.
    const revealTop = Math.max(
      0,
      Math.max(toolbarBottom, 0) - (boxRect.top - stickyShiftRef.current),
    );
    const revealBottom = Math.max(0, boxRect.bottom - window.innerHeight);
    const pageShift = Math.max(-revealBottom, Math.min(shortfall, revealTop));
    const page =
      scrollParentOf(box) ?? ((document.scrollingElement as HTMLElement | null) ?? null);
    const pageFrom = page ? page.scrollTop : 0;
    const pageTarget = page
      ? Math.max(
          0,
          Math.min(pageFrom - pageShift, page.scrollHeight - page.clientHeight),
        )
      : 0;
    const pageDist = pageTarget - pageFrom;
    if (Math.abs(dist) < 1 && Math.abs(pageDist) < 1) return;
    if (followAnimRef.current) cancelAnimationFrame(followAnimRef.current);
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      box.scrollTop = target;
      if (page) page.scrollTop = pageTarget;
      return;
    }
    // Slightly longer glide for bigger hops (seeks), capped so it never lags
    // behind fast line changes.
    const span = Math.max(Math.abs(dist), Math.abs(pageDist));
    const duration = Math.min(650, 300 + span * 0.4);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      box.scrollTop = from + dist * eased;
      if (page) page.scrollTop = pageFrom + pageDist * eased;
      followAnimRef.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    followAnimRef.current = requestAnimationFrame(step);
    return () => {
      if (followAnimRef.current) {
        cancelAnimationFrame(followAnimRef.current);
        followAnimRef.current = null;
      }
    };
  }, [activeSegIdx, follow, playing, editMode, reading]);
  // Manual wheel/touch INSIDE the transcript box disarms follow (the chip
  // re-arms); scrolling anywhere else on the page leaves it armed — a stray
  // tick over the sidebar used to kill it. Listener-level, not onScroll:
  // the follow scroll itself must never self-disarm.
  useEffect(() => {
    if (!playing || !follow) return;
    const box = transcriptBoxRef.current;
    if (!box) return;
    const disarm = () => setFollow(false);
    box.addEventListener("wheel", disarm, { passive: true });
    box.addEventListener("touchmove", disarm, { passive: true });
    return () => {
      box.removeEventListener("wheel", disarm);
      box.removeEventListener("touchmove", disarm);
    };
    // The mode/showFullText/focus remount the box — re-attach to the fresh node.
  }, [playing, follow, mode, showFullText, focus]);

  // Space play/pause, ←/→ word-by-word, ↑/↓ line-by-line, F focus toggle,
  // Esc exit — never while typing somewhere, and never when another control
  // (the file-queue listbox) already handled the key.
  useEffect(() => {
    /** Seek one line forward/back from the playhead. */
    const stepSegment = (dir: 1 | -1) => {
      const segs = dataRef.current.segs ?? [];
      if (!segs.length) return;
      const t = audioRef.current?.currentTime ?? 0;
      const li = lastStartedAt(segs, t);
      const next = Math.max(0, Math.min(segs.length - 1, li + dir));
      seekTo(segs[next].start);
    };
    /** Seek one word forward/back; lines when the run has no word timings. */
    const stepWord = (dir: 1 | -1) => {
      const words = dataRef.current.words;
      if (!words.length) {
        stepSegment(dir);
        return;
      }
      const t = audioRef.current?.currentTime ?? 0;
      const best = lastStartedAt(words, t);
      const next = Math.max(0, Math.min(words.length - 1, best + dir));
      seekTo(words[next].start);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // e.g. the queue listbox's ↑/↓ selection
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      // A focused control owns Space and the arrows: every switch/segment/chip in this
      // app is a <button> that activates on Space, and preventDefault here cancelled that
      // — Tab to "Speaker diarization", press Space, and the audio play/paused instead.
      if (
        t?.closest(
          'button, [role="button"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="slider"], [role="option"], [role="combobox"]',
        )
      )
        return;
      if (e.key === "Escape") {
        if (focus) {
          e.preventDefault();
          setFocus(false);
        }
        return;
      }
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleFocus();
        return;
      }
      if (!audioSrc || audioBroken) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepWord(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepWord(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        stepSegment(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        stepSegment(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const clearCopiedTimer = () => {
    if (copyTimer.current) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = undefined;
    }
  };
  useEffect(() => {
    setCopied(false);
    clearCopiedTimer();
  }, [path, okey]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stripControlChars(copyText()));
    } catch (e) {
      console.error("clipboard copy failed:", e); // don't flash "Copied" if the write failed
      return;
    }
    setCopied(true);
    clearCopiedTimer();
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  // Clear a still-pending confirmation timer if the viewer unmounts mid-window.
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // ── row callbacks (stable, so SegmentRow's memo holds) ───────────────────
  const onToggleReassign = useCallback((i: number) => {
    setReassignRow((r) => (r === i ? null : i));
  }, []);
  const onReassign = useCallback(
    (i: number, label: string) => {
      const orig = result.segments?.[i]?.speaker;
      setSegmentSpeaker(okey, i, label === orig ? null : label);
      setReassignRow(null);
    },
    [okey, result],
  );
  const onCommitEdit = useCallback(
    (i: number, text: string) => {
      const t = stripControlChars(text).trim();
      const orig = (result.segments?.[i]?.text ?? "").trim();
      setSegmentEdit(okey, i, t && t !== orig ? t : null);
    },
    [okey, result],
  );

  const canSeek = !!audioSrc && !audioBroken;
  /** The Subtitles option's tooltip: the limits the cues follow. */
  const subtitlesTitle = (() => {
    if (!cueOpts) return "As transcribed: one subtitle per segment";
    const l = limitsFor(cueOpts, result.language);
    return `${limitsTitle(l)} · ${cueOpts.timing === "own" ? "own timing per language" : "same timing for every language"}`;
  })();

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div
      data-transcript-viewer=""
      className={cn(
        focus
          ? "fixed inset-0 z-50 flex flex-col bg-bg"
          : cn(
              "relative rounded-card border border-line bg-surface/80 p-5 backdrop-blur-sm",
              fill && "flex min-h-0 flex-1 flex-col",
              className,
            ),
      )}
    >
      {/* Toolbar: identity + player + display toggles + legend. Sticky in the
          stacked card (pins against the page scroller while the rows scroll);
          a plain flex-none header in the studio pane and in focus mode, where
          only the transcript box itself scrolls. The overlap a stuck toolbar
          casts over the box's top is compensated by the sticky-shift effect
          on the box — see stickyShiftRef above the follow logic. */}
      <div
        ref={toolbarRef}
        className={cn(
          focus
            ? "flex-none border-b bg-surface/95 px-6 pb-0.5 pt-4"
            : cn(
                "-mx-5 -mt-5 rounded-t-card border-b bg-surface/95 px-5 pb-0.5 pt-5",
                fill ? "flex-none" : "sticky -top-px z-10 backdrop-blur-md",
              ),
          // The rule edges the list; over the export panel it ran along the
          // Format/Summary boxes' top borders. Transparent there, not removed:
          // the gap under the toolbar stays the same in every mode.
          reading ? "border-line" : "border-transparent",
        )}
      >
      <div className="mb-2.5 font-mono text-[11px] uppercase tracking-label text-faint">
        transcript
        {/* Identity first: same-URL records only differ by when they ran. */}
        {stamp ? (
          <>
            {" · "}
            <span className="text-dim">{stamp}</span>
          </>
        ) : null}
        {fileLabel ? ` · ${fileLabel}` : ""}
        {result.language ? ` · ${safeDisplayText(result.language, 16)}` : ""}
        {result.duration
          ? ` · ${result.duration < 60 ? `${result.duration.toFixed(1)}s` : fmtDurationExact(result.duration)}`
          : ""}
        {hasSpeakers ? ` · ${speakers.length} speakers` : ""}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Viewer mode"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setReassignRow(null);
          }}
          options={[
            { value: "read", label: "Read", icon: BookOpen },
            {
              value: "edit", label: "Edit", icon: Pencil, disabled: !hasSegments, dot: editCount > 0,
              title: editCount ? plural(editCount, "correction") : undefined,
            },
            { value: "export", label: "Export", icon: Download },
          ]}
        />
        <span className="flex-1" />
        <div className="flex items-center gap-2">
          {urlSource && (
            <Button
              variant="ghost"
              size="sm"
              title="Open the transcribed link in the browser"
              onClick={() => void openSourceUrl(path).catch(() => {})}
            >
              <ExternalLink className="size-4" />
              Open link
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleFocus}
            aria-pressed={focus}
            title={focus ? "Exit focus mode (Esc)" : "Focus mode — transcript only (F)"}
          >
            {focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            {focus ? "Exit focus" : "Focus"}
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              title="Close this transcript (it stays in History)"
              onClick={onClose}
            >
              <XIcon className="size-4" />
              Close
            </Button>
          )}
        </div>
      </div>

      {editMode && (
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-accent/35 bg-accent-soft px-4 py-2.5">
          <Pencil className="size-4 shrink-0 text-accent" />
          <span className="text-[13px] font-medium text-accent">Editing transcript</span>
          <span className="text-[12px] text-dim">
            {editCount
              ? `${plural(editCount, "correction")} — they apply to Copy and every export`
              : "click a sentence to correct it · click a speaker chip to reassign"}
          </span>
          <span className="flex-1" />
          {flaggedIdxs.length > 0 && isTauri && retroTranslateAvailable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={translating}
              title="Corrected segments carry the OLD text's translations; kept-original segments failed the server's quality guard — re-translate just those"
              onClick={() => {
                // No translated tracks yet = nothing to refresh — open the
                // options panel instead of silently no-opping on [] targets.
                if (langs.length) {
                  // The transcript's OWN regime, not the backend default — see translateOptsFrom.
                  void runTranslate(flaggedIdxs, langs, translateOptsFrom(result.translation));
                } else {
                  setShowTranslate(true);
                }
              }}
            >
              {translating ? "Translating…" : `↻ Re-translate ${flaggedIdxs.length} flagged`}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearEdits(okey);
              setMode("read");
              setReassignRow(null);
            }}
          >
            Discard
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => {
              setMode("read");
              setReassignRow(null);
            }}
          >
            <Check className="size-4" />
            Done
          </Button>
        </div>
      )}

      {audioSrc && !audioBroken && (
        <>
          {/* key forces a clean reload per file; mounted in every mode, so
              Export keeps the playhead and Space still plays */}
          <audio
            key={blobSrc ?? path}
            ref={attachAudio}
            src={blobSrc ?? audioSrc}
            preload="metadata"
            onLoadedMetadata={(e) => {
              setAudioLen(e.currentTarget.duration || 0);
              e.currentTarget.playbackRate = rate;
            }}
            // Coarse fallback only — while playing, the rAF loop above owns
            // the playhead (timeupdate ticks every 250-500 ms on WebKitGTK).
            onTimeUpdate={(e) => {
              if (!playing) syncPlayhead(e.currentTarget.currentTime);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={(e) => {
              const me = e.currentTarget.error;
              onAudioError(
                me
                  ? `media error ${me.code}${me.message ? `: ${me.message}` : ""}`
                  : undefined,
              );
            }}
          />
          {reading && (
            <div className="mb-3 flex items-center gap-3.5 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5">
              <button
                type="button"
                aria-label={playing ? "Pause" : "Play"}
                onClick={togglePlay}
                className="ring-signal grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink"
              >
                {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
              </button>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-text">
                {fmtTimestamp(curTime)}
                <span className="text-faint"> / {fmtTimestamp(audioLen || result.duration || 0)}</span>
              </span>
              <div
                role="slider"
                aria-label="Seek"
                aria-valuemin={0}
                aria-valuemax={Math.round(audioLen)}
                aria-valuenow={Math.round(curTime)}
                tabIndex={0}
                className="relative h-5 flex-1 cursor-pointer touch-none"
                // Pointer capture makes this a real drag scrubber: after the
                // press, moves anywhere on screen keep seeking until release.
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                  seekTo(frac * (audioLen || 0));
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                  seekTo(frac * (audioLen || 0));
                }}
                // The window key handler concedes Space/arrows to a focused slider,
                // so this one has to own them — a focusable ARIA slider without
                // keyboard seeking was dead on exactly the control built for it.
                onKeyDown={(e) => {
                  const next = seekKeyTarget(e.key, curTime, audioLen || 0, e.shiftKey);
                  if (next === "toggle") {
                    e.preventDefault();
                    togglePlay();
                    return;
                  }
                  if (next === null) return;
                  e.preventDefault();
                  seekTo(next);
                }}
              >
                <div className="absolute inset-x-0 top-1/2 h-[5px] -translate-y-1/2 overflow-hidden rounded-pill bg-surface-2">
                  <div
                    className="h-full rounded-pill bg-accent"
                    style={{ width: `${audioLen ? Math.min(100, (curTime / audioLen) * 100) : 0}%` }}
                  />
                </div>
                <span
                  className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text shadow"
                  style={{ left: `${audioLen ? Math.min(100, (curTime / audioLen) * 100) : 0}%` }}
                />
              </div>
              <button
                type="button"
                onClick={cycleRate}
                className="ring-signal shrink-0 rounded-pill border border-line px-2.5 py-0.5 font-mono text-[11.5px] text-dim hover:text-text"
                title="Playback speed"
              >
                {rate}×
              </button>
              <button
                type="button"
                onClick={() => setFollow((v) => !v)}
                aria-pressed={follow}
                title="Auto-scroll to the spoken segment"
                className={cn(
                  "ring-signal inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-[11.5px] font-medium",
                  follow
                    ? "border-accent/35 bg-accent-soft text-accent"
                    : "border-line bg-surface-2 text-dim",
                )}
              >
                <ArrowDownToLine className="size-3" />
                Follow
              </button>
            </div>
          )}
        </>
      )}

      {reading && audioNote === "copy" && !audioBroken && (
        <div className="-mt-2 mb-3 px-1 text-[11.5px] text-faint">
          Playing the app's saved copy — the original file was moved or deleted.
        </div>
      )}

      {reading && audioBroken && (
        <div className="mb-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2 text-[12px] text-dim">
          {brokenWhy !== "gone"
            ? "Playback isn't available — every playback path failed for this audio. The transcript and exports still work."
            : urlSource
              ? "The downloaded audio isn't stored on this device — run the link again to restore playback. The transcript and edits still work."
              : "Playback isn't available — the original file is gone and no copy was kept (it predates audio copies, or “Keep a copy of the audio” was off)."}
          {/* The technical reason — a codec, a missing file, and a media-stack
              hiccup are different problems; guessing one in prose sent a
              debugging session down the wrong road. */}
          {brokenDetail && (
            <div className="mt-1 font-mono text-[10.5px] text-faint">
              {stripControlChars(brokenDetail).slice(0, 200)}
            </div>
          )}
        </div>
      )}

      {reading && urlSource && !mediaPath && !audioBroken && (
        <div className="mb-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2 text-[12px] text-dim">
          No audio is stored for this link — run it again to restore playback.
          The transcript and edits still work.
        </div>
      )}

      {reading && hasSegments && allTracks.length > 1 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          {(subtitlesView ? trackOrd : segOrder).length > 1 && (
            <ExportTrackChips
              result={result}
              order={subtitlesView ? trackOrd : segOrder}
              chosen={subtitlesView ? visibleTracks : segVisible}
              onChosen={pickTracks}
              onOrder={(next) => setTrackPrefs({ order: subtitlesView ? next : mergeOrder(result, trackOrd, next) })}
            />
          )}
          {result.translation?.model && (
            <span className="text-[11px] text-faint">
              MT · {safeDisplayText(result.translation.model.split("/").pop() ?? "", 40)}
            </span>
          )}
          {/* The way back into a half-translated transcript: a cancelled or interrupted
              chunked run keeps its merged chunks, and the "Translate" door below closes the
              moment the first one lands. Driven by actual per-segment coverage. */}
          {isTauri && retroTranslateAvailable && !trRun && untranslatedIdxs.length > 0 && (
            <button
              type="button"
              disabled={translating}
              title="This run was cancelled or interrupted — translate the segments it never reached"
              className="ring-signal inline-flex h-7 items-center gap-1 rounded-pill border border-dashed border-line-strong px-3 text-[12px] text-dim transition-colors hover:text-text"
              onClick={() => void runTranslate(untranslatedIdxs, langs, translateOptsFrom(result.translation))}
            >
              Finish translating {untranslatedIdxs.length}
            </button>
          )}
        </div>
      )}

      {trRun ? (
        <TranslateProgressCard run={trRun} modeLabel={trRunMode} onCancel={cancelTranslate} />
      ) : (
        <>
          {reading && hasSegments && langs.length === 0 && isTauri && retroTranslateAvailable && (
            <div className="mb-2.5">
              <button
                type="button"
                onClick={() => setShowTranslate((v) => !v)}
                aria-expanded={showTranslate}
                className={cn(
                  "ring-signal inline-flex h-7 items-center gap-1.5 rounded-pill border px-3 text-[12px] transition-colors",
                  showTranslate
                    ? "border-accent/45 text-accent"
                    : "border-dashed border-line-strong text-dim hover:text-text",
                )}
                title="Translate this transcript (server-side MT)"
              >
                Translate
              </button>
            </div>
          )}
          {reading && showTranslate && hasSegments && langs.length === 0 && retroTranslateAvailable && (
            <div className="mb-3 rounded-xl border border-line bg-surface-2/60 p-4">
              <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-label text-faint">
                translate this transcript
              </div>
              <TranslationOptionsFields
                targets={effTargets}
                onTargetsChange={setTrTargets}
                mode={trMode}
                onModeChange={setTrMode}
                model={trModel}
                inheritedModel={trBackend?.translationOverrides?.model}
                onModelChange={setTrModel}
                caps={trCaps}
                exclude={result.language ?? undefined}
                disabled={translating}
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  variant="accent"
                  size="sm"
                  disabled={translating || !effTargets.length}
                  onClick={() =>
                    void runTranslate(
                      (result.segments ?? []).map((_, i) => i),
                      effTargets,
                      { mode: trMode, model: trModel || undefined },
                    )
                  }
                >
                  Translate now
                </Button>
                <span className="text-[11.5px] text-faint">
                  runs on {safeDisplayText(trBackend?.name ?? "the backend", 40)} — the original
                  is kept; translated lines appear as they finish
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {reading && hasSegments && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Show transcript as"
            value={editMode ? "segments" : view}
            onChange={setView}
            options={[
              { value: "segments", label: "Segments" },
              { value: "subtitles", label: "Subtitles", disabled: editMode, title: subtitlesTitle },
            ]}
          />
          <span className="h-5 w-px bg-line" />
          {(
            [
              ["Timestamps", showTs, setShowTs, true],
              ["Speaker names", showNames, setShowNames, hasSpeakers],
              ["Colors", colorize, setColorize, hasSpeakers],
            ] as const
          ).map(([label, on, setter, available]) =>
            available ? (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                onClick={() => setter(!on)}
                className={cn(
                  "ring-signal inline-flex h-7 items-center rounded-pill border px-3 text-[12px] font-medium transition-colors",
                  on
                    ? "border-accent/35 bg-accent-soft text-accent"
                    : "border-line bg-surface-2 text-dim hover:text-text",
                )}
              >
                {label}
              </button>
            ) : null,
          )}
          <span className="text-[11.5px] text-faint">
            the view is the export — Copy and files match what you see
          </span>
        </div>
      )}

      {reading && hasSpeakers && showNames && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          {speakers.map((label) => {
            const color = colorOf(label);
            return editingSpeaker === label ? (
              <span key={label} className="inline-flex items-center gap-2">
                {/* The speaker color OWNS the field: its solid border is
                    the focus indicator (no app-wide accent ring competing
                    with it) and a dot inside doubles the preview. Picking
                    a swatch repaints both instantly. */}
                <span className="relative inline-flex items-center">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-3 size-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setEditingSpeaker(null);
                    }}
                    aria-label={`Rename ${prettySpeaker(label)}`}
                    className="h-7 w-36 rounded-pill border-2 bg-surface-2 pl-7 pr-3 text-[12px] text-text outline-none"
                    style={{ borderColor: color }}
                  />
                </span>
                <span className="inline-flex items-center gap-1">
                  {DEFAULT_SPEAKER_COLORS.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      title="Use this color"
                      aria-label={`Color ${prettySpeaker(label)} ${idx + 1}`}
                      aria-pressed={colorIdxOf(label) === idx}
                      // preventDefault keeps focus in the rename input, so
                      // picking a color doesn't blur-commit and close it.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setSpeakerColor(label, idx)}
                      className={cn(
                        "grid size-4 place-items-center rounded-full transition-transform hover:scale-110",
                        colorIdxOf(label) === idx && "scale-110",
                      )}
                      style={{ backgroundColor: `var(--spk-${idx + 1})` }}
                    >
                      {/* Check on the selected swatch — selection no longer
                          reads by hue alone. */}
                      {colorIdxOf(label) === idx && (
                        <Check className="size-2.5 text-black/70" strokeWidth={4} />
                      )}
                    </button>
                  ))}
                </span>
              </span>
            ) : (
              <button
                key={label}
                type="button"
                title="Rename or recolor this speaker"
                onClick={() => {
                  setEditingSpeaker(label);
                  setRenameDraft(fileRenames[label] ?? "");
                }}
                className="ring-signal inline-flex items-center gap-1.5 rounded-pill py-0.5 pl-2 pr-2.5 text-[12px] font-medium"
                style={chipStyle(color)}
              >
                <span className="size-[7px] rounded-full" style={{ backgroundColor: color }} />
                {displayName(label)}
              </button>
            );
          })}
          <span className="text-[11.5px] text-faint">
            click a name to rename or pick its color — both apply to Copy and exports
          </span>
        </div>
      )}
      </div>

      <TranscriptExport
        open={mode === "export"}
        result={result}
        editedResult={editedResult}
        effWords={effWords}
        path={path}
        mediaPath={mediaPath}
        overlayKey={overlayKey}
        initialExport={initialExport}
        order={trackOrd}
        record={recId ? record : undefined}
        visibleTracks={visibleTracks}
        trackPrefs={trackPrefs}
        onTrackPrefs={setTrackPrefs}
        fileRenames={fileRenames}
        fileColors={fileColors}
        speakers={speakers}
        editCount={editCount}
        cueOpts={cueOpts}
        fill={fill}
        focus={focus}
        trBackend={trBackend}
        trCaps={trCaps}
      />

      {/* `transport::batch` deliberately leaves `text` untouched ("that IS the output"), so
          bidi overrides and other invisible format characters from an untrusted server reach
          this node by design. The Copy button above already strips them; without the same
          treatment here what the user READS can be reordered relative to what they paste. */}
      {!reading ? null : !hasSegments ? (
        <div
          className={cn(
            "select-text whitespace-pre-wrap text-[14px] leading-relaxed text-text",
            (fill || focus) && "min-h-0 flex-1 overflow-y-auto overscroll-contain",
            focus && "px-6 py-8",
          )}
        >
          {stripControlChars(showFullText ? result.text : result.text.slice(0, TRANSCRIPT_PREVIEW_CHARS))}
        </div>
      ) : (
        <div
          ref={transcriptBoxRef}
          // -mx/px pair: the rows' -mx-1.5 highlight bleed lands in the
          // box's own padding instead of overflowing the scroll container.
          // overscroll-contain only where the page has nowhere to scroll
          // (studio pane, focus). In the stacked card, hitting the box's top
          // must chain to the page — with contain, a page scrolled to the
          // bottom left the first lines unreachable behind the stuck toolbar.
          // Sideways too: Subtitles lanes that don't fit keep their width and
          // scroll inside the box, never the page.
          className={cn(
            "select-text overflow-auto text-text",
            focus
              ? "min-h-0 flex-1 overscroll-contain"
              : cn(
                  "-mx-1.5 px-1.5 text-[14px] leading-relaxed",
                  fill ? "min-h-0 flex-1 overscroll-contain" : "max-h-[65vh]",
                ),
          )}
        >
          <div
            // Focus mode is a reading room: a centred ~68ch column with the
            // type stepped up — line length stays in the readable band no
            // matter how wide the window is. The Subtitles view sizes its own
            // columns and lanes (SubtitleList widths), so it only gets the room.
            className={focus ? (subGrid ? "px-6 py-10" : "mx-auto max-w-[72ch] px-6 py-10 text-[15.5px] leading-[1.8]") : undefined}
          >
            {subGrid ? (
              <SubtitleList
                result={editedResult}
                grid={subGrid}
                tracks={visibleTracks}
                cues={cueOpts}
                curTime={curTime}
                activeSeg={activeSegIdx}
                scrollRef={transcriptBoxRef}
                canSeek={canSeek}
                seekTo={seekTo}
                onEditSegment={onEditSegment}
                showNames={showNames}
                colorize={colorize}
                displayName={displayName}
                colorOf={colorOf}
              />
            ) : effSegments.slice(0, MAX_SEGMENT_ROWS).map((seg, i) => (
              <SegmentRow
                key={i}
                seg={seg}
                i={i}
                isActive={i === activeSegIdx && !editMode}
                passed={!editMode && i !== activeSegIdx && i <= passedSegIdx}
                activeWordIdx={i === activeSegIdx && !editMode ? activeWordIdx : -1}
                passedWordIdx={i === activeSegIdx && !editMode ? passedWordIdx : -1}
                range={segWordRanges[i]}
                words={effWords}
                showTs={showTs}
                showNames={showNames}
                colorize={colorize}
                editMode={editMode}
                reassignOpen={reassignRow === i}
                speakers={speakers}
                canSeek={canSeek}
                translations={result.segments?.[i]?.translations}
                translationsKept={result.segments?.[i]?.translationsKept}
                visLangsKey={visLangsKey}
                origVisible={origVisible}
                origLang={safeDisplayText((result.language ?? "??"), 16)}
                stale={!!fileStale[i]}
                isFrontier={i === (trRun?.frontierIdx ?? -1)}
                colorOf={colorOf}
                displayName={displayName}
                seekTo={seekTo}
                onToggleReassign={onToggleReassign}
                onReassign={onReassign}
                onCommitEdit={onCommitEdit}
              />
            ))}
          </div>
        </div>
      )}

      {reading && !subtitlesView && effSegments.length > MAX_SEGMENT_ROWS && (
        <div className={cn("mt-3 text-[12px] text-faint", focus && "flex-none px-6 pb-4")}>
          Showing the first {MAX_SEGMENT_ROWS.toLocaleString()} of {effSegments.length.toLocaleString()}{" "}
          lines. Copy and every export write all of them.
        </div>
      )}
      {audioSrc && !audioBroken && hasSegments && mode === "read" && (
        <div
          className={cn(
            "border-t border-line font-mono text-[11px] text-faint",
            focus ? "flex-none px-6 py-2.5 text-center" : "mt-3 pt-2.5",
          )}
        >
          space play/pause · ←/→ word · ↑/↓ line · click a word or timestamp to jump there ·{" "}
          {focus ? "Esc exits focus" : "F for focus mode"}
        </div>
      )}

      {reading && !hasSegments && !showFullText && result.text.length > TRANSCRIPT_PREVIEW_CHARS && (
        <div className={cn("mt-3 flex items-center gap-3", focus && "flex-none px-6 pb-4")}>
          <Button variant="ghost" size="sm" onClick={() => setShowFullText(true)}>
            Show full transcript
          </Button>
          <span className="text-[12px] text-faint">
            Showing the first {TRANSCRIPT_PREVIEW_CHARS.toLocaleString()} of{" "}
            {result.text.length.toLocaleString()} characters. Copy always copies all of it.
          </span>
        </div>
      )}
    </div>
  );
}
