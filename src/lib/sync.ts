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
    openAtLogin: g.openAtLogin,
    // evdevEnabled is machine-local: deliberately absent.
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
  return list
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
      activation: oneOf<ActivationKind>((p as Profile).activation, ACTIVATIONS, "hold"),
      // Rendered as React CHILDREN (`<Badge>{p.endpoint}</Badge>`, `languageLabel(p.language)`,
      // which returns its argument unchanged when the code is unknown) — an object leaf throws
      // "Objects are not valid as a React child" — and `endpoint` is another fallback-less enum.
      endpoint: p.endpoint == null ? p.endpoint : oneOf<EndpointKind>(p.endpoint, ENDPOINT_KINDS, "stream"),
      name: typeof p.name === "string" ? p.name : "",
      tag: typeof p.tag === "string" ? p.tag : undefined,
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
  return Array.isArray(v) && v.length <= MAX_CHORD_CODES && v.every((c) => typeof c === "string");
}

/** Ceiling on the codes in ONE chord. Every real binding is ≤6 (modifiers + a key); the capture
 *  UI cannot produce more. */
const MAX_CHORD_CODES = 16;

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
    // …but only when the profiles it beats came from the same blob. `general` has no consent
    // arm, so a blob carrying ONLY `general.quickAddHotkey` reaches this with the user's own
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

