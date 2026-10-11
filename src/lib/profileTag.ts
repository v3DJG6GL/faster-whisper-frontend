// The short label shown on the overlay chip for the active Profile. A Profile may
// author its own `tag`; when it doesn't, we derive a compact fallback from the
// name (uppercased, whitespace collapsed, capped). The chip also CSS-truncates, so
// this is about a sensible default rather than a hard width guarantee.

import { profileDisplayName, trimLeadingInvisible } from "./sanitize";

export function deriveChipTag(name: string): string {
  // Slice by code points (spread) not UTF-16 units, so an astral char (emoji) straddling the
  // cap isn't split into a lone surrogate that renders as the replacement glyph "�".
  return [...name.trim().replace(/\s+/g, " ").toUpperCase()].slice(0, 10).join("").trimEnd();
}

const AUTHORED_TAG_MAX = 16; // matches the Profiles editor's maxLength

/** An authored tag as the chip shows it: its invisible head dropped first, so a tag that renders
 *  blank reads "" (= unset) and a padded one keeps its visible part inside the cap. The one rule
 *  for every reader of an authored tag — the chip, the Profiles row badge, the tag a dictation
 *  record stores and History's badge. */
export function authoredChipTag(tag: unknown): string {
  const t = typeof tag === "string" ? trimLeadingInvisible(tag).trim() : "";
  return t ? [...t].slice(0, AUTHORED_TAG_MAX).join("").trimEnd() : "";
}

/** The effective chip tag for a Profile: its authored tag, else derived from name.
 *
 *  The AUTHORED branch is capped at the Profiles editor's own limit (AUTHORED_TAG_MAX), so a tag
 *  the user typed shows in full; the derived branch keeps its tighter 10. The authored cap still
 *  matters: it is the branch a sync blob controls (`sanitizeProfiles` checks id/name/hotkey, not
 *  `tag`), and it feeds the `dictation://update` payload rebuilt on every level tick — an
 *  unbounded tag was re-broadcast cross-window and re-laid-out several times a second. Display
 *  only; the stored tag is untouched. An authored tag that renders blank counts as unset. */
export function chipTagFor(profile: { name: string; tag?: string }): string {
  const authored = authoredChipTag(profile.tag);
  if (authored) return authored;
  // Derived from the name as the lists show it (`profileDisplayName`): a synced name that renders
  // blank, or starts with ten invisible characters, would otherwise derive "" — the overlay then
  // hides the tag group and the hover language/mode detail inside it — or a truthy tag that
  // renders empty. A blank one reads "UNTITLED P", the tag of the "Untitled profile" a local save
  // stores for it.
  return deriveChipTag(profileDisplayName(profile.name));
}
