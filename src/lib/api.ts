// Bridge to the Rust core. Every call is guarded so the UI still runs in a plain
// browser (`pnpm dev`) — outside Tauri the calls no-op or return safe defaults.

import { invoke } from "@tauri-apps/api/core";
import type {
  AudioDevice,
  BatchResult,
  Capabilities,
  Config,
  ConnectionInfo,
  DecodeOverrides,
  FocusedApp,
  PipelineFetch,
  PipelineSaveResult,
  RecentWords,
  ResolvedOverrideProfile,
} from "./types";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadConfig(): Promise<Config | null> {
  if (!isTauri) return null;
  return invoke<Config>("load_config");
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

export async function stopMicTest(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_mic_test");
}

/** Subscribe to live RMS levels (0..1) emitted during capture. Returns an unlisten fn. */
export async function onAudioLevel(cb: (level: number) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<number>("audio://level", (e) => cb(e.payload));
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
    muteSystem: args.muteSystem ?? false,
  });
}

export async function stopRecord(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_record");
}

/** Re-register global hotkeys after the bindings change (or to restore them). */
export async function reregisterShortcuts(): Promise<void> {
  if (!isTauri) return;
  await invoke("reregister_shortcuts");
}

/** Suspend all global hotkeys while capturing a new binding (so a keypress only
 *  rebinds and doesn't also trigger dictation). Restore with reregisterShortcuts. */
export async function suspendShortcuts(): Promise<void> {
  if (!isTauri) return;
  await invoke("suspend_shortcuts");
}

/** Whether an accelerator (e.g. "Ctrl+Shift+Space") can be registered as a global shortcut. */
export async function validateShortcut(accelerator: string): Promise<boolean> {
  if (!isTauri) return true;
  return invoke<boolean>("validate_shortcut", { accelerator });
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

/** Insert text into the focused field of the active app. */
export async function injectText(args: {
  text: string;
  method: "paste" | "direct" | "clipboard";
  autoEnter: boolean;
  restoreClipboard: boolean;
  pasteShortcut: string[];
}): Promise<void> {
  if (!isTauri) return;
  await invoke("inject_text", {
    text: args.text,
    method: args.method,
    autoEnter: args.autoEnter,
    restoreClipboard: args.restoreClipboard,
    pasteShortcut: args.pasteShortcut,
  });
}

/** The focused app's id + title + (when deep detection is on) editability, via AT-SPI.
 *  null when nothing is known yet (no a11y bridge / cold listener). */
export async function getFocusedApp(): Promise<FocusedApp | null> {
  if (!isTauri) return null;
  return (await invoke<FocusedApp | null>("get_focused_app")) ?? null;
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

/**
 * Shape the overlay window's mouse input region to just the visible chip (logical
 * px, relative to the window's top-left), so the chip becomes hoverable while the
 * rest of the transparent strip stays click-through. No-op outside Tauri.
 */
export async function setChipHitRegion(x: number, y: number, w: number, h: number): Promise<void> {
  if (!isTauri) return;
  await invoke("set_chip_hit_region", { x, y, w, h });
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
  action: "start" | "stop" | "toggle";
}

/** Subscribe to dictation triggers (CLI / global hotkey). Returns an unlisten fn. */
export async function onTrigger(cb: (e: TriggerEvent) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TriggerEvent>("trigger", (e) => cb(e.payload));
}

/** Subscribe to system resume-from-suspend (emitted by the Rust suspend watcher).
 *  Returns an unlisten fn. */
export async function onSystemResumed(cb: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("system://resumed", () => cb());
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
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ kind: string }>("overlay://action", (e) => cb(e.payload.kind));
}

/** Subscribe (in the main window) to navigate requests from show_main_at_screen.
 *  Returns an unlisten fn. */
export async function onAppNavigate(cb: (screen: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("app://navigate", (e) => cb(e.payload));
}

/** Native "open file" dialog → absolute path (or null if cancelled / not in Tauri). */
export async function pickAudioFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Audio / Video",
        extensions: ["wav", "mp3", "m4a", "mp4", "aac", "ogg", "opus", "webm", "flac"],
      },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

/** Native "choose folder" dialog → absolute path (or null if cancelled / not in Tauri).
 *  Used to pick a custom recordings folder. */
export async function pickRecordingsDir(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** The active recordings folder for display (the user's custom folder, or the default
 *  under the app data dir; a leading $HOME is shown as ~). Pass the current custom value. */
export async function recordingsDirPath(custom: string | null): Promise<string | null> {
  if (!isTauri) return null;
  return await invoke<string | null>("recordings_dir_path", { custom });
}

/** Open the active recordings folder in the system file manager (created if absent). */
export async function openRecordingsDir(custom: string | null): Promise<void> {
  if (!isTauri) return;
  await invoke("open_recordings_dir", { custom });
}

/** Label a saved recording with its transcript — writes a sibling .txt next to the .wav.
 *  Best-effort: swallows errors (labeling must never disrupt dictation). */
export async function writeRecordingTranscript(wavPath: string, text: string): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("write_recording_transcript", { wavPath, text });
  } catch (e) {
    console.error("write recording transcript:", e);
  }
}
