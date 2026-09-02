// The settings manifest: ONE declarative registry of every user setting —
// its Settings-tab label, its place in the settings tree (group / section /
// parent nesting), which store fields it owns, which sync category its
// fields ride in, and whether it is machine-specific (sync default OFF).
//
// Both the Settings screens AND the Sync tab's "What this device syncs" list
// draw from this table, which is what guarantees the two can never disagree
// on names or nesting. Declaring a setting here IS its sync registration:
// new settings appear in the Sync list automatically (on by default,
// `machineSpecific: true` flips them off).
//
// Forgetting an entry is a compile error, not a convention: the coverage
// maps at the bottom are `satisfies`-checked against the store slices' full
// key sets — add a field to GeneralSettings/RecordingSettings/… without
// deciding its sync story and `tsc` fails.
//
// Pure data + pure helpers only. Imports types only — never defaults, the
// store, api, or sync engine (unit-tests under plain node; defaults.ts
// imports THIS file for the sync sub-defaults).

import type {
  AppSettings,
  GeneralSettings,
  LoggingSettings,
  RecordingSettings,
  SyncCategory,
  TranscribeSettings,
} from "./types";

/* ── Types ─────────────────────────────────────────────────────────────── */

/** A store field a setting owns, discriminated by store slice. */
export type FieldRef =
  | { slice: "general"; key: keyof GeneralSettings }
  | { slice: "recording"; key: keyof RecordingSettings }
  | { slice: "transcribe"; key: keyof TranscribeSettings }
  | { slice: "logging"; key: keyof LoggingSettings }
  | { slice: "settings"; key: "theme" | "accentHue" | "accentMotion" | "homeProfileId" | "quickAddList" };

/** The Sync tab's group cards, in display order. */
export const SYNC_GROUPS = [
  "general",
  "appearance",
  "dictation",
  "recordingHistory",
  "transcribeDefaults",
  "chip",
  "backends",
  "profiles",
  "dictionary",
  "appRules",
  "logging",
] as const;
export type SyncGroup = (typeof SYNC_GROUPS)[number];

export const SYNC_GROUP_LABEL: Record<SyncGroup, string> = {
  general: "General",
  appearance: "Appearance",
  dictation: "Dictation",
  recordingHistory: "Recording & history",
  transcribeDefaults: "Transcribe defaults",
  chip: "Chip",
  backends: "Backends",
  profiles: "Profiles",
  dictionary: "Dictionary",
  appRules: "App rules",
  logging: "Logging",
};

/** List-category behaviors: switches that gate a bespoke compose/apply arm
 *  (element-wise substitution etc.) instead of plain field copying. */
export type CustomArm =
  | "backendList"
  | "backendUrls"
  | "backendKeys"
  | "backendDefaults"
  | "profileList"
  | "profileHotkeys"
  | "profileEnabled"
  | "homeProfile"
  | "quickAddPin"
  | "appRulesOs"
  | "appRuleOverrides"
  | "appPasteShortcuts"
  | "profileInsertion";

/** The wire category a setting's data rides in. */
export type WireCategory = SyncCategory;

export interface SettingDef {
  /** Stable sync key (SyncSubSettings entry) — never rename once shipped. */
  id: string;
  /** EXACT Settings-row title (or the screen's control label) — the Sync row
   *  shows the same string, by construction. */
  label: string;
  /** Sync-row description; the Settings screens keep their own desc copy. */
  desc?: string;
  group: SyncGroup;
  /** Section eyebrow inside the group card — the settings tab's own section
   *  label where one exists. */
  section?: string;
  /** id of the row this one indents under (mirrors the Settings tree; the
   *  indent is presentation, NOT a sync dependency). */
  parent?: string;
  category: WireCategory;
  /** The store fields this one switch governs (one UI row can own several —
   *  e.g. a visible/hover pair rendered as one control). Empty for `custom`. */
  fields: readonly FieldRef[];
  /** Machine-specific (paths, chords, display geometry): sync default OFF. */
  machineSpecific?: true;
  /** Rendered in Settings for its label, but NEVER synced: the apply arm drops the field
   *  on every inbound path (the `autoEnter` strip — a peer must not arm a post-paste
   *  Return), so a sync switch would advertise a choice the user does not have. No sync
   *  row, no gate, no wire field. */
  localOnly?: true;
  /** List-category arm this switch gates instead of field copying. */
  custom?: CustomArm;
}

