// Local transcription history: every finished (or failed) batch run is kept
// as one JSON record on disk (Rust side: transcripts.rs — atomic writes,
// owner-only permissions, files are the source of truth). This module owns
// the in-memory mirror: a module-level zustand store (same survival contract
// as transcribeRun) plus load/upsert/delete that keep disk and mirror in step.

import { create } from "zustand";
import {
  audioBasePref, deleteTranscriptRecord, listTranscriptRecords, saveTranscriptRecord,
} from "../api";
import { useApp } from "../store";
import type { BatchResult, TranscribeOptions } from "../types";
import { joinSegmentTexts } from "./transcriptFormats";
import { applyTextEdits } from "./wordAlign";

export interface TranscriptRecord {
  schemaVersion: 1;
  /** Absent (pre-v2 records) = "file". Dictation records reuse the same
   *  shape: sourceName carries the target-app label, sourcePath the saved
   *  recording's path ("" when recordings are off/expired), result.text the
   *  session text and result.duration its length in seconds — so search,
   *  snippets, buckets and the meta line work unchanged. */
  kind?: "file" | "dictation" | "url" | "text";
  id: string; // crypto.randomUUID()
  createdAt: string; // ISO
  sourcePath: string;
  sourceName: string;
  /** URL records only: the media title from the link preview/result — the
   *  display name (sourcePath holds the URL itself, which IS the identity). */
  title?: string;
  /** App-managed audio copy (transcripts/media/<id>.<ext>) — playback falls
   *  back to it when the original at sourcePath is gone. File records only. */
  mediaPath?: string;
  /** Local VIDEO copy of a link run (`<base>/video/<id>.<ext>`) — kept for
   *  export; there is no in-app video playback yet. URL records only. */
  videoPath?: string;
  status: "done" | "failed";
  error?: string;
  tookMs?: number;
  backendId?: string;
  model?: string;
  language?: string;
  /** The per-run options the file was transcribed with (Retry re-uses them). */
  options?: TranscribeOptions;
  result?: BatchResult;
  /** The workbench overlays, exactly as in transcribeRun (label-keyed renames
   *  and palette indexes; segment-index-keyed corrections) — reopening a
   *  record restores the FULL workbench state. */
  renames?: Record<string, string>;
  speakerColors?: Record<string, number>;
  edits?: Record<number, string>;
  speakerEdits?: Record<number, string>;
  /** Segment indexes whose translations went stale (original edited). */
  translationsStale?: Record<number, true>;
  /** The export panel's dragged track order and typed track names
   *  (lib/exportTracks TrackPrefs; read through readTrackPrefs). */
  exportTracks?: { order?: string[]; names?: Record<string, string> };
  // ── dictation-only metadata ──
  /** Focused app id at session start (also the filter facet). */
  appId?: string;
  profileName?: string;
  profileTag?: string;
  activation?: "hold" | "handsfree";
  /** What actually happened to the text (endOutcome). */
  insertMethod?: "typed" | "clipboard" | "none";
  wordCount?: number;
  /** T2T dictation: the translated text that was injected (the record's
   *  `result.text` stays the ORIGINAL transcript), its target language, and
   *  whether translation actually happened (false = fallback to original). */
  translatedText?: string;
  translationTarget?: string;
  translationInjected?: boolean;
  /** Per-language transcripts, keyed the same way a batch run keys them
   *  (`BatchResult.translations`). `translatedText` above is the FLATTENED
   *  form that was actually injected — it is what went into the target app,
   *  so it stays — but it cannot be taken apart again: the join is
   *  blank-line separated and a transcript contains its own line breaks.
   *  History rendered that blob under one label and then rendered
   *  `result.text` again beneath it, which is why the original appeared
   *  twice. With this map every track is addressable, so each renders once
   *  under its own code.
   *
   *  Absent on records written before this existed; those still render as a
   *  single untitled block, which is the most that can honestly be said
   *  about them. */
  translations?: Record<string, string>;
  /** Target codes as an ARRAY. `translationTarget` is the same list joined
   *  with ", " for display, which loses the boundaries — `RouteBadge` needs
   *  the parts, and a 3+ target list was being truncated mid-code. */
  translationTargets?: string[];
  /** Whether the untranslated original was injected alongside the
   *  translations. Without it the renderer cannot tell whether the first
   *  block of `translatedText` is the original or a translation, so it
   *  cannot strip the duplicate even when it can see one. */
  includeOriginal?: boolean;
  /** Was translation even configured for this session, and if it was attempted and
   *  didn't land, why. Additive + OPTIONAL on purpose, so schemaVersion stays 1: an
   *  old record reads back as "no translation configured", which is what it is. The
   *  distinction matters because `translatedText` absent means BOTH "translation was
   *  off" and "translation failed and the original went in" — two very different
   *  stories to tell the user about the text they are looking at. */
  translationAttempted?: boolean;
  translationFailure?: string;
}

