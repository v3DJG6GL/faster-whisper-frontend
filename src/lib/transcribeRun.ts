// Module-level state + pump for the Transcribe screen's batch runs.
//
// This lives OUTSIDE the component on purpose: switching to another tab
// unmounts the screen, and a run's queue, results, live progress, renames
// and colors must survive that (the async pump never depended on the mount —
// it kept running against dead setState calls before this store existed).
// Returning to the tab re-subscribes to exactly where the run is.

import { create } from "zustand";
import {
  cancelFileTranscription, getTranscribeProgress, transcribeFile,
} from "./api";
import type {
  BatchProgress, BatchResult, DecodeOverrides, TranscribeOptions,
} from "./types";

export type ItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface QueueItem {
  path: string;
  status: ItemStatus;
  result?: BatchResult;
  error?: string;
  /** Wall time the file took end to end — feeds the whole-run estimate. */
  tookMs?: number;
}

/** The pipeline stages of a run, in server order (the progress rail). */
export type RailStage = "separating" | "transcribing" | "diarizing";

export interface StageTime {
  start: number;
  end?: number;
}

/** Model/device chips observed for a stage — kept after the stage finishes
 *  so done rows hold their evidence. */
export interface StageMeta {
  model?: string;
  device?: string;
  compute?: string;
}

/** Rough share of a run's wall time per stage — sizes the segments of the
 *  overall pipeline bar and weights the overall percentage. */
export const STAGE_WEIGHTS: Record<RailStage, number> = {
  separating: 25,
  transcribing: 60,
  diarizing: 15,
};

/** The stages of a run in server order — transcribe always, the optional
 *  stages only when the run switched them on. */
export function railStages(opts: TranscribeOptions | undefined): RailStage[] {
  return [
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

/** Weighted 0..1 fraction across the whole pipeline (done stages count in
 *  full, the active stage by its own fraction). Null when nothing runs. */
export function overallFraction(s: {
  queue: QueueItem[];
  progress: BatchProgress | null;
  lastOptions?: TranscribeOptions;
}): number | null {
  if (!s.queue.some((it) => it.status === "running" || it.status === "queued")) return null;
  const stages = railStages(s.lastOptions);
  const active = s.progress?.stage ? railIndex(s.progress.stage, stages) : 0;
  let total = 0;
  let done = 0;
  stages.forEach((st, i) => {
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
  return stage === "separating" || stage === "diarizing" ? stage : "transcribing";
}

export function patchItem(path: string, patch: Partial<QueueItem>) {
  set((s) => ({
    queue: s.queue.map((it) => (it.path === path ? { ...it, ...patch } : it)),
  }));
}

/** Changed inputs abandon any settled results (bumps the epoch so a stale
 *  in-flight completion can't land against them). */
export function resetForInputChange() {
  set((s) => ({
    epoch: s.epoch + 1,
    queue: [],
    selectedPath: null,
    progress: null,
    stageTimes: {},
    stageMeta: {},
  }));
}

export function addFiles(paths: string[]) {
  resetForInputChange();
  set((s) => ({ files: [...s.files, ...paths.filter((p) => !s.files.includes(p))] }));
}

export function removeFile(path: string) {
  resetForInputChange();
  set((s) => ({ files: s.files.filter((p) => p !== path) }));
}

export function selectPath(path: string | null) {
  set({ selectedPath: path });
}

export function setRename(path: string, label: string, name: string) {
  set((s) => ({
    renames: { ...s.renames, [path]: { ...s.renames[path], [label]: name } },
  }));
}

export function setSpeakerColor(path: string, label: string, idx: number) {
  set((s) => ({
    speakerColors: {
      ...s.speakerColors,
      [path]: { ...s.speakerColors[path], [label]: idx },
    },
  }));
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
    if (prev !== cur) {
      stageTimes = { ...stageTimes };
      if (prev && stageTimes[prev] && !stageTimes[prev].end) {
        stageTimes[prev] = { ...stageTimes[prev], end: now };
      }
      if (!stageTimes[cur]) stageTimes[cur] = { start: now };
    } else if (!stageTimes[cur]) {
      stageTimes = { ...stageTimes, [cur]: { start: now } };
    }
    // Chips outlive their stage: a done row keeps showing which model and
    // device did the work. "waiting" reports null meta, so it never taints
    // the transcribe row with the previous stage's chips.
    let stageMeta = s.stageMeta;
    if (p.model && p.stage !== "waiting") {
      stageMeta = {
        ...stageMeta,
        [cur]: {
          model: p.model,
          device: p.device ?? undefined,
          compute: p.compute ?? undefined,
        },
      };
    }
    return { progress: p, stageTimes, stageMeta };
  });
}

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
      patchItem(next.path, { status: "running" });
      // Live progress (full backend only): a fresh hex id per file keys the
      // server-side entry; a 1 s poll paints the rail. Best-effort — a poll
      // error (older backend, standard server) just leaves it indeterminate.
      const pid = ctx.standard ? null : crypto.randomUUID().replace(/-/g, "");
      // Seed the first stage's clock from the request start, so the rail
      // shows elapsed time before the first poll lands (and at all on
      // standard servers, which are never polled).
      const first: RailStage = options?.separateBgm ? "separating" : "transcribing";
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
        const res = await transcribeFile({
          serverUrl: ctx.serverUrl,
          backendId: ctx.backendId,
          model: ctx.model,
          language: ctx.language,
          prompt: ctx.prompt,
          decodeOverrides: ctx.decodeOverrides,
          overrideProfile: ctx.overrideProfile,
          filePath: next.path,
          options: pid ? { ...options, progressId: pid } : options,
        });
        if (epoch !== get().epoch) return;
        patchItem(next.path, {
          status: "done",
          result: res,
          tookMs: Date.now() - fileT0,
        });
        set({ selectedPath: next.path }); // follow the latest finished file
      } catch (e) {
        if (epoch !== get().epoch) return;
        patchItem(next.path, { status: "failed", error: String(e) });
      } finally {
        if (poller !== undefined) window.clearInterval(poller);
        if (epoch === get().epoch) set({ progress: null, stageTimes: {}, stageMeta: {} });
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
    queue: s.files.map((path): QueueItem => ({ path, status: "queued" })),
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
  // Abort the in-flight file (the Rust epoch bump drops the HTTP request,
  // which also cancels the server's handler task) AND skip everything
  // queued. Bumping the epoch makes the pump exit and ignores the aborted
  // call's rejection.
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
