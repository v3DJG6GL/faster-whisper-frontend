// The overlay chip's label for the active Profile: its authored `tag`, else one derived from
// the name. The chip also CSS-truncates, so the caps here set a sensible default, not a hard
// width guarantee.

import { capCodePoints, leadingTrimBudget, profileDisplayName, trimLeadingInvisible } from "./sanitize";

export function deriveChipTag(name: string): string {
  return capCodePoints(name.trim().replace(/\s+/g, " ").toUpperCase(), 10).trimEnd();
}

const AUTHORED_TAG_MAX = 16; // matches the Profiles editor's maxLength

/** An authored tag as the chip shows it: its invisible head dropped first, so a tag that renders
 *  blank reads "" (= unset) and a padded one keeps its visible part inside the cap. The one rule
 *  for every reader of an authored tag — the chip, the Profiles row badge, the tag a dictation
 *  record stores, History's badge and the translation-target picker's header. `budget` bounds the
 *  head walk (`trimLeadingInvisible`); the tag a record stores walks it whole. */
export function authoredChipTag(tag: unknown, budget = Infinity): string {
  // Capped before the trailing trim, so MBs of synced trailing whitespace are never walked. Same
  // output: the head is already trimmed, so the cap keeps a visible first character whenever any
  // text is left, and trailing whitespace past the cap is cut either way.
  const t = typeof tag === "string" ? trimLeadingInvisible(tag, budget).trimStart() : "";
  return capCodePoints(t, AUTHORED_TAG_MAX).trimEnd();
}

/** `authoredChipTag` for a surface that re-renders it — the chip (rebuilt on every level tick), the
 *  Profiles row badge, the picker header. A synced tag is unbounded, and MBs of invisible head
 *  would be walked on every render, so the walk is budgeted (`leadingTrimBudget`): a tag with
 *  fewer than 32 Ki invisible leading code points (every real one) reads the same, a padded one
 *  reads "…". */
export const shownChipTag = (tag: unknown): string => authoredChipTag(tag, leadingTrimBudget(AUTHORED_TAG_MAX));

/** The effective chip tag for a Profile: its authored tag (`shownChipTag`), else derived from
 *  name.
 *
 *  The authored cap is the editor's own limit, so a typed tag shows in full, but it still matters:
 *  a sync blob controls `tag` (`sanitizeProfiles` type-checks it but does not bound it), and it
 *  feeds the `dictation://update` payload rebuilt on every level tick — an unbounded tag would be
 *  re-broadcast cross-window and re-laid-out several times a second. Display only; the stored
 *  tag is untouched. */
export function chipTagFor(profile: { name: string; tag?: string }): string {
  const authored = shownChipTag(profile.tag);
  if (authored) return authored;
  // Derived from the name as the lists show it (`profileDisplayName`): a synced name that renders
  // blank, or starts with ten invisible characters, would otherwise derive "" — the overlay then
  // hides the tag group and the hover language/mode detail inside it — or a truthy tag that
  // renders empty. A blank one reads "UNTITLED P", the tag of the "Untitled profile" a local save
  // stores for it.
  return deriveChipTag(profileDisplayName(profile.name));
}
