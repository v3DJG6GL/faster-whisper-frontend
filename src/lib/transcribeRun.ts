// Module-level state + pump for the Transcribe screen's batch runs.
//
// This lives OUTSIDE the component on purpose: switching to another tab
// unmounts the screen, and a run's queue, results, live progress, renames
// and colors must survive that (the async pump never depended on the mount —
// it kept running against dead setState calls before this store existed).
// Returning to the tab re-subscribes to exactly where the run is.

import { create } from "zustand";
import {
  audioBasePref, cancelBackendTranscription, cancelFileTranscription, fetchUrlMedia,
  getTranscribeProgress, readTextFile, saveTranscriptMedia, transcribeFile, transcribeUrl,
  translateText,
} from "./api";
import { transportErrorDoorway } from "./errors";
import { displayLabel, isSourceUrl, normalizeMediaUrl } from "./urlSource";
import { isTextSourcePath, parseImportedText } from "./subtitleImport";
import { useApp } from "./store";
import { setRecordForgetHook, upsertRecord, type TranscriptRecord } from "./transcriptHistory";
import type {
  BatchProgress, BatchResult, DecodeOverrides, TranscribeOptions,
} from "./types";

export type ItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface QueueItem {
  /** Identity key: a filesystem path, or (URL items) the normalized link
   *  itself — the two can't collide (isSourceUrl). */
  path: string;
  /** Absent = "file" (pre-URL rows). Display and transport dispatch branch
   *  on this; every path-keyed structure works unchanged. */
  kind?: "file" | "url" | "text";
  /** When this transcript was made (ISO) — the viewer's identity stamp.
   *  Same-URL records share the path key, so the timestamp is the only
   *  visible way to tell them apart. */
  createdAt?: string;
  /** URL items: the media title from the preview — the display name. */
  title?: string;
  status: ItemStatus;
  result?: BatchResult;
  error?: string;
  /** Wall time the file took end to end — feeds the whole-run estimate. */
  tookMs?: number;
  /** App-managed audio copy — playback falls back to it when `path` is gone. */
  mediaPath?: string;
}

/** The pipeline stages of a run, in server order (the progress rail). */
export type RailStage = "downloading" | "separating" | "transcribing" | "diarizing" | "translating";

export interface StageTime {
  start: number;
  end?: number;
  /** Stamped only by a real progress poll. A merely seeded clock stays
   *  unobserved — which is how a stage the server jumped over is told apart
   *  from one that ran (see skippedStages). */
  observed?: boolean;
}

/** Model/device chips observed for a stage — kept after the stage finishes
 *  so done rows hold their evidence. */
export interface StageMeta {
  model?: string;
  device?: string;
  compute?: string;
  /** Download stage only: the media's total bytes, captured while the
   *  download reported them — later stages' polls don't carry the field, so
   *  the done row's receipt ("21.8 MB · 3.6 MB/s avg") needs its own copy. */
  bytes?: number;
  /** Download stage only: when the server FIRST reported stage=downloading.
   *  The row's clock starts at request entry and folds resolving (and the
   *  model load) in, which is right for elapsed but poisons byte rates —
   *  21.8 MB over an 18s row is "1.1 MB/s" when the transfer took 4s. */
  dlStart?: number;
}

/** Rough share of a run's wall time per stage — sizes the segments of the
 *  overall pipeline bar and weights the overall percentage. */
export const STAGE_WEIGHTS: Record<RailStage, number> = {
  downloading: 15,
  separating: 25,
  transcribing: 60,
  diarizing: 15,
  translating: 12,
};

/** The stages of a run in server order — transcribe always, the optional
 *  stages only when the run switched them on, and (URL items) the leading
 *  server-side download. Text sources (subtitle/txt files) run the
 *  translating stage alone — no audio ever exists for them. */
export function railStages(
  opts: TranscribeOptions | undefined,
  forUrl?: boolean,
  forText?: boolean,
): RailStage[] {
  if (forText) return ["translating"];
  return [
    ...(forUrl ? (["downloading"] as const) : []),
    ...(opts?.separateBgm ? (["separating"] as const) : []),
    "transcribing" as const,
    ...(opts?.diarize ? (["diarizing"] as const) : []),
    ...(opts?.translateTo?.length ? (["translating"] as const) : []),
  ];
}

/** Index of the server's current stage on the rail (waiting/unknown light
 *  the transcribe row). */
export function railIndex(stage: string | undefined, stages: RailStage[]): number {
  const i = stages.indexOf(railOf(stage));
  return i < 0 ? Math.max(0, stages.indexOf("transcribing")) : i;
}

/** The rail row that is actually active. "waiting" is the server queued on a
 *  semaphore — it says nothing about WHICH stage runs next (the registry is
 *  seeded "waiting" at request entry, seconds before a URL run even starts
 *  resolving). Mapping it straight onto the transcribe row painted every
 *  earlier stage as done before the download began; instead, trust the stage
 *  clocks — the active row is the first stage whose clock hasn't closed. */
export function activeRailIndex(
  progress: BatchProgress | null,
  stageTimes: Partial<Record<RailStage, StageTime>>,
  stages: RailStage[],
): number {
  if (!progress?.stage) return 0;
  if (progress.stage === "waiting") {
    const i = stages.findIndex((st) => !stageTimes[st]?.end);
    return i === -1 ? railIndex(progress.stage, stages) : i;
  }
  return railIndex(progress.stage, stages);
}

/** A rail row's visual state. "skipped" is first-class: a requested stage the
 *  server declined to run is neither done nor pending, and must not read as
 *  either. */
export type StepState = "pending" | "active" | "done" | "skipped";

/** Requested stages the server won't run. Two sources, authoritative first:
 *  the progress payload's `skipped` list (newer backends name the stages they
 *  declined the moment they decline them), else inference — a genuine
 *  pipeline stage past them has been observed while they never were.
 *  "waiting" convicts nothing in the inference: the semaphore queue runs both
 *  before separation and before the decode, so it maps onto the transcribe
 *  row without proving the earlier stage won't still happen. */
