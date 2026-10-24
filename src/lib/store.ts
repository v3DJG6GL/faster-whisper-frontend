import { create } from "zustand";
import { canonicalActivation } from "./types";
import { DEFAULT_PAGE_QUERY, type UsagePageQuery, viewSigBackend, viewSigSource } from "./usageDerive";
import type {
  AppRule,
  AppSettings,
  Backend,
  Capabilities,
  Config,
  ConnectionInfo,
  DictationPhase,
  ServerWork,
  DictationStatus,
  FocusedApp,
  MicFallback,
  Profile,
  SyncCategory,
  SyncSettings,
  SyncSubSettings,
  ThemeName,
  UsageStats,
} from "./types";
import type { TranslateRunUi } from "./retroTranslate";
import type { TranslateFailure } from "./dictation/dictationTranslate";
import { newSpeakMemo, stepSpeaking } from "./dictation/speaking";
import { swap } from "./arr";
import { hasOwn } from "./own";
import { appRuleKey, trimLeadingInvisible, wellFormedAppRules } from "./sanitize";
import { applyTheme } from "./theme";
import { serverUrlFromPeer } from "./backends";

// Derives `speaking` (green vs amber) from the RMS level stream centrally, so the
// main-window surfaces (Home button, sidebar dot, waveforms) all agree with the chip
// without each re-running the smoothing. One singleton memo: the store is a singleton.
const speakMemo = newSpeakMemo();

/** Ceiling on quick-launch entries reaching the store. The editor caps the user at 6 out of ~11
 *  possible targets; this is loose on purpose (the list is synced back, so truncating near the
 *  real count would propagate to the user's other devices) while still bounding a hostile list. */
const MAX_QUICK_LAUNCH = 100;

/**
 * Frontend store. Boots on default settings with no backends/profiles; the persistence
 * layer wires load/save through Tauri commands (config persisted as JSON in the app config
 * dir, API keys in the OS keyring). Keep mutations here so persistence can
 * subscribe in one place.
 *
 * A Backend is a server connection (URL + model + decode defaults). A Profile is
 * a dictation setup (activation + chord + a target Backend + optional overrides).
 */

// DEFAULT_SYNC lives in defaults.ts (pure data, no import cycle with the settings
// manifest); re-exported here so importers don't churn.
import { DEFAULT_SETTINGS, DEFAULT_SYNC } from "./defaults";
import { completeGates, withLegacySubKeys } from "./settingsManifest";
export { DEFAULT_SYNC };

/** Deep-merge loaded settings over the defaults so a config written by an older version
 *  — or with fields omitted by the backend's skip-empty serialization (e.g. an empty
 *  `recording.quickLaunch`) — still gets every field. Without this, a missing field is
 *  `undefined` at runtime and crashes code that assumes the typed shape. */
export function withSettingsDefaults(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Partial<AppSettings>;
  const recording = { ...DEFAULT_SETTINGS.recording, ...(s.recording ?? {}) };
  // This merge fills MISSING keys but cannot vouch for the type of a PRESENT one, and a pulled
  // sync blob replaces the whole `recording` block. `quickLaunch` elements are used unguarded in
  // the chip and the Settings editor (kind/target compared as strings, interpolated into keys,
  // `e.kind` rendered as a React child), and with no error boundary in either webview a
  // non-string leaf unmounts the window. Require string leaves here, at the choke point.
  recording.quickLaunch = Array.isArray(recording.quickLaunch)
    ? recording.quickLaunch.filter(
        (e) =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { id?: unknown }).id === "string" &&
          typeof (e as { kind?: unknown }).kind === "string" &&
          typeof (e as { target?: unknown }).target === "string",
      )
      // First entry per id wins: the editor keys rows and removes by id, so a foreign blob's
      // duplicate ids would make Remove delete both rows (and collide React keys in editor and chip).
      // One pass (a Set): it runs before the ceiling below, on whatever length the blob carries.
      .filter(((seen) => (e: unknown) => {
        const id = (e as { id: string }).id;
        return seen.has(id) ? false : (seen.add(id), true);
      })(new Set<string>()))
      // The one sync-supplied list no sanitizer bounds. It is re-serialized into the overlay
      // payload on every level tick, rendered one button/row per entry in the chip and the
      // editor, and persisted, so an oversized list survives restarts. MAX_QUICK_LAUNCH says why
      // the ceiling is loose.
      .slice(0, MAX_QUICK_LAUNCH)
    : [];
  // A quick-launch entry saved before the Home screen became Dashboard still names it by its
  // old id.
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
      // persisted in full — so a miss here is permanent.
      sub: completeSub(s.sync?.sub, migratedCategories),
      urlOverrides: { ...(s.sync?.urlOverrides ?? {}) },
    },
    logging: { ...DEFAULT_SETTINGS.logging!, ...(s.logging ?? {}) },
  };
}

