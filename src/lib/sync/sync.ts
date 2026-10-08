// P30: the settings-sync engine — composes the synced blob, 3-way merges,
// applies pulls, and drives the automatic triggers (startup pull, focus pull,
// debounced push). File export/import reuses the same extract/apply core
// (lib/sync/settingsFile.ts).
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

import { useApp, CONFIG_VERSION } from "../store";
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
} from "../api";
import { configReady } from "../persistence";
import { effectiveServerUrl, isStorableServerUrl, normalizeUrl, stripUrlNoise } from "../backends";
import { DEFAULT_PASTE_SHORTCUT, PASTE_PRESETS } from "../paste";
import { IS_WINDOWS } from "../platform";
import { hasOwn, ownProp } from "../own";
import { sanitizeCueLimits } from "../transcript/cueSplit";
import { appRuleKey, normalizeAppId, safeDisplayText } from "../sanitize";
import { conflicts, QUICK_ADD_PEER_ID, withQuickAddPeer } from "../hotkeyConflicts";
import { LEGACY_HANDSFREE } from "../types";
import { TRANSLATION_MAX_TARGETS } from "../languages";
import { clampDecodeOverrides, DECODE_KEYS, TYPED_TEXT_KEYS } from "../decodeKeys";
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
  TranslationOverrides,
} from "../types";
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
import type { SyncSubSettings } from "../types";
import { MANIFEST, completeGates } from "../settingsManifest";
import { isValidAccentMotion } from "../theme";
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
  catsFromGates,
  isPlainObject,
  SCALAR_CATS,
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

/** Every category set to `on` — the all-included export selection and test fixtures. */
export function categorySelection(on: boolean): Record<SyncCategory, boolean> {
  return Object.fromEntries(ALL_CATEGORIES.map((c) => [c, on])) as Record<SyncCategory, boolean>;
}

/** This device's field-level opt-outs (Settings → Sync sub-toggles), with the
 *  behavior-preserving defaults for configs from before they existed. */
function subSettings(): SyncSubSettings {
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
function settingGates(): Gates {
  const sync = useApp.getState().settings.sync;
  return completeGates(sync?.sub, sync?.categories);
}

/** The engine's category toggles, DERIVED from the per-setting gates. The persisted
 *  `sync.categories` map has had no UI writer since the manifest list replaced the
 *  category rows: reading it froze an upgraded user's OFF category forever (no control
 *  could turn it back on) and left the list-level switches — "Server list", "Profile
 *  list & settings", "Rules for this OS" — inert. */
function syncCats(): Record<SyncCategory, boolean> {
  return catsFromGates(settingGates()) as Record<SyncCategory, boolean>;
}

/** applyBlob strips gated-off scalar fields, so the security review must judge what
 *  will actually apply: comparing ungated blobs raised the consent dialog (and held a
 *  whole category back) for a peer edit to a setting this device opted out of. Both
 *  sides are stripped, or `securityChanges`' local-value fallbacks would fire spuriously. */
function gateScalars(b: SyncBlob, gates: Gates): SyncBlob {
  const out: SyncBlob = { ...b };
  for (const c of SCALAR_CATS) {
    if (out[c] !== undefined) (out as Record<string, unknown>)[c] = gateApplyScalar(c, out[c], gates);
  }
  return out;
}

/** This machine's appRules bucket. macOS has no app-rules backend; it falls
 *  into the linux bucket harmlessly (rules never match anything there). */
const MY_BUCKET: "linux" | "windows" = IS_WINDOWS ? "windows" : "linux";
const OTHER_BUCKET: "linux" | "windows" = IS_WINDOWS ? "linux" : "windows";

// ── canonical hash ──────────────────────────────────────────────────────────

import { stableStringify } from "../stable";
import { forgetCaps } from "../capabilities";

/** FNV-1a over the canonical string — a compact change-detection token (NOT
 *  crypto; it only gates "did anything sync-relevant change?"). */
function hashBlob(v: unknown): string {
  const s = stableStringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export { isPlainObject } from "./syncGates";

/** Category equality — the test that decides whether a category conflicts and prompts, or merges
 *  silently. Compares the canonical strings, NOT their hashes: `hashBlob` builds this exact string
 *  first and then folds it to 32 bits, so the digest comparison was strictly more work for a
 *  probabilistic answer — on inputs one of which (the base) is the server's own last blob. */
const catEqual = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

/** Bound an await that may never settle. The ONLY unbounded await in the
 *  engine is the keyring read (a locked KWallet parks the request behind a
 *  password prompt indefinitely); everything else rides reqwest's timeout.
 *  Without this, one blocked read wedges the engine for the whole session
 *  (`inFlight` never clears — the finally never runs on a never-settling
 *  promise). Degrading to `fallback` (push without secrets) is always safer
 *  than never pushing again. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
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
  const out: Record<string, unknown> = Object.create(null);
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
  // A non-object root (a server-sent string) would spread into one key per code unit here.
  if (!isPlainObject(blob)) return {};
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
    // Guarded like `g`/`b` around it: a server-authored STRING here would be
    // rest-spread into one key per code unit (and persisted as the snapshot).
    const dict = isPlainObject(out.dictionary) ? out.dictionary : undefined;
    if (isCodeList(quickAddHotkey) && dict?.quickAddHotkey === undefined) {
      out.dictionary = { ...(dict ?? {}), quickAddHotkey } as typeof out.dictionary;
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
      if (Object.keys(dictPart).length) {
        // Create the category when absent, like the file half below: the keys were already
        // stripped from `transcription`, so an old-shape blob with no `recording` payload
        // lost them from the merge base, the pull and an imported file.
        out.recording = {
          ...dictPart,
          ...(isPlainObject(out.recording) ? (out.recording as object) : {}),
        } as SyncRecording;
      }
      if (Object.keys(filePart).length && out.fileTranscriptions === undefined) {
        out.fileTranscriptions = filePart as SyncFileTranscriptions;
      }
    }
  }
  if (isPlainObject(out.recording)) {
    const rec = out.recording as Record<string, unknown>;
    if (hasOwn(rec, "latchAutoStopMin") && !hasOwn(rec, "handsFreeAutoStopMin")) {
      rec.handsFreeAutoStopMin = rec.latchAutoStopMin;
      delete rec.latchAutoStopMin;
    }
  }
  const b = out.backends as (SyncBackends & { quickAddList?: unknown }) | undefined;
  if (isPlainObject(b) && hasOwn(b, "quickAddList")) {
    const { quickAddList, ...rest } = b;
    out.backends = rest as SyncBackends;
    const dict = isPlainObject(out.dictionary) ? out.dictionary : undefined;
    if (dict?.quickAddList === undefined && quickAddList !== undefined) {
      out.dictionary = { ...(dict ?? {}), quickAddList: safeQuickAddTarget(quickAddList) } as typeof out.dictionary;
    }
  }
  return out;
}

// ── extract: live config → category payloads ───────────────────────────────

function extractGeneral(settings: AppSettings): SyncGeneral {
  const g = settings.general;
  return {
    theme: settings.theme,
    accentHue: settings.accentHue,
    accentMotion: settings.accentMotion,
    startMinimized: g.startMinimized,
    insertTiming: g.insertTiming,
    typeAsISpeak: g.typeAsISpeak,
    insertMethod: g.insertMethod,
    pasteShortcut: g.pasteShortcut,
    // autoEnter is deliberately absent: the apply arm drops it on every inbound path (a
    // peer must not arm a post-paste Return), so it is local-only in the manifest too.
    restoreClipboard: g.restoreClipboard,
    excludeFromClipboardHistory: g.excludeFromClipboardHistory,
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

/** Profiles, with the "Profile shortcuts" sub-toggle applied: when OFF, each
 *  known profile ships the SNAPSHOT's chord (this device's chord edits stay
 *  local) — a profile the snapshot doesn't know yet ships its live chord, so
 *  peers never receive a chord-less profile (`sanitizeProfiles` requires a
 *  code list). */
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
  // Strip `insertionOverrides.autoEnter` before the wire/export: the apply side forces
  // it off on every inbound path (same security reason as the app-rule twin), so emitting
  // it promises a value no import can restore.
  list = list.map((p) =>
    p.insertionOverrides?.autoEnter !== undefined
      ? { ...p, insertionOverrides: { ...p.insertionOverrides, autoEnter: undefined } }
      : p,
  );
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

/** Blobs `composeBlob` built through its degraded-keyring pass-through (see `backendsDegraded`). */
const degradedComposes = new WeakSet<SyncBlob>();

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
    ? extractDictionary(
        cfg.settings,
        opts.sub.quickAddHotkey,
        // The pin needs its referent list AND its own "Pinned word mappings" switch (which
        // nothing read before). `gates` is absent on the export path, deliberately all-on.
        cats.backends && (opts.gates?.pinnedMappings ?? true),
        snapshot,
      )
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
        // device believes it HAS keys and we read none back, re-push the SNAPSHOT's category
        // (the server's own last content, unchanged). NOT `undefined`: the transport is a
        // whole-blob PUT and the client does the merge, so an omitted key does not "leave the
        // server's copy alone" — JSON.stringify drops it and the stored list AND its keys are
        // erased, then recorded as the new merge base. On the export path (no snapshot) the
        // local list travels without secrets — a backup must never silently lose the server list.
        blob.backends = snapshot ? snapshot.backends : { list: cfg.backends };
        // Marked for the merge callers (`backendsDegraded`): not by reference identity, because
        // the per-setting gate pass below rebuilds `blob.backends` into a fresh object.
        if (snapshot) degradedComposes.add(blob);
      }
    }
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
    // Strip `autoEnter` before it reaches the wire/export: the apply side forces it off
    // on every inbound path (security: a post-paste Return submits whatever the transcript
    // put in the buffer), so emitting it promises a value no import can restore. Stripping
    // here keeps the export honest and prevents a backup/restore from silently dropping the
    // setting on a fresh device (where there is no local value to repin from).
    buckets[MY_BUCKET] = cfg.appRules.map(({ autoEnter: _, ...r }) => r as AppRule);
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
    for (const c of SCALAR_CATS) {
      if (cats[c] && blob[c] !== undefined) {
        (blob as Record<string, unknown>)[c] = gateComposeScalar(c, blob[c], snapshot?.[c], gates);
      }
    }
    if (cats.backends && isPlainObject(blob.backends)) {
      let list = Array.isArray(blob.backends.list) ? blob.backends.list : [];
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

interface MergeResult {
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
      // defineProperty, not `[]=`: the remote blob is parsed server JSON, so an own
      // `__proto__` key arrives here and a plain assignment would invoke the setter —
      // replacing `merged`'s prototype and silently DROPPING the key (the one thing this
      // block promises never to do). composeBlob's twin is immune via `k in blob`.
      if (!known.has(k) && v !== undefined) {
        Object.defineProperty(merged, k, { value: v, writable: true, enumerable: true, configurable: true });
      }
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

/** Keyring accounts this app reserves for its own bookkeeping. A Backend `id` is used verbatim
 *  as the keyring account name, and an inbound `id` is whatever the sender chose — so without
 *  this a peer could name a backend after our snapshot stash and have `readBackendKeys` hand it
 *  the bundle of EVERY backend's key (which the next push, and that backend's own Authorization
 *  header, would then ship to a server of the sender's choosing). */
function isReservedBackendId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("__") && id.endsWith("__");
}

/** TRANSLATION_CONTEXT_SEGMENTS' upper bound on the server. */
const CONTEXT_SEGMENTS_MAX = 10;

/** The `translationOverrides` leaf, shared by the profile and backend sanitizers. Rust holds it as
 *  opaque JSON and forwards `contextSegments` into an `Option<u32>` IPC field on every dictation
 *  translation, so a fractional or negative value would fail that call — it is an integer 0–10
 *  (the server's TRANSLATION_CONTEXT_SEGMENTS range) or nothing. */
export function clampTranslationOverrides(v: unknown): TranslationOverrides | undefined {
  if (!isPlainObject(v)) return undefined;
  const cs = v.contextSegments;
  const out: TranslationOverrides = {
    translateTo: Array.isArray(v.translateTo)
      ? v.translateTo.filter((c: unknown): c is string => typeof c === "string").slice(0, TRANSLATION_MAX_TARGETS)
      : undefined,
    model: typeof v.model === "string" ? v.model.slice(0, 200) : undefined,
    contextSegments:
      typeof cs === "number" && Number.isFinite(cs) ? Math.min(CONTEXT_SEGMENTS_MAX, Math.max(0, Math.round(cs))) : undefined,
    glossary: typeof v.glossary === "string" ? v.glossary.slice(0, 4000) : undefined,
    mode: v.mode === "fluent" || v.mode === "faithful" ? v.mode : undefined,
    includeOriginal: v.includeOriginal == null ? undefined : v.includeOriginal === true,
  };
  // An absent key must stay ABSENT, not `undefined`: the per-field spreads that layer a Profile
  // over its Backend would let an own `undefined` overwrite the inherited value (an inheriting
  // Profile stops translating). Explicit false and "" are values and stay.
  for (const k of Object.keys(out) as (keyof TranslationOverrides)[]) if (out[k] === undefined) delete out[k];
  return out;
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
      name: p.name,
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
      translationOverrides: clampTranslationOverrides(p.translationOverrides),
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
      // Same clamp as the Backend twin: the leaf rode the `...p` spread untouched, and Rust
      // forwards it into every session request as opaque JSON.
      decodeOverrides: clampDecodeOverrides(p.decodeOverrides),
      // `backendId` rode the `...p` spread too. Rust's `backend_id` is `Option<String>`,
      // and the dangling-reference scrub in `applyBlob` is NOT a type check standing in for one:
      // it is gated on `p.backendId &&`, so a FALSY non-string (`0`, `false`) skips it entirely
      // and reaches the typed parse, which rejects the whole `Config`. `null` is the app's own
      // "no backend chosen" value, so the scrub still runs on whatever survives here.
      backendId: typeof p.backendId === "string" ? p.backendId : null,
    }))
    )
    .slice(0, MAX_SYNCED_ENTRIES);
}

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
/** A chord as the capture UI produces it: a list of `KeyboardEvent.code` strings.
 *
 *  The LENGTH bound matters as much as the element type. `Profile.hotkey` is canonicalized
 *  (sort + dedup) by Rust's `de_hotkey` on the round-trip, but the store holds the raw inbound
 *  value for the rest of the session, and the TS consumers are the expensive ones: `HotkeyChips`
 *  renders one DOM node per code, `conflictsByProfile` runs an O(k²) subset scan in a component
 *  body (not memoized), both sync preview dialogs cap the PEER count but not the chord, and the
 *  debounced save gate runs the same scan. A real binding is at most a handful of codes. */
