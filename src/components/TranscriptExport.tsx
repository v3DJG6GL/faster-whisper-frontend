// The transcript viewer's export panel: format, tracks, media, the "in this
// file" contract, the live preview and Save. Moved out of TranscriptViewer;
// it stays mounted with the viewer (hidden while closed), so its picks and a
// running media export survive closing the panel.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Circle, Download, Minus, PanelBottom, PanelRight, TriangleAlert } from "lucide-react";
import { useApp } from "@/lib/store";
import { effectiveServerUrl } from "@/lib/backends";
import { Button, RangeField, Segmented } from "@/components/ui";
import { fmtBytes } from "@/lib/format";
import {
  pickExportPath, saveTextFile, audioBasePref, cancelMediaExport, copyMediaTo, fetchUrlMedia, fetchUrlVideo,
  fetchUrlVideoOnDemand, getMediaStreams, onMediaExportProgress, packageMedia,
} from "@/lib/api";
import { safeDisplayText } from "@/lib/sanitize";
import {
  cpsWarnings, cueGrid, generateExports, prettySpeaker, speakerHex, type ExportFormat, type ExportOptions, exportFileNames,
} from "@/lib/transcriptExport";
import {
  CUE_PRESETS, CUE_RANGES, cueTrackLang, limitsFor, sanitizeCueLimits, type CueLimits, type CueOptions,
  type SubtitleLength,
} from "@/lib/cueSplit";
import { contentStates, exportSummary, type ContentItem } from "@/lib/exportSummary";
import { cn } from "@/lib/cn";
import { isSourceUrl } from "@/lib/urlSource";
import { isTextSourcePath } from "@/lib/subtitleImport";
import {
  basename, derivePickedStem, embeddedSubtitleTracks, exportStem, isSubtitleFormat, isVideoSourcePath, languageLabel,
  mediaExportPlan, mp4Disabled, sidecarFiles, trackLang, type MediaChoice, type MediaContainer,
  type MediaExportPhase, type MediaStreams, type SubtitleMode,
} from "@/lib/mediaExport";
import { patchRecord, useTranscriptHistory } from "@/lib/transcriptHistory";
import { useDisplayToggles } from "@/lib/useDisplayToggles";
import type { Backend, BatchResult, Capabilities, TranscribeSettings, TranscriptWord } from "@/lib/types";

/** The five export formats as always-visible cards (5 options is below every
 *  buttons-vs-dropdown threshold — NN/g, Fluent, Apple HIG). The one-liner
 *  says what the format is FOR; the Summary says what the file will contain. */
const FORMAT_CARDS: { value: ExportFormat; label: string; use: string }[] = [
  { value: "srt", label: "SRT", use: "video subtitles — VLC, mpv, YouTube" },
  { value: "vtt", label: "VTT", use: "web video captions — HTML5 players" },
  { value: "txt", label: "TXT", use: "plain text — read, paste, edit" },
  { value: "lrc", label: "LRC", use: "synced lyrics — music players" },
  { value: "json", label: "JSON", use: "full data — every field & word" },
];


