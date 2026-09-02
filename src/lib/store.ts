import { create } from "zustand";
import { LEGACY_HANDSFREE } from "./types";
import { DEFAULT_PAGE_QUERY, type UsagePageQuery } from "./usageDerive";
import type {
  AppRule,
  AppSettings,
  Backend,
  Capabilities,
  Config,
  ConnectionInfo,
  DictationPhase,
  DictationStatus,
  FocusedApp,
  Profile,
  SyncCategory,
  SyncSettings,
  SyncSubSettings,
  ThemeName,
  UsageStats,
} from "./types";
import type { TranslateRunUi } from "./retroTranslate";
import type { TranslateFailure } from "./dictationTranslate";
import { newSpeakMemo, stepSpeaking } from "./speaking";
import { swap } from "./arr";
import { hasOwn } from "./own";
import { normalizeAppId } from "./sanitize";
import { applyTheme } from "./theme";

// Derives `speaking` (green vs amber) from the RMS level stream centrally, so the
// main-window surfaces (Home button, sidebar dot, waveforms) all agree with the chip
// without each re-running the smoothing. One singleton memo: the store is a singleton.
const speakMemo = newSpeakMemo();

/** Ceiling on quick-launch entries reaching the store. The editor caps the user at 6 out of ~11
 *  possible targets; this is loose on purpose (the list is synced back, so truncating near the
 *  real count would propagate to the user's other devices) while still bounding a hostile list. */
const MAX_QUICK_LAUNCH = 100;

/**
 * Frontend store. Holds seeded defaults in memory; the persistence layer wires
 * load/save through Tauri commands (config persisted as JSON in the app config
 * dir, API keys in the OS keyring). Keep mutations here so persistence can
 * subscribe in one place.
 *
 * A Backend is a server connection (URL + model + decode defaults). A Profile is
 * a dictation setup (activation + chord + a target Backend + optional overrides).
 */

// DEFAULT_SYNC / DEFAULT_SETTINGS moved to defaults.ts (pure data, no import
// cycle with the settings manifest); re-exported here so importers don't churn.
import { DEFAULT_SETTINGS, DEFAULT_SYNC } from "./defaults";
import { completeGates } from "./settingsManifest";
export { DEFAULT_SYNC };

/** Deep-merge loaded settings over the defaults so a config written by an older version
 *  — or with fields omitted by the backend's skip-empty serialization (e.g. an empty
 *  `recording.quickLaunch`) — still gets every field. Without this, a missing field is
 *  `undefined` at runtime and crashes code that assumes the typed shape. */
export function withSettingsDefaults(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Partial<AppSettings>;
  const recording = { ...DEFAULT_SETTINGS.recording, ...(s.recording ?? {}) };
  // This merge fills MISSING keys but cannot vouch for the type of a key that is PRESENT, and
  // the whole `recording` block is replaced wholesale by a pulled sync blob. `quickLaunch` is
  // the one leaf whose elements get dereferenced unguarded (`quickLaunchMeta` reads `e.kind`
  // in both the chip and the Settings editor), and with no error boundary in either webview a
  // bad element unmounts the window. Coerce it to a list of objects here, at the choke point.
  // The "is an object" floor was enough for the `e.kind` deref it was written for, but
  // `quickLaunchMeta` also returns `label: reg?.label ?? e.target`, and the Settings editor
  // renders both `label` and `e.kind` as React CHILDREN — an object target survives the filter
  // and throws "Objects are not valid as a React child" during render. Require string leaves.
  recording.quickLaunch = Array.isArray(recording.quickLaunch)
    ? recording.quickLaunch.filter(
        (e) =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { id?: unknown }).id === "string" &&
          typeof (e as { kind?: unknown }).kind === "string" &&
          typeof (e as { target?: unknown }).target === "string",
      )
      // The one sync-supplied list with no entry ceiling anywhere — the three list sanitizers all
      // have one. It is re-serialized into the overlay payload on every level tick, rendered one
      // button per entry in the always-on-top chip and one row per entry in the editor, and
      // persisted, so an oversized list survives restarts. The editor hard-caps the user at 6 and
      // the option universe is ~11, so this ceiling is far above anything reachable by hand —
      // deliberately, because this list IS pushed back to the server, and a cap near the real
      // count would propagate a truncation to the user's other devices.
      .slice(0, MAX_QUICK_LAUNCH)
    : [];
  // The Home screen became Dashboard (2026-09-02); a quick-launch entry saved before then
  // still names it by its old id.
  for (const e of recording.quickLaunch as { target?: string }[]) if (e.target === "home") e.target = "dashboard";
  const migratedCategories = completeCategories(s.sync?.categories);
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    general: { ...DEFAULT_SETTINGS.general, ...(s.general ?? {}) },
    recording,
    sync: {
      ...DEFAULT_SYNC,
      ...(s.sync ?? {}),
      categories: migratedCategories,
      // The MIGRATED map, not the raw one: a pre-split `recording:false` /
      // `general:false` only reaches the chip/dictionary members through the
      // split-out keys completeCategories adds, and the completed gates are
      // persisted in full — so a miss here was permanent. One binding, so the
      // two cannot drift apart.
      sub: completeSub(s.sync?.sub, migratedCategories),
      urlOverrides: { ...(s.sync?.urlOverrides ?? {}) },
    },
    logging: { ...DEFAULT_SETTINGS.logging!, ...(s.logging ?? {}) },
  };
}