/* ── The registry (display order) ──────────────────────────────────────── */

const g = (key: keyof GeneralSettings): FieldRef => ({ slice: "general", key });
const r = (key: keyof RecordingSettings): FieldRef => ({ slice: "recording", key });
const t = (key: keyof TranscribeSettings): FieldRef => ({ slice: "transcribe", key });
const lg = (key: keyof LoggingSettings): FieldRef => ({ slice: "logging", key });

export const MANIFEST = [
  // ── General ──────────────────────────────────────────────────────────
  { id: "theme", label: "Theme", group: "appearance", category: "general",
    fields: [{ slice: "settings", key: "theme" }] },
  { id: "accentHue", label: "Signal colour", group: "appearance", category: "general",
    desc: "The preset or the Custom hue — one value, so both travel together.",
    fields: [{ slice: "settings", key: "accentHue" }] },
  { id: "accentMotion", label: "Motion", group: "appearance", category: "general",
    desc: "Speed, Range and the two colours of a breath — one value, so they travel together.",
    fields: [{ slice: "settings", key: "accentMotion" }] },
  { id: "openAtLogin", label: "Launch at login", group: "general", category: "general",
    fields: [g("openAtLogin")] },
  { id: "startMinimized", label: "Start minimized to tray", group: "general", category: "general",
    fields: [g("startMinimized")] },
  { id: "typeAsISpeak", section: "Insertion", label: "Type as I speak",
    group: "dictation", category: "general",
    desc: "Default for new and inheriting profiles.",
    fields: [g("typeAsISpeak")] },
  { id: "insertMethod", section: "Insertion", label: "Insertion method", group: "dictation", category: "general",
    fields: [g("insertMethod")] },
  { id: "pasteShortcut", section: "Insertion", label: "Paste shortcut", group: "dictation", category: "general",
    desc: "A keyboard chord; terminals differ per machine.",
    machineSpecific: true, fields: [g("pasteShortcut")] },
  { id: "deepFieldDetection", section: "Insertion", label: "Deep field detection", group: "dictation", category: "general",
    fields: [g("deepFieldDetection")] },
  { id: "pressEnterAfter", section: "Insertion", label: "Press Enter after", group: "dictation", category: "general",
    localOnly: true, fields: [] },
  { id: "restoreClipboard", section: "Insertion", label: "Restore clipboard afterward", group: "dictation", category: "general",
    fields: [g("restoreClipboard")] },
  { id: "soundCues", label: "Sound cues", group: "general", category: "general",
    fields: [g("soundEffects")] },

  // ── Recording & history (sections mirror the tab) ────────────────────
  { id: "keepDictationHistory", label: "Save dictations to History",
    group: "recordingHistory", section: "Dictations", category: "recording",
    fields: [t("keepDictationHistory")] },
  { id: "keepDictationAudio", label: "Keep dictation audio",
    group: "recordingHistory", section: "Dictations", category: "recording",
    fields: [r("saveRecordings")] },
  { id: "trimSilence", label: "Trim silence from saved audio", parent: "keepDictationAudio",
    group: "recordingHistory", section: "Dictations", category: "recording",
    fields: [r("trimSilence")] },
  { id: "dictationRetention", label: "Delete dictations after",
    group: "recordingHistory", section: "Dictations", category: "recording",
    desc: "One clock for text and audio together.",
    fields: [r("recordingsRetentionDays"), t("dictationRetentionDays")] },
  { id: "reportTargetApp", label: "Report the app I dictate into",
    group: "recordingHistory", section: "Dictations", category: "recording",
    desc: "The program name only, for Statistics.",
    fields: [r("reportTargetApp")] },
  { id: "keepAudioCopies", label: "Keep audio from files",
    group: "recordingHistory", section: "Transcriptions", category: "fileTranscriptions",
    fields: [t("keepAudioCopies")] },
  { id: "keepUrlAudioCopies", label: "Keep audio from links",
    group: "recordingHistory", section: "Transcriptions", category: "fileTranscriptions",
    fields: [t("keepUrlAudioCopies")] },
  { id: "transcriptionRetention", label: "Delete transcriptions after",
    group: "recordingHistory", section: "Transcriptions", category: "fileTranscriptions",
    fields: [t("historyRetentionDays")] },
  { id: "audioFolder", label: "Audio folder",
    group: "recordingHistory", section: "Audio storage", category: "recording",
    desc: "One folder for everything recorded or copied (dictations, files, links). A machine-specific path.",
    machineSpecific: true, fields: [r("audioBaseDir"), r("recordingsDir")] },
  { id: "muteSystemAudio", label: "Silence other apps",
    group: "dictation", section: "While recording", category: "recording",
    fields: [r("muteSystemAudio")] },
  { id: "handsFreeAutoStop", label: "Auto-stop hands-free after silence",
    group: "dictation", section: "While recording", category: "recording",
    fields: [r("handsFreeAutoStopMin")] },

  // ── Transcribe defaults (controls live on the Transcribe screen) ─────
  { id: "diarize", label: "Speaker diarization", group: "transcribeDefaults", category: "transcription",
    fields: [t("diarize")] },
  { id: "speakers", label: "Speakers", parent: "diarize",
    group: "transcribeDefaults", category: "transcription",
    desc: "Auto / Count / Range and the counts.",
    fields: [t("speakerMode"), t("numSpeakers"), t("minSpeakers"), t("maxSpeakers")] },
  { id: "translate", label: "Translate to English", group: "transcribeDefaults", category: "transcription",
    fields: [t("translate")] },
  { id: "translateTo", label: "Translation", group: "transcribeDefaults", category: "transcription",
    desc: "T2T target languages, the model pick and the mode.",
    fields: [t("translateTo"), t("translationModel"), t("translationMode")] },
  { id: "separateBgm", label: "Music source separation (MSS)", group: "transcribeDefaults", category: "transcription",
    fields: [t("separateBgm")] },
  { id: "showTimestamps", label: "Timestamps", group: "transcribeDefaults", category: "transcription",
    fields: [t("showTimestamps")] },
  { id: "showSpeakerNames", label: "Speaker names", group: "transcribeDefaults", category: "transcription",
    fields: [t("showSpeakerNames")] },
  { id: "colorizeSpeakers", label: "Colors", group: "transcribeDefaults", category: "transcription",
    fields: [t("colorizeSpeakers")] },
  { id: "wordTimestamps", label: "Word timestamps", group: "transcribeDefaults", category: "transcription",
    fields: [t("wordTimestamps")] },
  { id: "exportFormat", label: "Export format", group: "transcribeDefaults", category: "transcription",
    fields: [t("exportFormat")] },
  { id: "transcribePicks", label: "Last-used server, model & language",
    group: "transcribeDefaults", category: "transcription",
    desc: "What the Transcribe screen last used, not a setting you chose.",
    machineSpecific: true,
    fields: [t("backendId"), t("model"), t("language")] },

  // ── Chip (labels mirror the Chip tab) ────────────────────────────────
  { id: "chipPosition", label: "Position", group: "chip", category: "chip",
    desc: "Depends on this machine's displays.",
    machineSpecific: true, fields: [r("indicatorPosition")] },
  { id: "keepChipDocked", label: "Keep chip docked", group: "chip", category: "chip",
    desc: "Depends on this machine's displays.",
    machineSpecific: true, fields: [r("persistentDock")] },
  { id: "autoHideToEdge", label: "Auto-hide to edge", group: "chip", category: "chip",
    fields: [r("overlayPeek")] },
  { id: "hideAfter", label: "Hide after", parent: "autoHideToEdge", group: "chip", category: "chip",
    fields: [r("peekTimeoutSec")] },
  { id: "stayHiddenWhileDictating", label: "Stay hidden while dictating", parent: "autoHideToEdge",
    group: "chip", category: "chip", fields: [r("peekWhileActive")] },
  { id: "dimAfter", label: "Dim after", group: "chip", category: "chip",
    fields: [r("dimAfterSec")] },
  { id: "liveTranscript", label: "Live transcript", group: "chip", category: "chip",
    fields: [r("realtimePreview"), r("realtimePreviewOnHover")] },
  { id: "showActiveProfile", label: "Show active profile", group: "chip", category: "chip",
    fields: [r("showProfileOnOverlay"), r("showProfileOnHover")] },
  { id: "showTranslationRoute", label: "Show translation route", group: "chip", category: "chip",
    fields: [r("showRouteOnOverlay"), r("showRouteOnHover")] },
  { id: "showUsageOnChip", label: "Show usage on chip", group: "chip", category: "chip",
    fields: [r("showStatsOnOverlay"), r("overlayStatsOnHover")] },
  { id: "chipMetric", label: "Chip metric", parent: "showUsageOnChip", group: "chip", category: "chip",
    fields: [r("overlayStatsMetric")] },
  { id: "showInjectionTarget", label: "Show injection target", group: "chip", category: "chip",
    fields: [r("showTargetOnOverlay"), r("showTargetOnHover")] },
  { id: "onlyWhileSpeaking", label: "Only while speaking", parent: "showInjectionTarget",
    group: "chip", category: "chip", fields: [r("showTargetOnlySpeaking")] },
  { id: "hoverRevealDelay", label: "Hover reveal delay", group: "chip", category: "chip",
    fields: [r("hoverRevealMs")] },
  { id: "quickLaunchButtons", label: "Quick-launch buttons", group: "chip", category: "chip",
    fields: [r("quickLaunch")] },

  // ── Backends (a LIST — switches gate custom arms, not field copies) ──
  { id: "backendList", label: "Server list", group: "backends", category: "backends",
    desc: "Names, endpoints, kinds — the servers themselves.",
    custom: "backendList", fields: [] },
  { id: "serverAddresses", label: "Server addresses", group: "backends", category: "backends",
    desc: "URLs often differ per network; per-device overrides always win locally. Needs Server list on.",
    machineSpecific: true, custom: "backendUrls", fields: [] },
  { id: "apiKeys", label: "API keys", group: "backends", category: "backends",
    desc: "Stored on your own server; mirrors the export dialog's “Include API keys”. Needs Server list on.",
    custom: "backendKeys", fields: [] },
  { id: "modelDecodeDefaults", label: "Model & decode defaults", group: "backends", category: "backends",
    desc: "Model, language, prompt, response format, decode overrides. Needs Server list on.",
    custom: "backendDefaults", fields: [] },

  // ── Profiles ─────────────────────────────────────────────────────────
  { id: "profileList", label: "Profile list & settings", group: "profiles", category: "profiles",
    desc: "Name, backend, activation, chip tag, decode options.",
    custom: "profileList", fields: [] },
  { id: "profileHotkeys", label: "Profile shortcuts", group: "profiles", category: "profiles",
    desc: "Off = each machine keeps its own chords. Needs Profile list & settings on.",
    custom: "profileHotkeys", fields: [] },
  { id: "enabledPerProfile", label: "Enabled per profile", group: "profiles", category: "profiles",
    desc: "Off = each machine picks which profiles are active. Needs Profile list & settings on.",
    custom: "profileEnabled", fields: [] },
  { id: "profileInsertion", label: "Profile insertion overrides", group: "profiles", category: "profiles",
    desc: "Type-as-you-speak, and per-profile method / chord / clipboard restore. Needs Profile list & settings on.",
    custom: "profileInsertion", fields: [] },
  { id: "homeProfile", label: "Home profile", group: "profiles", category: "profiles",
    desc: "Which profile the Home button targets. Needs Profile list & settings on.",
    custom: "homeProfile", fields: [{ slice: "settings", key: "homeProfileId" }] },

  // ── Dictionary ───────────────────────────────────────────────────────
  { id: "quickAddHotkey", label: "Quick-add shortcut", group: "dictionary", category: "dictionary",
    desc: "Off = each machine keeps its own chord.",
    fields: [g("quickAddHotkey")] },
  { id: "pinnedMappings", label: "Pinned word mappings", group: "dictionary", category: "dictionary",
    desc: "Needs Backends → Server list on — the pin points at a server.",
    custom: "quickAddPin", fields: [{ slice: "settings", key: "quickAddList" }] },

  // ── App rules ────────────────────────────────────────────────────────
  { id: "rulesThisOs", label: "Rules for this OS", group: "appRules", category: "appRules",
    desc: "Blocklist and per-app behavior; other-OS rules pass through untouched.",
    custom: "appRulesOs", fields: [] },
  { id: "perAppOverrides", label: "Per-app insertion overrides", group: "appRules", category: "appRules",
    desc: "Insertion method and clipboard restore, per app. Needs Rules for this OS on.",
    custom: "appRuleOverrides", fields: [] },
  { id: "perAppPasteShortcuts", label: "Per-app paste shortcuts", group: "appRules", category: "appRules",
    desc: "Chords, like the global paste shortcut. Needs Rules for this OS on.",
    machineSpecific: true, custom: "appPasteShortcuts", fields: [] },

  // ── Logging ──────────────────────────────────────────────────────────
  { id: "logLevel", label: "Log level", group: "logging", category: "logging",
    desc: "Off = each machine keeps its own verbosity.",
    fields: [lg("logLevel")] },
  { id: "logRetention", label: "Keep log files", group: "logging", category: "logging",
    fields: [lg("keepDays")] },
  { id: "logsInSidebar", label: "Show Logs in the sidebar", group: "logging", category: "logging",
    fields: [lg("showInSidebar")] },
  { id: "logFolder", label: "Log folder", group: "logging", category: "logging",
    desc: "A machine-specific path, like Audio folder.",
    machineSpecific: true, fields: [lg("logDir")] },
] as const satisfies readonly SettingDef[];

