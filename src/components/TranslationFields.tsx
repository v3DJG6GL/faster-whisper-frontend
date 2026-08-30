// Target-language chips for the T2T translation stage — the selected targets
// as removable pills (in output order) plus a "+ language" picker over the
// remaining candidates. Reused by the Processing card, the Backend/Profile
// "Translation defaults" editors, and retro-translate popovers.
import { LANGUAGES, languageLabel } from "../lib/languages";
import { cn } from "../lib/cn";

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
