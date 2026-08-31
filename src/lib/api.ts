// Bridge to the Rust core. Every call is guarded so the UI still runs in a plain
// browser (`pnpm dev`) — outside Tauri the calls no-op or return safe defaults.

import { invoke } from "@tauri-apps/api/core";
import type {
  AudioDevice,
  BatchProgress,
  BatchResult,
  Capabilities,
  Config,
  ConnectionInfo,
  DecodeOverrides,
  FocusedApp,
  InsertMethod,
  PipelineFetch,
  PipelineSaveResult,
  RecentWords,
  ResolvedOverrideProfile,
  TranscribeOptions,
  UsageBucket,
  UsageStats,
} from "./types";
import type { UrlPreview } from "./urlSource";
import type {
  ExportEnvelope,
  ImportResult,
  SyncBlob,
  SyncDeleteResult,
  SyncDeviceInfo,
  SyncPullResult,
  SyncPushResult,
  SyncState,
} from "./syncTypes";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The config plus whether Rust had to RECOVER it (backed up an unreadable/corrupt file to
 *  config.json.bak and returned defaults) — so the UI can warn the settings were reset. */
export interface LoadedConfig {
  config: Config;
  recovered: boolean;
}

export async function loadConfig(): Promise<LoadedConfig | null> {
  if (!isTauri) return null;
  return invoke<LoadedConfig>("load_config");
}

export async function saveConfig(config: Config): Promise<void> {
  if (!isTauri) return;
  await invoke("save_config", { config });
}

export async function setBackendKey(backendId: string, key: string): Promise<void> {
  if (!isTauri) return;
  await invoke("set_backend_key", { backendId, key });
}

export async function deleteBackendKey(backendId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("delete_backend_key", { backendId });
}

/** The app version baked into the binary at build time. Sourced from tauri.conf.json,
 *  which a release bump keeps in lockstep with package.json / Cargo.toml via
 *  `scripts/version.mjs`. Empty string outside the desktop app (plain `pnpm dev`). */
export async function appVersion(): Promise<string> {
  if (!isTauri) return "";
  return invoke<string>("app_version");
}

export async function testConnection(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<ConnectionInfo> {
  if (!isTauri) {
    return { ok: false, openMode: false, models: [], error: "Not running in the desktop app." };
  }
  return invoke<ConnectionInfo>("test_connection", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

export async function transcribeFile(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  model: string;
  language: string;
  // undefined/null = omit (inherit DEFAULT_PROMPT); "" = explicit clear; value = use.
  prompt?: string | null;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  filePath: string;
  /** Per-run stage options (translate / diarization). Omitted keys = absent
   *  on the wire, so the server's own defaults apply. */
  options?: TranscribeOptions | null;
}): Promise<BatchResult> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke<BatchResult>("transcribe_file", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    filePath: args.filePath,
    options: args.options ?? null,
  });
}

/** Read a subtitle/text source file (translate-only runs; 10 MB cap). */
export async function readTextFile(path: string): Promise<string> {
  if (!isTauri) throw new Error("Reading files requires the desktop app.");
  return invoke<string>("read_text_file", { path });
}

/** Per-input-index translation maps + bounded provenance from
 *  POST /v1/text/translations (full backend, translation_enabled). */
export interface TextTranslationResult {
  /** results[i] = translations of texts[i], keyed by target language code. */
  results: Record<string, string>[];
  /** kept[i] = target codes for which results[i] carries the SOURCE text
   *  unchanged (server quality guard) — dense, aligned with `results`.
   *  Optional defensively (absent from older payloads / test fixtures). */
  kept?: string[][];
  model?: string;
  source?: string;
  warnings?: string[];
}

/** Translate segment texts (T2T, no audio): dictation settle-time
 *  translation, the viewer's re-translate, retro-translation, and
 *  subtitle/text-file sources. */
export async function translateText(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  texts: string[];
  targets: string[];
  source?: string | null;
  model?: string | null;
  mode?: "fluent" | "faithful" | null;
  glossary?: string | null;
  contextSegments?: number | null;
  /** Keys the server-side progress entry (getTranscribeProgress polls it,
   *  cancelTextTranslation aborts by it). Optional — older backends ignore it. */
  progressId?: string | null;
  /** The dictation capture whose log receipt the server is holding open for
   *  this translation, so the utterance and its translation are logged as ONE
   *  block. Omitted by every non-dictation caller; an older backend ignores
   *  the unknown field. */
  capturedId?: string | null;
}): Promise<TextTranslationResult> {
  if (!isTauri) throw new Error("Translation requires the desktop app.");
  return invoke<TextTranslationResult>("translate_text", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    texts: args.texts,
    targets: args.targets,
    source: args.source ?? null,
    model: args.model ?? null,
    mode: args.mode ?? null,
    glossary: args.glossary ?? null,
    contextSegments: args.contextSegments ?? null,
    progressId: args.progressId ?? null,
    capturedId: args.capturedId ?? null,
  });
}

