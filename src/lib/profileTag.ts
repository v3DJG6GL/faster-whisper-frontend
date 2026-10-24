// The short label shown on the overlay chip for the active Profile. A Profile may
// author its own `tag`; when it doesn't, we derive a compact fallback from the
// name (uppercased, whitespace collapsed, capped). The chip also CSS-truncates, so
// this is about a sensible default rather than a hard width guarantee.

import { capCodePoints, profileDisplayName, trimLeadingInvisible } from "./sanitize";

export function deriveChipTag(name: string): string {
  // Cut by code points, not UTF-16 units, so an astral char (emoji) straddling the cap isn't
  // split into a lone surrogate that renders as the replacement glyph "�".
  return capCodePoints(name.trim().replace(/\s+/g, " ").toUpperCase(), 10).trimEnd();
}

const AUTHORED_TAG_MAX = 16; // matches the Profiles editor's maxLength

/** An authored tag as the chip shows it: its invisible head dropped first, so a tag that renders
 *  blank reads "" (= unset) and a padded one keeps its visible part inside the cap. The one rule
 *  for every reader of an authored tag — the chip, the Profiles row badge, the tag a dictation
 *  record stores, History's badge and the translation-target picker's header. */
export function authoredChipTag(tag: unknown): string {
  const t = typeof tag === "string" ? trimLeadingInvisible(tag).trim() : "";
  return t ? capCodePoints(t, AUTHORED_TAG_MAX).trimEnd() : "";
}

/** The effective chip tag for a Profile: its authored tag (`authoredChipTag`), else derived from
 *  name.
 *
 *  The authored cap is the editor's own limit, so a typed tag shows in full, but it still matters:
 *  a sync blob controls `tag` (`sanitizeProfiles` type-checks it but does not bound it), and it
 *  feeds the `dictation://update` payload rebuilt on every level tick — an unbounded tag was
 *  re-broadcast cross-window and re-laid-out several times a second. Display only; the stored
 *  tag is untouched. */
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
