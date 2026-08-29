// The transcript workbench: player + karaoke follow, display toggles, speaker
// legend, corrections, export panel. Extracted from the Transcribe screen so
// (a) playback-time updates re-render only this subtree (the playhead ticks at
// display rate now, not at the webview's timeupdate cadence), (b) the same
// viewer renders in three shells — stacked card, studio pane, and the
// full-viewport focus mode (F / Esc) — without remounting, so audio, scroll
// and edit state survive every layout switch.

import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  ArrowDownToLine, Check, Circle, Copy, Download, ExternalLink, Maximize2,
  Minimize2, Minus, Pause, Pencil, Play, X as XIcon,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui";
import { fmtDurationExact, fmtTimestamp } from "@/lib/format";
import {
  decodeMediaFile, openSourceUrl, pickExportPath, readMediaFile, saveTextFile, isTauri,
} from "@/lib/api";
import {
  clearEdits, setRename, setSegmentEdit, setSegmentSpeaker,
  setSpeakerColor as setSpeakerColorAction, useTranscribeRun,
} from "@/lib/transcribeRun";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import {
  DEFAULT_SPEAKER_COLORS, EXPORT_EXTENSIONS, generateExport,
  type ExportFormat, type ExportOptions,
} from "@/lib/transcriptExport";
import { applyTextEdits, segmentWordRanges } from "@/lib/wordAlign";
import { cn } from "@/lib/cn";
import { isSourceUrl } from "@/lib/urlSource";
import type { BatchResult, TranscriptWord } from "@/lib/types";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Best-effort MIME for the playback blob (helps WebKitGTK pick a decoder). */
function mediaMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg",
    oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
    wma: "audio/x-ms-wma", mp4: "video/mp4", mkv: "video/x-matroska",
    webm: "video/webm", mov: "video/quicktime",
  };
  return map[ext] ?? "application/octet-stream";
}

/** How much of a returned transcript to lay out before the user asks for the rest.
 *
 *  The user picks the FILE; the server picks the RESPONSE — a small upload can be answered with a
 *  body up to the 32 MiB transport cap, and this card renders it wrapping, in one synchronous
 *  pass, with no error boundary to recover from a stalled renderer. A long transcript is also
 *  exactly what this screen is for, so this is a preview with an explicit "show the rest", not a
 *  truncation: `result.text` is untouched, and Copy still writes the FULL text. */
const TRANSCRIPT_PREVIEW_CHARS = 50_000;

/** Segment cap for the Timestamps/Speakers views — same renderer-stall reasoning as the
 *  character preview above (each segment is a DOM row; an hour of speech is ~1-2k rows,
 *  fine; a hostile response could carry far more). */
const MAX_SEGMENT_ROWS = 5_000;

/** Chip styling from a speaker's CSS color (a --spk-N token, so it follows
 *  the light/dark theme): readable text, a soft fill, and a solid dot. */
