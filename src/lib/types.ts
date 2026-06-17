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
  // Server override-profile (full backend only): a profile name to reference,
  // NO_OVERRIDE_PROFILE = force no profile (plain defaults), undefined = server
  // default (a server-bound profile may still apply).
  overrideProfile?: string;
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
  // Override Backend.overrideProfile: a profile name, NO_OVERRIDE_PROFILE =
  // force no profile (plain defaults), undefined = inherit the backend.
  overrideProfile?: string;
}

/** Reserved override-profile value meaning "apply NO server profile — plain
 *  defaults", distinct from undefined (inherit / server default). Sent to the
 *  backend verbatim; MUST match the backend's config_store.NO_PROFILE_SENTINEL. */
export const NO_OVERRIDE_PROFILE = "__none__";

/** A per-application injection rule, keyed by the focused window's app_id. Overrides are
 *  inherit-by-default: a null/undefined field falls back to the global setting. */
export interface AppRule {
  id: string; // stable key (crypto.randomUUID)
  appId: string; // matches the focused window's app_id (case-insensitive)
  name?: string; // friendly label; defaults to appId
  block: boolean; // never inject into this app
  insertMethod?: InsertMethod | null; // override global; null/undefined = inherit
  pasteShortcut?: string[] | null; // override global; null/undefined = inherit
}

/** The focused app as reported by AT-SPI: its id/title plus — when "deep field detection"
 *  is on — whether the focused element is an editable text field. `editable` is
 *  null/undefined when unknown (app not on the a11y bus, or detection off) → type anyway. */
export interface FocusedApp {
  appId: string;
  title: string;
  editable?: boolean | null;
  /** True when this is OUR OWN focused window — the chip shows "→ this app" and dictation
   *  won't type here (the Rust injection guard skips our own windows). */
  isSelf?: boolean;
}

export type InsertMethod = "paste" | "direct" | "clipboard";
/** When the transcription is inserted: never / once on stop / live as you speak. */
export type InsertTiming = "off" | "stop" | "live";
export type IndicatorPosition = "top" | "bottom" | "off";
export type ThemeName = "dark" | "light";
/** Which usage figure the chip's optional readout shows (today's value). */
export type OverlayStatsMetric = "words" | "audio" | "both";
/** How the Home usage section presents the trend: one shared chart, or a
 *  sparkline embedded in each stat tile. */
export type HomeStatsLayout = "chart" | "sparklines";

/** A navigable app screen, referenced by the sidebar, the overlay quick-launch,
 *  and cross-window navigation (kept in sync with the router in App.tsx). */
export type OverlayScreen = "home" | "transcribe" | "profiles" | "backends" | "dictionary" | "app-rules" | "settings";
/** A dictation action the overlay quick-launch can trigger (beyond screen nav). */
export type OverlayActionKind = "toggle-dictation" | "cycle-active-profile" | "open-quick-add";
/** One quick-launch chip button: a screen nav target or a dictation action. A flat
 *  tagged shape so it round-trips through serde as opaque JSON (like DecodeOverrides). */
export interface OverlayQuickAction {
  id: string; // stable key for reorder/remove (crypto.randomUUID)
  kind: "screen" | "action";
  target: OverlayScreen | OverlayActionKind;
}

export interface GeneralSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  insertTiming: InsertTiming;
  insertMethod: InsertMethod;
  /** Chord sent for the "clipboard paste" method (KeyboardEvent.code list); default Ctrl+V. */
  pasteShortcut: string[];
  autoEnter: boolean;
  restoreClipboard: boolean;
  soundEffects: boolean;
  evdevEnabled: boolean; // opt-in evdev backend (reliable hold / L-R / AltGr on Wayland)
  /** Opt-in AT-SPI "deep field detection": skip typing when the focused element isn't a
   *  text field (covers browsers/Electron via an a11y flag + active poke). Default off. */
  deepFieldDetection: boolean;
  /** Global chord (KeyboardEvent.code list) that opens the quick-add window; [] = unset. */
  quickAddHotkey: string[];
}

export interface RecordingSettings {
  indicatorPosition: IndicatorPosition;
  saveRecordings: boolean;
  recordingsDir: string | null; // user-chosen folder for saved .wav files; null = default app-data location
  trimSilence: boolean; // when saving: keep only spoken spans (drop silence) in the .wav
  muteSystemAudio: boolean;
  latchAutoStopMin: number; // auto-stop a hands-free (latch) session after N min of silence (0 = never)
  realtimePreview: boolean;
  showProfileOnOverlay: boolean; // show the active Profile's tag on the chip
  showStatsOnOverlay: boolean; // show a tiny usage readout on the chip (off by default)
  overlayStatsMetric: OverlayStatsMetric; // which usage figure the chip shows
  showTargetOnOverlay: boolean; // show the injection target (→ app) + a warn hint when not typable
  showTargetOnlySpeaking: boolean; // only show the target while actively dictating (chip expanded)
  persistentDock: boolean; // keep the chip on screen (a standby dot) even when dictation is off
  overlayPeek: boolean; // after sitting idle, slide the chip to the screen edge (hover to restore)
  peekTimeoutSec: number; // idle seconds before the chip peeks to the edge
  peekWhileActive: boolean; // stay tucked at the edge as a dot even while dictating (color + pulse only)
  dimAfterSec: number; // idle seconds before the chip fades to a dim opacity (0 = never)
  hoverRevealMs: number; // hover-intent delay before the chip reveals detail + quick-launch
  quickLaunch: OverlayQuickAction[]; // chip quick-launch buttons (screens + dictation actions)
}

