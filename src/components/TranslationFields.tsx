// Target-language chips for the T2T translation stage — the selected targets
// as removable pills (in output order) plus a "+ language" picker over the
// remaining candidates. Reused by the Processing card, the Backend/Profile
// "Translation defaults" editors, and retro-translate popovers.
import type { ReactNode } from "react";
import { OverrideHeader, OverrideText, OVERRIDE_CONTROL_W } from "./OverrideField";
import { envDesc } from "../lib/settingDesc";
import { TRANSLATION_MAX_TARGETS } from "../lib/languages";
import { chipCodes, pruneTranslationOverrides } from "../lib/translationTargets";
import { maxTranslationTargets, translationTargetInfo } from "../lib/capabilities";
import { TargetLanguagePicker } from "./LanguagePicker";
import { CompoundChip } from "./CompoundChip";
import type { ChipPart } from "../lib/siteSubtitles";
import { cn } from "../lib/cn";
import type { Capabilities, TranslationOverrides } from "../lib/types";
import { ModelPicker } from "./ModelPicker";
import { CodeChip, MicroLabel, Segmented, Stepper } from "./ui";
import { inheritLabel, onOff } from "../lib/inherit";

export function TranslationTargetChips({
  value,
  onChange,
  supported = null,
  modelName,
  exclude,
  max = TRANSLATION_MAX_TARGETS,
  disabled,
  ariaLabel = "Translation targets",
  parts,
  onPart,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Compound chips (D86 site subtitles): each language's sources after its code, in fixed
   *  order, each part clickable (`onPart` gets its key). */
  parts?: Record<string, ChipPart[]>;
  onPart?: (key: string) => void;
  /** The translation model's languages (translationLanguages); null = unknown — the picker
   *  then offers every language untagged. */
  supported?: string[] | null;
  /** The model the "Supported by …" group names. */
  modelName?: string;
  /** The known source language — offering it as a target is a no-op. */
  exclude?: string;
  max?: number;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const shown = chipCodes(value);
  // Membership and removal go through the SAME sanitizer as the chips: a synced " de " renders
  // "DE", so removing it must match on that code, not on the raw entry.
  const codeOf = (c: string) => chipCodes([c])[0] ?? "";

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={ariaLabel}>
      {shown.map((code) => {
        const chip = (
          <CodeChip
            key={code}
            code={code}
            disabled={disabled}
            head={!!parts?.[code]}
            onRemove={() => onChange(value.filter((c) => codeOf(c) !== code))}
          />
        );
        if (!parts?.[code]) return chip;
        return <CompoundChip key={code} head={chip} parts={parts[code]} onPart={onPart} disabled={disabled} />;
      })}
      <TargetLanguagePicker
        value={shown}
        onChange={onChange}
        supported={supported}
        modelName={modelName}
        exclude={exclude}
        max={max}
        disabled={disabled}
      />
      {shown.length > 0 && (
        <span className={cn("text-[11px] tabular-nums", shown.length >= max ? "text-warn" : "text-faint")}>
          {shown.length} of {max}
        </span>
      )}
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
  inheritedModel,
  caps,
  exclude,
  disabled,
  className,
  sectionLabels,
  chipParts,
  onChipPart,
  children,
}: {
  targets: string[];
  onTargetsChange: (next: string[]) => void;
  /** Compound target chips (see TranslationTargetChips `parts`). */
  chipParts?: Record<string, ChipPart[]>;
  onChipPart?: (key: string) => void;
  mode: "fluent" | "faithful";
  onModeChange: (m: "fluent" | "faithful") => void;
  model: string;
  onModelChange: (m: string) => void;
  /** What an empty model runs with — the backend's translation model, when it sets one (the
   *  run uses it before the server's default). */
  inheritedModel?: string;
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
          {...translationTargetInfo(caps, model || inheritedModel)}
          max={maxTranslationTargets(caps)}
          exclude={exclude}
          disabled={disabled}
          parts={chipParts}
          onPart={onChipPart}
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
                defaultLabel={inheritLabel(
                  (inheritedModel || caps?.translation_models?.[0]?.id || "server model").split("/").pop(),
                  "Default",
                )}
                ariaLabel="Translation model"
                disabled={disabled}
              />
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/** What a TranslationDefaultsEditor's empty fields inherit, as display values. */
export interface TranslationInherited {
  /** "English, French" / "no translation" / "server default". */
  targets?: string;
  model?: string;
  /** "Fluent" / "Faithful". */
  mode?: string;
  contextSegments?: number;
  /** The inherited glossary text; "" = explicitly none. */
  glossary?: string;
  includeOriginal?: boolean;
}

/** The Backend/Profile "Translation defaults" body — targets, model, context
 *  depth, glossary, and mode, each absent = inherit the previous layer
 *  (Backend inherits the server; a Profile inherits its Backend). */
export function TranslationDefaultsEditor({
  value,
  onChange,
  caps,
  inherited,
  inheritedModel,
  inheritedFrom,
  liveInsert,
}: {
  value: TranslationOverrides | undefined;
  onChange: (next: TranslationOverrides | undefined) => void;
  /** The backend's /v1/me capabilities (model + language lists); null = unknown. */
  caps: Capabilities | null;
  /** What each empty field falls back to, as display text — the layer below's values
   *  (a Profile shows its Backend's; a Backend shows the server's where it publishes them).
   *  Absent members leave the bare "Inherit". */
  inherited: TranslationInherited;
  /** The model id an empty Model field runs with (a Profile's backend's; absent = the server's
   *  default) — whose languages the target picker groups by. */
  inheritedModel?: string;
  /** Whose values the inherited ones are ("backend", "server") — shown after a greyed number. */
  inheritedFrom?: string;
  /** Will this profile insert phrase-by-phrase? Live translation is forced to Faithful —
   *  see `translateModeFor` — so the Mode control is inert and says so rather than
   *  offering a choice that quietly doesn't apply. */
  liveInsert?: boolean;
}) {
  const v = value ?? {};
  const patch = (p: Partial<TranslationOverrides>) =>
    onChange(pruneTranslationOverrides({ ...v, ...p }));

  // Live translation forces Faithful (translateModeFor): the Mode row is inert and says why in
  // its tooltip, with the stored value it returns to when this profile inserts on stop.
  const liveModeWhy = liveInsert
    ? `Always Faithful while “Type as I speak” is on — a live phrase is translated on its own, and Fluent merges sentences across it, which can drop the opening clause. ${v.mode ? `Set to ${v.mode}; applies` : "Applies"} when this profile inserts on stop.`
    : undefined;

  return (
    <div>
      <OverrideHeader
        title="TRANSLATE_TO"
        desc={envDesc("TRANSLATE_TO")}
        overridden={v.translateTo !== undefined}
        onClear={() => patch({ translateTo: [] })}
        canClear={v.translateTo?.length !== 0}
        clearTitle="Override with none (translate into nothing, ignoring the inherited targets)"
        onReset={() => patch({ translateTo: undefined })}
        note={
          // An empty chip row cannot tell "none set" from "explicitly none" on its own, and the
          // two resolve differently — so while the row IS empty it names which one it is.
          !v.translateTo?.length
            ? v.translateTo === undefined
              ? inheritLabel(inherited.targets)
              : "Empty · no translation"
            : undefined
        }
      >
        <TranslationTargetChips
          value={v.translateTo ?? []}
          onChange={(next) => patch({ translateTo: next })}
          {...translationTargetInfo(caps, v.model || inheritedModel)}
          max={maxTranslationTargets(caps)}
        />
      </OverrideHeader>
      <OverrideHeader
        title="TRANSLATION_MODEL"
        desc={envDesc("TRANSLATION_MODEL")}
        overridden={v.model !== undefined}
      >
        <div className={OVERRIDE_CONTROL_W}>
          <ModelPicker
            value={v.model ?? ""}
            onChange={(m) => patch({ model: m || undefined })}
            models={caps?.translation_models ?? []}
            defaultLabel={inheritLabel(inherited.model)}
            ariaLabel="Translation model"
          />
        </div>
      </OverrideHeader>
      <OverrideHeader
        title="TRANSLATION_MODE"
        desc={envDesc("TRANSLATION_MODE")}
        overridden={v.mode !== undefined}
        disabled={liveInsert}
        disabledTitle={liveModeWhy}
        note={liveInsert ? "Faithful while typing as you speak" : undefined}
      >
        <Segmented
          value={liveInsert ? "faithful" : v.mode ?? "inherit"}
          disabled={liveInsert}
          onChange={(m) => patch({ mode: m === "inherit" ? undefined : (m as "fluent" | "faithful") })}
          options={[
            { value: "inherit", label: inheritLabel(inherited.mode) },
            { value: "fluent", label: "Fluent" },
            { value: "faithful", label: "Faithful" },
          ]}
          ariaLabel="Translation mode"
        />
      </OverrideHeader>
      <OverrideHeader
        title="TRANSLATION_CONTEXT_SEGMENTS"
        desc={envDesc("TRANSLATION_CONTEXT_SEGMENTS")}
        overridden={v.contextSegments !== undefined}
      >
        {/* Tri-state: absent inherits (shown greyed), any number (0 = no context) overrides. */}
        <Stepper
          value={v.contextSegments}
          inherited={inherited.contextSegments}
          inheritNote={inheritedFrom}
          onReset={() => patch({ contextSegments: undefined })}
          onChange={(n) => patch({ contextSegments: n })}
          min={0}
          max={10}
          unit="segments"
          ariaLabel="Context segments"
        />
      </OverrideHeader>
      <OverrideHeader
        title="TRANSLATION_GLOSSARY"
        desc={envDesc("TRANSLATION_GLOSSARY")}
        overridden={v.glossary !== undefined}
        onClear={() => patch({ glossary: "" })}
        canClear={v.glossary !== ""}
        clearTitle="Override with empty (suppress the inherited glossary)"
        onReset={() => patch({ glossary: undefined })}
        wide
      >
        <OverrideText
          ariaLabel="Translation glossary"
          rows={3}
          value={v.glossary}
          // Tri-state: emptying an existing value stores "" (clear — the server's own glossary
          // is suppressed); reset stores undefined (inherit).
          onChange={(g) => patch({ glossary: g })}
          inherited={inherited.glossary === "" ? "no glossary" : inherited.glossary}
        />
      </OverrideHeader>
      <OverrideHeader
        title="Include original (dictation)"
        env={false}
        hint="Inject the untranslated text first, then each language — blank-line separated."
        overridden={v.includeOriginal !== undefined}
        last
      >
        <Segmented
          value={v.includeOriginal === undefined ? "inherit" : v.includeOriginal ? "on" : "off"}
          onChange={(m) => patch({ includeOriginal: m === "inherit" ? undefined : m === "on" })}
          options={[
            { value: "inherit", label: inheritLabel(onOff(inherited.includeOriginal)) },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          ariaLabel="Include original text in dictation output"
        />
      </OverrideHeader>
    </div>
  );
}
