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

/** The two addresses, display-safe, when a sync moved the backend between a save (`savedTo`) and its
 *  follow-up reload (`shownFrom`, null when the reload did not commit); null when it did not move.
 *  Either one unknown (null) reads as no move — the clauses below check a reload that did not commit
 *  on their own. */
function savedElsewhere(savedTo: string | null, shownFrom: string | null): { to: string; now: string } | null {
  if (savedTo === null || shownFrom === null || shownFrom === savedTo) return null;
  return { to: safeDisplayText(savedTo, 120), now: safeDisplayText(shownFrom, 120) };
}

/** The follow-up reload committed nothing (`shownFrom` null outside the fetch-error view): a peer
 *  deleted the backend during the save, or its address kept moving. The pre-save edits are still on
 *  screen under the hold notice, so a clause must not claim the rules were reloaded. */
const NOT_RELOADED = " The rules were not reloaded — this backend changed during the save, so your edits from before it are still on screen";

/** The banner line for rules a save stored. `savedTo` is the address the save went to, `shownFrom`
 *  the one its follow-up reload committed (null when the reload did not commit): when a sync moved the
 *  backend in between, the rules on screen are not the ones just saved, so the line names both. A
 *  reload that committed nothing outside the fetch-error view (`reloadFailed`, whose FetchError says
 *  so) leaves the saved edits on screen as unsaved changes, so the line says they were not reloaded. */
export function dictionarySavedText(count: number, savedTo: string | null, shownFrom: string | null, reloadFailed: boolean): string {
  const saved = `Saved ${plural(count, "rule")}`;
  const moved = savedElsewhere(savedTo, shownFrom);
  if (!moved) return shownFrom === null && !reloadFailed ? `${saved}.${NOT_RELOADED}.` : `${saved}.`;
  // No "whose rules are shown": in the fetch-error view the reload from the new address failed.
  return `${saved} to ${moved.to} — this backend now points at ${moved.now}.`;
}

/** The clause after the detail of a save that landed but whose reply was unreadable. After a move the
 *  rules on screen (or the ones Retry/Refresh loads) are the new address's, so "check that your
 *  changes are there" would send the user looking where the changes never went. */
export function dictionaryLandedText(savedTo: string | null, shownFrom: string | null, reloadFailed: boolean, retryBelow: boolean): string {
  const moved = savedElsewhere(savedTo, shownFrom);
  if (moved) {
    return ` The changes went to ${moved.to} — this backend now points at ${moved.now}, so check ${moved.to} for them: a rule changed elsewhere may not have been saved.`;
  }
  if (reloadFailed) return ` Reloading the rules failed — use ${retryBelow ? "Retry below" : "Refresh above"}, then check that your changes are there.`;
  return shownFrom === null
    ? `${NOT_RELOADED}. Check ${savedTo === null ? "the server" : safeDisplayText(savedTo, 120)} for your changes: a rule changed elsewhere may not have been saved.`
    : " The rules were reloaded from the server — check that your changes are there: a rule changed elsewhere may not have been saved.";
}

/** The clause after "N rules changed on the server and were not saved". After a move the server that
 *  reported the conflicts is not the one whose rules were reloaded, so it names both. `savedShown`:
 *  the "Saved N rules" notice is drawn above it and already says the rules were not reloaded, so the
 *  banner does not say it twice. */
export function dictionaryConflictText(
  savedTo: string | null,
  shownFrom: string | null,
  reloadFailed: boolean,
  retryBelow: boolean,
  savedShown: boolean,
): string {
  const retry = retryBelow ? "Retry below" : "Refresh above";
  const moved = savedElsewhere(savedTo, shownFrom);
  if (moved) {
    return reloadFailed
      ? ` That server is ${moved.to} — this backend now points at ${moved.now}, and loading its rules failed — use ${retry}.`
      : ` That server is ${moved.to} — this backend now points at ${moved.now}, whose rules are shown.`;
  }
  if (reloadFailed) return ` Reloading the rules failed — use ${retry} to load the latest version.`;
  if (shownFrom !== null) return " The latest version has been reloaded.";
  return savedShown ? "" : `${NOT_RELOADED}.`;
}
