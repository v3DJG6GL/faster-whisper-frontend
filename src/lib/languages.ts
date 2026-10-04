// Curated Whisper language set (ISO 639-1) + "auto". Language is configured
// per Model Profile (not globally), per the product brief.
export const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "it", label: "Italian" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "ru", label: "Russian" },
  { value: "uk", label: "Ukrainian" },
  { value: "cs", label: "Czech" },
  { value: "sv", label: "Swedish" },
  { value: "da", label: "Danish" },
  { value: "no", label: "Norwegian" },
  { value: "fi", label: "Finnish" },
  { value: "tr", label: "Turkish" },
  { value: "ar", label: "Arabic" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
];

// English names for codes outside the curated set (a server's translation
// targets reach well past it: el, hi, hu, ro, th, vi, …). Built lazily; null
// where the runtime lacks Intl.DisplayNames.
let displayNames: Intl.DisplayNames | null | undefined;
function intlName(code: string): string | undefined {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(code) || undefined;
  } catch {
    return undefined; // not a well-formed language tag
  }
}

/** English name for a language code; an unknown code comes back unchanged. */
export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.value === code)?.label ?? intlName(code) ?? code;
}