interface HistoryState {
  /** Newest-first. */
  records: TranscriptRecord[];
  loaded: boolean;
}

export const useTranscriptHistory = create<HistoryState>(() => ({
  records: [],
  loaded: false,
}));

/** The selector behind useRecord: one record by id. */
export const selectRecord = (id: string | null | undefined) => (s: Pick<HistoryState, "records">) =>
  id ? s.records.find((r) => r.id === id) : undefined;

/** One record, subscribed on its own: the component re-renders when THIS record changes,
 *  not on every history write (a subscription to `records` re-rendered on each). */
export function useRecord(id: string | null | undefined): TranscriptRecord | undefined {
  return useTranscriptHistory(selectRecord(id));
}

/** Records are read back from disk — malformed files (hand-edited, foreign)
 *  must never break the listing. */
function isRecord(v: unknown): v is TranscriptRecord {
  const r = v as TranscriptRecord;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.sourcePath === "string" &&
    typeof r.sourceName === "string" &&
    (r.status === "done" || r.status === "failed")
  );
}

/** Only the string entries of a target list read back from disk; `undefined` when it is not
 *  an array at all. A string ("de") passes every `?.length` check and then throws at `.map`. */
function stringTargets(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : undefined;
}

/** Only the string entries of a correction/rename map read back from disk; `undefined` when it
 *  is not a plain object. A number reaches the speaker-name sanitizer (`for..of`) and throws in
 *  the render. Hands the same object back when it is already clean. */
function stringMap<K extends string | number>(v: unknown): Record<K, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.every(([, x]) => typeof x === "string")) return v as Record<K, string>;
  return Object.fromEntries(entries.filter(([, x]) => typeof x === "string")) as Record<K, string>;
}

/** Repair the fields a malformed file would crash the History render with, keeping the record:
 *  a non-string appId throws in the search and app chips (`.toLowerCase()` / `.split()`), a
 *  non-array target list in the route badge, the provenance line and the bug report's
 *  `options.translateTo` fallback (`.map` / `.join`), a non-string `translatedText` or
 *  `result.text` in the snippet sanitizer (`for..of`), a damaged segment list or correction
 *  map in the snippet's per-segment `.trim()`, a non-string speaker name (segment label,
 *  rename, speaker correction, legend list) in the viewer's speaker-name sanitizer, a segment's
 *  non-string translation or non-array kept-source list in the viewer's and exports' `.trim()` /
 *  `.includes()` (a string map also lists its indexes as ghost tracks), a non-string
 *  `error` / `title` in the failed row's sanitizer and the export stem, an `insertMethod` that
 *  is not one of the three known values in the expanded row's footer (an object as a JSX
 *  child), a non-number `result.duration` in the viewer's meta line (`.toFixed`), and a damaged
 *  `result.timedTracks` list (a non-array, a track with no cue list, a cue with non-string text
 *  or non-finite times) in the viewer's, the media export's and the cue splitter's `.map` /
 *  `.some` / `.trim()`. Every step composes on `out`. */
