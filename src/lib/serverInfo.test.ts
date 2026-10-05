import { describe, expect, it } from "vitest";
import { capturesOn, keepRows, limitRows } from "./serverInfo";
import type { ServerInfo } from "./types";

const info: ServerInfo = {
  limits: { translation_max_targets: 8, url_max_duration_s: 14400, url_allowed_extractors: [], url_allow_direct_media: true },
  keeps: {
    captures: { enabled: true, retention_days: 365, sample_fraction: 1, max: 1000 },
    server_log: { max_bytes: 10_000_000, backup_count: 10 },
    recent_transcriptions: { retention_days: 30, max: 500 },
    usage_app_retention_days: 90,
    usage_retention_days: 0,
  },
};

describe("limitRows", () => {
  it("names each limit with its value", () => {
    expect(limitRows(info)).toEqual([
      { env: "URL_MAX_DURATION_S", value: "14400 · 4h" },
      { env: "URL_ALLOWED_EXTRACTORS", value: "all dedicated" },
      { env: "URL_ALLOW_DIRECT_MEDIA", value: "on" },
      { env: "TRANSLATION_MAX_TARGETS", value: "8" },
    ]);
  });
  it("has no row for a leaf the server did not send", () => {
    expect(limitRows({ limits: { translation_max_targets: 3 } }).map((r) => r.env)).toEqual(["TRANSLATION_MAX_TARGETS"]);
    expect(limitRows(undefined)).toEqual([]);
  });
});

describe("keepRows", () => {
  it("marks captures red while they are on", () => {
    expect(capturesOn(info)).toBe(true);
    const rows = keepRows(info, true);
    expect(rows[0]).toEqual({ env: "CAPTURES_RECORDING_ENABLED", value: "on", tone: "bad" });
    expect(rows.find((r) => r.env === "CAPTURES_RECORDING_SAMPLE_RATE")?.value).toBe("1.0 · every request");
    expect(rows.find((r) => r.env === "LOG_BACKUP_COUNT")?.value).toBe("10 files · ~110.0 MB");
    expect(rows.find((r) => r.env === "USAGE_RETENTION_DAYS")?.value).toBe("0 · forever");
  });
  it("says whether the per-app rollup applies to you", () => {
    const you = (report: boolean) => keepRows(info, report).find((r) => r.env === "USAGE_APP_RETENTION_DAYS");
    expect(you(true)?.you).toMatch(/^Applies to you/);
    expect(you(true)?.tone).toBe("warn");
    expect(you(false)?.you).toMatch(/^Not sent/);
    expect(you(false)?.tone).toBe("ok");
  });
  it("captures off: the dot is calm", () => {
    const off = { keeps: { captures: { enabled: false, retention_days: 365 } } };
    expect(capturesOn(off)).toBe(false);
    expect(keepRows(off, true).map((r) => r.tone)).toEqual(["ok", "none"]);
  });
});
