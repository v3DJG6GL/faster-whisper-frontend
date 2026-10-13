// Bridge to the Rust core. Every call is guarded so the UI still runs in a plain
// browser (`pnpm dev`) — outside Tauri the calls no-op or return safe defaults.

import { AUDIO_SOURCE_EXTS, TEXT_SOURCE_EXTS } from "./transcript/subtitleImport";
import { invoke } from "@tauri-apps/api/core";
import { safeDisplayText } from "./sanitize";
import { languageCodeOf } from "./languages";
import type {
  AppRule,
  PlanStage,
  BatchProgress,
  BatchResult,
  Capabilities,
  JobOutcome,
  JobStatus,
  Config,
  ConnectionInfo,
  DecodeOverrides,
  FocusedApp,
  InsertMethod,
  LogLevelSetting,
  MicInventory,
  PipelineFetch,
  PipelineSaveResult,
  RecentWords,
  DecodeDefaults,
  TranscribeOptions,
  UsageOutcome,
  UsageOutcomePostResult,
  UsageStats,
  UsageQuery,
} from "./types";
import type { UrlPreview } from "./urlSource";
import type { MediaExportProgress, MediaStreams } from "./transcript/mediaExport";
import type {
  ExportEnvelope,
  ImportResult,
  SyncBlob,
  SyncDeleteResult,
  SyncDeviceInfo,
  SyncPullResult,
  SyncPushResult,
  SyncState,
} from "./sync/syncTypes";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The server a command talks to: its URL plus whose key Rust resolves — the saved backend's
 *  keyring entry (`backendId`) or an explicit `apiKey` (a backend not saved yet). */
export interface ServerTarget {
  serverUrl: string;
  backendId?: string | null;
  apiKey?: string | null;
}

/** Invoke a server command with the target's three args (absent ones sent as null) ahead of
 *  `rest`. Outside Tauri it answers `offline` instead — or throws it, when that is an Error. */
async function invokeServer<T>(
  cmd: string,
  target: ServerTarget,
  rest: Record<string, unknown>,
  offline: T | Error,
): Promise<T> {
  if (!isTauri) {
    if (offline instanceof Error) throw offline;
    return offline;
  }
  return invoke<T>(cmd, {
    serverUrl: target.serverUrl,
    backendId: target.backendId ?? null,
    apiKey: target.apiKey ?? null,
    ...rest,
  });
}

/** The config plus whether Rust had to RECOVER it (backed up an unreadable/corrupt file to
 *  config.json.bak and returned defaults) — so the UI can warn the settings were reset. */
export interface LoadedConfig {
  config: Config;
  recovered: boolean;
  /** The reset happened but no config.json.bak could be made: Rust refuses every save this session. */
  backupFailed: boolean;
}

export async function loadConfig(): Promise<LoadedConfig | null> {
  if (!isTauri) return null;
  return invoke<LoadedConfig>("load_config");
}

export async function saveConfig(config: Config): Promise<void> {
  if (!isTauri) return;
  await invoke("save_config", { config });
}

/** Apply the in-memory switches `save_config` applies before its write (per-app "Remote desktop"
 *  rules, clipboard-history privacy, log level) without writing — for a save the webview holds
 *  back (the shortcut-conflict freeze), so push-to-talk, Quick-Add and clipboard writes keep
 *  following the live settings the paste path already uses, and the log records at the level
 *  Settings shows. */
export async function applyLiveSwitches(
  appRules: AppRule[],
  excludeFromClipboardHistory: boolean,
  logLevel: LogLevelSetting,
): Promise<void> {
  if (!isTauri) return;
  await invoke("apply_live_switches", { appRules, excludeFromClipboardHistory, logLevel });
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

/** Tell the core which screen the main window shows, for its periodic memory line
 *  (memwatch.rs) — a spike in the log then says where it happened. Fire and forget. */
export function noteRoute(path: string): void {
  if (!isTauri) return;
  void invoke("note_route", { path }).catch(() => {});
}

/** One line into the core's log file (`frontend_log` → `tracing` with the user's log
 *  level), for diagnostics that only the webview can see — the typed-baseline divergence
 *  and carry notes of live dictation. Rust keeps printable ASCII, caps `msg` at 300 chars
 *  and rejects a `tag` outside [a-z]{1,16}, so keep both plain. NEVER pass transcript text:
 *  the log is shared in bug reports. Fire and forget. */
export function logLine(level: "info" | "warn", tag: string, msg: string): void {
  if (!isTauri) return;
  void invoke("frontend_log", { level, tag, msg }).catch(() => {});
}

/** Whether Rust's built-in list recognises this app id as a remote-desktop client — the
 *  answer an App rule's "Auto" setting resolves to (the exe list only; the window-class
 *  check needs a live window and so can't be asked here). False outside the desktop app
 *  or on any error: the hint then reads "not a known client", which is the honest default. */
export async function remoteDesktopAutoDetected(appId: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return (await invoke<boolean>("remote_desktop_auto_detected", { appId })) === true;
  } catch {
    return false;
  }
}

export async function testConnection(args: ServerTarget): Promise<ConnectionInfo> {
  const offline = { ok: false, openMode: false, models: [], error: "Not running in the desktop app." };
  return invokeServer<ConnectionInfo>("test_connection", args, {}, offline);
}

/** A server result's language as tracks file it: a standard (OpenAI-compatible) server answers
 *  verbose_json's word ("english"), which every track reader would take for an unknown code. */
function withLanguageCode(r: BatchResult): BatchResult {
  return typeof r.language === "string" && r.language ? { ...r, language: languageCodeOf(r.language) } : r;
}

