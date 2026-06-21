// Hotkey-conflict detection for dictation Profiles.
//
// Two kinds of conflict, both reported against BOTH offending profiles so each
// card can show a banner:
//   • "duplicate" — two profiles share the exact same chord.
//   • "shadow"    — one chord is a strict subset of another (e.g. Alt vs Ctrl+Alt).
//                   The shorter chord would fire whenever the longer one is held.
//
// This MUST match the evdev matcher's rule (src-tauri/src/evdev_hotkeys.rs:
// compute_strict_supersets) so the UI and the backend agree on what "shadow" means.
// Only enabled profiles with a non-empty hotkey participate.

import type { Profile } from "./types";
import { canonicalizeCodes, sameCodes } from "./keys";

export type ConflictKind = "duplicate" | "shadow";

export interface ProfileConflict {
  profileId: string; // the profile this conflict is reported against
  otherId: string; // the profile it collides with
  kind: ConflictKind;
}

/** The global quick-add chord participates in conflict detection as a synthetic peer profile, so a
 *  profile chord colliding with it is flagged on all three surfaces (per-card banner, the Editor
 *  capture-warn check, and the persistence save-gate). One factory + id keeps those in lockstep. */
export const QUICK_ADD_PEER_ID = "__quick-add__";

export function quickAddPeer(hotkey: string[]): Profile {
  return { id: QUICK_ADD_PEER_ID, name: "Quick add", activation: "hold", enabled: true, hotkey, backendId: null };
}

/** Is `a` a strict subset of `b` (fewer keys, all contained in `b`)? */
function isStrictSubset(a: string[], b: string[]): boolean {
  return a.length < b.length && a.every((c) => b.includes(c));
}

/** Find every chord conflict among the given profiles. */
export function conflicts(profiles: Profile[]): ProfileConflict[] {
  const active = profiles
    .filter((p) => p.enabled && p.hotkey.length > 0)
    .map((p) => ({ id: p.id, codes: canonicalizeCodes(p.hotkey) }));

  const out: ProfileConflict[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (sameCodes(a.codes, b.codes)) {
        out.push({ profileId: a.id, otherId: b.id, kind: "duplicate" });
        out.push({ profileId: b.id, otherId: a.id, kind: "duplicate" });
      } else if (isStrictSubset(a.codes, b.codes)) {
        // a is shadowed by b (b is the more specific superset).
        out.push({ profileId: a.id, otherId: b.id, kind: "shadow" });
        out.push({ profileId: b.id, otherId: a.id, kind: "shadow" });
      } else if (isStrictSubset(b.codes, a.codes)) {
        out.push({ profileId: b.id, otherId: a.id, kind: "shadow" });
        out.push({ profileId: a.id, otherId: b.id, kind: "shadow" });
      }
    }
  }
  return out;
}

/**
 * Capture-time check: would binding `codes` to a profile clash with any OTHER
 * enabled profile? Returns the first clashing profile + kind, or null. Use this
 * while the user is choosing a chord (pass the other profiles).
 */
export function findChordConflict(
  codes: string[],
  others: Profile[],
): { id: string; name: string; kind: ConflictKind } | null {
  const a = canonicalizeCodes(codes);
  if (a.length === 0) return null;
  for (const o of others) {
    if (!o.enabled || o.hotkey.length === 0) continue;
    const b = canonicalizeCodes(o.hotkey);
    if (sameCodes(a, b)) return { id: o.id, name: o.name, kind: "duplicate" };
    if (isStrictSubset(a, b) || isStrictSubset(b, a)) return { id: o.id, name: o.name, kind: "shadow" };
  }
  return null;
}

/** Group conflicts by the profile they're reported against (for per-card banners). */
export function conflictsByProfile(profiles: Profile[]): Map<string, ProfileConflict[]> {
  const map = new Map<string, ProfileConflict[]>();
  for (const c of conflicts(profiles)) {
    const list = map.get(c.profileId) ?? [];
    list.push(c);
    map.set(c.profileId, list);
  }
  return map;
}
