import { create } from "zustand";
import type {
  AppSettings,
  Backend,
  Config,
  ConnectionInfo,
  DictationStatus,
  Profile,
  ThemeName,
} from "./types";

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
  general: {
    openAtLogin: false,
    startMinimized: false,
    insertTiming: "live",
    insertMethod: "paste",
    autoEnter: false,
    restoreClipboard: true,
    soundEffects: true,
    evdevEnabled: false,
  },
  recording: {
    indicatorPosition: "top",
    saveRecordings: false,
    muteSystemAudio: false,
    realtimePreview: true,
    showProfileOnOverlay: true,
    persistentDock: false,
    overlayPeek: false,
    peekTimeoutSec: 30,
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

  // live dictation runtime (driven by Rust events)
  status: DictationStatus;
  level: number; // 0..1 audio RMS for the visualizer
  partial: string; // live partial transcript for the chip preview
  activeProfile: string | null; // id of the Profile currently dictating
  dictationError: string | null;
  /** Decode overrides the server refused (admin-locked) for the active stream. */
  overridesIgnored: string[];

  connections: Record<string, ConnectionInfo | undefined>; // keyed by Backend id

  setTheme: (t: ThemeName) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateGeneral: (patch: Partial<AppSettings["general"]>) => void;
  updateRecording: (patch: Partial<AppSettings["recording"]>) => void;

  upsertBackend: (b: Backend) => void;
  removeBackend: (id: string) => void;
  duplicateBackend: (id: string) => void;

  upsertProfile: (p: Profile) => void;
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  removeProfile: (id: string) => void;
  duplicateProfile: (id: string) => void;

  setConnection: (backendId: string, info: ConnectionInfo) => void;

  /** Update live dictation runtime (status / level / partial transcript). */
  setDictation: (
    patch: Partial<{
      status: DictationStatus;
      level: number;
      partial: string;
      activeProfile: string | null;
      dictationError: string | null;
      overridesIgnored: string[];
    }>,
  ) => void;

  /** Replace settings/backends/profiles from the persisted config (on startup). */
  hydrate: (cfg: Config) => void;
}

export const useApp = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  backends: [DEFAULT_BACKEND],
  profiles: DEFAULT_PROFILES,

  status: "idle",
  level: 0,
  partial: "",
  activeProfile: null,
  dictationError: null,
  overridesIgnored: [],

  connections: {},

  setTheme: (t) => {
    document.documentElement.dataset.theme = t;
    set((s) => ({ settings: { ...s.settings, theme: t } }));
  },
  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  updateGeneral: (patch) =>
    set((s) => ({ settings: { ...s.settings, general: { ...s.settings.general, ...patch } } })),
  updateRecording: (patch) =>
    set((s) => ({ settings: { ...s.settings, recording: { ...s.settings.recording, ...patch } } })),

  upsertBackend: (b) =>
    set((s) => {
      const i = s.backends.findIndex((x) => x.id === b.id);
      const backends = [...s.backends];
      if (i >= 0) backends[i] = b;
      else backends.push(b);
      return { backends };
    }),
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

  upsertProfile: (p) =>
    set((s) => {
      const i = s.profiles.findIndex((x) => x.id === p.id);
      const profiles = [...s.profiles];
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
      return { profiles };
    }),
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

  setConnection: (backendId, info) =>
    set((s) => ({ connections: { ...s.connections, [backendId]: info } })),

  setDictation: (patch) => set(patch),

  hydrate: (cfg) => {
    const c = migrateConfig(cfg);
    set({ settings: c.settings, backends: c.backends, profiles: c.profiles });
  },
}));
