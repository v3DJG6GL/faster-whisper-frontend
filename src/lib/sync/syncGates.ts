// Per-setting sync gating — the pure half of the granular "What this device
// syncs" switches. Generalizes the four original sub-toggles' pattern to
// every manifest setting:
//
//  - COMPOSE (outbound): a gated-OFF setting's fields carry the SNAPSHOT's
//    values (the peer's state passes through untouched); when the snapshot
//    has no value the field is omitted — never "this device's value", which
//    would push local edits the user opted out of, and never a deletion,
//    which would erase the field for devices that do sync it.
//  - APPLY (inbound): a gated-OFF setting's fields are stripped from the
//    incoming category before the merge-over-current, so this device keeps
//    its local values no matter what a peer pushed.
//
// List categories (backends/profiles/appRules) gate per-ELEMENT fields the
// same way, keyed by element id — extending the profile-chord precedent.
//
// Pure functions only (no store/api imports) — unit-tested in isolation.

import {
  DEFS,
  settingsOfCategory,
  type SettingDef,
  type SettingId,
  type WireCategory,
} from "../settingsManifest";

export type Gates = Record<SettingId, boolean>;


/** Scalar wire categories where payload keys equal store field keys. The ONE list —
 *  sync.ts's compose and apply gating both iterate it, so a new scalar category is added here
 *  and nowhere else (the Rust importer's shape check in commands/sync.rs mirrors it by hand). */
export const SCALAR_CATS: readonly WireCategory[] = [
  "general",
  "recording",
  "chip",
  "transcription",
  "fileTranscriptions",
  "dictionary",
  "logging",
];

/** A JSON object — not null, not an array, not a string. The blob's containers are attacker-shaped
 *  just like its lists, and `Object.entries`/`Object.keys` accept a string by expanding it per code
 *  unit; every ceiling in the engine bounds ENTRY COUNT, which that turns into 4M. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The wire keys of a category's gated-OFF non-custom settings. */
function gatedOffKeys(cat: WireCategory, gates: Gates): string[] {
  const keys: string[] = [];
  for (const d of settingsOfCategory(cat)) {
    if (d.custom) continue; // list arms handle their own fields
    if (gates[d.id as SettingId]) continue;
    for (const ref of d.fields) keys.push(ref.key);
  }
  return keys;
}

/** COMPOSE side: substitute the snapshot's values for gated-off fields in a
 *  freshly extracted scalar-category payload (omit when the snapshot has
 *  none). Non-scalar categories and non-object payloads pass through. */
export function gateComposeScalar(
  cat: WireCategory,
  payload: unknown,
  snapshotCat: unknown,
  gates: Gates,
): unknown {
  if (!SCALAR_CATS.includes(cat) || !isPlainObject(payload)) return payload;
  const off = gatedOffKeys(cat, gates);
  if (off.length === 0) return payload;
  const out: Record<string, unknown> = { ...payload };
  const snap = isPlainObject(snapshotCat) ? snapshotCat : undefined;
  for (const key of off) {
    const v = snap?.[key];
    if (v !== undefined) out[key] = v;
    else delete out[key];
  }
  return out;
}

/** APPLY side: strip gated-off fields from an inbound scalar-category object
 *  so the merge-over-current keeps this device's values. */
export function gateApplyScalar(
  cat: WireCategory,
  incoming: unknown,
  gates: Gates,
): unknown {
  if (!SCALAR_CATS.includes(cat) || !isPlainObject(incoming)) return incoming;
  const off = gatedOffKeys(cat, gates);
  if (off.length === 0) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  for (const key of off) delete out[key];
  return out;
}

/** Element-wise substitution for list categories: for each element of `live`
 *  whose id the `snapshot` list knows, replace the given fields with the
 *  snapshot's values (COMPOSE with a gate off — local edits stay local). An
 *  element the snapshot doesn't know keeps its live fields: peers must never
 *  receive an element missing a required field. */
export function substituteElementFields<T extends { id: string }>(
  live: readonly T[],
  snapshot: unknown,
  fields: readonly (keyof T & string)[],
  /** exact: mirror the snapshot's field even when ABSENT (delete the live
   *  value) — right for OPTIONAL fields (per-rule overrides), where absence
   *  is itself a state. Non-exact keeps live values for absent snapshot
   *  fields — right for REQUIRED fields (chords), which peers must receive. */
  exact = false,
): T[] {
  const snapById = new Map(
    (Array.isArray(snapshot) ? snapshot : [])
      .filter((e): e is Record<string, unknown> & { id: string } =>
        isPlainObject(e) && typeof e.id === "string",
      )
      .map((e) => [e.id, e]),
  );
  return live.map((e) => {
    const snap = snapById.get(e.id);
    if (!snap) return e;
    const out = { ...e };
    for (const f of fields) {
      const v = snap[f];
      if (v !== undefined) (out as Record<string, unknown>)[f] = v;
      else if (exact) delete (out as Record<string, unknown>)[f];
    }
    return out;
  });
}