const MAX_CHORD_CODES = 16;

/** Ceiling on the LENGTH of one code, paired with `MAX_CHORD_CODE_LEN` in commands/sync.rs — the same
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
  const peers = withQuickAddPeer(profiles, quickAddHotkey);
  const order = new Map(peers.map((p, i) => [p.id, i]));
  const disable = new Set<string>();
  let rejectQuickAddHotkey = false;
  // Collapse modifier SIDES only where the registrar does (the plugin / evdev-off platforms):
  // the Windows low-level hook registers side-distinct chords (hotkeys/windows.rs, VK_LCONTROL ≠
  // VK_RCONTROL), the save gate (persistence.ts) and the Sync tab's preview both know that,
  // and collapsing here anyway disabled a working LCtrl+Space / RCtrl+Space pair on every
  // pull — persisted, and pushed back out. On Linux the over-detection is kept on purpose:
  // the sanitizer runs before the live backend is known and must be a superset of the gate.
  for (const c of conflicts(peers, !IS_WINDOWS)) {
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

/** Ceiling on how many entries one inbound blob may install. Far above any real profile /
 *  backend / rule set, so nothing legitimate is truncated — but it bounds the O(n²) passes
 *  these lists feed: `chords_from`'s dedup and `Engine::step`, which runs on EVERY system-wide
 *  key event, plus `conflicts()` and the unbounded list renders. */
const MAX_SYNCED_ENTRIES = 500;

/** Closed-vocabulary settings arrive as raw JSON. `save_config` takes a typed `Config` whose
 *  enums have no serde fallback, so one unknown variant makes EVERY later save fail — the store
 *  keeps the bad value, the save banner sticks, and `pushNow` short-circuits on it. Keep the
 *  device's current value when the incoming one is not a known variant. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** The settings leaves Rust declares as `u32` (`config/mod.rs`: `hover_reveal_ms`,
 *  `recordings_retention_days`, `LoggingSettings::keep_days`). Every other numeric leaf is `f64`.
 *  Keep this in step with the Rust structs: a `u32` leaf missing here rides through `typedLike` on
 *  `typeof === "number"` alone, and `-1` then fails `deserialize_u32` for the WHOLE Config —
 *  every later save_config rejected for the session. */
const U32_KEYS = new Set(["hoverRevealMs", "recordingsRetentionDays", "keepDays"]);

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
    "keepUrlAudioCopies", "keepUrlVideoCopies", "revealAfterSave",
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
  const len = ownProp(v, "subtitleLength");
  if (len === "transcribed" || len === "standard" || len === "short" || len === "custom") {
    out.subtitleLength = len;
  }
  const custom = sanitizeCueLimits(ownProp(v, "subtitleCustom"));
  if (custom) out.subtitleCustom = custom;
  const timing = ownProp(v, "translationTiming");
  if (timing === "same" || timing === "own") out.translationTiming = timing;
  // The export panel's Media defaults and the link-video keep height (manifest rows
  // exportMedia / urlVideoQuality promise these travel).
  const media = ownProp(v, "exportMedia");
  if (media === "none" || media === "audio" || media === "video") out.exportMedia = media;
  const box = ownProp(v, "exportContainer");
  if (box === "mkv" || box === "mp4") out.exportContainer = box;
  const subs = ownProp(v, "exportSubtitleMode");
  if (subs === "embedded" || subs === "sidecar" || subs === "both") out.exportSubtitleMode = subs;
  const height = ownProp(v, "urlVideoMaxHeight");
  if (height === null) out.urlVideoMaxHeight = null;
  else if (typeof height === "number" && Number.isFinite(height)) {
    out.urlVideoMaxHeight = Math.max(144, Math.min(4320, Math.round(height)));
  }
  // The sub-toggle-gated picks: free strings, bounded. backendId is only a
  // reference — the Transcribe screen ignores ids that don't resolve.
  for (const k of ["backendId", "model", "language", "translationModel"]) {
    const str = ownProp(v, k);
    if (typeof str === "string" && str.length <= 256) out[k] = str;
  }
  // T2T targets: the blob's only array-of-strings field — clamp shape hard
  // (TRANSLATION_MAX_TARGETS short codes max) so a hostile peer can't balloon the settings blob.
  const tt = ownProp(v, "translateTo");
  if (Array.isArray(tt)) {
    out.translateTo = tt
      .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 16)
      .slice(0, TRANSLATION_MAX_TARGETS);
  }
  return out as Partial<TranscribeSettings>;
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
function typedLike<T extends object>(incoming: T, local: T): Partial<T> {
  const out: Record<string, unknown> = Object.create(null);
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

export function sanitizeBackends(list: unknown): Backend[] {
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
      // …and the SCHEMELESS form the keyboard path accepts ("host:8000") is stored the way
      // that path stores it — with the `http://` `normalizeUrl` prepends. Stored bare, every
      // display helper re-normalised it for the UI while the transport handed reqwest a
      // scheme-less string and every request failed with an opaque URL-parse error.
      serverUrl: isStorableServerUrl(b.serverUrl)
        ? (/^https?:\/\//i.test(stripUrlNoise(b.serverUrl)) || stripUrlNoise(b.serverUrl) === ""
          ? stripUrlNoise(b.serverUrl)
          : normalizeUrl(b.serverUrl) || stripUrlNoise(b.serverUrl))
        : "",
      name: typeof b.name === "string" ? b.name : "",
      model: typeof b.model === "string" ? b.model : "",
      language: typeof b.language === "string" ? b.language : "auto",
      prompt: typeof b.prompt === "string" ? b.prompt : "",
      // The explicit-clear half of the prompt's tri-state (see `backendPrompt`). Only
      // `true` survives: anything else — a peer's string, a number, absent — is the
      // inherit the empty prompt already means, and a non-boolean would reach Rust's
      // `Option<bool>`, which has no serde fallback and would wedge every later save.
      promptCleared: b.promptCleared === true ? true : undefined,
      endpoint: oneOf<EndpointKind>(b.endpoint, ENDPOINT_KINDS, "stream"),
      responseFormat: oneOf<ResponseFormat>(b.responseFormat, RESPONSE_FORMATS, "json"),
      hasApiKey: b.hasApiKey === true,
      overrideProfile: typeof b.overrideProfile === "string" ? b.overrideProfile : undefined,
      // The one backend enum this pass had missed. `Option<BackendKind>` defaults when the key
      // is ABSENT, but a present unknown string (or a non-string) has no serde fallback and
      // fails the typed parse like its two siblings above. Keep undefined = "infer from the
      // connection test", which is what an absent key already means.
      kind: b.kind == null ? undefined : oneOf<BackendKind>(b.kind, BACKEND_KINDS, "auto"),
      decodeOverrides: clampDecodeOverrides(b.decodeOverrides),
      translationOverrides: clampTranslationOverrides(b.translationOverrides),
    }))
    )
    .slice(0, MAX_SYNCED_ENTRIES);
}

/** Drop inbound app rules that aren't shaped like rules. `appId` is only checked for existence
 *  by the Rust importer (and not at all on the pull path), yet every injection resolves through
 *  `rule.appId.toLowerCase()` — one malformed entry throws there and no transcript is ever
 *  inserted again, including in the editor the user would need to remove it. */
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
      // Three-state like its neighbours, but junk means AUTO (dropped), not "off": a wrong `true`
      // would strip clipboard restores from an app that isn't remote, a wrong `false` would
      // re-arm the 300 ms race on one that is — auto-detect is the only safe reading of a
      // value nobody meant. `Option<bool>` in Rust rejects a string outright.
      remoteDesktop:
        typeof r.remoteDesktop === "boolean"
          ? r.remoteDesktop
          : r.remoteDesktop === null
            ? null
            : undefined,
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
          const key = appRuleKey(r.appId);
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
 *  isn't actually available here. `rotated` = backends this device already knew
 *  whose stored key the apply REPLACED with a different one: their caps and
 *  connection state were measured as the old caller, so the caller evicts them. */
