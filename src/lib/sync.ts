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

import { useApp, CONFIG_VERSION } from "./store";
import {
  deleteBackendKey,
  isTauri,
  loadSyncState,
  readBackendKeys,
  saveSyncState,
  setBackendKey,
  setDeepFieldDetection,
  syncDeviceInfo,
  syncPull,
  syncPush,
} from "./api";
import { configReady } from "./persistence";
import { effectiveServerUrl, isStorableServerUrl, normalizeUrl, stripUrlNoise } from "./backends";
import { DEFAULT_PASTE_SHORTCUT, PASTE_PRESETS } from "./paste";
import { IS_WINDOWS } from "./platform";
import { hasOwn, ownProp } from "./own";
import { normalizeAppId } from "./sanitize";
import { conflicts, quickAddPeer, QUICK_ADD_PEER_ID } from "./conflicts";
import { LEGACY_HANDSFREE } from "./types";
import type {
  ActivationKind,
  AppRule,
  AppSettings,
  Backend,
  BackendKind,
  Config,
  EndpointKind,
  IndicatorPosition,
  InsertMethod,
  InsertTiming,
  OverlayStatsMetric,
  Profile,
  QuickAddTarget,
  ResponseFormat,
  SyncCategory,
  ThemeName,
  TranscribeSettings,
} from "./types";
import {
  CHIP_FIELDS,
  DICTATION_HISTORY_FIELDS,
  FILE_TRANSCRIPTION_FIELDS,
  TRANSCRIPTION_FIELDS,
  TRANSCRIPTION_PICK_FIELDS,
} from "./syncTypes";
import type {
  SyncBackends,
  SyncBlob,
  SyncChip,
  SyncDeviceInfo,
  SyncDictionary,
  SyncGeneral,
  SyncRecording,
  SyncRemoteState,
  SyncFileTranscriptions,
  SyncState,
  SyncTranscription,
} from "./syncTypes";
import type { SyncSubSettings } from "./types";
import { completeGates } from "./settingsManifest";
import {
  APP_RULE_OVERRIDE_FIELDS,
  APP_RULE_PASTE_FIELDS,
  APP_RULE_LOCAL_ONLY_FIELDS,
  PROFILE_INSERTION_FIELDS,
  BACKEND_DEFAULTS_FIELDS,
  gateApplyScalar,
  gateComposeScalar,
  repinElementFields,
  substituteElementFields,
  type Gates,
} from "./syncGates";

export const ALL_CATEGORIES: SyncCategory[] = [
  "general",
  "recording",
  "chip",
  "backends",
  "profiles",
  "dictionary",
  "appRules",
  "transcription",
  "fileTranscriptions",
  "logging",
];

/** This device's field-level opt-outs (Settings → Sync sub-toggles), with the
 *  behavior-preserving defaults for configs from before they existed. */
export function subSettings(): SyncSubSettings {
  return (
    useApp.getState().settings.sync?.sub ?? {
      recordingsDir: false,
      profileHotkeys: true,
      quickAddHotkey: true,
      transcribePicks: false,
    }
  );
}

/** This device's complete per-setting sync gates (the granular switches on
 *  Settings → Sync), with manifest defaults + legacy/category migration. */
export function settingGates(): Gates {
  const sync = useApp.getState().settings.sync;
  return completeGates(sync?.sub, sync?.categories);
}

/** This machine's appRules bucket. macOS has no app-rules backend; it falls
 *  into the linux bucket harmlessly (rules never match anything there). */
const MY_BUCKET: "linux" | "windows" = IS_WINDOWS ? "windows" : "linux";
const OTHER_BUCKET: "linux" | "windows" = IS_WINDOWS ? "linux" : "windows";

// ── canonical hash ──────────────────────────────────────────────────────────

// stableStringify moved to stable.ts (pure module, shared with the settings
// manifest); re-exported here so existing importers don't churn.
export { stableStringify } from "./stable";
import { stableStringify } from "./stable";

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

/** Category equality — the test that decides whether a category conflicts and prompts, or merges
 *  silently. Compares the canonical strings, NOT their hashes: `hashBlob` builds this exact string
 *  first and then folds it to 32 bits, so the digest comparison was strictly more work for a
 *  probabilistic answer — on inputs one of which (the base) is the server's own last blob. */
/** A JSON object — not null, not an array, not a string. The blob's containers are attacker-shaped
 *  just like its lists, and `Object.entries`/`Object.keys` accept a string by expanding it per code
 *  unit; every ceiling in the engine bounds ENTRY COUNT, which that turns into 4M. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const catEqual = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

/** Bound an await that may never settle. The ONLY unbounded await in the
 *  engine is the keyring read (a locked KWallet parks the request behind a
 *  password prompt indefinitely); everything else rides reqwest's timeout.
 *  Without this, one blocked read wedges the engine for the whole session
 *  (`inFlight` never clears — the finally never runs on a never-settling
 *  promise). Degrading to `fallback` (push without secrets) is always safer
 *  than never pushing again. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ── blob migration: pre-split shapes → the current category layout ──────────

const CHIP_FIELD_SET: ReadonlySet<string> = new Set(CHIP_FIELDS);

/** Own-property partition helpers. Own-props only: the blob is JSON-parsed, so
 *  `__proto__`/`constructor` are ordinary own keys and inherited members must
 *  never be copied (the same hygiene as `typedLike`). */
function pickFields(obj: Record<string, unknown>, fields: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (fields.has(k)) out[k] = obj[k];
  return out;
}
function omitFields(obj: Record<string, unknown>, fields: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (!fields.has(k)) out[k] = obj[k];
  return out;
}

/**
 * Normalize a blob from before the category split (one "recording" holding
 * the chip fields, the quick-add chord under `general`, the pin under
 * `backends`) into the current layout. Runs on EVERY inbound blob — server
 * pulls, the persisted snapshot, import files — so the engine, the merge, and
 * the previews only ever see one shape, and the 3-way base stays comparable
 * with freshly composed blobs after an upgrade.
 *
 * Also the enforcement point for the category boundaries: chip-classified
 * keys are ALWAYS stripped out of `recording` (and vice-versa applied via the
 * apply-side filters), so a blob cannot smuggle e.g. `saveRecordings` past
 * the recording toggle (and its consent gate) by hiding it in another
 * category. Existing new-shape entries win over migrated legacy ones.
 */
export function migrateBlob(blob: SyncBlob): SyncBlob {
  const out: SyncBlob = { ...blob };
  if (isPlainObject(out.recording)) {
    const rec = out.recording as Record<string, unknown>;
    const chipPart = pickFields(rec, CHIP_FIELD_SET);
    if (Object.keys(chipPart).length > 0) {
      out.recording = omitFields(rec, CHIP_FIELD_SET) as SyncRecording;
      if (out.chip === undefined) out.chip = chipPart as SyncChip;
    }
  }
  const g = out.general as (SyncGeneral & { quickAddHotkey?: unknown }) | undefined;
  if (isPlainObject(g) && hasOwn(g, "quickAddHotkey")) {
    const { quickAddHotkey, ...rest } = g;
    out.general = rest as SyncGeneral;
    if (isCodeList(quickAddHotkey) && out.dictionary?.quickAddHotkey === undefined) {
      out.dictionary = { ...(out.dictionary ?? {}), quickAddHotkey };
    }
  }
  // v0.1.63 shipped ONE `transcription` category carrying the history flags
  // too; they now live with their subject (dictation clock → `recording`,
  // file clock → `fileTranscriptions`). Split an old-shape entry, existing
  // new-shape entries winning — same contract as the chip split above.
  if (isPlainObject(out.transcription)) {
    const tr = out.transcription as Record<string, unknown>;
    const dictPart = pickFields(tr, DICTATION_HISTORY_SET);
    const filePart = pickFields(tr, FILE_TRANSCRIPTION_SET);
    if (Object.keys(dictPart).length || Object.keys(filePart).length) {
      out.transcription = omitFields(
        tr,
        new Set([...DICTATION_HISTORY_SET, ...FILE_TRANSCRIPTION_SET]),
      ) as SyncTranscription;
      if (Object.keys(dictPart).length && isPlainObject(out.recording)) {
        out.recording = { ...dictPart, ...(out.recording as object) } as SyncRecording;
      }
      if (Object.keys(filePart).length && out.fileTranscriptions === undefined) {
        out.fileTranscriptions = filePart as SyncFileTranscriptions;
      }
    }
  }
  const b = out.backends as (SyncBackends & { quickAddList?: unknown }) | undefined;
  if (isPlainObject(b) && hasOwn(b, "quickAddList")) {
    const { quickAddList, ...rest } = b;
    out.backends = rest as SyncBackends;
    if (out.dictionary?.quickAddList === undefined && quickAddList !== undefined) {
      out.dictionary = { ...(out.dictionary ?? {}), quickAddList: safeQuickAddTarget(quickAddList) };
    }
  }
  return out;
}

// ── extract: live config → category payloads ───────────────────────────────

function extractGeneral(settings: AppSettings): SyncGeneral {
  const g = settings.general;
  return {
    theme: settings.theme,
    startMinimized: g.startMinimized,
    insertTiming: g.insertTiming,
    typeAsISpeak: g.typeAsISpeak,
    insertMethod: g.insertMethod,
    pasteShortcut: g.pasteShortcut,
    autoEnter: g.autoEnter,
    restoreClipboard: g.restoreClipboard,
    soundEffects: g.soundEffects,
    deepFieldDetection: g.deepFieldDetection,
    openAtLogin: g.openAtLogin,
    // evdevEnabled is machine-local: deliberately absent.
    // quickAddHotkey lives in the `dictionary` category now.
  };
}

/** The recording-proper fields (chip fields split out). `recordingsDir` is a
 *  machine path: live value only when the sub-toggle is on, else the
 *  snapshot's passthrough — never omitted-because-opted-out, which would read
 *  as a local change and erase the field for the devices that do sync it. */
function extractRecording(
  settings: AppSettings,
  syncDir: boolean,
  snapshot: SyncBlob | undefined,
): SyncBlob["recording"] {
  const { recordingsDir, audioBaseDir, ...rest } = settings.recording;
  const out = omitFields(rest, CHIP_FIELD_SET) as SyncRecording;
  // The dictation-history flags live in settings.transcribe but belong to
  // this category (the tab's "Dictation" group governs the same sessions).
  Object.assign(
    out,
    pickFields((settings.transcribe ?? {}) as Record<string, unknown>, DICTATION_HISTORY_SET),
  );
  const dir = syncDir ? recordingsDir : snapshot?.recording?.recordingsDir;
  if (dir !== undefined) out.recordingsDir = dir;
  // audioBaseDir rides the same machine-path sub-toggle as recordingsDir.
  const base = syncDir ? audioBaseDir : snapshot?.recording?.audioBaseDir;
  if (base !== undefined) out.audioBaseDir = base;
  return out;
}

function extractChip(settings: AppSettings): SyncBlob["chip"] {
  return pickFields(settings.recording as unknown as Record<string, unknown>, CHIP_FIELD_SET) as SyncChip;
}

/** Profiles, with the "Profile shortcuts" sub-toggle applied: when OFF, each
 *  known profile ships the SNAPSHOT's chord (this device's chord edits stay
 *  local) — a profile the snapshot doesn't know yet ships its live chord, so
 *  peers never receive a chord-less profile (`sanitizeProfiles` requires a
 *  code list). */
const TRANSCRIPTION_FIELD_SET: ReadonlySet<string> = new Set(TRANSCRIPTION_FIELDS);
const DICTATION_HISTORY_SET: ReadonlySet<string> = new Set(DICTATION_HISTORY_FIELDS);
const FILE_TRANSCRIPTION_SET: ReadonlySet<string> = new Set(FILE_TRANSCRIPTION_FIELDS);
const TRANSCRIPTION_PICK_SET: ReadonlySet<string> = new Set(TRANSCRIPTION_PICK_FIELDS);

/** The `transcription` category: the classified subset of settings.transcribe.
 *  The last-used backend/model/language picks travel only when the sub-toggle
 *  opts in; otherwise the snapshot's values pass through so an opted-out
 *  device never erases a peer's picks. */
function extractTranscription(
  settings: AppSettings,
  syncPicks: boolean,
  snapshot: SyncBlob | undefined,
): SyncTranscription {
  const tr = (settings.transcribe ?? {}) as Record<string, unknown>;
  const out = pickFields(tr, TRANSCRIPTION_FIELD_SET) as SyncTranscription;
  const picks = syncPicks
    ? pickFields(tr, TRANSCRIPTION_PICK_SET)
    : pickFields(
        (snapshot?.transcription ?? {}) as Record<string, unknown>,
        TRANSCRIPTION_PICK_SET,
      );
  return { ...out, ...(picks as SyncTranscription) };
}

/** The `logging` category: the log viewer's preferences. `logDir` is a
 *  machine path behind its gate (the recordingsDir precedent): live when
 *  opted in, snapshot passthrough otherwise — and never present in exports
 *  (the export contract composes without gates → syncDir false, no snapshot). */