/** Complete the per-setting sync gates from a persisted (possibly
 *  older-version) config: manifest defaults ← old category toggles (an OFF
 *  category seeds its members OFF) ← legacy sub keys ← saved gate values.
 *  The legacy four keys are also written BACK (derived from the gates) so a
 *  downgraded app still reads the same intent. */
function completeSub(
  saved: Partial<SyncSubSettings> | undefined,
  savedCategories: Partial<Record<SyncCategory, boolean>> | undefined,
): SyncSubSettings {
  const gates = completeGates(saved, savedCategories);
  // Legacy keys written back so a downgraded app reads the same intent.
  return { ...gates, recordingsDir: gates.audioFolder, latchAutoStop: gates.handsFreeAutoStop };
}

/** Fill missing category toggles — with a one-time split migration: a config
 *  persisted before "chip" / "dictionary" existed carried the chip fields
 *  under "Recording & Chip" and the quick-add chord under General, so a user
 *  who had those groups OFF must not find the split-out halves silently ON. */
function completeCategories(
  saved: Partial<Record<SyncCategory, boolean>> | undefined,
): Record<SyncCategory, boolean> {
  const cats = { ...DEFAULT_SYNC.categories, ...(saved ?? {}) };
  if (saved) {
    if (saved.chip === undefined && typeof saved.recording === "boolean") cats.chip = saved.recording;
    if (saved.dictionary === undefined && typeof saved.general === "boolean") cats.dictionary = saved.general;
  }
  return cats;
}

/** Element-level shape checks for the two lists that arrive typed only by assertion. The FILE
 *  import path gets a real serde parse in Rust; a sync pull does not — its blob is an opaque
 *  `serde_json::Value` all the way into `hydrate`. A profile missing `hotkey` or `name` throws
 *  in `conflicts()` and `deriveChipTag()`, and there is no error boundary in the tree, so the
 *  throw unmounts the window and kills the debounced config save for the session. Drop the
 *  malformed entries instead, so every path into the store shares one floor.
 *
 *  Deliberately SHAPE ONLY. The sync sanitizers also apply entry ceilings and enum clamps, and
 *  those must NOT be mirrored here: this runs on the user's own on-disk config on every launch,
 *  where a fallback that is "keep the local value" on the sync path becomes a rewrite, and an
 *  entry ceiling becomes silent truncation of the user's data that the armed autosave then
 *  writes back. Shape checks are safe because they only drop what Rust's typed load() would have
 *  rejected anyway. */
function wellFormedProfiles(v: unknown): Profile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (p): p is Profile =>
        !!p && typeof p === "object" &&
        typeof (p as Profile).id === "string" &&
        typeof (p as Profile).name === "string" &&
        // The ELEMENTS, not just the container — the sync sanitizer's floor. A numeric code throws
        // in `canonicalizeCodes`' localeCompare tie-break, which runs in a component body and in
        // the debounced save.
        isStringList((p as Profile).hotkey) &&
        // The activation kind too — the map below explains why the value is load-bearing (an
        // unknown one is rendered AS A COMPONENT and unmounts the window). Dropped, not
        // rewritten, matching the shape-only rule: Rust's typed load rejects such a config
        // anyway; this covers the no-Rust dev path. The legacy spelling survives to the map.
        (["hold", "handsfree", LEGACY_HANDSFREE] as string[]).includes((p as Profile).activation as string),
    )
    // Normalize the pre-rename `"latch"` spelling of `"handsfree"`. Rust's `#[serde(alias)]`
    // already does this for every config it parses, so this only covers the paths that skip
    // Rust — the browser dev path and a hand-edited config.json. Worth doing anyway: the
    // value indexes `GLYPH[p.activation]` in Home, which is rendered AS A COMPONENT, so an
    // unmatched key is `React.createElement(undefined)` and unmounts the main window.
    .map((p) =>
      (p.activation as string) === LEGACY_HANDSFREE ? { ...p, activation: "handsfree" as const } : p,
    );
}

