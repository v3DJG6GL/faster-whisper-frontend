// Pure default values for settings + sync, extracted from store.ts as pure
// data: any module can read a default without pulling in the store. Imports
// only types and the (equally pure) settings manifest.

import type { AppSettings, SyncSettings } from "./types";
import { DEFAULT_SETTING_SYNC } from "./settingsManifest";

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
  // Derived from the manifest (the single source); `recordingsDir` is the
  // legacy alias of `audioFolder`. A hand-written literal here outranks the
  // manifest once persisted (a saved boolean reads as an explicit choice).
  sub: { ...DEFAULT_SETTING_SYNC, recordingsDir: DEFAULT_SETTING_SYNC.audioFolder },
  urlOverrides: {},
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "auto", // follow the OS scheme until the user picks a side (Sidebar toggle)
  accentHue: 65, // the stock amber; theme.ts stamps no overrides for this value
  accentMotion: { period: 0, range: "wheel" }, // Still: the Signal colour stays where it was set
  microphoneId: null,
  homeProfileId: null,
  quickAddList: null,
  general: {
    openAtLogin: false,
    startMinimized: false,
    insertTiming: "live",
    // Matches the old insertTiming default, so a fresh install behaves as it always did.
    typeAsISpeak: true,
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
    handsFreeAutoStopMin: 30,
    // App id only (never the window title); the Statistics page's "Typed into" facet.
    reportTargetApp: true,
    realtimePreview: true,
    realtimePreviewOnHover: false,
    showProfileOnOverlay: true,
    showProfileOnHover: false,
    // A route is a promise about what will be typed, so it defaults to always-visible.
    showRouteOnOverlay: true,
    showRouteOnHover: false,
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
