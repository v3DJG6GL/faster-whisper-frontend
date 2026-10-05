// Translation target lists and the T2T slice of a run: the pure side of the translation
// controls in components/TranslationFields.tsx (the chips, the per-run fields, the
// Backend/Profile defaults editor).

import { languageLabel } from "./languages";
import { cleanCodes } from "./recent";
import type { TranscribeOptions, TranslationOverrides } from "./types";

/** Drop the known source language from a target list — a source→source stage
 *  is a no-op run. "auto" is not a known source, so nothing is pruned. */
export function pruneTargets(targets: string[], source: string): string[] {
  if (!source || source === "auto") return targets;
  return targets.filter((c) => c !== source);
}

/** The renderable codes of a target list. `translationOverrides` is a SYNCED field neither
 *  sanitizer clamps element-wise, so a peer's `translateTo: [123]` reached `code.toUpperCase()`
 *  in the render body and — with no error boundary — unmounted the window on every launch.
 *  Strings only, trimmed, bounded per code and in count, de-duplicated (the chips are keyed on
 *  the code). Removal still filters the ORIGINAL array, so nothing is lost by rendering less. */
export const chipCodes = (v: unknown, max = 32) => cleanCodes(v, { max, bound: 12 });

/** Store-shape for a `TranslationOverrides` draft: drop the keys that are "inherit"
 *  so an all-inherit object stores as `undefined` (the `decodeOverrides` idiom), and
 *  KEEP the ones that are an explicit empty override.
 *
 *  `translateTo` and `glossary` are tri-state — only `undefined` is inherit. An empty
 *  list / empty string is the user saying "none, whatever the layer below has", and
 *  pruning it silently re-inherited the value they had just cleared. `model`/`mode`
 *  stay truthiness-pruned: their controls have a real "Inherit" row instead. */
export function pruneTranslationOverrides(
  next: TranslationOverrides,
): TranslationOverrides | undefined {
  const out = { ...next };
  if (out.translateTo === undefined) delete out.translateTo;
  if (!out.model) delete out.model;
  if (out.contextSegments === undefined) delete out.contextSegments;
  if (out.glossary === undefined) delete out.glossary;
  if (!out.mode) delete out.mode;
  // Tri-state: only `undefined` is "inherit". `false` is an explicit OFF and must be
  // STORED — the effective value is a per-field spread merge (streaming.ts trOv), so a
  // pruned `false` silently re-inherited a Backend default of `true` while the toggle
  // sat visibly off.
  if (out.includeOriginal === undefined) delete out.includeOriginal;
  return Object.keys(out).length ? out : undefined;
}

/** The T2T slice of a run's `TranscribeOptions`, as the wire's tri-state.
 *
 *  The screen's chips are authoritative, so "no targets" has to be SAID (`translateTo:
 *  []` → `translate_to=""`) rather than left out — an absent field now means "inherit
 *  the server override-profile's TRANSLATE_TO", which would put back the stage the user
 *  switched off. Everything is omitted for a backend that has no T2T stage at all
 *  (a standard Whisper server), where the field would be meaningless.
 *
 *  `glossary` carries the Backend default's own tri-state through untouched: an
 *  explicit "" is forwarded so the server's TRANSLATION_GLOSSARY is suppressed, and
 *  only an unset one is omitted. */
export function translationRunOptions(args: {
  /** The backend runs a translating stage (full backend, translation_enabled). */
  available: boolean;
  /** The run's target codes — an empty list is an explicit "translate into nothing". */
  targets: string[];
  mode: "fluent" | "faithful";
  /** Resolved per-run model; empty/undefined = the server's default. */
  model?: string;
  /** Tri-state: undefined = inherit, "" = explicit clear, value = use it. */
  glossary?: string;
  /** Context depth (0–10); undefined = the server's TRANSLATION_CONTEXT_SEGMENTS. */
  contextSegments?: number;
}): Pick<
  TranscribeOptions,
  "translateTo" | "translationMode" | "translationModel" | "translationGlossary" | "translationContextSegments"
> {
  if (!args.available) return {};
  if (!args.targets.length) return { translateTo: [] };
  return {
    translateTo: args.targets,
    translationMode: args.mode,
    ...(args.model ? { translationModel: args.model } : {}),
    ...(args.glossary !== undefined ? { translationGlossary: args.glossary } : {}),
    ...(args.contextSegments !== undefined ? { translationContextSegments: args.contextSegments } : {}),
  };
}

/** Display text for a list of target codes: their language names, or `none` when empty. */
export function targetsLabel(codes: unknown, none: string): string {
  const list = chipCodes(codes);
  return list.length ? list.map((c) => languageLabel(c)).join(", ") : none;
}