function wellFormedBackends(v: unknown): Backend[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (b): b is Backend =>
      !!b && typeof b === "object" &&
      typeof (b as Backend).id === "string" &&
      typeof (b as Backend).serverUrl === "string" &&
      // A backend id is used verbatim as a keyring account name; the reserved `__…__` namespace
      // is our own snapshot stash. Same rejection the sync path makes.
      !isReservedId((b as Backend).id),
  );
}

function wellFormedAppRules(v: unknown): AppRule[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (r): r is AppRule =>
        !!r && typeof r === "object" &&
        typeof (r as AppRule).id === "string" &&
        typeof (r as AppRule).appId === "string",
    )
    // The one normalization this floor DOES apply, and the exception to the shape-only rule above.
    // `appId` is the rule's matching key, and the audit screen renders it through a filter that
    // deletes invisible characters — so an un-normalized key displays as armed and matches
    // nothing. On a legitimate rule (already trimmed by the editor, no invisible characters) this
    // is a no-op, so it is not the silent rewrite the rule warns about. Rules whose key is
    // entirely invisible are dropped: they could never match and could never be read.
    .map((r) => ({ ...r, appId: normalizeAppId(r.appId) }))
    .filter((r) => r.appId.length > 0);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string");
}

function isReservedId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("__") && id.endsWith("__");
}

/**
 * Retire the global three-way `insertTiming` (off / stop / live) onto the per-Profile
 * `typeAsISpeak` boolean that replaced it.
 *
 * The three-way only ever produced a distinct outcome in ONE of its twelve
 * timing × endpoint × activation combinations — "live" on a streaming, hands-free
 * profile. Everywhere else it silently degraded to insert-on-stop, while the UI kept
 * offering it as if it were a live choice.
 *
 * The dangerous value is `"off"`, which meant *transcribe but never insert anywhere*.
 * Dropping it without a mapping would start typing into the focused app, on the next
 * dictation, for anyone who had deliberately turned insertion off — so it maps onto the
 * insert method that types nothing rather than onto the boolean:
 *
 *   "off"   → insertMethod "clipboard" (text reaches the clipboard, no keystrokes) + false
 *   "stop"  → false
 *   "live"  → true
 *
 * Every EXISTING profile is seeded from the old global. Defaulting them instead would
 * hand a "stop" user live typing, which is the same class of surprise in the other
 * direction. New profiles leave the field undefined and inherit `general.typeAsISpeak`.
 *
 * Runs exactly once, gated by `migrateConfig` on the config's schema version being
 * below 3 (the version that introduced this migration). Presence of the field cannot
 * be the key: Rust's
 * `GeneralSettings.insert_timing` is a non-Option `#[serde(default)]` field, so every
 * config that has passed through `load_config`/`save_config` carries it — a presence
 * gate re-ran this on every launch and reset `typeAsISpeak` to the write-back value.
 * `insertTiming` itself is kept in the type (deprecated) and in the Rust struct — see
 * the note there — so a rollback to an older build still reads a conservative value
 * rather than defaulting itself back to "live".
 */
