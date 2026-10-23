// Module-level state + pump for the Transcribe screen's batch runs.
//
// This lives OUTSIDE the component on purpose: switching to another tab
// unmounts the screen, and a run's queue, results, live progress, renames
// and colors must survive that (the async pump never depended on the mount —
// it kept running against dead setState calls before this store existed).
// Returning to the tab re-subscribes to exactly where the run is.

import { create } from "zustand";
import {
  audioBasePref, cancelBackendTranscription, cancelFileTranscription, fetchUrlAudioOnDemand, fetchUrlMedia,
  fetchUrlSubtitles, fetchUrlVideo, fetchUrlVideoOnDemand, getJobResult, getTranscribeProgress, readTextFile,
  saveTranscriptMedia, transcribeFile, transcribeUrl, translateText, type UrlMediaDownload,
} from "./api";
import {
  doorwayBackendLabel, errorText, handedOffDoorway, shortCause, transportErrorDoorway, uploadTooLarge, uploadTooLargeText,
} from "./errors";
import { displayLabel, isSourceUrl, normalizeMediaUrl } from "./urlSource";
import { isTextSourcePath, parseImportedText, type ImportedText } from "./transcript/subtitleImport";
import { useApp } from "./store";
import { safeDisplayText } from "./sanitize";
import { backendLabelById } from "./backends";
import {
  currentRecord, patchRecord, setRecordForgetHook, upsertRecord, useTranscriptHistory, type TranscriptRecord,
} from "./transcript/transcriptHistory";
import type {
  BatchProgress, BatchResult, DecodeOverrides, PlanStage, PlanUnit, TranscribeOptions,
  TranscriptSegment, VideoProgress,
} from "./types";
import { isVideoSourcePath, siteDisplayName, stampCopyPath, withoutCopyPath } from "./transcript/mediaExport";
import { forgetRow, ledgerRows, persistRow, type LedgerRow } from "./jobsLedger";
import { applyMultilingual, primarySubtag, spokenLanguage, translateSourceCode } from "./languages";
import { trText } from "./transcript/cueSplit";
import { joinSegmentTexts } from "./transcript/transcriptFormats";
import { newProgressId } from "./ids";
import { hasOwn, ownProp } from "./own";
import { backendTargetCap, refreshCaps } from "./capabilities";
import { wireCodes } from "./translationTargets";
import { TRANSLATE_CHUNK_CHARS } from "./retroTranslate";
import { isWindowHidden, onWindowHiddenChange } from "./windowVisibility";
import {
  attachSiteTracks, siteTimedTracks, type ParsedSiteTrack, type SiteSubsRun,
} from "./transcript/siteSubtitles";

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
  /** Failed row whose lost request was handed to a headless watcher: that server job
   *  id. A retry stops the watcher first; the watcher's ingest settles the row. */
  orphanJobId?: string;
  /** Link items: the run planned the site's own transcript track but could not fetch it, so
   *  it is transcribing the audio instead — the run panel shows the full rail from the moment
   *  that is decided, not only once the result's warning lands. Cleared when the item runs. */
  siteFallback?: boolean;
}

/** What a queue item runs as: a link (downloaded and transcribed server-side, even when it ends
 *  in .srt/.txt), a text source (translated alone), else a media file. URL-first, so the pump,
 *  the run panel and the queue row all classify an item the same way. */
export function itemSourceKind(it: { kind?: QueueItem["kind"]; path: string }): "url" | "text" | "file" {
  if (it.kind === "url" || isSourceUrl(it.path)) return "url";
  if (it.kind === "text" || isTextSourcePath(it.path)) return "text";
  return "file";
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
  /** Translating stage only: client wall-clock start per target language,
   *  stamped when a poll first names it — the ledger's per-language elapsed
   *  ticks between polls off this, like the stage clocks. */
  unitStarts?: Record<string, number>;
  /** Download stage only (keep_video runs): the secondary video fetch's
   *  last reported state, and when it first reported downloading (its own
   *  rate clock, like dlStart), and when it first reported a terminal state
   *  (done/failed/cancelled) — freezes its clock and average speed. */
  video?: VideoProgress;
  videoDlStart?: number;
  videoDlEnd?: number;
}

/** A secondary video fetch state that ends its clock. */
export function videoTerminal(st: VideoProgress["state"] | undefined): boolean {
  return st === "done" || st === "failed" || st === "cancelled";
}

/** Canonical pipeline order — used to close seeded clocks of stages the server
 *  jumped over (e.g. a seeded "separating" clock when the backend declines BGM
 *  separation and jumps straight to "transcribing"). */
const RAIL_ORDER: RailStage[] = ["downloading", "separating", "transcribing", "diarizing", "translating"];

/** A stage switch (diarization, music separation) as the run sends it: the screen's own pick
 *  (true/false), else the server's default for this caller (request-default-settings
 *  `diarize` / `separate_bgm`), else undefined — an older server that names no default gets no
 *  field, so its own default still applies. A LOCKED server default wins over the screen's pick —
 *  the server binds it regardless of the request, so the rail must show what will actually run.
 *  The rail, the preload plan and the request all read this one value; `=== true` is "the stage
 *  runs". */
export function stagePick(
  own: boolean | undefined,
  serverDefault: { value: unknown; locked?: boolean } | null | undefined,
): boolean | undefined {
  if (serverDefault?.locked === true && typeof serverDefault.value === "boolean") return serverDefault.value;
  if (typeof own === "boolean") return own;
  const v = serverDefault?.value;
  return typeof v === "boolean" ? v : undefined;
}

/** The stages of a run in server order — transcribe always, the optional
 *  stages only when the run switched them on, and (URL items) the leading
 *  server-side download. Text sources (subtitle/txt files) run the
 *  translating stage alone — no audio ever exists for them. A link whose
 *  transcript is the site's own subtitle track (`siteTranscript`) downloads
 *  that track and translates it — no separating, transcribing or diarizing. */