/** Complete the per-setting sync gates from a persisted (possibly
 *  older-version) config: manifest defaults ← old category toggles (an OFF
 *  category seeds its members OFF) ← legacy sub keys ← saved gate values.
 *  The pre-rename keys (`recordingsDir`, `latchAutoStop`) are also written BACK
 *  (derived from the gates) so a downgraded app still reads the same intent. */
function completeSub(
  saved: Partial<SyncSubSettings> | undefined,
  savedCategories: Partial<Record<SyncCategory, boolean>> | undefined,
): SyncSubSettings {
  return withLegacySubKeys(completeGates(saved, savedCategories));
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
        canonicalActivation((p as Profile).activation) !== undefined,
    )
    // Normalize the pre-rename `"latch"` spelling of `"handsfree"`. Rust's `#[serde(alias)]`
    // already does this for every config it parses, so this only covers the paths that skip
    // Rust — the browser dev path and a hand-edited config.json. Worth doing anyway: the
    // value indexes `GLYPH[p.activation]` in Dashboard, which is rendered AS A COMPONENT, so an
    // unmatched key is `React.createElement(undefined)` and unmounts the main window.
    .map((p) => {
      const activation = canonicalActivation(p.activation)!;
      return activation === p.activation ? p : { ...p, activation };
    });
}

function wellFormedBackends(v: unknown): Backend[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (b): b is Backend =>
        !!b && typeof b === "object" &&
        typeof (b as Backend).id === "string" &&
        typeof (b as Backend).serverUrl === "string" &&
        // A backend id is used verbatim as a keyring account name; the reserved `__…__` namespace
        // is our own snapshot stash. Same rejection the sync path makes.
        !isReservedId((b as Backend).id),
    )
    .map((b) => {
      // Older builds stored a lenient address (`http:/host:8000`) verbatim. The sync sanitizer
      // canonicalises a peer's copy of it, so a local copy left lenient compared unequal to the
      // very same host: every pull raised a "server-url" consent row and the restore dialog
      // called the key "moved". Store it in the peer's spelling; one the sanitizer would blank
      // (an unsupported scheme) stays verbatim, so its connect error still names it.
      const serverUrl = serverUrlFromPeer(b.serverUrl) || b.serverUrl;
      return serverUrl === b.serverUrl ? b : { ...b, serverUrl };
    });
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
 * below 3. Presence of the field cannot be the key: Rust's
 * `GeneralSettings.insert_timing` is a non-Option `#[serde(default)]` field, so every
 * config that has passed through `load_config`/`save_config` carries it — a presence
 * gate would re-run this on every launch and reset `typeAsISpeak` to the write-back value.
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
 * Normalize a config to the current shape on every path into the store (startup load, sync
 * pull, file import). Rust's `load()` already migrates legacy v1, so that branch only guards
 * the no-Rust `pnpm dev` path; the v3 `insertTiming` migration and the shape floor run only here.
 */