export async function transcribeFile(args: ServerTarget & {
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
  return invokeServer<BatchResult>("transcribe_file", args, {
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    filePath: args.filePath,
    options: args.options ?? null,
  }, new Error("Transcription requires the desktop app.")).then(withLanguageCode);
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
  /** The run plan's receipt for this request (one translating stage whose
   *  units are the targets) — the settled rail of a text-source run. */
  plan?: PlanStage[];
}

/** Translate segment texts (T2T, no audio): dictation settle-time
 *  translation, the viewer's re-translate, retro-translation, and
 *  subtitle/text-file sources. */
export async function translateText(args: ServerTarget & {
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
  /** The dictation session this translation belongs to — the same client-minted id the
   *  stream handshake sent as `client_job`. A stop-timing one-shot holds no capture, so
   *  this is what lets the server's log tie its receipt to the session's utterances. */
  clientJob?: string | null;
  /** Drop the request when cancelFileTranscription bumps Rust's epoch — the
   *  Transcribe pump's text-source path only. */
  fileEpochCancel?: boolean;
}): Promise<TextTranslationResult> {
  return invokeServer<TextTranslationResult>("translate_text", args, {
    texts: args.texts,
    targets: args.targets,
    source: args.source ?? null,
    model: args.model ?? null,
    mode: args.mode ?? null,
    glossary: args.glossary ?? null,
    contextSegments: args.contextSegments ?? null,
    progressId: args.progressId ?? null,
    capturedId: args.capturedId ?? null,
    clientJob: args.clientJob ?? null,
    cancelWithFileEpoch: args.fileEpochCancel ?? null,
  }, new Error("Translation requires the desktop app."));
}

/** Tell the SERVER to abort the in-flight text translation behind
 *  `progressId` (the cancel endpoint is shared with batch transcription).
 *  Best-effort — an older backend just answers 404. */
export async function cancelTextTranslation(args: ServerTarget & {
  progressId: string;
}): Promise<void> {
  await invokeServer<void>("cancel_text_translation", args, {
    progressId: args.progressId,
  }, undefined);
}

/** Transcribe a pasted media link: the SERVER downloads the audio (yt-dlp)
 *  and runs the normal pipeline. Full backend only (url_download_enabled). */
export async function transcribeUrl(args: ServerTarget & {
  model: string;
  language: string;
  prompt?: string | null;
  decodeOverrides?: DecodeOverrides | null;
  overrideProfile?: string | null;
  sourceUrl: string;
  options?: TranscribeOptions | null;
}): Promise<BatchResult> {
  return invokeServer<BatchResult>("transcribe_url", args, {
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    sourceUrl: args.sourceUrl,
    options: args.options ?? null,
  }, new Error("Transcription requires the desktop app.")).then(withLanguageCode);
}

/** Metadata preview of a pasted media link (title/duration/thumbnail) —
 *  debounced from the URL field. Advisory: a failed preview never blocks
 *  adding the link; the run itself is the authority. */
export async function urlPreview(args: ServerTarget & {
  url: string;
}): Promise<UrlPreview> {
  return invokeServer<UrlPreview>("url_preview", args, {
    url: args.url,
  }, new Error("Not running in the desktop app."));
}

// ── Media export (audio / video / video + subtitle tracks) ─────────────────

export interface SubtitleTrackIn {
  lang: string;
  label?: string;
  srt: string;
  /** Per-track flags (servers before them ignore the keys): written in the
   *  spoken language, its language's default track, hearing-impaired. */
  original?: boolean;
  default?: boolean;
  hearingImpaired?: boolean;
}
export type PackageOutcomeKind =
  | "ok" | "expired" | "mp4_incompatible" | "no_video" | "too_large"
  | "rate_limited" | "busy" | "disabled" | "cancelled" | "error";
export interface PackageOutcome {
  /** "busy" = this user's export slot is taken (another device): retry later
   *  (queueMediaExport does). */
  kind: PackageOutcomeKind;
  detail: string;
  bytes: number;
  /** "ok": the packaged server copy. "busy" or any other failed package after a
   *  local file was uploaded: that upload's server copy, so a retry (or "Save as
   *  MKV") skips the upload. */
  mediaId: string | null;
  expiresAt: number | null;
  reason: string | null;
}

/** Package a retained (or local) video with subtitle tracks straight to
 *  `destPath`: uploads a local file first (streamed), then muxes on the
 *  server and streams the result down. Progress on onMediaExportProgress
 *  filtered by `jobId`; cancel with cancelMediaExport. */
export async function packageMedia(args: ServerTarget & {
  jobId: string;
  sourceMediaId?: string | null;
  sourcePath?: string | null;
  container: "mkv" | "mp4";
  subtitles: SubtitleTrackIn[];
  defaultTrack: number | null;
  /** Index of the original-language track (Matroska FlagOriginal). */
  originalTrack: number | null;
  /** The spoken language, tagged onto every audio stream. */
  audioLang?: string | null;
  audioLabel?: string | null;
  destPath: string;
  filename: string;
  maxUploadBytes?: number | null;
  /** The custom audio base (`audioBasePref`), so an export folder under it counts as app
   *  storage and is refused. */
  audioBase?: string | null;
}): Promise<PackageOutcome> {
  return invokeServer<PackageOutcome>("package_media", args, {
    jobId: args.jobId,
    sourceMediaId: args.sourceMediaId ?? null,
    sourcePath: args.sourcePath ?? null,
    container: args.container,
    subtitles: args.subtitles,
    defaultTrack: args.defaultTrack,
    originalTrack: args.originalTrack,
    audioLang: args.audioLang ?? null,
    audioLabel: args.audioLabel ?? null,
    destPath: args.destPath,
    filename: args.filename,
    maxUploadBytes: args.maxUploadBytes ?? null,
    audioBase: args.audioBase ?? null,
  }, new Error("Video export requires the desktop app."));
}

export async function cancelMediaExport(): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_media_export");
}

/** Subscribe to export progress events; returns the unsubscribe. */
export async function onMediaExportProgress(
  cb: (p: MediaExportProgress) => void,
): Promise<() => void> {
  return subscribe<MediaExportProgress>("media://export-progress", cb);
}

/** Codec facts for a retained file; null when the server no longer has it. */
export async function getMediaStreams(args: ServerTarget & {
  mediaId: string;
}): Promise<MediaStreams | null> {
  return invokeServer<MediaStreams | null>("get_media_streams", args, {
    mediaId: args.mediaId,
  }, null);
}

/** Plain copy of one of a record's media files (source, audio copy or
 *  video copy) to a user-picked path. Returns the bytes copied; null when
 *  `noClobber` is set and something already sits at `dest` (left untouched). */
export async function copyMediaTo(args: {
  src: string;
  dest: string;
  recordId: string;
  audioBase?: string | null;
  noClobber?: boolean;
}): Promise<number | null> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<number | null>("copy_media_to", {
    src: args.src,
    dest: args.dest,
    recordId: args.recordId,
    audioBase: args.audioBase ?? null,
    noClobber: args.noClobber ?? false,
  });
}

/** Pull the server-retained VIDEO of a link run into the local media store
 *  (video/<recordId>.<ext>). Null when the server no longer has it. */
export async function fetchUrlVideo(args: ServerTarget & {
  mediaId: string;
  recordId: string;
  audioBase?: string | null;
}): Promise<string | null> {
  return invokeServer<string | null>("fetch_url_video", args, {
    mediaId: args.mediaId,
    recordId: args.recordId,
    audioBase: args.audioBase ?? null,
  }, null);
}

