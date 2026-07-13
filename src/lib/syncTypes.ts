// Wire/file shapes for settings export/import + server sync. The SAME
// category shapes travel in the server blob and in an export file's
// `categories`, so one extract/apply path serves both features.

import type {
  AppRule,
  Backend,
  InsertMethod,
  InsertTiming,
  Profile,
  QuickAddTarget,
  RecordingSettings,
  ThemeName,
} from "./types";

/** The `general` category: settings.theme + the portable general fields.
 *  Machine-local fields (evdevEnabled) are excluded by construction — this
 *  type simply doesn't have them. */
export interface SyncGeneral {
  theme: ThemeName;
  startMinimized: boolean;
  /** Optional: absent in blobs/exports written before it became syncable
   *  (2026-07-13) — apply's spread then keeps the device's local value. */
  openAtLogin?: boolean;
  insertTiming: InsertTiming;
  insertMethod: InsertMethod;
  pasteShortcut: string[];
  autoEnter: boolean;
  restoreClipboard: boolean;
  soundEffects: boolean;
  deepFieldDetection: boolean;
  quickAddHotkey: string[];
}

/** The `recording` category: everything on RecordingSettings except the
 *  machine-local recordingsDir. */
export type SyncRecording = Omit<RecordingSettings, "recordingsDir">;

/** The `backends` category. `secrets` ({backendId: apiKey}) is present in the
 *  server blob always (user decision — it's their own server) and in an export
 *  file only when "Include API keys" was checked. quickAddList rides with its
 *  referent (a backend id + a server-side rule slug). */
export interface SyncBackends {
  list: Backend[];
  quickAddList: QuickAddTarget | null;
  secrets?: Record<string, string>;
}

/** The `profiles` category. homeProfileId rides with its referent. */
export interface SyncProfiles {
  list: Profile[];
  homeProfileId: string | null;
}

/** The `appRules` category, bucketed per-OS: appIds are AT-SPI names on Linux
 *  vs exe basenames on Windows, so each device only ever applies (and
 *  replaces) its own bucket and passes the other through untouched. */
export interface SyncAppRules {
  linux: AppRule[];
  windows: AppRule[];
}

/** The synced document: one optional entry per category. Also the `categories`
 *  payload of an export file. An absent category means "nothing stored" (never
 *  "delete") — apply skips it, compose preserves whatever the server had. */
export interface SyncBlob {
  general?: SyncGeneral;
  recording?: SyncRecording;
  backends?: SyncBackends;
  profiles?: SyncProfiles;
  appRules?: SyncAppRules;
}

/** The export-file envelope (single pretty-printed JSON file). */
export interface ExportEnvelope {
  formatVersion: 1;
  configVersion: 2;
  appVersion: string;
  createdAt: string; // ISO 8601
  hostname: string;
  platform: string; // "linux" | "windows" | "macos"
  categories: SyncBlob;
}

/** Rust `import_settings_file` result: the parsed + validated envelope with
 *  secrets split out and human-readable warnings for the preview UI. */
export interface ImportResult {
  formatVersion: number;
  configVersion: number;
  appVersion: string;
  hostname: string;
  platform: string;
  createdAt: string;
  categories: SyncBlob;
  secrets: Record<string, string>;
  hasSecrets: boolean;
  warnings: string[];
}

/** Local bookkeeping persisted in `<config dir>/sync-state.json` (Rust-opaque).
 *  `snapshot` is the last-synced blob = the 3-way merge base; `version` is the
 *  server version it corresponds to; `hash` lets pushes short-circuit when
 *  nothing sync-relevant changed. */
export interface SyncState {
  deviceId?: string;
  /** Which sync server the version/hash/snapshot bookkeeping belongs to.
   *  Sync state is per-server: reusing server A's version as a CAS base (or
   *  its snapshot as a merge base) against server B corrupts the first
   *  exchange after a sync-server switch, so the engine resets on mismatch. */
  serverBackendId?: string | null;
  version?: number;
  updatedAt?: number | null;
  device?: string | null; // last writer's label as reported by the server
  hash?: string;
  snapshot?: SyncBlob;
}

/** Mirror of Rust transport::sync::SyncRemoteState. */
export interface SyncRemoteState {
  version: number;
  blob: SyncBlob | null;
  updated_at?: number | null;
  device?: string | null;
}

/** Mirror of Rust transport::sync::SyncPull. status 0 = unreachable,
 *  404 = backend build predates sync, 401 = key problem. */
export interface SyncPullResult {
  ok: boolean;
  status: number;
  state?: SyncRemoteState;
  error?: string;
}

/** Mirror of Rust transport::sync::SyncPush. A 409 sets `conflict` to the
 *  CURRENT server state (the retry loop's merge input). */
export interface SyncPushResult {
  ok: boolean;
  status: number;
  state?: SyncRemoteState;
  conflict?: SyncRemoteState;
  error?: string;
}

/** Mirror of Rust transport::sync::SyncDelete. */
export interface SyncDeleteResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** Rust `sync_device_info` result. */
export interface SyncDeviceInfo {
  deviceId: string;
  hostname: string;
  platform: string;
}
