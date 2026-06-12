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

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.value === code)?.label ?? code;
}
