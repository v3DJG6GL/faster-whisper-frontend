// Pure logic for the Logs screen — filtering, follow/scroll-lock, and the
// bug-report bundle. No store or Tauri imports so it unit-tests under node.

import type { LogLine } from "./api";
import { stripControlChars } from "./sanitize";

/** Threshold semantics: "info" = Info and above, "all" includes trace/debug. */
export type LevelThreshold = "all" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLine["level"], number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const THRESHOLD_RANK: Record<LevelThreshold, number> = {
  all: 0,
  info: 2,
  warn: 3,
  error: 4,
};

export function passesThreshold(level: LogLine["level"], t: LevelThreshold): boolean {
  return LEVEL_RANK[level] >= THRESHOLD_RANK[t];
}

/** Combined row filter: threshold AND tag set (empty set = all tags) AND
 *  case-insensitive substring over tag + message. */
export function matchesFilters(
  l: LogLine,
  t: LevelThreshold,
  tags: ReadonlySet<string>,
  text: string,
): boolean {
  if (!passesThreshold(l.level, t)) return false;
  if (tags.size > 0 && (!l.tag || !tags.has(l.tag))) return false;
  const q = text.trim().toLowerCase();
  if (q) {
    const hay = `${l.tag ?? ""} ${l.msg}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Distinct subsystem tags in first-seen order, for the filter chips. */
export function collectTags(lines: readonly LogLine[], max = 32): string[] {
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.tag && !seen.has(l.tag)) {
      seen.add(l.tag);
      if (seen.size >= max) break;
    }
  }
  return [...seen];
}

/** How many of a run's earlier occurrences a folded row keeps for expansion.
 *  A wedged poll loop can repeat thousands of times; holding every one would
 *  put the whole buffer behind a single row. The newest are kept — the oldest
 *  is already named by `firstTs`. */
export const FOLD_RUN_CAP = 50;

/** One display row after "Merge repeats": `line` is the LATEST occurrence
 *  (its ts/seq render), `count` the run length, `firstTs`/`firstSeq` when the
 *  run began. `earlier` holds the run's other occurrences, newest first and
 *  capped, so the row can expand to show WHEN each one landed — the burst rate
 *  is the thing folding otherwise destroys. */
export interface FoldedLine {
  line: LogLine;
  count: number;
  firstTs: number;
  /** Seq of the run's FIRST occurrence. Stable while the run grows (`line.seq`
   *  is not), so the view can key an expanded row by it. */
  firstSeq: number;
  earlier: LogLine[];
}

/** Occurrences in the run that `earlier` had to drop (0 when it holds them all). */
export function foldDropped(r: FoldedLine): number {
  return Math.max(0, r.count - 1 - r.earlier.length);
}

/** Fold runs of CONSECUTIVE identical lines (level + tag + message; the
 *  timestamp is what varies in a poll loop) into single rows. */
export function foldLines(lines: readonly LogLine[]): FoldedLine[] {
  const out: FoldedLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.line.level === l.level && prev.line.tag === l.tag && prev.line.msg === l.msg) {
      // The occurrence being displaced is the newest of the earlier ones.
      prev.earlier.unshift(prev.line);
      if (prev.earlier.length > FOLD_RUN_CAP) prev.earlier.pop();
      prev.line = l;
      prev.count += 1;
    } else {
      out.push({ line: l, count: 1, firstTs: l.ts, firstSeq: l.seq, earlier: [] });
    }
  }
  return out;
}

/** Follow / scroll-lock state machine: following auto-scrolls on new lines;
 *  any upward scroll pauses following and counts pending lines for the
 *  "N new lines ↓" pill; returning to the bottom (or the pill) re-latches. */
export interface FollowState {
  follow: boolean;
  pendingNew: number;
}

export type FollowEvent =
  | { kind: "appended"; count: number }
  | { kind: "scrolled"; atBottom: boolean }
  | { kind: "relatch" };

export function followReduce(state: FollowState, ev: FollowEvent): FollowState {
  switch (ev.kind) {
    case "appended":
      return state.follow ? state : { ...state, pendingNew: state.pendingNew + ev.count };
    case "scrolled":
      return ev.atBottom ? { follow: true, pendingNew: 0 } : { ...state, follow: false };
    case "relatch":
      return { follow: true, pendingNew: 0 };
  }
}

/** "14:02:31.104 WARN  [pipeline] message" — local time; message defanged
 *  (pipeline warns can carry server-authored bodies with control bytes). */
export function formatLine(l: LogLine): string {
  const d = new Date(l.ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const level = l.level.toUpperCase().padEnd(5);
  const tag = l.tag ? `[${l.tag}] ` : "";
  return `${ts} ${level} ${tag}${stripControlChars(l.msg)}`;
}

export interface BugReportHeader {
  appVersion: string;
  platform: string;
  backend: string | null;
  model: string | null;
  profile: string | null;
  /** What the reported run actually DID.
   *
   *  The header used to name only a backend and a model, and it read them
   *  from the Transcribe screen's settings — so a dictation bug report named
   *  a model that never ran. These come from the last session instead, and
   *  they name the stages, because "the French came out wrong" is
   *  unactionable without the targets and the translation model. */
  route?: string | null;
  stages?: string | null;
  source?: string | null;
  /** Human-readable description of the view filters the copied lines passed
   *  ("warn+ · tag: overlay · text: portal"); omitted when nothing is
   *  filtered. Recorded in the header so a reader knows the paste is a
   *  SUBSET, not the whole session. */
  filters?: string | null;
}

export const BUG_REPORT_LINES = 500;

/** The paste-ready support bundle: context header + the last 500 lines the
 *  caller passes in — the Logs screen hands over exactly what the view shows,
 *  so what you filtered to is what you paste. */
export function buildBugReport(hdr: BugReportHeader, raw: readonly LogLine[]): string {
  const tail = raw.slice(-BUG_REPORT_LINES);
  const ctx = [
    `faster-whisper-frontend v${hdr.appVersion} · ${hdr.platform}`,
    [
      hdr.source ? `source: ${hdr.source}` : null,
      hdr.backend ? `backend: ${hdr.backend}` : null,
      hdr.model ? `model: ${hdr.model}` : null,
      hdr.profile ? `profile: ${hdr.profile}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    [
      hdr.route ? `route: ${hdr.route}` : null,
      hdr.stages ? `stages: ${hdr.stages}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    `—— last ${tail.length} lines ——${hdr.filters ? ` filtered: ${hdr.filters}` : ""}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
  return `${ctx}\n${tail.map(formatLine).join("\n")}\n`;
}
