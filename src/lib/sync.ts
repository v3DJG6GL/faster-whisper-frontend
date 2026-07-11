// P30: the settings-sync engine — composes the synced blob, 3-way merges,
// applies pulls, and drives the automatic triggers (startup pull, focus pull,
// debounced push). File export/import reuses the same extract/apply core
// (lib/exportImport.ts).
//
// Invariants this module owns:
//  - CATEGORY MAP: the authoritative config-path → category classification
//    (incl. the machine-local exclusions that NEVER travel).
//  - COMPOSE/PRESERVE: a pushed blob carries this device's live state only for
//    toggled-ON categories; OFF categories pass through from the last-synced
//    snapshot, so a device can never erase a category it doesn't sync.
//  - LOOP GUARD: pulls are applied under `applyingRemote` (the push subscriber
//    ignores those store changes), and a push short-circuits when the composed
//    blob hashes identical to the last-synced snapshot.
//  - MERGE: category-level 3-way against the snapshot base; only a category
//    changed on BOTH sides (to different values) is a genuine conflict, which
//    surfaces in the Sync tab's conflict dialog. appRules sub-merge per-OS
//    bucket, so two machines editing different OSes' rules never conflict.

import { useApp } from "./store";
import {
  isTauri,
  loadSyncState,
  readBackendKeys,
  saveSyncState,
  setBackendKey,
  syncDeviceInfo,
  syncPull,
  syncPush,
} from "./api";
import { configReady } from "./persistence";
import { effectiveServerUrl } from "./backends";
import { IS_WINDOWS } from "./platform";
import type {
  AppRule,
  AppSettings,
  Backend,
  Config,
  SyncCategory,
} from "./types";
import type {
  SyncBlob,
  SyncDeviceInfo,
  SyncGeneral,
  SyncRemoteState,
  SyncState,
} from "./syncTypes";

export const ALL_CATEGORIES: SyncCategory[] = [
  "general",
  "recording",
  "backends",
  "profiles",
  "appRules",
];

/** This machine's appRules bucket. macOS has no app-rules backend; it falls
 *  into the linux bucket harmlessly (rules never match anything there). */
const MY_BUCKET: "linux" | "windows" = IS_WINDOWS ? "windows" : "linux";
const OTHER_BUCKET: "linux" | "windows" = IS_WINDOWS ? "linux" : "windows";

// ── canonical hash ──────────────────────────────────────────────────────────

/** JSON.stringify with recursively sorted object keys, so semantically-equal
 *  blobs hash equal regardless of construction order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** FNV-1a over the canonical string — a compact change-detection token (NOT
 *  crypto; it only gates "did anything sync-relevant change?"). */