export function TranscriptExport({
  open, result, editedResult, effWords, path, mediaPath, overlayKey, initialExport, langs, allTracks,
  visibleTracks, fileRenames, fileColors, speakers, editCount, cueOpts, fill, focus, trBackend, trCaps,
}: {
  /** The panel shows; closed it renders nothing but keeps its state. */
  open: boolean;
  result: BatchResult;
  /** The result with corrections applied — what Save writes. */
  editedResult: BatchResult;
  /** Words re-aligned to the corrections. */
  effWords: TranscriptWord[];
  path: string;
  mediaPath?: string;
  overlayKey?: string;
  initialExport?: { media: MediaChoice };
  /** Translated tracks of the result, and "orig" + those. */
  langs: string[];
  allTracks: string[];
  /** The viewer's visible tracks — the export's default pick. */
  visibleTracks: string[];
  fileRenames: Record<string, string>;
  fileColors: Record<string, number>;
  speakers: string[];
  editCount: number;
  /** Subtitle length + translation timing from the saved settings. */
  cueOpts: CueOptions | undefined;
  fill?: boolean;
  focus: boolean;
  trBackend: Backend | undefined;
  trCaps: Capabilities | null | undefined;
}) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const persistOptions = (patch: Partial<TranscribeSettings>) => {
    updateSettings({ transcribe: { ...settings.transcribe, ...patch } });
  };
  const { showTs, showNames, colorize, wordTs, setShowTs, setShowNames, setColorize, setWordTs } = useDisplayToggles();
  const hasSpeakers = speakers.length > 0;
  const urlSource = isSourceUrl(path);
  const textSource = isTextSourcePath(path);
  // Export panel state, seeded from the persisted screen defaults.
  const [exportFormat, setExportFormat] = useState<ExportFormat>(
    () => settings.transcribe?.exportFormat ?? "srt",
  );
  // Which language tracks the export carries: null = follow the viewer's
  // visible tracks (the-view-is-the-export); a pick overrides per panel.
  const [exportTracks, setExportTracks] = useState<string[] | null>(null);
  const [lineOrder, setLineOrder] = useState<"orig-first" | "trans-first">("orig-first");
  // Media section (audio / video / video + subtitle tracks), seeded from the
  // persisted defaults like the format card.
  const [mediaChoice, setMediaChoice] = useState<MediaChoice>(
    () => settings.transcribe?.exportMedia ?? "none",
  );
  const [container, setContainer] = useState<MediaContainer>(
    () => settings.transcribe?.exportContainer ?? "mkv",
  );
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>(
    () => settings.transcribe?.exportSubtitleMode ?? "embedded",
  );
  const [mediaJob, setMediaJob] = useState<{
    jobId: string; phase: MediaExportPhase; done: number; total: number | null;
  } | null>(null);
  const [mediaError, setMediaError] = useState<{ kind: string; msg: string; reason?: string } | null>(null);
  const [streams, setStreams] = useState<MediaStreams | null>(null);
  /** D69 A: with Video on, only subtitle formats stay live. A lit TXT/LRC/JSON
   *  card moves to SRT and the footer says so once (cleared on the next
   *  card or media click). */
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  useEffect(() => {
    if (mediaChoice !== "video" || isSubtitleFormat(exportFormat)) return;
    setSwitchNote(`SRT — switched from ${exportFormat.toUpperCase()}, which can't ride with a video`);
    setExportFormat("srt");
    persistOptions({ exportFormat: "srt" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaChoice, exportFormat]);
  useEffect(() => {
    if (!initialExport) return;
    setMediaChoice(initialExport.media);
  }, [initialExport]);
  // Expand preview: the preview leaves the right column for a full-width box
  // below both columns.
  const [wide, setWide] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // ── Media section facts ──────────────────────────────────────────────────
  // The record behind this transcript (its local copies + server ids).
  const records = useTranscriptHistory((s) => s.records);
  const rec = overlayKey ? records.find((r) => r.id === overlayKey) : undefined;
  const nowSec = Date.now() / 1000;
  // The server's retained VIDEO: a link run's kept video, or the upload a
  // file run retained (retain_media) — either way, packaging needs no upload.
  const serverVideoId =
    rec?.result?.sourceVideoMediaId && (rec.result.sourceVideoExpiresAt ?? 0) > nowSec
      ? rec.result.sourceVideoMediaId
      : !urlSource && rec?.result?.sourceMediaId && (rec.result.sourceMediaExpiresAt ?? 0) > nowSec
        ? rec.result.sourceMediaId
        : null;
  // The local VIDEO: the app's copy of a link's video, or the file itself.
  const localVideo = rec?.videoPath ?? (!urlSource && !textSource && isVideoSourcePath(path) ? path : null);
  const packageOn = trCaps?.media_package_enabled === true;
  const urlVideoOnDemand = urlSource && trCaps?.url_video_enabled === true;
  const hasVideoSource = !!(serverVideoId || localVideo || urlVideoOnDemand);
  const showMedia = !textSource && (urlSource || isVideoSourcePath(path));
  const audioExt = mediaPath ? (/\.([a-z0-9]+)$/i.exec(mediaPath)?.[1]?.toLowerCase() ?? "m4a") : null;
  const mp4Why = mediaChoice === "video" ? mp4Disabled(streams, trCaps ?? null) : null;
  // Codec facts for the MP4 verdict, fetched once the panel wants them.
  useEffect(() => {
    if (!open || mediaChoice !== "video" || !serverVideoId || streams || !trBackend) return;
    let alive = true;
    getMediaStreams({
      serverUrl: effectiveServerUrl(trBackend, settings), backendId: trBackend.id, mediaId: serverVideoId,
    })
      .then((st) => { if (alive && st) setStreams(st); })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mediaChoice, serverVideoId]);
  // A different record: forget its predecessor's facts, picks and outcome.
  // Keyed on record identity, not `result`: every retro-translate chunk merge
  // hands in a fresh result object, and resetting on those wiped the track
  // picks mid-selection every few seconds.
  useEffect(() => {
    setStreams(null);
    setMediaError(null);
    // Track picks belong to the previous file's tracks.
    setExportTracks(null);
    setLineOrder("orig-first");
    // A "permission denied" line (or a still-ticking "Saved") must not sit
    // next to B's button.
    setSaveError(null);
    setSaved(false);
  }, [overlayKey, path]);
  /** One source of truth for Save AND the live preview: the display toggles
   *  map onto the generator options (colors on → "line" mode; names/timestamps
   *  gate their prefixes). */
  // Memoized over exactly what it reads, so the preview below (and anything
  // else keyed on it) holds across the re-renders that don't touch the export
  // choices — playhead ticks, and a media export's progress events.
  const exportOptions = useMemo((): ExportOptions => ({
    format: exportFormat,
    renames: fileRenames,
    speakerColors: hasSpeakers && colorize ? "line" : "off",
    speakerNames: showNames,
    timestamps: showTs,
    // The wire format is explicit hexes, resolved by the SAME shared resolver
    // the chips use — a pick can't render one color and export another.
    colors: Object.fromEntries(
      Object.keys(fileColors).map((l) => [l, speakerHex(speakers, fileColors, l)]),
    ),
    wordTimestamps: wordTs,
    cues: cueOpts,
    // Intersect with THIS file's tracks — a pick left over from another
    // file must never silently empty the export.
    ...(langs.length
      ? {
          tracks: (exportTracks ?? visibleTracks).filter((t) => allTracks.includes(t)),
          lineOrder,
        }
      : {}),
  }), [
    exportFormat, fileRenames, hasSpeakers, colorize, showNames, showTs, fileColors, speakers,
    wordTs, langs, exportTracks, visibleTracks, allTracks, lineOrder, cueOpts,
  ]);
  const exportOpts = (): ExportOptions => exportOptions;

  /** Tracks the export actually carries (the picker, else the visible ones). */
  const effTracks = useMemo(
    () => (langs.length ? (exportTracks ?? visibleTracks) : []),
    [langs, exportTracks, visibleTracks],
  );
  const subs = isSubtitleFormat(exportFormat);
  /** The original track's cues — the preview's slice and the summary's
   *  count; null when the file has no split subtitles. */
  const grid = useMemo(
    () => (open && subs && cueOpts ? cueGrid(editedResult, exportOptions, ["orig"]) : null),
    [open, subs, cueOpts, editedResult, exportOptions],
  );
  /** Reading-speed scan over every cue the file carries — memoized so the
   *  summary in JSX doesn't re-walk the transcript at playhead cadence. */
  const cpsWarn = useMemo(
    () => (open && subs ? cpsWarnings(editedResult, { ...exportOptions, tracks: effTracks }) : []),
    [open, subs, editedResult, effTracks, exportOptions],
  );
  const origIncluded = !effTracks.length || effTracks.includes("orig");
  const content = contentStates({
    format: exportFormat, showTs, showNames, colorize, wordTs, hasSpeakers,
    hasWords: !!effWords.length, origIncluded,
  });
  const toggleContent: Record<ContentItem["key"], () => void> = {
    ts: () => setShowTs(!showTs),
    names: () => setShowNames(!showNames),
    colors: () => setColorize(!colorize),
    words: () => setWordTs(!wordTs),
  };
  const origCode = safeDisplayText((result.language ?? "??").toUpperCase(), 16);
  /** The track chips in line order — the order Segmented reorders them. */
  const chipTracks = lineOrder === "orig-first" ? allTracks : [...langs, "orig"];

  /** How many leading subtitles (or segments) the preview serializes — enough
   *  to show real content past a VTT STYLE block, still cheap per toggle. */
  const PREVIEW_CUES = 12;

  /** The first subtitles of the ACTUAL file, re-serialized on every
   *  card/toggle change — the panel's answer to "what am I getting?".
   *  Memoized: a video export re-renders the viewer per progress event. Only
   *  while the panel shows it. `count` = subtitles (else segments) shown. */
  const exportPreview = useMemo((): { text: string; count: number } | null => {
    if (!open || !result.segments?.length) return null;
    const full = editedResult;
    // Split subtitles: the segments behind the first PREVIEW_CUES cues.
    const n = grid ? grid.cues[Math.min(PREVIEW_CUES, grid.cues.length) - 1].seg + 1 : PREVIEW_CUES;
    const segs = (full.segments ?? []).slice(0, n);
    const lastEnd = segs[segs.length - 1]?.end ?? 0;
    const sample: BatchResult = {
      ...full,
      segments: segs,
      words: full.words?.filter((w) => w.start < lastEnd + 0.05),
      text: segs.map((s) => s.text.trim()).join(" "),
      timedTracks: full.timedTracks?.map((t) => ({ ...t, cues: t.cues.filter((c) => c.start < lastEnd + 0.05) })),
    };
    // Preview the first file generateExports would actually write — the
    // singular generateExport falls back to the original track for
    // multi-track LRC, which no written file would contain.
    return {
      text: generateExports(sample, exportOptions)[0].content,
      count: grid ? grid.cues.filter((c) => c.seg < n).length : segs.length,
    };
  }, [open, result.segments, editedResult, exportOptions, grid]);

  /** The files one Save writes (the media file first, then the text files),
   *  from the panel's current choices. */
  const exportPlanNow = () => {
    const opts = exportOpts();
    return mediaExportPlan({
      choice: mediaChoice, container, subtitleMode, format: exportFormat,
      textFileNames: exportFileNames(opts, editedResult.timedTracks),
      audioExt,
      tracks: effTracks.length ? effTracks : ["orig"],
      origLang: trackLang(editedResult, "orig"),
      hasVideoSource,
    });
  };

  const persistMedia = (patch: Partial<TranscribeSettings>) => persistOptions(patch);

  /** Plain copy of the audio (the app's local copy; a link's is fetched
   *  first when the copy is missing and the server still has it). */
  const exportAudioTo = async (dest: string) => {
    let src = mediaPath ?? null;
    if (!src && urlSource && rec?.result?.sourceMediaId && trBackend) {
      setMediaJob({ jobId: "", phase: "fetching", done: 0, total: null });
      src = await fetchUrlMedia({
        serverUrl: effectiveServerUrl(trBackend, settings), backendId: trBackend.id,
        mediaId: rec.result.sourceMediaId, recordId: rec.id, audioBase: audioBasePref(settings.recording),
      });
      setMediaJob(null);
    }
    if (!src) throw new Error("No audio is stored for this transcription.");
    if (!rec) throw new Error("This transcription has no record to export from.");
    setMediaJob({ jobId: "", phase: "copying", done: 0, total: null });
    try {
      await copyMediaTo({ src, dest, recordId: rec.id, audioBase: audioBasePref(settings.recording) });
    } finally {
      setMediaJob(null);
    }
  };

  /** The video: a plain copy when no tracks ride inside it and a local copy
   *  exists; otherwise the server packages it (uploading a local file first,
   *  or fetching a link's video on demand). False = stopped with an error
   *  the panel now shows. */
  const exportVideoTo = async (dest: string, embedded: string[]): Promise<boolean> => {
    if (!rec) throw new Error("This transcription has no record to export from.");
    const audioBase = audioBasePref(settings.recording);
    if (!embedded.length && localVideo) {
      setMediaJob({ jobId: "", phase: "copying", done: 0, total: null });
      try {
        await copyMediaTo({ src: localVideo, dest, recordId: rec.id, audioBase });
      } finally {
        setMediaJob(null);
      }
      return true;
    }
    if (!trBackend) throw new Error("No backend is selected.");
    const serverUrl = effectiveServerUrl(trBackend, settings);
    let source: { sourceMediaId?: string; sourcePath?: string };
    if (serverVideoId) source = { sourceMediaId: serverVideoId };
    else if (localVideo) source = { sourcePath: localVideo };
    else if (urlVideoOnDemand) {
      setMediaJob({ jobId: "", phase: "fetching", done: 0, total: null });
      try {
        const got = await fetchUrlVideoOnDemand({
          serverUrl, backendId: trBackend.id, url: path,
          maxHeight: settings.transcribe?.urlVideoMaxHeight ?? null,
        });
        source = { sourceMediaId: got.mediaId };
        // Every write below merges onto the LATEST copy of the record, never
        // onto `rec`: that is the render's snapshot, and spreading it (the
        // video fetch lands after the write above) erased the id just stored.
        patchRecord(rec.id, (r) => ({
          ...r,
          result: {
            ...(r.result ?? { text: "" }),
            sourceVideoMediaId: got.mediaId,
            sourceVideoExpiresAt: got.expiresAt ?? undefined,
          },
        }));
        // Keep a local copy too (the Settings' video store), best effort.
        void fetchUrlVideo({ serverUrl, backendId: trBackend.id, mediaId: got.mediaId, recordId: rec.id, audioBase })
          .then((vp) => { if (vp) patchRecord(rec.id, (r) => ({ ...r, videoPath: vp })); })
          .catch(() => {});
      } catch (e) {
        setMediaJob(null);
        setMediaError({ kind: "fetch", msg: safeDisplayText(String(e), 300) || "The video could not be fetched." });
        return false;
      }
    } else {
      setMediaError({ kind: "none", msg: "No video is available for this transcription." });
      return false;
    }
    const opts = exportOpts();
    const subtitles = embedded.length ? embeddedSubtitleTracks(editedResult, opts, embedded) : [];
    const origIdx = subtitles.findIndex((t) => t.original);
    const defaultTrack = subtitles.length ? Math.max(0, origIdx) : null;
    const originalTrack = origIdx >= 0 ? origIdx : null;
    // The spoken language is known here; the source file's audio tag is
    // whatever the uploader's default was ("en" on a German video).
    const audioLang = (editedResult.language ?? "").trim() || null;
    const jobId = crypto.randomUUID().replace(/-/g, "");
    setMediaJob({ jobId, phase: source.sourcePath ? "uploading" : "packaging", done: 0, total: null });
    const unsub = await onMediaExportProgress((p) => {
      if (p.jobId !== jobId) return;
      setMediaJob({ jobId, phase: p.phase, done: p.done, total: p.total });
    });
    let outcome;
    try {
      outcome = await packageMedia({
        serverUrl, backendId: trBackend.id, jobId,
        ...source,
        container, subtitles, defaultTrack, originalTrack,
        audioLang, audioLabel: audioLang ? languageLabel(audioLang) : null,
        destPath: dest, filename: basename(dest).replace(/\.[^.]+$/, ""),
        maxUploadBytes: trCaps?.media_package?.max_upload_bytes ?? null,
      });
    } finally {
      unsub();
      setMediaJob(null);
    }
    if (outcome.kind === "ok") {
      // An uploaded file's server copy is reusable for a while: remember it
      // so "Save as MKV" or a second export skips the upload.
      if (source.sourcePath && outcome.mediaId) {
        const mediaId = outcome.mediaId;
        const expiresAt = outcome.expiresAt ?? undefined;
        patchRecord(rec.id, (r) => ({
          ...r,
          result: { ...(r.result ?? { text: "" }), sourceMediaId: mediaId, sourceMediaExpiresAt: expiresAt },
        }));
      }
      return true;
    }
    if (outcome.kind === "expired") {
      // The server dropped it: forget the id; a local copy carries on. Judged
      // against the latest copy — the upload may have stored a newer id since.
      patchRecord(rec.id, (latest) => {
        if (latest.result?.sourceVideoMediaId !== serverVideoId && latest.result?.sourceMediaId !== serverVideoId) {
          return latest;
        }
        const r = { ...(latest.result ?? { text: "" }) };
        delete r.sourceVideoMediaId; delete r.sourceVideoExpiresAt;
        if (!urlSource) { delete r.sourceMediaId; delete r.sourceMediaExpiresAt; }
        return { ...latest, result: r };
      });
      setMediaError({
        kind: "expired",
        msg: localVideo
          ? "The server no longer has this video — save again to upload the local copy."
          : "The server no longer has this video — save again to fetch it from the link.",
      });
      return false;
    }
    if (outcome.kind === "mp4_incompatible") {
      setStreams({ mp4Ok: false, mp4Reason: outcome.reason ?? outcome.detail });
      setMediaError({ kind: "mp4", msg: outcome.reason ?? outcome.detail, reason: outcome.reason ?? undefined });
      return false;
    }
    setMediaError({
      kind: outcome.kind,
      msg: outcome.kind === "cancelled" ? "Export cancelled." : safeDisplayText(outcome.detail, 300) || "Export failed.",
    });
    return false;
  };

  const doExport = async () => {
    setSaveError(null);
    setMediaError(null);
    const stem = exportStem(rec?.title, path);
    const opts = exportOpts();
    const plan = exportPlanNow();
    // Beside a video the text files are one subtitle file per language; the
    // plain text export stays the (possibly bilingual) reading file.
    const files = plan.sidecars
      ? sidecarFiles(editedResult, opts, plan.sidecars.tracks, plan.sidecars.format)
      : generateExports(editedResult, opts);
    let target: string | null;
    try {
      target = await pickExportPath(
        plan.primary.name(stem),
        plan.primary.kind === "video"
          ? `${plan.primaryExt.toUpperCase()} video`
          : plan.primary.kind === "audio" ? "Audio" : exportFormat.toUpperCase(),
        plan.primaryExt,
      );
    } catch (e) {
      console.error("export save dialog failed:", e);
      return;
    }
    if (!target) return; // cancelled
    // The picked path names the FIRST file; siblings land beside it under
    // the stem the user actually chose in the dialog.
    const { dir, stem: pickedStem } = derivePickedStem(target, plan.primary.name(""), plan.primaryExt);
    try {
      let textIdx = 0;
      for (const f of plan.files) {
        const dest = dir + f.name(pickedStem);
        if (f.kind === "text") {
          await saveTextFile(dest, files[textIdx++].content);
        } else if (f.kind === "audio") {
          await exportAudioTo(dest);
        } else if (!(await exportVideoTo(dest, plan.embedded))) {
          return;
        }
      }
    } catch (e) {
      setMediaJob(null);
      setSaveError(String(e));
      return;
    }
    setSaved(true);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaved(false), 1500);
  };
  // Clear a still-pending confirmation timer if the panel unmounts mid-window.
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  if (!open) return null;

  const plan = exportPlanNow();
  const stem = exportStem(rec?.title, path);
  const names = plan.files.map((f) => f.name(stem));
  const textNames = plan.files.filter((f) => f.kind === "text");
  const cpsLimits = new Set(
    (effTracks.length ? effTracks : ["orig"]).map((t) => (cueOpts ? limitsFor(cueOpts, cueTrackLang(editedResult, t)).cps : 20)),
  );
  const summary = exportSummary({
    format: exportFormat,
    trackCodes: (effTracks.length ? chipTracks.filter((t) => effTracks.includes(t)) : ["orig"]).map((t) =>
      t === "orig" ? origCode : safeDisplayText(cueTrackLang(editedResult, t) ?? t, 16).toUpperCase()),
    stacked: textNames.length === 1,
    filePerTrack: textNames.length > 1 || !!plan.sidecars,
    cueCount: grid ? grid.cues.length : null,
    segCount: result.segments?.length ?? 0,
    showTs,
    content,
    hasSpeakers,
    firstName: speakers.length ? safeDisplayText(fileRenames[speakers[0]]?.trim() || prettySpeaker(speakers[0])) : null,
    cpsCount: cpsWarn.length,
    cpsLimit: cpsLimits.size === 1 ? `${[...cpsLimits][0]} chars/s` : "each language's limit",
    editCount,
    media: showMedia ? { choice: mediaChoice, container, subtitleMode, audioExt } : null,
  });
  const phaseText =
    mediaJob?.phase === "fetching" ? "fetching the video from the link…"
      : mediaJob?.phase === "uploading" ? "uploading the video"
        : mediaJob?.phase === "packaging" ? "packaging on the server…"
          : mediaJob?.phase === "downloading" ? "receiving the packaged video"
            : mediaJob?.phase === "copying" ? "copying…" : "writing…";
  const pct = mediaJob && mediaJob.total ? Math.round((mediaJob.done / mediaJob.total) * 100) : null;
  const custom = sanitizeCueLimits(settings.transcribe?.subtitleCustom) ?? CUE_PRESETS.standard;
  const length = settings.transcribe?.subtitleLength ?? "standard";
  const cardCls = (on: boolean, off: boolean) => cn(
    "ring-signal min-w-0 flex-1 rounded-xl border px-3 py-2 text-left transition-colors",
    on ? "border-accent/55 bg-accent-soft" : "border-line bg-surface-2 hover:border-line-strong",
    off && "cursor-not-allowed opacity-50 hover:border-line",
  );
  const box = "flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface/50 px-4 py-3.5";
  const boxTitle = "font-display text-[14px] font-semibold text-text";
  const expand = (
    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setWide((w) => !w)}
      title={wide ? "Put the preview back beside the settings" : "Show the preview full width, below the settings"}>
      {wide ? <PanelRight className="size-4" /> : <PanelBottom className="size-4" />}
      {wide ? "Collapse preview" : "Expand preview"}
    </Button>
  );
  const preview = (
    <div className={box}>
      <div className="flex items-center gap-3">
        <span className={boxTitle}>Preview</span>
        <span className="font-mono text-[11px] text-faint">
          {exportPreview && (grid
            ? `first ${exportPreview.count} of ${grid.cues.length.toLocaleString("en")} subtitles`
            : (result.segments?.length ?? 0) > exportPreview.count ? "start of the file" : "")}
        </span>
        {expand}
      </div>
      <pre
        className={cn(
          "overflow-auto whitespace-pre rounded-xl border border-line bg-surface px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-dim",
          wide ? "h-[min(640px,75vh)]" : "h-[min(440px,55vh)]",
        )}
      >
        {exportPreview?.text ?? "No segments to preview."}
      </pre>
    </div>
  );

  // Media: what the Save also writes. Audio = the app's copy of a link's
  // audio; Video = the kept/uploaded video, with the chosen tracks muxed in
  // as subtitle streams (server-side), as sidecars, or both.
  const media = showMedia && (() => {
    const audioAvailable = urlSource && !!(mediaPath || rec?.result?.sourceMediaId);
    const videoWhy = !hasVideoSource
      ? "no video is available for this transcription"
      : !packageOn && subtitleMode !== "sidecar" && !localVideo
        ? (trCaps?.media_package?.reason ?? "this server can't package subtitles")
        : null;
    const pick = (c: MediaChoice) => { setSwitchNote(null); setMediaChoice(c); persistMedia({ exportMedia: c }); };
    return (
      <div className={box}>
        <span className={boxTitle}>Media</span>
        <div role="radiogroup" aria-label="Export media" className="flex gap-2">
          <button type="button" role="radio" aria-checked={mediaChoice === "none"}
            onClick={() => pick("none")} className={cardCls(mediaChoice === "none", false)}>
            <span className={cn("block text-[13px] font-medium", mediaChoice === "none" ? "text-accent" : "text-text")}>None</span>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">text file only</span>
          </button>
          {urlSource && (
            <button type="button" role="radio" aria-checked={mediaChoice === "audio"} disabled={!audioAvailable}
              title={audioAvailable ? undefined : "no audio is stored for this link"}
              onClick={() => audioAvailable && pick("audio")} className={cardCls(mediaChoice === "audio", !audioAvailable)}>
              <span className={cn("block text-[13px] font-medium", mediaChoice === "audio" ? "text-accent" : "text-text")}>Audio</span>
              <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
                {mediaPath ? `${audioExt} copy` : audioAvailable ? "from the server" : "not stored"}
              </span>
            </button>
          )}
          <button type="button" role="radio" aria-checked={mediaChoice === "video"} disabled={!!videoWhy}
            title={videoWhy ?? undefined}
            onClick={() => !videoWhy && pick("video")} className={cardCls(mediaChoice === "video", !!videoWhy)}>
            <span className={cn("block text-[13px] font-medium", mediaChoice === "video" ? "text-accent" : "text-text")}>Video</span>
            <span className="mt-0.5 block truncate text-[10.5px] leading-snug text-faint">{videoWhy ? "not available" : "with subtitles"}</span>
          </button>
        </div>
        {mediaChoice === "video" && !videoWhy && (
          <div className="flex flex-col gap-2 text-[12px]">
            <span className="inline-flex items-center gap-2">
              <span className="w-[72px] font-mono text-[10.5px] uppercase tracking-label text-faint">container</span>
              {(["mkv", "mp4"] as const).map((c) => {
                const off = subtitleMode === "sidecar" && !!localVideo && !serverVideoId
                  ? c !== (/\.([a-z0-9]+)$/i.exec(localVideo)?.[1]?.toLowerCase() === "mp4" ? "mp4" : "mkv")
                  : c === "mp4" && !!mp4Why;
                const on = container === c;
                return (
                  <button key={c} type="button" aria-pressed={on} disabled={off}
                    title={c === "mp4" && mp4Why ? mp4Why : subtitleMode === "sidecar" && !!localVideo && !serverVideoId ? "a plain copy keeps the original container" : undefined}
                    onClick={() => { if (!off) { setContainer(c); persistMedia({ exportContainer: c }); } }}
                    className={cn(
                      "ring-signal inline-flex h-6 items-center rounded-pill border px-2.5 font-mono text-[11px] font-medium",
                      on ? "border-accent/45 text-accent" : "border-line bg-surface-2 text-dim hover:text-text",
                      off && "cursor-not-allowed opacity-50 hover:text-dim",
                    )}>
                    {c.toUpperCase()}
                  </button>
                );
              })}
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-[72px] font-mono text-[10.5px] uppercase tracking-label text-faint">subtitles</span>
              {([["embedded", "embedded"], ["sidecar", "files"], ["both", "both"]] as const).map(([v, l]) => (
                <button key={v} type="button" aria-pressed={subtitleMode === v}
                  disabled={v !== "sidecar" && !packageOn}
                  title={v !== "sidecar" && !packageOn ? (trCaps?.media_package?.reason ?? "this server can't package subtitles") : undefined}
                  onClick={() => { setSubtitleMode(v); persistMedia({ exportSubtitleMode: v }); }}
                  className={cn(
                    "ring-signal inline-flex h-6 items-center rounded-pill border px-2.5 font-mono text-[11px] font-medium",
                    subtitleMode === v ? "border-accent/45 text-accent" : "border-line bg-surface-2 text-dim hover:text-text",
                    v !== "sidecar" && !packageOn && "cursor-not-allowed opacity-50",
                  )}>
                  {l}
                </button>
              ))}
            </span>
          </div>
        )}
      </div>
    );
  })();
  const tracksBox = langs.length > 0 && exportFormat !== "json" && (
    <div className={box}>
      <span className={boxTitle}>Tracks</span>
      <div className="flex flex-wrap gap-1.5">
        {chipTracks.map((t) => {
          const on = effTracks.includes(t);
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = on ? effTracks.filter((x) => x !== t) : allTracks.filter((x) => effTracks.includes(x) || x === t);
                if (next.length) setExportTracks(next);
              }}
              className={cn(
                "ring-signal inline-flex h-6 items-center rounded-pill border px-2.5 font-mono text-[11px] font-medium",
                on
                  ? t === "orig"
                    ? "border-accent/35 bg-accent-soft text-accent"
                    : "border-accent/45 text-accent"
                  : "border-line bg-surface-2 text-dim hover:text-text",
              )}
            >
              {t === "orig" ? `${origCode} · original` : safeDisplayText(t, 16).toUpperCase()}
            </button>
          );
        })}
      </div>
      <span
        className="self-start"
        title={effTracks.length < 2 ? "Pick a second track to set the order"
          : textNames.length > 1 ? "Each language goes to its own file" : "Lines inside each subtitle follow the chips"}
      >
        <Segmented
          ariaLabel="Line order"
          value={lineOrder}
          onChange={setLineOrder}
          disabled={effTracks.length < 2 || textNames.length > 1}
          options={[
            { value: "orig-first", label: "Original first" },
            { value: "trans-first", label: "Translations first" },
          ]}
        />
      </span>
    </div>
  );

  return (
    <div
      className={cn(
        "@container mb-4 flex flex-col gap-3.5",
        // The panel replaces the list: in the studio pane and focus mode it
        // is the part that scrolls.
        (fill || focus) && "min-h-0 flex-1 overflow-y-auto",
        focus && "mx-6 mt-3",
      )}
    >
      <div className="grid items-start gap-3.5 @[860px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] @[860px]:gap-4">
        <div className="flex min-w-0 flex-col gap-3.5">
          <div className={box}>
            <span className={boxTitle}>Format</span>
            {/* Format cards — radio semantics, always visible. */}
            <div role="radiogroup" aria-label="Export format" className="flex gap-2">
              {FORMAT_CARDS.map((f) => {
                const on = exportFormat === f.value;
                const notSubtitle = mediaChoice === "video" && !isSubtitleFormat(f.value);
                return (
                  <button
                    key={f.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={notSubtitle}
                    title={notSubtitle ? "not a subtitle format" : f.use}
                    onClick={() => {
                      if (notSubtitle) return;
                      setSwitchNote(null);
                      setExportFormat(f.value);
                      persistOptions({ exportFormat: f.value });
                    }}
                    className={cardCls(on, notSubtitle)}
                  >
                    <span className={cn("block font-mono text-[13px] font-medium", on ? "text-accent" : "text-text")}>
                      {f.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] leading-snug text-faint">{f.use}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={box}>
            <span className={boxTitle}>Content</span>
            <div className="flex flex-wrap gap-2">
              {content.map((c) => {
                const locked = c.state === "fixed" || c.state === "na";
                return (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={c.state === "on" || c.state === "fixed"}
                    aria-disabled={locked}
                    title={c.why}
                    onClick={locked ? undefined : toggleContent[c.key]}
                    className={cn(
                      "ring-signal inline-flex h-[30px] items-center gap-1.5 rounded-pill border px-3 text-[12.5px] transition-colors",
                      c.state === "on" && "border-accent/45 text-accent",
                      c.state === "off" && "border-line bg-surface-2 text-dim hover:text-text",
                      c.state === "fixed" && "cursor-default border-ok/35 text-ok",
                      c.state === "na" && "cursor-not-allowed border-line bg-surface-2 text-dim line-through opacity-45",
                    )}
                  >
                    {c.state === "on" || c.state === "fixed" ? <Check className="size-3.5" />
                      : c.state === "na" ? <Minus className="size-3.5" /> : <Circle className="size-3" />}
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          {(tracksBox || media) && (
            <div className={cn("grid gap-3.5", tracksBox && media && "@[560px]:grid-cols-2")}>
              {tracksBox}
              {media}
            </div>
          )}

          <div className={box}>
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <span className={boxTitle}>Subtitle length</span>
              <span title={subs ? undefined : "Only SRT and VTT have subtitles to split"}>
                <Segmented<SubtitleLength>
                  ariaLabel="Subtitle length"
                  value={length}
                  onChange={(v) => persistOptions({ subtitleLength: v })}
                  disabled={!subs}
                  options={[
                    { value: "transcribed", label: "As transcribed", title: "One subtitle per segment, however long it runs" },
                    { value: "standard", label: "Standard", title: limitsTitle(CUE_PRESETS.standard) },
                    { value: "short", label: "Short", title: limitsTitle(CUE_PRESETS.short) },
                    { value: "custom", label: "Custom", title: limitsTitle(custom) },
                  ]}
                />
              </span>
            </div>
            {length === "custom" && subs && (
              <div className="flex flex-col gap-2.5 rounded-xl border border-line-strong bg-surface px-3.5 py-3">
                {CUE_SLIDERS.map(([k, label, unit]) => (
                  <RangeField
                    key={k}
                    label={label}
                    unit={unit}
                    value={custom[k]}
                    defaultValue={CUE_PRESETS.standard[k]}
                    {...CUE_RANGES[k]}
                    onChange={(v) => persistOptions({ subtitleCustom: { ...custom, [k]: v } })}
                  />
                ))}
              </div>
            )}
            {langs.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <span className="text-[12.5px] text-dim">Translation timing</span>
                <div role="radiogroup" aria-label="Translation timing" className="flex gap-2.5">
                  {([
                    ["same", "Same as the original", "All languages switch together; one subtitle can hold several"],
                    ["own", "Own per language", "Each language split for its own reading speed; one file per language"],
                  ] as const).map(([v, label, why]) => {
                    const on = (settings.transcribe?.translationTiming ?? "same") === v;
                    const off = !subs || !cueOpts;
                    return (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={off}
                        title={off ? "Needs SRT or VTT with split subtitles" : why}
                        onClick={() => persistOptions({ translationTiming: v })}
                        className={cn(cardCls(on, off), "flex items-center gap-3")}
                      >
                        <TimingMini own={v === "own"} />
                        <span className={cn("text-[12.5px] font-medium", on ? "text-accent" : "text-text")}>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3.5 @[860px]:sticky @[860px]:top-3">
          <div className={cn(box, "gap-0.5")}>
            <div className="mb-1 flex items-center gap-3">
              <span className={boxTitle}>Summary</span>
              {expand}
            </div>
            {summary.map((r) => (
              <div key={r.label} className="flex items-start gap-2.5 py-1 text-[12.5px]">
                {r.state === "on" ? <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                  : r.state === "warn" ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    : r.state === "na" ? <Minus className="mt-0.5 size-3.5 shrink-0 text-faint" />
                      : <Circle className="mt-0.5 size-3.5 shrink-0 text-faint" />}
                <span className={cn("shrink-0", r.state === "na" ? "text-faint" : r.state === "off" ? "text-dim" : "text-text")}>
                  {r.label}
                </span>
                <span className={cn("min-w-0 text-[11.5px]", r.state === "warn" ? "text-warn" : "text-faint")}>{r.why}</span>
              </div>
            ))}
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
              <span className="min-w-0 font-mono text-[11px] text-faint [overflow-wrap:anywhere]">
                {names.join(" + ")}
                {switchNote && <span className="text-warn"> · {switchNote}</span>}
              </span>
              {mediaJob ? (
                <span className="inline-flex items-center gap-2 font-mono text-[11px] tabular-nums text-dim">
                  <span className="inline-block h-1 w-24 overflow-hidden rounded-pill bg-surface-2">
                    <span
                      className={cn("block h-full rounded-pill bg-accent transition-[width]", pct === null && "animate-pulse")}
                      style={{ width: `${pct ?? 100}%` }}
                    />
                  </span>
                  {phaseText}{pct !== null ? ` ${pct}%` : ""}
                  {mediaJob.total ? ` · ${fmtBytes(mediaJob.done)} of ${fmtBytes(mediaJob.total)}` : ""}
                  {mediaJob.jobId && (
                    <Button variant="ghost" size="sm" onClick={() => void cancelMediaExport()}>Cancel</Button>
                  )}
                </span>
              ) : (
                <Button variant="accent" onClick={doExport}>
                  {saved ? <Check className="size-4" /> : <Download className="size-4" />}
                  {saved ? "Saved" : plan.saveLabel}
                </Button>
              )}
            </div>
            {saveError && <span className="mt-2 text-[12px] text-warn">{safeDisplayText(saveError, 300)}</span>}
            {mediaError && (
              <span className="mt-2 text-[12px] text-warn">
                {safeDisplayText(mediaError.msg, 300)}
                {mediaError.kind === "mp4" && (
                  <button type="button" className="ml-2 underline"
                    onClick={() => { setContainer("mkv"); persistMedia({ exportContainer: "mkv" }); setMediaError(null); }}>
                    Save as MKV
                  </button>
                )}
              </span>
            )}
          </div>
          {!wide && preview}
        </div>
      </div>
      {wide && preview}
    </div>
  );
}

/** The four Custom sliders: limit key, label, unit. */
const CUE_SLIDERS: [keyof CueLimits, string, string][] = [
  ["cpl", "Characters per line", ""],
  ["lines", "Lines", ""],
  ["maxDur", "Longest subtitle", " s"],
  ["cps", "Reading speed", " chars/s"],
];

/** A preset's limits as its tooltip. */
function limitsTitle(l: CueLimits): string {
  return `${l.lines} ${l.lines === 1 ? "line" : "lines"} × ${l.cpl} characters · up to ${l.maxDur} s · ${l.cps} chars/s`;
}

/** The Translation timing cards' picture: original cues on top, the
 *  translation's below — sharing the grid, or on their own. */
function TimingMini({ own }: { own: boolean }) {
  const bar = (left: number, top: number, width: number, faint?: boolean) => (
    <i
      key={`${left}-${top}`}
      className={cn("absolute h-2 rounded-[2px] bg-accent", faint && "opacity-40")}
      style={{ left, top, width }}
    />
  );
  return (
    <span aria-hidden className="relative h-6 w-14 shrink-0">
      {[0, 20, 40].map((x) => bar(x, 2, 16))}
      {own ? [bar(0, 14, 26, true), bar(30, 14, 26, true)] : [0, 20, 40].map((x) => bar(x, 14, 16, true))}
    </span>
  );
}