export function skippedStages(s: {
  progress: BatchProgress | null;
  stageTimes: Partial<Record<RailStage, StageTime>>;
  lastOptions?: TranscribeOptions;
  forUrl?: boolean;
  forText?: boolean;
}): Set<RailStage> {
  const out = new Set<RailStage>();
  const stages = railStages(s.lastOptions, s.forUrl, s.forText);
  for (const r of s.progress?.skipped ?? []) {
    if ((stages as string[]).includes(r)) out.add(r as RailStage);
  }
  // A backend that names its skipped stages is authoritative — including an empty list:
  // inference on top of it convicted stages that ran between two polls.
  if (Array.isArray(s.progress?.skipped)) return out;
  const stage = s.progress?.stage;
  if (!stage || stage === "waiting" || stage === "unknown") return out;
  const active = railIndex(stage, stages);
  stages.forEach((st, i) => {
    // No clock at all, not merely "never sampled": the pump seeds the first stage's clock
    // when it opens, and a seeded stage RAN even if every poll missed it. Absence of a
    // poll is not evidence of absence of a stage.
    if (i < active && !s.stageTimes[st]) out.add(st);
  });
  return out;
}

/** Weighted 0..1 fraction across the whole pipeline (done stages count in
 *  full, the active stage by its own fraction, skipped stages drop out of the
 *  denominator entirely — no credit for work that never happened). Null when
 *  nothing runs. */
export function overallFraction(s: {
  queue: QueueItem[];
  progress: BatchProgress | null;
  stageTimes: Partial<Record<RailStage, StageTime>>;
  lastOptions?: TranscribeOptions;
  forUrl?: boolean;
  forText?: boolean;
}): number | null {
  if (!s.queue.some((it) => it.status === "running" || it.status === "queued")) return null;
  const stages = railStages(s.lastOptions, s.forUrl, s.forText);
  const active = activeRailIndex(s.progress, s.stageTimes, stages);
  const skipped = skippedStages(s);
  let total = 0;
  let done = 0;
  stages.forEach((st, i) => {
    if (skipped.has(st)) return;
    const w = STAGE_WEIGHTS[st];
    total += w;
    if (i < active) done += w;
    else if (i === active && typeof s.progress?.progress === "number") {
      done += w * s.progress.progress;
    }
  });
  return total > 0 ? done / total : 0;
}

/** Per-stage realtime factors (audio seconds ÷ stage wall seconds) learned
 *  from finished stages, EWMA'd across runs in this session. They only size
 *  the estimated segments of the timeline strip; the seeds are a measured
 *  GPU run and get replaced by real numbers as stages complete. */
const DEFAULT_STAGE_RTF: Record<RailStage, number> = {
  downloading: 75,
  separating: 8,
  transcribing: 6,
  diarizing: 11,
  translating: 25,
};
const stageRtf: Partial<Record<RailStage, number>> = {};

function learnStageRtf(stage: RailStage, wallMs: number, audioSec: number | null | undefined) {
  if (!audioSec || wallMs < 500) return;
  const rtf = audioSec / (wallMs / 1000);
  if (!Number.isFinite(rtf) || rtf <= 0) return;
  const prev = stageRtf[stage];
  stageRtf[stage] = prev ? prev * 0.5 + rtf * 0.5 : rtf;
}

/** Estimated wall ms for a stage, or null without an audio duration to
 *  scale from. */
export function stageEstimateMs(
  stage: RailStage,
  audioDurSec: number | null | undefined,
): number | null {
  if (!audioDurSec) return null;
  return (audioDurSec / (stageRtf[stage] ?? DEFAULT_STAGE_RTF[stage])) * 1000;
}

export function _resetStageRtfForTests() {
  for (const k of Object.keys(stageRtf) as RailStage[]) delete stageRtf[k];
}

/** One segment of the overall timeline strip. `ms` is the segment's relative
 *  size: measured wall time once a stage finished, an estimate before that
 *  (weight-scaled pseudo-time when no audio duration exists to estimate
 *  from). Skipped stages are absent — the strip shows only time actually
 *  spent or still expected. */
export interface TimelineEntry {
  stage: RailStage;
  ms: number;
  /** Wall ms spent so far — full span when done, ticking while active. */
  elapsedMs: number;
  state: "done" | "active" | "pending";
  /** Inner fill of the active segment (stage-local server fraction). */
  fill: number;
  /** Active stage running past its estimate — the view pulses the fill and
   *  the segment widens in deliberate 15 s steps, never per tick. */
  overrun: boolean;
  /** Audio-scaled estimate for the label ("~2m 40s"); null when unknowable. */
  estMs: number | null;
}

export function stageTimeline(s: {
  stages: RailStage[];
  skipped: Set<RailStage>;
  stageTimes: Partial<Record<RailStage, StageTime>>;
  progress: BatchProgress | null;
  audioDurSec: number | null;
  complete: boolean;
  now: number;
}): TimelineEntry[] {
  const active = s.complete
    ? s.stages.length
    : activeRailIndex(s.progress, s.stageTimes, s.stages);
  const out: TimelineEntry[] = [];
  s.stages.forEach((st, i) => {
    if (s.skipped.has(st)) return;
    const t = s.stageTimes[st];
    const est = stageEstimateMs(st, s.audioDurSec);
    // Weight-scaled pseudo-time keeps proportions sane before the audio
    // duration is known (never shown as a number, only as width).
    const fallback = STAGE_WEIGHTS[st] * 2000;
    if (i < active) {
      const span = t?.end != null ? Math.max(t.end - t.start, 1000) : null;
      out.push({
        stage: st,
        ms: span ?? est ?? fallback,
        elapsedMs: span ?? 0,
        state: "done",
        fill: 1,
        overrun: false,
        estMs: est,
      });
    } else if (i === active) {
      const elapsed = t ? Math.max(s.now - t.start, 0) : 0;
      const over = est != null && elapsed > est;
      const ms = over
        ? est + Math.ceil((elapsed - est) / 15000) * 15000
        : (est ?? fallback);
      const frac =
        typeof s.progress?.progress === "number" ? s.progress.progress : 0;
      out.push({
        stage: st,
        ms: Math.max(ms, 1),
        elapsedMs: elapsed,
        state: "active",
        fill: over ? 0.96 : Math.min(frac, 1),
        overrun: over,
        estMs: est,
      });
    } else {
      out.push({
        stage: st,
        ms: est ?? fallback,
        elapsedMs: 0,
        state: "pending",
        fill: 0,
        overrun: false,
        estMs: est,
      });
    }
  });
  return out;
}

/** Everything the pump needs from the screen, captured once per run — the
 *  same freeze-at-start the old component closure gave. */
