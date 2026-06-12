// Bridge to the Rust core. Every call is guarded so the UI still runs in a plain
// browser (`pnpm dev`) — outside Tauri the calls no-op or return safe defaults.

import { invoke } from "@tauri-apps/api/core";
import type { AudioDevice, BatchResult, Config, ConnectionInfo } from "./types";

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

export async function setProfileKey(profileId: string, key: string): Promise<void> {
  if (!isTauri) return;
  await invoke("set_profile_key", { profileId, key });
}

export async function deleteProfileKey(profileId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("delete_profile_key", { profileId });
}

export async function testConnection(args: {
  serverUrl: string;
  profileId?: string | null;
  apiKey?: string | null;
}): Promise<ConnectionInfo> {
  if (!isTauri) {
    return { ok: false, openMode: false, models: [], error: "Not running in the desktop app." };
  }
  return invoke<ConnectionInfo>("test_connection", {
    serverUrl: args.serverUrl,
    profileId: args.profileId ?? null,
    apiKey: args.apiKey ?? null,
  });
}

export async function transcribeFile(args: {
  serverUrl: string;
  profileId?: string | null;
  apiKey?: string | null;
  model: string;
  language: string;
  prompt: string;
  filePath: string;
}): Promise<BatchResult> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke<BatchResult>("transcribe_file", {
    serverUrl: args.serverUrl,
    profileId: args.profileId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    prompt: args.prompt,
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
  profileId?: string | null;
  apiKey?: string | null;
  model: string;
  language: string;
  responseFormat: string;
  deviceId?: string | null;
}): Promise<void> {
  if (!isTauri) return;
  await invoke("start_stream", {
    serverUrl: args.serverUrl,
    profileId: args.profileId ?? null,
    apiKey: args.apiKey ?? null,
    model: args.model,
    language: args.language,
    responseFormat: args.responseFormat,
    deviceId: args.deviceId ?? null,
  });
}

export async function stopStream(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_stream");
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