export type SettingId = (typeof MANIFEST)[number]["id"];

/** The manifest widened to the interface type — the literal tuple keeps its
 *  narrow per-entry types (good for `SettingId`), but derived helpers want
 *  the uniform shape (optional props present on every entry). */
const DEFS: readonly SettingDef[] = MANIFEST;

export const SETTING = Object.fromEntries(DEFS.map((d) => [d.id, d])) as unknown as Record<
  SettingId,
  SettingDef
>;

/* ── Coverage maps: the exhaustiveness guarantee ───────────────────────── */

/** Sentinel for fields that are deliberately machine-local and never sync. */
export const LOCAL = Symbol("machine-local");
type Covered = SettingId | typeof LOCAL;

/** Every GeneralSettings field → the setting that owns it (or LOCAL).
 *  Adding a field to the interface without deciding here fails tsc. */
export const GENERAL_COVERAGE = {
  openAtLogin: "openAtLogin",
  startMinimized: "startMinimized",
  // Retired onto `typeAsISpeak` at load (`migrateInsertTiming`); no UI row, so no sync
  // switch. It still rides the general category as a conservative value for rollbacks.
  insertTiming: LOCAL,
  typeAsISpeak: "typeAsISpeak",
  insertMethod: "insertMethod",
  pasteShortcut: "pasteShortcut",
  autoEnter: LOCAL, // never accepted from a peer — see the general apply strip in sync.ts
  restoreClipboard: "restoreClipboard",
  soundEffects: "soundCues",
  evdevEnabled: LOCAL, // Permissions-tab hardware opt-in, per machine
  deepFieldDetection: "deepFieldDetection",
  quickAddHotkey: "quickAddHotkey",
} as const satisfies Record<keyof GeneralSettings, Covered>;