export interface RunContext {
  backendId: string;
  serverUrl: string;
  model: string;
  language: string;
  prompt?: string;
  decodeOverrides?: DecodeOverrides;
  overrideProfile?: string;
  /** Proven-standard server: skip full-backend progress polling. */
  standard: boolean;
}

interface TranscribeRunState {
  files: string[];
  queue: QueueItem[];
  selectedPath: string | null;
  /** The file the pump ran LAST: the completed run panel's per-file clocks belong to it, so
   *  the panel is pinned here rather than following the clicked row. */
  lastRunPath: string | null;
  /** Live server progress of the RUNNING file (null between files). */
  progress: BatchProgress | null;
  /** Wall-clock spans of the RUNNING file's stages (reset per file). */
  stageTimes: Partial<Record<RailStage, StageTime>>;
  /** Model/device chips per stage of the RUNNING file (reset per file). */
  stageMeta: Partial<Record<RailStage, StageMeta>>;
  /** Per-file speaker renames / palette-index picks (label-keyed). */
  renames: Record<string, Record<string, string>>;
  speakerColors: Record<string, Record<string, number>>;
  /** Per-file pre-export corrections: segment index → replacement text /
   *  reassigned speaker label. Same lifetime as renames; both flow into
   *  Copy and every export. */
  edits: Record<string, Record<number, string>>;
  speakerEdits: Record<string, Record<number, string>>;
  /** Per-file segment indexes whose translations went stale (the ORIGINAL
   *  text was edited after the MT ran). Cleared per index by re-translate. */
  translationsStale: Record<string, Record<number, true>>;
  /** Link metadata by URL key (title/duration/uploader from the preview) —
   *  labels queue rows and survives resetForInputChange (re-adding the same
   *  link keeps its name). */
  urlMeta: Record<string, {
    title?: string;
    durationSec?: number;
    uploader?: string;
    /** yt-dlp extractor key from the preview ("Youtube", "Generic", …) —
     *  shown as the run panel's source pill. */
    extractor?: string;
    /** Preview's size estimate; the download row's total until the real
     *  total_bytes arrives. */
    estimatedBytes?: number;
    /** "m4a · 128 kbps" — the audio format the download fetches. */
    format?: string;
  }>;
  /** Options/overrides of the current or last run (rail layout + Retry). */
  lastOptions?: TranscribeOptions;
  lastOverrides: DecodeOverrides;
  /** History-record id of the transcript on the workbench, or null. The
   *  Recent strip marks its row with this — path can't do it, same-URL
   *  records share their path. */
  openRecordId: string | null;
  epoch: number;
  running: boolean;
}

export const useTranscribeRun = create<TranscribeRunState>(() => ({
  files: [],
  queue: [],
  selectedPath: null,
  lastRunPath: null,
  progress: null,
  stageTimes: {},
  stageMeta: {},
  renames: {},
  speakerColors: {},
  edits: {},
  speakerEdits: {},
  translationsStale: {},
  urlMeta: {},
  lastOptions: undefined,
  lastOverrides: {},
  openRecordId: null,
  epoch: 0,
  running: false,
}));

const set = useTranscribeRun.setState;
const get = useTranscribeRun.getState;

/** Which rail row a server progress stage lights ("waiting"/"unknown" both
 *  belong to the transcribe row — the semaphore queue precedes the decode). */
export function railOf(stage: string | undefined | null): RailStage {
  // "resolving" (the metadata probe) folds onto the download row the same
  // way "waiting"/"analyzing" fold onto transcribe — seconds-long phases
  // don't get their own rail rows.
  if (stage === "downloading" || stage === "resolving") return "downloading";
  return stage === "separating" || stage === "diarizing" || stage === "translating"
    ? stage
    : "transcribing";
}

export function patchItem(path: string, patch: Partial<QueueItem>) {
  set((s) => ({
    queue: s.queue.map((it) => (it.path === path ? { ...it, ...patch } : it)),
  }));
}

/** Changed inputs abandon pending work (epoch bump so a stale in-flight
 *  completion can't land) — but SETTLED results survive: adding one more file
 *  used to wipe every finished transcript from view, and they are in the
 *  history now, so keep showing them. */
export function resetForInputChange() {
  // Reached from addFiles/removeFile: touching the file list mid-run used to
  // abandon the running file silently, leaving the server transcribing for a
  // queue we had already thrown away.
  abandonActiveRun();
  set((s) => {
    const settled = s.queue.filter(
      (it) => it.status === "done" || it.status === "failed",
    );
    return {
      epoch: s.epoch + 1,
      queue: settled,
      selectedPath: settled.some((it) => it.path === s.selectedPath)
        ? s.selectedPath
        : null,
      openRecordId: settled.some((it) => it.path === s.selectedPath)
        ? s.openRecordId
        : null,
      progress: null,
      stageTimes: {},
      stageMeta: {},
    };
  });
}

/** Close the transcript on the workbench — back to the idle config screen.
 *  Only meaningful between runs; the record itself stays in history. */
export function closeRecord() {
  if (get().running) return;
  // `running` is false, so there should be nothing left to abandon — but the
  // epoch bump below is exactly the "our end is gone" move, and a stale handle
  // here is the one shape that leaks server work. Idempotent, so it costs
  // nothing when there is none.
  abandonActiveRun();
  set((s) => ({
    epoch: s.epoch + 1,
    queue: [],
    selectedPath: null,
    openRecordId: null,
    progress: null,
    stageTimes: {},
    stageMeta: {},
  }));
}

export function setUrlMeta(url: string, meta: TranscribeRunState["urlMeta"][string]) {
  set((s) => ({ urlMeta: { ...s.urlMeta, [url]: { ...s.urlMeta[url], ...meta } } }));
}

export function addFiles(paths: string[]) {
  resetForInputChange();
  // URL entries normalize BEFORE the dedupe, so a re-pasted variant of a
  // link already in the list collapses onto it (and History's re-transcribe,
  // which replays rec.sourcePath verbatim, hits the same key).
  const cleaned = paths
    .map((p) => (isSourceUrl(p) ? normalizeMediaUrl(p) ?? p : p));
  set((s) => ({ files: [...s.files, ...cleaned.filter((p) => !s.files.includes(p))] }));
}

export function removeFile(path: string) {
  resetForInputChange();
  set((s) => ({ files: s.files.filter((p) => p !== path) }));
}

