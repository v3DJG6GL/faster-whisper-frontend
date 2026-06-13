// The short label shown on the overlay chip for the active Profile. A Profile may
// author its own `tag`; when it doesn't, we derive a compact fallback from the
// name (uppercased, whitespace collapsed, capped). The chip also CSS-truncates, so
// this is about a sensible default rather than a hard width guarantee.

export function deriveChipTag(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase().slice(0, 10).trimEnd();
}

/** The effective chip tag for a Profile: its authored tag, else derived from name. */
export function chipTagFor(profile: { name: string; tag?: string }): string {
  const t = profile.tag?.trim();
  return t ? t : deriveChipTag(profile.name);
}
