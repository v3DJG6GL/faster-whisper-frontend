import { create } from "zustand";
import type {
  AppRule,
  AppSettings,
  Backend,
  Config,
  ConnectionInfo,
  DictationStatus,
  FocusedApp,
  Profile,
  SyncSettings,
  ThemeName,
  UsageStats,
} from "./types";
import { newSpeakMemo, stepSpeaking } from "./speaking";
import { swap } from "./arr";
import { applyTheme } from "./theme";

// Derives `speaking` (green vs amber) from the RMS level stream centrally, so the
// main-window surfaces (Home button, sidebar dot, waveforms) all agree with the chip
// without each re-running the smoothing. One singleton memo: the store is a singleton.
const speakMemo = newSpeakMemo();

/**
 * Frontend store. Holds seeded defaults in memory; the persistence layer wires
 * load/save through Tauri commands (config persisted as JSON in the app config
 * dir, API keys in the OS keyring). Keep mutations here so persistence can
 * subscribe in one place.
 *
 * A Backend is a server connection (URL + model + decode defaults). A Profile is
 * a dictation setup (activation + chord + a target Backend + optional overrides).
 */

const DEFAULT_BACKEND: Backend = {
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

/** Sync starts off with every category opted in — flipping "Enable sync" is
 *  the single gate; the toggles then subtract. Machine-local by contract
 *  (never travels in a blob/export), so defaults only matter per-device. */
export const DEFAULT_SYNC: SyncSettings = {
  enabled: false,
  backendId: null,
  categories: { general: true, recording: true, backends: true, profiles: true, appRules: true },
  urlOverrides: {},
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: "auto", // follow the OS scheme until the user picks a side (Sidebar toggle)
  microphoneId: null,
  homeProfileId: null,
  quickAddList: null,
  general: {
    openAtLogin: false,
    startMinimized: false,
    insertTiming: "live",
    insertMethod: "paste",
    pasteShortcut: ["ControlLeft", "KeyV"],
    autoEnter: false,
    restoreClipboard: true,
    soundEffects: true,
    evdevEnabled: false,
    deepFieldDetection: false,
    quickAddHotkey: [],
  },
  recording: {
    indicatorPosition: "top",
    saveRecordings: true,
    recordingsDir: null,
    trimSilence: true,
    muteSystemAudio: true,
    latchAutoStopMin: 30,
    realtimePreview: true,
    realtimePreviewOnHover: false,
    showProfileOnOverlay: true,
    showProfileOnHover: false,
    showStatsOnOverlay: true,
    overlayStatsOnHover: false,
    overlayStatsMetric: "both",
    showTargetOnOverlay: true,
    showTargetOnHover: false,
    showTargetOnlySpeaking: false,
    persistentDock: true,
    overlayPeek: true,
    peekTimeoutSec: 5,
    peekWhileActive: false,
    dimAfterSec: 2.5,
    hoverRevealMs: 500,
    quickLaunch: [],
  },
  sync: DEFAULT_SYNC,
};

// Seed ids match the legacy mode strings so migration is idempotent (see Rust load()).
const DEFAULT_PROFILES: Profile[] = [
  { id: "hold", name: "Push-to-talk", activation: "hold", enabled: true, hotkey: ["ControlLeft", "ShiftLeft"], backendId: "default" },
  { id: "handsfree", name: "Latch", activation: "latch", enabled: true, hotkey: ["ControlLeft", "KeyH"], backendId: "default" },
];

/** Deep-merge loaded settings over the defaults so a config written by an older version
 *  — or with fields omitted by the backend's skip-empty serialization (e.g. an empty
 *  `recording.quickLaunch`) — still gets every field. Without this, a missing field is
 *  `undefined` at runtime and crashes code that assumes the typed shape. */
function withSettingsDefaults(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    general: { ...DEFAULT_SETTINGS.general, ...(s.general ?? {}) },
    recording: { ...DEFAULT_SETTINGS.recording, ...(s.recording ?? {}) },
    sync: {
      ...DEFAULT_SYNC,
      ...(s.sync ?? {}),
      categories: { ...DEFAULT_SYNC.categories, ...(s.sync?.categories ?? {}) },
      urlOverrides: { ...(s.sync?.urlOverrides ?? {}) },
    },
  };
}

/**
 * Normalize a loaded config to the v2 shape. The Rust `load()` already migrates,
 * but this guards the no-Rust `pnpm dev` path and any version skew during dev.
 */