export function selectPath(path: string | null) {
  // Selection defines what's "open": keep the Recent-strip marker on the
  // record registered for the newly selected row. If the CURRENTLY open
  // record already belongs to this path, keep it — historyByPath only holds
  // the last-registered record per path, and the user may have an OLDER
  // same-path record open (three records of one URL). Recomputing here used
  // to swap the overlay/run key under the viewer mid-look.
  set((s) => {
    const cur = s.openRecordId ? recordById[s.openRecordId] : undefined;
    return {
      selectedPath: path,
      openRecordId:
        path && cur && cur.sourcePath === path
          ? s.openRecordId
          : (path && historyByPath[path]?.id) || null,
    };
  });
}

// ── history bridge ───────────────────────────────────────────────────────────
// The latest history record per file path. A finished run registers here; a
// reopened record re-registers, so later corrections re-save under the SAME
// id instead of forking a new entry.
const historyByPath: Record<string, TranscriptRecord> = {};
// Overlay slots and edit persistence are keyed by RECORD ID — the path
// can't do it, two records of the same URL share theirs.
const recordById: Record<string, TranscriptRecord> = {};
// One timer PER overlay key: a single handle let an edit to record B (opened from
// History inside the debounce window) cancel a pending write for record A.
const persistTimers = new Map<string, number>();

function registerRecord(rec: TranscriptRecord) {
  historyByPath[rec.sourcePath] = rec;
  recordById[rec.id] = rec;
}

/** Drop a deleted record from the registries (and close it if it is the open one), so a
 *  later overlay edit or chunk merge cannot re-save it. `null` = every record (bulk wipe). */
export function forgetRecord(id: string | null): void {
  if (id === null) {
    for (const k of Object.keys(recordById)) delete recordById[k];
    for (const k of Object.keys(historyByPath)) delete historyByPath[k];
    for (const t of persistTimers.values()) window.clearTimeout(t);
    persistTimers.clear();
    set({ openRecordId: null });
    return;
  }
  const rec = recordById[id];
  delete recordById[id];
  if (rec && historyByPath[rec.sourcePath]?.id === id) delete historyByPath[rec.sourcePath];
  window.clearTimeout(persistTimers.get(id));
  persistTimers.delete(id);
  if (get().openRecordId === id) set({ openRecordId: null });
}
setRecordForgetHook(forgetRecord);

/** Re-save a record with the CURRENT overlays, debounced — every
 *  rename/recolor/correction lands in the history within a second, without a
 *  disk write per keystroke. `key` is the overlay key: the record id
 *  (legacy path keys still resolve through historyByPath). */
function schedulePersistEdits(key: string) {
  if (!recordById[key] && !historyByPath[key]) return;
  window.clearTimeout(persistTimers.get(key));
  persistTimers.set(key, window.setTimeout(() => {
    persistTimers.delete(key);
    const rec = recordById[key] ?? historyByPath[key];
    if (!rec) return;
    const s = get();
    const updated: TranscriptRecord = {
      ...rec,
      renames: s.renames[key],
      speakerColors: s.speakerColors[key],
      edits: s.edits[key],
      speakerEdits: s.speakerEdits[key],
      translationsStale: s.translationsStale[key],
    };
    registerRecord(updated);
    upsertRecord(updated);
  }, 800));
}

/** Every settled run — success or failure — becomes a history record the
 *  moment it lands (failures keep their error and are retryable from the
 *  History screen). Registers under the path so later corrections re-save
 *  the same record. */
function recordRun(
  path: string,
  ctx: RunContext,
  options: TranscribeOptions | undefined,
  outcome: { status: "done" | "failed"; result?: BatchResult; error?: string; tookMs?: number },
): TranscriptRecord {
  const s = get();
  const isUrl = isSourceUrl(path);
  const title = s.urlMeta[path]?.title;
  const rec: TranscriptRecord = {
    schemaVersion: 1,
    kind: isUrl ? "url" : isTextSourcePath(path) ? "text" : "file",
    title: isUrl ? title : undefined,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourcePath: path,
    sourceName: displayLabel(path, title),
    status: outcome.status,
    error: outcome.error,
    tookMs: outcome.tookMs,
    backendId: ctx.backendId,
    model: ctx.model,
    language: outcome.result?.language ?? undefined,
    options,
    result: outcome.result,
    // No overlays: a fresh run starts clean. Overlay slots are keyed by
    // record id, and this record's id is minted right here.
  };
  registerRecord(rec);
  upsertRecord(rec);
  // The viewer identifies the open transcript by its timestamp — same-URL
  // records are otherwise indistinguishable (the URL is the queue key).
  patchItem(path, { createdAt: rec.createdAt });
  // A just-finished run that's on screen is what the Recent strip should
  // mark as open.
  if (get().selectedPath === path) set({ openRecordId: rec.id });
  return rec;
}

/** Copy the finished run's input audio into the app's media store (unless the
 *  setting is off), then late-link the path into the record and queue row —
 *  exactly the dictation recording-path pattern. Best-effort: a failed copy
 *  never touches the run outcome. */
function copyRunMedia(path: string, rec: TranscriptRecord) {
  const s = useApp.getState().settings;
  if (s.transcribe?.keepAudioCopies === false) return;
  void saveTranscriptMedia(rec.id, path, audioBasePref(s.recording))
    .then((mediaPath) => {
      if (!mediaPath) return;
      patchItem(path, { mediaPath });
      // Re-resolve by ID and register under BOTH maps: every persist path reads the id
      // map first, so a path-only write left the record's mediaPath to be dropped by the
      // next rename / recolor / edit — permanently, for a URL run whose copy is the only
      // playable source.
      const cur = recordById[rec.id] ?? historyByPath[path];
      if (cur && cur.id === rec.id) {
        const updated = { ...cur, mediaPath };
        registerRecord(updated);
        upsertRecord(updated);
      }
    })
    .catch((e) => console.error("audio copy failed:", e));
}

/** URL-run counterpart of copyRunMedia: pull the server-retained download
 *  into the local store (`<base>/links/`). Gated on its OWN setting
 *  (keepUrlAudioCopies, default on) — never on keepAudioCopies, because a
 *  link run has no other playable source. Best-effort: null (retention
 *  expired) or an error leaves the transcript fully usable, minus playback. */
