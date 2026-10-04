// The transcript viewer's export panel: format, tracks, media, the "in this
// file" contract, the live preview and Save. Moved out of TranscriptViewer;
// it stays mounted with the viewer (hidden while closed), so its picks and a
// running media export survive closing the panel.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Circle, Download, Minus } from "lucide-react";
import { useApp } from "@/lib/store";
import { effectiveServerUrl } from "@/lib/backends";
import { Button } from "@/components/ui";
import { fmtBytes } from "@/lib/format";
import {
  pickExportPath, saveTextFile, audioBasePref, cancelMediaExport, copyMediaTo, fetchUrlMedia, fetchUrlVideo,
  fetchUrlVideoOnDemand, getMediaStreams, onMediaExportProgress, packageMedia,
} from "@/lib/api";
import { safeDisplayText } from "@/lib/sanitize";
import {
  cpsWarnings, generateExports, speakerHex, type ExportFormat, type ExportOptions, exportFileNames,
} from "@/lib/transcriptExport";
import { cueOptionsOf } from "@/lib/cueSplit";
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
  title?: string;
  onToggle?: () => void;
};

export function TranscriptExport({
  open, result, editedResult, effWords, path, mediaPath, overlayKey, initialExport, langs, allTracks,
  visibleTracks, fileRenames, fileColors, speakers, editCount, focus, trBackend, trCaps,
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
  // Export-preview height: null = auto up to 40vh; a number once the user
  // drags the visible resize handle (WebKitGTK's native corner grip is
  // invisible on dark UIs, so the handle row IS the affordance).
  const [previewH, setPreviewH] = useState<number | null>(null);
  const previewRef = useRef<HTMLPreElement | null>(null);
  const previewDrag = useRef<{ startY: number; startH: number } | null>(null);
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
  const serverVideoUntil =
    serverVideoId === rec?.result?.sourceVideoMediaId
      ? rec?.result?.sourceVideoExpiresAt
      : rec?.result?.sourceMediaExpiresAt;
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
  /** Subtitle length + translation timing: read from the saved settings
   *  (Standard unless changed), like History's quick export. */
  const cueOpts = useMemo(() => cueOptionsOf(settings.transcribe), [settings.transcribe]);
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
  /** Reading-speed scan over every cue the file carries — memoized so the
   *  contract rows in JSX don't re-walk the transcript at playhead cadence. */
  const cpsWarn = useMemo(
    () =>
      open && isSubtitleFormat(exportFormat)
        ? cpsWarnings(editedResult, { ...exportOptions, tracks: effTracks })
        : [],
    [open, editedResult, effTracks, exportFormat, exportOptions],
  );

  /** The "in this file" rows for the selected format (see ContractRow). */
  const exportContract = (): ContractRow[] => {
    const hasWords = !!effWords.length;
    const namesRow: ContractRow | null = hasSpeakers
      ? {
          label: "Speaker names",
          state: showNames ? "on" : "off",
          why: showNames ? "on — mirrors the view toggle" : "off — click to include",
          onToggle: () => setShowNames(!showNames),
        }
      : null;
    const colorsOn = (why: string): ContractRow | null =>
      hasSpeakers
        ? {
            label: "Speaker colors",
            state: colorize ? "on" : "off",
            why: colorize ? why : "off — click to include",
            onToggle: () => setColorize(!colorize),
          }
        : null;
    const colorsNa = (why: string): ContractRow | null =>
      hasSpeakers ? { label: "Speaker colors", state: "na", why } : null;
    const wordsNa = (why: string): ContractRow => ({
      label: "Word timestamps",
      state: "na",
      why,
    });
    const origInExport = !effTracks.length || effTracks.includes("orig");
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
              onToggle: () => setShowTs(!showTs),
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
            !hasWords
              ? wordsNa("this run captured no word timing")
              : !origInExport
                ? // Truthful contract: MT lines have no word timing, and no
                  // original-track file is being written to carry any.
                  wordsNa(
                    "word timing is original-track only — translated lines carry line timing",
                  )
                : {
                    label: "Word timestamps",
                    state: (wordTs ? "on" : "off") as ContractRow["state"],
                    why: wordTs
                      ? effTracks.some((t) => t !== "orig")
                        ? "on — enhanced-LRC word tags in the original-track file (translated files carry line timing)"
                        : "on — enhanced-LRC <mm:ss.xx> word tags (karaoke players)"
                      : "off — click to include",
                    onToggle: () => setWordTs(!wordTs),
                  },
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
    const mtLangs = effTracks.filter((t) => t !== "orig");
    if (langs.length && exportFormat !== "json") {
      // D70 A: one row for the original, mirroring its track chip — the file
      // can be translations only, and then this row is the one place saying so.
      const origCode = safeDisplayText((result.language ?? "??").toUpperCase(), 16);
      const video = mediaChoice === "video" && hasVideoSource;
      const why = !origInExport
        ? "off — click to include"
        : video
          ? subtitleMode === "sidecar" ? "on — its own file" : "on — default track"
          : !mtLangs.length
            ? "on — the only track"
            : exportFormat === "lrc"
              ? "on — its own file"
              : lineOrder === "orig-first" ? "on — first line of each cue" : "on — last line of each cue";
      rows.push({
        label: `${origCode} · original`,
        state: origInExport ? "on" : "off",
        why,
        onToggle: mtLangs.length
          ? () => {
              const all = ["orig", ...langs];
              setExportTracks(origInExport ? effTracks.filter((t) => t !== "orig") : all.filter((t) => t === "orig" || effTracks.includes(t)));
            }
          : undefined,
      });
    }
    if (mtLangs.length && exportFormat !== "json") {
      rows.push({
        label: `${mtLangs.map((l) => l.toUpperCase()).join(" + ")} translation`,
        state: "always",
        why: `machine-translated${result.translation?.model ? ` (${result.translation.model.split("/").pop()})` : ""} · timing from the original`,
      });
    }
    if (cpsWarn.length) {
      rows.push({
        label: "Reading speed",
        state: "na",
        why: `${cpsWarn.length} subtitle${cpsWarn.length === 1 ? "" : "s"} too fast`,
        title: "Characters per second above the limit for the language — flagged, never reflowed",
      });
    }
    if (exportFormat === "json" && langs.length) {
      rows.push({
        label: "Translations",
        state: "always",
        why: "always — JSON carries every track regardless of the picker",
      });
    }
    if (exportFormat === "lrc" && mtLangs.length && effTracks.length > 1) {
      rows.push({
        label: "Files",
        state: "always",
        why: `one .lrc per track (${effTracks.length} files) — bilingual LRC renders unreliably in players`,
      });
    }
    return rows.filter((r): r is ContractRow => r !== null);
  };

  /** How many leading cues the preview serializes — enough to show real
   *  content past a VTT STYLE block, still cheap to re-serialize per toggle. */
  const PREVIEW_CUES = 12;

  /** First cues of the ACTUAL file, re-serialized on every card/toggle
   *  change — the panel's answer to "what am I getting?". Memoized: it used
   *  to re-serialize on every render, and a video export re-renders the
   *  viewer per progress event. Only while the panel shows it. */
  const exportPreview = useMemo((): string | null => {
    if (!open || !result.segments?.length) return null;
    const full = editedResult;
    const segs = (full.segments ?? []).slice(0, PREVIEW_CUES);
    const lastEnd = segs[segs.length - 1]?.end ?? 0;
    const sample: BatchResult = {
      ...full,
      segments: segs,
      words: full.words?.filter((w) => w.start < lastEnd + 0.05),
      text: segs.map((s) => s.text.trim()).join(" "),
    };
    // Preview the first file generateExports would actually write — the
    // singular generateExport falls back to the original track for
    // multi-track LRC, which no written file would contain.
    return generateExports(sample, exportOptions)[0].content;
  }, [open, result.segments, editedResult, exportOptions]);


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
  return (
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
          const notSubtitle = mediaChoice === "video" && !isSubtitleFormat(f.value);
          return (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={notSubtitle}
              onClick={() => {
                if (notSubtitle) return;
                setSwitchNote(null);
                setExportFormat(f.value);
                persistOptions({ exportFormat: f.value });
              }}
              className={cn(
                "ring-signal min-w-0 flex-1 rounded-xl border px-3 py-2 text-left transition-colors",
                on
                  ? "border-accent/55 bg-accent-soft"
                  : "border-line bg-surface-2 hover:border-line-strong",
                notSubtitle && "cursor-not-allowed opacity-50 hover:border-line",
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
              <span className={cn("mt-0.5 block text-[10.5px] leading-snug", notSubtitle ? "text-warn" : "text-faint")}>
                {notSubtitle ? "not a subtitle format" : f.use}
              </span>
            </button>
          );
        })}
      </div>

      {langs.length > 0 && exportFormat !== "json" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">
            tracks
          </span>
          {["orig", ...langs].map((t) => {
            const eff = exportTracks ?? visibleTracks;
            const on = eff.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const all = ["orig", ...langs];
                  const next = on ? eff.filter((x) => x !== t) : all.filter((x) => eff.includes(x) || x === t);
                  if (!next.length) return;
                  setExportTracks(next);
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
                {t === "orig" ? `${safeDisplayText((result.language ?? "??").toUpperCase(), 16)} · original` : t.toUpperCase()}
              </button>
            );
          })}
          {(exportTracks ?? visibleTracks).length > 1 && (
            <button
              type="button"
              onClick={() => setLineOrder((o) => (o === "orig-first" ? "trans-first" : "orig-first"))}
              className="ring-signal inline-flex h-6 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11px] text-dim hover:text-text"
              title="Which line comes first inside each cue"
            >
              {lineOrder === "orig-first" ? "original first" : "translations first"}
            </button>
          )}
        </div>
      )}

      {/* Media: what the Save also writes. Audio = the app's copy of a
          link's audio; Video = the kept/uploaded video, with the tracks
          chosen above muxed in as subtitle streams (server-side), as
          sidecars, or both. Cards keep the format cards' radio idiom. */}
      {showMedia && (() => {
        const audioAvailable = urlSource && !!(mediaPath || rec?.result?.sourceMediaId);
        const videoWhy = !hasVideoSource
          ? "no video is available for this transcription"
          : !packageOn && subtitleMode !== "sidecar" && !localVideo
            ? (trCaps?.media_package?.reason ?? "this server can't package subtitles")
            : null;
        const sourceLine =
          mediaChoice !== "video" ? null
            : localVideo && !urlSource ? `${basename(localVideo)} · ${serverVideoId ? "already on the server" : "will be uploaded"}`
              : rec?.videoPath ? "local copy"
                : serverVideoId && serverVideoUntil
                  ? `on the server until ${new Date(serverVideoUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : urlVideoOnDemand ? "fetched from the link when you save" : null;
        const cardCls = (on: boolean, off: boolean) => cn(
          "ring-signal min-w-0 flex-1 rounded-xl border px-3 py-2 text-left transition-colors",
          on ? "border-accent/55 bg-accent-soft" : "border-line bg-surface-2 hover:border-line-strong",
          off && "cursor-not-allowed opacity-50 hover:border-line",
        );
        const pick = (c: MediaChoice) => { setSwitchNote(null); setMediaChoice(c); persistMedia({ exportMedia: c }); };
        return (
          <div className="mt-3 rounded-xl border border-line bg-surface/50 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">media</span>
              {sourceLine && <span className="text-[11.5px] text-faint">video: {safeDisplayText(sourceLine, 120)}</span>}
            </div>
            <div role="radiogroup" aria-label="Export media" className="mt-2 flex gap-2.5">
              <button type="button" role="radio" aria-checked={mediaChoice === "none"}
                onClick={() => pick("none")} className={cardCls(mediaChoice === "none", false)}>
                <span className={cn("block text-[13px] font-medium", mediaChoice === "none" ? "text-accent" : "text-text")}>None</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">the text file only</span>
              </button>
              {urlSource && (
                <button type="button" role="radio" aria-checked={mediaChoice === "audio"} disabled={!audioAvailable}
                  title={audioAvailable ? undefined : "no audio is stored for this link"}
                  onClick={() => audioAvailable && pick("audio")} className={cardCls(mediaChoice === "audio", !audioAvailable)}>
                  <span className={cn("block text-[13px] font-medium", mediaChoice === "audio" ? "text-accent" : "text-text")}>Audio</span>
                  <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
                    {mediaPath ? `the app's copy · ${audioExt}` : audioAvailable ? "fetched from the server" : "not stored"}
                  </span>
                </button>
              )}
              <button type="button" role="radio" aria-checked={mediaChoice === "video"} disabled={!!videoWhy}
                title={videoWhy ?? undefined}
                onClick={() => !videoWhy && pick("video")} className={cardCls(mediaChoice === "video", !!videoWhy)}>
                <span className={cn("block text-[13px] font-medium", mediaChoice === "video" ? "text-accent" : "text-text")}>Video</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
                  {videoWhy ?? "with the subtitle tracks chosen above"}
                </span>
              </button>
            </div>
            {mediaChoice === "video" && !videoWhy && (
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">container</span>
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
                  <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">subtitles</span>
                  {([["embedded", "embedded tracks"], ["sidecar", "sidecar files"], ["both", "both"]] as const).map(([v, l]) => (
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
                {mp4Why && container === "mkv" && (
                  <span className="text-[11.5px] text-faint">{safeDisplayText(mp4Why, 160)}</span>
                )}
              </div>
            )}
          </div>
        );
      })()}

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
              title={r.title}
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
        {exportPreview ?? "No segments to preview."}
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

      {(() => {
        const plan = exportPlanNow();
        const stem = exportStem(rec?.title, path);
        const names = plan.files.map((f) => f.name(stem));
        const phaseText =
          mediaJob?.phase === "fetching" ? "fetching the video from the link…"
            : mediaJob?.phase === "uploading" ? "uploading the video"
              : mediaJob?.phase === "packaging" ? "packaging on the server…"
                : mediaJob?.phase === "downloading" ? "receiving the packaged video"
                  : mediaJob?.phase === "copying" ? "copying…" : "writing…";
        const pct = mediaJob && mediaJob.total ? Math.round((mediaJob.done / mediaJob.total) * 100) : null;
        return (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[11.5px] text-faint">
              {names.length > 1 ? `${names.length} files · ${names.join(" · ")}` : names[0]}
              {(result.segments?.length ?? 0) > PREVIEW_CUES
                ? ` · first ${PREVIEW_CUES} of ${result.segments?.length} cues`
                : ""}
              {switchNote && <span className="text-warn"> · {switchNote}</span>}
            </span>
            <span className="flex-1" />
            {editCount > 0 && (
              <span className="font-mono text-[11px] text-faint">
                {editCount} correction{editCount === 1 ? "" : "s"} included
              </span>
            )}
            {saveError && (
              <span className="text-[12px] text-warn">{safeDisplayText(saveError, 300)}</span>
            )}
            {mediaError && (
              <span className="text-[12px] text-warn">
                {safeDisplayText(mediaError.msg, 300)}
                {mediaError.kind === "mp4" && (
                  <button type="button" className="ml-2 underline"
                    onClick={() => { setContainer("mkv"); persistMedia({ exportContainer: "mkv" }); setMediaError(null); }}>
                    Save as MKV
                  </button>
                )}
              </span>
            )}
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
              <Button variant="accent" size="sm" onClick={doExport}>
                {saved ? <Check className="size-4" /> : <Download className="size-4" />}
                {saved ? "Saved" : plan.saveLabel}
              </Button>
            )}
          </div>
        );
      })()}
    </div>
  );
}