export function railStages(
  opts: TranscribeOptions | undefined,
  forUrl?: boolean,
  forText?: boolean,
  siteTranscript?: boolean,
): RailStage[] {
  if (forText) return ["translating"];
  // Wire-valid targets only, as the run sends them: a History record from before the chips
  // were wire-checked may hold a code the server refuses, which is no translating stage.
  const translates = wireCodes(opts?.translateTo).length > 0;
  if (siteTranscript) return ["downloading", ...(translates ? (["translating"] as const) : [])];
  return [
    ...(forUrl ? (["downloading"] as const) : []),
    ...(opts?.separateBgm ? (["separating"] as const) : []),
    "transcribing" as const,
    ...(opts?.diarize ? (["diarizing"] as const) : []),
    ...(translates ? (["translating"] as const) : []),
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
  skipped?: ReadonlySet<RailStage>,
): number {
  // A server plan is authoritative: the row it marks active is the active
  // row, and once every stage is done the rail is past its end.
  const plan = progress?.plan;
  if (plan?.length) {
    const active = plan.find((p) => p.state === "active");
    if (active) {
      const i = stages.indexOf(active.stage as RailStage);
      if (i >= 0) return i;
    }
    const pending = plan.find((p) => p.state === "pending");
    if (pending) {
      const i = stages.indexOf(pending.stage as RailStage);
      if (i >= 0) return i;
    }
    if (plan.every((p) => p.state === "done" || p.state === "failed" || p.state === "skipped")) {
      return stages.length;
    }
  }
  if (!progress?.stage) return 0;
  if (progress.stage === "waiting") {
    // Find the first stage whose clock hasn't closed AND isn't skipped.
    // Without the skipped check, a declined stage's seeded clock (never
    // closed by a rail transition) latches this forever.
    const i = stages.findIndex((st) => !stageTimes[st]?.end && !skipped?.has(st));
    return i === -1 ? railIndex(progress.stage, stages) : i;
  }
  const mt = mtFetchStage(progress, stageTimes);
  if (mt && stages.includes(mt)) return stages.indexOf(mt);
  return railIndex(progress.stage, stages);
}

/** A rail row's visual state. "skipped" is first-class: a requested stage the
 *  server declined to run is neither done nor pending, and must not read as
 *  either. "failed" is its own state too: a server soft failure (the plan stage
 *  reports it) must not read as done. */
export type StepState = "pending" | "active" | "done" | "skipped" | "failed";

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
  siteTranscript?: boolean;
}): Set<RailStage> {
  const out = new Set<RailStage>();
  const stages = railStages(s.lastOptions, s.forUrl, s.forText, s.siteTranscript);
  // The server plan names its skipped stages outright.
  if (s.progress?.plan?.length) {
    for (const p of s.progress.plan) {
      if (p.state === "skipped" && (stages as string[]).includes(p.stage)) out.add(p.stage as RailStage);
    }
    return out;
  }
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

/** Why a stage the run asked for did not happen — one sentence per stage. The
 *  old two-way branch predated `translating`/`downloading` on the rail and
 *  printed the diarization sentence for both. */
export const SKIPPED_EXPLANATIONS: Record<RailStage, string> = {
  downloading: " — the server already had the media.",
  separating: " — transcribing the original audio instead.",
  transcribing: "",
  diarizing: " — segments stay unlabeled.",
  translating: " — the transcript stays in its source language.",
};

/** The run's overall 0..1 fraction: the SERVER's number (core/run_plan.py
 *  weighs every stage by what it cost or is expected to cost, and holds it
 *  monotone), 0 until the first poll answers. Null when nothing runs. */
export function overallOf(s: { queue: QueueItem[]; progress: BatchProgress | null }): number | null {
  if (!s.queue.some((it) => it.status === "running" || it.status === "queued")) return null;
  const v = s.progress?.overall;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Seconds the server expects the run still needs, or null when it has no
 *  evidence yet (the panel then prints "estimating…"). */
export function etaSecOf(progress: BatchProgress | null): number | null {
  const v = progress?.etaS;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The plan that describes the panel's file: the response's receipt once it settled (the
 *  progress entry is popped before the response leaves, so the last poll never sees the final
 *  stage close; the receipt is the only copy where every stage and unit carries its took_s),
 *  else the live poll's; null before the first poll answers or on a server without one.
 *  `result` = a SETTLED item's only: a re-run still holds its previous result. */
export function planOf(progress: BatchProgress | null, result?: BatchResult | null): PlanStage[] | null {
  if (result?.plan?.length) return result.plan;
  return progress?.plan?.length ? progress.plan : null;
}

/** One lane of the translate segment on the timeline strip. */
export interface TimelineLane {
  target: string;
  ms: number;
  state: PlanUnit["state"];
  fill: number;
}

/** One segment of the overall timeline strip. `ms` is the segment's relative
 *  size: the server's measured wall time once a stage finished, its estimate
 *  before that. Skipped stages are absent — the strip shows only time
 *  actually spent or still expected. */
export interface TimelineEntry {
  stage: RailStage;
  ms: number;
  /** Wall ms spent so far — full span when done, ticking while active. */
  elapsedMs: number;
  state: "done" | "active" | "pending";
  /** Inner fill of the active segment (stage-local fraction; unit-weighted
   *  for the translate stage). */
  fill: number;
  /** Active stage running past the server's estimate — the view pulses the
   *  fill and the segment widens in whole 15 s steps, never per tick. */
  overrun: boolean;
  /** The server's estimate for the label ("~2m 40s"); null when unknown. */
  estMs: number | null;
  /** True while the width is an estimate rather than a measurement. */
  estimated: boolean;
  /** Translate segment: one lane per target language. */
  lanes?: TimelineLane[];
}

/** Unit-weighted fraction of an active translate stage: done units in full,
 *  the running one by its own progress, instant copies not at all. */
export function unitsFraction(units: PlanUnit[] | null | undefined): number | null {
  if (!units?.length) return null;
  let total = 0;
  let got = 0;
  for (const u of units) {
    if (u.instant || u.state === "instant") continue;
    const w = (u.state === "done" ? u.tookS : null) ?? u.estS ?? null;
    if (w == null) continue;
    total += w;
    if (u.state === "done") got += w;
    else if (u.state === "running") got += w * (u.progress ?? 0);
  }
  return total > 0 ? got / total : null;
}

export function planTimeline(s: {
  stages: RailStage[];
  skipped: ReadonlySet<RailStage>;
  plan: PlanStage[] | null;
  stageTimes: Partial<Record<RailStage, StageTime>>;
  progress: BatchProgress | null;
  complete: boolean;
  now: number;
}): TimelineEntry[] {
  const byName = new Map<string, PlanStage>();
  for (const p of s.plan ?? []) byName.set(p.stage, p);
  const active = s.complete
    ? s.stages.length
    : activeRailIndex(s.progress, s.stageTimes, s.stages, s.skipped);
  const out: TimelineEntry[] = [];
  s.stages.forEach((st, i) => {
    if (s.skipped.has(st)) return;
    const p = byName.get(st);
    const t = s.stageTimes[st];
    const span = t?.end != null ? Math.max(t.end - t.start, 1000) : null;
    const state: TimelineEntry["state"] = p
      ? p.state === "done" || p.state === "failed" ? "done"
        : p.state === "active" ? "active" : "pending"
      : i < active ? "done" : i === active ? "active" : "pending";
    const estMs = p?.estS != null ? p.estS * 1000 : null;
    const tookMs = p?.tookS != null ? Math.max(p.tookS * 1000, 1000) : null;
    if (state === "done") {
      const ms = tookMs ?? span ?? estMs ?? 1000;
      out.push({ stage: st, ms, elapsedMs: span ?? ms, state, fill: 1, overrun: false, estMs,
        // A failed stage's units are already closed by the server (done stays done, the
        // one in flight failed, the queued never ran): forcing them done would fill the
        // lane of a language that never got translated.
        estimated: tookMs == null && span == null, lanes: lanesOf(p, p?.state !== "failed") });
      return;
    }
    if (state === "active") {
      const elapsed = t ? Math.max(s.now - t.start, 0) : (p?.elapsedS ?? 0) * 1000;
      // Warm-up (resolving, waiting, skipping silence, a model fetch,
      // separation's transcode): the stage has no fraction because none of
      // its work has happened — the segment stays empty rather than filling
      // by the clock, matching the row's spinner. Mirrors the server's
      // overall rule.
      const warmup =
        !!p?.phase ||
        (s.progress?.stage != null && s.progress.stage !== st) ||
        s.progress?.step === "preparing";
      const frac =
        unitsFraction(p?.units) ??
        (typeof s.progress?.progress === "number" ? s.progress.progress : null) ??
        (warmup ? 0 : estMs ? Math.min(elapsed / estMs, 0.95) : 0);
      const over = !warmup && estMs != null && elapsed > estMs;
      out.push({
        stage: st,
        // Never narrower than the time already spent: a stage past its
        // estimate keeps its true width, in whole 15 s steps so the strip
        // does not creep per tick.
        ms: Math.max(estMs ?? 1000, over ? Math.ceil(elapsed / 15000) * 15000 : 0, 1),
        elapsedMs: elapsed,
        state,
        fill: over ? 0.96 : Math.min(Math.max(frac, 0), 1),
        overrun: over,
        estMs,
        estimated: true,
        lanes: lanesOf(p, false),
      });
      return;
    }
    out.push({ stage: st, ms: estMs ?? 1000, elapsedMs: 0, state, fill: 0, overrun: false, estMs,
      estimated: true, lanes: lanesOf(p, false) });
  });
  return out;
}

/** Greedy left-to-right layout for the axis labels under the strip. A label
 *  keeps the top row when it fits inside its own segment and nothing before
 *  it overflows into its spot; otherwise it drops to the stagger row on a
 *  longer leader tick. A label that would run past the strip's right edge is
 *  pulled left to end exactly at it (`offset` ≤ 0, applied relative to its
 *  column). `px` are segment widths, `labelPx` measured label widths. */
export function axisLayout(
  px: number[],
  labelPx: number[],
  totalW: number,
): { row: 0 | 1; offset: number }[] {
  const out: { row: 0 | 1; offset: number }[] = [];
  let x = 0;
  let topEnd = -Infinity;
  let dropEnd = -Infinity;
  px.forEach((w, i) => {
    // Clamp so the label never crosses the strip's right edge.
    const xl = Math.min(x, Math.max(totalW - labelPx[i], 0));
    const clamped = xl < x - 0.5;
    const fitsOwn = (labelPx[i] <= w - 2 || i === px.length - 1) && !clamped;
    const maxStart = Math.max(totalW - labelPx[i], 0);
    let row: 0 | 1;
    let xUse = xl;
    if (fitsOwn && xl >= topEnd) {
      row = 0;
      topEnd = xl + labelPx[i] + 16;
    } else if (xl >= dropEnd) {
      row = 1;
      dropEnd = xl + labelPx[i] + 16;
    } else {
      // Neither row is clear at xl: take the row that frees up first and
      // start where it ends, so the label is pushed right instead of printed
      // through its predecessor (two tiny early stages at the 5px floor).
      const useTop = topEnd <= dropEnd;
      row = useTop ? 0 : 1;
      xUse = Math.min(Math.max(xl, useTop ? topEnd : dropEnd), maxStart);
      if (useTop) topEnd = xUse + labelPx[i] + 16;
      else dropEnd = xUse + labelPx[i] + 16;
    }
    out.push({ row, offset: xUse - x });
    x += w + 2;
  });
  return out;
}

function lanesOf(p: PlanStage | undefined, done: boolean): TimelineLane[] | undefined {
  if (!p?.units?.length) return undefined;
  const lanes: TimelineLane[] = [];
  for (const u of p.units) {
    if (u.instant || u.state === "instant") continue;
    const ms = ((u.tookS ?? u.estS) ?? 0) * 1000;
    const state: PlanUnit["state"] = done ? "done" : u.state;
    lanes.push({
      target: u.target,
      ms: Math.max(ms, 500),
      state,
      fill: state === "done" ? 1 : state === "running" ? Math.min(Math.max(u.progress ?? 0, 0.02), 1) : 0,
    });
  }
  return lanes.length ? lanes : undefined;
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
  /** The server can keep a link's video (caps.url_video_enabled): only then
   *  does a URL item's keep-video choice go on the wire. */
  urlVideoEnabled?: boolean;
  /** The server runs a translating stage (caps.translation_enabled on a full backend): a retry
   *  that lands on one without it drops the last run's translation settings. Unset = unknown
   *  (caps not loaded): only a standard server is assumed to lack it. */
  translationAvailable?: boolean;
  /** The server packages subtitles (caps.media_package_enabled): a local
   *  VIDEO file then asks the server to retain the upload for a while, so
   *  an export right after needs no second upload. */
  mediaPackageEnabled?: boolean;
  /** The server keeps a durable job resource (caps.jobs_enabled): only then
   *  is a run written to the in-flight ledger so it can be re-attached to
   *  after a restart (lib/jobsLedger.ts, lib/jobsReconcile.ts). */
  jobsEnabled?: boolean;
  /** The server's upload limit (caps.media_max_bytes): a local file over it stops before
   *  the upload (Rust checks the size) instead of streaming gigabytes into a 413. */
  mediaMaxBytes?: number;
  /** How long that server keeps a job (caps.jobs.ttl_s, clamped by
   *  `clampJobsTtl`): how long the ledger row stays worth asking about.
   *  Absent = the server's 72 h default. */
  jobsTtlS?: number;
  /** The screen offers Multiple languages for this run (offersMultilingual at run/retry
   *  time): false = a link card's frozen spoken pick never touches `multilingual`; unset =
   *  unknown, treated as offered (ledger rows written before this key replay as before). */
  multilingualOffered?: boolean;
  /** The server's default is multilingual as the screen sees it at run/retry time (its live
   *  inherited baseline): an Auto-detect link card then sends multilingual=false even when its
   *  add-time value (spokenMultiInherited) was frozen false; unset = that card value alone
   *  decides. */
  multilingualInherited?: boolean;
}

export interface TranscribeRunState {
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
  /** Per-file segment indexes whose CURRENT translations were made from a
   *  correction (a re-translate ran while it was in place): dropping that
   *  correction restores a text the MT never saw, so it marks them stale. Kept
   *  through a revert or a Discard until a merge re-translates the line. */
  translatedFromEdit: Record<string, Record<number, true>>;
  /** Link metadata by URL key (title/duration from the preview) —
   *  labels queue rows and survives resetForInputChange (re-adding the same
   *  link keeps its name). */
  urlMeta: Record<string, {
    title?: string;
    durationSec?: number;
    /** yt-dlp extractor key from the preview ("Youtube", "Generic", …) —
     *  shown as the run panel's source pill. */
    extractor?: string;
    /** Preview's size estimate; the download row's total until the real
     *  total_bytes arrives. */
    estimatedBytes?: number;
    /** "m4a · 128 kbps" — the audio format the download fetches. */
    format?: string;
    /** The link card's per-item video choice (absent = the Settings default). */
    keepVideo?: boolean;
    videoMaxHeight?: number | null;
    /** The link card's explicit rung (a yt-dlp format id); absent = the
     *  Settings height cap decides at run time. */
    videoFormat?: string | null;
    /** The link card's spoken language (a code, "auto" or MULTI_LANGUAGE) when it
     *  differs from the screen's — named by the site, detected, or picked. */
    spokenLanguage?: string;
    /** Whether the server's own default (as the card saw it) is multilingual — lets an
     *  Auto-detect pick send multilingual=false instead of inheriting it. */
    spokenMultiInherited?: boolean;
    /** Audio the spoken-language check already downloaded; the run reuses it. */
    prefetchMediaId?: string;
    /** When the server deletes `prefetchMediaId` (the check's mediaExpiresAt): a site
     *  transcript that reuses the audio stamps it, so playback/export stop offering it after. */
    prefetchExpiresAt?: number;
    /** The backend that issued `prefetchMediaId` (see linkPrefetchFor). */
    prefetchBackendId?: string;
    /** The link card's site-subtitle plan (D86), frozen at Add link. */
    siteSubs?: SiteSubsRun;
  }>;
  /** Options/overrides of the current or last run as REQUESTED (Retry replays them). A retry
   *  never overwrites them: every failed row of the queue, and every later retry, reconciles
   *  from this one copy (reconcileRetryOptions). */
  lastOptions?: TranscribeOptions;
  /** The options the current or last pump really runs with — a retry's reconciled ones (no
   *  Translating stage on a server without it); the rail and the stage inference read these.
   *  Undefined = the requested ones (lastOptions). */
  runOptions?: TranscribeOptions;
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
  translatedFromEdit: {},
  urlMeta: {},
  lastOptions: undefined,
  runOptions: undefined,
  lastOverrides: {},
  openRecordId: null,
  epoch: 0,
  running: false,
}));

const set = useTranscribeRun.setState;
const get = useTranscribeRun.getState;

/** Which rail row a server progress stage lights ("waiting"/"unknown" both
 *  belong to the transcribe row — the semaphore queue precedes the decode).
 *
 *  Stage vocabulary (server-side progress registry):
 *    downloading — media download (URL runs) OR MT-model fetch during translating
 *    resolving   — URL metadata probe (folds onto the download row)
 *    loading     — MT-model loading (always a translating sub-phase)
 *    waiting     — semaphore queue (folds onto transcribe)
 *    separating, transcribing, diarizing, translating — pipeline stages
 *
 *  NOTE: "downloading" is ambiguous — it can be a media download (download rail)
 *  or an MT-model fetch (translating rail). railOf maps it to the download row;
 *  foldProgress and activeRailIndex first ask mtFetchStage, which keeps a
 *  "downloading" poll after the rail moved past the download on the active row. */
export function railOf(stage: string | undefined | null): RailStage {
  // "resolving" (the metadata probe) folds onto the download row the same
  // way "waiting"/"analyzing" fold onto transcribe — seconds-long phases
  // don't get their own rail rows.
  if (stage === "downloading" || stage === "resolving") return "downloading";
  // "loading" is the MT-model loading sub-phase — always part of translation.
  if (stage === "loading") return "translating";
  return stage === "separating" || stage === "diarizing" || stage === "translating"
    ? stage
    : "transcribing";
}

/** The rail row a "downloading" poll belongs to when it is the translation model's fetch,
 *  a sub-phase of translating (the server's run plan labels it the same way and never
 *  rewinds to a finished row). The poll says so itself: the server goes translating →
 *  downloading within milliseconds, and its progress entry keeps the translating tick's
 *  llama.cpp `compute` ("gguf") and model — so a client polling once a second, which may
 *  never see that translating tick, still tells the fetch from the media download (and
 *  from a Whisper model's). `mtModel` = the run's translation model, when known. Else
 *  (an older server): a media download only ever runs first, so after a later stage was
 *  observed it is the fetch, on the last observed stage whose clock is still open.
 *  Null = not such a poll (use railOf). */
function mtFetchStage(
  p: Pick<BatchProgress, "stage" | "compute" | "model"> | null | undefined,
  stageTimes: Partial<Record<RailStage, StageTime>>,
  mtModel?: string,
): RailStage | null {
  if (p?.stage !== "downloading") return null;
  if (p.compute === "gguf" || (!!mtModel && p.model === mtModel)) return "translating";
  for (let i = RAIL_ORDER.length - 1; i > 0; i--) {
    const t = stageTimes[RAIL_ORDER[i]];
    if (t?.observed && !t.end) return RAIL_ORDER[i];
  }
  return null;
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

/** The warning a link run whose site transcript track could not be fetched carries: it ran the
 *  whole audio pipeline instead. */
export const SITE_TRANSCRIPT_FALLBACK = "The audio was transcribed instead of using the site's subtitles.";

/** Does this link's run use the site's own subtitle track as its transcript (no audio stages)? */
export function linkUsesSiteTranscript(meta: TranscribeRunState["urlMeta"][string] | undefined): boolean {
  return !!meta?.siteSubs?.transcriptTrackId;
}

export function setUrlMeta(url: string, meta: TranscribeRunState["urlMeta"][string]) {
  set((s) => ({ urlMeta: { ...s.urlMeta, [url]: { ...s.urlMeta[url], ...meta } } }));
}

export function addFiles(paths: string[]) {
  resetForInputChange();
  stageFiles(paths);
}

/** Adds inputs for the NEXT run without touching the current one: no reset, no abandon. Safe
 *  mid-run because startRun snapshots `files` into the queue once and the pump never reads it. */
export function stageFiles(paths: string[]) {
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
  // record already belongs to this path, keep it — idByPath only holds
  // the last-registered record per path, and the user may have an OLDER
  // same-path record open (three records of one URL). Recomputing here used
  // to swap the overlay/run key under the viewer mid-look.
  set((s) => {
    const cur = s.openRecordId ? registered(s.openRecordId) : undefined;
    return {
      selectedPath: path,
      openRecordId:
        path && cur && cur.sourcePath === path
          ? s.openRecordId
          : (path && registered(path)?.id) || null,
    };
  });
}

// ── history bridge ───────────────────────────────────────────────────────────
// Which records the workbench may re-save, by ID only — the record itself is always read
// back from the history mirror (currentRecord). These maps used to hold full copies, which
// went stale the moment the viewer (or a media fetch) upserted the record directly: the
// next rename/edit re-saved the old copy and reverted videoPath, sourceMediaId, an expired
// id's deletion. Every registration also upserts (recordRun, the persist paths) or passes a
// record the mirror holds (openHistoryRecord), so a registered id resolves unless deleted.
//
// Overlay slots and edit persistence are keyed by RECORD ID — the path can't do it, two
// records of the same URL share theirs.
const registeredIds = new Set<string>();
// The latest-registered record id per source path. A finished run registers here; a
// reopened record re-registers, so later corrections re-save under the SAME id instead of
// forking a new entry.
const idByPath: Record<string, string> = {};
// One timer PER overlay key: a single handle let an edit to record B (opened from
// History inside the debounce window) cancel a pending write for record A.
const persistTimers = new Map<string, number>();

function registerRecord(rec: TranscriptRecord) {
  idByPath[rec.sourcePath] = rec.id;
  registeredIds.add(rec.id);
}

/** The current copy of a registered record, by overlay key: a record id, or a legacy path
 *  key through idByPath. Undefined = not ours, or deleted since (the mirror no longer has
 *  it) — every writer treats that as "nothing to save". */
function registered(key: string): TranscriptRecord | undefined {
  const id = registeredIds.has(key) ? key : idByPath[key];
  return id ? currentRecord(id) : undefined;
}

/** Drop a deleted record from the registries (and close it if it is the open one), so a
 *  later overlay edit or chunk merge cannot re-save it. `null` = every record (bulk).
 *  `deleted` (bulk only): the records themselves are being deleted (Settings' clear) — stop
 *  every lost request's job too, as the single-id path does, or the finished job lands its
 *  transcript again. Without it the records are only re-homed (a storage move or reset keeps
 *  their ids): only the pending writes go, since one firing before the reload would re-save
 *  the pre-move paths. The ID registry stays — it re-reads the mirror (currentRecord), so the
 *  open record keeps its overlays and later edits save onto the moved copy. */
export function forgetRecord(id: string | null, opts?: { deleted?: boolean }): void {
  if (id === null) {
    for (const t of persistTimers.values()) window.clearTimeout(t);
    persistTimers.clear();
    if (!opts?.deleted) return;
    // A lost request's failed record carries its job id: one registered here, or one an
    // earlier launch left (reconcile watches it headless, nothing registered it). The
    // hook skips the rail's reattached run and is a no-op for an id nothing watches.
    const ids = new Set(registeredIds);
    for (const r of useTranscriptHistory.getState().records) if (r.status === "failed") ids.add(r.id);
    for (const jobId of ids) orphanForget?.(jobId);
    registeredIds.clear();
    for (const k of Object.keys(idByPath)) delete idByPath[k];
    set({ openRecordId: null });
    return;
  }
  registeredIds.delete(id);
  // A lost request's failed record carries its job id: deleting it must also stop the
  // headless watcher and drop the ledger row, or the finished job re-adds the record.
  // Unconditional: the ledger evicts a watched row after 20 newer requests, and the
  // stop is a no-op for an id nothing watches or ledgers.
  orphanForget?.(id);
  // By value, not via the record's sourcePath: deleteRecord calls this before the mirror
  // drops the record, but nothing guarantees the mirror still has it.
  for (const [p, v] of Object.entries(idByPath)) if (v === id) delete idByPath[p];
  window.clearTimeout(persistTimers.get(id));
  persistTimers.delete(id);
  if (get().openRecordId === id) set({ openRecordId: null });
}
setRecordForgetHook(forgetRecord);

/** After a storage move (Rust rewrote every record's media paths; loadHistory(true) reloaded
 *  them): point each queue row at its record's moved copy. A row keeps the path its run or the
 *  opened record stamped, and the viewer and the export prefer it over the record's, so they
 *  went on playing and exporting a file no longer there. A row follows the open record when it
 *  shows it, else its path's latest registered record. */
export function refreshRowMediaPaths(): void {
  const s = get();
  const open = s.openRecordId ? registered(s.openRecordId) : undefined;
  let changed = false;
  const queue = s.queue.map((it) => {
    const rec = open && open.sourcePath === it.path ? open : registered(it.path);
    if (!rec?.mediaPath || rec.mediaPath === it.mediaPath) return it;
    changed = true;
    return { ...it, mediaPath: rec.mediaPath };
  });
  if (changed) set({ queue });
}

/** After "Delete audio from link transcriptions" (`wiped`: the copy paths the wipe deleted,
 *  already stripped from their records): drop a queue row's copy that is one of them while its
 *  record no longer holds one. The row's path wins over the record's in the viewer and the
 *  export, so an open link transcript went on playing and exporting the deleted file, and
 *  refreshRowMediaPaths only re-points a row, never clears it. A record that still holds a copy
 *  (one stamped during the wipe) or a row not resolving to a record keeps its path. */
export function clearWipedRowMediaPaths(wiped: ReadonlySet<string>): void {
  const s = get();
  const open = s.openRecordId ? registered(s.openRecordId) : undefined;
  let changed = false;
  const queue = s.queue.map((it) => {
    if (!it.mediaPath || !wiped.has(it.mediaPath)) return it;
    const rec = open && open.sourcePath === it.path ? open : registered(it.path);
    if (!rec || rec.mediaPath) return it;
    changed = true;
    return withoutCopyPath(it, "mediaPath");
  });
  if (changed) set({ queue });
}

/** Re-save a record with the CURRENT overlays, debounced — every
 *  rename/recolor/correction lands in the history within a second, without a
 *  disk write per keystroke. `key` is the overlay key: the record id
 *  (legacy path keys still resolve through idByPath). The record is re-read
 *  when the timer fires, so the overlays land on its latest copy. */
function schedulePersistEdits(key: string) {
  if (!registered(key)) return;
  window.clearTimeout(persistTimers.get(key));
  persistTimers.set(key, window.setTimeout(() => persistEditsNow(key), 800));
}

/** The debounced write itself: drop the key's timer entry first, then re-save the record's
 *  latest copy with the current overlays. */
function persistEditsNow(key: string) {
  persistTimers.delete(key);
  const rec = registered(key);
  if (!rec) return;
  const s = get();
  const updated: TranscriptRecord = {
    ...rec,
    renames: s.renames[key],
    speakerColors: s.speakerColors[key],
    edits: s.edits[key],
    speakerEdits: s.speakerEdits[key],
    translationsStale: s.translationsStale[key],
    translatedFromEdit: s.translatedFromEdit[key],
  };
  registerRecord(updated);
  upsertRecord(updated);
}

/** Run every pending edit write now (quit / reload / session end). Synchronous: it only hands
 *  the records to upsertRecord, so a following `flushRecordWrites()` lands them on disk. */
export function flushPersistEdits(): void {
  for (const [key, t] of [...persistTimers]) {
    window.clearTimeout(t);
    persistEditsNow(key);
  }
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
  // A run ingested from the server's job resource after a restart brings its
  // own identity: the job id (so a second ingest upserts, never duplicates),
  // the moment it was posted, the link title the ledger kept — and it may
  // land HEADLESS, with no queue row to stamp and no viewer to open.
  extra: { id?: string; createdAt?: string; title?: string; touchQueue?: boolean } = {},
): TranscriptRecord {
  const s = get();
  const isUrl = isSourceUrl(path);
  const title = extra.title ?? s.urlMeta[path]?.title;
  const rec: TranscriptRecord = {
    schemaVersion: 1,
    kind: itemSourceKind({ path }),
    title: isUrl ? title : undefined,
    id: extra.id ?? crypto.randomUUID(),
    createdAt: extra.createdAt ?? new Date().toISOString(),
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
  if (extra.touchQueue === false) return rec;
  // The viewer identifies the open transcript by its timestamp — same-URL
  // records are otherwise indistinguishable (the URL is the queue key).
  patchItem(path, { createdAt: rec.createdAt });
  // A just-finished run that's on screen is what the Recent strip should
  // mark as open.
  if (get().selectedPath === path) set({ openRecordId: rec.id });
  return rec;
}

/** Patch a record's own queue row. The row is keyed by PATH, and two records of one source
 *  share it: while record A's late work (a chunk merge, an audio copy) is still in flight, the
 *  user may open record B of the same file or link from History — patching by path then
 *  painted A's data under B's header (A's segments, or A's audio played and exported as B's).
 *  Only THAT collision is suppressed: an open record of a different path leaves A's own row
 *  updated. */
function patchOwnRow(rec: TranscriptRecord, patch: Partial<QueueItem>) {
  const openId = get().openRecordId;
  const open = openId ? registered(openId) : undefined;
  if (!open || open.id === rec.id || open.sourcePath !== rec.sourcePath) patchItem(rec.sourcePath, patch);
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
      patchOwnRow(rec, { mediaPath });
      // Merge onto the record's LATEST copy, by id — and only while it is still ours: a
      // record deleted (or wiped) during the copy stays gone.
      if (registeredIds.has(rec.id)) patchRecord(rec.id, stampCopyPath(rec.id, "mediaPath", mediaPath));
    })
    .catch((e) => console.error("audio copy failed:", e));
}

/** URL-run counterpart of copyRunMedia: pull the server-retained download
 *  into the local store (`<base>/links/`). Gated on its OWN setting
 *  (keepUrlAudioCopies, default on) — never on keepAudioCopies, because a
 *  link run has no other playable source. Best-effort: null (retention
 *  expired) or an error leaves the transcript fully usable, minus playback. */
function fetchRunUrlMedia(rec: TranscriptRecord, ctx: RunContext, mediaId: string) {
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
      patchOwnRow(rec, { mediaPath });
      // Merge onto the record's LATEST copy, by id — and only while it is still ours: a
      // record deleted (or wiped) during the copy stays gone.
      if (registeredIds.has(rec.id)) patchRecord(rec.id, stampCopyPath(rec.id, "mediaPath", mediaPath));
    })
    .catch((e) => console.error("url media fetch failed:", e));
}

