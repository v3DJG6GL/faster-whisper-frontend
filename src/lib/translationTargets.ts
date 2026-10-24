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

/** A target list as the wire takes it — and the ONE list the chips show, count and remove from,
 *  and a run sends. Mirrors Rust's `is_lang_code` (src-tauri/src/transport/mod.rs): 2..=16
 *  ASCII letters, digits or `-`; a code the wire would refuse is skipped whole, never shortened
 *  (a clipped `ca-ES-valencia` is a code nobody picked). Input may be synced, stored or
 *  server-sent, so non-strings are dropped — a `[123]` would crash the render body, which has no
 *  error boundary. Trimmed, de-duplicated (chips are keyed on the code), at most 32. */
export const wireCodes = (v: unknown) =>
  cleanCodes(
    Array.isArray(v) ? v.filter((c) => typeof c === "string" && /^[A-Za-z0-9-]{2,16}$/.test(c.trim())) : v,
    { max: 32, bound: 16 },
  );

/** The targets a translation run starts from before the user touches the chips: the Backend's
 *  Translation defaults → the server's default list → English, never the known source (a
 *  source→source stage is a no-op), and within the server's target cap as the picker is.
 *  `backendTargets` / `serverDefault` are synced or server-sent, so only their wire-valid
 *  codes count (`wireCodes`). */
export function seedTargets(o: {
  backendTargets?: unknown;
  serverDefault?: unknown;
  source?: string | null;
  max: number;
}): string[] {
  const own = wireCodes(o.backendTargets);
  const server = wireCodes(o.serverDefault);
  const list = (own.length ? own : server.length ? server : ["en"]).filter((c) => c !== o.source);
  return (list.length ? list : [o.source === "en" ? "de" : "en"]).slice(0, o.max);
}

/** The source the translation chips leave out: while the site-subtitle panel holds them, the
 *  link's spoken language (falling back to the known source when unknown), else the screen's
 *  known source. ONE answer for the picker's exclude and the Toggle's seed: a seed that kept the
 *  link's spoken language would write a target the panel's chips never show, which would then
 *  surface as a chip (and a run target) once the panel lets go. */
export function chipSource(panelHolds: boolean, linkSpoken: string | null | undefined, knownSource: string | undefined): string | undefined {
  return panelHolds ? (linkSpoken ?? knownSource) : knownSource;
}

/** The targets a run sends for the queued files (and warms for them): the chips' list, less the
 *  screen's known source. The re-prune effect keeps translateTo free of it — except while the
 *  site-subtitle panel holds the chips for a draft link (their source is then the link's), where
 *  a Run would send each queued file its own spoken language as a target (a de→de copy track).
 *  Unknown or "auto" source: nothing to prune. A link with a site plan sends its frozen
 *  `mtTargets` instead (`linkTranslateTo`), untouched by this. */
export function runTargets(translateTo: unknown, knownSource: string | undefined): string[] {
  const codes = wireCodes(translateTo);
  return knownSource ? pruneTargets(codes, knownSource) : codes;
}

/** Store-shape for a `TranslationOverrides` draft: drop the keys that are "inherit"
 *  so an all-inherit object stores as `undefined` (the `decodeOverrides` idiom), and
 *  KEEP the ones that are an explicit empty override.
 *
 *  `translateTo` and `glossary` are tri-state — only `undefined` is inherit. An empty
 *  list / empty string is the user saying "none, whatever the layer below has", and
 *  pruning it would silently re-inherit the value they just cleared. `model`/`mode`
 *  stay truthiness-pruned: their controls have a real "Inherit" row instead. `model` is
 *  pruned when blank after a trim and stored trimmed — `effectiveTranslationModel` trims,
 *  so a synced "  " already inherits and " gemma " already runs "gemma". */
export function pruneTranslationOverrides(
  next: TranslationOverrides,
): TranslationOverrides | undefined {
  const out = { ...next };
  if (out.translateTo === undefined) delete out.translateTo;
  if (!out.model?.trim()) delete out.model;
  else out.model = out.model.trim();
  if (out.contextSegments === undefined) delete out.contextSegments;
  if (out.glossary === undefined) delete out.glossary;
  if (!out.mode) delete out.mode;
  // Tri-state: only `undefined` is "inherit". `false` is an explicit OFF and must be
  // STORED — the effective value is a per-field spread merge (dictation/sessionShape.ts
  // trOv), so a pruned `false` would silently re-inherit a Backend default of `true` while
  // the toggle sits visibly off.
  if (out.includeOriginal === undefined) delete out.includeOriginal;
  return Object.keys(out).length ? out : undefined;
}

/** How many Translation overrides a summary counts as set: the stored keys, less a model that
 *  is blank after a trim (it inherits — `effectiveTranslationModel`), which a peer can sync in
 *  and which stays stored until the next edit prunes it. */
export function countTranslationOverrides(t: TranslationOverrides | undefined): number {
  return Object.keys(t ?? {}).filter((k) => k !== "model" || !!t?.model?.trim()).length;
}

/** The T2T slice of a run's `TranscribeOptions`, as the wire's tri-state.
 *
 *  The screen's chips are authoritative, so "no targets" has to be SAID (`translateTo:
 *  []` → `translate_to=""`) rather than left out — an absent field means "inherit
 *  the server override-profile's TRANSLATE_TO", which would put back the stage the user
 *  switched off. Everything is omitted for a backend that has no T2T stage at all
 *  (a standard Whisper server), where the field would be meaningless.
 *
 *  `glossary` carries the Backend default's own tri-state through untouched: an
 *  explicit "" is forwarded so the server's TRANSLATION_GLOSSARY is suppressed, and
 *  only an unset one is omitted.
 *
 *  The regime (mode/model/glossary/context) rides along even with an empty list: a link's
 *  frozen site targets can still translate (`runLink` → `linkTranslateTo`), and the Rust
 *  form drops every translation_* field when there are no targets, so it is wire-safe. */
export function translationRunOptions(args: {
  /** The backend runs a translating stage (full backend, translation_enabled). */
  available: boolean;
  /** The run's target codes — an empty list is an explicit "translate into nothing". */
  targets: string[];
  mode: "fluent" | "faithful";
  /** Resolved per-run model, trimmed here; empty/blank/undefined = the server's default. */
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
  // A padded synced id must not reach the wire.
  const model = args.model?.trim();
  return {
    translateTo: args.targets,
    translationMode: args.mode,
    ...(model ? { translationModel: model } : {}),
    ...(args.glossary !== undefined ? { translationGlossary: args.glossary } : {}),
    ...(args.contextSegments !== undefined ? { translationContextSegments: args.contextSegments } : {}),
  };
}

/** Display text for a list of target codes: their language names, or `none` when empty. */
export function targetsLabel(codes: unknown, none: string): string {
  const list = wireCodes(codes);
  return list.length ? list.map((c) => languageLabel(c)).join(", ") : none;
}
