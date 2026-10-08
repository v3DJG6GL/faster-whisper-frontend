// What a Profile's dictation session is fixed to at start — for the chord family (a hold chord
// nested in a hands-free one, see hotkeyConflicts.ts / chord_engine.rs). Completing the superset over a
// live hold upgrades that session in place (streaming.ts `reclassifyLive`), which can flip the
// activation, typing mode, insertion overrides and label — but NOT what the session was opened
// with. Two Profiles whose shapes differ can't share a session: dictation.ts restarts instead.

import { backendPrompt, effectiveLanguage } from "../backends";
import { stableStringify } from "../stable";
import type { Backend, Profile } from "../types";

/** The backend, and the model / language / prompt / decode / translation setup resolved
 *  against it the way startLiveInner does, plus WHEN the translation-target picker asks: a
 *  hands-free asker has to ask before the session starts, a hold asker asks at release — so a
 *  hold root and a hands-free superset that both ask still can't share a session (the in-place
 *  upgrade never runs the before-start picker). `backend` is the Profile's resolved Backend
 *  (dictation.ts `backendForProfile`); `null` when there is none. Compared as strings. */
export function sessionShape(profile: Profile, backend: Backend | undefined): string | null {
  if (!backend) return null;
  // Object keys sorted, so two override maps set in a different order compare equal.
  return stableStringify([
    backend.id,
    profile.model?.trim() || backend.model,
    effectiveLanguage(profile.language, backend.language),
    profile.prompt !== undefined ? profile.prompt : backendPrompt(backend),
    { ...backend.decodeOverrides, ...profile.decodeOverrides },
    profile.overrideProfile?.trim() || backend.overrideProfile,
    profile.endpoint ?? backend.endpoint,
    { ...backend.translationOverrides, ...profile.translationOverrides },
    profile.askTranslationTargets ? (profile.activation === "hold" ? "ask-at-release" : "ask-before-start") : false,
  ]);
}