function migrateConfig(raw: unknown): Config {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object") {
    return { settings: DEFAULT_SETTINGS, backends: [DEFAULT_BACKEND], profiles: DEFAULT_PROFILES };
  }
  // Already v2 (has `backends`).
  if (Array.isArray((c as { backends?: unknown }).backends)) {
    return {
      settings: withSettingsDefaults(c.settings),
      backends: (c.backends as Backend[]) ?? [DEFAULT_BACKEND],
      profiles: Array.isArray(c.profiles) ? (c.profiles as Profile[]) : [],
      appRules: Array.isArray((c as { appRules?: unknown }).appRules) ? (c.appRules as AppRule[]) : [],
      version: c.version as number | undefined,
    };
  }
  // Legacy v1: `profiles` were Backends; `modes` were ModeBindings.
  const backends = Array.isArray(c.profiles) ? (c.profiles as Backend[]) : [DEFAULT_BACKEND];
  const modes = Array.isArray((c as { modes?: unknown }).modes)
    ? ((c as { modes: Record<string, unknown>[] }).modes)
    : [];
  const profiles: Profile[] = modes.length
    ? modes.map((m) => {
        const isHold = m.mode === "hold";
        return {
          id: isHold ? "hold" : "handsfree",
          name: isHold ? "Push-to-talk" : "Latch",
          activation: isHold ? "hold" : "latch",
          enabled: !!m.enabled,
          hotkey: Array.isArray(m.hotkey) ? (m.hotkey as string[]) : [],
          backendId: (m.profileId as string | null) ?? null,
        };
      })
    : DEFAULT_PROFILES;
  return { settings: withSettingsDefaults(c.settings), backends, profiles, version: 2 };
}

interface AppState {
  settings: AppSettings;
  backends: Backend[];
  profiles: Profile[];
  appRules: AppRule[];

  // live dictation runtime (driven by Rust events)
  status: DictationStatus;
  /** Mic is opening but not yet delivering real audio (e.g. a Bluetooth headset
   *  switching into its mic profile takes ~1–2s). While true the chip shows
   *  "warming up…" and the start cue is held until real audio actually flows. */
  warming: boolean;
  /** The mic actually went LIVE this session — set when real audio flowed (or the warm-up
   *  safety timeout fired), NOT when warming was cleared by teardown. Gates the start/stop
   *  cues so a session that starts/ends DURING warm-up doesn't play a mismatched chime. */
  micLive: boolean;
  level: number; // 0..1 audio RMS for the visualizer
  speaking: boolean; // derived from level (smoothed): actively speaking vs armed-silent
  partial: string; // live partial transcript for the chip preview
  activeProfile: string | null; // id of the Profile currently dictating
  dictationError: string | null;
  /** Decode overrides the server refused (admin-locked) for the active stream. */
  overridesIgnored: string[];
  /** The app the active session is injecting into — drives the chip's "→ app" readout. */
  targetApp: FocusedApp | null;
  /** Why injection into the target is skipped (coerced to clipboard): a per-app `block` rule, or
   *  the deep-detection guard finding the focused element isn't a text field. null = typing. */
  targetSkip: "blocked" | "notEditable" | null;
  /** One-shot signal that a phrase just landed — drives the chip's per-phrase pulse. `seq`
   *  bumps each time so identical consecutive kinds still retrigger the animation. */
  lastInsert: { kind: "typed" | "clipboard"; seq: number } | null;
  /** Truthful end-of-session insert result, set WITH the idle transition — drives the chip's
   *  done marker (✓ typed / clipboard glyph / nothing). null = no session finished yet. */
  sessionOutcome: "typed" | "clipboard" | "none" | null;

  connections: Record<string, ConnectionInfo | undefined>; // keyed by Backend id

  /** P28: per-Backend usage stats (GET /v1/usage), keyed by Backend id. A
   *  present-but-null value means "fetched and unsupported" (hide the stats
   *  surfaces); an absent key means "not fetched yet". Runtime-only — kept off
   *  the persisted Config. Fed by the usage controller (lib/usage.ts). */
  usage: Record<string, UsageStats | null>;

  /** P31: which Backend the usage VIEW (Home strip + Statistics page) shows. null =
   *  follow the dictation/home-target backend. Runtime-only (a view preference, not
   *  persisted). The chip readout ignores this — it always uses activeStatsBackend. */
  usageViewBackendId: string | null;

  /** Last config auto-save failure (disk full / read-only / IPC), surfaced as a banner so the
   *  user knows their recent settings/backends/profiles changes were NOT written to disk and
   *  may be lost on restart. null = last save succeeded. Runtime-only; set by the persistence
   *  auto-save, cleared on the next successful save. */
  saveError: string | null;
  // What KIND of notice saveError holds, so the banner can frame it correctly: "save" = an actual
  // write/conflict failure ("Couldn't save…"), "load" = a startup load-recovery / load-failure notice
  // (which is self-contained and must NOT show the save-failure framing). null when saveError is null.
  saveErrorKind: "save" | "load" | null;

