// The settings-sync engine — composes the synced blob, 3-way merges,
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
  readBackendKeyStates,
  saveSyncState,
  setBackendKey,
  setDeepFieldDetection,
  syncDeviceInfo,
  syncPull,
  syncPush,
} from "../api";
import { configReady, configSaveHeld, evdevPermittedNow, onConfigSaveHoldCleared, retryHeldConfigSave } from "../persistence";
import { effectiveServerUrl, normalizeUrl, serverUrlFromPeer } from "../backends";
import { DEFAULT_PASTE_SHORTCUT, PASTE_PRESETS } from "../paste";
import { IS_WINDOWS } from "../platform";
import { hasOwn, ownProp } from "../own";
import { sanitizeCueLimits } from "../transcript/cueSplit";
import { appRuleKey, capCodePoints, normalizeAppId, safeDisplayText, safeIdentityText } from "../sanitize";
import { conflicts, QUICK_ADD_PEER_ID, withQuickAddPeer } from "../hotkeyConflicts";
import { canonicalActivation } from "../types";
import { TRANSLATION_MAX_TARGETS } from "../languages";
import { fmtFull, plural } from "../format";
import { clampDecodeOverrides, DECODE_KEYS, keySpec, TYPED_TEXT_KEYS, type DecodeKey } from "../decodeKeys";
import type {
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
import type { BackendKeyRead } from "../api";
import { DEFS, MANIFEST, completeGates, type SettingId } from "../settingsManifest";
import { DEFAULT_SETTINGS } from "../defaults";
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
  gatesTurnedOn,
  gatePartsPresent,
  gateStillSyncs,
  isPlainObject,
  SCALAR_CATS,
  withGateParts,
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

/** Every category set to `on`. */
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
 *  `sync.categories` map has no UI writer since the manifest list replaced the category
 *  rows: reading it would freeze an upgraded user's OFF category for good (no control
 *  could turn it back on) and leave the list-level switches — "Server list", "Profile
 *  list & settings", "Rules for this OS" — inert. */
function syncCats(): Record<SyncCategory, boolean> {
  return catsFromGates(settingGates()) as Record<SyncCategory, boolean>;
}

/** applyBlob strips gated-off scalar fields, so the security review must judge what
 *  will actually apply: comparing ungated blobs would raise the consent dialog (and hold a
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

import { stableStringify } from "../stable";
import { forgetCredential } from "../capabilities";

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

/** Category equality — decides whether a category conflicts and prompts, or merges silently.
 *  Compares the canonical strings, NOT their hashes: `hashBlob` builds this exact string and then
 *  folds it to 32 bits, so comparing digests is more work for a merely probabilistic answer. */
const catEqual = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

/** Bound an await that may never settle — chiefly keyring calls (a locked
 *  KWallet parks the request behind a password prompt indefinitely); network
 *  calls ride reqwest's timeout. Without this, one blocked call wedges the
 *  engine for the whole session (`inFlight` never clears — the finally never
 *  runs on a never-settling promise). Degrading to `fallback` is always safer
 *  than never syncing again. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

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
  // Old blobs carry ONE `transcription` category holding the history flags
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
        // would lose them from the merge base, the pull and an imported file.
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
  // The legacy name is ALWAYS removed: renamed when the new key is absent, dropped when both
  // arrive — Rust's alias then reads two values for one field ("duplicate field") and rejects the
  // whole Config on every later save. On a copy: the caller's blob is not ours to edit.
  if (isPlainObject(out.recording) && hasOwn(out.recording, "latchAutoStopMin")) {
    const { latchAutoStopMin, ...rec } = out.recording as Record<string, unknown>;
    if (!hasOwn(rec, "handsFreeAutoStopMin")) rec.handsFreeAutoStopMin = latchAutoStopMin;
    out.recording = rec as SyncRecording;
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

/** The categories a pulled blob can actually restore: present after migration (so pre-split
 *  categories count) as a plain object, applyBlob's own arm test. The ONE predicate behind the
 *  restore offers' gates and their chips, so an offer never opens on a blob that restores
 *  nothing (`{}` from a peer syncing with every category off, or only unknown future keys). */
export function restorableCategories(blob: SyncBlob | null | undefined): SyncCategory[] {
  if (!blob) return [];
  const m = migrateBlob(blob);
  return ALL_CATEGORIES.filter((c) => isPlainObject(m[c]));
}

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
    // quickAddHotkey lives in the `dictionary` category.
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
  // this category (the tab lists them under "Recording & history").
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
 *  The last-used backend/model/language/translation-model picks travel only when the sub-toggle
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
 *  The pin is SLAVED to the backends category (`syncPin` also needs it on):
 *  it references a backend id, so on a device that doesn't sync its backend
 *  list the ids differ per machine — syncing the pin there would make every
 *  pull null the local pin through the dangling-reference scrub and every
 *  push overwrite the peer's, a slow ping-pong that destroys both pins.
 *  Backends OFF → passthrough. */
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

/** Per scalar category, every key this version CLASSIFIES: what its extractor emits (read off the
 *  factory defaults, so a newly extracted field counts at once), the category's manifest fields,
 *  and the keys it keeps off the wire on purpose (local-only, machine-local, owned by another
 *  category, legacy names `migrateBlob` rewrites). A key outside this set in the snapshot's copy
 *  came from a newer peer. Built on first use, not at module load. */
let knownScalarKeys: Map<SyncCategory, ReadonlySet<string>> | undefined;
function knownKeysOf(c: SyncCategory): ReadonlySet<string> {
  knownScalarKeys ??= (() => {
    const d = DEFAULT_SETTINGS;
    const extracted: Partial<Record<SyncCategory, object | undefined>> = {
      general: extractGeneral(d),
      recording: extractRecording(d, true, undefined),
      chip: extractChip(d),
      dictionary: extractDictionary(d, true, true, undefined),
      transcription: extractTranscription(d, true, undefined),
      fileTranscriptions: extractFileTranscriptions(d),
      logging: extractLogging(d, true, undefined),
    };
    const also: Partial<Record<SyncCategory, Iterable<string>>> = {
      general: ["autoEnter", "evdevEnabled", "quickAddHotkey"],
      recording: [...CHIP_FIELD_SET, ...DICTATION_HISTORY_SET, "recordingsDir", "audioBaseDir", "latchAutoStopMin"],
      chip: CHIP_FIELD_SET,
      dictionary: ["quickAddList", "quickAddHotkey"],
      transcription: [
        ...TRANSCRIPTION_FIELD_SET,
        ...TRANSCRIPTION_PICK_SET,
        ...DICTATION_HISTORY_SET,
        ...FILE_TRANSCRIPTION_SET,
      ],
      fileTranscriptions: FILE_TRANSCRIPTION_SET,
      logging: ["logDir"],
    };
    return new Map(
      SCALAR_CATS.map((cat) => [
        cat,
        new Set<string>([
          ...Object.keys(extracted[cat] ?? {}),
          ...(also[cat] ?? []),
          ...DEFS.filter((def) => def.category === cat).flatMap((def) => def.fields.map((f) => f.key)),
        ]),
      ]),
    );
  })();
  return knownScalarKeys.get(c) ?? new Set();
}

/** Per typed list, every element key this version knows: what its sanitizer emits (it sets each
 *  field Rust's `Profile` / `Backend` struct has). Built on first use, like `knownKeysOf`. */
let knownElementKeySets: { profiles: ReadonlySet<string>; backends: ReadonlySet<string> } | undefined;
function knownElementKeys(): { profiles: ReadonlySet<string>; backends: ReadonlySet<string> } {
  return (knownElementKeySets ??= {
    profiles: new Set(Object.keys(sanitizeProfiles([{ id: "p", name: "", hotkey: [] }])[0] ?? {})),
    backends: new Set(Object.keys(sanitizeBackends([{ id: "b", serverUrl: "" }])[0] ?? {})),
  });
}

/** `list` with each element given the keys its same-id snapshot element has that this version
 *  does not know and the element lacks (the scalar echo, per element). Copies only the elements
 *  it adds to — the live ones are the store's — and returns `list` itself when nothing moved. */
function echoElementKeys<T extends { id: string }>(list: T[], snapList: unknown, known: ReadonlySet<string>): T[] {
  if (!Array.isArray(list) || !Array.isArray(snapList)) return list;
  const snapById = new Map<string, Record<string, unknown>>();
  for (const e of snapList) {
    if (isPlainObject(e) && typeof e.id === "string" && !snapById.has(e.id)) snapById.set(e.id, e);
  }
  let changed = false;
  const out = list.map((el) => {
    const snap = isPlainObject(el) ? snapById.get(el.id) : undefined;
    if (!snap) return el;
    let copy: T | undefined;
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined || known.has(k) || hasOwn(el, k)) continue;
      copy ??= { ...el };
      // defineProperty: the snapshot is parsed server JSON, so `__proto__` can be an own key.
      Object.defineProperty(copy, k, { value: v, writable: true, enumerable: true, configurable: true });
    }
    if (!copy) return el;
    changed = true;
    return copy;
  });
  return changed ? out : list;
}

type StoreSlice = Pick<Config, "settings" | "backends" | "profiles"> & { appRules: AppRule[] };

/** A keyring read that answered for every id: each one is either read or reported ABSENT. Only
 *  then does a missing key mean "no key stored" rather than "could not tell" (a timeout is null). */