/** Tell the SERVER to abort the in-flight text translation behind
 *  `progressId` (the cancel endpoint is shared with batch transcription).
 *  Best-effort — an older backend just answers 404. */
export async function cancelTextTranslation(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  progressId: string;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_text_translation", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    progressId: args.progressId,
  });
}

/** Transcribe a pasted media link: the SERVER downloads the audio (yt-dlp)
 *  and runs the normal pipeline. Full backend only (url_download_enabled). */
export async function transcribeUrl(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  model: string;
  language: string;
  prompt?: string | null;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  sourceUrl: string;
  options?: TranscribeOptions | null;
}): Promise<BatchResult> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke<BatchResult>("transcribe_url", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    sourceUrl: args.sourceUrl,
    options: args.options ?? null,
  });
}

/** Metadata preview of a pasted media link (title/duration/thumbnail) —
 *  debounced from the URL field. Advisory: a failed preview never blocks
 *  adding the link; the run itself is the authority. */
export async function urlPreview(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  url: string;
}): Promise<UrlPreview> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<UrlPreview>("url_preview", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    url: args.url,
  });
}

/** Pull the server-retained audio of a finished URL run into the local media
 *  store (media/<recordId>.<ext>). Returns the local path, or null when the
 *  server no longer has the file (retention expired) — the transcript stays
 *  usable, only playback is gone. */
export async function fetchUrlMedia(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  mediaId: string;
  recordId: string;
  audioBase?: string | null;
}): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("fetch_url_media", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    mediaId: args.mediaId,
    recordId: args.recordId,
    audioBase: args.audioBase ?? null,
  });
}

/** Abort every in-flight file transcription (Transcribe screen's Cancel). */
export async function cancelFileTranscription(): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_file_transcription");
}

/** Tell the SERVER to abort the in-flight transcription behind `progressId`
 *  (cancelFileTranscription only drops our end of the connection — without
 *  this the server's pipeline runs to completion). Best-effort. */
export async function cancelBackendTranscription(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  progressId: string;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_backend_transcription", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    progressId: args.progressId,
  });
}

/** Poll the live progress of an in-flight file transcription. */
export async function getTranscribeProgress(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  progressId: string;
}): Promise<BatchProgress> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<BatchProgress>("get_transcribe_progress", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    progressId: args.progressId,
  });
}

/** Names of server-side override-profiles a client may reference (full backend
 *  only). Best-effort: returns [] outside Tauri or on any error. */