async function reconcileBackendSecrets(
  list: Backend[],
  secrets: Record<string, string> | undefined,
  // Superseded apply (sync off / server switch): stop writing the abandoned blob's keys into
  // the keyring. The caller's own `gen !== myGen` check after the await still drops the apply.
  aborted: () => boolean = () => false,
): Promise<{ backends: Backend[]; rotated: string[] }> {
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
  const incoming = (id: string): string | undefined => {
    const key = isPlainObject(secrets) ? ownProp(secrets as Record<string, unknown>, id) : undefined;
    return typeof key === "string" && key ? key : undefined;
  };
  // A key rotated on another device: read what this device stores BEFORE overwriting it, for
  // the backends it already runs. An unchanged rewritten key evicts nothing, and neither does a
  // degraded read (locked wallet, timed out) — the next connection test re-measures anyway.
  const known = new Set(useApp.getState().backends.map((b) => b.id));
  const candidates = list.map((b) => b.id).filter((id) => known.has(id) && incoming(id) !== undefined);
  const prior = candidates.length
    ? await withTimeout(readBackendKeys(candidates), 10_000, null as Record<string, string> | null)
    : null;
  const rotated =
    prior === null
      ? []
      : candidates.filter((id) => {
          const old = ownProp(prior as Record<string, unknown>, id);
          return typeof old === "string" && old !== "" && old !== incoming(id);
        });
  // An abort mid-loop still leaves the keys written so far replaced: report those as rotated.
  const written = new Set<string>();
  const landed = () => rotated.filter((id) => written.has(id));
  for (const b of list) {
    if (aborted()) return { backends: list, rotated: landed() };
    const id = b.id;
    const key = incoming(id);
    if (key) {
      written.add(id);
      // Same locked-wallet hazard as composeBlob's read: a parked prompt must
      // not wedge the apply. A skipped write surfaces as hasApiKey=false below.
      await withTimeout(
        setBackendKey(id, key).catch((e) => console.error("keyring write failed", e)),
        10_000,
        undefined,
      );
    }
  }
  if (aborted()) return { backends: list, rotated: landed() };
  const present = await withTimeout(
    readBackendKeys(list.map((b) => b.id)),
    10_000,
    null as Record<string, string> | null,
  );
  // A degraded read (locked wallet, timed out) must NOT demote: re-deriving `hasApiKey: false`
  // for every backend would be hydrated and persisted, and the next push would then see no
  // backend claiming a key — bypassing `composeBlob`'s erase guard and PUTting a keyless list
  // that also clears the local stash. Keep each backend's pre-apply local flag instead (false
  // for a backend new to this device, even if its secret was just written; the next pull
  // re-derives it).
  const localFlag = new Map(useApp.getState().backends.map((b) => [b.id, b.hasApiKey]));
  // Own-property test, not `in`: `present` is JSON-parsed, so it carries `Object.prototype`, and a
  // backend whose id is `constructor`/`toString`/… would be re-derived as `hasApiKey: true` with
  // nothing in the keyring — defeating the exact promise this function makes. Downstream that
  // phantom also makes `composeBlob`'s erase guard fire forever on a device holding no real keys,
  // silently dropping the backends category from every push.
  const backends = list.map((b) => {
    const held = present === null ? (localFlag.get(b.id) ?? false) : hasOwn(present, b.id);
    return b.hasApiKey === held ? b : { ...b, hasApiKey: held };
  });
  return { backends, rotated };
}

/**
 * Apply a blob's toggled-ON categories to the running app through the single
 * whole-config path (`hydrate()`), preserving every machine-local field.
 * Only the `hydrate` call runs under `applyingRemote` (so the push subscriber
 * ignores that one store change; the persistence auto-save still persists it,
 * which is wanted). The flag deliberately does NOT span the keyring wait: a
 * sync-OFF or server-switch edit made while the apply is parked must reach
 * the subscriber's supersede() branches, or the stale restart re-applies the
 * blob after the user disconnected.
 * While dictating, the apply is DEFERRED to the next idle transition — a mid-
 * session hydrate would yank profiles/backends out from under the session.
 */
export async function applyBlob(
  blob: SyncBlob,
  cats: Record<SyncCategory, boolean>,
  /** Retries left after a mid-apply store change (see the check after the keyring wait).
   *  Bounded so a user editing settings in a tight loop cannot spin this. */
  retries = 2,
  /** `ignoreGates`: an explicit one-shot restore (file import, Restore from server,
   *  onboarding) — see the gate step below. */
  opts: { ignoreGates?: boolean } = {},
): Promise<boolean> {
  const st = useApp.getState();
  if (st.status !== "idle") {
    // Deferred, not applied: the caller must NOT adopt the server's version as
    // the new base (pendingApply is memory-only and dies on quit/supersede), or
    // the peer's change is recorded as applied and never re-offered.
    pendingApply = { blob, cats, opts };
    return false;
  }
  // The epoch this apply belongs to: a supersede during the keyring wait (sync switched off,
  // server changed, a category toggled on and re-pulled) means the blob is for a state that no
  // longer exists — drop rather than restart, or the stale restart would hydrate over the new
  // pull's apply.
  const myGen = gen;
  let staleRestart = false;
  let staleAbort = false;
  // A thrown sentinel (not `return`) is the only way to leave the try AND still
  // reach the retry tail below — `return` inside the try skips it, which is
  // exactly how the documented stale-restart retry sat dead until now.
  const STALE = Symbol("stale-restart");
  try {
    const settings = st.settings;
    // Per-setting gates: strip a gated-off setting's fields from the inbound
    // scalar categories up front, so every merge-over-current below keeps
    // this device's values for them (the recordingsDir idiom, generalized).
    // List-category gates re-pin per element inside their arms below.
    // An explicit one-shot restore (file import, Restore from server, onboarding) is not
    // a sync round: the "what this device syncs" switches must not silently discard the
    // values the user asked to restore — the export composes WITHOUT gates, and on a stock
    // install every machine-specific switch is off (chip position, paste chord…).
    // Folders are the exception: every one-shot restore strips them before calling here
    // (`stripMachineFolders`), because a path from another machine (e.g. a Windows path on
    // Linux) is meaningless on this one.
    // All-on gates also neutralise the per-element repins in the list arms below.
    const gates = opts.ignoreGates
      ? (Object.fromEntries(MANIFEST.map((d) => [d.id, true])) as Gates)
      : completeGates(settings.sync?.sub, settings.sync?.categories);
    if (!opts.ignoreGates) blob = gateScalars(blob, gates);
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
      const { theme, accentHue, accentMotion, ...incoming } = blob.general as SyncGeneral;
      // Machine-local fields are excluded from SyncGeneral by TYPE only, which stops us sending
      // them but not a peer (or a hand-authored import file) from sending them to us — and the
      // import dialog promises the user the Linux input backend is never imported. Enforce it on the way in.
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
        // A hue is a finite degree in [0, 360]; anything else (a pre-hue blob, a hand-edited
        // string) keeps the current one — theme.ts would otherwise stamp NaN-derived hexes.
        accentHue:
          typeof accentHue === "number" && Number.isFinite(accentHue) && accentHue >= 0 && accentHue <= 360
            ? accentHue
            : nextSettings.accentHue,
        // Same shape-check as the hue: a period of 0 or 30 s…7 d, a known range, the arc's
        // two hues in [0, 360] if present — else keep the current one (the engine would run garbage).
        accentMotion: isValidAccentMotion(accentMotion)
          ? { period: accentMotion.period, range: accentMotion.range,
              ...(accentMotion.arcFrom !== undefined ? { arcFrom: accentMotion.arcFrom } : {}),
              ...(accentMotion.arcHue !== undefined ? { arcHue: accentMotion.arcHue } : {}) }
          : nextSettings.accentMotion,
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
      // Retired value: an inbound "off" from a pre-migration peer must not survive —
      // migrateInsertTiming won't re-run on a current-version config, so map to the
      // conservative "stop" the migration itself writes.
      if (nextSettings.general.insertTiming === "off") {
        nextSettings = { ...nextSettings, general: { ...nextSettings.general, insertTiming: "stop" } };
      }
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
          transcribe: { ...nextSettings.transcribe, ...dictHist },
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
            gates.audioFolder && (typeof rec.recordingsDir === "string" || rec.recordingsDir === null)
              ? rec.recordingsDir
              : settings.recording.recordingsDir,
          // Same machine-path rule for the audio base folder (one sub-toggle
          // governs both paths).
          audioBaseDir:
            gates.audioFolder && (typeof rec.audioBaseDir === "string" || rec.audioBaseDir === null)
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
      const picks = gates.transcribePicks ? pickFields(raw, TRANSCRIPTION_PICK_SET) : {};
      nextSettings = {
        ...nextSettings,
        // Over nextSettings.transcribe, not settings.transcribe alone: the recording arm
        // above already routed the dictation-history flags in here, and rebuilding from
        // the pre-apply settings discarded them on every ordinary pull (the
        // fileTranscriptions arm below had the right idiom).
        transcribe: {
          ...nextSettings.transcribe,
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
          transcribe: { ...nextSettings.transcribe, ...ft },
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
          // Bounded like the Settings steppers: a peer's 50× chip would cover the screen
          // (Rust clamps chipScale again at the window; dotScale is CSS-only, so this is
          // its only bound on this path).
          chipScale:
            typeof chip.chipScale === "number" && Number.isFinite(chip.chipScale)
              ? Math.min(2, Math.max(0.75, chip.chipScale))
              : settings.recording.chipScale,
          dotScale:
            typeof chip.dotScale === "number" && Number.isFinite(chip.dotScale)
              ? Math.min(3, Math.max(1, chip.dotScale))
              : settings.recording.dotScale,
        },
      };
    }
    // isPlainObject, like every scalar arm: a malformed container (`"backends": []` or a
    // string) is truthy, and `sanitizeBackends(undefined)` then returned `[]` — which the
    // dangling-reference scrub below turned into "every profile's backend is gone".
    if (cats.backends && isPlainObject(blob.backends)) {
      let inboundBackends = sanitizeBackends(blob.backends.list);
      // Element-wise keep-local for the gated backend aspects (the profile
      // chord idiom): addresses and model/decode defaults re-pin to this
      // device's values for backends it already knows; new backends keep the
      // inbound values (there is nothing local to keep).
      if (!gates.serverAddresses)
        inboundBackends = repinElementFields(inboundBackends, st.backends, ["serverUrl"]);
      if (!gates.modelDecodeDefaults)
        inboundBackends = repinElementFields(inboundBackends, st.backends, BACKEND_DEFAULTS_FIELDS, true);
      const reconciled = await reconcileBackendSecrets(
        inboundBackends,
        // API-keys gate off: inbound secrets never touch this device's keyring.
        gates.apiKeys ? blob.backends.secrets : undefined,
        () => gen !== myGen,
      );
      nextBackends = reconciled.backends;
      // A key rotated on another device keeps this device's serverUrl and hasApiKey, so
      // hydrate's own eviction misses it: drop the caps and connection state measured as the
      // OLD caller NOW, while the keyring write is what changed. Waiting for the hydrate lost
      // the eviction on a STALE restart or a dropped apply: the keyring already holds the new
      // key, so every later pass reads prior == incoming and finds nothing rotated.
      for (const id of reconciled.rotated) {
        forgetCaps(id);
        useApp.getState().forgetBackendCaches(id);
      }
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
      // away and written to disk. `backends` too: `nextBackends` is the inbound list re-pinned
      // against the PRE-wait `st.backends` (the wait only re-derives `hasApiKey`), so a backend
      // added, repointed or deleted while the apply was parked was hydrated away the same way.
      const live = useApp.getState();
      // Also check `status`: starting a dictation touches only `status`/`activeProfile`
      // (none of the four slice identities below), so a session started during the
      // reconcileBackendSecrets await slips the guard and `hydrate` replaces profiles,
      // backends and appRules under a session that is actively reading them.
      if (
        live.status !== "idle" ||
        live.settings !== settings ||
        live.backends !== st.backends ||
        live.profiles !== st.profiles ||
        live.appRules !== st.appRules ||
        gen !== myGen
      ) {
        staleRestart = retries > 0 && gen === myGen;
        staleAbort = true;
        throw STALE;
      }
    }
    // One verdict for "profiles arrive in this apply", shared by the arm below and the chord
    // collision pass after it: a truthy NON-object container (a string, an array) skips the arm,
    // so it must not count as inbound there either — or a remote quick-add chord would disable
    // this device's own, unchanged profiles to make room for itself.
    const inboundProfiles = cats.profiles && isPlainObject(blob.profiles) ? blob.profiles : null;
    if (inboundProfiles) {
      nextProfiles = sanitizeProfiles(inboundProfiles.list);
      // "Profile shortcuts" sub-toggle OFF: chords are per-machine — re-pin each profile this
      // device already knows to ITS chord (the recordingsDir precedent, per list element). A
      // profile new to this device keeps the inbound chord: there is no local value, and
      // `sanitizeProfiles` requires a code list, so stripping would drop the profile whole.
      if (!gates.profileHotkeys)
        nextProfiles = repinElementFields(nextProfiles, st.profiles, ["hotkey"]);
      // "Enabled per profile" gate off: which profiles are active is
      // per-machine — re-pin each known profile to ITS local enabled state.
      if (!gates.enabledPerProfile)
        nextProfiles = repinElementFields(nextProfiles, st.profiles, ["enabled"]);
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
          : typeof inboundProfiles.homeProfileId === "string"
            ? inboundProfiles.homeProfileId
            : null,
      };
    }
    if (cats.dictionary && isPlainObject(blob.dictionary)) {
      const d = blob.dictionary as { quickAddHotkey?: unknown; quickAddList?: unknown };
      // The chord: only when this device's sub-toggle opts in, and only a well-formed code
      // list — it lands in the same `canonicalizeCodes` / `conflicts()` consumers as the
      // profile chords, where a numeric entry throws in a component body AND in the debounced
      // save. Absent/malformed/opted-out → keep this device's chord.
      if (gates.quickAddHotkey && isCodeList(d.quickAddHotkey)) {
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
      if (
        gates.pinnedMappings &&
        cats.backends &&
        isPlainObject(blob.backends) &&
        hasOwn(blob.dictionary as Record<string, unknown>, "quickAddList")
      ) {
        nextSettings = { ...nextSettings, quickAddList: safeQuickAddTarget(d.quickAddList) };
      }
    }
    if (cats.appRules && isPlainObject(blob.appRules)) {
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
      inboundProfiles !== null,
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

    // The only store write in this function, and the only stretch the flag covers: `hydrate`
    // is a plain synchronous zustand `set`, so the subscriber sees the flag for exactly that.
    applyingRemote = true;
    try {
      useApp.getState().hydrate({
        settings: nextSettings,
        backends: nextBackends,
        profiles: nextProfiles,
        appRules: nextAppRules,
        // The blob's `general` block was validated field-by-field above (including the
        // retired `insertTiming`), so no schema migration must run on it here.
        version: CONFIG_VERSION,
      });
    } finally {
      applyingRemote = false;
    }
    // Side effects hydrate() doesn't cover: deep-field detection is pushed to
    // Rust imperatively by its Settings toggle, so mirror that here. (Autostart
    // re-syncs via save_config; theme is reactive; hotkeys re-register via the
    // persistence subscriber.)
    // From what was APPLIED, not the raw wire value: a gated-off or absent field is deleted
    // from the blob before this point, and invoking the typed Rust arg with `undefined` was a
    // silently swallowed failure on every unattended pull.
    if (cats.general && isPlainObject(blob.general)) {
      void setDeepFieldDetection(nextSettings.general.deepFieldDetection).catch(() => {});
    }
  } catch (e) {
    if (e !== STALE) throw e;
  }
  // The retry runs OUTSIDE the try so the STALE sentinel of the recursive call is its own
  // (`applyingRemote` wraps only `hydrate`, so nothing is held across the recursion).
  // A session that started during the keyring wait must NOT park the blob via the top-of-function
  // pendingApply branch: only a top-level call may queue — one-shot callers (import, restore,
  // review approval, conflict resolution) pre-check status to avoid that queue, and a "not
  // applied" answer that later lands behind the UI's back is worse than a plain "not applied".
  if (staleRestart) {
    if (useApp.getState().status !== "idle") return false;
    return applyBlob(blob, cats, retries - 1, opts);
  }
  // Retries exhausted: the apply was dropped stale, so report "not applied" —
  // the caller must leave the base alone and let the next pull re-offer it.
  if (staleAbort) return false;
  return true;
}