function chipStyle(color: string) {
  return { color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` };
}

/** The five export formats as always-visible cards (5 options is below every
 *  buttons-vs-dropdown threshold — NN/g, Fluent, Apple HIG). The one-liner
 *  says what the format is FOR; the "in this file" contract says what it
 *  will contain. */
const FORMAT_CARDS: { value: ExportFormat; label: string; use: string }[] = [
  { value: "srt", label: "SRT", use: "video subtitles — VLC, mpv, YouTube" },
  { value: "vtt", label: "VTT", use: "web video captions — HTML5 players" },
  { value: "txt", label: "TXT", use: "plain text — read, paste, edit" },
  { value: "lrc", label: "LRC", use: "synced lyrics — music players" },
  { value: "json", label: "JSON", use: "full data — every field & word" },
];

/** One row of the export panel's "in this file" contract. `always` = inherent
 *  to the format; on/off rows mirror the view toggles (clickable); `na` rows
 *  stay visible WITH the reason the format can't carry them — never hidden. */
type ContractRow = {
  label: string;
  state: "always" | "on" | "off" | "na";
  why: string;
  onToggle?: () => void;
};

/** "SPEAKER_00" → "Speaker 1"; anything else verbatim (already bounded by Rust). */
export function prettySpeaker(label: string): string {
  const m = /^SPEAKER_(\d+)$/.exec(label);
  return m ? `Speaker ${parseInt(m[1], 10) + 1}` : label;
}

/** Distinct speaker labels of a result, in first-appearance order. */
export function speakersOf(result: BatchResult): string[] {
  if (result.speakers?.length) return result.speakers;
  const seen: string[] = [];
  for (const s of result.segments ?? []) {
    if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return seen;
}

type EffSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  edited: boolean;
  textEdited: boolean;
};

/** One transcript row, memoized: during playback only the row entering and the
 *  row leaving the playhead re-render — the other (up to 5000) rows bail on a
 *  shallow prop compare, which is what makes the frame-rate clock affordable. */
const SegmentRow = memo(function SegmentRow({
  seg, i, isActive, passed, activeWordIdx, passedWordIdx, range, words, showTs,
  showNames, colorize, editMode, reassignOpen, speakers, canSeek, origText,
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
  origText: string;
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
  const karaoke = isActive && range && range[0] < range[1];
  const lineColor = colorize && seg.speaker ? { color: colorOf(seg.speaker) } : undefined;
  return (
    <div
      id={`seg-row-${i}`}
      className={cn(
        // No opacity transition here on purpose: when a finished line flips
        // from karaoke (words already dimmed one by one) to the plain passed
        // branch, an animated 1 → 0.6 fade reads as a bright flash.
        "relative -mx-1.5 flex gap-3 rounded-lg px-1.5 py-0.5",
        isActive && "bg-accent-soft/40",
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
              e.currentTarget.textContent = origText.trim();
              e.currentTarget.blur();
            }
          }}
          className="-mx-1 min-w-0 flex-1 whitespace-pre-wrap rounded px-1 outline-none focus:bg-surface-2/70"
          style={lineColor}
        >
          {seg.text.trim()}
        </span>
      ) : karaoke ? (
        <span className="min-w-0 flex-1 whitespace-pre-wrap" style={lineColor}>
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
      ) : (
        <span
          className="min-w-0 flex-1 whitespace-pre-wrap"
          style={lineColor}
          onClick={canSeek ? () => seekTo(seg.start) : undefined}
        >
          {stripControlChars(seg.text.trim())}
          {seg.edited && (
            <span className="ml-2 align-middle font-mono text-[10.5px] text-ok">· edited</span>
          )}
        </span>
      )}
    </div>
  );
});

export function TranscriptViewer({
  result,
  path,
  mediaPath,
  fileLabel,
  createdAt,
  onClose,
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
  /** Studio pane: fill the available height instead of capping at 65vh. */
  fill?: boolean;
  className?: string;
}) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const renames = useTranscribeRun((s) => s.renames);
  const speakerColors = useTranscribeRun((s) => s.speakerColors);
  const edits = useTranscribeRun((s) => s.edits);
  const speakerEdits = useTranscribeRun((s) => s.speakerEdits);

  const [copied, setCopied] = useState(false);
  // Reset per file, so a new (possibly huge) transcript starts collapsed again.
  const [showFullText, setShowFullText] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Export panel state, seeded from the persisted screen defaults.
  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(
    () => settings.transcribe?.exportFormat ?? "srt",
  );
  const [wordTs, setWordTs] = useState(() => settings.transcribe?.wordTimestamps ?? false);
  // Export-preview height: null = auto up to 40vh; a number once the user
  // drags the visible resize handle (WebKitGTK's native corner grip is
  // invisible on dark UIs, so the handle row IS the affordance).
  const [previewH, setPreviewH] = useState<number | null>(null);
  const previewRef = useRef<HTMLPreElement | null>(null);
  const previewDrag = useRef<{ startY: number; startH: number } | null>(null);
  // Display toggles — the view IS the export (Copy and Save match what is on
  // screen). Defaults migrate from the legacy speakerColorMode once.
  const [showTs, setShowTs] = useState(() => settings.transcribe?.showTimestamps ?? false);
  const [showNames, setShowNames] = useState(
    () => settings.transcribe?.showSpeakerNames ?? (settings.transcribe?.speakerColorMode !== "line-only"),
  );
  const [colorize, setColorize] = useState(() => {
    const legacy = settings.transcribe?.speakerColorMode;
    return settings.transcribe?.colorizeSpeakers ?? (legacy ? legacy !== "off" : true);
  });
  // Pre-export corrections mode.
  const [editMode, setEditMode] = useState(false);
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
        preFocusScroll.current = null;
        for (
          let p = toolbarRef.current?.parentElement ?? null;
          p;
          p = p.parentElement
        ) {
          if (p.scrollHeight > p.clientHeight + 1) {
            const oy = getComputedStyle(p).overflowY;
            if (oy === "auto" || oy === "scroll") {
              preFocusScroll.current = { el: p, top: p.scrollTop };
              break;
            }
          }
        }
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
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  // The "Copied" confirmation timer. Held in a ref so a rapid second Copy click clears the first
  // timer before re-arming — otherwise the stale timer fires mid-window and flips the label off
  // early (every other transient timer in the app is cleared the same way).
  const copyTimer = useRef<number | undefined>(undefined);

  const persistOptions = (patch: Partial<NonNullable<typeof settings.transcribe>>) => {
    updateSettings({ transcribe: { ...settings.transcribe, ...patch } });
  };

  // ── selected-result derivations ──────────────────────────────────────────
  const speakers = useMemo(() => speakersOf(result), [result]);
  const hasSegments = !!result.segments?.length;
  const hasSpeakers = speakers.length > 0;
  const fileRenames = useMemo(() => renames[path] ?? {}, [renames, path]);
  const fileColors = useMemo(() => speakerColors[path] ?? {}, [speakerColors, path]);
  const displayName = useCallback(
    (label: string) => safeDisplayText(fileRenames[label]?.trim() || prettySpeaker(label)),
    [fileRenames],
  );
  // User-picked palette index first, else first-appearance order — the chips
  // (via theme tokens) and the exported SRT/VTT (via hexes) stay in step.
  const colorIdxOf = useCallback(
    (label: string) =>
      fileColors[label] ??
      Math.max(0, speakers.indexOf(label)) % DEFAULT_SPEAKER_COLORS.length,
    [fileColors, speakers],
  );
  const colorOf = useCallback(
    (label: string) => `var(--spk-${colorIdxOf(label) + 1})`,
    [colorIdxOf],
  );

  const setSpeakerColor = (label: string, idx: number) => {
    setSpeakerColorAction(path, label, idx);
  };

  const commitRename = () => {
    if (editingSpeaker) {
      setRename(path, editingSpeaker, stripControlChars(renameDraft).trim());
    }
    setEditingSpeaker(null);
  };

  // Corrections layered over the server transcript — the segments every
  // surface renders, copies and exports.
  const fileEdits = useMemo(() => edits[path] ?? {}, [edits, path]);
  const fileSpkEdits = useMemo(() => speakerEdits[path] ?? {}, [speakerEdits, path]);
  const editCount = Object.keys(fileEdits).length + Object.keys(fileSpkEdits).length;
  const effSegments = useMemo(
    (): EffSegment[] =>
      (result.segments ?? []).map((seg, i) => ({
        ...seg,
        text: fileEdits[i] ?? seg.text,
        speaker: fileSpkEdits[i] ?? seg.speaker,
        // The combined flag drives the "edited" markers; only a TEXT edit
        // matters to word timing (a speaker reassignment leaves the words
        // exactly as valid as before, so it must not disable karaoke).
        edited: fileEdits[i] !== undefined || fileSpkEdits[i] !== undefined,
        textEdited: fileEdits[i] !== undefined,
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
  const editedResult = (): BatchResult => {
    if (!editCount) return result;
    const segs = effSegments.map(({ edited: _e, textEdited: _t, ...seg }) => seg);
    return {
      ...result,
      text: segs.map((seg) => seg.text.trim()).join(" "),
      segments: segs,
      words: effWords,
    };
  };

  const copyText = (): string => {
    if (!effSegments.length) return result.text;
    return effSegments
      .map((seg) => {
        const ts = showTs ? `[${fmtTimestamp(seg.start)}] ` : "";
        const who = showNames && seg.speaker ? `${displayName(seg.speaker)}: ` : "";
        return `${ts}${who}${seg.text.trim()}`;
      })
      .join("\n");
  };

  // ── playback + karaoke follow ────────────────────────────────────────────
  // The picked file plays straight from disk via the asset protocol. A URL
  // run has no local original — `path` IS the link — so playback comes from
  // the app's fetched copy (mediaPath), and with no copy there is simply no
  // <audio> (never convertFileSrc on a URL: that mints a guaranteed-broken
  // asset URL and a guaranteed error event).
  const urlSource = isSourceUrl(path);
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
    if (!isTauri) return undefined;
    if (urlSource) return mediaPath ? convertFileSrc(mediaPath) : undefined;
    return convertFileSrc(path);
  }, [path, mediaPath, urlSource]);

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
    let li = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (t >= segs[i].start) {
        li = i;
        break;
      }
    }
    setActiveSegIdx(li >= 0 && t < segs[li].end + 0.3 ? li : -1);
    setPassedSegIdx(li >= 0 ? (t >= segs[li].end ? li : li - 1) : -1);
    // Binary search: last word with start <= t (words are time-ordered).
    let lo = 0;
    let hi = words.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= t) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
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
    setEditMode(false);
    setReassignRow(null);
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = null;
    blobTriedRef.current = false;
    wavTriedRef.current = false;
    decodePendingRef.current = false;
    setBlobSrc(null);
  }, [path]);
  useEffect(
    () => () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    },
    [],
  );

  // A newly selected (possibly huge) transcript starts collapsed again.
  useEffect(() => {
    setShowFullText(false);
  }, [path, result]);

  /** The <audio> errored on the asset URL — resolve through the fallback
   *  chain ONCE per step: (1) buffer the original bytes through Rust (asset
   *  protocol quirks); if the original is gone, the app's stored copy; (2) a
   *  second error with the blob already loaded means the webview can't
   *  decode this CODEC (Linux WebKitGTK has no AAC/MP4 without proprietary
   *  GStreamer plugins — every retained YouTube audio) — decode to WAV in
   *  Rust and play that; (3) only when the WAV blob errors too is playback
   *  declared broken. */
  const onAudioError = (reason?: string) => {
    if (blobTriedRef.current) {
      if (wavTriedRef.current) {
        setAudioBroken(true);
        setBrokenWhy("codec");
        setBrokenDetail(`decoded WAV failed too — ${reason || "media element error"}`);
        return;
      }
      wavTriedRef.current = true;
      const fail = (why: "gone" | "codec" = "codec", detail?: string) => {
        setAudioBroken(true);
        setBrokenWhy(why);
        if (detail) setBrokenDetail(detail);
      };
      // Decode lands in a cached WAV file played through the asset
      // protocol — streaming from disk like every dictation, instead of a
      // ~240 MB in-memory blob (which freezes the WebKitGTK web process).
      const tryDecode = (p: string | null | undefined, next?: () => void) => {
        if (!p) return next ? next() : fail();
        decodePendingRef.current = true;
        decodeMediaFile(p)
          .then((wavPath) => {
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
            setBlobSrc(convertFileSrc(wavPath));
          })
          .catch((e) => {
            if (next) return next();
            fail(
              String(e).includes("gone") ? "gone" : "codec",
              `decode failed: ${String(e)}`,
            );
          })
          .finally(() => {
            decodePendingRef.current = false;
          });
      };
      if (urlSource) tryDecode(mediaPath);
      else tryDecode(path, () => tryDecode(mediaPath));
      return;
    }
    blobTriedRef.current = true;
    const asBlob = (buf: ArrayBuffer, p: string) => {
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
      readMediaFile(mediaPath)
        .then((buf) => asBlob(buf, mediaPath))
        .catch((e) => {
          setAudioBroken(true);
          setBrokenWhy("gone");
          setBrokenDetail(`could not read the stored copy: ${String(e)}`);
        });
      return;
    }
    readMediaFile(path)
      .then((buf) => asBlob(buf, path))
      .catch(() => {
        // Original unreadable (moved/deleted) — fall back to the app's copy.
        if (!mediaPath) {
          setAudioBroken(true);
          setBrokenWhy("gone");
          return;
        }
        readMediaFile(mediaPath)
          .then((buf) => {
            asBlob(buf, mediaPath);
            setAudioNote("copy");
          })
          .catch(() => {
            setAudioBroken(true);
            setBrokenWhy("gone");
          });
      });
  };

  // WebKitGTK doesn't reliably fire `error` for an unsupported container —
  // observed with yt-dlp's fragmented m4a it just stalls with readyState 0
  // forever, so an error-event-driven fallback chain never advances. Treat
  // a source that produces no metadata within 6 s as errored (unless a
  // decode is already in flight — that legitimately takes seconds).
  const activeAudioSrc = blobSrc ?? audioSrc;
  useEffect(() => {
    if (!activeAudioSrc || audioBroken) return;
    const t = window.setTimeout(() => {
      const a = audioRef.current;
      if (a && a.readyState === 0 && !decodePendingRef.current)
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
    if (a.paused) void a.play().catch(() => setAudioBroken(true));
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
    // editMode/showFullText remount the box node, result changes its natural
    // height — re-grab and re-measure.
  }, [fill, focus, editMode, showFullText, hasSegments, result]);

  // Follow: keep the active row centred while playing. Primarily by scrolling
  // the transcript BOX (its own scroll container); only when the box alone
  // cannot reach the row — a box edge scrolled out of the page viewport — a
  // bounded page nudge reveals that edge. scrollIntoView is still avoided:
  // it re-centres the page on EVERY line even when the box could handle it.
  // The animation is a hand-rolled rAF ease-out: WebKitGTK ignores
  // scrollTo({behavior:"smooth"}) and jumps instantly.
  const followAnimRef = useRef<number | null>(null);
  useEffect(() => {
    if (!follow || !playing || activeSegIdx < 0) return;
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
    const page = (() => {
      for (let p = box.parentElement; p; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 1) {
          const oy = getComputedStyle(p).overflowY;
          if (oy === "auto" || oy === "scroll") return p;
        }
      }
      return (document.scrollingElement as HTMLElement | null) ?? null;
    })();
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
  }, [activeSegIdx, follow, playing]);
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
    // editMode/showFullText/focus remount the box — re-attach to the fresh node.
  }, [playing, follow, editMode, showFullText, focus]);

  // Space play/pause, ←/→ word-by-word, ↑/↓ line-by-line, F focus toggle,
  // Esc exit — never while typing somewhere, and never when another control
  // (the file-queue listbox) already handled the key.
  useEffect(() => {
    /** Seek one line forward/back from the playhead. */
    const stepSegment = (dir: 1 | -1) => {
      const segs = dataRef.current.segs ?? [];
      if (!segs.length) return;
      const t = audioRef.current?.currentTime ?? 0;
      let li = -1;
      for (let i = segs.length - 1; i >= 0; i--) {
        if (t >= segs[i].start) {
          li = i;
          break;
        }
      }
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
      // Last word already started (binary search — words are time-ordered).
      let lo = 0;
      let hi = words.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].start <= t) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
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
  }, [path]);

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

  /** One source of truth for Save AND the live preview: the display toggles
   *  map onto the generator options (colors on → "line" mode; names/timestamps
   *  gate their prefixes). */
  const exportOpts = (): ExportOptions => ({
    format: exportFormat,
    renames: fileRenames,
    speakerColors: hasSpeakers && colorize ? "line" : "off",
    speakerNames: showNames,
    timestamps: showTs,
    colors: Object.fromEntries(
      Object.entries(fileColors).map(([l, i]) => [
        l,
        DEFAULT_SPEAKER_COLORS[i % DEFAULT_SPEAKER_COLORS.length],
      ]),
    ),
    wordTimestamps: wordTs,
  });

  /** The "in this file" rows for the selected format (see ContractRow). */
  const exportContract = (): ContractRow[] => {
    const hasWords = !!effWords.length;
    const namesRow: ContractRow | null = hasSpeakers
      ? {
          label: "Speaker names",
          state: showNames ? "on" : "off",
          why: showNames ? "on — mirrors the view toggle" : "off — click to include",
          onToggle: () => {
            setShowNames(!showNames);
            persistOptions({ showSpeakerNames: !showNames });
          },
        }
      : null;
    const colorsOn = (why: string): ContractRow | null =>
      hasSpeakers
        ? {
            label: "Speaker colors",
            state: colorize ? "on" : "off",
            why: colorize ? why : "off — click to include",
            onToggle: () => {
              setColorize(!colorize);
              persistOptions({ colorizeSpeakers: !colorize });
            },
          }
        : null;
    const colorsNa = (why: string): ContractRow | null =>
      hasSpeakers ? { label: "Speaker colors", state: "na", why } : null;
    const wordsNa = (why: string): ContractRow => ({
      label: "Word timestamps",
      state: "na",
      why,
    });
    const rows: (ContractRow | null)[] = (() => {
      switch (exportFormat) {
        case "srt":
          return [
            { label: "Cue timings", state: "always" as const, why: "always — the timing is the format" },
            namesRow,
            colorsOn("on — <font> tags, render in VLC & mpv"),
            wordsNa("SRT can't carry them — use LRC or JSON"),
          ];
        case "vtt":
          return [
            { label: "Cue timings", state: "always" as const, why: "always — the timing is the format" },
            namesRow,
            colorsOn("on — styled cues; render in browsers, video players show plain text"),
            wordsNa("not exported for VTT — use LRC or JSON"),
          ];
        case "txt":
          return [
            {
              label: "Timestamps",
              state: (showTs ? "on" : "off") as ContractRow["state"],
              why: showTs ? "on — [mm:ss] line prefixes, mirrors the view toggle" : "off — click to include",
              onToggle: () => {
                setShowTs(!showTs);
                persistOptions({ showTimestamps: !showTs });
              },
            },
            namesRow,
            colorsNa("plain text can't carry color"),
            wordsNa("TXT can't carry them — use LRC or JSON"),
          ];
        case "lrc":
          return [
            { label: "Line timings", state: "always" as const, why: "always — [mm:ss.xx] tags are the format" },
            namesRow,
            colorsNa("LRC can't carry color"),
            hasWords
              ? {
                  label: "Word timestamps",
                  state: (wordTs ? "on" : "off") as ContractRow["state"],
                  why: wordTs
                    ? "on — enhanced-LRC <mm:ss.xx> word tags (karaoke players)"
                    : "off — click to include",
                  onToggle: () => {
                    setWordTs(!wordTs);
                    persistOptions({ wordTimestamps: !wordTs });
                  },
                }
              : wordsNa("this run captured no word timing"),
          ];
        case "json":
          return [
            { label: "Segment timestamps", state: "always" as const, why: "always — start/end on every segment" },
            hasSpeakers
              ? { label: "Speakers", state: "always" as const, why: "always — labels, your renames and colors, as data" }
              : null,
            hasWords
              ? { label: "Word timestamps", state: "always" as const, why: "always — the words array" }
              : wordsNa("this run captured no word timing"),
          ];
      }
    })();
    return rows.filter((r): r is ContractRow => r !== null);
  };

  /** How many leading cues the preview serializes — enough to show real
   *  content past a VTT STYLE block, still cheap to re-serialize per toggle. */
  const PREVIEW_CUES = 12;

  /** First cues of the ACTUAL file, re-serialized on every card/toggle
   *  change — the panel's answer to "what am I getting?". */
  const exportPreview = (): string | null => {
    if (!result.segments?.length) return null;
    const full = editedResult();
    const segs = (full.segments ?? []).slice(0, PREVIEW_CUES);
    const lastEnd = segs[segs.length - 1]?.end ?? 0;
    const sample: BatchResult = {
      ...full,
      segments: segs,
      words: full.words?.filter((w) => w.start < lastEnd + 0.05),
      text: segs.map((s) => s.text.trim()).join(" "),
    };
    return generateExport(sample, exportOpts());
  };

  const exportFileName = () => {
    const stem = basename(path).replace(/\.[^.]+$/, "");
    return `${stem}.${EXPORT_EXTENSIONS[exportFormat]}`;
  };

  const doExport = async () => {
    setSaveError(null);
    const ext = EXPORT_EXTENSIONS[exportFormat];
    const stem = basename(path).replace(/\.[^.]+$/, "");
    let target: string | null;
    try {
      target = await pickExportPath(`${stem}.${ext}`, exportFormat.toUpperCase(), ext);
    } catch (e) {
      console.error("export save dialog failed:", e);
      return;
    }
    if (!target) return; // cancelled
    try {
      const contents = generateExport(editedResult(), exportOpts());
      await saveTextFile(target, contents);
    } catch (e) {
      setSaveError(String(e));
      return;
    }
    setSaved(true);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaved(false), 1500);
  };

  // Clear still-pending confirmation timers if the viewer unmounts mid-window.
  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
      window.clearTimeout(saveTimer.current);
    },
    [],
  );

  // ── row callbacks (stable, so SegmentRow's memo holds) ───────────────────
  const onToggleReassign = useCallback((i: number) => {
    setReassignRow((r) => (r === i ? null : i));
  }, []);
  const onReassign = useCallback(
    (i: number, label: string) => {
      const orig = result.segments?.[i]?.speaker;
      setSegmentSpeaker(path, i, label === orig ? null : label);
      setReassignRow(null);
    },
    [path, result],
  );
  const onCommitEdit = useCallback(
    (i: number, text: string) => {
      const t = stripControlChars(text).trim();
      const orig = (result.segments?.[i]?.text ?? "").trim();
      setSegmentEdit(path, i, t && t !== orig ? t : null);
    },
    [path, result],
  );

  const canSeek = !!audioSrc && !audioBroken;

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
            ? "flex-none border-b border-line bg-surface/95 px-6 pb-0.5 pt-4"
            : cn(
                "-mx-5 -mt-5 rounded-t-card border-b border-line bg-surface/95 px-5 pb-0.5 pt-5",
                fill ? "flex-none" : "sticky -top-px z-10 backdrop-blur-md",
              ),
        )}
      >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-label text-faint">
          transcript
          {/* Identity first: same-URL records only differ by when they ran. */}
          {stamp ? (
            <>
              {" · "}
              <span className="text-dim">{stamp}</span>
            </>
          ) : null}
          {fileLabel ? ` · ${fileLabel}` : ""}
          {result.language ? ` · ${result.language}` : ""}
          {result.duration
            ? ` · ${result.duration < 60 ? `${result.duration.toFixed(1)}s` : fmtDurationExact(result.duration)}`
            : ""}
          {hasSpeakers ? ` · ${speakers.length} speakers` : ""}
        </div>
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
          {hasSegments && !editMode && (
            <Button variant="ghost" size="sm" onClick={() => setEditMode(true)}>
              <Pencil className="size-4" />
              Edit
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowExport((v) => !v)}
            aria-expanded={showExport}
          >
            <Download className="size-4" />
            Export
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
              ? `${editCount} correction${editCount === 1 ? "" : "s"} — they apply to Copy and every export`
              : "click a sentence to correct it · click a speaker chip to reassign"}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearEdits(path);
              setEditMode(false);
              setReassignRow(null);
            }}
          >
            Discard
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => {
              setEditMode(false);
              setReassignRow(null);
            }}
          >
            Done
          </Button>
        </div>
      )}

      {audioSrc && !audioBroken && (
        <div className="mb-3 flex items-center gap-3.5 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5">
          {/* key forces a clean reload per file */}
          <audio
            key={blobSrc ?? path}
            ref={audioRef}
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

      {audioNote === "copy" && !audioBroken && (
        <div className="-mt-2 mb-3 px-1 text-[11.5px] text-faint">
          Playing the app's saved copy — the original file was moved or deleted.
        </div>
      )}

      {audioBroken && (
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

      {urlSource && !mediaPath && !audioBroken && (
        <div className="mb-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2 text-[12px] text-dim">
          No audio is stored for this link — run it again to restore playback.
          The transcript and edits still work.
        </div>
      )}

      {hasSegments && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(
            [
              ["Timestamps", showTs, (v: boolean) => { setShowTs(v); persistOptions({ showTimestamps: v }); }, true],
              ["Speaker names", showNames, (v: boolean) => { setShowNames(v); persistOptions({ showSpeakerNames: v }); }, hasSpeakers],
              ["Colors", colorize, (v: boolean) => { setColorize(v); persistOptions({ colorizeSpeakers: v }); }, hasSpeakers],
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

      {hasSpeakers && showNames && (
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

      {showExport && (
        <div
          className={cn(
            "mb-4 rounded-xl border border-line bg-surface-2/60 p-4",
            focus && "mx-6 mt-3 flex-none",
          )}
        >
          {/* Format cards — radio semantics, always visible. */}
          <div role="radiogroup" aria-label="Export format" className="flex gap-2.5">
            {FORMAT_CARDS.map((f) => {
              const on = exportFormat === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setExportFormat(f.value);
                    persistOptions({ exportFormat: f.value });
                  }}
                  className={cn(
                    "ring-signal min-w-0 flex-1 rounded-xl border px-3 py-2 text-left transition-colors",
                    on
                      ? "border-accent/55 bg-accent-soft"
                      : "border-line bg-surface-2 hover:border-line-strong",
                  )}
                >
                  <span
                    className={cn(
                      "block font-mono text-[13px] font-medium",
                      on ? "text-accent" : "text-text",
                    )}
                  >
                    {f.label}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
                    {f.use}
                  </span>
                </button>
              );
            })}
          </div>

          {/* "In this file": the contract. Rows mirror the view toggles
              (clicking flips them, live); impossible rows say why. */}
          <div className="mt-3 rounded-xl border border-line bg-surface/50 px-4 py-2">
            <div className="py-1 font-mono text-[10.5px] uppercase tracking-label text-faint">
              in this file
            </div>
            {exportContract().map((r) => {
              const icon =
                r.state === "na" ? (
                  <Minus className="size-3.5 shrink-0 text-faint" />
                ) : r.state === "off" ? (
                  <Circle className="size-3.5 shrink-0 text-faint" />
                ) : (
                  <Check className="size-3.5 shrink-0 text-ok" />
                );
              const inner = (
                <>
                  {icon}
                  <span
                    className={cn(
                      "shrink-0",
                      r.state === "na"
                        ? "text-faint"
                        : r.state === "off"
                          ? "text-dim"
                          : "text-text",
                    )}
                  >
                    {r.label}
                  </span>
                  <span className="truncate text-[11.5px] text-faint">{r.why}</span>
                </>
              );
              return r.onToggle ? (
                <button
                  key={r.label}
                  type="button"
                  aria-pressed={r.state === "on"}
                  onClick={r.onToggle}
                  className="ring-signal flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-[12.5px]"
                >
                  {inner}
                </button>
              ) : (
                <div
                  key={r.label}
                  className="flex w-full items-center gap-2.5 py-1.5 text-[12.5px]"
                >
                  {inner}
                </div>
              );
            })}
          </div>

          {/* Live preview: the first cues serialized in the real format.
              Grows with its content up to 40vh; the handle below drags it
              as tall as you like. */}
          <pre
            ref={previewRef}
            style={previewH !== null ? { height: previewH, maxHeight: "none" } : undefined}
            className="mt-3 max-h-[40vh] overflow-auto whitespace-pre rounded-xl border border-line bg-surface px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-dim"
          >
            {exportPreview() ?? "No segments to preview."}
          </pre>
          <div className="flex justify-center pt-1.5">
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize preview"
              title="Drag to resize the preview"
              className="h-1.5 w-11 cursor-row-resize touch-none rounded-pill bg-line hover:bg-faint"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                previewDrag.current = {
                  startY: e.clientY,
                  startH: previewRef.current?.getBoundingClientRect().height ?? 176,
                };
              }}
              onPointerMove={(e) => {
                const d = previewDrag.current;
                if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
                setPreviewH(
                  Math.max(96, Math.min(1400, d.startH + (e.clientY - d.startY))),
                );
              }}
              onPointerUp={() => {
                previewDrag.current = null;
              }}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[11.5px] text-faint">
              {exportFileName()}
              {(result.segments?.length ?? 0) > PREVIEW_CUES
                ? ` · first ${PREVIEW_CUES} of ${result.segments?.length} cues`
                : ""}
            </span>
            <span className="flex-1" />
            {editCount > 0 && (
              <span className="font-mono text-[11px] text-faint">
                {editCount} correction{editCount === 1 ? "" : "s"} included
              </span>
            )}
            {saveError && (
              <span className="text-[12px] text-warn">{stripControlChars(saveError)}</span>
            )}
            <Button variant="accent" size="sm" onClick={doExport}>
              {saved ? <Check className="size-4" /> : <Download className="size-4" />}
              {saved ? "Saved" : `Save ${exportFormat.toUpperCase()}`}
            </Button>
          </div>
        </div>
      )}

      {/* `transport::batch` deliberately leaves `text` untouched ("that IS the output"), so
          bidi overrides and other invisible format characters from an untrusted server reach
          this node by design. The Copy button above already strips them; without the same
          treatment here what the user READS can be reordered relative to what they paste. */}
      {!hasSegments ? (
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
          className={cn(
            "select-text overflow-y-auto text-text",
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
            // matter how wide the window is.
            className={focus ? "mx-auto max-w-[72ch] px-6 py-10 text-[15.5px] leading-[1.8]" : undefined}
          >
            {effSegments.slice(0, MAX_SEGMENT_ROWS).map((seg, i) => (
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
                origText={result.segments?.[i]?.text ?? ""}
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

      {audioSrc && !audioBroken && hasSegments && !editMode && (
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

      {!hasSegments && !showFullText && result.text.length > TRANSCRIPT_PREVIEW_CHARS && (
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