function fetchRunUrlMedia(path: string, rec: TranscriptRecord, ctx: RunContext, mediaId: string) {
  const s = useApp.getState().settings;
  if (s.transcribe?.keepUrlAudioCopies === false) return;
  void fetchUrlMedia({
    serverUrl: ctx.serverUrl,
    backendId: ctx.backendId,
    mediaId,
    recordId: rec.id,
    audioBase: audioBasePref(s.recording),
  })
    .then((mediaPath) => {
      if (!mediaPath) return;
      patchItem(path, { mediaPath });
      // Re-resolve by ID and register under BOTH maps: every persist path reads the id
      // map first, so a path-only write left the record's mediaPath to be dropped by the
      // next rename / recolor / edit — permanently, for a URL run whose copy is the only
      // playable source.
      const cur = recordById[rec.id] ?? historyByPath[path];
      if (cur && cur.id === rec.id) {
        const updated = { ...cur, mediaPath };
        registerRecord(updated);
        upsertRecord(updated);
      }
    })
    .catch((e) => console.error("url media fetch failed:", e));
}

/** Load a history record back into the workbench: one settled queue row,
 *  selected, with its overlays restored. Refused mid-run (the pump owns the
 *  queue then). */
export function openHistoryRecord(rec: TranscriptRecord): boolean {
  if (get().running) return false;
  // Loading a history record replaces the workbench (epoch bump below), so any
  // still-registered server-side run is ours to stop.
  abandonActiveRun();
  registerRecord(rec);
  const recIsUrl = isSourceUrl(rec.sourcePath);
  set((s) => ({
    epoch: s.epoch + 1,
    urlMeta: recIsUrl && rec.title
      ? { ...s.urlMeta, [rec.sourcePath]: { ...s.urlMeta[rec.sourcePath], title: rec.title } }
      : s.urlMeta,
    queue: [
      {
        path: rec.sourcePath,
        kind: recIsUrl
          ? ("url" as const)
          : isTextSourcePath(rec.sourcePath)
            ? ("text" as const)
            : ("file" as const),
        title: rec.title,
        createdAt: rec.createdAt,
        status: rec.status,
        result: rec.result,
        error: rec.error,
        tookMs: rec.tookMs,
        mediaPath: rec.mediaPath,
      },
    ],
    selectedPath: rec.sourcePath,
    openRecordId: rec.id,
    progress: null,
    stageTimes: {},
    stageMeta: {},
    lastOptions: rec.options ?? s.lastOptions,
    // Overlay slots keyed by record ID — the path can't do it, two records
    // of the same URL share theirs (edits used to bleed between them).
    renames: { ...s.renames, [rec.id]: rec.renames ?? {} },
    speakerColors: { ...s.speakerColors, [rec.id]: rec.speakerColors ?? {} },
    edits: { ...s.edits, [rec.id]: rec.edits ?? {} },
    speakerEdits: { ...s.speakerEdits, [rec.id]: rec.speakerEdits ?? {} },
    translationsStale: { ...s.translationsStale, [rec.id]: rec.translationsStale ?? {} },
  }));
  return true;
}

export function setRename(key: string, label: string, name: string) {
  set((s) => ({
    renames: { ...s.renames, [key]: { ...s.renames[key], [label]: name } },
  }));
  schedulePersistEdits(key);
}

export function setSpeakerColor(key: string, label: string, idx: number) {
  set((s) => ({
    speakerColors: {
      ...s.speakerColors,
      [key]: { ...s.speakerColors[key], [label]: idx },
    },
  }));
  schedulePersistEdits(key);
}

/** Record (or with null, drop) a text correction for one segment. */
export function setSegmentEdit(key: string, index: number, text: string | null) {
  set((s) => {
    const file = { ...s.edits[key] };
    if (text === null) delete file[index];
    else file[index] = text;
    // Editing the ORIGINAL text marks this segment's translations stale (they
    // translated the old text); reverting the edit clears the mark.
    const rec = recordById[key] ?? historyByPath[key];
    const hasTr = !!rec?.result?.segments?.[index]?.translations;
    let translationsStale = s.translationsStale;
    if (hasTr) {
      const stale = { ...s.translationsStale[key] };
      if (text === null) delete stale[index];
      else stale[index] = true;
      translationsStale = { ...s.translationsStale, [key]: stale };
    }
    return { edits: { ...s.edits, [key]: file }, translationsStale };
  });
  schedulePersistEdits(key);
}

/** Reassign (or with null, restore) one segment's speaker label. */
export function setSegmentSpeaker(key: string, index: number, label: string | null) {
  set((s) => {
    const file = { ...s.speakerEdits[key] };
    if (label === null) delete file[index];
    else file[index] = label;
    return { speakerEdits: { ...s.speakerEdits, [key]: file } };
  });
  schedulePersistEdits(key);
}

/** Discard every correction for one file (the edit banner's Discard). */
export function clearEdits(key: string) {
  set((s) => {
    const edits = { ...s.edits };
    const speakerEdits = { ...s.speakerEdits };
    const translationsStale = { ...s.translationsStale };
    delete edits[key];
    delete speakerEdits[key];
    // Discarding the corrections restores the text the MT translated.
    delete translationsStale[key];
    return { edits, speakerEdits, translationsStale };
  });
  schedulePersistEdits(key);
}

/** Merge fresh per-segment translations into a record (re-translate /
 *  retro-translate): updates the persisted record DIRECTLY (not via the
 *  debounced schedulePersistEdits — its single timer handle could drop a
 *  pending write for another key), patches the open queue item so the viewer
 *  re-renders, and clears the merged indexes' stale marks. */
