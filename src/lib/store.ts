import { create } from "zustand";
import type {
  AppRule,
  AppSettings,
  Backend,
  Config,
  ConnectionInfo,
  DictationStatus,
  FocusedApp,
  Profile,
  ThemeName,
  UsageStats,
} from "./types";
import { newSpeakMemo, stepSpeaking } from "./speaking";

// Derives `speaking` (green vs amber) from the RMS level stream centrally, so the
// main-window surfaces (Home button, sidebar dot, waveforms) all agree with the chip
// without each re-running the smoothing. One singleton memo: the store is a singleton.
const speakMemo = newSpeakMemo();

/**
 * Frontend store. Holds seeded defaults in memory; the persistence layer wires
 * load/save through Tauri commands (config persisted as JSON in the app config
 * dir, API keys in the OS keyring). Keep mutations here so persistence can
 * subscribe in one place.
 *
 * A Backend is a server connection (URL + model + decode defaults). A Profile is
 * a dictation setup (activation + chord + a target Backend + optional overrides).
 */

const DEFAULT_BACKEND: Backend = {
  id: "default",
  name: "Local server",
  serverUrl: "http://localhost:8000",
  hasApiKey: false,
  model: "whisper-1",
  endpoint: "stream",
  language: "auto",
  prompt: "",
  responseFormat: "verbose_json",
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
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
    quickAddHotkey: [],
  },
  recording: {
    indicatorPosition: "top",
    saveRecordings: false,
    recordingsDir: null,
    trimSilence: true,
    muteSystemAudio: false,
    latchAutoStopMin: 5,
    realtimePreview: true,
    realtimePreviewOnHover: false,
    showProfileOnOverlay: true,
    showProfileOnHover: false,
    showStatsOnOverlay: false,
    overlayStatsOnHover: false,
    overlayStatsMetric: "words",
    showTargetOnOverlay: true,
    showTargetOnHover: false,
    showTargetOnlySpeaking: false,
    persistentDock: false,
    overlayPeek: false,
    peekTimeoutSec: 30,
    peekWhileActive: false,
    dimAfterSec: 10,
    hoverRevealMs: 1000,
    quickLaunch: [],
  },
};

// Seed ids match the legacy mode strings so migration is idempotent (see Rust load()).
const DEFAULT_PROFILES: Profile[] = [
  { id: "hold", name: "Push-to-talk", activation: "hold", enabled: true, hotkey: ["ControlLeft", "ShiftLeft"], backendId: "default" },
  { id: "handsfree", name: "Latch", activation: "latch", enabled: true, hotkey: ["ControlLeft", "KeyH"], backendId: "default" },
];

/** Deep-merge loaded settings over the defaults so a config written by an older version
 *  — or with fields omitted by the backend's skip-empty serialization (e.g. an empty
 *  `recording.quickLaunch`) — still gets every field. Without this, a missing field is
 *  `undefined` at runtime and crashes code that assumes the typed shape. */
function withSettingsDefaults(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    general: { ...DEFAULT_SETTINGS.general, ...(s.general ?? {}) },
    recording: { ...DEFAULT_SETTINGS.recording, ...(s.recording ?? {}) },
  };
}

/**
 * Normalize a loaded config to the v2 shape. The Rust `load()` already migrates,
 * but this guards the no-Rust `pnpm dev` path and any version skew during dev.
 */
function migrateConfig(raw: unknown): Config {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object") {
    return { settings: DEFAULT_SETTINGS, backends: [DEFAULT_BACKEND], profiles: DEFAULT_PROFILES };
  }
  // Already v2 (has `backends`).
  if (Array.isArray((c as { backends?: unknown }).backends)) {
    return {
      settings: withSettingsDefaults(c.settings),
      backends: (c.backends as Backend[]) ?? [DEFAULT_BACKEND],
      profiles: Array.isArray(c.profiles) ? (c.profiles as Profile[]) : [],
      appRules: Array.isArray((c as { appRules?: unknown }).appRules) ? (c.appRules as AppRule[]) : [],
      version: c.version as number | undefined,
    };
  }
  // Legacy v1: `profiles` were Backends; `modes` were ModeBindings.
  const backends = Array.isArray(c.profiles) ? (c.profiles as Backend[]) : [DEFAULT_BACKEND];
  const modes = Array.isArray((c as { modes?: unknown }).modes)
    ? ((c as { modes: Record<string, unknown>[] }).modes)
    : [];
  const profiles: Profile[] = modes.length
    ? modes.map((m) => {
        const isHold = m.mode === "hold";
        return {
          id: isHold ? "hold" : "handsfree",
          name: isHold ? "Push-to-talk" : "Latch",
          activation: isHold ? "hold" : "latch",
          enabled: !!m.enabled,
          hotkey: Array.isArray(m.hotkey) ? (m.hotkey as string[]) : [],
          backendId: (m.profileId as string | null) ?? null,
        };
      })
    : DEFAULT_PROFILES;
  return { settings: withSettingsDefaults(c.settings), backends, profiles, version: 2 };
}