function keyReadFailedNowhere(read: BackendKeyRead | null): read is BackendKeyRead {
  return read !== null && Array.isArray(read.unreadable) && read.unreadable.length === 0;
}

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
        // The pin needs its referent list AND its own "Pinned word mappings" switch.
        // `gates` is absent on the export path, deliberately all-on.
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
    // "API keys" gate off: the gate pass below carries the snapshot's keys whatever is read here,
    // so skip the live read — a locked wallet must not divert the list to the degraded pass-through.
    if (opts.includeSecrets && (!opts.gates || opts.gates.apiKeys)) {
      const read = await withTimeout(
        readBackendKeyStates(cfg.backends.map((b) => b.id)),
        10_000,
        null as BackendKeyRead | null,
      );
      let secrets = read?.keys ?? {};
      // A key the store reports ABSENT (read fine, no entry) is a stale local `hasApiKey` — config
      // copied from another machine, wallet reset, entry deleted by hand — not a locked wallet.
      // Held as missing, it would take the degraded pass-through below on every compose, and every
      // merge would leave backends out of the apply: `reconcileBackendSecrets`, the one place that
      // re-derives the flag, never runs, and sync stays degraded for good. So: the base's key for
      // that id travels when it holds one (nothing is erased; it is written back here only when an
      // apply's reconcile runs), else the entry goes up as keyless, which is what it is. Only a
      // read with NO failed id, and only while the base's keys were read back whole (otherwise "no
      // base key" may just mean an unread stash): a failed id or a timeout keeps the completeness
      // rule below as is. And only from the ADOPTED base: with none, or with backends
      // fresh, a merge's pass-through is the remote, whose key carried here reads as this
      // device's own — the consent rule then sees no change and the apply stores it unreviewed.
      // The stash latch is consulted only when a base is passed: a settings export passes none,
      // so no base key can travel, and the latch (a sync-base matter) would drop every readable
      // key from the backup over one stale flag.
      if (keyReadFailedNowhere(read) && (snapshot === undefined || !snapshotSecretsUnavailable)) {
        const base = state.snapshot?.backends;
        const snapSecrets = base !== undefined && snapshot?.backends === base ? base.secrets : undefined;
        const carried: [string, string][] = [];
        const list = cfg.backends.map((b) => {
          if (!b.hasApiKey || ownProp(secrets, b.id) !== undefined) return b;
          const key = inboundSecret(snapSecrets, b.id);
          if (key === undefined) return { ...b, hasApiKey: false };
          carried.push([b.id, key]);
          return b;
        });
        if (carried.length > 0) secrets = { ...secrets, ...Object.fromEntries(carried) };
        blob.backends.list = list;
      }
      // COMPLETENESS, not non-emptiness. The read's `keys` leaves out the individual entries it
      // cannot read rather than failing the batch, so a PARTIAL map is the
      // normal degraded shape. Uploading it replaces the server's copy of every key that is
      // missing here with nothing — the same erase hazard the `else` branch below guards, one
      // step earlier. (`restoreSnapshotSecrets` already treats a partial read-back as failure.)
      const complete = blob.backends.list.every((b) => !b.hasApiKey || ownProp(secrets, b.id) !== undefined);
      if (Object.keys(secrets).length > 0 && complete) {
        blob.backends.secrets = secrets;
      } else if (blob.backends.list.some((b) => b.hasApiKey)) {
        // A locked wallet degrades the read above to `{}`: pushing this list without secrets
        // replaces the server's copy with a keyless one — which pushNow then records as the new
        // snapshot, orphaning the stash. So when this device believes it HAS keys and could not
        // read them all, re-push the SNAPSHOT's category (the server's own last content). NOT
        // `undefined`: the transport is a whole-blob PUT and the client does the merge, so an
        // omitted key erases the stored list AND its keys and becomes the new merge base. On the
        // export path (no snapshot) the local list travels without secrets — a backup must never
        // silently lose the server list.
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
  // FORWARD-COMPAT inside a category (the top-level carry-through is below): the extractors
  // allowlist their fields, so a newer peer's field in a category this device syncs never made
  // it into the compose. The 3-way merge read that absence as a LOCAL edit on every sync — a
  // conflict dialog for a category the user never touched, or a push that erased the field
  // from the server. Echo the snapshot's keys this version does not classify; a key it knows
  // keeps the live (or gated) value. Before the gate pass, which only touches known keys.
  if (snapshot) {
    for (const c of SCALAR_CATS) {
      const out = blob[c];
      const snap = snapshot[c];
      if (!cats[c] || !isPlainObject(out) || !isPlainObject(snap)) continue;
      const known = knownKeysOf(c);
      for (const [k, v] of Object.entries(snap)) {
        // defineProperty: the snapshot is parsed server JSON, so `__proto__` can be an own key.
        if (v === undefined || known.has(k) || hasOwn(out, k)) continue;
        Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
      }
    }
    // …and per element of the two typed lists: Rust's `Profile` / `Backend` have no catch-all,
    // so a newer peer's per-element field lasts only until this device restarts, after which the
    // live list reads as a local edit (a push erasing it, or a conflict nobody made). appRules
    // needs none: Rust keeps them as untyped JSON.
    const known = knownElementKeys();
    if (cats.profiles && blob.profiles && Array.isArray(blob.profiles.list)) {
      const list = echoElementKeys(blob.profiles.list, snapshot.profiles?.list, known.profiles);
      if (list !== blob.profiles.list) blob.profiles = { ...blob.profiles, list };
    }
    if (cats.backends && isPlainObject(blob.backends) && Array.isArray(blob.backends.list)) {
      const list = echoElementKeys(blob.backends.list, snapshot.backends?.list, known.backends);
      if (list !== blob.backends.list) blob.backends = { ...blob.backends, list };
    }
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
  // device's category on every push (server-side ping-pong).
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
      // block promises never to do). composeBlob's twin never reaches its assignment for
      // `__proto__` (`k in blob` is true via the prototype), so it skips the key rather
      // than swapping the prototype.
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
 *  (the server's TRANSLATION_CONTEXT_SEGMENTS range) or nothing. `model`/`glossary` are cut by
 *  code points like the server's caps: a UTF-16 cut can leave a lone surrogate that fails every
 *  later `save_config`, and truncates an emoji-heavy glossary the server keeps whole. */
export function clampTranslationOverrides(v: unknown): TranslationOverrides | undefined {
  if (!isPlainObject(v)) return undefined;
  const cs = v.contextSegments;
  const out: TranslationOverrides = {
    translateTo: Array.isArray(v.translateTo)
      ? v.translateTo.filter((c: unknown): c is string => typeof c === "string").slice(0, TRANSLATION_MAX_TARGETS)
      : undefined,
    model: typeof v.model === "string" ? capCodePoints(v.model, 200) : undefined,
    contextSegments:
      typeof cs === "number" && Number.isFinite(cs) ? Math.min(CONTEXT_SEGMENTS_MAX, Math.max(0, Math.round(cs))) : undefined,
    glossary: typeof v.glossary === "string" ? capCodePoints(v.glossary, 4000) : undefined,
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
 *  reaches consumers that deref it unguarded (`p.hotkey.length`), and with no error boundary in
 *  the tree a throw during render unmounts the window. Drop malformed entries here so both paths
 *  share the same floor. */
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
      // Two sinks for an unknown activation: `GLYPH[p.activation]` in Dashboard is rendered AS A
      // COMPONENT, so it throws "Element type is invalid" and, with no error boundary, unmounts
      // the main window; and `ActivationType` is a serde enum with no fallback, so `save_config`
      // rejects the WHOLE config for the session. "hold" is the fail-safe: push-to-talk never
      // live-types.
      //
      // An older peer still sends `"latch"` for `"handsfree"`. It must be NORMALIZED, not
      // rejected: the "hold" fallback would silently demote every hands-free profile to
      // push-to-talk. Rust's `#[serde(alias = "latch")]` covers the config-file path; this
      // covers the sync one.
      activation: canonicalActivation((p as Profile).activation) ?? "hold",
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
      // enum here wedges every later save for the session.
      //
      // `autoEnter` is dropped rather than clamped, as in `sanitizeAppRules`: a peer must
      // not be able to arm a post-paste Return.
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
      // `enabled` is a bare `bool` with no serde default, so a wrong type wedges every later
      // save, and a truthy non-bool counts as ACTIVE in `conflicts()`. `overrideProfile` has a
      // default, but a present non-string still fails the typed parse.
      enabled: p.enabled === true,
      // Trimmed, blank → unset: what every editor saves and the UI label shows. Untrimmed, a peer's
      // "clinic-de " would display as clinic-de but be sent verbatim, missing the server profile.
      overrideProfile:
        typeof p.overrideProfile === "string" && p.overrideProfile.trim()
          ? p.overrideProfile.trim()
          : undefined,
      // Same clamp as the Backend twin: Rust forwards it into every session request as opaque JSON.
      decodeOverrides: clampDecodeOverrides(p.decodeOverrides),
      // Rust's `backend_id` is `Option<String>`, and `applyBlob`'s dangling-reference scrub is no
      // type check: it is gated on `p.backendId &&`, so a FALSY non-string (`0`, `false`) skips it
      // and rejects the whole `Config`. `null` is the app's own "no backend chosen" value.
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

/** Would a restore of `m` (migrated, every category on, gates ignored) land a quick-add pin?
 *  The same conditions as `applyBlob`'s pin arm — a plain-object dictionary carrying a
 *  well-formed pin, next to a backends section — plus the dangling-reference scrub after it,
 *  which nulls a pin whose backend the incoming list does not hold. Without a pin the quick-add
 *  chord is inert, so a restore must not promise quick add on the chord alone. */
export function carriesQuickAddPin(m: SyncBlob): boolean {
  if (!isPlainObject(m.dictionary) || !isPlainObject(m.backends)) return false;
  const pin = safeQuickAddTarget(ownProp(m.dictionary as Record<string, unknown>, "quickAddList"));
  return !!pin && sanitizeBackends(m.backends.list).some((b) => b.id === pin.backendId);
}

export function isCodeList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_CHORD_CODES &&
    v.every((c) => typeof c === "string" && c.length <= MAX_CHORD_CODE_LEN)
  );
}

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
 *  number, but not the same measure: this counts UTF-16 code units and Rust counts UTF-8 bytes
 *  (Rust is the stricter on non-ASCII; every real `KeyboardEvent.code` is ASCII and well under 32).
 *  The count cap above bounds how many codes a chord has, never how long one is — 16 codes of
 *  ~250 KB each fit inside `SYNC_MAX_BODY` (4 MB) and reach `conflicts()`' O(k·m) subset scan, a
 *  `config.json` rewritten on every autosave, and `codeToLabel`'s raw fall-through render. A chord
 *  failing this is rejected whole. */
const MAX_CHORD_CODE_LEN = 64;

/** Turn OFF the later member of every chord collision in an inbound binding set, including a
 *  collision with the (possibly also inbound) quick-add chord. See the call site for why a
 *  conflicting set is worse than a malformed one.
 *
 *  Side-collapsing follows the save gate's rule (`evdevLive` carries the live backend), so the
 *  sanitizer catches at least what the gate does — anything the gate catches and this misses
 *  freezes saving. */
export function disableConflictingProfiles(
  profiles: Profile[],
  quickAddHotkey: string[],
  /** Did the PROFILES in this call arrive in the same blob as the chord? When they did not,
   *  the chord is remote-authored and the list is this device's own — see below. */
  profilesAreInbound: boolean,
  /** evdev is this device's live hotkey backend (enabled in the settings being applied AND
   *  permitted): it registers side-distinct chords, like the Windows hook. */
  evdevLive = false,
  /** Profiles in an INBOUND list whose CHORD is nevertheless this device's own ("Profile
   *  shortcuts" off re-pins every known profile's chord), keyed by id as this device holds them.
   *  One counts as local only where the rest of what `conflicts()` reads for the pair, which
   *  still arrives from the peer, is this device's too — only then did the pair pass its save
   *  gate. Against another profile that is the enabled state AND the activation kind (which
   *  decides a designed nesting); against the quick-add chord it is the enabled state alone,
   *  since the quick-add peer nests with nothing and activation cannot make or break that pair. */
  localBindings: ReadonlyMap<string, Profile> = new Map(),
  /** This device's own quick-add chord — what the caller installs in place of a rejected
   *  incoming one. Defaults to `quickAddHotkey` (the chord is not incoming). */
  localQuickAddHotkey: string[] = quickAddHotkey,
): { profiles: Profile[]; rejectQuickAddHotkey: boolean } {
  const order = new Map(profiles.map((p, i) => [p.id, i]));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const disable = new Set<string>();
  let rejectQuickAddHotkey = false;
  const chordIsLocal = (id: string, kindMatters: boolean) => {
    if (!profilesAreInbound) return true;
    const mine = localBindings.get(id);
    const p = byId.get(id);
    return (
      mine !== undefined &&
      p !== undefined &&
      mine.enabled === p.enabled &&
      (!kindMatters || mine.activation === p.activation)
    );
  };
  // Collapse modifier SIDES only where the registrar does — the save gate's own rule
  // (persistence.ts): the Windows low-level hook (hotkeys/windows.rs, VK_LCONTROL ≠ VK_RCONTROL)
  // and a live evdev backend register side-distinct chords, and collapsing anyway disabled a
  // working LCtrl+Space / RCtrl+Space pair on every pull — persisted, and pushed back out.
  const collapseSides = !IS_WINDOWS && !evdevLive;
  let found = conflicts(withQuickAddPeer(profiles, quickAddHotkey), collapseSides);
  // The quick-add peer always wins, since it is a single global chord the user may have bound
  // locally, not one of many list entries…
  //
  // …but only when the profiles it beats came from the same blob. `dictionary` has no consent
  // arm, so a blob carrying ONLY `dictionary.quickAddHotkey` reaches this with the user's own
  // local profile list, and the unconditional win then switches those profiles off and
  // persists that — worst case `["ControlLeft"]`, a strict subset of virtually every real
  // chord, which disables dictation app-wide with nothing malformed to point at and no
  // banner. When the collision is remote-chord-vs-local-profiles, drop the incoming chord
  // instead. The peer still cannot be disabled, so the save gate stays un-tripped either way.
  //
  // The same holds per profile when the list arrived but its chords did not: with "Profile
  // shortcuts" off every known profile carries this device's chord, so a collision there is
  // the incoming chord's fault, whatever the list order.
  if (found.some((c) => c.otherId === QUICK_ADD_PEER_ID && chordIsLocal(c.profileId, false))) {
    rejectQuickAddHotkey = true;
    // Settle the rest against the chord that will actually be installed: an inbound profile on
    // this device's own chord collides with it, while one that only met the dropped chord does not.
    found = conflicts(withQuickAddPeer(profiles, localQuickAddHotkey), collapseSides);
  }
  for (const c of found) {
    if (c.otherId === QUICK_ADD_PEER_ID) {
      // A local binding already passed this device's save gate beside its own chord, and is
      // never against an incoming one here (that chord was rejected above).
      if (!chordIsLocal(c.profileId, false)) disable.add(c.profileId);
    } else if (c.profileId !== QUICK_ADD_PEER_ID) {
      // Between two inbound bindings keep whichever came first.
      const self = order.get(c.profileId) ?? 0;
      const other = order.get(c.otherId) ?? 0;
      // Two local bindings already passed this device's save gate together: nothing new collides.
      const selfLocal = chordIsLocal(c.profileId, true);
      const otherLocal = chordIsLocal(c.otherId, true);
      if (selfLocal !== otherLocal) disable.add(selfLocal ? c.otherId : c.profileId);
      else if (!selfLocal && self > other) disable.add(c.profileId);
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
 *  keeps the bad value, the save stays held, and `pushNow` short-circuits on it. An unknown
 *  incoming variant becomes `fallback` (the device's current value where the caller has one). */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** The settings leaves Rust declares as `u32` (`config/mod.rs`: `hover_reveal_ms`,
 *  `recordings_retention_days`, `LoggingSettings::keep_days`). Every other numeric leaf is `f64`.
 *  Keep this in step with the Rust structs: a `u32` leaf missing here rides through `typedLike` on
 *  `typeof === "number"` alone, and `-1` then fails `deserialize_u32` for the WHOLE Config —
 *  every later save_config rejected for the session. */
const U32_KEYS = new Set(["hoverRevealMs", "recordingsRetentionDays", "keepDays"]);

/** Per-field validation for every inbound key that lands in `settings.transcribe` (the
 *  `transcription` and `fileTranscriptions` categories and the dictation-history flags riding
 *  `recording`). `settings.transcribe` is OPAQUE to Rust (serde_json::Value), so nothing
 *  downstream rejects a bad type — this is the only gate. Wrong-typed values are dropped (keep
 *  local); numbers are clamped to their UI ranges. Unknown keys never reach here (pickFields
 *  allowlists first). */
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
  for (const k of TRANSCRIPTION_PICK_FIELDS) {
    const str = ownProp(v, k);
    if (typeof str === "string" && str.length <= 256) out[k] = str;
  }
  // T2T targets: the only array field here — clamp shape hard (TRANSLATION_MAX_TARGETS
  // short codes max) so a hostile peer can't balloon the settings blob.
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
 *  of the session (the save stays held, `pushNow` short-circuits, and shortcut
 *  re-registration — which only runs on the success path — stops happening).
 *
 *  Drop only KNOWN keys whose type disagrees with what this device holds. Unknown keys are
 *  passed through untouched: Rust ignores unrecognised fields, so a newer peer's additions must
 *  survive the round-trip rather than being erased by an older client's next push. */
function typedLike<T extends object>(incoming: T, local: T): Partial<T> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    // OWN properties on both reads: `JSON.parse` makes `__proto__` / `constructor` / `toString`
    // ordinary own keys, while `in` and a bare index consult the prototype chain and would
    // compare them against `Object.prototype`'s members instead of against "absent".
    const ref = ownProp(local as Record<string, unknown>, k);
    // A key this version does not know passes through untouched, `null` included (see the docblock).
    if (!hasOwn(local as Record<string, unknown>, k)) {
      out[k] = v;
      continue;
    }
    // Pass `null` only where the LOCAL field is nullable too. `#[serde(default)]` fills an ABSENT
    // key; a PRESENT `null` still goes through `deserialize_bool` and errors, so a single
    // `{"general":{"soundEffects":null}}` rejects the whole `Config`. Keep this device's value
    // instead, as `oneOf` does for an unknown variant.
    if (v == null) {
      if (ref == null) out[k] = v;
      continue;
    }
    if (ref == null) {
      out[k] = v;
      continue;
    }
    if (typeof v !== typeof ref) continue;
    if (Array.isArray(ref) !== Array.isArray(v)) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    // JS has ONE number type; Rust does not. `typeof` agreeing is not enough for the
    // fields Rust holds as `u32` — `-1`, `0.5` and `5e9` all pass the check above and then
    // fail serde on the whole `Config`. The f64 fields need no bound: serde accepts any
    // finite double, so they cannot wedge the parse.
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
      // Inbound addresses are stored VERBATIM and go straight to the transport, so store the
      // form `serverUrlFromPeer` canonicalises. A scheme this app does not speak is BLANKED
      // (`https:/evil.tld` would read as host "https" here while reqwest resolves evil.tld, so
      // the card and consent dialog would name another server than the one receiving the key) —
      // blanked, not dropped: the entry keeps its id and keyring association, and "" is the
      // existing "not configured yet" state. The CLEANED string is stored because
      // `securityChanges` compares `normalizeUrl(cur) !== normalizeUrl(next)`: a dirty stored value
      // would let a dirty→clean swap of the same host compare equal and skip the consent prompt.
      // A lenient http(s) scheme (`http:/host`) is canonicalised, not blanked: the transport
      // already reads it as that host, and blanking broke a working backend.
      serverUrl: serverUrlFromPeer(b.serverUrl),
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
      overrideProfile:
        typeof b.overrideProfile === "string" && b.overrideProfile.trim()
          ? b.overrideProfile.trim()
          : undefined,
      // `Option<BackendKind>` defaults only when the key is ABSENT; a present unknown string (or a
      // non-string) has no serde fallback and fails the typed parse. undefined = "infer from the
      // connection test".
      kind: b.kind == null ? undefined : oneOf<BackendKind>(b.kind, BACKEND_KINDS, "auto"),
      decodeOverrides: clampDecodeOverrides(b.decodeOverrides),
      translationOverrides: clampTranslationOverrides(b.translationOverrides),
    }))
    )
    .slice(0, MAX_SYNCED_ENTRIES);
}

/** Drop inbound app rules that aren't shaped like rules, and clamp the fields of the rest. Rust
 *  never checks a rule's fields (the importer only checks each bucket is an array; the pull path
 *  not at all), and app rules raise no consent prompt, so a malformed rule arrives silently. */
export function sanitizeAppRules(rules: unknown): AppRule[] {
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
      // The rule's KEY, normalized as the editor does (see `normalizeAppId`).
      appId: normalizeAppId(r.appId),
      block: r.block === true,
      // The rules list does `r.name?.trim()` in a render body — `?.` guards null/undefined, not a
      // number or object, so one malformed rule unmounts the audit screen.
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
      // drops the field entirely and lets the local value stand (applyBlob re-pins it via
      // `APP_RULE_LOCAL_ONLY_FIELDS`).
      autoEnter: undefined,
    }))
    // An all-invisible appId normalizes to "", which matches nothing and displays as nothing —
    // a zombie row on the audit screen. Drop it rather than store it. Tested on the comparison
    // key: a joiner-only appId keeps its joiner when stored but keys to "".
    .filter((r) => appRuleKey(r.appId).length > 0)
    // Rules are MATCHED by appId and `resolveInjectionTarget` takes the FIRST match, so two rules
    // sharing an appId shadow each other (`dedupeById` keys on `id`, so it can't catch this).
    // Without it a peer prepends `{appId:"konsole", block:false, insertMethod:"direct"}` ahead of
    // the user's `{appId:"konsole", block:true}`: the resolver TYPES into the app the user marked
    // "never type here" while AppRules.tsx still shows the shadowed rule as blocked — and app
    // rules raise no SecurityChange, so it lands on the unattended startup/focus pull.
    // Keep-FIRST on both keys, as the resolver does, so display agrees with enforcement.
    // Unreachable for legitimate configs (`upsertAppRule` keeps appIds unique). Sync sanitizer
    // only, never `wellFormedAppRules`: that floor runs over the user's own config.json at every
    // launch with the autosave armed.
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

/** The inbound API key for `id`, read exactly as `reconcileBackendSecrets` writes it: a non-empty
 *  string, own property of a plain-object container. `secrets` has no shape check on either side
 *  (Rust forwards the blob as opaque JSON), so a STRING container iterated with `Object.entries`
 *  expands per code unit — seconds of frozen main thread on the unattended startup/focus pull.
 *  Own-property because `secrets.constructor` is otherwise a truthy function. `securityChanges`
 *  reads through this too, so it never raises an api-key row whose approval would write nothing. */
function inboundSecret(secrets: unknown, id: string): string | undefined {
  const key = isPlainObject(secrets) ? ownProp(secrets as Record<string, unknown>, id) : undefined;
  return typeof key === "string" && key ? key : undefined;
}

/** What an import or a restore does to each incoming backend's API key — the disclosure both
 *  consent dialogs show, judged on the list the apply installs (`incoming`, sanitized; empty when
 *  backends are not selected) and the keys it carries (`secrets`, read as the apply writes them).
 *  - `carried`: the apply writes keys into this device's keyring.
 *  - `missing`: claims a key nobody supplies — neither carried nor already held here.
 *  - `moved`: keeps the key this device holds for that id (nothing carried replaces it, and an
 *    apply never deletes one), but now CONNECTS elsewhere, so the key goes to `to`. "Connects" is
 *    `effectiveServerUrl`: an "Address on this device" override wins, and the apply leaves a
 *    surviving id's override in place, so the current settings are also the post-apply ones. */
export function backendKeyFates(
  incoming: Backend[],
  secrets: unknown,
  local: Backend[],
  settings: AppSettings,
): { carried: boolean; missing: Backend[]; moved: { backend: Backend; to: string }[] } {
  const dest = (x: Backend) => effectiveServerUrl(x, settings);
  const keyHere = (b: Backend) => local.find((x) => x.id === b.id && x.hasApiKey);
  const carries = (b: Backend) => inboundSecret(secrets, b.id) !== undefined;
  return {
    carried: incoming.some(carries),
    missing: incoming.filter((b) => b.hasApiKey && !carries(b) && !keyHere(b)),
    moved: incoming.flatMap((b) => {
      const here = keyHere(b);
      return here && !carries(b) && normalizeUrl(dest(here)) !== normalizeUrl(dest(b))
        ? [{ backend: b, to: dest(b) }]
        : [];
    }),
  };
}