  /** P30 runtime sync status (never persisted): what the Sync tab's status
   *  line shows. `syncUnsupported` = the sync backend 404'd the endpoint
   *  (build too old); `lastSyncedAt`/`lastSyncDevice` mirror sync-state.json. */
  syncStatus: "idle" | "syncing" | "ok" | "error";
  syncError: string | null;
  syncUnsupported: boolean;
  lastSyncedAt: number | null; // epoch ms of the last successful pull/push
  lastSyncDevice: string | null; // last WRITER's device label (server-reported)

  setTheme: (t: ThemeName) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateGeneral: (patch: Partial<AppSettings["general"]>) => void;
  updateRecording: (patch: Partial<AppSettings["recording"]>) => void;
  /** Patch settings.sync (deep-merges categories/urlOverrides at the caller). */
  updateSync: (patch: Partial<SyncSettings>) => void;
  /** Set (or clear, with null/empty) this device's address override for a
   *  backend. Invalidates the backend's cached connection + usage — the
   *  effective target changed (mirrors upsertBackend's URL-edit handling). */
  setUrlOverride: (backendId: string, url: string | null) => void;

  upsertBackend: (b: Backend) => void;
  removeBackend: (id: string) => void;
  duplicateBackend: (id: string) => void;
  moveBackend: (id: string, dir: "up" | "down") => void;

  upsertProfile: (p: Profile) => void;
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  removeProfile: (id: string) => void;
  duplicateProfile: (id: string) => void;
  moveProfile: (id: string, dir: "up" | "down") => void;

  upsertAppRule: (r: AppRule) => void;
  removeAppRule: (id: string) => void;

  setConnection: (backendId: string, info: ConnectionInfo) => void;

  /** Store the latest usage stats for a Backend (null = fetched-but-unsupported). */
  setUsage: (backendId: string, stats: UsageStats | null) => void;

  /** Pick which Backend the usage view shows (null = follow the dictation target). */
  setUsageViewBackend: (id: string | null) => void;

  /** Set (or clear, with null) the config-save error banner. */
  setSaveError: (msg: string | null, kind?: "save" | "load") => void;

  /** P30: update the runtime sync status line (engine-owned). */
  setSyncRuntime: (
    patch: Partial<{
      syncStatus: "idle" | "syncing" | "ok" | "error";
      syncError: string | null;
      syncUnsupported: boolean;
      lastSyncedAt: number | null;
      lastSyncDevice: string | null;
    }>,
  ) => void;

  /** Update live dictation runtime (status / level / partial transcript). */
  setDictation: (
    patch: Partial<{
      status: DictationStatus;
      warming: boolean;
      micLive: boolean;
      level: number;
      partial: string;
      activeProfile: string | null;
      dictationError: string | null;
      overridesIgnored: string[];
      targetApp: FocusedApp | null;
      targetSkip: "blocked" | "notEditable" | null;
      lastInsert: { kind: "typed" | "clipboard"; seq: number } | null;
      sessionOutcome: "typed" | "clipboard" | "none" | null;
    }>,
  ) => void;

  /** Replace settings/backends/profiles from the persisted config (on startup). */
  hydrate: (cfg: Config) => void;
}

/** Drop every settings-side reference to a removed backend id, RETURNING THE SAME
 *  OBJECT when nothing referenced it (so the auto-save subscriber sees no change).
 *  quick-add pin → null; sync server → disable sync (nowhere to push); the
 *  backend's per-device URL override → removed. */
function scrubBackendFromSettings(settings: AppSettings, id: string): AppSettings {
  let next = settings;
  if (next.quickAddList?.backendId === id) next = { ...next, quickAddList: null };
  const sync = next.sync;
  if (sync && (sync.backendId === id || id in sync.urlOverrides)) {
    const urlOverrides = { ...sync.urlOverrides };
    delete urlOverrides[id];
    next = {
      ...next,
      sync:
        sync.backendId === id
          ? { ...sync, enabled: false, backendId: null, urlOverrides }
          : { ...sync, urlOverrides },
    };
  }
  return next;
}

// Replace-or-append by id — the shared body of the upsert* reducers (backends/profiles/appRules).
function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  const next = [...arr];
  if (i >= 0) next[i] = item;
  else next.push(item);
  return next;
}

