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
}

export const BUG_REPORT_LINES = 500;

/** The paste-ready support bundle: context header + the last 500 RAW lines
 *  (ignores the active view filters — the helper always gets the full picture). */
export function buildBugReport(hdr: BugReportHeader, raw: readonly LogLine[]): string {
  const tail = raw.slice(-BUG_REPORT_LINES);
  const ctx = [
    `faster-whisper-frontend v${hdr.appVersion} · ${hdr.platform}`,
    [
      hdr.backend ? `backend: ${hdr.backend}` : null,
      hdr.model ? `model: ${hdr.model}` : null,
      hdr.profile ? `profile: ${hdr.profile}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    `—— last ${tail.length} lines ——`,
  ]
    .filter((s) => s !== "")
    .join("\n");
  return `${ctx}\n${tail.map(formatLine).join("\n")}\n`;
}
