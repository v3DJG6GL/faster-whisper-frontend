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
  MANIFEST,
  settingsOfCategory,
  type SettingDef,
  type SettingId,
  type WireCategory,
} from "./settingsManifest";

export type Gates = Record<SettingId, boolean>;

const DEFS: readonly SettingDef[] = MANIFEST;

/** Scalar wire categories where payload keys equal store field keys. */
const SCALAR_CATS: readonly WireCategory[] = [
  "general",
  "recording",
  "chip",
  "transcription",
  "fileTranscriptions",
  "dictionary",
  "logging",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
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
export const APP_RULE_OVERRIDE_FIELDS = ["insertMethod", "restoreClipboard"] as const;
export const APP_RULE_PASTE_FIELDS = ["pasteShortcut"] as const;
/** Fields forced back to this device's value on EVERY inbound path, gate or no gate. */
export const APP_RULE_LOCAL_ONLY_FIELDS = ["autoEnter"] as const;
/** The per-Profile insertion overrides the Profiles field switch governs. */
export const PROFILE_INSERTION_FIELDS = ["typeAsISpeak", "insertionOverrides"] as const;