function migrateConfig(raw: unknown): Config {
  const c = raw as Record<string, unknown> | null;
  // No config at all = a genuinely fresh install: EMPTY (no seeded backend or
  // profiles) — the first-run onboarding / Dashboard checklist takes it from here.
  if (!c || typeof c !== "object") {
    return { settings: DEFAULT_SETTINGS, backends: [], profiles: [] };
  }
  // Post-split shape (has `backends`): v2 and later.
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
  /** What the server is doing behind a "listening" status (cold model load / an utterance it
   *  holds or is decoding) — server-authored, see types.ServerWork. null = truly ready. */
  serverWork: ServerWork;
  level: number; // 0..1 audio RMS for the visualizer
  speaking: boolean; // derived from level (smoothed): actively speaking vs armed-silent
  partial: string; // live partial transcript for the chip preview
  activeProfile: string | null; // id of the Profile currently dictating
  dictationError: string | null;
  /** Decode overrides the server refused (admin-locked) for the active stream. */
  overridesIgnored: string[];
  /** The pinned mic isn't connected; this dictation records from the default input instead. */
  micFallback: MicFallback | null;
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
  /** Qualifies the end-of-session outcome. The not-inserted pair marks a "none" outcome that
   *  was NOT a cancel: the user aborted the translate-to picker after release, so the
   *  transcript was kept but nothing was inserted. Set in the SAME call as `sessionOutcome`
   *  (the chip is edge-triggered on that), "-saved" only when a History record was actually
   *  written. "incomplete" can accompany ANY outcome (typed / clipboard / none): the stream
   *  ended short (the drain timed out before the server's last final) but some text landed
   *  or was kept — the last phrase may be missing. null = no such note. */
  sessionNote: "not-inserted" | "not-inserted-saved" | "incomplete" | null;
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

  /** Per-Backend usage stats (GET /v1/usage), keyed by Backend id. A
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

  /** Which Backend the usage VIEW (Home strip + Statistics page) shows. null =
   *  follow the dictation/home-target backend. Runtime-only (a view preference, not
   *  persisted). The chip readout ignores this — it always uses activeStatsBackend. */
  usageViewBackendId: string | null;

  /** The Statistics page's own usage document: fetched for the filters it has set
   *  (`usageViewQuery`) against the viewed backend, tagged with the query signature it
   *  answers so a stale response is ignored. null = nothing fetched yet / unsupported.
   *  `failed`: the fetch for `sig` failed — `stats` is then the last good document of the same
   *  backend + target (any query), kept up so a refused range doesn't wipe the page, else null.
   *  Runtime-only. Fed by lib/usage.ts. */
  usageView: { sig: string; stats: UsageStats | null; failed?: boolean } | null;
  /** The Statistics calendar's own document: the last 365 days under the page's stage
   *  filter, whatever range the page shows, so the calendar is always a year (the page's
   *  own document is used instead when its range already covers one). `failed` marks a
   *  fetch for `sig` that failed — `stats` is then the last good year from the same backend +
   *  target (or null), shown as stale, as usageView does. Runtime-only. */
  usageYear: { sig: string; stats: UsageStats | null; failed?: boolean } | null;
  /** What the Statistics page asked for (range preset or custom span, stage filter).
   *  Per-device view state — never synced, never persisted. */
  usageViewQuery: UsagePageQuery;

  /** The config banner: a save failure or conflict freeze (disk full / read-only / IPC — the
   *  recent settings/backends/profiles changes were NOT written to disk and may be lost on
   *  restart) or a startup load notice; `saveErrorKind` says which. Runtime-only; set by the
   *  persistence auto-save, which clears a save failure on the next successful save. */
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

  /** Runtime sync status (never persisted): what the Sync tab's status
   *  line shows. `syncUnsupported` = the sync backend 404'd the endpoint
   *  (build too old); `lastSyncedAt`/`lastSyncDevice` mirror sync-state.json. */
  syncStatus: "idle" | "syncing" | "ok" | "error";
  syncError: string | null;
  syncUnsupported: boolean;
  lastSyncedAt: number | null; // epoch ms of the last successful pull/push
  lastSyncDevice: string | null; // last WRITER's device label (server-reported)
  /** Bumped on every change to the engine's pending review / conflict. The sync dialogs read
   *  those through non-reactive getters and re-render on this: the status line cannot carry it,
   *  since closing one prompt while its sibling waits writes the sibling's (unchanged) notice. */
  syncPromptSeq: number;

  setTheme: (t: ThemeName) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateGeneral: (patch: Partial<AppSettings["general"]>) => void;
  updateRecording: (patch: Partial<AppSettings["recording"]>) => void;
  updateLogging: (patch: Partial<NonNullable<AppSettings["logging"]>>) => void;
  /** Shallow-patch settings.sync: a nested map (`sub`) must arrive already merged by the caller. */
  updateSync: (patch: Partial<SyncSettings>) => void;
  /** Set (or clear, with null/empty) this device's address override for a
   *  backend. Evicts the backend's caches (connection, usage, caps, Statistics
   *  documents) — the effective target changed (as upsertBackend's URL edit). */
  setUrlOverride: (backendId: string, url: string | null) => void;

  upsertBackend: (b: Backend) => void;
  /** Drop a backend's cached connection, usage, caps and Statistics documents (what upsertBackend
   *  evicts on a URL or key-presence change) — for a key rotation the store can't see. */
  forgetBackendCaches: (id: string) => void;
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
  setUsageYear: (sig: string, stats: UsageStats | null) => void;
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

  /** Update the runtime sync status line (engine-owned). */
  setSyncRuntime: (
    patch: Partial<{
      syncStatus: "idle" | "syncing" | "ok" | "error";
      syncError: string | null;
      syncUnsupported: boolean;
      lastSyncedAt: number | null;
      lastSyncDevice: string | null;
      syncPromptSeq: number;
    }>,
  ) => void;

  /** Update live dictation runtime (status / level / partial transcript). */
  setDictation: (
    patch: Partial<{
      status: DictationStatus;
      warming: boolean;
      micLive: boolean;
      serverWork: ServerWork;
      level: number;
      partial: string;
      activeProfile: string | null;
      dictationError: string | null;
      overridesIgnored: string[];
      micFallback: MicFallback | null;
      targetApp: FocusedApp | null;
      targetSkip: "blocked" | "notEditable" | null;
      lastInsert: { kind: "typed" | "clipboard"; seq: number } | null;
      sessionOutcome: "typed" | "clipboard" | "none" | null;
      sessionNote: "not-inserted" | "not-inserted-saved" | "incomplete" | null;
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
  // hasOwn, not `in`: a blob-authored id like `constructor` is inherited-present, so `in` would
  // rebuild `settings` when nothing pointed at the backend — a spurious config save + push.
  // `isReservedBackendId` rejects only the `__…__` namespace, so those ids survive `sanitizeBackends`.
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

function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  const next = [...arr];
  if (i >= 0) next[i] = item;
  else next.push(item);
  return next;
}

/** Whether a usage-view signature (lib/usage.ts viewSignature) names backend `id`. */
function sigNames(sig: string, id: string): boolean {
  return viewSigBackend(sig) === id;
}

// Drops a backend's cached connection, usage and caps, plus the Statistics documents naming it: a
// usage-view signature carries no caller identity, so after a key rotation the old caller's
// documents would read as fresh (others keep their reference, so nothing re-renders for them).
function evictBackendCaches(s: AppState, id: string) {
  const connections = { ...s.connections };
  delete connections[id];
  const usage = { ...s.usage };
  delete usage[id];
  const caps = { ...s.caps };
  delete caps[id];
  const usageView = s.usageView && sigNames(s.usageView.sig, id) ? null : s.usageView;
  const usageYear = s.usageYear && sigNames(s.usageYear.sig, id) ? null : s.usageYear;
  return { connections, usage, caps, usageView, usageYear };
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
  serverWork: null,
  level: 0,
  speaking: false,
  partial: "",
  activeProfile: null,
  dictationError: null,
  overridesIgnored: [],
  micFallback: null,
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
  usageYear: null,
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
  syncPromptSeq: 0,

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
      // Own-property read: an inherited `constructor` hands `cur` a function, so the
      // `cur === next` short-circuit could never fire for such an id.
      const cur = (hasOwn(sync.urlOverrides, backendId) ? sync.urlOverrides[backendId] : null) ?? null;
      if (cur === next) return {};
      const urlOverrides = { ...sync.urlOverrides };
      if (next) urlOverrides[backendId] = next;
      else delete urlOverrides[backendId];
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
      // A changed server URL (or key presence) makes every cache under this id describe the OLD
      // server, yet effectiveServerKind, the status dot, the decode-override gate and the usage
      // poll all key on the backend id — evict them so they re-test against the new target.
      if (prev && (prev.serverUrl !== b.serverUrl || prev.hasApiKey !== b.hasApiKey)) {
        return { backends, ...evictBackendCaches(s, b.id) };
      }
      // A changed Server type on the same target keeps the connection, but the cached caps were
      // probed (or pinned null) under the old kind: drop them so the Backends list re-probes
      // under the new one, or the row's info button stays disabled after Standard → Auto/Full.
      if (prev && prev.kind !== b.kind && hasOwn(s.caps, b.id)) {
        const caps = { ...s.caps };
        delete caps[b.id];
        return { backends, caps };
      }
      return { backends };
    }),
  forgetBackendCaches: (id) => set((s) => evictBackendCaches(s, id)),
  removeBackend: (id) =>
    set((s) => {
      // Evict the removed backend's caches too (evictBackendCaches), so a re-added backend that
      // recycles the id (or a late in-flight fetch) can't read the dead server's state.
      return {
        backends: s.backends.filter((b) => b.id !== id),
        // Only build a new profiles array if a profile actually referenced the removed backend —
        // map() always returns a fresh reference, and the auto-save subscriber treats any new
        // profiles ref as a change: a needless config save + sync push (re-registration itself is
        // gated on the binding signature, persistence.ts bindingSig).
        profiles: s.profiles.some((p) => p.backendId === id)
          ? s.profiles.map((p) => (p.backendId === id ? { ...p, backendId: null } : p))
          : s.profiles,
        ...evictBackendCaches(s, id),
        // Scrub the other id-keyed references so none dangle, keeping each ref stable when it
        // didn't point at this backend (else the auto-save subscriber sees a spurious change).
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
      // for a fresh one. A name that renders blank (a synced one) copies as the label the lists
      // show for it, never as a bare "copy".
      const name = `${typeof src.name === "string" && trimLeadingInvisible(src.name) ? src.name : "Untitled backend"} copy`;
      const copy: Backend = { ...src, id: crypto.randomUUID(), name, hasApiKey: false };
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
      // Clear the chord on the copy — a duplicate must never inherit the same one. A name that
      // renders blank copies as "Untitled profile copy", as for backends above.
      const name = `${typeof src.name === "string" && trimLeadingInvisible(src.name) ? src.name : "Untitled profile"} copy`;
      const copy: Profile = { ...src, id: crypto.randomUUID(), name, hotkey: [] };
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
      // Rules are MATCHED by appId and resolveInjectionTarget takes the first match, so a second
      // rule for an already-ruled app would never apply: replace any rule for this appId (or the
      // edited id) in place, so the rule just saved is the one that takes effect.
      const key = appRuleKey(r.appId);
      const matches = (x: AppRule) => x.id === r.id || appRuleKey(x.appId) === key;
      const pos = s.appRules.findIndex(matches);
      const rest = s.appRules.filter((x) => !matches(x));
      return { appRules: pos < 0 ? [...rest, r] : [...rest.slice(0, pos), r, ...rest.slice(pos)] };
    }),
  removeAppRule: (id) => set((s) => ({ appRules: s.appRules.filter((r) => r.id !== id) })),

  setConnection: (backendId, info) =>
    set((s) => ({ connections: { ...s.connections, [backendId]: info } })),

  setUsage: (backendId, stats) =>
    set((s) => {
      // The 30 s usage poll hands over a fresh object even when the numbers are identical: keep the
      // `usage` reference stable, or every poll re-emits the overlay payload and re-renders the
      // UsageStats chart. The fixed 30-day document is small, so stringify-compare is cheap;
      // JSON.stringify(null) === "null" covers the null path.
      // hasOwn, not `in`: an id like `constructor` is inherited-present, and skipping the write
      // for it would leave the prototype member in place for every reader.
      if (hasOwn(s.usage, backendId) && JSON.stringify(s.usage[backendId]) === JSON.stringify(stats)) return {};
      return { usage: { ...s.usage, [backendId]: stats } };
    }),

  setUsageView: (sig, stats) =>
    set((s) => {
      if (stats === null) {
        if (s.usageView?.sig === sig && s.usageView.failed) return {};
        // Only a document from the same backend + target may stand in (another server's numbers
        // would read as this one's); otherwise null, and the page falls back to the backend's own
        // poll document.
        const prev = s.usageView;
        const src = viewSigSource(sig);
        const carry = prev && src !== null && viewSigSource(prev.sig) === src ? prev.stats : null;
        return { usageView: { sig, stats: carry, failed: true } };
      }
      // Same stability rule as setUsage: the 30 s poll re-answers the same query with an
      // identical document; keep the reference so the page does not re-render for nothing.
      if (s.usageView && s.usageView.sig === sig && !s.usageView.failed && JSON.stringify(s.usageView.stats) === JSON.stringify(stats)) return {};
      return { usageView: { sig, stats } };
    }),
  setUsageYear: (sig, stats) =>
    set((s) => {
      if (stats === null) {
        if (s.usageYear?.sig === sig && s.usageYear.failed) return {};
        // Same carry rule as setUsageView: only a year from the same backend + target stands in.
        const prev = s.usageYear;
        const src = viewSigSource(sig);
        const carry = prev && src !== null && viewSigSource(prev.sig) === src ? prev.stats : null;
        return { usageYear: { sig, stats: carry, failed: true } };
      }
      if (s.usageYear && s.usageYear.sig === sig && !s.usageYear.failed && JSON.stringify(s.usageYear.stats) === JSON.stringify(stats)) return {};
      return { usageYear: { sig, stats } };
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
      // Step the singleton speakMemo only on a level move or a genuine status change — NOT on a
      // same-value "listening" re-assert (the partial handler re-sends it several times a second) —
      // so it steps once per level sample. One shared flag (the chip reads it from its payload)
      // means subscribers re-render only on a transition, not on every RMS tick — important for
      // the always-mounted sidebar dot.
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
      // Same invalidation as `upsertBackend` and `setUrlOverride`: a sync pull or imported file
      // that keeps an existing id but repoints its address would otherwise leave the OLD server's
      // `{ok: true}` "connected" bound to the new host until the user re-tests. On the startup
      // path nothing has been tested yet, so this drops nothing. Like `evictBackendCaches` it also
      // drops the Statistics documents naming such a backend: a pull that adds this server's key
      // never reaches `forgetBackendCaches`, and the signature carries no caller identity.
      const prev = new Map(s.backends.map((b) => [b.id, b]));
      const connections = { ...s.connections };
      const usage = { ...s.usage };
      const caps = { ...s.caps };
      let usageView = s.usageView;
      let usageYear = s.usageYear;
      for (const id of new Set([
        ...Object.keys(connections),
        ...Object.keys(usage),
        ...Object.keys(caps),
        ...[viewSigBackend(s.usageView?.sig), viewSigBackend(s.usageYear?.sig)].filter((x): x is string => x !== null),
      ])) {
        const before = prev.get(id);
        const after = c.backends.find((b) => b.id === id);
        if (!after || !before || before.serverUrl !== after.serverUrl || before.hasApiKey !== after.hasApiKey) {
          delete connections[id];
          delete usage[id];
          delete caps[id];
          if (usageView && sigNames(usageView.sig, id)) usageView = null;
          if (usageYear && sigNames(usageYear.sig, id)) usageYear = null;
        } else if (before.kind !== after.kind) {
          // A pulled Server type change on the same target: same caps-only drop as
          // `upsertBackend`, so the Backends list re-probes under the new kind.
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
        usageView,
        usageYear,
      };
    }),
}));