export async function listOverrideProfiles(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<string[]> {
  if (!isTauri) return [];
  return invoke<string[]>("list_override_profiles", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

/** The caller's effective request-override capabilities (full backend only).
 *  Best-effort: null outside Tauri or on any error (endpoint absent / standard
 *  server / unreachable) — callers treat null as "unknown ⇒ assume permitted". */
export async function getCapabilities(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<Capabilities | null> {
  if (!isTauri) return null;
  return invoke<Capabilities | null>("get_capabilities", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

/** A model family the server can pre-warm. There is deliberately no `vad`
 *  member — the backend contract has no such family and rejects unknown ones. */
export type PreloadFamily = "whisper" | "diarization" | "separation" | "translation";

/** Ask the server to start warming the models a job will need
 *  (POST /v1/models/preload, full backend only). Best-effort: `false` outside
 *  Tauri or on any error — an older backend that 404s this endpoint must be
 *  indistinguishable from one that honours it, so no caller may branch on it
 *  beyond deciding not to retry. Never throws. */
export async function preloadModels(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  models: { family: PreloadFamily; id: string }[];
  planId?: string | null;
}): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("preload_models", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    models: args.models,
    planId: args.planId ?? null,
  });
}

/** One override-profile's decode values + locked client keys, for previewing
 *  inherited defaults. Best-effort: null outside Tauri or on any error (incl.
 *  404 when the caller may not request that profile). */
export async function getOverrideProfile(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  name: string;
}): Promise<ResolvedOverrideProfile | null> {
  if (!isTauri) return null;
  return invoke<ResolvedOverrideProfile | null>("get_override_profile", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    name: args.name,
  });
}

/** P17: the post-processing ("Dictionary") rules the caller may view + edit
 *  (GET /v1/pipeline-rules). Returns a structured result with the HTTP status so
 *  the screen can branch (0 = unreachable, 200 = ok, 401/403 = gated, 404 =
 *  standard/old server). Outside Tauri → an unreachable result. */
export async function getPipelineRules(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<PipelineFetch> {
  if (!isTauri) return { ok: false, status: 0, error: "Not running in the desktop app." };
  return invoke<PipelineFetch>("get_pipeline_rules", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

/** P18: recently-transcribed word/phrase suggestions for the Dictionary's
 *  spoken-symbol key field (GET /v1/recent-words), scoped to the Backend's API
 *  key via the keyring. Best-effort: `{ words: [] }` outside Tauri or on any
 *  error (old/standard server, no history) — the field just becomes a plain input. */
export async function getRecentWords(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<RecentWords> {
  if (!isTauri) return { words: [] };
  return invoke<RecentWords>("get_recent_words", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

/** P28: the caller's own usage (GET /v1/usage) — today + lifetime totals + a
 *  self-scoped daily/weekly trend series, for the Home stats section and the
 *  optional chip readout. Best-effort: null outside Tauri or on any error
 *  (endpoint absent / standard server / unreachable) — callers hide the stats
 *  surfaces when null. `tzMidnight` is the client's local-midnight epoch
 *  (seconds) for a viewer-local "today"; `days` <= 0 = lifetime series. */
export async function getUsageStats(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  tzMidnight?: number | null;
  days?: number | null;
  bucket?: UsageBucket | null;
}): Promise<UsageStats | null> {
  if (!isTauri) return null;
  return invoke<UsageStats | null>("get_usage_stats", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    tzMidnight: args.tzMidnight ?? null,
    days: args.days ?? null,
    bucket: args.bucket ?? null,
  });
}

/** P17: apply a per-rule patch (PATCH /v1/pipeline-rules). `patch` is the
 *  {rules_patch, fingerprints} object built from the user's edits. Returns
 *  saved / conflicts / requires_restart, plus 422 `errors` or a 400/403/500
 *  `detail`. */
export async function savePipelineRules(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  patch: {
    rules_patch: Record<string, Record<string, unknown>>;
    fingerprints?: Record<string, string>;
  };
}): Promise<PipelineSaveResult> {
  if (!isTauri)
    return {
      ok: false,
      status: 0,
      saved: [],
      conflicts: [],
      requires_restart: false,
      detail: "Not running in the desktop app.",
    };
  return invoke<PipelineSaveResult>("save_pipeline_rules", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    patch: args.patch,
  });
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  if (!isTauri) return [];
  return invoke<AudioDevice[]>("list_audio_devices");
}

export async function startMicTest(deviceId: string | null): Promise<void> {
  if (!isTauri) return;
  await invoke("start_mic_test", { deviceId });
}

/** Stop the mic test; resolves to the number of seconds captured (0 = nothing). */
export async function stopMicTest(): Promise<number> {
  if (!isTauri) return 0;
  return invoke<number>("stop_mic_test");
}

/** Replay the most recent mic-test capture on the default output device (no-op if
 *  nothing was recorded). Returns once playback has been dispatched. Stops any
 *  replay already in progress, so two never overlap. */
export async function playMicTest(): Promise<void> {
  if (!isTauri) return;
  await invoke("play_mic_test");
}

/** Stop an in-flight mic-test replay (no-op if nothing is playing). */
export async function stopMicTestPlayback(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_mic_test_playback");
}

/** Shared contract for every event subscription: no-op (empty unlisten) outside Tauri, else
 *  dynamic-import the event module and listen, handing the typed payload to `cb`. Keeps the
 *  isTauri guard + dynamic import in ONE place so a subscriber can't forget the empty-unlisten
 *  return (which would throw, not no-op, in non-Tauri `pnpm dev`). Returns the unlisten fn. */
async function subscribe<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

/** Fires when a mic-test replay finishes (and wasn't superseded), so the UI can
 *  clear its "playing" state. Returns an unlisten fn. */
export async function onMicTestPlayEnded(cb: () => void): Promise<() => void> {
  return subscribe<unknown>("audio://test-play-ended", () => cb());
}

// ── In-app log viewer (Logs screen) ─────────────────────────────────────────

/** One captured log line from the Rust ring buffer. `ts` is ms since epoch. */
export interface LogLine {
  seq: number;
  ts: number;
  level: "error" | "warn" | "info" | "debug" | "trace";
  target: string;
  /** Parsed leading `[subsystem]` tag, when present. */
  tag: string | null;
  msg: string;
}

export interface LogTail {
  lines: LogLine[];
  /** Cumulative error/warn counts since app launch (badge source). */
  errors: number;
  warns: number;
  /** Next sequence number — pass back as `sinceSeq` to continue from here. */
  seq: number;
}

const EMPTY_TAIL: LogTail = { lines: [], errors: 0, warns: 0, seq: 0 };

/** The ring's contents from `sinceSeq` on (0 = everything captured so far). */
export async function getLogTail(sinceSeq: number): Promise<LogTail> {
  if (!isTauri) return EMPTY_TAIL;
  return invoke<LogTail>("get_log_tail", { sinceSeq });
}

/** Gate the batched `log://lines` stream — on while the Logs screen is open. */
export async function setLogStream(active: boolean): Promise<void> {
  if (!isTauri) return;
  return invoke("set_log_stream", { active });
}

/** Badge hydration at startup: counters only, no lines. */
export async function getLogStatus(): Promise<LogTail> {
  if (!isTauri) return EMPTY_TAIL;
  return invoke<LogTail>("get_log_status");
}

/** Display path of the log folder (home-relative where possible). */
export async function logFolderPath(): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string>("log_folder_path").catch(() => null);
}

export async function openLogFolder(): Promise<void> {
  if (!isTauri) return;
  return invoke("open_log_folder");
}

/** Batched new log lines — emitted only while the stream is active. */
export async function onLogLines(
  cb: (payload: { lines: LogLine[] }) => void,
): Promise<() => void> {
  return subscribe<{ lines: LogLine[] }>("log://lines", cb);
}

/** Badge counters — always on, emitted only when the totals change. */
export async function onLogStatus(
  cb: (payload: { seq: number; errors: number; warns: number }) => void,
): Promise<() => void> {
  return subscribe<{ seq: number; errors: number; warns: number }>("log://status", cb);
}

/** Subscribe to live RMS levels (0..1) emitted during capture. Returns an unlisten fn. */
export async function onAudioLevel(cb: (level: number) => void): Promise<() => void> {
  return subscribe<number>("audio://level", cb);
}

export async function startStream(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  model: string;
  language: string;
  // undefined/null = omit (inherit DEFAULT_PROMPT); "" = explicit clear; value = use.
  prompt?: string | null;
  responseFormat: string;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  /** Declares that this session's utterances WILL be translated on a separate
   *  request. The server then holds each per-utterance log receipt open and
   *  merges the translation into it, instead of logging a receipt and four
   *  orphan [translate] lines with nothing linking them. Omitted → the server
   *  logs immediately, exactly as it always has, which is what keeps an older
   *  backend's behaviour unchanged. */
  translateExpect?: { targets: string[]; include_original: boolean } | null;
  deviceId?: string | null;
  save?: boolean;
  recordingsDir?: string | null;
  trimSilence?: boolean;
  muteSystem?: boolean;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("start_stream", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    responseFormat: args.responseFormat,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    translateExpect: args.translateExpect ?? null,
    deviceId: args.deviceId ?? null,
    save: args.save ?? false,
    recordingsDir: args.recordingsDir ?? null,
    trimSilence: args.trimSilence ?? true,
    muteSystem: args.muteSystem ?? false,
  });
}

export async function stopStream(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_stream");
}

/** Hard-abort the stream session WITHOUT draining (no wasted server work; releases the system mute).
 *  Used by cancelLive, and as the closed-handler's idempotent release of a parked session. */
export async function cancelStream(): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_stream");
}

