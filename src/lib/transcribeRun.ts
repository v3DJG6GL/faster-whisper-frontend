// Module-level state + pump for the Transcribe screen's batch runs.
//
// This lives OUTSIDE the component on purpose: switching to another tab
// unmounts the screen, and a run's queue, results, live progress, renames
// and colors must survive that (the async pump never depended on the mount —
// it kept running against dead setState calls before this store existed).
// Returning to the tab re-subscribes to exactly where the run is.

import { create } from "zustand";
import {
  cancelBackendTranscription, cancelFileTranscription, fetchUrlMedia,
  getTranscribeProgress, saveTranscriptMedia, transcribeFile, transcribeUrl,
} from "./api";
import { displayLabel, isSourceUrl, normalizeMediaUrl } from "./urlSource";
import { useApp } from "./store";
import { upsertRecord, type TranscriptRecord } from "./transcriptHistory";
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
  kind?: "file" | "url";
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
export type RailStage = "downloading" | "separating" | "transcribing" | "diarizing";

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
}

/** Rough share of a run's wall time per stage — sizes the segments of the
 *  overall pipeline bar and weights the overall percentage. */
export const STAGE_WEIGHTS: Record<RailStage, number> = {
  downloading: 15,
  separating: 25,
  transcribing: 60,
  diarizing: 15,
};

/** The stages of a run in server order — transcribe always, the optional
 *  stages only when the run switched them on, and (URL items) the leading
 *  server-side download. */
export function railStages(opts: TranscribeOptions | undefined, forUrl?: boolean): RailStage[] {
  return [
    ...(forUrl ? (["downloading"] as const) : []),
    ...(opts?.separateBgm ? (["separating"] as const) : []),
    "transcribing" as const,
    ...(opts?.diarize ? (["diarizing"] as const) : []),
  ];
}

/** Index of the server's current stage on the rail (waiting/unknown light
 *  the transcribe row). */
export function railIndex(stage: string | undefined, stages: RailStage[]): number {
  const i = stages.indexOf(railOf(stage));
  return i < 0 ? stages.indexOf("transcribing") : i;
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
}): Set<RailStage> {
  const out = new Set<RailStage>();
  const stages = railStages(s.lastOptions, s.forUrl);
  for (const r of s.progress?.skipped ?? []) {
    if ((stages as string[]).includes(r)) out.add(r as RailStage);
  }
  const stage = s.progress?.stage;
  if (!stage || stage === "waiting" || stage === "unknown") return out;
  const active = railIndex(stage, stages);
  stages.forEach((st, i) => {
    if (i < active && !s.stageTimes[st]?.observed) out.add(st);
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
}): number | null {
  if (!s.queue.some((it) => it.status === "running" || it.status === "queued")) return null;
  const stages = railStages(s.lastOptions, s.forUrl);
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
  }>;
  /** Options/overrides of the current or last run (rail layout + Retry). */
  lastOptions?: TranscribeOptions;
  lastOverrides: DecodeOverrides;
  epoch: number;
  running: boolean;
}

export const useTranscribeRun = create<TranscribeRunState>(() => ({
  files: [],
  queue: [],
  selectedPath: null,
  progress: null,
  stageTimes: {},
  stageMeta: {},
  renames: {},
  speakerColors: {},
  edits: {},
  speakerEdits: {},
  urlMeta: {},
  lastOptions: undefined,
  lastOverrides: {},
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
  return stage === "separating" || stage === "diarizing" ? stage : "transcribing";
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
      progress: null,
      stageTimes: {},
      stageMeta: {},
    };
  });
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
  set({ selectedPath: path });
}

// ── history bridge ───────────────────────────────────────────────────────────
// The latest history record per file path. A finished run registers here; a
// reopened record re-registers, so later corrections re-save under the SAME
// id instead of forking a new entry.
const historyByPath: Record<string, TranscriptRecord> = {};
let persistTimer: number | undefined;

/** Re-save `path`'s record with the CURRENT overlays, debounced — every
 *  rename/recolor/correction lands in the history within a second, without a
 *  disk write per keystroke. */
function schedulePersistEdits(path: string) {
  if (!historyByPath[path]) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const rec = historyByPath[path];
    if (!rec) return;
    const s = get();
    const updated: TranscriptRecord = {
      ...rec,
      renames: s.renames[path],
      speakerColors: s.speakerColors[path],
      edits: s.edits[path],
      speakerEdits: s.speakerEdits[path],
    };
    historyByPath[path] = updated;
    upsertRecord(updated);
  }, 800);
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
    kind: isUrl ? "url" : "file",
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
    renames: s.renames[path],
    speakerColors: s.speakerColors[path],
    edits: s.edits[path],
    speakerEdits: s.speakerEdits[path],
  };
  historyByPath[path] = rec;
  upsertRecord(rec);
  return rec;
}

