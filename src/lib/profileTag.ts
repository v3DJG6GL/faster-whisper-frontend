// The short label shown on the overlay chip for the active Profile. A Profile may
// author its own `tag`; when it doesn't, we derive a compact fallback from the
// name (uppercased, whitespace collapsed, capped). The chip also CSS-truncates, so
// this is about a sensible default rather than a hard width guarantee.

export function deriveChipTag(name: string): string {
  // Slice by code points (spread) not UTF-16 units, so an astral char (emoji) straddling the
  // cap isn't split into a lone surrogate that renders as the replacement glyph "�".
  return [...name.trim().replace(/\s+/g, " ").toUpperCase()].slice(0, 10).join("").trimEnd();
}

const AUTHORED_TAG_MAX = 16; // matches the Profiles editor's maxLength

/** The effective chip tag for a Profile: its authored tag, else derived from name.
 *
 *  The AUTHORED branch is capped at the Profiles editor's own limit (AUTHORED_TAG_MAX), so a tag
 *  the user typed shows in full; the derived branch keeps its tighter 10. The authored cap still
 *  matters: it is the branch a sync blob controls (`sanitizeProfiles` checks id/name/hotkey, not
 *  `tag`), and it feeds the `dictation://update` payload rebuilt on every level tick — an
 *  unbounded tag was re-broadcast cross-window and re-laid-out several times a second. Display
 *  only; the stored tag is untouched. */
export function chipTagFor(profile: { name: string; tag?: string }): string {
  const t = typeof profile.tag === "string" ? profile.tag.trim() : "";
  return t ? [...t].slice(0, AUTHORED_TAG_MAX).join("").trimEnd() : deriveChipTag(profile.name);
}