function extractLogging(
  settings: AppSettings,
  syncDir: boolean,
  snapshot: SyncBlob | undefined,
): SyncBlob["logging"] {
  const lg = settings.logging;
  const out: NonNullable<SyncBlob["logging"]> = {
    logLevel: lg?.logLevel ?? "info",
    keepDays: lg?.keepDays ?? 30,
    showInSidebar: lg?.showInSidebar ?? true,
  };
  const dir = syncDir ? (lg?.logDir ?? null) : snapshot?.logging?.logDir;
  if (dir !== undefined) out.logDir = dir;
  return out;
}

function extractFileTranscriptions(settings: AppSettings): SyncFileTranscriptions {
  return pickFields(
    (settings.transcribe ?? {}) as Record<string, unknown>,
    FILE_TRANSCRIPTION_SET,
  ) as SyncFileTranscriptions;
}

function extractProfiles(
  profiles: Profile[],
  homeProfileId: string | null,
  syncHotkeys: boolean,
  snapshot: SyncBlob | undefined,
): SyncBlob["profiles"] {
  let list = profiles;
  if (!syncHotkeys) {
    const snapList = snapshot?.profiles?.list;
    const snapChords = new Map(
      (Array.isArray(snapList) ? snapList : [])
        .filter((p) => !!p && typeof p === "object" && typeof p.id === "string" && isCodeList(p.hotkey))
        .map((p) => [p.id, p.hotkey]),
    );
    list = profiles.map((p) => {
      const snap = snapChords.get(p.id);
      return snap ? { ...p, hotkey: snap } : p;
    });
  }
  return { list, homeProfileId };
}

/** The quick-add pointers. Chord: live when the sub-toggle is on, snapshot
 *  passthrough when off (same never-erase rule as recordingsDir).
 *
 *  The pin is SLAVED to the backends category (`syncPin` = cats.backends),
 *  exactly as when it rode inside that payload: it references a backend id,
 *  so on a device that doesn't sync its backend list the ids differ per
 *  machine — syncing the pin there would make every pull null the local pin
 *  through the dangling-reference scrub and every push overwrite the peer's,
 *  a slow ping-pong that destroys both pins. Backends OFF → passthrough. */
function extractDictionary(
  settings: AppSettings,
  syncChord: boolean,
  syncPin: boolean,
  snapshot: SyncBlob | undefined,
): SyncBlob["dictionary"] {
  const out: SyncDictionary = {};
  const pin = syncPin ? (settings.quickAddList ?? null) : snapshot?.dictionary?.quickAddList;
  if (pin !== undefined) out.quickAddList = pin;
  const chord = syncChord ? settings.general.quickAddHotkey : snapshot?.dictionary?.quickAddHotkey;
  if (chord !== undefined) out.quickAddHotkey = chord;
  return out;
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
  opts: { includeSecrets: boolean; sub: SyncSubSettings; gates?: Gates },
): Promise<SyncBlob> {
  const blob: SyncBlob = {};
  blob.general = cats.general ? extractGeneral(cfg.settings) : snapshot?.general;
  blob.recording = cats.recording
    ? extractRecording(cfg.settings, opts.sub.recordingsDir, snapshot)
    : snapshot?.recording;
  blob.chip = cats.chip ? extractChip(cfg.settings) : snapshot?.chip;
  blob.dictionary = cats.dictionary
    ? extractDictionary(cfg.settings, opts.sub.quickAddHotkey, cats.backends, snapshot)
    : snapshot?.dictionary;
  blob.transcription = cats.transcription
    ? extractTranscription(cfg.settings, opts.sub.transcribePicks ?? false, snapshot)
    : snapshot?.transcription;
  blob.fileTranscriptions = cats.fileTranscriptions
    ? extractFileTranscriptions(cfg.settings)
    : snapshot?.fileTranscriptions;
  blob.logging = cats.logging
    ? extractLogging(cfg.settings, opts.gates?.logFolder ?? false, snapshot)
    : snapshot?.logging;
  if (cats.backends) {
    blob.backends = {
      list: cfg.backends,
    };
    if (opts.includeSecrets) {
      const secrets = await withTimeout(
        readBackendKeys(cfg.backends.map((b) => b.id)),
        10_000,
        {} as Record<string, string>,
      );
      // COMPLETENESS, not non-emptiness. `read_backend_keys` is a `filter_map`: it drops the
      // individual entries it cannot read rather than failing the batch, so a PARTIAL map is the
      // normal degraded shape. Uploading it replaces the server's copy of every key that is
      // missing here with nothing — the same erase hazard the `else` branch below guards, one
      // step earlier. (`restoreSnapshotSecrets` already treats a partial read-back as failure.)
      const complete = cfg.backends.every((b) => !b.hasApiKey || ownProp(secrets, b.id) !== undefined);
      if (Object.keys(secrets).length > 0 && complete) {
        blob.backends.secrets = secrets;
      } else if (cfg.backends.some((b) => b.hasApiKey)) {
        // Same erase-the-server's-keys hazard as the pass-through branch below, on the branch
        // that actually runs by default: when the wallet is locked the read above degrades to
        // `{}`, and pushing this list without secrets replaces the server's copy with a keyless
        // one — which pushNow then records as the new snapshot, orphaning the stash. If this
        // device believes it HAS keys and we read none back, push nothing for this category.
        blob.backends = undefined;
      }
    }
  } else if (opts.includeSecrets && snapshotSecretsUnavailable) {
    // The snapshot recorded keys we could not read back this session. Pushing its backends now
    // would send the list WITHOUT them and erase the server's stored keys, so leave the category
    // out entirely and let the server keep what it holds.
    blob.backends = undefined;
  } else {
    blob.backends = snapshot?.backends;
  }
  blob.profiles = cats.profiles
    ? extractProfiles(cfg.profiles, cfg.settings.homeProfileId ?? null, opts.sub.profileHotkeys, snapshot)
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
  // Per-setting gates (the granular "What this device syncs" switches). The
  // legacy four already act inside the extractors via `opts.sub`; this pass
  // extends the same snapshot-passthrough rule to every other setting:
  // gated-off fields carry the snapshot's value (peers never see this
  // device's opted-out edits, and nothing is erased for devices that sync).
  if (opts.gates) {
    const gates = opts.gates;
    for (const c of ["general", "recording", "chip", "transcription", "fileTranscriptions", "dictionary", "logging"] as const) {
      if (cats[c] && blob[c] !== undefined) {
        (blob as Record<string, unknown>)[c] = gateComposeScalar(c, blob[c], snapshot?.[c], gates);
      }
    }
    if (cats.backends && blob.backends) {
      let list = blob.backends.list;
      const snapList = snapshot?.backends?.list;
      if (!gates.serverAddresses) list = substituteElementFields(list, snapList, ["serverUrl"]);
      if (!gates.modelDecodeDefaults)
        list = substituteElementFields(list, snapList, BACKEND_DEFAULTS_FIELDS, true);
      const next = { ...blob.backends, list };
      if (!gates.apiKeys) {
        // Same never-erase rule for the keys bundle: the snapshot's copy
        // travels (or the field stays absent) — never a keyless overwrite.
        const snapSecrets = snapshot?.backends?.secrets;
        if (snapSecrets !== undefined) next.secrets = snapSecrets;
        else delete next.secrets;
      }
      blob.backends = next;
    }
    if (cats.profiles && blob.profiles) {
      let list = blob.profiles.list;
      if (!gates.enabledPerProfile)
        list = substituteElementFields(list, snapshot?.profiles?.list, ["enabled"]);
      // `exact` so ABSENCE travels: an override the user cleared has to reach the peer as
      // "not set", not as "unchanged" — which is what makes "Inherit" a real state rather
      // than a value that can only ever be added.
      if (!gates.profileInsertion)
        list = substituteElementFields(list, snapshot?.profiles?.list, PROFILE_INSERTION_FIELDS, true);
      const homeProfileId =
        gates.homeProfile || !snapshot?.profiles
          ? blob.profiles.homeProfileId
          : (snapshot.profiles.homeProfileId ?? null);
      blob.profiles = { list, homeProfileId };
    }
    if (cats.appRules && blob.appRules) {
      let mine = blob.appRules[MY_BUCKET];
      const snapMine = snapshot?.appRules?.[MY_BUCKET];
      if (!gates.perAppOverrides)
        mine = substituteElementFields(mine, snapMine, APP_RULE_OVERRIDE_FIELDS, true);
      if (!gates.perAppPasteShortcuts)
        mine = substituteElementFields(mine, snapMine, APP_RULE_PASTE_FIELDS, true);
      blob.appRules = { ...blob.appRules, [MY_BUCKET]: mine };
    }
  }
  // Drop absent categories entirely (undefined = "nothing stored", never null).
  for (const c of ALL_CATEGORIES) if (blob[c] === undefined) delete blob[c];
  // FORWARD-COMPAT: carry top-level categories this app version doesn't know
  // through from the snapshot verbatim. Without this, a device one release
  // behind rebuilds the blob from ALL_CATEGORIES and silently DROPS a newer
  // device's category on every push (server-side ping-pong). Shipped ahead of
  // the first new category (`logging`) on purpose.
  if (snapshot) {
    const known = new Set<string>(ALL_CATEGORIES);
    for (const [k, v] of Object.entries(snapshot)) {
      if (!known.has(k) && v !== undefined && !(k in blob)) {
        (blob as Record<string, unknown>)[k] = v;
      }
    }
  }
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
  // FORWARD-COMPAT (mirror of composeBlob's carry-through): categories this
  // app version doesn't know merge remote-wins-else-local, never dropped.
  const known = new Set<string>(ALL_CATEGORIES);
  for (const side of [local, remote]) {
    for (const [k, v] of Object.entries(side)) {
      if (!known.has(k) && v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
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

/** Keep an inbound paste chord within the presets the editor actually offers.
 *  The chord is synthesized as a real keypress into whatever window has focus, and nothing on
 *  the pull/import path validates it — so an arbitrary chord (Ctrl+Alt+T, Meta+R) would fire on
 *  every insert. Only applied to values arriving from a peer; a local config is left alone. */
function safePasteShortcut(codes: unknown, fallback: string[]): string[] {
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== "string")) return fallback;
  const joined = (codes as string[]).join("+");
  return PASTE_PRESETS.some((p) => p.codes.join("+") === joined) ? (codes as string[]) : fallback;
}

/** Drop inbound app rules that aren't shaped like rules. `appId` is only checked for existence
 *  by the Rust importer (and not at all on the pull path), yet every injection resolves through
 *  `rule.appId.toLowerCase()` — one malformed entry throws there and no transcript is ever
 *  inserted again, including in the editor the user would need to remove it. */
/** Keyring accounts this app reserves for its own bookkeeping. A Backend `id` is used verbatim
 *  as the keyring account name, and an inbound `id` is whatever the sender chose — so without
 *  this a peer could name a backend after our snapshot stash and have `readBackendKeys` hand it
 *  the bundle of EVERY backend's key (which the next push, and that backend's own Authorization
 *  header, would then ship to a server of the sender's choosing). */
function isReservedBackendId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("__") && id.endsWith("__");
}

/** Inbound `profiles.list` / `backends.list` are typed only by assertion: the FILE import path
 *  gets a real serde parse in Rust, the sync path does not. An element missing a required field
 *  reaches consumers that deref it unguarded (`p.hotkey.length`, `deriveChipTag(p.name)`), and
 *  with no error boundary in the tree a throw during render unmounts the window. Drop malformed
 *  entries here so both paths share the same floor. */
export function sanitizeProfiles(list: unknown): Profile[] {
  if (!Array.isArray(list)) return [];
  return dedupeById(list
    .filter(
      (p): p is Profile =>
        !!p && typeof p === "object" &&
        typeof (p as Profile).id === "string" &&
        typeof (p as Profile).name === "string" &&
        // The ELEMENTS matter as much as the container: `canonicalizeCodes`' sort tie-break calls
        // `a.localeCompare(b)`, which throws on a non-string code. That runs in a component body
        // (`conflictsByProfile`) and inside the debounced save, so one numeric entry both unmounts
        // the window and kills config persistence for the session. `safePasteShortcut` already
        // makes exactly this check on its own chord field.
        isCodeList((p as Profile).hotkey),
    )
    .map((p) => ({
      ...p,
      // The three fields above were the ones an earlier run tripped over; every OTHER leaf was
      // carried through by reference. Two sinks, both reached from the same unattended pull:
      // `GLYPH[p.activation]` in Home (the DEFAULT route) is rendered AS A COMPONENT, so an
      // unknown value is `React.createElement(undefined)` — "Element type is invalid" — and with
      // no error boundary anywhere in the tree that unmounts the main window; and `ActivationType`
      // is a two-variant serde enum with no fallback, so the same value makes `save_config`'s
      // typed parse reject the WHOLE config and every later save fails for the session.
      // "hold" is the fail-safe fallback: push-to-talk never live-types.
      //
      // `"handsfree"` was spelled `"latch"` between two earlier versions, so a peer that
      // hasn't updated still sends that. It must be NORMALIZED, not merely rejected: falling
      // through to the "hold" fallback would silently demote every hands-free profile on the
      // receiving device to push-to-talk — a behavior change from a spelling change. Rust's
      // `#[serde(alias = "latch")]` covers the config-file path; this covers the sync one.
      activation: oneOf<ActivationKind>(
        ((p as Profile).activation as string) === LEGACY_HANDSFREE
          ? "handsfree"
          : (p as Profile).activation,
        ACTIVATIONS,
        "hold",
      ),
      // Rendered as React CHILDREN (`<Badge>{p.endpoint}</Badge>`, `languageLabel(p.language)`,
      // which returns its argument unchanged when the code is unknown) — an object leaf throws
      // "Objects are not valid as a React child" — and `endpoint` is another fallback-less enum.
      endpoint: p.endpoint == null ? p.endpoint : oneOf<EndpointKind>(p.endpoint, ENDPOINT_KINDS, "stream"),
      name: typeof p.name === "string" ? p.name : "",
      tag: typeof p.tag === "string" ? p.tag : undefined,
      typeAsISpeak: p.typeAsISpeak == null ? undefined : p.typeAsISpeak === true,
      // Typed `Option<bool>` in Rust like its sibling above: a non-boolean would fail the
      // whole `save_config` parse.
      askTranslationTargets: p.askTranslationTargets == null ? undefined : p.askTranslationTargets === true,
      // Per-Profile insertion overrides get the same clamps their per-app twins do —
      // `save_config` parses into a typed Rust struct with no serde fallback, so ONE bad
      // enum here wedges every later save for the session. Everything not listed rides the
      // `...p` spread unvalidated, which is exactly the gap this closes.
      //
      // `autoEnter` is dropped rather than clamped, for the same reason as the app-rule
      // twin above: a peer must not be able to arm a post-paste Return.
      insertionOverrides: p.insertionOverrides
        ? {
            insertMethod:
              p.insertionOverrides.insertMethod == null
                ? undefined
                : oneOf<InsertMethod>(p.insertionOverrides.insertMethod, INSERT_METHODS, "paste"),
            pasteShortcut:
              p.insertionOverrides.pasteShortcut == null
                ? undefined
                : safePasteShortcut(p.insertionOverrides.pasteShortcut, DEFAULT_PASTE_SHORTCUT),
            restoreClipboard:
              p.insertionOverrides.restoreClipboard == null
                ? undefined
                : p.insertionOverrides.restoreClipboard === true,
            autoEnter: undefined,
          }
        : undefined,
      model: typeof p.model === "string" ? p.model : undefined,
      language: typeof p.language === "string" ? p.language : undefined,
      prompt: typeof p.prompt === "string" ? p.prompt : undefined,
      // The two leaves the pass above still carried by reference. `enabled` is a bare `bool`
      // with no serde default, so a wrong type wedges every later save; before that a truthy
      // non-bool also makes the profile count as ACTIVE in `conflicts()`. `overrideProfile`
      // has a default, so an absent key is fine — but a present non-string still fails the
      // typed parse, and its Backend twin below is already clamped this way.
      enabled: p.enabled === true,
      overrideProfile: typeof p.overrideProfile === "string" ? p.overrideProfile : undefined,
      // The last leaf still riding the `...p` spread. Rust's `backend_id` is `Option<String>`,
      // and the dangling-reference scrub in `applyBlob` is NOT a type check standing in for one:
      // it is gated on `p.backendId &&`, so a FALSY non-string (`0`, `false`) skips it entirely
      // and reaches the typed parse, which rejects the whole `Config`. `null` is the app's own
      // "no backend chosen" value, so the scrub still runs on whatever survives here.
      backendId: typeof p.backendId === "string" ? p.backendId : null,
    }))
    )
    .slice(0, MAX_SYNCED_ENTRIES);
}

/** A chord as the capture UI produces it: a list of `KeyboardEvent.code` strings.
 *
 *  The LENGTH bound matters as much as the element type. `Profile.hotkey` is canonicalized
 *  (sort + dedup) by Rust's `de_hotkey` on the round-trip, but the store holds the raw inbound
 *  value for the rest of the session, and the TS consumers are the expensive ones: `HotkeyChips`
 *  renders one DOM node per code, `conflictsByProfile` runs an O(k²) subset scan in a component
 *  body (not memoized), both sync preview dialogs cap the PEER count but not the chord, and the
 *  debounced save gate runs the same scan. A real binding is at most a handful of codes. */
/** The quick-add pin as Rust requires it: both leaves present and both strings.
 *
 *  Rebuilding rather than returning the object as-is would drop a newer peer's extra fields, so
 *  the original is passed through once its two required leaves check out. Anything else becomes
 *  `null`, which is the app's own "no list pinned" state and leaves the chord inert
 *  (`apply_bindings` gates on `quick_add_list.is_some()`). */
function safeQuickAddTarget(v: unknown): QuickAddTarget | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Partial<QuickAddTarget>;
  return typeof t.backendId === "string" && typeof t.slug === "string" ? (v as QuickAddTarget) : null;
}

