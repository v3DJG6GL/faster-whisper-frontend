// The Dictionary screen's rule for when a change it did not ask for may replace the loaded rules.
// Every manual way to replace them (the other backend pills, Refresh, Reload again, navigation) is
// refused while there are unsaved edits, but the backend list is synced: a peer can change the
// selected backend's address, flip its kind to standard, or delete it while the screen is open.
// Pure, so the decision is testable without mounting the screen.

/** - "reload": fetch the backend's rules and replace the document (nothing unsaved to lose).
 *  - "clear": no backend is selected and nothing is unsaved — empty the document.
 *  - "keep-moved": the SAME backend's address changed under unsaved edits — keep them and warn.
 *  - "keep-gone": the backend whose rules are on screen is no longer a candidate, under unsaved
 *    edits — keep them and warn. */
export type DictionaryLoadAction = "reload" | "clear" | "keep-moved" | "keep-gone";

/** What the load-on-change effect does. `backendId` is the backend it is running for (null when
 *  the selection no longer resolves), `loadedId` the backend whose rules are on screen. */
export function dictionaryLoadAction(backendId: string | null, loadedId: string | null, dirty: boolean): DictionaryLoadAction {
  if (backendId === null) return dirty && loadedId !== null ? "keep-gone" : "clear";
  if (dirty && backendId === loadedId) return "keep-moved";
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
