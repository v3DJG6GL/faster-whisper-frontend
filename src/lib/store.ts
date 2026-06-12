import { create } from "zustand";
import type {
  AppSettings,
  ConnectionInfo,
  DictationStatus,
  ModelProfile,
  ModeBinding,
  ThemeName,
} from "./types";

/**
 * Frontend store. For M0 this holds seeded defaults in memory; subsequent
 * milestones wire load/save through Tauri commands (config persisted as JSON in
 * the app config dir, API keys in the OS keyring). Keep mutations here so the
 * persistence layer can subscribe in one place.
 */

const DEFAULT_PROFILE: ModelProfile = {
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
  general: {
    openAtLogin: false,
    startMinimized: false,
    autoPaste: true,
    insertMethod: "paste",
    autoEnter: false,
    restoreClipboard: true,
    soundEffects: true,
  },
  recording: {
    indicatorPosition: "top",
    saveRecordings: false,
    muteSystemAudio: false,
    realtimePreview: true,
  },
};

const DEFAULT_MODES: ModeBinding[] = [
  { mode: "hold", enabled: true, hotkey: "Ctrl+Shift", profileId: "default" },
  { mode: "handsfree", enabled: true, hotkey: "Ctrl+H", profileId: "default" },
];

interface AppState {
  settings: AppSettings;
  profiles: ModelProfile[];
  modes: ModeBinding[];

  // live dictation runtime (driven by Rust events in later milestones)
  status: DictationStatus;
  level: number; // 0..1 audio RMS for the visualizer
  partial: string; // live partial transcript for the chip preview
  activeMode: ModeBinding["mode"] | null;

  connections: Record<string, ConnectionInfo | undefined>;

  setTheme: (t: ThemeName) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateGeneral: (patch: Partial<AppSettings["general"]>) => void;
  updateRecording: (patch: Partial<AppSettings["recording"]>) => void;

  upsertProfile: (p: ModelProfile) => void;
  removeProfile: (id: string) => void;
  updateMode: (mode: ModeBinding["mode"], patch: Partial<ModeBinding>) => void;

  setConnection: (profileId: string, info: ConnectionInfo) => void;
}

export const useApp = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  profiles: [DEFAULT_PROFILE],
  modes: DEFAULT_MODES,

  status: "idle",
  level: 0,
  partial: "",
  activeMode: null,

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

  upsertProfile: (p) =>
    set((s) => {
      const i = s.profiles.findIndex((x) => x.id === p.id);
      const profiles = [...s.profiles];
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
      return { profiles };
    }),
  removeProfile: (id) =>
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      modes: s.modes.map((m) => (m.profileId === id ? { ...m, profileId: null } : m)),
    })),
  updateMode: (mode, patch) =>
    set((s) => ({ modes: s.modes.map((m) => (m.mode === mode ? { ...m, ...patch } : m)) })),

  setConnection: (profileId, info) =>
    set((s) => ({ connections: { ...s.connections, [profileId]: info } })),
}));
