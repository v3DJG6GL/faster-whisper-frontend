// What a Profile's dictation session is fixed to at start — for the chord family (a hold chord
// nested in a hands-free one, see conflicts.ts / chord_engine.rs). Completing the superset over a
// live hold upgrades that session in place (streaming.ts `reclassifyLive`), which can flip the
// activation, typing mode, insertion overrides and label — but NOT what the session was opened
// with. Two Profiles whose shapes differ can't share a session: dictation.ts restarts instead.

import { backendPrompt, effectiveLanguage } from "./backends";
import type { Backend, Profile } from "./types";

/** The backend, and the model / language / prompt / decode / translation setup resolved
 *  against it the way startLiveInner does, plus the hands-free translation-target picker
 *  (it has to run before the session starts). `backend` is the Profile's resolved Backend
 *  (dictation.ts `backendForProfile`); `null` when there is none. Compared as strings. */
export function sessionShape(profile: Profile, backend: Backend | undefined): string | null {
  if (!backend) return null;
  return stableJson([
    backend.id,
    profile.model?.trim() || backend.model,
    effectiveLanguage(profile.language, backend.language),
    profile.prompt !== undefined ? profile.prompt : backendPrompt(backend),
    { ...backend.decodeOverrides, ...profile.decodeOverrides },
    profile.overrideProfile?.trim() || backend.overrideProfile,
    profile.endpoint ?? backend.endpoint,
    { ...backend.translationOverrides, ...profile.translationOverrides },
    !!profile.askTranslationTargets,
  ]);
}

/** JSON with object keys sorted, so two override maps set in a different order compare equal. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}
