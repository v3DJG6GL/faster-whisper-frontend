import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  UploadCloud, FileAudio, X, Loader2, Copy, Check, Plus, RotateCcw, Download,
  Pencil, Play, Pause, ArrowDownToLine, Circle, Minus,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApp } from "@/lib/store";
import {
  Button, Card, DisclosureToggle, Notice, PageHeader, Select,
  SettingRow, Stepper, Toggle,
} from "@/components/ui";
import { DecodeFields } from "@/components/DecodeFields";
import { LanguageSelect } from "@/components/LanguageSelect";
import { ModelPicker } from "@/components/ModelPicker";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { useBackendModels } from "@/lib/useBackendModels";
import { fmtDuration, fmtTimestamp } from "@/lib/format";
import {
  pickAudioFiles, pickExportPath, readMediaFile, saveTextFile, isTauri,
} from "@/lib/api";
import {
  addFiles, cancelRun, clearEdits, overallFraction, railIndex, railStages,
  removeFile as removeFileAction, resetForInputChange, retryFile, selectPath,
  setRename, setSegmentEdit, setSegmentSpeaker,
  setSpeakerColor as setSpeakerColorAction, startRun,
  useTranscribeRun, STAGE_WEIGHTS,
  type RailStage, type RunContext,
} from "@/lib/transcribeRun";
import {
  loadHistory, useTranscriptHistory, type TranscriptRecord,
} from "@/lib/transcriptHistory";
import { openHistoryRecord } from "@/lib/transcribeRun";
import { backendOptions, effectiveServerUrl } from "@/lib/backends";
import { effectiveServerKind } from "@/lib/serverKind";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import {
  DEFAULT_SPEAKER_COLORS, EXPORT_EXTENSIONS, generateExport,
  type ExportFormat, type ExportOptions,
} from "@/lib/transcriptExport";
import { cn } from "@/lib/cn";
import {
  NO_OVERRIDE_PROFILE,
  type BatchProgress, type BatchResult, type DecodeOverrides, type TranscribeOptions,
} from "@/lib/types";

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

/** Bound the "server ignored N overrides" list too — same untrusted response, same DOM. */
const MAX_IGNORED_SHOWN = 50;

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

