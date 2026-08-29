// Pure default values for settings + sync, extracted from store.ts so the
// settings manifest can consume them without an import cycle (the manifest
// needs defaults for changed-detection/reset; the store needs the manifest
// for derived sync defaults). Imports ONLY types — keep it that way.

import type { AppSettings, SyncSettings } from "./types";

/** Sync starts off with every category opted in — flipping "Enable sync" is
 *  the single gate; the toggles then subtract. Machine-local by contract
 *  (never travels in a blob/export), so defaults only matter per-device. */
export const DEFAULT_SYNC: SyncSettings = {
  enabled: false,
  backendId: null,
  categories: {
    general: true,
    recording: true,
    chip: true,
    backends: true,
    profiles: true,
    dictionary: true,
    appRules: true,
    transcription: true,
    fileTranscriptions: true,
    logging: true,
  },
  // Every default preserves the pre-sub-toggle behavior exactly: the folder
  // was never synced, chords always were; the Transcribe picks never were.
  sub: { recordingsDir: false, profileHotkeys: true, quickAddHotkey: true, transcribePicks: false },
  urlOverrides: {},
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "auto", // follow the OS scheme until the user picks a side (Sidebar toggle)
  microphoneId: null,
  homeProfileId: null,
  quickAddList: null,
  general: {
    openAtLogin: false,
    startMinimized: false,
    insertTiming: "live",
    insertMethod: "paste",
    pasteShortcut: ["ControlLeft", "KeyV"],
    autoEnter: false,
    restoreClipboard: true,
    soundEffects: true,
    evdevEnabled: false,
    deepFieldDetection: false,
    // Super+Alt (user-set 2026-07-13; mirrors Rust default_quick_add_hotkey) —
    // inert until a quick-add list is designated (apply_bindings skips it), so
    // the default is harmless out of the box.
    quickAddHotkey: ["AltLeft", "MetaLeft"],
  },
  recording: {
    indicatorPosition: "top",
    saveRecordings: true,
    recordingsDir: null,
    audioBaseDir: null,
    trimSilence: true,
    recordingsRetentionDays: 0,
    muteSystemAudio: true,
    latchAutoStopMin: 30,
    realtimePreview: true,
    realtimePreviewOnHover: false,
    showProfileOnOverlay: true,
    showProfileOnHover: false,
    showStatsOnOverlay: true,
    overlayStatsOnHover: false,
    overlayStatsMetric: "both",
    showTargetOnOverlay: true,
    showTargetOnHover: false,
    showTargetOnlySpeaking: false,
    persistentDock: true,
    overlayPeek: true,
    peekTimeoutSec: 5,
    peekWhileActive: false,
    dimAfterSec: 2.5,
    hoverRevealMs: 500,
    quickLaunch: [],
  },
  sync: DEFAULT_SYNC,
  logging: { logLevel: "info", keepDays: 30, showInSidebar: true, logDir: null },
  setupDismissed: false,
};