/** Write incoming secrets to the keyring, then re-derive every backend's
 *  hasApiKey from KEYRING TRUTH (imported key present, or one already stored
 *  on this machine) — so a synced "hasApiKey: true" can't claim a key that
 *  isn't actually available here. A key the read FAILED on keeps the local flag; only the
 *  store reporting it absent clears it. `rotated` = backends this device already knew
 *  whose stored credential the apply changed — a key replaced with a different one, or one
 *  added or removed (the keyring now disagrees with the live `hasApiKey`): their caps and
 *  connection state were measured as the old caller, so the caller evicts them, which also
 *  moves their credential generation for every reader keyed on it. */
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
  // Iterate the BACKENDS and read each key by id (`inboundSecret`), never the map itself: that is
  // O(backends) whatever the server put in `secrets`, and can never drop a legitimate key.
  // A key rotated on another device: read what this device stores BEFORE overwriting it, for
  // the backends it already runs. An unchanged rewritten key evicts nothing, and neither does a
  // degraded read (locked wallet, timed out) — the next connection test re-measures anyway.
  const known = new Set(useApp.getState().backends.map((b) => b.id));
  const candidates = list.map((b) => b.id).filter((id) => known.has(id) && inboundSecret(secrets, id) !== undefined);
  const prior = candidates.length
    ? await withTimeout(readBackendKeys(candidates), 10_000, null as Record<string, string> | null)
    : null;
  const rotated =
    prior === null
      ? []
      : candidates.filter((id) => {
          const old = ownProp(prior as Record<string, unknown>, id);
          return typeof old === "string" && old !== "" && old !== inboundSecret(secrets, id);
        });
  // An abort mid-loop still leaves the keys written so far replaced: report those as rotated.
  const written = new Set<string>();
  const landed = () => rotated.filter((id) => written.has(id));
  for (const b of list) {
    if (aborted()) return { backends: list, rotated: landed() };
    const id = b.id;
    const key = inboundSecret(secrets, id);
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
    readBackendKeyStates(list.map((b) => b.id)),
    10_000,
    null as BackendKeyRead | null,
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
  // A key the read could not get at (wallet prompt dismissed, platform error) was not read, not
  // removed — this function never deletes a key — so an `unreadable` id keeps its local flag like
  // a timeout's. One the store reports ABSENT clears it: a stale `true` (config copied from another
  // machine, wallet reset, entry deleted by hand) would otherwise hold every compose on the
  // degraded pass-through for good, and no restart could clear it.
  const unreadable = new Set(present?.unreadable ?? []);
  const backends = list.map((b) => {
    const held =
      present === null || unreadable.has(b.id)
        ? (localFlag.get(b.id) ?? false)
        : hasOwn(present.keys, b.id);
    return b.hasApiKey === held ? b : { ...b, hasApiKey: held };
  });
  // A key added to a backend this device runs is a credential change too: the generation must
  // move, or the editor's blank-key verdict and every per-caller fetch keyed on it keep the old
  // caller's answer. A degraded read keeps the local flags, so nothing flips (nor does a key the
  // read left out, above); a backend new to this device has no old caller.
  const flipped =
    present === null
      ? []
      : backends
          .filter((b) => known.has(b.id) && localFlag.has(b.id) && localFlag.get(b.id) !== b.hasApiKey)
          .map((b) => b.id);
  return { backends, rotated: [...new Set([...rotated, ...flipped])] };
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
 * While dictating nothing is applied — a mid-session hydrate would yank
 * profiles/backends out from under the session. A pull-apply re-pulls once the
 * session is idle (see `rePullAfterSession`); a one-shot restore just fails.
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
    // Not applied: the caller must NOT adopt the server's version as the new base, or the
    // peer's change is recorded as applied and never re-offered. A gate-respecting caller (a pull
    // or 409 reconcile) parks a re-pull for the end of the session (`pullParked`, memory-only, dies
    // on quit/supersede); an explicit one-shot restore (`ignoreGates`) never queues — its caller
    // reports the failure, and a re-pull it triggered later would only be a pointless sync.
    if (!opts.ignoreGates) pullParked = true;
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
  // reach the retry tail below — `return` inside the try skips it.
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

    // `isPlainObject`, not truthiness: Rust forwards the blob as opaque JSON, so `general` is
    // whatever the server put there. A STRING is truthy, and object rest-destructuring boxes it
    // into one key per code unit — a 4 MiB string (`SYNC_MAX_BODY`) becomes ~4M keys that
    // `typedLike` then copies into the store, on the unattended startup/focus pull.
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
        // The chord belongs to the `dictionary` category — migrateBlob moves it there on
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
        // Same rule as the hue: a malformed value keeps the current one (the engine would run garbage).
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
      // migrateBlob renamed or dropped the legacy auto-stop key already; never let it reach the
      // store beside the new one — Rust's serde alias rejects the whole Config on every save then.
      delete rec.latchAutoStopMin;
      nextSettings = {
        ...nextSettings,
        recording: {
          // Merge over THIS DEVICE'S block, like the `general` arm: an omitted key would otherwise
          // fall through to `hydrate`'s factory defaults — `saveRecordings: true` — and silently
          // re-enable plaintext archiving with no security change raised. A peer that wants it
          // off sends the literal `false`.
          ...settings.recording,
          ...typedLike(rec as Partial<typeof settings.recording>, settings.recording),
          // The folder is a machine path: applied only when this device's sub-toggle opts in
          // AND a well-typed value arrived; otherwise keep this device's folder no matter what.
          // `null` is a LEGITIMATE value ("use the default location", Rust Option<String>) and
          // must apply — treating it as "keep local" would let a peer's next push resurrect the
          // old path and silently revert a reset-to-default after one round trip.
          recordingsDir:
            gates.audioFolder && (typeof rec.recordingsDir === "string" || rec.recordingsDir === null)
              ? rec.recordingsDir
              : settings.recording.recordingsDir,
          audioBaseDir:
            gates.audioFolder && (typeof rec.audioBaseDir === "string" || rec.audioBaseDir === null)
              ? rec.audioBaseDir
              : settings.recording.audioBaseDir,
        },
      };
    }
    // The `transcription` category: same shape check, same merge-over-current rule as
    // `recording`. Only classified keys apply, so a crafted blob can't ride arbitrary keys
    // into the opaque transcribe blob.
    if (cats.transcription && isPlainObject(blob.transcription)) {
      const raw = blob.transcription as Record<string, unknown>;
      const classified = pickFields(raw, TRANSCRIPTION_FIELD_SET);
      const picks = gates.transcribePicks ? pickFields(raw, TRANSCRIPTION_PICK_SET) : {};
      const pulled = sanitizeTranscription({ ...classified, ...picks });
      // The translation-model pick names a model on its backend's server and travels with
      // backendId. A blob that carries it without any backendId (a pre-upgrade portable value)
      // keeps this device's own on a sync round; an explicit restore still applies it. An old
      // peer whose picks switch is off still passes the snapshot's backendId beside its own
      // model, which looks the same as a real pick, so that pair applies until every device
      // runs this version.
      if (!opts.ignoreGates && typeof pulled.backendId !== "string") delete pulled.translationModel;
      // Over nextSettings.transcribe, not settings.transcribe: the recording arm above
      // already routed the dictation-history flags in here.
      const transcribe = { ...nextSettings.transcribe, ...pulled };
      // The picks travel as one unit behind backendId. A peer's backend pick CLEARS its language
      // (an untouched one follows the Backend's) and JSON drops the undefined key, so a pick the
      // blob does not carry beside a carried backendId is cleared here too — merged over, this
      // device's old backend's language would stay pinned under the new backend and push back.
      // Omission is read on the RAW picks: a carried-but-malformed value keeps local, as the
      // sanitizer promises.
      if (typeof pulled.backendId === "string") {
        for (const k of TRANSCRIPTION_PICK_FIELDS) {
          if (k !== "backendId" && !hasOwn(picks, k)) delete transcribe[k];
        }
      }
      nextSettings = { ...nextSettings, transcribe };
    }
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
    // The `logging` category, merged over current. logDir is a machine path (gated like the
    // recording folders); null is a legitimate "use the default location".
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
    // The `chip` category — same merge-over-current rule as `recording`, and the mirror-image
    // field filter (only chip-classified keys may apply here).
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
    // isPlainObject, like every scalar arm: a malformed container (`[]`, a string) is truthy,
    // and `sanitizeBackends` would return `[]`, which the dangling-reference scrub below turns
    // into "every profile's backend is gone".
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
        gates.apiKeys ? blob.backends.secrets : undefined,
        () => gen !== myGen,
      );
      nextBackends = reconciled.backends;
      // A key rotated on another device keeps this device's serverUrl and hasApiKey, so
      // hydrate's own eviction misses it: drop the caps and connection state measured as the
      // OLD caller NOW, while the keyring write is what changed. Waiting for the hydrate lost
      // the eviction on a STALE restart or a dropped apply: the keyring already holds the new
      // key, so every later pass reads prior == incoming and finds nothing rotated. A key added
      // or removed counts too: hydrate would evict it, but moves no credential generation, so
      // the generation-keyed readers (the editor's verdict, decode defaults) kept the old caller.
      for (const id of reconciled.rotated) forgetCredential(id);
      // The ONLY await in this function, and the blob sizes it (sequential keyring writes, 10s
      // timeout apiece, up to 500 entries). Everything above came from a snapshot taken BEFORE
      // the wait and `hydrate` replaces it wholesale, so anything the user changed meanwhile —
      // including turning sync OFF — would be reverted and persisted. Restart rather than merge:
      // re-entering recomputes every derived value (dangling-reference scrub, conflict pass)
      // against current state. Bounded; on exhaustion the apply is dropped, not applied stale —
      // the next pull brings the blob back.
      // Compare every slice `hydrate` overwrites, not just `settings`: profile/app-rule edits
      // leave `settings` identical, and `nextBackends` is re-pinned against the PRE-wait list.
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
      // String-or-null only: a falsy non-string would skip the truthiness-gated scrub below
      // and wedge Rust's `Option<String>` (same as `quickAddList`).
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
      // Applied only when a backends LIST arrived in the same blob: without the referent list,
      // the dangling-reference scrub below can only compare against THIS device's backends, and
      // a peer's perfectly valid pin would null the local one.
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
      // transcript put in the buffer. `sanitizeAppRules` already drops the field; this re-pins
      // ours on a rule we know (a rule only the peer knows stays without it). Same contract as
      // the `general` strip.
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
    // (two enabled profiles on one chord, or one chord a strict subset of another). The app's
    // own save gate then refuses every later save for the session — including turning sync OFF
    // (`settings.sync` is part of `settings`) and the push of a correction — so the same blob
    // returns on the next launch. Disable the later member of each colliding pair instead: the
    // profile stays visible to re-enable, saving keeps working, and the local gate still stops
    // a genuine local mistake.
    //
    // "Profile shortcuts" off re-pinned every known profile to THIS device's chord above — but a
    // peer can still switch one on, or change its kind, so the pass compares those against this
    // device's copy before counting the binding as local.
    const resolved = disableConflictingProfiles(
      nextProfiles,
      nextSettings.general.quickAddHotkey,
      inboundProfiles !== null,
      nextSettings.general.evdevEnabled === true && evdevPermittedNow(),
      inboundProfiles !== null && !gates.profileHotkeys ? new Map(st.profiles.map((p) => [p.id, p])) : undefined,
      settings.general.quickAddHotkey,
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
        // The blob's `general` block was validated field-by-field above (including
        // `insertTiming`'s retired "off"), so no schema migration must run on it here.
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
    // from the blob before this point, and the typed Rust arg rejects `undefined` (silently,
    // given the catch).
    if (cats.general && isPlainObject(blob.general)) {
      void setDeepFieldDetection(nextSettings.general.deepFieldDetection).catch(() => {});
    }
  } catch (e) {
    if (e !== STALE) throw e;
  }
  // The retry runs OUTSIDE the try so the STALE sentinel of the recursive call is its own
  // (`applyingRemote` wraps only `hydrate`, so nothing is held across the recursion).
  // A session that started during the keyring wait must NOT park via the top-of-function branch:
  // only a top-level call may queue a re-pull. A retry that answers "not applied" here is final;
  // the caller (a reconcile re-offers on the next pull, a one-shot restore reports it) owns it.
  if (staleRestart) {
    if (useApp.getState().status !== "idle") return false;
    return applyBlob(blob, cats, retries - 1, opts);
  }
  // Dropped stale with no retry left (retries exhausted, or superseded): report "not applied" —
  // the caller must leave the base alone and let the next pull re-offer it.
  if (staleAbort) return false;
  return true;
}

let started = false;
let applyingRemote = false;
/** A pull-apply was refused because dictation ran: re-pull once the session is idle. */
let pullParked = false;
let state: SyncState = {};
/** sync-state.json exists but could not be read at launch (a Windows AV lock, an EIO): sync stays
 *  off until the next launch reads it. Every save replaces the whole file, so one made from the
 *  empty state would drop the merge base, version and stashed-key ids it holds. */
let stateUnreadable = false;
let device: SyncDeviceInfo | null = null;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let lastFocusPull = 0;
let inFlight = false;
/** A push the held-save gate refused (see pushNow): re-armed once a save lifts the hold, since
 *  the save that lifts it may come from a pull-apply the store subscriber ignores. */
let pushOwed = false;
/** Sync epoch. Bumped by supersede() when the target server changes (or sync
 *  toggles), so an in-flight pull/push against the OLD server can neither
 *  block the new server's first sync via `inFlight` nor write its late result
 *  over the new server's bookkeeping. Stale calls compare their captured epoch
 *  after every transport await and bail silently. */
let gen = 0;
/** Settles once launch is over: initSync's launch work (which holds `inFlight`) AND the startup
 *  pull it starts right after releasing the lock. Null outside that window. A manual Push / Pull
 *  clicked meanwhile awaits it instead of dropping at the `inFlight` gate; awaiting the launch
 *  work alone would wake with the startup pull holding the lock and drop all the same. */
let launchDone: Promise<void> | null = null;
/** Settles `launchDone` (and clears both) — set only for the startup pull, the part of launch a
 *  supersede may cut short; null during the launch work and outside launch. */
let endLaunch: (() => void) | null = null;

/** Categories turned ON (their gates) since the last adopted base. While a category is off its
 *  base is the server's copy passed through, so a 3-way merge would read this device's value as
 *  "changed here only" and push it over the peer's. Merged against a base without them instead
 *  (first contact for those categories): equal values merge, different ones raise the conflict
 *  dialog. Cleared when a base is adopted (`persistState` with a snapshot) and by a server
 *  switch; kept, and recorded in sync-state.json, across sync turned off and on and across a
 *  restart. */
const freshCats = new Set<SyncCategory>();

/** Settings turned ON since the last adopted base inside a category that already synced
 *  (`gatesTurnedOn`): the same hazard as `freshCats`, for one setting of a synced group. Judged
 *  apart from the rest of their category (`mergeFresh`): equal values merge, different ones ask
 *  about that setting only, and the category's other fields keep their 3-way merge. Same
 *  lifecycle as `freshCats` (cleared by an adopted base and a server switch, kept across sync
 *  off/on and a restart); one turned off again drops out. */
const freshGates = new Set<SettingId>();

/** Is any re-enabled category or setting still to be reconciled? */
function hasFresh(): boolean {
  return freshCats.size > 0 || freshGates.size > 0;
}

/** Record `freshCats` and `freshGates` in sync-state.json: a re-enabled category or setting whose
 *  reconcile has not landed (its dialog unanswered, its pull failed) must still be one after a
 *  restart — its gate is already ON then, so no OFF→ON transition would mark it again, and the
 *  startup pull's "nothing new" shortcut would push this device's value over the peer's. */
function persistFresh(): void {
  persistState(
    {
      freshCats: freshCats.size > 0 ? [...freshCats] : undefined,
      freshGates: freshGates.size > 0 ? [...freshGates] : undefined,
    },
    { stash: false },
  ).catch((e) => console.warn("sync: could not record the re-enabled categories", e));
}

/** The fresh settings by category, leaving out a category that is fresh as a whole. */
function freshGatesByCat(): Map<SyncCategory, SettingId[]> {
  const out = new Map<SyncCategory, SettingId[]>();
  for (const id of freshGates) {
    const c = DEFS.find((d) => d.id === id)?.category as SyncCategory | undefined;
    if (!c || freshCats.has(c)) continue;
    out.set(c, [...(out.get(c) ?? []), id]);
  }
  return out;
}

/** What a change of the sync settings from `prev` to `now` (same server) does to the re-enabled
 *  marks: the categories that came on whole, the settings that came on inside a category that
 *  already synced, and the marked ones that no longer sync (turned off again before their
 *  reconcile — nothing to ask about). The ONE rule the store subscriber and the launch work's
 *  twin both read. */
function freshTransition(prev: AppSettings["sync"], now: AppSettings["sync"]) {
  const prevGates = completeGates(prev?.sub, prev?.categories);
  const nowGates = completeGates(now?.sub, now?.categories);
  const prevCats = catsFromGates(prevGates);
  const on = catsFromGates(nowGates) as Record<SyncCategory, boolean>;
  return {
    on,
    cats: ALL_CATEGORIES.filter((c) => on[c] && !prevCats[c]),
    gates: gatesTurnedOn(prevGates, nowGates),
    prunedCats: [...freshCats].filter((c) => !on[c]),
    prunedGates: [...freshGates].filter((id) => !gateStillSyncs(nowGates, id)),
  };
}
type FreshTransition = ReturnType<typeof freshTransition>;

/** Apply a `freshTransition`; true when it marked or dropped anything. */
function markFreshFrom(t: FreshTransition): boolean {
  for (const c of t.prunedCats) freshCats.delete(c);
  for (const id of t.prunedGates) freshGates.delete(id);
  for (const c of t.cats) freshCats.add(c);
  for (const id of t.gates) freshGates.add(id);
  return t.prunedCats.length + t.prunedGates.length + t.cats.length + t.gates.length > 0;
}