export const RECORDING_COVERAGE = {
  indicatorPosition: "chipPosition",
  saveRecordings: "keepDictationAudio",
  recordingsDir: "audioFolder",
  audioBaseDir: "audioFolder",
  trimSilence: "trimSilence",
  recordingsRetentionDays: "dictationRetention",
  muteSystemAudio: "muteSystemAudio",
  handsFreeAutoStopMin: "handsFreeAutoStop",
  reportTargetApp: "reportTargetApp",
  realtimePreview: "liveTranscript",
  realtimePreviewOnHover: "liveTranscript",
  showProfileOnOverlay: "showActiveProfile",
  showProfileOnHover: "showActiveProfile",
  showRouteOnOverlay: "showTranslationRoute",
  showRouteOnHover: "showTranslationRoute",
  showStatsOnOverlay: "showUsageOnChip",
  overlayStatsOnHover: "showUsageOnChip",
  overlayStatsMetric: "chipMetric",
  showTargetOnOverlay: "showInjectionTarget",
  showTargetOnHover: "showInjectionTarget",
  showTargetOnlySpeaking: "onlyWhileSpeaking",
  persistentDock: "keepChipDocked",
  overlayPeek: "autoHideToEdge",
  peekTimeoutSec: "hideAfter",
  peekWhileActive: "stayHiddenWhileDictating",
  dimAfterSec: "dimAfter",
  hoverRevealMs: "hoverRevealDelay",
  quickLaunch: "quickLaunchButtons",
} as const satisfies Record<keyof RecordingSettings, Covered>;

