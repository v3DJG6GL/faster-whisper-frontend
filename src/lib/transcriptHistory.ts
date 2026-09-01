// Local transcription history: every finished (or failed) batch run is kept
// as one JSON record on disk (Rust side: transcripts.rs — atomic writes,
// owner-only permissions, files are the source of truth). This module owns
// the in-memory mirror: a module-level zustand store (same survival contract
// as transcribeRun) plus load/upsert/delete that keep disk and mirror in step.

import { create } from "zustand";
import {
  audioBasePref, deleteTranscriptRecord, listTranscriptRecords, saveTranscriptRecord,
} from "./api";
import { useApp } from "./store";
import type { BatchResult, TranscribeOptions } from "./types";
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
    (r.status === "done" || r.status === "failed")
  );
}

function newestFirst(records: TranscriptRecord[]): TranscriptRecord[] {
  return [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

let loading: Promise<void> | null = null;

/** Load the history from disk (once; later calls are no-ops unless forced). */
export function loadHistory(force = false): Promise<void> {
  if (loading) return loading;
  if (!force && useTranscriptHistory.getState().loaded) return Promise.resolve();
  loading = listTranscriptRecords()
    .then((raw) => {
      useTranscriptHistory.setState({
        records: newestFirst(raw.filter(isRecord)),
        loaded: true,
      });
    })
    .catch((e) => {
      console.error("history load failed:", e);
      useTranscriptHistory.setState({ loaded: true });
    })
    .finally(() => {
      loading = null;
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

function writeNow(rec: TranscriptRecord): void {
  lastWriteAt.set(rec.id, Date.now());
  void saveTranscriptRecord(rec.id, JSON.stringify(rec), rec.kind === "dictation").catch((e) =>
    console.error("history save failed:", e),
  );
}

/** Write every coalesced record now (app teardown). */
export function flushRecordWrites(): void {
  for (const [id, rec] of pendingWrite) {
    clearTimeout(writeTimers.get(id));
    writeTimers.delete(id);
    writeNow(rec);
  }
  pendingWrite.clear();
}

export function upsertRecord(rec: TranscriptRecord): void {
  useTranscriptHistory.setState((s) => ({
    records: newestFirst([rec, ...s.records.filter((r) => r.id !== rec.id)]),
  }));
  const since = Date.now() - (lastWriteAt.get(rec.id) ?? 0);
  if (since >= WRITE_COALESCE_MS && !writeTimers.has(rec.id)) {
    writeNow(rec);
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
      if (last) writeNow(last);
    }, WRITE_COALESCE_MS),
  );
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
  const rec = useTranscriptHistory.getState().records.find((r) => r.id === id);
  if (!rec || rec.sourcePath === path) return;
  upsertRecord({ ...rec, sourcePath: path });
}

/** Remove one record — mirror and disk. */
export function deleteRecord(id: string): void {
  // A coalesced write still pending for this record would land AFTER the delete and
  // resurrect the file on the next load — drop it first.
  clearTimeout(writeTimers.get(id));
  writeTimers.delete(id);
  pendingWrite.delete(id);
  useTranscriptHistory.setState((s) => ({
    records: s.records.filter((r) => r.id !== id),
  }));
  void deleteTranscriptRecord(id, audioBasePref(useApp.getState().settings.recording)).catch(
    (e) => console.error("history delete failed:", e),
  );
}

/** The record's transcript text with corrections applied — snippet + search. */
export function recordText(rec: TranscriptRecord): string {
  const segs = rec.result?.segments;
  if (!segs?.length) return rec.result?.text ?? "";
  return segs.map((s, i) => rec.edits?.[i] ?? s.text).join(" ");
}

/** The record's result with the stored corrections folded in — the same
 *  transform the workbench applies before Copy/export (an edited segment's
 *  words are re-aligned to the corrected text, keeping their timings). */
export function recordEditedResult(rec: TranscriptRecord): BatchResult {
  const res = rec.result ?? { text: "" };
  const edits = rec.edits ?? {};
  const speakerEdits = rec.speakerEdits ?? {};
  if (!res.segments?.length) return res;
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
    text: segments.map((s) => s.text.trim()).join(" "),
  };
}