interface AppState {
  settings: AppSettings;
  backends: Backend[];
  profiles: Profile[];
  appRules: AppRule[];

  // live dictation runtime (driven by Rust events)
  status: DictationStatus;
  /** Mic is opening but not yet delivering real audio (e.g. a Bluetooth headset
   *  switching into its mic profile takes ~1–2s). While true the chip shows
   *  "warming up…" and the start cue is held until real audio actually flows. */
  warming: boolean;
  level: number; // 0..1 audio RMS for the visualizer
  speaking: boolean; // derived from level (smoothed): actively speaking vs armed-silent
  partial: string; // live partial transcript for the chip preview
  activeProfile: string | null; // id of the Profile currently dictating
  dictationError: string | null;
  /** Decode overrides the server refused (admin-locked) for the active stream. */
  overridesIgnored: string[];
  /** The app the active session is injecting into — drives the chip's "→ app" readout. */
  targetApp: FocusedApp | null;
  /** Why injection into the target is skipped (coerced to clipboard): a per-app `block` rule, or
   *  the deep-detection guard finding the focused element isn't a text field. null = typing. */
  targetSkip: "blocked" | "notEditable" | null;
  /** One-shot signal that a phrase just landed — drives the chip's per-phrase pulse. `seq`
   *  bumps each time so identical consecutive kinds still retrigger the animation. */
  lastInsert: { kind: "typed" | "clipboard"; seq: number } | null;
  /** Truthful end-of-session insert result, set WITH the idle transition — drives the chip's
   *  done marker (✓ typed / clipboard glyph / nothing). null = no session finished yet. */
  sessionOutcome: "typed" | "clipboard" | "none" | null;

  connections: Record<string, ConnectionInfo | undefined>; // keyed by Backend id

  /** P28: per-Backend usage stats (GET /v1/usage), keyed by Backend id. A
   *  present-but-null value means "fetched and unsupported" (hide the stats
   *  surfaces); an absent key means "not fetched yet". Runtime-only — kept off
   *  the persisted Config. Fed by the usage controller (lib/usage.ts). */
  usage: Record<string, UsageStats | null>;

  /** P31: which Backend the usage VIEW (Home strip + Statistics page) shows. null =
   *  follow the dictation/home-target backend. Runtime-only (a view preference, not
   *  persisted). The chip readout ignores this — it always uses activeStatsBackend. */
  usageViewBackendId: string | null;

  setTheme: (t: ThemeName) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateGeneral: (patch: Partial<AppSettings["general"]>) => void;
  updateRecording: (patch: Partial<AppSettings["recording"]>) => void;

  upsertBackend: (b: Backend) => void;
  removeBackend: (id: string) => void;
  duplicateBackend: (id: string) => void;
  moveBackend: (id: string, dir: "up" | "down") => void;

  upsertProfile: (p: Profile) => void;
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  removeProfile: (id: string) => void;
  duplicateProfile: (id: string) => void;
  moveProfile: (id: string, dir: "up" | "down") => void;

  upsertAppRule: (r: AppRule) => void;
  removeAppRule: (id: string) => void;

  setConnection: (backendId: string, info: ConnectionInfo) => void;

  /** Store the latest usage stats for a Backend (null = fetched-but-unsupported). */
  setUsage: (backendId: string, stats: UsageStats | null) => void;

  /** Pick which Backend the usage view shows (null = follow the dictation target). */
  setUsageViewBackend: (id: string | null) => void;

  /** Update live dictation runtime (status / level / partial transcript). */
  setDictation: (
    patch: Partial<{
      status: DictationStatus;
      warming: boolean;
      level: number;
      partial: string;
      activeProfile: string | null;
      dictationError: string | null;
      overridesIgnored: string[];
      targetApp: FocusedApp | null;
      targetSkip: "blocked" | "notEditable" | null;
      lastInsert: { kind: "typed" | "clipboard"; seq: number } | null;
      sessionOutcome: "typed" | "clipboard" | "none" | null;
    }>,
  ) => void;

  /** Replace settings/backends/profiles from the persisted config (on startup). */
  hydrate: (cfg: Config) => void;
}