/** Pull the server-retained VIDEO of a link run into the local video store
 *  (keepUrlVideoCopies gate is the run's own keep_video choice — the server
 *  only holds a video the user asked for) and stamp it on the record as
 *  `videoPath`, merged onto the record's latest copy like the audio copy. */
function fetchRunUrlVideo(rec: TranscriptRecord, ctx: RunContext, mediaId: string) {
  // A record deleted meanwhile: downloading its video would only leave an orphan file.
  if (!registeredIds.has(rec.id)) return;
  const s = useApp.getState().settings;
  void fetchUrlVideo({
    serverUrl: ctx.serverUrl,
    backendId: ctx.backendId,
    mediaId,
    recordId: rec.id,
    audioBase: audioBasePref(s.recording),
  })
    .then((videoPath) => {
      if (!videoPath) return;
      if (registeredIds.has(rec.id)) patchRecord(rec.id, stampCopyPath(rec.id, "videoPath", videoPath));
    })
    .catch((e) => console.error("url video fetch failed:", e));
}

const NO_LONGER_TRACKED = "the server no longer tracks this video";
// A jobs-off server closes the progress entry right after the video ends but keeps no job row
// to read the outcome (or media id) from: the video may well sit finished on the server.
const NO_JOB_RECORD = "this server keeps no record of how the video ended — Try again downloads it once more";
// The poll's two-hour deadline on a run's own video: the server may still be on it, but nothing
// here watches any more (an on-demand request is still watched — its answer settles the row).
const TOOK_TOO_LONG = "the video took too long — Try again downloads it once more";

