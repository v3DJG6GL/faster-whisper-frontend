// Log-viewer controller: hydration + live stream + the sidebar badge.
//
// The line buffer lives at MODULE level, outside zustand — the hard-won
// lesson from streaming.ts: pushing high-frequency payloads through the
// shared store once bloated the WebKitGTK renderer to multiple GB. The store
// holds only a version counter and the tiny badge/status fields; list
// consumers re-read `visibleLines()` when `version` bumps.

import { create } from "zustand";
import {
  getLogStatus,
  getLogTail,
  onLogLines,
  onLogStatus,
  setLogStream,
  type LogLine,
} from "./api";
import type { LevelThreshold } from "./logFilter";

export const LOG_BUFFER_CAP = 10_000;

let buf: LogLine[] = [];
let nextSeq = 0;
/** "Clear view" hides everything at or below this seq — view/buffer only,
 *  never the ring or the file on disk. */
let clearFloorSeq = 0;
let visibleCache: { version: number; lines: LogLine[] } | null = null;

interface LogsState {
  /** Bumped on every buffer change; list consumers re-read visibleLines(). */
  version: number;
  status: { seq: number; errors: number; warns: number };
  /** Error/warn totals snapshotted when the Logs screen was last viewed. */
  baseline: { errors: number; warns: number };
  /** One-shot threshold handed to the Logs screen by the failure banner. */
  prefilter: LevelThreshold | null;
}

export const useLogs = create<LogsState>(() => ({
  version: 0,
  status: { seq: 0, errors: 0, warns: 0 },
  baseline: { errors: 0, warns: 0 },
  prefilter: null,
}));

function append(lines: LogLine[]) {
  if (lines.length === 0) return;
  // Hydration and the stream can overlap by a few lines — drop already-seen seqs.
  const fresh = lines.filter((l) => l.seq >= nextSeq);
  if (fresh.length === 0) return;
  buf.push(...fresh);
  nextSeq = fresh[fresh.length - 1].seq + 1;
  if (buf.length > LOG_BUFFER_CAP) buf = buf.slice(buf.length - LOG_BUFFER_CAP);
  useLogs.setState((s) => ({ version: s.version + 1 }));
}

/** The buffer minus the "Clear view" floor. Reference-stable WITHIN a version,
 *  and a NEW array on every version bump.
 *
 *  The second half is load-bearing and used to be wrong: with no clear floor
 *  this returned `buf` itself, which `append()` mutates in place — so the
 *  reference never changed, and every `useMemo` keyed on it in Logs.tsx went
 *  on believing its work was still valid. The screen rendered the snapshot it
 *  computed at mount (empty, before hydration) forever: no lines, no subsystem
 *  chips, no live tail, no "N new lines" pill, and a bug report that copied
 *  nothing. Changing a filter was the only thing that invalidated those memos,
 *  which is why the view only ever populated after touching one.
 *
 *  Cost is one slice per event BATCH (not per render), bounded by the 10k cap. */
export function visibleLines(): LogLine[] {
  const version = useLogs.getState().version;
  if (visibleCache?.version !== version) {
    visibleCache = {
      version,
      lines: clearFloorSeq > 0 ? buf.filter((l) => l.seq >= clearFloorSeq) : buf.slice(),
    };
  }
  return visibleCache.lines;
}

export function clearView() {
  clearFloorSeq = nextSeq;
  useLogs.setState((s) => ({ version: s.version + 1 }));
}

/** Sidebar badge: errors+warns logged since the Logs screen was last viewed. */
export function unseenCount(s: LogsState): number {
  return Math.max(
    0,
    s.status.errors + s.status.warns - (s.baseline.errors + s.baseline.warns),
  );
}

export function markLogsViewed() {
  useLogs.setState((s) => ({
    baseline: { errors: s.status.errors, warns: s.status.warns },
  }));
}

/** The failure banner routes here before navigating, so the Logs screen
 *  opens pre-filtered (consumed once on mount). */
export function openLogsPrefiltered(t: LevelThreshold) {
  useLogs.setState({ prefilter: t });
}

export function takePrefilter(): LevelThreshold | null {
  const t = useLogs.getState().prefilter;
  if (t) useLogs.setState({ prefilter: null });
  return t;
}

let statusStarted = false;

/** Start the always-on badge feed. Called once at app startup; safe to call
 *  again (no-op). Fire-and-forget — outside Tauri everything no-ops. */
export function initLogStatus(): void {
  if (statusStarted) return;
  statusStarted = true;
  void (async () => {
    // Baseline starts at the launch totals so a fresh session opens quiet;
    // errors during startup still count (status arrives after hydrate).
    const t = await getLogStatus();
    useLogs.setState({ status: { seq: t.seq, errors: t.errors, warns: t.warns } });
    await onLogStatus((p) => {
      useLogs.setState({ status: p });
    });
  })();
}

/** Attach the Logs screen: hydrate the buffer, then stream new batches.
 *  Returns a detach fn (unlisten + stream off). All-or-nothing rollback à la
 *  streaming.ts `reg()`: a mount/unmount race can't leak a subscription. */
export async function attachLogStream(): Promise<() => void> {
  let cancelled = false;
  const unlisten = await onLogLines((p) => {
    if (!cancelled) append(p.lines);
  });
  // Stream first-gate AFTER the listener exists, then hydrate the gap —
  // set_log_stream(true) marks "emit from now", so hydration covers the past.
  await setLogStream(true);
  const tail = await getLogTail(nextSeq);
  if (!cancelled) {
    append(tail.lines);
    useLogs.setState({
      status: { seq: tail.seq, errors: tail.errors, warns: tail.warns },
    });
  }
  return () => {
    cancelled = true;
    unlisten();
    void setLogStream(false);
  };
}