/** Every merge's 3-way, with the re-enabled categories (`mergeBase`) and settings (`freshGates`)
 *  reconciled as first contact. A category holding fresh settings is merged in two halves: the
 *  rest of it 3-way, with the fresh settings made the remote's on every side (the base's first,
 *  so an element the remote deleted carries one value on every side too); then the fresh
 *  settings alone — this device's equal to the merge's, it merges; else the category is a
 *  conflict whose two sides (`local` / `remote` here, what a pick lands) differ in those
 *  settings only, so neither pick throws away the other side's edits to the rest of it. A
 *  conflict in the rest of it is the whole category's, as without fresh settings. A setting the
 *  remote holds nothing of is first contact for it (this device's value goes up, as the plain
 *  merge decides), and a degraded-keyring backends compose — the snapshot's list, not this
 *  device's — is left to the plain merge and the callers' keyring notice. */
function mergeFresh(local: SyncBlob, remote: SyncBlob): MergeResult & { local: SyncBlob; remote: SyncBlob } {
  const base = mergeBase();
  const res = mergeBlobs(base, local, remote);
  const byCat = freshGatesByCat();
  if (!base || byCat.size === 0) return { ...res, local, remote };
  const merged: SyncBlob = { ...res.merged };
  const conflicts = new Set(res.conflicts);
  let sides = { local, remote };
  for (const [c, all] of byCat) {
    const b = base[c];
    const l = local[c];
    const r = remote[c];
    // Absent on a side: nothing to judge the settings apart from — the plain merge decides.
    if (b === undefined || l === undefined || r === undefined) continue;
    if (c === "backends" && degradedComposes.has(local)) continue;
    // A setting the remote holds nothing of is first contact: kept out of the merge on every side
    // and this device's value laid back on afterwards, whatever the rest of the category does.
    const absent = all.filter((id) => !gatePartsPresent(c, id, r, MY_BUCKET));
    const ids = all.filter((id) => !absent.includes(id));
    const strip = (x: unknown) => (absent.length > 0 ? withGateParts(c, absent, x, {}, MY_BUCKET) : x);
    const mineOf = (x: unknown) => (absent.length > 0 ? withGateParts(c, absent, x, l, MY_BUCKET) : x);
    const part = (target: unknown, source: unknown) => withGateParts(c, ids, target, source, MY_BUCKET);
    const neutral = (x: unknown) => part(part(strip(x), b), r);
    const rest = mergeBlobs({ [c]: neutral(b) }, { [c]: neutral(l) }, { [c]: strip(r) });
    if (rest.conflicts.length > 0) {
      conflicts.add(c);
      continue;
    }
    const merge = mineOf(rest.merged[c]);
    const mine = part(merge, l);
    if (catEqual(mine, merge)) {
      (merged as Record<string, unknown>)[c] = merge;
      conflicts.delete(c);
      continue;
    }
    conflicts.add(c);
    (merged as Record<string, unknown>)[c] = mine; // placeholder: a conflicted category takes the pick
    sides = { local: { ...sides.local, [c]: mine }, remote: { ...sides.remote, [c]: merge } };
  }
  return { merged, conflicts: ALL_CATEGORIES.filter((c) => conflicts.has(c)), ...sides };
}

/** The 3-way base every merge uses: the adopted snapshot, minus the `freshCats`. */
function mergeBase(): SyncBlob | undefined {
  const b = state.snapshot;
  if (!b || freshCats.size === 0) return b;
  const out: SyncBlob = { ...b };
  for (const c of freshCats) delete (out as Record<string, unknown>)[c];
  return out;
}

/** The compose pass-through of a merge against `remote` (see `composeLive`): the snapshot, with
 *  each fresh category's taken from the remote, as first contact does — merged against a base
 *  without it, the snapshot's copy of a field this device does not sync would read as an edit
 *  of this device's and ask (and "Keep mine" pushed it over the peer's newer value). No base:
 *  the remote. */
function passThroughFor(remote: SyncBlob): SyncBlob {
  const b = state.snapshot;
  if (!b) return remote;
  if (freshCats.size === 0) return b;
  const out: SyncBlob = { ...b };
  for (const c of freshCats) {
    if (remote[c] === undefined) delete (out as Record<string, unknown>)[c];
    else (out as Record<string, unknown>)[c] = remote[c];
  }
  return out;
}

/** Invalidate whatever sync work is in flight or queued. Call BEFORE starting
 *  work against a different server (or after disabling sync). */
function supersede(): void {
  gen++;
  inFlight = false; // the superseded call skips its own reset (epoch mismatch)
  // A pull for the new server must not wait out the superseded startup pull (up to a keyring wait
  // plus the request timeout): that part of launch is over. Clicks parked on it wake and are
  // voided by their gen check. A supersede during the launch work itself (resetSyncState while
  // the keys are still being restored) leaves the wait alone: a click must not compose a push
  // against a base that has no keys yet.
  endLaunch?.();
  clearTimeout(pushTimer);
  pushOwed = false; // the new target starts with a pull, which pushes what it needs
  setPendingConflict(null); // a conflict against the old server is unresolvable now
  setPendingReview(null); // ditto for a held-back pull from the old server
  pullParked = false; // ditto a re-pull parked for the old server
}

/** A conflict awaiting the user's per-category picks in the Sync tab's conflict dialog. */
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
/** Monotonic identity for the CURRENT pending conflict (remote version, stamp, writer AND
 *  category list). ConflictDialog tags the user's picks with it and with `pendingConflictRemoteKey`,
 *  and resolveSyncConflicts refuses picks made on another id. A re-raise of the SAME conflict keeps
 *  it (see raiseConflict). */
let pendingConflictId = 0;
/** Monotonic identity for the pending conflict's REMOTE side alone (version, stamp, writer). A new
 *  remote starts the dialog's picks empty — a retained "remote" pick would silently hand the peer
 *  content the user never chose. A re-raise of the same remote over a changed category list (the
 *  resolve's widening re-merge, a focus pull, a 409) bumps the id but keeps this key, so the dialog
 *  keeps the picks for the categories still shown instead of putting every row back on "local". */
let pendingConflictRemoteKey = 0;
/** The Sync tab reads the pending conflict through this (set into the store
 *  would drag blob payloads through every subscriber). */
export function getPendingConflict(): {
  id: number;
  remoteKey: number;
  categories: SyncCategory[];
  remoteDevice: string | null;
} | null {
  return pendingConflict
    ? {
        id: pendingConflictId,
        remoteKey: pendingConflictRemoteKey,
        categories: pendingConflict.categories,
        remoteDevice: pendingConflict.remoteDevice,
      }
    : null;
}

/** Every write to the two pending prompts goes through these. The dialogs read them through the
 *  non-reactive getters (`getPendingConflict`, `getPendingReview`), so each change bumps
 *  `syncPromptSeq` for them to re-render on — the status line could not carry it: closing one
 *  prompt while its sibling waits writes the sibling's notice, unchanged, so no selector moved and
 *  the closed dialog stayed up doing nothing. */
function setPendingConflict(c: PendingConflict | null): void {
  if (pendingConflict === c) return;
  pendingConflict = c;
  promptsChanged();
}
function setPendingReview(r: PendingReview | null): void {
  if (pendingReview === r) return;
  pendingReview = r;
  promptsChanged();
}
function promptsChanged(): void {
  setRuntime({ syncPromptSeq: useApp.getState().syncPromptSeq + 1 });
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
  return Boolean(isTauri && !stateUnreadable && syncMeta()?.enabled && syncBackend());
}

/** Re-resolve the sync target AT the request and return its address, or `null` if the backend the
 *  caller captured is no longer the one to talk to.
 *
 *  `pullNow`/`pushNow` capture `backend` once at entry and then await real IPC (`ensureStateFor`,
 *  `composeBlob`'s up-to-10 s keyring read) before building the address, so
 *  `effectiveServerUrl(backend, live settings)` would mix a LIVE override map with a STALE
 *  `backend.serverUrl`. A push is routinely in flight while the user edits Settings, and a
 *  corrected sync address only schedules another push (dropped by the `inFlight` gate) — the
 *  in-flight PUT would still go to the ABANDONED host, with that backend's bearer key and, on the
 *  `cats.backends` path, EVERY backend's plaintext key in the body.
 *
 *  The `gen` epoch does not cover this: an address edit on the same backend never calls supersede(). */
function liveSyncTarget(captured: Backend): string | null {
  const live = syncBackend();
  if (!live || live.id !== captured.id || live.serverUrl !== captured.serverUrl) return null;
  return effectiveServerUrl(live, useApp.getState().settings);
}

/** Keyring account holding the snapshot's API keys. The snapshot is the 3-way merge base and,
 *  for a toggled-OFF backends category, the source of what gets pushed back — so it has to keep
 *  the real keys, but not in plaintext sync-state.json. In memory the snapshot is unchanged; only
 *  the on-disk copy is stripped. */
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
 *  it back silently under an "ok" status would stall every push behind a 409 — so say why. */
function degradedBaseWithheld(remoteBlob: SyncBlob): boolean {
  // A re-enabled backends category (`freshCats`) was never compared — the degraded compose passed
  // the remote's list through — so no base may say it was: the first unlocked pull asks.
  const fresh =
    freshCats.has("backends") || [...freshGates].some((id) => DEFS.find((d) => d.id === id)?.category === "backends");
  if (!fresh && catEqual(remoteBlob.backends, state.snapshot?.backends)) return false;
  setRuntime({
    syncStatus: "error",
    // While it waits, nothing goes up either (the push gate holds every push until the list is
    // compared): say so, not only that incoming changes wait.
    syncError: fresh
      ? "Your API keys couldn't be read from the keyring, so the server list (or a server-list setting) you turned on for sync can't be compared with the server's yet, and nothing is synced until then. Unlock it and restart the app to resume syncing."
      : "Your API keys couldn't be read from the keyring, so incoming backend changes are on hold. Unlock it and restart the app to resume syncing.",
  });
  return true;
}

/** Most UTF-16 code units one stash account holds. wincred refuses a credential over 2560 bytes,
 *  and keyring stores the password as UTF-16 — 1280 units — so a single-account stash of a dozen
 *  keyed backends (36-char ids) failed to write on Windows. Kept under that with headroom. */
const SNAPSHOT_CHUNK_UNITS = 1000;

/** Most stash accounts a recorded chunk count may name: `snapshotSecretChunks` is read back from
 *  sync-state.json, and a damaged value must not build a billion-entry account list. Above what
 *  any stash can reach — its keys came in a blob under the 4 MiB SYNC_MAX_BODY. */
const MAX_SNAPSHOT_CHUNKS = 8192;

/** The keyring account of stash chunk `i`. Chunk 0 is the legacy single account, so a one-chunk
 *  stash is byte-identical to the format before sharding and an old stash reads unchanged. Every
 *  chunk account stays inside the reserved `__…__` namespace that `isReservedBackendId` (and the
 *  store's `isReservedId`) reject: a backend id is its keyring account verbatim, so a peer's or an
 *  imported backend named after a chunk would otherwise read that slice of every key out through
 *  `readBackendKeys`, or overwrite and delete it. */
function snapshotChunkAccount(i: number): string {
  return i === 0 ? SNAPSHOT_SECRETS_ACCOUNT : `__sync_snapshot_secrets_${i}__`;
}

/** The recorded chunk count, as a usable number (absent or damaged → 1, the legacy stash). */
function snapshotChunkCount(n: unknown): number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_SNAPSHOT_CHUNKS ? n : 1;
}

/** Cut the stash JSON into account-sized chunks, never between the halves of a surrogate pair:
 *  a lone surrogate does not survive the IPC hop (serde replaces it), so the join would no longer
 *  parse. */
function snapshotChunks(json: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < json.length) {
    let end = Math.min(at + SNAPSHOT_CHUNK_UNITS, json.length);
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(json.slice(at, end));
    at = end;
  }
  return out;
}

/** Best-effort delete of stash chunks `from`..`to - 1`. In parallel: api.ts's keyring turn sends
 *  keyring writes one at a time in call order anyway, and one shared 10 s bound beats one per
 *  chunk under a locked wallet. */
async function dropSnapshotChunks(from: number, to: number): Promise<void> {
  const drops: Promise<void>[] = [];
  for (let i = from; i < to; i++) {
    drops.push(withTimeout(deleteBackendKey(snapshotChunkAccount(i)).catch(() => {}), 10_000, undefined));
  }
  await Promise.all(drops);
}

/** Write the stash `chunks` over a previous stash of `prevChunks` accounts. Every write is issued
 *  in the same tick: api.ts's keyring turn runs keyring calls one at a time in call order, so they
 *  all queue ahead of a `clearSnapshotSecrets` delete a reset issues afterwards (awaiting each in
 *  turn let that delete overtake later chunks, orphaning them). The outcome settles on the first
 *  failed (or timed out) write, or once every write landed, so a locked wallet does not park a
 *  sync for 10 s per chunk. A failed write deletes every chunk either stash may hold: a
 *  half-written stash, or the OLDER complete one paired with the new ids, would otherwise be read
 *  back on the next launch as garbage or as stale keys in the merge base; with nothing there it
 *  reads as missing and latches `snapshotSecretsUnavailable`. */
async function stashSnapshotSecrets(chunks: string[], prevChunks: number): Promise<void> {
  const writes = chunks.map((c, i) =>
    withTimeout(
      setBackendKey(snapshotChunkAccount(i), c).then(
        () => true,
        (e) => {
          console.error("snapshot keyring write failed", e);
          return false;
        },
      ),
      // Chunk i queues behind chunks 0..i-1 on that turn (a wallet-unlock prompt included), so
      // its bound grows with its place: 10 s for each write up to and including its own.
      10_000 * (i + 1),
      false,
    ),
  );
  // Rejects on the first false: Promise.all settles there without waiting out the later bounds.
  const ok = await Promise.all(writes.map((w) => w.then((v) => v || Promise.reject()))).then(
    () => true,
    () => false,
  );
  const to = Math.max(chunks.length, prevChunks);
  // Success: only the tail an earlier, larger stash left behind; no write is parked, so awaited.
  // Failure: everything, not awaited — issue order already queues it behind any parked write, and
  // awaiting would run out each delete's bound behind a locked wallet. It never rejects.
  if (ok) await dropSnapshotChunks(chunks.length, to);
  else void dropSnapshotChunks(0, to);
}

/** Put the snapshot's keys back after a load. */
async function restoreSnapshotSecrets(): Promise<void> {
  snapshotSecretsUnavailable = false;
  const ids = state.snapshotSecretIds ?? [];
  if (ids.length === 0) return;
  // Every chunk in ONE read (one 10 s bound, one wallet prompt). A missing chunk reads as an empty
  // stash, which the partial-read check below latches like a locked wallet.
  const accounts = Array.from({ length: snapshotChunkCount(state.snapshotSecretChunks) }, (_, i) =>
    snapshotChunkAccount(i),
  );
  const read = await withTimeout(readBackendKeys(accounts), 10_000, {} as Record<string, string>);
  const parts = accounts.map((a) => read[a]);
  let secrets: unknown = {};
  try {
    secrets = parts.every((p) => typeof p === "string") ? JSON.parse(parts.join("")) : {};
  } catch {
    secrets = {};
  }
  // A PRESENT empty string is the legacy stash format (older builds stashed a blank key as
  // `{id: ""}`), not a missing key — counting it as missing would latch the flag below on every
  // launch. The recorded list is left as is: the next `persistState` re-derives it, and a
  // still-set list is what makes it drop a stash left with nothing in it.
  const want = isPlainObject(secrets)
    ? ids.filter((id) => ownProp(secrets as Record<string, unknown>, id) !== "")
    : ids;
  if (want.length === 0) return;
  // Read with the same `inboundSecret` rule `persistState` writes with — own-property, non-empty
  // string, plain-object container. Own-property matters: a backend id of `constructor`/`toString`
  // would read a function off the prototype of a locked wallet's `{}` read-back, the partial-read
  // flag would never fire, and the pass-through push would erase the server's copy of that key.
  const got = want.filter((id) => inboundSecret(secrets, id) !== undefined);
  // A PARTIAL read-back is not a success: the whole point of the flag is to stop a pass-through
  // push from erasing the server's keys, and a partial map erases exactly the ones that are
  // missing. Only a complete read-back clears it.
  if (got.length < want.length) {
    snapshotSecretsUnavailable = true;
    console.warn("sync: snapshot keys unavailable — backends pass-through disabled this session");
    if (got.length === 0) return;
  }
  if (state.snapshot?.backends) {
    // Only the ids this snapshot actually recorded — a stale entry from an older snapshot must
    // not re-enter the blob and get pushed back to the server.
    state.snapshot.backends.secrets = Object.fromEntries(got.map((id) => [id, inboundSecret(secrets, id)!]));
  }
}

/** Forget the stashed snapshot keys — every one of the `chunks` accounts the stash spans (the
 *  caller passes the count it recorded, read BEFORE any state reset drops it). The stash is a JSON
 *  bundle of every backend's key, so a state reset that leaves it behind parks plaintext
 *  credentials in the OS secret store indefinitely, under an account name nothing in the UI ever
 *  surfaces. */
async function clearSnapshotSecrets(chunks: number | undefined): Promise<void> {
  snapshotSecretsUnavailable = false;
  await dropSnapshotChunks(0, snapshotChunkCount(chunks));
}

/** The keyring stash of the latest `persistState` while it is in flight (every write waits it out). */
let stashing: Promise<void> | null = null;

