import { describe, expect, it } from "vitest";
import type { LogLine } from "./api";
import {
  BUG_REPORT_LINES,
  buildBugReport,
  collectTags,
  followReduce,
  formatLine,
  matchesFilters,
  passesThreshold,
  type FollowState,
} from "./logFilter";

function line(over: Partial<LogLine> = {}): LogLine {
  return {
    seq: 0,
    ts: 0,
    level: "info",
    target: "t",
    tag: null,
    msg: "hello",
    ...over,
  };
}

describe("passesThreshold", () => {
  it("applies and-above semantics per threshold", () => {
    expect(passesThreshold("trace", "all")).toBe(true);
    expect(passesThreshold("debug", "all")).toBe(true);
    expect(passesThreshold("debug", "info")).toBe(false);
    expect(passesThreshold("info", "info")).toBe(true);
    expect(passesThreshold("info", "warn")).toBe(false);
    expect(passesThreshold("warn", "warn")).toBe(true);
    expect(passesThreshold("warn", "error")).toBe(false);
    expect(passesThreshold("error", "error")).toBe(true);
    expect(passesThreshold("error", "all")).toBe(true);
  });
});

describe("matchesFilters", () => {
  const l = line({ level: "warn", tag: "pipeline", msg: "Connect Failed" });
  it("combines threshold, tag set, and case-insensitive text", () => {
    expect(matchesFilters(l, "warn", new Set(), "")).toBe(true);
    expect(matchesFilters(l, "error", new Set(), "")).toBe(false);
    expect(matchesFilters(l, "all", new Set(["pipeline"]), "")).toBe(true);
    expect(matchesFilters(l, "all", new Set(["audio"]), "")).toBe(false);
    expect(matchesFilters(l, "all", new Set(), "connect fail")).toBe(true);
    expect(matchesFilters(l, "all", new Set(), "PIPELINE")).toBe(true); // tag searchable
    expect(matchesFilters(l, "all", new Set(), "nope")).toBe(false);
  });
  it("an active tag set excludes untagged lines", () => {
    expect(matchesFilters(line({ tag: null }), "all", new Set(["pipeline"]), "")).toBe(false);
  });
});

describe("collectTags", () => {
  it("dedupes in first-seen order and caps", () => {
    const lines = [
      line({ tag: "audio" }),
      line({ tag: "pipeline" }),
      line({ tag: "audio" }),
      line({ tag: null }),
      line({ tag: "stream" }),
    ];
    expect(collectTags(lines)).toEqual(["audio", "pipeline", "stream"]);
    expect(collectTags(lines, 2)).toEqual(["audio", "pipeline"]);
  });
});

describe("followReduce", () => {
  const following: FollowState = { follow: true, pendingNew: 0 };
  it("appends are silent while following, counted while unlatched", () => {
    expect(followReduce(following, { kind: "appended", count: 5 })).toEqual(following);
    const paused = followReduce(following, { kind: "scrolled", atBottom: false });
    expect(paused.follow).toBe(false);
    const pending = followReduce(paused, { kind: "appended", count: 3 });
    expect(pending.pendingNew).toBe(3);
    expect(followReduce(pending, { kind: "appended", count: 2 }).pendingNew).toBe(5);
  });
  it("returning to the bottom or the pill re-latches and clears", () => {
    const pending: FollowState = { follow: false, pendingNew: 7 };
    expect(followReduce(pending, { kind: "scrolled", atBottom: true })).toEqual(following);
    expect(followReduce(pending, { kind: "relatch" })).toEqual(following);
  });
});

describe("formatLine / buildBugReport", () => {
  it("strips control characters from messages", () => {
    const out = formatLine(line({ msg: "bad\u001b[31mansi\u0007bell" }));
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).toContain("ansi");
  });
  it("includes level, tag, and message", () => {
    const out = formatLine(line({ level: "warn", tag: "pipeline", msg: "x" }));
    expect(out).toContain("WARN");
    expect(out).toContain("[pipeline]");
    expect(out).toContain("x");
  });
  it("caps the report at the last N raw lines and carries the header", () => {
    const raw = Array.from({ length: BUG_REPORT_LINES + 50 }, (_, i) =>
      line({ seq: i, msg: `m${i}` }),
    );
    const report = buildBugReport(
      { appVersion: "0.1.78", platform: "linux", backend: "local", model: "large-v3", profile: "Interviews" },
      raw,
    );
    expect(report).toContain("faster-whisper-frontend v0.1.78 · linux");
    expect(report).toContain("backend: local · model: large-v3 · profile: Interviews");
    expect(report).toContain(`—— last ${BUG_REPORT_LINES} lines ——`);
    expect(report).not.toContain("m49\n"); // dropped: older than the cap
    expect(report).toContain(`m${BUG_REPORT_LINES + 49}`); // newest kept
    // header count matches actual body lines
    const body = report.split("——")[2].trim().split("\n");
    expect(body.length).toBe(BUG_REPORT_LINES);
  });
  it("omits absent context fields", () => {
    const report = buildBugReport(
      { appVersion: "1", platform: "linux", backend: null, model: null, profile: null },
      [line()],
    );
    expect(report).not.toContain("backend:");
    expect(report).toContain("—— last 1 lines ——");
  });
});