export function hashBlob(v: unknown): string {
  const s = stableStringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const catEqual = (a: unknown, b: unknown) => hashBlob(a) === hashBlob(b);

// ── extract: live config → category payloads ───────────────────────────────

function extractGeneral(settings: AppSettings): SyncGeneral {
  const g = settings.general;
  return {
    theme: settings.theme,
    startMinimized: g.startMinimized,
    insertTiming: g.insertTiming,
    insertMethod: g.insertMethod,
    pasteShortcut: g.pasteShortcut,
    autoEnter: g.autoEnter,
    restoreClipboard: g.restoreClipboard,
    soundEffects: g.soundEffects,
    deepFieldDetection: g.deepFieldDetection,
    quickAddHotkey: g.quickAddHotkey,
    // openAtLogin + evdevEnabled are machine-local: deliberately absent.
  };
}

function extractRecording(settings: AppSettings): SyncBlob["recording"] {
  const { recordingsDir: _local, ...rest } = settings.recording;
  return rest;
}

type StoreSlice = Pick<Config, "settings" | "backends" | "profiles"> & { appRules: AppRule[] };

/**
 * Build the blob this device would push: live state for toggled-ON categories,
 * the snapshot's (server's) state for OFF ones. `secrets` are attached only
 * when requested (server push: always; export: opt-in).
 */
export async function composeBlob(
  cfg: StoreSlice,
  cats: Record<SyncCategory, boolean>,
  snapshot: SyncBlob | undefined,
  opts: { includeSecrets: boolean },
): Promise<SyncBlob> {
  const blob: SyncBlob = {};
  blob.general = cats.general ? extractGeneral(cfg.settings) : snapshot?.general;
  blob.recording = cats.recording ? extractRecording(cfg.settings) : snapshot?.recording;
  if (cats.backends) {
    blob.backends = {
      list: cfg.backends,
      quickAddList: cfg.settings.quickAddList ?? null,
    };
    if (opts.includeSecrets) {
      const secrets = await readBackendKeys(cfg.backends.map((b) => b.id));
      if (Object.keys(secrets).length > 0) blob.backends.secrets = secrets;
    }
  } else {
    blob.backends = snapshot?.backends;
  }
  blob.profiles = cats.profiles
    ? { list: cfg.profiles, homeProfileId: cfg.settings.homeProfileId ?? null }
    : snapshot?.profiles;
  // appRules: even when ON, this device only owns ITS OS bucket — the other
  // bucket passes through from the snapshot untouched.
  if (cats.appRules) {
    const buckets = { linux: [] as AppRule[], windows: [] as AppRule[] };
    buckets[MY_BUCKET] = cfg.appRules;
    buckets[OTHER_BUCKET] = snapshot?.appRules?.[OTHER_BUCKET] ?? [];
    blob.appRules = buckets;
  } else {
    blob.appRules = snapshot?.appRules;
  }
  // Drop absent categories entirely (undefined = "nothing stored", never null).
  for (const c of ALL_CATEGORIES) if (blob[c] === undefined) delete blob[c];
  return blob;
}

// ── merge: category-level 3-way ─────────────────────────────────────────────

export interface MergeResult {
  merged: SyncBlob;
  /** Categories BOTH sides changed to different values — the user must pick. */
  conflicts: SyncCategory[];
}

/**
 * 3-way merge of `local` and `remote` against the last-synced `base`
 * (undefined base = first contact: anything present counts as "changed").
 * Per category: only-one-side-changed auto-resolves; both-changed-equal
 * auto-resolves; both-changed-differently conflicts — except appRules, which
 * sub-merges per-OS bucket first (each device only edits its own bucket, so
 * cross-OS edits compose instead of conflicting).
 */
export function mergeBlobs(
  base: SyncBlob | undefined,
  local: SyncBlob,
  remote: SyncBlob,
): MergeResult {
  const merged: SyncBlob = {};
  const conflicts: SyncCategory[] = [];
  for (const c of ALL_CATEGORIES) {
    const b = base?.[c];
    const l = local[c];
    const r = remote[c];
    const localChanged = !catEqual(l, b);
    const remoteChanged = !catEqual(r, b);
    let pick: SyncBlob[SyncCategory & keyof SyncBlob];
    if (!localChanged) pick = r;
    else if (!remoteChanged) pick = l;
    else if (catEqual(l, r)) pick = l;
    else if (c === "appRules") {
      const sub = mergeAppRules(
        base?.appRules,
        local.appRules,
        remote.appRules,
      );
      if (sub === null) {
        conflicts.push(c);
        pick = l; // placeholder; a conflicted category is overwritten by the user's pick
      } else {
        pick = sub;
      }
    } else {
      conflicts.push(c);
      pick = l; // placeholder (see above)
    }
    if (pick !== undefined) (merged as Record<string, unknown>)[c] = pick;
  }
  return { merged, conflicts };
}

/** Per-bucket 3-way for appRules. Returns null when the SAME bucket changed
 *  on both sides to different values (a true conflict). */
function mergeAppRules(
  base: SyncBlob["appRules"],
  local: SyncBlob["appRules"],
  remote: SyncBlob["appRules"],
): SyncBlob["appRules"] | null {
  const out = { linux: [] as AppRule[], windows: [] as AppRule[] };
  for (const bucket of ["linux", "windows"] as const) {
    const b = base?.[bucket] ?? [];
    const l = local?.[bucket] ?? [];
    const r = remote?.[bucket] ?? [];
    if (!catEqual(l, b)) {
      if (!catEqual(r, b) && !catEqual(l, r)) return null;
      out[bucket] = l;
    } else {
      out[bucket] = r;
    }
  }
  return out;
}

// ── apply: blob → running app ───────────────────────────────────────────────

/** Write incoming secrets to the keyring, then re-derive every backend's
 *  hasApiKey from KEYRING TRUTH (imported key present, or one already stored
 *  on this machine) — so a synced "hasApiKey: true" can't claim a key that
 *  isn't actually available here. */
async function reconcileBackendSecrets(
  list: Backend[],
  secrets: Record<string, string> | undefined,
): Promise<Backend[]> {
  for (const [id, key] of Object.entries(secrets ?? {})) {
    if (key) await setBackendKey(id, key).catch((e) => console.error("keyring write failed", e));
  }
  const present = await readBackendKeys(list.map((b) => b.id));
  return list.map((b) =>
    b.hasApiKey === b.id in present ? b : { ...b, hasApiKey: b.id in present },
  );
}

/**
 * Apply a blob's toggled-ON categories to the running app through the single
 * whole-config path (`hydrate()`), preserving every machine-local field.
 * Runs under `applyingRemote` so the push subscriber ignores the resulting
 * store change; the persistence auto-save still persists it (that's wanted).
 * While dictating, the apply is DEFERRED to the next idle transition — a mid-
 * session hydrate would yank profiles/backends out from under the session.
 */
export async function applyBlob(
  blob: SyncBlob,
  cats: Record<SyncCategory, boolean>,
): Promise<void> {
  const st = useApp.getState();
  if (st.status !== "idle") {
    pendingApply = { blob, cats };
    return;
  }
  applyingRemote = true;
  try {
    const settings = st.settings;
    let nextSettings: AppSettings = settings;
    let nextBackends = st.backends;
    let nextProfiles = st.profiles;
    let nextAppRules = st.appRules;

    if (cats.general && blob.general) {
      const { theme, ...general } = blob.general;
      nextSettings = {
        ...nextSettings,
        theme,
        general: { ...nextSettings.general, ...general },
      };
    }
    if (cats.recording && blob.recording) {
      nextSettings = {
        ...nextSettings,
        recording: {
          ...blob.recording,
          // machine-local: keep this device's folder no matter what arrived
          recordingsDir: settings.recording.recordingsDir,
        },
      };
    }
    if (cats.backends && blob.backends) {
      nextBackends = await reconcileBackendSecrets(blob.backends.list, blob.backends.secrets);
      nextSettings = { ...nextSettings, quickAddList: blob.backends.quickAddList ?? null };
    }
    if (cats.profiles && blob.profiles) {
      nextProfiles = blob.profiles.list;
      nextSettings = { ...nextSettings, homeProfileId: blob.profiles.homeProfileId ?? null };
    }
    if (cats.appRules && blob.appRules) {
      nextAppRules = blob.appRules[MY_BUCKET] ?? [];
    }

    // Scrub dangling cross-references (a partially-synced pull can pair e.g.
    // new profiles with this device's old backends).
    const backendIds = new Set(nextBackends.map((b) => b.id));
    const profileIds = new Set(nextProfiles.map((p) => p.id));
    nextProfiles = nextProfiles.map((p) =>
      p.backendId && !backendIds.has(p.backendId) ? { ...p, backendId: null } : p,
    );
    if (nextSettings.homeProfileId && !profileIds.has(nextSettings.homeProfileId)) {
      nextSettings = { ...nextSettings, homeProfileId: null };
    }
    if (nextSettings.quickAddList && !backendIds.has(nextSettings.quickAddList.backendId)) {
      nextSettings = { ...nextSettings, quickAddList: null };
    }
    // A pulled backend list may have dropped the backend an urlOverride points
    // at; prune so the map doesn't accumulate dead ids.
    const sync = nextSettings.sync;
    if (sync && Object.keys(sync.urlOverrides).some((id) => !backendIds.has(id))) {
      const urlOverrides = Object.fromEntries(
        Object.entries(sync.urlOverrides).filter(([id]) => backendIds.has(id)),
      );
      nextSettings = { ...nextSettings, sync: { ...sync, urlOverrides } };
    }

    useApp.getState().hydrate({
      settings: nextSettings,
      backends: nextBackends,
      profiles: nextProfiles,
      appRules: nextAppRules,
      version: 2,
    });

    // Side effects hydrate() doesn't cover: deep-field detection is pushed to
    // Rust imperatively by its Settings toggle, so mirror that here. (Autostart
    // re-syncs via save_config; theme is reactive; hotkeys re-register via the
    // persistence subscriber.)
    if (cats.general && blob.general) {
      const { setDeepFieldDetection } = await import("./api");
      void setDeepFieldDetection(blob.general.deepFieldDetection).catch(() => {});
    }
  } finally {
    applyingRemote = false;
  }
}

// ── engine state ─────────────────────────────────────────────────────────────

let started = false;
let applyingRemote = false;
let pendingApply: { blob: SyncBlob; cats: Record<SyncCategory, boolean> } | null = null;
let state: SyncState = {};
let device: SyncDeviceInfo | null = null;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let lastFocusPull = 0;
let inFlight = false;

/** A conflict awaiting the user's per-category picks (drives the Sync tab's
 *  conflict dialog via store.syncStatus/"conflict" plumbing). */
interface PendingConflict {
  categories: SyncCategory[];
  merged: SyncBlob;
  local: SyncBlob;
  remote: SyncBlob;
  remoteVersion: number;
  remoteDevice: string | null;
}
let pendingConflict: PendingConflict | null = null;
/** The Sync tab reads the pending conflict through this (set into the store
 *  would drag blob payloads through every subscriber). */
export function getPendingConflict(): { categories: SyncCategory[]; remoteDevice: string | null } | null {
  return pendingConflict
    ? { categories: pendingConflict.categories, remoteDevice: pendingConflict.remoteDevice }
    : null;
}

const setRuntime = (p: Parameters<ReturnType<typeof useApp.getState>["setSyncRuntime"]>[0]) =>
  useApp.getState().setSyncRuntime(p);

function syncMeta() {
  return useApp.getState().settings.sync;
}

function syncBackend(): Backend | null {
  const s = useApp.getState();
  const id = s.settings.sync?.backendId;
  return (id && s.backends.find((b) => b.id === id)) || null;
}

function canSync(): boolean {
  return Boolean(isTauri && syncMeta()?.enabled && syncBackend());
}

async function persistState(patch: Partial<SyncState>): Promise<void> {
  state = { ...state, ...patch };
  await saveSyncState(state).catch((e) => console.error("saveSyncState failed", e));
}

// ── pull / push ─────────────────────────────────────────────────────────────

/** Pull the server blob and reconcile it into the running app. `manual` also
 *  re-applies when the version hasn't moved (a "make it so" button press). */
export async function pullNow(manual = false): Promise<void> {
  const backend = syncBackend();
  if (!backend || !canSync() || inFlight) return;
  inFlight = true;
  setRuntime({ syncStatus: "syncing", syncError: null });
  try {
    const res = await syncPull({
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      backendId: backend.id,
    });
    if (!res.ok || !res.state) {
      handleTransportFailure(res.status, res.error);
      return;
    }
    setRuntime({ syncUnsupported: false });
    const remote = res.state;
    if (remote.blob === null) {
      // First-ever contact: nothing stored server-side yet — seed it.
      setRuntime({ syncStatus: "ok" });
      schedulePush(0);
      return;
    }
    if (!manual && remote.version === state.version) {
      // Nothing new; a local drift (edits while offline) still pushes via the
      // hash check on the next push tick.
      setRuntime({ syncStatus: "ok" });
      schedulePush();
      return;
    }
    await reconcileRemote(remote);
  } finally {
    inFlight = false;
  }
}

/** Compose + push this device's state. No-ops when nothing sync-relevant
 *  changed since the last sync (hash match) unless `manual`. */
export async function pushNow(manual = false): Promise<void> {
  const backend = syncBackend();
  if (!backend || !canSync() || inFlight) return;
  // Don't propagate a state the local save-gate froze (hotkey conflict) or
  // couldn't persist — sync ships what config.json holds, not a maybe.
  if (useApp.getState().saveErrorKind === "save") return;
  inFlight = true;
  setRuntime({ syncStatus: "syncing", syncError: null });
  try {
    const s = useApp.getState();
    const cats = s.settings.sync?.categories ?? {
      general: true, recording: true, backends: true, profiles: true, appRules: true,
    };
    let blob = await composeBlob(
      { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
      cats,
      state.snapshot,
      { includeSecrets: true },
    );
    let base = state.version ?? 0;
    if (!manual && hashBlob(blob) === state.hash && base > 0) {
      setRuntime({ syncStatus: "ok" });
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await syncPush({
        serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
        backendId: backend.id,
        blob,
        baseVersion: base,
        device: device?.hostname ?? "unknown device",
      });
      if (res.ok && res.state) {
        await persistState({
          version: res.state.version,
          updatedAt: res.state.updated_at ?? null,
          device: device?.hostname ?? null,
          hash: hashBlob(blob),
          snapshot: blob,
        });
        setRuntime({
          syncStatus: "ok",
          syncUnsupported: false,
          lastSyncedAt: Date.now(),
          lastSyncDevice: device?.hostname ?? null,
        });
        return;
      }
      if (res.status === 409 && res.conflict) {
        const remote = res.conflict;
        const remoteBlob = (remote.blob ?? {}) as SyncBlob;
        const { merged, conflicts } = mergeBlobs(state.snapshot, blob, remoteBlob);
        if (conflicts.length > 0) {
          raiseConflict({ categories: conflicts, merged, local: blob, remote: remoteBlob,
            remoteVersion: remote.version, remoteDevice: remote.device ?? null });
          return;
        }
        // Auto-merged: adopt the merge locally, then retry on the new base.
        await applyBlob(merged, fullCats());
        blob = merged;
        base = remote.version;
        continue;
      }
      handleTransportFailure(res.status, res.error);
      return;
    }
    setRuntime({ syncStatus: "error", syncError: "The server kept changing underneath — try again." });
  } finally {
    inFlight = false;
  }
}

/** Shared pull-side reconcile: merge remote with local against the snapshot. */
async function reconcileRemote(remote: SyncRemoteState): Promise<void> {
  const s = useApp.getState();
  const cats = fullCats();
  const local = await composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    s.settings.sync?.categories ?? cats,
    state.snapshot,
    { includeSecrets: true },
  );
  const remoteBlob = (remote.blob ?? {}) as SyncBlob;
  const { merged, conflicts } = mergeBlobs(state.snapshot, local, remoteBlob);
  if (conflicts.length > 0) {
    raiseConflict({ categories: conflicts, merged, local, remote: remoteBlob,
      remoteVersion: remote.version, remoteDevice: remote.device ?? null });
    return;
  }
  await applyBlob(merged, s.settings.sync?.categories ?? cats);
  await persistState({
    version: remote.version,
    updatedAt: remote.updated_at ?? null,
    device: remote.device ?? null,
    hash: hashBlob(merged),
    snapshot: merged,
  });
  setRuntime({
    syncStatus: "ok",
    lastSyncedAt: Date.now(),
    lastSyncDevice: remote.device ?? null,
  });
  // Local had changes the server lacked → the merged doc differs from the
  // server's; push it up (base = the version we just adopted).
  if (hashBlob(merged) !== hashBlob(remoteBlob)) schedulePush(0);
}

function fullCats(): Record<SyncCategory, boolean> {
  return { general: true, recording: true, backends: true, profiles: true, appRules: true };
}

function handleTransportFailure(status: number, error?: string): void {
  if (status === 404) {
    setRuntime({
      syncStatus: "error",
      syncUnsupported: true,
      syncError: "This server doesn't support settings sync — update faster-whisper-backend.",
    });
  } else if (status === 401 || status === 403) {
    setRuntime({ syncStatus: "error", syncError: "The server rejected the API key." });
  } else {
    setRuntime({ syncStatus: "error", syncError: error ?? "Sync failed." });
  }
}

// ── conflict resolution (driven by the Sync tab dialog) ─────────────────────

function raiseConflict(c: PendingConflict): void {
  pendingConflict = c;
  setRuntime({
    syncStatus: "error",
    syncError:
      "Both this device and another changed the same settings — resolve the conflict in Settings → Sync.",
  });
}

/** Apply the user's per-category picks, then adopt + push the result. */
export async function resolveSyncConflicts(
  choices: Record<string, "local" | "remote">,
): Promise<void> {
  const c = pendingConflict;
  if (!c) return;
  pendingConflict = null;
  const final: SyncBlob = { ...c.merged };
  for (const cat of c.categories) {
    const src = choices[cat] === "remote" ? c.remote : c.local;
    const val = src[cat];
    if (val === undefined) delete final[cat];
    else (final as Record<string, unknown>)[cat] = val;
  }
  await applyBlob(final, useApp.getState().settings.sync?.categories ?? fullCats());
  await persistState({
    version: c.remoteVersion,
    hash: hashBlob(final),
    snapshot: final,
  });
  setRuntime({ syncStatus: "ok", syncError: null, lastSyncedAt: Date.now() });
  // The resolved doc differs from what the server holds unless "remote" won
  // everywhere — push it (base = the server version the conflict reported).
  if (hashBlob(final) !== hashBlob(c.remote)) void pushNow(true);
}

export function dismissSyncConflict(): void {
  pendingConflict = null;
  setRuntime({ syncStatus: "idle", syncError: null });
}

// ── triggers ────────────────────────────────────────────────────────────────

function schedulePush(delayMs = 3000): void {
  if (!canSync()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void pushNow();
  }, delayMs);
}

