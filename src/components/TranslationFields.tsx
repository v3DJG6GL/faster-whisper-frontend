// Target-language chips for the T2T translation stage — the selected targets
// as removable pills (in output order) plus a "+ language" picker over the
// remaining candidates. Reused by the Processing card, the Backend/Profile
// "Translation defaults" editors, and retro-translate popovers.
import type { ReactNode } from "react";
import { LANGUAGES, languageLabel } from "../lib/languages";
import { cn } from "../lib/cn";
import type { Capabilities, TranslationOverrides } from "../lib/types";
import { ModelPicker } from "./ModelPicker";
import { MicroLabel, Segmented, Stepper, TextArea, Toggle } from "./ui";

export const TRANSLATION_MAX_TARGETS = 8;

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
  const remaining = candidates.filter((code) => !value.includes(code));
  const atCap = value.length >= max;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={ariaLabel}>
      {value.map((code) => (
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
                hideReset
              />
            </div>
          )}
        </div>
      </div>
      {children}
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
}: {
  value: TranslationOverrides | undefined;
  onChange: (next: TranslationOverrides | undefined) => void;
  /** The backend's /v1/me capabilities (model + language lists); null = unknown. */
  caps: Capabilities | null;
  /** What an empty field falls back to — "server config" or "backend". */
  inheritLabel: string;
}) {
  const v = value ?? {};
  const patch = (p: Partial<TranslationOverrides>) => {
    const next = { ...v, ...p };
    // Prune empties so "all inherit" stores undefined (decodeOverrides idiom).
    if (!next.translateTo?.length) delete next.translateTo;
    if (!next.model) delete next.model;
    if (next.contextSegments === undefined) delete next.contextSegments;
    if (!next.glossary?.trim()) delete next.glossary;
    if (!next.mode) delete next.mode;
    if (!next.includeOriginal) delete next.includeOriginal;
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-dim">Translate to</div>
        <TranslationTargetChips
          value={v.translateTo ?? []}
          onChange={(next) => patch({ translateTo: next })}
          allowed={caps?.translation_languages}
        />
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
            hideReset
          />
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-dim">Mode</div>
          <Segmented
            value={v.mode ?? "inherit"}
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
        <div className="mb-1.5 text-[12px] font-medium text-dim">Glossary</div>
        <TextArea
          aria-label="Translation glossary"
          value={v.glossary ?? ""}
          onChange={(e) => patch({ glossary: e.target.value || undefined })}
          rows={3}
          placeholder={"One fixed term per line:\nRechnung = invoice"}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[12px] font-medium text-dim">Include original (dictation)</div>
          <div className="text-[11px] text-faint">
            Inject the untranslated text first, then each language — blank-line separated.
          </div>
        </div>
        <Toggle
          checked={v.includeOriginal ?? false}
          onChange={(on) => patch({ includeOriginal: on || undefined })}
          ariaLabel="Include original text in dictation output"
        />
      </div>
    </div>
  );
}