function typedLike<T extends object>(incoming: T, local: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    const ref = (local as Record<string, unknown>)[k];
    // A key this version does not know: pass it through untouched, `null` included. Rust ignores
    // unrecognised fields, so it cannot wedge the parse, and swallowing it would erase a newer
    // peer's data on this device's next push.
    if (!(k in (local as Record<string, unknown>))) {
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
const INDICATOR_POSITIONS = ["top", "bottom", "off"] as const;
const OVERLAY_STATS_METRICS = ["words", "audio", "both"] as const;
const ACTIVATIONS = ["hold", "latch"] as const;
const ENDPOINT_KINDS = ["stream", "batch"] as const;
const RESPONSE_FORMATS = ["json", "verbose_json"] as const;
const BACKEND_KINDS = ["auto", "full", "standard"] as const;

function sanitizeBackends(list: unknown): Backend[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
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
    }))
    // An all-invisible appId normalizes to "", which matches nothing and displays as nothing —
    // a zombie row on the audit screen. Drop it rather than store it.
    .filter((r) => r.appId.length > 0)
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
  const known = new Set(list.map((b) => b.id));
  for (const [id, key] of Object.entries(secrets ?? {})) {
    if (!known.has(id)) continue;
    if (key) {
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
    let nextSettings: AppSettings = settings;
    let nextBackends = st.backends;
    let nextProfiles = st.profiles;
    let nextAppRules = st.appRules;

    if (cats.general && blob.general) {
      const { theme, ...incoming } = blob.general;
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
          // Sibling of the chord clamp above. `quickAddHotkey` is a chord too, and it lands in
          // the same `canonicalizeCodes` / `conflicts()` consumers — a non-list (or a list with a
          // numeric entry) throws in a component body AND in the debounced save.
          quickAddHotkey: isCodeList((general as { quickAddHotkey?: unknown }).quickAddHotkey)
            ? ((general as { quickAddHotkey: string[] }).quickAddHotkey)
            : nextSettings.general.quickAddHotkey,
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
    if (cats.recording && blob.recording) {
      nextSettings = {
        ...nextSettings,
        recording: {
          // Merge over THIS DEVICE'S current block, the way the `general` arm above already
          // does. Replacing it wholesale meant an omitted key fell through to `hydrate`'s
          // `withSettingsDefaults`, which refills from the FACTORY defaults — where
          // `saveRecordings` is true. So a blob that simply left the field out raised no
          // security change (undefined is falsy), applied silently, and turned permanent
          // plaintext archiving back on for a user who had deliberately turned it off; the same
          // omission silently reset trimSilence / muteSystemAudio / latchAutoStopMin too.
          // A peer that genuinely wants it off still sends the literal `false`.
          ...settings.recording,
          ...typedLike(blob.recording, settings.recording),
          // machine-local: keep this device's folder no matter what arrived
          recordingsDir: settings.recording.recordingsDir,
          indicatorPosition: oneOf<IndicatorPosition>(
            blob.recording.indicatorPosition,
            INDICATOR_POSITIONS,
            settings.recording.indicatorPosition,
          ),
          overlayStatsMetric: oneOf<OverlayStatsMetric>(
            blob.recording.overlayStatsMetric,
            OVERLAY_STATS_METRICS,
            settings.recording.overlayStatsMetric,
          ),
        },
      };
    }
    if (cats.backends && blob.backends) {
      nextBackends = await reconcileBackendSecrets(
        sanitizeBackends(blob.backends.list),
        blob.backends.secrets,
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
      // `quickAddList` was the one leaf written into `settings` with NO type check anywhere —
      // not here, not in `import_settings_file`, and not by the scrub below, which only asks
      // whether `.backendId` names a backend in the blob (an attacker just names one it also
      // sent). Rust's `QuickAddTarget` requires `backend_id` AND `slug` as bare `String`s with
      // no serde default, so `{"backendId":"<known>","slug":7}` rejected the whole `Config` and
      // froze every later save for the session.
      nextSettings = { ...nextSettings, quickAddList: safeQuickAddTarget(blob.backends.quickAddList) };
    }
    if (cats.profiles && blob.profiles) {
      nextProfiles = sanitizeProfiles(blob.profiles.list);
      // `??` only replaces null/undefined, so a JSON `0` or `false` survived it — and the scrub
      // below is gated on truthiness, so a falsy non-string skipped that too and reached Rust's
      // `Option<String>`. Same wedge as `quickAddList`.
      nextSettings = {
        ...nextSettings,
        homeProfileId: typeof blob.profiles.homeProfileId === "string" ? blob.profiles.homeProfileId : null,
      };
    }
    if (cats.appRules && blob.appRules) {
      nextAppRules = sanitizeAppRules(blob.appRules[MY_BUCKET]);
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
      version: 2,
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
  const ids = secrets ? Object.keys(secrets) : [];
  const hadStash = state.snapshotSecretIds !== undefined;
  state.snapshotSecretIds = ids.length > 0 ? ids : undefined;
  if (ids.length > 0) {
    await stashSnapshotSecrets(secrets!);
  } else if (hadStash) {
    // The stash must never outlive the snapshot it belongs to. When the new snapshot carries no
    // secrets (locked wallet, or a remote snapshot with no backends category) the old bundle was
    // left in the keyring with nothing left to point at it: `restoreSnapshotSecrets` returns
    // early on an empty id list, and the two `clearSnapshotSecrets` callers only fire on a server
    // switch or a manual reset. A plaintext bundle of every key stayed there indefinitely.
    await clearSnapshotSecrets();
  }
  const onDisk: SyncState = {
    ...state,
    snapshot: state.snapshot
      ? {
          ...state.snapshot,
          backends: state.snapshot.backends
            ? { ...state.snapshot.backends, secrets: undefined }
            : state.snapshot.backends,
        }
      : state.snapshot,
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
    const res = await syncPull({
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      backendId: backend.id,
    });
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
        const remoteBlob = (remote.blob ?? {}) as SyncBlob;
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
    { includeSecrets: true },
  );
  if (myGen !== gen) return; // superseded — don't apply the old server's blob
  const remoteBlob = (remote.blob ?? {}) as SyncBlob;
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

// ── security review of a pulled blob (driven by the Sync tab dialog) ────────

/** One pulled change worth stopping for. Everything a sync server can change is applied
 *  silently EXCEPT these two: where the microphone audio goes, and which credential travels
 *  with it. A sync server is remote and may be hostile or intercepted, and the pull runs
 *  unattended at startup and on every window focus — so these get the same explicit consent
 *  the file-import path already asks for. */
export interface SecurityChange {
  kind: "new-backend" | "server-url" | "api-key" | "recording-retention" | "save-recordings";
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
  return kind === "recording-retention" || kind === "save-recordings" ? "recording" : "backends";
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
    const incomingKey = nextSecrets[b.id];
    if (incomingKey && here.has(b.id) && incomingKey !== localSecrets[b.id]) {
      out.push({
        kind: "api-key",
        backend: cur?.name || name,
        detail: localSecrets[b.id]
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
