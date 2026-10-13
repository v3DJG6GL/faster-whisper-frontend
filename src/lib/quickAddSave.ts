// The quick-add window's verdict on one whole-map PATCH reply (QuickAdd.tsx flushSave). Pure, so
// the state each reply leads to is testable without mounting the standalone window.
import { envPinnedOf, saveLanded, RULE_LIST_SETTING } from "./pipelineMap";
import type { PipelineSaveResult } from "./types";

/** - "saved": the PATCH landed (a 2xx, readable or not).
 *  - "pinned": a 2xx, but the server's environment pins the rule list — nothing took effect.
 *  - "refused": the server will never take this map's rule from this caller, by its own words:
 *    a 403 naming a lock ("rule '…' is locked and cannot be edited", "the terminal rule cannot
 *    be edited", "rule '…' is not visible to your user": an admin locked the list after the
 *    window loaded), a 403 "no access to /quick-config" (an admin revoked this caller's
 *    quick_config page), a 400 "unknown rule slug" (the pinned list was deleted, or hidden from
 *    this user; the server folds both into that one 400) or a 400 "field 'map' is not editable on
 *    rule '…'" (an admin changed the pinned rule's type away from a map). Like "pinned", a retry
 *    can never land, so the caller re-syncs instead, and the refresh's write gate then shows
 *    "List locked" / read-only or the "re-pin one in the Dictionary" page.
 *  - "error": anything else — worth retrying, and the user's rows are kept. That includes a 403
 *    that names no lock (a WAF blocking the PATCH body but not the GET: a re-sync would pass the
 *    write gate and silently replace the unsaved rows), a 400 dictionary cap, a 422, a 5xx,
 *    offline, and a 401 (an expired or wrong key is fixable). */
export type QuickAddSaveOutcome = "saved" | "pinned" | "refused" | "error";

/** The quick_config PATCH's refusal texts for a rule this caller may not edit (403). */
const LOCK_REFUSAL = /^(?:rule '.*' is locked and cannot be edited|the terminal rule cannot be edited|rule '.*' is not visible to your user)/;
/** require_page("quick_config")'s 403 once an admin sets this caller's quick_config scope to none. */
const PAGE_REFUSAL = /^no access to \/quick-config$/;
/** …for a slug the server no longer has, or no longer shows this caller, and for a rule whose
 *  type no longer takes a `map` (400). */
const GONE_RULE = /^(?:unknown rule slug\b|field '.*' is not editable on rule ')/;

export function quickAddSaveOutcome(res: PipelineSaveResult): QuickAddSaveOutcome {
  // `pinned` stays on res.ok — an unreadable 2xx reply names no pins.
  if (res.ok && envPinnedOf(res).includes(RULE_LIST_SETTING)) return "pinned";
  if (saveLanded(res)) return "saved";
  const detail = typeof res.detail === "string" ? res.detail.trim() : "";
  if (res.status === 403 && (LOCK_REFUSAL.test(detail) || PAGE_REFUSAL.test(detail))) return "refused";
  if (res.status === 400 && GONE_RULE.test(detail)) return "refused";
  return "error";
}