/** Split the snapshot's secrets out to the keyring (the file gets ids only) — `persistState`'s
 *  stash step. `prevChunks`: the accounts the stash spanned before the patch. */
async function stashSnapshot(prevChunks: number): Promise<void> {
  const secrets = state.snapshot?.backends?.secrets;
  // Iterate the snapshot's BACKEND LIST and read by id (as `reconcileBackendSecrets` does), never
  // the server-authored `secrets` map itself: these ids are persisted twice — to sync-state.json
  // AND inside the keyring stash read back at every launch. A `{"list":[],"secrets":{…350 000
  // junk ids…}}` fits SYNC_MAX_BODY and raises no SecurityChange (`securityChanges` iterates the
  // empty list), so it would apply unattended; `Object.keys` on a STRING `secrets` likewise yields
  // one id per code unit. The list is the bound that matters — `composeBlob` builds `secrets` from
  // the backend list, so legitimate keys are always a subset — and MAX_SYNCED_ENTRIES caps it.
  //
  // `inboundSecret` carries the container's shape check (plain object, own property), so a
  // non-object `secrets` reads undefined for every id and records none.
  const listed = Array.isArray(state.snapshot?.backends?.list) ? state.snapshot.backends.list : [];
  const ids: string[] = [];
  // Entries, not a `{}` written by index: an id of `__proto__` would hit the setter and drop out
  // of the stash while staying in `ids`, latching the flag on the next launch.
  const stash: [string, string][] = [];
  const seen = new Set<string>();
  for (const b of listed) {
    if (ids.length >= MAX_SYNCED_ENTRIES) break;
    const id: unknown = (b as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || seen.has(id)) continue;
    // Only a key the apply would write (`restoreSnapshotSecrets` drops an empty one).
    const key = inboundSecret(secrets, id);
    if (key === undefined) continue;
    seen.add(id);
    ids.push(id);
    stash.push([id, key]);
  }
  const hadStash = state.snapshotSecretIds !== undefined;
  state.snapshotSecretIds = ids.length > 0 ? ids : undefined;
  if (ids.length > 0) {
    // Stash the NARROWED map, not the original: stashing the attacker's map would put the ids
    // straight back into the keyring entry the id list was just bounded to keep out of.
    const chunks = snapshotChunks(JSON.stringify(Object.fromEntries(stash)));
    // Recorded before the writes, like the ids, and kept on failure: the failed stash is deleted
    // whole, so the next launch reads these accounts as missing and latches the refusal.
    state.snapshotSecretChunks = chunks.length > 1 ? chunks.length : undefined;
    await stashSnapshotSecrets(chunks, prevChunks);
  } else if (hadStash) {
    // The stash must never outlive the snapshot it belongs to. When the new snapshot carries no
    // secrets (locked wallet, or a remote snapshot with no backends category) nothing points at
    // the old bundle any more: `restoreSnapshotSecrets` returns early on an empty id list, and the
    // other `clearSnapshotSecrets` callers only fire on a server switch, a dead server document or
    // a reset — a plaintext bundle of every key would stay in the keyring indefinitely.
    state.snapshotSecretChunks = undefined;
    await clearSnapshotSecrets(prevChunks);
  }
}

async function persistState(patch: Partial<SyncState>, opts: { stash?: boolean } = {}): Promise<void> {
  if (stateUnreadable) {
    console.warn("sync state not saved: sync-state.json could not be read at launch, so it is kept as is");
    return;
  }
  // The accounts the CURRENT stash spans, before a patch can drop the count: a smaller stash
  // written below must delete the tail a larger one left.
  const prevChunks = snapshotChunkCount(state.snapshotSecretChunks);
  state = { ...state, ...patch };
  // A new base (or none): the categories turned on since are reconciled in it.
  if ("snapshot" in patch) {
    freshCats.clear();
    freshGates.clear();
    state.freshCats = undefined;
    state.freshGates = undefined;
  }
  // A bookkeeping-only write (`persistFresh`) leaves the keyring stash alone: re-deriving it from
  // a snapshot whose keys a locked keyring never restored would delete the stash and drop its ids,
  // which also lifts the refusal of a keyless backends push.
  if (opts.stash !== false) {
    const run = stashSnapshot(prevChunks);
    const mine = run.catch(() => {});
    stashing = mine;
    try {
      await run;
    } finally {
      if (stashing === mine) stashing = null;
    }
  }
  // A write waits out every stash in flight, not just its own or the one seen on entry: a newer
  // adoption records its ids before its keys land (a supersede frees the lock while the old stash
  // still runs), and a file written in between would pair the new ids with the old keyring
  // bundle. Each run clears the slot only while it is still its own, and the slot never rejects.
  while (stashing) await stashing;
  // `isPlainObject` on BOTH containers, on the half that PERSISTS: a server-supplied STRING
  // `backends` would be spread to one key per code unit. A 4 MiB string becomes a ~57 MB
  // sync-state.json that `initSync` re-parses into the 3-way merge base at every launch (every
  // merge then sorts 4M keys) and every later `persistState` re-spreads, degrading the install
  // long after the blob that caused it is gone.
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
  const stashChunks = state.snapshotSecretChunks;
  state = { deviceId: state.deviceId };
  // The old server's last sync says nothing about this one (forgetDeadDocument's reset too).
  setRuntime({ lastSyncedAt: null, lastSyncDevice: null });
  // The old server's snapshot is gone — but its stashed keys are NOT, unless we delete them.
  // The fresh state records no ids, so nothing would ever look for that entry again either.
  await clearSnapshotSecrets(stashChunks);
  await persistState({
    serverBackendId: backendId,
    version: 0,
    updatedAt: null,
    device: null,
  });
}

/** Compose this device as it is NOW (live store, gates, sub-settings, keyring). Every raiser and
 *  every consent re-judge goes through this one call: a re-judge is only sound if it composes
 *  exactly as the raisers do. `passThrough` fills what this device does not sync (OFF
 *  categories, gated-off fields, the other OS's rules, a degraded backends list): the base by
 *  default. A compose merged against a remote with NO base (first contact, or a re-created
 *  document's forgotten one) or with a category turned on since passes `passThroughFor(remote)`
 *  instead — with nothing to pass through, the gates delete those fields, the first-contact merge
 *  counts every one the remote carries as a local edit, and "Keep mine" would push them erased
 *  (the API keys among them).
 *  The store is read BEFORE the keyring wait (up to 10 s behind a wallet prompt), and applyBlob's
 *  stale guard only sees edits made during its own wait: an edit made during this one is in
 *  neither the compose nor the merge, so the apply hydrates over it and the retry pushes the old
 *  value as the base, leaving the edit's own push nothing to send. So compose again while the
 *  store moved underneath (bounded: a store that never settles goes up as last read). */
