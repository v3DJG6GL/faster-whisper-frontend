// Target-language chips for the T2T translation stage — the selected targets
// as removable pills (in output order) plus a "+ language" picker over the
// remaining candidates. Reused by the Processing card, the Backend/Profile
// "Translation defaults" editors, and retro-translate popovers.
import type { ReactNode } from "react";
import { Eraser, RotateCcw } from "lucide-react";
import { LANGUAGES, languageLabel } from "../lib/languages";
import { cn } from "../lib/cn";
import { safeDisplayText } from "../lib/sanitize";
import type { Capabilities, TranscribeOptions, TranslationOverrides } from "../lib/types";
import { ModelPicker } from "./ModelPicker";
import { MicroLabel, Segmented, Stepper, TextArea } from "./ui";

export const TRANSLATION_MAX_TARGETS = 8;

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
export function chipCodes(v: unknown, max = 32): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c !== "string" || !c.trim()) continue;
    const code = safeDisplayText(c.trim(), 12);
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

export function TranslationTargetChips({
  value,
  onChange,
  allowed,
  exclude,
  max = TRANSLATION_MAX_TARGETS,
  disabled,
  ariaLabel = "Translation targets",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Server-advertised target codes (caps.translation_languages); absent =
   *  the app's own curated list. Codes outside the app list still render
   *  (label falls back to the raw code). */
  allowed?: string[];
  /** The known source language — offering it as a target is a no-op. */
  exclude?: string;
  max?: number;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const candidates = (
    allowed?.length
      ? allowed
      : LANGUAGES.filter((l) => l.value !== "auto").map((l) => l.value)
  ).filter((code) => code !== exclude);
  const shown = chipCodes(value);
  const shownCandidates = chipCodes(candidates, 200);
  const remaining = shownCandidates.filter((code) => !value.includes(code));
  const atCap = value.length >= max;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={ariaLabel}>
      {shown.map((code) => (
        <button
          key={code}
          type="button"
          disabled={disabled}
          onClick={() => onChange(value.filter((c) => c !== code))}
          title={`Remove ${languageLabel(code)}`}
          className={cn(
            "ring-signal inline-flex h-7 items-center gap-1.5 rounded-pill border px-2.5 font-mono text-[11.5px]",
            "border-[color:var(--c-translate)]/50 text-[color:var(--c-translate)]",
            disabled && "opacity-50",
          )}
        >
          {code.toUpperCase()}
          <span aria-hidden className="opacity-60">
            ×
          </span>
        </button>
      ))}
      {!atCap && remaining.length > 0 && (
        <select
          value=""
          disabled={disabled}
          aria-label="Add a target language"
          onChange={(e) => {
            const code = e.target.value;
            if (code && !value.includes(code)) onChange([...value, code]);
          }}
          className={cn(
            "ring-signal h-7 cursor-pointer appearance-none rounded-pill border border-dashed border-line-strong",
            "bg-transparent px-2.5 text-[11.5px] text-dim hover:text-text",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <option value="">+ language</option>
          {remaining.map((code) => (
            <option key={code} value={code}>
              {languageLabel(code)}
            </option>
          ))}
        </select>
      )}
      {atCap && <span className="text-[11px] text-faint">max {max}</span>}
    </div>
  );
}

/** Per-run translation options — target chips, Fluent/Faithful mode, and the
 *  model pick (shown only when the server offers a choice). Fully controlled;
 *  shared by the Transcribe Processing card and the viewer's retro-translate
 *  panel so the two doors stay identical. `children` renders below the
 *  mode/model row (footer hints). */
export function TranslationOptionsFields({
  targets,
  onTargetsChange,
  mode,
  onModeChange,
  model,
  onModelChange,
  caps,
  exclude,
  disabled,
  className,
  sectionLabels,
  children,
}: {
  targets: string[];
  onTargetsChange: (next: string[]) => void;
  mode: "fluent" | "faithful";
  onModeChange: (m: "fluent" | "faithful") => void;
  model: string;
  onModelChange: (m: string) => void;
  /** The backend's /v1/me capabilities (model + language lists); null = unknown. */
  caps: Capabilities | null;
  /** The known source language — offering it as a target is a no-op. */
  exclude?: string;
  disabled?: boolean;
  className?: string;
  /** Micro-labels above each section ("targets" / "mode & model") — the
   *  SettingRow expand-panel idiom; off for inline/compact placements. */
  sectionLabels?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cn("space-y-2.5", className)}>
      <div>
        {sectionLabels && <MicroLabel>targets</MicroLabel>}
        <TranslationTargetChips
          value={targets}
          onChange={onTargetsChange}
          allowed={caps?.translation_languages}
          exclude={exclude}
          disabled={disabled}
        />
      </div>
      <div>
        {sectionLabels && <MicroLabel>mode &amp; model</MicroLabel>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented
            value={mode}
            onChange={onModeChange}
            ariaLabel="Translation mode"
            disabled={disabled}
            options={[
              { value: "fluent", label: "Fluent" },
              { value: "faithful", label: "Faithful" },
            ]}
          />
          {(caps?.translation_models?.length ?? 0) > 1 && (
            <div className="w-64">
              <ModelPicker
                value={model}
                onChange={onModelChange}
                models={caps?.translation_models ?? []}
                defaultLabel={`Default · ${caps?.translation_models?.[0]?.id?.split("/").pop() ?? "server model"}`}
                ariaLabel="Translation model"
              />
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

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
}): Pick<
  TranscribeOptions,
  "translateTo" | "translationMode" | "translationModel" | "translationGlossary"
> {
  if (!args.available) return {};
  if (!args.targets.length) return { translateTo: [] };
  return {
    translateTo: args.targets,
    translationMode: args.mode,
    ...(args.model ? { translationModel: args.model } : {}),
    ...(args.glossary !== undefined ? { translationGlossary: args.glossary } : {}),
  };
}

/** The clear/reset field header the tri-state override editors share (the same
 *  affordance `DecodeFields` and the Profile prompt use): an accent dot while the
 *  field overrides its inherited value, a "clear" button that writes the explicit
 *  EMPTY override, and a "reset" that goes back to inherit. */
function OverrideLabel({
  label,
  overridden,
  canClear,
  clearTitle,
  onClear,
  onReset,
}: {
  label: string;
  /** The field holds an override (empty or not) — shows the dot and the reset. */
  overridden: boolean;
  /** Not already cleared — hides "clear" once the override IS the empty one. */
  canClear: boolean;
  clearTitle: string;
  onClear: () => void;
  onReset: () => void;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      {overridden && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
      <label className="text-[12px] font-medium text-dim">{label}</label>
      <div className="ml-auto flex items-center gap-2">
        {canClear && (
          <button
            type="button"
            onClick={onClear}
            title={clearTitle}
            className="ring-signal inline-flex items-center gap-1 rounded-md px-1 text-[11px] text-faint hover:text-text"
          >
            <Eraser className="size-3" /> clear
          </button>
        )}
        {overridden && (
          <button
            type="button"
            onClick={onReset}
            title="Reset to inherited"
            className="ring-signal inline-flex items-center gap-1 rounded-md px-1 text-[11px] text-faint hover:text-text"
          >
            <RotateCcw className="size-3" /> reset
          </button>
        )}
      </div>
    </div>
  );
}

/** The Backend/Profile "Translation defaults" body — targets, model, context
 *  depth, glossary, and mode, each absent = inherit the previous layer
 *  (Backend inherits the server; a Profile inherits its Backend). */
export function TranslationDefaultsEditor({
  value,
  onChange,
  caps,
  inheritLabel,
  liveInsert,
}: {
  value: TranslationOverrides | undefined;
  onChange: (next: TranslationOverrides | undefined) => void;
  /** The backend's /v1/me capabilities (model + language lists); null = unknown. */
  caps: Capabilities | null;
  /** What an empty field falls back to — "server config" or "backend". */
  inheritLabel: string;
  /** Will this profile insert phrase-by-phrase? Live translation is forced to Faithful —
   *  see `translateModeFor` — so the Mode control is inert and says so rather than
   *  offering a choice that quietly doesn't apply. */
  liveInsert?: boolean;
}) {
  const v = value ?? {};
  const patch = (p: Partial<TranslationOverrides>) =>
    onChange(pruneTranslationOverrides({ ...v, ...p }));

  return (
    <div className="space-y-3">
      <div>
        <OverrideLabel
          label="Translate to"
          overridden={v.translateTo !== undefined}
          canClear={v.translateTo?.length !== 0}
          clearTitle="Override with none (translate into nothing, ignoring the inherited targets)"
          onClear={() => patch({ translateTo: [] })}
          onReset={() => patch({ translateTo: undefined })}
        />
        <TranslationTargetChips
          value={v.translateTo ?? []}
          onChange={(next) => patch({ translateTo: next })}
          allowed={caps?.translation_languages}
        />
        {/* An empty chip row cannot tell "none set" from "explicitly none" on its own,
            and the two now resolve differently: absent inherits the layer below (a
            server override-profile's TRANSLATE_TO), cleared overrides it with nothing.
            Only shown while the row IS empty — with chips up, they say it. */}
        {!v.translateTo?.length && (
          <div className="mt-1 text-[11px] text-faint">
            {v.translateTo === undefined
              ? `Inherit — ${inheritLabel}`
              : "(cleared — no translation, overrides the inherited targets)"}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 items-start gap-4">
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-dim">Model</div>
          <ModelPicker
            value={v.model ?? ""}
            onChange={(m) => patch({ model: m || undefined })}
            models={caps?.translation_models ?? []}
            defaultLabel={`Inherit · ${inheritLabel}`}
            ariaLabel="Translation model"
          />
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-dim">Mode</div>
          <Segmented
            value={liveInsert ? "faithful" : v.mode ?? "inherit"}
            disabled={liveInsert}
            onChange={(m) =>
              patch({ mode: m === "inherit" ? undefined : (m as "fluent" | "faithful") })
            }
            options={[
              { value: "inherit", label: "Inherit" },
              { value: "fluent", label: "Fluent" },
              { value: "faithful", label: "Faithful" },
            ]}
            ariaLabel="Translation mode"
          />
          {liveInsert && (
            // Full contrast, not dimmed with the control: the reason is the one thing on a
            // dead row that has to stay readable (the same rule SettingRow's disabledReason
            // follows). Shows the stored value so switching this profile back to
            // insert-on-stop makes plain what it will return to.
            <div className="mt-1.5 text-[12px] text-warn">
              Always Faithful while “Type as I speak” is on — a live phrase is translated on
              its own, and Fluent merges sentences across it, which can drop the opening
              clause. {v.mode ? `Set to ${v.mode}; applies` : "Applies"} when this profile
              inserts on stop.
            </div>
          )}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-dim">Context segments</div>
        <Stepper
          value={v.contextSegments ?? 0}
          onChange={(n) => patch({ contextSegments: n === 0 ? undefined : n })}
          min={0}
          max={10}
          zeroLabel="Inherit"
          ariaLabel="Context segments"
        />
      </div>
      <div>
        <OverrideLabel
          label="Glossary"
          overridden={v.glossary !== undefined}
          canClear={v.glossary !== ""}
          clearTitle="Override with empty (suppress the inherited glossary)"
          onClear={() => patch({ glossary: "" })}
          onReset={() => patch({ glossary: undefined })}
        />
        <TextArea
          aria-label="Translation glossary"
          value={v.glossary ?? ""}
          // Tri-state: emptying an existing value stores "" (clear — the server's own
          // glossary is suppressed); reset stores undefined (inherit). Coercing
          // "" → undefined here made the two indistinguishable.
          onChange={(e) => patch({ glossary: e.target.value })}
          rows={3}
          placeholder={
            v.glossary === ""
              ? "(cleared — no glossary sent)"
              : "One fixed term per line:\nRechnung = invoice"
          }
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[12px] font-medium text-dim">Include original (dictation)</div>
          <div className="text-[11px] text-faint">
            Inject the untranslated text first, then each language — blank-line separated.
          </div>
        </div>
        <Segmented
          value={v.includeOriginal === undefined ? "inherit" : v.includeOriginal ? "on" : "off"}
          onChange={(m) => patch({ includeOriginal: m === "inherit" ? undefined : m === "on" })}
          options={[
            { value: "inherit", label: "Inherit" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          ariaLabel="Include original text in dictation output"
        />
      </div>
    </div>
  );
}