/** Element-wise re-pin for list categories: for each inbound element whose id
 *  this device already knows, keep the LOCAL values of the given fields
 *  (APPLY with a gate off). Elements new to this device keep the inbound
 *  values — there is no local value to keep. */
export function repinElementFields<T extends { id: string }>(
  inbound: readonly T[],
  local: readonly { id: string }[],
  fields: readonly (keyof T & string)[],
  /** exact: mirror the local field even when ABSENT (see substitute above). */
  exact = false,
): T[] {
  const localById = new Map(local.map((e) => [e.id, e as Record<string, unknown>]));
  return inbound.map((e) => {
    const mine = localById.get(e.id);
    if (!mine) return e;
    const out = { ...e };
    for (const f of fields) {
      const v = mine[f];
      if (v !== undefined) (out as Record<string, unknown>)[f] = v;
      else if (exact) delete (out as Record<string, unknown>)[f];
    }
    return out;
  });
}

/** The engine's category toggles, derived from the gates. Scalar categories
 *  sync when ANY member setting does; list categories follow their LIST
 *  switch (the list IS the category — addresses/keys/defaults only modify
 *  it); dictionary follows its two field switches. */
export function catsFromGates(gates: Gates): Record<string, boolean> {
  const cats: Record<string, boolean> = {
    backends: gates.backendList,
    profiles: gates.profileList,
    appRules: gates.rulesThisOs,
  };
  for (const d of DEFS) {
    if (d.localOnly) continue;
    if (d.category === "backends" || d.category === "profiles" || d.category === "appRules") continue;
    cats[d.category] = (cats[d.category] ?? false) || gates[d.id as SettingId];
  }
  return cats;
}

/** The per-backend fields the "Model & decode defaults" switch governs. */
export const BACKEND_DEFAULTS_FIELDS = [
  "model",
  "language",
  "prompt",
  // Travels WITH `prompt` — it is the other half of one value (see `backendPrompt`),
  // and gating them apart would let a peer's prompt land without its cleared-ness.
  "promptCleared",
  "responseFormat",
  "decodeOverrides",
  "translationOverrides",
  "overrideProfile",
] as const;

/** The per-rule fields the App-rules field switches govern.
 *
 *  `autoEnter` is deliberately ABSENT: it is never accepted from a peer at all (the
 *  sanitizers drop it, and the apply arm re-pins it unconditionally), so gating it would
 *  imply a choice the user does not have. See `sanitizeAppRules`. */
export const APP_RULE_OVERRIDE_FIELDS = ["insertMethod", "restoreClipboard", "remoteDesktop"] as const;
export const APP_RULE_PASTE_FIELDS = ["pasteShortcut"] as const;
/** Fields forced back to this device's value on EVERY inbound path, gate or no gate. */
export const APP_RULE_LOCAL_ONLY_FIELDS = ["autoEnter"] as const;
/** The per-Profile insertion overrides the Profiles field switch governs. */
export const PROFILE_INSERTION_FIELDS = ["typeAsISpeak", "insertionOverrides"] as const;

/** The list switches: each IS its category (`catsFromGates`), so turning one on is a category
 *  coming on whole, never one setting inside it. */
const LIST_SWITCHES: readonly string[] = ["backendList", "profileList", "rulesThisOs"];

/** Does this setting actually travel under these gates: its switch on, its category synced, and —
 *  for the quick-add pin, which is slaved to the server list (`extractDictionary`) — that list too. */
function gateSyncs(gates: Gates, cats: Record<string, boolean>, d: SettingDef): boolean {
  return gates[d.id as SettingId] && !!cats[d.category] && (d.id !== "pinnedMappings" || gates.backendList);
}

/** The settings whose sync came on between `prev` and `now` inside a category that already
 *  synced in `prev` — one more setting of a synced group. While it was off, every base passed the
 *  server's value of it through, so a 3-way merge would read this device's own value as an edit
 *  and push it over the peer's. A category coming on whole is `catsFromGates`' business. */
export function gatesTurnedOn(prev: Gates, now: Gates): SettingId[] {
  const before = catsFromGates(prev);
  const after = catsFromGates(now);
  const out: SettingId[] = [];
  for (const d of DEFS) {
    if (d.localOnly || LIST_SWITCHES.includes(d.id)) continue;
    if (!before[d.category]) continue;
    if (gateSyncs(now, after, d) && !gateSyncs(prev, before, d)) out.push(d.id as SettingId);
  }
  return out;
}

