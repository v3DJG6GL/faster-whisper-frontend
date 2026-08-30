// The viewer's chunked retro-translate run ("Job Signals"): a pure progress
// state machine for the mini progress card plus the chunk-loop driver that
// feeds mergeSegmentTranslations per chunk. Kept free of React/IPC imports so
// vitest can exercise the chunk math and the poll folding directly — the
// TranscriptViewer supplies the actual translateText call and the store merge.
import type { BatchProgress } from "./types";
import type { TextTranslationResult } from "./api";

/** Segments per /v1/text/translations request. Small on purpose: results
 *  merge into the transcript per chunk, so the chunk size IS the "live fill"
 *  granularity — 400 meant a typical file translated as ONE request and
 *  nothing appeared until the very end. 32 keeps rows landing every batch or
 *  two while staying big enough for the server's sentence-merge + context
 *  window to do their job (context = 3 segments, fluent groups span a few). */
export const TRANSLATE_CHUNK = 32;

export type TranslatePhase =
  | "starting" // request sent, no progress entry observed yet
  | "downloading" // server is fetching the MT model
  | "loading" // model load into VRAM/RAM
  | "translating"
  | "reconnecting" // progress polls fail on the network while a chunk request is still in flight
  | "done"
  | "error";

/** Everything the mini progress card renders. One value per run — chunk
 *  boundaries fold into the whole-run fraction, they are not visible states. */