/** The transcript returned while its video was still downloading: keep
 *  polling the run's progress id (its own poller: every second while this
 *  link is the one on screen, every 5 s otherwise or while the window is
 *  hidden — the run poller is gone)
 *  until the `video` sub-object reaches a terminal state, folding it
 *  into the rail only while this run is still the one on screen, then pull
 *  the file. Gives up when the entry vanishes (server restart / stale
 *  sweep) or after two hours — a run's own poll (no `request`) first asks
 *  the job row, which the server stamps with the video's outcome just
 *  before it closes the entry. `jobRow` = such a row exists: a jobs-off
 *  server closes the entry all the same but keeps no outcome to ask for.
 *
 *  `request` = an on-demand fetch's own request (startOnDemandVideo): the
 *  server closes that entry the moment the video is done, so a poll almost
 *  never sees "done" — the request's answer is the completion signal, and
 *  "no entry" only ends the poll once the request has settled (before the
 *  handler claims the id the entry does not exist yet either). */
function awaitRunUrlVideo(
  rec: TranscriptRecord,
  ctx: RunContext,
  pid: string,
  epoch: number,
  request?: Promise<UrlMediaDownload | null>,
  jobRow = !!ctx.jobsEnabled,
) {
  const startedAt = Date.now();
  // Started after its file took the rail (every caller): a later same-path file is a new seq.
  const railSeq = railFileSeq;
  // The video is pulled once, whichever of a terminal poll and the request's answer is first.
  let pulled = false;
  const pull = (mediaId: string) => {
    if (pulled) return;
    pulled = true;
    fetchRunUrlVideo(rec, ctx, mediaId);
  };
  let requestSettled = !request;
  // The on-demand request failed: its 'failed' row stands, no poll repaints it.
  let ended = false;
  let inFlight = false;
  // An unreachable server backs the poll off (2, 4, … up to 30 s between
  // tries) instead of failing once a second until the deadline; a short
  // sleep still resumes the fetch.
  let failures = 0;
  let skip = 0;
  // The current skip is only the hidden window's (a painting poll): a show clears it so the
  // row resumes 1 s at once. Never a failure backoff's, which must run its course.
  let hiddenSkip = false;
  const timer = window.setInterval(() => {
    if (inFlight) return;
    // The record was deleted: nothing is left to take the video.
    if (!registeredIds.has(rec.id)) {
      end();
      return;
    }
    if (Date.now() - startedAt > 2 * 60 * 60 * 1000) {
      end();
      // An on-demand request still open (its own, longer timeout) settles the row with its
      // answer: failed here, Try again would start a second download beside the live one, and
      // the first answer would then paint "done" over the new attempt.
      if (request) return;
      // Settle the row like a closed entry does: left on its last "downloading"/"queued", its
      // clock ran on and Try again never showed. A run's own id may have finished meanwhile.
      if (jobRow) settleFromJob(1, TOOK_TOO_LONG);
      else paintSettled(null, TOOK_TOO_LONG);
      return;
    }
    if (skip > 0) {
      skip -= 1;
      return;
    }
    inFlight = true;
    getTranscribeProgress({ serverUrl: ctx.serverUrl, backendId: ctx.backendId, progressId: pid })
      .then((p) => {
        failures = 0;
        // The request's answer landed while this poll was out: it must not repaint the row.
        if (pulled || ended) return;
        const painting = onScreen();
        // A poll that paints nothing (headless, epoch -1, or its link no longer
        // on screen) only feeds the terminal check: match the headless watcher's
        // 5 s cadence — as does one nobody can see (window hidden to the tray).
        // Recomputed each poll, so a link back on screen resumes 1 s; an on-demand
        // request's answer still completes the row at once.
        if (!painting || isWindowHidden()) skip = 4;
        hiddenSkip = painting && isWindowHidden();
        if (p.stage === "unknown" || !p.stage) {
          // Entry gone without a terminal state. An on-demand request still
          // open has not claimed it yet, or answers itself.
          if (!p.video && requestSettled) {
            end();
            // A run's own id is its job id: the server closes the entry only after it
            // wrote the video's outcome onto the job row, a "done" a 1 s poll almost
            // always misses.
            if (!request) {
              if (jobRow) settleFromJob(1);
              else paintSettled(null, NO_JOB_RECORD);
            }
            return;
          }
        }
        const video = p.video;
        if (video && painting) {
          set((s) => {
            // This attempt's request failed and marked the row (the handler, a microtask
            // behind, ends the poll); a stale attempt's failure cannot paint (pid check).
            if (request && onDemandVideoPid === pid && s.stageMeta.downloading?.video?.state === "failed") return s;
            return {
              stageMeta: {
                ...s.stageMeta,
                downloading: foldVideo(s.stageMeta.downloading, video, Date.now()),
              },
            };
          });
        }
        const st = p.video?.state;
        if (videoTerminal(st)) {
          end();
          if (st === "done" && p.video?.mediaId) pull(p.video.mediaId);
        }
      })
      .catch(() => {
        failures += 1;
        skip = Math.min(2 ** failures, 30) - 1;
        hiddenSkip = false;
      })
      .finally(() => { inFlight = false; });
  }, 1000);
  const offHidden = onWindowHiddenChange((hidden) => {
    if (hidden || !hiddenSkip) return;
    skip = 0;
    hiddenSkip = false;
  });
  // Every way the poll ends drops the show listener with the timer.
  function end() {
    window.clearInterval(timer);
    offHidden();
  }
  // The epoch stays the same across the files of one run: only the link the rail is
  // showing may take this video's progress — and a same-path retry is a different file on
  // the rail (`railFileSeq`).
  function onScreen() {
    return epoch === get().epoch && railSeq === railFileSeq && get().lastRunPath === rec.sourcePath;
  }
  // Read the video's outcome off the job row: pull a finished one, else mark the row failed
  // so Try again shows (the row would otherwise stay at its last "downloading"). A transport
  // error is asked once more a poll later before it becomes the verdict.
  // `gone` = the reason when the row names no outcome of its own.
  function settleFromJob(retries: number, gone = NO_LONGER_TRACKED) {
    void getJobResult({ serverUrl: ctx.serverUrl, backendId: ctx.backendId, jobId: pid })
      .catch((e): { kind: "error"; message: string } => ({ kind: "error", message: errorText(e, 200) }))
      .then((o) => {
        if (pulled || !registeredIds.has(rec.id)) return;
        if (o.kind === "error" && retries > 0) {
          setTimeout(() => settleFromJob(retries - 1, gone), 1000);
          return;
        }
        const res = o.kind === "ok" ? o.value : null;
        paintSettled(res, o.kind === "error" ? o.message : o.kind === "disabled" ? NO_JOB_RECORD : gone);
      });
  }
  // The settled outcome: `res` names the video's media id (done) or its error, else the row
  // fails with `fallback`.
  function paintSettled(res: BatchResult | null, fallback: string) {
    if (pulled || !registeredIds.has(rec.id)) return;
    const mediaId = res?.sourceVideoMediaId;
    if (onScreen()) {
      const prev = get().stageMeta.downloading?.video;
      const video: VideoProgress = res && mediaId
        ? {
            ...prev,
            state: "done",
            mediaId,
            expiresAt: res.sourceVideoExpiresAt ?? prev?.expiresAt,
            bytes: res.sourceVideoBytes ?? prev?.bytes,
            height: res.sourceVideoHeight ?? prev?.height,
            container: res.sourceVideoContainer ?? prev?.container,
            error: null,
          }
        : { ...prev, state: "failed", error: res?.sourceVideoError ?? fallback };
      set((s) => ({
        stageMeta: { ...s.stageMeta, downloading: foldVideo(s.stageMeta.downloading, video, Date.now()) },
      }));
    }
    if (mediaId) pull(mediaId);
  }
  // A failed request (null) already marked the Video row failed: the poll ends with it
  // (Try again recovers).
  void request?.then((dl) => {
    requestSettled = true;
    if (pulled) return;
    end();
    if (!dl) {
      ended = true;
      return;
    }
    if (!registeredIds.has(rec.id)) return;
    if (onScreen()) {
      const prev = get().stageMeta.downloading?.video;
      // The answer's own height/container: a short fetch no poll saw still names its format.
      // An answer at another height (a Try again at a different pick) is another rung: the
      // earlier attempt's label and codecs would contradict it.
      const otherRung = dl.height != null && dl.height !== prev?.height;
      const video: VideoProgress = {
        ...prev,
        ...(otherRung ? { label: null, vcodec: null, acodec: null, formatId: null } : {}),
        state: "done",
        mediaId: dl.mediaId,
        expiresAt: dl.expiresAt,
        bytes: dl.bytes,
        height: dl.height ?? prev?.height,
        container: dl.container ?? prev?.container,
        error: null,
      };
      set((s) => ({
        stageMeta: { ...s.stageMeta, downloading: foldVideo(s.stageMeta.downloading, video, Date.now()) },
      }));
    }
    pull(dl.mediaId);
  });
}

/** The Video row's "Try again": fetch the link's video on demand for the
 *  panel's finished link run, folding the server's progress into the same
 *  `video` sub-object the run used, then pull the file like a kept one.
 *  Runs through the run's own progress id so the rail keeps one clock. */
export function retryRunVideo(path: string, ctx: RunContext): void {
  const s = get();
  // The OPEN record first: idByPath holds the last-registered record of the path, and
  // the panel may show an older same-link one.
  const open = s.openRecordId ? registered(s.openRecordId) : undefined;
  const rec = open && open.sourcePath === path ? open : registered(path);
  if (!rec || !s.stageMeta.downloading?.video) return;
  const epoch = s.epoch;
  const pid = newProgressId();
  set((st2) => ({
    stageMeta: {
      ...st2.stageMeta,
      downloading: {
        ...st2.stageMeta.downloading,
        video: { ...(st2.stageMeta.downloading?.video as VideoProgress), state: "queued",
                 progress: null, downloadedBytes: null, error: null },
        // Started by the first "downloading" poll: queue time is not transfer time.
        videoDlStart: undefined,
        videoDlEnd: undefined,
      },
    },
  }));
  awaitRunUrlVideo(rec, ctx, pid, epoch, startOnDemandVideo(path, ctx, pid, epoch));
}

/** The video height a link downloads at: the link card's pick, else the Settings default. */
export function videoMaxHeightOf(url: string): number | null {
  const meta = get().urlMeta[url];
  return meta?.videoMaxHeight !== undefined
    ? meta.videoMaxHeight
    : useApp.getState().settings.transcribe?.urlVideoMaxHeight ?? null;
}

/** The latest on-demand video attempt's pid: only its request may mark the Video row failed. */
let onDemandVideoPid: string | null = null;

/** Fetch a link's video on demand under `pid` (awaitRunUrlVideo folds its progress into the
 *  Video row); a request that fails outright marks the Video row failed. Resolves to the
 *  server's answer, null on failure — hand it to awaitRunUrlVideo, which pulls the file. */
function startOnDemandVideo(
  url: string,
  ctx: RunContext,
  pid: string,
  epoch: number,
): Promise<UrlMediaDownload | null> {
  const railSeq = railFileSeq;
  onDemandVideoPid = pid;
  return fetchUrlVideoOnDemand({
    serverUrl: ctx.serverUrl,
    backendId: ctx.backendId,
    url,
    maxHeight: videoMaxHeightOf(url),
    formatId: get().urlMeta[url]?.videoFormat ?? null,
    progressId: pid,
  }).catch((e) => {
    // A Try again started a new attempt (same file, new pid): this stale failure is not its.
    if (epoch !== get().epoch || railSeq !== railFileSeq || get().lastRunPath !== url
        || onDemandVideoPid !== pid) return null;
    set((st2) => ({
      stageMeta: {
        ...st2.stageMeta,
        downloading: {
          ...st2.stageMeta.downloading,
          video: { ...(st2.stageMeta.downloading?.video as VideoProgress), state: "failed",
                   error: errorText(e, 200) },
        },
      },
    }));
    return null;
  });
}

/** Load a history record back into the workbench: one settled queue row,
 *  selected, with its overlays restored. Refused mid-run (the pump owns the
 *  queue then). */