async function composeLive(
  cats: Record<SyncCategory, boolean>,
  passThrough: SyncBlob | undefined = state.snapshot,
): Promise<SyncBlob> {
  for (let attempt = 1; ; attempt++) {
    const s = useApp.getState();
    const blob = await composeBlob(
      { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
      cats,
      passThrough,
      { includeSecrets: true, sub: subSettings(), gates: settingGates() },
    );
    const now = useApp.getState();
    const moved =
      now.settings !== s.settings ||
      now.backends !== s.backends ||
      now.profiles !== s.profiles ||
      now.appRules !== s.appRules;
    if (!moved || attempt >= 3) return blob;
  }
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
    const read = await withTimeout(
      readBackendKeyStates(s.backends.map((b) => b.id)).catch(() => null),
      10_000,
      null as BackendKeyRead | null,
    );
    // An id the store reports ABSENT holds no key (a stale `hasApiKey`), which is what the store
    // holds — only a timeout, or a failed id of a backend that claims a key, leaves a rotation
    // unknowable. Counting the absent one as unread would ask on every backends conflict of every
    // approval; counting a keyless backend's failed id would ask whenever the wallet is locked.
    const failed =
      read === null ||
      !isPlainObject(read.keys) ||
      !Array.isArray(read.unreadable) ||
      s.backends.some((b) => b.hasApiKey && read.unreadable.includes(b.id));
    const prints: Record<string, string> = {};
    if (!failed) {
      for (const [id, key] of Object.entries(read.keys)) prints[id] = keyPrint(String(key));
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
 *  park in the keyring for seconds; a focus pull racing them would re-raise the review/conflict
 *  over an approval that had already landed. False when a supersede happened while waiting. */
async function takeSyncLock(myGen: number): Promise<boolean> {
  while (inFlight) {
    await new Promise((r) => setTimeout(r, 50));
    if (myGen !== gen) return false;
  }
  if (myGen !== gen) return false;
  inFlight = true;
  return true;
}

/** The idle-transition re-run of a pull-apply parked while dictation ran: a fresh pull under the
 *  engine lock, which re-merges the current server document against the live store, re-runs the
 *  security gates and adopts the base. Waits out a running pull/push instead of dropping on its
 *  `inFlight` — the reconcile that parked may still hold the lock (a review raise reads the
 *  keyring after its parked apply). Dropped on a supersede, which starts its own pull. */
async function rePullAfterSession(): Promise<void> {
  const myGen = gen;
  while (inFlight) {
    await new Promise((r) => setTimeout(r, 50));
    if (myGen !== gen) return;
  }
  if (myGen === gen && canSync()) await pullNow(true);
}

// The epoch of a manual Pull / Push already parked on launch (see the top of pullNow / pushNow):
// a later click of the same epoch folds into it; one after a supersede parks on its own, since the
// parked one will be voided.
let parkedPullGen: number | null = null;
let parkedPushGen: number | null = null;

/** A manual Push / Pull clicked during launch: wait it out (see `launchDone`), then wait out the
 *  lock as well, as rePullAfterSession does — a "Delete server copy" made during the launch work
 *  can still hold it (its keyring delete queues behind launch's keyring read), and two clicks
 *  parked on one launch wake together, the first taking it. False when a supersede (sync
 *  switched, server copy deleted) happened meanwhile — the click is void then. The caller takes
 *  the lock one await hop later, so it loops on `inFlight`. */
async function waitForLaunch(myGen: number): Promise<boolean> {
  if (launchDone) await launchDone;
  while (inFlight) {
    if (myGen !== gen) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return myGen === gen;
}

/** Pull the server blob and reconcile it into the running app. `manual` also
 *  re-applies when the version hasn't moved (a "make it so" button press). */
export async function pullNow(manual = false): Promise<void> {
  // A click made during launch runs once launch is over and the lock is free; further clicks of
  // the same kind meanwhile fold into it (the buttons stay enabled during the launch work, and
  // each forced run would be one more server write / re-apply). The re-check of `inFlight` after
  // each wait has no await before the take below: a twin parked on the same launch may have
  // taken the lock in the hop since waitForLaunch saw it free.
  if (manual && launchDone) {
    const clickGen = gen;
    if (parkedPullGen === clickGen) return;
    parkedPullGen = clickGen;
    try {
      do {
        if (!(await waitForLaunch(clickGen))) return;
      } while (inFlight);
    } finally {
      if (parkedPullGen === clickGen) parkedPullGen = null;
    }
  }
  return pullCore(manual);
}

/** pullNow past its launch park: takes the lock before its first await. initSync's startup pull
 *  calls it directly, as a forced pull may not park on the launch it ends itself. */
async function pullCore(manual: boolean): Promise<void> {
  const backend = syncBackend();
  if (!backend || !canSync() || inFlight) return;
  inFlight = true;
  const myGen = gen;
  // The failure a pull that contacts no server restores (pushNow's twin). Only one with a message:
  // a server switch clears syncError but leaves the old server's "error", and restoring that
  // would show a warn dot with no notice, carried over from the old server.
  // The held-save line only while the save it blamed is still held.
  const prior = useApp.getState();
  const priorError =
    prior.syncStatus === "error" &&
    prior.syncError &&
    !(prior.syncError === HELD_PUSH_ERROR && !configSaveHeld()) &&
    !pendingConflict &&
    !pendingReview
      ? prior.syncError
      : undefined;
  setRuntime({ syncStatus: "syncing", syncError: null });
  try {
    await ensureStateFor(backend.id);
    // Superseded while in the keyring: neither read the server nor stamp "ok" over the new epoch.
    if (myGen !== gen) return;
    const pullUrl = liveSyncTarget(backend);
    if (pullUrl === null) {
      // The target moved while we were in the keyring. Don't read the abandoned host — the next
      // window-focus pull runs against the corrected address on its own. Nothing was contacted:
      // an earlier failure stands, and so does a status a Reject / Later set meanwhile.
      if (useApp.getState().syncStatus !== "syncing") return;
      if (!pendingConflict && !pendingReview && priorError !== undefined)
        setRuntime({ syncStatus: "error", syncError: priorError });
      else idleStatus();
      return;
    }
    const res = await syncPull({ serverUrl: pullUrl, backendId: backend.id });
    if (myGen !== gen) return; // superseded mid-flight — this result is for the wrong server
    if (!res.ok || !res.state) {
      handleTransportFailure(res.status, res.error);
      return;
    }
    setRuntime({ syncUnsupported: false });
    // Defence in depth behind Rust's `accept()`, which already refuses a version past 2^53: as a
    // JS double it would lose precision, be PERSISTED as the base, and make every later
    // `sync_push` fail to deserialize `base_version: i64` — the device could never push again,
    // across restarts. A transport failure, not an adoption.
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
        setPendingReview(null);
        setPendingConflict(null);
        pullParked = false;
      }
      // An empty server has nothing to reconcile them with: the push seeds it.
      freshCats.clear();
      freshGates.clear();
      persistFresh();
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
    if (serverRecreated(remote.version, remote.updated_ts) && !(await forgetDeadDocument(myGen))) return;
    if (
      !manual &&
      remote.version === state.version &&
      !(hasFresh() && state.snapshot !== undefined && !pendingConflict && !pendingReview)
    ) {
      // Nothing new; a local drift (edits while offline) still pushes via the
      // hash check on the next push tick. idleStatus, not "ok": a conflict or review can wait at
      // this very version (a re-enabled category's, see `freshCats`) and keeps its notice.
      // A re-enabled category still to reconcile with no prompt waiting (pushNow's gate) is
      // reconciled against this very result instead: the shortcut's push would only start a
      // second, forced pull, with a false "Synced" in between.
      idleStatus();
      schedulePush();
      return;
    }
    await reconcileRemote(remote, myGen);
  } finally {
    if (myGen === gen) inFlight = false;
  }
}

/** The status line while sync-state.json could not be read at launch (see `stateUnreadable`). */
const STATE_UNREADABLE_ERROR =
  "Sync is paused until the app restarts: this device's record of the last sync (sync-state.json) could not be read, and syncing without it would lose that record.";

/** The status line of a sync this device's held config save stopped (see `configSaveHeld`): the
 *  save banner explains the hold, but the user can dismiss it. */
const HELD_PUSH_ERROR =
  "This device couldn't save its settings, so nothing was pushed. Fix the problem in the warning at the top (a failed save, or a shortcut used twice), then push again.";

/** Compose + push this device's state. No-ops when nothing sync-relevant
 *  changed since the last sync (hash match) unless `manual`. */
export async function pushNow(manual = false): Promise<void> {
  // The launch park and click folding, as in pullNow (the reasons are there).
  if (manual && launchDone) {
    const clickGen = gen;
    if (parkedPushGen === clickGen) return;
    parkedPushGen = clickGen;
    try {
      do {
        if (!(await waitForLaunch(clickGen))) return;
      } while (inFlight);
    } finally {
      if (parkedPushGen === clickGen) parkedPushGen = null;
    }
  }
  let backend = syncBackend();
  if (!backend || !canSync() || inFlight) return;
  // Don't propagate a state the local save-gate froze (hotkey conflict) or
  // couldn't persist — sync ships what config.json holds, not a maybe. Read from persistence,
  // not the save banner: dismissing the banner leaves the change just as unsaved.
  if (configSaveHeld()) {
    // A click retries the held save first: a disk that recovered with no edit since has nothing
    // else to re-issue it. Still held (a conflict freeze, a disk still failing) — say so, unless a
    // prompt's notice owns the line; an automatic push stays a silent drop. Either way the push
    // is owed to the save that lifts the hold. Bounded (10 s): a write that hangs leaves the hold
    // standing, and the click must still answer.
    if (manual) await withTimeout(retryHeldConfigSave(), 10_000, undefined);
    if (configSaveHeld()) {
      pushOwed = true;
      if (manual && !pendingConflict && !pendingReview) setRuntime({ syncStatus: "error", syncError: HELD_PUSH_ERROR });
      return;
    }
    // The wait let anything change: re-check, with no await between this and the take below.
    backend = syncBackend();
    if (!backend || !canSync() || inFlight) return;
  }
  // A category turned on since the last base (`freshCats`) is reconciled with the server first —
  // equal values merge, different ones ask — instead of this device's value going up over the
  // peer's; that pull pushes what it needs once it adopts a base. While its conflict or review
  // waits, nothing goes up (no base was adopted, so the server may still be at this one).
  // No base: nothing to merge against, so nothing to wait for (an empty server's pull seeds it
  // with exactly this push, and gating it turned that into a pull loop).
  if (hasFresh() && state.snapshot !== undefined) {
    if (!pendingConflict && !pendingReview) void pullNow(true);
    return;
  }
  pushOwed = false;
  inFlight = true;
  const myGen = gen;
  // The failure a push that contacts no server restores — not a prompt's own notice, which a
  // Reject / Later meanwhile may have dismissed.
  const prior = useApp.getState();
  // The held-save line is not restored: past the gate, the save it blamed has landed.
  const priorError =
    prior.syncStatus === "error" && prior.syncError && prior.syncError !== HELD_PUSH_ERROR && !pendingConflict && !pendingReview
      ? prior.syncError
      : undefined;
  /** End a push that contacted no server: a status another writer set meanwhile (a Reject /
   *  Later, an approve) stands, an earlier failure is restored, else the idle status. */
  const endWithoutServer = () => {
    if (useApp.getState().syncStatus !== "syncing") return;
    if (!pendingConflict && !pendingReview && priorError !== undefined)
      setRuntime({ syncStatus: "error", syncError: priorError });
    else idleStatus();
  };
  setRuntime({ syncStatus: "syncing", syncError: null });
  try {
    await ensureStateFor(backend.id);
    // Superseded (sync turned off, server copy deleted) while an await parked: no status write
    // below may land over the reset state. inFlight was already reset by supersede().
    if (myGen !== gen) return;
    const cats = syncCats();
    let blob = await composeLive(cats);
    // The keyring read in composeBlob can park up to 10 s — superseded meanwhile: never send.
    if (myGen !== gen) return;
    let base = state.version ?? 0;
    if (!manual && hashBlob(blob) === state.hash && base > 0) {
      // Nothing to send — but a pending prompt adopts no base, so ANY store edit lands here while
      // it waits: restore its notice (cleared by the "syncing" above) instead of "Synced" next to
      // the dialog. Likewise a push that contacts no server must not overwrite an earlier
      // failure (a failed pull, a refused keyring read) with "Synced".
      endWithoutServer();
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
        // Past the first attempt an earlier one reached the (old) server, so a prior failure is stale.
        if (attempt === 0) endWithoutServer();
        else if (useApp.getState().syncStatus === "syncing") idleStatus();
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
        // A conflict body is the sync API answering, as a pull's 200 is: an earlier 404's
        // "doesn't support settings sync" must not hide the notices this arm raises.
        setRuntime({ syncUnsupported: false });
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
        if (serverRecreated(remote.version, remote.updated_ts)) {
          if (!(await forgetDeadDocument(myGen))) return;
        }
        // Normalize a pre-split peer's blob before merging — the 3-way base and the local
        // compose are already in the current shape.
        const remoteBlob = migrateBlob((remote.blob ?? {}) as SyncBlob);
        // ALWAYS recompose from the live store: `blob` was read before the PUT (or is the last
        // attempt's merge), so an edit made while the request was on the wire is in neither it
        // nor the merge — and applying the merge would hydrate over that edit, push the old value
        // and adopt it as the base, while the edit's own push then found nothing to send.
        // No base (first contact, or the re-created document's just forgotten) or a fresh category:
        // the remote fills the pass-through (see `passThroughFor`), as in reconcileRemote — the
        // pre-PUT compose filled those slots from the dead snapshot or from nothing.
        // No keyring-refusal re-check: the forget cleared the stash latch with the snapshot it
        // guarded, and a locked keyring now passes the REMOTE's backends through (marked
        // degraded), which the arms below hold out of the apply and withhold as a base.
        blob = await composeLive(
          syncCats(),
          state.snapshot === undefined || freshCats.size > 0 ? passThroughFor(remoteBlob) : undefined,
        );
        if (myGen !== gen) return;
        const { merged, conflicts } = mergeFresh(blob, remoteBlob);
        if (conflicts.length > 0) {
          raiseConflict({ categories: conflicts, merged, local: blob, remote: remoteBlob,
            remoteVersion: remote.version, remoteDevice: remote.device ?? null,
            remoteUpdatedAt: remote.updated_ts ?? null });
          return;
        }
        // Auto-merged: adopt the merge locally, then retry on the new base. Honour the user's
        // opt-outs, and leave the backends category out of a degraded-keyring compose's apply,
        // as reconcileRemote does.
        const syncedCats = syncCats();
        const degraded = backendsDegraded(blob, syncedCats);
        const pushCats = degraded ? { ...syncedCats, backends: false } : syncedCats;
        // A 409 merge adopts remote values too, so it gets the same consent gate as a pull.
        const riskyPush = gatedSecurityCheck(merged, blob, pushCats);
        if (riskyPush.length > 0) {
          const applyNow = heldBack(pushCats, riskyPush);
          const landed = await applyBlob(merged, applyNow);
          if (myGen !== gen) return; // superseded during the apply wait
          // The gates the apply ran under, then the keyring read — which parks up to 10 s, so the
          // epoch is checked AGAIN after it: a supersede meanwhile dropped every pending prompt on
          // purpose, and raising this one would revive the old server's review in the new state.
          const gatesSig = gatesSignature();
          const storeSig = await storeSignature(pushCats);
          if (myGen !== gen) return;
          raiseReview({
            changes: riskyPush, blob: merged, cats: pushCats, remote: remoteBlob,
            applied: landed ? appliedAt(pushCats, applyNow) : categorySelection(false),
            storeSig, gatesSig,
            version: remote.version, updatedAt: remote.updated_ts ?? null, device: remote.device ?? null,
            pushAfter: true, degraded,
          });
          return;
        }
        const applied = await applyBlob(merged, pushCats);
        if (myGen !== gen) return; // superseded during the apply wait
        if (!applied) {
          // Refused (dictation live) or dropped: no base adopted and nothing pushed, the next pull
          // re-offers it. Clear the 'syncing' this call set, as reconcileRemote's twin does —
          // without hiding a prompt that still waits, or overwriting a Reject / Later meanwhile.
          if (useApp.getState().syncStatus === "syncing") idleStatus();
          return;
        }
        // Applied without the degraded backends category: adopt the base and keep pushing only
        // when the remote left that category alone (see `degradedBaseWithheld`).
        if (degraded && degradedBaseWithheld(remoteBlob)) return;
        // A second 409 recomposes `blob` first, and that compose re-derives the degraded flag.
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
  // Normalize a pre-split peer's blob before merging (the base and local are current-shape).
  const remoteBlob = migrateBlob((remote.blob ?? {}) as SyncBlob);
  // With no base, or for a fresh category, the remote fills what this device does not sync
  // (see `composeLive`).
  const local = await composeLive(cats, passThroughFor(remoteBlob));
  if (myGen !== gen) return; // superseded — don't apply the old server's blob
  const { merged, conflicts } = mergeFresh(local, remoteBlob);
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
  // This pull is unattended (startup + every window focus). A security-relevant change (a
  // repointed backend, a swapped key, a typed-text or retention change: see `catOf`) is held
  // for confirmation instead of being adopted silently.
  const risky = gatedSecurityCheck(merged, local, applyCats);
  if (risky.length > 0) {
    // Everything else still applies — only the categories with a held-back change wait.
    // Deliberately no persistState here: adopting the server's version as the new base would
    // drop the held-back change, so the next pull re-offers it until the user decides.
    const applyNow = heldBack(applyCats, risky);
    const landed = await applyBlob(merged, applyNow);
    if (myGen !== gen) return; // superseded during the apply wait — the review is for a dead epoch
    // Same re-check after the keyring read as pushNow's 409 twin.
    const gatesSig = gatesSignature();
    const storeSig = await storeSignature(applyCats);
    if (myGen !== gen) return;
    raiseReview({
      changes: risky, blob: merged, cats: applyCats, remote: remoteBlob,
      applied: landed ? appliedAt(applyCats, applyNow) : categorySelection(false),
      storeSig, gatesSig,
      version: remote.version, updatedAt: remote.updated_ts ?? null,
      device: remote.device ?? null, pushAfter: true, degraded,
    });
    return;
  }
  const applied = await applyBlob(merged, applyCats);
  // Epoch FIRST: a supersede during applyBlob's keyring wait also answers false, and any status
  // write below would then land over the reset state (pushNow's 409 twin's order).
  if (myGen !== gen) return;
  if (!applied) {
    // Refused (dictation live) or dropped. Persist no base so the next pull re-offers the blob —
    // the same rule the held-back-review path documents above. No base means no
    // dropSupersededPending either, so a waiting prompt keeps its notice — and a Reject / Later
    // pressed meanwhile keeps its status (pushNow's 409 twin).
    if (useApp.getState().syncStatus === "syncing") idleStatus();
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
    // Any answer but a 404 is the sync route answering: the Sync tab hides `syncError` while an
    // earlier 404's "doesn't support settings sync" stands, so this must clear it. Status 0 (no
    // answer at all) tells nothing about the route and leaves it.
    setRuntime({ syncStatus: "error", syncUnsupported: false, syncError: "The server rejected the API key." });
  } else {
    // An empty error page (a proxy's bare 502/503) carries no detail: still name the status, or
    // the Sync tab shows a warn dot with no notice.
    setRuntime({
      syncStatus: "error",
      ...(status > 0 ? { syncUnsupported: false } : {}),
      syncError: error?.trim() || (status ? `Sync failed (HTTP ${status}).` : "Sync failed."),
    });
  }
}

/** One pulled change worth stopping for. Everything a sync server can change is applied
 *  silently EXCEPT these: where the microphone audio goes, which credential travels with it,
 *  what the app types, and what this device keeps, deletes or reports. A sync server is remote
 *  and may be hostile or intercepted, and the pull runs unattended at startup and on every window
 *  focus — so these get the same explicit consent the file-import path already asks for. */
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
  /** The backend a `backends`-category change applies to; the recording and retention kinds have
   *  no backend and set this to an empty string (the dialog omits it). A `typed-text` change names
   *  the backend or profile whose decode defaults carry the text. */
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
  /** The profile or backend the change belongs to. Part of the review identity (`changeKey`):
   *  two entries with the same shown name — two blank ones both read "Untitled profile" — are
   *  still two rows, so one added after the review was raised re-raises it. */
  id?: string;
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
 *  `PendingReview.applied` — only when that apply answered "applied": one refused while dictating
 *  (or dropped stale) landed nothing, and the raisers record `categorySelection(false)` instead.
 *  Claiming it landed would let an approval keep a later live edit over a peer value the store
 *  never received, adopt the base and push the edit over the peer's change.
 *  The dictionary's pin applies only together with the backends list (applyBlob's `cats.backends`
 *  check), so holding backends back also withholds the peer's pin: the dictionary then did NOT
 *  fully land, and an edit to it while the review waits must ask. */
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

/** The local side for `securityChanges`, with a truthful `backends` container: a degraded-keyring
 *  compose re-sends the snapshot's category, which is MISSING when the snapshot holds none, and a
 *  missing container would read as "this device has no backends" — every server backend, even
 *  ones this device already holds byte-identically, would be reported as "new" and park sync on a
 *  review. `secrets: {}` keeps the api-key comparison fail-closed (an incoming key still raises a
 *  review). */
function localForReview(local: SyncBlob): SyncBlob {
  if (local.backends) return local;
  return { ...local, backends: { list: useApp.getState().backends, secrets: {} } };
}

/**
 * `securityChanges` over an incoming blob and the local one, both gated by the SAME
 * `settingGates()` snapshot — the consent sites (409 merge, unattended pull, approval re-judge,
 * conflict resolution) must never diverge in how they gate the two sides.
 */
function gatedSecurityCheck(
  incoming: SyncBlob,
  localBlob: SyncBlob,
  cats: Record<SyncCategory, boolean>,
): SecurityChange[] {
  const g = settingGates();
  return securityChanges(gateScalars(incoming, g), gateScalars(localForReview(localBlob), g), cats, g);
}

/** A consent row's label: the raw name only when it renders as something (the dialog shows it
 *  through `safeIdentityText`, which drops the invisible head — joiners included — and folds a
 *  spaces-, invisible- or format-only name to nothing, so a joiner-only name counts as blank),
 *  else "" so the caller falls back to the "Untitled …" label the lists use or the address. */
const shownName = (n: unknown): string => (typeof n === "string" && safeIdentityText(n, 80) ? n : "");

/** A consent row's profile/backend label, from the entry's LOCAL copy when this device holds one
 *  (`local ?? incoming` at the call sites): every row of one entry then reads the same in one
 *  dialog — not the typed-text row under a peer's new name beside server-url and api-key rows
 *  under the local one — and a known entry with a blank name is labelled by its own address,
 *  not by a name or address the other device chose. */
const entryLabel = (e: { name?: unknown; serverUrl?: unknown }, category: "profiles" | "backends"): string =>
  shownName(e.name) ||
  (category === "profiles" ? "Untitled profile" : (typeof e.serverUrl === "string" && e.serverUrl) || "Untitled backend");

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
    const local = here.get(e.id);
    const cur = local?.decodeOverrides ?? {};
    const name = entryLabel(local ?? e, category);
    for (const key of TYPED_TEXT_KEYS) {
      const v = next[key];
      if (typeof v !== "string" || v === "" || v === cur[key]) continue;
      out.push({
        kind: "typed-text",
        id: e.id,
        backend: name,
        category,
        detail: typedTextDetail(key, v),
      });
    }
  }
  return out;
}

const typedTextDetail = (key: DecodeKey, v: string): string => `${DECODE_KEYS[key].env} would type ${JSON.stringify(v)}`;

/** The longest `typedTextDetail` the sanitizer lets through: every code point of a full-length
 *  value escaped to its widest JSON form (a lone surrogate → `\udXXX`, six characters). */
const TYPED_TEXT_DETAIL_MAX = Math.max(
  ...[...TYPED_TEXT_KEYS].map((k) => typedTextDetail(k, "").length + 6 * (keySpec(k).maxLen ?? 512)),
);

/** How many code points of a consent row's `detail` the review dialog shows. A typed-text row is
 *  the user's only view of what would be typed into the focused window after every dictation, so
 *  it is never cut: at the 200 every other row uses, a peer's 512-character suffix could put a
 *  harmless head in front and the escaped newline plus command behind the "…". */
export const consentDetailCap = (kind: SecurityChange["kind"]): number =>
  kind === "typed-text" ? TYPED_TEXT_DETAIL_MAX : 200;

/** Report only the security-relevant differences between what a pull would apply and what this
 *  device holds. `local` is the freshly composed local blob, so its `backends.secrets` already
 *  reflects the keyring — no extra wallet read here. */
export function securityChanges(
  incoming: SyncBlob,
  local: SyncBlob,
  cats: Record<SyncCategory, boolean>,
  gates?: Partial<Pick<Gates, "modelDecodeDefaults" | "serverAddresses" | "apiKeys">>,
): SecurityChange[] {
  const out: SecurityChange[] = [];
  // The retention windows drive sweeps that DELETE stored data (saved recordings; dictation
  // sessions incl. audio; file transcripts incl. their audio copies). Only a change that starts
  // deleting, or deletes sooner, needs consent — lengthening the window (or turning retention
  // off) destroys nothing.
  //
  // Typed reads, because the merged blob reaches here before applyBlob's typedLike pass. `norm`
  // mirrors what the apply does to an incoming value: the u32 key drops anything that is not a
  // whole non-negative number (typedLike's U32_KEYS), the two transcription-settings keys round
  // and clamp to 0..3650 (sanitizeTranscription). So a window the apply can never land (`"3"`,
  // -1, 0.3, 2.5) raises no review and parks no category. `undefined` from `norm` is "dropped":
  // the apply keeps the local days, so it reads as no change.
  const days = (
    container: unknown,
    key: string,
    fallback: number,
    norm?: (v: number) => number | undefined,
  ): number => {
    // An ABSENT key is "no change" on the apply side (the arms merge over current), so it must
    // not be read as the app default — a peer with this row's sync switch off omits it, and the
    // default would raise a consent dialog for a deletion that can't happen. A non-numeric value
    // (null, a string) is dropped by the apply side too, which keeps the local days.
    const v = isPlainObject(container) ? ownProp(container, key) : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return norm ? (norm(v) ?? fallback) : v;
  };
  const asU32 = (v: number) => (Number.isInteger(v) && v >= 0 && v <= 0xff_ff_ff_ff ? v : undefined);
  const clamp3650 = (v: number) => Math.max(0, Math.min(3650, Math.round(v)));
  const pushIfSooner = (hereDays: number, nextDays: number, what: string, kind: SecurityChange["kind"]) => {
    if (nextDays !== hereDays && nextDays !== 0 && (hereDays === 0 || nextDays < hereDays)) {
      out.push({
        kind,
        backend: "",
        detail:
          hereDays === 0
            ? `${what} older than ${plural(nextDays, "day")} would start being deleted (currently kept forever)`
            : `${what} would be deleted after ${plural(nextDays, "day")} instead of ${fmtFull(hereDays)}`,
      });
    }
  };
  // The `recording` category looks like styling but carries settings with real consequences:
  // retention windows drive sweeps that DELETE saved recordings and their transcripts,
  // `saveRecordings` turns on a permanent plaintext archive of everything dictated, and the
  // history and report-target-app switches below delete or send data. They get the same
  // confirmation as a repointed server.
  if (cats.recording && incoming.recording) {
    if (incoming.recording.saveRecordings === true && local.recording?.saveRecordings !== true) {
      out.push({
        kind: "save-recordings",
        backend: "",
        detail: "every dictation would be saved to this device as audio and text",
      });
    }
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
    // Strictly more destructive than the retention clock beside it: Rust's retention sweep
    // wipes EVERY dictation record the moment this reads false, on the next config save.
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
  // non-zero of the two (Rust's `effective_dictation_days`, Settings' `dictDays`). Judged
  // per key, a change that only lengthens the effective window (audio 0 + record 7 → 30/30)
  // would ask consent for "currently kept forever" recordings, so compare that one value.
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
  // Judge the lists the apply KEEPS: `applyBlob` installs `sanitizeProfiles`/`sanitizeBackends`
  // output, which drops a malformed entry, a reserved id, a duplicate id's later copy and
  // everything past the entry cap. Text on an entry the apply discards would otherwise raise a
  // typed-text row and park the whole category for an approval that changes nothing.
  if (cats.profiles && incoming.profiles) {
    out.push(...typedTextChanges(sanitizeProfiles(incoming.profiles.list), local.profiles?.list, "profiles"));
  }
  // Backend decode defaults travel only under the "Model & decode defaults" switch; with it off
  // the apply re-pins a KNOWN backend's values, so a peer's text cannot land there. A backend new
  // to this device has nothing local to re-pin and keeps its inbound overrides (like its
  // serverUrl below), so its text is still held for review.
  // One sanitized list for the whole backends gate: `sanitizeBackends` also floors the shape (a
  // non-array container, a non-string id/serverUrl), so the gate cannot throw on anything the
  // server sends — a throw would escape `void pullNow()` and leave syncStatus stuck on "syncing".
  if (!cats.backends || !incoming.backends) return out;
  const inBackends = sanitizeBackends(incoming.backends.list);
  const here = new Map((local.backends?.list ?? []).map((b) => [b.id, b]));
  out.push(
    ...typedTextChanges(
      gates?.modelDecodeDefaults !== false ? inBackends : inBackends.filter((b) => !here.has(b.id)),
      local.backends?.list,
      "backends",
    ),
  );
  const localSecrets = local.backends?.secrets ?? {};
  // Walk the entries `applyBlob` INSTALLS, as for profiles above (a dropped entry's rows would
  // also re-raise on every pull), and a blanked scheme would show an address the transport never
  // receives. Fail-closed still holds: the apply stores exactly this list and
  // `reconcileBackendSecrets` writes keys only for its ids.
  for (const b of inBackends) {
    const cur = here.get(b.id);
    const name = entryLabel(cur ?? b, "backends");
    // A backend new to this device keeps its inbound address even with "Server addresses" off
    // (there is nothing local to re-pin), so `new-backend` is raised regardless of the gates.
    // A KNOWN backend's address change, or an incoming key with "API keys" off, can never land —
    // applyBlob re-pins serverUrl / drops inbound secrets — so raising them would make approval a
    // no-op and a rejection re-raise on every pull.
    // An empty `serverUrl` is `sanitizeBackends` blanking an unsupported scheme: say so rather
    // than render a blank target. `url` stays empty so the repoint footer stays off.
    if (!cur) {
      out.push({ kind: "new-backend", id: b.id, backend: name, detail: b.serverUrl || "(no address)", url: b.serverUrl });
    } else if (
      gates?.serverAddresses !== false &&
      normalizeUrl(cur.serverUrl) !== normalizeUrl(b.serverUrl)
    ) {
      out.push({
        kind: "server-url",
        id: b.id,
        backend: name,
        detail: `${cur.serverUrl || "(no address)"} → ${b.serverUrl || "(none: the address would be cleared)"}`,
        url: b.serverUrl,
      });
    }
    // Only an actual value change counts: an unchanged key rides along in every push. But the
    // comparison must FAIL CLOSED — `localSecrets` can be empty because the keyring read degraded
    // (a locked wallet) or because a backend has no key yet, and requiring a known local value
    // would let an incoming key be written with no review in exactly the cases we can least
    // verify.
    // Own-property reads: an inbound id is whatever the blob chose, and `isReservedBackendId`
    // rejects only the `__…__` namespace — so `toString`/`constructor` otherwise make both maps
    // return the same inherited function (comparison false, no prompt) or mislabel the detail line
    // as "the stored key would be replaced" for a key that does not exist locally.
    // The incoming side goes through `inboundSecret`, the same reader the apply writes with.
    const incomingKey = inboundSecret(incoming.backends.secrets, b.id);
    const localKey = ownProp(localSecrets, b.id);
    if (gates?.apiKeys !== false && incomingKey && cur && incomingKey !== localKey) {
      out.push({
        kind: "api-key",
        id: b.id,
        backend: name,
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
  /** The categories the raise's apply landed (`appliedAt` over `heldBack(cats, changes)` THEN);
   *  `categorySelection(false)` when that apply did not land (refused while dictating, or its
   *  retries exhausted). Kept across a relist: recomputing it from the relisted rows would count
   *  a category that was held back at the raise, and whose rows no longer show, as applied — and
   *  keep a live edit over a peer value the store never received. Kept (with `gatesSig`) across
   *  a re-raise of the same server version whose apply was refused too: that apply changed
   *  nothing, so the earlier landed one still holds. */
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
  /** The raise's held-back apply landed the rest of the update: the dialog may say "everything
   *  else was applied already" only then — an apply refused while dictating landed nothing. */
  restApplied: boolean;
} | null {
  return pendingReview
    ? {
        changes: pendingReview.changes,
        device: pendingReview.device,
        relisted: pendingReview.relisted === true,
        restApplied: Object.values(pendingReview.applied).some(Boolean),
      }
    : null;
}

function raiseReview(r: PendingReview): void {
  // A review adopts no base, so every push / focus pull re-raises it: keep the "the list changed
  // since you read it" notice while it is still the same list, or the next re-raise (a debounced
  // push 409s right back into the review) would wipe it seconds after it appeared.
  if (pendingReview?.relisted && !r.relisted && sameReview(pendingReview, r)) r = { ...r, relisted: true };
  // A re-raise whose apply was refused (dictating) changed nothing in the store: the earlier
  // raise's landed apply, and the gates it ran under, still describe it — or the dialog would say
  // nothing was applied yet and the approval would re-ask over categories that already landed.
  // The new `storeSig` stays (same as a relist): it is the store as it is now. Same server
  // version and writer, whatever the rows: an edit or a gate turned on since changes the list,
  // not what the earlier apply landed (a relist keeps `applied` across a new list too), and
  // approveLocked asks wherever today's gates differ from the kept `gatesSig`.
  if (
    pendingReview &&
    !Object.values(r.applied).some(Boolean) &&
    Object.values(pendingReview.applied).some(Boolean) &&
    pendingReview.version === r.version &&
    pendingReview.device === r.device
  ) {
    r = { ...r, applied: pendingReview.applied, gatesSig: pendingReview.gatesSig };
  }
  setPendingReview(r);
  // A conflict against an older server version is moot now: the server moved past it.
  if (pendingConflict && pendingConflict.remoteVersion < r.version) setPendingConflict(null);
  reviewStatus();
}

/** The status a pending review shows, at the raise and wherever another notice clears while the review still waits. */
function reviewStatus(): void {
  setRuntime({
    syncStatus: "error",
    syncError:
      "A pulled update wants to change where your dictation is sent, what it types, or what is kept on this device — review it in Settings → Sync.",
  });
}

/** A base at `version` was just adopted (a clean pull, or a push the server accepted): a review
 *  or conflict raised against that version or an older one describes a server state that is
 *  gone — another device took the change back, or this one now agrees. Left up, the dialog would
 *  sit next to "Synced" and its Apply would re-land the withdrawn change and move the base
 *  backwards. */
function dropSupersededPending(version: number): void {
  if (pendingReview && pendingReview.version <= version) setPendingReview(null);
  if (pendingConflict && pendingConflict.remoteVersion <= version) setPendingConflict(null);
}

/** Two server `updated_ts` stamps name the same write. Not `===`: a persisted base's stamp went
 *  through serde_json (no `float_roundtrip`) and the state file, whose best-effort float parse can
 *  bring a 17-digit `time.time()` back one ULP off — strict equality would then read the unchanged
 *  server copy as a re-created document after a restart and forget a live base. A real delete +
 *  re-seed is never within a millisecond of the old write. */
const sameStamp = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-3;

/** The server's document at `version` is not the one this device's base or pending prompts were
 *  built on: server versions only grow, so a version BELOW the base or below a pending prompt's
 *  means the document was deleted and re-created — a peer's "Delete server copy" followed by its
 *  re-seed, seen by a device that missed the empty window. A re-seed can also land EXACTLY on the
 *  base's number: the server stamps `updated_ts` on every write and every base persists its own
 *  write's stamp, so the same version with a different stamp is a different document. Missed,
 *  it would take the "nothing new" shortcut, and the next push at that base would overwrite the
 *  re-seed. */
function serverRecreated(version: number, updatedTs: number | null | undefined): boolean {
  // Built on `atVersion` (stamped `atTs`), yet the server now holds another document there.
  const restamped = (atVersion: number, atTs: number | null | undefined) =>
    version > 0 &&
    version === atVersion &&
    typeof atTs === "number" &&
    typeof updatedTs === "number" &&
    !sameStamp(updatedTs, atTs);
  const base = state.version ?? 0;
  return (
    version < base ||
    restamped(base, state.updatedAt) ||
    // The prompts too: each carries the stamp it was raised at, and a re-seed climbing back to
    // exactly a prompt's number would otherwise approve (or resolve) the dead document's blob
    // as the base — and the follow-up push at that number overwrites the re-seed.
    (pendingReview !== null &&
      (pendingReview.version > version || restamped(pendingReview.version, pendingReview.updatedAt))) ||
    (pendingConflict !== null &&
      (pendingConflict.remoteVersion > version ||
        restamped(pendingConflict.remoteVersion, pendingConflict.remoteUpdatedAt)))
  );
}

/** Forget a base (and every prompt) that describes a server document which no longer exists, and
 *  re-seed from version 0, as resetSyncState does for the deleting device. A kept base would make
 *  the next push skip on the hash match or carry a stale baseVersion — at a re-created document's
 *  matching number it would overwrite the peer's re-seed blind — and a 3-way merge against the
 *  dead snapshot would drop or conflict the wrong categories; a kept prompt is never dropped
 *  (numbering restarts at 1) and approving it would re-land the deleted doc's change. False when
 *  superseded during the keyring or state writes. */
async function forgetDeadDocument(myGen: number): Promise<boolean> {
  await clearSnapshotSecrets(state.snapshotSecretChunks);
  if (myGen !== gen) return false;
  // `snapshotSecretIds` too: left set, persistState sees a stash to drop and runs a second
  // keyring delete (another 10 s timeout under a locked wallet) for the one cleared above.
  await persistState({
    version: 0,
    updatedAt: null,
    device: null,
    hash: undefined,
    snapshot: undefined,
    snapshotSecretIds: undefined,
    snapshotSecretChunks: undefined,
  });
  if (myGen !== gen) return false;
  setPendingReview(null);
  setPendingConflict(null);
  pullParked = false;
  setRuntime({ lastSyncedAt: null, lastSyncDevice: null });
  return true;
}

/** A change's identity for "was this row on the list the user saw". */
function changeKey(c: SecurityChange): string {
  return JSON.stringify([c.kind, c.category ?? null, c.id ?? null, c.backend, c.detail, c.url ?? null]);
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
  // Never run a consented apply behind a live dictation: applyBlob would refuse it and park a
  // re-pull for the session's end, which only re-raises this review — the click would be
  // consumed for nothing. Leave the review up instead; the dialog says why.
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
  // After the release: the push takes the lock itself. "done" still re-arms the debounced push:
  // a store edit made just before the click fired its pushNow into this lock and was dropped,
  // and nothing else re-sends it (the hash check makes it a no-op otherwise). Not "prompt": a
  // push then only 409s back into it (the edit goes out with the answer), re-running the
  // held-back apply for nothing.
  if (outcome === "push") schedulePush(0);
  else if (outcome === "done") schedulePush();
}

/** What approveLocked left behind: "push" — applied, and the merged doc differs from the
 *  server's; "done" — nothing more to do; "prompt" — a relisted review or a conflict is up. */
type ApproveOutcome = "push" | "done" | "prompt";

/** approvePendingReview's body, run under the engine lock. */
async function approveLocked(r: PendingReview, myGen: number): Promise<ApproveOutcome> {
  // A base at or past the reviewed version was adopted meanwhile: the review is moot. At the
  // base's own version only with no fresh category waiting: a reconcile of one raises at the
  // version the base already holds, and adopting a base clears `freshCats`.
  const v0 = state.version ?? 0;
  if (v0 > r.version || (v0 === r.version && !hasFresh())) {
    setPendingReview(null);
    setRuntime({ syncStatus: "ok", syncError: null });
    return "done";
  }
  // The categories this device syncs NOW, within the raise's: turning one off does not supersede
  // the review (only an ON transition re-pulls), so approving under `r.cats` would land e.g. the
  // peer's whole server list on a device that had just opted out of it. The compose, the judge
  // and the apply all run under these; the store signature stays on `r.cats`, like `r.storeSig`.
  const live = syncCats();
  const cats = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, r.cats[c] && live[c]])) as Record<
    SyncCategory,
    boolean
  >;
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
  // next time, and the reviewed value went back over it. An edit landing during either keyring
  // wait (the signature's, or the compose's, which recomposes when the store moved) is therefore
  // in `localNow` only: `movedMid` spans both waits and then counts every conflicting category as
  // edited (keep the live value, or ask), never as the reviewed value going back over it.
  const st0 = useApp.getState();
  const sigNow = await storeSignature(r.cats);
  if (myGen !== gen || pendingReview !== r || useApp.getState().status !== "idle") return "done";
  // With no base, the remote is the pass-through, as the raisers compose (see `composeLive`).
  const localNow = await composeLive(cats, passThroughFor(r.remote));
  if (myGen !== gen || pendingReview !== r || useApp.getState().status !== "idle") return "done";
  const st1 = useApp.getState();
  const movedMid =
    st0.settings !== st1.settings ||
    st0.backends !== st1.backends ||
    st0.profiles !== st1.profiles ||
    st0.appRules !== st1.appRules;
  // The keyring can lock between the raise and this approval: a degraded compose carries the
  // base's (or remote's) backends category, not this device's list, so the merge reads backends
  // as "local unchanged" and the apply below wrote that list over every backend added here.
  // Hold the category out as resolveLocked does — `r.degraded` alone only knows the raise.
  const degradedNow = backendsDegraded(localNow, cats);
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
  const re = mergeFresh(localNow, r.remote);
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
    setPendingReview(null);
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
  // Judge under the categories the apply below runs with: a degraded keyring holds backends out
  // of it, so judging them under `cats` relisted rows (a peer's stored keys) that never land.
  const applyCats = degradedNow ? { ...cats, backends: false } : cats;
  const now = gatedSecurityCheck(blobNow, localNow, applyCats);
  const shown = new Set(r.changes.map(changeKey));
  if (now.some((c) => !shown.has(changeKey(c)))) {
    // Judged against the store as it is now: a later approval compares against that. The gates
    // and `applied` stay the raise's — the store still holds that apply, stripped fields and all.
    raiseReview({ ...r, blob: blobNow, changes: now, relisted: true, storeSig: sigNow });
    return "prompt";
  }
  setPendingReview(null);
  const applied = await applyBlob(blobNow, applyCats);
  if (myGen !== gen) return "done";
  if (!applied) {
    // Not applied (a session started mid-apply, or the store kept changing under it): put
    // the review back so the approval isn't consumed by an apply that never happened.
    setPendingReview(r);
    return "prompt";
  }
  // Same degraded-keyring rule as the paths that raised it: the remote becomes the base only when
  // it left the backends category alone, or the next unlocked push reverts the peer's change.
  // The raise's flag counts only while backends still syncs (`live`: a degraded raise already
  // holds backends out of `r.cats`, so `cats` cannot tell): turned off since, nothing is held for
  // it, and reconcileRemote adopts the base then too (`backendsDegraded` is off with it).
  if (((r.degraded && live.backends) || degradedNow) && degradedBaseWithheld(r.remote)) return "done";
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
  setPendingReview(null);
  // Also drops a pull-apply parked while dictation ran, so nothing lands behind a refusal.
  pullParked = false;
  // A conflict raised at the review's own version (a push 409ing next to it) still waits: keep
  // its notice rather than a blank status next to its dialog.
  if (pendingConflict) conflictStatus();
  else setRuntime({ syncStatus: "idle", syncError: null });
}

/** Test seam: raise a minimal conflict so the id contract is pinnable without a transport. The
 *  default version is one past the current base, as a real conflict's is — one below it, or at it
 *  with no fresh category waiting, is moot (resolveLocked). */
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

/** Test seam: run the launch-time snapshot-key restore for recorded `ids` (the keyring read goes
 *  through `readBackendKeys`, which a test mocks) and report whether it blocked the backends
 *  pass-through and which keys it put back into the snapshot. */
export async function restoreSnapshotSecretsForTests(
  ids: string[],
  chunks?: number,
): Promise<{ blocked: boolean; restored: Record<string, string> | undefined }> {
  state = { snapshot: { backends: { list: [] } }, snapshotSecretIds: ids, snapshotSecretChunks: chunks };
  await restoreSnapshotSecrets();
  return { blocked: backendsPushBlocked(), restored: state.snapshot?.backends?.secrets };
}

/** Test seam: stash a snapshot carrying `secrets` (one listed backend per id) through
 *  persistState's writer, over whatever stash the previous call recorded (the keyring writes go
 *  through `setBackendKey`/`deleteBackendKey`, which a test mocks), and report what it recorded. */
export async function persistSnapshotSecretsForTests(
  secrets: Record<string, string>,
): Promise<{ ids: string[]; chunks: number | undefined }> {
  state = {
    snapshotSecretIds: state.snapshotSecretIds,
    snapshotSecretChunks: state.snapshotSecretChunks,
    snapshot: { backends: { list: Object.keys(secrets).map((id) => ({ id })) as never, secrets } },
  };
  await persistState({});
  return { ids: state.snapshotSecretIds ?? [], chunks: state.snapshotSecretChunks };
}

/** Test seam: is a re-pull parked for the end of the dictation session? */
export function hasPendingApplyForTests(): boolean {
  return pullParked;
}

function raiseConflict(c: PendingConflict): void {
  // A pending conflict adopts no base, so every focus pull / 409 re-raises it: keep the id when it
  // is the SAME conflict (same server version, write stamp, writer and categories — so the same
  // remote content, and a retained "remote" pick hands over nothing unseen), or the dialog
  // remounts and resets the user's half-made picks on every window switch. The remote key keeps
  // over a changed category list alone: the remote content is the same, so the dialog keeps the
  // picks for the categories it still shows (see pendingConflictRemoteKey).
  const sameRemote =
    pendingConflict !== null &&
    pendingConflict.remoteVersion === c.remoteVersion &&
    (pendingConflict.remoteUpdatedAt === c.remoteUpdatedAt ||
      (pendingConflict.remoteUpdatedAt !== null &&
        c.remoteUpdatedAt !== null &&
        sameStamp(pendingConflict.remoteUpdatedAt, c.remoteUpdatedAt))) &&
    pendingConflict.remoteDevice === c.remoteDevice;
  const same = sameRemote && pendingConflict!.categories.join() === c.categories.join();
  if (!sameRemote) pendingConflictRemoteKey++;
  if (!same) pendingConflictId++;
  setPendingConflict(c);
  // Same rule as raiseReview: a review against an older server version is moot now.
  if (pendingReview && pendingReview.version < c.remoteVersion) setPendingReview(null);
  conflictStatus();
}

function conflictStatus(): void {
  setRuntime({
    syncStatus: "error",
    syncError:
      "Both this device and another changed the same settings — resolve the conflict in Settings → Sync.",
  });
}

/** The status a sync that adopted no base ends on: a prompt adopts none either, so it still
 *  waits — restore its notice (the call's "syncing" cleared it) instead of "Synced" next to the
 *  dialog. A conflict takes precedence over a review. */
function idleStatus(): void {
  if (pendingConflict) conflictStatus();
  else if (pendingReview) reviewStatus();
  else setRuntime({ syncStatus: "ok" });
}

/** Apply the user's per-category picks, then adopt + push the result. */
export async function resolveSyncConflicts(
  choices: Record<string, "local" | "remote">,
  /** The id of the conflict the picks were made on (`getPendingConflict().id`). A different one
   *  is pending — a re-raise over more categories, or another conflict — and the picks do not
   *  describe it: a category missing from `choices` fell to this device's value unasked. */
  expectedId?: number,
): Promise<void> {
  if (!pendingConflict) return;
  if (expectedId !== undefined && pendingConflictId !== expectedId) return;
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
  const v0 = state.version ?? 0;
  if (v0 > c.remoteVersion || (v0 === c.remoteVersion && !hasFresh())) {
    setPendingConflict(null);
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
  // With no base, the remote is the pass-through, as the raisers compose (see `composeLive`).
  const localNow = await composeLive(syncedCats, passThroughFor(c.remote));
  if (myGen !== gen || pendingConflict !== c || useApp.getState().status !== "idle") return "done";
  // `c.merged` was merged against the raise-time local: an edit made here since (to a category
  // only this device changed) would be hydrated back to its old value. Re-merge against the live
  // compose, and if that conflicts on a category the user was never asked about, ask again.
  const re = mergeFresh(localNow, c.remote);
  if (re.conflicts.some((cat) => !c.categories.includes(cat))) {
    raiseConflict({ ...c, categories: re.conflicts, merged: re.merged, local: localNow });
    return "prompt";
  }
  setPendingConflict(null);
  const final: SyncBlob = { ...re.merged };
  for (const cat of c.categories) {
    // The re-merge's sides: a category holding a re-enabled setting differs there only (`mergeFresh`).
    const src = choices[cat] === "remote" ? re.remote : re.local;
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
  // Judged under applyCats, as approveLocked does: a degraded keyring holds backends out of both
  // the judge and the apply.
  // The security gate runs here too, not only on the clean-merge path: `final` carries every
  // non-conflicting category auto-resolved in the server's favour, and the conflict dialog shows
  // only the conflicting category names, so a peer that also touched a locally edited category
  // (forcing this branch) would ride its backend repoint / key swap in unreviewed. Same shape as
  // reconcileRemote: apply everything else, hold the flagged categories back, and persist no
  // base so a rejection is re-offered on the next pull.
  const risky = gatedSecurityCheck(final, localNow, applyCats);
  if (risky.length > 0) {
    const applyNow = heldBack(applyCats, risky);
    const landed = await applyBlob(final, applyNow);
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
      applied: landed ? appliedAt(applyCats, applyNow) : categorySelection(false),
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
    setPendingConflict(c);
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
  setPendingConflict(null);
  pullParked = false; // "Later" also drops a pull-apply parked while dictation ran (re-offered next pull)
  // Same as rejectPendingReview: a review at this version still waits — keep its notice.
  if (pendingReview) reviewStatus();
  else setRuntime({ syncStatus: "idle", syncError: null });
}

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
  // Hold the engine lock across the launch work: until loadSyncState and the keyring restore
  // (up to 10 s on a locked wallet) land, the base has no keys, so a "Push now" clicked meanwhile
  // composed a pass-through push against it and shipped a keyless backends list over the server's
  // keys. An automatic trigger dropped at the gate loses nothing — the startup pull below runs
  // after release; a manual Push / Pull clicked meanwhile waits for launch and that pull, then runs.
  const myGen = gen;
  inFlight = true;
  let launchEnded!: () => void;
  const thisLaunch: Promise<void> = new Promise<void>((r) => {
    launchEnded = () => {
      // A supersede may have ended this launch already and a later one begun: leave that alone.
      if (launchDone !== thisLaunch) return;
      launchDone = endLaunch = null;
      r();
    };
  });
  launchDone = thisLaunch;
  // The sync settings the launch work started from: the store subscriber is armed only after it,
  // so the startup pull below compares against these to catch an edit made meanwhile.
  let launchSync: AppSettings["sync"];
  try {
    await configReady;
    launchSync = useApp.getState().settings.sync;
    try {
      state = (await loadSyncState()) ?? {};
    } catch (e) {
      // Not "no state": the file is there but locked. Sync stays off for this launch (the
      // launch fails below) rather than starting from {} and saving that over the merge base.
      stateUnreadable = true;
      setRuntime({ syncStatus: "error", syncError: STATE_UNREADABLE_ERROR });
      throw e;
    }
    // Normalize a pre-split snapshot to the current category layout. Without this the 3-way
    // base stays old-shape while fresh composes are new-shape, so the first sync after an
    // upgrade would read EVERY category as changed-on-both-sides and raise spurious conflicts.
    if (state.snapshot) state.snapshot = migrateBlob(state.snapshot); // non-object snapshot → {}
    // The re-enabled categories a previous run had not reconciled yet (see `persistFresh`) — only
    // known ones still ON, and only with a base to merge against. The file is untrusted input.
    freshCats.clear();
    freshGates.clear();
    if (state.snapshot) {
      const gates = completeGates(launchSync?.sub, launchSync?.categories);
      const on = catsFromGates(gates);
      for (const c of Array.isArray(state.freshCats) ? state.freshCats : []) {
        if ((ALL_CATEGORIES as readonly unknown[]).includes(c) && on[c as SyncCategory]) freshCats.add(c as SyncCategory);
      }
      // A setting known to this version whose sync is still on (`gateStillSyncs` reads the id).
      for (const id of Array.isArray(state.freshGates) ? state.freshGates : []) {
        if (typeof id === "string" && gateStillSyncs(gates, id as SettingId)) freshGates.add(id as SettingId);
      }
    }
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
    // next save strips it and every launch regenerates (and re-writes) a new one. An id already
    // loaded wins: Rust hands out an unsaved fresh one when its own read of the file failed.
    if (device?.deviceId && !state.deviceId) state.deviceId = device.deviceId;

    // Migrate pre-serverBackendId state files: they were only ever written for
    // the currently configured sync server, so stamp that identity instead of
    // letting ensureStateFor() wipe a perfectly good snapshot on first contact.
    // The server the launch started from (`launchSync`), not the live one: a switch during the
    // launch work would stamp the old server's state as the new one's base.
    if (state.version && !state.serverBackendId && launchSync?.backendId) {
      await persistState({ serverBackendId: launchSync.backendId });
    }

    if (state.updatedAt) {
      setRuntime({
        lastSyncedAt: Math.round((state.updatedAt as number) * 1000),
        lastSyncDevice: state.device ?? null,
      });
    }
  } catch (e) {
    launchEnded(); // no startup pull follows: release a waiting click (it finds the gate open)
    throw e;
  } finally {
    if (myGen === gen) inFlight = false; // a resetSyncState mid-launch superseded and took its own
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
      // A pull-apply parked while dictation ran: re-pull once the session lands back at idle
      // rather than re-applying a held blob. That direct re-apply ran outside the engine lock
      // and adopted no base, so a pull landing a newer version during its keyring wait got the
      // older blob hydrated back over it (and the next push shipped the revert). Only
      // gate-respecting callers park (applyBlob never parks an `ignoreGates` restore).
      if (pullParked && s.status === "idle" && prev.status !== "idle") {
        pullParked = false;
        void rePullAfterSession();
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
    // Gates turned ON or OFF on the same server, whether sync is on or not (`freshCats`): the base
    // survives sync turned off and on again, and so must the mark — a gate turned on while sync
    // was off is as unreconciled as one turned on while it ran.
    const fresh = prevSync && nowSync && prevSync.backendId === nowSync.backendId ? freshTransition(prevSync, nowSync) : null;
    const markFresh = (): boolean => (fresh ? markFreshFrom(fresh) : false);
    if (nowSync?.enabled && (!prevSync?.enabled || prevSync.backendId !== nowSync.backendId)) {
      supersede();
      // A server switch: the old server's base is not this one's. The same server turned back
      // on keeps its base, and with it the categories still to reconcile.
      if (prevSync?.backendId !== nowSync.backendId) {
        freshCats.clear();
        freshGates.clear();
      } else markFresh();
      persistFresh();
      setRuntime({ syncUnsupported: false, syncError: null });
      void pullNow(true);
      return;
    }
    // Sync switched off: cancel queued/in-flight work and clear stale status (the base and the
    // categories still to reconcile stay for when it comes back on).
    if (prevSync?.enabled && !nowSync?.enabled) {
      supersede();
      if (markFresh()) persistFresh();
      setRuntime({ syncStatus: "idle", syncError: null });
      return;
    }
    if (!nowSync?.enabled) {
      if (markFresh()) persistFresh();
      return;
    }
    // A category toggled ON (via the per-setting gates), or one more setting of a category that
    // already syncs, is reconciled with the server before anything is pushed (`freshCats`,
    // `freshGates`): the same value merges, a different one asks. Keyed on the gates, not the raw
    // `sync.categories` map: that has had no writer since the manifest list replaced the category
    // rows.
    if (fresh) {
      // A dialog that still asks about a category, or a setting, turned off again is re-raised
      // without it (or dropped) by a fresh reconcile.
      const prunedIn = new Set<SyncCategory>([
        ...fresh.prunedCats,
        ...fresh.prunedGates.map((id) => DEFS.find((d) => d.id === id)?.category as SyncCategory),
      ]);
      const stale = !!pendingConflict?.categories.some((c) => prunedIn.has(c));
      if (fresh.cats.length > 0 || fresh.gates.length > 0 || stale) {
        supersede();
        markFresh();
        persistFresh();
        void pullNow(true);
        return;
      }
      if (markFresh()) persistFresh();
    }
    schedulePush();
  });

  // A push the held-save gate refused goes out once a save lifts the hold: that save may come
  // from a pull-apply (ignored by the subscriber above) or a retry, with no store edit to re-arm it.
  onConfigSaveHoldCleared(() => {
    if (!pushOwed) return;
    pushOwed = false;
    schedulePush(0);
  });

  // Focus pull (throttled): catches "changed it on the other machine".
  window.addEventListener("focus", () => {
    const now = Date.now();
    if (now - lastFocusPull < 5000) return;
    lastFocusPull = now;
    void pullNow();
  });

  // Launch ends with the startup pull (pullCore takes the lock before its first await, so no click
  // released below can slip in ahead of it), or here when there is none. Only this pull may be cut
  // short by a supersede (a server switch must not wait it out). Sync turned on, the server
  // switched or a gate turned ON during the launch work never reached the subscriber, so the pull
  // is forced as its arms would have made it: an automatic one finding the server version
  // unchanged skips the reconcile and pushes this device's value over the peer's. It goes through
  // pullCore, as pullNow(true) would park on this very launch.
  // Gate transitions during the launch work on the same server, whether or not sync is on now
  // (the subscriber, armed only now, never saw them), are marked as its gate arm would have; a
  // server switch leaves nothing of the old base to reconcile against.
  const nowSync = useApp.getState().settings.sync;
  const sameServer = !!launchSync && launchSync.backendId === nowSync?.backendId;
  let turnedOnDuringLaunch = false;
  if (!sameServer) {
    if (hasFresh()) {
      freshCats.clear();
      freshGates.clear();
      persistFresh();
    }
  } else if (launchSync !== nowSync) {
    const fresh = freshTransition(launchSync, nowSync);
    if (markFreshFrom(fresh)) persistFresh();
    turnedOnDuringLaunch = fresh.cats.length > 0 || fresh.gates.length > 0;
  }
  if (canSync()) {
    // Forced also by a category still to reconcile, from this launch or recorded before a restart.
    const forced = !launchSync?.enabled || !sameServer || turnedOnDuringLaunch || hasFresh();
    endLaunch = launchEnded;
    void pullCore(forced).then(launchEnded, launchEnded);
  } else launchEnded();
}

/** Plain-language failure line for "Delete server copy". Server text is peer/attacker
 *  authored, so it is defanged like the warnings channel. */
export function deleteFailureMessage(r: { ok: boolean; status: number; error?: string | null }): string {
  const detail = safeDisplayText(r.error ?? "", 200);
  if (r.status === 401 || r.status === 403) {
    return "The server rejected the API key — the stored settings were not deleted.";
  }
  if (r.status === 0) {
    return `Could not reach the server — the stored settings were not deleted.${detail ? ` (${detail})` : ""}`;
  }
  if (r.status === 404) {
    return "This server doesn't support settings sync — nothing was deleted.";
  }
  return `The server refused to delete the stored settings (${r.status}).${detail ? ` ${detail}` : ""}`;
}

/** The sync status "Delete server copy" writes for the server's answer; only an `ok` one goes on
 *  to `resetSyncState`. A 404 is NOT "already gone": the backend answers an empty store with 200
 *  `deleted: false`, so a 404 is the route itself missing (an old build, a proxy not forwarding
 *  it) — read as a pull's 404 is, and the local base kept, or a copy still stored there merges
 *  back with none. Any other answer, success included, is the sync route answering and clears an
 *  earlier 404's "doesn't support settings sync": that notice would hide a failure (the Sync tab
 *  shows `syncError` only while the flag is clear) and contradict a success. Status 0 (no answer
 *  at all) tells nothing about the route. */
export function deleteAnswerRuntime(r: {
  ok: boolean;
  status: number;
  error?: string | null;
}): Parameters<typeof setRuntime>[0] {
  // A 2xx is the sync route answering too; `resetSyncState` writes the rest of the status.
  if (r.ok) return { syncUnsupported: false };
  return {
    syncStatus: "error",
    ...(r.status === 404 ? { syncUnsupported: true } : r.status > 0 ? { syncUnsupported: false } : {}),
    syncError: deleteFailureMessage(r),
  };
}

/** For the Sync tab's "Delete server copy": forget local bookkeeping so the
 *  next push recreates from version 0. */
export async function resetSyncState(): Promise<void> {
  // The file could not be read at launch: it is kept as is (and the paused notice stays up). The
  // next launch reads it, and its pull finds the server copy gone like any other device's would.
  if (stateUnreadable) return;
  supersede();
  // Hold the lock across the keyring delete (up to 10 s on a locked wallet): supersede() freed it,
  // and a push or pull started in that window passed its gate, PUT at base 0 and adopted v1 — which
  // the writes below then overwrote with version 0 and no snapshot, so the next push hit a needless
  // conflict and "Last synced" went blank right after a sync. A trigger dropped at the gate loses
  // nothing: the reset state has no hash, so the next one sends everything.
  const myGen = gen;
  inFlight = true;
  try {
    const stashChunks = state.snapshotSecretChunks;
    state = { deviceId: state.deviceId, serverBackendId: state.serverBackendId };
    await clearSnapshotSecrets(stashChunks); // no snapshot left — drop its stashed keys with it
    await persistState({ version: 0, updatedAt: null, device: null, hash: undefined, snapshot: undefined });
    setRuntime({ lastSyncedAt: null, lastSyncDevice: null, syncStatus: "idle", syncError: null });
  } finally {
    if (myGen === gen) inFlight = false;
  }
}