/** What the server answers when a link's video or audio was fetched on demand. */
export interface UrlMediaDownload {
  mediaId: string;
  expiresAt: number | null;
  height: number | null;
  container: string | null;
  bytes: number | null;
  /** Audio only: the file's extension ("m4a"). */
  ext?: string | null;
}

/** Fetch a link's VIDEO on demand (a run that did not keep it, or whose copy
 *  expired) into the server's media store; the id can then be pulled with
 *  fetchUrlVideo. Long-running: progress via getTranscribeProgress on
 *  `progressId` (stage downloading + the `video` sub-object). */
export async function fetchUrlVideoOnDemand(args: ServerTarget & {
  url: string;
  maxHeight?: number | null;
  formatId?: string | null;
  progressId?: string | null;
}): Promise<UrlMediaDownload> {
  return invokeServer<UrlMediaDownload>("url_video_download", args, {
    url: args.url,
    maxHeight: args.maxHeight ?? null,
    formatId: args.formatId ?? null,
    progressId: args.progressId ?? null,
  }, new Error("Video download requires the desktop app."));
}

/** Fetch a link's AUDIO on demand into the server's media store — a run whose
 *  transcript comes from the site's subtitles still keeps the audio; pull it
 *  with fetchUrlMedia. */
export async function fetchUrlAudioOnDemand(args: ServerTarget & {
  url: string;
  progressId?: string | null;
}): Promise<UrlMediaDownload> {
  return invokeServer<UrlMediaDownload>("url_audio_download", args, {
    url: args.url,
    progressId: args.progressId ?? null,
  }, new Error("Audio download requires the desktop app."));
}

/** What POST /v1/audio/url-subtitles answers: the raw VTT/SRT text of each
 *  fetched track, and the ones that failed with a client-safe reason. */
export interface UrlSubtitles {
  tracks: { id: string; lang: string; kind: "manual" | "auto"; ext: "vtt" | "srt"; text: string }[];
  failed: { id: string; error: string }[];
}

/** Download a link's picked subtitle tracks (≤ 8 ids from its preview). */
export async function fetchUrlSubtitles(args: ServerTarget & {
  url: string;
  tracks: string[];
}): Promise<UrlSubtitles> {
  return invokeServer<UrlSubtitles>("url_subtitles", args, {
    url: args.url,
    tracks: args.tracks,
  }, new Error("Subtitle download requires the desktop app."));
}

/** What POST /v1/audio/url-language answers: the vote over three sampled
 *  pieces, plus the downloaded audio a run can reuse (prefetchedMediaId). */
export interface UrlLanguageCheck {
  language: string | null;
  probability: number;
  verdict: "detected" | "mixed" | "unknown";
  also: string[];
  pieces: { at: number; language: string | null; probability: number }[];
  mediaId: string | null;
  mediaExpiresAt: number | null;
}

/** Which language does this link speak? Slow (the server downloads the audio
 *  first); cancel with cancelTextTranslation on the same `progressId`. */
export async function urlLanguageCheck(args: ServerTarget & {
  url: string;
  model?: string | null;
  progressId?: string | null;
}): Promise<UrlLanguageCheck> {
  return invokeServer<UrlLanguageCheck>("url_language_check", args, {
    url: args.url,
    model: args.model ?? null,
    progressId: args.progressId ?? null,
  }, new Error("The language check requires the desktop app."));
}

/** Pull the server-retained audio of a finished URL run into the local media
 *  store (<base>/links/<recordId>.<ext>). Returns the local path, or null when the
 *  server no longer has the file (retention expired) — the transcript stays
 *  usable, only playback is gone. */
export async function fetchUrlMedia(args: ServerTarget & {
  mediaId: string;
  recordId: string;
  audioBase?: string | null;
}): Promise<string | null> {
  return invokeServer<string | null>("fetch_url_media", args, {
    mediaId: args.mediaId,
    recordId: args.recordId,
    audioBase: args.audioBase ?? null,
  }, null);
}

/** Abort every in-flight file transcription (Transcribe screen's Cancel). */
export async function cancelFileTranscription(): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_file_transcription");
}

/** Tell the SERVER to abort the in-flight transcription behind `progressId`
 *  (cancelFileTranscription only drops our end of the connection — without
 *  this the server's pipeline runs to completion). Best-effort. */
export async function cancelBackendTranscription(args: ServerTarget & {
  progressId: string;
}): Promise<void> {
  await invokeServer<void>("cancel_backend_transcription", args, {
    progressId: args.progressId,
  }, undefined);
}

/** Poll the live progress of an in-flight file transcription. */
export async function getTranscribeProgress(args: ServerTarget & {
  progressId: string;
}): Promise<BatchProgress> {
  return invokeServer<BatchProgress>("get_transcribe_progress", args, {
    progressId: args.progressId,
  }, new Error("Not running in the desktop app."));
}

/** Names of server-side override-profiles a client may reference (full backend
 *  only). Best-effort: returns [] outside Tauri or on any error. */
export async function listOverrideProfiles(args: ServerTarget): Promise<string[]> {
  return invokeServer<string[]>("list_override_profiles", args, {}, []);
}

/** The caller's effective request-override capabilities (full backend only).
 *  Best-effort: null outside Tauri or on any error (endpoint absent / standard
 *  server / unreachable) — callers treat null as "unknown ⇒ assume permitted". */
export async function getCapabilities(args: ServerTarget): Promise<Capabilities | null> {
  return invokeServer<Capabilities | null>("get_capabilities", args, {}, null);
}

/** A model family the server can pre-warm. There is deliberately no `vad`
 *  member — the backend contract has no such family and rejects unknown ones. */
export type PreloadFamily = "whisper" | "diarization" | "separation" | "translation";

/** Ask the server to start warming the models a job will need
 *  (POST /v1/models/preload, full backend only). Best-effort: `false` outside
 *  Tauri or on any error — an older backend that 404s this endpoint must be
 *  indistinguishable from one that honours it, so no caller may branch on it
 *  beyond deciding not to retry. Never throws. */
export async function preloadModels(args: ServerTarget & {
  models: { family: PreloadFamily; id: string }[];
}): Promise<boolean> {
  try {
    return await invokeServer<boolean>("preload_models", args, { models: args.models }, false);
  } catch {
    return false;
  }
}

/** The decode values the caller inherits from the server for one model and override profile
 *  (GET /v1/request-default-settings) — the "Inherit · <value>" labels. `model` "" = the server's default
 *  model; `overrideProfile` is what the request would name (NO_OVERRIDE_PROFILE included).
 *  Best-effort: null outside Tauri or on any error. */
