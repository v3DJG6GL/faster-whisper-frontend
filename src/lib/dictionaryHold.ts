// The Dictionary screen's rule for when a change it did not ask for may replace the loaded rules.
// Every manual way to replace them (the other backend pills, Refresh, Reload again, navigation) is
// refused while there are unsaved edits, but the backend list is synced: a peer can change the
// selected backend's address, flip its kind to standard, or delete it while the screen is open.
// Pure, so the decision is testable without mounting the screen.

import { plural } from "@/lib/format";
import { safeDisplayText } from "@/lib/sanitize";

/** - "reload": fetch the backend's rules and replace the document (nothing unsaved to lose).
 *  - "clear": no backend is selected and nothing is unsaved — empty the document.
 *  - "keep-moved": the SAME backend's address changed under unsaved edits — keep them and warn.
 *  - "keep-gone": the backend whose rules are on screen is no longer a candidate, under unsaved
 *    edits — keep them and warn.
 *  - "keep": the SAME backend at the SAME address under unsaved edits (it came back after
 *    vanishing — a kind flipped back, a sync restore — or its address moved back): the document
 *    is still its rules; keep the edits and end any hold. */
export type DictionaryLoadAction = "reload" | "clear" | "keep-moved" | "keep-gone" | "keep";

/** What the load-on-change effect does. `backendId` is the backend it is running for (null when
 *  the selection no longer resolves), `loadedId` the backend whose rules are on screen, and
 *  `sameAddress` whether the backend's address is the one those rules were fetched from. */
export function dictionaryLoadAction(
  backendId: string | null,
  loadedId: string | null,
  dirty: boolean,
  sameAddress: boolean,
): DictionaryLoadAction {
  if (backendId === null) return dirty && loadedId !== null ? "keep-gone" : "clear";
  if (dirty && backendId === loadedId) return sameAddress ? "keep" : "keep-moved";
  return "reload";
}

/** What ends a hold once its unsaved edits are gone — however they went: Discard, a rule's own
 *  reset, or typing a value back. "reload": the moved backend's rules from its new address (the
 *  document on screen is the old address's, and a Save would send the old server's slugs and
 *  fingerprints to the new one). "release": a vanished backend's hold lets the selection move on.
 *  null: nothing held, or the edits are still unsaved. */
export function dictionaryHeldResolution(
  held: "keep-moved" | "keep-gone" | null,
  dirty: boolean,
  hasBackend: boolean,
): "reload" | "release" | null {
  if (held === null || dirty) return null;
  return held === "keep-moved" && hasBackend ? "reload" : "release";
}

/** The backend to select. A selection that is still a candidate stays; one that vanished stays
 *  too while there are unsaved edits (falling back to the first candidate would load its rules
 *  over them); otherwise the first candidate, or none. */
export function dictionarySelection(selectedId: string | null, candidateIds: readonly string[], dirty: boolean): string | null {
  if (selectedId !== null && (dirty || candidateIds.includes(selectedId))) return selectedId;
  return candidateIds[0] ?? null;
}

/** One step of a rules reload once its fetch from `requested` has returned. `live` is the backend's
 *  address now (null when it is gone). A plain reload of an address that moved under it "bail"s:
 *  those are the old host's rules, and the load-on-change effect owns the move. The reload after a
 *  save that LANDED (`afterSave`) "refetch"es from the live address instead: the saved edits are no
 *  longer unsaved, so leaving them on screen under a hold would ask for a second Save — which sends
 *  the old host's slugs and fingerprints to the new one. */
export function dictionaryReloadStep(requested: string, live: string | null, afterSave: boolean): "commit" | "refetch" | "bail" {
  if (live === requested) return "commit";
  return afterSave && live !== null ? "refetch" : "bail";
}

/** The banner line for rules a save stored. `savedTo` is the address the save went to, `shownFrom`
 *  the one its follow-up reload committed (null when the reload did not commit): when a sync moved the
 *  backend in between, the rules on screen are not the ones just saved, so the line names both. Either one unknown (null) reads as no move. */
export function dictionarySavedText(count: number, savedTo: string | null, shownFrom: string | null): string {
  const saved = `Saved ${plural(count, "rule")}`;
  if (savedTo === null || shownFrom === null || shownFrom === savedTo) return `${saved}.`;
  // No "whose rules are shown": in the fetch-error view the reload from the new address failed.
  return `${saved} to ${safeDisplayText(savedTo, 120)} — this backend now points at ${safeDisplayText(shownFrom, 120)}.`;
}