export const TRANSCRIBE_COVERAGE = {
  backendId: "transcribePicks",
  model: "transcribePicks",
  language: "transcribePicks",
  diarize: "diarize",
  speakerMode: "speakers",
  numSpeakers: "speakers",
  minSpeakers: "speakers",
  maxSpeakers: "speakers",
  translate: "translate",
  translateTo: "translateTo",
  translationModel: "translateTo",
  translationMode: "translateTo",
  viewTracks: LOCAL, // viewer track visibility — view state, like layout
  separateBgm: "separateBgm",
  exportFormat: "exportFormat",
  speakerColorMode: LOCAL, // legacy, superseded by the display toggles
  wordTimestamps: "wordTimestamps",
  layout: LOCAL, // window-width-dependent screen arrangement
  showTimestamps: "showTimestamps",
  showSpeakerNames: "showSpeakerNames",
  colorizeSpeakers: "colorizeSpeakers",
  historyRetentionDays: "transcriptionRetention",
  keepDictationHistory: "keepDictationHistory",
  dictationRetentionDays: "dictationRetention",
  keepAudioCopies: "keepAudioCopies",
  keepUrlAudioCopies: "keepUrlAudioCopies",
} as const satisfies Record<keyof TranscribeSettings, Covered>;

export const LOGGING_COVERAGE = {
  logLevel: "logLevel",
  keepDays: "logRetention",
  showInSidebar: "logsInSidebar",
  logDir: "logFolder",
} as const satisfies Record<keyof LoggingSettings, Covered>;