export async function getDecodeDefaults(args: ServerTarget & {
  model: string;
  overrideProfile?: string | null;
}): Promise<DecodeDefaults | null> {
  return invokeServer<DecodeDefaults | null>("get_decode_defaults", args, {
    model: args.model,
    overrideProfile: args.overrideProfile?.trim() || null,
  }, null);
}

/** P17: the post-processing ("Dictionary") rules the caller may view + edit
 *  (GET /v1/pipeline-rules). Returns a structured result with the HTTP status so
 *  the screen can branch (see PipelineFetch: `ok` = state present, 0 = unreachable,
 *  401/403 = gated, 404 = standard/old server). Outside Tauri → an unreachable result. */
export async function getPipelineRules(args: ServerTarget): Promise<PipelineFetch> {
  return invokeServer<PipelineFetch>("get_pipeline_rules", args, {}, { ok: false, status: 0, error: "Not running in the desktop app." });
}

/** P18: recently-transcribed word/phrase suggestions for the Dictionary's
 *  spoken-symbol key field (GET /v1/recent-words), scoped to the Backend's API
 *  key via the keyring. Best-effort: `{ words: [] }` outside Tauri or on any
 *  error (old/standard server, no history) — the field just becomes a plain input. */
export async function getRecentWords(args: ServerTarget): Promise<RecentWords> {
  return invokeServer<RecentWords>("get_recent_words", args, {}, { words: [] });
}

/** P28: the caller's own usage document (GET /v1/usage) — per-kind today/total,
 *  the daily series, stages, dictation facets, apps, calendar and streak — for the
 *  Home strip, the Statistics page and the optional chip readout. Best-effort: null
 *  outside Tauri or on any error (endpoint absent / standard server / unreachable) —
 *  callers hide the stats surfaces when null. `tz` is the viewer's IANA zone so the
 *  server reckons "today" (and DST) the way the viewer does; `days` = the window. */
export async function getUsageStats(args: ServerTarget & {
  query: UsageQuery;
}): Promise<UsageStats | null> {
  return invokeServer<UsageStats | null>("get_usage_stats", args, {
    query: {
      days: args.query.days ?? null,
      from: args.query.from ?? null,
      to: args.query.to ?? null,
      all: args.query.all ?? false,
      with: args.query.with ?? [],
      tz: args.query.tz ?? null,
    },
  }, null);
}

/** Report end-of-dictation outcomes (POST /v1/usage/outcome). Never throws — a
 *  structured result whose `status` (0 = unreachable) drives the queue's retry/drop
 *  decision (lib/usageOutcome.ts). */
export async function postUsageOutcomes(args: ServerTarget & {
  outcomes: UsageOutcome[];
}): Promise<UsageOutcomePostResult> {
  return invokeServer<UsageOutcomePostResult>("post_usage_outcomes", args, {
    outcomes: args.outcomes,
  }, { ok: false, status: 0, error: "Not running in the desktop app.", results: [] });
}

/** `GET /v1/jobs/{id}` — a server job row, with the live progress while in
 *  flight. Deliberately NOT tied to the file-transcribe cancel epoch: a late
 *  re-attach must survive an unrelated cancel. */
export async function getJob(args: ServerTarget & {
  jobId: string;
}): Promise<JobOutcome<JobStatus>> {
  return invokeServer<JobOutcome<JobStatus>>("get_job", args, {
    jobId: args.jobId,
  }, { kind: "error", message: "Not running in the desktop app." });
}

/** `GET /v1/jobs/{id}/result` — the stored payload as the BatchResult the
 *  POST would have returned (same conversion + bounding in Rust). */
export async function getJobResult(args: ServerTarget & {
  jobId: string;
}): Promise<JobOutcome<BatchResult>> {
  const o = await invokeServer<JobOutcome<BatchResult>>("get_job_result", args, {
    jobId: args.jobId,
  }, { kind: "error", message: "Not running in the desktop app." });
  return o.kind === "ok" ? { ...o, value: withLanguageCode(o.value) } : o;
}

/** `DELETE /v1/jobs/{id}` — cancel a running job or delete a finished one. */
export async function deleteJob(args: ServerTarget & {
  jobId: string;
}): Promise<JobOutcome<null>> {
  return invokeServer<JobOutcome<null>>("delete_job", args, {
    jobId: args.jobId,
  }, { kind: "error", message: "Not running in the desktop app." });
}

/** The on-disk in-flight jobs ledger (opaque to Rust; shape owned by lib/jobsLedger.ts). */
export async function loadJobsLedger(): Promise<unknown> {
  if (!isTauri) return null;
  return invoke<unknown>("load_jobs_ledger");
}

export async function saveJobsLedger(ledger: unknown): Promise<void> {
  if (!isTauri) return;
  await invoke("save_jobs_ledger", { ledger });
}

/** The on-disk outcome queue (opaque to Rust; shape owned by lib/usageOutcome.ts). */
export async function loadUsageOutcomes(): Promise<unknown> {
  if (!isTauri) return null;
  return invoke<unknown>("load_usage_outcomes");
}

export async function saveUsageOutcomes(queue: unknown): Promise<void> {
  if (!isTauri) return;
  await invoke("save_usage_outcomes", { queue });
}

/** P17: apply a per-rule patch (PATCH /v1/pipeline-rules). `patch` is the
 *  {rules_patch, fingerprints} object built from the user's edits. Returns
 *  saved / conflicts / requires_restart, plus 422 `errors` or a 400/403/500
 *  `detail`. A 2xx with `ok: false` LANDED (see PipelineSaveResult): branch on
 *  `saveLanded`, not `ok`. */
export async function savePipelineRules(args: ServerTarget & {
  patch: {
    rules_patch: Record<string, Record<string, unknown>>;
    fingerprints?: Record<string, string>;
  };
}): Promise<PipelineSaveResult> {
  const offline = {
    ok: false,
    status: 0,
    saved: [],
    conflicts: [],
    requires_restart: false,
    detail: "Not running in the desktop app.",
  };
  return invokeServer<PipelineSaveResult>("save_pipeline_rules", args, { patch: args.patch }, offline);
}

const NO_MICS: MicInventory = {
  server: null,
  defaultLabel: null,
  mics: [],
  otherPaths: [],
  advancedSupported: false,
};

/** The microphone list. `includePaths` adds every raw ALSA path per mic (Linux, advanced). */
export async function listAudioDevices(includePaths = false): Promise<MicInventory> {
  if (!isTauri) return NO_MICS;
  return invoke<MicInventory>("list_audio_devices", { includePaths });
}

/** Map a microphone saved by display name (older settings) to today's id + name; null while
 *  that mic isn't connected. */