export function migrateInsertTiming(
  settings: AppSettings,
  profiles: Profile[],
  appRules: AppRule[] = [],
): { settings: AppSettings; profiles: Profile[]; appRules: AppRule[] } {
  const timing = settings.general.insertTiming;
  if (timing !== "off" && timing !== "stop" && timing !== "live") return { settings, profiles, appRules };
  const live = timing === "live";
  return {
    settings: {
      ...settings,
      general: {
        ...settings.general,
        insertMethod: timing === "off" ? "clipboard" : settings.general.insertMethod,
        // The global default a Profile's "Inherit" resolves to. Seeded from the same
        // old value the profiles are, so inheriting and overriding agree after the move.
        typeAsISpeak: live,
        // Written back as the conservative value: if this config is later read by a build
        // that still honours the field, insert-on-stop is the choice that can't surprise.
        insertTiming: "stop",
      },
    },
    // Only seed profiles that haven't been given an explicit value already (a config
    // written by a newer build and then re-read by this path).
    profiles: profiles.map((p) => (p.typeAsISpeak === undefined ? { ...p, typeAsISpeak: live } : p)),
    // "off" meant never insert ANYWHERE, and a per-app `insertMethod` override out-ranks the
    // migrated global "clipboard" — so a rule pinning paste/direct for some app would have
    // started typing real keystrokes into it the moment the global short-circuit went away.
    // Coerce those to clipboard too; `block`, chords and everything else stay as they were.
    appRules:
      timing === "off"
        ? appRules.map((r) => (r.insertMethod == null ? r : { ...r, insertMethod: "clipboard" as const }))
        : appRules,
  };
}

/**
 * Schema version written into every saved config. Bumped when a one-shot migration is
 * added to `migrateConfig`; the migration runs for configs below it and never again.
 *   2 — backends/profiles split (legacy v1 had `modes`)
 *   3 — `insertTiming` retired onto `typeAsISpeak` (`migrateInsertTiming`)
 */
export const CONFIG_VERSION = 3;

/**
 * Normalize a loaded config to the current shape. The Rust `load()` already migrates,
 * but this guards the no-Rust `pnpm dev` path and any version skew during dev.
 */
