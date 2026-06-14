// Shared data model. Mirrors the Rust-side config (src-tauri/src/config) and the
// faster-whisper-backend contract. The frontend never holds raw API keys — those
// live in the OS keyring (Rust); the UI only knows whether a key is set.

export type EndpointKind = "stream" | "batch";
export type ResponseFormat = "json" | "verbose_json";
/** Full faster-whisper-backend vs a conventional Whisper server. "auto" (or
 *  absent) infers from the connection test; "full"/"standard" are manual. */
export type BackendKind = "auto" | "full" | "standard";

/**
 * Per-field decode-param overrides. Every field optional; absent/empty = "inherit
 * from server" (the backend falls back to its per-model config). Lives on both
 * Backend (defaults) and Profile (override-of-defaults). Keys match the backend's
 * faster-whisper kwarg names so they pass straight through the wire. The backend
 * clamps every value to the admin-config bounds.
 */
export interface DecodeOverrides {
  beam_size?: number; // 1..20
  best_of?: number; // 1..20
  temperature?: number; // 0..1 (single value; overrides the server's ladder)
  condition_on_previous_text?: boolean;
  vad_filter?: boolean;
  vad_threshold?: number; // 0..1
  vad_min_silence_duration_ms?: number; // 0..10000
  vad_speech_pad_ms?: number; // 0..2000
  no_speech_threshold?: number; // 0..1
  log_prob_threshold?: number; // -10..0
  compression_ratio_threshold?: number; // 0..10
  hotwords?: string;
  prepend_punctuations?: string;
  append_punctuations?: string;
  suppress_tokens?: string; // comma-separated token ids
  patience?: number; // 0.5..5
  length_penalty?: number; // 0.1..5
  repetition_penalty?: number; // 0.5..5
  no_repeat_ngram_size?: number; // 0..10
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
  kind?: BackendKind; // full vs standard server; absent/"auto" = infer from the connection test
  overrideProfile?: string; // name of a server-side override-profile to reference (full backend only)
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
  tag?: string; // short label for the overlay chip; empty/undefined = derive from name
  language?: string; // override Backend.language; empty/undefined = inherit
  prompt?: string; // override Backend.prompt; empty/undefined = inherit
  decodeOverrides?: DecodeOverrides; // Phase-B: per-Profile decode overrides
  overrideProfile?: string; // override Backend.overrideProfile; empty/undefined = inherit
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
  showProfileOnOverlay: boolean; // show the active Profile's tag on the chip
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
  /** Server's per-process `boot_id` (non-standard, faster-whisper-backend only).
   *  Present ⇒ full backend; absent ⇒ conventional Whisper server. */
  bootId?: string;
  error?: string;
}

/** The caller's effective request-override capabilities (GET /v1/me, full
 *  backend only). snake_case mirrors the backend contract (like DecodeOverrides).
 *  A null fetch result ⇒ "unknown": the UI assumes permitted, never gates a knob
 *  it can't prove is disabled. */
export interface Capabilities {
  can_request_override_profile: boolean;
  can_request_decode_overrides: boolean;
  /** ["*"] = unrestricted (free choice); explicit names = restricted; [] = none. */
  allowed_override_profiles: string[];
}

/** A baseline shown (ghosted) under the decode editor: backend defaults and/or a
 *  selected override-profile's resolved values. Loosely typed because the server
 *  may send `temperature` as a string (a ladder); display-only. A DecodeOverrides
 *  is assignable to it, so backend defaults merge in cleanly. */
export type InheritedValues = Partial<Record<keyof DecodeOverrides, number | string | boolean>>;

/** One server override-profile's decode-relevant values + locked client keys
 *  (GET /v1/override-profiles/{name}) — shown as inherited defaults in the editor. */
export interface ResolvedOverrideProfile {
  name: string;
  values: InheritedValues;
  locked: string[];
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
  /** Decode overrides the server refused because the field is admin-locked. */
  overridesIgnored?: string[];
}