export async function resolveLegacyMic(name: string): Promise<{ id: string; label: string } | null> {
  if (!isTauri) return null;
  return invoke<{ id: string; label: string } | null>("resolve_legacy_mic", { name });
}


// Mic-test start/stop run on Rust's blocking pool and meet on a non-FIFO mutex, so two in
// flight could apply out of order — a stale stop landing after a newer start kills the new test
// with the UI still on "testing". Issue each only once the previous one settled.
let micTestChain: Promise<unknown> = Promise.resolve();
function inMicTestOrder<T>(op: () => Promise<T>): Promise<T> {
  const run = micTestChain.then(op);
  micTestChain = run.catch(() => {});
  return run;
}

/** `onIssued` runs when the start actually goes out, i.e. after every earlier start/stop settled
 *  (and so after a replaced capture was joined and had sent its last event). */
export async function startMicTest(deviceId: string | null, onIssued?: () => void): Promise<void> {
  if (!isTauri) return;
  await inMicTestOrder(() => {
    onIssued?.();
    return invoke("start_mic_test", { deviceId });
  });
}

/** Stop the mic test; resolves to the number of seconds captured (0 = nothing). */
export async function stopMicTest(): Promise<number> {
  if (!isTauri) return 0;
  return inMicTestOrder(() => invoke<number>("stop_mic_test"));
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
 *  return (which would throw, not no-op, in non-Tauri `pnpm dev`). Returns the unlisten fn.
 *  Exported for the aux windows (Overlay, QuickAdd, LangPick) that listen to their own events. */
export async function subscribe<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

/** Fires when a mic-test replay finishes (and wasn't superseded), so the UI can
 *  clear its "playing" state. Returns an unlisten fn. */
export async function onMicTestPlayEnded(cb: () => void): Promise<() => void> {
  return subscribe<unknown>("audio://test-play-ended", () => cb());
}

/** Fires when the mic test ended on its own rather than by a stop call: `"device-lost"` (the mic
 *  vanished or kept erroring) or `"open-failed"` (a slow open failed after the start already
 *  resolved). Returns an unlisten fn. */
export async function onMicTestEnded(cb: (reason: string) => void): Promise<() => void> {
  return subscribe<string>("audio://test-ended", (reason) => cb(reason));
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

/** A fresh value per call: returned on the non-Tauri path, where a shared mutable
 *  constant would let one caller's mutation leak into every later call. */
const emptyTail = (): LogTail => ({ lines: [], errors: 0, warns: 0, seq: 0 });

/** The ring's contents from `sinceSeq` on (0 = everything captured so far). */
export async function getLogTail(sinceSeq: number): Promise<LogTail> {
  if (!isTauri) return emptyTail();
  return invoke<LogTail>("get_log_tail", { sinceSeq });
}

/** Gate the batched `log://lines` stream — on while the Logs screen is open. */
export async function setLogStream(active: boolean): Promise<void> {
  if (!isTauri) return;
  return invoke("set_log_stream", { active });
}

/** Badge hydration at startup: counters only, no lines. */
export async function getLogStatus(): Promise<LogTail> {
  if (!isTauri) return emptyTail();
  return invoke<LogTail>("get_log_status");
}

/** Display path of the log folder (home-relative where possible). `custom` = the live
 *  log-folder preference (null/blank = the default folder); the on-disk config lags the
 *  debounced save, so the command never falls back to it. */
export async function logFolderPath(custom: string | null): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string>("log_folder_path", { custom }).catch(() => null);
}

// One Open-folder call per folder at a time, shared by every caller: the commands block on a
// stalled mount with no timeout, and the buttons that gate them are per-mount (Settings unmounts
// on navigation, the Logs screen has its own button) — a second call queued behind the first
// pops a second file-manager window when the mount answers. A later click joins the pending
// call (and hears its answer); a different folder still gets its own call, the way out of a hung
// share. Keyed by the preference as passed (null and blank both mean the default folder).
// `onFail` logs the failure here, once per real call: every joined click hears the same
// rejection, and a warn line per caller would read as several failed attempts.
const openLogInFlight = new Map<string, Promise<void>>();
const openAudioInFlight = new Map<string, Promise<void>>();
function openOnce(
  inFlight: Map<string, Promise<void>>,
  custom: string | null,
  run: () => Promise<unknown>,
  onFail: () => void,
): Promise<void> {
  const k = custom ?? "";
  const pending = inFlight.get(k);
  if (pending) return pending;
  const p: Promise<void> = run()
    .then(
      () => {},
      (e: unknown) => {
        onFail();
        throw e;
      },
    )
    .finally(() => {
      if (inFlight.get(k) === p) inFlight.delete(k);
    });
  inFlight.set(k, p);
  return p;
}

export async function openLogFolder(custom: string | null): Promise<void> {
  if (!isTauri) return;
  // Path-free: the log is pasted into bug reports.
  return openOnce(
    openLogInFlight,
    custom,
    () => invoke("open_log_folder", { custom }),
    () => logLine("warn", "logs", "could not open the log folder"),
  );
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

export async function startStream(args: ServerTarget & {
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
  translateExpect?: {
    targets: string[];
    include_original: boolean;
    /** Whether a translate request will arrive for EVERY utterance (live
     *  mode) or once for the whole transcript (stop-timing). The server holds
     *  a log receipt open per utterance only in the first case — in the second
     *  nothing would ever claim them and they would all release on the idle
     *  timeout. Absent on older clients, where the server assumes per-utterance
     *  because that is what it already did. */
    per_utterance: boolean;
  } | null;
  /** Client-minted session id (32 hex) → the handshake's `client_job`, so the server
   *  counts this session as ONE run and the post-session outcome can name it. */
  clientJob?: string | null;
  deviceId?: string | null;
  save?: boolean;
  recordingsDir?: string | null;
  trimSilence?: boolean;
  /** When saving: one `.wav` per finished utterance (`dictation-<stamp>-u<n>.wav`) instead of
   *  one per session — live hands-free sessions keep one History record per utterance. */
  perUtteranceClips?: boolean;
  muteSystem?: boolean;
}): Promise<void> {
  await invokeServer<void>("start_stream", args, {
    model: args.model,
    language: args.language,
    prompt: args.prompt ?? null,
    responseFormat: args.responseFormat,
    decodeOverrides: args.decodeOverrides ?? null,
    overrideProfile: args.overrideProfile ?? null,
    translateExpect: args.translateExpect ?? null,
    clientJob: args.clientJob ?? null,
    deviceId: args.deviceId ?? null,
    save: args.save ?? false,
    recordingsDir: args.recordingsDir ?? null,
    trimSilence: args.trimSilence ?? true,
    perUtteranceClips: args.perUtteranceClips ?? false,
    muteSystem: args.muteSystem ?? false,
  }, undefined);
}

export async function stopStream(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_stream");
}

/** Hard-abort the stream session WITHOUT draining (no wasted server work; releases the system mute).
 *  Used by cancelLive (`userInitiated: true` — also aborts a transcript already being typed, even
 *  in stop-timing mode where the session is long gone), and as the closed-handler's idempotent
 *  release of a parked session (`false`, so the end-of-session insert queued moments later lives).
 *  `discardRecording`: a user's Cancel after stop also drops the recording the detached drain
 *  would save (the batch path's rule); a recovery cancel passes false to keep that audio.
 *  The one exception to "without draining": a recovery cancel (`userInitiated` true,
 *  `discardRecording` false) FINISHES a live session when "Keep recordings" is on, so its drain
 *  writes the recording (its UI events epoch-silenced); with it off the session is aborted like a
 *  Cancel. Either way it settles a detached drain so its keep is final. */
export async function cancelStream(userInitiated = false, discardRecording = userInitiated): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_stream", { userInitiated, discardRecording });
}

export async function startRecord(args: ServerTarget & {
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
  /** Plain OpenAI-compatible server — an "auto" language is omitted, not sent empty. */
  standard?: boolean;
}): Promise<void> {
  await invokeServer<void>("start_record", args, {
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
    standard: args.standard ?? false,
  }, undefined);
}

export async function stopRecord(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_record");
}

/** Hard-abort the record session WITHOUT transcribing (no wasted server POST; releases the system
 *  mute), except for a recovery cancel (`userInitiated` true, `discardRecording` false), which
 *  finishes a live session when its recording is kept (see below). Used by cancelLive
 *  (`userInitiated: true`), and as the closed-handler's idempotent release of a parked session,
 *  which calls with the defaults (`userInitiated` false, `discardRecording` true — unlike
 *  `cancelStream`, whose `discardRecording` default follows `userInitiated`): a parked live
 *  session is discarded, which is safe because a device-loss salvage has already written its
 *  .wav/.txt before the `closed` that triggers the release.
 *  `discardRecording`: a cancel during "transcribing…" disowns the detached transcription and
 *  its saved .wav/.txt; a recovery cancel passes false to keep them. With false a LIVE session
 *  is finished, not discarded (`cancelStream`'s rule), when "Keep recordings" is on: its clip is
 *  transcribed and its .wav/.txt written, its UI events epoch-silenced, and a device-loss salvage
 *  already under way keeps its own .wav/.txt. With recordings off it is discarded: the live clip
 *  is not uploaded, and a device-loss salvage is stopped unless its upload had already started
 *  (then only its result is dropped). */
export async function cancelRecord(userInitiated = false, discardRecording = true): Promise<void> {
  if (!isTauri) return;
  await invoke("cancel_record", { userInitiated, discardRecording });
}

/** Retire the active session epoch WITHOUT draining/aborting — the error/fatal-inject teardown keeps
 *  its draining stop (sidecar still written) but uses this so the detached drain's late final/closed
 *  can't bleed onto a session re-triggered during the error linger. */
export async function retireSessionEpoch(): Promise<void> {
  if (!isTauri) return;
  await invoke("retire_session_epoch");
}

// Suspend/re-register run on Rust's blocking pool and meet on the non-FIFO APPLY_LOCK, so two in
// flight could apply out of order — a suspend landing after its paired re-register would leave
// capture suspension on with every hotkey dead. Issue each only once the previous one settled.
let shortcutChain: Promise<unknown> = Promise.resolve();
function inShortcutOrder<T>(op: () => Promise<T>): Promise<T> {
  const run = shortcutChain.then(op);
  shortcutChain = run.catch(() => {});
  return run;
}

/** Re-register global hotkeys after the bindings change (or to restore them). */
export async function reregisterShortcuts(): Promise<void> {
  if (!isTauri) return;
  await inShortcutOrder(() => invoke("reregister_shortcuts"));
}

/** Like reregisterShortcuts, but a no-op while a binding capture is in progress — used by
 *  cancelLive's resume-recovery so cancelling a session on system://resumed can't re-arm the
 *  hotkeys (and clear the capture suspension) mid-capture. */
export async function reregisterShortcutsUnlessCapturing(): Promise<void> {
  if (!isTauri) return;
  await inShortcutOrder(() => invoke("reregister_shortcuts_unless_capturing"));
}

/** Suspend all global hotkeys while capturing a new binding (so a keypress only
 *  rebinds and doesn't also trigger dictation). Restore with reregisterShortcuts. */
export async function suspendShortcuts(): Promise<void> {
  if (!isTauri) return;
  await inShortcutOrder(() => invoke("suspend_shortcuts"));
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
  /** The text landed — typed, pasted, or deliberately left on the clipboard. False means no key
   *  or chord went out and the transcript was not delivered: do not advance a typed baseline,
   *  there is nothing to recover, and the phrase must go out again (a re-send is safe). That
   *  invariant is the contract; the causes today are one of our own windows holding focus, so the
   *  insert was skipped (at entry or at a sink — at a Wayland paste chord only when a user cancel
   *  landed during one of its own-window probes (the chord-time probe or the portal job's pre-job
   *  probe), otherwise it is a divert), or a clipboard write that was busy or failed before any
   *  keystroke: on the clipboard-only, divert or recovery path, or at the paste sink (on Windows:
   *  a quick-add copy grab still held the clipboard after 8 s, a stuck clipboard read still held
   *  it, or the remote-desktop owner or legacy write failed or timed out — a timed-out offer may
   *  still reach the clipboard later); or an insert marked `withholdOnDivert` (the hard-break
   *  separator) that would otherwise have been diverted, or recovered after a sink that wrote
   *  nothing, before anything was written: nothing is written, and that caller drops it rather
   *  than re-sending. A cancel (user or error abort) before the write is not a `false` cause: it
   *  stops the insert with `landed: true` and nothing written, like any cancelled insert. */
  landed: boolean;
  /** Rust diverted to the clipboard against what we asked for — the trigger chord was still held,
   *  focus had moved to a different app, one of our own windows took focus just before the paste
   *  chord, the active keyboard layout cannot type the transcript's letters (Wayland portal
   *  typing), or a failed session's transcript was recovered to the clipboard after the sink
   *  wrote nothing. A recovery after a cancel bail or a partly typed phrase still reports
   *  `landed: true, diverted: false` — Rust cannot tell whether a key already went out. The text
   *  is safe but did not go where the user was looking, so say so rather than stamping a green
   *  "typed" confirmation over it. */
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
  /** The app rule's remote-desktop override (`resolveInjectionTarget().remoteDesktop`):
   *  true/false force the remote paste path (longer settle, no clipboard restore) on or off,
   *  null lets Rust auto-detect from the exe / window class. REQUIRED on purpose — an
   *  optional field is the one a new call site forgets, and forgetting it here would
   *  silently ignore the user's rule. Pass null where no target was resolved. */
  remoteDesktop: boolean | null;
  /** The CLIPBOARD form of `text`, when it differs from what goes into the field: a translated
   *  live block without the field's phrase gap, or a typed untranslated phrase without its
   *  leading seam space (it is pasted somewhere new). The clipboard-only method sends none — it
   *  copies its own trimmed window. Every Rust arm that leaves the transcript on the clipboard for
   *  the user — the clipboard-only write, a divert, a failed paste, an error-abort recovery —
   *  writes this in place of `text`; the field still gets `text`. Omit for "the same as `text`". */
  clipboardText?: string;
  /** Nothing here is worth leaving on the clipboard (the hard-break separator): `text` never
   *  becomes the clipboard's persistent owner. Before anything is written, a divert or recovery
   *  that would put it there (trigger chord still held, focus moved, an own window at a Wayland
   *  chord, the Wayland portal's letters-not-on-the-layout divert, the error-abort recovery after
   *  a sink that wrote nothing) writes nothing and reports `landed: false, diverted: false`; a
   *  cancel (user or error abort) stops it with `landed: true` and nothing written, like any
   *  cancelled insert. Once the paste write has put it on the clipboard (the chord-time own-window
   *  divert, an error abort cancelling the paste) it reports `landed: true, diverted: false`, and
   *  the user's copy is given back as for a pasted one. A failed paste rejects, and Rust restores
   *  nothing for it unless `restoreClipboard` is set — the separator's caller gives the user's
   *  copy back from its own snapshot. Omit for the normal divert. */
  withholdOnDivert?: boolean;
}): Promise<InjectOutcome> {
  if (!isTauri) return { landed: true, diverted: false };
  return await invoke<InjectOutcome>("inject_text", {
    text: args.text,
    method: args.method,
    autoEnter: args.autoEnter,
    restoreClipboard: args.restoreClipboard,
    pasteShortcut: args.pasteShortcut,
    expectAppId: args.expectAppId ?? null,
    remoteDesktop: args.remoteDesktop ?? null,
    clipboardText: args.clipboardText ?? null,
    withholdOnDivert: args.withholdOnDivert ?? false,
  });
}