export function mergeSegmentTranslations(
  key: string,
  patch: Record<number, Record<string, string>>,
  provenance?: { model?: string; targets?: string[]; source?: string; mode?: string },
  /** Per merged index: target codes whose entry kept the SOURCE text (server
   *  quality guard). REPLACES the segment's mark — a successful re-translate
   *  passes [] (or omits the map) and clears it. */
  kept?: Record<number, string[]>,
) {
  const rec = recordById[key] ?? historyByPath[key];
  if (!rec?.result?.segments) return;
  const segments = rec.result.segments.map((seg, i) => {
    if (!patch[i]) return seg;
    const next: typeof seg = { ...seg, translations: { ...seg.translations, ...patch[i] } };
    if (kept?.[i]?.length) next.translationsKept = kept[i];
    else delete next.translationsKept;
    return next;
  });
  const targets = Array.from(
    new Set([...(rec.result.translation?.targets ?? []), ...(provenance?.targets ?? [])]),
  );
  const updated: TranscriptRecord = {
    ...rec,
    result: {
      ...rec.result,
      segments,
      translation: {
        ...rec.result.translation,
        model: provenance?.model ?? rec.result.translation?.model,
        source: provenance?.source ?? rec.result.translation?.source ?? rec.result.language,
        mode: provenance?.mode ?? rec.result.translation?.mode,
        targets,
      },
    },
  };
  // Clear the merged indexes' stale marks FIRST so the persisted record
  // carries the post-merge state (upsertRecord stringifies synchronously).
  set((s) => {
    const stale = { ...s.translationsStale[key] };
    for (const i of Object.keys(patch)) delete stale[Number(i)];
    return { translationsStale: { ...s.translationsStale, [key]: stale } };
  });
  updated.translationsStale = get().translationsStale[key];
  registerRecord(updated);
  upsertRecord(updated);
  // The queue row is keyed by PATH, and two records of one URL share it: while record A is
  // still merging chunks, the user may open record B of the same link from History — patching
  // by path then swapped the OPEN transcript to A's segments under B's header. Only THAT
  // collision is suppressed: an open record of a different path leaves A's own row updated.
  const openId = get().openRecordId;
  const open = openId ? recordById[openId] : undefined;
  if (!open || open.id === rec.id || open.sourcePath !== rec.sourcePath) {
    patchItem(rec.sourcePath, { result: updated.result });
  }
}

/** Fold a progress poll into the store. "unknown" is the server saying "no
 *  such entry" — before the handler registers the id, and again after the
 *  response pops it — so it never overwrites a real stage (that flashed the
 *  rail to "Transcribe" at t=0 and back). Stage transitions stamp the
 *  wall-clock spans the rail shows as elapsed time. */
export function foldProgress(p: BatchProgress) {
  if (!p.stage || p.stage === "unknown") return;
  set((s) => {
    const now = Date.now();
    const prev = s.progress ? railOf(s.progress.stage) : null;
    const cur = railOf(p.stage);
    // "waiting" is the registry's request-entry seed, not evidence the
    // transcribe row ran: it must not stamp a clock `observed`, or the phantom
    // span it opens is fed to learnStageRtf by the first real stage (a
    // realtime factor of hundreds → every later transcribe estimate ~0).
    const obs = p.stage !== "waiting";
    let stageTimes = s.stageTimes;
    // Every poll marks its stage observed — a stage whose clock only ever got
    // seeded (never polled) is one the server jumped over.
    if (prev !== cur) {
      stageTimes = { ...stageTimes };
      const pc = prev ? stageTimes[prev] : undefined;
      if (prev && pc && !pc.end) {
        stageTimes[prev] = { ...pc, end: now };
        // A finished stage with a known audio duration teaches the timeline
        // strip its realtime factor (only observed clocks — a seeded phantom
        // span would poison the average).
        if (pc.observed) {
          learnStageRtf(prev, now - pc.start, p.duration ?? s.progress?.duration);
        }
      }
      // Entering a stage whose clock is already CLOSED restarts it fresh.
      // That closed clock is a phantom: the server's request-entry "waiting"
      // maps onto the transcribe row, seeding a transcribing clock at t=0
      // that the first real stage then stamps shut — resurrecting it here
      // once transcription actually starts would freeze its stale span
      // ("done · 11s" for a 3-minute transcribe, and a nonsense ×realtime).
      const existing = stageTimes[cur];
      stageTimes[cur] =
        existing && !existing.end
          ? { ...existing, observed: existing.observed || obs }
          : { start: now, observed: obs };
    } else if (obs && !stageTimes[cur]?.observed) {
      stageTimes = {
        ...stageTimes,
        [cur]: { start: now, ...stageTimes[cur], observed: true },
      };
    }
    // Chips outlive their stage: a done row keeps showing which model and
    // device did the work. "waiting" reports null meta, so it never taints
    // the transcribe row with the previous stage's chips.
    let stageMeta = s.stageMeta;
    if (p.model && p.stage !== "waiting") {
      stageMeta = {
        ...stageMeta,
        [cur]: {
          ...stageMeta[cur],
          model: p.model,
          device: p.device ?? undefined,
          compute: p.compute ?? undefined,
        },
      };
    }
    // The download's total bytes live only in downloading-stage polls; copy
    // them into the stage's meta so the done row can show its receipt.
    if (cur === "downloading" && typeof p.totalBytes === "number" && p.totalBytes > 0) {
      stageMeta = {
        ...stageMeta,
        downloading: { ...stageMeta.downloading, bytes: p.totalBytes },
      };
    }
    // Actual-transfer clock: the exact stage (not the folded rail row) —
    // resolving polls must not start it.
    if (p.stage === "downloading" && !stageMeta.downloading?.dlStart) {
      stageMeta = {
        ...stageMeta,
        downloading: { ...stageMeta.downloading, dlStart: now },
      };
    }
    return { progress: p, stageTimes, stageMeta };
  });
}

/** The in-flight file's server-side progress id + where to send a cancel for
 *  it. Module-level (not store state): only cancelRun reads it, and it must
 *  survive component unmounts exactly like the pump itself. */
let activeCancel: {
  serverUrl: string;
  backendId?: string | null;
  progressId: string;
} | null = null;

/** Tell the SERVER to stop the in-flight file. Every epoch bump abandons our
 *  end of the request — the pump exits and the rejection is ignored — but the
 *  server's pipeline (separate → transcribe → diarize, minutes of GPU) runs to
 *  completion regardless: dropping the HTTP request does not stop it. So every
 *  path that bumps the epoch calls this, not just the explicit Cancel button.
 *  Take-and-null makes it idempotent, and the API swallows a 404 for an id the
 *  server already retired. */
function abandonActiveRun(): void {
  const target = activeCancel;
  activeCancel = null;
  if (target) void cancelBackendTranscription(target).catch(() => {});
}

/** Sequential queue pump. Runs detached from the component; every commit
 *  compares against the CURRENT epoch so a cancel/input-change abandons it. */
/** Translate-only run for a subtitle/text source: read + parse locally, one
 *  batched /v1/text/translations call, assemble a BatchResult the viewer,
 *  history and exports consume like any other. */