/**
 * Start the engine (idempotent; call once from App after initConfig()).
 * Ordering: waits for the persisted config to hydrate so the startup pull
 * merges against the REAL local state, not the seeded defaults.
 */
export async function initSync(): Promise<void> {
  if (!isTauri || started) return;
  started = true;
  await configReady;
  state = (await loadSyncState()) ?? {};
  device = await syncDeviceInfo();

  if (state.updatedAt) {
    setRuntime({
      lastSyncedAt: Math.round((state.updatedAt as number) * 1000),
      lastSyncDevice: state.device ?? null,
    });
  }

  // Debounced push on any sync-relevant store change. Mirrors the persistence
  // subscriber's ref-predicate; `applyingRemote` marks pull-applies. A change
  // that only touches settings.sync still lands here (same settings ref churn),
  // but compose excludes it, so the hash check discards the push.
  useApp.subscribe((s, prev) => {
    if (applyingRemote) return;
    if (
      s.settings === prev.settings &&
      s.backends === prev.backends &&
      s.profiles === prev.profiles &&
      s.appRules === prev.appRules
    ) {
      // Re-run a deferred pull-apply once dictation lands back at idle.
      if (pendingApply && s.status === "idle" && prev.status !== "idle") {
        const p = pendingApply;
        pendingApply = null;
        void applyBlob(p.blob, p.cats);
      }
      return;
    }
    // Turning sync on (or switching the sync server) starts with a pull so
    // this device reconciles into the shared set instead of clobbering it.
    const prevSync = prev.settings.sync;
    const nowSync = s.settings.sync;
    if (nowSync?.enabled && (!prevSync?.enabled || prevSync.backendId !== nowSync.backendId)) {
      void pullNow(true);
      return;
    }
    // A category toggled ON adopts the server's state for it before pushing.
    if (
      nowSync?.enabled &&
      prevSync?.categories &&
      ALL_CATEGORIES.some((c) => nowSync.categories[c] && !prevSync.categories[c])
    ) {
      void pullNow(true);
      return;
    }
    schedulePush();
  });

  // Focus pull (throttled): catches "changed it on the other machine".
  window.addEventListener("focus", () => {
    const now = Date.now();
    if (now - lastFocusPull < 5000) return;
    lastFocusPull = now;
    void pullNow();
  });

  if (canSync()) void pullNow();
}

/** For the Sync tab's "Delete server copy": forget local bookkeeping so the
 *  next push recreates from version 0. */
export async function resetSyncState(): Promise<void> {
  state = { deviceId: state.deviceId };
  await persistState({ version: 0, updatedAt: null, device: null, hash: undefined, snapshot: undefined });
  setRuntime({ lastSyncedAt: null, lastSyncDevice: null, syncStatus: "idle", syncError: null });
}