// ── engine state ─────────────────────────────────────────────────────────────

let started = false;
let applyingRemote = false;
let pendingApply: {
  blob: SyncBlob;
  cats: Record<SyncCategory, boolean>;
  opts: { ignoreGates?: boolean };
} | null = null;
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
  /** The server's `updated_ts` for `remoteVersion` — what an adopt persists as `updatedAt`, so a
   *  restart still restores "Last synced" (initSync skips a null one). */
  remoteUpdatedAt: number | null;
}
let pendingConflict: PendingConflict | null = null;
/** Monotonic identity for the CURRENT pending conflict: the dialog keys its
 *  body on it so a later conflict remounts with fresh picks — a retained
 *  "remote" pick from the previous conflict would otherwise silently hand the
 *  peer a category with no second prompt. A re-raise of the SAME conflict keeps
 *  it (see raiseConflict). */
let conflictSeq = 0;
let pendingConflictId = 0;
/** The Sync tab reads the pending conflict through this (set into the store
 *  would drag blob payloads through every subscriber). */
export function getPendingConflict(): { id: number; categories: SyncCategory[]; remoteDevice: string | null } | null {
  return pendingConflict
    ? { id: pendingConflictId, categories: pendingConflict.categories, remoteDevice: pendingConflict.remoteDevice }
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

/** Would a push right now erase the server's stored API keys? True while the keyring
 *  could not give back the keys the snapshot recorded — the push is refused instead of
 *  sending a keyless list (or omitting the category, which the whole-blob PUT treats as
 *  deletion). Latched for the session like the flag it reads. */
function backendsPushBlocked(): boolean {
  return snapshotSecretsUnavailable;
}

/** Does the composed blob list a backend that has a key on the server without carrying that
 *  key? Pushing it would erase the server's stored key through the whole-blob PUT. */
export function backendsBlobIncomplete(blob: SyncBlob): boolean {
  if (!isPlainObject(blob.backends)) return false;
  const secrets = isPlainObject(blob.backends.secrets) ? blob.backends.secrets : {};
  const list = Array.isArray(blob.backends.list) ? (blob.backends.list as unknown[]) : [];
  return list.some(
    (b) => isPlainObject(b) && b.hasApiKey === true && typeof b.id === "string" && !ownProp(secrets, b.id),
  );
}

/** Did `composeBlob` take its degraded-keyring pass-through (the backends category re-sent from
 *  the snapshot because the live key read came back incomplete)? A merge against such a blob sees
 *  "local unchanged" and keeps the remote list, so applying it would silently revert this
 *  device's own backend edits — callers leave the category out of the apply and adopt the remote
 *  as base only when it left the category alone (`degradedBaseWithheld`). */
function backendsDegraded(composed: SyncBlob, cats: Record<SyncCategory, boolean>): boolean {
  return cats.backends && degradedComposes.has(composed);
}

/** After a degraded-keyring merge applied without the backends category: may the remote become
 *  the new base? Only when the remote left the category exactly as the current base holds it —
 *  then this device's list stays put and the next push re-sends the base's category, so nothing
 *  is lost. A remote that changed backends must not become the base (the next unlocked merge
 *  would read the peer's change as "local unchanged" and drop this device's edits), and holding
 *  it back forever under an "ok" status stalled every push behind a 409 — so say why. */
function degradedBaseWithheld(remoteBlob: SyncBlob): boolean {
  if (catEqual(remoteBlob.backends, state.snapshot?.backends)) return false;
  setRuntime({
    syncStatus: "error",
    syncError: "Your API keys couldn't be read from the keyring, so incoming backend changes are on hold. Unlock it and restart the app to resume syncing.",
  });
  return true;
}

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

/** Compose this device as it is NOW (live store, gates, sub-settings, keyring). Every raiser and
 *  every consent re-judge goes through this one call: a re-judge is only sound if it composes
 *  exactly as the raisers do. */
function composeLive(cats: Record<SyncCategory, boolean>): Promise<SyncBlob> {
  const s = useApp.getState();
  return composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    cats,
    state.snapshot,
    { includeSecrets: true, sub: subSettings(), gates: settingGates() },
  );
}

/** Stands in for the API-key fingerprints in a `storeSignature` whose keyring read came back
 *  failed or partial: nothing can be said about a key rotation then, so an approval that finds it
 *  on either side treats a conflicting backends category as edited and asks. */
const KEYS_UNREAD = "\u0000unread";

/** A change-detection token for one API key (two FNV-1a passes, 64 bits) — what a review keeps
 *  in memory instead of the key itself. NOT crypto: it only tells "same key as at the raise". */
const keyPrint = (key: string): string => hashBlob(["k1", key]) + hashBlob(["k2", key]);

/** What the store holds for every synced setting, with NO gate or sub-toggle substitution. A
 *  review records it right after its held-back apply, so an approval can tell an edit made while
 *  it waited from a gate turned on since: that changes the gated compose (a stripped field now
 *  carries this device's value) without anything in the store changing. The keyring is part of
 *  the store: the store's backends carry only `hasApiKey`, so rotating an existing backend's key
 *  is invisible in the list — `backends.secrets` holds a fingerprint per key read back instead
 *  (never the key; this lives in the PendingReview), or `KEYS_UNREAD` when the read failed or
 *  came back partial. */
async function storeSignature(cats: Record<SyncCategory, boolean>): Promise<SyncBlob> {
  const s = useApp.getState();
  const sig = await composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    cats,
    state.snapshot,
    {
      includeSecrets: false,
      sub: { recordingsDir: true, profileHotkeys: true, quickAddHotkey: true, transcribePicks: true },
      gates: Object.fromEntries(MANIFEST.map((d) => [d.id, true])) as Gates,
    },
  );
  if (cats.backends && isPlainObject(sig.backends)) {
    const keys = await withTimeout(
      readBackendKeys(s.backends.map((b) => b.id)).catch(() => null),
      10_000,
      null as Record<string, string> | null,
    );
    // Same completeness rule as composeBlob: `read_backend_keys` drops what it cannot read.
    const complete =
      isPlainObject(keys) && s.backends.every((b) => !b.hasApiKey || ownProp(keys, b.id) !== undefined);
    const prints: Record<string, string> = {};
    if (complete) {
      for (const [id, key] of Object.entries(keys)) prints[id] = keyPrint(String(key));
    } else {
      prints[KEYS_UNREAD] = "1";
    }
    sig.backends = { ...sig.backends, secrets: prints };
  }
  return sig;
}

/** Did this `storeSignature` fail to read the keyring (see `KEYS_UNREAD`)? */
function keysUnread(sig: SyncBlob): boolean {
  const secrets = sig.backends?.secrets;
  return isPlainObject(secrets) && ownProp(secrets, KEYS_UNREAD) !== undefined;
}

/** Which category a legacy sub-toggle key (one that is not a manifest id) feeds. */
const LEGACY_SUB_CATEGORY: Partial<Record<string, SyncCategory>> = { recordingsDir: "recording" };

/** The gates + sub-toggles composeLive / applyBlob read, split per category: what the held-back
 *  apply stripped from a category depends only on its own switches, so a gate flipped for an
 *  unrelated category must not turn an ordinary edit into a conflict. A key this cannot place
 *  goes into every category (an unclear change asks rather than keeps). */
function gatesSignature(): Record<SyncCategory, string> {
  const catOfId = new Map<string, SyncCategory>(MANIFEST.map((d) => [d.id, d.category]));
  const place = (key: string): SyncCategory | undefined => catOfId.get(key) ?? LEGACY_SUB_CATEGORY[key];
  const per = (src: Record<string, unknown>, cat: SyncCategory) =>
    Object.fromEntries(Object.entries(src).filter(([k]) => (place(k) ?? cat) === cat));
  const gates = settingGates() as Record<string, unknown>;
  const sub = subSettings() as unknown as Record<string, unknown>;
  return Object.fromEntries(
    ALL_CATEGORIES.map((cat) => [cat, stableStringify({ gates: per(gates, cat), sub: per(sub, cat) })]),
  ) as Record<SyncCategory, string>;
}

/** Take the engine's `inFlight` lock for a user-driven apply (review approval, conflict
 *  resolution), WAITING for a running pull/push instead of dropping the click. Those applies
 *  park in the keyring for seconds; a focus pull racing them re-raised the review/conflict over
 *  an approval that had already landed. False when a supersede happened while waiting. */