/** Copy the finished run's input audio into the app's media store (unless the
 *  setting is off), then late-link the path into the record and queue row —
 *  exactly the dictation recording-path pattern. Best-effort: a failed copy
 *  never touches the run outcome. */
function copyRunMedia(path: string, rec: TranscriptRecord) {
  if (useApp.getState().settings.transcribe?.keepAudioCopies === false) return;
  void saveTranscriptMedia(rec.id, path)
    .then((mediaPath) => {
      if (!mediaPath) return;
      patchItem(path, { mediaPath });
      const cur = historyByPath[path];
      if (cur && cur.id === rec.id) {
        const updated = { ...cur, mediaPath };
        historyByPath[path] = updated;
        upsertRecord(updated);
      }
    })
    .catch((e) => console.error("audio copy failed:", e));
}

/** URL-run counterpart of copyRunMedia: pull the server-retained download
 *  into the local media store. NOT gated on keepAudioCopies — a link run has
 *  no other playable source, so without this copy playback simply doesn't
 *  exist. Best-effort: null (retention expired) or an error leaves the
 *  transcript fully usable, minus playback. */
function fetchRunUrlMedia(path: string, rec: TranscriptRecord, ctx: RunContext, mediaId: string) {
  void fetchUrlMedia({
    serverUrl: ctx.serverUrl,
    backendId: ctx.backendId,
    mediaId,
    recordId: rec.id,
  })
    .then((mediaPath) => {
      if (!mediaPath) return;
      patchItem(path, { mediaPath });
      const cur = historyByPath[path];
      if (cur && cur.id === rec.id) {
        const updated = { ...cur, mediaPath };
        historyByPath[path] = updated;
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
  historyByPath[rec.sourcePath] = rec;
  const recIsUrl = isSourceUrl(rec.sourcePath);
  set((s) => ({
    epoch: s.epoch + 1,
    urlMeta: recIsUrl && rec.title
      ? { ...s.urlMeta, [rec.sourcePath]: { ...s.urlMeta[rec.sourcePath], title: rec.title } }
      : s.urlMeta,
    queue: [
      {
        path: rec.sourcePath,
        kind: recIsUrl ? ("url" as const) : ("file" as const),
        title: rec.title,
        status: rec.status,
        result: rec.result,
        error: rec.error,
        tookMs: rec.tookMs,
        mediaPath: rec.mediaPath,
      },
    ],
    selectedPath: rec.sourcePath,
    progress: null,
    stageTimes: {},
    stageMeta: {},
    lastOptions: rec.options ?? s.lastOptions,
    renames: { ...s.renames, [rec.sourcePath]: rec.renames ?? {} },
    speakerColors: { ...s.speakerColors, [rec.sourcePath]: rec.speakerColors ?? {} },
    edits: { ...s.edits, [rec.sourcePath]: rec.edits ?? {} },
    speakerEdits: { ...s.speakerEdits, [rec.sourcePath]: rec.speakerEdits ?? {} },
  }));
  return true;
}

export function setRename(path: string, label: string, name: string) {
  set((s) => ({
    renames: { ...s.renames, [path]: { ...s.renames[path], [label]: name } },
  }));
  schedulePersistEdits(path);
}

export function setSpeakerColor(path: string, label: string, idx: number) {
  set((s) => ({
    speakerColors: {
      ...s.speakerColors,
      [path]: { ...s.speakerColors[path], [label]: idx },
    },
  }));
  schedulePersistEdits(path);
}

/** Record (or with null, drop) a text correction for one segment. */
export function setSegmentEdit(path: string, index: number, text: string | null) {
  set((s) => {
    const file = { ...s.edits[path] };
    if (text === null) delete file[index];
    else file[index] = text;
    return { edits: { ...s.edits, [path]: file } };
  });
  schedulePersistEdits(path);
}

/** Reassign (or with null, restore) one segment's speaker label. */
export function setSegmentSpeaker(path: string, index: number, label: string | null) {
  set((s) => {
    const file = { ...s.speakerEdits[path] };
    if (label === null) delete file[index];
    else file[index] = label;
    return { speakerEdits: { ...s.speakerEdits, [path]: file } };
  });
  schedulePersistEdits(path);
}

/** Discard every correction for one file (the edit banner's Discard). */
export function clearEdits(path: string) {
  set((s) => {
    const edits = { ...s.edits };
    const speakerEdits = { ...s.speakerEdits };
    delete edits[path];
    delete speakerEdits[path];
    return { edits, speakerEdits };
  });
  schedulePersistEdits(path);
}

/** Fold a progress poll into the store. "unknown" is the server saying "no
 *  such entry" — before the handler registers the id, and again after the
 *  response pops it — so it never overwrites a real stage (that flashed the
 *  rail to "Transcribe" at t=0 and back). Stage transitions stamp the
 *  wall-clock spans the rail shows as elapsed time. */
function foldProgress(p: BatchProgress) {
  if (!p.stage || p.stage === "unknown") return;
  set((s) => {
    const now = Date.now();
    const prev = s.progress ? railOf(s.progress.stage) : null;
    const cur = railOf(p.stage);
    let stageTimes = s.stageTimes;
    // Every poll marks its stage observed — a stage whose clock only ever got
    // seeded (never polled) is one the server jumped over.
    if (prev !== cur) {
      stageTimes = { ...stageTimes };
      if (prev && stageTimes[prev] && !stageTimes[prev].end) {
        stageTimes[prev] = { ...stageTimes[prev], end: now };
      }
      stageTimes[cur] = { start: now, ...stageTimes[cur], observed: true };
    } else if (!stageTimes[cur]?.observed) {
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

/** Sequential queue pump. Runs detached from the component; every commit
 *  compares against the CURRENT epoch so a cancel/input-change abandons it. */
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
      patchItem(next.path, { status: "running" });
      // Live progress (full backend only): a fresh hex id per file keys the
      // server-side entry; a 1 s poll paints the rail. Best-effort — a poll
      // error (older backend, standard server) just leaves it indeterminate.
      const pid = ctx.standard ? null : crypto.randomUUID().replace(/-/g, "");
      activeCancel = pid
        ? { serverUrl: ctx.serverUrl, backendId: ctx.backendId, progressId: pid }
        : null;
      // Seed the first stage's clock from the request start, so the rail
      // shows elapsed time before the first poll lands (and at all on
      // standard servers, which are never polled).
      const first: RailStage = isUrl
        ? "downloading"
        : options?.separateBgm ? "separating" : "transcribing";
      const fileT0 = Date.now();
      set({
        progress: null,
        stageMeta: {},
        stageTimes: { [first]: { start: fileT0 } },
      });
      const poller = pid
        ? window.setInterval(() => {
            getTranscribeProgress({
              serverUrl: ctx.serverUrl,
              backendId: ctx.backendId,
              progressId: pid,
            })
              .then((p) => {
                if (epoch === get().epoch) foldProgress(p);
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
        const res = isUrl
          ? await transcribeUrl({ ...common, sourceUrl: next.path })
          : await transcribeFile({ ...common, filePath: next.path });
        if (epoch !== get().epoch) return;
        const tookMs = Date.now() - fileT0;
        patchItem(next.path, { status: "done", result: res, tookMs });
        set({ selectedPath: next.path }); // follow the latest finished file
        const rec = recordRun(next.path, ctx, options, { status: "done", result: res, tookMs });
        if (isUrl) {
          if (res.sourceMediaId) fetchRunUrlMedia(next.path, rec, ctx, res.sourceMediaId);
        } else {
          copyRunMedia(next.path, rec);
        }
      } catch (e) {
        if (epoch !== get().epoch) return;
        patchItem(next.path, { status: "failed", error: String(e) });
        recordRun(next.path, ctx, options, { status: "failed", error: String(e) });
      } finally {
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
  const epoch = s.epoch + 1;
  set({
    epoch,
    selectedPath: null,
    queue: s.files.map((path): QueueItem => ({
      path,
      status: "queued",
      kind: isSourceUrl(path) ? "url" : "file",
      title: s.urlMeta[path]?.title,
    })),
    lastOptions: options,
    lastOverrides: overrides,
  });
  void pump(epoch, options, ctx);
}

export function retryFile(path: string, ctx: RunContext) {
  const s = get();
  if (s.running) return;
  patchItem(path, { status: "queued", error: undefined });
  void pump(s.epoch, s.lastOptions, ctx);
}

export function cancelRun() {
  // Abort the in-flight file AND skip everything queued. Two sides to the
  // abort: the server is told to stop the actual work (dropping the HTTP
  // request alone leaves its pipeline stages running to completion), and
  // the Rust epoch bump drops our end of the request. Bumping the epoch
  // makes the pump exit and ignores the aborted call's rejection.
  const target = activeCancel;
  activeCancel = null;
  if (target) void cancelBackendTranscription(target).catch(() => {});
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