// Replace-or-append by id — the shared body of the upsert* reducers (backends/profiles/appRules).
function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  const next = [...arr];
  if (i >= 0) next[i] = item;
  else next.push(item);
  return next;
}

export const useApp = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  backends: [DEFAULT_BACKEND],
  profiles: DEFAULT_PROFILES,
  appRules: [],

  status: "idle",
  warming: false,
  level: 0,
  speaking: false,
  partial: "",
  activeProfile: null,
  dictationError: null,
  overridesIgnored: [],
  targetApp: null,
  targetSkip: null,
  lastInsert: null,
  sessionOutcome: null,

  connections: {},
  usage: {},
  usageViewBackendId: null,

  setTheme: (t) => {
    document.documentElement.dataset.theme = t;
    set((s) => ({ settings: { ...s.settings, theme: t } }));
  },
  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  updateGeneral: (patch) =>
    set((s) => ({ settings: { ...s.settings, general: { ...s.settings.general, ...patch } } })),
  updateRecording: (patch) =>
    set((s) => ({ settings: { ...s.settings, recording: { ...s.settings.recording, ...patch } } })),

  upsertBackend: (b) => set((s) => ({ backends: upsertById(s.backends, b) })),
  removeBackend: (id) =>
    set((s) => ({
      backends: s.backends.filter((b) => b.id !== id),
      profiles: s.profiles.map((p) => (p.backendId === id ? { ...p, backendId: null } : p)),
    })),
  duplicateBackend: (id) =>
    set((s) => {
      const i = s.backends.findIndex((b) => b.id === id);
      if (i < 0) return {};
      const src = s.backends[i];
      // The API key lives in the OS keyring under the source id, not in this object,
      // so it can't be carried to the new id — mark it absent so the editor prompts
      // for a fresh one.
      const copy: Backend = { ...src, id: crypto.randomUUID(), name: `${src.name} copy`, hasApiKey: false };
      const backends = [...s.backends];
      backends.splice(i + 1, 0, copy);
      return { backends };
    }),
  moveBackend: (id, dir) =>
    set((s) => {
      const i = s.backends.findIndex((b) => b.id === id);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= s.backends.length) return {};
      const backends = [...s.backends];
      [backends[i], backends[j]] = [backends[j], backends[i]];
      return { backends };
    }),

  upsertProfile: (p) => set((s) => ({ profiles: upsertById(s.profiles, p) })),
  updateProfile: (id, patch) =>
    set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  removeProfile: (id) => set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),
  duplicateProfile: (id) =>
    set((s) => {
      const i = s.profiles.findIndex((p) => p.id === id);
      if (i < 0) return {};
      const src = s.profiles[i];
      // Clear the chord on the copy — a duplicate must never inherit the same one.
      const copy: Profile = { ...src, id: crypto.randomUUID(), name: `${src.name} copy`, hotkey: [] };
      const profiles = [...s.profiles];
      profiles.splice(i + 1, 0, copy);
      return { profiles };
    }),
  moveProfile: (id, dir) =>
    set((s) => {
      const i = s.profiles.findIndex((p) => p.id === id);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= s.profiles.length) return {};
      const profiles = [...s.profiles];
      [profiles[i], profiles[j]] = [profiles[j], profiles[i]];
      return { profiles };
    }),

  upsertAppRule: (r) => set((s) => ({ appRules: upsertById(s.appRules, r) })),
  removeAppRule: (id) => set((s) => ({ appRules: s.appRules.filter((r) => r.id !== id) })),

  setConnection: (backendId, info) =>
    set((s) => ({ connections: { ...s.connections, [backendId]: info } })),

  setUsage: (backendId, stats) =>
    set((s) => ({ usage: { ...s.usage, [backendId]: stats } })),

  setUsageViewBackend: (id) => set({ usageViewBackendId: id }),

  setDictation: (patch) =>
    set((s) => {
      // Keep the shared `speaking` flag current whenever level/status moves. Computing
      // it here (not per-component) means subscribers re-render only on a transition,
      // not on every RMS tick — important for the tiny always-mounted sidebar dot.
      if (!("level" in patch) && !("status" in patch)) return patch;
      const status = patch.status ?? s.status;
      const level = patch.level ?? s.level;
      const speaking = stepSpeaking(speakMemo, level, status === "listening", performance.now());
      return speaking === s.speaking ? patch : { ...patch, speaking };
    }),

  hydrate: (cfg) => {
    const c = migrateConfig(cfg);
    set({ settings: c.settings, backends: c.backends, profiles: c.profiles, appRules: c.appRules ?? [] });
  },
}));