async function takeSyncLock(myGen: number): Promise<boolean> {
  while (inFlight) {
    await new Promise((r) => setTimeout(r, 50));
    if (myGen !== gen) return false;
  }
  if (myGen !== gen) return false;
  inFlight = true;
  return true;
}

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
    // Superseded while in the keyring: neither read the server nor stamp "ok" over the new epoch.
    if (myGen !== gen) return;
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
      // Nothing stored server-side: first-ever contact, or the server copy was deleted (a
      // peer's "Delete server copy", or a wipe) — seed it.
      if ((state.version ?? 0) > 0 || state.snapshot !== undefined) {
        if (!(await forgetDeadDocument(myGen))) return;
      } else {
        // No base to forget, but any review / conflict / parked apply still describes a server
        // document that no longer exists.
        pendingReview = null;
        pendingConflict = null;
        pendingApply = null;
      }
      setRuntime({ syncStatus: "ok" });
      schedulePush(0);
      return;
    }
    if (!isPlainObject(remote.blob)) {
      handleTransportFailure(0, "The server sent settings this app cannot read.");
      return;
    }
    // Before the "nothing new" check too: a re-created document can climb back to this base's
    // version number while a prompt from the deleted one still waits above it. The base is then
    // version 0, so this falls through to a first-contact reconcile against the new document.
    if (serverRecreated(remote.version) && !(await forgetDeadDocument(myGen))) return;
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
    // Superseded (sync turned off, server copy deleted) while an await parked: no status write
    // below may land over the reset state. inFlight was already reset by supersede().
    if (myGen !== gen) return;
    const cats = syncCats();
    let blob = await composeLive(cats);
    // The keyring read in composeBlob can park up to 10 s — superseded meanwhile (sync turned
    // off, server copy deleted): never send. inFlight was already reset by supersede().
    if (myGen !== gen) return;
    let base = state.version ?? 0;
    if (!manual && hashBlob(blob) === state.hash && base > 0) {
      setRuntime({ syncStatus: "ok" });
      return;
    }
    // Gated on the COMPOSED blob, not on the Backends switch: the snapshot pass-through
    // (switch OFF, or the live read degraded) is exactly the arm that carries a list with
    // `hasApiKey` entries and no secrets, while a switch-ON push whose live keyring read was
    // complete is safe even with the latch set (the stash write alone may have failed).
    if (backendsPushBlocked() && backendsBlobIncomplete(blob)) {
      // Refuse rather than degrade: every alternative (a keyless list, an omitted category)
      // erases the server's stored keys through the whole-blob PUT. Said out loud so the
      // user knows why nothing is leaving this device.
      setRuntime({
        syncStatus: "error",
        syncError: "Your API keys couldn't be read from the keyring, so settings weren't pushed. Unlock it and restart the app to resume syncing.",
      });
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // Re-asked per ATTEMPT, not once before the loop: a conflict retry re-sends the merged blob,
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
          updatedAt: res.state.updated_ts ?? null,
          device: device?.hostname ?? null,
          hash: hashBlob(blob),
          snapshot: blob,
        });
        if (myGen !== gen) return; // superseded during the keyring stash wait
        dropSupersededPending(res.state.version);
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
        if (remote.blob !== null && !isPlainObject(remote.blob)) {
          handleTransportFailure(res.status, "The server sent settings this app cannot read.");
          return;
        }
        if (remote.blob === null) {
          // The server copy was deleted under our base (a peer's "Delete server copy", or a
          // wipe): the 409 body is the zero-state. Merging `{}` against the stale snapshot drops
          // every unchanged category and conflicts the changed ones — re-seed from version 0
          // instead, as pullNow's null-blob arm does, and let the follow-up push send it all.
          if (!(await forgetDeadDocument(myGen))) return;
          setRuntime({ syncStatus: "ok" });
          schedulePush(0);
          return;
        }
        // Same as pullNow: a re-created document drops the dead base, so the merge below is a
        // first-contact one (no snapshot) instead of a 3-way merge against the deleted document.
        if (serverRecreated(remote.version)) {
          if (!(await forgetDeadDocument(myGen))) return;
          // Recompose: the blob above filled its pass-through slots (categories and fields this
          // device does not sync, the other-OS rules, a degraded backends list WITH its keys)
          // from the dead snapshot, and a first-contact merge would count them as local edits
          // and push the deleted document's values back. pullNow's reconcile composes after the
          // forget the same way. No keyring-refusal re-check: the forget cleared the stash latch
          // with the snapshot it guarded, and with no snapshot there is nothing to pass through —
          // a locked keyring now composes the live list without keys, which the first-contact
          // merge either conflicts against a re-seed that carries keys (the user decides) or
          // sends where the server holds no list (nothing to erase), as on a first sync.
          blob = await composeLive(syncCats());
          if (myGen !== gen) return;
        }
        // Normalize a pre-split peer's blob before merging — the 3-way base and the local
        // compose are already in the current shape.
        const remoteBlob = migrateBlob((remote.blob ?? {}) as SyncBlob);
        const { merged, conflicts } = mergeBlobs(state.snapshot, blob, remoteBlob);
        if (conflicts.length > 0) {
          raiseConflict({ categories: conflicts, merged, local: blob, remote: remoteBlob,
            remoteVersion: remote.version, remoteDevice: remote.device ?? null,
            remoteUpdatedAt: remote.updated_ts ?? null });
          return;
        }
        // Auto-merged: adopt the merge locally, then retry on the new base. Honour the user's
        // opt-outs like the other two applyBlob callers. A degraded-keyring compose leaves the
        // backends category out of the apply, as reconcileRemote does.
        const syncedCats = syncCats();
        const degraded = backendsDegraded(blob, syncedCats);
        const pushCats = degraded ? { ...syncedCats, backends: false } : syncedCats;
        // A 409 merge adopts remote values too, so it gets the same consent gate as a pull.
        const riskyPush = gatedSecurityCheck(merged, blob, pushCats);
        if (riskyPush.length > 0) {
          const applyNow = heldBack(pushCats, riskyPush);
          await applyBlob(merged, applyNow);
          if (myGen !== gen) return; // superseded during the apply wait
          // The gates the apply ran under, then the keyring read — which parks up to 10 s, so the
          // epoch is checked AGAIN after it: a supersede meanwhile dropped every pending prompt on
          // purpose, and raising this one would revive the old server's review in the new state.
          const gatesSig = gatesSignature();
          const storeSig = await storeSignature(pushCats);
          if (myGen !== gen) return;
          raiseReview({
            changes: riskyPush, blob: merged, cats: pushCats, remote: remoteBlob,
            applied: appliedAt(pushCats, applyNow),
            storeSig, gatesSig,
            version: remote.version, updatedAt: remote.updated_ts ?? null, device: remote.device ?? null,
            pushAfter: true, degraded,
          });
          return;
        }
        const applied = await applyBlob(merged, pushCats);
        if (myGen !== gen) return; // superseded during the apply wait
        if (!applied) {
          // Deferred/dropped: no base adopted and nothing pushed, the next pull re-offers it.
          // Clear the 'syncing' this call set, as reconcileRemote's twin does.
          setRuntime({ syncStatus: "ok" });
          return;
        }
        // Applied without the degraded backends category: adopt the base and keep pushing only
        // when the remote left that category alone (see `degradedBaseWithheld`).
        if (degraded && degradedBaseWithheld(remoteBlob)) return;
        // The merge carries the base's backends category, not this device's list: a second 409
        // must still keep it out of the apply.
        if (degraded) degradedComposes.add(merged);
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
  const cats = syncCats();
  const local = await composeLive(cats);
  if (myGen !== gen) return; // superseded — don't apply the old server's blob
  // Normalize a pre-split peer's blob before merging (the base and local are current-shape).
  const remoteBlob = migrateBlob((remote.blob ?? {}) as SyncBlob);
  const { merged, conflicts } = mergeBlobs(state.snapshot, local, remoteBlob);
  if (conflicts.length > 0) {
    raiseConflict({ categories: conflicts, merged, local, remote: remoteBlob,
      remoteVersion: remote.version, remoteDevice: remote.device ?? null,
      remoteUpdatedAt: remote.updated_ts ?? null });
    return;
  }
  // Degraded keyring (see `backendsDegraded`): `local.backends` is the snapshot's own category,
  // not this device's list, so the merge "keeps" the remote list and applying it would silently
  // revert every backend added or edited here. Leave the backends category out of the apply.
  const degraded = backendsDegraded(local, cats);
  const applyCats = degraded ? { ...cats, backends: false } : cats;
  // This pull is unattended (startup + every window focus). If it would repoint a backend or
  // swap a stored key, hold it for confirmation instead of adopting it silently.
  const risky = gatedSecurityCheck(merged, local, applyCats);
  if (risky.length > 0) {
    // Everything else still applies — only the backends category waits. Deliberately no
    // persistState here: adopting the server's version as the new base would drop the held-back
    // change, so the next pull re-offers it until the user decides.
    const applyNow = heldBack(applyCats, risky);
    await applyBlob(merged, applyNow);
    if (myGen !== gen) return; // superseded during the apply wait — the review is for a dead epoch
    // Same re-check after the keyring read as pushNow's 409 twin.
    const gatesSig = gatesSignature();
    const storeSig = await storeSignature(applyCats);
    if (myGen !== gen) return;
    raiseReview({
      changes: risky, blob: merged, cats: applyCats, remote: remoteBlob,
      applied: appliedAt(applyCats, applyNow),
      storeSig, gatesSig,
      version: remote.version, updatedAt: remote.updated_ts ?? null,
      device: remote.device ?? null, pushAfter: true, degraded,
    });
    return;
  }
  const applied = await applyBlob(merged, applyCats);
  // Epoch FIRST: applyBlob answers false exactly when a supersede bumped `gen` during its keyring
  // wait, and the "ok" below would then land over the reset state (pushNow's 409 twin's order).
  if (myGen !== gen) return;
  if (!applied) {
    // Deferred (dictation live). Persist no base so the next pull re-offers the blob — the same
    // rule the held-back-review path documents above.
    setRuntime({ syncStatus: "ok" });
    return;
  }
  // Applied without the degraded backends category: the remote becomes the base only when it
  // left that category alone; otherwise no base, and the status says why (`degradedBaseWithheld`).
  if (degraded && degradedBaseWithheld(remoteBlob)) return;
  // Persist what the SERVER holds (remote), not the merge result: snapshot is
  // the 3-way base for the NEXT sync and hash is the did-anything-change gate
  // for pushes. Recording `merged` here would make the follow-up push compose
  // an identical hash and silently skip — stranding the local contribution
  // client-side forever. (For toggled-OFF categories merged == remote by
  // construction, so compose-from-snapshot preservation is unaffected.)
  await persistState({
    version: remote.version,
    updatedAt: remote.updated_ts ?? null,
    device: remote.device ?? null,
    hash: hashBlob(remoteBlob),
    snapshot: remoteBlob,
  });
  // persistState can park in the keyring stash; a reset/sync-off in that window must not get
  // this epoch's "ok" written over it.
  if (myGen !== gen) return;
  dropSupersededPending(remote.version);
  setRuntime({
    syncStatus: "ok",
    lastSyncedAt: Date.now(),
    lastSyncDevice: remote.device ?? null,
  });
  // Local had changes the server lacked → the merged doc differs from the
  // server's; push it up (base = the version we just adopted).
  if (hashBlob(merged) !== hashBlob(remoteBlob)) schedulePush(0);
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
    | "save-recordings"
    | "history-retention"
    | "dictation-retention"
    | "dictation-history"
    | "report-target-app"
    | "typed-text";
  /** The backend a `backends`-category change applies to; the recording kinds have no backend and
   *  set this to an empty string (the dialog omits it). A `typed-text` change names the backend
   *  or profile whose decode defaults carry the text. */
  backend: string;
  /** `typed-text` only: the category that holds it — a profile's overrides or a backend's
   *  defaults — so exactly that category waits for the approval. */
  category?: "profiles" | "backends";
  detail: string;
  /** The address that would take effect, unformatted, for the kinds that carry one. The dialog
   *  parses this rather than trusting `detail`: a URL's real authority is whatever follows the
   *  last "@", so `http://localhost:8000@evil.tld/v1` reads as a loopback address in prose while
   *  connecting to `evil.tld`. The consent surface has to show the host it will actually reach. */
  url?: string;
}

/** Which category each held-back change lives in, so the apply can suppress exactly that one and
 *  let everything else through. */
function catOf({ kind, category }: SecurityChange): SyncCategory {
  if (kind === "typed-text") return category ?? "profiles";
  if (
    kind === "save-recordings" ||
    kind === "dictation-retention" ||
    kind === "dictation-history" ||
    kind === "report-target-app"
  ) {
    return "recording";
  }
  if (kind === "history-retention") return "fileTranscriptions";
  return "backends";
}