async function translateTextSource(
  path: string,
  options: TranscribeOptions,
  ctx: RunContext,
  progressId?: string | null,
  epoch?: number,
): Promise<BatchResult> {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "txt";
  const content = await readTextFile(path);
  const parsed = parseImportedText(ext, content);
  const targets = options.translateTo ?? [];
  // Chunk well under the transport's 512-text cap — a feature-length .srt
  // easily exceeds it, and each chunk is one server round trip.
  const CHUNK = 400;
  const results: Record<string, string>[] = [];
  const keptAll: string[][] = [];
  const warnings: string[] = [];
  let model: string | undefined;
  let source: string | undefined;
  for (let at = 0; at < parsed.segments.length; at += CHUNK) {
    // A cancel or an input change bumps the epoch; the pump only checks it after this
    // function returns, so without this a feature-length file kept POSTing chunk after
    // chunk for minutes after Cancel. The partial result is discarded by the pump.
    if (epoch !== undefined && epoch !== get().epoch) break;
    const r = await translateText({
      serverUrl: ctx.serverUrl,
      backendId: ctx.backendId,
      texts: parsed.segments.slice(at, at + CHUNK).map((seg) => seg.text),
      targets,
      source: parsed.language ?? null,
      model: options.translationModel ?? null,
      mode: options.translationMode ?? null,
      glossary: options.translationGlossary ?? null,
      progressId: progressId ?? null,
    });
    results.push(...r.results);
    // Dense and aligned with results — a chunk from an older backend that omits
    // `kept` contributes empty arrays, never a shift.
    for (let k = 0; k < r.results.length; k++) keptAll.push(r.kept?.[k] ?? []);
    if (r.warnings?.length) for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    model = model ?? r.model;
    source = source ?? r.source;
  }
  const segments = assembleTranslatedSegments(parsed.segments, results, keptAll);
  return {
    text: parsed.segments.map((seg) => seg.text).join(" "),
    language: parsed.language ?? source ?? undefined,
    segments,
    warnings: warnings.length ? warnings : undefined,
    translations: Object.fromEntries(
      targets.map((lang) => [
        lang,
        segments
          .map((seg) => (seg.translationsKept?.includes(lang) ? "" : (seg.translations?.[lang] ?? "")))
          .filter(Boolean)
          .join(" "),
      ]),
    ),
    translation: { model, targets, source: source ?? parsed.language },
  } as BatchResult;
}

/** Pair parsed text-source segments with their translations — and with the targets the
 *  server's quality guard KEPT as the source text, marked exactly as the audio path's
 *  `mergeSegmentTranslations` marks them, so the viewer flags them, "Re-translate N
 *  flagged" finds them and the exports drop them. Without the mark a kept line was stored
 *  and exported as a genuine translation. */
export function assembleTranslatedSegments(
  parsed: { start?: number; end?: number; text: string; speaker?: string }[],
  results: Record<string, string>[],
  keptAll: string[][],
): { start: number; end: number; text: string; speaker?: string; translations?: Record<string, string>; translationsKept?: string[] }[] {
  return parsed.map((seg, i) => ({
    start: seg.start ?? i,
    end: seg.end ?? (seg.start !== undefined ? seg.start : i + 1),
    text: seg.text,
    ...(seg.speaker ? { speaker: seg.speaker } : {}),
    ...(results[i] && Object.keys(results[i]).length ? { translations: results[i] } : {}),
    ...(keptAll[i]?.length ? { translationsKept: keptAll[i] } : {}),
  }));
}

async function pump(
  epoch: number,
  options: TranscribeOptions | undefined,
  ctx: RunContext,
) {
  if (get().running) return;
  set({ running: true });
  try {
    while (epoch === get().epoch) {
      const next = get().queue.find((it) => it.status === "queued");
      if (!next) break;
      const isUrl = next.kind === "url" || isSourceUrl(next.path);
      const isText = !isUrl && (next.kind === "text" || isTextSourcePath(next.path));
      // A URL item can only run against a full backend (the download happens
      // server-side). A stale queue on a standard server fails locally with
      // a clear message instead of a confusing server 4xx.
      if (isUrl && ctx.standard) {
        patchItem(next.path, {
          status: "failed",
          error: "This server can't download links — pick a full backend.",
        });
        recordRun(next.path, ctx, options, {
          status: "failed",
          error: "This server can't download links — pick a full backend.",
        });
        continue;
      }
      // A text source runs the translation stage ONLY — it needs targets and
      // a full backend with the T2T endpoint.
      if (isText && (ctx.standard || !options?.translateTo?.length)) {
        const error = ctx.standard
          ? "Text files need a full backend with translation enabled."
          : "Text files need at least one translation target — turn on Translation.";
        patchItem(next.path, { status: "failed", error });
        recordRun(next.path, ctx, options, { status: "failed", error });
        continue;
      }
      patchItem(next.path, { status: "running" });
      // Live progress (full backend only): a fresh hex id per file keys the
      // server-side entry; a 1 s poll paints the rail. Best-effort — a poll
      // error (older backend, standard server) just leaves it indeterminate.
      // Text runs poll too: /v1/text/translations registers the same progress
      // entry (stage "translating" + last_text live line).
      const pid = ctx.standard ? null : crypto.randomUUID().replace(/-/g, "");
      activeCancel = pid
        ? { serverUrl: ctx.serverUrl, backendId: ctx.backendId, progressId: pid }
        : null;
      // Seed the first stage's clock from the request start, so the rail
      // shows elapsed time before the first poll lands (and at all on
      // standard servers, which are never polled).
      const first: RailStage = isText
        ? "translating"
        : isUrl
          ? "downloading"
          : options?.separateBgm ? "separating" : "transcribing";
      const fileT0 = Date.now();
      set({
        progress: null,
        lastRunPath: next.path,
        stageMeta: {},
        stageTimes: { [first]: { start: fileT0 } },
      });
      // The epoch does not change between files of one run, so it cannot tell
      // this file's polls from the previous file's last in-flight one — a late
      // answer would open the previous file's stage on the next file's clocks.
      let pollingDone = false;
      const poller = pid
        ? window.setInterval(() => {
            getTranscribeProgress({
              serverUrl: ctx.serverUrl,
              backendId: ctx.backendId,
              progressId: pid,
            })
              .then((p) => {
                if (!pollingDone && epoch === get().epoch) foldProgress(p);
              })
              .catch(() => {});
          }, 1000)
        : undefined;
      try {
        const common = {
          serverUrl: ctx.serverUrl,
          backendId: ctx.backendId,
          model: ctx.model,
          language: ctx.language,
          prompt: ctx.prompt,
          decodeOverrides: ctx.decodeOverrides,
          overrideProfile: ctx.overrideProfile,
          options: pid ? { ...options, progressId: pid } : options,
        };
        const res = isText
          ? await translateTextSource(next.path, options!, ctx, pid, epoch)
          : isUrl
            ? await transcribeUrl({ ...common, sourceUrl: next.path })
            : await transcribeFile({ ...common, filePath: next.path });
        if (epoch !== get().epoch) return;
        const tookMs = Date.now() - fileT0;
        patchItem(next.path, { status: "done", result: res, tookMs });
        // Follow the latest finished file. The old open record (possibly a
        // DIFFERENT path's) must not linger as the overlay/run key for even a
        // render: null it here — recordRun below registers the fresh record
        // and stamps its id as the open one.
        set({ selectedPath: next.path, openRecordId: null });
        const rec = recordRun(next.path, ctx, options, { status: "done", result: res, tookMs });
        if (isUrl) {
          if (res.sourceMediaId) fetchRunUrlMedia(next.path, rec, ctx, res.sourceMediaId);
        } else if (!isText) {
          copyRunMedia(next.path, rec);
        }
      } catch (e) {
        if (epoch !== get().epoch) return;
        patchItem(next.path, { status: "failed", error: String(e) });
        recordRun(next.path, ctx, options, { status: "failed", error: String(e) });
        // Failure doorway banner → Logs screen (pre-filtered to Warn+). The
        // queue item keeps the raw error; the doorway gets the truthful
        // template (cause + backend + one fix). A text source only ran the
        // translate stage, so it toasts as a translation failure.
        const backendName =
          useApp.getState().backends.find((b) => b.id === ctx.backendId)?.name ?? "the backend";
        useApp
          .getState()
          .setLogsDoorway(transportErrorDoorway(isText ? "translate" : "transcribe", e, backendName));
      } finally {
        pollingDone = true;
        activeCancel = null;
        if (poller !== undefined) window.clearInterval(poller);
        if (epoch === get().epoch) {
          if (get().queue.some((it) => it.status === "queued")) {
            set({ progress: null, stageTimes: {}, stageMeta: {} });
          } else {
            // Last file of the run: KEEP the rail data — the panel settles
            // into its completed-receipts state (per the approved design)
            // until the input changes. Just close any still-open clocks.
            const doneAt = Date.now();
            set((s) => ({
              stageTimes: Object.fromEntries(
                Object.entries(s.stageTimes).map(([k, t]) => [
                  k,
                  t.end ? t : { ...t, end: doneAt },
                ]),
              ) as TranscribeRunState["stageTimes"],
            }));
          }
        }
      }
    }
  } finally {
    set({ running: false });
  }
}