/** "today 21:04 · 11m 10s · de · 4 speakers" — the recent-strip meta line. */
function recentMeta(rec: TranscriptRecord): string {
  const d = new Date(rec.createdAt);
  const parts: string[] = [];
  if (!Number.isNaN(d.getTime())) {
    const startOf = (x: Date) =>
      new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
    const day =
      diff <= 0 ? "today" : diff === 1 ? "yesterday" : d.toLocaleDateString();
    parts.push(`${day} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  if (rec.result?.duration) parts.push(fmtDuration(rec.result.duration));
  if (rec.language) parts.push(safeDisplayText(rec.language, 12));
  const spk = rec.result?.speakers?.length ?? 0;
  if (spk > 1) parts.push(`${spk} speakers`);
  return parts.join(" · ");
}

/** Human label for a server progress stage (absent/unknown ⇒ generic). */
function stageLabel(p: BatchProgress | null): string {
  switch (p?.stage) {
    case "waiting":
      return "Waiting for a server slot…";
    case "separating":
      return "Separating music…";
    case "transcribing":
      return "Transcribing…";
    case "diarizing":
      return "Identifying speakers…";
    default:
      return "Transcribing…";
  }
}

/** m:ss-style elapsed time for the rail's stage rows. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Display names + one-line explanations for the rail rows (the stage order
 *  itself lives in transcribeRun.railStages). */
const RAIL_NAMES: Record<RailStage, string> = {
  separating: "Separate music",
  transcribing: "Transcribe",
  diarizing: "Identify speakers",
};
const RAIL_DESCRIPTIONS: Record<RailStage, string> = {
  separating: "Vocals kept, music removed — the transcript decodes from the clean stem.",
  transcribing: "",
  diarizing: "Labels each segment with who is speaking.",
};

/** Remaining-time estimate in ms: linear projection from the current rate,
 *  only once it is stable (≥5% done, ≥10 s elapsed) so it never appears as
 *  a wild early guess. */
function etaMs(frac: number | null, elapsedMs: number): number | null {
  if (frac === null || frac < 0.05 || frac >= 1 || elapsedMs < 10_000) return null;
  return (elapsedMs * (1 - frac)) / frac;
}

/** "about X left", rounded coarsely (5 s under ten minutes, whole minutes
 *  above) so consecutive polls never make the estimate jitter. */
function aboutLeft(ms: number): string {
  const s = Math.max(5, Math.round(ms / 1000 / 5) * 5);
  if (s < 600) {
    const m = Math.floor(s / 60);
    return m > 0
      ? `about ${m}m ${String(s % 60).padStart(2, "0")}s left`
      : `about ${s}s left`;
  }
  return `about ${Math.round(s / 60)}m left`;
}

/** "SPEAKER_00" → "Speaker 1"; anything else verbatim (already bounded by Rust). */
function prettySpeaker(label: string): string {
  const m = /^SPEAKER_(\d+)$/.exec(label);
  return m ? `Speaker ${parseInt(m[1], 10) + 1}` : label;
}

/** Distinct speaker labels of a result, in first-appearance order. */
function speakersOf(result: BatchResult): string[] {
  if (result.speakers?.length) return result.speakers;
  const seen: string[] = [];
  for (const s of result.segments ?? []) {
    if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return seen;
}

export default function Transcribe() {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  // Recent transcripts for the idle-screen strip (full list: History screen).
  const historyRecords = useTranscriptHistory((s) => s.records);
  const recentRecords = useMemo(
    // Files only — dictations belong to the History screen's timeline.
    () => historyRecords.filter((r) => r.status === "done" && r.kind !== "dictation").slice(0, 3),
    [historyRecords],
  );
  useEffect(() => {
    void loadHistory();
  }, []);

  // Backend/model/language picks persist in settings.transcribe (they were
  // component state before, so leaving the screen reset them). The saved pick
  // only applies while that backend still exists; model/language ride on it.
  const savedBackend =
    settings.transcribe?.backendId &&
    backends.some((b) => b.id === settings.transcribe?.backendId)
      ? settings.transcribe.backendId
      : undefined;
  const [backendId, setBackendId] = useState(savedBackend ?? backends[0]?.id ?? "");
  const [language, setLanguage] = useState(
    (savedBackend ? settings.transcribe?.language : undefined) ??
      backends.find((b) => b.id === (savedBackend ?? backends[0]?.id))?.language ??
      "auto",
  );
  // "" = use the Backend's configured model; anything else is a per-run pick
  // from the models the server advertised on the last connection test.
  const [model, setModel] = useState(savedBackend ? (settings.transcribe?.model ?? "") : "");
  // Run state lives in the transcribeRun store so it (and the pump driving
  // it) survives this screen unmounting on a tab switch.
  const files = useTranscribeRun((s) => s.files);
  const queue = useTranscribeRun((s) => s.queue);
  const selectedPath = useTranscribeRun((s) => s.selectedPath);
  const progress = useTranscribeRun((s) => s.progress);
  const stageTimes = useTranscribeRun((s) => s.stageTimes);
  const stageMeta = useTranscribeRun((s) => s.stageMeta);
  const renames = useTranscribeRun((s) => s.renames);
  const speakerColors = useTranscribeRun((s) => s.speakerColors);
  const edits = useTranscribeRun((s) => s.edits);
  const speakerEdits = useTranscribeRun((s) => s.speakerEdits);
  const lastOptions = useTranscribeRun((s) => s.lastOptions);
  const [copied, setCopied] = useState(false);
  // Reset per result, so a new (possibly huge) transcript starts collapsed again.
  const [showFullText, setShowFullText] = useState(false);
  // Per-run stage options, seeded from the persisted screen defaults.
  const [diarize, setDiarize] = useState(() => settings.transcribe?.diarize ?? false);
  const [numSpeakers, setNumSpeakers] = useState(() => settings.transcribe?.numSpeakers ?? 0);
  const [translate, setTranslate] = useState(() => settings.transcribe?.translate ?? false);
  const [separateBgm, setSeparateBgm] = useState(() => settings.transcribe?.separateBgm ?? false);
  // Per-RUN decode overrides layered over the Backend's stored defaults —
  // deliberately not persisted: this is "for this file, try beam 5", not a
  // settings edit (those live on the Backend / Profile editors).
  const [runOverrides, setRunOverrides] = useState<DecodeOverrides>({});
  // Per-run server override-profile pick; "" = inherit the Backend's. Same
  // not-persisted contract as runOverrides.
  const [runOverrideProfile, setRunOverrideProfile] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Export panel state, seeded from the persisted screen defaults.
  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(
    () => settings.transcribe?.exportFormat ?? "srt",
  );
  const [wordTs, setWordTs] = useState(() => settings.transcribe?.wordTimestamps ?? false);
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
  // Built-in playback with karaoke follow.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [audioLen, setAudioLen] = useState(0);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  const [audioBroken, setAudioBroken] = useState(false);
  // Blob-URL fallback when the asset protocol can't feed the media stack
  // (Linux WebKitGTK). Revoked on file change/unmount.
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const blobTriedRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // The "Copied" confirmation timer. Held in a ref so a rapid second Copy click clears the first
  // timer before re-arming — otherwise the stale timer fires mid-window and flips the label off
  // early (every other transient timer in the app is cleared the same way).
  const copyTimer = useRef<number | undefined>(undefined);
  // Prevents a double-click from opening two native file dialogs.
  const picking = useRef(false);

  // The store boots with a seeded backend, then config hydration (and later edits/removals)
  // can replace the list with different ids. Re-sync the selection when the current id falls
  // out of the list, so the Backend dropdown and language don't reference a backend that's gone.
  useEffect(() => {
    if (backends.length && !backends.some((b) => b.id === backendId)) {
      setBackendId(backends[0].id);
      setLanguage(backends[0].language ?? "auto");
    }
  }, [backends, backendId]);

  const backend = backends.find((b) => b.id === backendId) ?? backends[0];
  const serverKind = backend ? effectiveServerKind(backend, connections[backend.id]) : "unknown";
  // "unknown" must never gate (serverKind.ts contract) — only a PROVEN
  // standard server hides the full-backend-only stages.
  const isStandard = serverKind === "standard";

  // Capability gate + inherited baseline for the per-run decode editor —
  // the same context the Backend/Profile editors use.
  const { caps, resolved } = useOverrideContext({
    serverUrl: backend ? effectiveServerUrl(backend, settings) : "",
    backendId: backend?.id,
    profileName: backend?.overrideProfile ?? undefined,
    serverKind,
  });
  // What a blank per-run field inherits: profile baseline, overridden by the
  // Backend's stored decode defaults (the Profiles editor's merge precedent).
  const inheritedBaseline = { ...resolved, ...backend?.decodeOverrides };

  // Per-run model pick: "" = backend default. The advertised list comes from
  // the shared hook (session connection cache + one background probe).
  const advertised = useBackendModels(backend);

  const busy = queue.some((it) => it.status === "running" || it.status === "queued");

  // 1 s heartbeat while a run is active, so the rail's elapsed times count
  // even when no server poll lands (standard servers, waiting stages).
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // A newly selected (possibly huge) transcript starts collapsed again —
  // also covers the pump auto-following the latest finished file.
  useEffect(() => {
    setShowFullText(false);
  }, [selectedPath]);
  const doneCount = queue.filter((it) => it.status === "done").length;
  const selected = queue.find((it) => it.path === selectedPath && it.status === "done");
  const result = selected?.result ?? null;

  const persistOptions = (patch: Partial<NonNullable<typeof settings.transcribe>>) => {
    updateSettings({ transcribe: { ...settings.transcribe, ...patch } });
  };

  const clearCopied = () => {
    setCopied(false);
    if (copyTimer.current) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = undefined;
    }
  };

  const choose = async () => {
    if (picking.current || busy) return;
    picking.current = true;
    let paths: string[];
    try {
      paths = await pickAudioFiles();
    } catch (e) {
      console.error("pick audio files failed:", e);
      return;
    } finally {
      picking.current = false;
    }
    if (paths.length) {
      clearCopied();
      addFiles(paths); // changed inputs abandon any settled results
    }
  };

  const removeFile = (path: string) => {
    if (busy) return;
    clearCopied();
    removeFileAction(path);
  };

  /** Everything the detached pump needs, frozen at run/retry time. */
  const buildCtx = (overrides: DecodeOverrides): RunContext | null => {
    if (!backend) return null;
    // Per-run overrides win over the Backend's stored defaults.
    const merged = { ...backend.decodeOverrides, ...overrides };
    return {
      backendId: backend.id,
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      model: model || backend.model,
      language,
      // Empty backend prompt = inherit the server DEFAULT_PROMPT → omit the field.
      prompt: backend.prompt || undefined,
      decodeOverrides: Object.keys(merged).length ? merged : undefined,
      // Per-run pick wins ("" = inherit); NO_OVERRIDE_PROFILE passes through
      // verbatim (it forces "no profile" server-side).
      overrideProfile: runOverrideProfile || backend.overrideProfile,
      standard:
        effectiveServerKind(backend, useApp.getState().connections[backend.id]) === "standard",
    };
  };

  const run = () => {
    if (!files.length || !backend || busy) return;
    clearCopied();
    setShowFullText(false);
    const options: TranscribeOptions | undefined =
      diarize || translate || separateBgm
        ? {
            ...(translate
              ? { task: "translate" as const, useTranslationsEndpoint: isStandard }
              : {}),
            ...(diarize && !isStandard
              ? { diarize: true, ...(numSpeakers > 0 ? { numSpeakers } : {}) }
              : {}),
            ...(separateBgm && !isStandard ? { separateBgm: true } : {}),
          }
        : undefined;
    const ctx = buildCtx(runOverrides);
    if (ctx) startRun(options, runOverrides, ctx);
  };

  const retry = (path: string) => {
    if (busy) return;
    const ctx = buildCtx(useTranscribeRun.getState().lastOverrides);
    if (ctx) retryFile(path, ctx);
  };

  // ── selected-result derivations ──────────────────────────────────────────
  const speakers = result ? speakersOf(result) : [];
  const hasSegments = !!result?.segments?.length;
  const hasSpeakers = speakers.length > 0;
  const fileRenames = (selectedPath && renames[selectedPath]) || {};
  const fileColors = (selectedPath && speakerColors[selectedPath]) || {};
  const displayName = (label: string) =>
    safeDisplayText(fileRenames[label]?.trim() || prettySpeaker(label));
  // User-picked palette index first, else first-appearance order — the chips
  // (via theme tokens) and the exported SRT/VTT (via hexes) stay in step.
  const colorIdxOf = (label: string) =>
    fileColors[label] ??
    Math.max(0, speakers.indexOf(label)) % DEFAULT_SPEAKER_COLORS.length;
  const colorOf = (label: string) => `var(--spk-${colorIdxOf(label) + 1})`;

  const setSpeakerColor = (label: string, idx: number) => {
    if (selectedPath) setSpeakerColorAction(selectedPath, label, idx);
  };

  const commitRename = () => {
    if (editingSpeaker && selectedPath) {
      setRename(selectedPath, editingSpeaker, stripControlChars(renameDraft).trim());
    }
    setEditingSpeaker(null);
  };

  // Corrections layered over the server transcript — the segments every
  // surface renders, copies and exports.
  const fileEdits = (selectedPath && edits[selectedPath]) || {};
  const fileSpkEdits = (selectedPath && speakerEdits[selectedPath]) || {};
  const editCount = Object.keys(fileEdits).length + Object.keys(fileSpkEdits).length;
  const effSegments = useMemo(
    () =>
      (result?.segments ?? []).map((seg, i) => ({
        ...seg,
        text: fileEdits[i] ?? seg.text,
        speaker: fileSpkEdits[i] ?? seg.speaker,
        edited: fileEdits[i] !== undefined || fileSpkEdits[i] !== undefined,
      })),
    [result, fileEdits, fileSpkEdits],
  );

  // Word index ranges per segment (karaoke + word-level exports). One pass:
  // words arrive time-ordered; each word belongs to the first segment whose
  // window it falls into.
  const segWordRanges = useMemo(() => {
    const words = result?.words ?? [];
    const segs = result?.segments ?? [];
    let wi = 0;
    return segs.map((seg) => {
      while (wi < words.length && words[wi].start < seg.start - 0.05) wi++;
      const from = wi;
      while (wi < words.length && words[wi].start < seg.end + 0.05) wi++;
      return [from, wi] as const;
    });
  }, [result]);

  /** The result with corrections applied — what Save writes. Words of a
   *  text-edited segment are dropped (their timings no longer match). */
  const editedResult = (): BatchResult => {
    if (!result) return { text: "" };
    if (!editCount) return result;
    const segs = effSegments.map(({ edited: _edited, ...seg }) => seg);
    const textEdited = new Set(Object.keys(fileEdits).map(Number));
    const words = (result.words ?? []).filter((_w, wi) =>
      !segWordRanges.some(([from, to], si) => textEdited.has(si) && wi >= from && wi < to),
    );
    return {
      ...result,
      text: segs.map((seg) => seg.text.trim()).join(" "),
      segments: segs,
      ...(words.length ? { words } : { words: [] }),
    };
  };

  const copyText = (): string => {
    if (!result) return "";
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
  // The picked file plays straight from disk via the asset protocol; word
  // timestamps drive the highlight (timeupdate ticks a few times a second).
  const audioSrc = useMemo(
    () => (selectedPath && isTauri ? convertFileSrc(selectedPath) : undefined),
    [selectedPath],
  );

  useEffect(() => {
    // New file: stop playback, forget position/errors, re-arm follow.
    setPlaying(false);
    setCurTime(0);
    setAudioLen(0);
    setAudioBroken(false);
    setFollow(true);
    setEditMode(false);
    setReassignRow(null);
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = null;
    blobTriedRef.current = false;
    setBlobSrc(null);
  }, [selectedPath]);
  useEffect(
    () => () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    },
    [],
  );

  /** The <audio> errored on the asset URL — buffer the file through Rust and
   *  retry from a blob once; a second failure means the webview genuinely
   *  can't decode this codec, so surface that instead of hiding the player. */
  const onAudioError = () => {
    if (blobTriedRef.current || !selectedPath) {
      setAudioBroken(true);
      return;
    }
    blobTriedRef.current = true;
    readMediaFile(selectedPath)
      .then((buf) => {
        const url = URL.createObjectURL(new Blob([buf], { type: mediaMime(selectedPath) }));
        blobUrlRef.current = url;
        setBlobSrc(url);
      })
      .catch((e) => {
        console.error("playback blob fallback failed:", e);
        setAudioBroken(true);
      });
  };

  const seekTo = (t: number) => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(t)) return;
    a.currentTime = Math.max(0, Math.min(audioLen || t, t));
    setCurTime(a.currentTime);
  };

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

  // Current segment / word under the playhead (words are time-ordered).
  const activeSegIdx = useMemo(() => {
    if (!playing && curTime === 0) return -1;
    const segs = result?.segments ?? [];
    for (let i = segs.length - 1; i >= 0; i--) {
      if (curTime >= segs[i].start) return curTime < segs[i].end + 0.3 ? i : -1;
    }
    return -1;
  }, [result, curTime, playing]);
  const activeWordIdx = useMemo(() => {
    const words = result?.words ?? [];
    let lo = 0;
    let hi = words.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= curTime) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best >= 0 && curTime < (words[best].end ?? 0) + 0.4 ? best : -1;
  }, [result, curTime]);

  // Follow: keep the active row centred while playing; any manual wheel
  // scroll disarms it (the chip re-arms).
  useEffect(() => {
    if (!follow || !playing || activeSegIdx < 0) return;
    document
      .getElementById(`seg-row-${activeSegIdx}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeSegIdx, follow, playing]);
  useEffect(() => {
    if (!playing || !follow) return;
    const disarm = () => setFollow(false);
    window.addEventListener("wheel", disarm, { passive: true });
    window.addEventListener("touchmove", disarm, { passive: true });
    return () => {
      window.removeEventListener("wheel", disarm);
      window.removeEventListener("touchmove", disarm);
    };
  }, [playing, follow]);

  // Space play/pause, arrows ±5 s — never while typing somewhere.
  useEffect(() => {
    if (!audioSrc || !result) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(curTime - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(curTime + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(stripControlChars(copyText()));
    } catch (e) {
      console.error("clipboard copy failed:", e); // don't flash "Copied" if the write failed
      return;
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
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
    const hasWords = !!result?.words?.length;
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

  /** First cues of the ACTUAL file, re-serialized on every card/toggle
   *  change — the panel's answer to "what am I getting?". */
  const exportPreview = (): string | null => {
    if (!result?.segments?.length) return null;
    const full = editedResult();
    const segs = (full.segments ?? []).slice(0, 3);
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
    const stem = selectedPath ? basename(selectedPath).replace(/\.[^.]+$/, "") : "transcript";
    return `${stem}.${EXPORT_EXTENSIONS[exportFormat]}`;
  };

  const doExport = async () => {
    if (!result || !selectedPath) return;
    setSaveError(null);
    const ext = EXPORT_EXTENSIONS[exportFormat];
    const stem = basename(selectedPath).replace(/\.[^.]+$/, "");
    let path: string | null;
    try {
      path = await pickExportPath(`${stem}.${ext}`, exportFormat.toUpperCase(), ext);
    } catch (e) {
      console.error("export save dialog failed:", e);
      return;
    }
    if (!path) return; // cancelled
    try {
      const contents = generateExport(editedResult(), exportOpts());
      await saveTextFile(path, contents);
    } catch (e) {
      setSaveError(String(e));
      return;
    }
    setSaved(true);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaved(false), 1500);
  };

  // Clear still-pending confirmation timers if the screen unmounts mid-window.
  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
      window.clearTimeout(saveTimer.current);
    },
    [],
  );

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <PageHeader eyebrow="batch" title="Transcribe a file">
        Send audio or video files to one of your backends via the batch endpoint.
      </PageHeader>

      {files.length ? (
        <div className="mt-8 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-8">
          <div className="flex max-w-full flex-wrap items-center justify-center gap-3">
            {files.map((path) => (
              <div
                key={path}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3"
              >
                <FileAudio className="size-5 shrink-0 text-accent" />
                <span className="max-w-[300px] truncate text-[13px] text-text">{basename(path)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${basename(path)}`}
                  disabled={busy}
                  onClick={() => removeFile(path)}
                  className="ring-signal grid size-6 place-items-center rounded-lg text-faint transition-colors hover:text-rec disabled:opacity-40"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={choose}
            disabled={busy}
            className="ring-signal mt-4 inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text disabled:opacity-40"
          >
            <Plus className="size-3.5" /> Add more files
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={choose}
          className="ring-signal mt-8 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-12 text-center transition-colors hover:border-faint"
        >
          <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-faint">
            <UploadCloud className="size-6" />
          </div>
          <div className="mt-4 text-[14px] text-text">Choose files to transcribe</div>
          <div className="mt-1 text-[12.5px] text-dim">Audio or video — wav, mp3, m4a, ogg, webm, flac…</div>
        </button>
      )}

      {/* Recent transcripts, one click from the idle screen (VS Code's
          dual-access recents: short list here, full History screen a click
          away). Finished runs land in the history automatically. */}
      {!files.length && !queue.length && recentRecords.length > 0 && (
        <Card className="mt-6 px-5 py-1">
          <div className="flex items-baseline gap-2 py-2">
            <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">
              recent
            </span>
            <span className="flex-1" />
            <Link to="/history" className="ring-signal rounded text-[12px] text-accent">
              All history →
            </Link>
          </div>
          {recentRecords.map((rec, i) => (
            <div
              key={rec.id}
              className={cn(
                "flex items-center gap-3 py-2.5",
                i < recentRecords.length - 1 && "border-b border-line",
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
                <Check className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                {safeDisplayText(rec.sourceName, 120)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {recentMeta(rec)}
              </span>
              <Button variant="ghost" size="sm" onClick={() => openHistoryRecord(rec)}>
                Open
              </Button>
            </div>
          ))}
        </Card>
      )}

      <div className="mt-6 grid grid-cols-3 gap-4">
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Backend</label>
          <Select
            ariaLabel="Backend"
            value={backendId}
            onChange={(v) => {
              // A backend change is an input change: abandon any in-flight run + clear stale
              // results, else the prior backend's transcript/error shows under the new selection.
              clearCopied();
              resetForInputChange();
              setBackendId(v);
              setModel(""); // a per-run model pick belongs to ONE backend
              setRunOverrideProfile(""); // so does a server-profile name
              const b = backends.find((x) => x.id === v);
              const lang = b?.language ?? "auto";
              if (b) setLanguage(lang);
              persistOptions({ backendId: v, model: "", language: lang });
            }}
            options={backendOptions(backends)}
          />
        </div>
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Model</label>
          <ModelPicker
            ariaLabel="Model"
            value={model}
            onChange={(v) => {
              clearCopied();
              resetForInputChange();
              setModel(v);
              persistOptions({ backendId, model: v });
            }}
            models={advertised}
            defaultLabel={backend?.model ? `Default · ${backend.model}` : "Default · server model"}
          />
        </div>
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Language</label>
          <LanguageSelect
            ariaLabel="Language"
            value={language}
            onChange={(v) => {
              clearCopied();
              resetForInputChange();
              setLanguage(v);
              persistOptions({ backendId, language: v });
            }}
          />
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-2.5 font-mono text-[11px] uppercase tracking-label text-faint">processing</div>
        <Card className="px-5 py-1">
          {!isStandard && (
            <SettingRow
              title="Speaker diarization"
              desc="Label who is speaking in each segment. Runs on the server after transcription."
            >
              <div className="flex items-center gap-4">
                {diarize && (
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-dim">Speakers</span>
                    <Stepper
                      value={numSpeakers}
                      onChange={(v) => {
                        setNumSpeakers(v);
                        persistOptions({ numSpeakers: v });
                      }}
                      min={0}
                      max={32}
                      zeroLabel="auto"
                      ariaLabel="Expected speakers"
                    />
                  </div>
                )}
                <Toggle
                  checked={diarize}
                  ariaLabel="Speaker diarization"
                  onChange={(v) => {
                    setDiarize(v);
                    persistOptions({ diarize: v });
                  }}
                />
              </div>
            </SettingRow>
          )}
          <SettingRow
            title="Translate to English"
            desc="Whisper's translate task instead of transcribing in the source language."
            last={isStandard}
          >
            <Toggle
              checked={translate}
              ariaLabel="Translate to English"
              onChange={(v) => {
                setTranslate(v);
                persistOptions({ translate: v });
              }}
            />
          </SettingRow>
          {!isStandard && (
            <SettingRow
              title="Separate background music"
              desc="Strip music before transcribing (UVR). Adds processing time per file."
              last
            >
              <Toggle
                checked={separateBgm}
                ariaLabel="Separate background music"
                onChange={(v) => {
                  setSeparateBgm(v);
                  persistOptions({ separateBgm: v });
                }}
              />
            </SettingRow>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <DisclosureToggle open={showOverrides} onToggle={() => setShowOverrides((v) => !v)}>
          Decode overrides
          {Object.keys(runOverrides).length > 0 && (
            <span className="text-faint"> · {Object.keys(runOverrides).length} set for this run</span>
          )}
          {runOverrideProfile && (
            <span className="text-faint"> · server profile set for this run</span>
          )}
        </DisclosureToggle>
        {showOverrides && (
          <Card className="mt-3 p-5">
            <p className="mb-4 text-[12.5px] text-dim">
              Only for this run — your Backend and Profile defaults are untouched. Empty = inherit.
            </p>
            <DecodeFields
              value={runOverrides}
              onChange={setRunOverrides}
              inherited={inheritedBaseline}
              serverKind={serverKind}
              canCustomize={caps?.can_request_decode_overrides}
            />
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-3 text-[12px] font-medium text-dim">
                Server override profile{" "}
                <span className="text-faint">· only for this run — empty inherits the backend</span>
              </div>
              <OverrideProfilePicker
                serverUrl={backend ? effectiveServerUrl(backend, settings) : ""}
                backendId={backend?.id ?? ""}
                serverKind={serverKind}
                canRequest={caps?.can_request_override_profile}
                value={runOverrideProfile}
                inheritLabel={
                  !backend?.overrideProfile
                    ? "Backend default"
                    : backend.overrideProfile === NO_OVERRIDE_PROFILE
                      ? "Backend default · none"
                      : `Backend default · ${safeDisplayText(backend.overrideProfile, 40)}`
                }
                onChange={(v) => setRunOverrideProfile(v.trim() ? v : "")}
              />
            </div>
          </Card>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button variant="accent" disabled={!files.length || busy || !isTauri} onClick={run}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy
            ? "Transcribing…"
            : files.length > 1
              ? `Transcribe ${files.length} files`
              : "Transcribe"}
        </Button>
        {busy && queue.length > 1 && (
          <span className="font-mono text-[11px] text-faint">
            {doneCount} of {queue.length} done
          </span>
        )}
        {!isTauri && <span className="text-[12px] text-faint">Available in the desktop app.</span>}
      </div>

      {busy && (() => {
        // Run-detail panel (per the approved design canvas): identity plus an
        // overall pipeline bar segmented at the stage boundaries, then one
        // instrumented row per stage — %, elapsed, ~left, throughput, model +
        // device chips, the decoder's live tail, and the diarizer's current
        // step. "unknown" polls never overwrite a known stage, so the panel
        // only ever moves forward; until the first poll answers, the first
        // stage counts as active.
        const stages = railStages(lastOptions);
        const active = progress?.stage ? railIndex(progress.stage, stages) : 0;
        const now = Date.now();
        const runningItem = queue.find((it) => it.status === "running") ?? null;
        const fileIdx = queue.findIndex((it) => it.status === "running");
        const overall = overallFraction({ queue, progress, lastOptions }) ?? 0;
        const starts = Object.values(stageTimes).map((t) => t.start);
        const runElapsed = starts.length ? now - Math.min(...starts) : 0;
        const audioDur = progress?.duration ?? null;
        const doneItems = queue.filter((it) => it.status === "done");
        const queuedCount = queue.filter((it) => it.status === "queued").length;
        // Whole-run estimate: the current file's projection plus the average
        // measured wall time of the finished files for each queued one.
        const curLeft = etaMs(overall, runElapsed);
        const tooks = doneItems.map((it) => it.tookMs).filter((t): t is number => !!t);
        const avgTook = tooks.length ? tooks.reduce((a, b) => a + b, 0) / tooks.length : null;
        const runLeft =
          queuedCount > 0 && avgTook !== null && curLeft !== null
            ? curLeft + avgTook * queuedCount
            : null;
        return (
          <Card className="mt-4 px-5 py-4">
            <div className="flex items-center gap-3">
              <FileAudio className="size-[18px] shrink-0 text-accent" />
              <span className="min-w-0 truncate text-[13.5px] font-medium text-text">
                {runningItem ? basename(runningItem.path) : "Preparing…"}
              </span>
              {audioDur ? (
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {fmtDuration(audioDur)} audio
                </span>
              ) : null}
              <span className="flex-1" />
              <span className="font-mono text-[18px] font-medium tabular-nums text-accent">
                {Math.round(overall * 100)}%
              </span>
              <Button variant="default" size="sm" onClick={cancelRun}>
                Cancel
              </Button>
            </div>

            <div className="mt-3.5 flex gap-1">
              {stages.map((st, i) => {
                const frac =
                  i < active ? 1
                    : i === active && typeof progress?.progress === "number" ? progress.progress
                      : 0;
                return (
                  <div
                    key={st}
                    className="h-1.5 overflow-hidden rounded-pill bg-surface-2"
                    style={{ flexGrow: STAGE_WEIGHTS[st], flexBasis: 0 }}
                  >
                    {frac > 0 && (
                      <div
                        className={cn(
                          "h-full rounded-pill transition-[width] duration-500",
                          i < active ? "bg-ok" : "bg-accent",
                        )}
                        style={{ width: `${Math.max(2, Math.round(frac * 100))}%` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex items-baseline justify-between font-mono text-[11px] tabular-nums text-faint">
              <span>
                {queue.length > 1 && fileIdx >= 0 ? `file ${fileIdx + 1} of ${queue.length}` : "\u00a0"}
              </span>
              <span>
                elapsed <span className="text-dim">{fmtElapsed(runElapsed)}</span>
                {curLeft !== null ? <> · <span className="text-text">{aboutLeft(curLeft)}</span></> : null}
              </span>
            </div>

            <div className="mt-3 border-t border-line">
              {stages.map((st, i) => {
                const state = i < active ? "done" : i === active ? "active" : "pending";
                const frac =
                  state === "active" && typeof progress?.progress === "number"
                    ? progress.progress
                    : null;
                const waiting = state === "active" && progress?.stage === "waiting";
                const time = stageTimes[st];
                const meta = stageMeta[st];
                const stageElapsedMs =
                  state === "active" && time ? now - time.start
                    : state === "done" && time?.end ? time.end - time.start
                      : null;
                const stageLeft =
                  state === "active" && stageElapsedMs !== null ? etaMs(frac, stageElapsedMs) : null;
                // ×-realtime: live from the decoded position; finished stages
                // from the audio duration once the decoder reports it.
                const speed =
                  st === "transcribing" && state === "active" && progress?.position &&
                  stageElapsedMs && stageElapsedMs > 5000
                    ? progress.position / (stageElapsedMs / 1000)
                    : state === "done" && audioDur && stageElapsedMs
                      ? audioDur / (stageElapsedMs / 1000)
                      : null;
                return (
                  <div
                    key={st}
                    className={cn(
                      "flex gap-3.5 border-b border-line py-3.5 last:border-b-0",
                      state === "pending" && "opacity-55",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full font-mono text-[11px]",
                        state === "done" && "bg-ok/15 text-ok",
                        state === "active" && "bg-accent-soft text-accent",
                        state === "pending" && "bg-surface-2 text-faint",
                      )}
                    >
                      {state === "done" ? (
                        <Check className="size-3.5" />
                      ) : state === "active" && frac === null ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            "text-[13px] font-medium",
                            state === "active" ? "text-text" : "text-dim",
                          )}
                        >
                          {RAIL_NAMES[st]}
                          {waiting && (
                            <span className="font-normal text-faint"> — waiting for a server slot…</span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                          {state === "done" && "done"}
                          {frac !== null && (
                            <span className="text-text">{Math.round(frac * 100)}%</span>
                          )}
                          {st === "diarizing" && state === "active" && progress?.step
                            ? ` · ${safeDisplayText(progress.step)}`
                            : ""}
                          {st === "transcribing" && state === "active" && progress?.position && audioDur
                            ? ` · ${fmtDuration(progress.position)} of ${fmtDuration(audioDur)} audio`
                            : ""}
                        </span>
                      </div>
                      {RAIL_DESCRIPTIONS[st] && state === "pending" && (
                        <div className="mt-0.5 text-[12px] text-dim">{RAIL_DESCRIPTIONS[st]}</div>
                      )}
                      {frac !== null && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-pill bg-surface-2">
                          <div
                            className="h-full rounded-pill bg-accent transition-[width] duration-500"
                            style={{ width: `${Math.max(2, Math.round(frac * 100))}%` }}
                          />
                        </div>
                      )}
                      {(meta || stageElapsedMs !== null) && (
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <span className="flex flex-wrap gap-1.5">
                            {meta?.model && (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                {safeDisplayText(meta.model)}
                              </span>
                            )}
                            {meta?.device && (
                              <span
                                className={cn(
                                  "rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px]",
                                  meta.device === "cuda" ? "text-ok" : "text-warn",
                                )}
                              >
                                {safeDisplayText(meta.device)}
                                {meta.compute ? ` · ${safeDisplayText(meta.compute)}` : ""}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                            {stageElapsedMs !== null
                              ? state === "done"
                                ? fmtElapsed(stageElapsedMs)
                                : `running ${fmtElapsed(stageElapsedMs)}`
                              : ""}
                            {speed ? ` · ${speed.toFixed(1)}× realtime` : ""}
                            {stageLeft !== null ? ` · ${aboutLeft(stageLeft)}` : ""}
                          </span>
                        </div>
                      )}
                      {st === "transcribing" && state === "active" && progress?.lastText && (
                        <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-surface-2/60 px-3 py-1.5">
                          <span className="size-[7px] shrink-0 rounded-full bg-live" />
                          {progress.position ? (
                            <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                              {fmtTimestamp(progress.position)}
                            </span>
                          ) : null}
                          <span className="min-w-0 truncate text-[12px] text-dim">
                            {safeDisplayText(progress.lastText)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {queue.length > 1 && (
              <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3 font-mono text-[11px] tabular-nums text-faint">
                <span>
                  {doneItems.length} done · {queuedCount} queued
                </span>
                {runLeft !== null && (
                  <span>
                    whole run: <span className="text-text">{aboutLeft(runLeft)}</span>
                  </span>
                )}
              </div>
            )}
          </Card>
        );
      })()}

      {queue.length > 1 && (
        <Card className="mt-6 px-5 py-1">
          {queue.map((it, i) => (
            <div
              key={it.path}
              className={cn(
                "flex items-center gap-3 py-3",
                i < queue.length - 1 && "border-b border-line",
              )}
            >
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full",
                  it.status === "done" && "bg-ok/15 text-ok",
                  it.status === "running" && "bg-think/15 text-think",
                  it.status === "failed" && "bg-rec/15 text-rec",
                  (it.status === "queued" || it.status === "cancelled") && "bg-surface-2 text-faint",
                )}
              >
                {it.status === "done" ? (
                  <Check className="size-3.5" />
                ) : it.status === "running" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : it.status === "failed" ? (
                  <X className="size-3.5" />
                ) : (
                  <span className="font-mono text-[11px]">{i + 1}</span>
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  it.status === "cancelled" ? "text-faint line-through" : "text-text",
                )}
              >
                {basename(it.path)}
              </span>
              {it.status === "done" && it.result && (
                <span className="font-mono text-[11px] text-faint">
                  {it.result.duration
                    ? it.result.duration < 60
                      ? `${it.result.duration.toFixed(0)}s`
                      : fmtDuration(it.result.duration)
                    : ""}
                  {it.result.language ? ` · ${it.result.language}` : ""}
                  {speakersOf(it.result).length
                    ? ` · ${speakersOf(it.result).length} speakers`
                    : ""}
                </span>
              )}
              {it.status === "running" && (
                <span className="font-mono text-[11px] text-think">
                  {typeof progress?.progress === "number"
                    ? `${Math.round(progress.progress * 100)}%`
                    : stageLabel(progress).toLowerCase()}
                </span>
              )}
              {it.status === "cancelled" && (
                <span className="font-mono text-[11px] text-faint">cancelled</span>
              )}
              {it.status === "failed" && (
                <>
                  <span
                    className="max-w-[240px] truncate font-mono text-[11px] text-rec"
                    title={stripControlChars(it.error ?? "")}
                  >
                    {stripControlChars(it.error ?? "failed")}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => retry(it.path)} disabled={busy}>
                    <RotateCcw className="size-3.5" /> Retry
                  </Button>
                </>
              )}
              {it.status === "done" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(it.path === selectedPath && "text-accent")}
                  onClick={() => {
                    selectPath(it.path);
                    setShowFullText(false);
                  }}
                >
                  {it.path === selectedPath ? "Viewing" : "View"}
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      {queue.length === 1 && queue[0].status === "failed" && (
        <Notice className="mt-6">{stripControlChars(queue[0].error ?? "Transcription failed.")}</Notice>
      )}

      {result && (
        <Card className="mt-6 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-[11px] uppercase tracking-label text-faint">
              transcript
              {queue.length > 1 && selectedPath ? ` · ${basename(selectedPath)}` : ""}
              {result.language ? ` · ${result.language}` : ""}
              {result.duration
                ? ` · ${result.duration < 60 ? `${result.duration.toFixed(1)}s` : fmtDuration(result.duration)}`
                : ""}
              {hasSpeakers ? ` · ${speakers.length} speakers` : ""}
            </div>
            <div className="flex items-center gap-2">
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
                variant="default"
                size="sm"
                onClick={() => setShowExport((v) => !v)}
                aria-expanded={showExport}
              >
                <Download className="size-4" />
                Export
              </Button>
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
                  if (selectedPath) clearEdits(selectedPath);
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
                key={blobSrc ?? selectedPath ?? "none"}
                ref={audioRef}
                src={blobSrc ?? audioSrc}
                preload="metadata"
                onLoadedMetadata={(e) => {
                  setAudioLen(e.currentTarget.duration || 0);
                  e.currentTarget.playbackRate = rate;
                }}
                onTimeUpdate={(e) => setCurTime(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onError={onAudioError}
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

          {audioBroken && (
            <div className="mb-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2 text-[12px] text-dim">
              Playback isn't available for this file — the app couldn't decode it
              (missing audio codec in the system webview).
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

          {showExport && (
            <div className="mb-4 rounded-xl border border-line bg-surface-2/60 p-4">
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

              {/* Live preview: the first cues serialized in the real format. */}
              <pre className="mt-3 max-h-44 overflow-auto whitespace-pre rounded-xl border border-line bg-surface px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-dim">
                {exportPreview() ?? "No segments to preview."}
              </pre>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="font-mono text-[11.5px] text-faint">{exportFileName()}</span>
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

          {hasSpeakers && showNames && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-3">
              {speakers.map((label) => {
                const color = colorOf(label);
                return editingSpeaker === label ? (
                  <span key={label} className="inline-flex items-center gap-2">
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
                      className="ring-signal h-7 w-36 rounded-pill border bg-surface-2 px-3 text-[12px] text-text outline-none"
                      // The border tracks the speaker's own color (live, so
                      // picking a swatch recolors it immediately).
                      style={{ borderColor: `color-mix(in srgb, ${color} 55%, transparent)` }}
                    />
                    <span className="inline-flex items-center gap-1">
                      {DEFAULT_SPEAKER_COLORS.map((_, idx) => (
                        <button
                          key={idx}
                          type="button"
                          title="Use this color"
                          aria-label={`Color ${prettySpeaker(label)} ${idx + 1}`}
                          // preventDefault keeps focus in the rename input, so
                          // picking a color doesn't blur-commit and close it.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setSpeakerColor(label, idx)}
                          className={cn(
                            "size-4 rounded-full transition-transform hover:scale-110",
                            colorIdxOf(label) === idx &&
                              "ring-2 ring-text/60 ring-offset-1 ring-offset-surface",
                          )}
                          style={{ backgroundColor: `var(--spk-${idx + 1})` }}
                        />
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

          {/* `transport::batch` deliberately leaves `text` untouched ("that IS the output"), so
              bidi overrides and other invisible format characters from an untrusted server reach
              this node by design. The Copy button above already strips them; without the same
              treatment here what the user READS can be reordered relative to what they paste. */}
          {!hasSegments ? (
            <div className="select-text whitespace-pre-wrap text-[14px] leading-relaxed text-text">
              {stripControlChars(showFullText ? result.text : result.text.slice(0, TRANSCRIPT_PREVIEW_CHARS))}
            </div>
          ) : (
            <div className="select-text text-[14px] leading-relaxed text-text">
              {effSegments.slice(0, MAX_SEGMENT_ROWS).map((seg, i) => {
                const isActive = i === activeSegIdx && !editMode;
                const range = segWordRanges[i];
                const words = result.words ?? [];
                // Word spans only on the ACTIVE, untouched segment — keeps
                // the DOM light and karaoke honest (edited text has no
                // matching word timings any more).
                const karaoke =
                  isActive && !seg.edited && range && range[0] < range[1];
                const lineColor =
                  colorize && seg.speaker ? { color: colorOf(seg.speaker) } : undefined;
                return (
                  <div
                    key={i}
                    id={`seg-row-${i}`}
                    className={cn(
                      "relative flex gap-3 rounded-lg px-1.5 py-0.5 -mx-1.5",
                      isActive && "bg-accent-soft/40",
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
                        onClick={() => setReassignRow(reassignRow === i ? null : i)}
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
                    {editMode && reassignRow === i && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setReassignRow(null)}
                        />
                        <div className="absolute left-16 top-7 z-20 flex w-44 flex-col gap-0.5 rounded-xl border border-line-strong bg-surface p-1.5 shadow-xl">
                          {speakers.map((label) => (
                            <button
                              key={label}
                              type="button"
                              onClick={() => {
                                if (selectedPath) {
                                  const orig = result.segments?.[i]?.speaker;
                                  setSegmentSpeaker(
                                    selectedPath,
                                    i,
                                    label === orig ? null : label,
                                  );
                                }
                                setReassignRow(null);
                              }}
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
                        onBlur={(e) => {
                          if (!selectedPath) return;
                          const t = stripControlChars(e.currentTarget.textContent ?? "").trim();
                          const orig = (result.segments?.[i]?.text ?? "").trim();
                          setSegmentEdit(selectedPath, i, t && t !== orig ? t : null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            e.currentTarget.textContent = (result.segments?.[i]?.text ?? "").trim();
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
                          return (
                            <span
                              key={wi}
                              onClick={() => seekTo(w.start)}
                              className={cn(
                                "cursor-pointer",
                                current && "rounded bg-accent px-0.5 font-medium text-accent-ink",
                              )}
                            >
                              {stripControlChars(w.word)}
                            </span>
                          );
                        })}
                      </span>
                    ) : (
                      <span
                        className="min-w-0 flex-1 whitespace-pre-wrap"
                        style={lineColor}
                        onClick={audioSrc && !audioBroken ? () => seekTo(seg.start) : undefined}
                      >
                        {stripControlChars(seg.text.trim())}
                        {seg.edited && (
                          <span className="ml-2 align-middle font-mono text-[10.5px] text-ok">· edited</span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {audioSrc && !audioBroken && hasSegments && !editMode && (
            <div className="mt-3 border-t border-line pt-2.5 font-mono text-[11px] text-faint">
              space play/pause · ←/→ skip 5 s · click a word or timestamp to jump there
            </div>
          )}

          {!hasSegments && !showFullText && result.text.length > TRANSCRIPT_PREVIEW_CHARS && (
            <div className="mt-3 flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => setShowFullText(true)}>
                Show full transcript
              </Button>
              <span className="text-[12px] text-faint">
                Showing the first {TRANSCRIPT_PREVIEW_CHARS.toLocaleString()} of{" "}
                {result.text.length.toLocaleString()} characters. Copy always copies all of it.
              </span>
            </div>
          )}
        </Card>
      )}

      {result?.warnings && result.warnings.length > 0 && (
        <Notice className="mt-3">
          {result.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </Notice>
      )}

      {result?.overridesIgnored && result.overridesIgnored.length > 0 && (
        <Notice className="mt-3">
          The server ignored {result.overridesIgnored.length} override
          {result.overridesIgnored.length === 1 ? "" : "s"} (locked by the server admin):{" "}
          <span className="font-mono text-[12px]">
            {result.overridesIgnored.slice(0, MAX_IGNORED_SHOWN).join(", ")}
          </span>
          {result.overridesIgnored.length > MAX_IGNORED_SHOWN ? " …" : ""}.
        </Notice>
      )}
    </div>
  );
}