export function isCodeList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_CHORD_CODES &&
    v.every((c) => typeof c === "string" && c.length <= MAX_CHORD_CODE_LEN)
  );
}

/** Ceiling on the codes in ONE chord. Every real binding is ≤6 (modifiers + a key); the capture
 *  UI cannot produce more. */
const MAX_CHORD_CODES = 16;

/** Ceiling on the LENGTH of one code, paired with `MAX_CHORD_CODE_LEN` in commands.rs — the same
 *  number, but not the same measure: this counts UTF-16 code units and Rust counts UTF-8 bytes, so
 *  the two disagree on non-ASCII input (Rust is the stricter of the pair). Every real code is
 *  ASCII, where the measures coincide, and both bound the field regardless. The count cap
 *  above bounds how many codes a chord has, never how long one is — 16 codes of ~1.2 MB each fit
 *  inside `SYNC_MAX_BODY` and reach `chordConflicts`' O(k·m) subset scan, a `config.json` rewritten
 *  on every autosave, and `codeToLabel`'s raw fall-through render. Every real `KeyboardEvent.code`
 *  token is well under 32. A chord failing this is rejected whole, as an over-long one already is. */
const MAX_CHORD_CODE_LEN = 64;

/** Turn OFF the later member of every chord collision in an inbound binding set, including a
 *  collision with the (possibly also inbound) quick-add chord. See the call site for why a
 *  conflicting set is worse than a malformed one.
 *
 *  `collapseSides: true` deliberately over-detects: the save gate picks it from the live backend
 *  (evdev vs the plugin) and this runs before that is known, so matching the stricter side keeps
 *  the sanitizer a superset of the gate — which is the whole point, since anything the gate
 *  catches and this misses freezes saving. Two chords differing only by modifier side are in any
 *  case broken on the plugin backend, where one silently never registers. */
function disableConflictingProfiles(
  profiles: Profile[],
  quickAddHotkey: string[],
  /** Did the PROFILES in this call arrive in the same blob as the chord? When they did not,
   *  the chord is remote-authored and the list is this device's own — see below. */
  profilesAreInbound: boolean,
): { profiles: Profile[]; rejectQuickAddHotkey: boolean } {
  const peers = quickAddHotkey.length > 0 ? [...profiles, quickAddPeer(quickAddHotkey)] : profiles;
  const order = new Map(peers.map((p, i) => [p.id, i]));
  const disable = new Set<string>();
  let rejectQuickAddHotkey = false;
  for (const c of conflicts(peers, true)) {
    // Keep whichever came first — the quick-add peer always wins, since it is a single global
    // chord the user may have bound locally, not one of many list entries.
    //
    // …but only when the profiles it beats came from the same blob. `dictionary` has no consent
    // arm, so a blob carrying ONLY `dictionary.quickAddHotkey` reaches this with the user's own
    // local profile list, and the unconditional win then switches those profiles off and
    // persists that — worst case `["ControlLeft"]`, a strict subset of virtually every real
    // chord, which disables dictation app-wide with nothing malformed to point at and no
    // banner. When the collision is remote-chord-vs-local-profiles, drop the incoming chord
    // instead. The peer still cannot be disabled, so the save gate stays un-tripped either way.
    const self = order.get(c.profileId) ?? 0;
    const other = order.get(c.otherId) ?? 0;
    if (c.otherId === QUICK_ADD_PEER_ID) {
      if (profilesAreInbound) disable.add(c.profileId);
      else rejectQuickAddHotkey = true;
    } else if (self > other) {
      disable.add(c.profileId);
    }
  }
  disable.delete(QUICK_ADD_PEER_ID);
  return {
    profiles:
      disable.size === 0
        ? profiles
        : profiles.map((p) => (disable.has(p.id) ? { ...p, enabled: false } : p)),
    rejectQuickAddHotkey,
  };
}

/** Ceiling on how many entries one inbound blob may install. Far above any real profile /
 *  backend / rule set, so nothing legitimate is truncated — but it bounds the O(n²) passes
 *  these lists feed: `chords_from`'s dedup and `Engine::step`, which runs on EVERY system-wide
 *  key event, plus `conflicts()` and the unbounded list renders. */
/** Drop later entries sharing an id. Uniqueness is unenforced everywhere else, and every consumer
 *  resolves by FIRST match (`backends.find(b => b.id === …)`) while the pickers render one option
 *  per entry — so two entries with one id give two differently-LABELLED options that both select
 *  the first entry's server. Keep-first, so the surviving entry is the one those lookups already
 *  resolve to and no keyring association moves. Ids are `crypto.randomUUID()` on every legitimate
 *  path, so a duplicate is never a real entry.
 *
 *  Deliberately NOT mirrored into the store's `wellFormed*` floors: those run over the user's own
 *  config.json on every launch with the autosave armed. */
function dedupeById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

const MAX_SYNCED_ENTRIES = 500;

/** Closed-vocabulary settings arrive as raw JSON. `save_config` takes a typed `Config` whose
 *  enums have no serde fallback, so one unknown variant makes EVERY later save fail — the store
 *  keeps the bad value, the save banner sticks, and `pushNow` short-circuits on it. Keep the
 *  device's current value when the incoming one is not a known variant. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Same failure as `oneOf`, one level down: the settings blocks are spread in wholesale, and
 *  `save_config` takes a typed `Config` whose scalars (`bool`, `u32`, `f64`) have no serde
 *  fallback either. `#[serde(default)]` covers an ABSENT key, not a present one of the wrong
 *  type — so `soundEffects: "yes"` or `hoverRevealMs: -1` makes Tauri reject the invoke, and
 *  because nothing reverts the store, every later debounced save fails the same way for the rest
 *  of the session (the save banner sticks, `pushNow` short-circuits, and shortcut
 *  re-registration — which only runs on the success path — stops happening).
 *
 *  Drop only KNOWN keys whose type disagrees with what this device holds. Unknown keys are
 *  passed through untouched: Rust ignores unrecognised fields, so a newer peer's additions must
 *  survive the round-trip rather than being erased by an older client's next push. */
/** The settings leaves Rust declares as `u32` (`config/mod.rs`: `hover_reveal_ms`,
 *  `recordings_retention_days`). Every other numeric leaf is `f64`. */
const U32_KEYS = new Set(["hoverRevealMs", "recordingsRetentionDays"]);

/** Per-field validation for the `transcription` category. `settings.transcribe`
 *  is OPAQUE to Rust (serde_json::Value), so nothing downstream rejects a bad
 *  type — this is the only gate. Wrong-typed values are dropped (keep local);
 *  numbers are clamped to their UI ranges. Unknown keys never reach here
 *  (pickFields allowlists first). */
function sanitizeTranscription(v: Record<string, unknown>): Partial<TranscribeSettings> {
  const out: Record<string, unknown> = {};
  const BOOLS = [
    "diarize", "translate", "separateBgm", "wordTimestamps", "showTimestamps",
    "showSpeakerNames", "colorizeSpeakers", "keepDictationHistory", "keepAudioCopies",
    "keepUrlAudioCopies",
  ];
  for (const k of BOOLS) {
    const b = ownProp(v, k);
    if (typeof b === "boolean") out[k] = b;
  }
  const days = (k: string, max: number) => {
    const n = ownProp(v, k);
    if (typeof n === "number" && Number.isFinite(n)) {
      out[k] = Math.max(0, Math.min(max, Math.round(n)));
    }
  };
  days("historyRetentionDays", 3650);
  days("dictationRetentionDays", 3650);
  const spk = ownProp(v, "numSpeakers");
  if (typeof spk === "number" && Number.isFinite(spk)) {
    out.numSpeakers = Math.max(0, Math.min(32, Math.round(spk)));
  }
  const mode = ownProp(v, "speakerMode");
  if (mode === "auto" || mode === "count" || mode === "range") out.speakerMode = mode;
  // Listed under the manifest's Translation row, so the sync switch promises it travels.
  const trMode = ownProp(v, "translationMode");
  if (trMode === "fluent" || trMode === "faithful") out.translationMode = trMode;
  for (const k of ["minSpeakers", "maxSpeakers"] as const) {
    const n = ownProp(v, k);
    if (typeof n === "number" && Number.isFinite(n)) {
      out[k] = Math.max(1, Math.min(32, Math.round(n)));
    }
  }
  const fmt = ownProp(v, "exportFormat");
  if (fmt === "srt" || fmt === "vtt" || fmt === "txt" || fmt === "lrc" || fmt === "json") {
    out.exportFormat = fmt;
  }
  // The sub-toggle-gated picks: free strings, bounded. backendId is only a
  // reference — the Transcribe screen ignores ids that don't resolve.
  for (const k of ["backendId", "model", "language", "translationModel"]) {
    const str = ownProp(v, k);
    if (typeof str === "string" && str.length <= 256) out[k] = str;
  }
  // T2T targets: the blob's only array-of-strings field — clamp shape hard
  // (8 short codes max) so a hostile peer can't balloon the settings blob.
  const tt = ownProp(v, "translateTo");
  if (Array.isArray(tt)) {
    out.translateTo = tt
      .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 16)
      .slice(0, 8);
  }
  return out as Partial<TranscribeSettings>;
}