export async function startRecord(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  model: string;
  language: string;
  // undefined/null = omit (inherit DEFAULT_PROMPT); "" = explicit clear; value = use.
  prompt?: string | null;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  deviceId?: string | null;
  save?: boolean;
  recordingsDir?: string | null;
  trimSilence?: boolean;
  muteSystem?: boolean;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("start_record", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    deviceId: args.deviceId ?? null,
    save: args.save ?? false,
    recordingsDir: args.recordingsDir ?? null,
    trimSilence: args.trimSilence ?? true,
    muteSystem: args.muteSystem ?? false,
  });
}

export async function stopRecord(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_record");
}

/** Hard-abort the record session WITHOUT transcribing (no wasted server POST; releases the system
 *  mute). Used by cancelLive, and as the closed-handler's idempotent release of a parked session. */
export async function cancelRecord(): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_record");
}

/** Retire the active session epoch WITHOUT draining/aborting — the error/fatal-inject teardown keeps
 *  its draining stop (sidecar still written) but uses this so the detached drain's late final/closed
 *  can't bleed onto a session re-triggered during the error linger. */
export async function retireSessionEpoch(): Promise<void> {
  if (!isTauri) return;
  await invoke("retire_session_epoch");
}

/** Re-register global hotkeys after the bindings change (or to restore them). */
export async function reregisterShortcuts(): Promise<void> {
  if (!isTauri) return;
  await invoke("reregister_shortcuts");
}

/** Like reregisterShortcuts, but a no-op while a binding capture is in progress — used by
 *  cancelLive's resume-recovery so cancelling a session on system://resumed can't re-arm the
 *  hotkeys (and clear the capture suspension) mid-capture. */
export async function reregisterShortcutsUnlessCapturing(): Promise<void> {
  if (!isTauri) return;
  await invoke("reregister_shortcuts_unless_capturing");
}

/** Suspend all global hotkeys while capturing a new binding (so a keypress only
 *  rebinds and doesn't also trigger dictation). Restore with reregisterShortcuts. */
export async function suspendShortcuts(): Promise<void> {
  if (!isTauri) return;
  await invoke("suspend_shortcuts");
}

/** Whether a code-list chord (["ControlLeft","KeyH"]) can be registered via the
 *  global-shortcut plugin. Modifier-only / AltGr chords return false (evdev-only). */
export async function validateCodes(codes: string[]): Promise<boolean> {
  if (!isTauri) return true;
  return invoke<boolean>("validate_codes", { codes });
}

export interface EvdevStatus {
  available: boolean; // Linux-only backend
  permitted: boolean; // user can read /dev/input (in the `input` group)
  enabled: boolean; // turned on in config
}