export function openHistoryRecord(rec: TranscriptRecord): boolean {
  if (get().running) return false;
  // Loading a history record replaces the workbench (epoch bump below), so any
  // still-registered server-side run is ours to stop.
  abandonActiveRun();
  // Re-opening the open record (its Recent row stays clickable) while an edit still waits for
  // its debounced save: the caller's row predates that edit, and restoring the overlays from it
  // wiped the edit, which the pending timer then re-saved as gone. Save it now and read the
  // overlays back from the saved copy.
  const pending = persistTimers.get(rec.id);
  if (pending !== undefined) {
    window.clearTimeout(pending);
    persistEditsNow(rec.id);
    rec = currentRecord(rec.id) ?? rec;
  }
  // Every caller hands over a row it rendered from the history mirror, so the record is
  // there — but the registry resolves through the mirror, and a record missing from it
  // would open with edits that silently never save. Seed it rather than lose them.
  if (!currentRecord(rec.id)) upsertRecord(rec);
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
        kind: itemSourceKind({ path: rec.sourcePath }),
        title: rec.title,
        createdAt: rec.createdAt,
        status: rec.status,
        result: rec.result,
        error: rec.error,
        tookMs: rec.tookMs,
        mediaPath: rec.mediaPath,
        // A lost request's record (its id is the job id) whose job a watcher may still
        // finish: the row settles when it lands, like the pump's own failed row.
        ...(rec.status === "failed" && ledgerRows().some((r) => r.jobId === rec.id)
          ? { orphanJobId: rec.id } : {}),
      },
    ],
    selectedPath: rec.sourcePath,
    openRecordId: rec.id,
    progress: null,
    stageTimes: {},
    stageMeta: {},
    // The record stores its options verbatim (undefined = a run with no stage options) but
    // no decode overrides: an earlier run's set of either must not ride along into a retry
    // (or the rail's stages and VAD line).
    lastOptions: rec.options,
    runOptions: undefined,
    lastOverrides: {},
    // Overlay slots keyed by record ID — the path can't do it, two records
    // of the same URL share theirs (edits used to bleed between them).
    renames: { ...s.renames, [rec.id]: rec.renames ?? {} },
    speakerColors: { ...s.speakerColors, [rec.id]: rec.speakerColors ?? {} },
    edits: { ...s.edits, [rec.id]: rec.edits ?? {} },
    speakerEdits: { ...s.speakerEdits, [rec.id]: rec.speakerEdits ?? {} },
    translationsStale: { ...s.translationsStale, [rec.id]: rec.translationsStale ?? {} },
    translatedFromEdit: { ...s.translatedFromEdit, [rec.id]: rec.translatedFromEdit ?? {} },
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
  // Re-committing what the line already holds (a bare focus + blur on the row: the same
  // correction, or null on an uncorrected line) changes nothing — above all not the stale
  // mark of a translation, which a revert or a Discard may have set.
  if (get().edits[key]?.[index] === (text ?? undefined)) return;
  set((s) => {
    const file = { ...s.edits[key] };
    if (text === null) delete file[index];
    else file[index] = text;
    // Editing the ORIGINAL text marks this segment's translations stale (they
    // translated the old text); reverting the edit clears the mark — unless
    // they were made from a correction, which then no longer matches either.
    // That note stays after the revert: a later correction and its revert (or
    // Discard) would otherwise call the old correction's translation fresh.
    const rec = registered(key);
    const hasTr = !!rec?.result?.segments?.[index]?.translations;
    let translationsStale = s.translationsStale;
    if (hasTr) {
      const stale = { ...s.translationsStale[key] };
      if (text === null && !s.translatedFromEdit[key]?.[index]) delete stale[index];
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
    // Discarding the corrections restores the text the MT translated — except
    // where a re-translate ran on a correction: those segments go stale. Only the
    // corrected lines change; an uncorrected line keeps its mark (a translation of
    // a correction reverted earlier, or of text a line was sent as). The
    // made-from-a-correction notes stay: a merge of the original text drops them.
    const stale = { ...s.translationsStale[key] };
    const fromEdit = s.translatedFromEdit[key] ?? {};
    for (const k of Object.keys(s.edits[key] ?? {})) delete stale[Number(k)];
    for (const k of Object.keys(fromEdit)) stale[Number(k)] = true;
    if (Object.keys(stale).length) translationsStale[key] = stale;
    else delete translationsStale[key];
    return { edits, speakerEdits, translationsStale };
  });
  schedulePersistEdits(key);
}

/** Merge fresh per-segment translations into a record (re-translate /
 *  retro-translate): updates the persisted record DIRECTLY (not via the
 *  debounced schedulePersistEdits — its single timer handle could drop a
 *  pending write for another key), patches the open queue item so the viewer
 *  re-renders, and clears the merged indexes' stale marks — only where the
 *  merge re-translated what the line says now, in every language it holds. */
export function mergeSegmentTranslations(
  key: string,
  patch: Record<number, Record<string, string>>,
  provenance?: { model?: string; targets?: string[]; source?: string; mode?: string },
  /** Per merged index: target codes whose entry kept the SOURCE text (server
   *  quality guard). Replaces the mark for the languages in this patch — a
   *  successful re-translate passes [] (or omits the map) and clears it.
   *  Marks of languages NOT in this patch are carried forward so a re-translate
   *  targeting a subset of tracks never erases untouched tracks' marks. */
  kept?: Record<number, string[]>,
  /** Per merged index: the text it was SENT as (the chunk's textOf, read before the round
   *  trip). Absent = taken to be the line's current text. */
  sent?: Record<number, string>,
) {
  const rec = registered(key);
  if (!rec?.result?.segments) return;
  /** The languages each merged line held a translation in before this merge. */
  const held = new Map(Object.keys(patch).map((k) => [Number(k), Object.keys(rec.result?.segments?.[Number(k)]?.translations ?? {})]));
  const segments = rec.result.segments.map((seg, i) => {
    if (!patch[i]) return seg;
    const next: typeof seg = { ...seg, translations: { ...seg.translations, ...patch[i] } };
    // Carry the marks of languages this patch did NOT touch: a re-translate
    // targeting a SUBSET of the record's tracks must not erase the untouched
    // tracks' kept-original marks.
    const touched = new Set(Object.keys(patch[i]));
    const carried = (seg.translationsKept ?? []).filter((l) => !touched.has(l));
    const marks = [...carried, ...(kept?.[i] ?? [])];
    if (marks.length) next.translationsKept = marks;
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
        // `||`: an auto-detect answer's empty source never overwrites a known one.
        source: provenance?.source || rec.result.translation?.source || translateSourceCode(rec.result.language) || undefined,
        mode: provenance?.mode ?? rec.result.translation?.mode,
        targets,
      },
    },
  };
  // Settle the merged indexes' stale marks FIRST so the persisted record
  // carries the post-merge state (upsertRecord stringifies synchronously).
  // A segment translated from a correction (the retro-translate sends the edited
  // text) is noted, so dropping the correction marks it stale again.
  set((s) => {
    const stale = { ...s.translationsStale[key] };
    const fromEdit = { ...s.translatedFromEdit[key] };
    for (const k of Object.keys(patch)) {
      const i = Number(k);
      const original = (rec.result?.segments?.[i]?.text ?? "").trim();
      const now = (s.edits[key]?.[i] ?? rec.result?.segments?.[i]?.text ?? "").trim();
      const was = sent?.[i] ?? now;
      if (was !== now) {
        // Corrected (or the correction dropped) while the chunk was in flight: the
        // translation is of the text it was sent as, not of what the line says now.
        stale[i] = true;
        if (was !== original) fromEdit[i] = true;
        else delete fromEdit[i];
        continue;
      }
      // Another language of the line (one this merge did not re-translate) still
      // translates whatever the line said before: its mark stands.
      if (!(held.get(i) ?? []).every((l) => hasOwn(patch[i], l))) {
        if (s.edits[key]?.[i] !== undefined) fromEdit[i] = true;
        continue;
      }
      delete stale[i];
      if (s.edits[key]?.[i] !== undefined) fromEdit[i] = true;
      else delete fromEdit[i];
    }
    return {
      translationsStale: { ...s.translationsStale, [key]: stale },
      translatedFromEdit: { ...s.translatedFromEdit, [key]: fromEdit },
    };
  });
  updated.translationsStale = get().translationsStale[key];
  updated.translatedFromEdit = get().translatedFromEdit[key];
  registerRecord(updated);
  upsertRecord(updated);
  // Never onto another open record of the same source (patchOwnRow).
  patchOwnRow(rec, { result: updated.result });
}

/** Fold a video sub-object into the download row's meta: its clock starts at
 *  the first "downloading" state (queue time is not transfer time) and stops
 *  at the first terminal one. Shared by the run poll and awaitRunUrlVideo. */