export const useApp = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  backends: [DEFAULT_BACKEND],
  profiles: DEFAULT_PROFILES,
  appRules: [],

  status: "idle",
  warming: false,
  micLive: false,
  level: 0,
  speaking: false,
  partial: "",
  activeProfile: null,
  dictationError: null,
  overridesIgnored: [],
  targetApp: null,
  targetSkip: null,
  lastInsert: null,
  sessionOutcome: null,

  connections: {},
  usage: {},
  usageViewBackendId: null,
  saveError: null,
  saveErrorKind: null,

  syncStatus: "idle",
  syncError: null,
  syncUnsupported: false,
  lastSyncedAt: null,
  lastSyncDevice: null,

  setTheme: (t) => {
    applyTheme(t);
    set((s) => ({ settings: { ...s.settings, theme: t } }));
  },
  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  updateSync: (patch) =>
    set((s) => ({
      settings: { ...s.settings, sync: { ...(s.settings.sync ?? DEFAULT_SYNC), ...patch } },
    })),
  setUrlOverride: (backendId, url) =>
    set((s) => {
      const sync = s.settings.sync ?? DEFAULT_SYNC;
      const next = url?.trim() ? url.trim() : null;
      const cur = sync.urlOverrides[backendId] ?? null;
      if (cur === next) return {};
      const urlOverrides = { ...sync.urlOverrides };
      if (next) urlOverrides[backendId] = next;
      else delete urlOverrides[backendId];
      // The effective connect target changed: drop the cached connection +
      // usage so status/classification re-test against the new address.
      const connections = { ...s.connections };
      delete connections[backendId];
      const usage = { ...s.usage };
      delete usage[backendId];
      return {
        settings: { ...s.settings, sync: { ...sync, urlOverrides } },
        connections,
        usage,
      };
    }),
  updateGeneral: (patch) =>
    set((s) => ({ settings: { ...s.settings, general: { ...s.settings.general, ...patch } } })),
  updateRecording: (patch) =>
    set((s) => ({ settings: { ...s.settings, recording: { ...s.settings.recording, ...patch } } })),

  upsertBackend: (b) =>
    set((s) => {
      const prev = s.backends.find((x) => x.id === b.id);
      const backends = upsertById(s.backends, b);
      // A changed server URL (or key presence) invalidates the cached connection: its
      // ok/bootId/models/capabilities describe the OLD server, yet effectiveServerKind, the
      // Backends status dot, the decode-override gate, and the usage poll all key on the backend
      // id. Drop the stale connection + usage so they re-test against the new target instead of
      // showing the old server's "connected"/classification.
      if (prev && (prev.serverUrl !== b.serverUrl || prev.hasApiKey !== b.hasApiKey)) {
        const connections = { ...s.connections };
        delete connections[b.id];
        const usage = { ...s.usage };
        delete usage[b.id];
        return { backends, connections, usage };
      }
      return { backends };
    }),
  removeBackend: (id) =>
    set((s) => {
      // Drop the removed backend's cached connection + usage too, so a re-added backend that
      // recycles the id (or a late in-flight test) can't read the dead server's state.
      const connections = { ...s.connections };
      delete connections[id];
      const usage = { ...s.usage };
      delete usage[id];
      return {
        backends: s.backends.filter((b) => b.id !== id),
        // Only build a new profiles array if a profile actually referenced the removed backend —
        // map() always returns a fresh reference, and the auto-save subscriber treats any new
        // profiles ref as a chord change and re-registers the OS global hotkeys for nothing.
        profiles: s.profiles.some((p) => p.backendId === id)
          ? s.profiles.map((p) => (p.backendId === id ? { ...p, backendId: null } : p))
          : s.profiles,
        connections,
        usage,
        // Scrub the other id-keyed references to the removed backend so none dangle: the usage-view
        // pin (runtime), the PERSISTED quick-add-list pin, and the sync meta (removing the sync
        // server disables sync — there's nowhere to push to; also drop its per-device URL
        // override). Keep each ref stable when it didn't point at this backend, so the auto-save
        // subscriber doesn't see a spurious settings change.
        usageViewBackendId: s.usageViewBackendId === id ? null : s.usageViewBackendId,
        settings: scrubBackendFromSettings(s.settings, id),
      };
    }),
  duplicateBackend: (id) =>
    set((s) => {
      const i = s.backends.findIndex((b) => b.id === id);
      if (i < 0) return {};
      const src = s.backends[i];
      // The API key lives in the OS keyring under the source id, not in this object,
      // so it can't be carried to the new id — mark it absent so the editor prompts
      // for a fresh one.
      const copy: Backend = { ...src, id: crypto.randomUUID(), name: `${src.name} copy`, hasApiKey: false };
      const backends = [...s.backends];
      backends.splice(i + 1, 0, copy);
      return { backends };
    }),
  moveBackend: (id, dir) =>
    set((s) => {
      const i = s.backends.findIndex((b) => b.id === id);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= s.backends.length) return {};
      return { backends: swap(s.backends, i, j) };
    }),

  upsertProfile: (p) => set((s) => ({ profiles: upsertById(s.profiles, p) })),
  updateProfile: (id, patch) =>
    set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  removeProfile: (id) =>
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      // Scrub the PERSISTED home-profile pin if it referenced the removed profile (else a stale id
      // lingers on disk). Keep settings stable otherwise.
      settings: s.settings.homeProfileId === id ? { ...s.settings, homeProfileId: null } : s.settings,
    })),
  duplicateProfile: (id) =>
    set((s) => {
      const i = s.profiles.findIndex((p) => p.id === id);
      if (i < 0) return {};
      const src = s.profiles[i];
      // Clear the chord on the copy — a duplicate must never inherit the same one.
      const copy: Profile = { ...src, id: crypto.randomUUID(), name: `${src.name} copy`, hotkey: [] };
      const profiles = [...s.profiles];
      profiles.splice(i + 1, 0, copy);
      return { profiles };
    }),
  moveProfile: (id, dir) =>
    set((s) => {
      const i = s.profiles.findIndex((p) => p.id === id);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= s.profiles.length) return {};
      return { profiles: swap(s.profiles, i, j) };
    }),

  upsertAppRule: (r) =>
    set((s) => {
      // Per-app rules are MATCHED by appId (resolveInjectionTarget uses find() = first wins),
      // so two rules sharing an appId silently shadow each other — a newly-added or re-captured
      // rule for an already-ruled app would never apply (the older one keeps winning). Upsert by
      // appId (and the id being edited): replace any rule for this appId in place, so the rule the
      // user just saved is the one that takes effect.
      const key = r.appId.trim().toLowerCase();
      const matches = (x: AppRule) => x.id === r.id || x.appId.trim().toLowerCase() === key;
      const pos = s.appRules.findIndex(matches);
      const rest = s.appRules.filter((x) => !matches(x));
      return { appRules: pos < 0 ? [...rest, r] : [...rest.slice(0, pos), r, ...rest.slice(pos)] };
    }),
  removeAppRule: (id) => set((s) => ({ appRules: s.appRules.filter((r) => r.id !== id) })),

  setConnection: (backendId, info) =>
    set((s) => ({ connections: { ...s.connections, [backendId]: info } })),

  setUsage: (backendId, stats) =>
    set((s) => {
      // The 30s usage poll hands us a fresh object every tick even when the numbers are identical.
      // Skip the write when nothing changed so the `usage` reference is stable — otherwise every
      // poll churns a cross-window overlay re-emit + a UsageStats SVG re-render for no reason. The
      // shape is small + fixed (today/total + a ≤90-point series), so stringify-compare is trivial;
      // JSON.stringify(null) === "null" also subsumes the already-null path.
      if (backendId in s.usage && JSON.stringify(s.usage[backendId]) === JSON.stringify(stats)) return {};
      return { usage: { ...s.usage, [backendId]: stats } };
    }),

  setUsageViewBackend: (id) => set({ usageViewBackendId: id }),

  setSaveError: (msg, kind = "save") => set({ saveError: msg, saveErrorKind: msg ? kind : null }),

  setSyncRuntime: (patch) => set(patch),

  setDictation: (patch) =>
    set((s) => {
      // Keep the shared `speaking` flag current whenever the level moves or the status actually
      // changes. Stepping the singleton speakMemo only on a genuine move — NOT on a same-value
      // "listening" re-assert (the partial handler re-sends {status:"listening"} several times a
      // second) — keeps the store's detector in lockstep with the chip's, which steps once per
      // level sample (see Overlay.tsx / speaking.ts). Computing it here (not per-component) also
      // means subscribers re-render only on a transition, not on every RMS tick — important for
      // the tiny always-mounted sidebar dot.
      const statusMoved = "status" in patch && patch.status !== s.status;
      if (!("level" in patch) && !statusMoved) return patch;
      const status = patch.status ?? s.status;
      const level = patch.level ?? s.level;
      const speaking = stepSpeaking(speakMemo, level, status === "listening", performance.now());
      return speaking === s.speaking ? patch : { ...patch, speaking };
    }),

  hydrate: (cfg) => {
    const c = migrateConfig(cfg);
    set({ settings: c.settings, backends: c.backends, profiles: c.profiles, appRules: c.appRules ?? [] });
  },
}));