/** Top-level AppSettings leaves (the object slices have their own maps). */
export const TOP_COVERAGE = {
  theme: "theme",
  accentHue: "accentHue",
  accentMotion: "accentMotion",
  microphoneId: LOCAL, // a device id — meaningless on another machine
  homeProfileId: "homeProfile",
  quickAddList: "pinnedMappings",
  setupDismissed: LOCAL, // first-run gate bookkeeping
  recentTranslationTargets: LOCAL, // picker MRU — a convenience, not a setting
} as const satisfies Record<
  Exclude<keyof AppSettings, "general" | "recording" | "transcribe" | "sync" | "logging">,
  Covered
>;

/* ── Derived data ──────────────────────────────────────────────────────── */

/** Sync default per setting: on unless machine-specific. THE single source —
 *  replaces the old duplicated sub-default literals. */
export const DEFAULT_SETTING_SYNC = Object.fromEntries(
  DEFS.map((d) => [d.id, !d.machineSpecific && !d.localOnly]),
) as Record<SettingId, boolean>;

export function settingsOfGroup(group: SyncGroup): SettingDef[] {
  return DEFS.filter((d) => d.group === group && !d.localOnly);
}

export function settingsOfCategory(cat: WireCategory): SettingDef[] {
  return DEFS.filter((d) => d.category === cat && !d.localOnly);
}

/* ── Value access (changed-detection / reset) ──────────────────────────── */

/** Complete a persisted (possibly older-version) gate set to one boolean per
 *  manifest entry. Precedence, lowest to highest:
 *  1. manifest defaults (on unless machine-specific);
 *  2. the old coarse per-CATEGORY toggles — a category the user had OFF
 *     seeds every member OFF, so nothing silently starts syncing after the
 *     upgrade to per-setting gates;
 *  3. legacy sub-toggle keys mapped onto their new ids (recordingsDir →
 *     audioFolder, latchAutoStop → handsFreeAutoStop; the others kept their
 *     names);
 *  4. explicitly saved per-setting values. */
export function completeGates(
  saved?: Partial<Record<string, boolean>>,
  savedCategories?: Partial<Record<SyncCategory, boolean>>,
): Record<SettingId, boolean> {
  const gates = { ...DEFAULT_SETTING_SYNC };
  if (savedCategories) {
    for (const [cat, on] of Object.entries(savedCategories)) {
      if (on === false) {
        for (const d of settingsOfCategory(cat as WireCategory)) gates[d.id as SettingId] = false;
      }
    }
  }
  if (saved) {
    if (typeof saved.recordingsDir === "boolean") gates.audioFolder = saved.recordingsDir;
    // `latchAutoStop` is the pre-rename id of `handsFreeAutoStop`. Without this remap a
    // user who had deliberately switched that row's sync OFF would have it silently come
    // back ON at the next launch, because the saved key no longer matches any manifest id.
    if (typeof saved.latchAutoStop === "boolean") gates.handsFreeAutoStop = saved.latchAutoStop;
    for (const d of DEFS) {
      const v = saved[d.id];
      if (typeof v === "boolean") gates[d.id as SettingId] = v;
    }
  }
  return gates;
}