export function startRun(options: TranscribeOptions | undefined,
                         overrides: DecodeOverrides, ctx: RunContext) {
  const s = get();
  if (!s.files.length || s.running) return;
  // A previous run's handle can still be live here (a failed/abandoned pump
  // that never reached its `finally`); the epoch bump below orphans it, so
  // stop it before the new run competes with it for the same GPU.
  abandonActiveRun();
  const epoch = s.epoch + 1;
  set({
    epoch,
    selectedPath: null,
    queue: s.files.map((path): QueueItem => ({
      path,
      status: "queued",
      kind: isSourceUrl(path) ? "url" : isTextSourcePath(path) ? "text" : "file",
      title: s.urlMeta[path]?.title,
    })),
    lastOptions: options,
    lastOverrides: overrides,
  });
  void pump(epoch, options, ctx);
}

/** The sidebar badge's fraction: the running item's own rail flags (URL → a download stage,
 *  text → the translating rail alone), exactly as the Transcribe panel derives them. Passing
 *  the bare store credited a download's fraction to the transcribe weight — 80% while the file
 *  was still downloading, then back to 0%. */
export function runBadgeFraction(s: TranscribeRunState): number | null {
  const it = s.queue.find((q) => q.status === "running") ?? null;
  const forUrl = it?.kind === "url" || (it ? isSourceUrl(it.path) : false);
  const forText = it?.kind === "text" || (it && !forUrl ? isTextSourcePath(it.path) : false);
  return overallFraction({ ...s, forUrl, forText });
}

/** The item the completed run panel describes: the file the PUMP ran last (it stamps
 *  `selectedPath` on finish), not the last row in queue order — a retry of a non-final
 *  file makes those diverge, and the rail's clocks belong to the retried one. */
export function settledPanelItem(queue: QueueItem[], selectedPath: string | null): QueueItem | null {
  const settled = (it: QueueItem) => it.status === "done" || it.status === "failed";
  return (
    queue.find((it) => it.path === selectedPath && settled(it)) ??
    [...queue].reverse().find(settled) ??
    null
  );
}

/** Whole-run totals for the completed footer: the rail's clocks are per-file (the pump
 *  resets them between files), so a multi-file run sums the finished items instead of
 *  reporting the last file's wall time as the run's. */
export function runTotals(queue: QueueItem[]): { tookMs: number; audioSec: number } {
  let tookMs = 0;
  let audioSec = 0;
  for (const it of queue) {
    if (it.status !== "done") continue;
    tookMs += it.tookMs ?? 0;
    audioSec += it.result?.duration ?? 0;
  }
  return { tookMs, audioSec };
}

export function retryFile(path: string, ctx: RunContext, overrides?: DecodeOverrides) {
  const s = get();
  if (s.running) return;
  // A retry may carry NEW decode overrides (the VAD one-click fix); the rail's honesty
  // line reads the store, so the store must learn them too.
  if (overrides) set({ lastOverrides: overrides });
  patchItem(path, { status: "queued", error: undefined });
  void pump(s.epoch, s.lastOptions, ctx);
}

export function cancelRun() {
  // Abort the in-flight file AND skip everything queued. Two sides to the
  // abort: the server is told to stop the actual work (dropping the HTTP
  // request alone leaves its pipeline stages running to completion), and
  // the Rust epoch bump drops our end of the request. Bumping the epoch
  // makes the pump exit and ignores the aborted call's rejection.
  abandonActiveRun();
  set((s) => ({
    epoch: s.epoch + 1,
    progress: null,
    stageTimes: {},
    stageMeta: {},
    queue: s.queue.map((it) =>
      it.status === "queued" || it.status === "running"
        ? { ...it, status: "cancelled" as const }
        : it,
    ),
  }));
  void cancelFileTranscription().catch(() => {});
}