/** Put a stop-mode transcript the session could not deliver on the clipboard for the user to
 *  paste, and say whether the write succeeded. Unlike `injectText` with the clipboard method, no
 *  own-window guard: these recoveries fire exactly while one of our windows may hold focus, and
 *  the user is told the text is on the clipboard. */
export async function recoverTextToClipboard(text: string): Promise<boolean> {
  if (!isTauri) return false;
  return await invoke<boolean>("recover_to_clipboard", { text });
}

/** The focused app's id + title + (when deep detection is on) editability, via AT-SPI.
 *  null when nothing is known yet (no a11y bridge / cold listener). */
export async function getFocusedApp(): Promise<FocusedApp | null> {
  if (!isTauri) return null;
  return (await invoke<FocusedApp | null>("get_focused_app")) ?? null;
}

/** Whether ALL of this chord's modifier keys are physically held right now, per the
 *  low-level hotkey backends' shared HeldKeys signal (hotkeys::evdev / hotkeys::windows; always false
 *  when only the plugin backend runs, or when the chord has no modifiers — non-modifier
 *  members are ignored, projected onto the modifier subset for cross-backend parity
 *  (held_keys::modifier_code)). Consumer: the queued fast re-press start — fire only while
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
 *  anchored flush against that edge; the resting inset and edge-peek are pure CSS (Overlay.tsx).
 *  `scale` is the "Chip size" factor: Rust clamps it and applies it as the overlay webview's
 *  zoom, so the chip's own layout never sees it. */
