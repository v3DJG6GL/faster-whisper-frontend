// The viewer's chunked retro-translate run: a pure progress
// state machine for the mini progress card plus the chunk-loop driver that
// feeds mergeSegmentTranslations per chunk. Kept free of React/IPC imports so
// vitest can exercise the chunk math and the poll folding directly — the
// TranscriptViewer supplies the actual translateText call and the store merge.
import type { BatchProgress } from "./types";
import type { TextTranslationResult } from "./api";
import { ownProp } from "./own";

/** Segments per /v1/text/translations request. Small on purpose: results
 *  merge into the transcript per chunk, so the chunk size IS the "live fill"
 *  granularity. 32 keeps rows landing every batch or two while staying big
 *  enough for the server's sentence-merge + context window to do their job
 *  (context = 3 segments, fluent groups span a few). */
export const TRANSLATE_CHUNK = 32;

/** Character budget of one /v1/text/translations request, for every chunked caller: the
 *  server answers 413 for a request whose segment texts total over 200,000 characters
 *  (_TEXT_TRANSLATE_MAX_CHARS, backend translation/routes.py), which would fail a run of
 *  long .txt paragraphs whole. UTF-16 length never undercounts its code points. */
export const TRANSLATE_CHUNK_CHARS = 180_000;

/** Segment indexes missing at least one of `langs` — a cancelled or failed chunked run
 *  leaves these behind, and they are the run's resume set. The viewer's other doors
 *  close the moment the FIRST chunk lands (`langs` is non-empty from then on), so this is
 *  the only way back into a half-translated transcript. A blank-source segment is never
 *  in the set: its translation is blank by design, so it would keep offering a resume
 *  that can never finish. Blankness is judged on the EFFECTIVE text — `edits` first, as
 *  the resume run's `textOf` reads it — since that is what the run would send: an edit can
 *  turn a blank segment into words (then it needs translating) or words into a blank. */
export function untranslatedIndexes(
  segments: { text?: string; translations?: Record<string, string> }[] | undefined,
  langs: string[],
  edits?: Record<number, string>,
): number[] {
  if (!langs.length) return [];
  return (segments ?? []).flatMap((s, i) => {
    const text = edits?.[i] ?? s.text;
    return typeof text === "string" && !text.trim()
      ? []
      : langs.some((l) => !(ownProp(s.translations, l) ?? "").trim()) ? [i] : [];
  });
}

/** Re-runs reproduce the transcript's OWN regime (the mode/model its record carries),
 *  not the backend default — else "Re-translate N flagged" mixes two regimes in one
 *  transcript. `mode` is a free string on the record, so narrow it. */
export function translateOptsFrom(
  info?: { mode?: string; model?: string },
): { mode?: "fluent" | "faithful"; model?: string } {
  const mode = info?.mode === "faithful" || info?.mode === "fluent" ? info.mode : undefined;
  return { mode, model: info?.model || undefined };
}

export type TranslatePhase =
  | "starting" // request sent, no progress entry observed yet
  | "downloading" // server is fetching the MT model
  | "loading" // model load into VRAM/RAM
  | "translating"
  | "reconnecting" // progress polls fail on the network while a chunk request is still in flight
  | "done";

/** Everything the mini progress card renders. One value per run — chunk
 *  boundaries fold into the whole-run fraction, they are not visible states. */
