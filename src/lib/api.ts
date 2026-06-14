// Bridge to the Rust core. Every call is guarded so the UI still runs in a plain
// browser (`pnpm dev`) — outside Tauri the calls no-op or return safe defaults.

import { invoke } from "@tauri-apps/api/core";
import type { AudioDevice, BatchResult, Config, ConnectionInfo, DecodeOverrides } from "./types";

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
  prompt: string;
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
    prompt: args.prompt,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    filePath: args.filePath,
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
  prompt: string;
  responseFormat: string;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  deviceId?: string | null;
  save?: boolean;
  muteSystem?: boolean;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("start_stream", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt,
    responseFormat: args.responseFormat,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    deviceId: args.deviceId ?? null,
    save: args.save ?? false,
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
  prompt: string;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  deviceId?: string | null;
  save?: boolean;
  muteSystem?: boolean;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("start_record", {
    serverUrl: args.serverUrl,
    backendId: args.backendId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    deviceId: args.deviceId ?? null,
    save: args.save ?? false,
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

/** Insert text into the focused field of the active app. */
export async function injectText(args: {
  text: string;
  method: "paste" | "direct";
  autoEnter: boolean;
  restoreClipboard: boolean;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("inject_text", {
    text: args.text,
    method: args.method,
    autoEnter: args.autoEnter,
    restoreClipboard: args.restoreClipboard,
  });
}

/** Show + position the dictation chip overlay at the given screen edge. */
export async function showOverlay(position: "top" | "bottom"): Promise<void> {
  if (!isTauri) return;
  await invoke("show_overlay", { position });
}

/** Hide the dictation chip overlay. */
export async function hideOverlay(): Promise<void> {
  if (!isTauri) return;
  await invoke("hide_overlay");
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