/** What a raise's held-back apply (`applyNow`, under `applyCats`) actually landed, for
 *  `PendingReview.applied`. The dictionary's pin applies only together with the backends list
 *  (applyBlob's `cats.backends` check), so holding backends back also withholds the peer's pin:
 *  the dictionary then did NOT fully land, and an edit to it while the review waits must ask. */
function appliedAt(
  applyCats: Record<SyncCategory, boolean>,
  applyNow: Record<SyncCategory, boolean>,
): Record<SyncCategory, boolean> {
  return { ...applyNow, dictionary: applyNow.dictionary && (applyNow.backends || !applyCats.backends) };
}

/** `cats` with every category that has a held-back change switched OFF. */
function heldBack(
  cats: Record<SyncCategory, boolean>,
  risky: SecurityChange[],
): Record<SyncCategory, boolean> {
  const out = { ...cats };
  for (const c of risky) out[catOf(c)] = false;
  return out;
}

/** Compare what a pull would apply against what this device holds, and report only the
 *  security-relevant differences. `local` is the freshly composed local blob, so its
 *  `backends.secrets` already reflects the keyring — no extra wallet read here. */
/** The local side for `securityChanges`, with a truthful `backends` container: composeBlob
 *  deliberately omits the category when the keyring read degraded, and a MISSING container
 *  read as "this device has no backends" — so every server backend, including ones this
 *  device already holds byte-identically, was reported as "new" and parked sync on a
 *  review. `secrets: {}` keeps the api-key comparison fail-closed (an incoming key still
 *  raises a review); only the bogus new-backend rows go. */
function localForReview(local: SyncBlob): SyncBlob {
  if (local.backends) return local;
  return { ...local, backends: { list: useApp.getState().backends, secrets: {} } };
}

/**
 * `securityChanges` over an incoming blob and the local one, both gated by the SAME
 * `settingGates()` snapshot — the three consent sites (409 merge, unattended pull, conflict
 * resolution) must never diverge in how they gate the two sides.
 */
function gatedSecurityCheck(
  incoming: SyncBlob,
  localBlob: SyncBlob,
  cats: Record<SyncCategory, boolean>,
): SecurityChange[] {
  const g = settingGates();
  return securityChanges(gateScalars(incoming, g), gateScalars(localForReview(localBlob), g), cats, g);
}

/**
 * The decode keys whose text the app TYPES into the focused window (the live hard-break
 * separator, the output prefix/suffix) — the same class as the `autoEnter` refusal: a peer that
 * can set them can make every dictation type text of its choosing, a newline included. Only a
 * change to a non-empty value is held (clearing one types less, not more), compared after the
 * sanitizer, so a value it would drop or cap raises nothing it would not apply.
 */
function typedTextChanges(
  incomingList: unknown,
  localList: readonly (Profile | Backend)[] | undefined,
  category: "profiles" | "backends",
): SecurityChange[] {
  if (!Array.isArray(incomingList)) return [];
  const here = new Map((localList ?? []).map((e) => [e.id, e]));
  const out: SecurityChange[] = [];
  for (const e of incomingList) {
    if (!isPlainObject(e) || typeof e.id !== "string") continue;
    const next = clampDecodeOverrides(e.decodeOverrides) ?? {};
    const cur = here.get(e.id)?.decodeOverrides ?? {};
    const name = typeof e.name === "string" && e.name ? e.name : e.id;
    for (const key of TYPED_TEXT_KEYS) {
      const v = next[key];
      if (typeof v !== "string" || v === "" || v === cur[key]) continue;
      out.push({
        kind: "typed-text",
        backend: name,
        category,
        detail: `${DECODE_KEYS[key].env} would type ${JSON.stringify(v)}`,
      });
    }
  }
  return out;
}