/** Whether the evdev hotkey backend is available / permitted / enabled. */
export async function evdevStatus(): Promise<EvdevStatus> {
  if (!isTauri) return { available: false, permitted: false, enabled: false };
  return invoke<EvdevStatus>("evdev_status");
}

/** Add the user to the `input` group via pkexec (polkit). Returns a status message. */
export async function evdevSetup(): Promise<string> {
  if (!isTauri) throw new Error("Requires the desktop app.");
  return invoke<string>("evdev_setup");
}

/** Snapshot the clipboard before a live paste-injection session. */
export async function beginInjection(): Promise<void> {
  if (!isTauri) return;
  await invoke("begin_injection");
}

/** Restore the clipboard snapshot taken by beginInjection (end of a live session). */
export async function endInjection(): Promise<void> {
  if (!isTauri) return;
  await invoke("end_injection");
}

/** Put the beginInjection snapshot back on the clipboard WITHOUT consuming it, so the user's
 *  original clipboard is restored after each pasted phrase (the snapshot persists for the next
 *  phrase). No-op when no snapshot was taken. */
export async function restoreClipboardSnapshot(): Promise<void> {
  if (!isTauri) return;
  await invoke("restore_clipboard_snapshot");
}

/** Drop the beginInjection snapshot WITHOUT restoring it — for when a session ends on a
 *  clipboard-only phrase, so the transcript the user wants to paste survives (no restore)
 *  yet the snapshot can't leak into a later session. No-op when no snapshot was taken. */
export async function discardInjectionSnapshot(): Promise<void> {
  if (!isTauri) return;
  await invoke("discard_injection_snapshot");
}

/** What `inject_text` did. Mirror of the Rust `InjectOutcome`. */
export interface InjectOutcome {
  /** The text landed — typed, pasted, or deliberately left on the clipboard. False ONLY when one
   *  of our own windows held focus and the insert was skipped, at entry or at the sink. Do not
   *  advance a typed baseline on false: nothing was written anywhere, so there is nothing to
   *  recover and the phrase must go out again. */
  landed: boolean;
  /** Rust diverted to the clipboard against what we asked for — the trigger chord was still held,
   *  or focus had moved to a different app. The text is safe but did not go where the user was
   *  looking, so say so rather than stamping a green "typed" confirmation over it. */
  diverted: boolean;
}

/** Insert text into the focused field of the active app. */
export async function injectText(args: {
  text: string;
  method: InsertMethod;
  autoEnter: boolean;
  restoreClipboard: boolean;
  pasteShortcut: string[];
  /** The app whose per-app rule produced `method`. Rust re-checks the focused window against this
   *  immediately before typing and degrades to clipboard-only if focus moved, so a rule resolved
   *  a second earlier can't be applied to a different window. Omit when there is no identified
   *  target — an unidentified window deliberately still falls through. */
  expectAppId?: string | null;
}): Promise<InjectOutcome> {
  if (!isTauri) return { landed: true, diverted: false };
  return await invoke<InjectOutcome>("inject_text", {
    text: args.text,
    method: args.method,
    autoEnter: args.autoEnter,
    restoreClipboard: args.restoreClipboard,
    pasteShortcut: args.pasteShortcut,
    expectAppId: args.expectAppId ?? null,
  });
}

/** The focused app's id + title + (when deep detection is on) editability, via AT-SPI.
 *  null when nothing is known yet (no a11y bridge / cold listener). */
export async function getFocusedApp(): Promise<FocusedApp | null> {
  if (!isTauri) return null;
  return (await invoke<FocusedApp | null>("get_focused_app")) ?? null;
}

/** Whether ALL of this chord's modifier keys are physically held right now, per the
 *  low-level hotkey backends' shared HeldKeys signal (evdev / win_hotkeys; always false
 *  when only the plugin backend runs, or when the chord has no modifiers — non-modifier
 *  keys aren't observable). Consumer: the queued fast re-press start — fire only while
 *  the pressed chord itself is still down. */
export async function shortcutModsHeld(codes: string[]): Promise<boolean> {
  if (!isTauri) return false;
  return await invoke<boolean>("shortcut_mods_held", { codes });
}

/** Like getFocusedApp but skips the own-window self short-circuit — returns the previously
 *  focused OTHER app. For the App-rules "Use current" button, which is always clicked while
 *  our own window holds focus (so getFocusedApp would always report "this app"). */
export async function getFocusedOtherApp(): Promise<FocusedApp | null> {
  if (!isTauri) return null;
  return (await invoke<FocusedApp | null>("get_focused_other_app")) ?? null;
}

/** Toggle the opt-in AT-SPI "deep field detection" (a11y flag + Chromium/Electron poke). */
export async function setDeepFieldDetection(enabled: boolean): Promise<void> {
  if (!isTauri) return;
  await invoke("set_deep_field_detection", { enabled });
}