function repairRecord(r: TranscriptRecord): TranscriptRecord {
  let out = r;
  const tt = (r.options as { translateTo?: unknown } | undefined)?.translateTo;
  if (tt !== undefined && (!Array.isArray(tt) || tt.some((t) => typeof t !== "string"))) {
    out = { ...out, options: { ...out.options, translateTo: stringTargets(tt) } as TranscribeOptions };
  }
  if (r.translatedText != null && typeof r.translatedText !== "string") out = { ...out, translatedText: undefined };
  const im = r.insertMethod as unknown;
  if (im != null && im !== "typed" && im !== "clipboard" && im !== "none") out = { ...out, insertMethod: undefined };
  if (out.result && typeof out.result.text !== "string") out = { ...out, result: { ...out.result, text: "" } };
  const dur = out.result?.duration as unknown;
  if (out.result && dur != null && !(typeof dur === "number" && Number.isFinite(dur))) {
    out = { ...out, result: { ...out.result, duration: undefined } };
  }
  // Before the segment step, so a remap below moves already-clean maps.
  const edits = stringMap<number>(r.edits);
  if (r.edits != null && edits !== r.edits) out = { ...out, edits };
  const speakerEdits = stringMap<number>(r.speakerEdits);
  if (r.speakerEdits != null && speakerEdits !== r.speakerEdits) out = { ...out, speakerEdits };
  const renames = stringMap<string>(r.renames);
  if (r.renames != null && renames !== r.renames) out = { ...out, renames };
  const spk = out.result?.speakers as unknown;
  if (out.result && spk != null && (!Array.isArray(spk) || spk.some((x) => typeof x !== "string"))) {
    out = { ...out, result: { ...out.result, speakers: stringTargets(spk) } };
  }
  const segs = out.result?.segments as unknown;
  if (out.result && segs != null) {
    if (!Array.isArray(segs)) {
      out = { ...out, result: { ...out.result, segments: undefined } };
    } else {
      // A bad entry (not an object, or no string text) is dropped, never kept as a blank: a
      // blank segment would export as an empty cue and read as untranslated forever. The
      // corrections are keyed by segment index, so they move with their segments and the
      // dropped slots' keys go. A kept segment with a non-string speaker keeps its text and
      // loses only the label; a damaged translation map or kept-source list keeps only its
      // string entries (or goes, when it is not a map / list at all).
      type RawSeg = { speaker?: unknown; translations?: unknown; translationsKept?: unknown };
      const ok = (s: unknown) => !!s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string";
      const badSpeaker = (s: unknown) => {
        const sp = (s as RawSeg).speaker;
        return sp !== undefined && typeof sp !== "string";
      };
      const badTr = (s: unknown) => {
        const t = (s as RawSeg).translations;
        return t != null && stringMap<string>(t) !== t;
      };
      const badKept = (s: unknown) => {
        const k = (s as RawSeg).translationsKept;
        return k != null && (!Array.isArray(k) || k.some((x) => typeof x !== "string"));
      };
      const bad = (s: unknown) => badSpeaker(s) || badTr(s) || badKept(s);
      // A clean segment is handed back as the same object.
      const fixSeg = (s: unknown) => {
        if (!bad(s)) return s;
        const seg = s as RawSeg;
        return {
          ...(s as object),
          ...(badSpeaker(s) ? { speaker: undefined } : {}),
          ...(badTr(s) ? { translations: stringMap<string>(seg.translations) } : {}),
          ...(badKept(s) ? { translationsKept: stringTargets(seg.translationsKept) } : {}),
        };
      };
      const kept = () => segs.filter(ok).map(fixSeg) as typeof out.result.segments;
      if (segs.every(ok)) {
        if (segs.some(bad)) out = { ...out, result: { ...out.result, segments: kept() } };
      } else {
        const moved = new Map<number, number>();
        segs.forEach((s, i) => {
          if (ok(s)) moved.set(i, moved.size);
        });
        const remap = <V,>(m: Record<number, V> | undefined): Record<number, V> | undefined =>
          m && typeof m === "object"
            ? Object.fromEntries(
                Object.entries(m).flatMap(([k, v]) => {
                  // Only a canonical index key ("1", not "1.0" or ""): no reader looks the others up.
                  const to = String(Number(k)) === k ? moved.get(Number(k)) : undefined;
                  return to === undefined ? [] : [[to, v]];
                }),
              )
            : undefined;
        out = {
          ...out,
          result: { ...out.result, segments: kept() },
          edits: remap(out.edits),
          speakerEdits: remap(out.speakerEdits),
          translationsStale: remap(out.translationsStale),
        };
      }
    }
  }
  const tts = out.result?.timedTracks as unknown;
  if (out.result && tts != null) {
    if (!Array.isArray(tts)) {
      out = { ...out, result: { ...out.result, timedTracks: undefined } };
    } else {
      // A track with no string id/lang or no cue list is dropped whole; a kept track keeps only
      // its cues with string text and finite times and loses a non-string label/site (the JSON
      // export iterates them), and any track left without cues goes, stored empty or emptied by
      // the repair (the app never stores a cue-less track; a kept one would show a blank lane and
      // an export choice that writes an empty file). A clean track (and list) is handed back as
      // the same object.
      const okCue = (c: unknown) => {
        const q = c as { start?: unknown; end?: unknown; text?: unknown };
        return (
          !!q && typeof q === "object" && typeof q.text === "string" &&
          typeof q.start === "number" && Number.isFinite(q.start) &&
          typeof q.end === "number" && Number.isFinite(q.end)
        );
      };
      const okTrack = (t: unknown) => {
        const k = t as { id?: unknown; lang?: unknown; cues?: unknown };
        return !!k && typeof k === "object" && typeof k.id === "string" && typeof k.lang === "string" && Array.isArray(k.cues);
      };
      const cuesOf = (t: unknown) => (t as { cues: unknown[] }).cues;
      const str = (v: unknown) => v == null || typeof v === "string";
      const cleanTrack = (t: unknown) => {
        const k = t as { label?: unknown; site?: unknown };
        return cuesOf(t).length > 0 && cuesOf(t).every(okCue) && str(k.label) && str(k.site);
      };
      const fixTrack = (t: unknown): unknown[] => {
        if (cleanTrack(t)) return [t];
        const k = t as { label?: unknown; site?: unknown };
        const cues = cuesOf(t).filter(okCue);
        if (!cues.length) return [];
        return [{ ...(t as object), cues, label: str(k.label) ? k.label : undefined, site: str(k.site) ? k.site : undefined }];
      };
      if (!tts.every(okTrack) || !tts.every(cleanTrack)) {
        const timedTracks = tts.filter(okTrack).flatMap(fixTrack) as typeof out.result.timedTracks;
        out = { ...out, result: { ...out.result, timedTracks } };
      }
    }
  }
  // No segment for an index-keyed correction to land on, whether the list was damaged, is empty
  // or is missing: the maps go, or the viewer marks the record edited and rebuilds an empty text
  // for Copy/export from no segments.
  if (!out.result?.segments?.length && (out.edits || out.speakerEdits || out.translationsStale)) {
    out = { ...out, edits: undefined, speakerEdits: undefined, translationsStale: undefined };
  }
  if (r.appId != null && typeof r.appId !== "string") out = { ...out, appId: undefined };
  if (r.error != null && typeof r.error !== "string") out = { ...out, error: undefined };
  if (r.title != null && typeof r.title !== "string") out = { ...out, title: undefined };
  if (r.translationTargets != null && !Array.isArray(r.translationTargets)) {
    out = { ...out, translationTargets: undefined };
  } else if (r.translationTargets?.some((t) => typeof t !== "string")) {
    out = { ...out, translationTargets: stringTargets(r.translationTargets) };
  }
  const tr = out.result?.translation as unknown;
  if (out.result && tr && typeof tr === "object") {
    const targets = (tr as { targets?: unknown }).targets;
    const clean = stringTargets(targets) ?? [];
    if (!Array.isArray(targets) || clean.length !== targets.length) {
      out = { ...out, result: { ...out.result, translation: { ...(tr as object), targets: clean } } };
    }
  }
  return out;
}

