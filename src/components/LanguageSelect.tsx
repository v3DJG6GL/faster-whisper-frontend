// The one language picker every surface uses (Backends default, Profile
// override, Transcribe per-run) — previously three divergent option lists.

import { Select } from "@/components/ui";
import { WHISPER_LANGUAGES, languageLabel } from "@/lib/languages";

const LANGUAGES = ["auto", ...WHISPER_LANGUAGES].map((value) => ({ value, label: languageLabel(value) }));

export function LanguageSelect({
  value,
  onChange,
  inheritLabel,
  ariaLabel = "Language",
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Override contexts: prepend an empty-value row ("" = inherit) with this label. */
  inheritLabel?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      className={className}
      disabled={disabled}
      options={inheritLabel ? [{ value: "", label: inheritLabel }, ...LANGUAGES] : LANGUAGES}
    />
  );
}
