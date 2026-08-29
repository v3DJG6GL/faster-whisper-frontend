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
  TranscribeSettings,
} from "./types";

/** The `general` category: settings.theme + the portable general fields.
 *  Machine-local fields (evdevEnabled) are excluded by construction — this
 *  type simply doesn't have them. The quick-add chord lived here before the
 *  `dictionary` category existed; `migrateBlob` moves it on every inbound
 *  path, so post-migration blobs never carry it here. */
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
}

/** The fields of RecordingSettings that belong to the `chip` category — the
 *  overlay chip's look and behaviour, split out of the old catch-all
 *  "Recording & Chip" group so save-recordings/retention (consent-grade) and
 *  chip styling toggle independently. The single classification list the
 *  compose partition, the apply filters, and `migrateBlob` all share. */
export const CHIP_FIELDS = [
  "indicatorPosition",
  "persistentDock",
  "overlayPeek",
  "peekTimeoutSec",
  "peekWhileActive",
  "dimAfterSec",
  "hoverRevealMs",
  "quickLaunch",
  "realtimePreview",
  "realtimePreviewOnHover",
  "showProfileOnOverlay",
  "showProfileOnHover",
  "showStatsOnOverlay",
  "overlayStatsOnHover",
  "overlayStatsMetric",
  "showTargetOnOverlay",
  "showTargetOnHover",
  "showTargetOnlySpeaking",
] as const satisfies readonly (keyof RecordingSettings)[];

export type ChipField = (typeof CHIP_FIELDS)[number];

/** The `chip` category: the chip subset of RecordingSettings. */
export type SyncChip = Pick<RecordingSettings, ChipField>;

/** The `recording` category: RecordingSettings minus the chip fields.
 *  `recordingsDir` is a machine-specific path: present only when the writing
 *  device's "Recordings folder" sub-toggle is on (default off), else passed
 *  through from the snapshot so an opted-out device never erases it. */
export type SyncRecording = Partial<Pick<RecordingSettings, "recordingsDir" | "audioBaseDir">> &
  Omit<RecordingSettings, ChipField | "recordingsDir" | "audioBaseDir"> &
  Partial<Pick<TranscribeSettings, (typeof DICTATION_HISTORY_FIELDS)[number]>>;

/** The `backends` category. `secrets` ({backendId: apiKey}) is present in the
 *  server blob always (user decision — it's their own server) and in an export
 *  file only when "Include API keys" was checked. The quick-add pin lived here
 *  before the `dictionary` category existed (migrateBlob moves it). */
export interface SyncBackends {
  list: Backend[];
  secrets?: Record<string, string>;
}

/** The `profiles` category. homeProfileId rides with its referent. The wire
 *  shape is unchanged by the "Profile shortcuts" sub-toggle: chords stay
 *  INSIDE the elements — an opted-out device substitutes the snapshot's chord
 *  per profile on compose and re-pins its local chord per profile on apply. */
export interface SyncProfiles {
  list: Profile[];
  homeProfileId: string | null;
}

/** The `dictionary` category: the two LOCAL-config pointers of the quick-add
 *  feature. (The word list itself is live server state per account — it needs
 *  no sync category at all.) `quickAddHotkey` is absent when no device has
 *  ever synced it (the sub-toggle passthrough keeps it absent rather than
 *  erasing a peer's chord). */
export interface SyncDictionary {
  quickAddHotkey?: string[];
  quickAddList?: QuickAddTarget | null;
}

/** The `appRules` category, bucketed per-OS: appIds are AT-SPI names on Linux
 *  vs exe basenames on Windows, so each device only ever applies (and
 *  replaces) its own bucket and passes the other through untouched. */
export interface SyncAppRules {
  linux: AppRule[];
  windows: AppRule[];
}

/** The `transcription` category: the Transcribe SCREEN's option defaults
 *  only. History/retention flags live with their subject instead — the
 *  dictation clock rides the `recording` category, the file-transcription
 *  clock the `fileTranscriptions` category — so the Sync page can mirror the
 *  Recording & history tab's groups with independent toggles. The last-used
 *  backendId/model/language picks travel only when the "Last-used backend &
 *  model" sub-toggle opts in (TRANSCRIPTION_PICK_FIELDS), else pass through
 *  from the snapshot so an opted-out device never erases them.
 *  speakerColorMode is legacy (superseded by the display toggles), local. */
export const TRANSCRIPTION_FIELDS = [
  "diarize",
  "speakerMode",
  "numSpeakers",
  "minSpeakers",
  "maxSpeakers",
  "translate",
  "separateBgm",
  "exportFormat",
  "wordTimestamps",
  "showTimestamps",
  "showSpeakerNames",
  "colorizeSpeakers",
] as const satisfies readonly (keyof TranscribeSettings)[];

/** Dictation-history flags: stored in settings.transcribe but SYNCED inside
 *  the `recording` category, because they govern the same sessions the
 *  recording toggles do (the tab's "Dictation" group). */
export const DICTATION_HISTORY_FIELDS = [
  "keepDictationHistory",
  "dictationRetentionDays",
] as const satisfies readonly (keyof TranscribeSettings)[];

/** The `fileTranscriptions` category (the tab's "File transcriptions" group):
 *  history retention + audio copies. */
export const FILE_TRANSCRIPTION_FIELDS = [
  "historyRetentionDays",
  "keepAudioCopies",
  "keepUrlAudioCopies",
] as const satisfies readonly (keyof TranscribeSettings)[];

export type SyncFileTranscriptions = Partial<
  Pick<TranscribeSettings, (typeof FILE_TRANSCRIPTION_FIELDS)[number]>
>;

/** The per-machine-by-default Transcribe picks behind the sub-toggle. */
export const TRANSCRIPTION_PICK_FIELDS = [
  "backendId",
  "model",
  "language",
] as const satisfies readonly (keyof TranscribeSettings)[];

export type SyncTranscription = Partial<
  Pick<
    TranscribeSettings,
    | (typeof TRANSCRIPTION_FIELDS)[number]
    | (typeof TRANSCRIPTION_PICK_FIELDS)[number]
  >
>;

/** The synced document: one optional entry per category. Also the `categories`
 *  payload of an export file. An absent category means "nothing stored" (never
 *  "delete") — apply skips it, compose preserves whatever the server had. */
export interface SyncBlob {
  general?: SyncGeneral;
  recording?: SyncRecording;
  chip?: SyncChip;
  backends?: SyncBackends;
  profiles?: SyncProfiles;
  dictionary?: SyncDictionary;
  appRules?: SyncAppRules;
  transcription?: SyncTranscription;
  fileTranscriptions?: SyncFileTranscriptions;
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
  /** Backend ids whose API keys belong to `snapshot`. The VALUES live in the OS keyring, not
   *  here — this file sits beside config.json and used to hold them in cleartext. Absent when
   *  the snapshot carries no keys. */
  snapshotSecretIds?: string[];
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