export async function showOverlay(position: "top" | "bottom", scale: number): Promise<void> {
  if (!isTauri) return;
  await invoke("show_overlay", { position, scale });
}

/** A changed "Chip size" on a chip that is already up: Rust tweens the webview zoom, the
 *  window stays where it is. */
export async function setOverlayScale(scale: number): Promise<void> {
  if (!isTauri) return;
  await invoke("set_overlay_scale", { scale });
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

/** Show the translation-target picker, carrying the seed it renders from. */
export async function showLangPick(seed: unknown): Promise<void> {
  if (!isTauri) return;
  await invoke("show_lang_pick", { seed });
}

/** Answer the picker: the chosen targets ([] = insert the original only). */
export async function commitLangPick(targets: string[]): Promise<void> {
  if (!isTauri) return;
  await invoke("commit_lang_pick", { targets });
}

/** Abort the whole action from the picker (Esc / the Cancel button / a closed window):
 *  hands-free does not start, push-to-talk does not insert. Deliberately distinct from
 *  committing an empty list, which means "insert the original only". */
export async function abortLangPick(): Promise<void> {
  if (!isTauri) return;
  await invoke("abort_lang_pick");
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

/** Read the source app's CURRENT text selection for the correct-on-close guard (it confirms the
 *  same word is still highlighted before replacing it): on Linux accessibility first, PRIMARY only
 *  to read the text of a confirmed rich-text (opaque) selection; on Windows a copy-chord re-grab
 *  (win_seed) that touches and restores the clipboard. null when nothing is selected or it can't
 *  be read. */
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
export async function setTrayState(status: string, route?: string): Promise<void> {
  if (!isTauri) return;
  await invoke("set_tray_state", { status, route: route ?? null });
}

/** Play a short start/stop/error cue (no-op outside Tauri). */
export async function playCue(kind: "start" | "stop" | "error"): Promise<void> {
  if (!isTauri) return;
  await invoke("play_cue", { kind });
}

export interface TriggerEvent {
  profileId: string; // the fired Profile's id (resolved to a Backend by the controller)
  // reclassify = chord family: a hands-free superset completed over a live hold (upgrade in
  // place / toggle off).
  action: "start" | "stop" | "toggle" | "reclassify";
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

/** Subscribe (in the main window) to the quit handshake: tray Quit / the trayless close emit
 *  `app://before-quit` and wait (bounded) for `quitReady` before exiting. Returns an unlisten fn. */
export async function onBeforeQuit(cb: () => void): Promise<() => void> {
  return subscribe<unknown>("app://before-quit", () => cb());
}

/** Subscribe (in the main window) to the Windows session end: `WM_QUERYENDSESSION` emits
 *  `app://session-ending` so pending writes land early. Fire-and-forget — nothing waits for an
 *  answer, and the user may still cancel the shutdown. Returns an unlisten fn. */
export async function onSessionEnding(cb: () => void): Promise<() => void> {
  return subscribe<unknown>("app://session-ending", () => cb());
}

/** Tell the quit handshake this window has landed its pending writes; the app exits now. */
export async function quitReady(): Promise<void> {
  if (!isTauri) return;
  await invoke("quit_ready");
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
        extensions: [...AUDIO_SOURCE_EXTS],
      },
      // Text sources: translate-only runs (no audio ever exists for these).
      { name: "Subtitles / Text", extensions: [...TEXT_SOURCE_EXTS] },
    ],
  });
  if (Array.isArray(selected)) return selected.filter((p): p is string => typeof p === "string");
  return typeof selected === "string" ? [selected] : [];
}