export interface TranslateRunUi {
  phase: TranslatePhase;
  /** Whole-run fraction 0..1: completed chunks + the in-flight chunk's
   *  server-reported translate progress. */
  pct: number;
  /** Requested target codes (the card's title). */
  targets: string[];
  /** What's being translated (file basename / record title) — lets GLOBAL
   *  surfaces (sidebar badge, other-runs strip) name the run when its
   *  transcript is not the one on screen. */
  title?: string;
  /** Total segments across the run / how many of them earlier chunks already answered. */
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
  /** ms epoch when the in-flight chunk's request left (beginChunk). The poller shares one
   *  progress id across chunks, so a poll SENT before this belongs to the previous chunk and
   *  must not scale onto this one's frame. */
  chunkAt?: number;
  /** `sentAt` of the newest poll already folded (answered or failed). Polls overlap — each
   *  has a 10 s timeout and the 1 s poller does not wait — so one sent earlier can settle
   *  later; it is older news than what the card shows and is dropped. */
  pollAt?: number;
  /** ms epoch when the run started (the "running m:ss" clock). */
  startedAt: number;
  /** ms epoch when the run finished — stamped with phase "done", so the receipt's
   *  "took m:ss" stays the run's own length however late the card mounts. */
  endedAt?: number;
  /** A model download/load phase was observed — keeps the amber bar segment. */
  modelPhaseSeen: boolean;
  /** 0..1 within the model phase (downloading fraction; 1 once loading). */
  modelPct: number;
  /** ms epoch of the first downloading poll (download speed readout). */
  dlStartedAt?: number;
  /** Bytes expected during the downloading stage. */
  totalBytes?: number;
  /** Server warnings accumulated across the run's chunks (e.g. quality-guard
   *  "kept original" notices) — the card shows a compact amber line. */
  warnings?: string[];
  /** Server detail passthroughs, all optional/defensive. */
  step?: string;
  lastText?: string;
  model?: string;
  device?: string;
  /** The language being translated right now and how far along it is
   *  (0..1 within that language) — from the server's per-target ticks. */
  target?: string;
  targetProgress?: number;
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

/** A new chunk request left: floor the whole-run fraction at the answered
 *  prefix and move the frontier to the chunk's first segment. */
export function beginChunk(
  s: TranslateRunUi,
  chunkIdxs: number[],
  done: number,
  now: number = Date.now(),
): TranslateRunUi {
  return {
    ...s,
    // A chunk request leaving IS the run translating: against a server with no shared
    // progress entry (every poll 404s, which the viewer swallows) nothing else ever leaves
    // "starting", so the card would read "Starting…" for the whole run while rows land.
    // On the first chunk a later poll still corrects to downloading/loading.
    // Past it, any chunk having answered proves the model is up (and the network back):
    // whatever the card read — "loading"/"downloading" from a model phase no translating
    // poll outlived (a fast chunk inside the poll gap), or "reconnecting" — it now reads
    // "translating" with a full model lane, as foldTranslatePoll's translating arm sets it.
    // On the first chunk "reconnecting" settles on the busiest safe guess.
    phase:
      s.phase === "starting"
        ? "translating"
        : done > 0 && s.phase !== "done"
          ? "translating"
          : s.phase === "reconnecting"
            ? s.modelPhaseSeen ? "loading" : "translating"
            : s.phase,
    modelPct: done > 0 && s.modelPhaseSeen ? 1 : s.modelPct,
    done,
    chunkLen: chunkIdxs.length,
    chunkIdxs,
    chunkAt: now,
    frontierIdx: chunkIdxs.length ? chunkIdxs[0] : -1,
    pct: clamp01(done / s.total),
  };
}

/** Map the server's within-request fraction onto the in-flight chunk's
 *  segment list. The server counts segments×targets, so with T targets the
 *  position sweeps the chunk T times — take the position within the current
 *  sweep. */
function frontierAt(s: TranslateRunUi, progress: number, targetProgress?: number | null): number {
  const idxs = s.chunkIdxs;
  if (!idxs || !idxs.length) return s.frontierIdx;
  // A server that reports the per-target fraction says exactly where the
  // sweep is; otherwise derive it from the global fraction.
  let within: number;
  if (typeof targetProgress === "number" && Number.isFinite(targetProgress)) {
    within = clamp01(targetProgress);
  } else {
    const T = Math.max(1, s.targets.length);
    const scaled = clamp01(progress) * T;
    within = scaled >= T ? 1 : scaled % 1;
  }
  return idxs[Math.min(idxs.length - 1, Math.floor(within * idxs.length))];
}

/** Fold one progress poll into the card state. Defensive throughout: EVERY
 *  field may be absent — an empty poll changes nothing but still returns a
 *  fresh object (the card's clock re-renders off it). Terminal phases are sticky.
 *  `sentAt` = when the poll's request left. Two guards, in this order: a poll sent before
 *  the newest one already folded (`pollAt`) is dropped whole — the card already shows
 *  newer news. One that passes but was sent before the current chunk began (a late answer
 *  about the previous chunk) still folds its passthrough fields and clears "reconnecting",
 *  but leaves the chunk-relative pct/frontier alone, and past the first chunk cannot set a
 *  model phase back (that chunk's answer proved the model up). */
export function foldTranslatePoll(
  s: TranslateRunUi,
  p: BatchProgress,
  now: number = Date.now(),
  sentAt?: number,
): TranslateRunUi {
  if (s.phase === "done") return s;
  if (sentAt !== undefined && s.pollAt !== undefined && sentAt < s.pollAt) return s;
  const next: TranslateRunUi = { ...s };
  if (sentAt !== undefined) next.pollAt = sentAt;
  const stale = sentAt !== undefined && s.chunkAt !== undefined && sentAt < s.chunkAt;
  switch (p.stage) {
    case "downloading":
      if (stale && s.done > 0) break;
      next.phase = "downloading";
      next.modelPhaseSeen = true;
      if (typeof p.progress === "number") next.modelPct = clamp01(p.progress);
      if (next.dlStartedAt === undefined) next.dlStartedAt = now;
      if (typeof p.totalBytes === "number" && p.totalBytes > 0) next.totalBytes = p.totalBytes;
      break;
    case "loading":
      if (stale && s.done > 0) break;
      next.phase = "loading";
      next.modelPhaseSeen = true;
      next.modelPct = 1;
      break;
    case "translating":
      next.phase = "translating";
      if (next.modelPhaseSeen) next.modelPct = 1;
      if (typeof p.progress === "number" && !stale) {
        next.pct = clamp01((s.done + clamp01(p.progress) * s.chunkLen) / s.total);
        next.frontierIdx = frontierAt(s, p.progress, p.targetProgress);
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
  if (p.target) next.target = p.target;
  if (typeof p.targetProgress === "number") next.targetProgress = clamp01(p.targetProgress);
  if (p.lastText) next.lastText = p.lastText;
  if (p.model) next.model = p.model;
  if (p.device) next.device = p.device;
  return next;
}

/** A progress poll failed on the NETWORK while a chunk request is pending:
 *  the card shows "reconnecting…" (bar dimmed/frozen) but the run itself
 *  keeps going — the chunk request has its own long timeout, and polling
 *  continues until it recovers. Terminal phases are sticky here too.
 *  `sentAt` as in foldTranslatePoll: a poll sent before the current chunk began failing late
 *  says nothing about now (the chunk that just left proves the network). Likewise a poll
 *  sent before the newest one already folded (`pollAt`): a newer poll answered, so the
 *  network was back by then. */
export function foldPollFailure(s: TranslateRunUi, sentAt?: number): TranslateRunUi {
  if (s.phase === "done") return s;
  if (sentAt !== undefined && s.chunkAt !== undefined && sentAt < s.chunkAt) return s;
  if (sentAt !== undefined && s.pollAt !== undefined && sentAt < s.pollAt) return s;
  return { ...s, phase: "reconnecting", pollAt: sentAt ?? s.pollAt };
}

export interface ChunkedTranslateArgs {
  /** Segment indexes to translate, in order (may be sparse — stale rows). */
  indexes: number[];
  /** Current text of a segment index (edits layered over the transcript). */
  textOf: (segIdx: number) => string;
  /** One server round trip for a chunk's texts (the caller closes over
   *  targets/model/mode/glossary and the run's progress id). `idxs[k]` is the segment
   *  index of `texts[k]` — sent as the request's ids, so the server's "segment N"
   *  warnings name the row in the whole transcript, not a position in this chunk. */
  translate: (texts: string[], idxs: number[]) => Promise<TextTranslationResult>;
  /** A chunk request is about to leave: its segment indexes and how many of
   *  `indexes` earlier chunks already answered (merged or not). */
  onChunkStart?: (chunkIdxs: number[], done: number) => void;
  /** A chunk answered: per-segment-index translation maps (empty results are
   *  dropped) + accumulated provenance. `firstChunk` = first merge of the run
   *  (registers provenance / makes the track chips appear). `kept` mirrors
   *  the patch: per merged segment index, the target codes whose entry kept
   *  the SOURCE text (server quality guard) — [] on a clean segment, so a
   *  successful re-translate REPLACES (clears) an earlier mark. `sent` mirrors it too: the text
   *  each merged segment was sent as (textOf at send time), so the merge can tell a line
   *  corrected while its chunk was in flight from one it really re-translated. */
  onMerge: (
    patch: Record<number, Record<string, string>>,
    prov: { model?: string; source?: string },
    firstChunk: boolean,
    kept: Record<number, string[]>,
    sent: Record<number, string>,
  ) => void;
  /** Warnings accumulated so far (called after any chunk that added some). */
  onWarnings?: (all: string[]) => void;
  /** Checked between chunks AND after each response: a cancelled run keeps
   *  its completed chunks, the in-flight chunk's results are dropped. */
  isCancelled?: () => boolean;
  chunk?: number;
}

/** Drive a whole run in requests of at most TRANSLATE_CHUNK segments and
 *  TRANSLATE_CHUNK_CHARS characters, merging per chunk so translated rows appear
 *  as they finish. A failing chunk's transport error is rethrown unchanged and ends
 *  the run (the caller owns the toast copy). */
export async function runChunkedTranslate(a: ChunkedTranslateArgs): Promise<{
  model?: string;
  source?: string;
  cancelled: boolean;
  mergedChunks: number;
  warnings: string[];
}> {
  const chunk = Math.max(1, a.chunk ?? TRANSLATE_CHUNK);
  let model: string | undefined;
  let source: string | undefined;
  let mergedChunks = 0;
  const warnings: string[] = [];
  let slice: number[] = [];
  for (let at = 0; at < a.indexes.length; at += slice.length) {
    if (a.isCancelled?.()) return { model, source, cancelled: true, mergedChunks, warnings };
    // Close the chunk before the segment that would cross either cap; a lone segment over
    // the character budget still goes out alone (the server answers for it).
    slice = [a.indexes[at]];
    const texts = [a.textOf(a.indexes[at])];
    for (let chars = texts[0].length, k = at + 1; k < a.indexes.length && slice.length < chunk; k++) {
      const t = a.textOf(a.indexes[k]);
      chars += t.length;
      if (chars > TRANSLATE_CHUNK_CHARS) break;
      slice.push(a.indexes[k]);
      texts.push(t);
    }
    a.onChunkStart?.(slice, at);
    const r = await a.translate(texts, slice);
    // Cancelled while this chunk was in flight: its results are lost by
    // design (the approved copy says so); everything merged before stays.
    if (a.isCancelled?.()) return { model, source, cancelled: true, mergedChunks, warnings };
    model = model ?? r.model;
    source = source ?? r.source;
    if (r.warnings?.length) {
      // De-duplicated: the server emits its quality notice per REQUEST, so a 900-segment run
      // would otherwise report "29 warnings" for one recurring condition.
      let added = false;
      for (const w of r.warnings) {
        if (!warnings.includes(w)) {
          warnings.push(w);
          added = true;
        }
      }
      if (added) a.onWarnings?.(warnings.slice());
    }
    const patch: Record<number, Record<string, string>> = {};
    const kept: Record<number, string[]> = {};
    const sent: Record<number, string> = {};
    slice.forEach((segIdx, k) => {
      const tr = r.results[k];
      if (tr && Object.keys(tr).length) {
        patch[segIdx] = tr;
        kept[segIdx] = r.kept?.[k] ?? [];
        sent[segIdx] = texts[k];
      }
    });
    if (Object.keys(patch).length) {
      a.onMerge(patch, { model, source }, mergedChunks === 0, kept, sent);
      mergedChunks += 1;
    }
  }
  return { model, source, cancelled: false, mergedChunks, warnings };
}

/** A live run's controls: the chunk loop's cancel flag and the server request to abort. */
export interface TranslateCtl {
  pid: string;
  cancelled: boolean;
  serverUrl: string;
  backendId: string;
}

/** Live retro-translate controls, keyed by record. MODULE scope on purpose:
 *  the chunk loop + its 1 s poller must keep running (and keep the store's
 *  card state fresh) while the viewer is unmounted, and a remounted viewer
 *  must find the same ctl to gate re-entry and serve Cancel. */
export const translateCtls = new Map<string, TranslateCtl>();

/** Cancel the live run under `key`: stop the chunk loop and abort its request on the server
 *  by progress id (`abort` = api's cancelTextTranslation, passed in: this module stays free
 *  of IPC). The one cancel the viewer's card and the other-runs strip share — a run whose
 *  viewer is closed during a new transcription is cancelled from the strip. False = no live
 *  run under `key`, or it is already cancelled. */
export function cancelTranslateRun(
  key: string,
  abort: (t: { serverUrl: string; backendId: string; progressId: string }) => Promise<unknown>,
): boolean {
  const ctl = translateCtls.get(key);
  if (!ctl || ctl.cancelled) return false;
  ctl.cancelled = true;
  void abort({ serverUrl: ctl.serverUrl, backendId: ctl.backendId, progressId: ctl.pid }).catch(() => {});
  return true;
}

/** Whether the live run under `key` has been cancelled but is still finishing its in-flight
 *  chunk (its ctl stays until that request settles), so a Cancel button reads "Cancelling…"
 *  instead of staying live and pressable as a no-op. translateCtls is not reactive: the
 *  pressing component re-renders itself when cancelTranslateRun returns true. */
export function isTranslateCancelled(key: string): boolean {
  return translateCtls.get(key)?.cancelled === true;
}
