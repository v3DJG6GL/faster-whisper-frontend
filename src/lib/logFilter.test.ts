import { describe, expect, it } from "vitest";
import type { LogLine } from "./api";
import {
  BUG_REPORT_LINES,
  buildBugReport,
  collectTags,
  FOLD_RUN_CAP,
  foldDropped,
  foldLines,
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

describe("foldLines", () => {
  it("folds consecutive identical lines, keeping the latest occurrence and the run start", () => {
    const rows = foldLines([
      line({ seq: 1, ts: 100, tag: "focused-app", msg: "id=konsole" }),
      line({ seq: 2, ts: 200, tag: "focused-app", msg: "id=konsole" }),
      line({ seq: 3, ts: 300, tag: "focused-app", msg: "id=konsole" }),
      line({ seq: 4, ts: 400, tag: "focused-app", msg: "id=firefox" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ count: 3, firstTs: 100 });
    expect(rows[0].line.seq).toBe(3);
    expect(rows[1]).toMatchObject({ count: 1, firstTs: 400 });
  });

  it("does not fold across level, tag, or non-adjacent repeats", () => {
    const rows = foldLines([
      line({ seq: 1, msg: "m" }),
      line({ seq: 2, msg: "m", level: "warn" }),
      line({ seq: 3, msg: "m", tag: "keys" }),
      line({ seq: 4, msg: "other" }),
      line({ seq: 5, msg: "m" }),
    ]);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it("handles the empty list", () => {
    expect(foldLines([])).toEqual([]);
  });

  it("keeps the run's earlier occurrences, newest first, for the ×N expansion", () => {
    const rows = foldLines([
      line({ seq: 1, ts: 100, msg: "retry" }),
      line({ seq: 2, ts: 200, msg: "retry" }),
      line({ seq: 3, ts: 300, msg: "retry" }),
    ]);
    expect(rows[0].line.seq).toBe(3);
    expect(rows[0].earlier.map((l) => l.seq)).toEqual([2, 1]);
    expect(rows[0].firstSeq).toBe(1);
    expect(foldDropped(rows[0])).toBe(0);
  });

  it("caps a wedged run at FOLD_RUN_CAP, keeping the newest and counting the rest", () => {
    const many = Array.from({ length: FOLD_RUN_CAP + 20 }, (_, i) =>
      line({ seq: i + 1, ts: i * 10, msg: "poll" }),
    );
    const [r] = foldLines(many);
    expect(r.count).toBe(FOLD_RUN_CAP + 20);
    expect(r.earlier).toHaveLength(FOLD_RUN_CAP);
    // Newest kept: the occurrence just under the displayed one.
    expect(r.earlier[0].seq).toBe(FOLD_RUN_CAP + 19);
    expect(foldDropped(r)).toBe(19);
  });

  it("gives an unfolded row an empty run and its own seq as the run start", () => {
    const [r] = foldLines([line({ seq: 7, ts: 70 })]);
    expect(r).toMatchObject({ count: 1, firstSeq: 7, earlier: [] });
    expect(foldDropped(r)).toBe(0);
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
  it("copies only the lines handed in and names the active filters", () => {
    const shown = [line({ seq: 1, level: "warn", msg: "kept" })];
    const report = buildBugReport(
      {
        appVersion: "1",
        platform: "linux",
        backend: null,
        model: null,
        profile: null,
        filters: "warn+ · text: portal",
      },
      shown,
    );
    expect(report).toContain("—— last 1 lines —— filtered: warn+ · text: portal");
    expect(report).toContain("kept");
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

describe("bug report: what actually ran", () => {
  const L = [line({ msg: "m" })];

  it("names the route and stages so a translation bug is actionable", () => {
    // "The French came out wrong" is unactionable without the targets and
    // the fact that translation ran at all.
    const out = buildBugReport(
      {
        appVersion: "0.1.89",
        platform: "linux",
        source: "dictation",
        backend: "informethic",
        model: "large-v2",
        profile: "PTT DE",
        route: "de → en,fr",
        stages: "translate · insert:typed",
      },
      L,
    );
    expect(out).toContain("source: dictation");
    expect(out).toContain("route: de → en,fr");
    expect(out).toContain("stages: translate · insert:typed");
  });

  it("omits the provenance lines entirely when there is nothing to say", () => {
    // A fresh install with no history must not paste a line of empty labels.
    const out = buildBugReport(
      { appVersion: "0.1.89", platform: "linux", backend: null, model: null, profile: null },
      L,
    );
    expect(out).not.toContain("route:");
    expect(out).not.toContain("stages:");
    expect(out).not.toContain("source:");
    // ...and no blank line where the row would have been.
    expect(out).not.toMatch(/\n\n/);
  });
});