/** Show + position the dictation chip overlay at the given screen edge. The window is
 *  anchored flush against that edge; the resting inset and edge-peek are pure CSS (Overlay.tsx). */
export async function showOverlay(position: "top" | "bottom"): Promise<void> {
  if (!isTauri) return;
  await invoke("show_overlay", { position });
}

/** Hide the dictation chip overlay. */
export async function hideOverlay(): Promise<void> {
  if (!isTauri) return;
  await invoke("hide_overlay");
}

/** Show + focus the quick-add word-mapping window (summoned by the chip button / shortcut). */
export async function showQuickAdd(): Promise<void> {
  if (!isTauri) return;
  await invoke("show_quick_add");
}

/** Hide the quick-add word-mapping window (Esc / done). */
export async function hideQuickAdd(): Promise<void> {
  if (!isTauri) return;
  await invoke("hide_quick_add");
}

/** Read the user's current text selection from the source app to pre-fill Quick-Add's
 *  "When you say" field on summon. null when nothing usable is selected (leave it empty +
 *  show the recent-words dropdown). Best-effort: any error → null. */
export async function getQuickAddSeed(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return (await invoke<string | null>("get_quickadd_seed")) ?? null;
  } catch {
    return null;
  }
}

/** Read the focused element's CURRENT text selection (accessibility only — no highlight-buffer
 *  fallback). null when nothing is selected or it can't be read. The correct-on-close guard uses
 *  this to confirm the same word is still highlighted before replacing it. */
export async function getFocusedSelection(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return (await invoke<string | null>("get_focused_selection")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Shape the overlay window's mouse input region to just the visible chip (logical
 * px, relative to the window's top-left), so the chip becomes hoverable while the
 * rest of the transparent strip stays click-through. No-op outside Tauri.
 */
export async function setChipHitRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  // persist=false for the transient full-window hover hold — applied but not remembered as the
  // restore target, so a later re-show never reapplies a whole-window (click-swallowing) region.
  persist = true,
): Promise<void> {
  if (!isTauri) return;
  await invoke("set_chip_hit_region", { x, y, w, h, persist });
}

/** Is the cursor genuinely over the chip window right now, per the windowing system —
 *  immune to a lost DOM pointerleave (WebKitGTK drops the crossing when the input shape
 *  reshapes mid-exit). Fail-open: true outside Tauri / on any error, so a query hiccup can
 *  never cancel a legitimate hover. */
export async function chipPointerOver(): Promise<boolean> {
  if (!isTauri) return true;
  try {
    return await invoke<boolean>("chip_pointer_over");
  } catch {
    return true;
  }
}

/** Reflect the dictation status in the tray tooltip. */
export async function setTrayState(status: string): Promise<void> {
  if (!isTauri) return;
  await invoke("set_tray_state", { status });
}

/** Play a short start/stop/error cue (no-op outside Tauri). */
export async function playCue(kind: "start" | "stop" | "error"): Promise<void> {
  if (!isTauri) return;
  await invoke("play_cue", { kind });
}

export interface TriggerEvent {
  profileId: string; // the fired Profile's id (resolved to a Backend by the controller)
  // reclassify = chord family: a latch superset completed over a live hold (upgrade in
  // place / toggle off); cancel = quick-add superset aborted a nascent hold in-grace.
  action: "start" | "stop" | "toggle" | "reclassify" | "cancel";
}

/** Subscribe to dictation triggers (CLI / global hotkey). Returns an unlisten fn. */
export async function onTrigger(cb: (e: TriggerEvent) => void): Promise<() => void> {
  return subscribe<TriggerEvent>("trigger", cb);
}

/** Subscribe to system resume-from-suspend (emitted by the Rust suspend watcher).
 *  Returns an unlisten fn. */
export async function onSystemResumed(cb: () => void): Promise<() => void> {
  return subscribe<unknown>("system://resumed", () => cb());
}

/** Show + focus the main window and ask its router to navigate to a screen. Used by
 *  the overlay chip's quick-launch (a separate window that can't drive the router). */
export async function showMainAtScreen(screen: string): Promise<void> {
  if (!isTauri) return;
  await invoke("show_main_at_screen", { screen });
}

/** Emit a dictation action from the overlay window for the main window to run
 *  (see runOverlayAction in dictation.ts). */
export async function emitOverlayAction(kind: string): Promise<void> {
  if (!isTauri) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit("overlay://action", { kind });
}

/** Subscribe (in the main window) to dictation actions emitted by the overlay chip.
 *  Returns an unlisten fn. */
export async function onOverlayAction(cb: (kind: string) => void): Promise<() => void> {
  return subscribe<{ kind: string }>("overlay://action", (p) => cb(p.kind));
}

/** Subscribe (in the main window) to navigate requests from show_main_at_screen.
 *  Returns an unlisten fn. */
export async function onAppNavigate(cb: (screen: string) => void): Promise<() => void> {
  return subscribe<string>("app://navigate", cb);
}

/** Native "open files" dialog → absolute paths ([] if cancelled / not in Tauri). */
export async function pickAudioFiles(): Promise<string[]> {
  if (!isTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "Audio / Video",
        extensions: ["wav", "mp3", "m4a", "mp4", "aac", "ogg", "opus", "webm", "flac"],
      },
      // Text sources: translate-only runs (no audio ever exists for these).
      { name: "Subtitles / Text", extensions: ["srt", "vtt", "lrc", "txt", "json"] },
    ],
  });
  if (Array.isArray(selected)) return selected.filter((p): p is string => typeof p === "string");
  return typeof selected === "string" ? [selected] : [];
}