/** Which "Word mappings" (callback:map) list the quick-add window targets:
 *  the Backend it lives on + the rule slug. Designated on the Dictionary screen. */
export interface QuickAddTarget {
  backendId: string;
  slug: string;
}

export interface AppSettings {
  theme: ThemeName;
  microphoneId: string | null;
  homeProfileId?: string | null; // which Profile the Home button targets (null = first enabled)
  homeStatsLayout?: HomeStatsLayout; // Home usage section: shared chart vs per-tile sparklines
  quickAddList?: QuickAddTarget | null; // pinned "Word mappings" list the QuickAdd window targets
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
  /** The profile's own DEFAULT_PROMPT (NOT a decode key, so absent from `values`)
   *  — shown as the inherited "Vocabulary / prompt". Undefined when none. */
  prompt?: string;
  prompt_locked?: boolean;
}

// --- P17: pipeline ("Dictionary") rules — LIVE server state, not persisted ---
// Fetched per-Backend from GET /v1/pipeline-rules, edited, PATCHed back. Wire
// shape is snake_case (passes through Rust as opaque JSON, typed only here).

export type RuleType =
  | "regex-list"
  | "callback:map"
  | "callback:lowercase-wordlist"
  | "callback:dedup"
  | "callback:upper"
  | "terminal";

/** One find→replace row inside a `regex-list` rule's `entries`. */
export interface RegexListEntry {
  pattern: string;
  replacement?: string;
  label?: string;
  note?: string;
}

/** A single post-processing rule. Common fields are shared; the editable body
 *  depends on `type`. The client may edit only `enabled` + the per-type body
 *  (see `PipelineRulesState.editable_fields`); everything else is read-only
 *  context (name/label/tags/colour/locked/exposed are admin-only on the web). */
export interface PipelineRule {
  name: string; // slug (read-only)
  label: string; // display name (read-only)
  type: RuleType;
  enabled: boolean;
  locked?: boolean;
  seeded?: boolean;
  exposed?: boolean;
  tags?: string[];
  note?: string;
  color?: string;
  /** Per-rule fingerprint for optimistic concurrency — echo back on PATCH. */
  _fp?: string;
  // Editable bodies — only the one matching `type` is present:
  entries?: RegexListEntry[]; // regex-list
  map?: Record<string, string>; // callback:map (spoken → symbol)
  map_meta?: Record<string, number>; // callback:map — SERVER-OWNED, never sent
  pattern?: string; // callback:dedup / callback:upper / lowercase-wordlist
  wordlist?: string[]; // callback:lowercase-wordlist
}

/** GET /v1/pipeline-rules body: the rules the caller may view+edit, their role,
 *  and the per-type editable-field allow-list (so the client need not hardcode it). */
export interface PipelineRulesState {
  rules: PipelineRule[];
  role: "admin" | "user";
  editable_fields: Record<string, string[]>;
  /** Backend-configured # of NEWEST callback:map entries to show before
   *  collapsing the rest behind a "show older" toggle
   *  (QUICK_CONFIG_MAP_COLLAPSE_AFTER; 0 = show all). */
  map_collapse_after?: number;
}

/** GET outcome from the Rust command. `status` lets the UI branch: 0 =
 *  unreachable, 200 = ok (state present), 401/403 = gated, 404 = standard/old
 *  server (no such endpoint). */
export interface PipelineFetch {
  ok: boolean;
  status: number;
  state?: PipelineRulesState;
  error?: string;
}

/** A reported edit conflict — the rule changed on the server since load.
 *  `current_fp` is the server's fingerprint now (null if the rule vanished). */
export interface RuleConflict {
  slug: string;
  current_fp: string | null;
}

/** PATCH outcome. `ok` ⇒ HTTP 2xx (then inspect conflicts/requires_restart).
 *  `errors` is the 422 validation list; `detail` a 400/403/500 message or a
 *  transport error (status 0). */
export interface PipelineSaveResult {
  ok: boolean;
  status: number;
  saved: string[];
  conflicts: RuleConflict[];
  requires_restart: boolean;
  errors?: { loc?: string; msg?: string }[];
  detail?: string;
}

/** GET /v1/recent-words body: recently-transcribed word/phrase suggestions for
 *  the spoken-symbol (callback:map) key field, scoped to the caller's user.
 *  `max` echoes the backend cap (QUICK_CONFIG_WORD_SUGGESTIONS_MAX). Best-effort
 *  on the client — an empty list means no suggestions (old server / no history). */
export interface RecentWords {
  words: string[];
  max?: number;
}

// P28: per-user usage stats (GET /v1/usage). snake_case mirrors the backend
// JSON 1:1 — it passes straight through the Rust IPC boundary unchanged.
export type UsageBucket = "day" | "week";

/** One usage bucket's counters (the four metrics the backend rolls up). */
export interface UsageTotals {
  requests: number;
  errors: number;
  words: number;
  /** Seconds of audio (render as minutes/hours). */
  audio_s: number;
}

/** One trend point: a server-local day (days-since-epoch; ×86 400 000 → a JS
 *  Date) plus that day's (or week's) summed counters. */
export interface UsageSeriesPoint extends UsageTotals {
  day: number;
}

/** The caller's own usage: today + lifetime totals + a self-scoped trend. */
export interface UsageStats {
  username: string;
  today: UsageTotals;
  total: UsageTotals;
  range: { days: number; bucket: UsageBucket };
  series: UsageSeriesPoint[];
}

/** The persisted config blob (mirrors the Rust `Config`). */
export interface Config {
  settings: AppSettings;
  backends: Backend[];
  profiles: Profile[];
  appRules?: AppRule[]; // per-application injection rules (P16)
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
