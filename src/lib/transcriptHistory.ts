// Local transcription history: every finished (or failed) batch run is kept
// as one JSON record on disk (Rust side: transcripts.rs — atomic writes,
// owner-only permissions, files are the source of truth). This module owns
// the in-memory mirror: a module-level zustand store (same survival contract
// as transcribeRun) plus load/upsert/delete that keep disk and mirror in step.

import { create } from "zustand";
import {
  deleteTranscriptRecord, listTranscriptRecords, saveTranscriptRecord,
} from "./api";
import type { BatchResult, TranscribeOptions } from "./types";

export interface TranscriptRecord {
  schemaVersion: 1;
  id: string; // crypto.randomUUID()
  createdAt: string; // ISO
  sourcePath: string;
  sourceName: string;
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
export function upsertRecord(rec: TranscriptRecord): void {
  useTranscriptHistory.setState((s) => ({
    records: newestFirst([rec, ...s.records.filter((r) => r.id !== rec.id)]),
  }));
  void saveTranscriptRecord(rec.id, JSON.stringify(rec)).catch((e) =>
    console.error("history save failed:", e),
  );
}

/** Remove one record — mirror and disk. */
export function deleteRecord(id: string): void {
  useTranscriptHistory.setState((s) => ({
    records: s.records.filter((r) => r.id !== id),
  }));
  void deleteTranscriptRecord(id).catch((e) =>
    console.error("history delete failed:", e),
  );
}

/** The record's transcript text with corrections applied — snippet + search. */
export function recordText(rec: TranscriptRecord): string {
  const segs = rec.result?.segments;
  if (!segs?.length) return rec.result?.text ?? "";
  return segs.map((s, i) => rec.edits?.[i] ?? s.text).join(" ");
}

/** The record's result with the stored corrections folded in — the same
 *  transform the workbench applies before Copy/export (edited segments drop
 *  their words: the timing no longer matches the text). */
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
  const editedIdx = new Set(Object.keys(edits).map(Number));
  const words = editedIdx.size
    ? res.words?.filter(
        (w) =>
          !res.segments!.some(
            (s, i) =>
              editedIdx.has(i) && w.start >= s.start - 0.05 && w.start < s.end + 0.05,
          ),
      )
    : res.words;
  return {
    ...res,
    segments,
    words,
    text: segments.map((s) => s.text.trim()).join(" "),
  };
}
