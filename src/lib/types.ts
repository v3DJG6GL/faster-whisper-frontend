// Shared data model. Mirrors the Rust-side config (src-tauri/src/config) and the
// faster-whisper-backend contract. The frontend never holds raw API keys — those
// live in the OS keyring (Rust); the UI only knows whether a key is set.

export type EndpointKind = "stream" | "batch";
export type ResponseFormat = "json" | "verbose_json";

/**
 * Phase-B placeholder: per-field decode-param overrides. Every field optional;
 * absent = "inherit from server". Lives on both Backend (defaults) and Profile
 * (override). Phase B narrows this shape.
 */
export interface DecodeOverrides {
  [key: string]: unknown;
}

/** A configured connection to a faster-whisper / OpenAI-compatible server. */
export interface Backend {
  id: string;
  name: string;
  serverUrl: string; // http(s)://host:port (ws/wss derived for streaming)
  hasApiKey: boolean; // key itself is in the OS keyring, keyed by Backend id
  model: string; // e.g. "large-v3", "whisper-1", or an HF repo id
  endpoint: EndpointKind; // streaming WS vs batch multipart
  language: string; // "auto" | ISO 639-1 (default; a Profile may override)
  prompt: string; // optional initial_prompt / vocabulary biasing (default; overridable)
  responseFormat: ResponseFormat;
  decodeOverrides?: DecodeOverrides; // Phase-B: per-Backend decode defaults
}

/** How a Profile is activated — first-class, decoupled from its identity. */
export type ActivationKind = "hold" | "latch";

/** A user-defined dictation setup: activation + chord + a target Backend + overrides. */
export interface Profile {
  id: string; // stable, opaque (crypto.randomUUID); survives renames/rebinds
  name: string; // user-facing label, e.g. "Email — German"
  activation: ActivationKind;
  enabled: boolean;
  hotkey: string[]; // ordered KeyboardEvent.code list, e.g. ["ControlLeft","KeyB"]
  backendId: string | null; // references a Backend
  language?: string; // override Backend.language; empty/undefined = inherit
  prompt?: string; // override Backend.prompt; empty/undefined = inherit
  decodeOverrides?: DecodeOverrides; // Phase-B: per-Profile decode overrides
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
  evdevEnabled: boolean; // opt-in evdev backend (reliable hold / L-R / AltGr on Wayland)
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
  homeProfileId?: string | null; // which Profile the Home button targets (null = first enabled)
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
  backends: Backend[];
  profiles: Profile[];
  version?: number; // schema version (absent/legacy ⇒ 1; current ⇒ 2)
}

/** Result of a batch transcription. */
export interface BatchResult {
  text: string;
  language?: string;
  duration?: number;
}
