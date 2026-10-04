// One wording for "this control takes its value from the layer below": the word, then what that
// value IS, so a reader never has to open another screen to learn what "Inherit" means.
//
//   Inherit · on        — an override layer (Profile over Backend, Backend over server, App rule
//                         over Profile/Settings)
//   Default · large-v3  — a per-run choice on the Transcribe page
//
// A value the app cannot know (the server decides) leaves the bare word.

export type InheritWord = "Inherit" | "Default";

export function inheritLabel(value: string | null | undefined, word: InheritWord = "Inherit"): string {
  const v = typeof value === "string" ? value.trim() : "";
  return v ? `${word} · ${v}` : word;
}

/** A tri-state boolean's inherited side as the word its segments use. */
export function onOff(v: boolean | null | undefined): string | undefined {
  return typeof v === "boolean" ? (v ? "on" : "off") : undefined;
}

/** The decode defaults the server publishes (GET /v1/me): today only the skip-silence switch. */
export function capsDecodeDefaults(
  caps: { vad_filter_default?: boolean } | null | undefined,
): Partial<Record<"vad_filter", boolean>> {
  return typeof caps?.vad_filter_default === "boolean" ? { vad_filter: caps.vad_filter_default } : {};
}