/** Is this setting's sync still on (see `gatesTurnedOn`)? A fresh one turned off again drops out. */
export function gateStillSyncs(gates: Gates, id: SettingId): boolean {
  const d = DEFS.find((x) => x.id === id);
  return !!d && !d.localOnly && !LIST_SWITCHES.includes(d.id) && gateSyncs(gates, catsFromGates(gates), d);
}

/** Per-element field copy for one list: each element of `live` whose id `src` also holds takes
 *  `src`'s values of `fields` (absent ones deleted when `exact`). Malformed elements stay as they
 *  are — this only moves values between two copies of a list, it never cleans one. */
function swapElementFields(live: unknown, src: unknown, fields: readonly string[], exact: boolean): unknown {
  if (!Array.isArray(live)) return live;
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of Array.isArray(src) ? src : []) {
    if (isPlainObject(e) && typeof e.id === "string") byId.set(e.id, e);
  }
  return live.map((e) => {
    if (!isPlainObject(e) || typeof e.id !== "string") return e;
    const from = byId.get(e.id);
    if (!from) return e;
    const out: Record<string, unknown> = { ...e };
    for (const f of fields) {
      const v = from[f];
      if (v !== undefined) out[f] = v;
      else if (exact) delete out[f];
    }
    return out;
  });
}

/** `target` (one category's wire value) with the parts the given settings govern taken from
 *  `source` — the same parts composeBlob substitutes when their switch is off: scalar fields, the
 *  per-element fields of a list, the keys bundle, the home profile, this OS's app-rule bucket.
 *  Everything else stays `target`'s. Lets a merge judge one setting of a category apart from the
 *  rest of it. */
export function withGateParts(
  cat: WireCategory,
  ids: readonly SettingId[],
  target: unknown,
  source: unknown,
  myBucket: "linux" | "windows",
): unknown {
  const out: Record<string, unknown> = { ...(isPlainObject(target) ? target : {}) };
  const s = isPlainObject(source) ? source : {};
  const copy = (key: string) => {
    if (s[key] !== undefined) out[key] = s[key];
    else delete out[key];
  };
  const swapIn = (key: string, fields: readonly string[], exact: boolean) => {
    if (Array.isArray(out[key])) out[key] = swapElementFields(out[key], s[key], fields, exact);
  };
  for (const id of ids) {
    const d = DEFS.find((x) => x.id === id);
    if (!d || d.category !== cat) continue;
    switch (id) {
      case "serverAddresses":
        swapIn("list", ["serverUrl"], false);
        break;
      case "modelDecodeDefaults":
        swapIn("list", BACKEND_DEFAULTS_FIELDS, true);
        break;
      case "apiKeys":
        copy("secrets");
        break;
      case "profileHotkeys":
        swapIn("list", ["hotkey"], false);
        break;
      case "enabledPerProfile":
        swapIn("list", ["enabled"], false);
        break;
      case "profileInsertion":
        swapIn("list", PROFILE_INSERTION_FIELDS, true);
        break;
      case "homeProfile":
        copy("homeProfileId");
        break;
      case "perAppOverrides":
        swapIn(myBucket, APP_RULE_OVERRIDE_FIELDS, true);
        break;
      case "perAppPasteShortcuts":
        swapIn(myBucket, APP_RULE_PASTE_FIELDS, true);
        break;
      default:
        // Scalar settings (and the quick-add pin): their wire keys, as `gatedOffKeys` reads them.
        for (const ref of d.fields) copy(ref.key);
    }
  }
  return out;
}

/** The disclosure contract for one group, in one place: which rows render,
 *  whether the panel is open, and whether the toggle honestly OWNS that panel.
 *  Filter on → the group's exceptions (changed OR switch off), expansion
 *  ignored, and the toggle drives nothing so it claims no `aria-controls`;
 *  filter off → all rows when expanded, none when collapsed (the header +
 *  summary IS the collapsed view). The header always renders so the group
 *  master stays reachable in every mode. */
export function groupPanelState(
  defs: SettingDef[],
  gates: Record<SettingId, boolean>,
  changed: ReadonlySet<SettingId>,
  expanded: boolean,
  changedOnly: boolean,
): { visible: SettingDef[]; panelOpen: boolean; owns: boolean } {
  const isException = (d: SettingDef) =>
    !gates[d.id as SettingId] || changed.has(d.id as SettingId);
  const visible = changedOnly ? defs.filter(isException) : expanded ? defs : [];
  const panelOpen = visible.length > 0;
  return { visible, panelOpen, owns: !changedOnly && panelOpen };
}