/** Native "choose folder" dialog → absolute path (or null if cancelled / not in Tauri).
 *  Generic directory picker — used for the audio base folder and the log folder (both Settings). */
export async function pickRecordingsDir(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

// ── P30: settings export/import + server sync ──────────────────────────────

/** Pull the account's synced settings blob (GET /v1/synced-client-settings). Structured
 *  result: 0 = unreachable, 200 = ok (version 0 = empty store), 401 = key,
 *  404 = the backend build predates sync. Outside Tauri → unreachable. */
export async function syncPull(args: ServerTarget): Promise<SyncPullResult> {
  return invokeServer<SyncPullResult>("sync_pull", args, {}, { ok: false, status: 0, error: "Not running in the desktop app." });
}

/** Push the composed blob (PUT /v1/synced-client-settings). `baseVersion` is the server
 *  version this device last saw (0 creates); a 409 comes back in `conflict`
 *  carrying the current server state for the merge loop. */
export async function syncPush(args: ServerTarget & {
  blob: SyncBlob;
  baseVersion: number;
  device: string;
}): Promise<SyncPushResult> {
  return invokeServer<SyncPushResult>("sync_push", args, {
    blob: args.blob,
    baseVersion: args.baseVersion,
    device: args.device,
  }, { ok: false, status: 0, error: "Not running in the desktop app." });
}

/** Drop the account's server-side blob (DELETE /v1/synced-client-settings). */
export async function syncDelete(args: ServerTarget): Promise<SyncDeleteResult> {
  return invokeServer<SyncDeleteResult>("sync_delete", args, {}, { ok: false, status: 0, error: "Not running in the desktop app." });
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
async function importSettingsFile(path: string): Promise<ImportResult> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  return invoke<ImportResult>("import_settings_file", { path });
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

/** Native "save file" dialog → absolute path (or null if cancelled / not in Tauri). */
export function pickSavePath(defaultName: string): Promise<string | null> {
  return pickExportPath(defaultName, "Settings export", "json");
}

/** Write a plain text file via the Rust side (atomic tmp+rename). */
export async function saveTextFile(path: string, contents: string): Promise<void> {
  if (!isTauri) throw new Error("Not running in the desktop app.");
  await invoke("save_text_file", { path, contents });
}

/** Show a Save's result in the system file manager: the folder opens with the FIRST saved
 *  file selected — once per Save, never per file. A failure is logged, never thrown: the
 *  files are saved either way. */
export async function revealSaved(paths: readonly string[]): Promise<void> {
  const first = paths[0];
  if (!isTauri || !first) return;
  try {
    await invoke("reveal_in_folder", { path: first });
  } catch (e) {
    console.warn("could not open the saved file's folder:", e);
    logLine("warn", "export", `could not open the saved file's folder: ${String(e)}`);
  }
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
 *  the source is over the 10 GiB cap, MAX_MEDIA_BYTES). */
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
  videoMediaBytes: number;
  videoMediaFiles: number;
  recordingsBytes: number;
  /** Every app-owned file in the recordings folder (audio + `.txt` sidecars). */
  recordingsFiles: number;
  /** The `dictation-*.wav` files among `recordingsFiles`. */
  recordingsAudioFiles: number;
}

const EMPTY_STORE_STATS: TranscriptStoreStats = {
  dictationCount: 0, fileCount: 0, fileMediaBytes: 0, fileMediaFiles: 0,
  linkMediaBytes: 0, linkMediaFiles: 0, videoMediaBytes: 0, videoMediaFiles: 0,
  recordingsBytes: 0, recordingsFiles: 0, recordingsAudioFiles: 0,
};

export async function transcriptStoreStats(
  audioBase: string | null,
): Promise<TranscriptStoreStats> {
  if (!isTauri) return EMPTY_STORE_STATS;
  return await invoke<TranscriptStoreStats>("transcript_store_stats", { audioBase });
}

/** "Delete all dictations" — session records AND the dictations folder's
 *  .wav/.txt files. Returns how many records and audio files were removed (the .txt
 *  sidecars go too but are not counted), matching the confirm's "N dictations + M audio files". */
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
 *  ("file" → files/, "url" → links/, "video" → video/; any other kind empties all three);
 *  transcripts stay. */
export async function removeTranscriptMedia(
  kind: "file" | "url" | "video",
  audioBase: string | null,
): Promise<number> {
  if (!isTauri) return 0;
  return await invoke<number>("remove_transcript_media", { kind, audioBase });
}

/** Relocate the whole audio store (dictations/, files/, links/, video/) to a new base.
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
async function pickImportFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Settings export", extensions: ["json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Pick a settings export and import it — the one sequence behind all three import buttons
 *  (Setup checklist, Onboarding, Sync tab). null = the dialog was cancelled. */
export async function pickAndImportSettings(): Promise<{ result: ImportResult } | { error: string } | null> {
  try {
    const path = await pickImportFile();
    if (!path) return null;
    return { result: await importSettingsFile(path) };
  } catch (e) {
    // `import_settings_file`'s serde errors echo the offending input VERBATIM and untruncated
    // (the config enums are plain unit variants, so `unknown_variant` quotes whatever the file
    // said), and the only ceiling on it is the 20 MB whole-file cap. That is attacker-authored
    // text from a file that never passed validation — defang and bound it before display.
    return { error: safeDisplayText(String(e), 300) };
  }
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
  // Path-free: the log is pasted into bug reports.
  await openOnce(
    openAudioInFlight,
    custom,
    () => invoke("open_audio_dir", { custom }),
    () => logLine("warn", "files", "could not open the audio folder"),
  );
}