/** Native "choose folder" dialog → absolute path (or null if cancelled / not in Tauri).
 *  Used to pick a custom recordings folder. */
export async function pickRecordingsDir(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

// ── P30: settings export/import + server sync ──────────────────────────────

/** Pull the account's synced settings blob (GET /v1/client-settings). Structured
 *  result: 0 = unreachable, 200 = ok (version 0 = empty store), 401 = key,
 *  404 = the backend build predates sync. Outside Tauri → unreachable. */
export async function syncPull(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<SyncPullResult> {
  if (!isTauri) return { ok: false, status: 0, error: "Not running in the desktop app." };
  return invoke<SyncPullResult>("sync_pull", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

/** Push the composed blob (PUT /v1/client-settings). `baseVersion` is the server
 *  version this device last saw (0 creates); a 409 comes back in `conflict`
 *  carrying the current server state for the merge loop. */
export async function syncPush(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
  blob: SyncBlob;
  baseVersion: number;
  device: string;
}): Promise<SyncPushResult> {
  if (!isTauri) return { ok: false, status: 0, error: "Not running in the desktop app." };
  return invoke<SyncPushResult>("sync_push", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    blob: args.blob,
    baseVersion: args.baseVersion,
    device: args.device,
  });
}

/** Drop the account's server-side blob (DELETE /v1/client-settings). */
export async function syncDelete(args: {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}): Promise<SyncDeleteResult> {
  if (!isTauri) return { ok: false, status: 0, error: "Not running in the desktop app." };
  return invoke<SyncDeleteResult>("sync_delete", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

/** Local sync bookkeeping (<config dir>/sync-state.json): last-synced snapshot
 *  (the 3-way merge base) + server version + hash + device id. */
export async function loadSyncState(): Promise<SyncState | null> {
  if (!isTauri) return null;
  return invoke<SyncState | null>("load_sync_state");
}

export async function saveSyncState(state: SyncState): Promise<void> {
  if (!isTauri) return;
  await invoke("save_sync_state", { state });
}

/** This machine's sync identity (persistent uuid + hostname + platform). */
export async function syncDeviceInfo(): Promise<SyncDeviceInfo | null> {
  if (!isTauri) return null;
  return invoke<SyncDeviceInfo>("sync_device_info");
}

/** Bulk keyring read: the stored API keys of the given Backends (ids without a
 *  key are omitted). Feeds export-with-secrets and the synced blob. */
export async function readBackendKeys(backendIds: string[]): Promise<Record<string, string>> {
  if (!isTauri) return {};
  return invoke<Record<string, string>>("read_backend_keys", { backendIds });
}

/** Write a settings-export envelope to `path` (atomic tmp+rename, Rust-side). */
export async function exportSettingsFile(path: string, envelope: ExportEnvelope): Promise<void> {
  if (!isTauri) return;
  await invoke("export_settings_file", { path, envelope });
}

/** Read + validate a settings-export file. Throws (string) with a clear message
 *  on not-an-export / newer formatVersion / structurally-broken lists. */
export async function importSettingsFile(path: string): Promise<ImportResult> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<ImportResult>("import_settings_file", { path });
}

/** Native "save file" dialog → absolute path (or null if cancelled / not in Tauri). */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    defaultPath: defaultName,
    filters: [{ name: "Settings export", extensions: ["json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Save dialog for a transcript export → absolute path (or null if cancelled). */
export async function pickExportPath(
  defaultName: string,
  formatName: string,
  extension: string,
): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    defaultPath: defaultName,
    filters: [{ name: formatName, extensions: [extension] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Write a plain text file via the Rust side (atomic tmp+rename). */
export async function saveTextFile(path: string, contents: string): Promise<void> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  await invoke("save_text_file", { path, contents });
}

/** Persist one transcription-history record (opaque JSON, atomic write).
 *  `record` is pre-serialized by the caller so Rust never re-encodes it. */
export async function saveTranscriptRecord(
  id: string,
  record: string,
  dictation = false,
): Promise<void> {
  if (!isTauri) return;
  await invoke("save_transcript_record", { id, record, dictation });
}

/** The effective audio-base-folder preference: the new key, with the legacy
 *  custom recordings folder as fallback. Pass this wherever a command takes
 *  `audioBase`. */
export function audioBasePref(rec: {
  audioBaseDir?: string | null;
  recordingsDir?: string | null;
}): string | null {
  return rec.audioBaseDir?.trim() || rec.recordingsDir?.trim() || null;
}

/** Copy a run's input audio into the store (`<base>/files/<id>.<ext>`) so
 *  playback survives the original moving. Null = no copy (outside Tauri, or
 *  the source is over the 2 GB cap). */
export async function saveTranscriptMedia(
  id: string,
  sourcePath: string,
  audioBase: string | null,
): Promise<string | null> {
  if (!isTauri) return null;
  return await invoke<string | null>("save_transcript_media", { id, sourcePath, audioBase });
}

/** Per-type storage readout for the Recording & history tab. */
export interface TranscriptStoreStats {
  dictationCount: number;
  fileCount: number;
  fileMediaBytes: number;
  fileMediaFiles: number;
  linkMediaBytes: number;
  linkMediaFiles: number;
  recordingsBytes: number;
  recordingsFiles: number;
}

const EMPTY_STORE_STATS: TranscriptStoreStats = {
  dictationCount: 0, fileCount: 0, fileMediaBytes: 0, fileMediaFiles: 0,
  linkMediaBytes: 0, linkMediaFiles: 0, recordingsBytes: 0, recordingsFiles: 0,
};

export async function transcriptStoreStats(
  audioBase: string | null,
): Promise<TranscriptStoreStats> {
  if (!isTauri) return EMPTY_STORE_STATS;
  return await invoke<TranscriptStoreStats>("transcript_store_stats", { audioBase });
}

/** "Delete all dictations" — session records AND the dictations folder's
 *  .wav/.txt files. Returns how many files were removed. */
export async function deleteAllDictations(audioBase: string | null): Promise<number> {
  if (!isTauri) return 0;
  return await invoke<number>("delete_all_dictations", { audioBase });
}

/** "Delete all transcriptions" — every file/link record + its audio. */
export async function clearFileTranscriptions(audioBase: string | null): Promise<number> {
  if (!isTauri) return 0;
  return await invoke<number>("clear_file_transcriptions", { audioBase });
}

/** "Delete audio from … transcriptions" — empties one media subfolder
 *  ("file" → files/, "url" → links/); transcripts stay. */
export async function removeTranscriptMedia(
  kind: "file" | "url",
  audioBase: string | null,
): Promise<number> {
  if (!isTauri) return 0;
  return await invoke<number>("remove_transcript_media", { kind, audioBase });
}

/** Relocate the whole audio store (all three subfolders) to a new base.
 *  Call BEFORE saving the setting; only persist on success. */
export async function moveAudioBase(
  current: string | null,
  next: string | null,
): Promise<void> {
  if (!isTauri) return;
  await invoke("move_audio_base", { current, next });
}

/** All locally stored transcription-history records (unordered; each carries
 *  its own createdAt). [] outside Tauri or when none exist. */
export async function listTranscriptRecords(): Promise<unknown[]> {
  if (!isTauri) return [];
  return invoke<unknown[]>("list_transcript_records");
}

/** Delete one history record's file from disk (plus its audio, wherever the
 *  base folder currently is). */
export async function deleteTranscriptRecord(id: string, audioBase: string | null): Promise<void> {
  if (!isTauri) return;
  await invoke("delete_transcript_record", { id, audioBase });
}

/** Read a media file's raw bytes for the playback blob fallback (Linux
 *  WebKitGTK is unreliable with media over the asset protocol). */
export async function readMediaFile(path: string): Promise<ArrayBuffer> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<ArrayBuffer>("read_media_file", { path });
}

/** Decode a media file in Rust (symphonia) — the last-resort playback
 *  fallback for codecs the webview can't handle (AAC/MP4 on Linux
 *  WebKitGTK, i.e. every retained YouTube audio). Resolves to the path of
 *  a cached on-disk WAV (played via the asset protocol — huge in-memory
 *  blobs freeze the web process). Rejects with "gone" when the source
 *  file no longer exists. */
export async function decodeMediaFile(path: string): Promise<string> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<string>("decode_media_file", { path });
}

/** Open a transcribed link in the system browser (scheme-checked in Rust). */
export async function openSourceUrl(url: string): Promise<void> {
  if (!isTauri) return;
  return invoke("open_source_url", { url });
}

/** Native "open file" dialog for a settings export → absolute path (or null). */
export async function pickImportFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Settings export", extensions: ["json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** The active audio base folder for display (the user's custom base, or the default
 *  under the app data dir; a leading $HOME is shown as ~). Pass `audioBasePref(...)`. */
export async function audioDirPath(custom: string | null): Promise<string | null> {
  if (!isTauri) return null;
  return await invoke<string | null>("audio_dir_path", { custom });
}

/** Open the audio base folder in the system file manager (created, with its
 *  subfolders, if absent). */
export async function openAudioDir(custom: string | null): Promise<void> {
  if (!isTauri) return;
  await invoke("open_audio_dir", { custom });
}