function foldVideo(dl: StageMeta | undefined, video: VideoProgress, now: number): StageMeta {
  return {
    ...dl,
    video,
    videoDlStart: dl?.videoDlStart ?? (video.state === "downloading" ? now : undefined),
    videoDlEnd: videoTerminal(video.state) ? (dl?.videoDlEnd ?? now) : undefined,
  };
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
    // An MT-model fetch ("downloading" after the rail moved past the download) stays on
    // the active row: no clock closes or reopens, and the media receipt below is kept.
    const mtModel = (s.runOptions ?? s.lastOptions)?.translationModel?.trim() || undefined;
    const mtPrev = s.progress ? mtFetchStage(s.progress, s.stageTimes, mtModel) : null;
    const prev = s.progress ? (mtPrev ?? railOf(s.progress.stage)) : null;
    const mtFetch = mtFetchStage(p, s.stageTimes, mtModel);
    const cur = mtFetch ?? railOf(p.stage);
    // "waiting" is the registry's request-entry seed, not evidence the
    // transcribe row ran: it must not stamp a clock `observed` — a seeded
    // phantom span would read as the stage having run.
    const obs = p.stage !== "waiting";
    let stageTimes = s.stageTimes;
    // Every poll marks its stage observed — a stage whose clock only ever got
    // seeded (never polled) is one the server jumped over.
    if (prev !== cur) {
      stageTimes = { ...stageTimes };
      const pc = prev ? stageTimes[prev] : undefined;
      if (prev && pc && !pc.end) {
        stageTimes[prev] = { ...pc, end: now };
      }
      // Close every still-open clock whose pipeline order is before `cur`.
      // This handles seeded clocks for stages the server skipped (e.g. the
      // pump seeds "separating" at request entry, but if the server declines
      // BGM separation and jumps to "transcribing", the seeded clock must be
      // closed — otherwise it spans the whole run and defeats the "skipped"
      // inference). Only when `obs` is true: "waiting" is not evidence that
      // the earlier stages won't still happen.
      if (obs) {
        const curIdx = RAIL_ORDER.indexOf(cur);
        for (let ri = 0; ri < curIdx; ri++) {
          const st = RAIL_ORDER[ri];
          const tc = stageTimes[st];
          if (tc && !tc.end) {
            stageTimes[st] = { ...tc, end: now };
          }
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
    // A model fetch folded onto another row (the older-server fallback) names the
    // translation model: those chips belong to the translating row only.
    if (p.model && p.stage !== "waiting" && (!mtFetch || mtFetch === "translating")) {
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
    if (p.stage === "downloading" && !mtFetch && !stageMeta.downloading?.dlStart) {
      stageMeta = {
        ...stageMeta,
        downloading: { ...stageMeta.downloading, dlStart: now },
      };
    }
    // keep_video runs: the secondary video fetch rides in the entry's
    // `video` sub-object on every poll (also after the transcript returned,
    // via awaitRunUrlVideo). It never reopens the download row's clock.
    if (p.video) {
      stageMeta = { ...stageMeta, downloading: foldVideo(stageMeta.downloading, p.video, now) };
    }
    // Per-unit clock (a translation target, a diarization step): the first
    // poll naming it starts its ledger line's elapsed ticker (the server's
    // elapsed_s only moves per poll).
    if (p.target && (cur === "translating" || cur === "diarizing") &&
        !ownProp(stageMeta[cur]?.unitStarts, p.target)) {
      stageMeta = {
        ...stageMeta,
        [cur]: {
          ...stageMeta[cur],
          unitStarts: { ...stageMeta[cur]?.unitStarts, [p.target]: now },
        },
      };
    }
    return { progress: p, stageTimes, stageMeta };
  });
}

/** Bumped each time a file takes the rail (the pump's per-file reset, a reattach). A same-path
 *  retry re-pumps the link under the same epoch, so epoch + `lastRunPath` cannot tell the
 *  first run's still-polling video watcher from the retry's: the watcher captures this at its
 *  start and paints only while it is still the rail's file. */
let railFileSeq = 0;

/** The in-flight file's server-side progress id + where to send a cancel for
 *  it. Module-level (not store state): only cancelRun reads it, and it must
 *  survive component unmounts exactly like the pump itself. */
let activeCancel: {
  /** Where a cancel goes, resolved when it is sent — a re-attached run's follows the
   *  backend's current address (an edit mid-run applies). */
  serverUrlOf: () => string;
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
  // A re-attached run has no pump; its watcher (lib/jobsReconcile.ts) is
  // what must stop, synchronously, before the cancel goes out — startRun's
  // `running` guard reads the store right after this returns.
  const stop = reattachStop;
  reattachStop = null;
  if (stop) stop();
  const target = activeCancel;
  activeCancel = null;
  // A plain object: the resolver is a function and never crosses the IPC.
  if (target) {
    void cancelBackendTranscription({
      serverUrl: target.serverUrlOf(),
      backendId: target.backendId,
      progressId: target.progressId,
    }).catch(() => {});
  }
}

/** The re-attached run's stop hook: clears its watcher, marks the store not
 *  running and forgets its ledger row. Set by jobsReconcile, consumed by
 *  abandonActiveRun (every epoch bump). */
let reattachStop: (() => void) | null = null;
export function setReattachStop(fn: (() => void) | null): void {
  reattachStop = fn;
}

/** Did the request lose contact with a server that may still be running its job? Our own
 *  wait ran out or the connection dropped mid-wait (reqwest's "error sending request",
 *  passed through by friendly_err), or a gateway gave up (502/504, or Cloudflare's 524 origin
 *  timeout — the proxy's answer, not the backend's; its 522/523 mean the origin never got the
 *  request). Never a connection that never came up ("Could not connect": the run's
 *  one POST never reached the server, so no job exists), an over-limit refusal, another
 *  HTTP answer (a 503 "timed out waiting for a peer worker" is the backend speaking), or a
 *  malformed body ("decoding response"): the job is settled or was never started, and a
 *  watcher would retry it for 72 h. */
export function lostContact(e: unknown): boolean {
  if (uploadTooLarge(e)) return false;
  const cause = shortCause(e);
  if (cause === "timed out") return true;
  if (cause === "HTTP 502" || cause === "HTTP 504" || cause === "HTTP 524") return true;
  // Only outside an HTTP answer: a backend's 500 body may quote the phrase.
  return cause === "see the log" && String(e ?? "").includes("error sending request");
}

/** Hands a ledgered job whose request lost contact (timed out, connection
 *  dropped) to a headless watcher, so a transcript the server still finishes
 *  lands in History. Set by jobsReconcile; unset, the pump forgets the row. */
let orphanWatch: ((jobId: string) => void) | null = null;
export function setOrphanWatch(fn: ((jobId: string) => void) | null): void {
  orphanWatch = fn;
}

/** Stops the watchOrphan watchers of these source paths and forgets their rows
 *  (retryFile, startRun). Keyed by path: the queue row that named the job may be gone
 *  (closeRecord, openHistoryRecord). Set by jobsReconcile. */
let orphanStop: ((paths: string[]) => void) | null = null;
export function setOrphanStop(fn: ((paths: string[]) => void) | null): void {
  orphanStop = fn;
}

/** Stops the watcher of one lost request and forgets its row (forgetRecord: the user
 *  deleted the failed record that carries the job id). Set by jobsReconcile. */
let orphanForget: ((jobId: string) => void) | null = null;
export function setOrphanForget(fn: ((jobId: string) => void) | null): void {
  orphanForget = fn;
}

/** Take over the rail for a run the server is still working on (found in
 *  the in-flight ledger at launch): the queue shows it running, the first
 *  stage's clock starts when the request originally left, and Cancel routes
 *  to the same server id at `serverUrlOf()` — the backend's address when Cancel is pressed, so
 *  an edit mid-run applies as it does to the watcher's polls. Returns the epoch the watcher
 *  must fold under. */
export function reattachRun(row: LedgerRow, serverUrlOf: () => string): number {
  abandonActiveRun();
  const isUrl = row.kind === "url";
  const first: RailStage = isUrl
    ? "downloading"
    : row.options?.separateBgm ? "separating" : "transcribing";
  const s = get();
  const epoch = s.epoch + 1;
  railFileSeq += 1;
  set({
    epoch,
    files: [row.path],
    // A link planned on the site's transcript track is ledgered only once it falls back to a
    // server transcription (runLink): a reattached one is transcribing the audio.
    queue: [{
      path: row.path, status: "running", kind: row.kind, title: row.title,
      ...(isUrl && linkUsesSiteTranscript(row.urlMeta) ? { siteFallback: true } : {}),
    }],
    selectedPath: null,
    openRecordId: null,
    lastRunPath: row.path,
    lastOptions: row.options,
    runOptions: undefined,
    lastOverrides: row.overrides ?? {},
    urlMeta: row.urlMeta ? { ...s.urlMeta, [row.path]: { ...s.urlMeta[row.path], ...row.urlMeta } } : s.urlMeta,
    progress: null,
    stageMeta: {},
    stageTimes: { [first]: { start: row.startedAt } },
    running: true,
  });
  activeCancel = { serverUrlOf, backendId: row.backendId, progressId: row.jobId };
  return epoch;
}

/** Land a result fetched from the server's job resource exactly as the POST
 *  path would have. `attached` = the run owns the rail (reattachRun ran):
 *  the queue row settles, the record opens, the clocks close. Headless =
 *  the record goes straight to History (the media copies still happen). */
export function ingestJobResult(
  row: LedgerRow,
  res: BatchResult,
  tookMs: number,
  opts: { attached: boolean },
): TranscriptRecord {
  const isUrl = row.kind === "url";
  const extra = {
    id: row.jobId,
    createdAt: new Date(row.startedAt).toISOString(),
    title: row.title,
    touchQueue: opts.attached,
  };
  if (opts.attached) {
    patchItem(row.path, { status: "done", result: res, tookMs });
    set({ selectedPath: row.path, openRecordId: null });
  } else if (get().queue.some((it) => it.path === row.path && it.orphanJobId === row.jobId && it.status === "failed")) {
    // The lost request's row still reads "failed" with Retry: the server finished after all.
    patchItem(row.path, { status: "done", result: res, tookMs, error: undefined, orphanJobId: undefined });
  }
  const rec = recordRun(row.path, row.ctx, row.options, { status: "done", result: res, tookMs }, extra);
  if (isUrl) {
    if (res.sourceMediaId) fetchRunUrlMedia(rec, row.ctx, res.sourceMediaId);
    if (res.sourceVideoMediaId) {
      fetchRunUrlVideo(rec, row.ctx, res.sourceVideoMediaId);
    } else if (res.sourceVideoPending) {
      // Headless: -1 never equals the store epoch, so the poll never paints
      // the rail — it only waits for the video and pulls it. A re-attached run always has its
      // job row (it was just read).
      awaitRunUrlVideo(rec, row.ctx, row.jobId, opts.attached ? get().epoch : -1, undefined, true);
    }
  } else {
    copyRunMedia(row.path, rec);
  }
  if (opts.attached) settleReattached();
  return rec;
}

/** A configured backend as the doorway names it: the picker's label (`backendLabel`, so two
 *  same-named backends carry their host suffix here as there). undefined once the id is gone —
 *  the doorway then keeps its own "the backend". */
function configuredBackendLabel(id: string): string | undefined {
  return backendLabelById(useApp.getState().backends, id) ?? undefined;
}

/** The re-attached run failed (server error, cancelled, or the server no
 *  longer knows it): a failed record, and — when it owns the rail — the
 *  queue row settles with the reason, the doorway banner names it. */
export function failJob(row: LedgerRow, error: string, opts: { attached: boolean }): TranscriptRecord {
  const extra = {
    id: row.jobId,
    createdAt: new Date(row.startedAt).toISOString(),
    title: row.title,
    touchQueue: opts.attached,
  };
  if (opts.attached) {
    patchItem(row.path, { status: "failed", error });
  } else if (get().queue.some((it) => it.path === row.path && it.orphanJobId === row.jobId && it.status === "failed")) {
    // The lost request's row still shows the transport error: name the server's reason.
    patchItem(row.path, { error, orphanJobId: undefined });
  }
  const rec = recordRun(row.path, row.ctx, row.options, { status: "failed", error }, extra);
  if (opts.attached) {
    // Not a transport failure (the server lost, refused or cancelled the job, or we
    // gave up): name the reason itself — nothing was logged, so no Logs button.
    const label = doorwayBackendLabel(configuredBackendLabel(row.backendId));
    useApp.getState().setLogsDoorway({
      msg: `The run on ${label} did not finish: ${safeDisplayText(error, 200)}`,
      showLogs: false,
    });
    settleReattached();
  }
  return rec;
}

/** The pump's last-file settle, for a run that has no pump: close the open
 *  clocks, release the cancel handle, mark the store idle. */
function settleReattached(): void {
  activeCancel = null;
  reattachStop = null;
  const doneAt = Date.now();
  set((s) => ({
    running: false,
    stageTimes: Object.fromEntries(
      Object.entries(s.stageTimes).map(([k, t]) => [k, t.end ? t : { ...t, end: doneAt }]),
    ) as TranscribeRunState["stageTimes"],
  }));
}

/** Translate-only run for a subtitle/text source: read + parse locally, then
 *  translateParsed. */
async function translateTextSource(
  path: string,
  options: TranscribeOptions,
  ctx: RunContext,
  progressId?: string | null,
  epoch?: number,
): Promise<BatchResult> {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "txt";
  const content = await readTextFile(path);
  return translateParsed(parseImportedText(ext, content), options, ctx, progressId, epoch);
}

/** Parsed subtitle/text segments → batched /v1/text/translations calls into
 *  `options.translateTo` → a BatchResult the viewer, history and exports consume
 *  like any other. Shared by text sources and links whose transcript is the
 *  site's own subtitle track. */
export async function translateParsed(
  parsed: ImportedText,
  options: TranscribeOptions,
  ctx: RunContext,
  progressId?: string | null,
  epoch?: number,
): Promise<BatchResult> {
  // Over the server's limit the text route rejects the whole request: keep the first ones and
  // name the rest, in the audio route's own words (it drops them server-side). Wire-valid codes
  // only: a retried History record may carry one the transport refuses, failing the whole send.
  const all = wireCodes(options.translateTo);
  let cap: number | undefined;
  if (all.length) {
    // The limit is read live from this backend's caps (a long batch follows a server that
    // lowers it mid-run), the way the viewer's Translate does (TranscriptViewer): fetch caps
    // never fetched (never throws), and a server that really reports nothing keeps the app's
    // documented ceiling.
    if (!hasOwn(useApp.getState().caps, ctx.backendId)) {
      const b = useApp.getState().backends.find((x) => x.id === ctx.backendId);
      if (b) await refreshCaps(b, { force: true });
    }
    cap = backendTargetCap(ctx.backendId);
  }
  const targets = cap !== undefined && all.length > cap ? all.slice(0, cap) : all;
  // Chunk well under the transport's 512-text cap — a feature-length .srt
  // easily exceeds it, and each chunk is one server round trip.
  const CHUNK = 400;
  const results: Record<string, string>[] = [];
  const keptAll: string[][] = [];
  const warnings: string[] = [];
  if (targets.length < all.length) {
    warnings.push(`translation targets over TRANSLATION_MAX_TARGETS (${cap}) were dropped: ${all.slice(targets.length).join(", ")}`);
  }
  let model: string | undefined;
  let source: string | undefined;
  let plan: PlanStage[] | undefined;
  // An imported JSON may name its language as a word ("english"): only a code goes out.
  const srcCode = translateSourceCode(parsed.language);
  for (let at = 0, end = 0; targets.length && at < parsed.segments.length; at = end) {
    // Close the chunk before the segment that would cross either cap (the 400 above, and the
    // server's character cap: TRANSLATE_CHUNK_CHARS); a lone segment over the character
    // budget still goes out alone (the server answers for it).
    let chars = parsed.segments[at].text.length;
    for (end = at + 1; end < parsed.segments.length && end - at < CHUNK; end++) {
      chars += parsed.segments[end].text.length;
      if (chars > TRANSLATE_CHUNK_CHARS) break;
    }
    // A cancel or an input change bumps the epoch; the pump only checks it after this
    // function returns, so without this a feature-length file kept POSTing chunk after
    // chunk for minutes after Cancel. The partial result is discarded by the pump.
    if (epoch !== undefined && epoch !== get().epoch) break;
    const r = await translateText({
      serverUrl: ctx.serverUrl,
      backendId: ctx.backendId,
      texts: parsed.segments.slice(at, end).map((seg) => seg.text),
      // Ids are positions in the whole source, so a later chunk's warnings name its own cues
      // (and two chunks' same-reason warnings stay two lines through the de-dupe below).
      ids: Array.from({ length: end - at }, (_, k) => at + k),
      targets,
      source: srcCode,
      model: options.translationModel ?? null,
      mode: options.translationMode ?? null,
      glossary: options.translationGlossary ?? null,
      contextSegments: options.translationContextSegments ?? null,
      progressId: progressId ?? null,
      fileEpochCancel: true,
    });
    results.push(...r.results);
    // Dense and aligned with results — a chunk from an older backend that omits
    // `kept` contributes empty arrays, never a shift.
    for (let k = 0; k < r.results.length; k++) keptAll.push(r.kept?.[k] ?? []);
    if (r.warnings?.length) for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    model = model ?? r.model;
    // An auto-detect answer names no source (""): it never becomes the parsed language.
    source = source || r.source || undefined;
    // The last chunk's receipt stands for the run (each chunk is its own
    // one-stage plan on the server).
    if (r.plan?.length) plan = r.plan;
  }
  const segments = assembleTranslatedSegments(parsed.segments, results, keptAll);
  return {
    // Joined like the plain TXT export joins edited segments: no seam space inside CJK.
    text: joinSegmentTexts(parsed.segments.map((seg) => seg.text.trim())),
    language: parsed.language ?? source ?? undefined,
    segments,
    warnings: warnings.length ? warnings : undefined,
    translations: Object.fromEntries(
      targets.map((lang) => [
        lang,
        joinSegmentTexts(segments.map((seg) => trText(seg, lang)).filter((t): t is string => !!t)),
      ]),
    ),
    ...(targets.length
      ? {
          translation: {
            model, targets, source: source ?? srcCode ?? undefined,
            ...(options.translationMode ? { mode: options.translationMode } : {}),
          },
        }
      : {}),
    ...(parsed.segments.every((seg) => seg.start === undefined && seg.end === undefined)
      ? { timingSynthesized: true }
      : {}),
    ...(plan ? { plan } : {}),
  } as BatchResult;
}

/** Pair parsed text-source segments with their translations — and with the targets the
 *  server's quality guard KEPT as the source text, marked exactly as the audio path's
 *  `mergeSegmentTranslations` marks them, so the viewer flags them, "Re-translate N
 *  flagged" finds them and the exports drop them. Without the mark a kept line was stored
 *  and exported as a genuine translation. */
export function assembleTranslatedSegments(
  parsed: ImportedText["segments"],
  results: Record<string, string>[],
  keptAll: string[][],
): TranscriptSegment[] {
  return parsed.map((seg, i) => ({
    start: seg.start ?? i,
    end: seg.end ?? (parsed[i + 1]?.start ?? (seg.start !== undefined ? seg.start + 1 : i + 1)),
    text: seg.text,
    ...(seg.speaker ? { speaker: seg.speaker } : {}),
    ...(results[i] && Object.keys(results[i]).length ? { translations: results[i] } : {}),
    ...(keptAll[i]?.length ? { translationsKept: keptAll[i] } : {}),
  }));
}

/** The request fields every transcription shares (pump's `common`). */
type TranscribeCommon = Omit<Parameters<typeof transcribeUrl>[0], "sourceUrl">;

/** Download a link's frozen site tracks and parse them. Never throws: a failed
 *  download or an unreadable track becomes a warning, and the run carries on
 *  without it. The transcript track (when one is named) comes back on its own. */
async function fetchSiteSubs(
  url: string,
  site: SiteSubsRun,
  ctx: RunContext,
): Promise<{ transcript?: ParsedSiteTrack; others: ParsedSiteTrack[]; warnings: string[] }> {
  const warnings: string[] = [];
  const parsed: ParsedSiteTrack[] = [];
  try {
    const got = await fetchUrlSubtitles({ serverUrl: ctx.serverUrl, backendId: ctx.backendId, url, tracks: site.fetch });
    for (const t of got.tracks) {
      try {
        parsed.push({ id: t.id, lang: t.lang, kind: t.kind, parsed: parseImportedText(t.ext, t.text) });
      } catch {
        warnings.push(`The site's ${t.lang.toUpperCase()} subtitles were empty or unreadable — left out.`);
      }
    }
    for (const f of got.failed) warnings.push(`The site's subtitles "${f.id}" could not be downloaded: ${f.error}`);
  } catch (e) {
    warnings.push(`The site's subtitles could not be downloaded: ${errorText(e)}`);
  }
  const transcript = parsed.find((p) => p.id === site.transcriptTrackId);
  if (site.transcriptTrackId && !transcript) warnings.push(SITE_TRANSCRIPT_FALLBACK);
  return { transcript, others: parsed.filter((p) => p !== transcript), warnings };
}

/** A result + a link's downloaded site tracks, named by the link's site, and the warnings
 *  their download produced. */
function attachFetched(
  res: BatchResult,
  got: { others: ParsedSiteTrack[]; warnings: string[] },
  url: string,
  meta: TranscribeRunState["urlMeta"][string] | undefined,
): BatchResult {
  const timed = siteTimedTracks(got.others, meta?.siteSubs?.tracks, siteDisplayName(url, meta?.extractor));
  return attachSiteTracks(res, timed, got.warnings);
}

/** A transcription result + the link's site tracks (D86). Shared by the run and
 *  by a job result ingested after a restart. Only a link whose site transcript
 *  fell back to the audio is ever ledgered with a transcript track named, so that
 *  track never rides along as an extra site track (it may download fine now) and
 *  the result always carries the fallback warning, as the live run's does. */
export async function withSiteTracks(
  res: BatchResult,
  url: string,
  meta: TranscribeRunState["urlMeta"][string] | undefined,
  ctx: RunContext,
): Promise<BatchResult> {
  const site = meta?.siteSubs;
  if (!site?.fetch.length) return res;
  const got = await fetchSiteSubs(url, site, ctx);
  if (site.transcriptTrackId && !got.warnings.includes(SITE_TRANSCRIPT_FALLBACK)) got.warnings.push(SITE_TRANSCRIPT_FALLBACK);
  return attachFetched(res, got, url, meta);
}

/** The translation targets a link run actually sends: with the site's own tracks in use, only
 *  the targets the site lacks (`mtTargets`, possibly none); else the run's own. A backend without
 *  a T2T stage (`translateTo` undefined) sends nothing, even with a site plan frozen at Add link on
 *  one that had it; chips cleared after Add (`[]`) still send the frozen `mtTargets`. Shared by
 *  runLink and the run panel's rail, so the rail never shows a Translating stage the run skips. */
export function linkTranslateTo(
  opts: TranscribeOptions,
  meta?: { siteSubs?: SiteSubsRun },
): string[] | undefined {
  const site = meta?.siteSubs;
  return site && opts.translateTo !== undefined ? site.mtTargets : opts.translateTo;
}

/** The link card's prefetched media id, only when the run goes to the backend that issued it:
 *  a media id is only good on the server that stored it. A backend switched after Add link
 *  gets nothing, so the run downloads on its own server instead of pointing at a foreign id.
 *  A check download that has expired (or will within a minute: run latency, clock skew) counts
 *  as absent too — the server has dropped it, and a site transcript would keep a dead id. */
export function linkPrefetchFor(
  meta: { prefetchMediaId?: string; prefetchBackendId?: string; prefetchExpiresAt?: number } | undefined,
  backendId: string,
): string | undefined {
  if (!meta?.prefetchMediaId || meta.prefetchBackendId !== backendId) return undefined;
  if (meta.prefetchExpiresAt != null && meta.prefetchExpiresAt <= Date.now() / 1000 + 60) return undefined;
  return meta.prefetchMediaId;
}

/** A link run: the link card's spoken language and reused audio, and — when the
 *  card picked them — the site's own subtitles: as the transcript (no transcription;
 *  the audio is still fetched for playback, the video on demand when kept) or next
 *  to the transcription. `videoPid` = the progress id a kept video downloads under,
 *  `videoReq` = that on-demand request (awaitRunUrlVideo's completion signal). */
async function runLink(
  url: string,
  common: TranscribeCommon,
  ctx: RunContext,
  pid: string | null,
  epoch: number,
  // Writes the in-flight ledger row for a planned site transcript that falls
  // back to a server transcription (the pump skipped it: no job was expected).
  ledger?: () => Promise<void>,
): Promise<{ res: BatchResult; videoPid?: string; videoReq?: Promise<UrlMediaDownload | null> }> {
  const meta = get().urlMeta[url];
  const site = meta?.siteSubs;
  const spoken = meta?.spokenLanguage;
  const opts = common.options ?? {};
  const translateTo = linkTranslateTo(opts, meta);
  const prefetch = linkPrefetchFor(meta, ctx.backendId);
  const options: TranscribeOptions = {
    ...opts,
    ...(translateTo ? { translateTo } : {}),
    ...(prefetch ? { prefetchedMediaId: prefetch } : {}),
  };
  const req = {
    ...common,
    ...(spoken
      ? {
          language: spokenLanguage(spoken),
          // As spokenField: an unoffered flag leaves the overrides as a file run sends them (the
          // card keeps its pick, which applies again once the flag is offered).
          decodeOverrides:
            ctx.multilingualOffered === false
              ? common.decodeOverrides
              : // Either view of the server's default: an explicit false is redundant, never
                // wrong, once the flag is offered (the add-time value may predate a model switch
                // or the server values loading).
                applyMultilingual(
                  common.decodeOverrides ?? undefined,
                  spoken,
                  ctx.multilingualInherited === true || meta?.spokenMultiInherited === true,
                ),
        }
      : {}),
  };
  if (!site?.fetch.length) return { res: await transcribeUrl({ ...req, sourceUrl: url, options }) };
  const got = await fetchSiteSubs(url, site, ctx);
  // A cancel during the subtitle download must not still post the request
  // (the pump's catch drops it silently on the epoch mismatch).
  if (epoch !== get().epoch) throw new Error("cancelled");
  if (!got.transcript) {
    // Decided now: the server runs the full audio pipeline, so the rail must show it.
    patchItem(url, { siteFallback: true });
    if (ledger) {
      await ledger();
      if (epoch !== get().epoch) throw new Error("cancelled");
    }
    const res = await transcribeUrl({ ...req, sourceUrl: url, options });
    return { res: attachFetched(res, got, url, meta) };
  }
  // The transcript is the site's: keep the audio (the check's download, else one now).
  const warnings = [...got.warnings];
  // Its expiry rides along: without one the export panel reads the audio as kept forever.
  let audio = prefetch ?? null;
  let audioExp: number | undefined = prefetch ? meta?.prefetchExpiresAt : undefined;
  if (!audio && epoch === get().epoch) {
    try {
      const dl = await fetchUrlAudioOnDemand({ serverUrl: ctx.serverUrl, backendId: ctx.backendId, url, progressId: pid });
      audio = dl.mediaId;
      audioExp = dl.expiresAt ?? undefined;
    } catch (e) {
      warnings.push(`The audio could not be downloaded, so there is no playback: ${errorText(e)}`);
    }
  }
  const parsed = { ...got.transcript.parsed, language: primarySubtag(got.transcript.lang) };
  const res = await translateParsed(parsed, { ...options, translateTo: translateTo ?? [] }, ctx, pid, epoch);
  let videoPid: string | undefined;
  let videoReq: Promise<UrlMediaDownload | null> | undefined;
  if (options.keepVideo && epoch === get().epoch) {
    videoPid = newProgressId();
    videoReq = startOnDemandVideo(url, ctx, videoPid, epoch);
  }
  return {
    res: attachFetched(
      {
        ...res,
        ...(meta?.durationSec ? { duration: meta.durationSec } : {}),
        ...(audio ? { sourceMediaId: audio, ...(audioExp != null ? { sourceMediaExpiresAt: audioExp } : {}) } : {}),
        ...(videoPid ? { sourceVideoPending: true } : {}),
      },
      { others: got.others, warnings },
      url,
      meta,
    ),
    videoPid,
    videoReq,
  };
}

async function pump(
  epoch: number,
  options: TranscribeOptions | undefined,
  ctx: RunContext,
) {
  if (get().running) return;
  set({ running: true });
  // One failure path for the queue item AND its history record — the three sites below
  // used to spell the pair out (and one repeated the message literal in both calls).
  const failFile = (path: string, error: string) => {
    patchItem(path, { status: "failed", error });
    recordRun(path, ctx, options, { status: "failed", error });
  };
  try {
    while (epoch === get().epoch) {
      const next = get().queue.find((it) => it.status === "queued");
      if (!next) break;
      const sourceKind = itemSourceKind(next);
      const isUrl = sourceKind === "url";
      const isText = sourceKind === "text";
      // A URL item can only run against a full backend (the download happens
      // server-side). A stale queue on a standard server fails locally with
      // a clear message instead of a confusing server 4xx.
      if (isUrl && ctx.standard) {
        failFile(next.path, "This server can't download links — pick a full backend.");
        continue;
      }
      // A text source runs the translation stage ONLY — it needs targets and
      // a full backend with the T2T endpoint.
      if (isText && (ctx.standard || !wireCodes(options?.translateTo).length)) {
        // A full server with translation off has no Translation section to turn on.
        const error = ctx.standard || ctx.translationAvailable === false
          ? "Text files need a full backend with translation enabled."
          : "Text files need at least one translation target — turn on Translation.";
        failFile(next.path, error);
        continue;
      }
      patchItem(next.path, { status: "running", siteFallback: undefined });
      // Live progress (full backend only): a fresh hex id per file keys the
      // server-side entry; a 1 s poll paints the rail. Best-effort — a poll
      // error (older backend, standard server) just leaves it indeterminate.
      // Text runs poll too: /v1/text/translations registers the same progress
      // entry (stage "translating" + last_text live line).
      const pid = ctx.standard ? null : newProgressId();
      activeCancel = pid
        ? { serverUrlOf: () => ctx.serverUrl, backendId: ctx.backendId, progressId: pid }
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
      railFileSeq += 1;
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
      // Monotonic sequence: drop any response whose seq is older than the
      // newest folded one — out-of-order responses (poll latency > 1s on a
      // loaded backend) would rewind the stage clocks.
      let pollSeq = 0;
      let pollInFlight = false;
      // The file's ledger row is on disk (the server holds a job under pid),
      // and — after a lost connection — a headless watcher took it over.
      let ledgered = false;
      let handedOff = false;
      const poller = pid
        ? window.setInterval(() => {
            if (pollInFlight) return; // don't stack concurrent polls
            const seq = ++pollSeq;
            pollInFlight = true;
            getTranscribeProgress({
              serverUrl: ctx.serverUrl,
              backendId: ctx.backendId,
              progressId: pid,
            })
              .then((p) => {
                if (!pollingDone && epoch === get().epoch && seq === pollSeq) foldProgress(p);
              })
              .catch(() => {})
              .finally(() => { pollInFlight = false; });
          }, 1000)
        : undefined;
      try {
        // A URL item's keep-video choice: the link card's per-item pick,
        // else the Settings default — only when the server can do it.
        let itemOptions = options;
        if (isUrl && ctx.urlVideoEnabled) {
          const meta = get().urlMeta[next.path];
          const st = useApp.getState().settings.transcribe;
          const keepVideo = meta?.keepVideo ?? st?.keepUrlVideoCopies ?? true;
          if (keepVideo) {
            itemOptions = {
              ...(options ?? {}),
              keepVideo: true,
              videoMaxHeight: videoMaxHeightOf(next.path),
              ...(meta?.videoFormat ? { videoFormat: meta.videoFormat } : {}),
            };
          }
        }
        if (!isUrl && !isText && ctx.mediaPackageEnabled && isVideoSourcePath(next.path)) {
          itemOptions = { ...(itemOptions ?? {}), retainMedia: true };
        }
        const common = {
          serverUrl: ctx.serverUrl,
          backendId: ctx.backendId,
          model: ctx.model,
          language: ctx.language,
          prompt: ctx.prompt,
          decodeOverrides: ctx.decodeOverrides,
          overrideProfile: ctx.overrideProfile,
          options: pid ? { ...itemOptions, progressId: pid } : itemOptions,
        };
        // The in-flight ledger row lands BEFORE the request leaves: the
        // server's job row and ours share this id, and a quit in the first
        // second must still find the run at the next launch. Text sources
        // post N chunk requests under one id (translateTextSource) — a
        // server job row is one chunk, not the run — so they stay out, and
        // so does a link whose transcript is the site's own subtitle track
        // (no server job) — unless that track fails and the link falls back
        // to a transcription: runLink ledgers it right before that request.
        const siteTranscript = isUrl && linkUsesSiteTranscript(get().urlMeta[next.path]);
        const ledgerRow = async () => {
          try {
            // The run-level options, not itemOptions: a re-attached run's
            // lastOptions (and every retry from its record) comes from here,
            // and the per-item keepVideo/retainMedia flags are re-derived from
            // the link card and Settings on each run.
            await persistRow({
              v: 1,
              jobId: pid!,
              backendId: ctx.backendId,
              serverUrl: ctx.serverUrl,
              path: next.path,
              kind: isUrl ? "url" : "file",
              title: next.title,
              options,
              ctx,
              urlMeta: get().urlMeta[next.path],
              overrides: get().lastOverrides,
              startedAt: fileT0,
            });
            ledgered = true;
          } catch (e) {
            console.error("jobs ledger write failed:", e);
          }
        };
        if (pid && ctx.jobsEnabled && !isText && !siteTranscript) await ledgerRow();
        // A cancel during the ledger write must not still post the request.
        if (epoch !== get().epoch) return;
        let videoPid: string | undefined;
        let videoReq: Promise<UrlMediaDownload | null> | undefined;
        let res: BatchResult;
        if (isText) {
          res = await translateTextSource(next.path, options!, ctx, pid, epoch);
        } else if (isUrl) {
          const fallbackLedger = pid && ctx.jobsEnabled && siteTranscript ? ledgerRow : undefined;
          ({ res, videoPid, videoReq } = await runLink(next.path, common, ctx, pid, epoch, fallbackLedger));
        } else {
          // The limit rides as an option, not a pre-check here: Rust reads the size from the
          // file it is about to stream, so the two can't disagree.
          const fileOptions = ctx.mediaMaxBytes ? { ...common.options, mediaMaxBytes: ctx.mediaMaxBytes } : common.options;
          res = await transcribeFile({ ...common, options: fileOptions, filePath: next.path });
        }
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
          if (res.sourceMediaId) fetchRunUrlMedia(rec, ctx, res.sourceMediaId);
          if (res.sourceVideoMediaId) {
            fetchRunUrlVideo(rec, ctx, res.sourceVideoMediaId);
          } else if (res.sourceVideoPending && (videoPid ?? pid)) {
            // The transcript came back before the video did: keep polling
            // the same id (the server leaves the entry to the video task),
            // or the on-demand one a site-subtitle run started.
            awaitRunUrlVideo(rec, ctx, (videoPid ?? pid)!, epoch, videoReq);
          }
        } else if (!isText) {
          copyRunMedia(next.path, rec);
        }
      } catch (e) {
        if (epoch !== get().epoch) return;
        // Our end lost contact (the client-side wait ran out, or the
        // connection dropped) — the server's job may still be running and
        // finish. Record the failure under the job id, so the transcript a
        // headless watcher picks up later replaces it instead of adding a
        // second record, and keep the ledger row for that watcher.
        const lost = ledgered && lostContact(e);
        if (lost && pid && orphanWatch) {
          const error = String(e);
          patchItem(next.path, { status: "failed", error, orphanJobId: pid });
          // createdAt = the request start, the same stamp the watcher's ingest upserts
          // with: the record keeps its place in History when the transcript lands.
          recordRun(next.path, ctx, options, { status: "failed", error },
            { id: pid, createdAt: new Date(fileT0).toISOString() });
          orphanWatch(pid);
          handedOff = true;
        } else {
          failFile(next.path, uploadTooLargeText(e) ?? String(e));
        }
        // Failure doorway banner → Logs screen (pre-filtered to Warn+). The
        // queue item keeps the raw error; the doorway gets the truthful
        // template (cause + backend + one fix). A text source only ran the
        // translate stage, so it toasts as a translation failure. A run handed
        // to its headless watcher gets no "try again": a retry stops that
        // watcher and deletes the server job that would land in History.
        const backendLabel = configuredBackendLabel(ctx.backendId) ?? "the backend";
        const kind = isText ? "translate" : "transcribe";
        useApp.getState().setLogsDoorway(
          handedOff ? handedOffDoorway(kind, backendLabel) : transportErrorDoorway(kind, e, backendLabel),
        );
      } finally {
        pollingDone = true;
        activeCancel = null;
        if (poller !== undefined) window.clearInterval(poller);
        // Settled (done, failed, or our end dropped by a cancel): the row
        // has done its job. A cancelled run's server row lands `cancelled`
        // on its own; nothing to re-attach to. A lost connection's row
        // belongs to its headless watcher now, which forgets it on settle.
        if (pid && !handedOff) void forgetRow(pid);
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
  // A lost request's job for a file this run re-queues would transcribe it twice: stop
  // those watchers first (see retryFile). Other files' orphans keep landing in History.
  stopOrphans(s.files);
  const epoch = s.epoch + 1;
  set({
    epoch,
    // The open record goes with the selection, as on every other selection drop: the
    // Recent strip, the translating-elsewhere strip and the idle check read it.
    selectedPath: null,
    openRecordId: null,
    queue: s.files.map((path): QueueItem => ({
      path,
      status: "queued",
      kind: itemSourceKind({ path }),
      title: s.urlMeta[path]?.title,
    })),
    lastOptions: options,
    runOptions: undefined,
    lastOverrides: overrides,
  });
  void pump(epoch, options, ctx);
}

/** The sidebar badge's fraction — the same server number the run panel's header shows, so
 *  the two can never disagree. */
export function runBadgeFraction(s: TranscribeRunState): number | null {
  return overallOf(s);
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

/** A retry replays the last run's options, but a failed row survives a backend switch, so
 *  the wire-shaping keys follow the server the retry goes to: `standard` (how an "auto"
 *  language goes out), for Whisper's translate task the endpoint it is routed to, and on a
 *  server without a translating stage (any standard one, or a full one with translation off)
 *  no T2T slice at all — `translateTo` undefined is "no translating stage" (as
 *  `translationRunOptions` leaves it), which `linkTranslateTo` reads to skip a site plan's
 *  frozen targets. A missing slice stays missing: filled in as an explicit empty list it would
 *  turn a site plan's frozen targets back on (`linkTranslateTo`) while the rail, which reads
 *  `runOptions` (retryFile stores these there; `lastOptions` keeps the requested ones for the
 *  next retry), shows no Translating stage. `translationAvailable` unset = unknown (caps not
 *  loaded): only a standard server is assumed to lack it. */
export function reconcileRetryOptions(
  opts: TranscribeOptions | undefined,
  standard: boolean,
  translationAvailable?: boolean,
): TranscribeOptions | undefined {
  if (!opts) return standard ? { standard: true } : undefined;
  const out: TranscribeOptions = {
    ...opts,
    standard: standard || undefined,
    ...(opts.task === "translate" ? { useTranslationsEndpoint: standard } : {}),
  };
  // A History record saved before the chips were wire-checked may hold codes the server
  // refuses ("de_CH"): keep only the wire-valid ones. A defined list stays defined (even
  // empty), so `linkTranslateTo` still reads it as "this run had a translating slice".
  if (out.translateTo !== undefined) out.translateTo = wireCodes(out.translateTo);
  if (standard || !(translationAvailable ?? !standard)) {
    delete out.translateTo;
    delete out.translationMode;
    delete out.translationModel;
    delete out.translationGlossary;
    delete out.translationContextSegments;
  }
  return out;
}

/** Stop the headless watchers of lost requests for these paths before they are re-queued:
 *  a still-running old job would otherwise land a second record (and the file is
 *  transcribed twice). */
function stopOrphans(paths: string[]) {
  orphanStop?.(paths);
}

export function retryFile(path: string, ctx: RunContext, overrides?: DecodeOverrides) {
  const s = get();
  if (s.running) return;
  // A retry may carry NEW decode overrides (the VAD one-click fix); the rail's honesty
  // line reads the store, so the store must learn them too.
  if (overrides) set({ lastOverrides: overrides });
  // A lost request's job may still be running under a headless watcher: stop it, or
  // the old job lands a second record (and transcribes the file twice).
  stopOrphans([path]);
  patchItem(path, { status: "queued", error: undefined, orphanJobId: undefined });
  // Reconciled from the REQUESTED options every time (lastOptions, never overwritten here): a
  // retry on a server without translation must not strip the targets from the next retry on
  // one with it. The options it really runs with go to runOptions — the rail (railStages)
  // reads those, and a Translating row the retry skips would otherwise be painted done.
  const options = reconcileRetryOptions(s.lastOptions, ctx.standard, ctx.translationAvailable);
  set({ runOptions: options });
  void pump(s.epoch, options, ctx);
}

export function cancelRun() {
  // Abort the in-flight file AND skip everything queued. Two sides to the
  // abort: the server is told to stop the actual work (dropping the HTTP
  // request alone leaves its pipeline stages running to completion), and
  // the store epoch bump drops our end of the request. Bumping the epoch
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