function migrateConfig(raw: unknown): Config {
  const c = raw as Record<string, unknown> | null;
  // No config at all = a genuinely fresh install: EMPTY (no seeded backend or
  // profiles) — the first-run onboarding / Home checklist takes it from here.
  if (!c || typeof c !== "object") {
    return { settings: DEFAULT_SETTINGS, backends: [], profiles: [] };
  }
  // Already v2 (has `backends`).
  if (Array.isArray((c as { backends?: unknown }).backends)) {
    const version = typeof c.version === "number" ? c.version : 0;
    const settings = withSettingsDefaults(c.settings);
    const profiles = wellFormedProfiles(c.profiles);
    const appRules = wellFormedAppRules((c as { appRules?: unknown }).appRules);
    const migrated = version < 3 ? migrateInsertTiming(settings, profiles, appRules) : { settings, profiles, appRules };
    return {
      settings: migrated.settings,
      backends: wellFormedBackends(c.backends),
      profiles: migrated.profiles,
      appRules: migrated.appRules,
      version: CONFIG_VERSION,
    };
  }
  // Legacy v1: `profiles` were Backends; `modes` were ModeBindings. A legacy config
  // without modes never dictated — leave profiles empty (the checklist offers starters).
  const backends = wellFormedBackends(c.profiles);
  const modes = Array.isArray((c as { modes?: unknown }).modes)
    ? ((c as { modes: Record<string, unknown>[] }).modes)
    : [];
  const profiles: Profile[] = modes.map((m) => {
    const isHold = m.mode === "hold";
    return {
      id: isHold ? "hold" : "handsfree",
      name: isHold ? "Push-to-talk" : "Hands-free",
      activation: isHold ? "hold" : "handsfree",
      enabled: !!m.enabled,
      hotkey: isStringList(m.hotkey) ? m.hotkey : [],
      backendId: (m.profileId as string | null) ?? null,
    };
  });
  const migrated = migrateInsertTiming(withSettingsDefaults(c.settings), profiles);
  return { settings: migrated.settings, backends, profiles: migrated.profiles, version: CONFIG_VERSION };
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
  /** Qualifies a "none" outcome that was NOT a cancel: the user aborted the translate-to
   *  picker after release, so the transcript was kept but nothing was inserted. Set in the
   *  SAME call as `sessionOutcome` (the chip is edge-triggered on that), "-saved" only when
   *  a History record was actually written. null = no such note. */
  sessionNote: "not-inserted" | "not-inserted-saved" | null;
  /** The RESOLVED translation targets of the active session — what will actually be injected,
   *  not what the Profile is configured with. The two diverge once a per-session picker can
   *  change them, and the authoritative value (`sessionTranslation` in streaming.ts) lives in
   *  module scope the chip's window can never read. Empty/null = this session doesn't translate;
   *  the chip then falls back to the home Profile's configured targets for its standby preview. */
  sessionTargets: string[] | null;
  /** What the chip may NOT promise about the route yet — the answer to "what will this
   *  session translate into" while it is still open:
   *   • "undecided" — push-to-talk with the picker armed: the targets are asked at release;
   *   • "choosing"  — hands-free: the picker is on screen right now;
   *   • "original"  — the user explicitly chose to insert the original only (acknowledged
   *                   briefly by the chip, then silent).
   *  null = nothing pending: `sessionTargets` (or the standby preview) is the truth. */
  routePending: "undecided" | "choosing" | "original" | null;
  /** Why this session's translation didn't land, set WITH the idle transition alongside
   *  `sessionOutcome`. Drives the chip's truthful done marker: without it a session that
   *  inserted the ORIGINAL after a failed translate is indistinguishable from one that
   *  translated successfully. null = no failure (or no translation configured). */
  translateFailure: TranslateFailure | null;
  /** What the current status is waiting on, when the wait is long enough that
   *  the status word alone reads as a hang (the cold translate). Cleared in the
   *  SAME setDictation call as every transition to idle/error, so a stale phase
   *  can never outlive its session. */
  dictationPhase: DictationPhase | null;

  connections: Record<string, ConnectionInfo | undefined>; // keyed by Backend id

  /** P28: per-Backend usage stats (GET /v1/usage), keyed by Backend id. A
   *  present-but-null value means "fetched and unsupported" (hide the stats
   *  surfaces); an absent key means "not fetched yet". Runtime-only — kept off
   *  the persisted Config. Fed by the usage controller (lib/usage.ts). */
  usage: Record<string, UsageStats | null>;

  /** Per-Backend server capabilities (GET /v1/me), keyed by Backend id. Same
   *  convention as `connections`/`usage`: an ABSENT key means "not fetched
   *  yet", a present-but-null value means "fetched and unsupported" (standard
   *  or old server). Runtime-only — never persisted into Config. Cached here
   *  rather than refetched per mount because the non-React callers
   *  (streaming.ts, preload.ts) have no hook to hang a fetch off. Fed by
   *  lib/capabilities.ts. */
  caps: Record<string, Capabilities | null>;

  /** P31: which Backend the usage VIEW (Home strip + Statistics page) shows. null =
   *  follow the dictation/home-target backend. Runtime-only (a view preference, not
   *  persisted). The chip readout ignores this — it always uses activeStatsBackend. */
  usageViewBackendId: string | null;

  /** The Statistics page's own usage document: fetched for the filters it has set
   *  (`usageViewQuery`) against the viewed backend, tagged with the query signature it
   *  answers so a stale response is ignored. null = nothing fetched yet / unsupported.
   *  Runtime-only. Fed by lib/usage.ts. */
  usageView: { sig: string; stats: UsageStats | null } | null;
  /** What the Statistics page asked for (range preset or custom span, stage filter).
   *  Per-device view state — never synced, never persisted. */
  usageViewQuery: UsagePageQuery;

  /** Last config auto-save failure (disk full / read-only / IPC), surfaced as a banner so the
   *  user knows their recent settings/backends/profiles changes were NOT written to disk and
   *  may be lost on restart. null = last save succeeded. Runtime-only; set by the persistence
   *  auto-save, cleared on the next successful save. */
  saveError: string | null;
  // What KIND of notice saveError holds, so the banner can frame it correctly: "save" = an actual
  // write/conflict failure ("Couldn't save…"), "load" = a startup load-recovery / load-failure notice
  // (which is self-contained and must NOT show the save-failure framing). null when saveError is null.
  saveErrorKind: "save" | "load" | null;
  /** Failure-doorway banner ("Transcription failed — View logs"); null = hidden.
   *  `showLogs: false` = the message already says everything the log knows,
   *  so the banner drops its "View logs" affordance (truthful-toast contract). */
  logsDoorway: { msg: string; showLogs: boolean } | null;
  /** Plain strings keep the legacy contract (View logs shown). */
  setLogsDoorway: (msg: string | { msg: string; showLogs: boolean } | null) => void;

  /** Retro-translate runs by record key. Runtime-only, but held in the
   *  STORE (not viewer state) on purpose: the chunk loop keeps running
   *  when the viewer unmounts (page switch), and a remounted viewer must
   *  re-attach to the live card instead of losing it. */
  trRuns: Record<string, { run: TranslateRunUi; mode?: "fluent" | "faithful" }>;
  setTrRun: (
    okey: string,
    run: TranslateRunUi | null,
    mode?: "fluent" | "faithful",
  ) => void;

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
  updateLogging: (patch: Partial<NonNullable<AppSettings["logging"]>>) => void;
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

  /** Store a Backend's fetched capabilities (null = fetched-but-unsupported). */
  setCaps: (backendId: string, caps: Capabilities | null) => void;

  /** Pick which Backend the usage view shows (null = follow the dictation target). */
  setUsageViewBackend: (id: string | null) => void;
  /** Store the Statistics page's fetched document for a query signature. */
  setUsageView: (sig: string, stats: UsageStats | null) => void;
  /** Change what the Statistics page asks for (the controller refetches). */
  setUsageViewQuery: (q: UsagePageQuery) => void;

  /** Set (or clear, with null) the config-save error banner. */
  setSaveError: (msg: string | null, kind?: "save" | "load") => void;
  /** True once initConfig hydrated (or determined there's nothing to load) — the
   *  onboarding gate waits on this so it can't flash over a config still loading. */
  configLoaded: boolean;
  setConfigLoaded: () => void;
  /** The load failed at the IPC level (the store holds the EMPTY boot state, not the user's
   *  config). The first-run gate must not open on it: every exit from onboarding is a store
   *  write the armed auto-save would persist over the real config. */
  configLoadFailed: boolean;
  setConfigLoadFailed: () => void;

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
      sessionNote: "not-inserted" | "not-inserted-saved" | null;
      sessionTargets: string[] | null;
      routePending: "undecided" | "choosing" | "original" | null;
      translateFailure: TranslateFailure | null;
      dictationPhase: DictationPhase | null;
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
  // hasOwn, not `in`, for the same reason as `setUsage`'s: a blob-authored id like `constructor`
  // is inherited-present, so `in` reports a reference this map does not hold and rebuilds
  // `settings` when nothing pointed at the backend — the spurious churn this function's docstring
  // says it exists to avoid, which then triggers a config save and a push. `isReservedBackendId`
  // rejects only the `__…__` namespace, so those ids survive `sanitizeBackends`.
  if (sync && (sync.backendId === id || hasOwn(sync.urlOverrides, id))) {
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

function evictBackendCaches(s: AppState, id: string) {
  const connections = { ...s.connections };
  delete connections[id];
  const usage = { ...s.usage };
  delete usage[id];
  const caps = { ...s.caps };
  delete caps[id];
  return { connections, usage, caps };
}

export const useApp = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  // Empty until hydrate() — fresh installs genuinely have no backends/profiles
  // (the onboarding gate keys on that), and the persistence guard already
  // prevents saving before the real config loads.
  backends: [],
  profiles: [],
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
  sessionNote: null,
  sessionTargets: null,
  routePending: null,
  translateFailure: null,
  dictationPhase: null,

  connections: {},
  usage: {},
  caps: {},
  usageViewBackendId: null,
  usageView: null,
  usageViewQuery: DEFAULT_PAGE_QUERY,
  saveError: null,
  saveErrorKind: null,
  logsDoorway: null,
  setLogsDoorway: (msg) =>
    set({ logsDoorway: typeof msg === "string" ? { msg, showLogs: true } : msg }),

  trRuns: {},
  setTrRun: (okey, run, mode) =>
    set((s) => {
      const next = { ...s.trRuns };
      if (run == null) delete next[okey];
      else next[okey] = { run, mode: mode ?? next[okey]?.mode };
      return { trRuns: next };
    }),

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
      // Own-property read, same reason as the `in` above: an inherited `constructor` hands `cur`
      // a function, so the `cur === next` short-circuit could never fire for such an id.
      const cur = (hasOwn(sync.urlOverrides, backendId) ? sync.urlOverrides[backendId] : null) ?? null;
      if (cur === next) return {};
      const urlOverrides = { ...sync.urlOverrides };
      if (next) urlOverrides[backendId] = next;
      else delete urlOverrides[backendId];
      // The effective connect target changed: drop the cached connection +
      // usage + caps so status/classification re-test against the new address.
      return {
        settings: { ...s.settings, sync: { ...sync, urlOverrides } },
        ...evictBackendCaches(s, backendId),
      };
    }),
  updateGeneral: (patch) =>
    set((s) => ({ settings: { ...s.settings, general: { ...s.settings.general, ...patch } } })),
  updateRecording: (patch) =>
    set((s) => ({ settings: { ...s.settings, recording: { ...s.settings.recording, ...patch } } })),
  updateLogging: (patch) =>
    set((s) => ({
      settings: {
        ...s.settings,
        logging: { ...DEFAULT_SETTINGS.logging!, ...(s.settings.logging ?? {}), ...patch },
      },
    })),

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
        return { backends, ...evictBackendCaches(s, b.id) };
      }
      return { backends };
    }),
  removeBackend: (id) =>
    set((s) => {
      // Drop the removed backend's cached connection + usage + caps too, so a re-added backend
      // that recycles the id (or a late in-flight fetch) can't read the dead server's state.
      return {
        backends: s.backends.filter((b) => b.id !== id),
        // Only build a new profiles array if a profile actually referenced the removed backend —
        // map() always returns a fresh reference, and the auto-save subscriber treats any new
        // profiles ref as a chord change and re-registers the OS global hotkeys for nothing.
        profiles: s.profiles.some((p) => p.backendId === id)
          ? s.profiles.map((p) => (p.backendId === id ? { ...p, backendId: null } : p))
          : s.profiles,
        ...evictBackendCaches(s, id),
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
      // hasOwn, not `in`: an id like `constructor` is inherited-present, and skipping the write
      // for it would leave the prototype member in place for every reader below.
      if (hasOwn(s.usage, backendId) && JSON.stringify(s.usage[backendId]) === JSON.stringify(stats)) return {};
      return { usage: { ...s.usage, [backendId]: stats } };
    }),

  setUsageView: (sig, stats) =>
    set((s) => {
      // Same stability rule as setUsage: the 30 s poll re-answers the same query with an
      // identical document; keep the reference so the page does not re-render for nothing.
      if (s.usageView && s.usageView.sig === sig && JSON.stringify(s.usageView.stats) === JSON.stringify(stats)) return {};
      return { usageView: { sig, stats } };
    }),
  setUsageViewQuery: (q) => set({ usageViewQuery: q }),

  setCaps: (backendId, caps) =>
    set((s) => {
      // Same stability guard as setUsage, for the same reason: refreshCaps can be
      // re-triggered by unrelated store churn and hands us a structurally identical
      // object each time. hasOwn, not `in`, so an id like `constructor` doesn't read
      // as already-present via the prototype.
      if (hasOwn(s.caps, backendId) && JSON.stringify(s.caps[backendId]) === JSON.stringify(caps)) return {};
      return { caps: { ...s.caps, [backendId]: caps } };
    }),

  setUsageViewBackend: (id) => set({ usageViewBackendId: id }),

  setSaveError: (msg, kind = "save") => set({ saveError: msg, saveErrorKind: msg ? kind : null }),
  configLoaded: false,
  setConfigLoaded: () => set({ configLoaded: true }),
  configLoadFailed: false,
  setConfigLoadFailed: () => set({ configLoadFailed: true }),

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

  hydrate: (cfg) =>
    set((s) => {
      const c = migrateConfig(cfg);
      // Same invalidation `upsertBackend` and `setUrlOverride` do, for the same reason — this
      // is the third writer of `backends` and the only one that was missing it. It matters most
      // here: `hydrate` is also how a sync pull or an imported file replaces the list, so a
      // blob that keeps an existing id and repoints its address would otherwise leave the OLD
      // server's `{ok: true}` verdict — the green "connected" on the card whose own comment
      // calls it the audit surface — bound to the new host, permanently, since every re-test is
      // a user gesture. On the startup path nothing has been tested yet, so this drops nothing.
      const prev = new Map(s.backends.map((b) => [b.id, b]));
      const connections = { ...s.connections };
      const usage = { ...s.usage };
      const caps = { ...s.caps };
      for (const id of new Set([
        ...Object.keys(connections),
        ...Object.keys(usage),
        ...Object.keys(caps),
      ])) {
        const before = prev.get(id);
        const after = c.backends.find((b) => b.id === id);
        if (!after || !before || before.serverUrl !== after.serverUrl || before.hasApiKey !== after.hasApiKey) {
          delete connections[id];
          delete usage[id];
          delete caps[id];
        }
      }
      return {
        settings: c.settings,
        backends: c.backends,
        profiles: c.profiles,
        appRules: c.appRules ?? [],
        connections,
        usage,
        caps,
      };
    }),
}));
