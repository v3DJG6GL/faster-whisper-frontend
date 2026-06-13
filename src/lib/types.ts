// Shared data model. Mirrors the Rust-side config (src-tauri/src/config) and the
// faster-whisper-backend contract. The frontend never holds raw API keys — those
// live in the OS keyring (Rust); the UI only knows whether a key is set.

export type EndpointKind = "stream" | "batch";
export type ResponseFormat = "json" | "verbose_json";

/** A configured connection to a faster-whisper / OpenAI-compatible server. */
export interface ModelProfile {
  id: string;
  name: string;
  serverUrl: string; // http(s)://host:port (ws/wss derived for streaming)
  hasApiKey: boolean; // key itself is in the OS keyring, keyed by profile id
  model: string; // e.g. "large-v3", "whisper-1", or an HF repo id
  endpoint: EndpointKind; // streaming WS vs batch multipart  (per-profile, ← 3.7)
  language: string; // "auto" | ISO 639-1 (per-profile, ← 3.5)
  prompt: string; // optional initial_prompt / vocabulary biasing
  responseFormat: ResponseFormat;
}

export type DictationModeId = "hold" | "handsfree";

/** Hotkey + profile assignment for one dictation mode. */
export interface ModeBinding {
  mode: DictationModeId;
  enabled: boolean;
  hotkey: string[]; // ordered KeyboardEvent.code list, e.g. ["ControlLeft","KeyB"]
  profileId: string | null; // ← per-mode profile
}

export type InsertMethod = "paste" | "direct";
/** When the transcription is inserted: never / once on stop / live as you speak. */
export type InsertTiming = "off" | "stop" | "live";
export type IndicatorPosition = "top" | "bottom" | "off";
export type ThemeName = "dark" | "light";

export interface GeneralSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  insertTiming: InsertTiming;
  insertMethod: InsertMethod;
  autoEnter: boolean;
  restoreClipboard: boolean;
  soundEffects: boolean;
}

export interface RecordingSettings {
  indicatorPosition: IndicatorPosition;
  saveRecordings: boolean;
  muteSystemAudio: boolean;
  realtimePreview: boolean;
}

export interface AppSettings {
  theme: ThemeName;
  microphoneId: string | null;
  general: GeneralSettings;
  recording: RecordingSettings;
}

/** Runtime dictation status — mirrors the Rust state machine, surfaced to the chip. */
export type DictationStatus =
  | "idle"
  | "listening"
  | "transcribing"
  | "injecting"
  | "error";

export interface AudioDevice {
  id: string;
  label: string;
  isDefault: boolean;
}

/** A model exposed by GET /v1/models. */
export interface ServerModel {
  id: string;
  loaded: boolean;
}

export interface ConnectionInfo {
  ok: boolean;
  openMode: boolean;
  username?: string;
  models: ServerModel[];
  error?: string;
}

/** The persisted config blob (mirrors the Rust `Config`). */
export interface Config {
  settings: AppSettings;
  profiles: ModelProfile[];
  modes: ModeBinding[];
}

/** Result of a batch transcription. */
export interface BatchResult {
  text: string;
  language?: string;
  duration?: number;
}