export function securityChanges(
  incoming: SyncBlob,
  local: SyncBlob,
  cats: Record<SyncCategory, boolean>,
  gates?: Partial<Pick<Gates, "modelDecodeDefaults" | "serverAddresses" | "apiKeys">>,
): SecurityChange[] {
  const out: SecurityChange[] = [];
  // The three retention clocks drive sweeps that DELETE stored data (saved
  // recordings; dictation sessions incl. audio; file transcripts incl. their
  // audio copies). Only a change that starts deleting, or deletes sooner, needs
  // consent — lengthening the window (or turning retention off) destroys
  // nothing. The recording and dictation clocks ride the `recording` category and
  // are judged as the ONE effective dictation clock both sweeps use (below); the
  // file clock rides its own category. Typed reads: the merged blob reaches here
  // before applyBlob's typedLike pass, so a string `"3"` would otherwise raise
  // a review (and park the whole category) for a change that never applies.
  //
  // `norm` mirrors what the apply does to an incoming value: the u32 key drops anything that
  // is not a whole non-negative number (typedLike's U32_KEYS), the two transcription-settings
  // keys round and clamp to 0..3650 (sanitizeTranscription). Judging the raw value raised a
  // consent review for a deletion window (-1, 0.3, 2.5) that could never be applied. `undefined`
  // from `norm` is "dropped": the apply keeps the local days, so it reads as no change.
  const days = (
    container: unknown,
    key: string,
    fallback: number,
    norm?: (v: number) => number | undefined,
  ): number => {
    // An ABSENT key is "no change" on the apply side (the arms merge over current), so it must
    // not be read as the app default — a peer with this row's sync switch off omits it, and the
    // default raised a consent dialog for a deletion that can't happen. A non-numeric value
    // (null, a string) is dropped by the apply side too, which keeps the local days.
    const v = isPlainObject(container) ? ownProp(container, key) : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return norm ? (norm(v) ?? fallback) : v;
  };
  const asU32 = (v: number) => (Number.isInteger(v) && v >= 0 && v <= 0xff_ff_ff_ff ? v : undefined);
  const clamp3650 = (v: number) => Math.max(0, Math.min(3650, Math.round(v)));
  // Only a change that starts deleting, or deletes sooner, needs consent.
  const pushIfSooner = (hereDays: number, nextDays: number, what: string, kind: SecurityChange["kind"]) => {
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
  // The `recording` category looks like styling but carries two settings with real consequences:
  // the retention window drives a sweep that DELETES saved recordings and their transcripts, and
  // `saveRecordings` turns on a permanent plaintext archive of everything dictated. Both applied
  // silently on an unattended pull. They get the same confirmation as a repointed server.
  if (cats.recording && incoming.recording) {
    if (incoming.recording.saveRecordings === true && local.recording?.saveRecordings !== true) {
      out.push({
        kind: "save-recordings",
        backend: "",
        detail: "every dictation would be saved to this device as audio and text",
      });
    }
    // Strictly more destructive than the retention clock beside it: Rust's retention sweep
    // wipes EVERY dictation record the moment this reads false, on the next config save.
    // Incoming `false` wins silently (a peer's opt-OUT tightens privacy and applies at once);
    // an incoming `true` would start sending the app id of every dictation to the server
    // from this device, so it is held for review like `saveRecordings`.
    if (incoming.recording.reportTargetApp === true && local.recording?.reportTargetApp === false) {
      out.push({
        kind: "report-target-app",
        backend: "",
        detail: "the name of the app you dictate into would be reported to the server with every dictation",
      });
    }
    if (
      incoming.recording.keepDictationHistory === false &&
      local.recording?.keepDictationHistory !== false
    ) {
      out.push({
        kind: "dictation-history",
        backend: "",
        detail: "the whole dictation history on this device would be deleted, and no new dictations kept",
      });
    }
  }
  // The audio window (recordingsRetentionDays, default 0) and the record window
  // (dictationRetentionDays, default 7) are ONE clock: both sweeps delete by the stricter
  // non-zero of the two (Rust's `effective_dictation_days`, Settings' `dictDays`). Judging
  // each key alone asked consent for "saved recordings ... currently kept forever" when the
  // effective window only lengthened (audio 0 + record 7 → 30/30). So compare that one value.
  // An absent or non-numeric incoming key is "no change" (the apply keeps the local value),
  // so it reads as the local value here.
  if (cats.recording && isPlainObject(incoming.recording)) {
    const effDays = (a: number, r: number) => (a === 0 ? r : r === 0 ? a : Math.min(a, r));
    const localA = days(local.recording, "recordingsRetentionDays", 0);
    const localR = days(local.recording, "dictationRetentionDays", 7);
    pushIfSooner(
      effDays(localA, localR),
      effDays(
        days(incoming.recording, "recordingsRetentionDays", localA, asU32),
        days(incoming.recording, "dictationRetentionDays", localR, clamp3650),
      ),
      "dictations (text and audio)",
      "dictation-retention",
    );
  }
  if (cats.fileTranscriptions && isPlainObject(incoming.fileTranscriptions)) {
    const here = days(local.fileTranscriptions, "historyRetentionDays", 0);
    pushIfSooner(
      here,
      days(incoming.fileTranscriptions, "historyRetentionDays", here, clamp3650),
      "file transcriptions",
      "history-retention",
    );
  }
  if (cats.profiles && incoming.profiles) {
    out.push(...typedTextChanges(incoming.profiles.list, local.profiles?.list, "profiles"));
  }
  // Backend decode defaults travel only under the "Model & decode defaults" switch; with it off
  // the apply re-pins this device's values, so a peer's text could never land.
  if (cats.backends && incoming.backends && gates?.modelDecodeDefaults !== false) {
    out.push(...typedTextChanges(incoming.backends.list, local.backends?.list, "backends"));
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
    // A backend new to this device keeps its inbound address even with "Server addresses" off
    // (there is nothing local to re-pin), so `new-backend` is raised regardless of the gates.
    // A KNOWN backend's address change, or an incoming key with "API keys" off, can never land —
    // applyBlob re-pins serverUrl / drops inbound secrets — so raising them made approval a no-op
    // and a rejection re-raise on every pull.
    if (!cur) {
      out.push({ kind: "new-backend", backend: name, detail: b.serverUrl, url: b.serverUrl });
    } else if (
      gates?.serverAddresses !== false &&
      normalizeUrl(cur.serverUrl) !== normalizeUrl(b.serverUrl)
    ) {
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
    if (gates?.apiKeys !== false && incomingKey && cur && incomingKey !== localKey) {
      out.push({
        kind: "api-key",
        backend: cur.name || name,
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
  /** `storeSignature` right after the raise's held-back apply: an approval takes a category as
   *  edited while the review waited only when the store's value moved off this one. Not a gated
   *  compose — a gate turned on since changes that with no edit (a stripped field now carries
   *  this device's value), and a push's retry raise has no compose of this device at all. */
  storeSig: SyncBlob;
  /** `gatesSignature` at the raise: what the held-back apply stripped depends on it. A relist
   *  keeps it — no apply ran since, so the store still lacks what the raise's gates stripped. */
  gatesSig: Record<SyncCategory, string>;
  /** The categories the raise's apply landed (`appliedAt` over `heldBack(cats, changes)` THEN). Kept across a
   *  relist: recomputing it from the relisted rows would count a category that was held back at
   *  the raise, and whose rows no longer show, as applied — and keep a live edit over a peer
   *  value the store never received. */
  applied: Record<SyncCategory, boolean>;
  version: number;
  updatedAt: number | null;
  device: string | null;
  pushAfter: boolean;
  /** Raised over a degraded-keyring compose (`backendsDegraded`): `cats` already holds backends
   *  out, and the approval may adopt the remote as base only under `degradedBaseWithheld`. */
  degraded?: boolean;
  /** Re-raised by an approval that found rows the first list did not show (the gates, this
   *  device's own settings or its keyring changed since): the dialog says so, or a second
   *  click consents to rows nobody read. */
  relisted?: boolean;
}
let pendingReview: PendingReview | null = null;

/** The Sync tab reads the held-back pull through this (the blobs stay out of the store). */
export function getPendingReview(): {
  changes: SecurityChange[];
  device: string | null;
  relisted: boolean;
} | null {
  return pendingReview
    ? { changes: pendingReview.changes, device: pendingReview.device, relisted: pendingReview.relisted === true }
    : null;
}

function raiseReview(r: PendingReview): void {
  // A review adopts no base, so every push / focus pull re-raises it: keep the "the list changed
  // since you read it" notice while it is still the same list, or the next re-raise (a debounced
  // push 409s right back into the review) wiped it seconds after it appeared.
  if (pendingReview?.relisted && !r.relisted && sameReview(pendingReview, r)) r = { ...r, relisted: true };
  pendingReview = r;
  // A conflict against an older server version is moot now: the server moved past it.
  if (pendingConflict && pendingConflict.remoteVersion < r.version) pendingConflict = null;
  setRuntime({
    syncStatus: "error",
    syncError:
      "A pulled update wants to change where your dictation is sent, what it types, or what is kept on this device — review it in Settings → Sync.",
  });
}

/** A base at `version` was just adopted (a clean pull, or a push the server accepted): a review
 *  or conflict raised against that version or an older one describes a server state that is
 *  gone — another device took the change back, or this one now agrees. Left up, the dialog sat
 *  next to "Synced" and its Apply re-landed the withdrawn change and moved the base backwards. */
function dropSupersededPending(version: number): void {
  if (pendingReview && pendingReview.version <= version) pendingReview = null;
  if (pendingConflict && pendingConflict.remoteVersion <= version) pendingConflict = null;
}

/** The server's document at `version` is not the one this device's base or pending prompts were
 *  built on: server versions only grow, so a version BELOW the base or below a pending prompt's
 *  means the document was deleted and re-created — a peer's "Delete server copy" followed by its
 *  re-seed, seen by a device that missed the empty window. */
function serverRecreated(version: number): boolean {
  return (
    version < (state.version ?? 0) ||
    (pendingReview !== null && pendingReview.version > version) ||
    (pendingConflict !== null && pendingConflict.remoteVersion > version)
  );
}

/** Forget a base (and every prompt) that describes a server document which no longer exists, and
 *  re-seed from version 0, as resetSyncState does for the deleting device. A kept base made the
 *  next push skip on the hash match or carry a stale baseVersion — at a re-created document's
 *  matching number it overwrote the peer's re-seed blind — and a 3-way merge against the dead
 *  snapshot dropped or conflicted the wrong categories; a kept prompt was never dropped
 *  (numbering restarts at 1) and approving it re-landed the deleted doc's change. False when
 *  superseded during the keyring or state writes. */
async function forgetDeadDocument(myGen: number): Promise<boolean> {
  await clearSnapshotSecrets();
  if (myGen !== gen) return false;
  await persistState({ version: 0, updatedAt: null, device: null, hash: undefined, snapshot: undefined });
  if (myGen !== gen) return false;
  pendingReview = null;
  pendingConflict = null;
  pendingApply = null;
  setRuntime({ lastSyncedAt: null, lastSyncDevice: null });
  return true;
}

/** A change's identity for "was this row on the list the user saw". */
function changeKey(c: SecurityChange): string {
  return JSON.stringify([c.kind, c.category ?? null, c.backend, c.detail, c.url ?? null]);
}

/** The same review re-raised: same server version and writer, same rows on the list. */
function sameReview(a: PendingReview, b: PendingReview): boolean {
  if (a === b) return true;
  if (a.version !== b.version || a.device !== b.device) return false;
  const ka = new Set(a.changes.map(changeKey));
  const kb = new Set(b.changes.map(changeKey));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
}

/** Approve the held-back pull: apply it and adopt the server's version as the new base. */
export async function approvePendingReview(): Promise<void> {
  const r = pendingReview;
  if (!r) return;
  // Never QUEUE a consented apply behind a live dictation: applyBlob would park the blob in
  // `pendingApply` and the store subscriber would land it the moment the session ends — even
  // after the user changed their mind and pressed Reject. Leave the review up instead; the
  // dialog says why.
  if (useApp.getState().status !== "idle") return;
  // The epoch this approval belongs to: a supersede during the compose below or the apply's
  // keyring wait (sync off, server switched, server copy deleted) dropped this review on
  // purpose — never revive it, and never adopt the old server's version into the new state.
  const myGen = gen;
  // Hold the engine lock across the compose + apply: a focus pull landing in the keyring waits
  // would re-raise this review over the approval (or stamp "ok" while it is still pending).
  if (!(await takeSyncLock(myGen))) return;
  let outcome: ApproveOutcome = "done";
  try {
    // The wait may have let a pull replace or clear the review, or a dictation start. A review
    // adopts no base, so the pull it waited for re-raises it as a NEW object: judge it by
    // content (as resolveSyncConflicts does by id) and go on with the current one when it is
    // the review the user saw; a different one aborts.
    const cur = pendingReview;
    if (cur && sameReview(cur, r) && useApp.getState().status === "idle") {
      outcome = await approveLocked(cur, myGen);
    }
  } finally {
    if (myGen === gen) inFlight = false;
  }
  if (myGen !== gen) return;
  // After the release: the push takes the lock itself. Every other arm still re-arms the
  // debounced push: a store edit made just before the click fired its pushNow into this lock
  // and was dropped, and nothing else re-sends it (the hash check makes it a no-op otherwise).
  // Not when the approval put a new prompt up instead: a push then only 409s back into it (the
  // edit goes out with the answer), re-running the held-back apply for nothing.
  if (outcome === "push") schedulePush(0);
  else if (outcome === "done") schedulePush();
}

/** What approveLocked left behind: "push" — applied, and the merged doc differs from the
 *  server's; "done" — nothing more to do; "prompt" — a relisted review or a conflict is up. */
type ApproveOutcome = "push" | "done" | "prompt";

/** approvePendingReview's body, run under the engine lock. */
async function approveLocked(r: PendingReview, myGen: number): Promise<ApproveOutcome> {
  // A base at or past the reviewed version was adopted meanwhile: the review is moot.
  if ((state.version ?? 0) >= r.version) {
    pendingReview = null;
    setRuntime({ syncStatus: "ok", syncError: null });
    return "done";
  }
  // applyBlob reads the gates LIVE, but the list was judged under the gates at raise time: with
  // "Server addresses" / "API keys" off then, a repoint or key swap was left off the list (the
  // apply would strip it). Turning the gate on since does not supersede the review, so approving
  // as shown would land a change the user never saw. Re-judge under today's gates and, if
  // anything new appears, show the new list instead of applying. The raise-time compose is no
  // use for that: it ran under the raise-time gates, which substitute a gated-off address / key
  // with the snapshot's — the peer's own value, so the repoint compares equal. Compose this
  // device afresh.
  // The store signature is read BEFORE the compose it is paired with (a relist keeps it as the
  // new `storeSig` next to a blob built from this compose): an edit landing during the compose's
  // keyring wait is then in `localNow` and missing from `sigNow`, so the next approval still sees
  // it as an edit. Read after, it was in the signature but not the relisted blob — "not edited"
  // next time, and the reviewed value went back over it. Both snapshot the store when called, so
  // an edit landing during the signature's own keyring wait is in `localNow` only: `movedMid`
  // then counts every conflicting category as edited (keep the live value, or ask), never as the
  // reviewed value going back over it.
  const st0 = useApp.getState();
  const sigNow = await storeSignature(r.cats);
  if (myGen !== gen || pendingReview !== r || useApp.getState().status !== "idle") return "done";
  const st1 = useApp.getState();
  const movedMid =
    st0.settings !== st1.settings ||
    st0.backends !== st1.backends ||
    st0.profiles !== st1.profiles ||
    st0.appRules !== st1.appRules;
  let localNow = await composeLive(r.cats);
  if (myGen !== gen || pendingReview !== r || useApp.getState().status !== "idle") return "done";
  // `r.blob` was merged against the raise-time local: an edit made here since would be hydrated
  // back to its old value. Re-merge against the live compose (no base was adopted, so a category
  // the peer changed still differs from the base). Where that conflicts, "edited" means the
  // store moved off what the raise left in it (`r.storeSig`) — not "the live compose differs",
  // which a gate turned on since also makes true:
  //  - not edited: the reviewed value (the peer's change being consented to, a resolve's pick,
  //    or a field the raise stripped under a gate that is on now) — the security re-check below
  //    then judges it under today's gates and relists what the raise could not show.
  //  - edited (an API key rotated counts: the signature carries key fingerprints), in a category
  //    the raise already APPLIED, under that category's raise-time gates: `r.blob`'s value
  //    landed then, so the live value is it plus the user's edits on top — keep the live value
  //    (re.merged's conflict placeholder). Putting `r.blob` back reverted the edit, and the
  //    adopted base + follow-up push shipped the revert.
  //  - edited otherwise (a held-back category, that category's gates changed so the live value
  //    also carries fields the raise stripped, or the keyring could not be read at either end so
  //    a key rotation cannot be ruled out): neither side can win silently — the approval would
  //    discard the edit, keeping it would push this device's values over the peer's change.
  //    Ask, as a conflict at the review's version (its resolve re-runs the security check, so
  //    nothing lands unreviewed).
  const re = mergeBlobs(state.snapshot, localNow, r.remote);
  const appliedAtRaise = r.applied;
  const gatesNow = gatesSignature();
  const blobNow: SyncBlob = { ...re.merged };
  let ask = false;
  for (const cat of re.conflicts) {
    // A keyring read that failed at either end cannot rule out a key rotation: unclear = ask.
    const keysUnknown = cat === "backends" && (keysUnread(sigNow) || keysUnread(r.storeSig));
    if (keysUnknown || movedMid || !catEqual(sigNow[cat], r.storeSig[cat])) {
      if (keysUnknown || !(appliedAtRaise[cat] && gatesNow[cat] === r.gatesSig[cat])) ask = true;
      continue;
    }
    const v = r.blob[cat];
    if (v === undefined) delete blobNow[cat];
    else (blobNow as Record<string, unknown>)[cat] = v;
  }
  if (ask) {
    pendingReview = null;
    raiseConflict({
      categories: re.conflicts,
      merged: re.merged,
      local: localNow,
      remote: r.remote,
      remoteVersion: r.version,
      remoteDevice: r.device,
      remoteUpdatedAt: r.updatedAt,
    });
    return "prompt";
  }
  // A degraded keyring re-sends the snapshot's backends category (the peer's view, again): judge
  // against the live list with no keys instead, so every incoming address / key still raises.
  if (backendsDegraded(localNow, r.cats)) {
    localNow = { ...localNow, backends: { list: useApp.getState().backends, secrets: {} } };
  }
  const now = gatedSecurityCheck(blobNow, localNow, r.cats);
  const shown = new Set(r.changes.map(changeKey));
  if (now.some((c) => !shown.has(changeKey(c)))) {
    // Judged against the store as it is now: a later approval compares against that. The gates
    // and `applied` stay the raise's — the store still holds that apply, stripped fields and all.
    raiseReview({ ...r, blob: blobNow, changes: now, relisted: true, storeSig: sigNow });
    return "prompt";
  }
  pendingReview = null;
  const applied = await applyBlob(blobNow, r.cats);
  if (myGen !== gen) return "done";
  if (!applied) {
    // Not applied (a session started mid-apply, or the store kept changing under it): put
    // the review back so the approval isn't consumed by an apply that never happened.
    pendingReview = r;
    return "prompt";
  }
  // Same degraded-keyring rule as the paths that raised it: the remote becomes the base only when
  // it left the backends category alone, or the next unlocked push reverts the peer's change.
  if (r.degraded && degradedBaseWithheld(r.remote)) return "done";
  await persistState({
    version: r.version,
    updatedAt: r.updatedAt,
    device: r.device,
    hash: hashBlob(r.remote),
    snapshot: r.remote,
  });
  if (myGen !== gen) return "done";
  // The adopted base moves past a conflict raised at this same version (a debounced push 409ing
  // next to the review): its categories were re-merged above, a live edit kept and pushed below.
  dropSupersededPending(r.version);
  setRuntime({ syncStatus: "ok", syncError: null, lastSyncedAt: Date.now(), lastSyncDevice: r.device });
  return r.pushAfter && hashBlob(blobNow) !== hashBlob(r.remote) ? "push" : "done";
}

/** Reject the held-back pull. Nothing is applied and NO base is adopted, so the next pull
 *  re-offers it rather than silently treating the rejected state as agreed. */
export function rejectPendingReview(): void {
  pendingReview = null;
  // Also drops a pull-apply parked while dictation ran: with no base adopted the next pull
  // re-offers it, so nothing lands behind a refusal.
  pendingApply = null;
  setRuntime({ syncStatus: "idle", syncError: null });
}

// ── conflict resolution (driven by the Sync tab dialog) ─────────────────────

/** Test seam: raise a minimal conflict so the id contract is pinnable without
 *  a transport (mirrors resetWarmDebounceForTests in preload.ts). The default version is one
 *  past the current base, as a real conflict's is — one at or below it is moot (resolveLocked). */
export function raiseConflictForTests(over: Partial<PendingConflict> = {}): void {
  raiseConflict({
    categories: ["general"],
    remoteDevice: null,
    local: {},
    remote: {},
    merged: {},
    remoteVersion: (state.version ?? 0) + 1,
    remoteUpdatedAt: null,
    ...over,
  } as unknown as PendingConflict);
}

/** Test seam: set the 3-way merge base (in memory only) — none, as on first contact, or this
 *  device's live compose, as right after a sync that changed nothing. */
export async function setSyncBaseForTests(base: "none" | "live"): Promise<void> {
  state = base === "live" ? { snapshot: await composeLive(syncCats()) } : {};
}

/** Test seam: is a deferred apply parked for the end of the dictation session? */
export function hasPendingApplyForTests(): boolean {
  return pendingApply !== null;
}

function raiseConflict(c: PendingConflict): void {
  // A pending conflict adopts no base, so every focus pull / 409 re-raises it: keep the id when it
  // is the SAME conflict (same server version, writer and categories — so the same remote
  // content, and a retained "remote" pick hands over nothing unseen), or the dialog remounts
  // and resets the user's half-made picks on every window switch.
  const same =
    pendingConflict !== null &&
    pendingConflict.remoteVersion === c.remoteVersion &&
    pendingConflict.remoteDevice === c.remoteDevice &&
    pendingConflict.categories.join() === c.categories.join();
  if (!same) pendingConflictId = ++conflictSeq;
  pendingConflict = c;
  // Same rule as raiseReview: a review against an older server version is moot now.
  if (pendingReview && pendingReview.version < c.remoteVersion) pendingReview = null;
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
  if (!pendingConflict) return;
  if (useApp.getState().status !== "idle") return; // same rule as approvePendingReview
  const myGen = gen; // same epoch rule as approvePendingReview
  // The conflict the user picked on. Same lock rule as approvePendingReview; a pull during the
  // wait may re-raise it, which keeps the id only when it is the same conflict (raiseConflict),
  // so the picks still apply to it.
  const id = pendingConflictId;
  if (!(await takeSyncLock(myGen))) return;
  let outcome: ApproveOutcome = "done";
  try {
    const c = pendingConflict;
    if (c && pendingConflictId === id && useApp.getState().status === "idle") {
      outcome = await resolveLocked(c, choices, myGen);
    }
  } finally {
    if (myGen === gen) inFlight = false;
  }
  if (myGen !== gen) return;
  // After the release, or pushNow would no-op on the lock this call held. Otherwise re-arm the
  // debounced push for an edit whose pushNow hit this lock (as approvePendingReview does) — but
  // not when a prompt went back up: the push would only 409 into it and re-run the held-back
  // apply and keyring read for nothing (approvePendingReview's same rule).
  if (outcome === "push") void pushNow(true);
  else if (outcome === "done") schedulePush();
}

/** resolveSyncConflicts' body, run under the engine lock. Same outcomes as approveLocked. */
async function resolveLocked(
  c: PendingConflict,
  choices: Record<string, "local" | "remote">,
  myGen: number,
): Promise<ApproveOutcome> {
  // Same moot-conflict rule as approveLocked.
  if ((state.version ?? 0) >= c.remoteVersion) {
    pendingConflict = null;
    setRuntime({ syncStatus: "ok", syncError: null });
    return "done";
  }
  // `c.local` was composed under the raise-time gates: with "Server addresses" / "API keys" off
  // then, a gated-off address / key was substituted with the snapshot's — the peer's own value.
  // The gates may be on now (turning one on does not supersede the conflict) and applyBlob reads
  // them live, so both the "local" picks and the security judgement below must use this device
  // as it is NOW, or a "keep mine" lands the peer's repoint with no review row. Same rule as
  // approvePendingReview.
  const syncedCats = syncCats();
  const localNow = await composeLive(syncedCats);
  if (myGen !== gen || pendingConflict !== c || useApp.getState().status !== "idle") return "done";
  // `c.merged` was merged against the raise-time local: an edit made here since (to a category
  // only this device changed) would be hydrated back to its old value. Re-merge against the live
  // compose, and if that conflicts on a category the user was never asked about, ask again.
  const re = mergeBlobs(state.snapshot, localNow, c.remote);
  if (re.conflicts.some((cat) => !c.categories.includes(cat))) {
    raiseConflict({ ...c, categories: re.conflicts, merged: re.merged, local: localNow });
    return "prompt";
  }
  pendingConflict = null;
  const final: SyncBlob = { ...re.merged };
  for (const cat of c.categories) {
    const src = choices[cat] === "remote" ? c.remote : localNow;
    const val = src[cat];
    if (val === undefined) delete final[cat];
    else (final as Record<string, unknown>)[cat] = val;
  }
  // Degraded keyring (see `backendsDegraded`): a degraded compose carries the base's backends
  // category, not this device's list, so `final` holds the remote/base list whichever side won —
  // applying it deleted every backend added here. Hold the category out, as the two sibling adopt
  // sites do. Either compose counts: the raise-time `c.local`, and `localNow` (the re-merge
  // and every "local" pick).
  const degradedNow = backendsDegraded(localNow, syncedCats);
  const degraded = backendsDegraded(c.local, syncedCats) || degradedNow;
  const applyCats = degraded ? { ...syncedCats, backends: false } : syncedCats;
  // Judged against the live list with no keys when degraded, as approvePendingReview does, so
  // every incoming address / key still raises.
  const judgeLocal = degradedNow
    ? { ...localNow, backends: { list: useApp.getState().backends, secrets: {} } }
    : localNow;
  // The security gate has to run HERE too, not just on the clean-merge path. `final` starts as
  // `c.merged`, which already contains every NON-conflicting category auto-resolved in the
  // server's favour — so a peer that also touches some category the user happened to edit
  // locally forces the pull down this branch and rides its backend repoint / key swap in
  // unreviewed. The conflict dialog only ever showed the CONFLICTING category names, never the
  // address change. Same shape as reconcileRemote: apply everything else, hold backends, and
  // persist no base so a rejection is re-offered on the next pull.
  const risky = gatedSecurityCheck(final, judgeLocal, applyCats);
  if (risky.length > 0) {
    const applyNow = heldBack(applyCats, risky);
    await applyBlob(final, applyNow);
    if (myGen !== gen) return "done";
    // Same re-check after the keyring read as pushNow's 409 twin.
    const gatesSig = gatesSignature();
    const storeSig = await storeSignature(applyCats);
    if (myGen !== gen) return "done";
    raiseReview({
      changes: risky,
      blob: final,
      cats: applyCats,
      remote: c.remote,
      applied: appliedAt(applyCats, applyNow),
      storeSig,
      gatesSig,
      version: c.remoteVersion,
      updatedAt: c.remoteUpdatedAt ?? null,
      device: c.remoteDevice ?? null,
      pushAfter: true,
      degraded,
    });
    return "prompt";
  }
  const applied = await applyBlob(final, applyCats);
  if (myGen !== gen) return "done";
  if (!applied) {
    // Not applied (a session started mid-apply, or the store kept changing under it):
    // restore the conflict so the picks are re-offered, not a base that never landed.
    pendingConflict = c;
    return "prompt";
  }
  if (degraded && degradedBaseWithheld(c.remote)) return "done";
  // Same server-truth rule as reconcileRemote: the server still holds
  // c.remote at remoteVersion — record THAT, so if the follow-up push fails,
  // later automatic pushes still see a difference and retry.
  await persistState({
    version: c.remoteVersion,
    // The writer of the version being adopted, like the two sibling adopt sites — otherwise
    // "Last synced just now · from X" kept naming the PREVIOUS sync's device. Its `updatedAt`
    // too: a null one makes initSync restore "Not synced yet." after a restart.
    updatedAt: c.remoteUpdatedAt ?? null,
    device: c.remoteDevice ?? null,
    hash: hashBlob(c.remote),
    snapshot: c.remote,
  });
  if (myGen !== gen) return "done";
  // Same as approveLocked: a review at this version is answered by the adopted base (its held-back
  // category either came out of the security check clean, or the user picked this device's side).
  dropSupersededPending(c.remoteVersion);
  setRuntime({ syncStatus: "ok", syncError: null, lastSyncedAt: Date.now(), lastSyncDevice: c.remoteDevice ?? null });
  // The resolved doc differs from what the server holds unless "remote" won
  // everywhere — push it (base = the server version the conflict reported).
  return hashBlob(final) !== hashBlob(c.remote) ? "push" : "done";
}

export function dismissSyncConflict(): void {
  pendingConflict = null;
  pendingApply = null; // "Later" also drops a pull-apply parked while dictation ran (re-offered next pull)
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
  if (state.snapshot) state.snapshot = migrateBlob(state.snapshot); // non-object snapshot → {}
  await restoreSnapshotSecrets();
  // Migrate a pre-split state file: it still holds the keys in cleartext and records no ids.
  // Rewriting now moves them to the keyring and strips the file, rather than waiting for
  // whenever the next sync happens to persist.
  if (!state.snapshotSecretIds && state.snapshot?.backends?.secrets) {
    await persistState({});
  }
  device = await syncDeviceInfo();
  // Rust seeds `deviceId` into sync-state.json, but persistState writes
  // `{...state, ...patch}` — carry the id into the in-memory state or the very
  // next save strips it and every launch regenerates (and re-writes) a new one.
  if (device?.deviceId && state.deviceId !== device.deviceId) state.deviceId = device.deviceId;

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
        void applyBlob(p.blob, p.cats, 2, p.opts);
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
    // A category toggled ON (via the per-setting gates) adopts the server's
    // state for it before pushing. Keyed on the DERIVED cats: `sync.categories`
    // has had no writer since the manifest list replaced the category rows, so
    // comparing the raw map was permanently false and a re-enabled setting
    // pushed this device's value over the peer's.
    if (nowSync?.enabled && prevSync?.enabled) {
      const prevCats = catsFromGates(completeGates(prevSync.sub, prevSync.categories));
      const nowCats = catsFromGates(completeGates(nowSync.sub, nowSync.categories));
      if (ALL_CATEGORIES.some((c) => nowCats[c] && !prevCats[c])) {
        supersede();
        void pullNow(true);
        return;
      }
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

/** Plain-language failure line for "Delete server copy" — the one server call on
 *  the Sync tab whose result used to be discarded. Server text is peer/attacker
 *  authored, so it is defanged like the warnings channel. */
export function deleteFailureMessage(r: { ok: boolean; status: number; error?: string | null }): string {
  const detail = safeDisplayText(r.error ?? "", 200);
  if (r.status === 401 || r.status === 403) {
    return "The server rejected the API key — the stored settings were not deleted.";
  }
  if (r.status === 0) {
    return `Could not reach the server — the stored settings were not deleted.${detail ? ` (${detail})` : ""}`;
  }
  return `The server refused to delete the stored settings (${r.status}).${detail ? ` ${detail}` : ""}`;
}

/** For the Sync tab's "Delete server copy": forget local bookkeeping so the
 *  next push recreates from version 0. */
export async function resetSyncState(): Promise<void> {
  supersede();
  state = { deviceId: state.deviceId, serverBackendId: state.serverBackendId };
  await clearSnapshotSecrets(); // no snapshot left — drop its stashed keys with it
  await persistState({ version: 0, updatedAt: null, device: null, hash: undefined, snapshot: undefined });
  setRuntime({ lastSyncedAt: null, lastSyncDevice: null, syncStatus: "idle", syncError: null });
}
