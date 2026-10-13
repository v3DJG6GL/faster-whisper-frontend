// What a Profile's dictation session is fixed to at start — for the chord family (a hold chord
// nested in a hands-free one, see hotkeyConflicts.ts / chord_engine.rs). Completing the superset over a
// live hold upgrades that session in place (streaming.ts `reclassifyLive`), which can flip the
// activation, typing mode, insertion overrides and label — but NOT what the session was opened
// with. Two Profiles whose shapes differ can't share a session: dictation.ts restarts instead.

import { backendPrompt, effectiveLanguage, effectiveOverrideProfile, effectiveTranslationModel } from "../backends";
import { sendableTargets } from "../capabilities";
import { stableStringify } from "../stable";
import type { Backend, Profile } from "../types";

/** The backend, and the model / language / prompt / decode / translation setup resolved
 *  against it the way startLiveInner does, plus WHEN the translation-target picker asks: a
 *  hands-free asker has to ask before the session starts, a hold asker asks at release — so a
 *  hold root and a hands-free superset that both ask still can't share a session (the in-place
 *  upgrade never runs the before-start picker). The translation slot is `null` when the session
 *  translates nothing (no sendable target and no picker): startLiveInner then sends none of its
 *  fields, so an "Include original" Off, a cleared target list or a leftover glossary there
 *  is the same session. `backend` is the Profile's resolved Backend (dictation.ts
 *  `backendForProfile`); `null` when there is none. Compared as strings. */
export function sessionShape(profile: Profile, backend: Backend | undefined): string | null {
  if (!backend) return null;
  const trOv = { ...backend.translationOverrides, ...profile.translationOverrides };
  // As startLiveInner sends it: only the wire-valid codes, within the Backend's target cap.
  const targets = sendableTargets(trOv.translateTo, backend.id);
  // Object keys sorted, so two override maps set in a different order compare equal.
  return stableStringify([
    backend.id,
    // As startLiveInner sends it: both sides trimmed (a synced Backend model may be padded).
    profile.model?.trim() || backend.model.trim(),
    // As startLiveInner sends it: a word naming a Whisper language ("english") is its code, so an
    // "english" and an "en" Profile are one session.
    effectiveLanguage(profile.language, backend.language),
    profile.prompt !== undefined ? profile.prompt : backendPrompt(backend),
    { ...backend.decodeOverrides, ...profile.decodeOverrides },
    effectiveOverrideProfile(profile.overrideProfile, backend.overrideProfile),
    profile.endpoint ?? backend.endpoint,
    // An asking Profile keeps the fields with no targets: a pick builds the translation from them
    // (applySessionTargets over sessionTranslationBase).
    targets.length || profile.askTranslationTargets
      ? {
          targets,
          // Read truthily wherever it is used: an explicit Off is the inherited absent value.
          includeOriginal: !!trOv.includeOriginal,
          // As startLiveInner sends it (the shared effectiveTranslationModel rule).
          model: effectiveTranslationModel(profile.translationOverrides?.model, backend.translationOverrides?.model),
          glossary: trOv.glossary,
          mode: trOv.mode,
          contextSegments: trOv.contextSegments,
        }
      : null,
    profile.askTranslationTargets ? (profile.activation === "hold" ? "ask-at-release" : "ask-before-start") : false,
  ]);
}