function newestFirst(records: TranscriptRecord[]): TranscriptRecord[] {
  // A consistent comparator (equal stamps → 0): two records minted in the same millisecond
  // are reachable, and an inconsistent comparator's tie order is implementation-defined.
  return [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

let loading: Promise<void> | null = null;
/** Mirror changes (upsert → record, delete → null) made while a listing is in flight;
 *  replayed over the snapshot when it lands, since the snapshot predates them. */
let touchedSinceListing: Map<string, TranscriptRecord | null> | null = null;

/** Load the history from disk (once; later calls are no-ops unless forced). A FORCED call
 *  chains onto an in-flight listing instead of adopting it: every forced caller just changed
 *  the files on disk, and the listing already running was taken before that change.
 *  Mirror changes made while a listing is in flight are replayed over the snapshot — the
 *  snapshot predates them. */
export function loadHistory(force = false): Promise<void> {
  if (loading) {
    if (!force) return loading;
    return loading.then(() => loadHistory(true));
  }
  if (!force && useTranscriptHistory.getState().loaded) return Promise.resolve();
  // Issue any parked coalesced write before listing. The write is not awaited (nothing
  // orders the two IPC calls), but without this a just-edited record trailed the listing by
  // the whole debounce window and reverted to its older on-disk text in the UI.
  void flushRecordWrites();
  touchedSinceListing = new Map();
  loading = listTranscriptRecords()
    .then((raw) => {
      const touched = touchedSinceListing ?? new Map<string, TranscriptRecord | null>();
      // A field of the wrong shape (hand-edited or foreign file) would throw in the History
      // render; keep the record, repair only the bad fields (repairRecord).
      const byId = new Map(raw.filter(isRecord).map(repairRecord).map((r) => [r.id, r]));
      for (const [id, rec] of touched) {
        if (rec) byId.set(id, rec);
        else byId.delete(id);
      }
      useTranscriptHistory.setState({
        records: newestFirst([...byId.values()]),
        loaded: true,
      });
    })
    .catch((e) => {
      console.error("history load failed:", e);
      useTranscriptHistory.setState({ loaded: true });
    })
    .finally(() => {
      loading = null;
      touchedSinceListing = null;
    });
  return loading;
}

/** Insert or replace one record — in the mirror immediately, on disk
 *  best-effort (an I/O failure must never break the run that produced it). */
// Rapid successive upserts of ONE record — a chunked retro-translate merges every
// TRANSLATE_CHUNK (32) segments — each stringified and rewrote the whole record (all
// segments, words and every translation merged so far): ~30 full rewrites for a
// 900-segment transcript. The in-memory mirror updates immediately (live fill is the
// point); the disk write is leading-edge, then coalesced.
const WRITE_COALESCE_MS = 2_000;
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingWrite = new Map<string, TranscriptRecord>();
const lastWriteAt = new Map<string, number>();
/** Saves and deletes already issued and not yet settled — the immediate write and a fired
 *  coalesce timer drop their promise, so flushRecordWrites must find them here. */
const inFlight = new Set<Promise<void>>();

/** Track one disk call until it settles (it must never reject). */
function track(p: Promise<void>): Promise<void> {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/** Write one record now; the promise settles when the save does (never rejects). */
function writeNow(rec: TranscriptRecord): Promise<void> {
  const now = Date.now();
  // One stamp per record ever written would grow for the whole session (every dictation
  // adds one). A stamp older than the window decides nothing — upsertRecord reads a missing
  // one as "long ago" — so sweep those, only once the map is big enough to be worth it.
  if (lastWriteAt.size > 64) {
    for (const [id, at] of lastWriteAt) if (now - at >= WRITE_COALESCE_MS) lastWriteAt.delete(id);
  }
  lastWriteAt.set(rec.id, now);
  return track(saveTranscriptRecord(rec.id, JSON.stringify(rec), rec.kind === "dictation").catch((e) =>
    console.error("history save failed:", e),
  ));
}

/** DROP every coalesced write (never land it): the caller is about to move or wipe the
 *  files the parked records describe, and a write landing after that put the pre-move paths —
 *  or a record Rust just deleted — straight back on disk. */
export function dropPendingWrites(): void {
  for (const t of writeTimers.values()) clearTimeout(t);
  writeTimers.clear();
  pendingWrite.clear();
  lastWriteAt.clear();
}

/** The workbench registers records it holds open (transcribeRun); a delete must reach those
 *  registries too, or the next overlay edit re-saves the deleted record. Registered from
 *  transcribeRun's module scope (it imports this module, so no back-import). */
let forgetHook: ((id: string | null) => void) | null = null;
export function setRecordForgetHook(fn: (id: string | null) => void): void {
  forgetHook = fn;
}

/** Write every coalesced record now. The writes are issued synchronously; the promise
 *  settles once they — and every save or delete already in flight — have all landed (or
 *  failed): a quit path must await it before it exits, since a real exit (tray Quit, the
 *  trayless close) never fires `beforeunload`. Callers that only need the writes issued
 *  (loadHistory, beforeunload) may ignore it. */
export function flushRecordWrites(): Promise<void> {
  for (const [id, rec] of pendingWrite) {
    clearTimeout(writeTimers.get(id));
    writeTimers.delete(id);
    writeNow(rec); // tracked in inFlight
  }
  pendingWrite.clear();
  return Promise.allSettled([...inFlight]).then(() => undefined);
}

export function upsertRecord(rec: TranscriptRecord): void {
  touchedSinceListing?.set(rec.id, rec);
  useTranscriptHistory.setState((s) => ({
    records: newestFirst([rec, ...s.records.filter((r) => r.id !== rec.id)]),
  }));
  const since = Date.now() - (lastWriteAt.get(rec.id) ?? 0);
  if (since >= WRITE_COALESCE_MS && !writeTimers.has(rec.id)) {
    void writeNow(rec);
    return;
  }
  pendingWrite.set(rec.id, rec);
  if (writeTimers.has(rec.id)) return;
  writeTimers.set(
    rec.id,
    setTimeout(() => {
      writeTimers.delete(rec.id);
      const last = pendingWrite.get(rec.id);
      pendingWrite.delete(rec.id);
      if (last) void writeNow(last);
    }, WRITE_COALESCE_MS),
  );
}

/** The mirror's copy of one record — the ONLY current one. Anything that holds a record
 *  across an await or a debounce must re-read it here before writing: a copy kept aside goes
 *  stale the moment another writer (the viewer, a media fetch) upserts the same id, and
 *  saving it reverts their fields. `undefined` = gone (deleted, or wiped). */
export function currentRecord(id: string): TranscriptRecord | undefined {
  return useTranscriptHistory.getState().records.find((r) => r.id === id);
}

/** Read-modify-write one record against its latest copy. No-op when the record is gone
 *  (a late write must not resurrect a deleted one), and when `fn` hands the same object
 *  back (nothing changed → no disk write). */
export function patchRecord(id: string, fn: (r: TranscriptRecord) => TranscriptRecord): void {
  const latest = currentRecord(id);
  if (!latest) return;
  const next = fn(latest);
  if (next !== latest) upsertRecord(next);
}

/** Everything a finished dictation session hands over (streaming.ts). */
export interface DictationCapture {
  text: string;
  startedAt: number; // Date.now() at session start
  durationMs: number;
  backendId: string;
  model: string;
  language: string;
  appId?: string;
  appTitle?: string;
  profileName?: string;
  profileTag?: string;
  activation?: "hold" | "handsfree";
  insertMethod: "typed" | "clipboard" | "none";
  recordingPath?: string;
  translatedText?: string;
  translationTarget?: string;
  translationInjected?: boolean;
  translationAttempted?: boolean;
  translationFailure?: string;
  /** Per-language transcripts + the target list, kept apart. See the notes on
   *  TranscriptRecord.translations: the injected string is a lossy join and
   *  cannot be split back into languages. */
  translations?: Record<string, string>;
  translationTargets?: string[];
  includeOriginal?: boolean;
}

/** Save a finished dictation session as a history record; returns its id so
 *  the recording path can be attached when it arrives after the fact. */
export function recordDictation(cap: DictationCapture): string {
  const rec: TranscriptRecord = {
    schemaVersion: 1,
    kind: "dictation",
    id: crypto.randomUUID(),
    createdAt: new Date(cap.startedAt).toISOString(),
    sourcePath: cap.recordingPath ?? "",
    sourceName: cap.appTitle?.trim() || cap.appId?.trim() || "Dictation",
    status: "done",
    tookMs: cap.durationMs,
    backendId: cap.backendId,
    model: cap.model,
    language: cap.language,
    result: { text: cap.text, duration: cap.durationMs / 1000 },
    appId: cap.appId,
    profileName: cap.profileName,
    profileTag: cap.profileTag,
    activation: cap.activation,
    insertMethod: cap.insertMethod,
    wordCount: cap.text.split(/\s+/).filter(Boolean).length,
    translatedText: cap.translatedText,
    translationTarget: cap.translationTarget,
    translationInjected: cap.translationInjected,
    translationAttempted: cap.translationAttempted,
    translationFailure: cap.translationFailure,
    translations: cap.translations,
    translationTargets: cap.translationTargets,
    // Normalized to absent when false, matching how TranslationFields stores
    // the flag, so old and new records compare the same way.
    includeOriginal: cap.includeOriginal || undefined,
  };
  upsertRecord(rec);
  return rec.id;
}

/** Late-link the saved recording (the Rust event can land after the session
 *  settles). No-op when the record is gone (deleted, or capture skipped). */
export function attachRecordingPath(id: string, path: string): void {
  patchRecord(id, (r) => (r.sourcePath === path ? r : { ...r, sourcePath: path }));
}

/** Remove one record — mirror and disk. */
export function deleteRecord(id: string): void {
  // A coalesced write still pending for this record would land AFTER the delete and
  // resurrect the file on the next load — drop it first. The workbench's registries too:
  // its 800 ms edit debounce and the chunked translate merge re-read the record from there
  // and called upsertRecord, resurrecting the file (with its media already gone).
  clearTimeout(writeTimers.get(id));
  writeTimers.delete(id);
  pendingWrite.delete(id);
  lastWriteAt.delete(id);
  forgetHook?.(id);
  touchedSinceListing?.set(id, null);
  useTranscriptHistory.setState((s) => ({
    records: s.records.filter((r) => r.id !== id),
  }));
  void track(deleteTranscriptRecord(id, audioBasePref(useApp.getState().settings.recording)).catch(
    (e) => console.error("history delete failed:", e),
  ));
}

/** The record's transcript text with corrections applied — snippet + search. */
export function recordText(rec: TranscriptRecord, max = Infinity): string {
  const segs = rec.result?.segments;
  if (!segs?.length) return rec.result?.text ?? "";
  // Joined as the viewer and the exports join them — each part trimmed (raw segment text
  // often leads with a space), no space between two CJK segments.
  const part = (i: number) => (rec.edits?.[i] ?? segs[i].text).trim();
  if (max === Infinity) return joinSegmentTexts(segs.map((_, i) => part(i)));
  // Bounded: a History snippet keeps 160 chars, so joining a 900-segment transcript per row
  // per keystroke defeated the sanitizer's own output bound. Joined once from just enough
  // parts: a seam only ever adds (a CJK seam adds nothing), so once the parts alone reach
  // `max` the joined text does too, and its prefix is the full join's prefix.
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; i < segs.length && n < max; i++) {
    const p = part(i);
    parts.push(p);
    n += p.length;
  }
  return joinSegmentTexts(parts).slice(0, max);
}

/** The record's language tracks, original first, or null when it has none.
 *
 *  Returns null for records written before per-language tracks existed: their
 *  `translatedText` is a blank-line join and a transcript contains its own
 *  line breaks, so splitting it back apart would mislabel text rather than
 *  recover it. Those records render as one untitled block instead — the most
 *  that can honestly be said about them. */
export function recordTracks(
  rec: TranscriptRecord,
): { lang: string; text: string; orig?: boolean }[] | null {
  const tr = rec.translations;
  if (!tr || typeof tr !== "object") return null;
  // Both fields are file-borne and unvalidated on load: a string where the
  // target list belongs, or a number where a track belongs, must not throw.
  const targets = Array.isArray(rec.translationTargets) ? rec.translationTargets : Object.keys(tr);
  const map = tr as Record<string, unknown>;
  const langs = targets.filter(
    (l): l is string => typeof l === "string" && typeof map[l] === "string" && (map[l] as string).trim() !== "",
  );
  if (!langs.length) return null;
  const original = recordText(rec).trim();
  // The original is a track like any other, dimmed and carrying its own code.
  // Rendering it as a separate labelled section BELOW the blob is what showed
  // it twice, because the blob already began with it.
  // Always a track: `includeOriginal` says what was INJECTED, not what the record should
  // show — gating on it hid the spoken transcript for the default configuration. The
  // tracks come from the translations map, which never carries the source, so this
  // cannot duplicate anything.
  const head = original
    ? [{ lang: rec.language && rec.language !== "auto" ? rec.language : "orig", text: original, orig: true }]
    : [];
  return [...head, ...langs.map((lang) => ({ lang, text: map[lang] as string }))];
}

/** Human app label from a dictation record — the stored window title, else the
 *  app id's last dot-segment, capitalized ("org.mozilla.thunderbird" → "Thunderbird"). */
export function appLabel(r: TranscriptRecord): string {
  if (r.sourceName && r.sourceName !== "Dictation") return r.sourceName;
  const seg = r.appId?.split(".").pop()?.trim();
  return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Dictation";
}

/** Label for the "dictated into" chip. The chip groups by app id, so it must
 *  name the APP ("Thunderbird"), not the first grouped session's window title
 *  ("Re: invoice — Mozilla Thunderbird"), which is what `appLabel` returns for a
 *  row heading and which changed as newer sessions arrived. */
export function appChipLabel(r: Pick<TranscriptRecord, "appId" | "sourceName">): string {
  const seg = r.appId?.split(".").pop()?.trim();
  return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : appLabel(r as TranscriptRecord);
}

/** The record's result with the stored corrections folded in — the same
 *  transform the workbench applies before Copy/export (an edited segment's
 *  words are re-aligned to the corrected text, keeping their timings). */
export function recordEditedResult(rec: TranscriptRecord): BatchResult {
  const res = rec.result ?? { text: "" };
  const edits = rec.edits ?? {};
  const speakerEdits = rec.speakerEdits ?? {};
  // Unedited: the server's own result, its `text` included — the viewer's rule, so
  // History's quick export matches the panel's (a CJK or punctuated text is not
  // a space-join of its segments).
  if (!res.segments?.length || (!Object.keys(edits).length && !Object.keys(speakerEdits).length)) return res;
  const segments = res.segments.map((s, i) => {
    const text = edits[i] ?? s.text;
    const speaker = speakerEdits[i] ?? s.speaker;
    return { ...s, text, ...(speaker ? { speaker } : {}) };
  });
  const words = Object.keys(edits).length ? applyTextEdits(res, edits) : res.words;
  return {
    ...res,
    segments,
    words,
    text: joinSegmentTexts(segments.map((s) => s.text.trim())),
  };
}
