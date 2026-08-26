// The one language picker every surface uses (Backends default, Profile
// override, Transcribe per-run) — previously three divergent option lists.

import { Select } from "@/components/ui";
import { LANGUAGES } from "@/lib/languages";

export function LanguageSelect({
  value,
  onChange,
  inheritLabel,
  ariaLabel = "Language",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Override contexts: prepend an empty-value row ("" = inherit) with this label. */
  inheritLabel?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      className={className}
      options={inheritLabel ? [{ value: "", label: inheritLabel }, ...LANGUAGES] : LANGUAGES}
    />
  );
}
