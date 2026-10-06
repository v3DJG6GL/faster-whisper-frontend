// The Backends ⓘ panel as data: what this server limits and what it keeps (GET /v1/me
// `server_info`), one row per backend setting, titled by its ENV name. Show-only — the app never
// acts on these; it only says what the server does. A leaf the server did not send has no row.

import type { ServerInfo } from "./types";
import { fmtBytes, fmtDuration } from "./format";

/** The row's dot: `bad` = audio leaves your control (captures on), `warn` = kept for a while,
 *  `ok` = not kept / not sent, `none` = forever or not applicable. */
export type KeepTone = "bad" | "warn" | "ok" | "none";

export interface InfoRow {
  env: string;
  value: string;
  tone?: KeepTone;
  /** How the row applies to you (USAGE_APP_RETENTION_DAYS and the "Report the app" switch). */
  you?: string;
}

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);
/** A retention in days where the server reads 0 as "never auto-delete". */
const keepDays = (n: number) => (n === 0 ? "0 · forever" : days(n));

/** The "Limits" rows. */
export function limitRows(info: ServerInfo | undefined): InfoRow[] {
  const l = info?.limits;
  if (!l) return [];
  const rows: InfoRow[] = [];
  if (l.url_max_duration_s !== undefined)
    rows.push({ env: "URL_MAX_DURATION_S", value: `${l.url_max_duration_s} · ${fmtDuration(l.url_max_duration_s)}` });
  if (l.url_allowed_extractors !== undefined)
    rows.push({
      env: "URL_ALLOWED_EXTRACTORS",
      value: l.url_allowed_extractors.length ? l.url_allowed_extractors.join(", ") : "all dedicated",
    });
  if (l.url_allow_direct_media !== undefined)
    rows.push({ env: "URL_ALLOW_DIRECT_MEDIA", value: l.url_allow_direct_media ? "on" : "off" });
  if (l.translation_max_targets !== undefined)
    rows.push({ env: "TRANSLATION_MAX_TARGETS", value: String(l.translation_max_targets) });
  return rows;
}

/** Whether the server records audio + words of transcriptions (the ⓘ button's red dot). */
export function capturesOn(info: ServerInfo | undefined): boolean {
  return info?.keeps?.captures?.enabled === true;
}

/** The "What this server keeps" rows. `reportApp` = the "Report the app I dictate into" switch. */
export function keepRows(info: ServerInfo | undefined, reportApp: boolean): InfoRow[] {
  const k = info?.keeps;
  if (!k) return [];
  const rows: InfoRow[] = [];
  const on = capturesOn(info);
  const c = k.captures;
  if (c?.enabled !== undefined) rows.push({ env: "CAPTURES_RECORDING_ENABLED", value: on ? "on" : "off", tone: on ? "bad" : "ok" });
  if (c?.retention_days !== undefined)
    rows.push({ env: "CAPTURES_RETENTION_DAYS", value: keepDays(c.retention_days), tone: on ? "bad" : "none" });
  if (c?.sample_fraction !== undefined)
    rows.push({
      env: "CAPTURES_RECORDING_SAMPLE_RATE",
      value:
        c.sample_fraction >= 1
          ? `${c.sample_fraction.toFixed(1)} · every request`
          : `${c.sample_fraction} · ${Math.round(c.sample_fraction * 100)}% of requests`,
      tone: on ? "warn" : "none",
    });
  const log = k.server_log;
  if (log?.max_bytes !== undefined) rows.push({ env: "LOG_MAX_BYTES", value: fmtBytes(log.max_bytes), tone: "warn" });
  if (log?.backup_count !== undefined)
    rows.push({
      env: "LOG_BACKUP_COUNT",
      value:
        log.max_bytes !== undefined
          ? `${log.backup_count} files · ~${fmtBytes(log.max_bytes * (log.backup_count + 1))}`
          : `${log.backup_count} files`,
      tone: "warn",
    });
  const rt = k.recent_transcriptions;
  if (rt?.retention_days !== undefined)
    rows.push({ env: "RECENT_TRANSCRIPTIONS_RETENTION_DAYS", value: rt.retention_days === 0 ? "0 · no age limit" : days(rt.retention_days), tone: "warn" });
  if (rt?.max !== undefined)
    rows.push({ env: "RECENT_TRANSCRIPTIONS_MAX", value: rt.max === 0 ? "0 · unbounded" : String(rt.max), tone: "warn" });
  if (k.usage_app_retention_days !== undefined)
    rows.push({
      env: "USAGE_APP_RETENTION_DAYS",
      value: keepDays(k.usage_app_retention_days),
      tone: reportApp ? "warn" : "ok",
      you: reportApp
        ? "Applies to you: “Report the app I dictate into” is on in Settings."
        : "Not sent: “Report the app I dictate into” is off in Settings.",
    });
  if (k.usage_retention_days !== undefined)
    rows.push({
      env: "USAGE_RETENTION_DAYS",
      value: keepDays(k.usage_retention_days),
      tone: k.usage_retention_days === 0 ? "none" : "warn",
    });
  return rows;
}