export interface TranslateRunUi {
  phase: TranslatePhase;
  /** Whole-run fraction 0..1: completed chunks + the in-flight chunk's
   *  server-reported translate progress. */
  pct: number;
  /** Requested target codes (the card's title). */
  targets: string[];
  /** Total segments across the run / how many chunks-worth are merged. */
  total: number;
  done: number;
  /** In-flight chunk length (scales the server's per-chunk 0..1 progress). */
  chunkLen: number;
  /** Segment index the run is currently translating — the "translation
   *  frontier" row the transcript highlights. -1 = none. Starts at the
   *  in-flight chunk's first segment and advances through the chunk as
   *  server progress polls arrive. */
  frontierIdx: number;
  /** Segment indexes of the in-flight chunk (may be sparse — stale rows);
   *  polls map the server's within-chunk fraction onto this list. */
  chunkIdxs?: number[];
  /** ms epoch when the run started (the "running m:ss" clock). */
  startedAt: number;
  /** A model download/load phase was observed — keeps the amber bar segment. */
  modelPhaseSeen: boolean;
  /** 0..1 within the model phase (downloading fraction; 1 once loading). */
  modelPct: number;
  /** ms epoch of the first downloading poll (download speed readout). */
  dlStartedAt?: number;
  /** Bytes expected during the downloading stage. */
  totalBytes?: number;
  /** Server detail passthroughs, all optional/defensive. */
  step?: string;
  lastText?: string;
  model?: string;
  device?: string;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function newTranslateRun(
  total: number,
  targets: string[],
  now: number = Date.now(),
): TranslateRunUi {
  return {
    phase: "starting",
    pct: 0,
    targets,
    total: Math.max(1, total),
    done: 0,
    chunkLen: 0,
    frontierIdx: -1,
    startedAt: now,
    modelPhaseSeen: false,
    modelPct: 0,
  };
}

/** A new chunk request left: floor the whole-run fraction at the merged
 *  prefix and move the frontier to the chunk's first segment. */
export function beginChunk(
  s: TranslateRunUi,
  chunkIdxs: number[],
  done: number,
): TranslateRunUi {
  return {
    ...s,
    done,
    chunkLen: chunkIdxs.length,
    chunkIdxs,
    frontierIdx: chunkIdxs.length ? chunkIdxs[0] : -1,
    pct: clamp01(done / s.total),
  };
}

/** Map the server's within-request fraction onto the in-flight chunk's
 *  segment list. The server counts segments×targets, so with T targets the
 *  position sweeps the chunk T times — take the position within the current
 *  sweep. */
function frontierAt(s: TranslateRunUi, progress: number): number {
  const idxs = s.chunkIdxs;
  if (!idxs || !idxs.length) return s.frontierIdx;
  const T = Math.max(1, s.targets.length);
  const scaled = clamp01(progress) * T;
  const within = scaled >= T ? 1 : scaled % 1;
  return idxs[Math.min(idxs.length - 1, Math.floor(within * idxs.length))];
}

/** Fold one progress poll into the card state. Defensive throughout: the
 *  backend counterpart is being built in parallel, so EVERY field may be
 *  absent — an empty poll changes nothing but still returns a fresh object
 *  (the card's clock re-renders off it). Terminal phases are sticky. */
export function foldTranslatePoll(
  s: TranslateRunUi,
  p: BatchProgress,
  now: number = Date.now(),
): TranslateRunUi {
  if (s.phase === "done" || s.phase === "error") return s;
  const next: TranslateRunUi = { ...s };
  switch (p.stage) {
    case "downloading":
      next.phase = "downloading";
      next.modelPhaseSeen = true;
      if (typeof p.progress === "number") next.modelPct = clamp01(p.progress);
      if (next.dlStartedAt === undefined) next.dlStartedAt = now;
      if (typeof p.totalBytes === "number" && p.totalBytes > 0) next.totalBytes = p.totalBytes;
      break;
    case "loading":
      next.phase = "loading";
      next.modelPhaseSeen = true;
      next.modelPct = 1;
      break;
    case "translating":
      next.phase = "translating";
      if (next.modelPhaseSeen) next.modelPct = 1;
      if (typeof p.progress === "number") {
        next.pct = clamp01((s.done + clamp01(p.progress) * s.chunkLen) / s.total);
        next.frontierIdx = frontierAt(s, p.progress);
      }
      break;
    default:
      // Unknown/absent stage: no entry yet (between chunks, or before the
      // handler registers the id). A SUCCESSFUL poll while reconnecting
      // still proves the network is back — settle on the busiest safe guess.
      if (s.phase === "reconnecting") {
        next.phase = s.modelPhaseSeen && s.pct === 0 ? "loading" : "translating";
      }
      break;
  }
  if (p.step) next.step = p.step;
  if (p.lastText) next.lastText = p.lastText;
  if (p.model) next.model = p.model;
  if (p.device) next.device = p.device;
  return next;
}

/** A progress poll failed on the NETWORK while a chunk request is pending:
 *  the card shows "reconnecting…" (bar dimmed/frozen) but the run itself
 *  keeps going — the chunk request has its own long timeout, and polling
 *  continues until it recovers. Terminal phases are sticky here too. */
export function foldPollFailure(s: TranslateRunUi): TranslateRunUi {
  if (s.phase === "done" || s.phase === "error") return s;
  return { ...s, phase: "reconnecting" };
}

export interface ChunkedTranslateArgs {
  /** Segment indexes to translate, in order (may be sparse — stale rows). */
  indexes: number[];
  /** Current text of a segment index (edits layered over the transcript). */
  textOf: (segIdx: number) => string;
  /** One server round trip for a chunk's texts (the caller closes over
   *  targets/model/mode/glossary and the run's progress id). */
  translate: (texts: string[]) => Promise<TextTranslationResult>;
  /** A chunk request is about to leave: its segment indexes and how many
   *  segments are already merged. */
  onChunkStart?: (chunkIdxs: number[], done: number) => void;
  /** A chunk answered: per-segment-index translation maps (empty results are
   *  dropped) + accumulated provenance. `firstChunk` = first merge of the run
   *  (registers provenance / makes the track chips appear). */
  onMerge: (
    patch: Record<number, Record<string, string>>,
    prov: { model?: string; source?: string },
    firstChunk: boolean,
  ) => void;
  /** Checked between chunks AND after each response: a cancelled run keeps
   *  its completed chunks, the in-flight chunk's results are dropped. */
  isCancelled?: () => boolean;
  chunk?: number;
}

/** Drive a whole run in TRANSLATE_CHUNK-sized requests, merging per chunk so
 *  translated rows appear as they finish. Throws the first chunk's transport
 *  error unchanged (the caller owns the toast copy). */
export async function runChunkedTranslate(a: ChunkedTranslateArgs): Promise<{
  model?: string;
  source?: string;
  cancelled: boolean;
  mergedChunks: number;
}> {
  const chunk = Math.max(1, a.chunk ?? TRANSLATE_CHUNK);
  let model: string | undefined;
  let source: string | undefined;
  let mergedChunks = 0;
  for (let at = 0; at < a.indexes.length; at += chunk) {
    if (a.isCancelled?.()) return { model, source, cancelled: true, mergedChunks };
    const slice = a.indexes.slice(at, at + chunk);
    a.onChunkStart?.(slice, at);
    const r = await a.translate(slice.map((i) => a.textOf(i)));
    // Cancelled while this chunk was in flight: its results are lost by
    // design (the approved copy says so); everything merged before stays.
    if (a.isCancelled?.()) return { model, source, cancelled: true, mergedChunks };
    model = model ?? r.model;
    source = source ?? r.source;
    const patch: Record<number, Record<string, string>> = {};
    slice.forEach((segIdx, k) => {
      const tr = r.results[k];
      if (tr && Object.keys(tr).length) patch[segIdx] = tr;
    });
    if (Object.keys(patch).length) {
      a.onMerge(patch, { model, source }, mergedChunks === 0);
      mergedChunks += 1;
    }
  }
  return { model, source, cancelled: false, mergedChunks };
}