function typedLike<T extends object>(incoming: T, local: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    // OWN properties on both reads. `k` comes from `Object.entries` over the blob, and
    // `JSON.parse` makes `__proto__` / `constructor` / `toString` ordinary own enumerable keys —
    // while `in` and a bare index both consult the prototype chain, so those keys used to compare
    // against `Object.prototype`'s members instead of against "absent". It fails CLOSED today
    // (every prototype member is a function, and JSON cannot produce one, so the `typeof`
    // mismatch arm swallows them) — this is the last inbound site still reading that way, which
    // is exactly the hygiene `own.ts` exists for and `securityChanges` was converted to.
    const ref = ownProp(local as Record<string, unknown>, k);
    // A key this version does not know: pass it through untouched, `null` included. Rust ignores
    // unrecognised fields, so it cannot wedge the parse, and swallowing it would erase a newer
    // peer's data on this device's next push.
    if (!hasOwn(local as Record<string, unknown>, k)) {
      out[k] = v;
      continue;
    }
    // JSON has no `undefined`, so `null` is exactly what a hostile server puts on the wire — and
    // this arm used to pass it straight through on the strength of "nullable either side",
    // without ever checking that the LOCAL field is nullable. `#[serde(default)]` fills an ABSENT
    // key; a PRESENT `null` still goes through `deserialize_bool` and errors, so a single
    // `{"general":{"soundEffects":null}}` rejected the whole `Config` — the same session-long
    // save freeze this function exists to prevent. Keep this device's value instead, exactly as
    // `oneOf` does for an unknown variant.
    if (v == null) {
      if (ref == null) out[k] = v; // genuinely nullable here too
      continue;
    }
    if (ref == null) {
      out[k] = v;
      continue;
    }
    if (typeof v !== typeof ref) continue;
    if (Array.isArray(ref) !== Array.isArray(v)) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    // JS has ONE number type; Rust does not. `typeof` agreeing is not enough for the two
    // fields Rust holds as `u32` — `-1`, `0.5` and `5e9` all pass the check above and then
    // fail serde on the whole `Config`, which is the same session-long save freeze `oneOf`
    // exists to prevent (its own docstring names `hoverRevealMs: -1`). The f64 fields need
    // no bound: serde accepts any finite double, so they cannot wedge the parse.
    if (U32_KEYS.has(k) && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xff_ff_ff_ff)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

const INSERT_METHODS = ["paste", "direct", "clipboard"] as const;
const INSERT_TIMINGS = ["off", "stop", "live"] as const;
const THEMES = ["dark", "light", "auto"] as const;
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
const INDICATOR_POSITIONS = ["top", "bottom", "off"] as const;
const OVERLAY_STATS_METRICS = ["words", "audio", "both"] as const;
const ACTIVATIONS = ["hold", "handsfree"] as const;
const ENDPOINT_KINDS = ["stream", "batch"] as const;
const RESPONSE_FORMATS = ["json", "verbose_json"] as const;
const BACKEND_KINDS = ["auto", "full", "standard"] as const;

function sanitizeBackends(list: unknown): Backend[] {
  if (!Array.isArray(list)) return [];
  return dedupeById(list.filter(
    (b): b is Backend =>
      !!b && typeof b === "object" &&
      typeof (b as Backend).id === "string" &&
      typeof (b as Backend).serverUrl === "string" &&
      !isReservedBackendId((b as Backend).id),
  )
    // FILL the remaining leaves rather than filtering on them. Rust's `Backend` requires
    // `name`/`model`/`language`/`prompt`/`endpoint`/`responseFormat` with NO serde default, so a
    // filter would DROP a legitimately older peer's backend entirely — along with the keyring
    // association its `id` carries. Filling keeps the entry and its key while making the value
    // safe for both sinks: the list card renders `name`/`model`/`languageLabel(language)` as
    // React children (an object leaf throws and unmounts the settings window), and the two enums
    // have no serde fallback, so an unknown variant wedges every later save for the session.
    .map((b) => ({
      ...b,
      // Inbound addresses are stored VERBATIM — `normalizeUrl` runs only on what the user
      // types — and go straight to the transport. Blank one that carries a scheme this app
      // does not speak: prefixing `http://` to `https:/evil.tld` makes every helper here read
      // the host as "https" while reqwest resolves evil.tld, so the card and the consent
      // dialog would name a different server from the one receiving the key and the audio.
      // Blank, not dropped: the entry keeps its id and therefore its keyring association, and
      // an empty address is the app's existing "not configured yet" state.
      //
      // STORE THE CLEANED STRING, not the raw one. `stripUrlNoise` removes exactly what WHATWG
      // and Rust's `url` crate remove before parsing (interior tab/LF/CR, leading/trailing C0),
      // so this device's copy already reads the way the transport will resolve it. Cleaning here
      // rather than only inside `normalizeUrl` is deliberate: `securityChanges` detects a
      // repointed address with `normalizeUrl(cur) !== normalizeUrl(next)`, so if the STORED value
      // stayed dirty while the comparison saw a cleaned one, a dirty→clean swap of the same host
      // would compare equal and the consent prompt would not fire for the very transition it
      // exists to catch.
      serverUrl: isStorableServerUrl(b.serverUrl) ? stripUrlNoise(b.serverUrl) : "",
      name: typeof b.name === "string" ? b.name : "",
      model: typeof b.model === "string" ? b.model : "",
      language: typeof b.language === "string" ? b.language : "auto",
      prompt: typeof b.prompt === "string" ? b.prompt : "",
      endpoint: oneOf<EndpointKind>(b.endpoint, ENDPOINT_KINDS, "stream"),
      responseFormat: oneOf<ResponseFormat>(b.responseFormat, RESPONSE_FORMATS, "json"),
      hasApiKey: b.hasApiKey === true,
      overrideProfile: typeof b.overrideProfile === "string" ? b.overrideProfile : undefined,
      // The one backend enum this pass had missed. `Option<BackendKind>` defaults when the key
      // is ABSENT, but a present unknown string (or a non-string) has no serde fallback and
      // fails the typed parse like its two siblings above. Keep undefined = "infer from the
      // connection test", which is what an absent key already means.
      kind: b.kind == null ? undefined : oneOf<BackendKind>(b.kind, BACKEND_KINDS, "auto"),
    }))
    )
    .slice(0, MAX_SYNCED_ENTRIES);
}

function sanitizeAppRules(rules: unknown): AppRule[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter(
      (r): r is AppRule =>
        !!r && typeof r === "object" &&
        typeof (r as AppRule).id === "string" &&
        typeof (r as AppRule).appId === "string",
    )
    .map((r) => ({
      ...r,
      // The rule's KEY, and the only field the form used to normalize (`appId.trim()` in `save()`)
      // while every inbound path left it verbatim. See `normalizeAppId`.
      appId: normalizeAppId(r.appId),
      block: r.block === true,
      // `name` rode in through the spread unchecked while its neighbours were clamped, and the
      // rules list does `r.name?.trim()` in a render body — `?.` guards null/undefined, not a
      // number or an object, so one malformed rule unmounts the very screen a user opens to
      // audit which apps have a forced insert method. App rules have no consent gate, so this
      // arrives silently.
      name: typeof r.name === "string" ? r.name : undefined,
      pasteShortcut:
        r.pasteShortcut == null
          ? r.pasteShortcut
          : safePasteShortcut(r.pasteShortcut, DEFAULT_PASTE_SHORTCUT),
      // Sibling of the clamp above, and of the `general` clamp in `applyBlob`: a per-rule
      // insertMethod outside the enum is rejected by `save_config`'s typed parse and wedges
      // every later save. `null`/absent means "inherit the global", which stays valid.
      insertMethod:
        r.insertMethod == null
          ? r.insertMethod
          : oneOf<InsertMethod>(r.insertMethod, INSERT_METHODS, "paste"),
      restoreClipboard: r.restoreClipboard == null ? r.restoreClipboard : r.restoreClipboard === true,
      // `autoEnter` is FORCED OFF on every inbound path, never merely type-checked — the
      // same treatment the `general` block gets in applyBlob, and for the same reason: the
      // synthesized Return is sent AFTER the paste, outside the bracketed-paste region, so
      // it SUBMITS whatever the server-authored transcript put in the buffer. A peer must
      // not be able to arm that. Clamping the type would still let `true` through, so this
      // drops the field entirely and lets the local value stand (see repin below).
      autoEnter: undefined,
    }))
    // An all-invisible appId normalizes to "", which matches nothing and displays as nothing —
    // a zombie row on the audit screen. Drop it rather than store it.
    .filter((r) => r.appId.length > 0)
    // Rules are MATCHED by appId and `resolveInjectionTarget` takes the FIRST match, so two rules
    // sharing an appId shadow each other. `upsertAppRule` knows this and dedupes on the local
    // editor path — with a comment naming the hazard — and this inbound twin had neither that
    // guard nor Q12's `dedupeById` (which was applied to backends/profiles only, and keys on `id`,
    // so it would not catch two distinct ids sharing an appId anyway).
    //
    // Without it a peer prepends `{appId:"konsole", block:false, insertMethod:"direct"}` ahead of
    // the user's own `{appId:"konsole", block:true}`: the resolver picks the attacker's entry and
    // TYPES the transcript into the app the user marked "never type here", while AppRules.tsx
    // still draws the Ban icon and "Blocked — never typed here" for the shadowed rule. App rules
    // raise no SecurityChange, so this lands on the unattended startup/focus pull.
    //
    // Keep-FIRST on both keys, which is what the resolver already does — so the surviving row is
    // the one that was being enforced, and display goes back into agreement with enforcement.
    // Behaviour-preserving for every legitimate config: duplicates are unreachable from the UI,
    // `upsertAppRule` guarantees uniqueness. Placed in the sync sanitizer only, never in
    // `wellFormedAppRules` — that floor runs over the user's own config.json at every launch with
    // the autosave armed (Q12's rule).
    .filter(
      (() => {
        const ids = new Set<string>();
        const appIds = new Set<string>();
        return (r: AppRule) => {
          const key = r.appId.trim().toLowerCase();
          if (ids.has(r.id) || appIds.has(key)) return false;
          ids.add(r.id);
          appIds.add(key);
          return true;
        };
      })(),
    )
    .slice(0, MAX_SYNCED_ENTRIES);
}

/** Write incoming secrets to the keyring, then re-derive every backend's
 *  hasApiKey from KEYRING TRUTH (imported key present, or one already stored
 *  on this machine) — so a synced "hasApiKey: true" can't claim a key that
 *  isn't actually available here. */
async function reconcileBackendSecrets(
  list: Backend[],
  secrets: Record<string, string> | undefined,
): Promise<Backend[]> {
  // Only ids that are actually in the list: composeBlob reads keys for exactly the backends it
  // ships, so a secret for an unknown id can't come from a legitimate peer — but it WOULD be
  // written into the OS keyring under a name the sender chose.
  // Iterate the BACKENDS, not the map. `secrets` is the one container in the blob with no shape
  // check on either side — Rust forwards the blob as an opaque Value, and the file-import path's
  // `as_object()` floor has no sync-path twin — so a STRING here made `Object.entries` expand it
  // per code unit: a 4 MiB value measured 4M entries, ~8s of frozen main thread and +575 MB, on
  // the pull that runs unattended at startup and on every window focus. Reading by id instead is
  // O(backends), can never drop a legitimate key, and makes the lookup own-property at the same
  // time (`secrets.constructor` is a truthy function otherwise — the class already fixed below).
  for (const b of list) {
    const id = b.id;
    const key = isPlainObject(secrets) ? ownProp(secrets as Record<string, unknown>, id) : undefined;
    if (typeof key === "string" && key) {
      // Same locked-wallet hazard as composeBlob's read: a parked prompt must
      // not wedge the apply. A skipped write surfaces as hasApiKey=false below.
      await withTimeout(
        setBackendKey(id, key).catch((e) => console.error("keyring write failed", e)),
        10_000,
        undefined,
      );
    }
  }
  const present = await withTimeout(
    readBackendKeys(list.map((b) => b.id)),
    10_000,
    {} as Record<string, string>,
  );
  // Own-property test, not `in`: `present` is JSON-parsed, so it carries `Object.prototype`, and a
  // backend whose id is `constructor`/`toString`/… would be re-derived as `hasApiKey: true` with
  // nothing in the keyring — defeating the exact promise this function makes. Downstream that
  // phantom also makes `composeBlob`'s erase guard fire forever on a device holding no real keys,
  // silently dropping the backends category from every push.
  return list.map((b) => {
    const held = hasOwn(present, b.id);
    return b.hasApiKey === held ? b : { ...b, hasApiKey: held };
  });
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
  /** Retries left after a mid-apply store change (see the check after the keyring wait).
   *  Bounded so a user editing settings in a tight loop cannot spin this. */
  retries = 2,
): Promise<void> {
  const st = useApp.getState();
  if (st.status !== "idle") {
    pendingApply = { blob, cats };
    return;
  }
  applyingRemote = true;
  let staleRestart = false;
  try {
    const settings = st.settings;
    const sub = settings.sync?.sub ?? { recordingsDir: false, profileHotkeys: true, quickAddHotkey: true, transcribePicks: false };
    // Per-setting gates: strip a gated-off setting's fields from the inbound
    // scalar categories up front, so every merge-over-current below keeps
    // this device's values for them (the recordingsDir idiom, generalized).
    // List-category gates re-pin per element inside their arms below.
    const gates = completeGates(settings.sync?.sub, settings.sync?.categories);
    blob = { ...blob };
    for (const c of ["general", "recording", "chip", "transcription", "fileTranscriptions", "dictionary", "logging"] as const) {
      if (blob[c] !== undefined) {
        (blob as Record<string, unknown>)[c] = gateApplyScalar(c, blob[c], gates);
      }
    }
    let nextSettings: AppSettings = settings;
    let nextBackends = st.backends;
    let nextProfiles = st.profiles;
    let nextAppRules = st.appRules;

    // `isPlainObject`, not truthiness: Rust forwards the blob as opaque JSON (`transport/sync.rs`
    // — "Blobs pass through as opaque JSON"), so `general` arrives as whatever the server put
    // there. A STRING is truthy, and object rest-destructuring boxes it into one key per code
    // unit — so a 4 MiB string (the `SYNC_MAX_BODY` ceiling) becomes 4,194,304 keys, twice over
    // for the two rest-spreads, and `typedLike` then copies every one of them into the store
    // because "0", "1", … are not in `settings.general`. This is Q11's `backends.secrets` fix
    // applied to the two containers it never reached, on a pull that runs unattended at startup
    // and on every window focus.
    if (cats.general && isPlainObject(blob.general)) {
      const { theme, ...incoming } = blob.general as SyncGeneral;
      // Machine-local fields are excluded from SyncGeneral by TYPE only, which stops us sending
      // them but not a peer (or a hand-authored import file) from sending them to us — and the
      // import dialog promises the user "evdev is never imported". Enforce it on the way in.
      // `autoEnter` gets the same treatment for a sharper reason: the synthesized Return is sent
      // AFTER the paste, i.e. outside the bracketed-paste region, so it submits whatever the
      // pasted (server-authored, newline-preserving) transcript put in the buffer. A peer must
      // not be able to arm that; the local toggle is untouched.
      const {
        evdevEnabled: _evdev,
        autoEnter: _autoEnter,
        // The chord belongs to the `dictionary` category now — migrateBlob moves it there on
        // every inbound path, and stripping it here too means a hand-crafted blob can't apply
        // it past the dictionary toggle by leaving it in `general` (same defense-in-depth as
        // the evdev strip above; the local field itself still lives in settings.general).
        quickAddHotkey: _qa,
        ...general
      } = incoming as Record<string, unknown>;
      nextSettings = {
        ...nextSettings,
        theme: oneOf<ThemeName>(theme, THEMES, nextSettings.theme),
        general: {
          ...nextSettings.general,
          ...typedLike(general as Partial<typeof nextSettings.general>, nextSettings.general),
          pasteShortcut: safePasteShortcut(
            (general as { pasteShortcut?: unknown }).pasteShortcut,
            nextSettings.general.pasteShortcut,
          ),
          // Closed vocabularies: an unknown variant is rejected by `save_config`'s typed parse,
          // which then fails EVERY later save (see `oneOf`).
          insertMethod: oneOf<InsertMethod>(
            (general as { insertMethod?: unknown }).insertMethod,
            INSERT_METHODS,
            nextSettings.general.insertMethod,
          ),
          insertTiming: oneOf<InsertTiming>(
            (general as { insertTiming?: unknown }).insertTiming,
            INSERT_TIMINGS,
            nextSettings.general.insertTiming,
          ),
        },
      };
    }
    // Same shape check, same reason as the `general` arm above — `blob.recording` reaches
    // `typedLike` directly.
    if (cats.recording && isPlainObject(blob.recording)) {
      // Chip-classified keys can NEVER apply through the recording category (nor vice-versa
      // below): migrateBlob partitions honest blobs, and the filter here stops a crafted one
      // from riding e.g. `indicatorPosition` past a switched-off chip toggle.
      const rec = omitFields(blob.recording as Record<string, unknown>, CHIP_FIELD_SET);
      // The dictation-history flags ride this category but LIVE in
      // settings.transcribe — route them there (validated), and keep them out
      // of the recording block below.
      const dictHist = sanitizeTranscription(pickFields(rec, DICTATION_HISTORY_SET));
      if (Object.keys(dictHist).length) {
        nextSettings = {
          ...nextSettings,
          transcribe: { ...settings.transcribe, ...nextSettings.transcribe, ...dictHist },
        };
      }
      for (const k of DICTATION_HISTORY_FIELDS) delete rec[k];
      nextSettings = {
        ...nextSettings,
        recording: {
          // Merge over THIS DEVICE'S current block, the way the `general` arm above already
          // does. Replacing it wholesale meant an omitted key fell through to `hydrate`'s
          // `withSettingsDefaults`, which refills from the FACTORY defaults — where
          // `saveRecordings` is true. So a blob that simply left the field out raised no
          // security change (undefined is falsy), applied silently, and turned permanent
          // plaintext archiving back on for a user who had deliberately turned it off; the same
          // omission silently reset trimSilence / muteSystemAudio / handsFreeAutoStopMin too.
          // A peer that genuinely wants it off still sends the literal `false`.
          ...settings.recording,
          ...typedLike(rec as Partial<typeof settings.recording>, settings.recording),
          // The folder is a machine path: applied only when this device's sub-toggle opts in
          // AND a well-typed value arrived; otherwise keep this device's folder no matter what.
          // `null` is a LEGITIMATE value ("use the default location", Rust Option<String>) and
          // must apply — treating it as "keep local" made a peer's next push resurrect the old
          // path and silently revert a reset-to-default after one round trip.
          recordingsDir:
            sub.recordingsDir && (typeof rec.recordingsDir === "string" || rec.recordingsDir === null)
              ? rec.recordingsDir
              : settings.recording.recordingsDir,
          // Same machine-path rule for the audio base folder (one sub-toggle
          // governs both paths).
          audioBaseDir:
            sub.recordingsDir && (typeof rec.audioBaseDir === "string" || rec.audioBaseDir === null)
              ? rec.audioBaseDir
              : settings.recording.audioBaseDir,
        },
      };
    }
    // The `transcription` category: same shape check, same merge-over-current
    // rule as `recording`. Only classified keys apply (a crafted blob can't
    // ride arbitrary keys into the opaque transcribe blob), every value is
    // validated per-field, and the per-machine picks apply only when this
    // device's sub-toggle opts in.
    if (cats.transcription && isPlainObject(blob.transcription)) {
      const raw = blob.transcription as Record<string, unknown>;
      const classified = pickFields(raw, TRANSCRIPTION_FIELD_SET);
      const picks = sub.transcribePicks ? pickFields(raw, TRANSCRIPTION_PICK_SET) : {};
      nextSettings = {
        ...nextSettings,
        transcribe: {
          ...settings.transcribe,
          ...sanitizeTranscription({ ...classified, ...picks }),
        },
      };
    }
    // The `fileTranscriptions` category — same routing into the opaque
    // transcribe blob, same per-field validation.
    if (cats.fileTranscriptions && isPlainObject(blob.fileTranscriptions)) {
      const ft = sanitizeTranscription(
        pickFields(blob.fileTranscriptions as Record<string, unknown>, FILE_TRANSCRIPTION_SET),
      );
      if (Object.keys(ft).length) {
        nextSettings = {
          ...nextSettings,
          transcribe: { ...settings.transcribe, ...nextSettings.transcribe, ...ft },
        };
      }
    }
    // The `logging` category — merge-over-current with per-field validation
    // (closed level vocabulary; retention clamped to a sane day count; the
    // machine-path logDir applies only when this device's gate opts in AND a
    // well-typed value arrived, null meaning "use the default location").
    if (cats.logging && isPlainObject(blob.logging)) {
      const lg = blob.logging as Record<string, unknown>;
      const cur = settings.logging ?? { logLevel: "info" as const, keepDays: 30, showInSidebar: true, logDir: null };
      nextSettings = {
        ...nextSettings,
        logging: {
          ...cur,
          ...typedLike(lg as Partial<typeof cur>, cur),
          logLevel: oneOf(lg.logLevel, LOG_LEVELS, cur.logLevel),
          keepDays:
            typeof lg.keepDays === "number" && Number.isFinite(lg.keepDays)
              ? Math.min(3650, Math.max(0, Math.floor(lg.keepDays)))
              : cur.keepDays,
          logDir:
            gates.logFolder && (typeof lg.logDir === "string" || lg.logDir === null)
              ? lg.logDir
              : cur.logDir,
        },
      };
    }
    // The chip half of the old "Recording & Chip" group — same merge-over-current rule, and
    // the mirror-image field filter (only chip-classified keys may apply here).
    if (cats.chip && isPlainObject(blob.chip)) {
      const chip = pickFields(blob.chip as Record<string, unknown>, CHIP_FIELD_SET);
      nextSettings = {
        ...nextSettings,
        recording: {
          ...nextSettings.recording,
          ...typedLike(chip as Partial<typeof settings.recording>, settings.recording),
          indicatorPosition: oneOf<IndicatorPosition>(
            chip.indicatorPosition,
            INDICATOR_POSITIONS,
            settings.recording.indicatorPosition,
          ),
          overlayStatsMetric: oneOf<OverlayStatsMetric>(
            chip.overlayStatsMetric,
            OVERLAY_STATS_METRICS,
            settings.recording.overlayStatsMetric,
          ),
        },
      };
    }
    if (cats.backends && blob.backends) {
      let inboundBackends = sanitizeBackends(blob.backends.list);
      // Element-wise keep-local for the gated backend aspects (the profile
      // chord idiom): addresses and model/decode defaults re-pin to this
      // device's values for backends it already knows; new backends keep the
      // inbound values (there is nothing local to keep).
      if (!gates.serverAddresses)
        inboundBackends = repinElementFields(inboundBackends, st.backends, ["serverUrl"]);
      if (!gates.modelDecodeDefaults)
        inboundBackends = repinElementFields(inboundBackends, st.backends, BACKEND_DEFAULTS_FIELDS, true);
      nextBackends = await reconcileBackendSecrets(
        inboundBackends,
        // API-keys gate off: inbound secrets never touch this device's keyring.
        gates.apiKeys ? blob.backends.secrets : undefined,
      );
      // The ONLY await in this function, and the blob sizes it: `reconcileBackendSecrets`
      // writes each incoming secret sequentially with a 10s timeout apiece, so up to 500
      // entries against a locked keyring park here for a long time. Everything above was
      // computed from a snapshot taken BEFORE that wait, and `hydrate` below replaces
      // `settings` wholesale — so anything the user changed meanwhile is silently reverted
      // and then written to disk by the persistence subscriber. That includes turning sync
      // OFF (`settings.sync` is part of `settings`) and deleting the offending backend, i.e.
      // the blob would hold the disconnect switch down for as long as it keeps the apply
      // running. Restart rather than merge: re-entering recomputes every derived value above
      // (the dangling-reference scrub and the conflict pass included) against current state,
      // whereas merging a stale `nextSettings` onto the live store would have to re-run both
      // by hand or leave dangling ids behind. Bounded, and on exhaustion the apply is dropped
      // rather than applied stale — the next pull brings the blob back.
      // Check every slice `hydrate` overwrites, not just `settings`. `nextProfiles` and
      // `nextAppRules` are still the PRE-wait snapshot whenever their category is toggled off,
      // and `upsertProfile`/`patchProfile`/`upsertAppRule`/`removeAppRule` all return only
      // `{profiles}` / `{appRules}` — `settings` stays byte-identical, so a user deleting the
      // app rule this very blob installed slipped the check and had their deletion hydrated
      // away and written to disk. `nextBackends` needs no check: this wait only exists inside
      // the `cats.backends` branch, and there `nextBackends` is derived from the wait's own
      // result rather than the snapshot.
      const live = useApp.getState();
      if (live.settings !== settings || live.profiles !== st.profiles || live.appRules !== st.appRules) {
        staleRestart = retries > 0;
        return;
      }
    }
    if (cats.profiles && blob.profiles) {
      nextProfiles = sanitizeProfiles(blob.profiles.list);
      // "Profile shortcuts" sub-toggle OFF: chords are per-machine — re-pin each profile this
      // device already knows to ITS chord (the recordingsDir precedent, per list element). A
      // profile new to this device keeps the inbound chord: there is no local value, and
      // `sanitizeProfiles` requires a code list, so stripping would drop the profile whole.
      if (!sub.profileHotkeys) {
        const localChords = new Map(st.profiles.map((p) => [p.id, p.hotkey]));
        nextProfiles = nextProfiles.map((p) => {
          const local = localChords.get(p.id);
          return local && !catEqual(local, p.hotkey) ? { ...p, hotkey: local } : p;
        });
      }
      // "Enabled per profile" gate off: which profiles are active is
      // per-machine — re-pin each known profile to ITS local enabled state.
      if (!gates.enabledPerProfile) {
        const localEnabled = new Map(st.profiles.map((p) => [p.id, p.enabled]));
        nextProfiles = nextProfiles.map((p) => {
          const mine = localEnabled.get(p.id);
          return mine !== undefined && mine !== p.enabled ? { ...p, enabled: mine } : p;
        });
      }
      // Per-Profile insertion overrides gate off: re-pin each known profile to ITS local
      // values, absence included (`exact`) — same contract as the per-app twins.
      if (!gates.profileInsertion)
        nextProfiles = repinElementFields(nextProfiles, st.profiles, PROFILE_INSERTION_FIELDS, true);
      // UNGATED twin of the app-rule `autoEnter` repin (`APP_RULE_LOCAL_ONLY_FIELDS`):
      // `sanitizeProfiles` drops the nested field on every inbound path so a peer can't arm
      // it, which without this also erased THIS device's own per-profile Enter on every pull.
      // A profile this device knows keeps its value; one new to it arrives with the field
      // absent, as intended. (Redundant, and harmless, when the gate above already repinned.)
      const localAutoEnter = new Map(st.profiles.map((p) => [p.id, p.insertionOverrides?.autoEnter]));
      nextProfiles = nextProfiles.map((p) => {
        const mine = localAutoEnter.get(p.id);
        return mine === undefined
          ? p
          : { ...p, insertionOverrides: { ...p.insertionOverrides, autoEnter: mine } };
      });
      // `??` only replaces null/undefined, so a JSON `0` or `false` survived it — and the scrub
      // below is gated on truthiness, so a falsy non-string skipped that too and reached Rust's
      // `Option<String>`. Same wedge as `quickAddList`. "Home profile" gate
      // off: keep this device's pick regardless of the blob.
      nextSettings = {
        ...nextSettings,
        homeProfileId: !gates.homeProfile
          ? settings.homeProfileId ?? null
          : typeof blob.profiles.homeProfileId === "string"
            ? blob.profiles.homeProfileId
            : null,
      };
    }
    if (cats.dictionary && isPlainObject(blob.dictionary)) {
      const d = blob.dictionary as { quickAddHotkey?: unknown; quickAddList?: unknown };
      // The chord: only when this device's sub-toggle opts in, and only a well-formed code
      // list — it lands in the same `canonicalizeCodes` / `conflicts()` consumers as the
      // profile chords, where a numeric entry throws in a component body AND in the debounced
      // save. Absent/malformed/opted-out → keep this device's chord.
      if (sub.quickAddHotkey && isCodeList(d.quickAddHotkey)) {
        nextSettings = {
          ...nextSettings,
          general: { ...nextSettings.general, quickAddHotkey: d.quickAddHotkey },
        };
      }
      // The pin: `quickAddList` is written into `settings` with NO other type check anywhere —
      // Rust's `QuickAddTarget` requires `backend_id` AND `slug` as bare `String`s with no
      // serde default, so `{"backendId":"<known>","slug":7}` would reject the whole `Config`
      // and freeze every later save for the session; `safeQuickAddTarget` clamps to null.
      //
      // Applied only when a backends LIST arrived in the same blob (`cats.backends &&
      // blob.backends`) — the pre-split gating, when the pin rode inside that payload. Without
      // the referent list, the dangling-reference scrub below can only compare against THIS
      // device's backends, and a peer's perfectly valid pin would null the local one.
      if (cats.backends && blob.backends && hasOwn(blob.dictionary as Record<string, unknown>, "quickAddList")) {
        nextSettings = { ...nextSettings, quickAddList: safeQuickAddTarget(d.quickAddList) };
      }
    }
    if (cats.appRules && blob.appRules) {
      let rules = sanitizeAppRules(blob.appRules[MY_BUCKET]);
      // Per-rule field gates: overrides/chords re-pin to this device's values
      // (including their ABSENCE — an override that isn't set locally stays
      // unset) for rules it already knows.
      if (!gates.perAppOverrides)
        rules = repinElementFields(rules, st.appRules, APP_RULE_OVERRIDE_FIELDS, true);
      if (!gates.perAppPasteShortcuts)
        rules = repinElementFields(rules, st.appRules, APP_RULE_PASTE_FIELDS, true);
      // UNGATED, unlike the two above: `autoEnter` is forced back to this device's value on
      // every inbound path, because a post-paste Return submits whatever the server-authored
      // transcript put in the buffer. `sanitizeAppRules` already drops the field; this is the
      // second half — without it, a rule the peer knows and we don't would arrive with no
      // local value to inherit and the field would simply be absent, which is the right
      // outcome, while a rule we DO know keeps ours. Same contract as the `general` strip.
      rules = repinElementFields(rules, st.appRules, APP_RULE_LOCAL_ONLY_FIELDS, true);
      nextAppRules = rules;
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
    // A well-formed blob is still not a SAFE blob. `profiles` and `quickAddHotkey` have no
    // consent gate, so an unattended pull can install a binding set that collides with itself
    // (two enabled profiles on one chord, or one chord a strict subset of another). Nothing here
    // is malformed — it passes every check above — but the app's OWN save gate then refuses to
    // persist a conflicting set, and that gate was written for a local editing mistake the user
    // can see and undo. Applied from a pull it freezes config persistence for the whole session:
    // later edits are dropped behind a banner blaming "a shortcut", `pushNow` short-circuits on
    // the save error so the device can never push a correction, shortcut re-registration (which
    // only runs on the save-success path) stops, and because `settings.sync` is itself part of
    // `settings`, the user cannot even persist turning sync OFF — so the same blob returns on the
    // next launch. Disable the later member of each colliding pair instead: the profile stays
    // visible in the editor for the user to inspect and re-enable, saving keeps working, and the
    // local gate is left alone so a genuine local mistake still stops the write.
    const resolved = disableConflictingProfiles(
      nextProfiles,
      nextSettings.general.quickAddHotkey,
      !!(cats.profiles && blob.profiles),
    );
    nextProfiles = resolved.profiles;
    if (resolved.rejectQuickAddHotkey) {
      // Keep THIS device's chord: the collision is between an incoming chord and profiles the
      // user authored here, and switching their profiles off to make room for it would be the
      // blob quietly disabling dictation.
      nextSettings = {
        ...nextSettings,
        general: { ...nextSettings.general, quickAddHotkey: settings.general.quickAddHotkey },
      };
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
      // The blob's `general` block was validated field-by-field above (including the
      // retired `insertTiming`), so no schema migration must run on it here.
      version: CONFIG_VERSION,
    });

    // Side effects hydrate() doesn't cover: deep-field detection is pushed to
    // Rust imperatively by its Settings toggle, so mirror that here. (Autostart
    // re-syncs via save_config; theme is reactive; hotkeys re-register via the
    // persistence subscriber.)
    if (cats.general && blob.general) {
      void setDeepFieldDetection(blob.general.deepFieldDetection).catch(() => {});
    }
  } finally {
    applyingRemote = false;
  }
  if (staleRestart) await applyBlob(blob, cats, retries - 1);
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
/** Sync epoch. Bumped by supersede() when the target server changes (or sync
 *  toggles), so an in-flight pull/push against the OLD server can neither
 *  block the new server's first sync via `inFlight` nor write its late result
 *  over the new server's bookkeeping. Stale calls compare their captured epoch
 *  after every transport await and bail silently. */
let gen = 0;

/** Invalidate whatever sync work is in flight or queued. Call BEFORE starting
 *  work against a different server (or after disabling sync). */
function supersede(): void {
  gen++;
  inFlight = false; // the superseded call skips its own reset (epoch mismatch)
  clearTimeout(pushTimer);
  pendingConflict = null; // a conflict against the old server is unresolvable now
  pendingReview = null; // ditto for a held-back pull from the old server
  pendingApply = null; // ditto a deferred apply of the old server's blob
}

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

/** Re-resolve the sync target AT the request and return its address, or `null` if the backend the
 *  caller captured is no longer the one to talk to.
 *
 *  `pullNow`/`pushNow` capture `backend` once at entry and then await real IPC — `ensureStateFor`
 *  (a keyring delete + `saveSyncState` on first contact) and, on push, `composeBlob`'s
 *  `readBackendKeys`, which carries a 10s timeout precisely because a locked wallet parks it. The
 *  address is only built afterwards, and `effectiveServerUrl(backend, live settings)` then mixes a
 *  LIVE override map with the STALE `backend.serverUrl` — the two halves of one address disagreeing.
 *  Any store change schedules a push 3s later (a pull schedules one too), so a push is routinely in
 *  flight while the user is in Settings; correcting the sync backend's address there makes
 *  `upsertBackend` build a new array whose subscriber only calls `schedulePush()`, which the
 *  `inFlight` gate drops — and the in-flight PUT still goes to the ABANDONED host, where
 *  `sync_push` attaches that backend's stored bearer key and uploads a body that on the
 *  `cats.backends` path carries EVERY backend's plaintext key.
 *
 *  This is the same live-target check K5/Q13/R13/R14/R15/R16 applied across the screens; the `gen`
 *  epoch does not cover it, because both `myGen` checks run only after the request has been sent. */
function liveSyncTarget(captured: Backend): string | null {
  const live = syncBackend();
  if (!live || live.id !== captured.id || live.serverUrl !== captured.serverUrl) return null;
  return effectiveServerUrl(live, useApp.getState().settings);
}

/** Keyring account holding the snapshot's API keys. The snapshot is the 3-way merge base and,
 *  for a toggled-OFF backends category, the source of what gets pushed back — so it has to keep
 *  the real keys. It does NOT have to keep them in a FILE: sync-state.json sat next to config.json
 *  as plaintext, defeating the whole point of the OS secret store. In memory the snapshot is
 *  unchanged; only the on-disk copy is stripped. */
const SNAPSHOT_SECRETS_ACCOUNT = "__sync_snapshot_secrets__";

/** True when the last snapshot load found recorded key ids but could not read their values back
 *  (locked wallet, wiped keyring). Blocks composing a backends push FROM the snapshot, which
 *  would otherwise send a secret-less list and wipe the server's stored keys. */
let snapshotSecretsUnavailable = false;

async function stashSnapshotSecrets(secrets: Record<string, string>): Promise<void> {
  await withTimeout(
    setBackendKey(SNAPSHOT_SECRETS_ACCOUNT, JSON.stringify(secrets)).catch((e) =>
      console.error("snapshot keyring write failed", e),
    ),
    10_000,
    undefined,
  );
}

/** Put the snapshot's keys back after a load. */
async function restoreSnapshotSecrets(): Promise<void> {
  snapshotSecretsUnavailable = false;
  const ids = state.snapshotSecretIds ?? [];
  if (ids.length === 0) return;
  const read = await withTimeout(
    readBackendKeys([SNAPSHOT_SECRETS_ACCOUNT]),
    10_000,
    {} as Record<string, string>,
  );
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(read[SNAPSHOT_SECRETS_ACCOUNT] ?? "{}");
  } catch {
    secrets = {};
  }
  // Own-property reads: `secrets` is JSON-parsed, so a backend id of `constructor`/`toString`/…
  // would read a truthy function off the prototype and be counted as PRESENT in a read-back that
  // does not contain it. That defeats the only thing this function does — with a locked wallet the
  // read-back is `{}`, the partial-read flag would never fire, and the pass-through push would
  // upload a secrets map missing that key (the `Object` function does not survive JSON), erasing
  // the server's copy. Exactly the hazard the flag exists to prevent.
  const got = ids.filter((id) => !!ownProp(secrets, id));
  // A PARTIAL read-back is not a success: the whole point of the flag is to stop a pass-through
  // push from erasing the server's keys, and a partial map erases exactly the ones that are
  // missing. Only a complete read-back clears it.
  if (got.length < ids.length) {
    snapshotSecretsUnavailable = true;
    console.warn("sync: snapshot keys unavailable — backends pass-through disabled this session");
    if (got.length === 0) return;
  }
  if (state.snapshot?.backends) {
    // Only the ids this snapshot actually recorded — a stale entry from an older snapshot must
    // not re-enter the blob and get pushed back to the server.
    state.snapshot.backends.secrets = Object.fromEntries(got.map((id) => [id, ownProp(secrets, id)!]));
  }
}

/** Forget the stashed snapshot keys. The stash is a JSON bundle of every backend's key, so a
 *  state reset that leaves it behind parks plaintext credentials in the OS secret store
 *  indefinitely, under an account name nothing in the UI ever surfaces. */
async function clearSnapshotSecrets(): Promise<void> {
  snapshotSecretsUnavailable = false;
  await withTimeout(
    deleteBackendKey(SNAPSHOT_SECRETS_ACCOUNT).catch(() => {}),
    10_000,
    undefined,
  );
}

async function persistState(patch: Partial<SyncState>): Promise<void> {
  state = { ...state, ...patch };
  // Split the snapshot's secrets out to the keyring; the file gets ids only.
  const secrets = state.snapshot?.backends?.secrets;
  // Same reason as `reconcileBackendSecrets`: `Object.keys` on a server-supplied STRING yields one
  // id per code unit, and these ids are PERSISTED — a 4 MiB value becomes a ~40 MB sync-state.json
  // that is re-read and re-expanded on every launch, long after the blob that caused it is gone.
  //
  // R2 gave this read the SHAPE check and no COUNT cap, and it is the one container read in the
  // engine whose result is persisted twice — to sync-state.json AND to the OS keyring. Iterate the
  // snapshot's BACKEND LIST and read by id, which is Q11's settled fix for the sibling read in
  // `reconcileBackendSecrets`, rather than iterating the attacker's map. `state.snapshot` is the
  // RAW remote blob, so `secrets` is server-authored: a well-formed
  // `{"backends":{"list":[],"secrets":{…350 000 junk ids…}}}` sits inside SYNC_MAX_BODY and raises
  // NO SecurityChange (`securityChanges` iterates `backends.list`, which is empty), so it applies
  // on the unattended startup/focus pull. Every one of those ids would land in
  // `snapshotSecretIds`, be written to sync-state.json and re-parsed at EVERY launch, and be
  // `JSON.stringify`d into a single keyring entry — where on Windows wincred's 2560-byte credential
  // limit makes the write fail into a `.catch(console.error)` while the ids persist anyway, so
  // every later launch reads back nothing, latches `snapshotSecretsUnavailable`, and drops the
  // backends category from every push for the session.
  //
  // Bounding by the list is the bound that matters (a secret for a backend the snapshot does not
  // list can never be composed — `composeBlob` builds `secrets` from the local backend list, so
  // legitimate keys are always a subset), and MAX_SYNCED_ENTRIES caps it by construction since the
  // raw list is itself server-authored.
  const secretsMap = isPlainObject(secrets) ? (secrets as Record<string, unknown>) : undefined;
  const listed = Array.isArray(state.snapshot?.backends?.list) ? state.snapshot.backends.list : [];
  const ids: string[] = [];
  if (secretsMap) {
    const seen = new Set<string>();
    for (const b of listed) {
      if (ids.length >= MAX_SYNCED_ENTRIES) break;
      const id: unknown = (b as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || seen.has(id)) continue;
      if (typeof ownProp(secretsMap, id) !== "string") continue;
      seen.add(id);
      ids.push(id);
    }
  }
  const hadStash = state.snapshotSecretIds !== undefined;
  state.snapshotSecretIds = ids.length > 0 ? ids : undefined;
  if (ids.length > 0) {
    // Stash the NARROWED map, not the original: stashing the attacker's map would put the ids
    // straight back into the keyring entry the id list was just bounded to keep out of.
    await stashSnapshotSecrets(
      Object.fromEntries(ids.map((id) => [id, ownProp(secretsMap!, id) as string])),
    );
  } else if (hadStash) {
    // The stash must never outlive the snapshot it belongs to. When the new snapshot carries no
    // secrets (locked wallet, or a remote snapshot with no backends category) the old bundle was
    // left in the keyring with nothing left to point at it: `restoreSnapshotSecrets` returns
    // early on an empty id list, and the two `clearSnapshotSecrets` callers only fire on a server
    // switch or a manual reset. A plaintext bundle of every key stayed there indefinitely.
    await clearSnapshotSecrets();
  }
  // `isPlainObject` on BOTH containers, for the reason the `ids` line above already gives — but
  // this is the half that PERSISTS. `state.snapshot?.backends?.secrets` reads `undefined` when
  // `backends` is a server-supplied STRING, so the guarded `ids` path above is silently skipped
  // and the unguarded spread below expands it to one key per code unit. A 4 MiB `backends` string
  // becomes a ~57 MB sync-state.json, which `initSync` re-parses into the 3-way merge base at
  // every launch — so `catEqual`/`stableStringify` then sort 4M keys on every merge and the next
  // `persistState` re-spreads the exploded object. One pull otherwise degrades the install
  // permanently, long after the blob that caused it is gone.
  const snapshot = isPlainObject(state.snapshot) ? (state.snapshot as SyncBlob) : undefined;
  const onDisk: SyncState = {
    ...state,
    snapshot: snapshot
      ? {
          ...snapshot,
          // A non-object `backends` is DROPPED rather than passed through: it can only have come
          // from a hostile/broken server, it is unusable as a merge base either way, and keeping
          // it is what re-explodes it on the next `persistState`.
          backends: isPlainObject(snapshot.backends)
            ? ({ ...snapshot.backends, secrets: undefined } as SyncBackends)
            : undefined,
        }
      : undefined,
  };
  await saveSyncState(onDisk).catch((e) => console.error("saveSyncState failed", e));
}

/** Bind the bookkeeping to the server it belongs to. On a sync-server switch
 *  the old server's version must not become a CAS base against the new one
 *  (nor its snapshot a merge base) — drop everything but the device identity
 *  and start the new server from the version-0 zero-state. */
async function ensureStateFor(backendId: string): Promise<void> {
  if (state.serverBackendId === backendId) return;
  state = { deviceId: state.deviceId };
  // The old server's snapshot is gone — but its stashed keys are NOT, unless we delete them.
  // The fresh state records no ids, so nothing would ever look for that entry again either.
  await clearSnapshotSecrets();
  await persistState({
    serverBackendId: backendId,
    version: 0,
    updatedAt: null,
    device: null,
  });
}

// ── pull / push ─────────────────────────────────────────────────────────────

/** Pull the server blob and reconcile it into the running app. `manual` also
 *  re-applies when the version hasn't moved (a "make it so" button press). */
export async function pullNow(manual = false): Promise<void> {
  const backend = syncBackend();
  if (!backend || !canSync() || inFlight) return;
  inFlight = true;
  const myGen = gen;
  setRuntime({ syncStatus: "syncing", syncError: null });
  try {
    await ensureStateFor(backend.id);
    const pullUrl = liveSyncTarget(backend);
    if (pullUrl === null) {
      // The target moved while we were in the keyring. Don't read the abandoned host — the next
      // window-focus pull runs against the corrected address on its own.
      setRuntime({ syncStatus: "ok" });
      return;
    }
    const res = await syncPull({ serverUrl: pullUrl, backendId: backend.id });
    if (myGen !== gen) return; // superseded mid-flight — this result is for the wrong server
    if (!res.ok || !res.state) {
      handleTransportFailure(res.status, res.error);
      return;
    }
    setRuntime({ syncUnsupported: false });
    // The server chooses `version`, Rust parses it as i64, and it arrives here as a JS double —
    // so anything above 2^53 has already lost precision, and i64::MAX round-trips back out as
    // i64::MAX + 1. Every later `sync_push` then fails to deserialize `base_version: i64` before
    // any Rust code runs, and because the bad value is PERSISTED to sync-state.json the device
    // can never push again, across restarts, with the status stuck on "syncing" and no error.
    // Treat an unrepresentable version as a transport failure instead of adopting it.
    const remote = res.state;
    if (!Number.isSafeInteger(remote.version)) {
      handleTransportFailure(0, "The server sent a settings version this app cannot represent.");
      return;
    }
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
    await reconcileRemote(remote, myGen);
  } finally {
    if (myGen === gen) inFlight = false;
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
  const myGen = gen;
  setRuntime({ syncStatus: "syncing", syncError: null });
  try {
    await ensureStateFor(backend.id);
    const s = useApp.getState();
    const cats = s.settings.sync?.categories ?? fullCats();
    let blob = await composeBlob(
      { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
      cats,
      state.snapshot,
      { includeSecrets: true, sub: subSettings(), gates: settingGates() },
    );
    let base = state.version ?? 0;
    if (!manual && hashBlob(blob) === state.hash && base > 0) {
      setRuntime({ syncStatus: "ok" });
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // Re-asked per ATTEMPT, not once before the loop: a conflict retry re-composes and re-sends,
      // so the address can go stale between attempts too. This is the request that carries every
      // backend's plaintext key, so it is the one that must not go to an abandoned host.
      const pushUrl = liveSyncTarget(backend);
      if (pushUrl === null) {
        setRuntime({ syncStatus: "ok" });
        schedulePush(0); // let the corrected address receive this state instead
        return;
      }
      const res = await syncPush({
        serverUrl: pushUrl,
        backendId: backend.id,
        blob,
        baseVersion: base,
        device: device?.hostname ?? "unknown device",
      });
      if (myGen !== gen) return; // superseded mid-flight — drop this server's result
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
        // Normalize a pre-split peer's blob before merging — the 3-way base and the local
        // compose are already in the current shape.
        const remoteBlob = migrateBlob((remote.blob ?? {}) as SyncBlob);
        const { merged, conflicts } = mergeBlobs(state.snapshot, blob, remoteBlob);
        if (conflicts.length > 0) {
          raiseConflict({ categories: conflicts, merged, local: blob, remote: remoteBlob,
            remoteVersion: remote.version, remoteDevice: remote.device ?? null });
          return;
        }
        // Auto-merged: adopt the merge locally, then retry on the new base. Honour the user's
        // category opt-outs like the other two applyBlob callers — with fullCats() a category
        // the user switched OFF still took the remote value on any ordinary 409.
        const pushCats = useApp.getState().settings.sync?.categories ?? fullCats();
        // A 409 merge adopts remote values too, so it gets the same consent gate as a pull.
        const riskyPush = securityChanges(merged, blob, pushCats);
        if (riskyPush.length > 0) {
          await applyBlob(merged, heldBack(pushCats, riskyPush));
          raiseReview({
            changes: riskyPush, blob: merged, cats: pushCats, remote: remoteBlob,
            version: remote.version, updatedAt: null, device: remote.device ?? null,
            pushAfter: true,
          });
          return;
        }
        await applyBlob(merged, pushCats);
        blob = merged;
        base = remote.version;
        continue;
      }
      handleTransportFailure(res.status, res.error);
      return;
    }
    setRuntime({ syncStatus: "error", syncError: "The server kept changing underneath — try again." });
  } finally {
    if (myGen === gen) inFlight = false;
  }
}

/** Shared pull-side reconcile: merge remote with local against the snapshot.
 *  `myGen` is the caller's sync epoch — bail before mutating anything if a
 *  supersede happened while the transport call was in flight. */
async function reconcileRemote(remote: SyncRemoteState, myGen: number): Promise<void> {
  const s = useApp.getState();
  const cats = fullCats();
  const local = await composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    s.settings.sync?.categories ?? cats,
    state.snapshot,
    { includeSecrets: true, sub: subSettings(), gates: settingGates() },
  );
  if (myGen !== gen) return; // superseded — don't apply the old server's blob
  // Normalize a pre-split peer's blob before merging (the base and local are current-shape).
  const remoteBlob = migrateBlob((remote.blob ?? {}) as SyncBlob);
  const { merged, conflicts } = mergeBlobs(state.snapshot, local, remoteBlob);
  if (conflicts.length > 0) {
    raiseConflict({ categories: conflicts, merged, local, remote: remoteBlob,
      remoteVersion: remote.version, remoteDevice: remote.device ?? null });
    return;
  }
  const applyCats = s.settings.sync?.categories ?? cats;
  // This pull is unattended (startup + every window focus). If it would repoint a backend or
  // swap a stored key, hold it for confirmation instead of adopting it silently.
  const risky = securityChanges(merged, local, applyCats);
  if (risky.length > 0) {
    // Everything else still applies — only the backends category waits. Deliberately no
    // persistState here: adopting the server's version as the new base would drop the held-back
    // change, so the next pull re-offers it until the user decides.
    await applyBlob(merged, heldBack(applyCats, risky));
    raiseReview({
      changes: risky, blob: merged, cats: applyCats, remote: remoteBlob,
      version: remote.version, updatedAt: remote.updated_at ?? null,
      device: remote.device ?? null, pushAfter: true,
    });
    return;
  }
  await applyBlob(merged, applyCats);
  // Persist what the SERVER holds (remote), not the merge result: snapshot is
  // the 3-way base for the NEXT sync and hash is the did-anything-change gate
  // for pushes. Recording `merged` here would make the follow-up push compose
  // an identical hash and silently skip — stranding the local contribution
  // client-side forever. (For toggled-OFF categories merged == remote by
  // construction, so compose-from-snapshot preservation is unaffected.)
  await persistState({
    version: remote.version,
    updatedAt: remote.updated_at ?? null,
    device: remote.device ?? null,
    hash: hashBlob(remoteBlob),
    snapshot: remoteBlob,
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
  return {
    general: true,
    logging: true,
    recording: true,
    chip: true,
    backends: true,
    profiles: true,
    dictionary: true,
    appRules: true,
    transcription: true,
    fileTranscriptions: true,
  };
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

// ── security review of a pulled blob (driven by the Sync tab dialog) ────────

/** One pulled change worth stopping for. Everything a sync server can change is applied
 *  silently EXCEPT these two: where the microphone audio goes, and which credential travels
 *  with it. A sync server is remote and may be hostile or intercepted, and the pull runs
 *  unattended at startup and on every window focus — so these get the same explicit consent
 *  the file-import path already asks for. */
export interface SecurityChange {
  kind:
    | "new-backend"
    | "server-url"
    | "api-key"
    | "recording-retention"
    | "save-recordings"
    | "history-retention"
    | "dictation-retention";
  /** The backend a `backends`-category change applies to; the recording kinds have no backend and
   *  set this to an empty string (the dialog omits it). */
  backend: string;
  detail: string;
  /** The address that would take effect, unformatted, for the kinds that carry one. The dialog
   *  parses this rather than trusting `detail`: a URL's real authority is whatever follows the
   *  last "@", so `http://localhost:8000@evil.tld/v1` reads as a loopback address in prose while
   *  connecting to `evil.tld`. The consent surface has to show the host it will actually reach. */
  url?: string;
}

/** Which category each held-back change lives in, so the apply can suppress exactly that one and
 *  let everything else through. */
function catOf(kind: SecurityChange["kind"]): SyncCategory {
  if (kind === "recording-retention" || kind === "save-recordings" || kind === "dictation-retention") {
    return "recording";
  }
  if (kind === "history-retention") return "fileTranscriptions";
  return "backends";
}

/** `cats` with every category that has a held-back change switched OFF. */
function heldBack(
  cats: Record<SyncCategory, boolean>,
  risky: SecurityChange[],
): Record<SyncCategory, boolean> {
  const out = { ...cats };
  for (const c of risky) out[catOf(c.kind)] = false;
  return out;
}

/** Compare what a pull would apply against what this device holds, and report only the
 *  security-relevant differences. `local` is the freshly composed local blob, so its
 *  `backends.secrets` already reflects the keyring — no extra wallet read here. */
function securityChanges(
  incoming: SyncBlob,
  local: SyncBlob,
  cats: Record<SyncCategory, boolean>,
): SecurityChange[] {
  const out: SecurityChange[] = [];
  // The `recording` category looks like styling but carries two settings with real consequences:
  // the retention window drives a sweep that DELETES saved recordings and their transcripts, and
  // `saveRecordings` turns on a permanent plaintext archive of everything dictated. Both applied
  // silently on an unattended pull. They get the same confirmation as a repointed server.
  if (cats.recording && incoming.recording) {
    const nextDays = incoming.recording.recordingsRetentionDays ?? 0;
    const hereDays = local.recording?.recordingsRetentionDays ?? 0;
    // Only a change that starts deleting, or deletes sooner, needs consent — lengthening the
    // window (or turning retention off) destroys nothing.
    if (nextDays !== hereDays && nextDays !== 0 && (hereDays === 0 || nextDays < hereDays)) {
      out.push({
        kind: "recording-retention",
        backend: "",
        detail:
          hereDays === 0
            ? `saved recordings older than ${nextDays} day(s) would start being deleted`
            : `saved recordings would be deleted after ${nextDays} day(s) instead of ${hereDays}`,
      });
    }
    if (incoming.recording.saveRecordings && !local.recording?.saveRecordings) {
      out.push({
        kind: "save-recordings",
        backend: "",
        detail: "every dictation would be saved to this device as audio and text",
      });
    }
  }
  // The two history retention clocks drive sweeps that DELETE stored history
  // (dictation sessions incl. audio; file transcripts incl. their audio
  // copies). Same rule as the recording clock above: only a change that
  // starts deleting, or deletes sooner, needs consent. The dictation clock
  // rides the `recording` category; the file clock its own category.
  const clockCheck = (
    container: unknown,
    localContainer: unknown,
    key: "dictationRetentionDays" | "historyRetentionDays",
    fallback: number,
    what: string,
    kind: SecurityChange["kind"],
  ) => {
    if (!isPlainObject(container)) return;
    const rawNext = ownProp(container, key);
    const nextDays = typeof rawNext === "number" && Number.isFinite(rawNext) ? rawNext : fallback;
    const rawHere = isPlainObject(localContainer) ? ownProp(localContainer, key) : undefined;
    const hereDays = typeof rawHere === "number" ? rawHere : fallback;
    if (nextDays !== hereDays && nextDays !== 0 && (hereDays === 0 || nextDays < hereDays)) {
      out.push({
        kind,
        backend: "",
        detail:
          hereDays === 0
            ? `${what} older than ${nextDays} day(s) would start being deleted (currently kept forever)`
            : `${what} would be deleted after ${nextDays} day(s) instead of ${hereDays}`,
      });
    }
  };
  if (cats.recording) {
    clockCheck(incoming.recording, local.recording, "dictationRetentionDays", 7,
      "dictations", "dictation-retention");
  }
  if (cats.fileTranscriptions) {
    clockCheck(incoming.fileTranscriptions, local.fileTranscriptions, "historyRetentionDays", 0,
      "file transcriptions", "history-retention");
  }
  if (!cats.backends || !incoming.backends) return out;
  const here = new Map((local.backends?.list ?? []).map((b) => [b.id, b]));
  const localSecrets = local.backends?.secrets ?? {};
  const nextSecrets = incoming.backends.secrets ?? {};
  // `??` defends null/undefined only. The CONTAINER is as attacker-shaped as its elements —
  // the blob is an opaque `serde_json::Value` all the way through Rust — so `"list": 5` threw
  // "is not iterable" here, before the per-element guard below, with the same silent outcome:
  // the rejection escapes `void pullNow()` (startup + every window focus), syncStatus sticks on
  // "syncing" and syncError stays null. The three sanitizers all open with this check; the gate
  // that protects the apply did not.
  for (const b of Array.isArray(incoming.backends.list) ? incoming.backends.list : []) {
    // The gate runs on the RAW list — sanitization happens later, inside `applyBlob` — so it must
    // survive anything the server sends. `normalizeUrl` calls `.trim()`, and a non-string
    // serverUrl threw right here, inside the consent gate itself: the rejection escaped
    // `reconcileRemote` into `void pullNow()`, leaving syncStatus stuck on "syncing" with no error
    // shown and every later focus pull repeating it. Match `sanitizeBackends`' own floor, so an
    // entry that would be dropped anyway cannot disable the gate that protects the apply.
    if (!b || typeof b.id !== "string" || typeof b.serverUrl !== "string") continue;
    const cur = here.get(b.id);
    const name = b.name || b.serverUrl || b.id;
    if (!cur) {
      out.push({ kind: "new-backend", backend: name, detail: b.serverUrl, url: b.serverUrl });
    } else if (normalizeUrl(cur.serverUrl) !== normalizeUrl(b.serverUrl)) {
      out.push({
        kind: "server-url",
        backend: cur.name || name,
        detail: `${cur.serverUrl} → ${b.serverUrl}`,
        url: b.serverUrl,
      });
    }
    // Only an actual value change counts: an unchanged key rides along in every push. But the
    // comparison must FAIL CLOSED — `localSecrets` is `{}` whenever the keyring read degraded
    // (locked wallet: composeBlob's read is a 10s withTimeout that falls back to `{}`), and it is
    // legitimately empty for a backend that has no key yet. Requiring a known local value there
    // let an incoming key be written with no review in exactly the cases we can least verify.
    // Own-property reads: an inbound id is whatever the blob chose, and `isReservedBackendId`
    // rejects only the `__…__` namespace — so `toString`/`constructor` otherwise make both maps
    // return the same inherited function (comparison false, no prompt) or mislabel the detail line
    // as "the stored key would be replaced" for a key that does not exist locally.
    const incomingKey = ownProp(nextSecrets, b.id);
    const localKey = ownProp(localSecrets, b.id);
    if (incomingKey && here.has(b.id) && incomingKey !== localKey) {
      out.push({
        kind: "api-key",
        backend: cur?.name || name,
        detail: localKey
          ? "the stored key would be replaced"
          : "a key would be stored for this server",
      });
    }
  }
  return out;
}

/** A pulled blob held back until the user approves its security-relevant changes. */
interface PendingReview {
  changes: SecurityChange[];
  blob: SyncBlob;
  cats: Record<SyncCategory, boolean>;
  remote: SyncBlob;
  version: number;
  updatedAt: number | null;
  device: string | null;
  pushAfter: boolean;
}
let pendingReview: PendingReview | null = null;

/** The Sync tab reads the held-back pull through this (the blobs stay out of the store). */
export function getPendingReview(): { changes: SecurityChange[]; device: string | null } | null {
  return pendingReview ? { changes: pendingReview.changes, device: pendingReview.device } : null;
}

function raiseReview(r: PendingReview): void {
  pendingReview = r;
  setRuntime({
    syncStatus: "error",
    syncError:
      "A pulled update wants to change where your dictation is sent, or what is kept on this device — review it in Settings → Sync.",
  });
}

/** Approve the held-back pull: apply it and adopt the server's version as the new base. */
export async function approvePendingReview(): Promise<void> {
  const r = pendingReview;
  if (!r) return;
  pendingReview = null;
  await applyBlob(r.blob, r.cats);
  await persistState({
    version: r.version,
    updatedAt: r.updatedAt,
    device: r.device,
    hash: hashBlob(r.remote),
    snapshot: r.remote,
  });
  setRuntime({ syncStatus: "ok", syncError: null, lastSyncedAt: Date.now(), lastSyncDevice: r.device });
  if (r.pushAfter && hashBlob(r.blob) !== hashBlob(r.remote)) schedulePush(0);
}

/** Reject the held-back pull. Nothing is applied and NO base is adopted, so the next pull
 *  re-offers it rather than silently treating the rejected state as agreed. */
export function rejectPendingReview(): void {
  pendingReview = null;
  setRuntime({ syncStatus: "idle", syncError: null });
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
  const applyCats = useApp.getState().settings.sync?.categories ?? fullCats();
  // The security gate has to run HERE too, not just on the clean-merge path. `final` starts as
  // `c.merged`, which already contains every NON-conflicting category auto-resolved in the
  // server's favour — so a peer that also touches some category the user happened to edit
  // locally forces the pull down this branch and rides its backend repoint / key swap in
  // unreviewed. The conflict dialog only ever showed the CONFLICTING category names, never the
  // address change. Same shape as reconcileRemote: apply everything else, hold backends, and
  // persist no base so a rejection is re-offered on the next pull.
  const risky = securityChanges(final, c.local, applyCats);
  if (risky.length > 0) {
    await applyBlob(final, heldBack(applyCats, risky));
    raiseReview({
      changes: risky,
      blob: final,
      cats: applyCats,
      remote: c.remote,
      version: c.remoteVersion,
      updatedAt: null,
      device: c.remoteDevice ?? null,
      pushAfter: true,
    });
    return;
  }
  await applyBlob(final, applyCats);
  // Same server-truth rule as reconcileRemote: the server still holds
  // c.remote at remoteVersion — record THAT, so if the follow-up push fails,
  // later automatic pushes still see a difference and retry.
  await persistState({
    version: c.remoteVersion,
    hash: hashBlob(c.remote),
    snapshot: c.remote,
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
  // Normalize a pre-split snapshot to the current category layout. Without this the 3-way
  // base stays old-shape while fresh composes are new-shape, so the first sync after an
  // upgrade would read EVERY category as changed-on-both-sides and raise spurious conflicts.
  if (state.snapshot) state.snapshot = migrateBlob(state.snapshot);
  await restoreSnapshotSecrets();
  // Migrate a pre-split state file: it still holds the keys in cleartext and records no ids.
  // Rewriting now moves them to the keyring and strips the file, rather than waiting for
  // whenever the next sync happens to persist.
  if (!state.snapshotSecretIds && state.snapshot?.backends?.secrets) {
    await persistState({});
  }
  device = await syncDeviceInfo();

  // Migrate pre-serverBackendId state files: they were only ever written for
  // the currently configured sync server, so stamp that identity instead of
  // letting ensureStateFor() wipe a perfectly good snapshot on first contact.
  if (state.version && !state.serverBackendId && syncMeta()?.backendId) {
    await persistState({ serverBackendId: syncMeta()!.backendId });
  }

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
    // supersede() first: an in-flight sync against the previous server (e.g.
    // one still waiting out the transport timeout on an unreachable host)
    // must neither block this pull via `inFlight` nor land its late result —
    // without it, switching servers looked dead until a disable/re-enable.
    const prevSync = prev.settings.sync;
    const nowSync = s.settings.sync;
    if (nowSync?.enabled && (!prevSync?.enabled || prevSync.backendId !== nowSync.backendId)) {
      supersede();
      setRuntime({ syncUnsupported: false, syncError: null });
      void pullNow(true);
      return;
    }
    // Sync switched off: cancel queued/in-flight work and clear stale status.
    if (prevSync?.enabled && !nowSync?.enabled) {
      supersede();
      setRuntime({ syncStatus: "idle", syncError: null });
      return;
    }
    // A category toggled ON adopts the server's state for it before pushing.
    if (
      nowSync?.enabled &&
      prevSync?.categories &&
      ALL_CATEGORIES.some((c) => nowSync.categories[c] && !prevSync.categories[c])
    ) {
      supersede();
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
  state = { deviceId: state.deviceId, serverBackendId: state.serverBackendId };
  await clearSnapshotSecrets(); // no snapshot left — drop its stashed keys with it
  await persistState({ version: 0, updatedAt: null, device: null, hash: undefined, snapshot: undefined });
  setRuntime({ lastSyncedAt: null, lastSyncDevice: null, syncStatus: "idle", syncError: null });
}
