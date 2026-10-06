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
  it("counts a single log backup in the singular", () => {
    const one: ServerInfo = { keeps: { server_log: { max_bytes: 10_000_000, backup_count: 1 } } };
    expect(keepRows(one, true).find((r) => r.env === "LOG_BACKUP_COUNT")?.value).toBe("1 file · ~20.0 MB");
  });
  it("says whether the per-app rollup applies to you", () => {
    const you = (report: boolean) => keepRows(info, report).find((r) => r.env === "USAGE_APP_RETENTION_DAYS");
    expect(you(true)?.you).toMatch(/^Applies to you/);
    expect(you(true)?.tone).toBe("warn");
    expect(you(false)?.you).toMatch(/^Not sent/);
    expect(you(false)?.tone).toBe("ok");
  });
  it("a retention of 0 reads as never auto-deleted, not as 0 days", () => {
    const zero: ServerInfo = {
      keeps: {
        captures: { enabled: true, retention_days: 0 },
        recent_transcriptions: { retention_days: 0, max: 500 },
        usage_app_retention_days: 0,
      },
    };
    const value = (env: string) => keepRows(zero, true).find((r) => r.env === env)?.value;
    expect(value("CAPTURES_RETENTION_DAYS")).toBe("0 · forever");
    // The row cap still trims it, so only the age limit is gone.
    expect(value("RECENT_TRANSCRIPTIONS_RETENTION_DAYS")).toBe("0 · no age limit");
    expect(value("USAGE_APP_RETENTION_DAYS")).toBe("0 · forever");
    expect(keepRows(info, true).find((r) => r.env === "CAPTURES_RETENTION_DAYS")?.value).toBe("365 days");
  });
  it("a sample rate never rounds to 0% or 100%", () => {
    const rate = (sample_fraction: number) =>
      keepRows({ keeps: { captures: { enabled: true, sample_fraction } } }, true).find(
        (r) => r.env === "CAPTURES_RECORDING_SAMPLE_RATE",
      )?.value;
    expect(rate(0.001)).toBe("0.001 · <1% of requests");
    expect(rate(0.999)).toBe("0.999 · >99% of requests");
    expect(rate(0.25)).toBe("0.25 · 25% of requests");
    expect(rate(0)).toBe("0 · 0% of requests");
  });
  it("captures off: the dot is calm", () => {
    const off = { keeps: { captures: { enabled: false, retention_days: 365 } } };
    expect(capturesOn(off)).toBe(false);
    expect(keepRows(off, true).map((r) => r.tone)).toEqual(["ok", "none"]);
  });
  it("shows the capture caps, the per-job rows and the link media window", () => {
    const more: ServerInfo = {
      keeps: {
        captures: { enabled: true, max: 5000, max_mb: 5000 },
        usage_retention_days: 0,
        usage_jobs_retention_days: 365,
        url_media_ttl_s: 3600,
      },
    };
    const row = (i: ServerInfo, env: string) => keepRows(i, true).find((r) => r.env === env);
    expect(row(more, "CAPTURES_MAX")).toEqual({ env: "CAPTURES_MAX", value: "5000", tone: "warn" });
    expect(row(more, "CAPTURES_MAX_MB")).toEqual({ env: "CAPTURES_MAX_MB", value: "5000 · ~5.24 GB", tone: "warn" });
    expect(row(more, "USAGE_JOBS_RETENTION_DAYS")).toEqual({ env: "USAGE_JOBS_RETENTION_DAYS", value: "365 days", tone: "warn" });
    expect(row(more, "URL_MEDIA_TTL_S")).toEqual({ env: "URL_MEDIA_TTL_S", value: "3600 · 1h", tone: "warn" });
    // Order: the caps follow the capture rows, the per-job rows follow the hourly rollup.
    expect(keepRows(more, true).map((r) => r.env)).toEqual([
      "CAPTURES_RECORDING_ENABLED",
      "CAPTURES_MAX",
      "CAPTURES_MAX_MB",
      "USAGE_RETENTION_DAYS",
      "USAGE_JOBS_RETENTION_DAYS",
      "URL_MEDIA_TTL_S",
    ]);
    const off: ServerInfo = { keeps: { captures: { enabled: false, max: 0, max_mb: 0 }, usage_jobs_retention_days: 0 } };
    expect(row(off, "CAPTURES_MAX")).toEqual({ env: "CAPTURES_MAX", value: "0 · unbounded", tone: "none" });
    expect(row(off, "CAPTURES_MAX_MB")?.value).toBe("0 · unbounded");
    expect(row(off, "USAGE_JOBS_RETENTION_DAYS")).toEqual({ env: "USAGE_JOBS_RETENTION_DAYS", value: "0 · forever", tone: "none" });
  });
});
